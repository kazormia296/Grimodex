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

use grimodex_db::Database;

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
/// - `nonempty_scene_count`: 本文が現行チャンカで 1 つ以上 chunk を生む (= index に
///   載りうる) scene 数。空 scene は chunk を 1 件も生まないため
///   `indexed_scene_count` に永遠に載らない一方、total scene 数には含まれる。充足
///   判定の分母をこの値にすることで「空 scene があるだけで恒真 → open ごとに無駄な
///   再インデックス」を防ぐ。SQL だけでは決まらない (チャンカ通しが要る) ため
///   `collect_index_status` では 0 のまま返し、`semantic_index_status` command が埋める。
/// - `current_*`: 呼び出し側 (commands/semantic.rs) が握る現行の識別子をそのまま返す。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusReport {
    pub indexed_chunk_count: usize,
    pub stale_chunk_count: usize,
    pub indexed_scene_count: usize,
    pub nonempty_scene_count: usize,
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
            // SQL だけでは空/非空を判別できない。command 側が
            // `count_indexable_scenes` を通して埋める (0 のまま漏れても
            // `indexed < nonempty` が偽になり「再インデックスしない」側に倒れる安全既定)。
            nonempty_scene_count: 0,
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

/// まだ chunk を 1 件も持たない scene の content 一覧。`nonempty_scene_count` の
/// 算出で「既に chunk を持つ scene は定義上 non-empty なので数え直さず、未 chunk
/// 集合だけをチャンカに通して本当に空か判定する」ための読み出し。空 scene が大量に
/// あっても content 読み出しは未 chunk 分だけで済む。Embedder は不要。
pub fn list_unindexed_scene_contents(db: &Database, project_id: &str) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT tn.content
             FROM tree_nodes tn
             WHERE tn.project_id = ? AND tn.node_type = 'scene'
               AND NOT EXISTS (
                   SELECT 1 FROM scene_chunks sc WHERE sc.scene_id = tn.id
               )",
        )?;
        let rows = stmt.query_map(params![project_id], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// 与えた content 群のうち、現行チャンカで 1 つ以上 chunk を生む (= index に載りうる)
/// ものの件数。`embed_scene_payloads` と同一の parse→chunk 経路を辿るので「実際に
/// 載る」判定と完全に一致する (ヒューリスティックな空判定でズレて恒真化するのを防ぐ)。
/// JSON parse 失敗・空本文は 0 chunk = 非 indexable として数えない。Embedder は不要 —
/// チャンク分割は純 CPU なので呼び出し側は DB lock の外で回すこと。
pub fn count_indexable_scenes(
    contents: &[String],
    spec: &crate::spec::EmbeddingModelSpec,
) -> usize {
    use crate::chunker::{chunk_scene, CHUNKER_VERSION};
    use crate::chunker_en::chunk_scene_en;
    let config = spec.chunker_config();
    contents
        .iter()
        .filter(|content| {
            let Ok(doc) = serde_json::from_str::<serde_json::Value>(content) else {
                return false;
            };
            // 言語別チャンカー: ja=chunk_scene、en=chunk_scene_en (embed_scene_payloads と同一分岐)。
            let chunks = if spec.chunker_version == CHUNKER_VERSION {
                chunk_scene(&doc, &config)
            } else {
                chunk_scene_en(&doc, &config)
            };
            chunks.map(|c| !c.is_empty()).unwrap_or(false)
        })
        .count()
}

// ─────────────────────────────────────────────────────────────────────────────
// オーケストレーション (Embedder を借りるため feature gate)
// ─────────────────────────────────────────────────────────────────────────────

/// シーン content と initial hash を読み出す (DB lock は読み出しの間だけ)。
/// `None` = 該当 id が scene でない / 存在しない。
pub fn read_scene_for_index(db: &Database, scene_id: &str) -> Result<Option<(String, String)>> {
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
    Ok(row.map(|c| {
        let h = compute_content_hash(&c);
        (c, h)
    }))
}

/// content を parse → chunk → embed して upsert 用 payload を作る。
/// DB に一切触れない純 CPU 処理 — ONNX 推論は scene あたり秒単位かかりうる
/// ため、呼び出し側は workspace lock (with_db) の外で呼ぶこと。
/// 推論中に本文が変わっても、後段の `upsert_scene_chunks` が TX 内で
/// initial hash を再確認して負けた側を捨てるので整合は保たれる。
#[cfg(feature = "semantic-embedding")]
pub fn embed_scene_payloads(
    embedder: &mut crate::embedding::Embedder,
    scene_id: &str,
    content: &str,
    spec: &'static crate::spec::EmbeddingModelSpec,
) -> Result<Vec<ChunkPayload>> {
    embed_scene_payloads_cancellable(embedder, scene_id, content, spec, || true)?
        .ok_or_else(|| anyhow::anyhow!("unconditional scene embedding was cancelled unexpectedly"))
}

/// [`embed_scene_payloads`] の協調キャンセル版。
///
/// ONNX の単一推論自体は中断できないため、`should_continue` は各チャンクの
/// 推論前後に確認する。`None` はキャンセル済みを表し、途中まで構築した payload は
/// 破棄される。呼び出し側は `None` のとき `upsert_scene_chunks` を呼ばないことで、
/// 既存の index を部分 payload で置換しない。
#[cfg(feature = "semantic-embedding")]
pub fn embed_scene_payloads_cancellable(
    embedder: &mut crate::embedding::Embedder,
    scene_id: &str,
    content: &str,
    spec: &'static crate::spec::EmbeddingModelSpec,
    mut should_continue: impl FnMut() -> bool,
) -> Result<Option<Vec<ChunkPayload>>> {
    use crate::chunker::{chunk_scene, CHUNKER_VERSION};
    use crate::chunker_en::chunk_scene_en;
    use anyhow::anyhow;

    if !should_continue() {
        return Ok(None);
    }
    let doc: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| anyhow!("scene_id={scene_id} content JSON parse error: {e}"))?;
    // 言語別チャンカー: ja=ruri 既定の chunk_scene、en=chunk_scene_en。
    let config = spec.chunker_config();
    let chunks = if spec.chunker_version == CHUNKER_VERSION {
        chunk_scene(&doc, &config)?
    } else {
        chunk_scene_en(&doc, &config)?
    };
    if !should_continue() {
        return Ok(None);
    }

    embed_chunks_cancellable(
        &chunks,
        embedder.embedding_dim(),
        |text| embedder.embed_document(text),
        &mut should_continue,
    )
}

