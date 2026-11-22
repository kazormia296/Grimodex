//! The restore-only append entry (`append_snapshot_restore_in_tx`) and the
//! continuity exemption it grants (DR-SRC-8). The entry is `pub(crate)`, so
//! these tests live inside the crate; `tests/snapshot_restore_feed_continuity.rs`
//! covers the product path end to end.

use super::*;
use crate::change_events::AppendChangeEvent;
use crate::Database;

const P: &str = "restore-entry-p1";
const SESSION: &str = "restore-entry-session";

fn digest(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

fn new_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        conn.execute_batch(&format!(
            "INSERT INTO projects (id, title) VALUES ('{P}', 'One');
             INSERT INTO chat_sessions (id, project_id, title) VALUES ('{SESSION}', '{P}', 's');
             INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
               VALUES ('s1', '{P}', 'scene', 'Scene', 'a0');"
        ))?;
        Ok(())
    })
    .expect("seed");
    db
}

fn scene_scope(mutation: &str, before: Option<char>, after: char) -> NarrativeChangeEventInput {
    NarrativeChangeEventInput {
        object_key: json!({ "kind": "scene-scope", "sceneId": "s1" }),
        change_kind: "metadata".to_string(),
        mutation_kind: mutation.to_string(),
        before_version: before.map(|_| 1),
        before_digest: before.map(digest),
        after_version: Some(1),
        after_digest: Some(digest(after)),
        changed_paths: vec!["/binding/version".to_string()],
        text_impact: None,
        structural_impact: Some(json!({ "scopeAuthorityChanged": true })),
    }
}

fn registry(mutation: &str, before: Option<char>, after: char) -> NarrativeChangeEventInput {
    NarrativeChangeEventInput {
        object_key: json!({ "kind": "scope-registry", "projectId": P }),
        change_kind: "metadata".to_string(),
        mutation_kind: mutation.to_string(),
        before_version: None,
        before_digest: before.map(digest),
        after_version: None,
        after_digest: Some(digest(after)),
        changed_paths: vec!["/".to_string()],
        text_impact: None,
        structural_impact: None,
    }
}

#[derive(Clone, Copy)]
enum Entry {
    Public,
    RestoreOnly,
}

fn append(
    db: &Database,
    entry: Entry,
    tag: &str,
    origin: NarrativeChangeOrigin,
    source_domain: &str,
    events: Vec<NarrativeChangeEventInput>,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let uid = format!("uid-{tag}");
        let canonical = AppendChangeEvent {
            event_uid: uid.clone(),
            scene_id: None,
            domain: "revision".to_string(),
            op_type: source_domain.to_string(),
            entity_type: Some("project_snapshot".to_string()),
            entity_id: Some(tag.to_string()),
            payload: "{}".to_string(),
            timestamp: 1_786_000_000_000,
        };
        let input = AppendNarrativeChangeTransactionInput {
            project_id: P.to_string(),
            request_id: format!("req-{tag}"),
            source_domain: source_domain.to_string(),
            source_change_event_uid: uid,
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin,
            original_transaction_id: None,
            commit_id: None,
            journal_id: None,
            undo_journal_id: None,
            application_ids: vec![],
            occurred_at: "2026-11-22T00:00:00.000Z".to_string(),
            events,
        };
        let result = match entry {
            Entry::Public => {
                append_canonical_and_narrative_change_in_tx(conn, P, SESSION, &canonical, &input)
            }
            Entry::RestoreOnly => {
                append_snapshot_restore_in_tx(conn, P, SESSION, &canonical, &input)
            }
        };
        match result {
            Ok(_) => {
                conn.execute_batch("COMMIT")?;
                Ok(Ok(()))
            }
            Err(error) => {
                conn.execute_batch("ROLLBACK")?;
                Ok(Err(error))
            }
        }
    })
    .expect("with_conn")
}

