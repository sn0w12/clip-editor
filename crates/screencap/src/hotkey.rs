//! Global hotkey listener. `global-hotkey` and the raw extended-key path both
//! register via `RegisterHotKey` on hidden windows and need a Win32 message
//! pump, so this module owns a control thread that runs `GetMessage`/
//! `DispatchMessage` directly. (A `winit` event loop is impossible here: the
//! host app already created the process's single event loop, and winit 0.30
//! refuses to build a second one on any thread.) The foreground window title
//! is sampled synchronously on `Pressed`; registration failure is fatal.

use std::thread;

use crossbeam_channel::{Receiver, Sender};
use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

use crate::error::{HotkeyError, RunError};

/// A save request from the hotkey thread. The title is already captured.
#[derive(Debug, Clone)]
pub enum HotkeyCommand {
    Save { foreground_title: String },
}

/// Handle for the hotkey control thread.
pub struct HotkeyControl {
    shutdown: Sender<()>,
    join: Option<thread::JoinHandle<()>>,
}

impl HotkeyControl {
    /// Register the hotkey and start the control thread. Registration failure
    /// is fatal: the error is published on `err_tx` and returned here.
    pub fn start(
        hotkey_str: &str,
        tx: Sender<HotkeyCommand>,
        err_tx: Sender<RunError>,
    ) -> Result<HotkeyControl, HotkeyError> {
        let parsed = parse_hotkey_extended(hotkey_str)
            .map_err(|e| HotkeyError::General(format!("invalid hotkey `{hotkey_str}`: {e}")))?;
        let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded::<()>(1);
        let join = thread::Builder::new()
            .name("hotkey".to_string())
            .spawn(move || run_hotkey_thread(parsed, tx, err_tx, shutdown_rx))
            .map_err(|e| HotkeyError::General(format!("cannot spawn hotkey thread: {e}")))?;
        Ok(HotkeyControl { shutdown: shutdown_tx, join: Some(join) })
    }

    /// Signal the control thread to stop (the supervisor keeps it alive until
    /// shutdown so hotkeys never stop working mid-run).
    pub fn stop(&mut self) {
        let _ = self.shutdown.try_send(());
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for HotkeyControl {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_hotkey_thread(
    parsed: ParsedHotkey,
    tx: Sender<HotkeyCommand>,
    err_tx: Sender<RunError>,
    shutdown: Receiver<()>,
) {
    let manager = match GlobalHotKeyManager::new() {
        Ok(m) => m,
        Err(e) => {
            let _ = err_tx.send(RunError::Hotkey(HotkeyError::General(format!(
                "cannot create hotkey manager: {e}"
            ))));
            return;
        }
    };
    let mut hotkey_id: u32 = 0;
    let mut raw_hotkey: Option<(windows::Win32::Foundation::HWND, u16)> = None;
    match &parsed {
        ParsedHotkey::Standard(hotkey) => {
            if let Err(e) = manager.register(hotkey.clone()) {
                let _ = err_tx.send(RunError::Hotkey(HotkeyError::General(format!(
                    "cannot register hotkey `{hotkey}` (reserved by Windows or in use by another application?): {e}"
                ))));
                return;
            }
            hotkey_id = hotkey.id();
        }
        ParsedHotkey::Raw { ctrl, shift, alt, win, vk } => {
            match register_raw_hotkey(*ctrl, *shift, *alt, *win, *vk, tx.clone()) {
                Ok(handle) => raw_hotkey = Some(handle),
                Err(e) => {
                    let _ = err_tx.send(RunError::Hotkey(e));
                    return;
                }
            }
        }
    }

    // Stop the pump by posting WM_QUIT to this thread's queue.
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
        use windows::Win32::UI::WindowsAndMessaging::WM_QUIT;
        let thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
        std::thread::Builder::new()
            .name("hotkey-shutdown".to_string())
            .spawn(move || {
                let _ = shutdown.recv();
                unsafe {
                    let _ = PostThreadMessageW(
                        thread_id,
                        WM_QUIT,
                        windows::Win32::Foundation::WPARAM(0),
                        windows::Win32::Foundation::LPARAM(0),
                    );
                }
            })
            .ok();
    }

    // Raw Win32 message pump: dispatches WM_HOTKEY to the global-hotkey and
    // raw-registration windows, then drains the global-hotkey event channel.
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, TranslateMessage, MSG,
        };
        unsafe {
            let mut msg = std::mem::zeroed::<MSG>();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
                drain_global_hotkey_events(hotkey_id, &tx);
            }
            drain_global_hotkey_events(hotkey_id, &tx);
        }
    }

    if let Some((hwnd, atom)) = raw_hotkey {
        cleanup_raw_hotkey(hwnd, atom);
    }
}

