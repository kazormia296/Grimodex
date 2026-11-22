//! 英語 project 用 `_en` FTS 索引の AFTER DELETE trigger の回帰試験。
//!
//! 旧形の trigger は `projects.language` を引く WHEN を持っていた。FK の ON DELETE
//! CASCADE は親行（projects／chat_sessions）を先に消すので、副照会が NULL になって
//! trigger が発火せず、chat_messages／codex_entries／snippets の `_en` に孤児の行が
//! 残った。本体の rowid が再利用されると次の保存が standalone FTS5 の rowid 重複
//! （constraint failed 1555）で決まって失敗し、削除済みの本文も `*_en_content`
//! （shadow）に平文で残った。
//!
//! 守る性質：
//! * 3 つの削除の経路（session 削除、履歴の全消去、project 削除）の後に孤児が 0 で、
//!   その後の保存が成功する（chat／codex／snippets）。
//! * 旧形の trigger を持つ現行版の DB は checkpoint が偽になり、`migrate()` で trigger が
//!   差し替わって孤児が消える。版（`user_version`）は変わらず、英語の生きた行は残る。
//! * 収束後の再 open は trigger を作り直さない。
//! * 日本語の project は何も変わらない。

#[path = "../test-support/adapter.rs"]
mod test_support;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use grimodex_core::workspace_schema::{
    has_current_schema_checkpoint_invariants, has_en_fts_delete_triggers,
};
use grimodex_db::domain_writes::{project_delete, ProjectDeletePayload};
use grimodex_db::Database;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

/// `(本体, `_en` 索引表)`。tree_nodes と post_effect_annotations は PR #233 で guard が
/// 外れていた表で、同じ性質が崩れていないことの対照にする。
const SYNCED: [(&str, &str); 5] = [
    ("chat_messages", "chat_messages_fts_en"),
    ("codex_entries", "codex_fts_en"),
    ("snippets", "snippets_fts_en"),
    ("tree_nodes", "tree_nodes_fts_en"),
    ("post_effect_annotations", "post_effect_annotations_fts_en"),
];

/// 旧形（guard 付き）の `_ad` trigger。#233 が外し漏れた 3 本を verbatim で持つ。旧 build は
/// `en_ad_unguarded` の旗を書かないので、旗も消す。
const LEGACY_GUARDED_DELETE_TRIGGERS: &str = "\
DROP TRIGGER chat_messages_fts_en_ad;
CREATE TRIGGER chat_messages_fts_en_ad AFTER DELETE ON chat_messages WHEN (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = old.session_id)) LIKE 'en%' BEGIN DELETE FROM chat_messages_fts_en WHERE rowid = old.rowid; END;
DROP TRIGGER codex_fts_en_ad;
CREATE TRIGGER codex_fts_en_ad AFTER DELETE ON codex_entries WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%' BEGIN DELETE FROM codex_fts_en WHERE rowid = old.rowid; END;
DROP TRIGGER snippets_fts_en_ad;
CREATE TRIGGER snippets_fts_en_ad AFTER DELETE ON snippets WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%' BEGIN DELETE FROM snippets_fts_en WHERE rowid = old.rowid; END;
DELETE FROM fts_meta WHERE key = 'en_ad_unguarded';";

/// 英語 project `pe`（session se1／se2／se3）と日本語 project `pj`（sj1）。
///
/// chat の rowid は挿入順：e1,e2 (se1) → j1 (sj1) → e3,e4 (se2) → e5 (se3)。
/// 末尾は se3 → se2 の順に英語の行。codex／snippets は日本語の行を先に入れ、英語の行を
/// 末尾に置く。末尾の行を消すと次の INSERT が同じ rowid を再利用する。
const SEED: &str = "
INSERT INTO projects (id, title, language) VALUES ('pj','Ja','ja'), ('pe','En','en');
INSERT INTO chat_sessions (id, project_id, title, model) VALUES
  ('se1','pe','E1','m'), ('se2','pe','E2','m'), ('se3','pe','E3','m'), ('sj1','pj','J1','m');
