//! Chat episodic recall の検索実行系: codex の `codex_search.rs` を
//! 「1 メッセージ 1 ベクトル・効果信号付き・project_id 非正規化」にフォークした版。
//!
//! - `ChatSearchCache`: message_id 単位の in-memory 埋め込みキャッシュ。codex の
//!   `CodexSearchCache` と同じ stale ガード (model_id / embedding_dim /
//!   chunker_version)。
//! - `load_chat_chunk_from_db`: `chat_message_chunks` の 1 行を読む。text / signal /
//!   session/role は全て同表に非正規化済みなので JOIN 不要。
//! - `run_chat_search`: pure logic。**生 cosine と signal 列をそのまま返す**。
//!   「効いた発話」の重み付け (signals × cosine) と gate/floor は JS 側 chatRecall に
//!   寄せ、閾値ロジックを 1 箇所に集約する (scene/codex の選別と同じ哲学)。
//! - スコアは `crate::search::dot_product` を流用 (正規化済み → cosine)。
//!   project スコープは `list_indexed_chat_message_ids` の `project_id = ?` が正本。

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::search::dot_product;
use grimodex_db::Database;

/// in-memory に保持される 1 メッセージのベクトル + 表示メタ + 効果信号。
#[derive(Debug, Clone)]
pub struct ChatCachedChunk {
    pub message_id: String,
    pub session_id: String,
    pub role: String,
    pub text: String,
    pub inserted_to_editor: bool,
    pub extracted_count: i64,
    pub embedding: Vec<f32>,
}

/// 検索結果 1 件。frontend (chatRecall) へ JSON で返す。生 cosine を `score` に、
/// 重み付けの材料 (role / inserted_to_editor / extracted_count) を併せて返す。
/// JSON 形: `{ messageId, sessionId, role, text, insertedToEditor, extractedCount, score }`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchHit {
    pub message_id: String,
    pub session_id: String,
    pub role: String,
    pub text: String,
    pub inserted_to_editor: bool,
    pub extracted_count: i64,
    pub score: f32,
}

/// message_id 単位のキャッシュエントリ。識別子が現行と一致するときだけ hit。
#[derive(Debug, Clone)]
struct CacheEntry {
    model_id: String,
    embedding_dim: usize,
    chunker_version: String,
    chunk: Arc<ChatCachedChunk>,
    /// LRU 用。最後にアクセスした時点の tick。
    last_used: u64,
}

/// キャッシュ保持数の上限。1 エントリ ≒ 埋め込み f32×256-384 (~1-1.5KB) + メタ
/// なので 2048 件でも数 MB に収まる。超過時は最終アクセスが最も古いものを 1 件
/// evict する (codexCrossMentions の LRU 上限 64 と同じ方針の Rust 簡易版)。
const CACHE_CAPACITY: usize = 2048;

struct CacheInner {
    map: HashMap<String, CacheEntry>,
    /// 単調アクセスカウンタ。get/put のたびに進める。
    tick: u64,
}

/// message_id → キャッシュエントリ (容量上限つき LRU)。`Mutex` は std
/// (spawn_blocking 内で使う)。
pub struct ChatSearchCache {
    inner: Mutex<CacheInner>,
    capacity: usize,
}

impl Default for ChatSearchCache {
    fn default() -> Self {
        Self::with_capacity(CACHE_CAPACITY)
    }
}

