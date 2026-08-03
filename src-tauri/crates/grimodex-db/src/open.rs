//! `open_workspace` の共通本体 (旧 `src-tauri/src/commands/workspace.rs` から
//! Electron 移行 Phase 2 S1 で抽出)。migrate → swap → RAII SwitchingGuard
//! の一連を Tauri コマンド層と napi 層の両方から呼べるようにする。
//! semantic キャッシュのクリア等シェル側にしか無い swap 直後の後処理は
//! `OpenDeps::on_swapped` フックで注入する (napi 側は no-op)。

use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use crate::state::{ActiveWorkspace, GlobalSettingsPath, WorkspaceState};
use crate::workspace;
use crate::{AppError, Database};

/// Fixed, non-sensitive stage names for the development-only native
/// workspace-open trace. Keeping this as an enum prevents paths, identifiers,
/// SQL, or exception text from becoming span names by accident.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeWorkspaceOpenSpanName {
    BlockingPoolWait,
    OpenLockWait,
    PathMeta,
    DatabaseOpen,
    Migrate,
    Optimize,
    FtsCheck,
    WorkspaceSwapLock,
    HookTotal,
    ImeLockWait,
    MatcherLockWait,
    SemanticRotate,
    SettingsLockWait,
    SettingsUpdate,
    MaintenanceSchedule,
    SerializeEvent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeWorkspaceOpenSpanStatus {
    Running,
    Finished,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeWorkspaceOpenResult {
    Ready,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceOpenSpan {
    name: NativeWorkspaceOpenSpanName,
    status: NativeWorkspaceOpenSpanStatus,
    start_offset_ms: f64,
    duration_ms: f64,
    #[serde(skip)]
    started_at: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWorkspaceOpenSummary<'a> {
    version: u8,
    result: NativeWorkspaceOpenResult,
    total_duration_ms: f64,
    spans: &'a [NativeWorkspaceOpenSpan],
}

/// Monotonic, allowlisted native timing collector. The N-API boundary decides
/// whether it is enabled; Tauri/MCP callers use a disabled instance through
/// the existing `open_workspace_sync` API.
pub struct NativeWorkspaceOpenTrace {
    started_at: Instant,
    enabled: bool,
    terminal_emitted: bool,
    spans: Vec<NativeWorkspaceOpenSpan>,
}

impl NativeWorkspaceOpenTrace {
    pub fn new(enabled: bool) -> Self {
        Self::with_start(Instant::now(), enabled)
    }

    pub fn with_start(started_at: Instant, enabled: bool) -> Self {
        Self {
            started_at,
            enabled,
            terminal_emitted: false,
            spans: Vec::new(),
        }
    }

    pub fn started_at(&self) -> Instant {
        self.started_at
    }

    pub fn begin_span(&mut self, name: NativeWorkspaceOpenSpanName) -> Option<usize> {
        if !self.enabled {
            return None;
        }
        let started_at = Instant::now();
        let index = self.spans.len();
        self.spans.push(NativeWorkspaceOpenSpan {
            name,
            status: NativeWorkspaceOpenSpanStatus::Running,
            start_offset_ms: rounded_ms(started_at.duration_since(self.started_at)),
            duration_ms: 0.0,
            started_at,
        });
        Some(index)
    }

    pub fn finish_span(&mut self, span: Option<usize>) {
        self.close_span(span, NativeWorkspaceOpenSpanStatus::Finished);
    }

    pub fn fail_span(&mut self, span: Option<usize>) {
        self.close_span(span, NativeWorkspaceOpenSpanStatus::Failed);
    }

    pub fn record_result<T, E>(
        &mut self,
        name: NativeWorkspaceOpenSpanName,
        operation: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let span = self.begin_span(name);
        let result = operation();
        if result.is_ok() {
            self.finish_span(span);
        } else {
            self.fail_span(span);
        }
        result
    }

    /// Serialize and mark the terminal once. The schema intentionally contains
    /// only a fixed result, fixed span names, and monotonic numeric timings.
    pub fn terminal_json(&mut self, result: NativeWorkspaceOpenResult) -> Option<String> {
        if !self.enabled || self.terminal_emitted {
            return None;
        }
        self.terminal_emitted = true;
        let summary = NativeWorkspaceOpenSummary {
            version: 1,
            result,
            total_duration_ms: rounded_ms(self.started_at.elapsed()),
            spans: &self.spans,
        };
        serde_json::to_string(&summary).ok()
    }

    pub fn emit_terminal(&mut self, result: NativeWorkspaceOpenResult) {
        if let Some(json) = self.terminal_json(result) {
            let stderr = std::io::stderr();
            write_workspace_open_trace(&mut stderr.lock(), &json);
        }
    }

    fn close_span(&mut self, span: Option<usize>, status: NativeWorkspaceOpenSpanStatus) {
        let Some(span) = span else {
            return;
        };
        let Some(entry) = self.spans.get_mut(span) else {
            return;
        };
        if entry.status != NativeWorkspaceOpenSpanStatus::Running {
            return;
        }
        entry.duration_ms = rounded_ms(entry.started_at.elapsed());
        entry.status = status;
    }
}

fn write_workspace_open_trace(writer: &mut dyn Write, json: &str) {
    // A diagnostic sink may disappear while Electron is shutting down. Trace
    // output must never turn a successful authority swap into a native error.
    let _ = writeln!(writer, "[workspace-open-native] {json}");
}

fn rounded_ms(duration: std::time::Duration) -> f64 {
    (duration.as_secs_f64() * 10_000.0).round() / 10.0
}

/// Read a legacy global-scoped setting from the workspace `app_settings` table.
///
/// Global settings moved to `global-settings.json`; this helper is retained as
/// a compatibility fallback for workspaces that have not gone through the
/// renderer-side settings migration yet.
fn read_app_setting(db: &Database, key: &str, default: &str) -> String {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [key],
                |r| r.get::<_, String>(0),
            )
            .ok())
    })
    .ok()
    .flatten()
    .unwrap_or_else(|| default.to_string())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AutoBackupConfig {
    enabled: bool,
    interval_min: u64,
    max_backups: usize,
}

