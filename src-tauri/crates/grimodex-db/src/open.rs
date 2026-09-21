//! `open_workspace` の共通本体 (旧 `src-tauri/src/commands/workspace.rs` から
//! Electron 移行 Phase 2 S1 で抽出)。migrate → swap → RAII SwitchingGuard
//! の一連を Tauri コマンド層と napi 層の両方から呼べるようにする。
//! semantic キャッシュのクリア等シェル側にしか無い swap 直後の後処理は
//! `OpenDeps::on_swapped` フックで注入する (napi 側は no-op)。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::recovery::{OpenWorkspacePayload, WorkspaceOpenOutcome};
use crate::state::{ActiveWorkspace, GlobalSettingsPath, WorkspaceAuthority, WorkspaceState};
use crate::workspace;
use crate::{AppError, Database, WorkspaceLifecycleCompatibilityView};

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
    WalPrepare,
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

#[derive(Default)]
struct WorkspaceMaintenanceRegistry {
    active: HashSet<PathBuf>,
    exclusive_waiters: HashMap<PathBuf, usize>,
}

/// Path-scoped lifecycle barrier for detached maintenance connections.
///
/// Open uses a non-blocking claim so backup work never delays authority
/// publication. Restore registers as an exclusive waiter and holds the same
/// claim across sidecar removal, replacement, and reopen. This makes a worker's
/// independent SQLite handle visible to restore without putting the slow
/// worker behind `WorkspaceState::open_lock`.
static WORKSPACE_MAINTENANCE: OnceLock<(Mutex<WorkspaceMaintenanceRegistry>, Condvar)> =
    OnceLock::new();

fn workspace_maintenance_registry() -> &'static (Mutex<WorkspaceMaintenanceRegistry>, Condvar) {
    WORKSPACE_MAINTENANCE.get_or_init(|| {
        (
            Mutex::new(WorkspaceMaintenanceRegistry::default()),
            Condvar::new(),
        )
    })
}

fn workspace_maintenance_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

pub(crate) fn try_claim_workspace_maintenance(path: &Path) -> Option<WorkspaceMaintenanceClaim> {
    let key = workspace_maintenance_key(path);
    let (lock, _) = workspace_maintenance_registry();
    let mut registry = match lock.lock() {
        Ok(registry) => registry,
        Err(poisoned) => poisoned.into_inner(),
    };
    if registry.active.contains(&key)
        || registry
            .exclusive_waiters
            .get(&key)
            .copied()
            .unwrap_or_default()
            > 0
    {
        return None;
    }
    registry.active.insert(key.clone());
    Some(WorkspaceMaintenanceClaim(key))
}

pub(crate) fn claim_workspace_maintenance_exclusive(
    path: &Path,
) -> Result<WorkspaceMaintenanceClaim, AppError> {
    // A detached worker may be inside VACUUM INTO while the host is under
    // heavy CPU or disk pressure.  Ten seconds made a same-path reopen fail
    // spuriously even though the worker was healthy and would release its
    // claim shortly afterwards; keep the fail-closed path, but give normal
    // maintenance enough time to finish.
    claim_workspace_maintenance_exclusive_with_timeout(path, Duration::from_secs(30))
}

fn claim_workspace_maintenance_exclusive_with_timeout(
    path: &Path,
    timeout: Duration,
) -> Result<WorkspaceMaintenanceClaim, AppError> {
    let key = workspace_maintenance_key(path);
    let (lock, idle) = workspace_maintenance_registry();
    let mut registry = match lock.lock() {
        Ok(registry) => registry,
        Err(poisoned) => poisoned.into_inner(),
    };
    *registry.exclusive_waiters.entry(key.clone()).or_default() += 1;

    let started = Instant::now();
    while registry.active.contains(&key) {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            remove_workspace_maintenance_waiter(&mut registry, &key);
            return Err(anyhow::anyhow!(
                "ワークスペース保守処理が完了せず復元を中止しました。少し待って再試行してください。"
            )
            .into());
        }
        let (next_registry, wait_result) = match idle.wait_timeout(registry, remaining) {
            Ok(waited) => waited,
            Err(poisoned) => poisoned.into_inner(),
        };
        registry = next_registry;
        if wait_result.timed_out() && registry.active.contains(&key) {
            remove_workspace_maintenance_waiter(&mut registry, &key);
            return Err(anyhow::anyhow!(
                "ワークスペース保守処理が完了せず復元を中止しました。少し待って再試行してください。"
            )
            .into());
        }
    }

    remove_workspace_maintenance_waiter(&mut registry, &key);
    registry.active.insert(key.clone());
    Ok(WorkspaceMaintenanceClaim(key))
}

fn remove_workspace_maintenance_waiter(registry: &mut WorkspaceMaintenanceRegistry, key: &Path) {
    let remove_waiter = if let Some(waiters) = registry.exclusive_waiters.get_mut(key) {
        *waiters = waiters.saturating_sub(1);
        *waiters == 0
    } else {
        false
    };
    if remove_waiter {
        registry.exclusive_waiters.remove(key);
    }
}