impl ChatSearchCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// テストで上限を差し替えるためのコンストラクタ。
    fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(CacheInner {
                map: HashMap::new(),
                tick: 0,
            }),
            capacity,
        }
    }

    pub fn get(
        &self,
        message_id: &str,
        model_id: &str,
        embedding_dim: usize,
        chunker_version: &str,
    ) -> Result<Option<Arc<ChatCachedChunk>>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("chat search cache lock poisoned: {e}"))?;
        guard.tick += 1;
        let tick = guard.tick;
        let Some(entry) = guard.map.get_mut(message_id) else {
            return Ok(None);
        };
        if entry.model_id == model_id
            && entry.embedding_dim == embedding_dim
            && entry.chunker_version == chunker_version
        {
            entry.last_used = tick;
            return Ok(Some(entry.chunk.clone()));
        }
        guard.map.remove(message_id);
        Ok(None)
    }

    pub fn put(
        &self,
        message_id: String,
        model_id: String,
        embedding_dim: usize,
        chunker_version: String,
        chunk: Arc<ChatCachedChunk>,
    ) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("chat search cache lock poisoned: {e}"))?;
        guard.tick += 1;
        let last_used = guard.tick;
        guard.map.insert(
            message_id,
            CacheEntry {
                model_id,
                embedding_dim,
                chunker_version,
                chunk,
                last_used,
            },
        );
        if guard.map.len() > self.capacity {
            if let Some(oldest) = guard
                .map
                .iter()
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone())
            {
                guard.map.remove(&oldest);
            }
        }
        Ok(())
    }

    /// message_id 単位の無効化。`chat_index_message` 成功後に呼ぶ。
    pub fn invalidate(&self, message_id: &str) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("chat search cache lock poisoned: {e}"))?;
        guard.map.remove(message_id);
        Ok(())
    }

    /// 全消去。workspace 切替時に呼ぶ。
    pub fn clear(&self) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("chat search cache lock poisoned: {e}"))?;
        guard.map.clear();
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.map.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB 読み出し
// ─────────────────────────────────────────────────────────────────────────────

