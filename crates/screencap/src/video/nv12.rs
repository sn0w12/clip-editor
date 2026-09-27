//! GPU-side BGRA to NV12 conversion for the DXGI capture path.
//!
//! The duplication hands back a BGRA8 texture. Piping that to the encoder moves
//! `width * height * 4` bytes per frame and makes FFmpeg run a software
//! BGRA->NV12 conversion, because no hardware encoder accepts BGRA. Converting on
//! the GPU instead and piping NV12 cuts the wire to `width * height * 3 / 2` and
//! removes the software conversion: `h264_nvenc` takes NV12 natively.
//!
//! The conversion is a fullscreen pass that samples a GPU-side copy of the
//! acquired frame texture and writes Y and UV into two staging textures, so no
//! BGRA frame is ever staged or copied through CPU memory. The pointer is
//! composited in the same pass before the YUV matrix.
//!
//! Colour uses the limited-range BT.601 matrix FFmpeg's swscale applied to BGRA
//! input, so clips keep the colours they had on the BGRA path. Chroma is the box
//! average of each 2x2 block.

use std::time::Instant;

use windows::Win32::Graphics::Direct3D::D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_BLEND_DESC, D3D11_BLEND_ONE, D3D11_BLEND_OP_ADD, D3D11_BLEND_ZERO, D3D11_BUFFER_DESC,
    D3D11_COLOR_WRITE_ENABLE_ALL, D3D11_COMPARISON_FUNC, D3D11_CPU_ACCESS_READ, D3D11_CULL_MODE,
    D3D11_DEPTH_STENCIL_DESC, D3D11_FILL_MODE, D3D11_FILTER, D3D11_FILTER_MIN_MAG_MIP_POINT,
    D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_RASTERIZER_DESC,
    D3D11_RENDER_TARGET_BLEND_DESC, D3D11_SAMPLER_DESC, D3D11_SUBRESOURCE_DATA,
    D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
    D3D11_VIEWPORT, ID3D11BlendState, ID3D11Buffer, ID3D11DepthStencilState,
    ID3D11DepthStencilView, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader,
    ID3D11RasterizerState, ID3D11RenderTargetView, ID3D11SamplerState, ID3D11ShaderResourceView,
    ID3D11Texture2D, ID3D11VertexShader,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM,
    DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::core::{Interface, PCSTR};

const D3D11_FILL_MODE_SOLID: D3D11_FILL_MODE = D3D11_FILL_MODE(3);
const D3D11_CULL_MODE_NONE: D3D11_CULL_MODE = D3D11_CULL_MODE(1);
const D3D_COMPARISON_FUNC_NEVER: D3D11_COMPARISON_FUNC = D3D11_COMPARISON_FUNC(1);

const PIXEL_SHADER: &str = r#"
cbuffer Params : register(b0) {
    int4 srcSize;     // frame width, frame height
    int4 cursorFrame; // cursor top-left x, y, width, height (width 0 = none)
};

Texture2D<float4> srcTex : register(t0);
Texture2D<float4> curTex : register(t1);

float3 compositeAt(float2 px)
{
    int2 p = clamp(int2(px), int2(0, 0), int2(srcSize.x - 1, srcSize.y - 1));
    float3 c = srcTex.Load(int3(p, 0)).rgb;
    if (cursorFrame.z > 0 && cursorFrame.w > 0) {
        int2 rel = p - cursorFrame.xy;
        if (rel.x >= 0 && rel.y >= 0 && rel.x < cursorFrame.z && rel.y < cursorFrame.w) {
            float4 cur = curTex.Load(int3(rel, 0));
            c = lerp(c, cur.rgb, cur.a);
        }
    }
    return c;
}

float3 toYuv(float3 c)
{
    // Limited-range BT.601, the coefficients swscale used for BGRA->NV12:
    // Y 16-235, C 128 +/- 128, from 8-bit R,G,B in 0..1.
    float y  = dot(c, float3(0.256788, 0.504129, 0.097906)) + 0.062500;
    float cb = dot(c, float3(-0.148223, -0.290993, 0.439216)) + 0.500000;
    float cr = dot(c, float3( 0.439216, -0.367788, -0.071427)) + 0.500000;
    // Chroma only: the R8G8_UNORM target truncates the float instead of
    // rounding it (measured: a flat rgb(20,20,20) yields luma 33 but chroma
    // 127/127 where both should be 33/128/128), and neutral chroma is exactly
    // 0.5, i.e. a dead tie at 127.5. Truncation sends every neutral grey to
    // 127 and tints it green. Half an LSB makes truncation land on the
    // correctly rounded value. The R8_UNORM luma target rounds properly, so it
    // is left alone: biasing it would push it one step too far.
    const float HALF_LSB = 0.0019608; // 0.5 / 255
    return float3(y, cb + HALF_LSB, cr + HALF_LSB);
}