INSERT INTO chat_messages (id, session_id, role, content) VALUES
  ('e1','se1','assistant','alpha dragon fortress'),
  ('e2','se1','assistant','bravo harbor lantern'),
  ('j1','sj1','assistant','japanese tail message marker'),
  ('e3','se2','assistant','charlie orchard whisper'),
  ('e4','se2','assistant','delta glacier compass'),
  ('e5','se3','assistant','echo meadow cipher');
INSERT INTO codex_entries (id, project_id, name, content) VALUES
  ('cj1','pj','Japanese codex','ja codex body'),
  ('ce1','pe','Codexone','codexalpha uniqueword'),
  ('ce2','pe','Codextwo','codexbravo uniqueword');
INSERT INTO snippets (id, project_id, title, content) VALUES
  ('sj1','pj','Japanese snippet','ja snippet body'),
  ('sn1','pe','Snipone','snipalpha uniqueword'),
  ('sn2','pe','Sniptwo','snipbravo uniqueword');
INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order) VALUES
  ('tj1','pj','scene','Ja scene','ja scene body','a0'),
  ('te1','pe','scene','Treeone','treealpha uniqueword','a0');";

fn seeded() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    exec(&db, SEED).expect("seed");
    db
}

fn exec(db: &Database, sql: &str) -> Result<(), String> {
    db.with_conn(|conn| Ok(conn.execute_batch(sql)?))
        .map_err(|error| format!("{error:#}"))
}

fn count(db: &Database, sql: &str) -> i64 {
    db.with_conn(|conn| Ok(conn.query_row(sql, [], |row| row.get::<_, i64>(0))?))
        .unwrap_or_else(|error| panic!("{sql}: {error:#}"))
}

/// 本体のうち「英語 project の行」の rowid を返す副照会（`rebuild_en_fts_sql` と同じ基準）。
fn english_rowids(base: &str) -> String {
    let english_projects = "SELECT id FROM projects WHERE language LIKE 'en%'";
    if base == "chat_messages" {
        format!(
            "SELECT rowid FROM chat_messages WHERE session_id IN \
             (SELECT id FROM chat_sessions WHERE project_id IN ({english_projects}))"
        )
    } else {
        format!("SELECT rowid FROM {base} WHERE project_id IN ({english_projects})")
    }
}

/// `_en` の行のうち、本体の英語の行に対応しないもの（孤児と、日本語の行が rowid を
/// 再利用して残った古い行の両方）。
fn stray_en_rows(db: &Database, base: &str, fts: &str) -> i64 {
    count(
        db,
        &format!(
            "SELECT count(*) FROM {fts} WHERE rowid NOT IN ({})",
            english_rowids(base)
        ),
    )
}

/// 削除済みの本文が残る `_en` の shadow（`*_content`）の行数。
fn stray_en_content_rows(db: &Database, base: &str, fts: &str) -> i64 {
    count(
        db,
        &format!(
            "SELECT count(*) FROM {fts}_content WHERE id NOT IN ({})",
            english_rowids(base)
        ),
    )
}

fn assert_no_stray_en_rows(db: &Database, label: &str) {
    for (base, fts) in SYNCED {
        assert_eq!(
            stray_en_rows(db, base, fts),
            0,
            "{label}: {fts} に本体の英語の行に対応しない行が残っている"
        );
        assert_eq!(
            stray_en_content_rows(db, base, fts),
            0,
            "{label}: {fts}_content に削除済みの本文が残っている"
        );
    }
}

/// `_en` の行数は、本体の英語の行の数と一致する（索引が欠けても余ってもいない）。
fn assert_en_matches_live_english_rows(db: &Database, label: &str) {
    for (base, fts) in SYNCED {
        assert_eq!(
            count(db, &format!("SELECT count(*) FROM {fts}")),
            count(
                db,
                &format!("SELECT count(*) FROM ({})", english_rowids(base))
            ),
            "{label}: {fts} の行数が本体の英語の行数と違う"
        );
    }
}

/// FTS5 の segment（`*_data` の blob）に、削除済みの語が生のまま残っている block の数。
/// `DELETE` は語を segment に残し、`optimize` の merge で初めて取り除かれる。
fn data_blocks_with(db: &Database, fts: &str, term: &str) -> i64 {
    count(
        db,
        &format!("SELECT count(*) FROM {fts}_data WHERE instr(block, CAST('{term}' AS BLOB)) > 0"),
    )
}

