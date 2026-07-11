//! Chronicle event 埋め込み index (Phase 3): codex の `codex_index.rs` を
//! 「作中年表の出来事」用にフォークした版。codex と同じく「チャンク不要・
//! 1 出来事 1 ベクトル」。
//!
//! 出来事レコード (title + note + 主役名 + 場所名 + 参加者名) は短いので、
//! scene のような段落チャンカーは通さず entry 全体を 1 ベクトルで埋める。
//!
//! race condition 戦略は codex と同型: 呼び出し側が embed 前に event を読んで
//! hash 算出 → embed 中は DB lock を放す → `upsert_event_chunk` が TX 内で
//! event を再 SELECT・再 hash し、`expected_hash` 不一致なら破棄。
//!
//! ## 受容する Phase-3 の制約 (cross-entity eventual consistency)
//! hash は参加者の **名前** (id ではなく) を含むため、出来事自体を編集すれば
//! 名前変更も再インデックスされる。しかし参照先の codex (主役/場所/参加者) を
//! **リネームしただけ**では、その出来事が次に変更されるまで自動再インデックス
//! されない。codex 名の伝播はイベント側の hash には伝わらないため、名前変更が
//! event 検索に反映されるのは「その出来事が次に mutate されたとき」になる。
//!
//! pure logic (`build_event_embed_text` / `compute_event_content_hash` /
//! `upsert_event_chunk` / `read_event_for_index` / `list_event_ids_in_project`)
//! は `semantic-embedding` feature 無しで build でき、`--no-default-features`
//! で検証可能。Embedder を借りる `embed_event_text` のみ feature gate。

#![allow(dead_code)]

use anyhow::{ensure, Result};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use grimodex_db::Database;

/// `events` 1 行の hash 入力フィールド: (title, kind, note, primary_codex_id, location_codex_id)。
/// `upsert_event_chunk` の TX 内 re-SELECT 結果の型 (clippy::type_complexity 回避)。
type EventUpsertRow = (String, String, String, Option<String>, Option<String>);

/// upsert の結果。event は 1 出来事 1 ベクトルなので Indexed は 0 か 1。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventUpsertOutcome {
    /// 投入したベクトル数 (常に 1)。
    Indexed(usize),
    /// TX 開始時の hash が呼び出し側の expected_hash と不一致。古い job 等。
    SkippedHashMismatch,
    /// event_id が存在しない。
    SkippedMissing,
}

/// codex_entries.name を id から引く。null / 空 / 不在は空文字。
fn resolve_codex_name(conn: &Connection, codex_id: Option<&str>) -> Result<String> {
    let Some(id) = codex_id else {
        return Ok(String::new());
    };
    if id.is_empty() {
        return Ok(String::new());
    }
    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM codex_entries WHERE id = ?",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .ok();
    Ok(name.unwrap_or_default())
}

