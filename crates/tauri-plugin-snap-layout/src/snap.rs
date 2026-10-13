use super::{SnapConfig, SnapCursor};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::sync::Arc;
use tauri::{Emitter, Manager, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetPropW, IsZoomed, LoadCursorW, RemovePropW,
            SendMessageW, SetCursor, SetPropW, SetWindowPos, HTMAXBUTTON, IDC_ARROW, IDC_HAND,
            SC_MAXIMIZE, SC_RESTORE, SWP_NOACTIVATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN,
            WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_SETCURSOR, WM_SYSCOMMAND, WS_CHILD, WS_VISIBLE,
        },
    },
};

const CHILD_PROP: &[u16] = &[
    b'T' as u16,
    b'a' as u16,
    b'u' as u16,
    b'r' as u16,
    b'i' as u16,
    b'S' as u16,
    b'n' as u16,
    b'a' as u16,
    b'p' as u16,
    b'C' as u16,
    b'h' as u16,
    b'i' as u16,
    b'l' as u16,
    b'd' as u16,
    0,
];

const STATE_PROP: &[u16] = &[
    b'T' as u16,
    b'a' as u16,
    b'u' as u16,
    b'r' as u16,
    b'i' as u16,
    b'S' as u16,
    b'n' as u16,
    b'a' as u16,
    b'p' as u16,
    b'S' as u16,
    b't' as u16,
    b'a' as u16,
    b't' as u16,
    b'e' as u16,
    0,
];

const SUBCLASS_ID: usize = 0x7466_736e_6170;
const EVENT_ENTER: &str = "tauri-snap://snap/mouseenter";
const EVENT_LEAVE: &str = "tauri-snap://snap/mouseleave";
const EVENT_DOWN: &str = "tauri-snap://snap/mousedown";
const EVENT_UP: &str = "tauri-snap://snap/mouseup";