/// Drain global-hotkey press events matching the registered hotkey.
fn drain_global_hotkey_events(hotkey_id: u32, tx: &Sender<HotkeyCommand>) {
    while let Ok(event) = GlobalHotKeyEvent::receiver().try_recv() {
        if event.state() == HotKeyState::Pressed && event.id() == hotkey_id {
            let title = crate::naming::active_window_title();
            let _ = tx.send(HotkeyCommand::Save { foreground_title: title });
        }
    }
}

/// Hotkey window id and the TX used by its window proc (extended keys).
#[cfg(windows)]
const RAW_HOTKEY_ID: i32 = 0x5343_5243;
#[cfg(windows)]
static RAW_HOTKEY_TX: parking_lot::Mutex<Option<Sender<HotkeyCommand>>> = parking_lot::Mutex::new(None);

/// Register an extended (non-global-hotkey) key via a hidden window that
/// receives WM_HOTKEY, dispatched by our message pump.
#[cfg(windows)]
fn register_raw_hotkey(
    ctrl: bool,
    shift: bool,
    alt: bool,
    win: bool,
    vk: u32,
    tx: Sender<HotkeyCommand>,
) -> Result<(windows::Win32::Foundation::HWND, u16), HotkeyError> {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassW, UnregisterClassW, WNDCLASSW, WM_HOTKEY,
        WS_EX_TOOLWINDOW,
    };

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_HOTKEY {
            if let Some(tx) = RAW_HOTKEY_TX.lock().as_ref() {
                let title = crate::naming::active_window_title();
                let _ = tx.send(HotkeyCommand::Save { foreground_title: title });
            }
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    unsafe {
        let hinstance = GetModuleHandleW(None)
            .map_err(|e| HotkeyError::General(format!("cannot get module handle: {e}")))?;
        let class_name: Vec<u16> = format!("screencap_raw_hotkey_{}", std::process::id())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: hinstance.into(),
            lpszClassName: windows::core::PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        let atom = RegisterClassW(&wc);
        if atom == 0 {
            return Err(HotkeyError::General(format!(
                "cannot register hotkey window class: {}",
                std::io::Error::last_os_error()
            )));
        }
        let hwnd = match CreateWindowExW(
            WS_EX_TOOLWINDOW,
            windows::core::PCWSTR(class_name.as_ptr()),
            windows::core::PCWSTR::null(),
            Default::default(),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinstance.into()),
            None,
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                let _ = UnregisterClassW(windows::core::PCWSTR(class_name.as_ptr()), Some(hinstance.into()));
                return Err(HotkeyError::General(format!(
                    "cannot create hotkey window: {e}"
                )));
            }
        };

        *RAW_HOTKEY_TX.lock() = Some(tx);
        let mut mods = HOT_KEY_MODIFIERS(0);
        if ctrl {
            mods.0 |= MOD_CONTROL.0;
        }
        if shift {
            mods.0 |= MOD_SHIFT.0;
        }
        if alt {
            mods.0 |= MOD_ALT.0;
        }
        if win {
            mods.0 |= MOD_WIN.0;
        }
        if RegisterHotKey(Some(hwnd), RAW_HOTKEY_ID, mods, vk).is_err() {
            *RAW_HOTKEY_TX.lock() = None;
            let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(hwnd);
            let _ = UnregisterClassW(windows::core::PCWSTR(class_name.as_ptr()), Some(hinstance.into()));
            return Err(HotkeyError::General(
                "cannot register hotkey (reserved by Windows or in use by another application?)"
                    .to_string(),
            ));
        }
        Ok((hwnd, atom))
    }
}