impl Default for AutoBackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_min: 60,
            max_backups: 10,
        }
    }
}

/// Resolve the effective auto-backup settings.
///
/// The JSON global settings file is authoritative for current installations.
/// The workspace table is consulted only when a key is absent, which preserves
/// behavior for old workspaces while ensuring that a user's current global
/// preference always wins.
fn auto_backup_config(settings: &workspace::GlobalSettings, db: &Database) -> AutoBackupConfig {
    let value = |key: &str, default: &str| {
        settings
            .user_preferences
            .get(key)
            .cloned()
            .unwrap_or_else(|| read_app_setting(db, key, default))
    };

    AutoBackupConfig {
        enabled: value("data.autoBackup", "true") == "true",
        interval_min: value("data.backupInterval", "60").parse().unwrap_or(60),
        max_backups: value("data.maxBackups", "10")
            .parse::<usize>()
            .unwrap_or(10)
            .max(1),
    }
}

/// Prevent two rapid reopens of the same workspace from starting duplicate
/// maintenance workers before the first worker has materialized its backup.
static AUTO_BACKUP_IN_FLIGHT: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn auto_backup_in_flight() -> &'static Mutex<HashSet<PathBuf>> {
    AUTO_BACKUP_IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

fn auto_backup_claim(path: &Path) -> Option<AutoBackupClaim> {
    let lock = auto_backup_in_flight();
    let mut paths = match lock.lock() {
        Ok(paths) => paths,
        Err(poisoned) => poisoned.into_inner(),
    };
    if !paths.insert(path.to_path_buf()) {
        return None;
    }
    Some(AutoBackupClaim(path.to_path_buf()))
}

struct AutoBackupClaim(PathBuf);

impl Drop for AutoBackupClaim {
    fn drop(&mut self) {
        let lock = auto_backup_in_flight();
        let mut paths = match lock.lock() {
            Ok(paths) => paths,
            Err(poisoned) => poisoned.into_inner(),
        };
        paths.remove(&self.0);
    }
}

/// `<ws>/backups/` のバックアップファイル名か（無圧縮 `.db` と gzip `.db.gz` の両方）。
/// `.tmp` ステージングや無関係ファイルは除外。`newest_backup_age_secs` と
/// `rotate_backups` が**同じ判定**を使うことで新旧形式が 1 つの世代集合として扱われる
/// （片方が新形式を漏らすと間引き判定が壊れ毎回バックアップし、旧形式がローテ対象外で
/// 永遠に残る。backup restore Phase 2）。ファイル名の時刻プレフィクスは固定幅なので
/// 拡張子が混在しても名前ソート＝時系列は維持される。
fn is_backup_file(name: &str) -> bool {
    name.starts_with("grimodex-") && (name.ends_with(".db") || name.ends_with(".db.gz"))
}

/// Age (seconds) of the most recent backup in `dir`, if any.
fn newest_backup_age_secs(dir: &Path) -> Option<u64> {
    let mut newest: Option<std::time::SystemTime> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_backup_file(&name) {
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
            newest = Some(newest.map_or(modified, |cur| cur.max(modified)));
        }
    }
    std::time::SystemTime::now()
        .duration_since(newest?)
        .ok()
        .map(|d| d.as_secs())
}