float4 psY(float4 pos : SV_Position) : SV_Target
{
    return toYuv(compositeAt(pos.xy - 0.5)).x;
}

float4 psUV(float4 pos : SV_Position) : SV_Target
{
    // `pos` already indexes the chroma target, which is half the frame in each
    // dimension, so texel i covers source columns 2i and 2i+1. Halving again
    // here would only reach the left half of the frame and stretch it across
    // the plane.
    int2 base = int2(pos.xy);
    // Only chroma: `toYuv` returns luma in .x, so take .yz.
    float2 sum = 0.0;
    [unroll]
    for (int j = 0; j < 2; ++j) {
        [unroll]
        for (int i = 0; i < 2; ++i) {
            sum += toYuv(compositeAt(float2(base.x * 2 + i, base.y * 2 + j))).yz;
        }
    }
    return float4(sum * 0.25, 0.0, 0.0);
}
"#;

const VERTEX_SHADER: &str = r#"
float4 vsMain(uint vid : SV_VertexID) : SV_Position
{
    float2 p = float2((vid == 1) ? 3.0 : -1.0, (vid == 2) ? 3.0 : -1.0);
    return float4(p, 0.0, 1.0);
}
"#;

/// Pointer shape plus the frame-space rectangle it composites into.
pub struct CursorUpload<'a> {
    /// Shape pixels in BGRA order, `pitch` bytes per row, at least
    /// `pitch * height` bytes long.
    pub shape: &'a [u8],
    pub pitch: u32,
    pub width: u32,
    pub height: u32,
    /// Top-left of the shape in frame coordinates, already hotspot-adjusted.
    pub x: i32,
    pub y: i32,
}

/// One NV12 plane: a render target the shader writes and a staging texture the
/// result is read back from.
struct Plane {
    target: ID3D11Texture2D,
    rtv: ID3D11RenderTargetView,
    staging: ID3D11Texture2D,
}

impl Plane {
    fn new(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
    ) -> Result<Self, String> {
        let render = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let staging = D3D11_TEXTURE2D_DESC {
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            ..render
        };
        let mut target = None;
        let mut stg = None;
        let mut rtv = None;
        // SAFETY: `device` outlives every object created here, and each out
        // parameter receives the object it names.
        unsafe {
            if device
                .CreateTexture2D(&render, None, Some(&mut target))
                .is_err()
            {
                return Err(format!("cannot create {width}x{height} NV12 target"));
            }
            if device
                .CreateTexture2D(&staging, None, Some(&mut stg))
                .is_err()
            {
                return Err(format!("cannot create {width}x{height} NV12 staging"));
            }
            let target = target.expect("checked above");
            if device
                .CreateRenderTargetView(&target, None, Some(&mut rtv))
                .is_err()
            {
                return Err(format!("cannot create {width}x{height} NV12 RTV"));
            }
            Ok(Self {
                target,
                rtv: rtv.expect("checked above"),
                staging: stg.expect("checked above"),
            })
        }
    }
}

fn compile(src: &str, entry: &str, target: &str) -> Result<Vec<u8>, String> {
    // `D3DCompile` wants NUL-terminated UTF-8 entry point and target names.
    let mut entry_z = entry.as_bytes().to_vec();
    entry_z.push(0);
    let mut target_z = target.as_bytes().to_vec();
    target_z.push(0);
    let mut code = None;
    let mut errors = None;
    // SAFETY: `src` outlives the call and `code` receives the compiled bytecode.
    // The source name, macro table and include interface are all optional, so
    // null handles are valid.
    unsafe {
        D3DCompile(
            src.as_ptr().cast(),
            src.len(),
            None::<&PCSTR>,
            None,
            None,
            PCSTR(entry_z.as_ptr()),
            PCSTR(target_z.as_ptr()),
            0,
            0,
            &mut code,
            Some(&mut errors),
        )
    }
    .map_err(|e| {
        let detail = errors
            .as_ref()
            .map(|blob| unsafe { blob_text(blob) })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| e.to_string());
        format!("D3DCompile({entry}) failed: {detail}")
    })?;
    let blob = code.ok_or("D3DCompile produced no bytecode")?;
    // SAFETY: the blob owns `GetBufferSize` bytes at `GetBufferPointer`, both
    // valid for as long as `blob` lives.
    unsafe {
        let ptr = blob.GetBufferPointer().cast::<u8>();
        let len = blob.GetBufferSize();
        if ptr.is_null() {
            return Err("D3DCompile returned a null buffer".to_string());
        }
        Ok(std::slice::from_raw_parts(ptr, len).to_vec())
    }
}