/// 出来事の参加者 codex 名を name 昇順で集める。
fn gather_participant_names(conn: &Connection, event_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT ce.name FROM event_participants ep \
         JOIN codex_entries ce ON ce.id = ep.codex_entry_id \
         WHERE ep.event_id = ? ORDER BY ce.name",
    )?;
    let rows = stmt.query_map(params![event_id], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 埋め込み対象テキストを組み立てる: `title。note。主役名。場所名。参加者名…`。
/// 空フィールドは除外、区切りは「。」(codex の `build_codex_embed_text` と同形)。
pub fn build_event_embed_text(
    title: &str,
    note: &str,
    primary_name: &str,
    location_name: &str,
    participant_names: &[String],
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !title.is_empty() {
        parts.push(title.to_string());
    }
    if !note.is_empty() {
        parts.push(note.to_string());
    }
    if !primary_name.is_empty() {
        parts.push(primary_name.to_string());
    }
    if !location_name.is_empty() {
        parts.push(location_name.to_string());
    }
    let participants_joined = participant_names.join(" ");
    if !participants_joined.is_empty() {
        parts.push(participants_joined);
    }
    parts.join("。")
}

/// 出来事の DB 状態から決定的に hash を出す。`read_event_for_index` (read 時) と
/// `upsert_event_chunk` (TX 内 re-check) が同じ入力で同じ hash を出すための正本。
///
/// 参加者は **名前** で hash に含める (id ではない)。出来事自体を mutate すれば
/// 名前変更も反映されるが、参照先 codex をリネームしただけでは出来事が次に
/// 変更されるまで再インデックスされない (cross-entity eventual consistency)。
pub fn compute_event_content_hash(
    title: &str,
    note: &str,
    primary_name: &str,
    location_name: &str,
    participant_names: &[String],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(title.as_bytes());
    hasher.update([0u8]);
    hasher.update(note.as_bytes());
    hasher.update([0u8]);
    hasher.update(primary_name.as_bytes());
    hasher.update([0u8]);
    hasher.update(location_name.as_bytes());
    hasher.update([0u8]);
    for name in participant_names {
        hasher.update(name.as_bytes());
        hasher.update([0u8]);
    }
    hex::encode(hasher.finalize())
}

/// event の埋め込みテキストと initial hash を読み出す (DB lock は読み出しの間だけ)。
/// `None` = 該当 id が存在しない。主役/場所名・参加者名はここで resolve する。
pub fn read_event_for_index(db: &Database, event_id: &str) -> Result<Option<(String, String)>> {
    db.with_conn(|conn| {
        let row: Option<(String, String, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT title, COALESCE(note, ''), primary_codex_id, location_codex_id
                 FROM events WHERE id = ?",
                params![event_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .ok();

        let Some((title, note, primary_id, location_id)) = row else {
            return Ok(None);
        };

        let primary_name = resolve_codex_name(conn, primary_id.as_deref())?;
        let location_name = resolve_codex_name(conn, location_id.as_deref())?;
        let participant_names = gather_participant_names(conn, event_id)?;

        let text = build_event_embed_text(
            &title,
            &note,
            &primary_name,
            &location_name,
            &participant_names,
        );
        let hash = compute_event_content_hash(
            &title,
            &note,
            &primary_name,
            &location_name,
            &participant_names,
        );
        Ok(Some((text, hash)))
    })
}

/// `event_chunks` の 1 行を upsert する (PK=event_id なので INSERT OR REPLACE)。
///
/// TX 内で event を再 SELECT・再 hash し、`expected_hash` と一致するときだけ書く。
/// 不一致なら `SkippedHashMismatch`、event 不在なら `SkippedMissing`。
#[allow(clippy::too_many_arguments)]
pub fn upsert_event_chunk(
    db: &Database,
    event_id: &str,
    expected_hash: &str,
    embedding: &[u8],
    text: &str,
    model_id: &str,
    embedding_dim: usize,
    chunker_version: &str,
) -> Result<EventUpsertOutcome> {
    ensure!(
        embedding.len() == embedding_dim * 4,
        "embedding len {} != dim {} * 4 = {}",
        embedding.len(),
        embedding_dim,
        embedding_dim * 4
    );

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;

        let row: Option<EventUpsertRow> = tx
            .query_row(
                "SELECT title, kind, COALESCE(note, ''), primary_codex_id, location_codex_id
                 FROM events WHERE id = ?",
                params![event_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .ok();

        let Some((title, kind, note, primary_id, location_id)) = row else {
            return Ok(EventUpsertOutcome::SkippedMissing);
        };

        // hash 入力と同じフィールドを TX 内で再 gather する。
        let primary_name = resolve_codex_name(&tx, primary_id.as_deref())?;
        let location_name = resolve_codex_name(&tx, location_id.as_deref())?;
        let participant_names = gather_participant_names(&tx, event_id)?;

        let current_hash = compute_event_content_hash(
            &title,
            &note,
            &primary_name,
            &location_name,
            &participant_names,
        );
        if current_hash != expected_hash {
            return Ok(EventUpsertOutcome::SkippedHashMismatch);
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        tx.execute(
            "INSERT OR REPLACE INTO event_chunks (
                event_id, event_title, event_kind, text, embedding,
                embedding_dim, model_id, content_hash, chunker_version,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                event_id,
                title,
                kind,
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
        Ok(EventUpsertOutcome::Indexed(1))
    })
}

/// 指定 project 配下の event id 一覧 (reindex 用)。
pub fn list_event_ids_in_project(db: &Database, project_id: &str) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT id FROM events WHERE project_id = ? ORDER BY ordinal, id")?;
        let rows = stmt.query_map(params![project_id], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// project の event index 充足状況 (bulk back-index 要否判定用)。
/// `indexed_event_count < total_event_count` なら未 index の既存出来事がある。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventsIndexStatus {
    /// 現 spec (model_id/embedding_dim/chunker_version) に一致する event_chunks 行数
    /// (= index 済み event 数)。stale 行は数えない。
    pub indexed_event_count: usize,
    /// project 配下の events 総数。
    pub total_event_count: usize,
}

/// event の index 充足状況を 1 回の `with_conn` で集計する。Embedder 不要の cheap
/// クエリ (codex の `collect_codex_index_status` と同型)。event_chunks は PK=event_id
/// なので 行数 = index 済み event 数。`indexed` は現 spec 一致行のみ (stale 除外)。
pub fn collect_events_index_status(
    db: &Database,
    project_id: &str,
    current_model_id: &str,
    current_embedding_dim: usize,
    current_chunker_version: &str,
) -> Result<EventsIndexStatus> {
    db.with_conn(|conn| {
        let total_event_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM events WHERE project_id = ?",
            params![project_id],
            |row| row.get(0),
        )?;

        let indexed_event_count: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM event_chunks ec
             JOIN events e ON e.id = ec.event_id
             WHERE e.project_id = ?
               AND ec.model_id = ?
               AND ec.embedding_dim = ?
               AND ec.chunker_version = ?",
            params![
                project_id,
                current_model_id,
                current_embedding_dim as i64,
                current_chunker_version,
            ],
            |row| row.get(0),
        )?;

        Ok(EventsIndexStatus {
            indexed_event_count: indexed_event_count as usize,
            total_event_count: total_event_count as usize,
        })
    })
}

/// event_id からそのプロジェクトの言語を引く (events → projects JOIN)。
/// 行が無ければ "ja"。spec 選択に使う (非 gated)。
pub fn project_language_for_event(db: &Database, event_id: &str) -> Result<String> {
    db.with_conn(|conn| {
        let lang: Option<String> = conn
            .query_row(
                "SELECT p.language FROM projects p \
                 JOIN events e ON e.project_id = p.id \
                 WHERE e.id = ?",
                params![event_id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        Ok(lang.unwrap_or_else(|| "ja".to_string()))
    })
}

/// text を embed して LE f32 バイト列 (1 ベクトル) を返す。チャンカーは通さない。
/// DB に触れない純 CPU 処理。呼び出し側は workspace lock の外で呼ぶこと。
#[cfg(feature = "semantic-embedding")]
pub fn embed_event_text(embedder: &mut crate::embedding::Embedder, text: &str) -> Result<Vec<u8>> {
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

    /// project + (任意) codex_entry を seed する。codex_entries の複合 FK
    /// (project_id, type) → codex_types(project_id, slug) を満たすため type を先に作る。
    fn seed_codex(db: &Database, project_id: &str, entry_id: &str, name: &str) {
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
                 VALUES (?, ?, 'character', ?, '', '{}', datetime('now'), datetime('now'))",
                params![entry_id, project_id, name],
            )?;
            Ok(())
        })
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_event(
        db: &Database,
        project_id: &str,
        event_id: &str,
        title: &str,
        note: &str,
        primary_codex_id: Option<&str>,
        location_codex_id: Option<&str>,
        kind: &str,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO projects (id, title, language) VALUES (?, 'test', 'ja')",
                params![project_id],
            )?;
            conn.execute(
                "INSERT INTO events (id, project_id, title, note, ordinal, primary_codex_id, location_codex_id, kind, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'a0', ?, ?, ?, datetime('now'), datetime('now'))",
                params![event_id, project_id, title, note, primary_codex_id, location_codex_id, kind],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn add_participant(db: &Database, event_id: &str, codex_entry_id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO event_participants (event_id, codex_entry_id) VALUES (?, ?)",
                params![event_id, codex_entry_id],
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

    fn count_chunks(db: &Database, event_id: &str) -> i64 {
        db.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM event_chunks WHERE event_id = ?",
                params![event_id],
                |r| r.get(0),
            )?;
            Ok(n)
        })
        .unwrap()
    }

    #[test]
    fn embed_text_includes_title_note_names_and_participants() {
        let t = build_event_embed_text(
            "邂逅",
            "神社で出会う",
            "朱音",
            "古い神社",
            &["蓮".to_string(), "芽衣".to_string()],
        );
        assert!(t.contains("邂逅"));
        assert!(t.contains("神社で出会う"));
        assert!(t.contains("朱音"));
        assert!(t.contains("古い神社"));
        assert!(t.contains("蓮"));
        assert!(t.contains("芽衣"));
    }

    /// 空フィールドは除外され区切りが二重にならないことを確認。
    #[test]
    fn embed_text_skips_empty_parts() {
        let t = build_event_embed_text("題", "", "", "", &[]);
        assert_eq!(t, "題");
    }

    #[test]
    fn content_hash_changes_with_any_field() {
        let base = compute_event_content_hash("t", "n", "p", "l", &["a".into()]);
        assert_eq!(
            base,
            compute_event_content_hash("t", "n", "p", "l", &["a".into()])
        );
        assert_ne!(
            base,
            compute_event_content_hash("T", "n", "p", "l", &["a".into()])
        );
        assert_ne!(
            base,
            compute_event_content_hash("t", "N", "p", "l", &["a".into()])
        );
        assert_ne!(
            base,
            compute_event_content_hash("t", "n", "P", "l", &["a".into()])
        );
        assert_ne!(
            base,
            compute_event_content_hash("t", "n", "p", "L", &["a".into()])
        );
        assert_ne!(
            base,
            compute_event_content_hash("t", "n", "p", "l", &["b".into()])
        );
        assert_ne!(base, compute_event_content_hash("t", "n", "p", "l", &[]));
        assert_eq!(base.len(), 64);
    }

    #[test]
    fn read_resolves_names_into_text_and_hash() {
        let db = mem_db();
        seed_codex(&db, "p1", "primary1", "朱音");
        seed_codex(&db, "p1", "loc1", "古い神社");
        seed_codex(&db, "p1", "part1", "蓮");
        seed_event(
            &db,
            "p1",
            "e1",
            "邂逅",
            "出会う",
            Some("primary1"),
            Some("loc1"),
            "generic",
        );
        add_participant(&db, "e1", "part1");
        let (text, hash) = read_event_for_index(&db, "e1").unwrap().unwrap();
        assert!(text.contains("朱音"));
        assert!(text.contains("古い神社"));
        assert!(text.contains("蓮"));
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn upsert_inserts_then_replaces_same_pk() {
        let db = mem_db();
        seed_event(&db, "p1", "e1", "邂逅", "出会う", None, None, "generic");
        let (text, hash) = read_event_for_index(&db, "e1").unwrap().unwrap();

        let out =
            upsert_event_chunk(&db, "e1", &hash, &emb_bytes(8, 0.1), &text, "m", 8, "v1").unwrap();
        assert_eq!(out, EventUpsertOutcome::Indexed(1));
        assert_eq!(count_chunks(&db, "e1"), 1);

        let out2 =
            upsert_event_chunk(&db, "e1", &hash, &emb_bytes(8, 0.9), &text, "m", 8, "v1").unwrap();
        assert_eq!(out2, EventUpsertOutcome::Indexed(1));
        assert_eq!(count_chunks(&db, "e1"), 1);
    }

    #[test]
    fn upsert_skips_on_hash_mismatch() {
        let db = mem_db();
        seed_event(&db, "p1", "e1", "邂逅", "出会う", None, None, "generic");
        let (text, hash) = read_event_for_index(&db, "e1").unwrap().unwrap();
        upsert_event_chunk(&db, "e1", &hash, &emb_bytes(8, 0.1), &text, "m", 8, "v1").unwrap();

        // 並行する別 save が title を書き換えたケースを模擬。
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE events SET title = ? WHERE id = ?",
                params!["別の出来事", "e1"],
            )?;
            Ok(())
        })
        .unwrap();

        let out =
            upsert_event_chunk(&db, "e1", &hash, &emb_bytes(8, 0.5), &text, "m", 8, "v1").unwrap();
        assert_eq!(out, EventUpsertOutcome::SkippedHashMismatch);
        assert_eq!(count_chunks(&db, "e1"), 1);
    }

    #[test]
    fn upsert_skips_when_participant_added_after_read() {
        // 参加者名が hash に含まれるので、read 後に参加者が増えると hash mismatch。
        let db = mem_db();
        seed_codex(&db, "p1", "part1", "蓮");
        seed_event(&db, "p1", "e1", "邂逅", "", None, None, "generic");
        let (text, hash) = read_event_for_index(&db, "e1").unwrap().unwrap();
        add_participant(&db, "e1", "part1");
        let out =
            upsert_event_chunk(&db, "e1", &hash, &emb_bytes(8, 0.1), &text, "m", 8, "v1").unwrap();
        assert_eq!(out, EventUpsertOutcome::SkippedHashMismatch);
    }

    #[test]
    fn upsert_skips_missing_event() {
        let db = mem_db();
        let out =
            upsert_event_chunk(&db, "nope", "h", &emb_bytes(8, 0.1), "t", "m", 8, "v1").unwrap();
        assert_eq!(out, EventUpsertOutcome::SkippedMissing);
    }

    #[test]
    fn upsert_rejects_short_embedding() {
        let db = mem_db();
        seed_event(&db, "p1", "e1", "邂逅", "", None, None, "generic");
        let (text, hash) = read_event_for_index(&db, "e1").unwrap().unwrap();
        let r = upsert_event_chunk(&db, "e1", &hash, &[0, 0, 0], &text, "m", 8, "v1");
        assert!(r.is_err(), "short embedding must be rejected");
    }

    #[test]
    fn cascade_delete_on_event_removal() {
        let db = mem_db();
        seed_event(&db, "p1", "e1", "邂逅", "", None, None, "generic");
        let (text, hash) = read_event_for_index(&db, "e1").unwrap().unwrap();
        upsert_event_chunk(&db, "e1", &hash, &emb_bytes(8, 0.1), &text, "m", 8, "v1").unwrap();
        assert_eq!(count_chunks(&db, "e1"), 1);

        db.with_conn(|conn| {
            conn.execute("DELETE FROM events WHERE id = ?", params!["e1"])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(count_chunks(&db, "e1"), 0);
    }

    #[test]
    fn list_event_ids_scoped_to_project() {
        let db = mem_db();
        seed_event(&db, "p1", "e1", "A", "", None, None, "generic");
        seed_event(&db, "p1", "e2", "B", "", None, None, "generic");
        seed_event(&db, "p2", "e3", "C", "", None, None, "generic");
        let ids = list_event_ids_in_project(&db, "p1").unwrap();
        assert_eq!(ids, vec!["e1".to_string(), "e2".to_string()]);
    }

    /// テスト用: event を指定 model で index する (dim 8 / ver "v1" 固定)。
    fn index_event(db: &Database, event_id: &str, model_id: &str) {
        let (text, hash) = read_event_for_index(db, event_id).unwrap().unwrap();
        upsert_event_chunk(
            db,
            event_id,
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
        seed_event(&db, "p1", "e1", "A", "", None, None, "generic");
        seed_event(&db, "p1", "e2", "B", "", None, None, "generic");
        seed_event(&db, "p1", "e3", "C", "", None, None, "generic");
        index_event(&db, "e1", "m");
        index_event(&db, "e2", "m");
        let s = collect_events_index_status(&db, "p1", "m", 8, "v1").unwrap();
        assert_eq!(s.total_event_count, 3);
        assert_eq!(s.indexed_event_count, 2);
    }

    #[test]
    fn index_status_excludes_stale_model() {
        let db = mem_db();
        seed_event(&db, "p1", "e1", "A", "", None, None, "generic");
        index_event(&db, "e1", "old-model");
        let s = collect_events_index_status(&db, "p1", "m", 8, "v1").unwrap();
        assert_eq!(s.total_event_count, 1);
        assert_eq!(
            s.indexed_event_count, 0,
            "stale model row must not count as indexed"
        );
    }

    #[test]
    fn index_status_scoped_to_project() {
        let db = mem_db();
        seed_event(&db, "p1", "e1", "A", "", None, None, "generic");
        seed_event(&db, "p2", "e2", "B", "", None, None, "generic");
        index_event(&db, "e1", "m");
        index_event(&db, "e2", "m");
        let s = collect_events_index_status(&db, "p1", "m", 8, "v1").unwrap();
        assert_eq!(s.total_event_count, 1);
        assert_eq!(s.indexed_event_count, 1);
    }

    #[test]
    fn project_language_for_event_resolves_or_defaults() {
        let db = mem_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES ('p1', 'test', 'en')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        seed_event(&db, "p1", "e1", "A", "", None, None, "generic");
        assert_eq!(project_language_for_event(&db, "e1").unwrap(), "en");
        // 不在 event は既定 ja。
        assert_eq!(project_language_for_event(&db, "nope").unwrap(), "ja");
    }
}
