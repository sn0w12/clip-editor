//! Windows integration test/helper (plan §6.2).
//!
//! Starts the built `screencap` binary with a 3-second fixture configuration,
//! waits for the buffer to fill, synthesizes the configured global hotkey with
//! `SendInput`, waits for the saved Matroska, and verifies it with the bundled
//! ffprobe: one video stream, five audio streams whose `screencap_track`
//! metadata is 1/2/3/4/5 (track 4 is the silent placeholder for the missing
//! configured number), stream titles matching the configured names, and a
//! duration within one segment of 3 seconds.
//!
//! Gated behind `SCREENCAP_ITEST=1` because it needs an interactive desktop
//! session (screen capture, microphone access, and a global hotkey). On
//! non-Windows hosts this module is not compiled at all.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY,
};

const FIXTURE: &str = r#"[replay]
duration_seconds = 3
segment_seconds = 1
output_dir = "__OUTDIR__"
filename_base = "Replay"
monitor = "primary"
fps = 30
hotkey = "ctrl+shift+KeyQ"
success_sound = "__SOUND__"

[video]
codec = "libx264"
quality = 23
cursor = true

[audio]
sample_rate = 48000
channels = 2
block_ms = 20

[[audio.processes]]
id = "spotify"
executable = "Spotify.exe"
tags = ["muted"]
include_children = true

[[audio.processes]]
id = "browser"
executable = "chrome.exe"
tags = ["muted"]
include_children = true

[[audio.processes]]
id = "discord"
executable = "Discord.exe"
tags = ["tracked"]
include_children = true

[[audio.inputs]]
id = "mic"
kind = "microphone"
device = "default"

[[audio.tracks]]
number = 1
name = "other"
include = ["all_processes"]
exclude = ["tag:muted", "tag:tracked"]

[[audio.tracks]]
number = 2
name = "discord"
include = ["source:discord"]
exclude = []

[[audio.tracks]]
number = 3
name = "mic"
include = ["input:mic"]
exclude = []

[[audio.tracks]]
number = 5
name = "non_muted"
include = ["all_nonmuted_processes"]
exclude = []
"#;