/// SAFETY: `blob` must be a live `ID3DBlob` with a valid buffer.
unsafe fn blob_text(blob: &windows::Win32::Graphics::Direct3D::ID3DBlob) -> String {
    let ptr = unsafe { blob.GetBufferPointer() };
    let len = unsafe { blob.GetBufferSize() };
    if ptr.is_null() || len == 0 {
        return String::new();
    }
    // SAFETY: the blob owns `len` readable bytes at `ptr`.
    let bytes = unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len) };
    String::from_utf8_lossy(bytes).trim().to_string()
}

/// Compiles the conversion shaders and owns the D3D11 objects they need.
///
/// Objects live on the duplication's device because the source texture comes
/// from the duplication. Rebuild if that device or the surface size changes.
pub struct Nv12Converter {
    device: *mut core::ffi::c_void,
    width: u32,
    height: u32,
    vs: ID3D11VertexShader,
    ps_y: ID3D11PixelShader,
    ps_uv: ID3D11PixelShader,
    cbuffer: ID3D11Buffer,
    sampler: ID3D11SamplerState,
    rasterizer: ID3D11RasterizerState,
    blend: ID3D11BlendState,
    depth: ID3D11DepthStencilState,
    src: ID3D11Texture2D,
    src_srv: ID3D11ShaderResourceView,
    y: Plane,
    uv: Plane,
    cursor: ID3D11Texture2D,
    cursor_srv: ID3D11ShaderResourceView,
    cursor_dims: (u32, u32),
}

impl Nv12Converter {
    /// Compile the shaders and create every object for a `width` x `height`
    /// surface on `device`. `Err` means this surface cannot use the NV12 path
    /// and the caller must stay on BGRA.
    pub fn new(
        device: &ID3D11Device,
        src_format: DXGI_FORMAT,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        if !matches!(
            src_format,
            DXGI_FORMAT_B8G8R8A8_UNORM | DXGI_FORMAT_R8G8B8A8_UNORM
        ) {
            return Err(format!("capture format {src_format:?} is not 8-bit RGBA"));
        }
        // NV12 subsamples chroma 2x2, so both dimensions must be even.
        if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(format!("{width}x{height} has an odd dimension"));
        }
        let vs_code = compile(VERTEX_SHADER, "vsMain", "vs_4_0")?;
        let y_code = compile(PIXEL_SHADER, "psY", "ps_4_0")?;
        let uv_code = compile(PIXEL_SHADER, "psUV", "ps_4_0")?;

