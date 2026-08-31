use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use grimodex_db::agent_writes::RendererCanonicalWriteContext;
use grimodex_db::agent_writes::{
    agent_codex_create_impl, agent_codex_update_with_request_impl, agent_undo_journal_impl,
    AgentCodexCreatePayload, AgentCodexUpdatePayload, AgentUndoJournalPayload,
};
use grimodex_db::change_events::{append_change_events_in_tx, AppendChangeEvent};
use grimodex_db::domain_writes::{
    tree_node_create, tree_node_patch, tree_node_patch_with_authority, TreeNodeCreatePayload,
    TreeNodePatchPayload,
};
use grimodex_db::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, append_narrative_change_transaction_in_tx,
    narrative_snapshot_digest, AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind,
    NarrativeChangeEventInput, NarrativeChangeOrigin,
};
use grimodex_db::snippet_writes::{create as snippet_create, SnippetCreatePayload};
use grimodex_db::Database;
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    params,
};
use serde_json::{json, Value};
use sha2::Digest;

const PROJECT_ID: &str = "timelapse-create-project";
const SESSION_ID: &str = "timelapse-create-session";
const SCENE_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Scene A"}]}]}"#;
const CODEX_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Codex A"}]}]}"#;
const SNIPPET_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Snippet A"}]}]}"#;

#[derive(Clone, Copy, Debug)]
enum BodyKind {
    Scene,
    Codex,
    Snippet,
}

impl BodyKind {
    fn domain(self) -> &'static str {
        match self {
            Self::Scene => "editor",
            Self::Codex => "codex",
            Self::Snippet => "snippet",
        }
    }

    fn entity_type(self) -> &'static str {
        match self {
            Self::Scene => "scene",
            Self::Codex => "codex_entry",
            Self::Snippet => "snippet",
        }
    }

    fn object_key(self, entity_id: &str) -> Value {
        match self {
            Self::Scene => json!({ "kind": "scene", "sceneId": entity_id }),
            Self::Codex => json!({ "kind": "codex-entry", "entryId": entity_id }),
            Self::Snippet => {
                json!({ "kind": "component", "componentId": format!("snippet:{entity_id}") })
            }
        }
    }
}

fn database() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title, language) VALUES (?1, 'Timelapse', 'ja')",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed project");
    db
}

fn insert_body(
    conn: &rusqlite::Connection,
    kind: BodyKind,
    entity_id: &str,
    content: &str,
) -> anyhow::Result<()> {
    match kind {
        BodyKind::Scene => {
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, sort_order, content)
                 VALUES (?1, ?2, 'scene', 'Scene', 'a0', ?3)",
                params![entity_id, PROJECT_ID, content],
            )?;
        }
        BodyKind::Codex => {
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, content)
                 VALUES (?1, ?2, 'character', 'Codex', ?3)",
                params![entity_id, PROJECT_ID, content],
            )?;
        }
        BodyKind::Snippet => {
            conn.execute(
                "INSERT INTO snippets (id, project_id, title, content)
                 VALUES (?1, ?2, 'Snippet', ?3)",
                params![entity_id, PROJECT_ID, content],
            )?;
        }
    }
    Ok(())
}

fn append_body_lifecycle(
    conn: &rusqlite::Connection,
    kind: BodyKind,
    entity_id: &str,
    event_uid: &str,
    timestamp: i64,
    mutation_kind: &str,
) -> anyhow::Result<i64> {
    let op_type = format!("test.{}.{}", kind.domain(), mutation_kind);
    let state_digest = narrative_snapshot_digest(&json!({
        "entityId": entity_id,
        "kind": kind.entity_type(),
    }))?;
    let (before_version, before_digest, after_version, after_digest) = match mutation_kind {
        "delete" => (Some(1), Some(state_digest), None, None),
        _ => (None, None, Some(1), Some(state_digest)),
    };
    let append = append_canonical_and_narrative_change_in_tx(
        conn,
        PROJECT_ID,
        SESSION_ID,
        &AppendChangeEvent {
            event_uid: event_uid.to_string(),
            scene_id: None,
            domain: kind.domain().to_string(),
            op_type: op_type.clone(),
            entity_type: Some(kind.entity_type().to_string()),
            entity_id: Some(entity_id.to_string()),
            payload: json!({ "entityId": entity_id }).to_string(),
            timestamp,
        },
        &AppendNarrativeChangeTransactionInput {
            project_id: PROJECT_ID.to_string(),
            request_id: format!("request:{event_uid}"),
            source_domain: op_type,
            source_change_event_uid: event_uid.to_string(),
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin: if mutation_kind == "restore" {
                NarrativeChangeOrigin::Restore
            } else {
                NarrativeChangeOrigin::Human
            },
            original_transaction_id: None,
            commit_id: None,
            journal_id: None,
            undo_journal_id: None,
            application_ids: Vec::new(),
            occurred_at: "2026-08-31T00:00:00.000Z".to_string(),
            events: vec![NarrativeChangeEventInput {
                object_key: kind.object_key(entity_id),
                change_kind: "content".to_string(),
                mutation_kind: mutation_kind.to_string(),
                before_version,
                before_digest,
                after_version,
                after_digest,
                changed_paths: vec!["/".to_string()],
                text_impact: None,
                structural_impact: Some(json!({ "changedPaths": ["/"] })),
            }],
        },
    )?;
    Ok(append.canonical.tail_sequence)
}

fn create_body_with_lifecycle(
    db: &Database,
    kind: BodyKind,
    entity_id: &str,
    content: &str,
    event_uid: &str,
    timestamp: i64,
) -> anyhow::Result<i64> {
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        insert_body(&transaction, kind, entity_id, content)?;
        let sequence = append_body_lifecycle(
            &transaction,
            kind,
            entity_id,
            event_uid,
            timestamp,
            "create",
        )?;
        transaction.commit()?;
        Ok(sequence)
    })
}

fn append_pre_feed_narrative_root(
    conn: &rusqlite::Connection,
    kind: BodyKind,
    entity_id: &str,
    event_uid: &str,
) -> anyhow::Result<()> {
    let state_digest = narrative_snapshot_digest(&json!({
        "entityId": entity_id,
        "kind": kind.entity_type(),
    }))?;
    let op_type = format!("test.{}.create", kind.domain());
    append_narrative_change_transaction_in_tx(
        conn,
        &AppendNarrativeChangeTransactionInput {
            project_id: PROJECT_ID.to_string(),
            request_id: format!("pre-feed-modernize:{event_uid}"),
            source_domain: op_type,
            source_change_event_uid: event_uid.to_string(),
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin: NarrativeChangeOrigin::Migration,
            original_transaction_id: None,
            commit_id: None,
            journal_id: None,
            undo_journal_id: None,
            application_ids: Vec::new(),
            occurred_at: "2026-08-31T00:00:00.000Z".to_string(),
            events: vec![NarrativeChangeEventInput {
                object_key: kind.object_key(entity_id),
                change_kind: "content".to_string(),
                mutation_kind: "create".to_string(),
                before_version: None,
                before_digest: None,
                after_version: Some(1),
                after_digest: Some(state_digest),
                changed_paths: vec!["/".to_string()],
                text_impact: None,
                structural_impact: Some(json!({ "changedPaths": ["/"] })),
            }],
        },
    )?;
    Ok(())
}

