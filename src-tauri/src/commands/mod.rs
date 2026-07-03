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
pub(crate) mod onboarding;
pub(crate) mod plot_threads;
pub(crate) mod post_effect;
#[cfg(feature = "semantic-embedding")]
pub(crate) mod semantic;
pub(crate) mod timelapse;
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

/// AtomicBool flag to request aborting an in-progress PostEffect run.
/// Each run checks this flag periodically; set to true to request cancellation.
pub(crate) struct PostEffectAbortFlag {
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
///
/// `db` は `Arc<Database>` にして `with_db_state` が clone-then-drop できる
/// ようにしている: ws_state.inner ロックを SQL 実行の前に解放し、遅いライタ
/// の背後で全リーダ/ライタが直列化されるのを防ぐ (アーキ監査 2026-07 の見出し
/// 「ws_state Mutex を DB コール全体で保持」の解消)。swap 中に発行済みの
/// コマンドは pre-swap で clone した Arc (旧 DB) に着弾するので、新 DB への
/// 混入は起きない (open_workspace の swap 不変条件と両立)。実際の DB 直列化は
/// Database 内部の conn: Mutex<Connection> が引き続き担う。
pub(crate) struct ActiveWorkspace {
    pub(crate) db: Arc<Database>,
    #[allow(dead_code)]
    pub(crate) path: PathBuf,
}

pub(crate) struct WorkspaceState {
    pub(crate) inner: Mutex<Option<ActiveWorkspace>>,
    /// `open_workspace` 実行中フラグ。DB コマンドの async 化 (M3) で
    /// open_workspace と他コマンドが真に並行するようになったため、切替中の
    /// DB アクセスを `with_db` で明示エラーにする (swap を跨いだ write が
    /// 切替後の別 workspace の DB へ黙って落ちるより遥かに良い失敗モード)。
    /// set/reset は open_workspace 内の RAII ガードが行う。
    pub(crate) switching: std::sync::atomic::AtomicBool,
    /// `open_workspace` 自体を直列化する番兵。並行 open による同一 DB への
    /// 併走 migrate (add_column_if_missing の check-then-act) と二重
    /// VACUUM INTO を防ぐ。ガードは絶対に await を跨がないこと
    /// (std::sync::MutexGuard は !Send)。
    pub(crate) open_lock: Mutex<()>,
}

/// Path to the global settings file in AppData.
pub(crate) struct GlobalSettingsPath {
    pub(crate) path: PathBuf,
    /// global-settings.json の read-modify-write を直列化する番兵
    /// (license.rs の `write_lock` と同型)。M3 async 化で blocking pool 上の
    /// open_workspace / seed_sample_workspace と main thread の
    /// save_global_settings が並行しうるため、これが無いと lost update が
    /// 起きる。ガードは絶対に await を跨がないこと
    /// (std::sync::MutexGuard は !Send)。
    pub(crate) write_lock: Mutex<()>,
}

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
    with_db_state(ws_state, f)
}