/// Keep the newest `keep` backups (timestamped names sort chronologically),
/// deleting older ones.
fn rotate_backups(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(is_backup_file)
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.len() > keep {
        for old in &files[..files.len() - keep] {
            if let Err(e) = std::fs::remove_file(old) {
                tracing::warn!("auto-backup: cannot remove old backup {old:?}: {e}");
            }
        }
    }
}

/// Automatic backup wiring (DB health audit 2026-07): if enabled and the
/// newest backup is older than the configured interval, write a `VACUUM INTO`
/// snapshot to `<ws>/backups/` and rotate to `maxBackups`.
fn maybe_auto_backup(ws_path: &Path, db: &Database, config: AutoBackupConfig) {
    if !config.enabled {
        return;
    }
    let dir = ws_path.join("backups");

    if let Some(age) = newest_backup_age_secs(&dir) {
        if age < config.interval_min.saturating_mul(60) {
            return;
        }
    }
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("auto-backup: cannot create backups dir: {e}");
        return;
    }
    // `%3f` = ミリ秒。同一秒に複数バックアップ（連続復元の安全退避や、safety が
    // auto-backup と同秒）を書くと backup_to の rename が既存を上書きして世代を 1 つ失う
    // ため、サブ秒のエントロピを足して衝突を避ける（敵対レビュー minor）。
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S%3f");
    // gzip 圧縮バックアップ（Phase 2）。
    let dest = dir.join(format!("grimodex-{ts}.db.gz"));
    match db.quick_check() {
        Ok(Some(report)) => {
            tracing::error!("auto-backup: quick_check reported corruption ({report}); backing up anyway for recovery");
        }
        Err(e) => tracing::warn!("auto-backup: quick_check failed: {e}"),
        Ok(None) => {}
    }
    if let Err(e) = db.backup_to(&dest) {
        tracing::warn!("auto-backup: VACUUM INTO failed: {e}");
        return;
    }
    rotate_backups(&dir, config.max_backups);
}