#[cfg(windows)]
fn cleanup_raw_hotkey(hwnd: windows::Win32::Foundation::HWND, atom: u16) {
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::UnregisterHotKey;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyWindow, UnregisterClassW};

    unsafe {
        let _ = UnregisterHotKey(Some(hwnd), RAW_HOTKEY_ID);
        let _ = DestroyWindow(hwnd);
        *RAW_HOTKEY_TX.lock() = None;
        if let Ok(hinstance) = GetModuleHandleW(None) {
            let class_name: Vec<u16> = format!("screencap_raw_hotkey_{}", std::process::id())
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let _ = UnregisterClassW(windows::core::PCWSTR(class_name.as_ptr()), Some(hinstance.into()));
        }
        let _ = atom;
    }
}

/// A parsed hotkey: either a standard global-hotkey code or a Windows key the
/// global-hotkey grammar cannot express (e.g. the Menu key), which is
/// registered directly via `RegisterHotKey`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedHotkey {
    Standard(HotKey),
    Raw { ctrl: bool, shift: bool, alt: bool, win: bool, vk: u32 },
}

impl ParsedHotkey {
    /// Canonical display form, e.g. `ctrl+ContextMenu`.
    pub fn describe(&self) -> String {
        match self {
            ParsedHotkey::Standard(hk) => hk.to_string(),
            ParsedHotkey::Raw { ctrl, shift, alt, win, vk } => {
                let mut out = String::new();
                for (held, name) in [(*ctrl, "ctrl"), (*shift, "shift"), (*alt, "alt"), (*win, "win")] {
                    if held {
                        out.push_str(name);
                        out.push('+');
                    }
                }
                out.push_str(extended_key_name(*vk).unwrap_or("?"));
                out
            }
        }
    }
}

/// Name for an extended (non-global-hotkey) key, or `None` for standard keys.
fn extended_key_name(vk: u32) -> Option<&'static str> {
    match vk {
        0x5D => Some("ContextMenu"),
        _ => None,
    }
}

/// Parse the config hotkey syntax, accepting standard global-hotkey names
/// (`win` aliases `cmd`) and the extended Windows keys that grammar lacks
/// (e.g. `ContextMenu`).
pub fn parse_hotkey_extended(s: &str) -> Result<ParsedHotkey, String> {
    let normalized = s.replace("win+", "cmd+").replace("Win+", "cmd+").replace("WIN+", "cmd+");
    if let Ok(hk) = normalized.parse::<HotKey>() {
        return Ok(ParsedHotkey::Standard(hk));
    }
    let mut ctrl = false;
    let mut shift = false;
    let mut alt = false;
    let mut win = false;
    let mut key: Option<&str> = None;
    for raw in s.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return Err(format!("invalid hotkey `{s}`: empty token"));
        }
        match token.to_uppercase().as_str() {
            "CTRL" | "CONTROL" => ctrl = true,
            "SHIFT" => shift = true,
            "ALT" | "OPTION" => alt = true,
            "WIN" | "CMD" | "COMMAND" | "SUPER" => win = true,
            _ => {
                if key.is_some() {
                    return Err(format!("invalid hotkey `{s}`: more than one key"));
                }
                key = Some(token);
            }
        }
    }
    let key = key.ok_or_else(|| format!("invalid hotkey `{s}`: no key"))?;
    let vk = match key.to_uppercase().as_str() {
        "CONTEXTMENU" | "MENU" | "APPS" => 0x5D,
        other => return Err(format!("unsupported key `{other}` in hotkey `{s}`")),
    };
    Ok(ParsedHotkey::Raw { ctrl, shift, alt, win, vk })
}

