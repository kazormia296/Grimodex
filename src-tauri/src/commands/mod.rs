//! Tauri command modules.
//!
//! 機能別に command を分割する。共有 state/型/ヘルパーは本ファイルで定義し、
//! `pub(crate)` で各サブモジュールに公開する。run() で `app.manage(...)` も
//! lib.rs から本ファイルの型を参照する。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::database::Database;

// DB 層の state / 契約型は crates/grimodex-db へ移動 (Electron 移行 Phase 2
// S1)。この re-export シムで各コマンドファイルの `use super::{AppError, …}` は
// 1 行も変えずに従来どおり解決する。AppError の文字列ワイヤ契約
// (WORKSPACE_SWITCHING / No workspace is open) のテストも同クレートへ移動済み。
pub(crate) use grimodex_db::{
    with_db_state, ActiveWorkspace, AppError, AppResult, GlobalSettingsPath, QueryResult,
    WorkspaceState,
};

pub(crate) mod agent_writes;
pub(crate) mod ai;
pub(crate) mod cli_ai;
pub(crate) mod codex_candidates;
pub(crate) mod db;
pub(crate) mod export;
pub(crate) mod external_mount;
pub(crate) mod fonts;
pub(crate) mod foreshadow;
pub(crate) mod integrity;
pub(crate) mod license;
pub(crate) mod lint;
pub(crate) mod logs;
pub(crate) mod onboarding;
pub(crate) mod plot_threads;
pub(crate) mod post_effect;
pub(crate) mod reorder;
#[cfg(feature = "semantic-embedding")]
pub(crate) mod semantic;
pub(crate) mod timelapse;
pub(crate) mod trash_bin;
pub(crate) mod vivliostyle;
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

/// PostEffect run の中止要求を run_id 単位で保持するレジストリ。
/// 旧実装はアプリ全体で単一の AtomicBool だったため、並走 run の一方を
/// 中止すると全 run に波及し、新 run 開始が中止要求を握り潰していた。
pub(crate) struct PostEffectAbortRegistry {
    aborted: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl PostEffectAbortRegistry {
    pub(crate) fn new() -> Self {
        Self {
            aborted: std::sync::Mutex::new(std::collections::HashSet::new()),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
        // poison は前保持者の panic 痕。フラグ集合は整合性を要しないので回復して続行。
        self.aborted.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn request(&self, run_id: &str) {
        self.lock().insert(run_id.to_string());
    }
    pub(crate) fn is_aborted(&self, run_id: &str) -> bool {
        self.lock().contains(run_id)
    }
    /// run 終端時に呼ぶ（累積によるメモリリーク防止）。
    pub(crate) fn clear(&self, run_id: &str) {
        self.lock().remove(run_id);
    }
}

/// Holds the `tracing-appender` worker guard so the non-blocking writer
/// keeps draining for the lifetime of the Tauri app. Dropping this
/// flushes pending log lines synchronously.
pub(crate) struct LogGuard(
    #[allow(dead_code)] pub(crate) tracing_appender::non_blocking::WorkerGuard,
);

/// Path to the AI settings file in AppData.
pub(crate) struct AiSettingsPath {
    pub(crate) path: PathBuf,
}

/// Path to the license file in AppData (ライセンス認証設計書 §2)。
/// global-settings.json と同階層の独立ファイル。メモリキャッシュは持たず
/// ファイルを唯一の正本とする。
pub(crate) struct LicensePath {
    pub(crate) path: PathBuf,
    /// license.json の read-modify-write を直列化する番兵。sync コマンド
    /// (get_license_state) と async コマンド (activate 等) は別スレッドで
    /// 並行しうるため、これが無いと lost update が起きる。
    /// ガードは絶対に await を跨がないこと (std::sync::MutexGuard は !Send)。
    pub(crate) write_lock: Mutex<()>,
    /// validate の in-flight フラグ。手動再検証とバックグラウンドサイクルが
    /// 同時に Polar へ validate を二重送信するのを防ぐ。
    pub(crate) validate_in_flight: std::sync::atomic::AtomicBool,
}

// ---------------------------------------------------------------------------
// Shared error / result / helper
// ---------------------------------------------------------------------------
// AppError / AppResult / QueryResult / with_db_state の実体と文字列ワイヤ契約
// のテストは grimodex-db (crates/grimodex-db/src/{error,state}.rs) に移動した。

/// Run `f` against the active workspace's DB. Returns an error if no
/// workspace is currently open.
pub(crate) fn with_db<T>(
    ws_state: &tauri::State<'_, WorkspaceState>,
    f: impl FnOnce(&Database) -> anyhow::Result<T>,
) -> AppResult<T> {
    with_db_state(ws_state, f)
}
