//! Host I/O only. Cloud-bank normalization and update policy must use frozen JS.
pub mod http;
pub mod migration;
pub mod storage;

/// Reviewed host transport correction; the TypeScript answer core is unchanged.
/// LEGACY-AI-UTF8-001 chooses a streaming UTF-8 decoder instead of reproducing
/// the old per-Buffer corruption. SSE contents and request identities stay intact.
pub const UTF8_TRANSPORT_DECISION: &str =
    "LEGACY-AI-UTF8-001: preserve valid UTF-8 across network chunk boundaries";
