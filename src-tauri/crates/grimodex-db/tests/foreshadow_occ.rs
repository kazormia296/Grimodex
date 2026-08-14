use std::path::Path;

use grimodex_db::{
    agent_writes::{
        agent_foreshadow_update_impl, agent_undo_journal_impl, AgentForeshadowUpdatePayload,
        AgentUndoJournalPayload,
    },
    foreshadow::{self, ForeshadowDeletePayload, RendererWriteContext},
    narrative_extraction::change_feed::NarrativeChangeOrigin,
    Database,
};
use serde_json::{json, Value};

fn delete_payload(
    id: &str,
    project_id: &str,
    base_version: i64,
    request_id: &str,
) -> ForeshadowDeletePayload {
    ForeshadowDeletePayload {
        id: id.to_string(),
        project_id: project_id.to_string(),
        base_version,
        context: RendererWriteContext {
            request_id: request_id.to_string(),
            session_id: "manual-session".to_string(),
            event_uid: format!("{request_id}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
        },
    }
}

fn test_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open test database");
    db.migrate().expect("migrate test database");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'Project');
             INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, sort_order)
             VALUES
                ('s1', 'p1', 'scene', 'Plant', '{}', 'a0'),
                ('s2', 'p1', 'scene', 'Payoff', '{}', 'a1');
             INSERT INTO codex_entries (id, project_id, type, name)
             VALUES ('c1', 'p1', 'character', 'Witness');
             INSERT INTO foreshadows
                (id, project_id, title, intent, notes, payoff_scene_id,
                 payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned,
                 secret, load_bearing, mechanism, version, codex_link_dirty_at,
                 created_at, updated_at)
             VALUES
                ('f1', 'p1', 'Original', 'intent', 'notes', 's2', 8, 12,
                 1, 0, 0, 'critical', 'misdirection', 0, 77, 1, 1);
             INSERT INTO foreshadow_setups
                (id, foreshadow_id, scene_id, from_pos, to_pos, kind, role,
                 strength, ai_strength, ai_reasoning, attribution, ai_rationale,
                 last_evaluated_at, is_orphan, evidence_anchor_id, semantic_key,
                 created_at, updated_at)
             VALUES
                ('su1', 'f1', 's1', 2, 5, 'designated_existing', 'primary',
                 'strong', 'medium', 'reason', 'human', 'rationale', 44, 0,
                 'ev-setup', 'setup-key', 1, 1);
             INSERT INTO foreshadow_payoffs
                (id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
                 is_primary, attribution, ai_rationale, is_orphan,
                 evidence_anchor_id, semantic_key, created_at, updated_at)
             VALUES
                ('po1', 'f1', 's2', 8, 12, 'primary', 1, 1, 'ai',
                 'payoff rationale', 0, 'ev-payoff', 'payoff-key', 1, 1);
             INSERT INTO foreshadow_setup_payoff_links
                (foreshadow_id, setup_id, payoff_id, bridge_kind, explanation, created_at)
             VALUES ('f1', 'su1', 'po1', 'causal', 'bridge', 1);
             INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
             VALUES ('f1', 'c1');",
        )?;
        Ok(())
    })
    .expect("seed aggregate");
    db
}

fn apply_journal(db: &Database, journal_id: &str, direction: &str) -> anyhow::Result<Value> {
    agent_undo_journal_impl(
        db,
        AgentUndoJournalPayload {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: "p1".to_string(),
            session_id: "history-session".to_string(),
            journal_id: journal_id.to_string(),
            direction: direction.to_string(),
        },
    )
}

fn root_version(db: &Database) -> Option<i64> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT version FROM foreshadows WHERE id = 'f1'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    })
    .expect("load root version")
}

