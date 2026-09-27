//! Dump one GPU-converted capture frame and report what is actually in each
//! NV12 plane. This is the diagnostic for "the recorded video is a solid
//! colour": it separates a broken conversion (a plane that is all zeros, or
//! luma pinned at 16) from a correct conversion being misinterpreted further
//! down the pipeline.
//!
//! ```text
//! cargo run --release --example nv12dump -- [out.nv12]
//! ```
//!
//! With an output path it also writes the raw frame so it can be inspected
//! outside the app:
//!
//! ```text
//! ffmpeg -f rawvideo -pix_fmt nv12 -s 1920x1080 -i out.nv12 -frames:v 1 out.png
//! ```

use std::time::{Duration, Instant};

use screencap::video::nv12::Nv12Converter;
use screencap::video::nv12_frame_bytes;
use windows_capture::dxgi_duplication_api::{
    DxgiDuplicationApi, DxgiDuplicationFrame, Error as DxgiError,
};
use windows_capture::monitor::Monitor;

/// Filler for the output buffer. Distinguishes "the conversion wrote zeros"
/// from "the conversion never touched the buffer at all", which a zeroed
/// buffer cannot show.
const SENTINEL: u8 = 0xAA;

fn report(name: &str, plane: &[u8]) {
    let min = plane.iter().copied().min().unwrap_or(0);
    let max = plane.iter().copied().max().unwrap_or(0);
    let mean = plane.iter().map(|&b| b as u64).sum::<u64>() as f64 / plane.len().max(1) as f64;
    let zeros = plane.iter().filter(|&&b| b == 0).count();
    let untouched = plane.iter().filter(|&&b| b == SENTINEL).count();
    println!(
        "  {name:<3} len={:<9} min={min:<4} max={max:<4} mean={mean:>7.2} zeros={} sentinel={untouched}/{}{}",
        plane.len(),
        zeros,
        plane.len(),
        if untouched == plane.len() {
            "  <-- CONVERSION NEVER WROTE"
        } else {
            ""
        },
    );
    let head: Vec<String> = plane[..16.min(plane.len())]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    println!("       head: {}", head.join(" "));
}

/// Copy the acquired frame into a staging texture and map it, reporting the
/// blue channel's range. This is the readback the NV12 converter replaced; if it
/// also reads as uniformly zero then the acquired frame itself is not readable
/// here and the converter is not at fault.
fn reference_staging_readback(frame: &DxgiDuplicationFrame<'_>, w: u32, h: u32) {
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;

    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: frame.texture_desc().Format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut staging = None;
    // SAFETY: the device is live and `staging` receives the new texture.
    if unsafe {
        frame
            .device()
            .CreateTexture2D(&desc, None, Some(&mut staging))
    }
    .is_err()
    {
        println!("  reference readback: could not create the staging texture");
        return;
    }
    let staging = staging.expect("checked above");
    let context = frame.device_context();
    // SAFETY: the frame is held, so its texture is valid; the staging texture is
    // not mapped.
    unsafe {
        context.CopyResource(&staging, frame.texture());
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        match context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) {
            Ok(()) => {
                // SAFETY: the mapping is valid until `Unmap`.
                unsafe {
                    let pitch = mapped.RowPitch as usize;
                    let (mut min, mut max, mut sum, mut n) = (255u8, 0u8, 0u64, 0u64);
                    for y in 0..h as usize {
                        let row = mapped.pData.cast::<u8>().add(y * pitch);
                        for x in (0..w as usize).step_by(64) {
                            // Blue channel of a BGRA texel.
                            let b = *row.add(x * 4 + 2);
                            min = min.min(b);
                            max = max.max(b);
                            sum += b as u64;
                            n += 1;
                        }
                    }
                    println!(
                        "  reference readback (BGRA staging): blue min={min} max={max} mean={:.2}",
                        sum as f64 / n.max(1) as f64
                    );
                    context.Unmap(&staging, 0);
                }
            }
            Err(e) => println!("  reference readback: map failed: {e}"),
        }
    }
}

/// Fraction of the frame DXGI reports as changed, mirroring the capture loop's
/// `dirty_area_fraction`. `None` means "definitely large", which never skips.
fn dirty_area_fraction(frame: &DxgiDuplicationFrame<'_>, width: u32, height: u32) -> Option<f64> {
    const MAX_DIRTY_RECTS: usize = 256;
    let mut rects = vec![windows::Win32::Foundation::RECT::default(); MAX_DIRTY_RECTS];
    let bytes = (rects.len() * std::mem::size_of::<windows::Win32::Foundation::RECT>()) as u32;
    let mut required = 0u32;
    // SAFETY: `rects` is `bytes` long and the duplication writes at most that.
    if unsafe {
        frame
            .duplication()
            .GetFrameDirtyRects(bytes, rects.as_mut_ptr(), &mut required)
    }
    .is_err()
    {
        return None;
    }
    let count = (required as usize / std::mem::size_of::<windows::Win32::Foundation::RECT>())
        .min(rects.len());
    let mut area = 0u64;
    for r in &rects[..count] {
        let w = (r.right - r.left).max(0) as u64;
        let h = (r.bottom - r.top).max(0) as u64;
        area += w * h;
    }
    Some((area as f64 / (width as f64 * height as f64)).min(1.0))
}