/// Record a hotkey by pressing it, then write it into the config file.
pub fn record(config_path: Option<&std::path::Path>) -> Result<(), RunError> {
    let config = crate::config::Config::load(config_path)?;
    let path = match config_path {
        Some(p) => p.to_path_buf(),
        None => crate::config::default_config_path(),
    };
    println!("current hotkey: {}", config.replay.hotkey);
    let recorded = capture_hotkey()?;
    println!("recorded: {recorded}");
    set_hotkey_in_file(&path, &recorded)?;
    // The rewritten file must still validate, including the new hotkey.
    crate::config::Config::load(config_path)?;
    println!("hotkey updated in {}", path.display());
    Ok(())
}

/// Shared state for the recording hook.
#[cfg(windows)]
#[derive(Default)]
struct HookState {
    ctrl: bool,
    shift: bool,
    alt: bool,
    win: bool,
    result: Option<String>,
    done: bool,
}

/// Compose the canonical combo string and modifier bitmask from the hook state.
#[cfg(windows)]
fn build_combo(state: &HookState, name: &str) -> (String, u32) {
    let mut combo = String::new();
    let mut mods = 0u32;
    for (held, mod_name, bit) in [
        (state.ctrl, "ctrl", 2u32),
        (state.shift, "shift", 4),
        (state.alt, "alt", 1),
        (state.win, "win", 8),
    ] {
        if held {
            combo.push_str(mod_name);
            combo.push('+');
            mods |= bit;
        }
    }
    combo.push_str(name);
    (combo, mods)
}

/// Wait for a key combination and return it in hotkey syntax
/// (`ctrl+shift+Q`, `ContextMenu`, ...). Esc cancels; combinations reserved
/// by Windows or another application are rejected with a message and the
/// recorder keeps waiting.
#[cfg(windows)]
fn capture_hotkey() -> Result<String, RunError> {
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        KBDLLHOOKSTRUCT, LLKHF_UP, MSG, WH_KEYBOARD_LL, WM_QUIT,
    };

    static STATE: parking_lot::Mutex<Option<HookState>> = parking_lot::Mutex::new(None);

    unsafe extern "system" fn proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let up = (kb.flags.0 & LLKHF_UP.0) != 0;
            let mut guard = STATE.lock();
            if let Some(state) = guard.as_mut() {
                match kb.vkCode {
                    0x10 | 0xA0 | 0xA1 => state.shift = !up,
                    0x11 | 0xA2 | 0xA3 => state.ctrl = !up,
                    0x12 | 0xA4 | 0xA5 => state.alt = !up,
                    0x5B | 0x5C => state.win = !up,
                    0x1B if !up => {
                        state.result = None;
                        state.done = true;
                    }
                    vk if !up => {
                        if let Some(name) = vk_name(vk) {
                            let (combo, mods) = build_combo(state, &name);
                            if parse_hotkey_extended(&combo).is_ok() {
                                if probe_registrable(mods, vk) {
                                    state.result = Some(combo);
                                    state.done = true;
                                } else {
                                    eprintln!(
                                        "`{combo}` is reserved by Windows or another application — try a different combination"
                                    );
                                }
                            }
                        }
                    }
                    _ => {}
                }
                if state.done {
                    // Wake the installing thread's message loop.
                    let _ = unsafe {
                        PostThreadMessageW(GetCurrentThreadId(), WM_QUIT, WPARAM(0), LPARAM(0))
                    };
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    let _ = STATE.lock().replace(HookState::default());
    println!("Press the new hotkey combination (Esc cancels)...");
    let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(proc), None, 0) }.map_err(|e| {
        RunError::Hotkey(HotkeyError::General(format!(
            "cannot install keyboard hook: {e}"
        )))
    })?;

    // Pump messages: the low-level hook fires during this loop, and WM_QUIT
    // (posted by the hook when a combination lands) ends it.
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    loop {
        let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if ret.0 == 0 || ret.0 == -1 {
            break;
        }
    }
    let _ = unsafe { UnhookWindowsHookEx(hook) };

    let state = STATE.lock().take().unwrap_or_default();
    match state.result {
        Some(combo) => Ok(combo),
        None => Err(RunError::Hotkey(HotkeyError::General(
            "hotkey recording cancelled".to_string(),
        ))),
    }
}

#[cfg(not(windows))]
fn capture_hotkey() -> Result<String, RunError> {
    Err(RunError::Hotkey(HotkeyError::General(
        "hotkey recording is only supported on Windows".to_string(),
    )))
}

