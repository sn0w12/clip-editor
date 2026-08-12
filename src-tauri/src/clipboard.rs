//! Copy a file to the Windows clipboard as a file drop (CF_HDROP), matching
//! the legacy `copy-file-to-clipboard` contract.

/// CF_HDROP = 15 (the windows crate exposes it as a `CLIPBOARD_FORMAT` in
/// `Win32::System::Ole`; defined locally to avoid pulling that feature).
const CF_HDROP: u32 = 15;

/// Copy one file path to the clipboard as CF_HDROP so the user can paste it
/// into Explorer/file pickers. Off-Windows returns an explicit error.
pub fn copy_file_to_clipboard(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND};
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };
        use windows::Win32::UI::Shell::DROPFILES;

        let wide: Vec<u16> = path.encode_utf16().collect();
        // DROPFILES header (pFiles offset, point, fNC, fWide) + wide file
        // list terminated by a double NUL.
        let header_size = std::mem::size_of::<DROPFILES>();
        let payload_len = header_size + (wide.len() + 2) * 2;
        let mut buffer = vec![0u8; payload_len];
        buffer[0..4].copy_from_slice(&(header_size as u32).to_le_bytes());
        // fWide at offset 16 (pFiles=4 + pt.x=4 + pt.y=4 + fNC=4).
        buffer[16..20].copy_from_slice(&1u32.to_le_bytes());
        let mut offset = header_size;
        for unit in wide {
            buffer[offset..offset + 2].copy_from_slice(&unit.to_le_bytes());
            offset += 2;
        }
        // The trailing double NUL is already in the zeroed buffer.

        unsafe {
            if let Err(e) = OpenClipboard(Some(HWND::default())) {
                return Err(crate::types::err(
                    "clipboard",
                    format!("OpenClipboard: {e}"),
                ));
            }
            let h_mem = match GlobalAlloc(GMEM_MOVEABLE, payload_len) {
                Ok(h) => h,
                Err(e) => {
                    let _ = CloseClipboard();
                    return Err(crate::types::err("clipboard", format!("GlobalAlloc: {e}")));
                }
            };
            let ptr = GlobalLock(h_mem);
            if ptr.is_null() {
                let _ = GlobalFree(Some(h_mem));
                let _ = CloseClipboard();
                return Err(crate::types::err("clipboard", "GlobalLock failed"));
            }
            std::ptr::copy_nonoverlapping(buffer.as_ptr(), ptr as *mut u8, buffer.len());
            let _ = GlobalUnlock(h_mem);
            let _ = EmptyClipboard();
            let result = SetClipboardData(CF_HDROP, Some(HANDLE(h_mem.0)));
            let _ = CloseClipboard();
            match result {
                Ok(_) => Ok(()),
                Err(e) => {
                    let _ = GlobalFree(Some(h_mem));
                    Err(crate::types::err(
                        "clipboard",
                        format!("SetClipboardData: {e}"),
                    ))
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        Err(crate::types::err(
            "clipboard",
            "file clipboard (CF_HDROP) is only supported on Windows",
        ))
    }
}