pub(crate) struct WorkspaceMaintenanceClaim(PathBuf);

impl Drop for WorkspaceMaintenanceClaim {
    fn drop(&mut self) {
        let (lock, idle) = workspace_maintenance_registry();
        let mut registry = match lock.lock() {
            Ok(registry) => registry,
            Err(poisoned) => poisoned.into_inner(),
        };
        registry.active.remove(&self.0);
        drop(registry);
        idle.notify_all();
    }
}

#[cfg(test)]
pub(crate) fn workspace_maintenance_exclusive_waiters(path: &Path) -> usize {
    let key = workspace_maintenance_key(path);
    let (lock, _) = workspace_maintenance_registry();
    let registry = match lock.lock() {
        Ok(registry) => registry,
        Err(poisoned) => poisoned.into_inner(),
    };
    registry
        .exclusive_waiters
        .get(&key)
        .copied()
        .unwrap_or_default()
}

/// `<ws>/backups/` のバックアップファイル名か（無圧縮 `.db` と gzip `.db.gz` の両方）。
/// `.tmp` ステージングや無関係ファイルは除外。restore/list parser の受理確認に使う。
#[cfg(test)]
fn is_backup_file(name: &str) -> bool {
    crate::backup_restore::parse_backup_file_name(name).is_some()
}

/// Auto-backup maintenance candidate. Content-addressed restore aliases are
/// durable restore artifacts and must not participate in age or rotation.
fn is_auto_backup_file(name: &str) -> bool {
    crate::backup_restore::parse_backup_file_name(name)
        .is_some_and(|(_, expected_digest)| expected_digest.is_none())
}

