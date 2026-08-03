//! Chat episodic-memory 埋め込み index: codex の `codex_index.rs` を
//! 「1 メッセージ 1 ベクトル・project_id 非正規化・効果信号付き」にフォークした版。
//!
//! 過去の対話 (エピソード記憶) を scene/codex と同じ意味検索経路で recall する。
//! チャットはシーンより雑多なので、`insertedToEditor` / `extractedCodex` 等の
//! 「実際に効いた発話」信号を列として持ち、検索時 (JS chatRecall) の重み付けに使う。
//!
//! ## scene/codex との違い
//! - chat_messages には project_id が無い (session 経由)。スコープ (project.db 単位)
//!   を検索読み出しで効かせるため、index 時に `chat_sessions` を JOIN して
//!   project_id / session_id を非正規化して持つ。
//! - 効果信号 (inserted_to_editor / extracted_count) を metadata JSON から抽出して
//!   列に持つ。**signal が変われば content_hash も変わる**よう hash 入力に含める
//!   ので、本文不変でも metadata 変更 → 再 index で signal 列が更新される
//!   (stale-weight drift 対策)。
//! - 埋め込み対象は user / assistant の非空メッセージのみ (system / 空は index 外)。
//!
//! race condition 戦略は codex/scene と同型: 呼び出し側が embed 前にメッセージを
//! 読んで hash 算出 → embed 中は DB lock を放す → `upsert_chat_chunk` が TX 内で
//! 再 SELECT・再 hash し、`expected_hash` 不一致なら破棄。
//!
//! pure logic は `semantic-embedding` feature 無しで build でき、
//! `--no-default-features` で検証可能。Embedder を借りる `embed_chat_text` のみ
//! feature gate。

#![allow(dead_code)]

use anyhow::{ensure, Result};
use rusqlite::params;
use serde_json::Value;
use sha2::{Digest, Sha256};

use grimodex_db::Database;

/// upsert の結果。chat は 1 message 1 ベクトルなので Indexed は 0 か 1。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatUpsertOutcome {
    /// 投入したベクトル数 (常に 1)。
    Indexed(usize),
    /// TX 開始時の hash が呼び出し側の expected_hash と不一致。古い job / 並行編集。
    SkippedHashMismatch,
    /// message_id が存在しない、または index 対象外 (system / 空本文)。
    SkippedMissing,
}

/// index 対象に読み出した 1 メッセージの状態。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatIndexInput {
    /// 埋め込み対象テキスト (= 本文 trim)。
    pub text: String,
    pub project_id: String,
    pub session_id: String,
    pub role: String,
    pub inserted_to_editor: bool,
    pub extracted_count: i64,
    /// content + role + signal から決定的に出した hash。
    pub hash: String,
}

/// user / assistant のみ index 対象 (system は内部用なので除外)。
pub fn is_indexable_role(role: &str) -> bool {
    role == "user" || role == "assistant"
}

