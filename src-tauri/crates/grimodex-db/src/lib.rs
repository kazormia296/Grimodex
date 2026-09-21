//! Grimodex workspace DB 層 (Electron 移行 Phase 2 S1 で src-tauri から抽出)。
//!
//! SQLite の open/migrate/FTS/backup と workspace 状態 (`WorkspaceState` /
//! `with_db_state` / `AppError` の文字列ワイヤ契約) を、Tauri コマンド層と
//! napi バックエンド (`electron/native/grimodex-node`) の両方から呼べる形で
//! 提供する。tauri:: には一切依存しない。src-tauri 側は `lib.rs` /
//! `commands/mod.rs` の互換シム経由で従来のパス (`crate::database::…` /
//! `crate::workspace::…` / `crate::commands::AppError` 等) のまま利用する。

use rusqlite::{config::DbConfig, types::Value as SqlValue, Connection};
use serde_json::Value;
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex, MutexGuard, TryLockError,
};
use std::time::Duration;

pub(crate) mod narrative_maintenance_connection;
use narrative_maintenance_connection::ConnectionHealth;

/// Run a foreground maintenance command under the ordinary blocking
/// connection acquisition policy. Automatic maintenance remains no-wait, but
/// user initiated Verify/Backfill/Rebuild commands must retain the existing
/// foreground wait semantics when a background phase currently owns SQLite.
pub fn with_foreground_maintenance_wait<T>(operation: impl FnOnce() -> T) -> T {
    narrative_maintenance_connection::with_foreground_maintenance_wait(operation)
}

thread_local! {
    static BACKGROUND_CONNECTION_PRIORITY_DEPTH: Cell<usize> = const { Cell::new(0) };
    /// Native maintenance owns the connection in short, phase-scoped
    /// no-wait sections. Direct ledger reads that still use `with_conn` must
    /// inherit that policy instead of sleeping behind a foreground writer.
    static MAINTENANCE_NO_WAIT_DEPTH: Cell<usize> = const { Cell::new(0) };
}

struct BackgroundConnectionPriorityGuard;

impl Drop for BackgroundConnectionPriorityGuard {
    fn drop(&mut self) {
        BACKGROUND_CONNECTION_PRIORITY_DEPTH.with(|depth| {
            depth.set(depth.get().saturating_sub(1));
        });
    }
}

/// Thread-local no-wait mode used by the Native maintenance owner while it
/// performs short ledger/bookkeeping reads between phase scopes.
///
/// The guard is deliberately thread-affine.  Its state is stored in
/// thread-local storage, so allowing it to move to another worker would leave
/// no-wait mode enabled on the creating worker and decrement an unrelated
/// worker's depth when dropped.
#[must_use = "a maintenance no-wait guard must stay alive for the scoped work"]
pub struct MaintenanceConnectionNoWaitGuard {
    _thread_affine: std::marker::PhantomData<*mut ()>,
}

impl Drop for MaintenanceConnectionNoWaitGuard {
    fn drop(&mut self) {
        MAINTENANCE_NO_WAIT_DEPTH.with(|depth| {
            depth.set(depth.get().saturating_sub(1));
        });
    }
}

struct ForegroundConnectionWaiter<'a> {
    count: &'a AtomicUsize,
}

impl<'a> ForegroundConnectionWaiter<'a> {
    fn new(count: &'a AtomicUsize) -> Self {
        // Waiter admission and the finalization reservation are separate
        // atomics.  Use one sequentially consistent order for both so the
        // pre/post checks around the reservation CAS cannot observe a
        // foreground arrival on the wrong side of the handoff.
        count.fetch_add(1, Ordering::SeqCst);
        Self { count }
    }
}

impl Drop for ForegroundConnectionWaiter<'_> {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct BatchStatement {
    pub sql: String,
    pub params: Vec<Value>,
    pub method: String,
}

pub struct Database {
    conn: Mutex<Connection>,
    /// Connections whose close returned the owned handle for an explicit
    /// retry. They never re-enter normal access; the owner keeps them here
    /// until a close succeeds and only then emits retirement proof.
    retired_connections: Mutex<Vec<Connection>>,
    foreground_connection_waiters: std::sync::Arc<AtomicUsize>,
    maintenance_finalization_reserved: std::sync::Arc<AtomicBool>,
    connection_health: ConnectionHealth,
}

