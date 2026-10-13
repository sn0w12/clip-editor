use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::api::{EchoRequest, EchoResult};
use crate::error::Result;
use crate::events::{NullSink, SharedSink};
use crate::recording::RecordingHandle;
use crate::runtime::cancellation::CancellationToken;
use crate::runtime::scheduler::Scheduler;
use crate::watcher::RootWatcher;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackendConfig {
    /// Maximum concurrent blocking jobs.
    pub max_blocking_operations: usize,
}

impl Default for BackendConfig {
    fn default() -> Self {
        Self {
            max_blocking_operations: 8,
        }
    }
}

/// The domain facade every command delegates to. Owns the SQLite connection,
/// the replay-buffer handle, the caches, the library watchers, and the event
/// sink the shell injects at startup.
pub struct Backend {
    scheduler: Scheduler,
    pub db: Mutex<Connection>,
    pub recording: RecordingHandle,
    pub cache_root: PathBuf,
    pub steam_dir: Mutex<String>,
    pub client: reqwest::Client,
    pub watchers: Mutex<HashMap<String, RootWatcher>>,
    pub watcher_tx: Sender<PathBuf>,
    pub watcher_rx: Mutex<Option<Receiver<PathBuf>>>,
    pub media_server_port: u16,
    events: RwLock<SharedSink>,
}

impl Backend {
    pub fn new(config: BackendConfig) -> Self {
        let (watcher_tx, watcher_rx) = channel();
        Self {
            scheduler: Scheduler::new(config.max_blocking_operations),
            db: Mutex::new(Connection::open_in_memory().expect("in-memory database opens")),
            recording: RecordingHandle::new(),
            cache_root: PathBuf::new(),
            steam_dir: Mutex::new(String::new()),
            client: reqwest::Client::new(),
            watchers: Mutex::new(HashMap::new()),
            watcher_tx,
            watcher_rx: Mutex::new(Some(watcher_rx)),
            media_server_port: 0,
            events: RwLock::new(Arc::new(NullSink)),
        }
    }

    /// Open the domain against a data directory: database, caches, library
    /// watcher channel, and the embedded media server. `steam_dir` is the
    /// resolved Steam install root from the settings store.
    pub fn open(
        config: BackendConfig,
        data_dir: PathBuf,
        steam_dir: String,
    ) -> std::result::Result<Self, String> {
        let cache_root = data_dir.join("cache");
        std::fs::create_dir_all(&data_dir).map_err(|e| format!("app data dir: {e}"))?;
        std::fs::create_dir_all(&cache_root).map_err(|e| format!("app cache dir: {e}"))?;
        crate::media::set_ffmpeg_dir(data_dir.clone());

        let db = crate::db::open(&data_dir.join("seraphis.db"))?;

        let media_server_port =
            crate::media_server::start().map_err(|e| format!("media server: {e}"))?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("http client: {e}"))?;

        let (watcher_tx, watcher_rx) = channel();
        Ok(Self {
            scheduler: Scheduler::new(config.max_blocking_operations),
            db: Mutex::new(db),
            recording: RecordingHandle::new(),
            cache_root,
            steam_dir: Mutex::new(steam_dir),
            client,
            watchers: Mutex::new(HashMap::new()),
            watcher_tx,
            watcher_rx: Mutex::new(Some(watcher_rx)),
            media_server_port,
            events: RwLock::new(Arc::new(NullSink)),
        })
    }

    /// Install the shell's event sink. Called once during setup.
    pub fn set_events(&self, sink: SharedSink) {
        *self.events.write() = sink;
    }

    pub fn events(&self) -> SharedSink {
        self.events.read().clone()
    }

    /// Take the debounce receiver out for the watcher loop (once).
    pub fn take_watcher_rx(&self) -> Option<Receiver<PathBuf>> {
        self.watcher_rx.lock().take()
    }

    pub fn ping(&self) -> Result<String> {
        Ok("pong".to_owned())
    }

    pub async fn echo(&self, request: EchoRequest) -> Result<EchoResult> {
        let message = request.message.trim().to_owned();
        if message.is_empty() {
            return Err(crate::error::Error::invalid_input(
                "message must not be empty",
            ));
        }
        let length = message.chars().count();
        self.scheduler
            .run(&CancellationToken::new(), move || {
                Ok(EchoResult { message, length })
            })
            .await
    }
}

impl Default for Backend {
    fn default() -> Self {
        Self::new(BackendConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_answers() {
        assert_eq!(Backend::default().ping().unwrap(), "pong");
    }

    #[tokio::test]
    async fn echo_rejects_blank_messages() {
        let backend = Backend::default();
        let err = backend
            .echo(EchoRequest {
                message: "   ".to_owned(),
            })
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalidInput");
    }

    #[tokio::test]
    async fn echo_trims_and_counts_characters_not_bytes() {
        let backend = Backend::default();
        let result = backend
            .echo(EchoRequest {
                message: "  héllo  ".to_owned(),
            })
            .await
            .unwrap();
        assert_eq!(result.message, "héllo");
        assert_eq!(result.length, 5);
    }
}