        let mut vs = None;
        let mut ps_y = None;
        let mut ps_uv = None;
        let mut cbuffer = None;
        let mut sampler = None;
        let mut rasterizer = None;
        let mut blend = None;
        let mut depth = None;
        // SAFETY: every out parameter receives an object created from a live
        // `device`; `None` class-linkage handles are valid.
        unsafe {
            if device
                .CreateVertexShader(&vs_code, None, Some(&mut vs))
                .is_err()
            {
                return Err("cannot create the NV12 vertex shader".to_string());
            }
            if device
                .CreatePixelShader(&y_code, None, Some(&mut ps_y))
                .is_err()
            {
                return Err("cannot create the NV12 luma shader".to_string());
            }
            if device
                .CreatePixelShader(&uv_code, None, Some(&mut ps_uv))
                .is_err()
            {
                return Err("cannot create the NV12 chroma shader".to_string());
            }

            // Must be a constant buffer: it is bound with
            // `VS/PSSetConstantBuffers`, not as a shader resource.
            let cbuf = D3D11_BUFFER_DESC {
                ByteWidth: 32,
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
                StructureByteStride: 0,
            };
            if device
                .CreateBuffer(&cbuf, None, Some(&mut cbuffer))
                .is_err()
            {
                return Err("cannot create the NV12 constant buffer".to_string());
            }

            let samp = D3D11_SAMPLER_DESC {
                Filter: D3D11_FILTER(D3D11_FILTER_MIN_MAG_MIP_POINT.0),
                AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                MipLODBias: 0.0,
                MaxAnisotropy: 1,
                ComparisonFunc: D3D_COMPARISON_FUNC_NEVER,
                BorderColor: [0.0; 4],
                MinLOD: 0.0,
                MaxLOD: 0.0,
            };
            if device
                .CreateSamplerState(&samp, Some(&mut sampler))
                .is_err()
            {
                return Err("cannot create the NV12 sampler".to_string());
            }

            // D3D11 keeps no default pipeline state, so the rasterizer, blend
            // and depth-stencil states are all set before drawing. These are
            // spelled out rather than derived from `Default::default()`,
            // which zeroes every field: a zeroed `DepthClipEnable` is `FALSE`,
            // which discards the fullscreen triangle.
            let rs = D3D11_RASTERIZER_DESC {
                FillMode: D3D11_FILL_MODE_SOLID,
                CullMode: D3D11_CULL_MODE_NONE,
                FrontCounterClockwise: false.into(),
                DepthBias: 0,
                DepthBiasClamp: 0.0,
                SlopeScaledDepthBias: 0.0,
                DepthClipEnable: true.into(),
                ScissorEnable: false.into(),
                MultisampleEnable: false.into(),
                AntialiasedLineEnable: false.into(),
            };
            if device
                .CreateRasterizerState(&rs, Some(&mut rasterizer))
                .is_err()
            {
                return Err("cannot create the NV12 rasterizer state".to_string());
            }
            // `Default::default()` zeroes `RenderTarget[0].RenderTargetWriteMask`,
            // which means "write no channels": a `Draw` then silently discards
            // every fragment while `ClearRenderTargetView` (which ignores blend
            // state) still works. Blending itself stays off.
            let blend_desc = D3D11_BLEND_DESC {
                AlphaToCoverageEnable: false.into(),
                IndependentBlendEnable: false.into(),
                RenderTarget: [D3D11_RENDER_TARGET_BLEND_DESC {
                    BlendEnable: false.into(),
                    SrcBlend: D3D11_BLEND_ONE,
                    DestBlend: D3D11_BLEND_ZERO,
                    BlendOp: D3D11_BLEND_OP_ADD,
                    SrcBlendAlpha: D3D11_BLEND_ONE,
                    DestBlendAlpha: D3D11_BLEND_ZERO,
                    BlendOpAlpha: D3D11_BLEND_OP_ADD,
                    RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
                }; 8],
            };
            if device
                .CreateBlendState(&blend_desc, Some(&mut blend))
                .is_err()
            {
                return Err("cannot create the NV12 blend state".to_string());
            }
            if device
                .CreateDepthStencilState(&D3D11_DEPTH_STENCIL_DESC::default(), Some(&mut depth))
                .is_err()
            {
                return Err("cannot create the NV12 depth-stencil state".to_string());
            }
        }

        let (src, src_srv) = Self::create_source(device, src_format, width, height)?;
        let y = Plane::new(device, width, height, DXGI_FORMAT_R8_UNORM)?;
        let uv = Plane::new(device, width / 2, height / 2, DXGI_FORMAT_R8G8_UNORM)?;
        let (cursor, cursor_srv) = Self::create_cursor(device, 1, 1)?;