#[cfg(feature = "semantic-embedding")]
fn embed_chunks_cancellable(
    chunks: &[crate::chunker::SceneChunk],
    embedding_dim: usize,
    mut embed_document: impl FnMut(&str) -> Result<Vec<f32>>,
    mut should_continue: impl FnMut() -> bool,
) -> Result<Option<Vec<ChunkPayload>>> {
    let mut payloads = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        if !should_continue() {
            return Ok(None);
        }
        let vec = embed_document(&chunk.text)?;
        if !should_continue() {
            return Ok(None);
        }
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
    Ok(Some(payloads))
}

/// 読み出し → embed → upsert を一括で行う合成版。テストや「lock 分割が
/// 不要な呼び出し側」用。Tauri command 側は workspace lock を embed 中に
/// 保持しないよう、`read_scene_for_index` / `embed_scene_payloads` /
/// `upsert_scene_chunks` を個別に呼ぶ (commands/semantic.rs 参照)。
#[cfg(feature = "semantic-embedding")]
pub fn index_scene(
    db: &Database,
    embedder: &mut crate::embedding::Embedder,
    scene_id: &str,
    model_id: &str,
    spec: &'static crate::spec::EmbeddingModelSpec,
) -> Result<UpsertOutcome> {
    let Some((content, initial_hash)) = read_scene_for_index(db, scene_id)? else {
        return Ok(UpsertOutcome::SkippedNotScene);
    };
    let payloads = embed_scene_payloads(embedder, scene_id, &content, spec)?;
    let embedding_dim = embedder.embedding_dim();
    upsert_scene_chunks(
        db,
        scene_id,
        &initial_hash,
        &payloads,
        model_id,
        embedding_dim,
        spec.chunker_version,
    )
}

