//! Chronicle event セマンティック検索の実行系 (Phase 3): codex の
//! `codex_search.rs` を「作中年表の出来事」用にフォークした版。dense のみ
//! (FTS hybrid なし・減点なし)。
//!
//! - `EventsSearchCache`: event_id 単位の in-memory 埋め込みキャッシュ。
//!   `Arc<EventsCachedChunk>` を保持し、ロック保持を短くする。codex の
//!   `CodexSearchCache` と同じ stale ガード (model_id / embedding_dim /
//!   chunker_version)。
//! - `load_event_chunk_from_db`: `event_chunks` から 1 event のベクトル +
//!   title/kind を取得。**project スコープは `list_indexed_event_ids` 側で
//!   効かせる** (XPROJ)。
//! - `run_events_search`: pure logic。query_embedding は呼び出し側が用意するため
//!   Embedder 非依存で `--no-default-features` でも build/test できる。
//! - スコアは `crate::semantic::search::dot_product` を流用 (正規化済み → cosine)。

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::semantic::search::dot_product;

/// in-memory に保持される 1 event のベクトル + 表示メタ。
#[derive(Debug, Clone)]
pub struct EventsCachedChunk {
    pub event_id: String,
    pub title: String,
    pub kind: String,
    pub embedding: Vec<f32>,
}

/// 検索結果 1 件。frontend (search_events) へ JSON で返す。
/// JSON 形: `{ eventId, title, kind, score }`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchHit {
    pub event_id: String,
    pub title: String,
    pub kind: String,
    pub score: f32,
}

/// event_id 単位のキャッシュエントリ。識別子が現行と一致するときだけ hit。
#[derive(Debug, Clone)]
struct CacheEntry {
    model_id: String,
    embedding_dim: usize,
    chunker_version: String,
    chunk: Arc<EventsCachedChunk>,
}

/// event_id → キャッシュエントリ。`Mutex` は std (spawn_blocking 内で使う)。
pub struct EventsSearchCache {
    inner: Mutex<HashMap<String, CacheEntry>>,
}

impl Default for EventsSearchCache {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl EventsSearchCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(
        &self,
        event_id: &str,
        model_id: &str,
        embedding_dim: usize,
        chunker_version: &str,
    ) -> Result<Option<Arc<EventsCachedChunk>>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("events search cache lock poisoned: {e}"))?;
        let Some(entry) = guard.get(event_id) else {
            return Ok(None);
        };
        if entry.model_id == model_id
            && entry.embedding_dim == embedding_dim
            && entry.chunker_version == chunker_version
        {
            return Ok(Some(entry.chunk.clone()));
        }
        guard.remove(event_id);
        Ok(None)
    }

    pub fn put(
        &self,
        event_id: String,
        model_id: String,
        embedding_dim: usize,
        chunker_version: String,
        chunk: Arc<EventsCachedChunk>,
    ) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("events search cache lock poisoned: {e}"))?;
        guard.insert(
            event_id,
            CacheEntry {
                model_id,
                embedding_dim,
                chunker_version,
                chunk,
            },
        );
        Ok(())
    }

    /// event_id 単位の無効化。`events_index_entry` 成功後に呼ぶ。
    pub fn invalidate(&self, event_id: &str) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("events search cache lock poisoned: {e}"))?;
        guard.remove(event_id);
        Ok(())
    }

    /// 全消去。workspace 切替時に呼ぶ。
    pub fn clear(&self) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("events search cache lock poisoned: {e}"))?;
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

