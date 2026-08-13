//! Output filename behavior: the old OBS script's `base + "_" + title + ".ext"`
//! convention with Windows-safe sanitization and collision suffixes.

use std::path::{Path, PathBuf};

/// Maximum length of the title component in characters.
const MAX_TITLE_CHARS: usize = 120;

/// Replace Windows-invalid characters (`\ / : * ? " < > |`) and control
/// characters with `_`, trim trailing spaces/periods, cap at 120 chars, and
/// fall back to `UnknownWindow` when nothing remains.
pub fn sanitize_title(title: &str) -> String {
    let mut out: String = title
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();

    // Windows forbids trailing spaces and periods.
    while out.ends_with(' ') || out.ends_with('.') {
        out.pop();
    }

    if out.is_empty() {
        return "UnknownWindow".to_string();
    }

    if out.chars().count() > MAX_TITLE_CHARS {
        let truncated: String = out.chars().take(MAX_TITLE_CHARS).collect();
        out = truncated;
    }

    out
}

/// Compute the output path `<filename_base>_<sanitized_title>.mp4`, appending
/// `_001`, `_002`, ... before the extension when the plain name already exists
/// in `dir`, so a second save with the same window title never overwrites the
/// first.
pub fn pick_output_path(dir: &Path, filename_base: &str, sanitized_title: &str) -> PathBuf {
    let stem = format!("{filename_base}_{sanitized_title}");
    let first = dir.join(format!("{stem}.mp4"));
    if !first.exists() {
        return first;
    }
    let mut n: u32 = 1;
    loop {
        let candidate = dir.join(format!("{stem}_{n:03}.mp4"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// The filename prefix including a local timestamp: `Replay 2026-08-09
/// 20-22-45`. The time uses dashes because colons are invalid in Windows
/// filenames. On non-Windows the base is returned unchanged.
pub fn timestamp_stem(filename_base: &str) -> String {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetLocalTime;
        let t = unsafe { GetLocalTime() };
        return format!(
            "{filename_base} {:04}-{:02}-{:02} {:02}-{:02}-{:02}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
        );
    }
    #[cfg(not(windows))]
    {
        filename_base.to_string()
    }
}

/// The foreground window's title at call time. On non-Windows this always
/// returns the empty string (mapped to `UnknownWindow` by [`sanitize_title`]).
#[cfg(windows)]
pub fn active_window_title() -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

#[cfg(not(windows))]
pub fn active_window_title() -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "screencap_naming_{tag}_{}_{}",
            std::process::id(),
            stamp
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitizes_windows_invalid_characters() {
        assert_eq!(sanitize_title("My/Game:Clip"), "My_Game_Clip");
        assert_eq!(sanitize_title("a\\b*c?d\"e<f>g|h"), "a_b_c_d_e_f_g_h");
    }

    #[test]
    fn empty_title_becomes_unknown_window() {
        assert_eq!(sanitize_title(""), "UnknownWindow");
        assert_eq!(sanitize_title("   "), "UnknownWindow");
        assert_eq!(sanitize_title("..."), "UnknownWindow");
        assert_eq!(sanitize_title("///"), "___");
    }

    #[test]
    fn trims_trailing_punctuation() {
        assert_eq!(sanitize_title("My Game."), "My Game");
        assert_eq!(sanitize_title("My Game "), "My Game");
        assert_eq!(sanitize_title("Clip: "), "Clip_");
    }

    #[test]
    fn caps_title_length() {
        let long = "x".repeat(300);
        let out = sanitize_title(&long);
        assert_eq!(out.chars().count(), 120);
    }

    #[test]
    fn collision_suffix_appended() {
        let dir = temp_dir("collide");
        let base = "Replay";
        let title = "My_Game_Clip";

        let first = pick_output_path(&dir, base, title);
        assert_eq!(
            first.file_name().unwrap().to_str().unwrap(),
            "Replay_My_Game_Clip.mp4"
        );
        std::fs::write(&first, "1").unwrap();

        let second = pick_output_path(&dir, base, title);
        assert_eq!(
            second.file_name().unwrap().to_str().unwrap(),
            "Replay_My_Game_Clip_001.mp4"
        );
        std::fs::write(&second, "2").unwrap();

        let third = pick_output_path(&dir, base, title);
        assert_eq!(
            third.file_name().unwrap().to_str().unwrap(),
            "Replay_My_Game_Clip_002.mp4"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn timestamp_stem_has_safe_format() {
        let stem = timestamp_stem("Replay");
        // "Replay YYYY-MM-DD HH-MM-SS" — dashes, never colons.
        let parts: Vec<&str> = stem.split(' ').collect();
        assert_eq!(parts.len(), 3, "base date time: {stem}");
        assert_eq!(parts[0], "Replay");
        let date = parts[1].as_bytes();
        assert_eq!(date.len(), 10);
        assert_eq!(date[4], b'-');
        assert_eq!(date[7], b'-');
        let time = parts[2].as_bytes();
        assert_eq!(time.len(), 8);
        assert_eq!(time[2], b'-');
        assert_eq!(time[5], b'-');
    }
}