fn modernize_pre_feed_lifecycle(
    db: &Database,
    kind: BodyKind,
    entity_id: &str,
    content: &str,
    event_uid: &str,
    timestamp: i64,
    legacy_entity_type: bool,
) -> anyhow::Result<()> {
    let sequence = create_body_with_lifecycle(db, kind, entity_id, content, event_uid, timestamp)?;
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM narrative_change_transactions
              WHERE project_id = ?1 AND source_change_event_uid = ?2",
            params![PROJECT_ID, event_uid],
        )?;
        if legacy_entity_type {
            transaction.execute(
                "UPDATE state_snapshots
                    SET entity_type = NULL
                  WHERE project_id = ?1
                    AND domain = ?2
                    AND entity_id = ?3
                    AND anchor_sequence = ?4",
                params![PROJECT_ID, kind.domain(), entity_id, sequence],
            )?;
        }
        append_pre_feed_narrative_root(&transaction, kind, entity_id, event_uid)?;
        transaction.commit()?;
        Ok(())
    })
}

fn tamper_pre_feed_snapshot(
    db: &Database,
    kind: BodyKind,
    entity_id: &str,
    mismatch: &str,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        let sql = match mismatch {
            "payload" => "UPDATE state_snapshots SET payload = 'tampered'",
            "timestamp" => "UPDATE state_snapshots SET anchor_timestamp = anchor_timestamp + 1",
            "encoding" => "UPDATE state_snapshots SET encoding = 'binary'",
            _ => return Err(anyhow::anyhow!("unknown snapshot mismatch {mismatch}")),
        };
        conn.execute(
            &format!(
                "{sql}
                  WHERE project_id = ?1 AND domain = ?2 AND entity_id = ?3"
            ),
            params![PROJECT_ID, kind.domain(), entity_id],
        )?;
        Ok(())
    })
}

fn detach_pre_feed_narrative_root(db: &Database, event_uid: &str) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM narrative_change_transactions
              WHERE project_id = ?1 AND source_change_event_uid = ?2",
            params![PROJECT_ID, event_uid],
        )?;
        Ok(())
    })
}

fn tree_create_payload(
    entity_id: &str,
    node_type: &str,
    content: &str,
    request_id: &str,
) -> TreeNodeCreatePayload {
    serde_json::from_value(json!({
        "id": entity_id,
        "projectId": PROJECT_ID,
        "requestId": request_id,
        "sessionId": format!("session:{request_id}"),
        "eventUid": format!("event:{request_id}"),
        "origin": "human",
        "originalTransactionId": null,
        "undoJournalId": null,
        "parentId": null,
        "nodeType": node_type,
        "title": entity_id,
        "sortOrder": "a0",
        "synopsis": null,
        "status": null,
        "sourceUri": null,
        "sourceMtime": null,
        "content": content,
        "canonicalPayload": null
    }))
    .expect("decode tree create payload")
}

fn codex_create_payload(entity_id: &str, content: &str) -> AgentCodexCreatePayload {
    AgentCodexCreatePayload {
        request_id: Some(format!("request:{entity_id}")),
        entry_id: Some(entity_id.to_string()),
        project_id: PROJECT_ID.to_string(),
        session_id: format!("session:{entity_id}"),
        surface: Some("manual".to_string()),
        type_slug: "character".to_string(),
        name: entity_id.to_string(),
        summary: Some(String::new()),
        content: Some(content.to_string()),
        aliases: None,
        excluded_aliases: None,
        readings: None,
        tags_cache: None,
        parent_id: None,
        source_chat_message_id: None,
        model: None,
        chat_message_id: None,
        trace_id: None,
        authorship_spans: Vec::new(),
    }
}

fn mcp_codex_content_update_payload(
    entry_id: &str,
    base_version: i64,
    content: &str,
) -> AgentCodexUpdatePayload {
    AgentCodexUpdatePayload {
        project_id: PROJECT_ID.to_string(),
        session_id: "mcp-content-session".to_string(),
        surface: Some("mcp".to_string()),
        entry_id: entry_id.to_string(),
        base_version,
        type_slug: None,
        name: None,
        summary: None,
        content: Some(content.to_string()),
        timelapse_doc_step_coverage: None,
        aliases: None,
        excluded_aliases: None,
        readings: None,
        tags_cache: None,
        parent_id: None,
        context_mode: None,
        icon: None,
        children_budget: None,
        notes: None,
        model: None,
        chat_message_id: None,
        trace_id: None,
        authorship_spans: None,
        authorship_span_lanes: None,
    }
}

fn snippet_create_payload(entity_id: &str, content: &str) -> SnippetCreatePayload {
    serde_json::from_value(json!({
        "requestId": format!("request:{entity_id}"),
        "sessionId": format!("session:{entity_id}"),
        "eventUid": format!("event:{entity_id}"),
        "origin": "human",
        "authorityRoute": "human-direct",
        "caller": "human-ui",
        "controls": ["runtime-policy", "actor-context", "typed-writer", "occ", "change-event", "change-feed"],
        "writesAuthorityProtectedField": false,
        "originalTransactionId": null,
        "undoJournalId": null,
        "projectId": PROJECT_ID,
        "snippetId": entity_id,
        "title": entity_id,
        "content": content,
        "tagsCache": null,
        "contentSource": "human",
        "sceneId": null,
        "sourceChatMessageId": null,
        "canonicalPayload": null
    }))
    .expect("decode snippet create payload")
}

fn replay_journal(db: &Database, journal_id: &str, direction: &str, request_id: &str) {
    agent_undo_journal_impl(
        db,
        AgentUndoJournalPayload {
            request_id: request_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            session_id: format!("session:{request_id}"),
            journal_id: journal_id.to_string(),
            direction: direction.to_string(),
            authority_route: "history-replay".to_string(),
            origin: direction.to_string(),
            caller: "undo-redo-command".to_string(),
            controls: vec![
                "original-transaction".to_string(),
                "journal-lineage".to_string(),
                "typed-writer".to_string(),
                "occ".to_string(),
                "change-event".to_string(),
                "change-feed".to_string(),
            ],
        },
    )
    .expect("replay Native Undo Journal");
}

fn snapshot_rows(db: &Database) -> Vec<(String, String, String, i64, i64, String, i64)> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT domain, entity_type, entity_id, anchor_sequence,
                    anchor_timestamp, payload, created_at
               FROM state_snapshots
              WHERE project_id = ?1
              ORDER BY id ASC",
        )?;
        let rows = statement.query_map([PROJECT_ID], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
    .expect("read snapshots")
}

fn canonical_sequence(db: &Database, entity_id: &str) -> i64 {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT sequence FROM change_events
              WHERE project_id = ?1 AND entity_id = ?2
              ORDER BY sequence DESC LIMIT 1",
            params![PROJECT_ID, entity_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
    })
    .expect("read canonical sequence")
}

fn insert_renderer_coverage_prefix(
    db: &Database,
    entity_id: &str,
    content_digest: &str,
    session_id: &str,
) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO change_events
                 (project_id, event_uid, domain, op_type, entity_type, entity_id,
                  payload, session_id, sequence, timestamp, prev_hash, hash)
             VALUES (?1, 'tree-proof-step', 'editor', 'doc.step', 'scene', ?2,
                     '{}', ?3, 2, 2, 'tree-proof-prev', 'tree-proof-step-hash')",
            params![PROJECT_ID, entity_id, session_id],
        )?;
        conn.execute(
            "INSERT INTO change_events
                 (project_id, event_uid, domain, op_type, entity_type, entity_id,
                  payload, session_id, sequence, timestamp, prev_hash, hash)
             VALUES (?1, 'tree-proof-coverage', 'timelapse-internal',
                     'doc.step.coverage', 'scene', ?2,
                     json_object('resultContentDigest', ?3), ?4, 3, 3,
                     'tree-proof-step-hash', 'tree-proof-coverage-hash')",
            params![PROJECT_ID, entity_id, content_digest, session_id],
        )?;
        Ok(())
    })
    .expect("insert tree renderer coverage prefix");
}