/// Windows virtual key to the global-hotkey code name (short form: `Q`, `F12`,
/// `ArrowDown`, ...). `None` for keys the grammar has no name for.
fn vk_name(vk: u32) -> Option<String> {
    let name = match vk {
        0x41..=0x5A => return Some(((b'A' + (vk - 0x41) as u8) as char).to_string()),
        0x30..=0x39 => return Some(((b'0' + (vk - 0x30) as u8) as char).to_string()),
        0x70..=0x87 => return Some(format!("F{}", vk - 0x70 + 1)),
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0D => "Enter",
        0x14 => "CapsLock",
        0x20 => "Space",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "ArrowLeft",
        0x26 => "ArrowUp",
        0x27 => "ArrowRight",
        0x28 => "ArrowDown",
        0x2C => "PrintScreen",
        0x2D => "Insert",
        0x2E => "Delete",
        0x60..=0x69 => return Some(format!("Numpad{}", vk - 0x60)),
        0x6A => "NumpadMultiply",
        0x6B => "NumpadAdd",
        0x6D => "NumpadSubtract",
        0x6E => "NumpadDecimal",
        0x6F => "NumpadDivide",
        0x90 => "NumLock",
        0x91 => "ScrollLock",
        0xBA => "Semicolon",
        0xBB => "Equal",
        0xBC => "Comma",
        0xBD => "Minus",
        0xBE => "Period",
        0xBF => "Slash",
        0xC0 => "Backquote",
        0xDB => "BracketLeft",
        0xDC => "Backslash",
        0xDD => "BracketRight",
        0xDE => "Quote",
        0x5D => "ContextMenu",
        _ => return None,
    };
    Some(name.to_string())
}

/// Can this modifier/key combination be registered as a global hotkey?
/// Reserved Windows combinations (Win+L, Ctrl+Alt+Del, ...) and hotkeys
/// already taken by another application fail here.
#[cfg(windows)]
fn probe_registrable(mods_bits: u32, vk: u32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS,
    };
    const PROBE_ID: i32 = 0x5343;
    unsafe {
        match RegisterHotKey(None, PROBE_ID, HOT_KEY_MODIFIERS(mods_bits), vk) {
            Ok(()) => {
                let _ = UnregisterHotKey(None, PROBE_ID);
                true
            }
            Err(_) => false,
        }
    }
}