/// Acquire and convert `count` frames, reporting how long the conversion takes
/// and how often the capture loop would skip a tick as unchanged. Run this while
/// the game is running: a conversion slower than the 16.7 ms tick means the
/// capture thread cannot publish 60 unique frames a second.
fn measure_loop(count: u32) {
    const DIRTY_SKIP_FRACTION: f64 = 0.005;
    // Must match the capture loop's acquire timeout, or the measurement does not
    // describe the real capture path.
    const ACQUIRE_TIMEOUT_MS: u32 = 17;
    let monitor = Monitor::primary().expect("primary monitor");
    let mut api = DxgiDuplicationApi::new(monitor).expect("open DXGI duplication");

    let mut converter: Option<Nv12Converter> = None;
    let mut buf: Vec<u8> = Vec::new();
    let (mut aw, mut ah) = (0u32, 0u32);
    let mut times: Vec<f64> = Vec::new();
    let mut skipped = 0u32;
    let mut timeouts = 0u32;
    let mut dirty_samples: Vec<f64> = Vec::new();

    for _ in 0..count {
        let frame = loop {
            match api.acquire_next_frame(ACQUIRE_TIMEOUT_MS) {
                Ok(f) => break f,
                Err(DxgiError::Timeout) => {
                    timeouts += 1;
                    continue;
                }
                Err(e) => panic!("acquire failed: {e:?}"),
            }
        };
        let (w, h) = (frame.width(), frame.height());
        aw = w;
        ah = h;
        if converter
            .as_ref()
            .is_none_or(|c| !c.matches(&frame.device(), w, h))
        {
            converter = Nv12Converter::new(&frame.device(), frame.texture_desc().Format, w, h).ok();
            buf = vec![SENTINEL; nv12_frame_bytes(w, h)];
        }
        match dirty_area_fraction(&frame, w, h) {
            Some(f) if f <= DIRTY_SKIP_FRACTION => skipped += 1,
            Some(f) => dirty_samples.push(f),
            None => dirty_samples.push(1.0),
        }
        let c = converter.as_mut().expect("converter");
        // SAFETY: the frame is held and the converter's targets are unmapped.
        let t = match unsafe {
            c.convert(
                &frame.device_context(),
                frame.texture(),
                w,
                h,
                None,
                &mut buf,
            )
        } {
            Ok(t) => t.as_secs_f64() * 1000.0,
            Err(e) => panic!("conversion failed: {e}"),
        };
        times.push(t);
    }

    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = times.iter().sum::<f64>() / times.len().max(1) as f64;
    let p95 = times[times.len() * 95 / 100];
    println!("converted {} frames at {aw}x{ah}", times.len());
    println!(
        "  conversion ms: min={:.2} mean={:.2} p95={:.2} max={:.2}",
        times.first().copied().unwrap_or(0.0),
        mean,
        p95,
        times.last().copied().unwrap_or(0.0)
    );
    println!(
        "  budget at 60fps is 16.67 ms; frames over budget: {}",
        times.iter().filter(|t| **t > 16.67).count()
    );
    println!(
        "  ticks the dirty-skip would drop: {skipped}/{} ({timeouts} acquire timeouts)",
        times.len()
    );
    if !dirty_samples.is_empty() {
        dirty_samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "  dirty fraction of converted ticks: min={:.4} median={:.4} max={:.4}",
            dirty_samples.first().copied().unwrap_or(0.0),
            dirty_samples[dirty_samples.len() / 2],
            dirty_samples.last().copied().unwrap_or(0.0)
        );
    }
}

