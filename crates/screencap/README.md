# screencap

A crash-tolerant, multi-track replay buffer for Windows. It continuously
captures the selected monitor and per-application audio into a rolling buffer;
when you press a global hotkey it saves the newest N seconds as
`<base> <date> <time>_<window-title>.mkv`.

No runtime installs are required: FFmpeg is bundled beside the executable in
releases, or downloaded automatically on first run (a system `ffmpeg` found
only through `PATH` is never used).

## Requirements

- Windows 10 build 20348+ or Windows 11 (application-loopback audio capture)
- The OS must have screen-capture and microphone permissions granted for the app

## Build

```sh
cargo build --release
```

The release bundle is `target/release/screencap.exe`; ship `ffmpeg.exe` beside
it (from the same FFmpeg build) for offline use.

## Usage

```
screencap [run] [--config PATH]        # start capturing (default command)
screencap validate [--config PATH]     # check config without opening devices
screencap init [--config PATH]         # write a minimal starting config
screencap init --example [--config PATH]  # write the full multi-track routing example
screencap keys                         # every config key, type, default, notes
screencap hotkey [--config PATH]      # press a key combo to set replay.hotkey
screencap processes [--contains TEXT]  # running processes + executable names
```

On first run the default config is written to
`%APPDATA%\screencap\config.toml` so it is always discoverable and editable
(no config file means the same embedded defaults). The defaults capture the
monitor and all process audio to a single track, saving the last 30 seconds
on `Ctrl+Shift+Q`.

## Configuration

The config file defaults to the platform config directory
(`%APPDATA%\screencap\config.toml`). `SCREENCAP_*` environment variables
override keys, using `__` for nesting:
`SCREENCAP_REPLAY__DURATION_SECONDS=60`.

Run `screencap keys` for the full reference. The important parts:

| Key                                           | Default              | Notes                                                                                                 |
| --------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `replay.duration_seconds`                     | `30`                 | Buffer length (1..=3600)                                                                              |
| `replay.segment_seconds`                      | `1`                  | Rolling segment length (1..=10, <= duration)                                                          |
| `replay.output_dir`                           | `captures`           | Where saved replays land                                                                              |
| `replay.filename_base`                        | `Replay`             | Outputs are `<base>_<title>.mkv`                                                                      |
| `replay.monitor`                              | `primary`            | or `index:<one-based-index>`                                                                          |
| `replay.fps`                                  | `60`                 | Capture rate (1..=240)                                                                                |
| `replay.hotkey`                               | `ctrl+shift+KeyQ`    | Global hotkey, e.g. `shift+alt+KeyQ`, `ContextMenu` (Menu key); `screencap hotkey` records it for you |
| `replay.success_sound`                        | `—`                  | Path to a WAV played after a clip is saved; omit for no sound                                         |
| `video.codec`                                 | `libx264`            | or `h264_nvenc` (GPU; far less CPU)                                                                   |
| `video.quality`                               | `23`                 | CRF (libx264) / CQ (nvenc), 0..=51                                                                    |
| `audio.sample_rate` / `channels` / `block_ms` | `48000` / `2` / `20` | Mix output format                                                                                     |

### Per-application audio routing

Each `[[audio.processes]]` rule names an executable (case-insensitive, see
`screencap processes` for exact names) and gives it a stable `id` and routing
`tags`. Each `[[audio.tracks]]` builds one output stream from ORed `include`
selectors minus `exclude` selectors:

- `all_processes` — every process source
- `all_nonmuted_processes` — every process source without the `muted` tag
- `source:<process-id>` — one configured process rule
- `input:<input-id>` — one configured input (microphone)
- `tag:<tag>` — everything carrying that tag

A `muted` tag only affects routing — nothing in screencap ever changes Windows
volume or mute state, and muted applications stay muted on every track because
capture binds to each application's render session, not a system loopback.

`screencap init --example` writes this full routing example: Spotify and the
browser muted, Discord on track 2, the microphone on track 3, all other
non-muted process audio on track 5:

```toml
[replay]
duration_seconds = 30
segment_seconds = 1
output_dir = "captures"
filename_base = "Replay"
monitor = "primary"
fps = 60
hotkey = "ctrl+shift+KeyQ"
# Optional: rolling buffer location. Omit it to use the system temp directory
# (normally the fast system drive) automatically; set it to force a specific
# disk, e.g. buffer_dir = "D:\\screencap-buffer".

[video]
codec = "auto"
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
number = 4
name = "non_muted"
include = ["all_nonmuted_processes"]
exclude = []
```

Track `number`s are stored as `screencap_track` stream metadata and the names
as stream titles, so the streams are identifiable in any player that shows
Matroska stream tags. Matroska numbers streams densely, so a config with
tracks 1/2/3/5 becomes four audio streams (1, 2, 3, 5) plus one silent
placeholder for the missing number 4 — the placeholder keeps the stream
position aligned with the configured numbering. A track list with no gaps
(numbered 1..N) produces exactly N audio streams with no placeholder.

## Saving

The hotkey samples the foreground window title at press time, so the file is
always `<base> <date> <time>_<sanitized-title>.mkv` (e.g. `Replay 2026-08-09 20-22-45_My_Game_Clip.mkv`, time dashes because colons are invalid in Windows filenames) regardless of later focus changes.
Windows-invalid characters become `_`, trailing spaces/periods are trimmed,
empty titles become `UnknownWindow`, and repeated saves with the same title get
`_001`, `_002`, ... suffixes. A save concatenates the newest whole segments
covering `duration_seconds` with a stream copy and renames atomically, so an
interrupted save never leaves a partial replay. Pressing the hotkey while a
save is running queues a single additional save rather than running two at
once.

## Notes

- The buffer is disk-bounded: only the newest `duration_seconds + one segment`
  are kept, and interrupted segments stay readable (Matroska) — the next run
  starts with a clean rolling directory. The rolling buffer lives in the
  system temp directory (`%TEMP%`, normally the fast system drive) by default
  so the per-second segment churn never lands on a slow save disk; set
  `replay.buffer_dir` to force a specific location. Leftover dirs from killed
  runs are swept at the next startup. The saved replay is always written to
  `replay.output_dir`.
- Encoding cost is the big lever. The default `codec = "auto"` uses the GPU
  NVENC encoder when present and falls back to `libx264` otherwise. Measured
  total CPU (capture + encode + mux) on a 1080p monitor: ~0.5 cores at 30fps
  and ~0.85 cores at 60fps with NVENC, versus ~2 cores at 30fps and ~3.7
  cores at 60fps with software `libx264` — set `fps` lower if capture must
  cost almost nothing.
- Windows privacy settings may require granting screen/microphone access; a
  denial surfaces as a startup error, never as silent empty captures.

## Tests and benchmarks

```sh
cargo test                          # unit tests (platform-independent)
SCREENCAP_ITEST=1 cargo test --test windows_integration
                                    # end-to-end: capture, hotkey, ffprobe check
cargo bench                         # router mix, resample, f32le write, config, sanitize
```

The integration test needs an interactive desktop session: it starts the app
with a 3-second buffer, synthesizes the configured hotkey with `SendInput`, and
verifies the saved Matroska (one video + five audio streams with
`screencap_track` 1/2/3/4/5, where 4 is the silent placeholder) with the
bundled ffprobe.
