<h1 align="center">Seraphis</h1>

<div align="center">
    <img alt="GitHub Actions Workflow Status" src="https://img.shields.io/github/actions/workflow/status/sn0w12/clip-editor/build.yml">
    <img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/sn0w12/clip-editor">
    <img alt="GitHub Release" src="https://img.shields.io/github/v/release/sn0w12/clip-editor?color=%2374c4c9">
    <img alt="Downloads" src="https://img.shields.io/github/downloads/sn0w12/clip-editor/total">
    <img alt="License" src="https://img.shields.io/github/license/sn0w12/clip-editor">
</div>

A desktop app for recording, editing, organizing, and exporting your game
clips. Built with Tauri 2, React 19, and Rust.

## Features

- **Replay buffer**: continuously capture the screen and per-application audio,
  then save the last few seconds to a clip with a global hotkey.
- **Clip library**: a searchable, filterable grid of every clip in your
  library, with game artwork, groups, and drag selection.
- **Editing**: trim and cut clips on a timeline with a waveform, then export.
- **Export**: MP4, WebM, MOV, MKV, or GIF with hardware-accelerated encoding.
- **Game detection**: categorize clips by game from your Steam library, with
  artwork, aliases, and custom games.
- **Groups**: colored tags for filtering and organizing clips.

## Development

### Requirements

- Node LTS
- Rust 1.85+
- The platform dependencies from the
  [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).

### Commands

```bash
npm install
npm run tauri dev      # desktop app with hot reload
npm run dev            # frontend only, port 3000
npm run tauri build    # installer bundle
```

Run the full gate set before opening a pull request:

```bash
npm run format:check
npm run lint
npm run typecheck
cargo fmt --all --check
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

After changing the Rust settings schema, regenerate the frontend contract:

```bash
cargo run -p seraphis --bin export_settings
```

- `crates/core/` is the domain library: SQLite persistence, library scanning
  and watching, the FFmpeg media pipeline, Steam scanning, the replay buffer,
  and the embedded localhost media server. It has no Tauri dependency; it
  emits events through an `EventSink` the shell injects.
- `crates/tauri/` holds the commands, the Tauri event sink, the native save
  dialog, the tray, autostart, and the settings/session stores.
- `crates/screencap/` is the Windows capture and replay-buffer engine.

## Platform support

Windows is the supported platform. The replay buffer relies on Windows capture
APIs (Windows Graphics Capture and the Windows Audio Session API), and release
builds are produced for Windows only.