fn en_ad_unguarded_flag(db: &Database) -> i64 {
    count(
        db,
        "SELECT count(*) FROM fts_meta WHERE key = 'en_ad_unguarded' AND value = '1'",
    )
}

/// 旧 build（master の `ensure_en_fts`）が full DDL で行う `_ad` trigger の処理を模す。
/// `en_ad_unguarded` の旗が無ければ 5 本を DROP し、`CREATE TRIGGER IF NOT EXISTS` で旧形
/// （chat／codex／snippets は guard 付き、tree_nodes／post_effect_annotations は guard なし）
/// を入れる。旗があれば DROP せず、既存の trigger があるので CREATE は何もしない。
fn replay_old_build_delete_trigger_ddl(db: &Database) {
    if en_ad_unguarded_flag(db) == 0 {
        exec(
            db,
            "DROP TRIGGER IF EXISTS codex_fts_en_ad;
             DROP TRIGGER IF EXISTS snippets_fts_en_ad;
             DROP TRIGGER IF EXISTS chat_messages_fts_en_ad;
             DROP TRIGGER IF EXISTS tree_nodes_fts_en_ad;
             DROP TRIGGER IF EXISTS post_effect_annotations_fts_en_ad;",
        )
        .expect("old build drops the delete triggers");
    }
    exec(
        db,
        "CREATE TRIGGER IF NOT EXISTS codex_fts_en_ad AFTER DELETE ON codex_entries
           WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%'
         BEGIN DELETE FROM codex_fts_en WHERE rowid = old.rowid; END;
         CREATE TRIGGER IF NOT EXISTS snippets_fts_en_ad AFTER DELETE ON snippets
           WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%'
         BEGIN DELETE FROM snippets_fts_en WHERE rowid = old.rowid; END;
         CREATE TRIGGER IF NOT EXISTS chat_messages_fts_en_ad AFTER DELETE ON chat_messages
           WHEN (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = old.session_id)) LIKE 'en%'
         BEGIN DELETE FROM chat_messages_fts_en WHERE rowid = old.rowid; END;
         CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_en_ad AFTER DELETE ON tree_nodes
         BEGIN DELETE FROM tree_nodes_fts_en WHERE rowid = old.rowid; END;
         CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_en_ad AFTER DELETE ON post_effect_annotations
         BEGIN DELETE FROM post_effect_annotations_fts_en WHERE rowid = old.rowid; END;",
    )
    .expect("old build recreates the delete triggers");
}

fn en_hits(db: &Database, fts: &str, word: &str) -> i64 {
    count(
        db,
        &format!("SELECT count(*) FROM {fts} WHERE {fts} MATCH '\"{word}\"'"),
    )
}

/// 英語 project への保存（chat／codex／snippets）が通り、`_en` に索引される。
fn assert_english_saves_succeed(db: &Database, session: &str, project: &str, tag: &str) {
    exec(
        db,
        &format!(
            "INSERT INTO chat_messages (id, session_id, role, content)
               VALUES ('chat-{tag}','{session}','assistant','chatnew{tag} fresh');
             INSERT INTO codex_entries (id, project_id, name, content)
               VALUES ('codex-{tag}','{project}','Codexnew{tag}','codexnew{tag} fresh');
             INSERT INTO snippets (id, project_id, title, content)
               VALUES ('snip-{tag}','{project}','Snipnew{tag}','snipnew{tag} fresh');"
        ),
    )
    .unwrap_or_else(|error| panic!("削除の後の英語の保存が失敗した（{tag}）: {error}"));
    assert_eq!(
        en_hits(db, "chat_messages_fts_en", &format!("chatnew{tag}")),
        1
    );
    assert_eq!(en_hits(db, "codex_fts_en", &format!("codexnew{tag}")), 1);
    assert_eq!(en_hits(db, "snippets_fts_en", &format!("snipnew{tag}")), 1);
}