        Ok(Self {
            device: device.as_raw(),
            width,
            height,
            vs: vs.expect("checked above"),
            ps_y: ps_y.expect("checked above"),
            ps_uv: ps_uv.expect("checked above"),
            cbuffer: cbuffer.expect("checked above"),
            sampler: sampler.expect("checked above"),
            rasterizer: rasterizer.expect("checked above"),
            blend: blend.expect("checked above"),
            depth: depth.expect("checked above"),
            src,
            src_srv,
            y,
            uv,
            cursor,
            cursor_srv,
            cursor_dims: (1, 1),
        })
    }

    fn create_cursor(
        device: &ID3D11Device,
        width: u32,
        height: u32,
    ) -> Result<(ID3D11Texture2D, ID3D11ShaderResourceView), String> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut tex = None;
        let mut srv = None;
        // SAFETY: `device` outlives both objects and each out parameter receives
        // the object it names.
        unsafe {
            if device.CreateTexture2D(&desc, None, Some(&mut tex)).is_err() {
                return Err("cannot create the NV12 cursor texture".to_string());
            }
            let tex = tex.expect("checked above");
            if device
                .CreateShaderResourceView(&tex, None, Some(&mut srv))
                .is_err()
            {
                return Err("cannot create the NV12 cursor SRV".to_string());
            }
            Ok((tex, srv.expect("checked above")))
        }
    }

    /// Build the converter and its source copy.
    ///
    /// The acquired duplication texture is copied into `src` before sampling.
    /// It already carries `D3D11_BIND_SHADER_RESOURCE` (a 1080p duplication
    /// reports `BindFlags` 0x28), so the copy is not needed to make the texture
    /// bindable, but sampling it directly reads back as all-zero on this driver
    /// — the duplication only guarantees the frame's contents for a read of the
    /// buffer, not as a shader input. Copying into a texture this converter owns
    /// costs one GPU-side copy and no CPU round trip.
    fn create_source(
        device: &ID3D11Device,
        format: DXGI_FORMAT,
        width: u32,
        height: u32,
    ) -> Result<(ID3D11Texture2D, ID3D11ShaderResourceView), String> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut tex = None;
        let mut srv = None;
        // SAFETY: `device` outlives both objects and each out parameter receives
        // the object it names.
        unsafe {
            if device.CreateTexture2D(&desc, None, Some(&mut tex)).is_err() {
                return Err("cannot create the NV12 source copy".to_string());
            }
            let tex = tex.expect("checked above");
            if device
                .CreateShaderResourceView(&tex, None, Some(&mut srv))
                .is_err()
            {
                return Err("cannot create the NV12 source SRV".to_string());
            }
            Ok((tex, srv.expect("checked above")))
        }
    }

    /// Whether this converter was built for `device` at this surface size.
    pub fn matches(&self, device: &ID3D11Device, width: u32, height: u32) -> bool {
        self.device == device.as_raw() && self.width == width && self.height == height
    }

    /// Convert the acquired frame into `out` as NV12, compositing `cursor` in
    /// the same pass. Returns the total CPU time spent on the conversion.
    ///
    /// # Safety
    /// `context` must be the immediate context owning `device`; `src` must be a
    /// texture on that device; `out` must be uniquely owned and exactly
    /// `width * height * 3 / 2` bytes.
    pub unsafe fn convert(
        &mut self,
        context: &ID3D11DeviceContext,
        src: &ID3D11Texture2D,
        width: u32,
        height: u32,
        cursor: Option<CursorUpload<'_>>,
        out: &mut [u8],
    ) -> Result<std::time::Duration, String> {
        let expected = width as usize * height as usize * 3 / 2;
        if out.len() != expected {
            return Err(format!(
                "NV12 output is {} bytes, expected {expected}",
                out.len()
            ));
        }
        let started = Instant::now();

        // The acquired texture is copied into a texture this converter owns,
        // which the shader then samples. See `create_source` for why sampling
        // the duplication texture directly does not work.
        // SAFETY: `src` is a live texture on `context`'s device with the same
        // size and format as `self.src`, which is unmapped and not a copy
        // destination in flight.
        unsafe { context.CopyResource(&self.src, src) };

        if let Some(cur) = cursor.as_ref() {
            if (cur.width, cur.height) != self.cursor_dims {
                // SAFETY: `device` is the live device that owns this converter.
                let (tex, srv) =
                    unsafe { Self::create_cursor_from(context, cur.width, cur.height)? };
                self.cursor = tex;
                self.cursor_srv = srv;
                self.cursor_dims = (cur.width, cur.height);
            }
            // SAFETY: the cursor texture is `cur.width` x `cur.height` BGRA and
            // `shape` holds at least `pitch * height` bytes, which is exactly
            // what `UpdateSubresource` reads using `SysMemPitch`.
            unsafe {
                let data = D3D11_SUBRESOURCE_DATA {
                    pSysMem: cur.shape.as_ptr().cast(),
                    SysMemPitch: cur.pitch,
                    SysMemSlicePitch: 0,
                };
                context.UpdateSubresource(&self.cursor, 0, None, data.pSysMem, data.SysMemPitch, 0);
            }
        }

        let params = params_bytes(width, height, cursor.as_ref());
        // SAFETY: `cbuffer` is 32 bytes and `params` is exactly 32 bytes, the
        // size of the two `int4` members the shader declares.
        unsafe {
            context.UpdateSubresource(&self.cbuffer, 0, None, params.as_ptr().cast(), 32, 0);
        }

        // SAFETY: every object bound here is owned by `self` and outlives the
        // call; the render targets are not mapped and no readback is in flight.
        unsafe {
            context.IASetInputLayout(None);
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.VSSetShader(&self.vs, None);
            context.VSSetConstantBuffers(0, Some(&[Some(self.cbuffer.clone())]));
            context.PSSetConstantBuffers(0, Some(&[Some(self.cbuffer.clone())]));
            context.PSSetShaderResources(
                0,
                Some(&[Some(self.src_srv.clone()), Some(self.cursor_srv.clone())]),
            );
            context.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            context.RSSetState(&self.rasterizer);
            context.OMSetBlendState(&self.blend, None, u32::MAX);
            context.OMSetDepthStencilState(&self.depth, 0);
            context.OMSetRenderTargets(None, None::<&ID3D11DepthStencilView>);
        }
        // SAFETY: `self.draw` only binds objects owned by this converter and
        // the render targets are unmapped.
        //
        // The viewport is the render target's size in pixels, which is NOT the
        // same as the plane's row length in the output buffer: the chroma target
        // is `width / 2` texels across but each of its rows occupies `width`
        // bytes in NV12. Passing `width` here would make the viewport twice the
        // target's width, so only the left half of the source would be
        // rasterized and then stretched across the plane — chroma offset from
        // luma by a factor of two.
        unsafe {
            self.draw(context, &self.y, &self.ps_y, width, height);
            self.draw(context, &self.uv, &self.ps_uv, width / 2, height / 2);
        }

        // SAFETY: both staging textures are unmapped; the reads below unmap
        // before returning.
        unsafe {
            context.CopyResource(&self.y.staging, &self.y.target);
            context.CopyResource(&self.uv.staging, &self.uv.target);
        }

        let y_len = width as usize * height as usize;
        // SAFETY: each staging texture is unmapped and each slice of `out` is
        // the exact size of the plane it receives.
        //
        // Both NV12 planes are `width` BYTES per row: luma is one byte per
        // pixel, and chroma is `width / 2` RG texels at two bytes each. Passing
        // `width / 2` for the chroma row would copy half of every row.
        unsafe {
            copy_plane(context, &self.y.staging, width, height, &mut out[..y_len])?;
            copy_plane(
                context,
                &self.uv.staging,
                width,
                height / 2,
                &mut out[y_len..],
            )?;
        }
        Ok(started.elapsed())
    }

    unsafe fn create_cursor_from(
        context: &ID3D11DeviceContext,
        width: u32,
        height: u32,
    ) -> Result<(ID3D11Texture2D, ID3D11ShaderResourceView), String> {
        // SAFETY: the context is live and returns its own device.
        let device = unsafe { context.GetDevice() }.map_err(|e| e.to_string())?;
        Self::create_cursor(&device, width, height)
    }

    unsafe fn draw(
        &self,
        context: &ID3D11DeviceContext,
        plane: &Plane,
        ps: &ID3D11PixelShader,
        width: u32,
        height: u32,
    ) {
        let viewport = D3D11_VIEWPORT {
            TopLeftX: 0.0,
            TopLeftY: 0.0,
            Width: width as f32,
            Height: height as f32,
            MinDepth: 0.0,
            MaxDepth: 1.0,
        };
        // SAFETY: the target, viewport, shader and pipeline state are all live
        // objects, and the render target is not mapped. `OMSetRenderTargets`
        // returns `()` in this binding (it drops the HRESULT), so a failed bind
        // would make the following `Draw` a silent no-op.
        unsafe {
            context.PSSetShader(ps, None);
            context.OMSetRenderTargets(
                Some(&[Some(plane.rtv.clone())]),
                None::<&ID3D11DepthStencilView>,
            );
            context.RSSetViewports(Some(&[viewport]));
            context.Draw(3, 0);
        }
    }
}

