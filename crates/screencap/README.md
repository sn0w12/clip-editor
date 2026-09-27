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

| Key                                           | Default              | Notes                                                                                                                                                                                                                          |
| --------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `replay.duration_seconds`                     | `30`                 | Buffer length (1..=3600)                                                                                                                                                                                                       |
| `replay.segment_seconds`                      | `1`                  | Rolling segment length (1..=10, <= duration). Also the GOP length (NVENC ignores forced keyframes), so it trades keyframe bytes against save latency and clip-length overshoot; measure with `segmentbench` before changing it |
| `replay.output_dir`                           | `captures`           | Where saved replays land                                                                                                                                                                                                       |
| `replay.filename_base`                        | `Replay`             | Outputs are `<base>_<title>.mkv`                                                                                                                                                                                               |
| `replay.monitor`                              | `primary`            | or `index:<one-based-index>`                                                                                                                                                                                                   |
| `replay.fps`                                  | `60`                 | Capture rate (1..=240)                                                                                                                                                                                                         |
| `replay.hotkey`                               | `ctrl+shift+KeyQ`    | Global hotkey, e.g. `shift+alt+KeyQ`, `ContextMenu` (Menu key); `screencap hotkey` records it for you                                                                                                                          |
| `replay.success_sound`                        | `—`                  | Path to a WAV played after a clip is saved; omit for no sound                                                                                                                                                                  |
| `video.codec`                                 | `libx264`            | or `h264_nvenc` (GPU; far less CPU)                                                                                                                                                                                            |
| `video.quality`                               | `23`                 | CRF (libx264) / CQ (nvenc), 0..=51                                                                                                                                                                                             |
| `audio.sample_rate` / `channels` / `block_ms` | `48000` / `2` / `20` | Mix output format                                                                                                                                                                                                              |

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
always `<base> <date> <time>_<sanitized-title>.mp4` (e.g. `Replay 2026-08-09 20-22-45_My_Game_Clip.mp4`, time dashes because colons are invalid in Windows filenames) regardless of later focus changes.
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

## Capture path

Capture is the part that runs _while you play_, so it is built to cost the game
as little as possible and to be measurable when it does not. In order:

- **One duplication acquire per stream tick**, not per compositor frame.
  DXGI coalesces every desktop update since the last release, so a game
  presenting at 400 fps is handed to the duplication ~60 times a second instead
  of 400 — the handoffs are the compositor work the stream never uses. A tick
  that starts late is skipped rather than bursted, and the pacer re-sends the
  latest frame to keep the stream's cadence.
- **One readback per tick, waited on in place.** The staging copy is mapped with
  a blocking map: measured with `examples/readbacklat.rs`, a 1080p frame costs
  p50 1.04 ms / p95 1.33 ms, against a 16.7 ms tick at 60 fps. Probing the same
  copy non-blocking instead is worse _and_ misleading — `Map` reports
  `WAS_STILL_DRAWING` until something asks for the data, so a probe deferred by
  a tick reads as ~31 ms of latency while the same copy, waited on immediately,
  is ready in about a millisecond. The wait is recorded
  (`COPY-LATENCY`/`slow_map_waits`), so a contended GPU shows up as latency
  before it shows up as missing frames.
- **Nothing to read back costs nothing.** A tick whose changed area is at most
  half a percent of the frame (cursor, clock) reuses the previous pixels; if the
  pointer moved, it is blended into that copy on the CPU, so a cursor-only
  update never touches the GPU.
- **The cursor is blended into the frame being read back**, not into a second
  full-frame copy, and buffers are recycled through a pool that only ever hands
  out uniquely-owned memory.
- **Encoder latency is stripped per encoder.** NVENC runs `p1`/`ull` with
  lookahead, delay, and B-frames off; x264 runs `zerolatency` with lookahead
  and B-frames off; AMF runs the `lowlatency` usage with B-frames off, so no
  encoder holds frames in an internal pipeline ahead of the segment files.
  `codec = "auto"` prefers the *render GPU's* vendor (registry display-class
  detection): a hardware encoder on the other GPU of a hybrid laptop pays a
  cross-adapter copy per frame, which alone can consume the entire frame
  budget at 60 fps and push the pipeline behind in real time.

Watch the numbers on the settings page or in the log: the encoder, delivered vs
target fps, per-frame readback CPU, p95 readback latency, and slow-readback
count. The capture-health warning names the measured bottleneck when the
pipeline cannot keep up (delivery shortfall, stale frames, over-acquiring, or
readback latency approaching the frame budget).

## Tests and benchmarks

```sh
cargo test                          # unit tests (platform-independent)
SCREENCAP_ITEST=1 cargo test --test windows_integration
                                    # end-to-end: capture, hotkey, ffprobe check
SCREENCAP_JOIN_TEST=1 cargo test --test join_frames
                                    # frames across segment joins (needs ffmpeg/ffprobe
                                    # beside the test binary)
cargo bench                         # router mix, resample, f32le write, config, sanitize
```

The capture harnesses are examples, and they need the real thing to mean
anything (a moving desktop, no other capture app):

```sh
cargo run --example capbench -- 20 fps=60 cursor=true
# delivered fps, acquires/s (must track fps, not the compositor),
# readback CPU, COPY-LATENCY p95, dirty-skip/cursor-reuse counts, verdicts

cargo run --example readbacklat -- 30
# copy->map latency for a desktop readback, probed vs waited on in place;
# `probe=0` measures the blocking map the capture loop actually uses,
# `poll_us=N` shows how a probe cadence inflates the apparent latency

cargo run --example segmentbench -- 8 segments=1,2,3,6 fps=60
# one row per segment length: delivered fps, queue depth/frame age, FFmpeg CPU,
# bitrate and keyframe byte share, save latency, clip length, and the join frame
# deficit (0 = no frame lost at a join). Add `keyframes` to probe whether this
# FFmpeg can force keyframes with NVENC.
```

The measurement that decided the readback design, on a 1080p desktop with an
RTX 3090: an 8 MB staging copy is mappable 0.58 ms after `CopyResource` when it
is polled continuously, 2.6 ms when polled every 0.5 ms, and 41 ms when polled
every 20 ms — the probe cadence, not the copy, is what costs the time. The
segment-length measurements: 1 s segments at 1080p60 spend ~11% of their bytes
on keyframes and 3 s segments ~3.5%, with no join deficit (and no lost frame at
a join) at either length; at 120 fps the video queue reaches 11-14 of its 16
slots, which is a delivery-headroom warning, not a readback one. The `keyframes`
probe reports that forced IDRs _do_ work with NVENC once `-forced-idr 1` is
passed, but that does not make short segments cheaper: the segment muxer can
only cut at a keyframe, so every segment boundary needs one regardless, which is
why the segmenter ties `-g` to `segment_seconds`.

The integration test needs an interactive desktop session: it starts the app
with a 3-second buffer, synthesizes the configured hotkey with `SendInput`, and
verifies the saved clip (one video + five audio streams in dense track order,
where 4 is the silent placeholder, and titles matching the configured track
names) with the bundled ffprobe. The rolling segment files additionally carry
the `screencap_track` stream metadata, which the MP4 save container cannot
represent.