/// Process-local finalization reservation held for one exact terminal
/// transaction.  Foreground admission observes this reservation before
/// announcing a waiter, closing the waiter/grant ordering race.
pub(crate) struct MaintenanceFinalizationReservation<'a> {
    db: &'a Database,
}

impl Drop for MaintenanceFinalizationReservation<'_> {
    fn drop(&mut self) {
        self.db
            .maintenance_finalization_reserved
            .store(false, Ordering::SeqCst);
    }
}

/// Connection-local token used to prove that a renderer snapshot and a
/// backend mutation were observed on the same SQLite connection state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqliteSourceRevision {
    pub connection_epoch: String,
    pub total_changes: u64,
    pub data_version: u64,
}

/// Read all connection-local revision components in one SQLite statement.
/// `total_changes` observes writes made through this connection, while
/// `data_version` changes when another connection commits to the same DB.
pub fn read_sqlite_source_revision(conn: &Connection) -> anyhow::Result<SqliteSourceRevision> {
    let (connection_epoch, total_changes, data_version): (String, i64, i64) = conn.query_row(
        "SELECT meta.epoch, total_changes(), version.data_version
           FROM temp.grimodex_connection_meta AS meta
           CROSS JOIN pragma_data_version AS version
          WHERE meta.singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(SqliteSourceRevision {
        connection_epoch,
        total_changes: u64::try_from(total_changes)?,
        data_version: u64::try_from(data_version)?,
    })
}

/// `<path><suffix>` を組む（拡張子付与 / temp 名生成用）。
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(suffix);
    PathBuf::from(os)
}

/// `src` を gzip 圧縮して `dst` に書く（ストリーミング・一定メモリ）。
fn gzip_file(src: &Path, dst: &Path) -> anyhow::Result<()> {
    let input = std::fs::File::open(src)?;
    let output = std::fs::File::create(dst)?;
    let mut encoder = flate2::write::GzEncoder::new(output, flate2::Compression::new(6));
    let mut reader = std::io::BufReader::new(input);
    std::io::copy(&mut reader, &mut encoder)?;
    encoder.finish()?;
    Ok(())
}

/// gzip の `src` を解凍して `dst` に書く（ストリーミング・一定メモリ）。
/// バックアップ復元（Phase 2）で `.db.gz` を平文 `.db` に展開するのに使う。
pub fn gunzip_file(src: &Path, dst: &Path) -> anyhow::Result<()> {
    let input = std::fs::File::open(src)?;
    let mut decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(input));
    let mut output = std::fs::File::create(dst)?;
    std::io::copy(&mut decoder, &mut output)?;
    Ok(())
}

// --- slim バックアップ (backup restore Phase 3) ----------------------------
// バックアップから**ソース本文から再生成可能な派生データ**を除外して容量を約半減させる。
// 復元側は content から FTS を rebuild し（restore_backup_core）、埋め込みは reload 後の
// フロント autoIndex が back-index するので、除外しても情報は失われない。

/// slim で全削除するチャンク表（埋め込み BLOB + 重複 text、再生成可）。トリガ・被参照
/// FK が無いので素の DELETE で安全（migrate.rs:1348-1444 で確認）。
///
/// **`event_chunks` は意図的に除外**する。復元後はフロント
/// `ensureSemanticIndexesOnOpen`（autoIndex.ts）が scene/codex/events/chat を
/// back-index するが、events 検索だけは sparse/FTS fallback が無い。
/// モデル未導入・オフラインの復元直後も Chronicle 意味検索を使えるよう、
/// 容量影響の小さい event embedding は backup に残す。slim 対象化は
/// restore→events back-index の統合テストと offline UX の方針決定後に行う。
const SLIM_CHUNK_TABLES: &[&str] = &["scene_chunks", "codex_chunks", "chat_message_chunks"];

/// slim で索引を空にする JA FTS（external content, `content=...`）。`'delete-all'` で
/// 内容表に触れず索引だけ空にする（DROP は復元後の書き込みで `*_fts_ai/ad/au` トリガを
/// 壊すため不可）。
const SLIM_JA_FTS_TABLES: &[&str] = &[
    "codex_fts",
    "snippets_fts",
    "chat_messages_fts",
    "tree_nodes_fts",
    "post_effect_annotations_fts",
];

