//! Embedded localhost HTTP server for library media.
//!
//! WebView2's `WebResourceRequested`-intercepted schemes (asset protocol,
//! custom URI schemes) were the audio problem, not range serving — the
//! editor's audio was being routed through a silent Web Audio graph. With
//! that fixed, clips are served by this real HTTP server with full HTTP Range
//! support so the `<video>` element can seek.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tiny_http::{Header, Method, Response, Server, StatusCode};

type Body = Box<dyn Read + Send + 'static>;

fn empty_resp(status: StatusCode) -> Response<Body> {
    Response::new(
        status,
        Vec::new(),
        Box::new(std::io::empty()) as Body,
        Some(0),
        None,
    )
}

/// Start the server on an ephemeral localhost port. Returns the bound port.
pub fn start() -> Result<u16, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("media server bind: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let server = Arc::new(server);

    std::thread::Builder::new()
        .name("media-server".to_string())
        .spawn(move || {
            // Serve requests concurrently so the visualizer's fetch never
            // waits behind the video element's stream.
            for request in server.incoming_requests() {
                std::thread::Builder::new()
                    .name("media-server-req".to_string())
                    .spawn(move || {
                        let response = handle(&request);
                        if let Err(e) = request.respond(response) {
                            eprintln!("[media-server] respond: {e}");
                        }
                    })
                    .map_err(|e| eprintln!("[media-server] spawn: {e}"))
                    .ok();
            }
        })
        .map_err(|e| format!("media server thread: {e}"))?;

    Ok(port)
}

fn handle(request: &tiny_http::Request) -> Response<Body> {
    fn cors(mut resp: Response<Body>) -> Response<Body> {
        resp.add_header(
            Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        );
        resp
    }

    if request.method() == &Method::Options {
        let mut resp = empty_resp(StatusCode(204));
        resp.add_header(
            Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        );
        resp.add_header(
            Header::from_bytes(
                &b"Access-Control-Allow-Headers"[..],
                &b"Range, Content-Range"[..],
            )
            .unwrap(),
        );
        return resp;
    }

    let path = match decode_path(request.url()) {
        Some(p) => p,
        None => return cors(empty_resp(StatusCode(400))),
    };

    let metadata = match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => m,
        _ => return cors(empty_resp(StatusCode(404))),
    };
    let total = metadata.len();

    let content_type = content_type_for(&path).unwrap_or("application/octet-stream");
    let ct = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap();
    let accept_ranges = Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap();

    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_owned());

    let (status, start, end) = match range.as_deref() {
        None => (StatusCode(200), 0u64, total.saturating_sub(1)),
        Some(r) => match parse_range(r, total) {
            Ok((s, e)) => (StatusCode(206), s, e),
            Err(()) => {
                let mut resp = empty_resp(StatusCode(416));
                resp.add_header(
                    Header::from_bytes(
                        &b"Content-Range"[..],
                        format!("bytes */{total}").as_bytes(),
                    )
                    .unwrap(),
                );
                return cors(resp);
            }
        },
    };
    if start >= total {
        let mut resp = empty_resp(StatusCode(416));
        resp.add_header(
            Header::from_bytes(&b"Content-Range"[..], format!("bytes */{total}").as_bytes())
                .unwrap(),
        );
        return cors(resp);
    }
    let content_length = end - start + 1;

    // HEAD: announce without a body.
    if request.method() == &Method::Head {
        let mut resp = empty_resp(StatusCode(200));
        resp.add_header(ct);
        resp.add_header(accept_ranges);
        resp.add_header(
            Header::from_bytes(&b"Content-Length"[..], total.to_string().as_bytes()).unwrap(),
        );
        return cors(resp);
    }

    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return cors(empty_resp(StatusCode(404))),
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return cors(empty_resp(StatusCode(500)));
    }

    // Force identity (Content-Length) encoding; chunked media is unreliable in
    // this WebView2.
    let mut resp = Response::new(
        status,
        Vec::new(),
        Box::new(file) as Body,
        Some(content_length as usize),
        None,
    )
    .with_chunked_threshold(usize::MAX);
    resp.add_header(ct);
    resp.add_header(accept_ranges);
    resp.add_header(
        Header::from_bytes(
            &b"Content-Length"[..],
            content_length.to_string().as_bytes(),
        )
        .unwrap(),
    );
    if status == StatusCode(206) {
        resp.add_header(
            Header::from_bytes(
                &b"Content-Range"[..],
                format!("bytes {start}-{end}/{total}").as_bytes(),
            )
            .unwrap(),
        );
    }
    cors(resp)
}

/// Decode `http://127.0.0.1:<port>/<percent-encoded absolute path>` into a
/// `PathBuf`. Rejects traversal and relative paths.
fn decode_path(url: &str) -> Option<PathBuf> {
    let raw = url.split('?').next().unwrap_or(url);
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    let stripped = decoded.trim_start_matches('/');
    if stripped.is_empty() || stripped == "favicon.ico" {
        return None;
    }
    let path = Path::new(stripped);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(path.to_path_buf())
}

fn parse_range(header: &str, total: u64) -> Result<(u64, u64), ()> {
    let value = header.strip_prefix("bytes=").ok_or(())?;
    let (start_s, end_s) = value.split_once('-').ok_or(())?;
    if start_s.is_empty() {
        // Suffix range: last N bytes.
        let suffix: u64 = end_s.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = total.saturating_sub(suffix);
        return Ok((start, total.saturating_sub(1)));
    }
    let start: u64 = start_s.trim().parse().map_err(|_| ())?;
    let end = if end_s.is_empty() {
        total.saturating_sub(1)
    } else {
        end_s
            .trim()
            .parse::<u64>()
            .map_err(|_| ())?
            .min(total.saturating_sub(1))
    };
    if start > end {
        return Err(());
    }
    Ok((start, end))
}

fn content_type_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    match ext.as_str() {
        "mp4" => Some("video/mp4"),
        "mkv" => Some("video/x-matroska"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "avi" => Some("video/x-msvideo"),
        "wav" => Some("audio/wav"),
        "mp3" => Some("audio/mpeg"),
        "ogg" => Some("audio/ogg"),
        "m4a" => Some("audio/mp4"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000).unwrap(), (0, 99));
        assert_eq!(parse_range("bytes=500-", 1000).unwrap(), (500, 999));
        assert_eq!(parse_range("bytes=-100", 1000).unwrap(), (900, 999));
        assert_eq!(parse_range("bytes=100-50", 1000), Err(()));
        assert_eq!(parse_range("bytes=0-9999", 1000).unwrap(), (0, 999));
        assert_eq!(parse_range("items=0-1", 1000), Err(()));
        assert_eq!(parse_range("bytes=-0", 1000), Err(()));
    }

    #[test]
    fn path_decoding() {
        let p = decode_path("/C%3A%5CUsers%5Clucas%5Cclip.mp4").unwrap();
        assert_eq!(p, PathBuf::from(r"C:\Users\lucas\clip.mp4"));
        let p = decode_path("/%5C%5C%3F%5CE%3A%5Cclips%5Cclip.mkv").unwrap();
        assert_eq!(p, PathBuf::from(r"\\?\E:\clips\clip.mkv"));
        assert!(decode_path("/..%5C..%5Cwindows").is_none());
        assert!(decode_path("/relative/path.mp4").is_none());
    }
}