/// Pack the two `int4` constant-buffer members.
fn params_bytes(width: u32, height: u32, cursor: Option<&CursorUpload<'_>>) -> [u8; 32] {
    let (cx, cy, cw, ch) = match cursor {
        Some(cur) if cur.width > 0 && cur.height > 0 => (cur.x, cur.y, cur.width, cur.height),
        _ => (0, 0, 0, 0),
    };
    let mut out = [0u8; 32];
    out[0..4].copy_from_slice(&width.to_ne_bytes());
    out[4..8].copy_from_slice(&height.to_ne_bytes());
    out[16..20].copy_from_slice(&cx.to_ne_bytes());
    out[20..24].copy_from_slice(&cy.to_ne_bytes());
    out[24..28].copy_from_slice(&cw.to_ne_bytes());
    out[28..32].copy_from_slice(&ch.to_ne_bytes());
    out
}

/// Map a staging plane and copy its rows into `out`.
///
/// # Safety
/// `staging` must be unmapped and `out` at least `width * height` bytes.
unsafe fn copy_plane(
    context: &ID3D11DeviceContext,
    staging: &ID3D11Texture2D,
    width: u32,
    height: u32,
    out: &mut [u8],
) -> Result<(), String> {
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    // SAFETY: `staging` is unmapped and `mapped` receives the description.
    unsafe { context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
        .map_err(|e| format!("NV12 plane readback failed: {e}"))?;
    let row_len = width as usize;
    // SAFETY: the mapping is valid until `Unmap`, `RowPitch` is at least
    // `width`, and `pData` spans `RowPitch * height` readable bytes.
    unsafe {
        let src = mapped.pData.cast::<u8>();
        let dst = out.as_mut_ptr();
        let pitch = mapped.RowPitch as usize;
        if pitch == row_len {
            std::ptr::copy_nonoverlapping(src, dst, row_len * height as usize);
        } else {
            for y in 0..height as usize {
                std::ptr::copy_nonoverlapping(src.add(y * pitch), dst.add(y * row_len), row_len);
            }
        }
        context.Unmap(staging, 0);
    }
    Ok(())
}

/// Reference limited-range BT.601 conversion, shared with the tests. Rounds
/// rather than truncates, matching the float-to-unorm8 conversion the render
/// target performs.
#[doc(hidden)]
pub fn bgra_to_nv12_reference(bgra: &[u8], width: u32, height: u32, out: &mut [u8]) {
    let w = width as usize;
    let y_len = w * height as usize;
    for (p, px) in out[..y_len].iter_mut().enumerate() {
        let i = p * 4;
        let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
        let lum = 0.256788 * r + 0.504129 * g + 0.097906 * b + 16.0;
        *px = lum.clamp(0.0, 255.0).round() as u8;
    }
    for y in (0..height as usize).step_by(2) {
        for x in (0..w).step_by(2) {
            let (mut cb, mut cr) = (0.0f32, 0.0f32);
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let i = ((y + dy) * w + (x + dx)) * 4;
                let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
                cb += -0.148223 * r - 0.290993 * g + 0.439216 * b + 128.0;
                cr += 0.439216 * r - 0.367788 * g - 0.071427 * b + 128.0;
            }
            let o = y_len + (y / 2) * w + x;
            out[o] = (cb * 0.25).clamp(0.0, 255.0).round() as u8;
            out[o + 1] = (cr * 0.25).clamp(0.0, 255.0).round() as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nv12_len(width: u32, height: u32) -> usize {
        (width as usize * height as usize * 3) / 2
    }

    /// Compile every entry point. The shaders are only built at runtime, so
    /// without this an HLSL type error would not surface until a recording
    /// started on a user's machine.
    #[test]
    fn shaders_compile() {
        for (src, entry, target) in [
            (VERTEX_SHADER, "vsMain", "vs_4_0"),
            (PIXEL_SHADER, "psY", "ps_4_0"),
            (PIXEL_SHADER, "psUV", "ps_4_0"),
        ] {
            let code = compile(src, entry, target)
                .unwrap_or_else(|e| panic!("{entry} failed to compile: {e}"));
            assert!(
                code.len() > 16,
                "{entry} produced {} bytes, which cannot be a shader",
                code.len()
            );
        }
    }

    #[test]
    fn chroma_covers_the_whole_frame() {
        // A single red column at the far right of the frame, on a black
        // background. Chroma texel i must average source columns 2i and 2i+1,
        // so the rightmost column has to reach the last UV texel. A halved
        // index would leave it in the left half of the plane and never tint the
        // right side, which is the "colours stretched 2x" failure.
        let (w, h) = (64u32, 4u32);
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        for y in 0..h as usize {
            let i = ((y * w as usize) + (w as usize - 1)) * 4;
            bgra[i..i + 4].copy_from_slice(&[0, 0, 255, 255]);
        }
        let mut out = vec![0u8; nv12_len(w, h)];
        bgra_to_nv12_reference(&bgra, w, h, &mut out);

        let y_len = w as usize * h as usize;
        // A chroma row is `w` bytes holding `w / 2` RG texels, so the last
        // texel occupies the final two bytes of the row.
        let last = &out[y_len + w as usize - 2..y_len + w as usize];
        assert!(
            last[0] < 128 && last[1] > 128,
            "the rightmost source column must tint the last chroma texel, got {last:?}"
        );
        let first = &out[y_len..y_len + 2];
        assert!(
            (first[0] as i32 - 128).abs() <= 1 && (first[1] as i32 - 128).abs() <= 1,
            "the leftmost chroma texel is pure black here, got {first:?}"
        );
    }

    #[test]
    fn chroma_plane_is_half_the_frame_in_bytes() {
        // Both NV12 planes are `width` BYTES per row; the chroma plane is half
        // as many rows. Getting this wrong is what stretched the colours.
        let (w, h) = (1920u32, 1080u32);
        let y_len = w as usize * h as usize;
        assert_eq!(y_len, 2_073_600);
        assert_eq!(nv12_len(w, h) - y_len, w as usize * (h / 2) as usize);
        assert_eq!(nv12_len(w, h) - y_len, 1_036_800);
    }

    #[test]
    fn luma_endpoints_match_bt601_limited_range() {
        let (w, h) = (2u32, 2u32);
        // Two black pixels then two white ones.
        let bgra: Vec<u8> = [
            0u8, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255,
        ]
        .to_vec();
        let mut out = vec![0u8; nv12_len(w, h)];
        bgra_to_nv12_reference(&bgra, w, h, &mut out);
        assert_eq!(out[0], 16, "black is Y=16");
        assert_eq!(out[2], 235, "white is Y=235");
    }

    #[test]
    fn neutral_grey_has_neutral_chroma() {
        let (w, h) = (2u32, 2u32);
        let bgra = [[128u8, 128, 128, 255]; 4].concat();
        let mut out = vec![0u8; nv12_len(w, h)];
        bgra_to_nv12_reference(&bgra, w, h, &mut out);
        let uv = &out[4..];
        assert!(
            uv.iter().all(|&c| (c as i32 - 128).abs() <= 1),
            "grey chroma is neutral, got {uv:?}"
        );
    }

    #[test]
    fn red_pushes_chroma_in_opposite_directions() {
        let (w, h) = (2u32, 2u32);
        let bgra = [[0u8, 0, 255, 255]; 4].concat();
        let mut out = vec![0u8; nv12_len(w, h)];
        bgra_to_nv12_reference(&bgra, w, h, &mut out);
        assert!(out[4] < 128, "red Cb is below neutral, got {}", out[4]);
        assert!(out[5] > 128, "red Cr is above neutral, got {}", out[5]);
    }

    #[test]
    fn nv12_is_two_thirds_the_size_of_bgra() {
        let (w, h) = (1920u32, 1080u32);
        assert_eq!(nv12_len(w, h), 3_110_400);
        assert_eq!(w as usize * h as usize * 4, 8_294_400);
    }

    #[test]
    fn params_carry_the_cursor_rectangle() {
        assert_eq!(
            &params_bytes(1920, 1080, None)[24..28],
            &[0, 0, 0, 0],
            "no cursor is a zero-width rectangle"
        );
        let shape = vec![0u8; 4];
        let with = params_bytes(
            1920,
            1080,
            Some(&CursorUpload {
                shape: &shape,
                pitch: 4,
                width: 1,
                height: 1,
                x: 10,
                y: 20,
            }),
        );
        assert_eq!(i32::from_ne_bytes(with[16..20].try_into().unwrap()), 10);
        assert_eq!(i32::from_ne_bytes(with[20..24].try_into().unwrap()), 20);
    }
}
