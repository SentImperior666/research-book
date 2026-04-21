//! Per-project exclusive write lock.
//!
//! Mutating endpoints (ingest, query/save, lint, deep research, config writes)
//! acquire a project-scoped lock; concurrent attempts get `409 Conflict` with a
//! `Retry-After` hint. Read-only endpoints bypass the lock entirely.

use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::sync::Mutex;

static LOCKS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// RAII guard: releases the lock automatically on drop.
pub struct ProjectLockGuard {
    project: String,
}

impl Drop for ProjectLockGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = LOCKS.lock() {
            set.remove(&self.project);
        }
    }
}

/// Try to acquire an exclusive lock for `project_path`.
/// Returns `None` if the project is already locked.
pub fn try_acquire(project_path: &str) -> Option<ProjectLockGuard> {
    let key = normalize(project_path);
    let mut set = LOCKS.lock().ok()?;
    if set.contains(&key) {
        return None;
    }
    set.insert(key.clone());
    Some(ProjectLockGuard { project: key })
}

fn normalize(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}