fn human_tree_context(payload: &TreeNodePatchPayload) -> RendererCanonicalWriteContext {
    RendererCanonicalWriteContext {
        request_id: payload.request_id.clone(),
        event_uid: payload.event_uid.clone(),
        authority_session_id: None,
        origin: NarrativeChangeOrigin::Human,
        authority_route: "human-direct".to_string(),
        caller: "manual-wrapper".to_string(),
        controls: vec![
            "runtime-policy".to_string(),
            "actor-context".to_string(),
            "typed-writer".to_string(),
            "occ".to_string(),
            "change-event".to_string(),
            "change-feed".to_string(),
        ],
        provenance: None,
        writes_authority_protected_field: false,
        original_transaction_id: None,
        undo_journal_id: None,
        context_mode: None,
        icon: None,
        children_budget: None,
        notes: None,
        canonical_payload: None,
    }
}

fn tree_content_patch_payload(
    entity_id: &str,
    content: &str,
    request_id: &str,
    session_id: &str,
    event_uid: &str,
) -> TreeNodePatchPayload {
    serde_json::from_value(json!({
        "projectId": PROJECT_ID,
        "requestId": request_id,
        "sessionId": session_id,
        "eventUid": event_uid,
        "nodeId": entity_id,
        "patch": { "content": content },
        "baseVersion": null,
        "bumpVersion": false,
        "updatedAt": "2026-08-31T00:00:00.000Z",
        "changeEvent": null,
        "timelapseDocStepCoverage": null,
        "origin": "human",
        "originalTransactionId": null,
        "undoJournalId": null,
        "sourceDomain": null,
        "opType": null,
        "canonicalPayload": null
    }))
    .expect("decode tree content patch payload")
}

#[test]
fn enabled_by_default_and_explicit_true_create_exact_baselines_for_all_body_kinds() {
    for explicit_true in [false, true] {
        let db = database();
        if explicit_true {
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO project_settings (project_id, key, value)
                     VALUES (?1, 'timelapse.enabled', 'true')",
                    [PROJECT_ID],
                )?;
                Ok(())
            })
            .expect("enable timelapse explicitly");
        }

        let fixtures = [
            (BodyKind::Scene, "scene-create", SCENE_DOC, 101_i64),
            (BodyKind::Codex, "codex-create", CODEX_DOC, 102_i64),
            (BodyKind::Snippet, "snippet-create", SNIPPET_DOC, 103_i64),
        ];
        for (index, (kind, entity_id, content, timestamp)) in fixtures.iter().enumerate() {
            let sequence = create_body_with_lifecycle(
                &db,
                *kind,
                entity_id,
                content,
                &format!("create-event-{index}"),
                *timestamp,
            )
            .expect("create body and lifecycle");
            assert_eq!(sequence, i64::try_from(index + 1).expect("small sequence"));
        }

        assert_eq!(
            snapshot_rows(&db),
            vec![
                (
                    "editor".to_string(),
                    "scene".to_string(),
                    "scene-create".to_string(),
                    1,
                    101,
                    SCENE_DOC.to_string(),
                    101,
                ),
                (
                    "codex".to_string(),
                    "codex_entry".to_string(),
                    "codex-create".to_string(),
                    2,
                    102,
                    CODEX_DOC.to_string(),
                    102,
                ),
                (
                    "snippet".to_string(),
                    "snippet".to_string(),
                    "snippet-create".to_string(),
                    3,
                    103,
                    SNIPPET_DOC.to_string(),
                    103,
                ),
            ],
            "default-on and explicit-on must share the exact trusted baseline contract"
        );
    }
}

#[test]
fn pre_feed_modernization_reuses_exact_typed_and_legacy_snapshots_for_all_body_kinds() {
    let fixtures = [
        (BodyKind::Scene, SCENE_DOC),
        (BodyKind::Codex, CODEX_DOC),
        (BodyKind::Snippet, SNIPPET_DOC),
    ];
    for (index, (kind, content)) in fixtures.into_iter().enumerate() {
        for legacy_entity_type in [false, true] {
            let db = database();
            let entity_id = format!("pre-feed-{index}-{legacy_entity_type}");
            let event_uid = format!("pre-feed-event-{index}-{legacy_entity_type}");
            let timestamp = 150 + i64::try_from(index).expect("small fixture index");
            modernize_pre_feed_lifecycle(
                &db,
                kind,
                &entity_id,
                content,
                &event_uid,
                timestamp,
                legacy_entity_type,
            )
            .expect("exact pre-Feed snapshot is reusable");

            db.with_conn(|conn| {
                let snapshot: (Option<String>, i64, i64, String, String) = conn.query_row(
                    "SELECT entity_type, anchor_sequence, anchor_timestamp, payload, encoding
                       FROM state_snapshots
                      WHERE project_id = ?1 AND domain = ?2 AND entity_id = ?3",
                    params![PROJECT_ID, kind.domain(), entity_id],
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
                    snapshot,
                    (
                        if legacy_entity_type {
                            None
                        } else {
                            Some(kind.entity_type().to_string())
                        },
                        1,
                        timestamp,
                        content.to_string(),
                        "json".to_string(),
                    )
                );
                let snapshot_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM state_snapshots
                      WHERE project_id = ?1 AND domain = ?2 AND entity_id = ?3",
                    params![PROJECT_ID, kind.domain(), entity_id],
                    |row| row.get(0),
                )?;
                assert_eq!(snapshot_count, 1, "reuse must not append a duplicate");
                let lifecycle_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_change_events
                      WHERE project_id = ?1 AND canonical_sequence = 1
                        AND mutation_kind IN ('create', 'restore')",
                    [PROJECT_ID],
                    |row| row.get(0),
                )?;
                assert_eq!(lifecycle_count, 1, "modernization creates one Feed root");
                Ok(())
            })
            .expect("inspect modernized snapshot");
        }
    }
}

#[test]
fn pre_feed_snapshot_payload_timestamp_and_encoding_mismatch_roll_back_for_all_body_kinds() {
    let fixtures = [
        (BodyKind::Scene, SCENE_DOC),
        (BodyKind::Codex, CODEX_DOC),
        (BodyKind::Snippet, SNIPPET_DOC),
    ];
    for (index, (kind, content)) in fixtures.into_iter().enumerate() {
        for mismatch in ["payload", "timestamp", "encoding"] {
            let db = database();
            let entity_id = format!("mismatch-{index}-{mismatch}");
            let event_uid = format!("mismatch-event-{index}-{mismatch}");
            let timestamp = 180 + i64::try_from(index).expect("small fixture index");
            create_body_with_lifecycle(&db, kind, &entity_id, content, &event_uid, timestamp)
                .expect("create body for mismatch fixture");
            detach_pre_feed_narrative_root(&db, &event_uid).expect("detach old Feed root");
            tamper_pre_feed_snapshot(&db, kind, &entity_id, mismatch)
                .expect("tamper one snapshot field");

            db.with_conn(|conn| {
                let transaction = conn.unchecked_transaction()?;
                let error =
                    append_pre_feed_narrative_root(&transaction, kind, &entity_id, &event_uid)
                        .expect_err("mismatched snapshot must fail closed");
                assert!(
                    error
                        .to_string()
                        .contains("TIMELAPSE_CREATION_BASELINE_SNAPSHOT_MISMATCH"),
                    "{kind:?}/{mismatch}: {error}"
                );
                transaction.rollback()?;
                Ok(())
            })
            .expect("rollback mismatch transaction");

            db.with_conn(|conn| {
                let narrative_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_change_events WHERE project_id = ?1",
                    [PROJECT_ID],
                    |row| row.get(0),
                )?;
                let transaction_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_change_transactions WHERE project_id = ?1",
                    [PROJECT_ID],
                    |row| row.get(0),
                )?;
                let snapshot_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM state_snapshots
                      WHERE project_id = ?1 AND domain = ?2 AND entity_id = ?3",
                    params![PROJECT_ID, kind.domain(), entity_id],
                    |row| row.get(0),
                )?;
                assert_eq!(narrative_count, 0, "Feed event must roll back");
                assert_eq!(transaction_count, 0, "Feed transaction must roll back");
                assert_eq!(snapshot_count, 1, "mismatch fixture must remain unchanged");
                Ok(())
            })
            .expect("inspect mismatch rollback");
        }
    }
}

