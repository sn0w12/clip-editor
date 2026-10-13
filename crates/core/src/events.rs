use std::sync::Arc;

/// Sink for backend-originated events. The shell implements it over the Tauri
/// event bus so the domain never depends on `tauri`; tests use `NullSink`.
pub trait EventSink: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

pub type SharedSink = Arc<dyn EventSink>;

pub struct NullSink;

impl EventSink for NullSink {
    fn emit_json(&self, _event: &str, _payload: serde_json::Value) {}
}

pub fn emit<T: serde::Serialize>(sink: &dyn EventSink, event: &str, payload: T) {
    sink.emit_json(
        event,
        serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
    );
}