/// slim で空にする EN FTS（非 external）。`'delete-all'` は external/contentless 専用で
/// 使えないので素の DELETE（fts.rs の `_en` 非 external 前提と対）。
const SLIM_EN_FTS_TABLES: &[&str] = &[
    "codex_fts_en",
    "snippets_fts_en",
    "chat_messages_fts_en",
    "tree_nodes_fts_en",
    "post_effect_annotations_fts_en",
];

/// `VACUUM INTO` 出力のコピー（never the live DB）を開き、再生成可能な派生データを削って
/// 最後に `VACUUM` する。DELETE だけでは解放ページが freelist に残ってファイルが縮まず、
/// 解放ページ上の埋め込み BLOB バイトが物理的に残って圧縮率を殺す（`secure_delete` は
/// 既定 OFF）ため、`VACUUM` が必須。
fn slim_backup_copy(path: &Path) -> anyhow::Result<()> {
    // foreign_keys は既定 OFF のまま（チャンク表に FK は無いが cascade 事故を避ける）。
    let conn = Connection::open(path)?;
    for table in SLIM_CHUNK_TABLES {
        conn.execute(&format!("DELETE FROM {table}"), [])?;
    }
    for fts in SLIM_JA_FTS_TABLES {
        conn.execute(
            &format!("INSERT INTO {fts}({fts}) VALUES('delete-all')"),
            [],
        )?;
    }
    for fts in SLIM_EN_FTS_TABLES {
        conn.execute(&format!("DELETE FROM {fts}"), [])?;
    }
    // 復元側が「FTS を rebuild すべき slim バックアップ」と確実に分かるようマーカーを立てる。
    // external content FTS は索引を空にしても `SELECT`/`count(*)` が content 表を読むため
    // 索引の空判定ができない。app_settings のマーカーで検知する（rebuild_fts_if_stale）。
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('fts.slim_backup', '1')",
        [],
    )?;
    conn.execute_batch("VACUUM")?;
    Ok(())
}

