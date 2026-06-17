//! Codex セマンティック検索の実行系 (stage 3): scene の `search.rs` を
//! 「1 エントリ 1 ベクトル・dialogue 減点なし」にフォークした版。
//!
//! - `CodexSearchCache`: entry_id 単位の in-memory 埋め込みキャッシュ。
//!   `Arc<CodexCachedChunk>` を保持し、ロック保持を短くする。scene の
//!   `SearchCache` と同じ stale ガード (model_id / embedding_dim /
//!   chunker_version)。
//! - `load_codex_chunk_from_db`: `codex_chunks` + `codex_entries` JOIN で
//!   1 entry のベクトル + entry_name/type/summary を取得。**project スコープは
//!   `list_indexed_codex_entry_ids` 側で効かせる** (XPROJ)。
//! - `run_codex_search`: pure logic。query_embedding は呼び出し側が用意するため
//!   Embedder 非依存で `--no-default-features` でも build/test できる。
//! - スコアは `crate::semantic::search::dot_product` を流用 (正規化済み → cosine)。
//!   codex に dialogue_ratio は無いので減点は行わない。

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::semantic::search::dot_product;

/// in-memory に保持される 1 entry のベクトル + 表示メタ。
#[derive(Debug, Clone)]
pub struct CodexCachedChunk {
    pub entry_id: String,
    pub entry_name: String,
    pub entry_type: String,
    pub summary: String,
    pub embedding: Vec<f32>,
}

/// 検索結果 1 件。frontend (search_codex hybrid) へ JSON で返す。
/// JSON 形: `{ entryId, entryName, entryType, summary, score }`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexSearchHit {
    pub entry_id: String,
    pub entry_name: String,
    pub entry_type: String,
    pub summary: String,
    pub score: f32,
}

/// entry_id 単位のキャッシュエントリ。識別子が現行と一致するときだけ hit。
#[derive(Debug, Clone)]
struct CacheEntry {
    model_id: String,
    embedding_dim: usize,
    chunker_version: String,
    chunk: Arc<CodexCachedChunk>,
}

/// entry_id → キャッシュエントリ。`Mutex` は std (spawn_blocking 内で使う)。
pub struct CodexSearchCache {
    inner: Mutex<HashMap<String, CacheEntry>>,
}

impl Default for CodexSearchCache {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl CodexSearchCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(
        &self,
        entry_id: &str,
        model_id: &str,
        embedding_dim: usize,
        chunker_version: &str,
    ) -> Result<Option<Arc<CodexCachedChunk>>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("codex search cache lock poisoned: {e}"))?;
        let Some(entry) = guard.get(entry_id) else {
            return Ok(None);
        };
        if entry.model_id == model_id
            && entry.embedding_dim == embedding_dim
            && entry.chunker_version == chunker_version
        {
            return Ok(Some(entry.chunk.clone()));
        }
        guard.remove(entry_id);
        Ok(None)
    }

    pub fn put(
        &self,
        entry_id: String,
        model_id: String,
        embedding_dim: usize,
        chunker_version: String,
        chunk: Arc<CodexCachedChunk>,
    ) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("codex search cache lock poisoned: {e}"))?;
        guard.insert(
            entry_id,
            CacheEntry {
                model_id,
                embedding_dim,
                chunker_version,
                chunk,
            },
        );
        Ok(())
    }

    /// entry_id 単位の無効化。`codex_index_entry` 成功後に呼ぶ。
    pub fn invalidate(&self, entry_id: &str) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("codex search cache lock poisoned: {e}"))?;
        guard.remove(entry_id);
        Ok(())
    }

    /// 全消去。workspace 切替時に呼ぶ。
    pub fn clear(&self) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("codex search cache lock poisoned: {e}"))?;
        guard.clear();
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.len()).unwrap_or(0)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB 読み出し
// ─────────────────────────────────────────────────────────────────────────────

