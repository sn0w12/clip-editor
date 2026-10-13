//! Settings keys the domain needs to read. Values live in the schema-driven
//! settings store owned by the shell; the domain only names the keys it cares
//! about so the two sides cannot drift on a string literal.

/// Typed convenience accessors used by the backend.
pub mod keys {
    pub const LAUNCH_ON_STARTUP: &str = "launchOnStartup";
    pub const START_REPLAY_BUFFER_ON_STARTUP: &str = "startReplayBufferOnStartup";
    pub const STEAM_DIRECTORY: &str = "steamDirectory";
}
