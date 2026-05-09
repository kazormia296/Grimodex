//! Tauri command modules.
//!
//! 機能別に command を分割する。共有 state/型/ヘルパーは本ファイルで定義し、
//! `pub(crate)` で各サブモジュールに公開する。run() で `app.manage(...)` も
//! lib.rs から本ファイルの型を参照する。

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::database::Database;

pub(crate) mod ai;
pub(crate) mod cli_ai;
pub(crate) mod db;
pub(crate) mod foreshadow;
pub(crate) mod integrity;
pub(crate) mod lint;
pub(crate) mod trash_bin;
pub(crate) mod workspace;

// ---------------------------------------------------------------------------
// Shared state structs
// ---------------------------------------------------------------------------

/// AtomicBool flag to request aborting an in-progress chat stream.
pub(crate) struct StreamAbortFlag {
    pub(crate) flag: Arc<std::sync::atomic::AtomicBool>,
}

/// AtomicBool flag to request aborting an in-progress inline-AI stream.
/// Kept separate from `StreamAbortFlag` so that aborting one does not affect the other
/// when Chat and inline AI are streaming simultaneously.
pub(crate) struct InlineAiAbortFlag {
    pub(crate) flag: Arc<std::sync::atomic::AtomicBool>,
}

/// AtomicBool flag to request aborting an in-progress CLI provider stream.
/// CLI providers (Claude Code / Codex / OpenCode) are spawned as subprocesses
/// and need their own abort signal independent from the HTTP-based Chat stream.
pub(crate) struct CliStreamAbortFlag {
    pub(crate) flag: Arc<std::sync::atomic::AtomicBool>,
}

/// Holds the `tracing-appender` worker guard so the non-blocking writer
/// keeps draining for the lifetime of the Tauri app. Dropping this
/// flushes pending log lines synchronously.
pub(crate) struct LogGuard(
    #[allow(dead_code)] pub(crate) tracing_appender::non_blocking::WorkerGuard,
);

/// Holds the currently-open workspace's DB.
/// Wrapped in Option so it can be None before a workspace is opened.
pub(crate) struct ActiveWorkspace {
    pub(crate) db: Database,
    #[allow(dead_code)]
    pub(crate) path: PathBuf,
}

pub(crate) struct WorkspaceState {
    pub(crate) inner: Mutex<Option<ActiveWorkspace>>,
}

/// Path to the global settings file in AppData.
pub(crate) struct GlobalSettingsPath {
    pub(crate) path: PathBuf,
}

/// Path to the AI settings file in AppData.
pub(crate) struct AiSettingsPath {
    pub(crate) path: PathBuf,
}

// ---------------------------------------------------------------------------
// Shared error / result / helper
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub(crate) enum AppError {
    #[error("{0}")]
    Anyhow(#[from] anyhow::Error),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Serialize)]
pub(crate) struct QueryResult {
    pub(crate) rows: Vec<serde_json::Map<String, Value>>,
}

/// Run `f` against the active workspace's DB. Returns an error if no
/// workspace is currently open.
pub(crate) fn with_db<T>(
    ws_state: &tauri::State<'_, WorkspaceState>,
    f: impl FnOnce(&Database) -> anyhow::Result<T>,
) -> Result<T, AppError> {
    // Phase 5 instrumentation: log ws_state lock contention. This is the
    // outer Mutex held for the entire DB call, so contention here delays
    // every DB-touching command — including readers behind a slow writer.
    let lock_started = std::time::Instant::now();
    let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    let ws_lock_ms = lock_started.elapsed().as_millis();
    if ws_lock_ms >= 50 {
        tracing::warn!("with_db ws_state.lock wait={}ms", ws_lock_ms);
    }
    let ws = inner
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No workspace is open"))?;
    Ok(f(&ws.db)?)
}