/// 指定 project 配下で現行 model/dim/version に一致する event_chunks を持つ
/// event_id 一覧。**ここで `e.project_id = ?` を効かせるのが XPROJ ガードの正本**。
pub fn list_indexed_event_ids(
    db: &Database,
    project_id: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT ec.event_id
             FROM event_chunks ec
             JOIN events e ON e.id = ec.event_id
             WHERE e.project_id = ?
               AND ec.model_id = ?
               AND ec.embedding_dim = ?
               AND ec.chunker_version = ?",
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

/// 1 event の event_chunk を読む。`model_id` / `embedding_dim` /
/// `chunker_version` が現行一致のときのみ。BLOB は f32 LE flat → `Vec<f32>`。
pub fn load_event_chunk_from_db(
    db: &Database,
    event_id: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Option<EventsCachedChunk>> {
    db.with_conn(|conn| {
        let row = conn
            .query_row(
                "SELECT ec.event_title, ec.event_kind, ec.embedding
                 FROM event_chunks ec
                 WHERE ec.event_id = ?
                   AND ec.model_id = ?
                   AND ec.embedding_dim = ?
                   AND ec.chunker_version = ?",
                params![event_id, model_id, embedding_dim as i64, chunker_version],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .ok();

        let Some((title, kind, bytes)) = row else {
            return Ok(None);
        };

        let expected = embedding_dim * 4;
        if bytes.len() != expected {
            return Err(anyhow!(
                "event_id={event_id} embedding bytes {} != dim {} * 4 = {}",
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
        Ok(Some(EventsCachedChunk {
            event_id: event_id.to_string(),
            title,
            kind,
            embedding,
        }))
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// オーケストレーション
// ─────────────────────────────────────────────────────────────────────────────

/// event 検索本体。`query_embedding` は呼び出し側で算出する (Embedder 経由)。
///
/// 1. project 配下で現行識別子に一致する event_id 群を取得 (XPROJ scope)
/// 2. 各 event を cache から取る or DB load してキャッシュ
/// 3. 全ベクトルをスコアリング (ドット積 = cosine)
/// 4. 降順 sort → Top-K
/// 5. `EventSearchHit` に変換して返す
#[allow(clippy::too_many_arguments)]
pub fn run_events_search(
    db: &Database,
    cache: &EventsSearchCache,
    query_embedding: &[f32],
    project_id: &str,
    limit: usize,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Vec<EventSearchHit>> {
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

    let event_ids =
        list_indexed_event_ids(db, project_id, model_id, embedding_dim, chunker_version)?;

    let mut chunks: Vec<Arc<EventsCachedChunk>> = Vec::with_capacity(event_ids.len());
    for event_id in &event_ids {
        let arc = match cache.get(event_id, model_id, embedding_dim, chunker_version)? {
            Some(a) => a,
            None => {
                match load_event_chunk_from_db(
                    db,
                    event_id,
                    model_id,
                    embedding_dim,
                    chunker_version,
                )? {
                    Some(chunk) => {
                        let arc = Arc::new(chunk);
                        cache.put(
                            event_id.clone(),
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

    let mut scored: Vec<(f32, &EventsCachedChunk)> = Vec::new();
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
        .map(|(score, chunk)| EventSearchHit {
            event_id: chunk.event_id.clone(),
            title: chunk.title.clone(),
            kind: chunk.kind.clone(),
            score,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::events_index::{read_event_for_index, upsert_event_chunk};
    use std::path::Path;

    const MODEL_ID: &str = "test/model";
    const VER: &str = "test-chunker-v1";

    fn mem_db() -> Database {
        let db = Database::new(Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db
    }

    fn seed_event(db: &Database, project_id: &str, event_id: &str, title: &str, kind: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO projects (id, title, language) VALUES (?, 'test', 'ja')",
                params![project_id],
            )?;
            conn.execute(
                "INSERT INTO events (id, project_id, title, ordinal, kind, created_at, updated_at)
                 VALUES (?, ?, ?, 'a0', ?, datetime('now'), datetime('now'))",
                params![event_id, project_id, title, kind],
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

    /// event を index する (実 hash を通す)。
    fn index_event(db: &Database, event_id: &str, dim: usize, vec: &[f32], model: &str, ver: &str) {
        let (text, hash) = read_event_for_index(db, event_id).unwrap().unwrap();
        let outcome =
            upsert_event_chunk(db, event_id, &hash, &le_bytes(vec), &text, model, dim, ver)
                .unwrap();
        assert!(matches!(
            outcome,
            crate::semantic::events_index::EventUpsertOutcome::Indexed(1)
        ));
    }

    #[test]
    fn run_events_search_ranks_by_cosine() {
        let db = mem_db();
        let dim = 8;
        seed_event(&db, "p1", "e0", "Zero", "generic");
        seed_event(&db, "p1", "e1", "One", "generic");
        seed_event(&db, "p1", "e2", "Two", "generic");
        index_event(&db, "e0", dim, &unit_vec(dim, 0), MODEL_ID, VER);
        index_event(&db, "e1", dim, &unit_vec(dim, 1), MODEL_ID, VER);
        index_event(&db, "e2", dim, &unit_vec(dim, 2), MODEL_ID, VER);

        let cache = EventsSearchCache::new();
        let q = unit_vec(dim, 1);
        let hits = run_events_search(&db, &cache, &q, "p1", 10, MODEL_ID, dim, VER).unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].event_id, "e1");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn run_events_search_top_k_limit() {
        let db = mem_db();
        let dim = 8;
        for i in 0..5 {
            let id = format!("e{i}");
            seed_event(&db, "p1", &id, &format!("N{i}"), "generic");
            index_event(&db, &id, dim, &unit_vec(dim, i), MODEL_ID, VER);
        }
        let cache = EventsSearchCache::new();
        let hits =
            run_events_search(&db, &cache, &unit_vec(dim, 0), "p1", 2, MODEL_ID, dim, VER).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn run_events_search_rejects_query_dim_mismatch() {
        let db = mem_db();
        let cache = EventsSearchCache::new();
        let r = run_events_search(&db, &cache, &[0.0; 4], "p1", 10, MODEL_ID, 8, VER);
        assert!(r.is_err(), "query dim != configured dim must error");
    }

    #[test]
    fn run_events_search_limit_zero_is_empty() {
        let db = mem_db();
        let cache = EventsSearchCache::new();
        let hits = run_events_search(&db, &cache, &[0.0; 8], "p1", 0, MODEL_ID, 8, VER).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn load_filters_by_model_id() {
        let db = mem_db();
        let dim = 8;
        seed_event(&db, "p1", "e1", "One", "generic");
        index_event(&db, "e1", dim, &unit_vec(dim, 1), "old/model", VER);
        let ids = list_indexed_event_ids(&db, "p1", MODEL_ID, dim, VER).unwrap();
        assert!(ids.is_empty());
        let ids_old = list_indexed_event_ids(&db, "p1", "old/model", dim, VER).unwrap();
        assert_eq!(ids_old, vec!["e1".to_string()]);
    }

    #[test]
    fn events_search_scopes_to_project() {
        // XPROJ: p2 の event は p1 の検索結果に出てはならない。
        let db = mem_db();
        let dim = 8;
        seed_event(&db, "p1", "e1", "InP1", "generic");
        seed_event(&db, "p2", "e2", "InP2", "generic");
        index_event(&db, "e1", dim, &unit_vec(dim, 3), MODEL_ID, VER);
        index_event(&db, "e2", dim, &unit_vec(dim, 3), MODEL_ID, VER);

        let cache = EventsSearchCache::new();
        let hits = run_events_search(&db, &cache, &unit_vec(dim, 3), "p1", 10, MODEL_ID, dim, VER)
            .unwrap();
        assert_eq!(hits.len(), 1, "only p1 events");
        assert_eq!(hits[0].event_id, "e1");
    }

    #[test]
    fn search_returns_title_and_kind() {
        let db = mem_db();
        let dim = 8;
        seed_event(&db, "p1", "e1", "邂逅", "birth");
        index_event(&db, "e1", dim, &unit_vec(dim, 1), MODEL_ID, VER);
        let cache = EventsSearchCache::new();
        let hits = run_events_search(&db, &cache, &unit_vec(dim, 1), "p1", 10, MODEL_ID, dim, VER)
            .unwrap();
        assert_eq!(hits[0].title, "邂逅");
        assert_eq!(hits[0].kind, "birth");
    }

    #[test]
    fn cache_returns_stale_miss_on_model_change() {
        let cache = EventsSearchCache::new();
        let chunk = Arc::new(EventsCachedChunk {
            event_id: "e1".into(),
            title: "t".into(),
            kind: "generic".into(),
            embedding: vec![1.0, 0.0],
        });
        cache
            .put("e1".into(), "m1".into(), 2, "v1".into(), chunk)
            .unwrap();
        assert!(cache.get("e1", "m1", 2, "v1").unwrap().is_some());
        assert!(cache.get("e1", "m2", 2, "v1").unwrap().is_none());
        assert!(cache.get("e1", "m1", 2, "v1").unwrap().is_none());
    }
}
