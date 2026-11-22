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

// --- replays_an_apply_commit (DR-SRC-12) ---
//
// The predicate decides which Undo/Redo skip the restore refusal. Every fact
// comes from the replayed root transaction's row and the commit and journal rows
// it names; it is true for exactly one shape. These tests build each near
// miss from real transactions and flip one fact at a time.

mod replays_an_apply_commit_predicate {
    use super::*;

    /// The journal a verified commit leaves (a created Codex entry) and its
    /// operation row.
    const VERIFIED_JOURNAL: &str =
        r#"{"entities":[{"entityKind":"codex_entry","entityId":"e1","opKind":"create"}]}"#;
    const VERIFIED_OPERATION: &str = "codex.entry.create";

    fn seed_commit(db: &Database, commit: &str, journal: &str) {
        seed_commit_with(
            db,
            commit,
            journal,
            Some(VERIFIED_JOURNAL),
            &[VERIFIED_OPERATION],
        );
    }

    /// A commit, its journal (with the given `after_json`) and one operation
    /// row per given `operation_kind`.
    fn seed_commit_with(
        db: &Database,
        commit: &str,
        journal: &str,
        after_json: Option<&str>,
        operation_kinds: &[&str],
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_apply_commits
                    (id, project_id, request_id, plan_digest, status, created_at)
                 VALUES (?1, ?2, ?3, 'digest', 'applied', 't')",
                params![commit, P, format!("req-{commit}")],
            )?;
            conn.execute(
                "INSERT INTO narrative_commit_journals
                    (id, commit_id, project_id, after_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, 't')",
                params![journal, commit, P, after_json],
            )?;
            for (index, kind) in operation_kinds.iter().enumerate() {
                conn.execute(
                    "INSERT INTO narrative_apply_operations
                        (id, commit_id, operation_index, operation_kind, status, created_at)
                     VALUES (?1, ?2, ?3, ?4, 'applied', 't')",
                    params![format!("op-{commit}-{index}"), commit, index as i64, kind],
                )?;
            }
            Ok(())
        })
        .expect("seed commit and journal");
    }

    /// A real forward transaction with the given origin and source domain,
    /// then pointed at a commit and a journal (the table has no constraint
    /// that ties them to the origin).
    fn root(
        db: &Database,
        index: u8,
        origin: NarrativeChangeOrigin,
        source_domain: &str,
        commit: &str,
        journal: &str,
    ) -> String {
        // Each root chains from the previous one on the same registry object.
        let tag = format!("root{index}");
        let letter = |n: u8| char::from(b'a' + n);
        let event = if index == 0 {
            registry("create", None, letter(0))
        } else {
            registry("update", Some(letter(index - 1)), letter(index))
        };
        append(db, Entry::Public, &tag, origin, source_domain, vec![event])
            .expect("append the root transaction");
        db.with_conn(|conn| {
            let id: String = conn.query_row(
                "SELECT id FROM narrative_change_transactions
                  WHERE project_id = ?1 AND request_id = ?2",
                params![P, format!("req-{tag}")],
                |row| row.get(0),
            )?;
            conn.execute(
                "UPDATE narrative_change_transactions
                    SET commit_id = ?2, journal_id = ?3 WHERE id = ?1",
                params![id, commit, journal],
            )?;
            Ok(id)
        })
        .expect("link the root transaction")
    }

    fn undo_input(
        commit: Option<&str>,
        journal: Option<&str>,
    ) -> AppendNarrativeChangeTransactionInput {
        AppendNarrativeChangeTransactionInput {
            project_id: P.to_string(),
            request_id: "req-undo".to_string(),
            source_domain: "narrative.commit.undo".to_string(),
            source_change_event_uid: "uid-undo".to_string(),
            cause_kind: NarrativeChangeCauseKind::Undo,
            origin: NarrativeChangeOrigin::Undo,
            original_transaction_id: None,
            commit_id: commit.map(str::to_string),
            journal_id: journal.map(str::to_string),
            undo_journal_id: None,
            application_ids: vec![],
            occurred_at: "2026-11-22T00:00:00.000Z".to_string(),
            events: vec![],
        }
    }

    fn predicate(
        db: &Database,
        input: &AppendNarrativeChangeTransactionInput,
        root_transaction_id: &str,
    ) -> bool {
        db.with_conn(|conn| replays_an_apply_commit(conn, input, root_transaction_id))
            .expect("evaluate the predicate")
    }

    const APPLY: &str = "narrative.commit.apply";

    #[test]
    fn it_is_true_only_for_the_commits_own_apply_root_named_by_the_replay() {
        let db = new_db();
        seed_commit(&db, "c1", "j1");
        let genuine = root(&db, 0, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j1");
        assert!(predicate(
            &db,
            &undo_input(Some("c1"), Some("j1")),
            &genuine
        ));
    }

    #[test]
    fn a_replay_that_names_no_commit_or_no_journal_is_never_one() {
        let db = new_db();
        seed_commit(&db, "c1", "j1");
        let genuine = root(&db, 0, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j1");
        assert!(!predicate(&db, &undo_input(None, None), &genuine));
        assert!(!predicate(&db, &undo_input(Some("c1"), None), &genuine));
        assert!(!predicate(&db, &undo_input(None, Some("j1")), &genuine));
    }

    #[test]
    fn a_root_with_another_origin_is_not_an_apply() {
        let db = new_db();
        seed_commit(&db, "c1", "j1");
        let human = root(&db, 0, NarrativeChangeOrigin::Human, APPLY, "c1", "j1");
        assert!(!predicate(&db, &undo_input(Some("c1"), Some("j1")), &human));
    }

    #[test]
    fn a_root_with_another_source_domain_is_not_an_apply() {
        let db = new_db();
        seed_commit(&db, "c1", "j1");
        let other = root(
            &db,
            0,
            NarrativeChangeOrigin::AiApply,
            "test.other",
            "c1",
            "j1",
        );
        assert!(!predicate(&db, &undo_input(Some("c1"), Some("j1")), &other));
    }

    #[test]
    fn a_commit_or_journal_that_differs_from_the_roots_is_not_one() {
        let db = new_db();
        seed_commit(&db, "c1", "j1");
        seed_commit(&db, "c2", "j2");
        let genuine = root(&db, 0, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j1");
        // The replay names a different commit, a different journal, or both.
        assert!(!predicate(
            &db,
            &undo_input(Some("c2"), Some("j1")),
            &genuine
        ));
        assert!(!predicate(
            &db,
            &undo_input(Some("c1"), Some("j2")),
            &genuine
        ));
        assert!(!predicate(
            &db,
            &undo_input(Some("c2"), Some("j2")),
            &genuine
        ));
        // The root row names a journal that belongs to another commit.
        let crossed = root(&db, 1, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j2");
        assert!(!predicate(
            &db,
            &undo_input(Some("c1"), Some("j2")),
            &crossed
        ));
        // The root row names a commit that does not exist.
        let dangling = root(
            &db,
            2,
            NarrativeChangeOrigin::AiApply,
            APPLY,
            "c-none",
            "j-none",
        );
        assert!(!predicate(
            &db,
            &undo_input(Some("c-none"), Some("j-none")),
            &dangling
        ));
    }

    #[test]
    fn a_root_that_is_not_a_forward_transaction_is_not_an_apply() {
        let db = new_db();
        seed_commit(&db, "c1", "j1");
        let genuine = root(&db, 0, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j1");
        let replayed = root(&db, 1, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j1");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_change_transactions
                    SET cause_kind = 'undo', original_transaction_id = ?2
                  WHERE id = ?1",
                params![replayed, genuine],
            )?;
            Ok(())
        })
        .expect("turn the root into an undo");
        assert!(!predicate(
            &db,
            &undo_input(Some("c1"), Some("j1")),
            &replayed
        ));
        assert!(predicate(
            &db,
            &undo_input(Some("c1"), Some("j1")),
            &genuine
        ));
    }

    #[test]
    fn a_root_of_another_project_is_not_found() {
        let db = new_db();
        seed_commit(&db, "c1", "j1");
        let genuine = root(&db, 0, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j1");
        let mut input = undo_input(Some("c1"), Some("j1"));
        input.project_id = "another-project".to_string();
        assert!(!predicate(&db, &input, &genuine));
    }

    // --- the kind condition (DR-SRC-12, confirmation 88) ---
    //
    // The exemption covers only the kinds verified through a real restore. The
    // journal entities and the operation rows of the commit both have to be
    // verified, and a commit that mixes a verified kind with another is refused.

    fn entities_json(entities: &[(&str, Option<&str>)]) -> String {
        let rows: Vec<Value> = entities
            .iter()
            .enumerate()
            .map(|(index, (kind, op_kind))| {
                let mut row = json!({ "entityKind": kind, "entityId": format!("e{index}") });
                if let Some(op_kind) = op_kind {
                    row["opKind"] = json!(op_kind);
                }
                row
            })
            .collect();
        json!({ "entities": rows }).to_string()
    }

    /// Seed one commit and test the predicate for its journal and operations.
    fn kind_verdict(entities: &[(&str, Option<&str>)], operation_kinds: &[&str]) -> bool {
        let db = new_db();
        seed_commit_with(
            &db,
            "c1",
            "j1",
            Some(&entities_json(entities)),
            operation_kinds,
        );
        let genuine = root(&db, 0, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j1");
        predicate(&db, &undo_input(Some("c1"), Some("j1")), &genuine)
    }

    #[test]
    fn every_verified_kind_is_exempt() {
        for (entity, op_kind, operation) in [
            ("event", "create", "chronicle.event.create"),
            ("codex_entry", "create", "codex.entry.create"),
            ("codex_entry", "patch", "codex.entry.patch"),
            (
                "temporal_scene_chronicle",
                "patch",
                "temporal.scene.metadata.patch",
            ),
            (
                "temporal_event_chronicle",
                "patch",
                "temporal.event.metadata.patch",
            ),
            ("codex_detail_value", "patch", "codex.detail.value.set"),
        ] {
            assert!(
                kind_verdict(&[(entity, Some(op_kind))], &[operation]),
                "{entity}/{op_kind} must be exempt"
            );
        }
        // Several verified kinds in one commit are exempt too.
        assert!(kind_verdict(
            &[("event", Some("create")), ("codex_entry", Some("patch"))],
            &["chronicle.event.create", "codex.entry.patch"],
        ));
    }

    #[test]
    fn an_unverified_kind_is_not_exempt_even_with_a_verified_looking_operation() {
        for (entity, op_kind, operation) in [
            ("codex_phase", "create", "codex.phase.create"),
            ("codex_phase", "patch", "codex.phase.patch"),
            (
                "codex_semantic_binding",
                "create",
                "codex.semantic_binding.upsert",
            ),
            ("codex_relation", "create", "codex.relation.create"),
            ("codex_entry", "bind", "codex.entity.bind-existing"),
            // Creating a detail value is not the verified patch.
            ("codex_detail_value", "create", "codex.detail.value.set"),
            ("temporal_node", "create", "temporal.node.ensure"),
            ("temporal_node", "ensure-existing", "temporal.node.ensure"),
            (
                "temporal_constraint",
                "create",
                "temporal.constraint.create",
            ),
            (
                "temporal_scene_story_order",
                "patch",
                "temporal.story-order.materialize",
            ),
            (
                "temporal_projection",
                "create",
                "temporal.projection.record",
            ),
            ("plot_thread", "create", "plot.thread.create"),
            ("plot_thread", "patch", "plot.thread.patch"),
            ("plot_thread_marker", "create", "plot.marker.create"),
            ("plot_thread_branch", "create", "plot.branch.create"),
            ("foreshadow", "create", "foreshadow.aggregate.create"),
            ("foreshadow", "patch", "foreshadow.aggregate.patch"),
            // A verified entity kind with an op kind that was not verified.
            ("event", "patch", "chronicle.event.create"),
            (
                "temporal_scene_chronicle",
                "create",
                "temporal.scene.metadata.patch",
            ),
        ] {
            assert!(
                !kind_verdict(&[(entity, Some(op_kind))], &[operation]),
                "{entity}/{op_kind} must stay refused"
            );
            // The journal alone decides: a verified operation row does not rescue it.
            assert!(
                !kind_verdict(&[(entity, Some(op_kind))], &[VERIFIED_OPERATION]),
                "{entity}/{op_kind} must stay refused whatever the operation row says"
            );
        }
    }

    #[test]
    fn a_commit_that_mixes_a_verified_and_an_unverified_kind_is_not_exempt() {
        // Verified first, unverified first, and an unverified one in the middle.
        assert!(!kind_verdict(
            &[
                ("codex_entry", Some("create")),
                ("plot_thread", Some("create"))
            ],
            &["codex.entry.create", "plot.thread.create"],
        ));
        assert!(!kind_verdict(
            &[("foreshadow", Some("create")), ("event", Some("create"))],
            &["foreshadow.aggregate.create", "chronicle.event.create"],
        ));
        assert!(!kind_verdict(
            &[
                ("event", Some("create")),
                ("codex_phase", Some("create")),
                ("codex_entry", Some("create")),
            ],
            &[
                "chronicle.event.create",
                "codex.phase.create",
                "codex.entry.create",
            ],
        ));
    }

    #[test]
    fn the_operation_rows_must_be_verified_too() {
        // The journal is verified, but the commit's operation rows are not.
        assert!(!kind_verdict(&[("codex_entry", Some("create"))], &[]));
        assert!(!kind_verdict(
            &[("codex_entry", Some("create"))],
            &["codex.entry.create", "plot.thread.create"],
        ));
        assert!(!kind_verdict(
            &[("codex_entry", Some("create"))],
            &["plot.thread.create"],
        ));
    }

    #[test]
    fn a_missing_op_kind_is_read_as_create_like_the_replay_does() {
        assert!(kind_verdict(
            &[("codex_entry", None)],
            &["codex.entry.create"]
        ));
        // `codex_detail_value` without an opKind is a create, which is not verified.
        assert!(!kind_verdict(
            &[("codex_detail_value", None)],
            &["codex.detail.value.set"]
        ));
    }

    #[test]
    fn a_journal_that_cannot_be_read_is_not_exempt() {
        for after_json in [
            None,
            Some("not json"),
            Some("[]"),
            Some("{}"),
            Some(r#"{"entities":{}}"#),
            Some(r#"{"entities":[]}"#),
            Some(r#"{"entities":[{"entityId":"e1","opKind":"create"}]}"#),
            Some(r#"{"entities":[{"entityKind":7,"opKind":"create"}]}"#),
        ] {
            let db = new_db();
            seed_commit_with(&db, "c1", "j1", after_json, &[VERIFIED_OPERATION]);
            let genuine = root(&db, 0, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j1");
            assert!(
                !predicate(&db, &undo_input(Some("c1"), Some("j1")), &genuine),
                "{after_json:?} must not be exempt"
            );
        }
    }

    #[test]
    fn a_journal_row_of_another_commit_or_project_is_not_read() {
        // The root names journal j2, which belongs to commit c2; the kind check
        // reads the journal by commit and project, so c1's own verified journal
        // cannot stand in for it.
        let db = new_db();
        seed_commit(&db, "c1", "j1");
        seed_commit_with(
            &db,
            "c2",
            "j2",
            Some(&entities_json(&[("plot_thread", Some("create"))])),
            &["plot.thread.create"],
        );
        let crossed = root(&db, 0, NarrativeChangeOrigin::AiApply, APPLY, "c2", "j2");
        assert!(!predicate(
            &db,
            &undo_input(Some("c2"), Some("j2")),
            &crossed
        ));
        let genuine = root(&db, 1, NarrativeChangeOrigin::AiApply, APPLY, "c1", "j1");
        assert!(predicate(
            &db,
            &undo_input(Some("c1"), Some("j1")),
            &genuine
        ));
    }
}
