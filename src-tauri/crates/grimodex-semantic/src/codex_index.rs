//! Codex 埋め込み index (stage 3): scene の `index.rs` を「チャンク不要・
//! 1 エントリ 1 ベクトル」にフォークした版。
//!
//! eval (scripts/eval-codex-recall.py) で codex 本文は短く (80〜300字)、
//! チャンク分割せず entry 全体 (name+aliases+summary+本文) を 1 ベクトルで
//! 埋めれば descriptive recall が出ることを確認済み。よって scene のような
//! 段落チャンカーは通さない。
//!
//! race condition 戦略は scene と同型: 呼び出し側が embed 前に entry を読んで
//! hash 算出 → embed 中は DB lock を放す → `upsert_codex_chunk` が TX 内で
//! entry を再 SELECT・再 hash し、`expected_hash` 不一致なら破棄。
//!
//! pure logic (`build_codex_embed_text` / `compute_codex_content_hash` /
//! `upsert_codex_chunk` / `read_codex_for_index` / `list_entry_ids_in_project`)
//! は `semantic-embedding` feature 無しで build でき、`--no-default-features`
//! で検証可能。Embedder を借りる `embed_codex_text` のみ feature gate。

#![allow(dead_code)]

use anyhow::{ensure, Result};
use rusqlite::params;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::chunker::extract_paragraph_texts;
use grimodex_db::Database;

/// upsert の結果。codex は 1 entry 1 ベクトルなので Indexed は 0 か 1。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexUpsertOutcome {
    /// 投入したベクトル数 (常に 1)。
    Indexed(usize),
    /// TX 開始時の hash が呼び出し側の expected_hash と不一致。古い job 等。
    SkippedHashMismatch,
    /// entry_id が存在しない。
    SkippedMissing,
}