fn restore_append(
    db: &Database,
    tag: &str,
    events: Vec<NarrativeChangeEventInput>,
) -> anyhow::Result<()> {
    append(
        db,
        Entry::RestoreOnly,
        tag,
        NarrativeChangeOrigin::Restore,
        SNAPSHOT_RESTORE_SOURCE_DOMAIN,
        events,
    )
}

/// Seed the heads of the scene-scope of `s1` and of the project registry.
fn seed_heads(db: &Database) {
    append(
        db,
        Entry::Public,
        "seed",
        NarrativeChangeOrigin::Human,
        "test.seed",
        vec![
            scene_scope("create", None, 'c'),
            registry("create", None, 'c'),
        ],
    )
    .expect("seed heads");
}

fn assert_discontinuity(result: anyhow::Result<()>, what: &str) {
    let error = result.expect_err(what);
    assert!(
        error
            .to_string()
            .contains("NARRATIVE_CHANGE_FEED_DISCONTINUITY"),
        "{what}: {error}"
    );
}

#[test]
fn the_restore_entry_lets_a_scene_scope_event_through_that_does_not_chain() {
    let db = new_db();
    seed_heads(&db);
    // The rebuilt binding's before ('a') is not the head's after ('c').
    restore_append(&db, "r1", vec![scene_scope("update", Some('a'), 'd')])
        .expect("the restore's own scene-scope event");
    // The head followed the restore's after state ('d'): through the public
    // entry a stale before is refused again.
    assert_discontinuity(
        append(
            &db,
            Entry::Public,
            "h1",
            NarrativeChangeOrigin::Human,
            "test.write",
            vec![scene_scope("update", Some('a'), 'e')],
        ),
        "a stale before after the restore entry moved the head",
    );
    restore_append(&db, "r3", vec![scene_scope("update", Some('d'), 'e')])
        .expect("a chained event passes");
}

#[test]
fn the_restore_entry_exempts_no_other_kind() {
    let db = new_db();
    seed_heads(&db);
    assert_discontinuity(
        restore_append(&db, "r1", vec![registry("update", Some('a'), 'd')]),
        "an object kind other than scene-scope",
    );
}

#[test]
fn the_restore_entry_does_not_exempt_a_second_event_of_the_same_batch() {
    let db = new_db();
    seed_heads(&db);
    assert_discontinuity(
        restore_append(
            &db,
            "r1",
            vec![
                scene_scope("update", Some('a'), 'd'),
                scene_scope("update", Some('x'), 'e'),
            ],
        ),
        "the second scene-scope event of the batch does not chain from the first",
    );
}

#[test]
fn the_public_entry_never_exempts_a_scene_scope_event() {
    let db = new_db();
    seed_heads(&db);
    assert_discontinuity(
        append(
            &db,
            Entry::Public,
            "p1",
            NarrativeChangeOrigin::Restore,
            SNAPSHOT_RESTORE_SOURCE_DOMAIN,
            vec![scene_scope("update", Some('a'), 'd')],
        ),
        "a restore-shaped batch through the public entry",
    );
}

#[test]
fn the_restore_entry_refuses_a_transaction_that_does_not_say_it_is_a_restore() {
    let db = new_db();
    seed_heads(&db);
    let wrong_origin = append(
        &db,
        Entry::RestoreOnly,
        "w1",
        NarrativeChangeOrigin::Human,
        SNAPSHOT_RESTORE_SOURCE_DOMAIN,
        vec![scene_scope("update", Some('a'), 'd')],
    )
    .expect_err("origin human");
    assert!(wrong_origin
        .to_string()
        .contains("snapshot restore append entry"));
    let wrong_domain = append(
        &db,
        Entry::RestoreOnly,
        "w2",
        NarrativeChangeOrigin::Restore,
        "revision.scene.restore.renderer",
        vec![scene_scope("update", Some('a'), 'd')],
    )
    .expect_err("another source domain");
    assert!(wrong_domain
        .to_string()
        .contains("snapshot restore append entry"));
}
