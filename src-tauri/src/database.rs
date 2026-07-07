use rusqlite::Connection;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, serde::Deserialize)]
pub struct BatchStatement {
    pub sql: String,
    pub params: Vec<Value>,
    pub method: String,
}

pub struct Database {
    conn: Mutex<Connection>,
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
pub(crate) fn gunzip_file(src: &Path, dst: &Path) -> anyhow::Result<()> {
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
/// **`event_chunks` は意図的に除外**する。scene/codex/chat の埋め込みは復元後 reload で
/// フロント `ensureSemanticIndexesOnOpen`（autoIndex.ts）が back-index して自己修復するが、
/// **events の open 時 back-index は存在せず**（`ensureEventsIndexed` なし・`events_reindex_all`
/// に FE 呼び出し元なし）、events 検索は dense-only なので slim で消すと Chronicle イベントの
/// 意味検索が無音で全滅し復旧手段が無い（敵対レビュー）。events 埋め込みは短く容量影響も小さい
/// ので、events の open 時 back-index を足すまではバックアップに残す。
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
    pub fn new(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        // synchronous=NORMAL is safe with WAL (committed txns survive crash;
        // only the very last group commit can be lost on power loss). The
        // SQLite default `FULL` issues an extra fsync per write — on WSL2 and
        // some SSDs that adds 100s of ms per UPDATE, which dominated D&D
        // commit latency in grid perf logs.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
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
             -- Cap the work `PRAGMA optimize` (run post-migrate / on close) does.
             PRAGMA analysis_limit=400;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Update the query planner's statistics (`sqlite_stat1`). Cheap because
    /// `analysis_limit` is set at open; safe to call any time. Run after
    /// migrate and periodically — without it SQLite never gathers stats and the
    /// planner can pick poor plans as tables grow (DB health audit 2026-07).
    pub fn optimize(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute_batch("PRAGMA optimize;")?;
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
            let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
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
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let cutoff = format!("-{retain_days} days");
        let mut total = 0usize;
        // Table names are fixed literals (no injection); created_at is stored in
        // datetime('now') text form, so lexical comparison is chronological.
        for table in ["undo_journal", "chat_message_prompts", "generation_logs"] {
            let sql = format!("DELETE FROM {table} WHERE created_at < datetime('now', ?1)");
            total += conn.execute(&sql, rusqlite::params![cutoff])?;
        }
        Ok(total)
    }

    /// Lightweight structural integrity probe (`PRAGMA quick_check`). Returns
    /// `Ok(None)` when the database reports `ok`, otherwise `Ok(Some(report))`
    /// with the first errors. Cheaper than `integrity_check`; used by the
    /// backup path to refuse snapshotting a corrupt DB (DB health audit 2026-07).
    pub fn quick_check(&self) -> anyhow::Result<Option<String>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
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
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        f(&conn)
    }
}

pub(crate) mod change_events;
mod execute;
mod fts;
mod integrity;
mod migrate;
pub(crate) mod undo_journal;

#[cfg(test)]
mod seed_schema_parity;
#[cfg(test)]
mod tests;
