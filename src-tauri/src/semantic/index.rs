//! Step 6: `scene_chunks` の upsert と content_hash race 検証。
//!
//! 設計: temp/semantic-prose-search-context.md §3.4, §3.5。
//!
//! 構成:
//! - pure logic (`compute_content_hash`, `upsert_scene_chunks`, `ChunkPayload`,
//!   `UpsertOutcome`): `semantic-embedding` feature 無しで build できる。
//!   `cargo test --no-default-features` で完全に検証可能。
//! - `index_scene`: チャンク化 → 埋め込み → upsert を繋ぐオーケストレーション。
//!   `Embedder` を借りるため feature gate。
//!
//! race condition 戦略:
//! - 呼び出し側 (`index_scene`) が「embed 前に scene content を読んで hash 算出」。
//! - 埋め込み中は DB lock を放す。
//! - `upsert_scene_chunks` がトランザクション内で content を再 SELECT、再 hash 計算、
//!   呼び出し側の `expected_hash` と一致しなければ `SkippedHashMismatch` で破棄。
//! - DELETE/INSERT は `unchecked_transaction()` の Drop で auto-ROLLBACK が利く。
//!
//! `--no-default-features` ビルドではコマンド配線が無く本モジュールの pub 関数群
//! が呼ばれないため crate 内 dead_code を許容する (chunker / embedding と同じ)。

#![allow(dead_code)]

use anyhow::{ensure, Result};
use rusqlite::params;
use sha2::{Digest, Sha256};

use crate::database::Database;

/// upsert の結果。チャンク数を返すか、破棄理由を返す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpsertOutcome {
    /// 投入したチャンク数 (0 件 = 空シーンを正常に同期した場合)。
    Indexed(usize),
    /// TX 開始時の content_hash が呼び出し側の expected_hash と不一致。古い job 等。
    SkippedHashMismatch,
    /// scene_id が `node_type='scene'` でない、もしくは存在しない。
    SkippedNotScene,
}

/// upsert 用の単一チャンクペイロード。`embedding` は f32 を little-endian で
/// flat 連結したバイト列。長さは `embedding_dim * 4` でなければならない。
#[derive(Debug, Clone)]
pub struct ChunkPayload {
    pub text: String,
    pub char_start: i64,
    pub char_end: i64,
    pub dialogue_ratio: f32,
    pub embedding: Vec<u8>,
}

/// 与えられた文字列の SHA-256 を hex 文字列で返す。
pub fn compute_content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

/// `scene_chunks` の DELETE + INSERT をトランザクションで行う。
///
/// TX 内で `tree_nodes.content` を再 SELECT し、`compute_content_hash` で
/// `expected_hash` と一致するか確認する。不一致なら何も書かずに
/// `SkippedHashMismatch` を返す (`Transaction` の Drop で auto-ROLLBACK)。
///
/// `payloads` が空でも、hash 一致時は DELETE は実行する (テーブル同期目的)。
pub fn upsert_scene_chunks(
    db: &Database,
    scene_id: &str,
    expected_hash: &str,
    payloads: &[ChunkPayload],
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<UpsertOutcome> {
    // 長さガード: TX 開始前に弾く。Embedder の出力サイズ揺れを silently 投入しない。
    for (i, p) in payloads.iter().enumerate() {
        ensure!(
            p.embedding.len() == embedding_dim * 4,
            "payload[{i}] embedding len {} != dim {} * 4 = {}",
            p.embedding.len(),
            embedding_dim,
            embedding_dim * 4
        );
    }

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;

        // TX 内で scene 存在 + node_type 検証 + content 再読み込み
        let current_content: Option<String> = tx
            .query_row(
                "SELECT content FROM tree_nodes WHERE id = ? AND node_type = 'scene'",
                params![scene_id],
                |row| row.get::<_, String>(0),
            )
            .ok();

        let Some(content) = current_content else {
            return Ok(UpsertOutcome::SkippedNotScene);
        };

        let current_hash = compute_content_hash(&content);
        if current_hash != expected_hash {
            return Ok(UpsertOutcome::SkippedHashMismatch);
        }

        // 旧 chunks を全削除
        tx.execute(
            "DELETE FROM scene_chunks WHERE scene_id = ?",
            params![scene_id],
        )?;

        // 新 chunks を chunk_index 順で挿入
        let now_ms = chrono::Utc::now().timestamp_millis();
        for (idx, p) in payloads.iter().enumerate() {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO scene_chunks (
                    id, scene_id, chunk_index, text, char_start, char_end,
                    dialogue_ratio, embedding, embedding_dim, model_id,
                    content_hash, chunker_version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id,
                    scene_id,
                    idx as i64,
                    p.text,
                    p.char_start,
                    p.char_end,
                    p.dialogue_ratio,
                    p.embedding.as_slice(),
                    embedding_dim as i64,
                    model_id,
                    expected_hash,
                    chunker_version,
                    now_ms,
                    now_ms,
                ],
            )?;
        }

        tx.commit()?;
        Ok(UpsertOutcome::Indexed(payloads.len()))
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// インデックス状態の集計 (Step 8)
// ─────────────────────────────────────────────────────────────────────────────

/// `semantic_index_status` Tauri command の戻り値。frontend に JSON で返す。
///
/// - `indexed_chunk_count`: project 内 scene_chunks の総件数 (model/version 不問)。
/// - `stale_chunk_count`: そのうち現行 `model_id` / `embedding_dim` / `chunker_version`
///   と不一致のもの (再インデックス対象)。
/// - `indexed_scene_count`: 何件の scene が一つでも chunk を持っているか。
/// - `current_*`: 呼び出し側 (commands/semantic.rs) が握る現行の識別子をそのまま返す。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusReport {
    pub indexed_chunk_count: usize,
    pub stale_chunk_count: usize,
    pub indexed_scene_count: usize,
    pub current_model_id: String,
    pub current_embedding_dim: usize,
    pub current_chunker_version: String,
}

