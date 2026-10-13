use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInvalidation {
    pub repo_id: u64,
    pub generation: u64,
    pub reason: String,
}

/// Fan-out hub for repository invalidation notifications.
///
/// The Tauri layer subscribes once and forwards entries to the webview as a
/// low-frequency `repository-invalidated` event. Slow receivers only lag;
/// they never block mutation paths.
#[derive(Clone, Default)]
pub struct InvalidationHub {
    sender: Option<broadcast::Sender<RepositoryInvalidation>>,
}

impl InvalidationHub {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(256);
        Self {
            sender: Some(sender),
        }
    }

    pub fn publish(&self, repo_id: u64, generation: u64, reason: impl Into<String>) {
        if let Some(sender) = &self.sender {
            let _ = sender.send(RepositoryInvalidation {
                repo_id,
                generation,
                reason: reason.into(),
            });
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RepositoryInvalidation> {
        self.sender.as_ref().expect("hub sender").subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribers_receive_published_events() {
        let hub = InvalidationHub::new();
        let mut rx = hub.subscribe();

        hub.publish(7, 42, "watcher");

        let event = rx.try_recv().unwrap();
        assert_eq!(event.repo_id, 7);
        assert_eq!(event.generation, 42);
        assert_eq!(event.reason, "watcher");
    }

    #[test]
    fn lagged_or_dropped_receivers_do_not_break_publishers() {
        let hub = InvalidationHub::new();
        let rx = hub.subscribe();
        drop(rx);

        for generation in 0..600u64 {
            hub.publish(1, generation, "burst");
        }
    }

    #[test]
    fn default_hub_is_safe_to_publish() {
        let hub = InvalidationHub::default();
        hub.publish(1, 1, "noop");
    }
}
