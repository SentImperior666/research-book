//! HTTP routing for the `/api/*` namespace.
//!
//! Authentication, lock acquisition, and JSON parsing happen here; everything
//! else is delegated to the renderer over the bridge. Routes are intentionally
//! thin: each one constructs an `ApiRequest` describing the operation and
//! forwards the renderer's reply verbatim.

use serde_json::{json, Value};
use std::collections::HashMap;
#[allow(unused_imports)]
use std::io::Read;
use tauri::AppHandle;
use tiny_http::{Header, Method, Request, Response};

use super::auth::check_authorization;
use super::bridge::{dispatch, new_correlation_id, ApiRequest};
use super::locks::try_acquire;
use super::sse::subscribe;

/// Routes that are read-only and bypass the per-project lock.
const READ_ONLY_ROUTES: &[&str] = &[
    "/api/health",
    "/api/templates",
    "/api/projects",
    "/api/config/llm",
    "/api/config/embedding",
    "/api/config/search",
    "/api/sources",
    "/api/wiki/index",
    "/api/wiki/pages",
    "/api/wiki/page",
    "/api/graph",
    "/api/review",
    "/api/jobs",
];

/// Mutating routes that require the per-project exclusive lock.
const MUTATING_ROUTES: &[&str] = &[
    "/api/projects",        // POST: create
    "/api/projects/open",   // POST
    "/api/projects/select", // POST
    "/api/config/llm",      // POST
    "/api/config/embedding",
    "/api/config/search",
    "/api/sources/import",
    "/api/sources/delete",
    "/api/query",
    "/api/lint",
    "/api/research",
    "/api/review/resolve",
];