#[test]
fn pre_feed_mixed_exact_and_corrupt_boundary_snapshots_fail_closed() {
    let fixtures = [
        (BodyKind::Scene, SCENE_DOC),
        (BodyKind::Codex, CODEX_DOC),
        (BodyKind::Snippet, SNIPPET_DOC),
    ];
    for (index, (kind, content)) in fixtures.into_iter().enumerate() {
        let db = database();
        let entity_id = format!("mixed-{index}");
        let event_uid = format!("mixed-event-{index}");
        let timestamp = 210 + i64::try_from(index).expect("small fixture index");
        create_body_with_lifecycle(&db, kind, &entity_id, content, &event_uid, timestamp)
            .expect("create mixed fixture body");
        detach_pre_feed_narrative_root(&db, &event_uid).expect("detach old Feed root");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO state_snapshots
                    (project_id, domain, entity_type, entity_id,
                     anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                 SELECT project_id, domain, entity_type, entity_id,
                        anchor_sequence, anchor_timestamp, 'corrupt', encoding, created_at
                   FROM state_snapshots
                  WHERE project_id = ?1 AND domain = ?2 AND entity_id = ?3",
                params![PROJECT_ID, kind.domain(), entity_id],
            )?;
            Ok(())
        })
        .expect("insert corrupt sibling snapshot");

        db.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            let error = append_pre_feed_narrative_root(&transaction, kind, &entity_id, &event_uid)
                .expect_err("mixed exact and corrupt snapshots must fail closed");
            assert!(error
                .to_string()
                .contains("TIMELAPSE_CREATION_BASELINE_SNAPSHOT_MISMATCH"));
            transaction.rollback()?;
            Ok(())
        })
        .expect("rollback mixed boundary transaction");

        db.with_conn(|conn| {
            let narrative_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_events WHERE project_id = ?1",
                [PROJECT_ID],
                |row| row.get(0),
            )?;
            let snapshot_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots
                  WHERE project_id = ?1 AND domain = ?2 AND entity_id = ?3",
                params![PROJECT_ID, kind.domain(), entity_id],
                |row| row.get(0),
            )?;
            assert_eq!(narrative_count, 0);
            assert_eq!(snapshot_count, 2);
            Ok(())
        })
        .expect("inspect mixed boundary rollback");
    }
}

#[test]
fn real_scene_codex_and_snippet_writers_snapshot_after_canonical_create() {
    let db = database();
    let scene_payload = tree_create_payload("real-scene", "scene", SCENE_DOC, "real-scene");
    let created_scene = tree_node_create(&db, scene_payload.clone()).expect("create real scene");

    let mut retry = scene_payload;
    retry.session_id = "session:after-restart".to_string();
    retry.event_uid = "event:ignored-retry".to_string();
    assert_eq!(
        tree_node_create(&db, retry).expect("retry real scene create"),
        created_scene,
        "the real writer's idempotent retry must reuse its committed receipt"
    );

    tree_node_create(
        &db,
        tree_create_payload("real-folder", "folder", "{}", "real-folder"),
    )
    .expect("create real folder");
    agent_codex_create_impl(&db, codex_create_payload("real-codex", CODEX_DOC))
        .expect("create real codex entry");
    snippet_create(&db, snippet_create_payload("real-snippet", SNIPPET_DOC))
        .expect("create real snippet");

    let rows = snapshot_rows(&db);
    assert_eq!(rows.len(), 3, "only body entities receive baselines");
    for (domain, entity_type, entity_id, payload) in [
        ("editor", "scene", "real-scene", SCENE_DOC),
        ("codex", "codex_entry", "real-codex", CODEX_DOC),
        ("snippet", "snippet", "real-snippet", SNIPPET_DOC),
    ] {
        let row = rows
            .iter()
            .find(|row| row.2 == entity_id)
            .expect("real writer baseline");
        assert_eq!(row.0, domain);
        assert_eq!(row.1, entity_type);
        assert_eq!(row.3, canonical_sequence(&db, entity_id));
        assert_eq!(row.5, payload);
    }
    assert!(
        rows.iter().all(|row| row.2 != "real-folder"),
        "folder create must not be misclassified as a scene body"
    );
    assert_eq!(
        rows.iter().filter(|row| row.2 == "real-scene").count(),
        1,
        "idempotent create retry must not duplicate its baseline"
    );
}

#[test]
fn real_writer_honors_explicit_off_without_suppressing_the_create() {
    let db = database();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO project_settings (project_id, key, value)
             VALUES (?1, 'timelapse.enabled', 'false')",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("disable timelapse");

    tree_node_create(
        &db,
        tree_create_payload("real-scene-off", "scene", SCENE_DOC, "real-scene-off"),
    )
    .expect("create scene through real writer while off");

    db.with_conn(|conn| {
        for table in [
            "tree_nodes",
            "change_events",
            "narrative_change_transactions",
            "narrative_change_events",
        ] {
            let count: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"),
                [PROJECT_ID],
                |row| row.get(0),
            )?;
            assert_eq!(count, 1, "{table} create contract must still commit");
        }
        Ok(())
    })
    .expect("inspect off writer");
    assert!(snapshot_rows(&db).is_empty());
}

#[test]
fn tree_content_patch_renderer_proof_is_ignored_and_body_snapshot_is_retained() {
    let db = database();
    tree_node_create(
        &db,
        tree_create_payload("tree-proof-scene", "scene", "{}", "tree-proof"),
    )
    .expect("create proof scene");
    let content = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
    let digest = format!(
        "sha256:{}",
        hex::encode(sha2::Sha256::digest(content.as_bytes()))
    );
    let session_id = "tree-proof-session";
    insert_renderer_coverage_prefix(&db, "tree-proof-scene", &digest, session_id);

    let mut payload = tree_content_patch_payload(
        "tree-proof-scene",
        content,
        "tree-proof-request",
        session_id,
        "tree-proof-event",
    );
    payload.timelapse_doc_step_coverage =
        Some(grimodex_db::timelapse::TimelapseDocStepCoverageProof {
            event_uid: "tree-proof-coverage".to_string(),
            session_id: session_id.to_string(),
            content_digest: digest,
        });
    let context = human_tree_context(&payload);
    let first = tree_node_patch_with_authority(&db, payload.clone(), Some(context))
        .expect("renderer proof must not block the body write");
    assert_eq!(
        snapshot_rows(&db).len(),
        2,
        "renderer proof cannot suppress the authoritative body snapshot"
    );

    // Proof transport can be re-materialized or omitted without changing the
    // canonical request identity; the durable receipt is returned unchanged.
    payload.timelapse_doc_step_coverage = None;
    payload.session_id = "tree-proof-retry-session".to_string();
    payload.event_uid = "tree-proof-retry-event".to_string();
    let retry = tree_node_patch(&db, payload.clone()).expect("proof-less retry receipt");
    assert_eq!(retry, first);
    assert_eq!(
        snapshot_rows(&db).len(),
        2,
        "idempotent retry must not duplicate the retained snapshot"
    );

    payload.patch.insert(
        "content".to_string(),
        Value::String("changed-body".to_string()),
    );
    let conflict = tree_node_patch(&db, payload).expect_err("changed body must conflict");
    assert!(conflict
        .to_string()
        .contains("TREE_NODE_PATCH_REQUEST_CONFLICT"));
    assert_eq!(
        snapshot_rows(&db).len(),
        2,
        "conflict must not mutate snapshots"
    );
}