#[test]
fn session_delete_leaves_no_en_orphan_and_the_next_save_succeeds() {
    let db = seeded();
    assert_no_stray_en_rows(&db, "seed");

    // `delete_session` と同じ SQL。末尾の session（e5 の行）を消す。
    exec(
        &db,
        "DELETE FROM chat_sessions WHERE id = 'se3' AND project_id = 'pe'",
    )
    .expect("delete session");
    assert_eq!(en_hits(&db, "chat_messages_fts_en", "cipher"), 0);
    assert_no_stray_en_rows(&db, "session 削除の後");

    // 末尾の rowid が再利用される。孤児が残っていれば rowid 重複（1555）で失敗する。
    assert_english_saves_succeed(&db, "se1", "pe", "a");
    assert_no_stray_en_rows(&db, "保存の後");
}

#[test]
fn clear_project_history_leaves_no_en_orphan_and_the_next_save_succeeds() {
    let db = seeded();

    // `clear_project_history` と同じ SQL。英語 project の全 session が cascade で消える。
    exec(&db, "DELETE FROM chat_sessions WHERE project_id = 'pe'").expect("clear history");
    assert_eq!(count(&db, "SELECT count(*) FROM chat_messages_fts_en"), 0);
    assert_no_stray_en_rows(&db, "履歴の全消去の後");

    // 日本語の行が、消えた英語の行の rowid を再利用しても、`_en` には何も出ない。
    exec(
        &db,
        "INSERT INTO chat_messages (id, session_id, role, content)
           VALUES ('j2','sj1','assistant','japanese reuse marker');",
    )
    .expect("japanese save");
    assert_no_stray_en_rows(&db, "日本語の保存の後");

    // 英語 project に新しい session を作って保存する。
    exec(
        &db,
        "INSERT INTO chat_sessions (id, project_id, title, model) VALUES ('se9','pe','E9','m')",
    )
    .expect("new session");
    assert_english_saves_succeed(&db, "se9", "pe", "b");
    assert_no_stray_en_rows(&db, "保存の後");
}

#[test]
fn project_delete_leaves_no_en_orphan_in_any_table_and_the_next_save_succeeds() {
    let db = seeded();

    project_delete(
        &db,
        ProjectDeletePayload {
            project_id: "pe".into(),
        },
    )
    .expect("project_delete(pe)");
    for (_, fts) in SYNCED {
        assert_eq!(
            count(&db, &format!("SELECT count(*) FROM {fts}")),
            0,
            "project 削除の後に {fts} に行が残っている"
        );
    }
    assert_no_stray_en_rows(&db, "project 削除の後");

    exec(
        &db,
        "INSERT INTO projects (id, title, language) VALUES ('pe2','En2','en');
         INSERT INTO chat_sessions (id, project_id, title, model) VALUES ('sx','pe2','X','m');",
    )
    .expect("new english project");
    assert_english_saves_succeed(&db, "sx", "pe2", "c");
    assert_no_stray_en_rows(&db, "保存の後");
}

#[test]
fn japanese_project_deletes_leave_english_rows_and_trigram_index_intact() {
    let db = seeded();
    let english_before: Vec<i64> = SYNCED
        .iter()
        .map(|(_, fts)| count(&db, &format!("SELECT count(*) FROM {fts}")))
        .collect();

    // 日本語 project の session 削除と project 削除の cascade。
    exec(&db, "DELETE FROM chat_sessions WHERE id = 'sj1'").expect("delete ja session");
    project_delete(
        &db,
        ProjectDeletePayload {
            project_id: "pj".into(),
        },
    )
    .expect("project_delete(pj)");

    let english_after: Vec<i64> = SYNCED
        .iter()
        .map(|(_, fts)| count(&db, &format!("SELECT count(*) FROM {fts}")))
        .collect();
    assert_eq!(
        english_after, english_before,
        "日本語の削除が英語の索引を動かした"
    );
    assert_no_stray_en_rows(&db, "日本語の削除の後");
    assert_eq!(en_hits(&db, "chat_messages_fts_en", "dragon"), 1);

    // 日本語の行は `_en` に一度も入らない。trigram の索引は従来どおり本体と一致する。
    for (base, trigram) in [
        ("chat_messages", "chat_messages_fts"),
        ("codex_entries", "codex_fts"),
        ("snippets", "snippets_fts"),
    ] {
        assert_eq!(
            count(&db, &format!("SELECT count(*) FROM {trigram}")),
            count(&db, &format!("SELECT count(*) FROM {base}")),
            "{trigram} が本体と一致しない"
        );
    }
}