/// 指定 project の scene_chunks の状態を 1 回の `with_conn` で集計する。
pub fn collect_index_status(
    db: &Database,
    project_id: &str,
    current_model_id: &str,
    current_embedding_dim: usize,
    current_chunker_version: &str,
) -> Result<IndexStatusReport> {
    db.with_conn(|conn| {
        // 全 chunks (project 配下、model/version 問わず)
        let indexed_chunk_count: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM scene_chunks sc
             JOIN tree_nodes tn ON sc.scene_id = tn.id
             WHERE tn.project_id = ?",
            params![project_id],
            |row| row.get(0),
        )?;

        // stale chunks (現行と一致しないもの)
        let stale_chunk_count: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM scene_chunks sc
             JOIN tree_nodes tn ON sc.scene_id = tn.id
             WHERE tn.project_id = ?
               AND (sc.model_id != ?
                    OR sc.embedding_dim != ?
                    OR sc.chunker_version != ?)",
            params![
                project_id,
                current_model_id,
                current_embedding_dim as i64,
                current_chunker_version,
            ],
            |row| row.get(0),
        )?;

        // chunk を持つ scene の distinct 件数
        let indexed_scene_count: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT sc.scene_id)
             FROM scene_chunks sc
             JOIN tree_nodes tn ON sc.scene_id = tn.id
             WHERE tn.project_id = ?",
            params![project_id],
            |row| row.get(0),
        )?;

        Ok(IndexStatusReport {
            indexed_chunk_count: indexed_chunk_count as usize,
            stale_chunk_count: stale_chunk_count as usize,
            indexed_scene_count: indexed_scene_count as usize,
            current_model_id: current_model_id.to_string(),
            current_embedding_dim,
            current_chunker_version: current_chunker_version.to_string(),
        })
    })
}