#[test]
fn mcp_codex_content_update_keeps_the_authoritative_snapshot_at_canonical_tail() {
    let db = database();
    let mut create = codex_create_payload("mcp-codex-content", CODEX_DOC);
    create.surface = Some("mcp".to_string());
    agent_codex_create_impl(&db, create).expect("create MCP Codex body");

    let update_content = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"MCP update"}]}]}"#;
    agent_codex_update_with_request_impl(
        &db,
        mcp_codex_content_update_payload("mcp-codex-content", 1, update_content),
        Some("mcp-codex-content-update"),
        None,
    )
    .expect("MCP Codex content update");

    let rows = snapshot_rows(&db);
    assert_eq!(
        rows.len(),
        2,
        "MCP content updates must retain full snapshots"
    );
    let update_snapshot = rows
        .iter()
        .find(|row| row.2 == "mcp-codex-content" && row.3 != 1)
        .expect("MCP update snapshot");
    assert_eq!(update_snapshot.0, "codex");
    assert_eq!(update_snapshot.1, "codex_entry");
    assert_eq!(
        update_snapshot.3,
        canonical_sequence(&db, "mcp-codex-content")
    );
    assert_eq!(update_snapshot.5, update_content);
}

#[test]
fn codex_content_forward_undo_redo_keeps_each_body_snapshot_at_its_canonical_tail() {
    let db = database();
    let mut create = codex_create_payload("codex-content-history", "{}");
    create.surface = Some("mcp".to_string());
    agent_codex_create_impl(&db, create).expect("create Codex body");

    let update = mcp_codex_content_update_payload("codex-content-history", 1, CODEX_DOC);
    let updated = agent_codex_update_with_request_impl(
        &db,
        update,
        Some("codex-content-history-update"),
        None,
    )
    .expect("forward Codex content update");
    let journal_id = updated["undoJournalId"]
        .as_str()
        .expect("Codex update journal")
        .to_string();

    replay_journal(&db, &journal_id, "undo", "codex-content-history-undo");
    replay_journal(&db, &journal_id, "redo", "codex-content-history-redo");

    let rows = snapshot_rows(&db)
        .into_iter()
        .filter(|row| {
            row.0 == "codex" && row.1 == "codex_entry" && row.2 == "codex-content-history"
        })
        .map(|row| (row.3, row.5))
        .collect::<Vec<_>>();
    assert_eq!(
        rows,
        vec![
            (1, "{}".to_string()),
            (2, CODEX_DOC.to_string()),
            (3, "{}".to_string()),
            (4, CODEX_DOC.to_string()),
        ],
        "Codex forward, undo, and redo snapshots must follow each canonical tail"
    );
}

#[test]
fn tree_content_patch_without_renderer_proof_falls_back_to_atomic_snapshot() {
    let db = database();
    tree_node_create(
        &db,
        tree_create_payload("tree-fallback-scene", "scene", "{}", "tree-fallback"),
    )
    .expect("create fallback scene");
    let content = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
    let payload = tree_content_patch_payload(
        "tree-fallback-scene",
        content,
        "tree-fallback-request",
        "tree-fallback-session",
        "tree-fallback-event",
    );
    tree_node_patch(&db, payload).expect("proof-less tree patch");
    let rows = snapshot_rows(&db);
    assert_eq!(
        rows.len(),
        2,
        "creation and update body snapshots are required"
    );
    let update_snapshot = rows
        .iter()
        .find(|row| row.2 == "tree-fallback-scene" && row.3 != 1)
        .expect("update snapshot");
    assert_eq!(update_snapshot.5, content);
    assert_eq!(update_snapshot.3, 2);
}

#[test]
fn real_writer_rolls_back_body_journal_ledgers_and_receipt_on_baseline_failure() {
    let db = database();
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_real_writer_baseline
             BEFORE INSERT ON state_snapshots
             BEGIN
               SELECT RAISE(ABORT, 'reject real writer baseline');
             END;",
        )?;
        Ok(())
    })
    .expect("install real writer failpoint");

    let error = tree_node_create(
        &db,
        tree_create_payload(
            "real-scene-rollback",
            "scene",
            SCENE_DOC,
            "real-scene-rollback",
        ),
    )
    .expect_err("baseline failure must abort the real writer transaction");
    assert!(error.to_string().contains("reject real writer baseline"));

    db.with_conn(|conn| {
        for table in [
            "tree_nodes",
            "undo_journal",
            "change_events",
            "narrative_change_transactions",
            "narrative_change_events",
            "state_snapshots",
            "idempotency_requests",
        ] {
            let count: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"),
                [PROJECT_ID],
                |row| row.get(0),
            )?;
            assert_eq!(count, 0, "{table} must roll back with the failed baseline");
        }
        Ok(())
    })
    .expect("inspect real writer rollback");
}

#[test]
fn real_snippet_undo_and_redo_append_a_new_baseline_for_the_restored_incarnation() {
    let db = database();
    snippet_create(
        &db,
        snippet_create_payload("real-snippet-replay", SNIPPET_DOC),
    )
    .expect("create replayable snippet");
    replay_journal(
        &db,
        "request:real-snippet-replay",
        "undo",
        "undo:real-snippet-replay",
    );
    replay_journal(
        &db,
        "request:real-snippet-replay",
        "redo",
        "redo:real-snippet-replay",
    );

    let rows = snapshot_rows(&db);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].2, "real-snippet-replay");
    assert_eq!(rows[0].3, 1);
    assert_eq!(rows[0].5, SNIPPET_DOC);
    assert_eq!(rows[1].2, "real-snippet-replay");
    assert_eq!(rows[1].3, 3, "undo delete is sequence 2; redo restore is 3");
    assert_eq!(rows[1].5, SNIPPET_DOC);
}

#[test]
fn explicit_false_creates_no_baseline() {
    let db = database();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO project_settings (project_id, key, value)
             VALUES (?1, 'timelapse.enabled', 'false')",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("disable timelapse");

    create_body_with_lifecycle(
        &db,
        BodyKind::Scene,
        "scene-off",
        SCENE_DOC,
        "scene-off-create",
        200,
    )
    .expect("create scene with timelapse off");
    assert!(snapshot_rows(&db).is_empty());
}

#[test]
fn baseline_anchors_to_the_create_event_tail_not_the_previous_tail() {
    let db = database();
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        let append = append_change_events_in_tx(
            &transaction,
            PROJECT_ID,
            SESSION_ID,
            &[AppendChangeEvent {
                event_uid: "preexisting-event".to_string(),
                scene_id: None,
                domain: "project".to_string(),
                op_type: "project.update".to_string(),
                entity_type: Some("project".to_string()),
                entity_id: Some(PROJECT_ID.to_string()),
                payload: "{}".to_string(),
                timestamp: 300,
            }],
        )?;
        assert_eq!(append.tail_sequence, 1);
        transaction.commit()?;
        Ok(())
    })
    .expect("seed prior tail");

    let create_sequence = create_body_with_lifecycle(
        &db,
        BodyKind::Codex,
        "codex-after-tail",
        CODEX_DOC,
        "codex-after-tail-create",
        301,
    )
    .expect("create codex after tail");
    assert_eq!(create_sequence, 2);
    assert_eq!(snapshot_rows(&db)[0].3, 2);
}