/// 指定 project 配下で現行 model/dim/version に一致する codex_chunks を持つ
/// entry_id 一覧。**ここで `ce.project_id = ?` を効かせるのが XPROJ ガードの正本**。
pub fn list_indexed_codex_entry_ids(
    db: &Database,
    project_id: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cc.entry_id
             FROM codex_chunks cc
             JOIN codex_entries ce ON ce.id = cc.entry_id
             WHERE ce.project_id = ?
               AND cc.model_id = ?
               AND cc.embedding_dim = ?
               AND cc.chunker_version = ?",
        )?;
        let rows = stmt.query_map(
            params![project_id, model_id, embedding_dim as i64, chunker_version],
            |row| row.get::<_, String>(0),
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// 1 entry の codex_chunk を読む。`model_id` / `embedding_dim` /
/// `chunker_version` が現行一致のときのみ。BLOB は f32 LE flat → `Vec<f32>`。
pub fn load_codex_chunk_from_db(
    db: &Database,
    entry_id: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Option<CodexCachedChunk>> {
    db.with_conn(|conn| {
        let row = conn
            .query_row(
                "SELECT cc.entry_name, cc.entry_type, COALESCE(ce.summary, ''), cc.embedding
                 FROM codex_chunks cc
                 JOIN codex_entries ce ON ce.id = cc.entry_id
                 WHERE cc.entry_id = ?
                   AND cc.model_id = ?
                   AND cc.embedding_dim = ?
                   AND cc.chunker_version = ?",
                params![entry_id, model_id, embedding_dim as i64, chunker_version],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                    ))
                },
            )
            .ok();

        let Some((entry_name, entry_type, summary, bytes)) = row else {
            return Ok(None);
        };

        let expected = embedding_dim * 4;
        if bytes.len() != expected {
            return Err(anyhow!(
                "entry_id={entry_id} embedding bytes {} != dim {} * 4 = {}",
                bytes.len(),
                embedding_dim,
                expected
            ));
        }
        let mut embedding = Vec::with_capacity(embedding_dim);
        for i in 0..embedding_dim {
            let off = i * 4;
            embedding.push(f32::from_le_bytes([
                bytes[off],
                bytes[off + 1],
                bytes[off + 2],
                bytes[off + 3],
            ]));
        }
        Ok(Some(CodexCachedChunk {
            entry_id: entry_id.to_string(),
            entry_name,
            entry_type,
            summary,
            embedding,
        }))
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// オーケストレーション
// ─────────────────────────────────────────────────────────────────────────────

/// codex 検索本体。`query_embedding` は呼び出し側で算出する (Embedder 経由)。
///
/// 1. project 配下で現行識別子に一致する entry_id 群を取得 (XPROJ scope)
/// 2. 各 entry を cache から取る or DB load してキャッシュ
/// 3. 全ベクトルをスコアリング (ドット積 = cosine)
/// 4. 降順 sort → Top-K
/// 5. `CodexSearchHit` に変換して返す
#[allow(clippy::too_many_arguments)]
pub fn run_codex_search(
    db: &Database,
    cache: &CodexSearchCache,
    query_embedding: &[f32],
    project_id: &str,
    limit: usize,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Vec<CodexSearchHit>> {
    if query_embedding.len() != embedding_dim {
        return Err(anyhow!(
            "query_embedding dim {} != configured embedding_dim {}",
            query_embedding.len(),
            embedding_dim
        ));
    }
    if limit == 0 {
        return Ok(Vec::new());
    }

    let entry_ids =
        list_indexed_codex_entry_ids(db, project_id, model_id, embedding_dim, chunker_version)?;

    let mut chunks: Vec<Arc<CodexCachedChunk>> = Vec::with_capacity(entry_ids.len());
    for entry_id in &entry_ids {
        let arc = match cache.get(entry_id, model_id, embedding_dim, chunker_version)? {
            Some(a) => a,
            None => {
                match load_codex_chunk_from_db(
                    db,
                    entry_id,
                    model_id,
                    embedding_dim,
                    chunker_version,
                )? {
                    Some(chunk) => {
                        let arc = Arc::new(chunk);
                        cache.put(
                            entry_id.clone(),
                            model_id.to_string(),
                            embedding_dim,
                            chunker_version.to_string(),
                            arc.clone(),
                        )?;
                        arc
                    }
                    None => continue,
                }
            }
        };
        chunks.push(arc);
    }

    let mut scored: Vec<(f32, &CodexCachedChunk)> = Vec::new();
    for chunk in &chunks {
        if chunk.embedding.len() != query_embedding.len() {
            continue;
        }
        let score = dot_product(query_embedding, &chunk.embedding);
        scored.push((score, chunk));
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);

    Ok(scored
        .into_iter()
        .map(|(score, chunk)| CodexSearchHit {
            entry_id: chunk.entry_id.clone(),
            entry_name: chunk.entry_name.clone(),
            entry_type: chunk.entry_type.clone(),
            summary: chunk.summary.clone(),
            score,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::codex_index::{read_codex_for_index, upsert_codex_chunk};
    use std::path::Path;

    const MODEL_ID: &str = "test/model";
    const VER: &str = "test-chunker-v1";

    fn mem_db() -> Database {
        let db = Database::new(Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db
    }

    fn seed_codex(db: &Database, project_id: &str, entry_id: &str, name: &str, summary: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO projects (id, title, language) VALUES (?, 'test', 'ja')",
                params![project_id],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO codex_types (id, project_id, slug, label) VALUES (?, ?, 'character', 'character')",
                params![format!("{project_id}:character"), project_id],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, content, created_at, updated_at)
                 VALUES (?, ?, 'character', ?, ?, '{}', datetime('now'), datetime('now'))",
                params![entry_id, project_id, name, summary],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn unit_vec(dim: usize, hot: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; dim];
        v[hot] = 1.0;
        v
    }

    /// vec を L2 正規化して LE bytes に。
    fn le_bytes(vec: &[f32]) -> Vec<u8> {
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        let mut bytes = Vec::with_capacity(vec.len() * 4);
        for f in vec {
            let n = if norm > f32::EPSILON { f / norm } else { *f };
            bytes.extend_from_slice(&n.to_le_bytes());
        }
        bytes
    }

    /// entry を index する (実 hash を通す)。
    fn index_entry(db: &Database, entry_id: &str, dim: usize, vec: &[f32], model: &str, ver: &str) {
        let (text, hash) = read_codex_for_index(db, entry_id).unwrap().unwrap();
        let outcome =
            upsert_codex_chunk(db, entry_id, &hash, &le_bytes(vec), &text, model, dim, ver)
                .unwrap();
        assert!(matches!(
            outcome,
            crate::semantic::codex_index::CodexUpsertOutcome::Indexed(1)
        ));
    }

    #[test]
    fn run_codex_search_ranks_by_cosine() {
        let db = mem_db();
        let dim = 8;
        seed_codex(&db, "p1", "c0", "Zero", "s0");
        seed_codex(&db, "p1", "c1", "One", "s1");
        seed_codex(&db, "p1", "c2", "Two", "s2");
        index_entry(&db, "c0", dim, &unit_vec(dim, 0), MODEL_ID, VER);
        index_entry(&db, "c1", dim, &unit_vec(dim, 1), MODEL_ID, VER);
        index_entry(&db, "c2", dim, &unit_vec(dim, 2), MODEL_ID, VER);

        let cache = CodexSearchCache::new();
        // クエリは次元1に揃える → c1 が最上位。
        let q = unit_vec(dim, 1);
        let hits = run_codex_search(&db, &cache, &q, "p1", 10, MODEL_ID, dim, VER).unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].entry_id, "c1");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn run_codex_search_top_k_limit() {
        let db = mem_db();
        let dim = 8;
        for i in 0..5 {
            let id = format!("c{i}");
            seed_codex(&db, "p1", &id, &format!("N{i}"), "s");
            index_entry(&db, &id, dim, &unit_vec(dim, i), MODEL_ID, VER);
        }
        let cache = CodexSearchCache::new();
        let hits =
            run_codex_search(&db, &cache, &unit_vec(dim, 0), "p1", 2, MODEL_ID, dim, VER).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn run_codex_search_rejects_query_dim_mismatch() {
        let db = mem_db();
        let cache = CodexSearchCache::new();
        let r = run_codex_search(&db, &cache, &[0.0; 4], "p1", 10, MODEL_ID, 8, VER);
        assert!(r.is_err(), "query dim != configured dim must error");
    }

    #[test]
    fn run_codex_search_limit_zero_is_empty() {
        let db = mem_db();
        let cache = CodexSearchCache::new();
        let hits = run_codex_search(&db, &cache, &[0.0; 8], "p1", 0, MODEL_ID, 8, VER).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn load_filters_by_model_id() {
        let db = mem_db();
        let dim = 8;
        seed_codex(&db, "p1", "c1", "One", "s1");
        index_entry(&db, "c1", dim, &unit_vec(dim, 1), "old/model", VER);
        // 現行 model では list に出ない。
        let ids = list_indexed_codex_entry_ids(&db, "p1", MODEL_ID, dim, VER).unwrap();
        assert!(ids.is_empty());
        let ids_old = list_indexed_codex_entry_ids(&db, "p1", "old/model", dim, VER).unwrap();
        assert_eq!(ids_old, vec!["c1".to_string()]);
    }

    #[test]
    fn codex_search_scopes_to_project() {
        // XPROJ: p2 の entry は p1 の検索結果に出てはならない。
        let db = mem_db();
        let dim = 8;
        seed_codex(&db, "p1", "c1", "InP1", "s1");
        seed_codex(&db, "p2", "c2", "InP2", "s2");
        // 同じベクトルで両方を index (クエリと完全一致)。
        index_entry(&db, "c1", dim, &unit_vec(dim, 3), MODEL_ID, VER);
        index_entry(&db, "c2", dim, &unit_vec(dim, 3), MODEL_ID, VER);

        let cache = CodexSearchCache::new();
        let hits =
            run_codex_search(&db, &cache, &unit_vec(dim, 3), "p1", 10, MODEL_ID, dim, VER).unwrap();
        assert_eq!(hits.len(), 1, "only p1 entries");
        assert_eq!(hits[0].entry_id, "c1");
    }

    #[test]
    fn cache_returns_stale_miss_on_model_change() {
        let cache = CodexSearchCache::new();
        let chunk = Arc::new(CodexCachedChunk {
            entry_id: "c1".into(),
            entry_name: "n".into(),
            entry_type: "character".into(),
            summary: "s".into(),
            embedding: vec![1.0, 0.0],
        });
        cache
            .put("c1".into(), "m1".into(), 2, "v1".into(), chunk)
            .unwrap();
        // 一致 → hit
        assert!(cache.get("c1", "m1", 2, "v1").unwrap().is_some());
        // model 変化 → miss + 除去
        assert!(cache.get("c1", "m2", 2, "v1").unwrap().is_none());
        assert!(cache.get("c1", "m1", 2, "v1").unwrap().is_none());
    }
}
