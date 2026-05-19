//! Step 7: 本文セマンティック検索の実行系。
//!
//! 設計: temp/semantic-prose-search-context.md §2.4, §3.5。
//!
//! 構成:
//! - `SearchCache`: scene_id 単位の in-memory embedding キャッシュ。
//!   `Arc<Vec<CachedChunk>>` を保持し、ロック保持時間を短くする。
//! - `load_scene_chunks_from_db`: `scene_chunks` + `tree_nodes` JOIN でチャンクと
//!   scene_title をまとめて取得し、f32 LE BLOB を `Vec<f32>` に decode。
//!   `model_id` / `embedding_dim` / `chunker_version` が一致するもののみ。
//! - `run_search`: pure logic オーケストレーション。Embedder には依存しない
//!   (query embedding は呼び出し側が用意する)。これにより本ファイル全体を
//!   `--no-default-features` でも build できる。
//! - `dot_product`: ruri-v3 は L2 正規化済み出力なので、ドット積 = コサイン。
//! - `apply_dialogue_penalty`: description_mode で `dialogue_ratio > 0.6` のとき
//!   `score *= 0.85`。
//!
//! Cache 無効化:
//! - シーン re-index 成功時: `cache.invalidate(scene_id)` でその scene のエントリを除く。
//! - workspace 切替時: `cache.clear()` で全消し (`open_workspace` で実施)。

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::database::Database;

/// 1 つのチャンクが in-memory に保持される形式。`embedding` は f32 配列に decode 済み。
#[derive(Debug, Clone)]
pub struct CachedChunk {
    pub scene_id: String,
    pub scene_title: String,
    pub chunk_text: String,
    pub char_start: i64,
    pub char_end: i64,
    pub dialogue_ratio: f32,
    pub embedding: Vec<f32>,
}

/// 検索結果 1 件。frontend へ JSON で返す。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub scene_id: String,
    pub scene_title: String,
    pub chunk_text: String,
    pub char_start: i64,
    pub char_end: i64,
    pub score: f32,
    pub dialogue_ratio: f32,
}

/// scene_id 単位のキャッシュエントリ。`model_id` / `embedding_dim` /
/// `chunker_version` が現行と一致するときだけ hit とみなす。
/// アプリ更新でモデル識別子が変わっても、workspace を開き直さずに
/// 古い埋め込みベクトルを返さないためのガード。
#[derive(Debug, Clone)]
struct CacheEntry {
    model_id: String,
    embedding_dim: usize,
    chunker_version: String,
    chunks: Arc<Vec<CachedChunk>>,
}

/// scene_id → キャッシュエントリ。
///
/// `Mutex` は std (spawn_blocking 内で使うため、tokio mutex の block_on を避ける)。
/// `Arc` を返すことで、cache hit 時にロックを早期 release してから scoring を行える。
pub struct SearchCache {
    inner: Mutex<HashMap<String, CacheEntry>>,
}

impl Default for SearchCache {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl SearchCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// scene_id のキャッシュエントリを取り出す。識別子が一致しない stale エントリは
    /// ミス扱いにして除去する。
    pub fn get(
        &self,
        scene_id: &str,
        model_id: &str,
        embedding_dim: usize,
        chunker_version: &str,
    ) -> Result<Option<Arc<Vec<CachedChunk>>>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("search cache lock poisoned: {e}"))?;
        let Some(entry) = guard.get(scene_id) else {
            return Ok(None);
        };
        if entry.model_id == model_id
            && entry.embedding_dim == embedding_dim
            && entry.chunker_version == chunker_version
        {
            return Ok(Some(entry.chunks.clone()));
        }
        guard.remove(scene_id);
        Ok(None)
    }

    pub fn put(
        &self,
        scene_id: String,
        model_id: String,
        embedding_dim: usize,
        chunker_version: String,
        chunks: Arc<Vec<CachedChunk>>,
    ) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("search cache lock poisoned: {e}"))?;
        guard.insert(
            scene_id,
            CacheEntry {
                model_id,
                embedding_dim,
                chunker_version,
                chunks,
            },
        );
        Ok(())
    }

    /// scene_id 単位の無効化。`semantic_index_scene` 成功後に呼ぶ。
    pub fn invalidate(&self, scene_id: &str) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("search cache lock poisoned: {e}"))?;
        guard.remove(scene_id);
        Ok(())
    }

    /// 全エントリ消去。workspace 切替時に呼ぶ。
    pub fn clear(&self) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| anyhow!("search cache lock poisoned: {e}"))?;
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