/// Run backup and log pruning after the workspace authority has been swapped.
/// A separate SQLite connection keeps these writes from holding the active
/// renderer connection's mutex during open.
/// `with_background_connection_priority` also yields between maintenance
/// statements whenever a foreground DB call is waiting.
fn schedule_workspace_maintenance(ws_path: &Path, global_settings_path: &Path) {
    let Some(claim) = auto_backup_claim(ws_path) else {
        return;
    };
    let workspace_path = ws_path.to_path_buf();
    let db_path = workspace_path.join("grimodex.db");
    let global_settings_path = global_settings_path.to_path_buf();
    let result = std::thread::Builder::new()
        .name("grimodex-workspace-maintenance".to_string())
        .spawn(move || {
            let _claim = claim;
            let database = match Database::new(&db_path) {
                Ok(database) => database,
                Err(error) => {
                    tracing::warn!(
                        "workspace maintenance: cannot open background connection: {error}"
                    );
                    return;
                }
            };
            // Atomic tmp+rename writes make an unlocked read safe here: the
            // worker sees either the previous complete settings file or the
            // next complete file, never a torn JSON document.
            let settings = workspace::read_global_settings(&global_settings_path);
            let config = auto_backup_config(&settings, &database);
            database.with_background_connection_priority(|| {
                maybe_auto_backup(&workspace_path, &database, config);
                if let Err(error) = database.prune_old_logs(90) {
                    tracing::warn!("prune_old_logs in workspace maintenance failed: {error}");
                }
            });
        });
    if let Err(error) = result {
        tracing::warn!("workspace maintenance: cannot spawn worker: {error}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspaceResult {
    name: String,
    is_existing: bool,
    workspace_id: String,
}

/// `open_workspace` は renderer 供給のパスにディレクトリ + SQLite DB を作成する。
/// 通常フローでは path はフォルダピッカ / recent / seed 由来の信頼値だが、renderer が
/// 侵害された場合に任意のシステムロケーションへ空ディレクトリ + DB を scaffold される
/// のを防ぐ defense-in-depth (security audit PIO-1)。絶対パスを要求し `..` traversal と
/// システムディレクトリ配下を拒否する。フォルダピッカは外部ドライブ等も返すため
/// home 限定にはしない。
///
/// `external_mount_register` も同じ guard を再利用する (renderer 侵害時に
/// 任意のシステムロケーションを mount root にされ、配下を read される踏み台に
/// なるのを防ぐ。エラー文言は "workspace path" 固定だが security 挙動は同一)。
pub fn reject_unsafe_workspace_path(ws_path: &Path) -> Result<(), AppError> {
    if !ws_path.is_absolute() {
        return Err(
            anyhow::anyhow!("workspace path must be absolute: {}", ws_path.display()).into(),
        );
    }
    if ws_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(anyhow::anyhow!(
            "workspace path must not contain '..': {}",
            ws_path.display()
        )
        .into());
    }
    // workspace ディレクトリ自体はまだ存在しないことがあるため、既存の最近接祖先を
    // canonicalize してシステムディレクトリ配下かどうかを判定する。
    let mut probe: &Path = ws_path;
    let canonical = loop {
        if let Ok(c) = probe.canonicalize() {
            break Some(c);
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break None,
        }
    };
    if let Some(canonical) = canonical {
        if is_system_directory(&canonical) {
            return Err(anyhow::anyhow!(
                "refusing to create a workspace under a system directory: {}",
                canonical.display()
            )
            .into());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn is_system_directory(path: &Path) -> bool {
    if path == Path::new("/") {
        return true;
    }
    // ユーザデータが置かれない明白なシステムルートのみ。`/tmp` `/var/folders` 等の
    // 一時領域は除外 (誤検知でテスト/正規利用を壊さないため)。
    const DENY: &[&str] = &[
        "/bin",
        "/sbin",
        "/boot",
        "/dev",
        "/etc",
        "/lib",
        "/lib64",
        "/proc",
        "/sys",
        "/usr",
        "/System",
        "/private/etc",
    ];
    DENY.iter().any(|d| path.starts_with(d))
}

#[cfg(not(unix))]
fn is_system_directory(path: &Path) -> bool {
    // Windows: %SystemRoot% / Program Files 配下を拒否 (drive letter 非依存に env から解決)。
    const DENY_ENV: &[&str] = &["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"];
    DENY_ENV.iter().any(|var| {
        std::env::var_os(var)
            .map(PathBuf::from)
            .and_then(|p| p.canonicalize().ok())
            .map(|p| path.starts_with(&p))
            .unwrap_or(false)
    })
}

/// RAII: `WorkspaceState::switching` を全 exit (正常・エラー・panic 巻き戻し)
/// で確実に false へ戻す。open_workspace が途中で `?` で抜けてもフラグが
/// 立ちっぱなしにならない (立ちっぱなし = 全 DB コマンドが恒久拒否 = 文鎮化)。
/// `backup_restore::restore_backup_core` も同じガードを使う。
pub struct SwitchingGuard<'a>(pub &'a std::sync::atomic::AtomicBool);

impl Drop for SwitchingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// `open_workspace_sync` へ注入するシェル側依存。
pub struct OpenDeps<'a> {
    /// recent-workspaces 更新先の global-settings.json (write_lock 込み)。
    pub gs_path: &'a GlobalSettingsPath,
    /// swap 直後 (switching=true のまま) に 1 回呼ばれる後処理フック。
    /// Tauri 側は semantic 系 in-memory cache のクリアを注入し、napi 側は
    /// no-op を渡す。ここでの失敗はフック実装側で握ること (open 全体を
    /// 失敗させない — 下記 swap 後 infallible 不変条件)。
    pub on_swapped: &'a mut dyn FnMut(),
}

/// `open_workspace` コマンドの同期本体 (blocking 前提 — 呼び出し側が
/// spawn_blocking 等で退避する)。migrate → swap → RAII
/// SwitchingGuard → recent-workspaces 更新までを行い、重い maintenance は
/// authority commit 後の低優先度 worker に委ねる。
pub fn open_workspace_sync(
    ws_state: &WorkspaceState,
    deps: &mut OpenDeps<'_>,
    path: &str,
) -> Result<OpenWorkspaceResult, AppError> {
    let mut trace = NativeWorkspaceOpenTrace::new(false);
    let gs_path = deps.gs_path;
    let on_swapped = &mut *deps.on_swapped;
    let mut traced_hook = move |_: &mut NativeWorkspaceOpenTrace| on_swapped();
    open_workspace_sync_impl(ws_state, gs_path, path, &mut trace, &mut traced_hook)
}

/// Traced N-API entrypoint. Its data contract remains internal to the native
/// backend; the renderer-facing `open_workspace` result is unchanged.
pub fn open_workspace_sync_traced(
    ws_state: &WorkspaceState,
    gs_path: &GlobalSettingsPath,
    path: &str,
    trace: &mut NativeWorkspaceOpenTrace,
    on_swapped: &mut dyn FnMut(&mut NativeWorkspaceOpenTrace),
) -> Result<OpenWorkspaceResult, AppError> {
    open_workspace_sync_impl(ws_state, gs_path, path, trace, on_swapped)
}

fn open_workspace_sync_impl(
    ws_state: &WorkspaceState,
    gs_path: &GlobalSettingsPath,
    path: &str,
    trace: &mut NativeWorkspaceOpenTrace,
    on_swapped: &mut dyn FnMut(&mut NativeWorkspaceOpenTrace),
) -> Result<OpenWorkspaceResult, AppError> {
    // open 自体を直列化 (併走 migrate の check-then-act / 二重
    // VACUUM INTO 防止)。ロック順序は open_lock → inner → write_lock
    // の一方向のみ (with_db は inner のみ取るので循環しない)。
    let _open_guard = trace.record_result(NativeWorkspaceOpenSpanName::OpenLockWait, || {
        ws_state
            .open_lock
            .lock()
            .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))
    })?;

    let (ws_path, is_existing, workspace_meta) =
        trace.record_result(NativeWorkspaceOpenSpanName::PathMeta, || {
            let ws_path = PathBuf::from(path);
            reject_unsafe_workspace_path(&ws_path)?;
            std::fs::create_dir_all(&ws_path).map_err(anyhow::Error::from)?;
            let is_existing = workspace::is_existing_workspace(&ws_path);
            let uuid_str = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now().to_rfc3339();
            let workspace_meta = workspace::ensure_workspace_meta(&ws_path, &uuid_str, &now)?;
            Ok::<_, AppError>((ws_path, is_existing, workspace_meta))
        })?;

    // Open database
    let db_path = ws_path.join("grimodex.db");
    let database = trace.record_result(NativeWorkspaceOpenSpanName::DatabaseOpen, || {
        Database::new(&db_path).map_err(AppError::from)
    })?;
    let maintenance_workspace_path = ws_path.clone();
    let maintenance_settings_path = gs_path.path.clone();
    trace.record_result(NativeWorkspaceOpenSpanName::Migrate, || {
        database.migrate().map_err(AppError::from)
    })?;
    if let Err(error) = trace.record_result(NativeWorkspaceOpenSpanName::Optimize, || {
        database.optimize_without_wait()
    }) {
        tracing::warn!("non-blocking PRAGMA optimize on workspace open skipped: {error}");
    }
    // slim バックアップ復元後などで FTS 索引が空なら content から再構築（自己修復。
    // restore の happy path 以外＝再オープン失敗経由の reload や手動昇格でも検索が
    // 無音故障しないようにする。通常 DB では count だけで no-op）。
    if let Err(e) = trace.record_result(NativeWorkspaceOpenSpanName::FtsCheck, || {
        database.rebuild_fts_if_stale()
    }) {
        tracing::warn!("rebuild_fts_if_stale on workspace open failed: {e}");
    }

    // swap 直前で switching を立てる (Fix I3)。ここまでの migrate /
    // VACUUM / prune の数秒間は旧 DB への正当な読み書き (切替中も
    // 生きている旧 UI の検索・チャット・保存) を通したままにし、
    // swap 区間だけ with_db を明示エラーで拒否する。swap 前に
    // 走り出した with_db は inner ロックで直列化されるので安全性は
    // 同等。ガードの Drop 復帰 (正常・エラー・panic) は維持。
    // _open_guard より後に宣言 = 先に drop されるので、open_lock
    // 解放時には必ずフラグは戻っている。
    let swap_span = trace.begin_span(NativeWorkspaceOpenSpanName::WorkspaceSwapLock);
    ws_state
        .switching
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let _switching_guard = SwitchingGuard(&ws_state.switching);

    // Set as active workspace
    let mut inner = match ws_state.inner.lock() {
        Ok(inner) => inner,
        Err(error) => {
            trace.fail_span(swap_span);
            return Err(AppError::Anyhow(anyhow::anyhow!("{error}")));
        }
    };
    *inner = Some(ActiveWorkspace {
        db: std::sync::Arc::new(database),
        path: ws_path,
    });
    // Shell swap hooks may wait for other subsystem writers (IME snapshot
    // barrier, semantic epoch rotation). Do not retain the workspace mutex
    // across those waits; `switching=true` already rejects fresh DB pins.
    drop(inner);
    trace.finish_span(swap_span);

    // =================================================================
    // 不変条件: swap (上の *inner = Some(...)) 以降は絶対に Err を
    // 返さないこと (infallible)。フロント (workspace/store.ts) の
    // endWorkspaceSwitch({restoreBinding}) 判定は「invoke エラー ⟹
    // swap 未実行」に依存しており、swap 後に Err を返すと旧束縛が
    // 復元され、旧束縛のまま新 DB へ timelapse が記録される (C1 の
    // 最悪形)。以降の失敗は tracing::warn で握って続行する
    // (workspace 自体は開けているので open 全体を失敗させない方が
    // 正しい)。残余: spawn_blocking の JoinError (swap 後の panic)
    // だけはこの契約の外だが、unwrap() 禁止のコードベースで panic は
    // 既に異常系。
    // =================================================================

    // swap 直後のシェル固有後処理 (Tauri: semantic 系 in-memory cache の
    // クリア。前 workspace の scene_id を握っているので切替時に必ず捨てる)。
    // フック内の失敗はフック側で握る契約 (上の不変条件)。
    let hook_span = trace.begin_span(NativeWorkspaceOpenSpanName::HookTotal);
    on_swapped(trace);
    trace.finish_span(hook_span);

    // Update global settings (write_lock で read-modify-write を
    // 原子化。save_global_settings / seed_sample_workspace と並行
    // しても lost update しない)。失敗 (ENOSPC / EACCES / AV による
    // rename ロック / 毒化) は recent-workspaces が更新されないだけ
    // なので warn で続行 (上の不変条件)。
    let settings_lock_span = trace.begin_span(NativeWorkspaceOpenSpanName::SettingsLockWait);
    match gs_path.write_lock.lock() {
        Ok(_gs_guard) => {
            trace.finish_span(settings_lock_span);
            let settings_update_span =
                trace.begin_span(NativeWorkspaceOpenSpanName::SettingsUpdate);
            let mut settings = workspace::read_global_settings(&gs_path.path);
            let now = chrono::Utc::now().to_rfc3339();
            workspace::touch_recent_workspace(&mut settings, path, &now);
            if let Err(e) = workspace::write_global_settings(&gs_path.path, &settings) {
                trace.fail_span(settings_update_span);
                tracing::warn!("global settings update on workspace open failed: {e}");
            } else {
                trace.finish_span(settings_update_span);
            }
        }
        Err(e) => {
            trace.fail_span(settings_lock_span);
            tracing::warn!("global settings lock on workspace open failed: {e}");
        }
    }

    // Backup and log pruning are deliberately after the authority swap and
    // recent-workspace commit. They must not delay the renderer's open invoke.
    let maintenance_span = trace.begin_span(NativeWorkspaceOpenSpanName::MaintenanceSchedule);
    schedule_workspace_maintenance(&maintenance_workspace_path, &maintenance_settings_path);
    trace.finish_span(maintenance_span);

    let name = workspace::workspace_name(path);
    Ok(OpenWorkspaceResult {
        name,
        is_existing,
        workspace_id: workspace_meta.id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::with_db_state;
    use std::io;
    use std::sync::Mutex;

    #[test]
    fn rejects_relative_workspace_path() {
        let err = reject_unsafe_workspace_path(Path::new("relative/dir")).unwrap_err();
        assert!(err.to_string().contains("absolute"));
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        #[cfg(unix)]
        let p = Path::new("/home/user/../../etc/evil");
        #[cfg(not(unix))]
        let p = Path::new("C:/Users/user/../../Windows/evil");
        let err = reject_unsafe_workspace_path(p).unwrap_err();
        assert!(err.to_string().contains(".."));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_system_directory() {
        // /etc は存在するシステムディレクトリ。配下への workspace 作成を拒否する。
        let err = reject_unsafe_workspace_path(Path::new("/etc/grimodex-evil")).unwrap_err();
        assert!(err.to_string().contains("system directory"));
    }

    #[cfg(unix)]
    #[test]
    fn allows_path_under_temp() {
        // 一時領域 (テスト/正規利用) は誤検知で弾かない。存在しない leaf でも祖先で判定。
        let base = std::env::temp_dir().join(format!("grimodex-ws-{}", uuid::Uuid::new_v4()));
        assert!(reject_unsafe_workspace_path(&base).is_ok());
    }

    #[test]
    fn native_trace_uses_monotonic_allowlisted_spans_and_one_terminal() {
        let mut trace = NativeWorkspaceOpenTrace::new(true);
        let names = [
            NativeWorkspaceOpenSpanName::BlockingPoolWait,
            NativeWorkspaceOpenSpanName::OpenLockWait,
            NativeWorkspaceOpenSpanName::PathMeta,
            NativeWorkspaceOpenSpanName::DatabaseOpen,
            NativeWorkspaceOpenSpanName::Migrate,
            NativeWorkspaceOpenSpanName::Optimize,
            NativeWorkspaceOpenSpanName::FtsCheck,
            NativeWorkspaceOpenSpanName::WorkspaceSwapLock,
            NativeWorkspaceOpenSpanName::HookTotal,
            NativeWorkspaceOpenSpanName::ImeLockWait,
            NativeWorkspaceOpenSpanName::MatcherLockWait,
            NativeWorkspaceOpenSpanName::SemanticRotate,
            NativeWorkspaceOpenSpanName::SettingsLockWait,
            NativeWorkspaceOpenSpanName::SettingsUpdate,
            NativeWorkspaceOpenSpanName::MaintenanceSchedule,
            NativeWorkspaceOpenSpanName::SerializeEvent,
        ];
        for name in names {
            let span = trace.begin_span(name);
            trace.finish_span(span);
        }

        let json = trace
            .terminal_json(NativeWorkspaceOpenResult::Ready)
            .expect("first terminal");
        assert!(
            trace
                .terminal_json(NativeWorkspaceOpenResult::Failed)
                .is_none(),
            "terminal summary must be emitted at most once"
        );
        let summary: serde_json::Value = serde_json::from_str(&json).expect("trace json");
        let spans = summary["spans"].as_array().expect("spans");
        assert_eq!(spans.len(), names.len());
        let mut previous_offset = 0.0;
        for span in spans {
            let offset = span["startOffsetMs"].as_f64().expect("offset");
            let duration = span["durationMs"].as_f64().expect("duration");
            assert!(offset >= previous_offset, "offsets must be monotonic");
            assert!(duration >= 0.0, "duration must not be negative");
            assert_eq!(span["status"], "finished");
            previous_offset = offset;
        }
    }

    #[test]
    fn native_trace_ignores_terminal_writer_failures() {
        struct FailingWriter;

        impl io::Write for FailingWriter {
            fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed stderr"))
            }

            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed stderr"))
            }
        }

        write_workspace_open_trace(&mut FailingWriter, "{\"result\":\"ready\"}");
    }

    #[test]
    fn native_trace_failure_closes_the_active_stage_without_sensitive_fields() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-native-open-trace-failure-{}",
            uuid::Uuid::new_v4()
        ));
        let ws_state = WorkspaceState {
            inner: Mutex::new(None),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: Mutex::new(()),
        };
        let gs_path = GlobalSettingsPath {
            path: dir.join("global-settings.json"),
            write_lock: Mutex::new(()),
        };
        let mut trace = NativeWorkspaceOpenTrace::new(true);
        let mut on_swapped = |_: &mut NativeWorkspaceOpenTrace| {};
        let result = open_workspace_sync_traced(
            &ws_state,
            &gs_path,
            "relative/private-workspace-name",
            &mut trace,
            &mut on_swapped,
        );
        let error = match result {
            Ok(_) => panic!("relative path must fail"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("absolute"));

        let json = trace
            .terminal_json(NativeWorkspaceOpenResult::Failed)
            .expect("failure terminal");
        let summary: serde_json::Value = serde_json::from_str(&json).expect("trace json");
        assert_eq!(summary["result"], "failed");
        let spans = summary["spans"].as_array().expect("spans");
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0]["name"], "open-lock-wait");
        assert_eq!(spans[0]["status"], "finished");
        assert_eq!(spans[1]["name"], "path-meta");
        assert_eq!(spans[1]["status"], "failed");

        let top_level_keys: std::collections::BTreeSet<_> = summary
            .as_object()
            .expect("summary object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            top_level_keys,
            std::collections::BTreeSet::from(["result", "spans", "totalDurationMs", "version",])
        );
        for span in spans {
            let keys: std::collections::BTreeSet<_> = span
                .as_object()
                .expect("span object")
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(
                keys,
                std::collections::BTreeSet::from(
                    ["durationMs", "name", "startOffsetMs", "status",]
                )
            );
        }
        for forbidden in [
            "workspaceId",
            "projectId",
            "documentId",
            "sql",
            "error",
            "relative/private-workspace-name",
        ] {
            assert!(!json.contains(forbidden), "trace leaked {forbidden}");
        }
    }

    #[test]
    fn test_is_backup_file_accepts_db_and_gz_only() {
        assert!(is_backup_file("grimodex-20260101-000000.db"));
        assert!(is_backup_file("grimodex-20260101-000000.db.gz"));
        assert!(!is_backup_file("grimodex-20260101-000000.db.tmp"));
        assert!(!is_backup_file("grimodex-20260101-000000.db.gz.tmp"));
        // materialize 用 restore-tmp は "grimodex." 始まり (ハイフン無し) で除外。
        assert!(!is_backup_file("grimodex.db.restore-tmp"));
        assert!(!is_backup_file("other.db"));
    }

    #[test]
    fn auto_backup_config_prefers_global_preferences_over_legacy_workspace_values() {
        let db = Database::new(Path::new(":memory:")).expect("open settings fixture");
        db.with_conn(|conn| {
            conn.execute(
                "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                [],
            )?;
            conn.execute_batch(
                "INSERT INTO app_settings (key, value) VALUES
                    ('data.autoBackup', 'true'),
                    ('data.backupInterval', '1'),
                    ('data.maxBackups', '2')",
            )?;
            Ok(())
        })
        .expect("seed legacy settings");

        let mut settings = workspace::GlobalSettings::default();
        settings
            .user_preferences
            .insert("data.autoBackup".to_string(), "false".to_string());
        settings
            .user_preferences
            .insert("data.backupInterval".to_string(), "240".to_string());
        settings
            .user_preferences
            .insert("data.maxBackups".to_string(), "7".to_string());

        assert_eq!(
            auto_backup_config(&settings, &db),
            AutoBackupConfig {
                enabled: false,
                interval_min: 240,
                max_backups: 7,
            }
        );
    }

    #[test]
    fn auto_backup_config_falls_back_to_legacy_values_for_old_workspaces() {
        let db = Database::new(Path::new(":memory:")).expect("open settings fixture");
        db.with_conn(|conn| {
            conn.execute(
                "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                [],
            )?;
            conn.execute_batch(
                "INSERT INTO app_settings (key, value) VALUES
                    ('data.autoBackup', 'false'),
                    ('data.backupInterval', '15'),
                    ('data.maxBackups', '4')",
            )?;
            Ok(())
        })
        .expect("seed legacy settings");

        assert_eq!(
            auto_backup_config(&workspace::GlobalSettings::default(), &db),
            AutoBackupConfig {
                enabled: false,
                interval_min: 15,
                max_backups: 4,
            }
        );
    }

    #[test]
    fn test_open_workspace_sync_creates_and_reopens_workspace() {
        // S1 抽出の gate: 抽出後の open_workspace_sync が (1) 新規 workspace を
        // scaffold + migrate して active にし、(2) on_swapped フックを swap 後に
        // ちょうど 1 回呼び、(3) recent-workspaces を更新し、(4) 再オープンで
        // is_existing=true を返し、(5) SwitchingGuard が switching を戻すこと。
        let dir = std::env::temp_dir().join(format!("grimodex_open_sync_{}", uuid::Uuid::new_v4()));
        let ws_dir = dir.join("ws");
        let gs_file = dir.join("global-settings.json");
        std::fs::create_dir_all(&dir).expect("mkdir");

        let ws_state = WorkspaceState {
            inner: Mutex::new(None),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: Mutex::new(()),
        };
        let gs_path = GlobalSettingsPath {
            path: gs_file.clone(),
            write_lock: Mutex::new(()),
        };

        let mut swapped = 0u32;
        let mut on_swapped = || swapped += 1;
        let mut deps = OpenDeps {
            gs_path: &gs_path,
            on_swapped: &mut on_swapped,
        };
        let ws_dir_str = ws_dir.to_string_lossy().into_owned();
        let first = open_workspace_sync(&ws_state, &mut deps, &ws_dir_str).expect("first open");
        assert_eq!(
            serde_json::to_value(&first).expect("json")["isExisting"],
            false
        );
        let first_workspace_id = serde_json::to_value(&first).expect("json")["workspaceId"]
            .as_str()
            .expect("workspace id")
            .to_string();
        assert!(!first_workspace_id.is_empty());
        assert_eq!(swapped, 1, "on_swapped は swap 後にちょうど 1 回呼ばれる");
        assert!(
            !ws_state.switching.load(std::sync::atomic::Ordering::SeqCst),
            "SwitchingGuard が switching を false に戻すこと"
        );

        // migrate 済みの active DB に対して with_db_state で読み書きできる。
        with_db_state(&ws_state, |db| {
            let rows = db.execute("SELECT count(*) AS n FROM projects", &[], "get")?;
            assert!(rows[0]["n"].as_i64().is_some());
            Ok(())
        })
        .expect("query after open");

        // recent-workspaces が更新されている。
        let settings = workspace::read_global_settings(&gs_file);
        assert_eq!(settings.recent_workspaces.len(), 1);
        assert_eq!(settings.last_active_workspace, Some(ws_dir_str.clone()));

        // 再オープンは is_existing=true (grimodex.db が既に存在する)。
        let mut on_swapped2 = || {};
        let mut deps2 = OpenDeps {
            gs_path: &gs_path,
            on_swapped: &mut on_swapped2,
        };
        let second = open_workspace_sync(&ws_state, &mut deps2, &ws_dir_str).expect("reopen");
        assert_eq!(
            serde_json::to_value(&second).expect("json")["isExisting"],
            true
        );
        assert_eq!(
            serde_json::to_value(&second).expect("json")["workspaceId"],
            first_workspace_id
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