impl Database {
    /// Adopt an already-open trusted connection.
    ///
    /// The standalone MCP server owns a connection whose open/schema guard is
    /// performed before the server is constructed.  Adopting it here lets MCP
    /// writes use the same canonical Native writer authority as Electron while
    /// preserving the existing connection for all read tools.
    pub fn from_connection(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
            retired_connections: Mutex::new(Vec::new()),
            foreground_connection_waiters: std::sync::Arc::new(AtomicUsize::new(0)),
            maintenance_finalization_reserved: std::sync::Arc::new(AtomicBool::new(false)),
            connection_health: ConnectionHealth::new(),
        }
    }

    /// Compatibility lock for trusted in-process consumers that still perform
    /// direct read projections. Domain writes must use the typed APIs instead.
    pub fn lock(&self) -> anyhow::Result<MutexGuard<'_, Connection>> {
        self.lock_conn()
    }

    pub fn new(path: &Path) -> anyhow::Result<Self> {
        Self::new_with_busy_timeout(path, Duration::from_millis(5_000))
    }

    /// Open the detached workspace-maintenance connection without ever
    /// waiting behind a foreground SQLite writer. Maintenance is best-effort:
    /// SQLITE_BUSY means "try again on a later workspace open", not that the
    /// editor should inherit the normal five-second busy timeout.
    pub(crate) fn new_for_workspace_maintenance(path: &Path) -> anyhow::Result<Self> {
        Self::new_with_busy_timeout(path, Duration::ZERO)
    }

    fn new_with_busy_timeout(path: &Path, busy_timeout: Duration) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        // Set this before journal-mode negotiation. A detached maintenance
        // connection must fail fast even when opening while another writer is
        // active; setting it in the later PRAGMA batch would be too late.
        conn.busy_timeout(busy_timeout)?;
        // Connection-wide defense in depth. Renderer SQL receives the
        // stricter, temporary authorizer/limit policy in execute.rs; these
        // settings are safe for trusted migration/backup code as well.
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_WRITABLE_SCHEMA, false)?;
        // synchronous=NORMAL is safe with WAL (committed txns survive crash;
        // only the very last group commit can be lost on power loss). The
        // SQLite default `FULL` issues an extra fsync per write — on WSL2 and
        // some SSDs that adds 100s of ms per UPDATE, which dominated D&D
        // commit latency in grid perf logs.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;
             -- Perf/maintenance (DB health audit 2026-07). All safe defaults:
             -- 16 MiB page cache, 256 MiB mmap reads, temp b-trees in RAM.
             PRAGMA cache_size=-16000;
             PRAGMA mmap_size=268435456;
             PRAGMA temp_store=MEMORY;
             -- Bound WAL growth on this long-lived connection: checkpoint every
             -- ~1000 pages and truncate the WAL file back to 64 MiB afterwards
             -- so it can't grow without bound during a long session.
             PRAGMA wal_autocheckpoint=1000;
             PRAGMA journal_size_limit=67108864;
             -- Cap the work `PRAGMA optimize` (restore / non-blocking open maintenance) does.
             PRAGMA analysis_limit=400;",
        )?;
        // TEMP metadata is deliberately connection-local: open/restore creates
        // a fresh Database and therefore a fresh epoch, while schema contracts
        // and backups remain untouched. Impact Review includes this token in
        // its source guard so a workspace swap cannot accidentally compare two
        // unrelated total_changes/data_version counters.
        conn.execute_batch(
            "CREATE TEMP TABLE grimodex_connection_meta (
                 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                 epoch TEXT NOT NULL
             );",
        )?;
        conn.execute(
            "INSERT INTO temp.grimodex_connection_meta (singleton, epoch)
             VALUES (1, ?1)",
            rusqlite::params![uuid::Uuid::new_v4().to_string()],
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            retired_connections: Mutex::new(Vec::new()),
            foreground_connection_waiters: std::sync::Arc::new(AtomicUsize::new(0)),
            maintenance_finalization_reserved: std::sync::Arc::new(AtomicBool::new(false)),
            connection_health: ConnectionHealth::new(),
        })
    }

    fn with_busy_timeout<T>(
        &self,
        timeout: Duration,
        operation: impl FnOnce(&Connection) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let conn = self.lock_conn()?;
        let original_timeout_ms: i64 =
            conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
        anyhow::ensure!(
            original_timeout_ms >= 0,
            "SQLite returned a negative busy_timeout"
        );
        conn.busy_timeout(timeout)?;
        let operation_result = operation(&conn);
        let restore_result = conn.busy_timeout(Duration::from_millis(original_timeout_ms as u64));

        match (operation_result, restore_result) {
            (Err(operation), Err(cleanup)) => {
                self.quarantine_connection(format!("busy timeout restore failed: {cleanup}"));
                Err(anyhow::anyhow!(
                    "operation failed: {operation}; busy timeout restore failed: {cleanup}"
                ))
            }
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => {
                self.quarantine_connection(format!("busy timeout restore failed: {error}"));
                Err(error.into())
            }
            (Ok(value), Ok(())) => Ok(value),
        }
    }

    fn background_connection_priority_active() -> bool {
        BACKGROUND_CONNECTION_PRIORITY_DEPTH.with(|depth| depth.get() > 0)
    }

    fn maintenance_no_wait_active() -> bool {
        MAINTENANCE_NO_WAIT_DEPTH.with(|depth| depth.get() > 0)
    }

    pub(crate) fn lock_conn(&self) -> anyhow::Result<MutexGuard<'_, Connection>> {
        self.ensure_connection_reusable()?;
        if Self::maintenance_no_wait_active() {
            if self.foreground_connection_waiters.load(Ordering::SeqCst) > 0 {
                anyhow::bail!(
                    "NEX_MAINTENANCE_CONNECTION_PREEMPTED: foreground waiter owns the next maintenance handoff"
                );
            }
            let conn = match self.conn.try_lock() {
                Ok(conn) => conn,
                Err(TryLockError::WouldBlock) => {
                    anyhow::bail!(
                        "NEX_MAINTENANCE_CONNECTION_PREEMPTED: maintenance connection is busy"
                    );
                }
                Err(TryLockError::Poisoned(error)) => {
                    return Err(anyhow::anyhow!("{error}"));
                }
            };
            self.ensure_connection_reusable()?;
            if self.foreground_connection_waiters.load(Ordering::SeqCst) > 0 {
                drop(conn);
                anyhow::bail!(
                    "NEX_MAINTENANCE_CONNECTION_PREEMPTED: foreground waiter arrived before maintenance acquisition"
                );
            }
            return Ok(conn);
        }
        if !Self::background_connection_priority_active() {
            loop {
                // A final transaction reserves the handoff before acquiring
                // its process-local grant. Do not announce a foreground
                // waiter into that narrow window.
                if self
                    .maintenance_finalization_reserved
                    .load(Ordering::SeqCst)
                {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                let waiter = ForegroundConnectionWaiter::new(&self.foreground_connection_waiters);
                if self
                    .maintenance_finalization_reserved
                    .load(Ordering::SeqCst)
                {
                    drop(waiter);
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
                self.ensure_connection_reusable()?;
                // Keep the waiter published until this caller owns the
                // connection. A background contender then observes either a
                // waiting foreground caller or the foreground-owned mutex.
                drop(waiter);
                return Ok(conn);
            }
        }

        loop {
            if self.foreground_connection_waiters.load(Ordering::SeqCst) > 0 {
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }
            match self.conn.try_lock() {
                Ok(conn) => {
                    if let Err(error) = self.ensure_connection_reusable() {
                        drop(conn);
                        return Err(error);
                    }
                    // Close the observation-to-lock race. A foreground caller
                    // that announced itself while try_lock succeeded gets the
                    // next hand-off instead of sitting behind another bulk item.
                    if self.foreground_connection_waiters.load(Ordering::SeqCst) == 0 {
                        return Ok(conn);
                    }
                    drop(conn);
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(TryLockError::Poisoned(error)) => {
                    return Err(anyhow::anyhow!("{error}"));
                }
            }
        }
    }

    pub(crate) fn try_reserve_maintenance_finalization(
        &self,
    ) -> Option<MaintenanceFinalizationReservation<'_>> {
        self.try_reserve_maintenance_finalization_with_hook(|| {})
    }

    fn try_reserve_maintenance_finalization_with_hook<F>(
        &self,
        after_reservation: F,
    ) -> Option<MaintenanceFinalizationReservation<'_>>
    where
        F: FnOnce(),
    {
        if self.foreground_connection_waiters.load(Ordering::SeqCst) > 0 {
            return None;
        }
        if self
            .maintenance_finalization_reserved
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return None;
        }
        after_reservation();
        if self.foreground_connection_waiters.load(Ordering::SeqCst) > 0 {
            self.maintenance_finalization_reserved
                .store(false, Ordering::SeqCst);
            return None;
        }
        Some(MaintenanceFinalizationReservation { db: self })
    }

    /**
     * Mark connection acquisitions on the current worker as rebuildable
     * background work.
     *
     * Bulk semantic indexing releases the SQLite mutex between items, but a
     * hot worker can otherwise reacquire it repeatedly before an Editor read
     * wakes. Within this scope, each acquisition yields to already-announced
     * foreground waiters. The marker is thread-local because the native bulk
     * operation and every nested `with_conn` call run on the same blocking
     * worker.
     */
    pub fn with_background_connection_priority<T>(&self, operation: impl FnOnce() -> T) -> T {
        BACKGROUND_CONNECTION_PRIORITY_DEPTH.with(|depth| {
            depth.set(depth.get().saturating_add(1));
        });
        let _guard = BackgroundConnectionPriorityGuard;
        operation()
    }

    /// Enter the Native maintenance no-wait mode for this worker.
    ///
    /// This narrow entry point is public so the Electron N-API crate can wrap
    /// its scheduler-owned ledger work.  The returned guard is the only
    /// authority exposed to that caller: it changes no database state and
    /// merely makes nested connection acquisition fail fast while it is alive.
    pub fn enter_maintenance_connection_no_wait(&self) -> MaintenanceConnectionNoWaitGuard {
        MAINTENANCE_NO_WAIT_DEPTH.with(|depth| {
            depth.set(depth.get().saturating_add(1));
        });
        MaintenanceConnectionNoWaitGuard {
            _thread_affine: std::marker::PhantomData,
        }
    }

    /// Update the query planner's statistics (`sqlite_stat1`). Cheap because
    /// `analysis_limit` is set at open; safe to call after a bulk replacement
    /// such as restore. Normal workspace open uses the non-blocking variant
    /// below because even a no-op `PRAGMA optimize` can request SQLite's writer
    /// lock (DB health audit 2026-07).
    pub fn optimize(&self) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        conn.execute_batch("PRAGMA optimize;")?;
        Ok(())
    }

    /// Refresh planner statistics without ever waiting behind another SQLite
    /// writer. Workspace open uses this before publishing authority: success
    /// preserves the previous maintenance behavior, while SQLITE_BUSY is a
    /// fail-soft signal and cannot reintroduce the five-second open stall.
    pub fn optimize_without_wait(&self) -> anyhow::Result<()> {
        self.with_busy_timeout(Duration::ZERO, |conn| {
            conn.execute_batch("PRAGMA optimize;")?;
            Ok(())
        })
    }

    /// Compact the active workspace in place. This trusted, argument-free API
    /// is the only renderer-reachable replacement for raw `VACUUM` SQL.
    pub fn vacuum(&self) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        conn.execute_batch("VACUUM")?;
        Ok(())
    }

    /// Write a consistent, compacted copy of the whole database to `dest` using
    /// `VACUUM INTO`. This is the automatic-backup primitive — it runs against
    /// the live connection (DB health audit 2026-07).
    ///
    /// - When `dest` ends in `.gz` the compacted copy is **gzip-compressed**
    ///   (backup restore Phase 2). SQLite pages of text/JSON typically shrink
    ///   3–6×; the fastest-growing part (`change_events`, repetitive JSON)
    ///   compresses very well.
    /// - Everything is staged in temp siblings and `rename`d into place, so a
    ///   crash mid-`VACUUM`/gzip never leaves a truncated `grimodex-<ts>.db(.gz)`:
    ///   such a stump would be picked as the "newest" backup by
    ///   `newest_backup_age_secs` (suppressing further backups) and count as a
    ///   live generation in `rotate_backups` (evicting a real one). Temp names end
    ///   in `.tmp`, invisible to `is_backup_file`.
    pub fn backup_to(&self, dest: &Path) -> anyhow::Result<()> {
        // 1. `VACUUM INTO` a plain sqlite temp (consistent, compacted, no sidecars).
        let sqlite_tmp = with_suffix(dest, ".sqlite.tmp");
        {
            let conn = self.lock_conn()?;
            if sqlite_tmp.exists() {
                std::fs::remove_file(&sqlite_tmp)?;
            }
            let s = sqlite_tmp
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("backup temp path is not valid UTF-8"))?;
            conn.execute("VACUUM INTO ?1", rusqlite::params![s])?;
            // Release the connection lock before the (possibly slow) gzip/rename.
        }

        // 2. Slim + materialize `dest`: strip recomputable derived data (embeddings
        //    + FTS index) so each backup is ~half size before compression, then
        //    gzip when `dest` ends in `.gz`, else plain rename. Writes to `<dest>.tmp`
        //    first so a crash never leaves a partial `dest` (backup restore Phase 3).
        let result = (|| -> anyhow::Result<()> {
            slim_backup_copy(&sqlite_tmp)?;
            if dest.extension().and_then(|e| e.to_str()) == Some("gz") {
                let gz_tmp = with_suffix(dest, ".tmp");
                gzip_file(&sqlite_tmp, &gz_tmp)?;
                std::fs::remove_file(&sqlite_tmp)?;
                std::fs::rename(&gz_tmp, dest)?;
            } else {
                std::fs::rename(&sqlite_tmp, dest)?;
            }
            Ok(())
        })();
        if result.is_err() {
            // Clean up staging so a failed backup can't pollute age/rotation.
            let _ = std::fs::remove_file(&sqlite_tmp);
            let _ = std::fs::remove_file(with_suffix(dest, ".tmp"));
        }
        result
    }

    /// Age out append-only audit/debug logs that otherwise grow without bound
    /// (DB health audit 2026-07). `change_events` is intentionally excluded —
    /// its append-only hash chain can't be partially pruned without a dedicated
    /// compaction pass. undo_journal / chat_message_prompts / generation_logs
    /// past the retention window are safe to drop. Returns rows deleted.
    pub fn prune_old_logs(&self, retain_days: i64) -> anyhow::Result<usize> {
        let cutoff = format!("-{retain_days} days");
        let mut total = 0usize;
        // Table names are fixed literals (no injection); created_at is stored in
        // datetime('now') text form, so lexical comparison is chronological.
        for table in ["undo_journal", "chat_message_prompts", "generation_logs"] {
            let sql = format!("DELETE FROM {table} WHERE created_at < datetime('now', ?1)");
            let conn = self.lock_conn()?;
            total += conn.execute(&sql, rusqlite::params![&cutoff])?;
        }
        Ok(total)
    }

    /// Bounded open-time maintenance on the detached zero-wait connection.
    /// Candidate scans never touch the active renderer mutex even when a table
    /// lacks a `created_at` index. Each write deletes at most 256 stable primary
    /// keys and fails immediately on SQLITE_BUSY. Remaining rows are left for a
    /// later workspace open.
    pub(crate) fn prune_old_logs_for_workspace_maintenance(
        &self,
        retain_days: i64,
    ) -> anyhow::Result<usize> {
        self.prune_old_logs_for_workspace_maintenance_inner(retain_days, |_| Ok(()))
    }

    #[cfg(test)]
    fn prune_old_logs_for_workspace_maintenance_with_hook(
        &self,
        retain_days: i64,
        after_select: impl FnMut(&str) -> anyhow::Result<()>,
    ) -> anyhow::Result<usize> {
        self.prune_old_logs_for_workspace_maintenance_inner(retain_days, after_select)
    }

    fn prune_old_logs_for_workspace_maintenance_inner(
        &self,
        retain_days: i64,
        mut after_select: impl FnMut(&str) -> anyhow::Result<()>,
    ) -> anyhow::Result<usize> {
        const ROWS_PER_TABLE: usize = 256;

        let cutoff = format!("-{retain_days} days");
        let mut total = 0usize;
        for (table, primary_key) in [
            ("undo_journal", "id"),
            ("chat_message_prompts", "message_id"),
            ("generation_logs", "id"),
        ] {
            let select_sql = format!(
                "SELECT {primary_key} FROM {table}
                  WHERE created_at < datetime('now', ?1)
                  ORDER BY {primary_key}
                  LIMIT ?2"
            );
            let keys = self.with_conn(|conn| {
                let mut statement = conn.prepare(&select_sql)?;
                let rows = statement
                    .query_map(rusqlite::params![&cutoff, ROWS_PER_TABLE as i64], |row| {
                        row.get::<_, String>(0)
                    })?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })?;
            if keys.is_empty() {
                continue;
            }
            after_select(table)?;

            let placeholders = (1..=keys.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(", ");
            let cutoff_parameter = keys.len() + 1;
            let delete_sql = format!(
                "DELETE FROM {table}
                  WHERE {primary_key} IN ({placeholders})
                    AND created_at < datetime('now', ?{cutoff_parameter})"
            );
            let mut delete_params: Vec<SqlValue> = keys.into_iter().map(SqlValue::Text).collect();
            delete_params.push(SqlValue::Text(cutoff.clone()));
            total += self.with_busy_timeout(Duration::ZERO, |conn| {
                Ok(conn.execute(
                    &delete_sql,
                    rusqlite::params_from_iter(delete_params.iter()),
                )?)
            })?;
        }
        Ok(total)
    }

    /// Lightweight structural integrity probe (`PRAGMA quick_check`). Returns
    /// `Ok(None)` when the database reports `ok`, otherwise `Ok(Some(report))`
    /// with the first errors. Cheaper than `integrity_check`; used by the
    /// backup path to refuse snapshotting a corrupt DB (DB health audit 2026-07).
    pub fn quick_check(&self) -> anyhow::Result<Option<String>> {
        let conn = self.lock_conn()?;
        let first: String = conn.query_row("PRAGMA quick_check(1)", [], |r| r.get(0))?;
        if first == "ok" {
            Ok(None)
        } else {
            Ok(Some(first))
        }
    }

    /// Execute a closure with direct access to the underlying `rusqlite::Connection`.
    /// Use this only when `execute` / `execute_batch_tx` are insufficient
    /// (e.g. `prepare` / `query_map` / `query_row` with native params).
    pub fn with_conn<T, F>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&Connection) -> anyhow::Result<T>,
    {
        let conn = self.lock_conn()?;
        f(&conn)
    }

    /// Read several Native observations from one SQLite snapshot. The shell
    /// need not depend directly on rusqlite to compose canonical readers.
    /// Errors drop/roll back the transaction before releasing the DB lock.
    pub fn with_read_transaction<T, F>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&Connection) -> anyhow::Result<T>,
    {
        self.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let value = f(&tx)?;
            tx.commit()?;
            Ok(value)
        })
    }
}