/// 旧形の trigger を持つ現行版の DB を作り、cascade 削除で孤児と、日本語の行による
/// rowid 再利用の古い行を残す。事前条件の確認（バグの再現）も含む。
fn legacy_database_with_orphans() -> Database {
    let db = seeded();
    exec(&db, LEGACY_GUARDED_DELETE_TRIGGERS).expect("install legacy guarded triggers");
    assert!(
        !db.with_conn(has_en_fts_delete_triggers).expect("probe"),
        "旧形の trigger は不変条件を満たさない"
    );
    assert!(
        !db.with_conn(has_current_schema_checkpoint_invariants)
            .expect("checkpoint"),
        "旧形の trigger は同版でも checkpoint を偽にする"
    );

    // chat: 末尾の英語 session を消し（孤児）、日本語の行がその rowid を再利用する。
    exec(&db, "DELETE FROM chat_sessions WHERE id = 'se3'").expect("delete tail session");
    exec(
        &db,
        "INSERT INTO chat_messages (id, session_id, role, content)
           VALUES ('j2','sj1','assistant','japanese reuse marker');",
    )
    .expect("japanese row reuses the orphaned rowid");
    // codex／snippets: 英語 project ごと消す（cascade）。
    exec(&db, "DELETE FROM projects WHERE id = 'pe'").expect("cascade delete english project");
    exec(
        &db,
        "INSERT INTO projects (id, title, language) VALUES ('pe2','En2','en');
         INSERT INTO chat_sessions (id, project_id, title, model) VALUES ('sx','pe2','X','m');",
    )
    .expect("new english project");

    for (base, fts) in [
        ("chat_messages", "chat_messages_fts_en"),
        ("codex_entries", "codex_fts_en"),
        ("snippets", "snippets_fts_en"),
    ] {
        assert!(
            stray_en_rows(&db, base, fts) > 0,
            "事前条件：旧形の trigger は {fts} に孤児を残す"
        );
        assert!(stray_en_content_rows(&db, base, fts) > 0);
    }
    // バグの症状：英語の保存が rowid 重複で決まって失敗する（codex／snippets は
    // 英語 project の最初の保存が、残った孤児の rowid と衝突する）。
    let error = exec(
        &db,
        "INSERT INTO codex_entries (id, project_id, name, content)
           VALUES ('codex-x','pe2','Codexx','body');",
    )
    .expect_err("旧形では孤児の rowid と衝突する");
    assert!(error.contains("constraint"), "{error}");
    db
}

#[test]
fn current_schema_open_repairs_legacy_guarded_triggers_and_sweeps_orphans() {
    let db = legacy_database_with_orphans();
    let version_before: i32 = db
        .with_conn(|conn| Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?))
        .expect("user_version");
    assert_eq!(version_before, grimodex_core::SCHEMA_VERSION);

    // 英語 project に生きた行を足しておく。掃除は孤児だけを消し、これは残る。
    exec(
        &db,
        "INSERT INTO chat_messages (id, session_id, role, content)
           VALUES ('live','sx','assistant','livemarker survives');",
    )
    .expect("live english row");
    let live_before = en_hits(&db, "chat_messages_fts_en", "livemarker");
    assert_eq!(live_before, 1);

    db.migrate()
        .expect("current-schema open must replay the in-version trigger repair");

    db.with_conn(|conn| {
        assert!(has_en_fts_delete_triggers(conn)?);
        assert!(
            has_current_schema_checkpoint_invariants(conn)?,
            "repair must converge the current checkpoint"
        );
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, version_before, "in-version repair は版を上げない");
        Ok(())
    })
    .expect("verify converged");
    assert_no_stray_en_rows(&db, "repair の後");
    assert_en_matches_live_english_rows(&db, "repair の後");
    assert_eq!(
        en_hits(&db, "chat_messages_fts_en", "livemarker"),
        1,
        "英語の生きた行の索引は残る"
    );

    // 保存が直る。以後の cascade 削除でも孤児は出ない。
    assert_english_saves_succeed(&db, "sx", "pe2", "d");
    exec(&db, "DELETE FROM projects WHERE id = 'pe2'").expect("cascade delete");
    assert_no_stray_en_rows(&db, "repair の後の cascade 削除の後");
}