#[test]
fn one_canonical_transaction_can_baseline_multiple_created_bodies() {
    let db = database();
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        insert_body(&transaction, BodyKind::Scene, "multi-scene-a", SCENE_DOC)?;
        insert_body(&transaction, BodyKind::Scene, "multi-scene-b", CODEX_DOC)?;
        let append = append_canonical_and_narrative_change_in_tx(
            &transaction,
            PROJECT_ID,
            SESSION_ID,
            &AppendChangeEvent {
                event_uid: "multi-create-event".to_string(),
                scene_id: None,
                domain: "tree".to_string(),
                op_type: "tree.aiScaffold".to_string(),
                entity_type: Some("tree_plan".to_string()),
                entity_id: Some("multi-create-plan".to_string()),
                payload: "{}".to_string(),
                timestamp: 350,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: PROJECT_ID.to_string(),
                request_id: "multi-create-request".to_string(),
                source_domain: "tree.aiScaffold".to_string(),
                source_change_event_uid: "multi-create-event".to_string(),
                cause_kind: NarrativeChangeCauseKind::Forward,
                origin: NarrativeChangeOrigin::AiApply,
                original_transaction_id: None,
                commit_id: None,
                journal_id: None,
                undo_journal_id: None,
                application_ids: Vec::new(),
                occurred_at: "2026-08-31T00:00:00.350Z".to_string(),
                events: [("multi-scene-a", SCENE_DOC), ("multi-scene-b", CODEX_DOC)]
                    .into_iter()
                    .map(|(entity_id, content)| {
                        Ok(NarrativeChangeEventInput {
                            object_key: BodyKind::Scene.object_key(entity_id),
                            change_kind: "content".to_string(),
                            mutation_kind: "create".to_string(),
                            before_version: None,
                            before_digest: None,
                            after_version: Some(0),
                            after_digest: Some(narrative_snapshot_digest(&json!({
                                "entityId": entity_id,
                                "content": content,
                            }))?),
                            changed_paths: vec!["/".to_string()],
                            text_impact: None,
                            structural_impact: Some(json!({ "changedPaths": ["/"] })),
                        })
                    })
                    .collect::<anyhow::Result<Vec<_>>>()?,
            },
        )?;
        assert_eq!(append.canonical.tail_sequence, 1);
        transaction.commit()?;
        Ok(())
    })
    .expect("append multi-body lifecycle");

    let rows = snapshot_rows(&db);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].3, 1);
    assert_eq!(rows[0].5, SCENE_DOC);
    assert_eq!(rows[1].3, 1);
    assert_eq!(rows[1].5, CODEX_DOC);
}

#[test]
fn snippet_component_prefix_is_exact_and_does_not_capture_foreign_components() {
    let db = database();
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        insert_body(
            &transaction,
            BodyKind::Snippet,
            "prefix-target",
            SNIPPET_DOC,
        )?;
        let append = append_change_events_in_tx(
            &transaction,
            PROJECT_ID,
            SESSION_ID,
            &[AppendChangeEvent {
                event_uid: "foreign-component-event".to_string(),
                scene_id: None,
                domain: "component".to_string(),
                op_type: "component.create".to_string(),
                entity_type: Some("component".to_string()),
                entity_id: Some("prefix-target".to_string()),
                payload: "{}".to_string(),
                timestamp: 360,
            }],
        )?;
        transaction.execute(
            "INSERT INTO narrative_change_transactions
                (id, project_id, request_id, source_domain,
                 source_change_event_uid, source_change_event_sequence,
                 cause_kind, origin, application_ids_json, payload_digest, created_at)
             VALUES ('foreign-component-transaction', ?1, 'foreign-component-request',
                     'component.create', 'foreign-component-event', ?2,
                     'forward', 'human', '[]', 'sha256:foreign-component',
                     '2026-08-31T00:00:00.360Z')",
            params![PROJECT_ID, append.tail_sequence],
        )?;
        transaction.execute(
            "INSERT INTO narrative_change_events
                (id, project_id, transaction_id, canonical_change_event_uid,
                 canonical_sequence, event_ordinal, object_key_json,
                 change_kind, mutation_kind, after_version, after_digest,
                 changed_paths_json, occurred_at)
             VALUES ('foreign-component-narrative', ?1,
                     'foreign-component-transaction', 'foreign-component-event',
                     ?2, 0,
                     '{\"kind\":\"component\",\"componentId\":\"snippetish:prefix-target\"}',
                     'content', 'create', 1, 'sha256:foreign-component',
                     '[\"/\"]', '2026-08-31T00:00:00.360Z')",
            params![PROJECT_ID, append.tail_sequence],
        )?;
        transaction.commit()?;
        Ok(())
    })
    .expect("append foreign component lifecycle");

    assert!(snapshot_rows(&db).is_empty());
}

#[test]
fn restore_of_the_same_id_appends_a_newer_baseline() {
    let db = database();
    create_body_with_lifecycle(
        &db,
        BodyKind::Snippet,
        "snippet-recreated",
        SNIPPET_DOC,
        "snippet-first-create",
        400,
    )
    .expect("create first incarnation");

    const RESTORED_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Restored"}]}]}"#;
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM snippets WHERE id = ?1 AND project_id = ?2",
            params!["snippet-recreated", PROJECT_ID],
        )?;
        let delete_sequence = append_body_lifecycle(
            &transaction,
            BodyKind::Snippet,
            "snippet-recreated",
            "snippet-delete",
            401,
            "delete",
        )?;
        assert_eq!(delete_sequence, 2);
        insert_body(
            &transaction,
            BodyKind::Snippet,
            "snippet-recreated",
            RESTORED_DOC,
        )?;
        let sequence = append_body_lifecycle(
            &transaction,
            BodyKind::Snippet,
            "snippet-recreated",
            "snippet-restore",
            402,
            "restore",
        )?;
        assert_eq!(sequence, 3);
        transaction.commit()?;
        Ok(())
    })
    .expect("restore second incarnation");

    let rows = snapshot_rows(&db);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].3, 1);
    assert_eq!(rows[0].5, SNIPPET_DOC);
    assert_eq!(rows[1].3, 3);
    assert_eq!(rows[1].5, RESTORED_DOC);
    let latest = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT payload FROM state_snapshots
                  WHERE project_id = ?1 AND domain = 'snippet' AND entity_id = ?2
                  ORDER BY anchor_sequence DESC, id DESC
                  LIMIT 1",
                params![PROJECT_ID, "snippet-recreated"],
                |row| row.get::<_, String>(0),
            )
            .map_err(Into::into)
        })
        .expect("read latest incarnation");
    assert_eq!(latest, RESTORED_DOC);
}

#[test]
fn baseline_failure_rolls_back_body_and_both_ledgers() {
    let db = database();
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_timelapse_create_baseline
             BEFORE INSERT ON state_snapshots
             BEGIN
               SELECT RAISE(ABORT, 'reject timelapse create baseline');
             END;",
        )?;
        Ok(())
    })
    .expect("install failpoint");

    let error = create_body_with_lifecycle(
        &db,
        BodyKind::Scene,
        "scene-rollback",
        SCENE_DOC,
        "scene-rollback-create",
        500,
    )
    .expect_err("snapshot failure must abort the whole create transaction");
    assert!(error
        .to_string()
        .contains("reject timelapse create baseline"));

    db.with_conn(|conn| {
        for table in [
            "tree_nodes",
            "change_events",
            "narrative_change_transactions",
            "narrative_change_events",
            "state_snapshots",
        ] {
            let count: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"),
                [PROJECT_ID],
                |row| row.get(0),
            )?;
            assert_eq!(count, 0, "{table} must roll back atomically");
        }
        Ok(())
    })
    .expect("inspect rollback");
}