#[test]
fn end_to_end_save_via_hotkey() {
    let _guard = TEST_LOCK.lock();
    if std::env::var("SCREENCAP_ITEST").as_deref() != Ok("1") {
        eprintln!("SKIP: set SCREENCAP_ITEST=1 to run the interactive capture integration test");
        return;
    }

    let work = unique_dir();
    let out = work.join("out");
    let cfg = work.join("config.toml");
    let out_dir_str = out.to_string_lossy().replace('\\', "/");
    let fixture = FIXTURE.replace("__OUTDIR__", &out_dir_str);
    // Generate a real WAV so the success sound actually plays.
    let app_dir = Path::new(env!("CARGO_BIN_EXE_screencap"))
        .parent()
        .expect("app parent dir");
    let ffmpeg = app_dir.join("ffmpeg.exe");
    let wav = work.join("save.wav");
    let status = Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=0.2",
        ])
        .arg(&wav)
        .status()
        .expect("ffmpeg runs to generate the sound");
    assert!(status.success(), "ffmpeg generates the test wav");
    let wav_str = wav.to_string_lossy().replace('\\', "/");
    let fixture = fixture.replace("__SOUND__", &wav_str);
    std::fs::write(&cfg, fixture).unwrap();

    let app = env!("CARGO_BIN_EXE_screencap");
    let log_path = work.join("app.log");
    let log = std::fs::File::create(&log_path).expect("create log file");
    let mut child = Command::new(app)
        .args(["run", "--config"])
        .arg(&cfg)
        .stdout(Stdio::from(log.try_clone().expect("clone log")))
        .stderr(Stdio::from(log))
        .spawn()
        .expect("spawn screencap");

    let mut failed = None;

    // 1. Wait for startup (allows the first-run ffmpeg download).
    if !wait_for(&log_path, "monitor resolved", Duration::from_secs(120)) {
        failed = Some("app did not reach startup within 120s".to_string());
    }
    // 2. Wait until the buffer is fully filled (cold starts can take 10s+
    // under parallel capture), then press the hotkey (retrying a lost press)
    // until the saved Matroska appears.
    if failed.is_none() && !wait_for(&log_path, "fill_percent=\"100%\"", Duration::from_secs(120)) {
        failed = Some("buffer never reached 100% fill".to_string());
    }
    let saved = if failed.is_none() {
        let mut saved = None;
        for _ in 0..6 {
            if let Some(p) = newest_mkv(&out) {
                saved = Some(p);
                break;
            }
            press_hotkey();
            std::thread::sleep(Duration::from_secs(5));
        }
        saved.or_else(|| newest_mkv(&out))
    } else {
        None
    };

    // 5. Stop the app (hard kill is fine after the atomic rename).
    let _ = child.kill();
    let _ = child.wait();

    if let Some(message) = failed {
        eprintln!("integration test failed: {message}");
        eprintln!(
            "app log:\n{}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        panic!("{message}");
    }
    let saved = saved.expect("saved mkv appeared within 30s");

    // 6. Structural verification with the bundled ffprobe.
    let ffprobe = app_dir.join("ffprobe.exe");
    assert!(
        ffprobe.exists(),
        "ffprobe.exe must sit beside screencap.exe"
    );

    let json = run_ffprobe(&ffprobe, &saved);
    let streams = json["streams"].as_array().expect("streams array");
    let video = streams
        .iter()
        .filter(|s| s["codec_type"] == "video")
        .collect::<Vec<_>>();
    assert_eq!(video.len(), 1, "exactly one video stream");

    let audio: Vec<&serde_json::Value> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    assert_eq!(
        audio.len(),
        5,
        "five audio streams (track 4 is the silent placeholder)"
    );

    let mut track_numbers: Vec<u32> = audio
        .iter()
        .map(|s| {
            // Matroska stores custom tag names uppercase (SCREENCAP_TRACK).
            tag_of(s, "screencap_track")
                .parse::<u32>()
                .unwrap_or_else(|e| panic!("screencap_track metadata missing/invalid: {e}"))
        })
        .collect();
    track_numbers.sort_unstable();
    assert_eq!(
        track_numbers,
        vec![1, 2, 3, 4, 5],
        "screencap_track metadata 1/2/3/4/5"
    );

    let mut titles: Vec<String> = audio.iter().map(|s| tag_of(s, "title")).collect();
    titles.sort();
    let mut expected = vec!["discord", "mic", "non_muted", "other", "silent"];
    expected.sort();
    assert_eq!(
        titles, expected,
        "stream titles match configured track names"
    );

    let duration: f64 = json["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        (2.0..=5.0).contains(&duration),
        "duration {duration:.2}s within one segment of 3s"
    );

    // The configured success sound must have played without error.
    let app_log = std::fs::read_to_string(&log_path).unwrap_or_default();
    assert!(
        !app_log.contains("failed to play success sound"),
        "success sound playback should succeed"
    );

    let _ = std::fs::remove_dir_all(&work);
}