pub mod agent_writes;
pub mod ai_audit;
pub mod backup_restore;
pub(crate) mod canonical_feed_snapshots;
pub mod change_events;
pub mod chronicle;
pub mod chronicle_bulk;
pub mod codex_relation_keys;
pub mod codex_writes;
pub mod domain_writes;
pub mod editor_stickies;
mod execute;
pub mod foreshadow;
mod fts;
mod idempotency;
pub mod ime_export;
pub mod import;
mod integrity;
pub mod lint_ignores;
pub mod lint_terms;
pub mod map_writes;
mod migrate;
pub mod narrative_extraction;
pub mod narrative_runtime_policy;
pub mod plot_threads;
pub mod post_effect;
pub mod profile_egress_policy;
pub mod project_snapshots;
pub mod protected_writers;
pub mod revision_restore;
pub mod runtime_performance_seed;
pub mod runtime_threads;
pub mod sample_seed;
pub mod scene_body;
pub mod schema_contract;
pub mod snippet_writes;
pub mod timelapse;
pub mod trash_bin;
pub mod undo_journal;

pub mod error;
pub mod events;
pub mod migration_supervisor;
pub mod open;
pub(crate) mod open_wal;
pub mod recovery;
pub mod state;
pub mod web_editor_handoff;
pub mod workspace;
pub mod workspace_lease;
pub mod workspace_lifecycle;