#[test]
fn current_schema_open_restores_a_missing_delete_trigger() {
    let db = seeded();
    exec(&db, "DROP TRIGGER snippets_fts_en_ad;").expect("drop one delete trigger");
    assert!(!db.with_conn(has_en_fts_delete_triggers).expect("probe"));
    assert!(!db
        .with_conn(has_current_schema_checkpoint_invariants)
        .expect("checkpoint"));

    db.migrate().expect("repair");
    assert!(db.with_conn(has_en_fts_delete_triggers).expect("probe"));
    assert!(db
        .with_conn(has_current_schema_checkpoint_invariants)
        .expect("checkpoint"));
    assert_en_matches_live_english_rows(&db, "欠けた trigger の repair の後");
}

#[test]
fn converged_open_does_not_recreate_the_delete_triggers() {
    let db = legacy_database_with_orphans();
    db.migrate().expect("first repair");

    // 収束済みの 2 回目の open は DDL を出さない（毎回 DROP／CREATE しない）。
    let drop_attempted = Arc::new(AtomicBool::new(false));
    let drop_attempted_for_hook = Arc::clone(&drop_attempted);
    db.with_conn_mut(|conn| {
        conn.authorizer(Some(move |context: AuthContext<'_>| match context.action {
            AuthAction::DropTrigger { trigger_name, .. }
                if trigger_name.ends_with("_fts_en_ad") =>
            {
                drop_attempted_for_hook.store(true, Ordering::SeqCst);
                Authorization::Allow
            }
            _ => Authorization::Allow,
        }))?;
        Ok(())
    })
    .expect("install observer");
    db.migrate().expect("reopen repaired schema");
    assert!(
        !drop_attempted.load(Ordering::SeqCst),
        "収束済みの open が `_en` の delete trigger を作り直した"
    );
    db.with_conn_mut(|conn| {
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        Ok(())
    })
    .expect("remove observer");
}

#[test]
fn repair_on_a_japanese_only_database_changes_no_data() {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    exec(
        &db,
        "INSERT INTO projects (id, title, language) VALUES ('pj','Ja','ja');
         INSERT INTO chat_sessions (id, project_id, title, model) VALUES ('sj1','pj','J1','m');
         INSERT INTO chat_messages (id, session_id, role, content)
           VALUES ('j1','sj1','assistant','日本語のメッセージ');
         INSERT INTO codex_entries (id, project_id, name, content)
           VALUES ('cj1','pj','日本語の項目','本文');
         INSERT INTO snippets (id, project_id, title, content)
           VALUES ('sj1','pj','日本語の断片','本文');",
    )
    .expect("seed japanese only");
    exec(&db, LEGACY_GUARDED_DELETE_TRIGGERS).expect("install legacy guarded triggers");
    let base_counts_before: Vec<i64> = SYNCED
        .iter()
        .map(|(base, _)| count(&db, &format!("SELECT count(*) FROM {base}")))
        .collect();
    let trigram_before = count(&db, "SELECT count(*) FROM chat_messages_fts");

    db.migrate()
        .expect("repair on a database with no english project");

    assert!(db
        .with_conn(has_current_schema_checkpoint_invariants)
        .expect("checkpoint"));
    for (_, fts) in SYNCED {
        assert_eq!(count(&db, &format!("SELECT count(*) FROM {fts}")), 0);
    }
    let base_counts_after: Vec<i64> = SYNCED
        .iter()
        .map(|(base, _)| count(&db, &format!("SELECT count(*) FROM {base}")))
        .collect();
    assert_eq!(
        base_counts_after, base_counts_before,
        "本体の行は変わらない"
    );
    assert_eq!(
        count(&db, "SELECT count(*) FROM chat_messages_fts"),
        trigram_before,
        "trigram の索引は変わらない"
    );
}

