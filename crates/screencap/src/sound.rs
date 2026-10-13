//! User-supplied WAV cues: `replay.save_intent_sound` plays when a save starts,
//! `replay.success_sound` when it finishes. No sound when a key is unset.

/// Play the WAV at `path` asynchronously. Missing files are logged and skipped
/// (there is no built-in default). `cue` names which key the request came from so
/// a missing or unplayable file is attributable. No-op on non-Windows.
#[cfg(windows)]
pub fn play_sound(cue: &str, path: &str) {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

    if !std::path::Path::new(path).exists() {
        tracing::warn!(cue, path, "sound file not found");
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
            tracing::warn!(cue, path, "failed to play sound");
        }
    }
}

#[cfg(not(windows))]
pub fn play_sound(_cue: &str, _path: &str) {}