// 旧 `commands/mod.rs` から移動した state / 契約型はクレートルートでも公開する
// (src-tauri の互換シム `pub(crate) use grimodex_db::{…}` と napi 側の両方が
// フラットに import できるように)。
pub use error::{AppError, AppResult, QueryResult};
pub use execute::{
    SqlExecutionResult, SqlOrigin, RENDERER_SQL_SECURITY_ERROR,
    RENDERER_TYPED_PAYLOAD_ERROR,
};
pub use integrity::{RepairIntegrityPayload, RepairIntegrityReport};
pub use narrative_runtime_policy::{
    ensure_narrative_runtime_policy_row, load_narrative_runtime_policy,
    load_narrative_runtime_policy_from_db, require_background_ai_allowed,
    require_generic_import_allowed, require_generic_import_apply_allowed,
    require_generic_import_capture_allowed, require_manual_apply_authority_in_tx,
    require_narrative_apply_allowed, require_narrative_extraction_allowed,
    require_narrative_maintenance_allowed, require_narrative_maintenance_mutation_allowed,
    require_narrative_maintenance_preview_allowed, require_narrative_redo_allowed,
    require_narrative_undo_allowed, set_narrative_runtime_policy,
    set_narrative_runtime_policy_in_tx, validate_narrative_apply_authority_in_tx,
    NarrativeRuntimeMode, NarrativeRuntimePolicy, SetNarrativeRuntimePolicyInput,
    NARRATIVE_APPROVAL_REQUIRED, NARRATIVE_BACKGROUND_AI_DISABLED, NARRATIVE_ENGINE_DISABLED,
    NARRATIVE_GENERIC_IMPORT_DISABLED, NARRATIVE_MAINTENANCE_DISABLED, NARRATIVE_REVIEW_ONLY,
    NARRATIVE_RUNTIME_POLICY_CONFLICT,
};
pub use protected_writers::PROTECTED_WRITER_SQL_ERROR;
pub use recovery::{
    MigrationReceipt, OpenWorkspacePayload, RecoveryCandidate, RecoveryCandidateKind,
    WorkspaceOpenOutcome,
};
pub use workspace_lifecycle::{
    AdmissionKind, AdmissionOutcome, AdmissionRejection, AdmissionTicket, ActivationState,
    ContentEffect, ControlGeneration, ControlRequest, ControlSlotOutcome, DeliveryAdmissionOutcome,
    DeliverySequence, DurableRunHandle, ExecutionId, ExecutionMembership, ExecutionPhase,
    FenceOutcome, LifecycleError,
    LifecycleResult, LifecycleSnapshot, LifecycleState, LiveBinding, MaintenancePermit,
    OperationId, PermitAdmission, PublicationPermit,
    RecoveryDescriptor, RecoveryDescriptorId, ResponsibilityError, ResponsibilityKind,
    ResponsibilityReservation, RunCreationState, RunCreationTransactionOutcome, RunOwnership,
    StateRevision, TransitionStage,
    WorkspaceExclusive, WorkspaceLifecycleCompatibilityView, WorkspaceLifecycleCore,
    WorkspaceParticipant,
    WorkspaceTransitionPermit, WorkExecutionId, WorkExecutionMembership,
    DELIVERY_CAPACITY, EMERGENCY_RESPONSIBILITY_CAPACITY, GENERAL_RESPONSIBILITY_CAPACITY,
};
pub use state::{
    with_db_state, ActiveWorkspace, GlobalSettingsPath, PinnedWorkspaceDb, WorkspaceAuthority,
    WorkspaceState,
};

#[cfg(test)]
mod seed_schema_parity;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
