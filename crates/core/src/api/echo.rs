//! Wire types crossing the IPC boundary. Everything here is
//! `#[serde(rename_all = "camelCase")]` so the TypeScript protocol twin in
//! `src/lib/backend/protocol.ts` reads the same as the Rust source.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoRequest {
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoResult {
    pub message: String,
    pub length: usize,
}