/// `tauri::State` を剥がした `with_db` 本体。単体テストから `WorkspaceState`
/// を直接組んで検証できるように分離している。
pub(crate) fn with_db_state<T>(
    ws_state: &WorkspaceState,
    f: impl FnOnce(&Database) -> anyhow::Result<T>,
) -> Result<T, AppError> {
    // ws_state.inner はアクティブ workspace の解決 (Option → Arc<Database>) と
    // switching チェックのためだけに取得し、SQL 実行 (f) の前に必ず解放する。
    // 以前は f をロック保持下で走らせていたため、ws_state Mutex が DB コール
    // 全体を直列化し、遅いライタの背後で全リーダが待たされていた (アーキ監査
    // 2026-07 の見出し指摘)。db を Arc<Database> にしたことで clone-then-drop
    // でき、実際の DB 直列化は Database 内部の conn: Mutex<Connection> が担う。
    // Phase 5 instrumentation: ws_state lock 取得待ちが 50ms 以上なら警告
    // (以前ほど長く保持しないが、取得待ち自体はリーダ数のシグナルとして残す)。
    let lock_started = std::time::Instant::now();
    let db = {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let ws_lock_ms = lock_started.elapsed().as_millis();
        if ws_lock_ms >= 50 {
            tracing::warn!("with_db ws_state.lock wait={}ms", ws_lock_ms);
        }
        // workspace 切替中の DB アクセスは明示エラーで拒否する (M3)。フロントは
        // 保存失敗 toast + dirty 維持でリトライに任せる。切替を跨いだ write が
        // 別 workspace の DB へ黙って落ちる (UPDATE は 0行 hit の黙示ロスト、
        // INSERT は行混入) のを防ぐ。
        // "WORKSPACE_SWITCHING" はフロントが判別に使う安定マーカー (timelapse
        // recorder の再送抑止 / 保存失敗 toast の文言差し替え)。TS 側の対の定数は
        // src/features/concurrency/workspaceSwitching.ts の
        // WORKSPACE_SWITCHING_MARKER。変更するときは両方同時に。
        if ws_state.switching.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(anyhow::anyhow!(
                "WORKSPACE_SWITCHING: workspace is switching; DB access is temporarily rejected"
            )
            .into());
        }
        let ws = inner
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No workspace is open"))?;
        Arc::clone(&ws.db)
        // inner guard はこのブロック終端で drop = f 実行前に ws_state ロック解放。
    };
    Ok(f(&db)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn workspace_state_with_db() -> WorkspaceState {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        WorkspaceState {
            inner: Mutex::new(Some(ActiveWorkspace {
                db: Arc::new(db),
                path: PathBuf::from("/tmp/test-ws"),
            })),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: Mutex::new(()),
        }
    }

    #[test]
    fn with_db_rejects_while_switching() {
        let state = workspace_state_with_db();
        state
            .switching
            .store(true, std::sync::atomic::Ordering::SeqCst);

        let mut ran = false;
        let err = with_db_state(&state, |_db| {
            ran = true;
            Ok(())
        })
        .expect_err("switching 中は明示エラーになるはず");
        assert!(
            err.to_string().contains("WORKSPACE_SWITCHING"),
            "エラー文言にフロント判別用の安定マーカーを含む: {err}"
        );
        assert!(!ran, "switching 中はクロージャを実行しない");

        // フラグ解除後は通常どおり実行される。
        state
            .switching
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let mut ran_after = false;
        with_db_state(&state, |_db| {
            ran_after = true;
            Ok(())
        })
        .expect("switching 解除後は成功する");
        assert!(ran_after);
    }

    #[test]
    fn with_db_releases_inner_lock_before_running_closure() {
        // ③ DB並行 Slice1 の不変条件: with_db_state は f を走らせる前に
        // ws_state.inner ロックを解放しなければならない (監査見出し「ws_state
        // Mutex を DB コール全体で保持」の解消)。同一スレッドからの try_lock
        // 成功で検証する — 旧実装 (ロック保持のまま f) では std::sync::Mutex は
        // 非再帰なので try_lock が WouldBlock で失敗し、このテストは red になる。
        let state = workspace_state_with_db();
        let lock_was_free = with_db_state(&state, |_db| Ok(state.inner.try_lock().is_ok()))
            .expect("workspace が開いていれば成功する");
        assert!(
            lock_was_free,
            "with_db_state は f を走らせる前に ws_state.inner ロックを解放すること"
        );
    }

    #[test]
    fn with_db_errors_when_no_workspace_open() {
        let state = WorkspaceState {
            inner: Mutex::new(None),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: Mutex::new(()),
        };
        let err = with_db_state(&state, |_db| Ok(())).expect_err("未オープンはエラー");
        assert!(err.to_string().contains("No workspace is open"));
    }
}