#[test]
fn repair_rebuilds_the_en_index_when_a_reused_rowid_changed_language() {
    // 英語の孤児 X の rowid を日本語 project J の行が再利用し、J を英語に変えた後の
    // `_en` の作り直し（アプリ側の best-effort）が失敗・中断した状態。J の行は英語の行だが、
    // `_en` にはその rowid に X の古い本文が居座り、J の本文は索引されていない。
    // 孤児だけを `NOT IN` で消す掃除では、この古い行は「英語の行に対応する」ので残る。
    let db = seeded();
    exec(&db, LEGACY_GUARDED_DELETE_TRIGGERS).expect("install legacy guarded triggers");
    exec(&db, "DELETE FROM chat_sessions WHERE id = 'se3'").expect("orphan the tail row");
    exec(
        &db,
        "INSERT INTO chat_messages (id, session_id, role, content)
           VALUES ('j2','sj1','assistant','japanese reuse marker');",
    )
    .expect("japanese row reuses the orphaned rowid");
    exec(&db, "UPDATE projects SET language = 'en' WHERE id = 'pj'")
        .expect("language change; the rebuild after it never ran");

    assert_eq!(
        en_hits(&db, "chat_messages_fts_en", "cipher"),
        1,
        "事前条件：古い本文"
    );
    assert_eq!(
        en_hits(&db, "chat_messages_fts_en", "marker"),
        0,
        "事前条件：未索引"
    );
    assert_eq!(
        stray_en_rows(&db, "chat_messages", "chat_messages_fts_en"),
        0,
        "事前条件：古い行は本体の英語の行に対応して見える（NOT IN の掃除では残る）"
    );

    db.migrate().expect("repair");

    assert_eq!(
        en_hits(&db, "chat_messages_fts_en", "cipher"),
        0,
        "古い本文は消える"
    );
    // 作り直しで、日本語から英語に変わった project の未索引の行も入る。
    assert_eq!(en_hits(&db, "chat_messages_fts_en", "marker"), 2);
    assert_eq!(en_hits(&db, "codex_fts_en", "Japanese"), 1);
    assert_eq!(en_hits(&db, "snippets_fts_en", "Japanese"), 1);
    assert_no_stray_en_rows(&db, "repair の後");
    assert_en_matches_live_english_rows(&db, "repair の後");
}

#[test]
fn repair_scrubs_deleted_text_from_the_fts_segments() {
    let db = seeded();
    // segment の語は前の語との共通接頭辞が省略されるので、探す語は他の語と接頭辞を共有しない
    // 綴りにする。
    exec(
        &db,
        "INSERT INTO chat_messages (id, session_id, role, content)
           VALUES ('zc','se3','assistant','zzorphanchat');
         INSERT INTO codex_entries (id, project_id, name, content)
           VALUES ('zx','pe','Mmmname','zzorphancodex');
         INSERT INTO snippets (id, project_id, title, content)
           VALUES ('zs','pe','Nnntitle','zzorphansnip');",
    )
    .expect("rows carrying distinctive words");
    exec(&db, LEGACY_GUARDED_DELETE_TRIGGERS).expect("install legacy guarded triggers");
    // 旧形の trigger は、消した行の語を `_en` の segment に残す（行ごと孤児になる）。
    exec(&db, "DELETE FROM chat_sessions WHERE id = 'se3'").expect("orphan a chat row");
    exec(&db, "DELETE FROM projects WHERE id = 'pe'").expect("orphan codex and snippets");
    for (fts, term) in [
        ("chat_messages_fts_en", "zzorphanchat"),
        ("codex_fts_en", "zzorphancodex"),
        ("snippets_fts_en", "zzorphansnip"),
    ] {
        assert!(
            data_blocks_with(&db, fts, term) > 0,
            "事前条件：{fts} の segment に削除済みの語 {term} が残っている"
        );
    }

    db.migrate().expect("repair");

    // `optimize` が merge して、削除済みの語を segment から取り除く（VACUUM はしない）。
    for (fts, term) in [
        ("chat_messages_fts_en", "zzorphanchat"),
        ("codex_fts_en", "zzorphancodex"),
        ("snippets_fts_en", "zzorphansnip"),
    ] {
        assert_eq!(
            data_blocks_with(&db, fts, term),
            0,
            "{fts} の segment に削除済みの語 {term} が残っている"
        );
    }
    assert_no_stray_en_rows(&db, "repair の後");
}

