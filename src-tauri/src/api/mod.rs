//! Local HTTP + MCP-bridging API exposed by the desktop app.
//!
//! Routes under `/api/*` are authenticated with a per-install bearer token and
//! dispatched into the Tauri renderer (which holds the live business logic in
//! `src/lib/*`). See `bridge.rs` for the request/response correlation, `sse.rs`
//! for progress streaming, `locks.rs` for per-project write serialization, and
//! `auth.rs` for token storage.

pub mod auth;
pub mod bridge;
pub mod locks;
pub mod router;
pub mod sse;
