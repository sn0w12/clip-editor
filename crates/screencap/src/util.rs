//! Small cross-cutting helpers shared by the capture workers.

use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TrySendError};
use tracing::warn;
/// Emits at most one message per interval. Used to rate-limit warnings from
/// real-time capture paths so a stuck pipeline cannot flood the log.
pub struct RateLimiter {
    interval: Duration,
    last: Option<Instant>,
}

impl RateLimiter {
    pub fn new(interval: Duration) -> Self {
        RateLimiter {
            interval,
            last: None,
        }
    }

    /// Returns `true` if the rate-limit window has elapsed since the last
    /// accepted emission.
    pub fn should_emit(&mut self) -> bool {
        let now = Instant::now();
        let allow = match self.last {
            Some(last) => now.duration_since(last) >= self.interval,
            None => true,
        };
        if allow {
            self.last = Some(now);
        }
        allow
    }
}

/// Send into a bounded channel without ever blocking a real-time capture
/// callback: when the channel is full, the oldest queued item is dropped and
/// the new item is pushed. A rate-limited warning names the dropped end of the
/// pipeline. Disconnected receivers are treated as shutdown.
pub fn send_drop_oldest<T>(
    tx: &Sender<T>,
    rx: &Receiver<T>,
    item: T,
    limiter: &mut RateLimiter,
    what: &str,
) {
    match tx.try_send(item) {
        Ok(()) => {}
        Err(TrySendError::Full(item)) => {
            // crossbeam channels are FIFO: dropping the head drops the oldest.
            let _ = rx.try_recv();
            if limiter.should_emit() {
                warn!(component = %what, "channel full; dropped oldest queued item");
            }
            let _ = tx.try_send(item);
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

/// Write interleaved `f32` samples as little-endian bytes.
pub fn write_f32le<W: std::io::Write>(writer: &mut W, samples: &[f32]) -> std::io::Result<()> {
    #[cfg(target_endian = "little")]
    {
        // SAFETY: on little-endian targets an f32's memory image is its LE
        // encoding; a single write beats per-sample `to_le_bytes` calls.
        let bytes =
            unsafe { std::slice::from_raw_parts(samples.as_ptr() as *const u8, samples.len() * 4) };
        return writer.write_all(bytes);
    }
    #[cfg(not(target_endian = "little"))]
    {
        for s in samples {
            writer.write_all(&s.to_le_bytes())?;
        }
        Ok(())
    }
}