#[test]
fn malformed_or_non_tail_lifecycle_anchor_is_rejected_atomically() {
    for (case, canonical_timestamp, canonical_sequence, append_new_tail) in [
        ("wrong-sequence", 510_i64, 2_i64, false),
        ("unsafe-sequence", 510, 9_007_199_254_740_992, false),
        ("old-tail", 510, 1, true),
        ("unsafe-timestamp", 9_007_199_254_740_992, 1, false),
    ] {
        let db = database();
        db.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            let entity_id = format!("scene-invalid-anchor-{case}");
            let event_uid = format!("invalid-anchor-event-{case}");
            insert_body(&transaction, BodyKind::Scene, &entity_id, SCENE_DOC)?;
            transaction.execute(
                "INSERT INTO change_events
                    (event_uid, project_id, domain, op_type, entity_type, entity_id,
                     payload, session_id, sequence, timestamp, prev_hash, hash)
                 VALUES (?1, ?2, 'editor', 'scene.create', 'scene', ?3,
                         '{}', ?4, 1, ?5, 'prev', ?6)",
                params![
                    event_uid,
                    PROJECT_ID,
                    entity_id,
                    SESSION_ID,
                    canonical_timestamp,
                    format!("hash-{case}-1"),
                ],
            )?;
            if append_new_tail {
                transaction.execute(
                    "INSERT INTO change_events
                        (event_uid, project_id, domain, op_type, entity_type, entity_id,
                         payload, session_id, sequence, timestamp, prev_hash, hash)
                     VALUES (?1, ?2, 'editor', 'scene.update', 'scene', ?3,
                             '{}', ?4, 2, 511, ?5, ?6)",
                    params![
                        format!("invalid-anchor-tail-event-{case}"),
                        PROJECT_ID,
                        entity_id,
                        SESSION_ID,
                        format!("hash-{case}-1"),
                        format!("hash-{case}-2"),
                    ],
                )?;
            }
            let transaction_id = format!("invalid-anchor-transaction-{case}");
            transaction.execute(
                "INSERT INTO narrative_change_transactions
                    (id, project_id, request_id, source_domain,
                     source_change_event_uid, source_change_event_sequence,
                     cause_kind, origin, application_ids_json, payload_digest, created_at)
                 VALUES (?1, ?2, ?3, 'scene.create', ?4, 1,
                         'forward', 'human', '[]', ?5,
                         '2026-08-31T00:00:00.510Z')",
                params![
                    transaction_id,
                    PROJECT_ID,
                    format!("invalid-anchor-request-{case}"),
                    event_uid,
                    format!("sha256:invalid-anchor-{case}"),
                ],
            )?;
            let error = transaction
                .execute(
                    "INSERT INTO narrative_change_events
                        (id, project_id, transaction_id, canonical_change_event_uid,
                         canonical_sequence, event_ordinal, object_key_json,
                         change_kind, mutation_kind, after_version, after_digest,
                         changed_paths_json, occurred_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6,
                             'content', 'create', 1, ?7, '[\"/\"]',
                             '2026-08-31T00:00:00.510Z')",
                    params![
                        format!("invalid-anchor-narrative-{case}"),
                        PROJECT_ID,
                        transaction_id,
                        event_uid,
                        canonical_sequence,
                        BodyKind::Scene.object_key(&entity_id).to_string(),
                        format!("sha256:invalid-anchor-after-{case}"),
                    ],
                )
                .expect_err("malformed lifecycle anchor must fail closed");
            assert!(
                error
                    .to_string()
                    .contains("TIMELAPSE_CREATION_BASELINE_INVALID_ANCHOR"),
                "{case}: {error}"
            );
            transaction.rollback()?;
            Ok(())
        })
        .expect("exercise invalid lifecycle anchor");

        db.with_conn(|conn| {
            for table in [
                "tree_nodes",
                "change_events",
                "narrative_change_transactions",
                "narrative_change_events",
                "state_snapshots",
            ] {
                let count: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"),
                    [PROJECT_ID],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 0, "{case}: {table} must roll back");
            }
            Ok(())
        })
        .expect("inspect invalid-anchor rollback");
    }
}

#[test]
fn duplicate_same_entity_lifecycle_at_one_canonical_boundary_is_rejected() {
    let db = database();
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        insert_body(
            &transaction,
            BodyKind::Scene,
            "scene-duplicate-lifecycle",
            SCENE_DOC,
        )?;
        transaction.execute(
            "INSERT INTO change_events
                (event_uid, project_id, domain, op_type, entity_type, entity_id,
                 payload, session_id, sequence, timestamp, prev_hash, hash)
             VALUES ('duplicate-lifecycle-event', ?1, 'editor', 'scene.create',
                     'scene', 'scene-duplicate-lifecycle', '{}', ?2,
                     1, 520, 'prev', 'duplicate-lifecycle-hash')",
            params![PROJECT_ID, SESSION_ID],
        )?;
        transaction.execute(
            "INSERT INTO narrative_change_transactions
                (id, project_id, request_id, source_domain,
                 source_change_event_uid, source_change_event_sequence,
                 cause_kind, origin, application_ids_json, payload_digest, created_at)
             VALUES ('duplicate-lifecycle-transaction', ?1,
                     'duplicate-lifecycle-request', 'scene.create',
                     'duplicate-lifecycle-event', 1, 'forward', 'human',
                     '[]', 'sha256:duplicate-lifecycle',
                     '2026-08-31T00:00:00.520Z')",
            [PROJECT_ID],
        )?;
        for ordinal in [0, 1] {
            let result = transaction.execute(
                "INSERT INTO narrative_change_events
                    (id, project_id, transaction_id, canonical_change_event_uid,
                     canonical_sequence, event_ordinal, object_key_json,
                     change_kind, mutation_kind, after_version, after_digest,
                     changed_paths_json, occurred_at)
                 VALUES (?1, ?2, 'duplicate-lifecycle-transaction',
                         'duplicate-lifecycle-event', 1, ?3,
                         '{\"kind\":\"scene\",\"sceneId\":\"scene-duplicate-lifecycle\"}',
                         'content', 'create', 1, 'sha256:duplicate-lifecycle-after',
                         '[\"/\"]', '2026-08-31T00:00:00.520Z')",
                params![
                    format!("duplicate-lifecycle-{ordinal}"),
                    PROJECT_ID,
                    ordinal
                ],
            );
            if ordinal == 0 {
                result.expect("first lifecycle event creates the baseline");
            } else {
                let error = result.expect_err("duplicate lifecycle must fail closed");
                assert!(error
                    .to_string()
                    .contains("TIMELAPSE_CREATION_BASELINE_DUPLICATE_LIFECYCLE"));
            }
        }
        transaction.rollback()?;
        Ok(())
    })
    .expect("exercise duplicate lifecycle");

    assert!(snapshot_rows(&db).is_empty());
    db.with_conn(|conn| {
        for table in [
            "tree_nodes",
            "change_events",
            "narrative_change_transactions",
            "narrative_change_events",
        ] {
            let count: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"),
                [PROJECT_ID],
                |row| row.get(0),
            )?;
            assert_eq!(count, 0, "{table} must roll back");
        }
        Ok(())
    })
    .expect("inspect duplicate lifecycle rollback");
}