/// codex_entries.aliases (JSON `["a","b"]`) を Vec<String> に。失敗時は空。
fn parse_aliases(raw: &str) -> Vec<String> {
    if raw.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

/// content (ProseMirror JSON) を平文化する。scene FTS/preview と同じ
/// `extract_paragraph_texts` を流用。parse 不能なら空文字。
fn codex_body_plaintext(content: &str) -> String {
    if content.is_empty() {
        return String::new();
    }
    match serde_json::from_str::<Value>(content) {
        Ok(doc) => extract_paragraph_texts(&doc).join("\n"),
        Err(_) => String::new(),
    }
}

/// 埋め込み対象テキストを組み立てる: `name。aliases。summary。本文(平文)`。
/// 空フィールドは除外、区切りは「。」(eval-codex-recall.py の `doc_for` と同形)。
pub fn build_codex_embed_text(name: &str, aliases: &str, summary: &str, content: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !name.is_empty() {
        parts.push(name.to_string());
    }
    let aliases_joined = parse_aliases(aliases).join(" ");
    if !aliases_joined.is_empty() {
        parts.push(aliases_joined);
    }
    if !summary.is_empty() {
        parts.push(summary.to_string());
    }
    let body = codex_body_plaintext(content);
    if !body.is_empty() {
        parts.push(body);
    }
    parts.join("。")
}

/// entry の DB 状態から決定的に hash を出す。`read_codex_for_index` (read 時) と
/// `upsert_codex_chunk` (TX 内 re-check) が同じ入力で同じ hash を出すための正本。
/// notes は埋め込み対象外なので hash にも含めない。
pub fn compute_codex_content_hash(
    name: &str,
    aliases: &str,
    summary: &str,
    content: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    hasher.update([0u8]);
    hasher.update(aliases.as_bytes());
    hasher.update([0u8]);
    hasher.update(summary.as_bytes());
    hasher.update([0u8]);
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

/// entry の埋め込みテキストと initial hash を読み出す (DB lock は読み出しの間だけ)。
/// `None` = 該当 id が存在しない。
pub fn read_codex_for_index(db: &Database, entry_id: &str) -> Result<Option<(String, String)>> {
    let row: Option<(String, String, String, String)> = db.with_conn(|conn| {
        let v = conn
            .query_row(
                "SELECT name, COALESCE(aliases, ''), COALESCE(summary, ''), content
                 FROM codex_entries WHERE id = ?",
                params![entry_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .ok();
        Ok(v)
    })?;
    Ok(row.map(|(name, aliases, summary, content)| {
        let text = build_codex_embed_text(&name, &aliases, &summary, &content);
        let hash = compute_codex_content_hash(&name, &aliases, &summary, &content);
        (text, hash)
    }))
}

/// `codex_chunks` の 1 行を upsert する (PK=entry_id なので INSERT OR REPLACE)。
///
/// TX 内で entry を再 SELECT・再 hash し、`expected_hash` と一致するときだけ書く。
/// 不一致なら `SkippedHashMismatch`、entry 不在なら `SkippedMissing`。
#[allow(clippy::too_many_arguments)]
pub fn upsert_codex_chunk(
    db: &Database,
    entry_id: &str,
    expected_hash: &str,
    embedding: &[u8],
    text: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<CodexUpsertOutcome> {
    ensure!(
        embedding.len() == embedding_dim * 4,
        "embedding len {} != dim {} * 4 = {}",
        embedding.len(),
        embedding_dim,
        embedding_dim * 4
    );

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;

        let row: Option<(String, String, String, String, String)> = tx
            .query_row(
                "SELECT name, type, COALESCE(aliases, ''), COALESCE(summary, ''), content
                 FROM codex_entries WHERE id = ?",
                params![entry_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .ok();

        let Some((name, entry_type, aliases, summary, content)) = row else {
            return Ok(CodexUpsertOutcome::SkippedMissing);
        };

        let current_hash = compute_codex_content_hash(&name, &aliases, &summary, &content);
        if current_hash != expected_hash {
            return Ok(CodexUpsertOutcome::SkippedHashMismatch);
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        tx.execute(
            "INSERT OR REPLACE INTO codex_chunks (
                entry_id, entry_name, entry_type, text, embedding,
                embedding_dim, model_id, content_hash, chunker_version,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                entry_id,
                name,
                entry_type,
                text,
                embedding,
                embedding_dim as i64,
                model_id,
                expected_hash,
                chunker_version,
                now_ms,
                now_ms,
            ],
        )?;

        tx.commit()?;
        Ok(CodexUpsertOutcome::Indexed(1))
    })
}

/// 指定 project 配下の codex entry id 一覧 (reindex 用)。
pub fn list_entry_ids_in_project(db: &Database, project_id: &str) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT id FROM codex_entries WHERE project_id = ? ORDER BY name")?;
        let rows = stmt.query_map(params![project_id], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// project の codex index 充足状況 (段階3c の bulk back-index 要否判定用)。
/// `indexed_entry_count < total_entry_count` なら未 index の既存エントリがある。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexIndexStatus {
    /// 現 spec (model_id/embedding_dim/chunker_version) に一致する codex_chunks 行数
    /// (= index 済み entry 数)。stale 行は数えない。
    pub indexed_entry_count: usize,
    /// project 配下の codex_entries 総数。
    pub total_entry_count: usize,
}

/// codex の index 充足状況を 1 回の `with_conn` で集計する。Embedder 不要の cheap
/// クエリ (scene の `collect_index_status` と同型)。codex_chunks は PK=entry_id なので
/// 行数 = index 済み entry 数。`indexed` は現 spec 一致行のみ (stale 除外)。
pub fn collect_codex_index_status(
    db: &Database,
    project_id: &str,
    current_model_id: &str,
    current_embedding_dim: usize,
    current_chunker_version: &str,
) -> Result<CodexIndexStatus> {
    db.with_conn(|conn| {
        let total_entry_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_entries WHERE project_id = ?",
            params![project_id],
            |row| row.get(0),
        )?;

        let indexed_entry_count: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM codex_chunks cc
             JOIN codex_entries ce ON ce.id = cc.entry_id
             WHERE ce.project_id = ?
               AND cc.model_id = ?
               AND cc.embedding_dim = ?
               AND cc.chunker_version = ?",
            params![
                project_id,
                current_model_id,
                current_embedding_dim as i64,
                current_chunker_version,
            ],
            |row| row.get(0),
        )?;

        Ok(CodexIndexStatus {
            indexed_entry_count: indexed_entry_count as usize,
            total_entry_count: total_entry_count as usize,
        })
    })
}

/// entry_id からそのプロジェクトの言語を引く (codex_entries → projects JOIN)。
/// 行が無ければ "ja"。spec 選択に使う (非 gated)。
pub fn project_language_for_codex_entry(db: &Database, entry_id: &str) -> Result<String> {
    db.with_conn(|conn| {
        let lang: Option<String> = conn
            .query_row(
                "SELECT p.language FROM projects p \
                 JOIN codex_entries ce ON ce.project_id = p.id \
                 WHERE ce.id = ?",
                params![entry_id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        Ok(lang.unwrap_or_else(|| "ja".to_string()))
    })
}

/// content を embed して LE f32 バイト列 (1 ベクトル) を返す。チャンカーは通さない。
/// DB に触れない純 CPU 処理。呼び出し側は workspace lock の外で呼ぶこと。
#[cfg(all(feature = "semantic-embedding", test))]
pub fn embed_codex_text(embedder: &mut crate::embedding::Embedder, text: &str) -> Result<Vec<u8>> {
    let embedding_dim = embedder.embedding_dim();
    let vec = embedder.embed_document(text)?;
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
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn mem_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open mem db");
        db.migrate().expect("migrate");
        db
    }

    /// project + codex_type + codex_entry を seed する。codex_entries の複合 FK
    /// (project_id, type) → codex_types(project_id, slug) を満たすため type を先に作る。
    fn seed_codex(
        db: &Database,
        project_id: &str,
        entry_id: &str,
        type_slug: &str,
        name: &str,
        summary: &str,
        content: &str,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO projects (id, title, language) VALUES (?, 'test', 'ja')",
                params![project_id],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO codex_types (id, project_id, slug, label) VALUES (?, ?, ?, ?)",
                params![format!("{project_id}:{type_slug}"), project_id, type_slug, type_slug],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, content, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
                params![entry_id, project_id, type_slug, name, summary, content],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn emb_bytes(dim: usize, fill: f32) -> Vec<u8> {
        let mut b = Vec::with_capacity(dim * 4);
        for _ in 0..dim {
            b.extend_from_slice(&fill.to_le_bytes());
        }
        b
    }

    fn count_chunks(db: &Database, entry_id: &str) -> i64 {
        db.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM codex_chunks WHERE entry_id = ?",
                params![entry_id],
                |r| r.get(0),
            )?;
            Ok(n)
        })
        .unwrap()
    }

    const DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"本文に共鳴という語がある"}]}]}"#;

    #[test]
    fn embed_text_includes_name_summary_and_body() {
        let t = build_codex_embed_text("セレーナ", r#"["導師"]"#, "幼なじみ", DOC);
        assert!(t.contains("セレーナ"));
        assert!(t.contains("導師"));
        assert!(t.contains("幼なじみ"));
        assert!(t.contains("共鳴"), "body plaintext must be included");
    }

    #[test]
    fn content_hash_changes_with_any_field() {
        let base = compute_codex_content_hash("n", "a", "s", "c");
        assert_eq!(base, compute_codex_content_hash("n", "a", "s", "c"));
        assert_ne!(base, compute_codex_content_hash("N", "a", "s", "c"));
        assert_ne!(base, compute_codex_content_hash("n", "A", "s", "c"));
        assert_ne!(base, compute_codex_content_hash("n", "a", "S", "c"));
        assert_ne!(base, compute_codex_content_hash("n", "a", "s", "C"));
        assert_eq!(base.len(), 64);
    }

    #[test]
    fn upsert_inserts_then_replaces_same_pk() {
        let db = mem_db();
        seed_codex(&db, "p1", "c1", "character", "太郎", "勇者", DOC);
        let (text, hash) = read_codex_for_index(&db, "c1").unwrap().unwrap();

        let out =
            upsert_codex_chunk(&db, "c1", &hash, &emb_bytes(8, 0.1), &text, "m", 8, "v1").unwrap();
        assert_eq!(out, CodexUpsertOutcome::Indexed(1));
        assert_eq!(count_chunks(&db, "c1"), 1);

        // 同じ entry を再 index → PK 衝突で REPLACE、件数は 1 のまま。
        let out2 =
            upsert_codex_chunk(&db, "c1", &hash, &emb_bytes(8, 0.9), &text, "m", 8, "v1").unwrap();
        assert_eq!(out2, CodexUpsertOutcome::Indexed(1));
        assert_eq!(count_chunks(&db, "c1"), 1);
    }

    #[test]
    fn upsert_skips_on_hash_mismatch() {
        let db = mem_db();
        seed_codex(&db, "p1", "c1", "character", "太郎", "勇者", DOC);
        let (text, hash) = read_codex_for_index(&db, "c1").unwrap().unwrap();
        upsert_codex_chunk(&db, "c1", &hash, &emb_bytes(8, 0.1), &text, "m", 8, "v1").unwrap();

        // 並行する別 save が summary を書き換えたケースを模擬。
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_entries SET summary = ? WHERE id = ?",
                params!["別人", "c1"],
            )?;
            Ok(())
        })
        .unwrap();

        let out =
            upsert_codex_chunk(&db, "c1", &hash, &emb_bytes(8, 0.5), &text, "m", 8, "v1").unwrap();
        assert_eq!(out, CodexUpsertOutcome::SkippedHashMismatch);
        // 旧データは残り、件数は 1 のまま。
        assert_eq!(count_chunks(&db, "c1"), 1);
    }

    #[test]
    fn upsert_skips_missing_entry() {
        let db = mem_db();
        let out =
            upsert_codex_chunk(&db, "nope", "h", &emb_bytes(8, 0.1), "t", "m", 8, "v1").unwrap();
        assert_eq!(out, CodexUpsertOutcome::SkippedMissing);
    }

    #[test]
    fn upsert_rejects_short_embedding() {
        let db = mem_db();
        seed_codex(&db, "p1", "c1", "character", "太郎", "勇者", DOC);
        let (text, hash) = read_codex_for_index(&db, "c1").unwrap().unwrap();
        let r = upsert_codex_chunk(&db, "c1", &hash, &[0, 0, 0], &text, "m", 8, "v1");
        assert!(r.is_err(), "short embedding must be rejected");
    }

    #[test]
    fn cascade_delete_on_entry_removal() {
        let db = mem_db();
        seed_codex(&db, "p1", "c1", "character", "太郎", "勇者", DOC);
        let (text, hash) = read_codex_for_index(&db, "c1").unwrap().unwrap();
        upsert_codex_chunk(&db, "c1", &hash, &emb_bytes(8, 0.1), &text, "m", 8, "v1").unwrap();
        assert_eq!(count_chunks(&db, "c1"), 1);

        db.with_conn(|conn| {
            conn.execute("DELETE FROM codex_entries WHERE id = ?", params!["c1"])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(count_chunks(&db, "c1"), 0);
    }

    #[test]
    fn list_entry_ids_scoped_to_project() {
        let db = mem_db();
        seed_codex(&db, "p1", "c1", "character", "A", "", "{}");
        seed_codex(&db, "p1", "c2", "character", "B", "", "{}");
        seed_codex(&db, "p2", "c3", "character", "C", "", "{}");
        let mut ids = list_entry_ids_in_project(&db, "p1").unwrap();
        ids.sort();
        assert_eq!(ids, vec!["c1".to_string(), "c2".to_string()]);
    }

    /// テスト用: entry を指定 model で index する (dim 8 / ver "v1" 固定)。
    fn index_entry(db: &Database, entry_id: &str, model_id: &str) {
        let (text, hash) = read_codex_for_index(db, entry_id).unwrap().unwrap();
        upsert_codex_chunk(
            db,
            entry_id,
            &hash,
            &emb_bytes(8, 0.1),
            &text,
            model_id,
            8,
            "v1",
        )
        .unwrap();
    }

    #[test]
    fn index_status_counts_total_and_indexed() {
        let db = mem_db();
        seed_codex(&db, "p1", "c1", "character", "A", "", "{}");
        seed_codex(&db, "p1", "c2", "character", "B", "", "{}");
        seed_codex(&db, "p1", "c3", "character", "C", "", "{}");
        index_entry(&db, "c1", "m");
        index_entry(&db, "c2", "m");
        let s = collect_codex_index_status(&db, "p1", "m", 8, "v1").unwrap();
        assert_eq!(s.total_entry_count, 3);
        assert_eq!(s.indexed_entry_count, 2);
    }

    #[test]
    fn index_status_excludes_stale_model() {
        let db = mem_db();
        seed_codex(&db, "p1", "c1", "character", "A", "", "{}");
        index_entry(&db, "c1", "old-model");
        let s = collect_codex_index_status(&db, "p1", "m", 8, "v1").unwrap();
        assert_eq!(s.total_entry_count, 1);
        assert_eq!(
            s.indexed_entry_count, 0,
            "stale model row must not count as indexed"
        );
    }

    #[test]
    fn index_status_scoped_to_project() {
        let db = mem_db();
        seed_codex(&db, "p1", "c1", "character", "A", "", "{}");
        seed_codex(&db, "p2", "c2", "character", "B", "", "{}");
        index_entry(&db, "c1", "m");
        index_entry(&db, "c2", "m");
        let s = collect_codex_index_status(&db, "p1", "m", 8, "v1").unwrap();
        assert_eq!(s.total_entry_count, 1);
        assert_eq!(s.indexed_entry_count, 1);
    }
}
