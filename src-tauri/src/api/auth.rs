//! Per-install bearer token used to authenticate `/api/*` requests.
//!
//! The token is generated on first launch and stored in the OS config dir at
//! `<config>/llm-wiki/api-token`. On Unix the file is created with mode 0600 so
//! only the current user can read it. Once read, the token is cached in a
//! process-wide `OnceCell`.

use once_cell::sync::Lazy;
use rand::RngCore;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const TOKEN_FILE_NAME: &str = "api-token";
const APP_DIR_NAME: &str = "llm-wiki";

static TOKEN: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// Resolve the on-disk path for the API token file.
fn token_path() -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    Some(base.join(APP_DIR_NAME).join(TOKEN_FILE_NAME))
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    // URL-safe hex: simple and dependency-free.
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}

/// Get (or generate, persist, and cache) the API token for this install.
pub fn get_or_create_token() -> Result<String, String> {
    {
        let cache = TOKEN.lock().map_err(|e| format!("token lock poisoned: {e}"))?;
        if let Some(t) = cache.as_ref() {
            return Ok(t.clone());
        }
    }

    let path = token_path().ok_or_else(|| "no config dir available".to_string())?;

    let token = if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if trimmed.is_empty() {
            let new = generate_token();
            write_token(&path, &new)?;
            new
        } else {
            trimmed
        }
    } else {
        let new = generate_token();
        write_token(&path, &new)?;
        new
    };

    {
        let mut cache = TOKEN.lock().map_err(|e| format!("token lock poisoned: {e}"))?;
        *cache = Some(token.clone());
    }

    Ok(token)
}

fn write_token(path: &std::path::Path, token: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create token dir: {e}"))?;
    }
    fs::write(path, token).map_err(|e| format!("write token: {e}"))?;
    restrict_permissions(path);
    Ok(())
}

/// Validate a bearer token from an `Authorization` header value.
///
/// Accepts either `Bearer <token>` or just `<token>`.
pub fn check_authorization(header: Option<&str>) -> bool {
    let token = match get_or_create_token() {
        Ok(t) => t,
        Err(_) => return false,
    };
    let raw = match header {
        Some(h) => h.trim(),
        None => return false,
    };
    let provided = raw.strip_prefix("Bearer ").unwrap_or(raw).trim();
    constant_time_eq(provided.as_bytes(), token.as_bytes())
}

/// Constant-time equality to avoid leaking token bytes via timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