#[test]
fn first_doc_step_is_strictly_after_the_exact_creation_baseline() {
    let db = database();
    let create_sequence = create_body_with_lifecycle(
        &db,
        BodyKind::Scene,
        "scene-first-step",
        SCENE_DOC,
        "scene-first-step-create",
        600,
    )
    .expect("create scene baseline");

    const STEP_PAYLOAD: &str = r#"{"steps":[{"stepType":"replace","from":8,"to":8,"slice":{"content":[{"type":"text","text":"!"}]}}]}"#;
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        let append = append_change_events_in_tx(
            &transaction,
            PROJECT_ID,
            SESSION_ID,
            &[AppendChangeEvent {
                event_uid: "scene-first-doc-step".to_string(),
                scene_id: Some("scene-first-step".to_string()),
                domain: "editor".to_string(),
                op_type: "doc.step".to_string(),
                entity_type: Some("scene".to_string()),
                entity_id: Some("scene-first-step".to_string()),
                payload: STEP_PAYLOAD.to_string(),
                timestamp: 601,
            }],
        )?;
        assert_eq!(append.tail_sequence, create_sequence + 1);
        transaction.commit()?;
        Ok(())
    })
    .expect("append first doc step");

    db.with_conn(|conn| {
        let (anchor, baseline): (i64, String) = conn.query_row(
            "SELECT anchor_sequence, payload FROM state_snapshots
              WHERE project_id = ?1 AND entity_id = 'scene-first-step'",
            [PROJECT_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(anchor, create_sequence);
        assert_eq!(baseline, SCENE_DOC);
        let replay_events = conn
            .prepare(
                "SELECT sequence, payload FROM change_events
                  WHERE project_id = ?1 AND entity_id = 'scene-first-step'
                    AND domain = 'editor' AND op_type = 'doc.step'
                    AND sequence > ?2
                  ORDER BY sequence ASC",
            )?
            .query_map(params![PROJECT_ID, anchor], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(
            replay_events,
            vec![(create_sequence + 1, STEP_PAYLOAD.to_string())],
            "replay must begin with the first post-create step exactly once"
        );
        Ok(())
    })
    .expect("inspect replay slice");
}

#[test]
fn unrelated_update_feed_does_not_create_a_body_baseline() {
    let db = database();
    db.with_conn(|conn| {
        insert_body(conn, BodyKind::Scene, "scene-update-only", SCENE_DOC)?;
        let transaction = conn.unchecked_transaction()?;
        let before_digest = narrative_snapshot_digest(&json!({ "version": 1 }))?;
        let after_digest = narrative_snapshot_digest(&json!({ "version": 2 }))?;
        append_canonical_and_narrative_change_in_tx(
            &transaction,
            PROJECT_ID,
            SESSION_ID,
            &AppendChangeEvent {
                event_uid: "scene-update-only-event".to_string(),
                scene_id: Some("scene-update-only".to_string()),
                domain: "editor".to_string(),
                op_type: "scene.update".to_string(),
                entity_type: Some("scene".to_string()),
                entity_id: Some("scene-update-only".to_string()),
                payload: "{}".to_string(),
                timestamp: 700,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: PROJECT_ID.to_string(),
                request_id: "scene-update-only-request".to_string(),
                source_domain: "scene.update".to_string(),
                source_change_event_uid: "scene-update-only-event".to_string(),
                cause_kind: NarrativeChangeCauseKind::Forward,
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                commit_id: None,
                journal_id: None,
                undo_journal_id: None,
                application_ids: Vec::new(),
                occurred_at: "2026-08-31T00:00:00.000Z".to_string(),
                events: vec![NarrativeChangeEventInput {
                    object_key: BodyKind::Scene.object_key("scene-update-only"),
                    change_kind: "content".to_string(),
                    mutation_kind: "update".to_string(),
                    before_version: Some(1),
                    before_digest: Some(before_digest),
                    after_version: Some(2),
                    after_digest: Some(after_digest),
                    changed_paths: vec!["/content".to_string()],
                    text_impact: None,
                    structural_impact: Some(json!({ "changedPaths": ["/content"] })),
                }],
            },
        )?;
        transaction.commit()?;
        Ok(())
    })
    .expect("append non-lifecycle update");
    assert!(snapshot_rows(&db).is_empty());
}

#[test]
fn current_schema_open_repairs_missing_and_stale_creation_baseline_triggers() {
    let db = database();
    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TRIGGER timelapse_scene_creation_baseline;
             DROP TRIGGER timelapse_codex_creation_baseline;
             DROP TRIGGER timelapse_snippet_creation_baseline;
             CREATE TRIGGER timelapse_codex_creation_baseline
                 AFTER INSERT ON narrative_change_events
                 BEGIN
                     SELECT 1;
                 END;",
        )?;
        assert!(
            !grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?,
            "missing and stale triggers must invalidate the current checkpoint"
        );
        Ok(())
    })
    .expect("damage current trigger contract");

    db.migrate()
        .expect("current-schema open must replay the in-version trigger repair");

    db.with_conn(|conn| {
        assert!(
            grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?,
            "repair must converge the current checkpoint"
        );
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, grimodex_core::SCHEMA_VERSION);
        Ok(())
    })
    .expect("verify repaired trigger contract");
}

#[test]
fn current_schema_open_repairs_semantically_stale_creation_baseline_triggers() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("create current schema");
    db.with_conn(|conn| {
        for name in [
            "timelapse_scene_creation_baseline",
            "timelapse_codex_creation_baseline",
            "timelapse_snippet_creation_baseline",
        ] {
            let sql: String = conn.query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
                [name],
                |row| row.get(0),
            )?;
            // Keep every other clause, including the broad mismatch and
            // duplicate-lifecycle guards, but invert one predicate that is
            // semantically authoritative. A fragment-only checkpoint would
            // incorrectly accept this trigger and skip the repair forever.
            let stale_sql = sql.replace(
                "snapshot.anchor_timestamp IS NOT canonical.timestamp",
                "snapshot.anchor_timestamp IS canonical.timestamp",
            );
            assert_ne!(stale_sql, sql, "{name} must contain the canonical guard");
            assert!(stale_sql.contains("TIMELAPSE_CREATION_BASELINE_SNAPSHOT_MISMATCH"));
            assert!(stale_sql.contains("TIMELAPSE_CREATION_BASELINE_DUPLICATE_LIFECYCLE"));
            conn.execute_batch(&format!("DROP TRIGGER {name};"))?;
            conn.execute_batch(&stale_sql)?;
        }
        assert!(
            !grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?,
            "semantically stale same-name triggers must invalidate the current checkpoint"
        );
        Ok(())
    })
    .expect("install semantically stale trigger definitions");

    db.migrate()
        .expect("current-schema open must replay the trigger repair");
    db.with_conn(|conn| {
        assert!(
            grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?,
            "the first repair must restore all canonical creation triggers"
        );
        Ok(())
    })
    .expect("verify repaired trigger definitions");

    // A second open must take the read-only converged path rather than
    // repeatedly dropping/recreating the same trigger definitions.
    let drop_attempted = Arc::new(AtomicBool::new(false));
    let drop_attempted_for_hook = Arc::clone(&drop_attempted);
    db.with_conn(|conn| {
        conn.authorizer(Some(move |context: AuthContext<'_>| match context.action {
            AuthAction::DropTrigger { trigger_name, .. }
                if trigger_name.starts_with("timelapse_") =>
            {
                drop_attempted_for_hook.store(true, Ordering::SeqCst);
                Authorization::Allow
            }
            _ => Authorization::Allow,
        }))?;
        Ok(())
    })
    .expect("install second-open trigger-repair observer");
    db.migrate().expect("reopen repaired schema");
    assert!(
        !drop_attempted.load(Ordering::SeqCst),
        "a converged second open must not recreate creation triggers"
    );
    db.with_conn(|conn| {
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        assert!(grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?);
        Ok(())
    })
    .expect("verify second-open convergence");
}
