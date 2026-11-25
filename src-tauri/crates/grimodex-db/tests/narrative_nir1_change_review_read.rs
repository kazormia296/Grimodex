use std::path::Path;

use grimodex_db::domain_writes::{tree_node_create, TreeNodeCreatePayload};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    narrative_extraction_append_human_decision, prepare_nir1_entity_relation_revision,
    read_nir1_change_review, read_nir1_entity_relation_revision, AppendDecisionPayload,
    Nir1ChangeReviewObjectChange, Nir1ChangeReviewResult, Nir1EntityRelationRevisionPrepareRequest,
    Nir1EntityRelationRevisionRead, C2_ZC_CUTOVER_CONTRACT_VERSION, C2_ZC_CUTOVER_MIGRATION_ID,
};
use grimodex_db::Database;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

fn review_row_counts(conn: &Connection) -> rusqlite::Result<(i64, i64, i64, i64, i64)> {
    Ok((
        conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_runs",
            [],
            |row| row.get(0),
        )?,
        conn.query_row("SELECT COUNT(*) FROM narrative_proposal_sets", [], |row| {
            row.get(0)
        })?,
        conn.query_row("SELECT COUNT(*) FROM narrative_proposals", [], |row| {
            row.get(0)
        })?,
        conn.query_row(
            "SELECT COUNT(*) FROM narrative_proposal_revisions",
            [],
            |row| row.get(0),
        )?,
        conn.query_row(
            "SELECT COUNT(*) FROM narrative_proposal_decisions",
            [],
            |row| row.get(0),
        )?,
    ))
}

fn change_review_db() -> anyhow::Result<Database> {
    let db = Database::new(Path::new(":memory:"))?;
    db.migrate()?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('change-review-epoch', 'default-project', 0, 'initial',
                     '2026-09-15T00:00:00.000Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
             VALUES (?1, ?2, '2026-09-15T00:00:00.000Z')",
            params![C2_ZC_CUTOVER_MIGRATION_ID, C2_ZC_CUTOVER_CONTRACT_VERSION],
        )?;
        Ok(())
    })?;
    tree_node_create(
        &db,
        TreeNodeCreatePayload {
            id: "nir1-change-review".into(),
            project_id: "default-project".into(),
            request_id: "change-review-scene-request".into(),
            session_id: "change-review-test".into(),
            event_uid: "change-review-scene-event".into(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: None,
            node_type: "scene".into(),
            title: "Change review".into(),
            sort_order: "a0".into(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: Some("{}".into()),
            canonical_payload: None,
        },
    )?;
    tree_node_create(
        &db,
        TreeNodeCreatePayload {
            id: "nir1-change-review-b".into(),
            project_id: "default-project".into(),
            request_id: "change-review-scene-b-request".into(),
            session_id: "change-review-test".into(),
            event_uid: "change-review-scene-b-event".into(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: None,
            node_type: "scene".into(),
            title: "Change review B".into(),
            sort_order: "a1".into(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: Some("{}".into()),
            canonical_payload: None,
        },
    )?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
             VALUES ('change-review-alice', 'default-project', 'character', 'Alice',
                     'Alice before', '2026-09-12T00:00:00Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
             VALUES ('change-review-bob', 'default-project', 'character', 'Bob',
                     'Bob', '2026-09-12T00:00:00Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
             VALUES ('change-review-carol', 'default-project', 'character', 'Carol',
                     'Carol', '2026-09-12T00:00:00Z')",
            [],
        )?;
        let head: i64 = conn.query_row(
            "SELECT COALESCE(MAX(source_change_event_sequence), 0)
               FROM narrative_change_transactions
              WHERE project_id = 'default-project'",
            [],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO narrative_change_cursors
                (project_id, consumer_id, acknowledged_through_sequence,
                 last_error, updated_at)
             VALUES ('default-project', 'narrative-incremental-freshness/v1', ?1,
                     NULL, '2026-09-15T00:00:00.000Z')",
            [head],
        )?;
        Ok(())
    })?;
    Ok(db)
}

fn prepare_change_review_revision(
    db: &Database,
    proposal_key: &str,
    scene_id: &str,
    entity_ids: &[&str],
) -> anyhow::Result<Value> {
    prepare_nir1_entity_relation_revision(
        db,
        Nir1EntityRelationRevisionPrepareRequest {
            project_id: "default-project".into(),
            scene_id: scene_id.into(),
            proposal_key: Some(proposal_key.into()),
            entity_ids: entity_ids
                .iter()
                .map(|entity_id| (*entity_id).into())
                .collect(),
            relation_ids: vec![],
        },
    )
}

fn approve_change_review_revision(db: &Database, prepared: &Value) -> anyhow::Result<()> {
    narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: prepared["runId"].as_str().unwrap().into(),
            project_id: "default-project".into(),
            proposal_id: prepared["result"]["proposalId"].as_str().unwrap().into(),
            revision_id: prepared["result"]["revisionId"].as_str().unwrap().into(),
            decision: "approved".into(),
            decision_json: None,
            created_by: Some("change-review-test".into()),
        },
    )?;
    Ok(())
}