fn assert_full_aggregate(db: &Database, expected_version: i64, expected_title: &str) {
    db.with_conn(|conn| {
        let root: (String, String, String, i64, i64) = conn.query_row(
            "SELECT title, mechanism, load_bearing, codex_link_dirty_at, version
               FROM foreshadows WHERE id = 'f1'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(
            root,
            (
                expected_title.to_string(),
                "misdirection".to_string(),
                "critical".to_string(),
                77,
                expected_version,
            )
        );
        let setup: (String, String, String, String, i64) = conn.query_row(
            "SELECT role, strength, ai_reasoning, evidence_anchor_id, last_evaluated_at
               FROM foreshadow_setups WHERE id = 'su1'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(
            setup,
            (
                "primary".to_string(),
                "strong".to_string(),
                "reason".to_string(),
                "ev-setup".to_string(),
                44,
            )
        );
        let payoff: (String, i64, String, String) = conn.query_row(
            "SELECT role, is_primary, evidence_anchor_id, semantic_key
               FROM foreshadow_payoffs WHERE id = 'po1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(
            payoff,
            (
                "primary".to_string(),
                1,
                "ev-payoff".to_string(),
                "payoff-key".to_string(),
            )
        );
        let edge: (String, String) = conn.query_row(
            "SELECT bridge_kind, explanation
               FROM foreshadow_setup_payoff_links
              WHERE setup_id = 'su1' AND payoff_id = 'po1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(edge, ("causal".to_string(), "bridge".to_string()));
        let codex: String = conn.query_row(
            "SELECT codex_entry_id FROM foreshadow_codex_links WHERE foreshadow_id = 'f1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(codex, "c1");
        Ok(())
    })
    .expect("assert full aggregate");
}

#[test]
fn manual_delete_restores_full_aggregate_and_advances_generation_each_cycle() {
    let db = test_db();
    let receipt = foreshadow::delete(&db, delete_payload("f1", "p1", 0, "delete-f1"))
        .expect("delete aggregate");
    let journal_id = receipt["undoJournalId"]
        .as_str()
        .expect("delete journal id");
    assert_eq!(root_version(&db), None);

    apply_journal(&db, journal_id, "undo").expect("undo delete");
    assert_full_aggregate(&db, 1, "Original");

    apply_journal(&db, journal_id, "redo").expect("redo delete");
    assert_eq!(root_version(&db), None);

    apply_journal(&db, journal_id, "undo").expect("undo delete again");
    assert_full_aggregate(&db, 2, "Original");

    let replay = apply_journal(&db, journal_id, "undo")
        .expect_err("old undo receipt replay must be rejected");
    assert!(replay.to_string().contains("still exists"));
    assert_full_aggregate(&db, 2, "Original");

    let stale_delete = foreshadow::delete(&db, delete_payload("f1", "p1", 0, "stale-delete-f1"))
        .expect_err("pre-delete token must remain stale after restore");
    assert!(stale_delete
        .to_string()
        .contains("FORESHADOW_VERSION_MISMATCH"));
    assert_full_aggregate(&db, 2, "Original");
}

#[test]
fn stacked_update_and_delete_history_keeps_monotonic_tokens_and_children() {
    let db = test_db();
    let update_payload: AgentForeshadowUpdatePayload = serde_json::from_value(json!({
        "requestId": "update-f1",
        "projectId": "p1",
        "sessionId": "agent-session",
        "foreshadowId": "f1",
        "baseVersion": 0,
        "title": "Updated",
    }))
    .expect("deserialize update payload");
    let update = agent_foreshadow_update_impl(&db, update_payload).expect("tracked update");
    let update_journal = update["undoJournalId"].as_str().expect("update journal id");
    assert_full_aggregate(&db, 1, "Updated");

    let delete = foreshadow::delete(&db, delete_payload("f1", "p1", 1, "delete-f1-after-update"))
        .expect("delete after update");
    let delete_journal = delete["undoJournalId"].as_str().expect("delete journal id");

    apply_journal(&db, delete_journal, "undo").expect("undo delete");
    assert_full_aggregate(&db, 2, "Updated");
    apply_journal(&db, update_journal, "undo").expect("undo earlier update");
    assert_full_aggregate(&db, 3, "Original");
    apply_journal(&db, update_journal, "redo").expect("redo earlier update");
    assert_full_aggregate(&db, 4, "Updated");
    apply_journal(&db, delete_journal, "redo").expect("redo delete");
    assert_eq!(root_version(&db), None);
    apply_journal(&db, delete_journal, "undo").expect("undo delete after stacked replay");
    assert_full_aggregate(&db, 5, "Updated");
}

use rusqlite::OptionalExtension;