/// Age (seconds) of the most recent backup in `dir`, if any.
fn newest_backup_age_secs(dir: &Path) -> Option<u64> {
    let mut newest: Option<std::time::SystemTime> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_auto_backup_file(&name) {
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
                .map(is_auto_backup_file)
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
/// Backup keeps a detached, zero-wait SQLite connection so its long copy never
/// holds the renderer mutex. Pruning on that same connection is zero-wait and
/// bounded to direct primary-key deletes, so it cannot inherit the normal
/// five-second foreground busy timeout or retain a stale active DB after a
/// same-path reopen.
fn schedule_workspace_maintenance(ws_path: &Path, global_settings_path: &Path) {
    if let Err(error) = spawn_workspace_maintenance_worker(ws_path, global_settings_path, || {}) {
        tracing::warn!("workspace maintenance: cannot spawn worker: {error}");
    }
}

pub(crate) fn spawn_workspace_maintenance_worker(
    ws_path: &Path,
    global_settings_path: &Path,
    on_started: impl FnOnce() + Send + 'static,
) -> std::io::Result<Option<std::thread::JoinHandle<()>>> {
    let Some(claim) = try_claim_workspace_maintenance(ws_path) else {
        return Ok(None);
    };
    let workspace_path = ws_path.to_path_buf();
    let db_path = workspace_path.join("grimodex.db");
    let global_settings_path = global_settings_path.to_path_buf();
    std::thread::Builder::new()
        .name("grimodex-workspace-maintenance".to_string())
        .spawn(move || {
            let _claim = claim;
            // Cross-process file lease: migration/restore cannot replace the live
            // DB while this detached connection is open.
            let _lease = match crate::workspace_lease::try_acquire_shared(&workspace_path) {
                Ok(lease) => lease,
                Err(error) => {
                    tracing::warn!(
                        "workspace maintenance: shared lease unavailable ({}); skipping",
                        error.code()
                    );
                    return;
                }
            };
            let settings = workspace::read_global_settings(&global_settings_path);
            match Database::new_for_workspace_maintenance(&db_path) {
                Ok(maintenance_database) => {
                    let config = auto_backup_config(&settings, &maintenance_database);
                    on_started();

                    if let Err(error) =
                        maintenance_database.prune_old_logs_for_workspace_maintenance(90)
                    {
                        tracing::warn!("prune_old_logs in workspace maintenance failed: {error}");
                    }
                    // Gate C2 Run Kind Policy `dependency-backfill` is
                    // deliberately NOT triggered here. Do not re-add this
                    // call without first fixing the hazard below.
                    //
                    // The backfill commits three times per project
                    // (`legacy_backfill.rs`: Run creation / transform /
                    // finalize), and `migrate` seeds `default-project`, so
                    // it wrote on every workspace open -- including brand
                    // new ones. Most foreground domain writes open a
                    // *deferred* transaction (`unchecked_transaction()` in
                    // `domain_writes.rs`), which takes a read snapshot and
                    // only upgrades to a write on its first INSERT. Any
                    // commit from another connection in that window fails
                    // the upgrade with SQLITE_BUSY_SNAPSHOT, which
                    // `busy_timeout` cannot retry -- the same hazard
                    // `execute.rs`'s `BEGIN IMMEDIATE` comment documents
                    // for the MCP process. The result was immediate
                    // (single-digit ms) "database is locked" failures in
                    // foreground writes running just after open.
                    //
                    // Re-wiring this needs one of: running the backfill on
                    // the live authority's own connection (no second
                    // writer), or making `domain_writes.rs`'s deferred
                    // transactions IMMEDIATE. Bounded batching alone would
                    // make it worse, not better -- it raises the commit
                    // count. Until then the Backfill stays reachable via
                    // its Admin IPC (`retryNarrativeLegacyBackfill`).
                    maybe_auto_backup(&workspace_path, &maintenance_database, config);
                }
                Err(error) => tracing::warn!(
                    "workspace maintenance: cannot open background connection: {error}"
                ),
            }
        })
        .map(Some)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspaceResult {
    name: String,
    is_existing: bool,
    workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    migration: Option<crate::migration_supervisor::OpenMigrationInfo>,
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
pub struct SwitchingGuard<'a>(pub &'a WorkspaceLifecycleCompatibilityView);

/// Same-path reopen quiesce: wait for sole authority owner, drop the old
/// authority (releasing its shared lease), and hold the maintenance exclusive
/// claim through the explicit replacement operation.  A failed operation is
/// left for the lifecycle supervisor to classify as RecoveryRequired; Drop
/// never starts a new reopen or publishes an authority behind that supervisor.
struct QuiescedSamePath {
    did_quiesce: bool,
    /// When true, Drop must not republish (Safe Mode / RecoveryRequired /
    /// successful replacement).
    abandon_restore: bool,
    _maintenance: Option<WorkspaceMaintenanceClaim>,
}

impl QuiescedSamePath {
    fn begin(ws_state: &WorkspaceState, ws_path: &Path) -> Result<Self, AppError> {
        let mut guard = Self {
            did_quiesce: false,
            abandon_restore: false,
            _maintenance: None,
        };
        let old = {
            let mut inner = ws_state
                .inner
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            match inner.as_ref() {
                Some(active) if paths_equal_for_workspace(active.path(), ws_path) => inner.take(),
                _ => None,
            }
        };
        let Some(old) = old else {
            return Ok(guard);
        };
        if let Err(error) = crate::backup_restore::wait_for_sole_owner(&old.authority) {
            let mut inner = ws_state
                .inner
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            *inner = Some(old);
            return Err(error);
        }
        let maintenance = match claim_workspace_maintenance_exclusive(ws_path) {
            Ok(claim) => claim,
            Err(error) => {
                let mut inner = ws_state
                    .inner
                    .lock()
                    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
                *inner = Some(old);
                return Err(error);
            }
        };
        drop(old);
        guard._maintenance = Some(maintenance);
        guard.did_quiesce = true;
        Ok(guard)
    }

    fn commit_success(&mut self) {
        self.abandon_restore = true;
        // Release before schedule_workspace_maintenance so a new worker can claim.
        self._maintenance = None;
    }

    fn commit_safe_mode(&mut self) {
        self.abandon_restore = true;
        self._maintenance = None;
    }
}

impl Drop for QuiescedSamePath {
    fn drop(&mut self) {
        if !self.did_quiesce || self.abandon_restore {
            return;
        }
        // Release only the in-process claim.  Starting a new DB open from Drop
        // would bypass the lifecycle Join/activation boundary and could revive
        // an authority while the replacement worker is still unobserved.
        self._maintenance = None;
        tracing::warn!(
            "workspace replacement failed after quiesce; lifecycle supervisor must own recovery"
        );
    }
}

fn paths_equal_for_workspace(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

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
) -> Result<WorkspaceOpenOutcome, AppError> {
    let mut trace = NativeWorkspaceOpenTrace::new(false);
    let gs_path = deps.gs_path;
    let on_swapped = &mut *deps.on_swapped;
    let mut traced_hook = move |_: &mut NativeWorkspaceOpenTrace| on_swapped();
    let mut prepare_wal = crate::open_wal::prepare_wal_for_open;
    open_workspace_sync_impl(
        ws_state,
        gs_path,
        path,
        &mut trace,
        &mut traced_hook,
        &mut prepare_wal,
        None,
    )
}

/// Traced N-API entrypoint. Its data contract remains internal to the native
/// backend; the renderer-facing `open_workspace` result is a
/// [`WorkspaceOpenOutcome`] discriminated union (Gate A2).
pub fn open_workspace_sync_traced(
    ws_state: &WorkspaceState,
    gs_path: &GlobalSettingsPath,
    path: &str,
    trace: &mut NativeWorkspaceOpenTrace,
    on_swapped: &mut dyn FnMut(&mut NativeWorkspaceOpenTrace),
) -> Result<WorkspaceOpenOutcome, AppError> {
    open_workspace_sync_traced_with_pre_swap(ws_state, gs_path, path, trace, on_swapped, None)
}

/// Traced open with a hook run while `open_lock` is still held before the
/// opener can remove or publish an authority. Native main uses this narrow
/// admission point to close the maintenance-attempt/workspace-swap race.
///
/// The hook must run before [`QuiescedSamePath::begin`]. Restore-only
/// outcomes return before the normal authority-publish point below and may
/// remove the old authority while entering Safe Mode or RecoveryRequired. A
/// caller that needs to close another process-local admission gate therefore
/// cannot wait until the normal publish path.
pub fn open_workspace_sync_traced_with_pre_swap(
    ws_state: &WorkspaceState,
    gs_path: &GlobalSettingsPath,
    path: &str,
    trace: &mut NativeWorkspaceOpenTrace,
    on_swapped: &mut dyn FnMut(&mut NativeWorkspaceOpenTrace),
    before_swap: Option<&mut dyn FnMut() -> Result<(), AppError>>,
) -> Result<WorkspaceOpenOutcome, AppError> {
    let mut prepare_wal = crate::open_wal::prepare_wal_for_open;
    open_workspace_sync_impl(
        ws_state,
        gs_path,
        path,
        trace,
        on_swapped,
        &mut prepare_wal,
        before_swap,
    )
}

fn open_workspace_sync_impl(
    ws_state: &WorkspaceState,
    gs_path: &GlobalSettingsPath,
    path: &str,
    trace: &mut NativeWorkspaceOpenTrace,
    on_swapped: &mut dyn FnMut(&mut NativeWorkspaceOpenTrace),
    prepare_wal: &mut dyn FnMut(
        &Database,
    ) -> anyhow::Result<crate::open_wal::OpenWalPreparationOutcome>,
    mut before_swap: Option<&mut dyn FnMut() -> Result<(), AppError>>,
) -> Result<WorkspaceOpenOutcome, AppError> {
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

    // Same-path reopen: raise switching first (WORKSPACE_SWITCHING, not
    // NoWorkspace), quiesce authority + maintenance, then run supervisor.
    ws_state
        .switching
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let _switching_guard = SwitchingGuard(&ws_state.switching);

    if let Some(before_swap) = before_swap.as_mut() {
        before_swap()?;
    }

    let mut quiesced = trace.record_result(NativeWorkspaceOpenSpanName::Migrate, || {
        QuiescedSamePath::begin(ws_state, &ws_path)
    })?;

    let maintenance_workspace_path = ws_path.clone();
    let maintenance_settings_path = gs_path.path.clone();
    let db_outcome = trace.record_result(NativeWorkspaceOpenSpanName::Migrate, || {
        crate::migration_supervisor::open_or_migrate_workspace_db(&ws_path).map_err(AppError::from)
    })?;

    // Gate A2: Safe Mode / RecoveryRequired are structured Ok outcomes.
    // Never publish WorkspaceAuthority; enter restore-only SafeModeSession.
    if let Some(session) = crate::recovery::session_from_db_outcome(&ws_path, &db_outcome)? {
        quiesced.commit_safe_mode();
        // Drop any leftover authority for this path and clear prior session.
        {
            let mut inner = ws_state
                .inner
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            *inner = None;
        }
        let outcome = match &db_outcome {
            crate::migration_supervisor::WorkspaceOpenDbOutcome::RecoveryRequired {
                reason,
                error_code,
                ..
            } => WorkspaceOpenOutcome::RecoveryRequired {
                reason: reason.clone(),
                error_code: error_code.clone(),
                snapshot_id: session.snapshot_id.clone(),
                candidates: session.candidates(),
            },
            crate::migration_supervisor::WorkspaceOpenDbOutcome::SafeMode { reason, .. } => {
                WorkspaceOpenOutcome::SafeMode {
                    reason: reason.clone(),
                    candidates: session.candidates(),
                }
            }
            crate::migration_supervisor::WorkspaceOpenDbOutcome::Ready { .. }
            | crate::migration_supervisor::WorkspaceOpenDbOutcome::Migrated { .. } => {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "internal: Safe Mode session built for authority-publishing outcome"
                )));
            }
        };
        ws_state.safe_mode.enter(session)?;
        return Ok(outcome);
    }

    // Clear any prior Safe Mode when a normal open succeeds.
    ws_state.safe_mode.clear()?;

    let (opened, migration_info) = match db_outcome {
        crate::migration_supervisor::WorkspaceOpenDbOutcome::Ready { opened, .. } => (opened, None),
        crate::migration_supervisor::WorkspaceOpenDbOutcome::Migrated {
            opened,
            from_schema,
            to_schema,
            receipt_path,
        } => (
            opened,
            Some(crate::migration_supervisor::OpenMigrationInfo {
                from_schema,
                to_schema,
                receipt_path: receipt_path.display().to_string(),
                recovered: false,
                error_code: None,
            }),
        ),
        crate::migration_supervisor::WorkspaceOpenDbOutcome::RecoveryRequired { .. }
        | crate::migration_supervisor::WorkspaceOpenDbOutcome::SafeMode { .. } => {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "internal: restore-only outcome missing Safe Mode session"
            )));
        }
    };
    if let Some(info) = migration_info.as_ref() {
        tracing::info!(
            "workspace migrated schema {} -> {} (receipt={})",
            info.from_schema,
            info.to_schema,
            info.receipt_path
        );
    }
    let database = opened.database;
    if let Err(error) = trace.record_result(NativeWorkspaceOpenSpanName::Optimize, || {
        database.optimize_without_wait()
    }) {
        tracing::warn!("non-blocking PRAGMA optimize on workspace open skipped: {error}");
    }
    if let Err(e) = trace.record_result(NativeWorkspaceOpenSpanName::FtsCheck, || {
        database.rebuild_fts_if_stale()
    }) {
        tracing::warn!("rebuild_fts_if_stale on workspace open failed: {e}");
    }
    let wal_preparation = trace.record_result(NativeWorkspaceOpenSpanName::WalPrepare, || {
        prepare_wal(&database).map_err(AppError::from)
    })?;
    tracing::info!(
        outcome = ?wal_preparation,
        "workspace open WAL preparation completed"
    );
    let authority = Arc::new(WorkspaceAuthority::new(
        database,
        ws_path.clone(),
        opened.lease,
    ));

    // Final authority publish under the existing switching guard.
    let swap_span = trace.begin_span(NativeWorkspaceOpenSpanName::WorkspaceSwapLock);
    let mut inner = match ws_state.inner.lock() {
        Ok(inner) => inner,
        Err(error) => {
            trace.fail_span(swap_span);
            return Err(AppError::Anyhow(anyhow::anyhow!("{error}")));
        }
    };
    *inner = Some(ActiveWorkspace::new(authority));
    quiesced.commit_success();
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
    let workspace = OpenWorkspacePayload {
        name,
        is_existing,
        workspace_id: workspace_meta.id,
    };
    Ok(match migration_info {
        Some(info) => WorkspaceOpenOutcome::Migrated {
            workspace,
            migration: info.into(),
        },
        None => WorkspaceOpenOutcome::Ready { workspace },
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
            NativeWorkspaceOpenSpanName::WalPrepare,
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
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
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
        assert!(is_backup_file(&format!(
            "grimodex-c2zc-restore-fixture--sha256-{}.backup.db",
            "a".repeat(64)
        )));
        assert!(!is_backup_file(
            "grimodex-c2zc-restore-fixture--sha256-ABC.backup.db"
        ));
        assert!(!is_backup_file(&format!(
            "grimodex-c2zc-restore-fixture--sha256-{}.backup.db.gz",
            "a".repeat(64)
        )));
        assert!(!is_backup_file("grimodex-20260101-000000.db.tmp"));
        assert!(!is_backup_file("grimodex-20260101-000000.db.gz.tmp"));
        // materialize 用 restore-tmp は "grimodex." 始まり (ハイフン無し) で除外。
        assert!(!is_backup_file("grimodex.db.restore-tmp"));
        assert!(!is_backup_file("other.db"));
    }

    #[test]
    fn newest_backup_age_ignores_content_addressed_alias_when_mixed_with_timestamp_backup() {
        let dir =
            std::env::temp_dir().join(format!("grimodex-auto-backup-age-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let alias = format!(
            "grimodex-c2zc-restore-fixture--sha256-{}.backup.db",
            "a".repeat(64)
        );
        std::fs::write(dir.join(&alias), b"content-addressed").expect("write alias");

        assert_eq!(newest_backup_age_secs(&dir), None);

        std::fs::write(dir.join("grimodex-20260101-000000.db"), b"timestamped")
            .expect("write timestamped backup");
        assert!(newest_backup_age_secs(&dir).is_some());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rotate_backups_keeps_content_addressed_alias_and_newest_timestamped_backups() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-auto-backup-rotate-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let alias = format!(
            "grimodex-c2zc-restore-fixture--sha256-{}.backup.db",
            "b".repeat(64)
        );
        for name in [
            "grimodex-20260101-000000.db",
            "grimodex-20260101-000100.db.gz",
            "grimodex-20260101-000200.db",
            &alias,
        ] {
            std::fs::write(dir.join(name), name.as_bytes()).expect("write backup");
        }

        rotate_backups(&dir, 2);

        assert!(!dir.join("grimodex-20260101-000000.db").exists());
        assert!(dir.join("grimodex-20260101-000100.db.gz").exists());
        assert!(dir.join("grimodex-20260101-000200.db").exists());
        assert!(dir.join(alias).exists());

        let _ = std::fs::remove_dir_all(dir);
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
    fn exclusive_maintenance_claim_times_out_without_leaking_waiter_state() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-maintenance-timeout-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create maintenance timeout fixture");
        let active_claim = try_claim_workspace_maintenance(&dir).expect("claim active maintenance");

        let started = Instant::now();
        let error = match claim_workspace_maintenance_exclusive_with_timeout(
            &dir,
            Duration::from_millis(20),
        ) {
            Ok(_) => panic!("exclusive claim must time out"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("再試行"));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(workspace_maintenance_exclusive_waiters(&dir), 0);
        assert!(
            try_claim_workspace_maintenance(&dir).is_none(),
            "timed-out waiter must not release active maintenance"
        );

        drop(active_claim);
        let retry_claim =
            try_claim_workspace_maintenance(&dir).expect("claim after active release");
        drop(retry_claim);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn same_path_reopen_does_not_retain_the_previous_active_database() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-maintenance-reopen-{}",
            uuid::Uuid::new_v4()
        ));
        let ws_dir = dir.join("ws");
        let gs_file = dir.join("global-settings.json");
        std::fs::create_dir_all(&ws_dir).expect("create reopen fixture");

        let previous_database =
            Database::new(&ws_dir.join("grimodex.db")).expect("open previous active database");
        previous_database.migrate().expect("migrate fixture");
        previous_database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO app_settings (key, value)
                     VALUES ('data.autoBackup', 'false')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO undo_journal (
                        id, project_id, surface, entity_kind, entity_id, op_kind,
                        base_version, result_version, created_at
                     ) VALUES (
                        'reopen-old', 'default-project', 'test', 'scene',
                        'scene-old', 'update', 0, 1, datetime('now', '-120 days')
                     )",
                    [],
                )?;
                Ok(())
            })
            .expect("seed maintenance fixture");
        let previous_authority =
            WorkspaceAuthority::from_database_for_test(previous_database, ws_dir.clone())
                .expect("previous authority");
        let previous_weak = Arc::downgrade(&previous_authority);

        let ws_state = Arc::new(WorkspaceState {
            inner: Mutex::new(Some(ActiveWorkspace::new(previous_authority))),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: Mutex::new(()),
        });
        let gs_path = Arc::new(GlobalSettingsPath {
            path: gs_file.clone(),
            write_lock: Mutex::new(()),
        });

        // Stop the real worker after its detached connection, path claim, and
        // shared file lease exist. Same-path reopen must wait for that worker
        // (Gate A) before dropping authority / taking exclusive migration.
        let (maintenance_started_tx, maintenance_started_rx) = std::sync::mpsc::channel();
        let (release_maintenance_tx, release_maintenance_rx) = std::sync::mpsc::channel();
        let maintenance = spawn_workspace_maintenance_worker(&ws_dir, &gs_file, move || {
            let _ = maintenance_started_tx.send(());
            let _ = release_maintenance_rx.recv();
        })
        .expect("spawn production maintenance worker")
        .expect("maintenance claim");
        maintenance_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("maintenance owns detached connection");

        let reopen_state = Arc::clone(&ws_state);
        let reopen_settings = Arc::clone(&gs_path);
        let reopen_path = ws_dir.to_string_lossy().into_owned();
        let (reopened_tx, reopened_rx) = std::sync::mpsc::channel();
        let reopen = std::thread::spawn(move || {
            let mut on_swapped = || {};
            let mut deps = OpenDeps {
                gs_path: &reopen_settings,
                on_swapped: &mut on_swapped,
            };
            let result = open_workspace_sync(&reopen_state, &mut deps, &reopen_path);
            let _ = reopened_tx.send(result);
        });

        // Reopen must block while maintenance holds the path claim.
        assert!(
            reopened_rx
                .recv_timeout(Duration::from_millis(200))
                .is_err(),
            "same-path reopen must wait for detached maintenance"
        );

        release_maintenance_tx
            .send(())
            .expect("release production maintenance worker");
        let reopened = reopened_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("same-path reopen after maintenance");
        reopened.expect("same-path reopen");
        reopen.join().expect("reopen thread");
        maintenance.join().expect("maintenance worker");
        assert!(
            previous_weak.upgrade().is_none(),
            "maintenance worker must not retain the previous active authority"
        );

        with_db_state(&ws_state, |db| {
            let remaining: i64 = db.with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM undo_journal WHERE id = 'reopen-old'",
                    [],
                    |row| row.get(0),
                )?)
            })?;
            assert_eq!(
                remaining, 0,
                "detached maintenance must prune the live file"
            );
            Ok(())
        })
        .expect("query reopened database");

        let _ = std::fs::remove_dir_all(dir);
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
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
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
        let first_json = serde_json::to_value(&first).expect("json");
        assert_eq!(first_json["status"], "ready");
        assert_eq!(first_json["workspace"]["isExisting"], false);
        let first_workspace_id = first_json["workspace"]["workspaceId"]
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
        let second_json = serde_json::to_value(&second).expect("json");
        assert_eq!(second_json["status"], "ready");
        assert_eq!(second_json["workspace"]["isExisting"], true);
        assert_eq!(second_json["workspace"]["workspaceId"], first_workspace_id);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wal_timeout_restore_failure_does_not_publish_workspace_authority() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex_open_wal_restore_failure_{}",
            uuid::Uuid::new_v4()
        ));
        let ws_dir = dir.join("ws");
        let gs_path = GlobalSettingsPath {
            path: dir.join("global-settings.json"),
            write_lock: Mutex::new(()),
        };
        let ws_state = WorkspaceState {
            inner: Mutex::new(None),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: Mutex::new(()),
        };
        let mut trace = NativeWorkspaceOpenTrace::new(false);
        let mut on_swapped = |_: &mut NativeWorkspaceOpenTrace| {};
        let mut prepare_wal =
            |_database: &Database| Err(anyhow::anyhow!("OPEN_WAL_TIMEOUT_RESTORE_FAILED"));

        let result = open_workspace_sync_impl(
            &ws_state,
            &gs_path,
            &ws_dir.to_string_lossy(),
            &mut trace,
            &mut on_swapped,
            &mut prepare_wal,
            None,
        );
        let error = result.expect_err("restoration failure must fail open");
        assert!(error
            .to_string()
            .contains("OPEN_WAL_TIMEOUT_RESTORE_FAILED"));
        assert!(
            ws_state.inner.lock().expect("workspace state").is_none(),
            "a connection with unverified timeout restoration must not be published"
        );
        assert!(!ws_state.switching.load(std::sync::atomic::Ordering::SeqCst));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cold_open_prepares_large_residual_wal_before_first_writer() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex_open_residual_wal_{}",
            uuid::Uuid::new_v4()
        ));
        let ws_dir = dir.join("ws");
        let gs_path = GlobalSettingsPath {
            path: dir.join("global-settings.json"),
            write_lock: Mutex::new(()),
        };
        let ws_state = WorkspaceState {
            inner: Mutex::new(None),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: Mutex::new(()),
        };
        let mut initial_hook = || {};
        let mut initial_deps = OpenDeps {
            gs_path: &gs_path,
            on_swapped: &mut initial_hook,
        };
        let ws_path = ws_dir.to_string_lossy().into_owned();
        open_workspace_sync(&ws_state, &mut initial_deps, &ws_path)
            .expect("create current-schema workspace");
        let initial_maintenance = claim_workspace_maintenance_exclusive(&ws_dir)
            .expect("join initial workspace maintenance before simulating process teardown");
        drop(initial_maintenance);

        with_db_state(&ws_state, |database| {
            database.with_conn(|conn| {
                conn.pragma_update(None, "wal_autocheckpoint", 0)?;
                conn.execute_batch(
                    "CREATE TABLE open_wal_fixture (
                         id INTEGER PRIMARY KEY,
                         body BLOB NOT NULL
                     );
                     WITH RECURSIVE seq(n) AS (
                         SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 800
                     )
                     INSERT INTO open_wal_fixture (body)
                     SELECT zeroblob(4096) FROM seq;",
                )?;
                let state = crate::open_wal::sqlite_wal_checkpoint(
                    conn,
                    crate::open_wal::OpenWalCheckpointMode::Noop,
                )?;
                assert!(
                    (750..=1_000).contains(&state.log_frames),
                    "fixture WAL must stay inside the bounded open-preparation window: {state:?}"
                );
                Ok(())
            })
        })
        .expect("seed residual WAL");

        // Keep one SQLite handle open while the first authority is dropped, as
        // happens when process teardown leaves a WAL sidecar for the next open.
        let keeper = rusqlite::Connection::open(ws_dir.join("grimodex.db"))
            .expect("open WAL keeper connection");
        let _: i64 = keeper
            .query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))
            .expect("activate WAL keeper connection");
        let previous = ws_state.inner.lock().expect("workspace state").take();
        drop(previous);

        let mut trace = NativeWorkspaceOpenTrace::new(true);
        let mut reopen_hook = |_: &mut NativeWorkspaceOpenTrace| {};
        open_workspace_sync_traced(&ws_state, &gs_path, &ws_path, &mut trace, &mut reopen_hook)
            .expect("cold-open residual WAL workspace");
        let trace_json = trace
            .terminal_json(NativeWorkspaceOpenResult::Ready)
            .expect("open trace terminal");
        let trace_value: serde_json::Value =
            serde_json::from_str(&trace_json).expect("open trace JSON");
        let span_names: Vec<_> = trace_value["spans"]
            .as_array()
            .expect("open trace spans")
            .iter()
            .filter_map(|span| span["name"].as_str())
            .collect();
        let wal_prepare = span_names
            .iter()
            .position(|name| *name == "wal-prepare")
            .expect("wal-prepare trace span");
        let authority_publish = span_names
            .iter()
            .position(|name| *name == "workspace-swap-lock")
            .expect("workspace-swap-lock trace span");
        assert!(wal_prepare < authority_publish);

        with_db_state(&ws_state, |database| {
            database.with_conn(|conn| {
                let auto_checkpoint: i64 =
                    conn.pragma_query_value(None, "wal_autocheckpoint", |row| row.get(0))?;
                assert_eq!(auto_checkpoint, 1_000);
                conn.execute(
                    "INSERT INTO open_wal_fixture (body) VALUES (zeroblob(128))",
                    [],
                )?;
                let state = crate::open_wal::sqlite_wal_checkpoint(
                    conn,
                    crate::open_wal::OpenWalCheckpointMode::Noop,
                )?;
                assert!(
                    state.log_frames < 750,
                    "the first post-open writer must start from a restarted WAL: {state:?}"
                );
                Ok(())
            })
        })
        .expect("verify first writer WAL state");

        let reopened = ws_state.inner.lock().expect("workspace state").take();
        drop(reopened);
        let reopened_maintenance = claim_workspace_maintenance_exclusive(&ws_dir)
            .expect("join reopened workspace maintenance before fixture cleanup");
        drop(reopened_maintenance);
        drop(keeper);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cold_open_defers_oversized_residual_wal_without_synchronous_checkpoint() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex_open_oversized_residual_wal_{}",
            uuid::Uuid::new_v4()
        ));
        let ws_dir = dir.join("ws");
        let gs_path = GlobalSettingsPath {
            path: dir.join("global-settings.json"),
            write_lock: Mutex::new(()),
        };
        let ws_state = WorkspaceState {
            inner: Mutex::new(None),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: Mutex::new(()),
        };
        let mut initial_hook = || {};
        let mut initial_deps = OpenDeps {
            gs_path: &gs_path,
            on_swapped: &mut initial_hook,
        };
        let ws_path = ws_dir.to_string_lossy().into_owned();
        open_workspace_sync(&ws_state, &mut initial_deps, &ws_path)
            .expect("create current-schema workspace");
        let initial_maintenance = claim_workspace_maintenance_exclusive(&ws_dir)
            .expect("join initial workspace maintenance before simulating process teardown");
        drop(initial_maintenance);

        with_db_state(&ws_state, |database| {
            database.with_conn(|conn| {
                conn.pragma_update(None, "wal_autocheckpoint", 0)?;
                conn.execute_batch(
                    "CREATE TABLE oversized_open_wal_fixture (
                         id INTEGER PRIMARY KEY,
                         body BLOB NOT NULL
                     );
                     WITH RECURSIVE seq(n) AS (
                         SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1200
                     )
                     INSERT INTO oversized_open_wal_fixture (body)
                     SELECT zeroblob(4096) FROM seq;",
                )?;
                Ok(())
            })
        })
        .expect("seed oversized residual WAL");

        let keeper = rusqlite::Connection::open(ws_dir.join("grimodex.db"))
            .expect("open oversized WAL keeper connection");
        let _: i64 = keeper
            .query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))
            .expect("activate oversized WAL keeper connection");
        let previous = ws_state.inner.lock().expect("workspace state").take();
        drop(previous);
        let before = crate::open_wal::sqlite_wal_checkpoint(
            &keeper,
            crate::open_wal::OpenWalCheckpointMode::Noop,
        )
        .expect("inspect oversized WAL before cold open");
        assert!(
            before.log_frames > 1_000,
            "fixture must exceed one autocheckpoint cycle: {before:?}"
        );

        let mut trace = NativeWorkspaceOpenTrace::new(true);
        let mut reopen_hook = |_: &mut NativeWorkspaceOpenTrace| {};
        // This regression proves deterministic work limiting and publication
        // safety. The canonical performance budget remains the authority for
        // wall-clock acceptance.
        open_workspace_sync_traced(&ws_state, &gs_path, &ws_path, &mut trace, &mut reopen_hook)
            .expect("cold-open oversized residual WAL workspace");

        let trace_json = trace
            .terminal_json(NativeWorkspaceOpenResult::Ready)
            .expect("open trace terminal");
        let trace_value: serde_json::Value =
            serde_json::from_str(&trace_json).expect("open trace JSON");
        let span_names: Vec<_> = trace_value["spans"]
            .as_array()
            .expect("open trace spans")
            .iter()
            .filter_map(|span| span["name"].as_str())
            .collect();
        let wal_prepare = span_names
            .iter()
            .position(|name| *name == "wal-prepare")
            .expect("wal-prepare trace span");
        let authority_publish = span_names
            .iter()
            .position(|name| *name == "workspace-swap-lock")
            .expect("workspace-swap-lock trace span");
        assert!(wal_prepare < authority_publish);

        with_db_state(&ws_state, |database| {
            database.with_conn(|conn| {
                let timeout_ms: i64 =
                    conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
                let auto_checkpoint: i64 =
                    conn.pragma_query_value(None, "wal_autocheckpoint", |row| row.get(0))?;
                let after = crate::open_wal::sqlite_wal_checkpoint(
                    conn,
                    crate::open_wal::OpenWalCheckpointMode::Noop,
                )?;
                assert_eq!(timeout_ms, 5_000);
                assert_eq!(auto_checkpoint, 1_000);
                assert_eq!(after, before, "oversized open must not run RESTART");
                Ok(())
            })
        })
        .expect("authority must publish without changing oversized WAL state");

        let reopened = ws_state.inner.lock().expect("workspace state").take();
        drop(reopened);
        let reopened_maintenance = claim_workspace_maintenance_exclusive(&ws_dir)
            .expect("join reopened workspace maintenance before fixture cleanup");
        drop(reopened_maintenance);
        drop(keeper);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