#[test]
fn change_review_matches_each_identity_across_scenes_without_removed_objects() -> anyhow::Result<()>
{
    let db = change_review_db()?;
    let scene_a = prepare_change_review_revision(
        &db,
        "change-review:scene-a",
        "nir1-change-review",
        &["change-review-alice", "change-review-bob"],
    )?;
    let scene_a_id = scene_a["result"]["revisionId"].as_str().unwrap().to_owned();
    approve_change_review_revision(&db, &scene_a)?;

    let scene_b_carol = prepare_change_review_revision(
        &db,
        "change-review:scene-b-carol",
        "nir1-change-review-b",
        &["change-review-carol"],
    )?;
    let scene_b_carol_id = scene_b_carol["result"]["revisionId"].as_str().unwrap();
    let carol_result = db.with_read_transaction(|conn| {
        read_nir1_change_review(conn, "default-project", scene_b_carol_id)
    })?;
    let carol_wire = serde_json::to_value(&carol_result)?;
    assert_eq!(carol_wire["status"], "available");
    assert_eq!(carol_wire["result"]["revisionId"], scene_b_carol_id);
    assert_eq!(carol_wire.as_object().unwrap().len(), 2);
    let Nir1ChangeReviewResult::Available(carol_review) = carol_result else {
        panic!("Scene B Carol revision should be available");
    };
    assert!(carol_review.previous_revision_ids.is_empty());
    assert_eq!(carol_review.objects.len(), 1);
    assert_eq!(
        carol_review.objects[0].identity,
        "codex:change-review-carol"
    );
    assert_eq!(
        carol_review.objects[0].change,
        Nir1ChangeReviewObjectChange::Added
    );

    let scene_b_alice = prepare_change_review_revision(
        &db,
        "change-review:scene-b-alice",
        "nir1-change-review-b",
        &["change-review-alice"],
    )?;
    let scene_b_alice_id = scene_b_alice["result"]["revisionId"].as_str().unwrap();
    let Nir1ChangeReviewResult::Available(alice_review) = db.with_read_transaction(|conn| {
        read_nir1_change_review(conn, "default-project", scene_b_alice_id)
    })?
    else {
        panic!("Scene B Alice revision should be available");
    };
    assert_eq!(alice_review.previous_revision_ids, vec![scene_a_id]);
    assert_eq!(alice_review.objects.len(), 1);
    assert_eq!(
        alice_review.objects[0].identity,
        "codex:change-review-alice"
    );
    assert_eq!(
        alice_review.objects[0].change,
        Nir1ChangeReviewObjectChange::Unchanged
    );
    Ok(())
}

