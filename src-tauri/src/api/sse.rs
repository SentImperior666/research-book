//! Server-Sent Events streaming for long-running jobs.
//!
//! When a tool kicks off an async job (ingest / lint / query / research), the
//! renderer publishes progress events on `api://progress::<jobId>`. This module
//! installs a *single* global listener on `api://progress::*` (we listen by
//! event prefix) and demultiplexes events to subscriber channels keyed by
//! `jobId`. The HTTP `/api/jobs/:jobId/stream` handler creates a subscriber,
//! returns a chunked-transfer body backed by a blocking `Read` impl that pulls
//! event frames from the channel.

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Listener};

#[derive(Debug, Clone, Deserialize)]
pub struct ProgressEvent {
    #[serde(rename = "jobId")]
    pub job_id: String,
    /// Forwarded verbatim into the SSE `event:` line; not inspected here.
    #[serde(default)]
    #[allow(dead_code)]
    pub status: Option<String>,
    /// Forwarded verbatim into SSE `data:`; useful for downstream debugging.
    #[serde(default)]
    #[allow(dead_code)]
    pub detail: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub progress: Option<f32>,
    #[serde(default)]
    #[allow(dead_code)]
    pub data: serde_json::Value,
    #[serde(default)]
    pub done: bool,
}

type Subs = Mutex<HashMap<String, Vec<Sender<String>>>>;
static SUBS: Lazy<Subs> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Install the global progress listener. Call once at startup.
pub fn install_progress_listener(app: &AppHandle) {
    // Tauri's `listen` does not support wildcards, so we listen on a single
    // event channel `api://progress` and demux based on `jobId` in the
    // payload. The renderer emits `api://progress` for every progress tick.
    let _ = app.listen("api://progress", |event| {
        let payload = event.payload();
        let parsed = match serde_json::from_str::<ProgressEvent>(payload) {
            Ok(ev) => ev,
            Err(_) => return,
        };
        let frame = format_sse_frame(&parsed, payload);

        let mut map = match SUBS.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        if let Some(senders) = map.get_mut(&parsed.job_id) {
            senders.retain(|tx| tx.send(frame.clone()).is_ok());
            if parsed.done {
                // Final frame delivered; close any remaining subscribers.
                senders.clear();
            }
            if senders.is_empty() {
                map.remove(&parsed.job_id);
            }
        }
    });
}

fn format_sse_frame(ev: &ProgressEvent, raw: &str) -> String {
    // SSE convention: `event:` + `data:` lines, terminated by blank line.
    let event_kind = if ev.done {
        "done"
    } else {
        ev.status.as_deref().unwrap_or("progress")
    };
    format!("event: {}\ndata: {}\n\n", event_kind, raw)
}

/// Create a subscriber for the given job. Returns a blocking `Read` body
/// suitable for a streaming HTTP response.
pub fn subscribe(job_id: String) -> SseBody {
    let (tx, rx) = channel::<String>();
    {
        if let Ok(mut map) = SUBS.lock() {
            map.entry(job_id.clone()).or_default().push(tx);
        }
    }
    SseBody::new(job_id, rx)
}

const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

pub struct SseBody {
    #[allow(dead_code)]
    job_id: String,
    rx: Receiver<String>,
    pending: Vec<u8>,
    pos: usize,
    closed: bool,
}

impl SseBody {
    fn new(job_id: String, rx: Receiver<String>) -> Self {
        let mut s = Self {
            job_id,
            rx,
            pending: Vec::new(),
            pos: 0,
            closed: false,
        };
        // Initial comment so clients know the stream opened.
        s.pending = b": connected\n\n".to_vec();
        s
    }
}

impl Read for SseBody {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.pos < self.pending.len() {
                let n = std::cmp::min(buf.len(), self.pending.len() - self.pos);
                buf[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
                self.pos += n;
                return Ok(n);
            }

            if self.closed {
                return Ok(0);
            }

            match self.rx.recv_timeout(KEEPALIVE_INTERVAL) {
                Ok(frame) => {
                    self.pending = frame.into_bytes();
                    self.pos = 0;
                    // Heuristic close: a frame containing `event: done` ends the stream.
                    if std::str::from_utf8(&self.pending)
                        .map(|s| s.contains("event: done"))
                        .unwrap_or(false)
                    {
                        self.closed = true;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    self.pending = b": keepalive\n\n".to_vec();
                    self.pos = 0;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    self.pending = b"event: done\ndata: {\"jobId\":\"\",\"done\":true}\n\n".to_vec();
                    self.pos = 0;
                    self.closed = true;
                }
            }
        }
    }
}
