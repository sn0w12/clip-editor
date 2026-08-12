//! User-supplied success sound (`replay.success_sound`): a WAV file played
//! asynchronously after a clip is saved. No sound when the option is unset.

/// Play the WAV at `path` asynchronously. Missing files are logged and
/// skipped (no default sound). No-op on non-Windows.
#[cfg(windows)]
pub fn play_sound(path: &str) {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

    if !std::path::Path::new(path).exists() {
        tracing::warn!(path, "success sound file not found");
        return;
    }
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let ok = PlaySoundW(
            windows::core::PCWSTR(wide.as_ptr()),
            None,
            SND_FILENAME | SND_ASYNC | SND_NODEFAULT,
        );
        if !ok.as_bool() {
            tracing::warn!(path, "failed to play success sound");
        }
    }
}

#[cfg(not(windows))]
pub fn play_sound(path: &str) {
    let _ = path;
}
