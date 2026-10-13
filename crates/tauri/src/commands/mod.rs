use seraphis_core::error::SerializedError;

pub type CommandResult<T> = Result<T, SerializedError>;

/// Serializes a domain error onto the wire. Every command funnels its
/// failures through this so the frontend sees one error shape.
pub fn to_serialized(error: seraphis_core::Error) -> SerializedError {
    SerializedError::from(&error)
}

pub mod app;
pub mod clip;
pub mod session;
pub mod settings;
