//! Library directory watching (notify) owned by `AppState`. Change bursts
//! are debounced into one rescan per root; watcher failures are surfaced as
//! `library-changed` events with kind `watcher-error` so the UI can offer a
//! manual rescan instead of silently going stale.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use notify::Watcher;
use tauri::Emitter;

use crate::types::{err, LibraryChangedPayload};

const DEBOUNCE: Duration = Duration::from_millis(500);

/// One active watcher: the notify watcher plus its debounce channel.
pub struct RootWatcher {
    _watcher: notify::RecommendedWatcher,
}

/// Start a watcher for one root. Change signals are forwarded on
/// `debounce_tx`; a watcher error sends a `watcher-error` event instead.
pub fn start_root_watcher(
    root: PathBuf,
    debounce_tx: Sender<PathBuf>,
    app: tauri::AppHandle,
) -> Result<RootWatcher, String> {
    let signal_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        match res {
            Ok(_) => {
                // Unbounded mpsc send never blocks.
                let _ = debounce_tx.send(signal_root.clone());
            }
            Err(e) => {
                let payload = LibraryChangedPayload {
                    root: signal_root.to_string_lossy().into_owned().into(),
                    kind: "watcher-error".into(),
                    message: Some(e.to_string()),
                };
                let _ = app.emit("library-changed", payload);
            }
        }
    })
    .map_err(|e| err("watcher", e))?;
    watcher
        .watch(&root, notify::RecursiveMode::NonRecursive)
        .map_err(|e| err("watcher", format!("{}: {e}", root.display())))?;
    Ok(RootWatcher { _watcher: watcher })
}

/// Consume debounced roots from `rx` and run the callback. The callback
/// rescans the root (sharing the library scan + DB code) and emits the
/// incremental `library-changed` event.
pub fn spawn_debounce_loop(
    rx: Receiver<PathBuf>,
    app: tauri::AppHandle,
    scan: impl Fn(&str) -> Result<crate::types::ScanResult, String> + Send + Sync + 'static,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("library-watcher".into())
        .spawn(move || {
            let mut pending: HashMap<PathBuf, std::time::Instant> = HashMap::new();
            let mut last_emit: HashMap<PathBuf, std::time::Instant> = HashMap::new();
            loop {
                // Collect newly signaled roots.
                while let Ok(root) = rx.try_recv() {
                    pending.insert(root, std::time::Instant::now());
                }
                let now = std::time::Instant::now();
                let due: Vec<PathBuf> = pending
                    .iter()
                    .filter(|(_, at)| now.duration_since(**at) >= DEBOUNCE)
                    .map(|(root, _)| root.clone())
                    .collect();
                for root in due {
                    pending.remove(&root);
                    // Never rescan a root more often than the debounce window.
                    if last_emit
                        .get(&root)
                        .is_some_and(|at| now.duration_since(*at) < DEBOUNCE)
                    {
                        continue;
                    }
                    last_emit.insert(root.clone(), now);
                    let root_str = root.to_string_lossy().into_owned();
                    match scan(&root_str) {
                        Ok(result) => {
                            let _ = app.emit(
                                "library-changed",
                                LibraryChangedPayload {
                                    root: Some(root_str),
                                    kind: "incremental".into(),
                                    message: Some(format!("{} clips", result.clips)),
                                },
                            );
                        }
                        Err(e) => {
                            let _ = app.emit(
                                "library-changed",
                                LibraryChangedPayload {
                                    root: Some(root_str),
                                    kind: "watcher-error".into(),
                                    message: Some(e),
                                },
                            );
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })
        .expect("watcher thread spawns")
}