struct SnapState {
    hovering: bool,
    parent_hwnd: HWND,
    cursor: SnapCursor,
    emit: Arc<dyn Fn(&'static str) + Send + Sync>,
}

#[tauri::command]
pub fn update_snap_bounds<R: tauri::Runtime>(
    webview_window: WebviewWindow<R>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> crate::Result<()> {
    let parent_hwnd = window_hwnd(&webview_window)? as isize;

    let window_clone = webview_window.clone();

    let cursor = webview_window
        .try_state::<SnapConfig>()
        .map(|config| config.cursor)
        .unwrap_or(SnapCursor::Arrow);

    webview_window.run_on_main_thread(move || unsafe {
        let p_hwnd = parent_hwnd as HWND;

        if windows_sys::Win32::UI::WindowsAndMessaging::IsWindow(p_hwnd) == 0 {
            return;
        }

        let dpi = GetDpiForWindow(p_hwnd);
        let scaled_x = scaled(x, dpi);
        let scaled_y = scaled(y, dpi);
        let scaled_width = scaled(width, dpi);
        let scaled_height = scaled(height, dpi);

        let child_hwnd = GetPropW(p_hwnd, CHILD_PROP.as_ptr()) as HWND;

        if !child_hwnd.is_null() {
            SetWindowPos(
                child_hwnd,
                0 as HWND,
                scaled_x,
                scaled_y,
                scaled_width,
                scaled_height,
                SWP_NOACTIVATE,
            );
        } else {
            let class_name = [
                b'S' as u16,
                b'T' as u16,
                b'A' as u16,
                b'T' as u16,
                b'I' as u16,
                b'C' as u16,
                0,
            ];
            let child = CreateWindowExW(
                0,
                class_name.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE,
                scaled_x,
                scaled_y,
                scaled_width,
                scaled_height,
                p_hwnd,
                0 as _,
                0 as _,
                std::ptr::null(),
            );

            if !child.is_null() {
                SetPropW(p_hwnd, CHILD_PROP.as_ptr(), child as HANDLE);

                let state = Box::new(SnapState {
                    hovering: false,
                    parent_hwnd: p_hwnd,
                    cursor,
                    emit: Arc::new(move |evt| {
                        let _ = window_clone.emit_to(window_clone.label(), evt, ());
                    }),
                });

                let state_raw = Box::into_raw(state);
                SetPropW(child, STATE_PROP.as_ptr(), state_raw as HANDLE);
                SetWindowSubclass(
                    child,
                    Some(child_subclass_proc),
                    SUBCLASS_ID,
                    state_raw as usize,
                );
            }
        }
    })?;

    Ok(())
}

#[tauri::command]
pub fn detach_snap_bounds<R: tauri::Runtime>(
    webview_window: WebviewWindow<R>,
) -> crate::Result<()> {
    uninstall(&webview_window)
}

pub fn uninstall<R: tauri::Runtime>(window: &WebviewWindow<R>) -> crate::Result<()> {
    let parent_hwnd = window_hwnd(window)? as isize;
    let window_clone = window.clone();

    window.run_on_main_thread(move || unsafe {
        let p_hwnd = parent_hwnd as HWND;
        let child_hwnd = RemovePropW(p_hwnd, CHILD_PROP.as_ptr()) as HWND;
        if !child_hwnd.is_null() {
            DestroyWindow(child_hwnd);
            let _ = window_clone.emit(EVENT_LEAVE, ());
        }
    })?;
    Ok(())
}

fn window_hwnd(window: &impl HasWindowHandle) -> crate::Result<HWND> {
    let handle = window
        .window_handle()
        .map_err(|e| crate::error::Error::Handle(e.to_string()))?;
    match handle.as_raw() {
        RawWindowHandle::Win32(handle) => Ok(handle.hwnd.get() as HWND),
        _ => Err(crate::error::Error::NotWin32),
    }
}

fn scaled(value: i32, dpi: u32) -> i32 {
    // +48 = half of 96 for correct rounding
    let sign = if value < 0 { -1i64 } else { 1i64 };
    (sign * (value.unsigned_abs() as i64 * dpi as i64 + 48) / 96) as i32
}

unsafe extern "system" fn child_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    ref_data: usize,
) -> LRESULT {
    let state_ptr = ref_data as *mut SnapState;

    match msg {
        WM_NCDESTROY => {
            RemoveWindowSubclass(hwnd, Some(child_subclass_proc), subclass_id);

            let owned_state = RemovePropW(hwnd, STATE_PROP.as_ptr()) as *mut SnapState;
            if !owned_state.is_null() {
                let _ = Box::from_raw(owned_state);
            }
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }
        WM_NCHITTEST => {
            if !state_ptr.is_null() {
                let state = &mut *state_ptr;

                if !state.hovering {
                    state.hovering = true;
                    (state.emit)(EVENT_ENTER);

                    let mut tme = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE | TME_NONCLIENT,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    TrackMouseEvent(&mut tme);
                }
                return HTMAXBUTTON as LRESULT;
            }
        }
        WM_NCMOUSELEAVE => {
            if !state_ptr.is_null() {
                let state = &mut *state_ptr;
                if state.hovering {
                    state.hovering = false;
                    (state.emit)(EVENT_LEAVE);
                }
            }
        }
        WM_NCLBUTTONDOWN => {
            if wparam == HTMAXBUTTON as usize {
                if !state_ptr.is_null() {
                    let state = &*state_ptr;
                    (state.emit)(EVENT_DOWN);
                }
                return 0;
            }
        }
        WM_NCLBUTTONUP => {
            if wparam == HTMAXBUTTON as usize && !state_ptr.is_null() {
                let state = &*state_ptr;
                (state.emit)(EVENT_UP);
                if IsZoomed(state.parent_hwnd) != 0 {
                    SendMessageW(state.parent_hwnd, WM_SYSCOMMAND, SC_RESTORE as WPARAM, 0);
                } else {
                    SendMessageW(state.parent_hwnd, WM_SYSCOMMAND, SC_MAXIMIZE as WPARAM, 0);
                }
                return 0;
            }
        }
        WM_SETCURSOR if !state_ptr.is_null() => {
            let state = &*state_ptr;
            let cursor_id = match state.cursor {
                SnapCursor::Hand => IDC_HAND,
                SnapCursor::Arrow => IDC_ARROW,
            };
            SetCursor(LoadCursorW(0 as _, cursor_id));
            return 1;
        }
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}