/// Serializes the interactive tests (all inject keyboard input and use global
/// input state).
static TEST_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// The Menu key (which global-hotkey cannot express) must work as the
/// configured hotkey end to end: registered via the extended path, triggered
/// by the key, and saved like any hotkey.
#[test]
fn menu_key_hotkey_saves_clip() {
    let _guard = TEST_LOCK.lock();
    if std::env::var("SCREENCAP_ITEST").as_deref() != Ok("1") {
        eprintln!("SKIP: set SCREENCAP_ITEST=1 to run the interactive capture integration test");
        return;
    }
    let work = unique_dir();
    let out = work.join("out");
    let cfg = work.join("config.toml");
    let fixture = FIXTURE
        .replace("__OUTDIR__", &out.to_string_lossy().replace('\\', "/"))
        .replace("hotkey = \"ctrl+shift+KeyQ\"", "hotkey = \"ContextMenu\"");
    std::fs::write(&cfg, fixture).unwrap();

    let app = env!("CARGO_BIN_EXE_screencap");
    let log_path = work.join("app.log");
    let log = std::fs::File::create(&log_path).unwrap();
    let mut child = Command::new(app)
        .args(["run", "--config"])
        .arg(&cfg)
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .expect("spawn screencap");

    let mut failed = None;
    if !wait_for(&log_path, "monitor resolved", Duration::from_secs(120)) {
        failed = Some("app did not reach startup within 120s".to_string());
    }
    std::thread::sleep(Duration::from_secs(8));
    let saved = if failed.is_none() {
        let mut saved = None;
        for _ in 0..6 {
            if let Some(p) = newest_mkv(&out) {
                saved = Some(p);
                break;
            }
            send_menu_key();
            std::thread::sleep(Duration::from_secs(5));
        }
        saved.or_else(|| newest_mkv(&out))
    } else {
        None
    };
    let _ = child.kill();
    let _ = child.wait();

    if let Some(message) = failed {
        panic!(
            "{message}\napp log:\n{}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
    }
    assert!(saved.is_some(), "menu-key hotkey must produce a saved clip");
    let _ = std::fs::remove_dir_all(&work);
}

#[test]
fn hotkey_recording_writes_config() {
    let _guard = TEST_LOCK.lock();
    if std::env::var("SCREENCAP_ITEST").as_deref() != Ok("1") {
        eprintln!("SKIP: set SCREENCAP_ITEST=1 to run the interactive capture integration test");
        return;
    }
    let work = unique_dir();
    let cfg = work.join("config.toml");
    std::fs::write(
        &cfg,
        "[replay]\nhotkey = \"ctrl+shift+KeyQ\"\n[video]\ncodec = \"auto\"\n",
    )
    .unwrap();
    let out_log = work.join("rec.log");
    let log = std::fs::File::create(&out_log).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_screencap"))
        .args(["hotkey", "--config"])
        .arg(&cfg)
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .expect("spawn hotkey recorder");

    // Give the keyboard hook time to install, then press the Menu key.
    std::thread::sleep(Duration::from_millis(600));
    send_menu_key();

    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(s) = child.try_wait().expect("recorder exits") {
            break s;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!(
                "hotkey recorder did not exit; log:\n{}",
                std::fs::read_to_string(&out_log).unwrap_or_default()
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(status.success(), "recorder exited cleanly");

    let cfg_text = std::fs::read_to_string(&cfg).unwrap();
    assert!(
        cfg_text.contains("hotkey = \"ContextMenu\""),
        "recorded hotkey written to config: {cfg_text}"
    );
    let _ = std::fs::remove_dir_all(&work);
}

/// Synthesize the Menu key (VK_APPS).
fn send_menu_key() {
    unsafe {
        for (vk, up) in [(0x5Du16, false), (0x5D, true)] {
            let input = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(vk),
                        wScan: 0,
                        dwFlags: if up {
                            KEYEVENTF_KEYUP
                        } else {
                            Default::default()
                        },
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(Duration::from_millis(30));
        }
    }
}

fn unique_dir() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("screencap_itest_{}_{}", std::process::id(), stamp));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn wait_for(log: &Path, needle: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(content) = std::fs::read_to_string(log) {
            if content.contains(needle) {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

/// The newest `.mkv` in `out`, if any.
fn newest_mkv(out: &Path) -> Option<PathBuf> {
    let mut newest: Option<PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(out) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "mkv") {
                match &newest {
                    Some(prev) if prev < &path => newest = Some(path),
                    None => newest = Some(path),
                    _ => {}
                }
            }
        }
    }
    newest
}

/// Synthesize Ctrl+Shift+Q with SendInput so the app's registered global
/// hotkey fires exactly like a real keypress.
fn press_hotkey() {
    unsafe {
        let ctrl = VIRTUAL_KEY(0x11);
        let shift = VIRTUAL_KEY(0x10);
        let q = VIRTUAL_KEY(0x51);
        for (vk, up) in [
            (ctrl, false),
            (shift, false),
            (q, false),
            (q, true),
            (shift, true),
            (ctrl, true),
        ] {
            let input = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: 0,
                        dwFlags: if up {
                            KEYEVENTF_KEYUP
                        } else {
                            Default::default()
                        },
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(Duration::from_millis(30));
        }
    }
}

fn run_ffprobe(ffprobe: &Path, file: &Path) -> serde_json::Value {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(file)
        .output()
        .expect("ffprobe runs");
    assert!(output.status.success(), "ffprobe succeeded");
    serde_json::from_slice(&output.stdout).expect("ffprobe json parses")
}

/// Case-insensitive tag lookup (Matroska normalizes tag names to uppercase).
fn tag_of(stream: &serde_json::Value, name: &str) -> String {
    let tags = stream["tags"].as_object().expect("stream tags object");
    let upper = name.to_uppercase();
    for (key, value) in tags {
        if key.eq_ignore_ascii_case(name) || key.eq_ignore_ascii_case(&upper) {
            return value.as_str().unwrap_or_default().to_string();
        }
    }
    panic!("tag `{name}` missing from {tags:?}");
}