/// 指定 project 配下の scene (node_type='scene') の id 一覧。
/// reindex_all がイテレーション対象を取るのに使う。
pub fn list_scene_ids_in_project(db: &Database, project_id: &str) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM tree_nodes
             WHERE project_id = ? AND node_type = 'scene'
             ORDER BY sort_order",
        )?;
        let rows = stmt.query_map(params![project_id], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// オーケストレーション (Embedder を借りるため feature gate)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(feature = "semantic-embedding")]
pub fn index_scene(
    db: &Database,
    embedder: &mut crate::semantic::embedding::Embedder,
    scene_id: &str,
    model_id: &str,
) -> Result<UpsertOutcome> {
    use crate::semantic::chunker::{chunk_scene, ChunkerConfig, CHUNKER_VERSION};
    use anyhow::anyhow;

    // 1) シーン content の読み出しと initial hash 算出 (DB lock を短く保つ)
    let (content, initial_hash) = {
        let row: Option<String> = db.with_conn(|conn| {
            let v = conn
                .query_row(
                    "SELECT content FROM tree_nodes WHERE id = ? AND node_type = 'scene'",
                    params![scene_id],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            Ok(v)
        })?;
        match row {
            Some(c) => {
                let h = compute_content_hash(&c);
                (c, h)
            }
            None => return Ok(UpsertOutcome::SkippedNotScene),
        }
    };

    // 2) parse + chunk
    let doc: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| anyhow!("scene_id={scene_id} content JSON parse error: {e}"))?;
    let chunks = chunk_scene(&doc, &ChunkerConfig::default())?;

    // 3) 各チャンクを embed して LE bytes に変換
    let embedding_dim = embedder.embedding_dim();
    let mut payloads = Vec::with_capacity(chunks.len());
    for chunk in &chunks {
        let vec = embedder.embed_document(&chunk.text)?;
        ensure!(
            vec.len() == embedding_dim,
            "embedder returned {} dims, expected {}",
            vec.len(),
            embedding_dim
        );
        let mut bytes = Vec::with_capacity(embedding_dim * 4);
        for f in &vec {
            bytes.extend_from_slice(&f.to_le_bytes());
        }
        payloads.push(ChunkPayload {
            text: chunk.text.clone(),
            char_start: chunk.char_start as i64,
            char_end: chunk.char_end as i64,
            dialogue_ratio: chunk.dialogue_ratio,
            embedding: bytes,
        });
    }

    // 4) TX 内で hash 再確認しつつ upsert
    upsert_scene_chunks(
        db,
        scene_id,
        &initial_hash,
        &payloads,
        model_id,
        embedding_dim,
        CHUNKER_VERSION,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::path::Path;

    fn mem_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open mem db");
        db.migrate().expect("migrate");
        db
    }

    fn seed_project(db: &Database) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO projects (id, title) VALUES ('p1', 'test project')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn seed_scene(db: &Database, scene_id: &str, content: &str) {
        seed_project(db);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes (
                    id, project_id, node_type, title, sort_order, content,
                    created_at, updated_at
                ) VALUES (?, 'p1', 'scene', 'test scene', 'a0', ?, datetime('now'), datetime('now'))",
                params![scene_id, content],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn seed_folder(db: &Database, folder_id: &str) {
        seed_project(db);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes (
                    id, project_id, node_type, title, sort_order, content,
                    created_at, updated_at
                ) VALUES (?, 'p1', 'folder', 'test folder', 'a0', '{}', datetime('now'), datetime('now'))",
                params![folder_id],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn make_payload(dim: usize, fill: f32) -> ChunkPayload {
        let mut bytes = Vec::with_capacity(dim * 4);
        for _ in 0..dim {
            bytes.extend_from_slice(&fill.to_le_bytes());
        }
        ChunkPayload {
            text: "サンプル".to_string(),
            char_start: 0,
            char_end: 4,
            dialogue_ratio: 0.0,
            embedding: bytes,
        }
    }

    fn count_chunks(db: &Database, scene_id: &str) -> i64 {
        db.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM scene_chunks WHERE scene_id = ?",
                params![scene_id],
                |r| r.get(0),
            )?;
            Ok(n)
        })
        .unwrap()
    }

    // ── compute_content_hash ─────────────────────────────────────────────

    #[test]
    fn compute_content_hash_deterministic() {
        let a = compute_content_hash("hello");
        let b = compute_content_hash("hello");
        let c = compute_content_hash("world");
        assert_eq!(a, b);
        assert_ne!(a, c);
        // SHA-256 hex は 64 文字
        assert_eq!(a.len(), 64);
    }

    // ── upsert_scene_chunks ──────────────────────────────────────────────

    #[test]
    fn upsert_inserts_new_chunks() {
        let db = mem_db();
        let content = r#"{"type":"doc","content":[]}"#;
        seed_scene(&db, "s1", content);
        let hash = compute_content_hash(content);
        let payloads = vec![
            make_payload(8, 0.1),
            make_payload(8, 0.2),
            make_payload(8, 0.3),
        ];

        let outcome =
            upsert_scene_chunks(&db, "s1", &hash, &payloads, "test/model", 8, "chunker-vT")
                .unwrap();
        assert_eq!(outcome, UpsertOutcome::Indexed(3));

        db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT chunk_index, length(embedding), embedding_dim, model_id,
                        content_hash, chunker_version
                 FROM scene_chunks WHERE scene_id = ? ORDER BY chunk_index",
            )?;
            let rows: Vec<(i64, i64, i64, String, String, String)> = stmt
                .query_map(params!["s1"], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })?
                .collect::<Result<_, _>>()?;
            assert_eq!(rows.len(), 3);
            for (i, row) in rows.iter().enumerate() {
                assert_eq!(row.0, i as i64);
                assert_eq!(row.1, 8 * 4); // dim * sizeof(f32)
                assert_eq!(row.2, 8);
                assert_eq!(row.3, "test/model");
                assert_eq!(row.4, hash);
                assert_eq!(row.5, "chunker-vT");
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn upsert_replaces_existing_chunks() {
        let db = mem_db();
        let content = r#"{"type":"doc"}"#;
        seed_scene(&db, "s1", content);
        let hash = compute_content_hash(content);

        let first = vec![make_payload(4, 0.5); 5];
        upsert_scene_chunks(&db, "s1", &hash, &first, "m", 4, "v1").unwrap();
        assert_eq!(count_chunks(&db, "s1"), 5);

        let second = vec![make_payload(4, 0.9); 2];
        let outcome = upsert_scene_chunks(&db, "s1", &hash, &second, "m", 4, "v1").unwrap();
        assert_eq!(outcome, UpsertOutcome::Indexed(2));
        assert_eq!(count_chunks(&db, "s1"), 2);
    }

    #[test]
    fn upsert_skips_on_hash_mismatch() {
        let db = mem_db();
        let content_a = r#"{"type":"doc","v":1}"#;
        seed_scene(&db, "s1", content_a);
        let hash_a = compute_content_hash(content_a);
        upsert_scene_chunks(&db, "s1", &hash_a, &[make_payload(4, 0.1)], "m", 4, "v1").unwrap();
        assert_eq!(count_chunks(&db, "s1"), 1);

        // 並行する別 save が content を書き換えたケースを模擬
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET content = ? WHERE id = ?",
                params![r#"{"type":"doc","v":2}"#, "s1"],
            )?;
            Ok(())
        })
        .unwrap();

        // 古い hash で upsert を試みる
        let outcome = upsert_scene_chunks(
            &db,
            "s1",
            &hash_a,
            &vec![make_payload(4, 0.9); 3],
            "m",
            4,
            "v1",
        )
        .unwrap();
        assert_eq!(outcome, UpsertOutcome::SkippedHashMismatch);

        // 旧データは消えず、新データも書かれていない
        assert_eq!(count_chunks(&db, "s1"), 1);
    }

    #[test]
    fn upsert_empty_chunks_clears_existing() {
        let db = mem_db();
        let content = r#"{"type":"doc"}"#;
        seed_scene(&db, "s1", content);
        let hash = compute_content_hash(content);
        upsert_scene_chunks(
            &db,
            "s1",
            &hash,
            &vec![make_payload(4, 0.1); 3],
            "m",
            4,
            "v1",
        )
        .unwrap();
        assert_eq!(count_chunks(&db, "s1"), 3);

        let outcome = upsert_scene_chunks(&db, "s1", &hash, &[], "m", 4, "v1").unwrap();
        assert_eq!(outcome, UpsertOutcome::Indexed(0));
        assert_eq!(count_chunks(&db, "s1"), 0);
    }

    #[test]
    fn upsert_rejects_short_embedding() {
        let db = mem_db();
        seed_scene(&db, "s1", "{}");
        let bad = ChunkPayload {
            text: "x".to_string(),
            char_start: 0,
            char_end: 1,
            dialogue_ratio: 0.0,
            embedding: vec![0, 0, 0], // dim*4 = 16 を満たさない
        };
        let result =
            upsert_scene_chunks(&db, "s1", &compute_content_hash("{}"), &[bad], "m", 4, "v1");
        assert!(result.is_err(), "short embedding should be rejected");
    }

    #[test]
    fn upsert_skips_non_scene_node() {
        let db = mem_db();
        seed_folder(&db, "f1");
        let outcome = upsert_scene_chunks(&db, "f1", "anyhash", &[], "m", 4, "v1").unwrap();
        assert_eq!(outcome, UpsertOutcome::SkippedNotScene);
    }

    #[test]
    fn upsert_skips_missing_scene() {
        let db = mem_db();
        seed_project(&db);
        let outcome =
            upsert_scene_chunks(&db, "nonexistent", "anyhash", &[], "m", 4, "v1").unwrap();
        assert_eq!(outcome, UpsertOutcome::SkippedNotScene);
    }

    #[test]
    fn cascade_delete_on_scene_removal() {
        let db = mem_db();
        let content = r#"{"type":"doc"}"#;
        seed_scene(&db, "s1", content);
        let hash = compute_content_hash(content);
        upsert_scene_chunks(
            &db,
            "s1",
            &hash,
            &vec![make_payload(4, 0.1); 3],
            "m",
            4,
            "v1",
        )
        .unwrap();
        assert_eq!(count_chunks(&db, "s1"), 3);

        db.with_conn(|conn| {
            conn.execute("DELETE FROM tree_nodes WHERE id = ?", params!["s1"])?;
            Ok(())
        })
        .unwrap();

        assert_eq!(count_chunks(&db, "s1"), 0);
    }

    // ── collect_index_status / list_scene_ids_in_project (Step 8) ────────

    const CURR_MODEL: &str = "current/model";
    const CURR_DIM: usize = 4;
    const CURR_VER: &str = "current-v1";

    #[test]
    fn status_empty_project_returns_zero_counts() {
        let db = mem_db();
        seed_project(&db);
        let s = collect_index_status(&db, "p1", CURR_MODEL, CURR_DIM, CURR_VER).unwrap();
        assert_eq!(s.indexed_chunk_count, 0);
        assert_eq!(s.stale_chunk_count, 0);
        assert_eq!(s.indexed_scene_count, 0);
        assert_eq!(s.current_model_id, CURR_MODEL);
        assert_eq!(s.current_embedding_dim, CURR_DIM);
        assert_eq!(s.current_chunker_version, CURR_VER);
    }

    #[test]
    fn status_counts_indexed_and_stale_chunks() {
        let db = mem_db();
        let content_a = r#"{"a":1}"#;
        let content_b = r#"{"b":2}"#;
        seed_scene(&db, "s_curr", content_a);
        seed_scene(&db, "s_stale_model", content_b);

        // s_curr に現行 (3 chunks)、s_stale_model に古い model (2 chunks)
        upsert_scene_chunks(
            &db,
            "s_curr",
            &compute_content_hash(content_a),
            &vec![make_payload(CURR_DIM, 0.1); 3],
            CURR_MODEL,
            CURR_DIM,
            CURR_VER,
        )
        .unwrap();
        upsert_scene_chunks(
            &db,
            "s_stale_model",
            &compute_content_hash(content_b),
            &vec![make_payload(CURR_DIM, 0.2); 2],
            "old/model",
            CURR_DIM,
            CURR_VER,
        )
        .unwrap();

        let s = collect_index_status(&db, "p1", CURR_MODEL, CURR_DIM, CURR_VER).unwrap();
        assert_eq!(s.indexed_chunk_count, 5);
        assert_eq!(s.stale_chunk_count, 2);
        assert_eq!(s.indexed_scene_count, 2);
    }

    #[test]
    fn status_stale_when_chunker_version_differs() {
        let db = mem_db();
        let content = r#"{"a":1}"#;
        seed_scene(&db, "s1", content);
        upsert_scene_chunks(
            &db,
            "s1",
            &compute_content_hash(content),
            &vec![make_payload(CURR_DIM, 0.1); 4],
            CURR_MODEL,
            CURR_DIM,
            "old-chunker",
        )
        .unwrap();
        let s = collect_index_status(&db, "p1", CURR_MODEL, CURR_DIM, CURR_VER).unwrap();
        assert_eq!(s.indexed_chunk_count, 4);
        assert_eq!(s.stale_chunk_count, 4);
    }

    #[test]
    fn status_stale_when_embedding_dim_differs() {
        let db = mem_db();
        let content = r#"{"a":1}"#;
        seed_scene(&db, "s1", content);
        upsert_scene_chunks(
            &db,
            "s1",
            &compute_content_hash(content),
            &vec![make_payload(CURR_DIM, 0.1); 2],
            CURR_MODEL,
            CURR_DIM, // 投入は dim=4
            CURR_VER,
        )
        .unwrap();
        // 別 dim を期待するクエリ → 全件 stale 扱い
        let s = collect_index_status(&db, "p1", CURR_MODEL, 256, CURR_VER).unwrap();
        assert_eq!(s.indexed_chunk_count, 2);
        assert_eq!(s.stale_chunk_count, 2);
    }

    #[test]
    fn list_scene_ids_excludes_folders_and_other_projects() {
        let db = mem_db();
        let content = r#"{}"#;
        seed_scene(&db, "s1", content);
        seed_scene(&db, "s2", content);
        seed_folder(&db, "f1");
        // 別 project のシーン
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('p2', 'other')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes (
                    id, project_id, node_type, title, sort_order, content,
                    created_at, updated_at
                ) VALUES ('s_other', 'p2', 'scene', 't', 'a0', '{}', datetime('now'), datetime('now'))",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let mut ids = list_scene_ids_in_project(&db, "p1").unwrap();
        ids.sort();
        assert_eq!(ids, vec!["s1".to_string(), "s2".to_string()]);
    }
}
