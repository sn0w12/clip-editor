use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{Error, Result};

/// Cooperative cancellation flag shared between the scheduler, the blocking
/// worker and the IPC command that started it. Clones share one flag, so the
/// command layer can hand a token to the frontend as an operation id.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    /// Returns true if this call performed the cancellation.
    pub fn cancel(&self) -> bool {
        !self.0.swap(true, Ordering::AcqRel)
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    /// Call from inside a long loop; returns [`Error::Cancelled`] once the
    /// operation has been cancelled.
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_reports_first_caller_only() {
        let token = CancellationToken::new();
        assert!(token.cancel());
        assert!(!token.cancel());
        assert_eq!(token.check().unwrap_err().code(), "cancelled");
    }

    #[test]
    fn clones_share_state() {
        let token = CancellationToken::new();
        token.clone().cancel();
        assert!(token.is_cancelled());
    }
}