/// metadata JSON から効果信号を抽出する。parse 不能 / 欠落は (false, 0)。
/// `extracted_count` = extractedCodex 件数 + extractedSnippets 件数
/// (conversationHistory.isTier2Anchor が「効いた発話」判定に使う信号と同源)。
pub fn parse_chat_signals(metadata: &str) -> (bool, i64) {
    if metadata.is_empty() {
        return (false, 0);
    }
    let v: Value = match serde_json::from_str(metadata) {
        Ok(v) => v,
        Err(_) => return (false, 0),
    };
    let inserted = v
        .get("insertedToEditor")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let codex_len = v
        .get("extractedCodex")
        .and_then(|x| x.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let snippet_len = v
        .get("extractedSnippets")
        .and_then(|x| x.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    (inserted, (codex_len + snippet_len) as i64)
}

/// 埋め込み対象テキスト = 本文 trim。役割や signal は埋め込まず列で持つ
/// (recall は話題で当てたいので role tag で embedding を汚さない)。
pub fn build_chat_embed_text(content: &str) -> String {
    content.trim().to_string()
}

/// メッセージの DB 状態から決定的に hash を出す。`read_chat_message_for_index`
/// (read 時) と `upsert_chat_chunk` (TX 内 re-check) が同じ入力で同じ hash を出す
/// ための正本。**signal を含める**ので metadata 変更 → hash 変化 → 再 index で
/// signal 列が更新される (content 不変でも weight が stale 化しない)。
pub fn compute_chat_content_hash(
    content: &str,
    role: &str,
    inserted_to_editor: bool,
    extracted_count: i64,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hasher.update([0u8]);
    hasher.update(role.as_bytes());
    hasher.update([0u8]);
    hasher.update([inserted_to_editor as u8]);
    hasher.update([0u8]);
    hasher.update(extracted_count.to_le_bytes());
    hex::encode(hasher.finalize())
}

/// 行 (content, role, metadata, project_id, session_id) から `ChatIndexInput` を組む。
/// index 対象外 (非 user/assistant・空本文) は `None`。read と upsert で共有する。
fn build_input_from_row(
    content: String,
    role: String,
    metadata: String,
    project_id: String,
    session_id: String,
) -> Option<ChatIndexInput> {
    if !is_indexable_role(&role) {
        return None;
    }
    let text = build_chat_embed_text(&content);
    if text.is_empty() {
        return None;
    }
    let (inserted_to_editor, extracted_count) = parse_chat_signals(&metadata);
    let hash = compute_chat_content_hash(&content, &role, inserted_to_editor, extracted_count);
    Some(ChatIndexInput {
        text,
        project_id,
        session_id,
        role,
        inserted_to_editor,
        extracted_count,
        hash,
    })
}

/// 1 メッセージの (content, role, metadata, project_id, session_id) を読む 1 行クエリ。
fn select_message_row(
    conn: &rusqlite::Connection,
    message_id: &str,
) -> Option<(String, String, String, String, String)> {
    conn.query_row(
        "SELECT cm.content, cm.role, COALESCE(cm.metadata, ''), cs.project_id, cm.session_id
         FROM chat_messages cm
         JOIN chat_sessions cs ON cs.id = cm.session_id
         WHERE cm.id = ?",
        params![message_id],
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
    .ok()
}

/// メッセージの埋め込み入力と initial hash を読み出す (DB lock は読み出しの間だけ)。
/// `None` = 該当 id が存在しない / index 対象外。
pub fn read_chat_message_for_index(
    db: &Database,
    message_id: &str,
) -> Result<Option<ChatIndexInput>> {
    let row = db.with_conn(|conn| Ok(select_message_row(conn, message_id)))?;
    Ok(
        row.and_then(|(content, role, metadata, project_id, session_id)| {
            build_input_from_row(content, role, metadata, project_id, session_id)
        }),
    )
}

/// `chat_message_chunks` の 1 行を upsert する (PK=message_id なので INSERT OR REPLACE)。
///
/// TX 内でメッセージを再 SELECT・再 hash し、`expected_hash` と一致するときだけ書く。
/// 不一致なら `SkippedHashMismatch`、不在 / index 対象外なら `SkippedMissing`。
#[allow(clippy::too_many_arguments)]
pub fn upsert_chat_chunk(
    db: &Database,
    message_id: &str,
    expected_hash: &str,
    embedding: &[u8],
    text: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<ChatUpsertOutcome> {
    ensure!(
        embedding.len() == embedding_dim * 4,
        "embedding len {} != dim {} * 4 = {}",
        embedding.len(),
        embedding_dim,
        embedding_dim * 4
    );

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;

        let Some((content, role, metadata, project_id, session_id)) =
            select_message_row(&tx, message_id)
        else {
            return Ok(ChatUpsertOutcome::SkippedMissing);
        };

        let Some(input) = build_input_from_row(content, role, metadata, project_id, session_id)
        else {
            return Ok(ChatUpsertOutcome::SkippedMissing);
        };

        if input.hash != expected_hash {
            return Ok(ChatUpsertOutcome::SkippedHashMismatch);
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        tx.execute(
            "INSERT OR REPLACE INTO chat_message_chunks (
                message_id, session_id, project_id, role, text,
                inserted_to_editor, extracted_count, embedding, embedding_dim,
                model_id, content_hash, chunker_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                message_id,
                input.session_id,
                input.project_id,
                input.role,
                text,
                input.inserted_to_editor as i64,
                input.extracted_count,
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
        Ok(ChatUpsertOutcome::Indexed(1))
    })
}

/// 指定 project 配下の index 対象メッセージ id 一覧 (reindex 用)。
/// system / 空本文は除外 (index 対象と同じ条件)。
pub fn list_message_ids_in_project(db: &Database, project_id: &str) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cm.id
             FROM chat_messages cm
             JOIN chat_sessions cs ON cs.id = cm.session_id
             WHERE cs.project_id = ?
               AND cm.role IN ('user', 'assistant')
               AND TRIM(cm.content) <> ''
             ORDER BY cm.created_at",
        )?;
        let rows = stmt.query_map(params![project_id], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// project の chat index 充足状況 (bulk back-index 要否判定用)。
/// `indexed_message_count < total_message_count` なら未 index の既存メッセージがある。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatIndexStatus {
    /// 現 spec に一致する chat_message_chunks 行数 (= index 済みメッセージ数)。
    pub indexed_message_count: usize,
    /// project 配下の index 対象メッセージ総数 (user/assistant・非空)。
    pub total_message_count: usize,
}

/// chat の index 充足状況を 1 回の `with_conn` で集計する。Embedder 不要の cheap
/// クエリ。chat_message_chunks は project_id を非正規化済みなので indexed 集計は
/// JOIN 不要。`indexed` は現 spec 一致行のみ (stale 除外)。
pub fn collect_chat_index_status(
    db: &Database,
    project_id: &str,
    current_model_id: &str,
    current_embedding_dim: usize,
    current_chunker_version: &str,
) -> Result<ChatIndexStatus> {
    db.with_conn(|conn| {
        let total_message_count: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM chat_messages cm
             JOIN chat_sessions cs ON cs.id = cm.session_id
             WHERE cs.project_id = ?
               AND cm.role IN ('user', 'assistant')
               AND TRIM(cm.content) <> ''",
            params![project_id],
            |row| row.get(0),
        )?;

        let indexed_message_count: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM chat_message_chunks
             WHERE project_id = ?
               AND model_id = ?
               AND embedding_dim = ?
               AND chunker_version = ?",
            params![
                project_id,
                current_model_id,
                current_embedding_dim as i64,
                current_chunker_version,
            ],
            |row| row.get(0),
        )?;

        Ok(ChatIndexStatus {
            indexed_message_count: indexed_message_count as usize,
            total_message_count: total_message_count as usize,
        })
    })
}

/// message_id からそのプロジェクトの言語を引く (chat_messages → chat_sessions →
/// projects JOIN)。行が無ければ "ja"。spec 選択に使う (非 gated)。
pub fn project_language_for_chat_message(db: &Database, message_id: &str) -> Result<String> {
    db.with_conn(|conn| {
        let lang: Option<String> = conn
            .query_row(
                "SELECT p.language FROM projects p \
                 JOIN chat_sessions cs ON cs.project_id = p.id \
                 JOIN chat_messages cm ON cm.session_id = cs.id \
                 WHERE cm.id = ?",
                params![message_id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        Ok(lang.unwrap_or_else(|| "ja".to_string()))
    })
}

/// text を embed して LE f32 バイト列 (1 ベクトル) を返す。チャンカーは通さない。
/// DB に触れない純 CPU 処理。呼び出し側は workspace lock の外で呼ぶこと。
#[cfg(all(feature = "semantic-embedding", test))]
pub fn embed_chat_text(embedder: &mut crate::embedding::Embedder, text: &str) -> Result<Vec<u8>> {
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

    /// project + chat_session + chat_message を seed する。
    #[allow(clippy::too_many_arguments)]
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

    fn set_metadata(db: &Database, message_id: &str, metadata: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE chat_messages SET metadata = ? WHERE id = ?",
                params![metadata, message_id],
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

    fn count_chunks(db: &Database, message_id: &str) -> i64 {
        db.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM chat_message_chunks WHERE message_id = ?",
                params![message_id],
                |r| r.get(0),
            )?;
            Ok(n)
        })
        .unwrap()
    }

    fn read_chunk_signals(db: &Database, message_id: &str) -> (i64, i64, String, String) {
        db.with_conn(|conn| {
            let r = conn.query_row(
                "SELECT inserted_to_editor, extracted_count, project_id, session_id
                 FROM chat_message_chunks WHERE message_id = ?",
                params![message_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )?;
            Ok(r)
        })
        .unwrap()
    }

    #[test]
    fn embed_text_is_trimmed_content() {
        assert_eq!(build_chat_embed_text("  hello  "), "hello");
        assert_eq!(build_chat_embed_text(""), "");
    }

    #[test]
    fn signals_parsed_from_metadata() {
        assert_eq!(parse_chat_signals(""), (false, 0));
        assert_eq!(parse_chat_signals("not json"), (false, 0));
        assert_eq!(
            parse_chat_signals(r#"{"insertedToEditor":true}"#),
            (true, 0)
        );
        assert_eq!(
            parse_chat_signals(r#"{"extractedCodex":["a","b"],"extractedSnippets":["c"]}"#),
            (false, 3)
        );
        assert_eq!(
            parse_chat_signals(r#"{"insertedToEditor":true,"extractedCodex":["a"]}"#),
            (true, 1)
        );
    }

    #[test]
    fn content_hash_changes_with_content_role_and_signals() {
        let base = compute_chat_content_hash("c", "user", false, 0);
        assert_eq!(base, compute_chat_content_hash("c", "user", false, 0));
        assert_ne!(base, compute_chat_content_hash("C", "user", false, 0));
        assert_ne!(base, compute_chat_content_hash("c", "assistant", false, 0));
        assert_ne!(
            base,
            compute_chat_content_hash("c", "user", true, 0),
            "signal change must change hash (stale-weight guard)"
        );
        assert_ne!(base, compute_chat_content_hash("c", "user", false, 1));
        assert_eq!(base.len(), 64);
    }

    #[test]
    fn read_skips_system_and_empty() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "sys", "system", "internal", None);
        seed_message(&db, "p1", "s1", "blank", "user", "   ", None);
        seed_message(&db, "p1", "s1", "ok", "user", "本文あり", None);
        assert!(read_chat_message_for_index(&db, "sys").unwrap().is_none());
        assert!(read_chat_message_for_index(&db, "blank").unwrap().is_none());
        assert!(read_chat_message_for_index(&db, "ok").unwrap().is_some());
        assert!(read_chat_message_for_index(&db, "nope").unwrap().is_none());
    }

    #[test]
    fn read_denormalizes_project_and_signals() {
        let db = mem_db();
        seed_message(
            &db,
            "p1",
            "s1",
            "m1",
            "assistant",
            "効いた発話",
            Some(r#"{"insertedToEditor":true,"extractedCodex":["x"]}"#),
        );
        let input = read_chat_message_for_index(&db, "m1").unwrap().unwrap();
        assert_eq!(input.project_id, "p1");
        assert_eq!(input.session_id, "s1");
        assert_eq!(input.role, "assistant");
        assert!(input.inserted_to_editor);
        assert_eq!(input.extracted_count, 1);
        assert_eq!(input.text, "効いた発話");
    }

    #[test]
    fn upsert_inserts_then_replaces_same_pk() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "本文", None);
        let input = read_chat_message_for_index(&db, "m1").unwrap().unwrap();

        let out = upsert_chat_chunk(
            &db,
            "m1",
            &input.hash,
            &emb_bytes(8, 0.1),
            &input.text,
            "m",
            8,
            "v1",
        )
        .unwrap();
        assert_eq!(out, ChatUpsertOutcome::Indexed(1));
        assert_eq!(count_chunks(&db, "m1"), 1);

        let out2 = upsert_chat_chunk(
            &db,
            "m1",
            &input.hash,
            &emb_bytes(8, 0.9),
            &input.text,
            "m",
            8,
            "v1",
        )
        .unwrap();
        assert_eq!(out2, ChatUpsertOutcome::Indexed(1));
        assert_eq!(count_chunks(&db, "m1"), 1);

        let (inserted, extracted, project_id, session_id) = read_chunk_signals(&db, "m1");
        assert_eq!(inserted, 0);
        assert_eq!(extracted, 0);
        assert_eq!(project_id, "p1");
        assert_eq!(session_id, "s1");
    }

    #[test]
    fn upsert_writes_signal_columns() {
        let db = mem_db();
        seed_message(
            &db,
            "p1",
            "s1",
            "m1",
            "user",
            "本文",
            Some(r#"{"insertedToEditor":true,"extractedCodex":["a","b"]}"#),
        );
        let input = read_chat_message_for_index(&db, "m1").unwrap().unwrap();
        upsert_chat_chunk(
            &db,
            "m1",
            &input.hash,
            &emb_bytes(8, 0.1),
            &input.text,
            "m",
            8,
            "v1",
        )
        .unwrap();
        let (inserted, extracted, _, _) = read_chunk_signals(&db, "m1");
        assert_eq!(inserted, 1);
        assert_eq!(extracted, 2);
    }

    #[test]
    fn metadata_change_invalidates_hash_and_refreshes_signals() {
        // 本文不変・metadata だけ変わったケース: 新 hash で再 index すると signal 列が更新。
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "本文", None);
        let first = read_chat_message_for_index(&db, "m1").unwrap().unwrap();
        upsert_chat_chunk(
            &db,
            "m1",
            &first.hash,
            &emb_bytes(8, 0.1),
            &first.text,
            "m",
            8,
            "v1",
        )
        .unwrap();
        let (inserted0, _, _, _) = read_chunk_signals(&db, "m1");
        assert_eq!(inserted0, 0);

        // editor 挿入 signal が付いた。
        set_metadata(&db, "m1", r#"{"insertedToEditor":true}"#);
        let second = read_chat_message_for_index(&db, "m1").unwrap().unwrap();
        assert_ne!(
            first.hash, second.hash,
            "metadata change must change the hash"
        );
        // 古い hash では破棄される。
        let stale = upsert_chat_chunk(
            &db,
            "m1",
            &first.hash,
            &emb_bytes(8, 0.1),
            &first.text,
            "m",
            8,
            "v1",
        )
        .unwrap();
        assert_eq!(stale, ChatUpsertOutcome::SkippedHashMismatch);
        // 新 hash で再 index → signal 列が更新される。
        upsert_chat_chunk(
            &db,
            "m1",
            &second.hash,
            &emb_bytes(8, 0.1),
            &second.text,
            "m",
            8,
            "v1",
        )
        .unwrap();
        let (inserted1, _, _, _) = read_chunk_signals(&db, "m1");
        assert_eq!(inserted1, 1, "re-index must refresh signal columns");
    }

    #[test]
    fn upsert_skips_on_content_hash_mismatch() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "本文", None);
        let input = read_chat_message_for_index(&db, "m1").unwrap().unwrap();
        upsert_chat_chunk(
            &db,
            "m1",
            &input.hash,
            &emb_bytes(8, 0.1),
            &input.text,
            "m",
            8,
            "v1",
        )
        .unwrap();

        // 並行編集で本文が書き換わった。
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE chat_messages SET content = ? WHERE id = ?",
                params!["別本文", "m1"],
            )?;
            Ok(())
        })
        .unwrap();

        let out = upsert_chat_chunk(
            &db,
            "m1",
            &input.hash,
            &emb_bytes(8, 0.5),
            &input.text,
            "m",
            8,
            "v1",
        )
        .unwrap();
        assert_eq!(out, ChatUpsertOutcome::SkippedHashMismatch);
        assert_eq!(count_chunks(&db, "m1"), 1);
    }

    #[test]
    fn upsert_skips_missing_and_system() {
        let db = mem_db();
        let out =
            upsert_chat_chunk(&db, "nope", "h", &emb_bytes(8, 0.1), "t", "m", 8, "v1").unwrap();
        assert_eq!(out, ChatUpsertOutcome::SkippedMissing);

        seed_message(&db, "p1", "s1", "sys", "system", "internal", None);
        // system は read で None。仮に hash を渡しても upsert で SkippedMissing。
        let out2 = upsert_chat_chunk(&db, "sys", "anyhash", &emb_bytes(8, 0.1), "t", "m", 8, "v1")
            .unwrap();
        assert_eq!(out2, ChatUpsertOutcome::SkippedMissing);
        assert_eq!(count_chunks(&db, "sys"), 0);
    }

    #[test]
    fn upsert_rejects_short_embedding() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "本文", None);
        let input = read_chat_message_for_index(&db, "m1").unwrap().unwrap();
        let r = upsert_chat_chunk(
            &db,
            "m1",
            &input.hash,
            &[0, 0, 0],
            &input.text,
            "m",
            8,
            "v1",
        );
        assert!(r.is_err(), "short embedding must be rejected");
    }

    #[test]
    fn cascade_delete_on_message_removal() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "本文", None);
        let input = read_chat_message_for_index(&db, "m1").unwrap().unwrap();
        upsert_chat_chunk(
            &db,
            "m1",
            &input.hash,
            &emb_bytes(8, 0.1),
            &input.text,
            "m",
            8,
            "v1",
        )
        .unwrap();
        assert_eq!(count_chunks(&db, "m1"), 1);

        db.with_conn(|conn| {
            conn.execute("DELETE FROM chat_messages WHERE id = ?", params!["m1"])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(count_chunks(&db, "m1"), 0);
    }

    #[test]
    fn cascade_delete_on_session_removal() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "本文", None);
        let input = read_chat_message_for_index(&db, "m1").unwrap().unwrap();
        upsert_chat_chunk(
            &db,
            "m1",
            &input.hash,
            &emb_bytes(8, 0.1),
            &input.text,
            "m",
            8,
            "v1",
        )
        .unwrap();
        db.with_conn(|conn| {
            conn.execute("DELETE FROM chat_sessions WHERE id = ?", params!["s1"])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            count_chunks(&db, "m1"),
            0,
            "session delete cascades to chunks"
        );
    }

    fn index_message(db: &Database, message_id: &str, model_id: &str) {
        let input = read_chat_message_for_index(db, message_id)
            .unwrap()
            .unwrap();
        upsert_chat_chunk(
            db,
            message_id,
            &input.hash,
            &emb_bytes(8, 0.1),
            &input.text,
            model_id,
            8,
            "v1",
        )
        .unwrap();
    }

    #[test]
    fn list_message_ids_scoped_and_filtered() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "A", None);
        seed_message(&db, "p1", "s1", "m2", "assistant", "B", None);
        seed_message(&db, "p1", "s1", "sys", "system", "internal", None);
        seed_message(&db, "p1", "s1", "blank", "user", "  ", None);
        seed_message(&db, "p2", "s2", "m3", "user", "C", None);
        let mut ids = list_message_ids_in_project(&db, "p1").unwrap();
        ids.sort();
        assert_eq!(ids, vec!["m1".to_string(), "m2".to_string()]);
    }

    #[test]
    fn index_status_counts_total_and_indexed() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "A", None);
        seed_message(&db, "p1", "s1", "m2", "assistant", "B", None);
        seed_message(&db, "p1", "s1", "m3", "user", "C", None);
        seed_message(&db, "p1", "s1", "sys", "system", "internal", None);
        index_message(&db, "m1", "m");
        index_message(&db, "m2", "m");
        let s = collect_chat_index_status(&db, "p1", "m", 8, "v1").unwrap();
        assert_eq!(s.total_message_count, 3, "system excluded from total");
        assert_eq!(s.indexed_message_count, 2);
    }

    #[test]
    fn index_status_excludes_stale_model() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "A", None);
        index_message(&db, "m1", "old-model");
        let s = collect_chat_index_status(&db, "p1", "m", 8, "v1").unwrap();
        assert_eq!(s.total_message_count, 1);
        assert_eq!(
            s.indexed_message_count, 0,
            "stale model row must not count as indexed"
        );
    }

    #[test]
    fn index_status_scoped_to_project() {
        let db = mem_db();
        seed_message(&db, "p1", "s1", "m1", "user", "A", None);
        seed_message(&db, "p2", "s2", "m2", "user", "B", None);
        index_message(&db, "m1", "m");
        index_message(&db, "m2", "m");
        let s = collect_chat_index_status(&db, "p1", "m", 8, "v1").unwrap();
        assert_eq!(s.total_message_count, 1);
        assert_eq!(s.indexed_message_count, 1);
    }

    #[test]
    fn project_language_resolves_via_session() {
        let db = mem_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES ('p1', 'en proj', 'en')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        seed_message(&db, "p1", "s1", "m1", "user", "hi", None);
        assert_eq!(project_language_for_chat_message(&db, "m1").unwrap(), "en");
        assert_eq!(
            project_language_for_chat_message(&db, "nope").unwrap(),
            "ja",
            "missing message falls back to ja"
        );
    }
}