/// Convert a synthetic flat colour and report the exact bytes produced.
///
/// This measures the GPU's float-to-unorm8 rounding, which cannot be observed
/// from a real capture: neutral chroma is exactly 0.5, i.e. 127.5 in 8-bit, so
/// a truncating conversion lands on 127 instead of 128 and shifts neutral greys
/// by one LSB in Cr.
fn flat_probe(r: u8, g: u8, b: u8) {
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_SHADER_RESOURCE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_DEFAULT,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    let monitor = Monitor::primary().expect("primary monitor");
    let mut api = DxgiDuplicationApi::new(monitor).expect("open DXGI duplication");
    let frame = loop {
        match api.acquire_next_frame(17) {
            Ok(f) => break f,
            Err(DxgiError::Timeout) => continue,
            Err(e) => panic!("acquire failed: {e:?}"),
        }
    };
    let (w, h) = (frame.width(), frame.height());
    let device = frame.device();
    let context = frame.device_context();

    // `convert` copies the source with `CopyResource`, which requires
    // `D3D11_USAGE_DEFAULT`, so the test texture is created as a default-usage
    // shader resource and filled with initial data rather than updated.
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
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
    let row = w as usize * 4;
    let mut pixels = vec![0u8; row * h as usize];
    for px in pixels.chunks_exact_mut(4) {
        px.copy_from_slice(&[b, g, r, 255]);
    }
    let sub = D3D11_SUBRESOURCE_DATA {
        pSysMem: pixels.as_ptr().cast(),
        SysMemPitch: row as u32,
        SysMemSlicePitch: 0,
    };
    let mut tex = None;
    // SAFETY: `pixels` holds `row * height` bytes, matching the dimensions and
    // `SysMemPitch`; the device is live and `tex` receives the new texture.
    unsafe { device.CreateTexture2D(&desc, Some(&sub), Some(&mut tex)) }
        .expect("create test texture");
    let tex = tex.expect("checked");

    let mut converter =
        Nv12Converter::new(&device, DXGI_FORMAT_B8G8R8A8_UNORM, w, h).expect("converter");
    let mut buf = vec![SENTINEL; nv12_frame_bytes(w, h)];
    // SAFETY: `tex` is a live texture on this device and the converter's
    // targets are unmapped.
    unsafe { converter.convert(&context, &tex, w, h, None, &mut buf) }.expect("convert");

    let y_len = w as usize * h as usize;
    let y = &buf[..y_len];
    let uv = &buf[y_len..];
    println!("flat probe rgb({r},{g},{b}) at {w}x{h}");
    println!(
        "  Y  min={} max={}   (neutral grey expects a single value)",
        y.iter().copied().min().unwrap(),
        y.iter().copied().max().unwrap()
    );
    println!(
        "  Cb min={} max={}",
        uv.iter().step_by(2).copied().min().unwrap(),
        uv.iter().step_by(2).copied().max().unwrap()
    );
    println!(
        "  Cr min={} max={}",
        uv.iter().skip(1).step_by(2).copied().min().unwrap(),
        uv.iter().skip(1).step_by(2).copied().max().unwrap()
    );
    let expect_y = (0.256788 * r as f64 + 0.504129 * g as f64 + 0.097906 * b as f64 + 16.0).round();
    println!("  expected Y for this colour = {expect_y}");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--flat") {
        let n = |i: usize| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(20u8);
        flat_probe(n(1), n(2), n(3));
        return;
    }
    if args.first().is_some_and(|a| a == "--loop") {
        let n = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(600u32);
        measure_loop(n);
        return;
    }
    let out_path = args.first().cloned();

    let monitor = Monitor::primary().expect("primary monitor");
    println!(
        "monitor {}x{}",
        monitor.width().expect("width"),
        monitor.height().expect("height")
    );
    let mut api = DxgiDuplicationApi::new(monitor).expect("open DXGI duplication");

    // Acquire one frame with a change in it. A static desktop times out
    // forever, so give up rather than hang.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if Instant::now() > deadline {
            panic!("no desktop change within 5s; move the mouse and re-run");
        }
        match api.acquire_next_frame(8) {
            Ok(frame) => {
                let (w, h) = (frame.width(), frame.height());
                let desc = frame.texture_desc();
                println!("acquired {w}x{h} format={:?}", desc.Format);
                println!(
                    "  texture desc: {}x{} mips={} usage={:?} bindflags=0x{:x} (bind_shader_resource=0x08: {})",
                    desc.Width,
                    desc.Height,
                    desc.MipLevels,
                    desc.Usage,
                    desc.BindFlags,
                    desc.BindFlags & 0x08 != 0
                );

                // Reference path: the BGRA readback this converter replaced,
                // used here only to prove the acquired texture is readable at
                // all. Copies into a staging texture and maps it.
                reference_staging_readback(&frame, w, h);

                let mut converter = match Nv12Converter::new(&frame.device(), desc.Format, w, h) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("converter creation failed: {e}");
                        return;
                    }
                };
                let mut buf = vec![SENTINEL; nv12_frame_bytes(w, h)];
                let y_len = w as usize * h as usize;
                // SAFETY: the acquired frame is held, so its texture is valid on
                // this context and the converter's targets are unmapped.
                let cpu = match unsafe {
                    converter.convert(
                        &frame.device_context(),
                        frame.texture(),
                        w,
                        h,
                        None,
                        &mut buf,
                    )
                } {
                    Ok(d) => d,
                    Err(e) => {
                        eprintln!("conversion failed: {e}");
                        return;
                    }
                };
                println!("  conversion took {:.2} ms", cpu.as_secs_f64() * 1000.0);
                println!(
                    "  expected {} bytes, got {}",
                    nv12_frame_bytes(w, h),
                    buf.len()
                );

                report("Y", &buf[..y_len]);
                report("UV", &buf[y_len..]);

                // Limited-range black is Y=16 with neutral chroma 128; a frame
                // pinned there is a correctly shaped black frame, while a frame
                // of Y=16 with chroma 0 decodes to solid green.
                let luma16 = buf[..y_len].iter().filter(|&&b| b == 16).count();
                println!(
                    "  Y==16: {luma16}/{} ({:.1}%)",
                    y_len,
                    100.0 * luma16 as f64 / y_len as f64
                );

                if let Some(path) = out_path {
                    std::fs::write(&path, &buf).expect("write frame");
                    println!("wrote {path}");
                }
                return;
            }
            Err(DxgiError::Timeout) => continue,
            Err(e) => panic!("acquire failed: {e:?}"),
        }
    }
}