#[test]
fn change_review_reads_approved_history_after_live_codex_change() -> anyhow::Result<()> {
    let db = change_review_db()?;
    let first = prepare_change_review_revision(
        &db,
        "change-review:first",
        "nir1-change-review",
        &["change-review-alice"],
    )?;
    let first_id = first["result"]["revisionId"].as_str().unwrap().to_owned();
    approve_change_review_revision(&db, &first)?;

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE codex_entries
                SET summary = 'Alice after', updated_at = '2026-09-13T00:00:00Z'
              WHERE id = 'change-review-alice' AND project_id = 'default-project'",
            [],
        )?;
        Ok(())
    })?;
    let live_reader = db.with_read_transaction(|conn| {
        read_nir1_entity_relation_revision(conn, "default-project", &first_id)
    })?;
    assert!(matches!(
        live_reader,
        Nir1EntityRelationRevisionRead::Unavailable { reason }
            if reason == "source-revision-changed"
    ));

    let current = prepare_change_review_revision(
        &db,
        "change-review:current",
        "nir1-change-review",
        &["change-review-alice"],
    )?;
    let current_id = current["result"]["revisionId"].as_str().unwrap();
    let before = db.with_conn(|conn| Ok(review_row_counts(conn)?))?;
    let Nir1ChangeReviewResult::Available(review) = db.with_read_transaction(|conn| {
        read_nir1_change_review(conn, "default-project", current_id)
    })?
    else {
        panic!("current typed revision and approved history are available");
    };
    let after = db.with_conn(|conn| Ok(review_row_counts(conn)?))?;
    assert_eq!(
        after, before,
        "change review read changed revision table rows"
    );
    assert_eq!(review.previous_revision_ids, vec![first_id.clone()]);
    let expected_build_action = db.with_read_transaction(|conn| {
        Ok(conn
            .query_row(
                "SELECT build_action FROM narrative_consumer_freshness
                  WHERE project_id = 'default-project'
                    AND consumer_kind = 'proposal-revision' AND consumer_key = ?1",
                [current_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    })?;
    assert_eq!(review.freshness.build_action, expected_build_action);
    assert!(review.objects.iter().any(|object| {
        object.identity == "codex:change-review-alice"
            && object.change == Nir1ChangeReviewObjectChange::ContentChanged
    }));
    Ok(())
}

#[test]
fn hidden_or_suppressed_items_make_the_current_revision_unavailable() -> anyhow::Result<()> {
    let db = change_review_db()?;
    let prepared = prepare_change_review_revision(
        &db,
        "change-review:hidden-suppressed",
        "nir1-change-review",
        &["change-review-alice"],
    )?;
    let revision_id = prepared["result"]["revisionId"].as_str().unwrap();

    for context_mode in ["hidden", "suppress"] {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_entries
                    SET context_mode = 'mentioned'
                  WHERE id = 'change-review-alice' AND project_id = 'default-project'",
                [],
            )?;
            Ok(())
        })?;
        let visible = db.with_read_transaction(|conn| {
            read_nir1_change_review(conn, "default-project", revision_id)
        })?;
        assert!(
            matches!(visible, Nir1ChangeReviewResult::Available(_)),
            "revision should be available before setting {context_mode}"
        );

        db.with_conn(|conn| {
            let updated = conn.execute(
                "UPDATE codex_entries SET context_mode = ?1
                  WHERE id = 'change-review-alice' AND project_id = 'default-project'",
                [context_mode],
            )?;
            anyhow::ensure!(updated == 1, "expected to update Alice context mode");
            Ok(())
        })?;
        let result = db.with_read_transaction(|conn| {
            read_nir1_change_review(conn, "default-project", revision_id)
        })?;
        assert_eq!(
            serde_json::to_value(&result)?,
            serde_json::json!({
                "status": "unavailable",
                "result": { "reason": "current-revision-unavailable" }
            })
        );
        assert!(
            matches!(
                result,
                Nir1ChangeReviewResult::Unavailable {
                    reason: "current-revision-unavailable"
                }
            ),
            "revision should be unavailable when context_mode is {context_mode}"
        );
    }

    Ok(())
}