/// 指定 project 配下で現行 model/dim/version に一致する chat_message_chunks を持つ
/// message_id 一覧。**ここで `project_id = ?` を効かせるのが XPROJ ガードの正本**。
/// project_id は非正規化済みなので JOIN 不要。
pub fn list_indexed_chat_message_ids(
    db: &Database,
    project_id: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT message_id
             FROM chat_message_chunks
             WHERE project_id = ?
               AND model_id = ?
               AND embedding_dim = ?
               AND chunker_version = ?",
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

/// 1 メッセージの chat_message_chunk を読む。`model_id` / `embedding_dim` /
/// `chunker_version` が現行一致のときのみ。BLOB は f32 LE flat → `Vec<f32>`。
pub fn load_chat_chunk_from_db(
    db: &Database,
    message_id: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Option<ChatCachedChunk>> {
    db.with_conn(|conn| {
        let row = conn
            .query_row(
                "SELECT session_id, role, text, inserted_to_editor, extracted_count, embedding
                 FROM chat_message_chunks
                 WHERE message_id = ?
                   AND model_id = ?
                   AND embedding_dim = ?
                   AND chunker_version = ?",
                params![message_id, model_id, embedding_dim as i64, chunker_version],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Vec<u8>>(5)?,
                    ))
                },
            )
            .ok();

        let Some((session_id, role, text, inserted, extracted, bytes)) = row else {
            return Ok(None);
        };

        let expected = embedding_dim * 4;
        if bytes.len() != expected {
            return Err(anyhow!(
                "message_id={message_id} embedding bytes {} != dim {} * 4 = {}",
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
        Ok(Some(ChatCachedChunk {
            message_id: message_id.to_string(),
            session_id,
            role,
            text,
            inserted_to_editor: inserted != 0,
            extracted_count: extracted,
            embedding,
        }))
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// オーケストレーション
// ─────────────────────────────────────────────────────────────────────────────

/// chat 検索本体。`query_embedding` は呼び出し側で算出する (Embedder 経由)。
///
/// 1. project 配下で現行識別子に一致する message_id 群を取得 (XPROJ scope)
/// 2. 各 message を cache から取る or DB load してキャッシュ
/// 3. 全ベクトルをスコアリング (ドット積 = cosine)
/// 4. 降順 sort → Top-K
/// 5. `ChatSearchHit` に変換 (生 cosine + signal) して返す。重み付けは JS 側。
#[allow(clippy::too_many_arguments)]
pub fn run_chat_search(
    db: &Database,
    cache: &ChatSearchCache,
    query_embedding: &[f32],
    project_id: &str,
    limit: usize,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Vec<ChatSearchHit>> {
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

    let message_ids =
        list_indexed_chat_message_ids(db, project_id, model_id, embedding_dim, chunker_version)?;

    let mut chunks: Vec<Arc<ChatCachedChunk>> = Vec::with_capacity(message_ids.len());
    for message_id in &message_ids {
        let arc = match cache.get(message_id, model_id, embedding_dim, chunker_version)? {
            Some(a) => a,
            None => {
                match load_chat_chunk_from_db(
                    db,
                    message_id,
                    model_id,
                    embedding_dim,
                    chunker_version,
                )? {
                    Some(chunk) => {
                        let arc = Arc::new(chunk);
                        cache.put(
                            message_id.clone(),
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

    let mut scored: Vec<(f32, &ChatCachedChunk)> = Vec::new();
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
        .map(|(score, chunk)| ChatSearchHit {
            message_id: chunk.message_id.clone(),
            session_id: chunk.session_id.clone(),
            role: chunk.role.clone(),
            text: chunk.text.clone(),
            inserted_to_editor: chunk.inserted_to_editor,
            extracted_count: chunk.extracted_count,
            score,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_index::{read_chat_message_for_index, upsert_chat_chunk};
    use std::path::Path;

    const MODEL_ID: &str = "test/model";
    const VER: &str = "test-chunker-v1";

    fn mem_db() -> Database {
        let db = Database::new(Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db
    }

    fn seed_message(
        db: &Database,
        project_id: &str,
        session_id: &str,
        message_id: &str,
        role: &str,
        content: &str,
        metadata: Option<&str>,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO projects (id, title, language) VALUES (?, 'test', 'ja')",
                params![project_id],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO chat_sessions (id, project_id, title, created_at, updated_at)
                 VALUES (?, ?, 'test', datetime('now'), datetime('now'))",
                params![session_id, project_id],
            )?;
            conn.execute(
                "INSERT INTO chat_messages (id, session_id, role, content, metadata, created_at)
                 VALUES (?, ?, ?, ?, ?, datetime('now'))",
                params![message_id, session_id, role, content, metadata],
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

    fn le_bytes(vec: &[f32]) -> Vec<u8> {
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        let mut bytes = Vec::with_capacity(vec.len() * 4);
        for f in vec {
            let n = if norm > f32::EPSILON { f / norm } else { *f };
            bytes.extend_from_slice(&n.to_le_bytes());
        }
        bytes
    }

    fn index_message(
        db: &Database,
        message_id: &str,
        dim: usize,
        vec: &[f32],
        model: &str,
        ver: &str,
    ) {
        let input = read_chat_message_for_index(db, message_id)
            .unwrap()
            .unwrap();
        let outcome = upsert_chat_chunk(
            db,
            message_id,
            &input.hash,
            &le_bytes(vec),
            &input.text,
            model,
            dim,
            ver,
        )
        .unwrap();
        assert!(matches!(
            outcome,
            crate::chat_index::ChatUpsertOutcome::Indexed(1)
        ));
    }

    #[test]
    fn run_chat_search_ranks_by_cosine() {
        let db = mem_db();
        let dim = 8;
        seed_message(&db, "p1", "s1", "m0", "user", "zero", None);
        seed_message(&db, "p1", "s1", "m1", "user", "one", None);
        seed_message(&db, "p1", "s1", "m2", "assistant", "two", None);
        index_message(&db, "m0", dim, &unit_vec(dim, 0), MODEL_ID, VER);
        index_message(&db, "m1", dim, &unit_vec(dim, 1), MODEL_ID, VER);
        index_message(&db, "m2", dim, &unit_vec(dim, 2), MODEL_ID, VER);

        let cache = ChatSearchCache::new();
        let q = unit_vec(dim, 1);
        let hits = run_chat_search(&db, &cache, &q, "p1", 10, MODEL_ID, dim, VER).unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].message_id, "m1");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn run_chat_search_returns_signals_and_role() {
        let db = mem_db();
        let dim = 8;
        seed_message(
            &db,
            "p1",
            "s1",
            "m1",
            "assistant",
            "効いた",
            Some(r#"{"insertedToEditor":true,"extractedCodex":["a","b"]}"#),
        );
        index_message(&db, "m1", dim, &unit_vec(dim, 1), MODEL_ID, VER);
        let cache = ChatSearchCache::new();
        let hits =
            run_chat_search(&db, &cache, &unit_vec(dim, 1), "p1", 10, MODEL_ID, dim, VER).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].role, "assistant");
        assert_eq!(hits[0].session_id, "s1");
        assert!(hits[0].inserted_to_editor);
        assert_eq!(hits[0].extracted_count, 2);
        assert_eq!(hits[0].text, "効いた");
    }

    #[test]
    fn run_chat_search_top_k_limit() {
        let db = mem_db();
        let dim = 8;
        for i in 0..5 {
            let id = format!("m{i}");
            seed_message(&db, "p1", "s1", &id, "user", &format!("n{i}"), None);
            index_message(&db, &id, dim, &unit_vec(dim, i), MODEL_ID, VER);
        }
        let cache = ChatSearchCache::new();
        let hits =
            run_chat_search(&db, &cache, &unit_vec(dim, 0), "p1", 2, MODEL_ID, dim, VER).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn run_chat_search_rejects_query_dim_mismatch() {
        let db = mem_db();
        let cache = ChatSearchCache::new();
        let r = run_chat_search(&db, &cache, &[0.0; 4], "p1", 10, MODEL_ID, 8, VER);
        assert!(r.is_err(), "query dim != configured dim must error");
    }

    #[test]
    fn run_chat_search_limit_zero_is_empty() {
        let db = mem_db();
        let cache = ChatSearchCache::new();
        let hits = run_chat_search(&db, &cache, &[0.0; 8], "p1", 0, MODEL_ID, 8, VER).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn load_filters_by_model_id() {
        let db = mem_db();
        let dim = 8;
        seed_message(&db, "p1", "s1", "m1", "user", "one", None);
        index_message(&db, "m1", dim, &unit_vec(dim, 1), "old/model", VER);
        let ids = list_indexed_chat_message_ids(&db, "p1", MODEL_ID, dim, VER).unwrap();
        assert!(ids.is_empty());
        let ids_old = list_indexed_chat_message_ids(&db, "p1", "old/model", dim, VER).unwrap();
        assert_eq!(ids_old, vec!["m1".to_string()]);
    }

    #[test]
    fn chat_search_scopes_to_project() {
        // XPROJ: p2 のメッセージは p1 の検索結果に出てはならない。
        let db = mem_db();
        let dim = 8;
        seed_message(&db, "p1", "s1", "m1", "user", "in p1", None);
        seed_message(&db, "p2", "s2", "m2", "user", "in p2", None);
        index_message(&db, "m1", dim, &unit_vec(dim, 3), MODEL_ID, VER);
        index_message(&db, "m2", dim, &unit_vec(dim, 3), MODEL_ID, VER);

        let cache = ChatSearchCache::new();
        let hits =
            run_chat_search(&db, &cache, &unit_vec(dim, 3), "p1", 10, MODEL_ID, dim, VER).unwrap();
        assert_eq!(hits.len(), 1, "only p1 messages");
        assert_eq!(hits[0].message_id, "m1");
    }

    #[test]
    fn cache_evicts_least_recently_used_over_capacity() {
        let cache = ChatSearchCache::with_capacity(2);
        let chunk = |id: &str| {
            Arc::new(ChatCachedChunk {
                message_id: id.into(),
                session_id: "s1".into(),
                role: "user".into(),
                text: "t".into(),
                inserted_to_editor: false,
                extracted_count: 0,
                embedding: vec![1.0, 0.0],
            })
        };
        cache
            .put("a".into(), "m".into(), 2, "v".into(), chunk("a"))
            .unwrap();
        cache
            .put("b".into(), "m".into(), 2, "v".into(), chunk("b"))
            .unwrap();
        // a に触れて recency を上げる → 溢れたときは b が evict される。
        assert!(cache.get("a", "m", 2, "v").unwrap().is_some());
        cache
            .put("c".into(), "m".into(), 2, "v".into(), chunk("c"))
            .unwrap();
        assert_eq!(cache.len(), 2);
        assert!(
            cache.get("b", "m", 2, "v").unwrap().is_none(),
            "LRU evicted"
        );
        assert!(cache.get("a", "m", 2, "v").unwrap().is_some());
        assert!(cache.get("c", "m", 2, "v").unwrap().is_some());
    }

    #[test]
    fn cache_returns_stale_miss_on_model_change() {
        let cache = ChatSearchCache::new();
        let chunk = Arc::new(ChatCachedChunk {
            message_id: "m1".into(),
            session_id: "s1".into(),
            role: "user".into(),
            text: "t".into(),
            inserted_to_editor: false,
            extracted_count: 0,
            embedding: vec![1.0, 0.0],
        });
        cache
            .put("m1".into(), "m1mid".into(), 2, "v1".into(), chunk)
            .unwrap();
        assert!(cache.get("m1", "m1mid", 2, "v1").unwrap().is_some());
        assert!(cache.get("m1", "m2mid", 2, "v1").unwrap().is_none());
        assert!(cache.get("m1", "m1mid", 2, "v1").unwrap().is_none());
    }
}