/// 単一 scene の chunks を DB から読む。`model_id` / `embedding_dim` /
/// `chunker_version` が現行と一致する行だけ。BLOB は f32 LE flat → `Vec<f32>`。
pub fn load_scene_chunks_from_db(
    db: &Database,
    scene_id: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Vec<CachedChunk>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT sc.text, sc.char_start, sc.char_end, sc.dialogue_ratio,
                    sc.embedding, tn.title
             FROM scene_chunks sc
             JOIN tree_nodes tn ON sc.scene_id = tn.id
             WHERE sc.scene_id = ?
               AND sc.model_id = ?
               AND sc.embedding_dim = ?
               AND sc.chunker_version = ?
             ORDER BY sc.chunk_index",
        )?;
        let rows = stmt.query_map(
            params![scene_id, model_id, embedding_dim as i64, chunker_version],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, f64>(3)? as f32,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )?;
        let mut out = Vec::new();
        for r in rows {
            let (text, char_start, char_end, dialogue_ratio, embedding_bytes, title) = r?;
            let expected_bytes = embedding_dim * 4;
            if embedding_bytes.len() != expected_bytes {
                return Err(anyhow!(
                    "scene_id={scene_id} embedding bytes {} != dim {} * 4 = {}",
                    embedding_bytes.len(),
                    embedding_dim,
                    expected_bytes
                ));
            }
            let mut embedding = Vec::with_capacity(embedding_dim);
            for i in 0..embedding_dim {
                let off = i * 4;
                embedding.push(f32::from_le_bytes([
                    embedding_bytes[off],
                    embedding_bytes[off + 1],
                    embedding_bytes[off + 2],
                    embedding_bytes[off + 3],
                ]));
            }
            out.push(CachedChunk {
                scene_id: scene_id.to_string(),
                scene_title: title,
                chunk_text: text,
                char_start,
                char_end,
                dialogue_ratio,
                embedding,
            });
        }
        Ok(out)
    })
}

