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

fn main() {
    let out_path = std::env::args().nth(1);

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
