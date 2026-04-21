//! Bridge between the Rust HTTP daemon and the Tauri renderer.
//!
//! Flow:
//! 1. HTTP handler builds an `ApiRequest`, registers a oneshot reply channel
//!    keyed by `correlationId`, and emits the `api://request` event.
//! 2. The renderer dispatcher (`src/lib/api-server.ts`) handles the request
//!    against the live `src/lib/*` functions and emits `api://reply` with the
//!    same `correlationId`.
//! 3. A single global Tauri listener (registered at startup) routes the reply
//!    back to the waiting HTTP handler over the channel.
//!
//! Long-running operations return immediately with `{ "jobId": ... }` and
//! stream progress over SSE (see `sse.rs`).

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Listener};

/// 15 minute upper bound — matches the existing long-ingest budget.
const REPLY_TIMEOUT: Duration = Duration::from_secs(900);

#[derive(Debug, Clone, Serialize)]
pub struct ApiRequest {
    #[serde(rename = "correlationId")]
    pub correlation_id: String,
    pub method: String,
    pub route: String,
    pub query: HashMap<String, String>,
    pub body: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ApiReply {
    #[serde(rename = "correlationId")]
    pub correlation_id: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub error: Option<String>,
}

type ReplyMap = Mutex<HashMap<String, SyncSender<ApiReply>>>;
static PENDING: Lazy<ReplyMap> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Register the global Tauri listener that funnels `api://reply` events back
/// to the waiting HTTP handlers. Call once at app startup.
pub fn install_reply_listener(app: &AppHandle) {
    let _ = app.listen("api://reply", |event| {
        let payload = event.payload();
        match serde_json::from_str::<ApiReply>(payload) {
            Ok(reply) => {
                if let Ok(mut map) = PENDING.lock() {
                    if let Some(tx) = map.remove(&reply.correlation_id) {
                        let _ = tx.send(reply);
                    }
                }
            }
            Err(err) => {
                eprintln!("[api bridge] failed to parse api://reply payload: {err} ({payload})");
            }
        }
    });
}

/// Issue a request to the renderer and block until it replies (or times out).
pub fn dispatch(app: &AppHandle, req: ApiRequest) -> Result<ApiReply, String> {
    let (tx, rx) = sync_channel::<ApiReply>(1);

    {
        let mut map = PENDING.lock().map_err(|e| format!("pending lock: {e}"))?;
        map.insert(req.correlation_id.clone(), tx);
    }

    if let Err(e) = app.emit("api://request", &req) {
        // Clean up on emit failure.
        if let Ok(mut map) = PENDING.lock() {
            map.remove(&req.correlation_id);
        }
        return Err(format!("emit api://request failed: {e}"));
    }

    match rx.recv_timeout(REPLY_TIMEOUT) {
        Ok(reply) => Ok(reply),
        Err(_) => {
            if let Ok(mut map) = PENDING.lock() {
                map.remove(&req.correlation_id);
            }
            Err("renderer did not reply in time (15min)".to_string())
        }
    }
}

/// Generate a fresh, unique correlation id.
pub fn new_correlation_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