#[test]
fn repair_records_the_flag_that_keeps_old_builds_from_reguarding_the_triggers() {
    // 新しく作る DB も、修復した DB も、旗を持つ。
    let fresh = test_support::current_schema_memory().expect("fixture");
    assert_eq!(en_ad_unguarded_flag(&fresh), 1, "新しい DB は旗を持つ");

    let db = legacy_database_with_orphans();
    assert_eq!(en_ad_unguarded_flag(&db), 0, "旧 build は旗を書かない");
    db.migrate().expect("repair");
    assert_eq!(en_ad_unguarded_flag(&db), 1, "repair が旗を書く");

    // 旧 build の full DDL（旗があれば DROP しない、CREATE IF NOT EXISTS は何もしない）で
    // 開いても、guard なしの形が保たれる。
    replay_old_build_delete_trigger_ddl(&db);
    assert!(
        db.with_conn(has_en_fts_delete_triggers).expect("probe"),
        "旧 build の full DDL が guard 付きに戻した"
    );
    assert!(db
        .with_conn(has_current_schema_checkpoint_invariants)
        .expect("checkpoint"));
    // その後の cascade 削除でも孤児は出ない。
    exec(&db, "DELETE FROM projects WHERE id = 'pe2'").expect("cascade delete");
    assert_no_stray_en_rows(&db, "旧 build の full DDL の後");
}

#[test]
fn old_build_full_ddl_without_the_flag_reguards_and_the_new_build_repairs_again() {
    // 対照：旗が無ければ、旧 build の full DDL は guard 付きに戻す（旗が効いている証拠）。
    // 新 build は旗に頼らず trigger の形で判定するので、往復しても修復される。
    let db = legacy_database_with_orphans();
    db.migrate().expect("repair");
    exec(&db, "DELETE FROM fts_meta WHERE key = 'en_ad_unguarded'").expect("drop the flag");
    replay_old_build_delete_trigger_ddl(&db);
    assert!(
        !db.with_conn(has_en_fts_delete_triggers).expect("probe"),
        "旗が無いと旧 build は guard 付きに戻す"
    );
    assert!(!db
        .with_conn(has_current_schema_checkpoint_invariants)
        .expect("checkpoint"));

    db.migrate().expect("the new build repairs again");
    assert!(db.with_conn(has_en_fts_delete_triggers).expect("probe"));
    assert_eq!(en_ad_unguarded_flag(&db), 1);
    assert_no_stray_en_rows(&db, "往復の後");
}

/// 実際の typed writer（`native-current-human-capture` で有効になる）でも同じ性質が
/// 成り立つ。CI の既定の workspace 試験は feature を付けないので、上の SQL 版が常に走る
/// 本体になる。この module は feature を明示した実行
/// （`cargo test -p grimodex-db --features native-current-human-capture --test en_fts_delete_sync`）
/// でだけ走る。impact map の chat 書込みの組には入っていない。
#[cfg(feature = "native-current-human-capture")]
mod typed_writers {
    use super::*;
    use grimodex_db::chat_typed_writes::{
        clear_project_history, delete_session, ClearProjectHistoryRequest, DeleteSessionRequest,
    };

    #[test]
    fn delete_session_typed_writer_leaves_no_en_orphan() {
        let db = seeded();
        delete_session(
            &db,
            DeleteSessionRequest {
                project_id: "pe".into(),
                session_id: "se3".into(),
            },
        )
        .expect("delete_session");
        assert_no_stray_en_rows(&db, "delete_session の後");
        assert_english_saves_succeed(&db, "se1", "pe", "t1");
    }

    #[test]
    fn clear_project_history_typed_writer_leaves_no_en_orphan() {
        let db = seeded();
        clear_project_history(
            &db,
            ClearProjectHistoryRequest {
                project_id: "pe".into(),
            },
        )
        .expect("clear_project_history");
        assert_no_stray_en_rows(&db, "clear_project_history の後");
        exec(
            &db,
            "INSERT INTO chat_sessions (id, project_id, title, model) VALUES ('se9','pe','E9','m')",
        )
        .expect("new session");
        assert_english_saves_succeed(&db, "se9", "pe", "t2");
    }
}