/// プロジェクトの言語 (`projects.language`) を読む。行が無ければ "ja"。
/// 非 gated: spec 選択を embedding feature 無しでも行えるようにする。
pub fn project_language(db: &Database, project_id: &str) -> Result<String> {
    db.with_conn(|conn| {
        let lang: Option<String> = conn
            .query_row(
                "SELECT language FROM projects WHERE id = ?",
                params![project_id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        Ok(lang.unwrap_or_else(|| "ja".to_string()))
    })
}

/// scene_id からそのプロジェクトの言語を引く (tree_nodes → projects JOIN)。
pub fn project_language_for_scene(db: &Database, scene_id: &str) -> Result<String> {
    db.with_conn(|conn| {
        let lang: Option<String> = conn
            .query_row(
                "SELECT p.language FROM projects p \
                 JOIN tree_nodes tn ON tn.project_id = p.id \
                 WHERE tn.id = ?",
                params![scene_id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        Ok(lang.unwrap_or_else(|| "ja".to_string()))
    })
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

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn cancellable_embedding_discards_partial_payloads_between_chunks() {
        use crate::chunker::SceneChunk;
        use std::cell::Cell;

        let chunks = vec![
            SceneChunk {
                chunk_index: 0,
                text: "first".to_string(),
                char_start: 0,
                char_end: 5,
                dialogue_ratio: 0.0,
            },
            SceneChunk {
                chunk_index: 1,
                text: "second".to_string(),
                char_start: 6,
                char_end: 12,
                dialogue_ratio: 0.0,
            },
        ];
        let embedded = Cell::new(0);
        let checks = Cell::new(0);
        let outcome = embed_chunks_cancellable(
            &chunks,
            2,
            |_| {
                embedded.set(embedded.get() + 1);
                Ok(vec![0.25, 0.75])
            },
            || {
                let next = checks.get() + 1;
                checks.set(next);
                next < 3
            },
        )
        .unwrap();

        assert!(outcome.is_none());
        assert_eq!(embedded.get(), 1);
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

    // ── nonempty_scene_count / count_indexable_scenes ────────────────────
    // 「空 scene 混在で open ごとに毎回フル再インデックス」回帰のガード。

    /// ProseMirror doc として本文を持つ (JA チャンカで chunk を 1 つ以上生む) JSON。
    const NONEMPTY_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"本文です。"}]}]}"#;
    /// 空 doc (paragraph 無し) — chunk を 1 件も生まない。
    const EMPTY_DOC: &str = r#"{"type":"doc","content":[]}"#;

    #[test]
    fn count_indexable_scenes_excludes_empty_and_unparsable() {
        let spec = crate::spec::spec_for_language("ja");
        let contents = vec![
            NONEMPTY_DOC.to_string(),
            EMPTY_DOC.to_string(),
            r#"{"type":"doc"}"#.to_string(), // content キー無し = 空
            "not json".to_string(),          // parse 失敗 = 非 indexable
        ];
        // 数に入るのは本文を持つ 1 件だけ。
        assert_eq!(count_indexable_scenes(&contents, spec), 1);
        assert_eq!(count_indexable_scenes(&[], spec), 0);
    }

    #[test]
    fn list_unindexed_scene_contents_returns_only_chunkless() {
        let db = mem_db();
        seed_scene(&db, "s_indexed", NONEMPTY_DOC);
        seed_scene(&db, "s_empty", EMPTY_DOC);
        // s_indexed にだけ chunk を入れる。
        upsert_scene_chunks(
            &db,
            "s_indexed",
            &compute_content_hash(NONEMPTY_DOC),
            &[make_payload(4, 0.1)],
            "m",
            4,
            "v1",
        )
        .unwrap();

        let contents = list_unindexed_scene_contents(&db, "p1").unwrap();
        // chunk を持つ s_indexed は除外され、未 chunk の s_empty だけ返る。
        assert_eq!(contents, vec![EMPTY_DOC.to_string()]);
    }

    /// 回帰: 実体 1 + 空 3 のとき nonempty == indexed == 1 で
    /// `indexed < nonempty` が偽 = 再インデックスしない側に倒れる。command が
    /// 組み立てるのと同じ式で検証する。
    #[test]
    fn nonempty_scene_count_ignores_empty_scenes() {
        let db = mem_db();
        let spec = crate::spec::spec_for_language("ja");
        seed_scene(&db, "s_real", NONEMPTY_DOC);
        upsert_scene_chunks(
            &db,
            "s_real",
            &compute_content_hash(NONEMPTY_DOC),
            &[make_payload(4, 0.1)],
            "m",
            4,
            "v1",
        )
        .unwrap();
        for id in ["e1", "e2", "e3"] {
            seed_scene(&db, id, EMPTY_DOC);
        }

        let s = collect_index_status(&db, "p1", "m", 4, "v1").unwrap();
        assert_eq!(s.indexed_scene_count, 1);
        let unindexed = list_unindexed_scene_contents(&db, "p1").unwrap();
        let nonempty = s.indexed_scene_count + count_indexable_scenes(&unindexed, spec);
        // 空 3 は数に入らない → nonempty == indexed → incomplete=false。
        assert_eq!(nonempty, 1);
        assert_eq!(s.indexed_scene_count, nonempty);
    }

    /// 逆: 未 index の非空 scene が居れば nonempty > indexed で再インデックスが要る。
    #[test]
    fn nonempty_scene_count_counts_unindexed_nonempty_scene() {
        let db = mem_db();
        let spec = crate::spec::spec_for_language("ja");
        seed_scene(&db, "s_real", NONEMPTY_DOC);
        upsert_scene_chunks(
            &db,
            "s_real",
            &compute_content_hash(NONEMPTY_DOC),
            &[make_payload(4, 0.1)],
            "m",
            4,
            "v1",
        )
        .unwrap();
        seed_scene(&db, "s_new", NONEMPTY_DOC); // 未 index の非空
        seed_scene(&db, "e1", EMPTY_DOC); // 未 index の空

        let s = collect_index_status(&db, "p1", "m", 4, "v1").unwrap();
        assert_eq!(s.indexed_scene_count, 1);
        let unindexed = list_unindexed_scene_contents(&db, "p1").unwrap();
        let nonempty = s.indexed_scene_count + count_indexable_scenes(&unindexed, spec);
        // s_new は数に入り e1 は入らない → nonempty=2 > indexed=1。
        assert_eq!(nonempty, 2);
        assert!(s.indexed_scene_count < nonempty);
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