/// Replace `replay.hotkey` in the config file, preserving everything else.
fn set_hotkey_in_file(path: &std::path::Path, hotkey: &str) -> Result<(), RunError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| RunError::Io(e))?;
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| RunError::Hotkey(HotkeyError::General(format!(
            "config is not valid TOML: {e}"
        ))))?;
    doc["replay"]["hotkey"] = toml_edit::value(hotkey);
    std::fs::write(path, doc.to_string()).map_err(RunError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hook tests inject real keyboard input and share the ambient input
    /// state, so they must not run in parallel.
    static HOOK_TEST_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    #[test]
    fn hotkey_parsing_accepts_documented_syntax() {
        assert!("shift+alt+KeyQ".parse::<HotKey>().is_ok());
        assert!("ctrl+shift+KeyQ".parse::<HotKey>().is_ok());
        assert!("ctrl+F12".parse::<HotKey>().is_ok());
    }

    #[test]
    fn hotkey_parsing_rejects_garbage() {
        assert!("not a hotkey".parse::<HotKey>().is_err());
        assert!("".parse::<HotKey>().is_err());
    }

    #[test]
    fn extended_parse_accepts_menu_key() {
        match parse_hotkey_extended("ContextMenu").unwrap() {
            ParsedHotkey::Raw { ctrl, shift, alt, win, vk } => {
                assert!(!ctrl && !shift && !alt && !win);
                assert_eq!(vk, 0x5D);
            }
            _ => panic!("ContextMenu must parse as raw"),
        }
        match parse_hotkey_extended("ctrl+ContextMenu").unwrap() {
            ParsedHotkey::Raw { ctrl, vk, .. } => {
                assert!(ctrl);
                assert_eq!(vk, 0x5D);
            }
            _ => panic!("ctrl+ContextMenu must parse as raw"),
        }
        assert!(matches!(
            parse_hotkey_extended("ctrl+shift+KeyQ").unwrap(),
            ParsedHotkey::Standard(_)
        ));
        assert!(matches!(parse_hotkey_extended("win+Q").unwrap(), ParsedHotkey::Standard(_)));
        assert!(parse_hotkey_extended("bogus+key").is_err());
        assert!(parse_hotkey_extended("").is_err());
        assert_eq!(parse_hotkey_extended("ContextMenu").unwrap().describe(), "ContextMenu");
        assert_eq!(parse_hotkey_extended("ctrl+ContextMenu").unwrap().describe(), "ctrl+ContextMenu");
    }

    #[test]
    fn virtual_key_names() {
        assert_eq!(vk_name(0x51).as_deref(), Some("Q"));
        assert_eq!(vk_name(0x71).as_deref(), Some("F2"));
        assert_eq!(vk_name(0x30).as_deref(), Some("0"));
        assert_eq!(vk_name(0x26).as_deref(), Some("ArrowUp"));
        assert_eq!(vk_name(0x6B).as_deref(), Some("NumpadAdd"));
        assert_eq!(vk_name(0x5D).as_deref(), Some("ContextMenu"));
        assert!(vk_name(0x5B).is_none(), "modifiers are not main keys");
        assert!(vk_name(0x00).is_none());
        assert!(vk_name(0xFF).is_none());
    }

    #[test]
    fn recorded_combo_parses() {
        for combo in ["Q", "ctrl+shift+Q", "ctrl+alt+F12", "shift+ArrowDown"] {
            assert!(combo.parse::<HotKey>().is_ok(), "{combo} should parse");
        }
    }

    #[test]
    fn rewrites_hotkey_in_toml() {
        let dir = std::env::temp_dir().join(format!(
            "screencap_hotkey_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "[replay]\nhotkey = \"ctrl+shift+KeyQ\"\n[video]\ncodec = \"auto\"\n").unwrap();
        set_hotkey_in_file(&path, "ctrl+alt+F12").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("hotkey = \"ctrl+alt+F12\""), "hotkey updated: {text}");
        assert!(text.contains("codec = \"auto\""), "other keys preserved: {text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Run the recorder and inject `keys`, retrying until the expected combo
    /// is captured (ambient input on CI machines can land first).
    #[cfg(windows)]
    fn capture_with_injected(expected: &str, keys: &[(u16, bool)]) -> String {
        use std::time::Duration;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        };
        for attempt in 0..4 {
            let handle = std::thread::spawn(capture_hotkey);
            std::thread::sleep(Duration::from_millis(50));
            unsafe {
                for (vk, up) in keys {
                    let input = INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VIRTUAL_KEY(*vk),
                                wScan: 0,
                                dwFlags: if *up { KEYEVENTF_KEYUP } else { Default::default() },
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    };
                    let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            let result = handle.join().expect("capture thread ends").expect("capture succeeds");
            if result == expected || attempt == 3 {
                return result;
            }
        }
        unreachable!()
    }

    /// End-to-end: the low-level hook must see injected input, combine
    /// modifiers, and wake the message loop. Skips silently on non-Windows.
    #[cfg(windows)]
    #[test]
    fn hook_captures_synthetic_combo() {
        let _guard = HOOK_TEST_LOCK.lock();
        let result = capture_with_injected(
            "ctrl+alt+F12",
            &[(0x11, false), (0x12, false), (0x7B, false), (0x7B, true), (0x12, true), (0x11, true)],
        );
        assert_eq!(result, "ctrl+alt+F12");
    }

    /// The Menu key (VK_APPS) must record as `ContextMenu`.
    #[cfg(windows)]
    #[test]
    fn hook_captures_menu_key() {
        let _guard = HOOK_TEST_LOCK.lock();
        let result = capture_with_injected("ContextMenu", &[(0x5D, false), (0x5D, true)]);
        assert_eq!(result, "ContextMenu");
    }
}