/// Returns true if this request should be handled by the API router.
pub fn matches(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// Top-level entry point. Returns `true` if the request was handled.
pub fn handle(app: &AppHandle, mut request: Request) -> bool {
    let url = request.url().to_string();
    if !matches(&url) {
        return false;
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    let auth_header = request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("authorization"))
        .map(|h| h.value.as_str().to_string());

    if !check_authorization(auth_header.as_deref()) {
        let body = json!({ "error": "unauthorized" }).to_string();
        let _ = request.respond(json_response(401, &body));
        return true;
    }

    // ── CORS preflight ────────────────────────────────────────────────────
    if matches!(request.method(), Method::Options) {
        let _ = request.respond(cors_preflight_response());
        return true;
    }

    // ── Parse path + query ────────────────────────────────────────────────
    let (path, query) = split_path_query(&url);

    // ── SSE streaming (must come before generic body parse) ───────────────
    if path.starts_with("/api/jobs/") && path.ends_with("/stream") {
        let job_id = path
            .trim_start_matches("/api/jobs/")
            .trim_end_matches("/stream")
            .to_string();
        if job_id.is_empty() {
            let _ = request.respond(json_response(400, r#"{"error":"missing job id"}"#));
            return true;
        }
        let body = subscribe(job_id);
        let mut response = Response::new(
            tiny_http::StatusCode(200),
            sse_headers(),
            body,
            None,
            None,
        );
        // Disable any keep-alive so the long-lived stream isn't capped.
        response.add_header(Header::from_bytes(&b"Connection"[..], &b"close"[..]).unwrap());
        let _ = request.respond(response);
        return true;
    }

    // ── Body ──────────────────────────────────────────────────────────────
    let mut body_str = String::new();
    let _ = request.as_reader().read_to_string(&mut body_str);
    let body: Value = if body_str.is_empty() {
        Value::Null
    } else {
        match serde_json::from_str(&body_str) {
            Ok(v) => v,
            Err(e) => {
                let msg = format!(r#"{{"error":"invalid json: {e}"}}"#);
                let _ = request.respond(json_response(400, &msg));
                return true;
            }
        }
    };

    let method = method_str(request.method());

    // ── Per-project lock for mutating routes ──────────────────────────────
    let project_for_lock = extract_project_path(path, request.method(), &body, &query);
    let _guard = if needs_lock(path, request.method()) {
        if let Some(project) = project_for_lock.as_ref() {
            match try_acquire(project) {
                Some(g) => Some(g),
                None => {
                    let body = json!({
                        "error": "project busy",
                        "code": "project_locked",
                        "project": project,
                    })
                    .to_string();
                    let mut resp = json_response(409, &body);
                    resp.add_header(Header::from_bytes(&b"Retry-After"[..], &b"5"[..]).unwrap());
                    let _ = request.respond(resp);
                    return true;
                }
            }
        } else {
            // No project specified for a mutating route: still allow but warn.
            None
        }
    } else {
        None
    };

    // ── Dispatch to renderer ──────────────────────────────────────────────
    let api_req = ApiRequest {
        correlation_id: new_correlation_id(),
        method,
        route: path.to_string(),
        query,
        body,
    };

    let reply = match dispatch(app, api_req) {
        Ok(r) => r,
        Err(e) => {
            let body = json!({
                "error": "renderer_unreachable",
                "detail": e,
            })
            .to_string();
            let _ = request.respond(json_response(503, &body));
            return true;
        }
    };

    let status = reply.status.unwrap_or(if reply.ok { 200 } else { 500 });
    let payload = if reply.ok {
        reply.data.to_string()
    } else {
        json!({
            "error": reply.error.unwrap_or_else(|| "renderer error".to_string()),
            "data": reply.data,
        })
        .to_string()
    };
    let _ = request.respond(json_response(status, &payload));
    true
}

fn json_response(status: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body.to_string()).with_status_code(status);
    response.add_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap(),
    );
    response.add_header(
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
    );
    response.add_header(
        Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Authorization,Content-Type"[..])
            .unwrap(),
    );
    response.add_header(
        Header::from_bytes(
            &b"Access-Control-Allow-Methods"[..],
            &b"GET,POST,DELETE,OPTIONS"[..],
        )
        .unwrap(),
    );
    response
}

fn cors_preflight_response() -> Response<std::io::Empty> {
    let mut resp = Response::empty(204);
    resp.add_header(
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
    );
    resp.add_header(
        Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Authorization,Content-Type"[..])
            .unwrap(),
    );
    resp.add_header(
        Header::from_bytes(
            &b"Access-Control-Allow-Methods"[..],
            &b"GET,POST,DELETE,OPTIONS"[..],
        )
        .unwrap(),
    );
    resp
}

fn sse_headers() -> Vec<Header> {
    vec![
        Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..]).unwrap(),
        Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap(),
        Header::from_bytes(&b"X-Accel-Buffering"[..], &b"no"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Authorization,Content-Type"[..])
            .unwrap(),
    ]
}

fn method_str(m: &Method) -> String {
    match m {
        Method::Get => "GET",
        Method::Post => "POST",
        Method::Put => "PUT",
        Method::Delete => "DELETE",
        Method::Patch => "PATCH",
        Method::Options => "OPTIONS",
        Method::Head => "HEAD",
        _ => "OTHER",
    }
    .to_string()
}

fn split_path_query(url: &str) -> (&str, HashMap<String, String>) {
    if let Some(idx) = url.find('?') {
        let (path, q) = url.split_at(idx);
        let q = &q[1..];
        let mut map = HashMap::new();
        for pair in q.split('&').filter(|s| !s.is_empty()) {
            let mut parts = pair.splitn(2, '=');
            let key = url_decode(parts.next().unwrap_or(""));
            let value = url_decode(parts.next().unwrap_or(""));
            map.insert(key, value);
        }
        (path, map)
    } else {
        (url, HashMap::new())
    }
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

/// Determine whether a route+method combination should grab the per-project lock.
fn needs_lock(path: &str, method: &Method) -> bool {
    let is_get = matches!(method, Method::Get);
    if is_get {
        return false;
    }
    // Read-only path with a non-mutating method (HEAD/OPTIONS) shouldn't lock.
    if READ_ONLY_ROUTES.contains(&path) && !MUTATING_ROUTES.contains(&path) {
        return false;
    }
    MUTATING_ROUTES.contains(&path) || path.starts_with("/api/sources/")
}

/// Best-effort extraction of the project path for lock keying.
///
/// Fall-through order:
///   1. `body.projectPath`
///   2. `body.path` for project lifecycle routes (create/open/select)
///   3. `?projectPath=` query string
///   4. The currently-active project mirrored by the daemon (`POST /project`,
///      which both `App.tsx` and `api-server.ts::selectProjectInRenderer`
///      keep in sync). Without this fallback, a CLI that omits
///      `--project-path` would silently bypass the per-project lock — and
///      since the renderer still resolves the operation against the active
///      project, two concurrent CLIs would happily clobber each other.
fn extract_project_path(
    path: &str,
    _method: &Method,
    body: &Value,
    query: &HashMap<String, String>,
) -> Option<String> {
    if let Some(p) = body.get("projectPath").and_then(|v| v.as_str()) {
        return Some(p.to_string());
    }
    if let Some(p) = body.get("path").and_then(|v| v.as_str()) {
        if path == "/api/projects" || path == "/api/projects/open" || path == "/api/projects/select" {
            return Some(p.to_string());
        }
    }
    if let Some(p) = query.get("projectPath") {
        return Some(p.clone());
    }
    crate::clip_server::get_current_project()
}
