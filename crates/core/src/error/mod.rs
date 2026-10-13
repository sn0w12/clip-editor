//! The single error type every backend call resolves to. It serializes to
//! `{ code, message, retryable, detail }` with stable camelCase codes, which
//! is what lets the frontend branch on failures without string matching.

use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    #[error("invalid input: {reason}")]
    InvalidInput { reason: String },
    #[error("not found: {what}")]
    NotFound { what: String },
    #[error("conflict: {details}")]
    Conflict { details: String },
    #[error("resource is busy: {details}")]
    Busy { details: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("operation cancelled")]
    Cancelled,
    #[error("not supported: {capability}")]
    Unsupported { capability: String },
    #[error("{message}")]
    Internal { message: String },
}

impl Error {
    pub fn invalid_input(reason: impl Into<String>) -> Self {
        Error::InvalidInput {
            reason: reason.into(),
        }
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        Error::NotFound { what: what.into() }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Error::Internal {
            message: message.into(),
        }
    }

    /// Stable wire code. Frontend code and tests may rely on these strings.
    pub fn code(&self) -> &'static str {
        match self {
            Error::InvalidInput { .. } => "invalidInput",
            Error::NotFound { .. } => "notFound",
            Error::Conflict { .. } => "conflict",
            Error::Busy { .. } => "busy",
            Error::Io(_) => "io",
            Error::Cancelled => "cancelled",
            Error::Unsupported { .. } => "unsupported",
            Error::Internal { .. } => "internal",
        }
    }

    /// Whether a retry has a real chance of succeeding. The UI uses this to
    /// decide between a plain error toast and one with a retry affordance.
    pub fn retryable(&self) -> bool {
        matches!(self, Error::Busy { .. } | Error::Io(_))
    }
}

impl From<tokio::sync::AcquireError> for Error {
    fn from(_: tokio::sync::AcquireError) -> Self {
        Error::internal("scheduler closed")
    }
}

impl From<tokio::task::JoinError> for Error {
    fn from(err: tokio::task::JoinError) -> Self {
        if err.is_cancelled() {
            Error::Cancelled
        } else {
            Error::internal(format!("worker panicked: {err}"))
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SerializedError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn detail_of(err: &Error) -> Option<String> {
    match err {
        Error::InvalidInput { reason } => Some(reason.clone()),
        Error::NotFound { what } => Some(what.clone()),
        Error::Conflict { details } => Some(details.clone()),
        Error::Busy { details } => Some(details.clone()),
        Error::Unsupported { capability } => Some(capability.clone()),
        _ => None,
    }
}

impl From<&Error> for SerializedError {
    fn from(err: &Error) -> Self {
        SerializedError {
            code: err.code(),
            message: err.to_string(),
            retryable: err.retryable(),
            detail: detail_of(err),
        }
    }
}

/// Bridge for domain code that still returns `Result<_, String>`: the command
/// layer converts those messages onto the wire without rewriting every call.
impl From<String> for SerializedError {
    fn from(message: String) -> Self {
        SerializedError {
            code: "internal",
            message,
            retryable: false,
            detail: None,
        }
    }
}

impl From<&str> for SerializedError {
    fn from(message: &str) -> Self {
        SerializedError::from(message.to_owned())
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let payload = SerializedError::from(self);
        let mut state = serializer.serialize_struct("SerializedError", 3)?;
        state.serialize_field("code", &payload.code)?;
        state.serialize_field("message", &payload.message)?;
        state.serialize_field("retryable", &payload.retryable)?;
        if let Some(detail) = &payload.detail {
            state.serialize_field("detail", detail)?;
        }
        state.end()
    }
}

impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code()
    }
}

impl fmt::Display for SerializedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_stable_codes() {
        let err = Error::invalid_input("message is empty");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "invalidInput");
        assert_eq!(json["detail"], "message is empty");
        assert_eq!(json["retryable"], false);
    }

    #[test]
    fn io_errors_are_retryable_and_convert() {
        let err: Error = std::io::Error::new(std::io::ErrorKind::NotFound, "gone").into();
        assert_eq!(err.code(), "io");
        assert!(err.retryable());
    }

    #[test]
    fn cancellation_is_distinct_and_terminal() {
        assert_eq!(Error::Cancelled.code(), "cancelled");
        assert!(!Error::Cancelled.retryable());
    }

    #[test]
    fn equality_compares_codes() {
        assert_eq!(Error::not_found("a"), Error::not_found("b"));
        assert_ne!(Error::not_found("a"), Error::invalid_input("a"));
    }
}