/// 指定 project_id 配下で、現行 model/dim/chunker_version に一致する chunks を持つ
/// scene_id 一覧を返す。`run_search` がスコープ未指定時に走査対象を決めるのに使う。
pub fn list_indexed_scene_ids(
    db: &Database,
    project_id: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT sc.scene_id
             FROM scene_chunks sc
             JOIN tree_nodes tn ON sc.scene_id = tn.id
             WHERE tn.project_id = ?
               AND sc.model_id = ?
               AND sc.embedding_dim = ?
               AND sc.chunker_version = ?",
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

// ─────────────────────────────────────────────────────────────────────────────
// スコアリング
// ─────────────────────────────────────────────────────────────────────────────

/// ruri-v3 出力は L2 正規化済みなのでドット積 = コサイン類似度。
pub fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(
        a.len(),
        b.len(),
        "dim mismatch ({} vs {})",
        a.len(),
        b.len()
    );
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// description_mode の dialogue 減点。設計: §3.5 (`score *= 0.85` if ratio > 0.6)。
pub fn apply_dialogue_penalty(score: f32, dialogue_ratio: f32, description_mode: bool) -> f32 {
    if description_mode && dialogue_ratio > 0.6 {
        score * 0.85
    } else {
        score
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// オーケストレーション
// ─────────────────────────────────────────────────────────────────────────────

/// 検索本体。`query_embedding` は呼び出し側で算出する (Embedder 経由)。
///
/// 1. scope に応じて検索対象 scene 群を決定 (scene_scope=Some → 単一 scene、
///    None → project 全 scene のうち model/dim/chunker_version 一致)
/// 2. 各 scene を cache から取る or DB から load してキャッシュ
/// 3. 全 chunks をスコアリング (ドット積 + dialogue 減点)
/// 4. 降順 sort → Top-K
/// 5. `SearchHit` に変換して返す
#[allow(clippy::too_many_arguments)]
pub fn run_search(
    db: &Database,
    cache: &SearchCache,
    query_embedding: &[f32],
    project_id: &str,
    scene_scope: Option<&str>,
    limit: usize,
    description_mode: bool,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<Vec<SearchHit>> {
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

    // 1) 検索対象 scene_id リスト
    let scene_ids: Vec<String> = match scene_scope {
        Some(s) => vec![s.to_string()],
        None => list_indexed_scene_ids(db, project_id, model_id, embedding_dim, chunker_version)?,
    };

    // 2) cache から取得 or DB load + cache put
    let mut chunk_groups: Vec<Arc<Vec<CachedChunk>>> = Vec::with_capacity(scene_ids.len());
    for scene_id in &scene_ids {
        let arc = match cache.get(scene_id, model_id, embedding_dim, chunker_version)? {
            Some(a) => a,
            None => {
                let chunks = load_scene_chunks_from_db(
                    db,
                    scene_id,
                    model_id,
                    embedding_dim,
                    chunker_version,
                )?;
                let arc = Arc::new(chunks);
                cache.put(
                    scene_id.clone(),
                    model_id.to_string(),
                    embedding_dim,
                    chunker_version.to_string(),
                    arc.clone(),
                )?;
                arc
            }
        };
        chunk_groups.push(arc);
    }

    // 3) 全 chunks を query_embedding と比較。
    //    debug_assert で dim をガードしつつ、本番は不一致 chunk を skip (古い stale)。
    let mut scored: Vec<(f32, &CachedChunk)> = Vec::new();
    for group in &chunk_groups {
        for chunk in group.iter() {
            if chunk.embedding.len() != query_embedding.len() {
                continue;
            }
            let raw = dot_product(query_embedding, &chunk.embedding);
            let adjusted = apply_dialogue_penalty(raw, chunk.dialogue_ratio, description_mode);
            scored.push((adjusted, chunk));
        }
    }

    // 4) Top-K (降順)
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);

    // 5) SearchHit へ変換
    Ok(scored
        .into_iter()
        .map(|(score, chunk)| SearchHit {
            scene_id: chunk.scene_id.clone(),
            scene_title: chunk.scene_title.clone(),
            chunk_text: chunk.chunk_text.clone(),
            char_start: chunk.char_start,
            char_end: chunk.char_end,
            score,
            dialogue_ratio: chunk.dialogue_ratio,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::index::{compute_content_hash, upsert_scene_chunks, ChunkPayload};
    use rusqlite::params;
    use std::path::Path;

    const MODEL_ID: &str = "test/model";
    const CHUNKER_VERSION: &str = "test-chunker-v1";

    fn mem_db() -> Database {
        let db = Database::new(Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('p1', 'test project')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        db
    }

    fn seed_scene(db: &Database, scene_id: &str, title: &str, content: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes (
                    id, project_id, node_type, title, sort_order, content,
                    created_at, updated_at
                ) VALUES (?, 'p1', 'scene', ?, 'a0', ?, datetime('now'), datetime('now'))",
                params![scene_id, title, content],
            )?;
            Ok(())
        })
        .unwrap();
    }

    /// f32 ベクトルを L2 正規化した上で LE bytes に変換した ChunkPayload を作る。
    fn payload_from_vec(text: &str, dialogue_ratio: f32, vec: &[f32]) -> ChunkPayload {
        let mut v = vec.to_vec();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > f32::EPSILON {
            for x in v.iter_mut() {
                *x /= norm;
            }
        }
        let mut bytes = Vec::with_capacity(v.len() * 4);
        for f in &v {
            bytes.extend_from_slice(&f.to_le_bytes());
        }
        ChunkPayload {
            text: text.to_string(),
            char_start: 0,
            char_end: text.chars().count() as i64,
            dialogue_ratio,
            embedding: bytes,
        }
    }

    fn unit_vec(dim: usize, hot: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; dim];
        v[hot] = 1.0;
        v
    }

    // ── dot_product ──────────────────────────────────────────────────────

    #[test]
    fn dot_product_basic() {
        let a = [1.0, 0.0, 0.0];
        let b = [1.0, 0.0, 0.0];
        assert_eq!(dot_product(&a, &b), 1.0);

        let c = [0.0, 1.0, 0.0];
        assert_eq!(dot_product(&a, &c), 0.0);

        let d = [-1.0, 0.0, 0.0];
        assert_eq!(dot_product(&a, &d), -1.0);
    }

    // ── apply_dialogue_penalty ───────────────────────────────────────────

    #[test]
    fn dialogue_penalty_off_when_description_mode_false() {
        let s = apply_dialogue_penalty(0.9, 0.9, false);
        assert_eq!(s, 0.9);
    }

    #[test]
    fn dialogue_penalty_off_below_threshold() {
        // ratio が 0.6 を超えなければ減点なし
        let s = apply_dialogue_penalty(0.9, 0.6, true);
        assert_eq!(s, 0.9);
    }

    #[test]
    fn dialogue_penalty_applied_above_threshold() {
        let s = apply_dialogue_penalty(0.9, 0.7, true);
        assert!((s - 0.765).abs() < 1e-5, "0.9 * 0.85 = 0.765, got {s}");
    }

    // ── SearchCache ──────────────────────────────────────────────────────

    #[test]
    fn cache_get_returns_none_for_missing() {
        let cache = SearchCache::new();
        assert!(cache
            .get("nope", MODEL_ID, 4, CHUNKER_VERSION)
            .unwrap()
            .is_none());
    }

    #[test]
    fn cache_put_get_roundtrip() {
        let cache = SearchCache::new();
        let chunks = Arc::new(vec![CachedChunk {
            scene_id: "s1".into(),
            scene_title: "Scene".into(),
            chunk_text: "text".into(),
            char_start: 0,
            char_end: 4,
            dialogue_ratio: 0.0,
            embedding: vec![0.1; 4],
        }]);
        cache
            .put(
                "s1".into(),
                MODEL_ID.to_string(),
                4,
                CHUNKER_VERSION.to_string(),
                chunks.clone(),
            )
            .unwrap();
        let got = cache
            .get("s1", MODEL_ID, 4, CHUNKER_VERSION)
            .unwrap()
            .expect("cache hit");
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn cache_misses_when_model_id_differs_and_drops_stale_entry() {
        let cache = SearchCache::new();
        cache
            .put(
                "s1".into(),
                "old/model".to_string(),
                4,
                CHUNKER_VERSION.to_string(),
                Arc::new(vec![]),
            )
            .unwrap();
        assert!(cache
            .get("s1", MODEL_ID, 4, CHUNKER_VERSION)
            .unwrap()
            .is_none());
        // stale entry は lazy remove される。
        assert!(cache
            .get("s1", "old/model", 4, CHUNKER_VERSION)
            .unwrap()
            .is_none());
    }

    #[test]
    fn cache_invalidate_removes_entry() {
        let cache = SearchCache::new();
        cache
            .put(
                "s1".into(),
                MODEL_ID.to_string(),
                4,
                CHUNKER_VERSION.to_string(),
                Arc::new(vec![]),
            )
            .unwrap();
        assert!(cache
            .get("s1", MODEL_ID, 4, CHUNKER_VERSION)
            .unwrap()
            .is_some());
        cache.invalidate("s1").unwrap();
        assert!(cache
            .get("s1", MODEL_ID, 4, CHUNKER_VERSION)
            .unwrap()
            .is_none());
    }

    #[test]
    fn cache_clear_removes_all() {
        let cache = SearchCache::new();
        cache
            .put(
                "s1".into(),
                MODEL_ID.to_string(),
                4,
                CHUNKER_VERSION.to_string(),
                Arc::new(vec![]),
            )
            .unwrap();
        cache
            .put(
                "s2".into(),
                MODEL_ID.to_string(),
                4,
                CHUNKER_VERSION.to_string(),
                Arc::new(vec![]),
            )
            .unwrap();
        assert_eq!(cache.len(), 2);
        cache.clear().unwrap();
        assert_eq!(cache.len(), 0);
    }

    // ── load_scene_chunks_from_db ────────────────────────────────────────

    #[test]
    fn load_decodes_embedding_bytes_to_f32_vec() {
        let db = mem_db();
        let content = r#"{"type":"doc"}"#;
        seed_scene(&db, "s1", "Scene One", content);
        let hash = compute_content_hash(content);
        let payload = payload_from_vec("hello", 0.0, &[1.0, 0.0, 0.0, 0.0]);
        upsert_scene_chunks(&db, "s1", &hash, &[payload], MODEL_ID, 4, CHUNKER_VERSION).unwrap();

        let chunks = load_scene_chunks_from_db(&db, "s1", MODEL_ID, 4, CHUNKER_VERSION).unwrap();
        assert_eq!(chunks.len(), 1);
        let c = &chunks[0];
        assert_eq!(c.scene_id, "s1");
        assert_eq!(c.scene_title, "Scene One");
        assert_eq!(c.chunk_text, "hello");
        // L2 normalize で (1,0,0,0) → そのまま
        assert!((c.embedding[0] - 1.0).abs() < 1e-6);
        assert_eq!(c.embedding[1..], vec![0.0; 3]);
    }

    #[test]
    fn load_filters_by_model_id() {
        let db = mem_db();
        let content = r#"{"type":"doc"}"#;
        seed_scene(&db, "s1", "Scene", content);
        let hash = compute_content_hash(content);
        let payload = payload_from_vec("a", 0.0, &[1.0, 0.0, 0.0, 0.0]);
        upsert_scene_chunks(
            &db,
            "s1",
            &hash,
            &[payload],
            "old/model",
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        let got = load_scene_chunks_from_db(&db, "s1", MODEL_ID, 4, CHUNKER_VERSION).unwrap();
        assert!(got.is_empty(), "stale model_id chunks must be filtered out");
    }

    // ── run_search ───────────────────────────────────────────────────────

    fn seed_two_scenes_with_known_vectors(db: &Database) {
        // dim=4, 各シーンに 1 チャンク。
        // s1: [1,0,0,0] (description, ratio=0.0)
        // s2: [0,1,0,0] (dialogue,    ratio=0.9)
        let content_a = r#"{"type":"doc","v":"a"}"#;
        let content_b = r#"{"type":"doc","v":"b"}"#;
        seed_scene(db, "s1", "Scene One", content_a);
        seed_scene(db, "s2", "Scene Two", content_b);
        let hash_a = compute_content_hash(content_a);
        let hash_b = compute_content_hash(content_b);
        upsert_scene_chunks(
            db,
            "s1",
            &hash_a,
            &[payload_from_vec(
                "description text",
                0.0,
                &[1.0, 0.0, 0.0, 0.0],
            )],
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        upsert_scene_chunks(
            db,
            "s2",
            &hash_b,
            &[payload_from_vec(
                "dialogue text",
                0.9,
                &[0.0, 1.0, 0.0, 0.0],
            )],
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
    }

    #[test]
    fn search_ranks_by_cosine() {
        let db = mem_db();
        let cache = SearchCache::new();
        seed_two_scenes_with_known_vectors(&db);

        // query が s1 の embedding 方向
        let query = unit_vec(4, 0);
        let hits = run_search(
            &db,
            &cache,
            &query,
            "p1",
            None,
            5,
            false,
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].scene_id, "s1");
        assert!(hits[0].score > hits[1].score);
        // s1 ベクトルとの一致なので score ≈ 1.0
        assert!((hits[0].score - 1.0).abs() < 1e-5);
        // s2 は直交なので 0.0
        assert!(hits[1].score.abs() < 1e-5);
    }

    #[test]
    fn search_top_k_limit() {
        let db = mem_db();
        let cache = SearchCache::new();
        seed_two_scenes_with_known_vectors(&db);
        let query = unit_vec(4, 0);
        let hits = run_search(
            &db,
            &cache,
            &query,
            "p1",
            None,
            1,
            false,
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].scene_id, "s1");
    }

    #[test]
    fn search_scope_filters_to_single_scene() {
        let db = mem_db();
        let cache = SearchCache::new();
        seed_two_scenes_with_known_vectors(&db);
        let query = unit_vec(4, 0);
        let hits = run_search(
            &db,
            &cache,
            &query,
            "p1",
            Some("s2"),
            5,
            false,
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].scene_id, "s2");
    }

    #[test]
    fn search_description_mode_penalizes_dialogue() {
        let db = mem_db();
        let cache = SearchCache::new();
        // s_dlg と s_pro 両方が query と高 cosine を返すよう、両方 [1,0,0,0] にする。
        // ratio: s_dlg=0.9 (dialogue), s_pro=0.0 (prose)。
        let content_a = r#"{"type":"doc","v":"a"}"#;
        let content_b = r#"{"type":"doc","v":"b"}"#;
        seed_scene(&db, "s_dlg", "Dialogue scene", content_a);
        seed_scene(&db, "s_pro", "Prose scene", content_b);
        let hash_a = compute_content_hash(content_a);
        let hash_b = compute_content_hash(content_b);
        upsert_scene_chunks(
            &db,
            "s_dlg",
            &hash_a,
            &[payload_from_vec("会話", 0.9, &[1.0, 0.0, 0.0, 0.0])],
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        upsert_scene_chunks(
            &db,
            "s_pro",
            &hash_b,
            &[payload_from_vec("地の文", 0.0, &[1.0, 0.0, 0.0, 0.0])],
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();

        let query = unit_vec(4, 0);
        // description_mode=false なら同 cosine なので順序は安定でない (両者 1.0)。
        // description_mode=true で s_dlg は 0.85 倍、s_pro は据え置きなので s_pro が上位。
        let hits = run_search(
            &db,
            &cache,
            &query,
            "p1",
            None,
            5,
            true,
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].scene_id, "s_pro");
        assert_eq!(hits[1].scene_id, "s_dlg");
        assert!(hits[0].score > hits[1].score);
        assert!((hits[1].score - 0.85).abs() < 1e-5);
    }

    #[test]
    fn search_uses_cache_on_second_call() {
        let db = mem_db();
        let cache = SearchCache::new();
        seed_two_scenes_with_known_vectors(&db);
        let query = unit_vec(4, 0);

        let _ = run_search(
            &db,
            &cache,
            &query,
            "p1",
            None,
            5,
            false,
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        assert_eq!(cache.len(), 2);

        // 2 回目: cache から取り出すルートを通る (cache がそのまま 2 件であり続けることで間接確認)
        let _ = run_search(
            &db,
            &cache,
            &query,
            "p1",
            None,
            5,
            false,
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn search_skips_zero_limit() {
        let db = mem_db();
        let cache = SearchCache::new();
        seed_two_scenes_with_known_vectors(&db);
        let query = unit_vec(4, 0);
        let hits = run_search(
            &db,
            &cache,
            &query,
            "p1",
            None,
            0,
            false,
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        )
        .unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn search_rejects_query_dim_mismatch() {
        let db = mem_db();
        let cache = SearchCache::new();
        seed_two_scenes_with_known_vectors(&db);
        let bad_query = vec![1.0f32, 0.0, 0.0]; // dim=3 ≠ 4
        let result = run_search(
            &db,
            &cache,
            &bad_query,
            "p1",
            None,
            5,
            false,
            MODEL_ID,
            4,
            CHUNKER_VERSION,
        );
        assert!(result.is_err());
    }
}
