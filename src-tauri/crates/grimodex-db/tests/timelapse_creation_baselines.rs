#[path = "../test-support/adapter.rs"]
mod test_support;

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
const PROTECTED_CODEX_ENTRY_ID: &str = "protected-codex-entry";
const PROTECTED_CODEX_APPLY_EVENT_UID: &str = "protected-codex-apply-event";
const PROTECTED_CODEX_UNDO_EVENT_UID: &str = "protected-codex-undo-event";
const PROTECTED_CODEX_TAIL_EVENT_UID: &str = "protected-codex-tail-event";
const PROTECTED_CODEX_COMMIT_ID: &str = "protected-codex-commit";
const PROTECTED_CODEX_JOURNAL_ID: &str = "protected-codex-journal";
const PROTECTED_CODEX_APPLICATION_ID: &str = "protected-codex-application";
const PROTECTED_CODEX_REQUEST_ID: &str = "protected-codex-request";
const PROTECTED_CODEX_PLAN_DIGEST: &str = "protected-codex-plan-digest";

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
    seed_database(test_support::current_schema_memory().expect("current-schema fixture"))
}

fn seed_database(db: Database) -> Database {
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

fn protected_codex_journal_entities() -> Value {
    json!([{
        "entityKind": "codex_entry",
        "entityId": PROTECTED_CODEX_ENTRY_ID,
        "version": 1,
        "opKind": "create",
        "snapshot": {
            "id": PROTECTED_CODEX_ENTRY_ID,
            "projectId": PROJECT_ID,
            "content": CODEX_DOC,
            "version": 1
        }
    }])
}

fn protected_codex_receipt() -> Value {
    json!({
        "commitId": PROTECTED_CODEX_COMMIT_ID,
        "requestId": PROTECTED_CODEX_REQUEST_ID,
        "planDigest": PROTECTED_CODEX_PLAN_DIGEST,
        "journalId": PROTECTED_CODEX_JOURNAL_ID,
        "status": "undone",
        "changeEventUid": PROTECTED_CODEX_UNDO_EVENT_UID
    })
}

fn append_protected_codex_root(
    conn: &rusqlite::Connection,
    request_id: &str,
) -> anyhow::Result<()> {
    let state_digest = narrative_snapshot_digest(&json!({
        "entityId": PROTECTED_CODEX_ENTRY_ID,
        "kind": "codex_entry",
    }))?;
    append_narrative_change_transaction_in_tx(
        conn,
        &AppendNarrativeChangeTransactionInput {
            project_id: PROJECT_ID.to_string(),
            request_id: request_id.to_string(),
            source_domain: "narrative.commit.apply".to_string(),
            source_change_event_uid: PROTECTED_CODEX_APPLY_EVENT_UID.to_string(),
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin: NarrativeChangeOrigin::AiApply,
            original_transaction_id: None,
            commit_id: Some(PROTECTED_CODEX_COMMIT_ID.to_string()),
            journal_id: Some(PROTECTED_CODEX_JOURNAL_ID.to_string()),
            undo_journal_id: None,
            application_ids: vec![PROTECTED_CODEX_APPLICATION_ID.to_string()],
            occurred_at: "2026-08-31T00:00:00.800Z".to_string(),
            events: vec![NarrativeChangeEventInput {
                object_key: BodyKind::Codex.object_key(PROTECTED_CODEX_ENTRY_ID),
                change_kind: "metadata".to_string(),
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

fn setup_protected_codex_historical_fixture() -> anyhow::Result<Database> {
    let db = database();
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        insert_body(
            &transaction,
            BodyKind::Codex,
            PROTECTED_CODEX_ENTRY_ID,
            CODEX_DOC,
        )?;
        transaction.execute(
            "UPDATE codex_entries SET version = 1
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?;
        let apply_payload = json!({
            "commitId": PROTECTED_CODEX_COMMIT_ID,
            "requestId": PROTECTED_CODEX_REQUEST_ID,
            "planDigest": PROTECTED_CODEX_PLAN_DIGEST
        })
        .to_string();
        let append = append_change_events_in_tx(
            &transaction,
            PROJECT_ID,
            SESSION_ID,
            &[AppendChangeEvent {
                event_uid: PROTECTED_CODEX_APPLY_EVENT_UID.to_string(),
                scene_id: None,
                domain: "narrative".to_string(),
                op_type: "narrative.commit.apply".to_string(),
                entity_type: Some("narrative_apply_commit".to_string()),
                entity_id: Some(PROTECTED_CODEX_COMMIT_ID.to_string()),
                payload: apply_payload,
                timestamp: 800,
            }],
        )?;
        assert_eq!(append.tail_sequence, 1);
        transaction.execute(
            "INSERT INTO state_snapshots
                (project_id, domain, entity_type, entity_id,
                 anchor_sequence, anchor_timestamp, payload, encoding, created_at)
             VALUES (?1, 'codex', 'codex_entry', ?2, 1, 800, ?3, 'json', 800)",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID, CODEX_DOC],
        )?;
        transaction.execute(
            "INSERT INTO narrative_apply_commits
                (id, project_id, request_id, plan_digest, status, session_id,
                 receipt_json, created_at)
             VALUES (?1, ?2, ?3, ?4, 'undone', ?5, ?6, '2026-08-31T00:00:00.800Z')",
            params![
                PROTECTED_CODEX_COMMIT_ID,
                PROJECT_ID,
                PROTECTED_CODEX_REQUEST_ID,
                PROTECTED_CODEX_PLAN_DIGEST,
                SESSION_ID,
                protected_codex_receipt().to_string()
            ],
        )?;
        transaction.execute(
            "INSERT INTO narrative_proposal_applications
                (id, commit_id, proposal_id, revision_id,
                 applied_entity_kind, applied_entity_id, created_at)
             VALUES (?1, ?2, 'protected-proposal', 'protected-revision',
                     'codex_entry', ?3, '2026-08-31T00:00:00.800Z')",
            params![
                PROTECTED_CODEX_APPLICATION_ID,
                PROTECTED_CODEX_COMMIT_ID,
                PROTECTED_CODEX_ENTRY_ID
            ],
        )?;
        let after_json = json!({
            "entities": protected_codex_journal_entities(),
            "entityBindings": []
        });
        transaction.execute(
            "INSERT INTO narrative_commit_journals
                (id, commit_id, project_id, before_json, after_json, created_at)
             VALUES (?1, ?2, ?3, NULL, ?4, '2026-08-31T00:00:00.800Z')",
            params![
                PROTECTED_CODEX_JOURNAL_ID,
                PROTECTED_CODEX_COMMIT_ID,
                PROJECT_ID,
                after_json.to_string()
            ],
        )?;
        append_protected_codex_root(&transaction, PROTECTED_CODEX_REQUEST_ID)?;
        transaction.commit()?;
        Ok(())
    })?;
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        let append = append_change_events_in_tx(
            &transaction,
            PROJECT_ID,
            SESSION_ID,
            &[AppendChangeEvent {
                event_uid: PROTECTED_CODEX_UNDO_EVENT_UID.to_string(),
                scene_id: None,
                domain: "narrative".to_string(),
                op_type: "narrative.commit.undo".to_string(),
                entity_type: Some("narrative_apply_commit".to_string()),
                entity_id: Some(PROTECTED_CODEX_COMMIT_ID.to_string()),
                payload: json!({
                    "commitId": PROTECTED_CODEX_COMMIT_ID,
                    "requestId": "protected-codex-undo-request",
                    "applyRequestId": PROTECTED_CODEX_REQUEST_ID
                })
                .to_string(),
                timestamp: 801,
            }],
        )?;
        assert_eq!(append.tail_sequence, 2);
        transaction.execute(
            "DELETE FROM narrative_change_transactions
              WHERE project_id = ?1 AND source_change_event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
        )?;
        let append = append_change_events_in_tx(
            &transaction,
            PROJECT_ID,
            SESSION_ID,
            &[AppendChangeEvent {
                event_uid: PROTECTED_CODEX_TAIL_EVENT_UID.to_string(),
                scene_id: None,
                domain: "test".to_string(),
                op_type: "test.tail".to_string(),
                entity_type: None,
                entity_id: None,
                payload: "{}".to_string(),
                timestamp: 802,
            }],
        )?;
        assert_eq!(append.tail_sequence, 3);
        transaction.commit()?;
        Ok(())
    })?;
    Ok(db)
}

#[derive(Clone, Copy, Debug)]
enum ProtectedCodexFailure {
    MissingTransaction,
    MismatchedTransaction,
    UnrelatedProvenance,
    MismatchedRequest,
    MismatchedSourceSequence,
    MismatchedCause,
    MismatchedOrigin,
    MismatchedOriginalTransaction,
    MismatchedUndoJournal,
    MismatchedTransactionCreatedAt,
    MissingCommit,
    MismatchedCommit,
    MismatchedCommitRequest,
    MismatchedCommitPlanDigest,
    MismatchedCommitStatus,
    MissingJournal,
    MismatchedJournal,
    MismatchedJournalCommit,
    MismatchedPayload,
    MismatchedPayloadRequest,
    MismatchedPayloadPlanDigest,
    MalformedPayload,
    MismatchedCanonical,
    MismatchedCanonicalDomain,
    MismatchedCanonicalEntityType,
    MismatchedCanonicalEntityId,
    MismatchedSession,
    MismatchedApplySession,
    MissingReceipt,
    MismatchedReceipt,
    MismatchedReceiptRequest,
    MismatchedReceiptPlanDigest,
    MismatchedReceiptJournal,
    MismatchedReceiptStatus,
    MismatchedReceiptChangeEvent,
    MismatchedReceiptMaintenanceTransaction,
    MismatchedReceiptMaintenanceOriginal,
    MismatchedReceiptMaintenanceEvents,
    MalformedReceipt,
    MissingUndo,
    MismatchedUndoIdentity,
    MismatchedUndoOrder,
    MalformedUndoPayload,
    MismatchedUndoPayloadCommit,
    MismatchedUndoPayloadRequest,
    MissingApplication,
    DuplicateApplication,
    ExtraApplication,
    MismatchedApplication,
    MismatchedApplicationCommit,
    MismatchedApplicationKind,
    MismatchedApplicationEntity,
    MissingEntity,
    NullEntity,
    MismatchedEntity,
    MismatchedEntityBody,
    MismatchedEntityVersion,
    MismatchedEntityOperation,
    MalformedEntity,
    UnknownEntity,
    DuplicateEntity,
    MismatchedBody,
    MismatchedVersion,
    MissingSnapshot,
    DuplicateSnapshot,
    MismatchedSnapshotType,
    MismatchedSnapshotSequence,
    MismatchedSnapshotTimestamp,
    MismatchedSnapshotPayload,
    MismatchedSnapshotEncoding,
    MismatchedNewTransaction,
    MismatchedNewCanonical,
    MismatchedNewSequence,
    MismatchedNewObject,
    MismatchedNewChangeKind,
    MismatchedNewMutation,
    MismatchedNewBeforeVersion,
    MismatchedNewBeforeDigest,
    MismatchedNewAfterVersion,
    MismatchedNewChangedPaths,
    MismatchedNewOccurredAt,
}

fn insert_protected_codex_candidate(
    conn: &rusqlite::Connection,
    failure: ProtectedCodexFailure,
) -> anyhow::Result<()> {
    let transaction_id = "protected-codex-candidate-transaction";
    let (source_uid, source_sequence) = match failure {
        ProtectedCodexFailure::MismatchedTransaction => (PROTECTED_CODEX_TAIL_EVENT_UID, 2_i64),
        ProtectedCodexFailure::MismatchedSourceSequence => (PROTECTED_CODEX_APPLY_EVENT_UID, 2_i64),
        _ => (PROTECTED_CODEX_APPLY_EVENT_UID, 1_i64),
    };
    let source_domain = match failure {
        ProtectedCodexFailure::UnrelatedProvenance => "test.unrelated",
        _ => "narrative.commit.apply",
    };
    let request_id = match failure {
        ProtectedCodexFailure::MismatchedRequest => "wrong-request",
        _ => PROTECTED_CODEX_REQUEST_ID,
    };
    let cause_kind = match failure {
        ProtectedCodexFailure::MismatchedCause => "redo",
        _ => "forward",
    };
    let origin = match failure {
        ProtectedCodexFailure::MismatchedOrigin => "redo",
        _ => "ai-apply",
    };
    let original_transaction_id = match failure {
        ProtectedCodexFailure::MismatchedOriginalTransaction => {
            Some("protected-codex-placeholder-transaction")
        }
        _ => None,
    };
    let undo_journal_id = match failure {
        ProtectedCodexFailure::MismatchedUndoJournal => Some("wrong-undo-journal"),
        _ => None,
    };
    let (commit_id, journal_id) = match failure {
        ProtectedCodexFailure::MissingCommit => (None, Some(PROTECTED_CODEX_JOURNAL_ID)),
        ProtectedCodexFailure::MismatchedCommit => {
            (Some("wrong-commit"), Some(PROTECTED_CODEX_JOURNAL_ID))
        }
        ProtectedCodexFailure::MissingJournal => (Some(PROTECTED_CODEX_COMMIT_ID), None),
        ProtectedCodexFailure::MismatchedJournal => {
            (Some(PROTECTED_CODEX_COMMIT_ID), Some("wrong-journal"))
        }
        _ => (
            Some(PROTECTED_CODEX_COMMIT_ID),
            Some(PROTECTED_CODEX_JOURNAL_ID),
        ),
    };
    let application_ids_json = match failure {
        ProtectedCodexFailure::MismatchedApplication => r#"["wrong-application"]"#,
        ProtectedCodexFailure::DuplicateApplication => {
            r#"["protected-codex-application","protected-codex-application"]"#
        }
        _ => r#"["protected-codex-application"]"#,
    };
    let created_at = match failure {
        ProtectedCodexFailure::MismatchedTransactionCreatedAt => "2026-08-31T00:00:00.999Z",
        _ => "2026-08-31T00:00:00.801Z",
    };
    if matches!(
        failure,
        ProtectedCodexFailure::MismatchedOriginalTransaction
    ) {
        conn.execute(
            "INSERT INTO narrative_change_transactions
                (id, project_id, request_id, source_domain,
                 source_change_event_uid, source_change_event_sequence,
                 cause_kind, origin, application_ids_json, payload_digest, created_at)
             VALUES (?1, ?2, 'protected-codex-placeholder-request', 'test.placeholder',
                     ?3, 3, 'forward', 'human', '[]',
                     'sha256:protected-codex-placeholder', '2026-08-31T00:00:00.803Z')",
            params![
                "protected-codex-placeholder-transaction",
                PROJECT_ID,
                PROTECTED_CODEX_TAIL_EVENT_UID
            ],
        )?;
    }
    conn.execute(
        "INSERT INTO narrative_change_transactions
            (id, project_id, request_id, source_domain,
             source_change_event_uid, source_change_event_sequence,
             cause_kind, origin, original_transaction_id, commit_id, journal_id,
             undo_journal_id, application_ids_json, payload_digest, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 'sha256:protected-codex-candidate', ?14)",
        params![
            transaction_id,
            PROJECT_ID,
            request_id,
            source_domain,
            source_uid,
            source_sequence,
            cause_kind,
            origin,
            original_transaction_id,
            commit_id,
            journal_id,
            undo_journal_id,
            application_ids_json,
            created_at,
        ],
    )?;

    match failure {
        ProtectedCodexFailure::MismatchedPayload
        | ProtectedCodexFailure::MismatchedPayloadRequest
        | ProtectedCodexFailure::MismatchedPayloadPlanDigest
        | ProtectedCodexFailure::MalformedPayload => {
            let payload = match failure {
                ProtectedCodexFailure::MalformedPayload => "{malformed".to_string(),
                ProtectedCodexFailure::MismatchedPayload => json!({
                    "commitId": "wrong-commit",
                    "requestId": PROTECTED_CODEX_REQUEST_ID,
                    "planDigest": PROTECTED_CODEX_PLAN_DIGEST
                })
                .to_string(),
                ProtectedCodexFailure::MismatchedPayloadRequest => json!({
                    "commitId": PROTECTED_CODEX_COMMIT_ID,
                    "requestId": "wrong-request",
                    "planDigest": PROTECTED_CODEX_PLAN_DIGEST
                })
                .to_string(),
                ProtectedCodexFailure::MismatchedPayloadPlanDigest => json!({
                    "commitId": PROTECTED_CODEX_COMMIT_ID,
                    "requestId": PROTECTED_CODEX_REQUEST_ID,
                    "planDigest": "wrong-plan-digest"
                })
                .to_string(),
                _ => unreachable!("payload mutation arm is exhaustive"),
            };
            conn.execute(
                "UPDATE change_events SET payload = ?1
                   WHERE project_id = ?2 AND event_uid = ?3",
                params![payload, PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
            )?
        }
        ProtectedCodexFailure::MismatchedCanonical => conn.execute(
            "UPDATE change_events SET op_type = 'narrative.commit.other'
               WHERE project_id = ?1 AND event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
        )?,
        ProtectedCodexFailure::MismatchedCanonicalDomain => conn.execute(
            "UPDATE change_events SET domain = 'wrong-domain'
               WHERE project_id = ?1 AND event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
        )?,
        ProtectedCodexFailure::MismatchedCanonicalEntityType => conn.execute(
            "UPDATE change_events SET entity_type = 'wrong-entity'
               WHERE project_id = ?1 AND event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
        )?,
        ProtectedCodexFailure::MismatchedCanonicalEntityId => conn.execute(
            "UPDATE change_events SET entity_id = 'wrong-commit'
               WHERE project_id = ?1 AND event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
        )?,
        ProtectedCodexFailure::MismatchedSession => conn.execute(
            "UPDATE narrative_apply_commits SET session_id = 'wrong-session'
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_COMMIT_ID],
        )?,
        ProtectedCodexFailure::MismatchedApplySession => conn.execute(
            "UPDATE change_events SET session_id = 'wrong-session'
               WHERE project_id = ?1 AND event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
        )?,
        ProtectedCodexFailure::MismatchedCommitRequest => conn.execute(
            "UPDATE narrative_apply_commits SET request_id = 'wrong-request'
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_COMMIT_ID],
        )?,
        ProtectedCodexFailure::MismatchedCommitPlanDigest => conn.execute(
            "UPDATE narrative_apply_commits SET plan_digest = 'wrong-plan-digest'
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_COMMIT_ID],
        )?,
        ProtectedCodexFailure::MismatchedCommitStatus => conn.execute(
            "UPDATE narrative_apply_commits SET status = 'applied'
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_COMMIT_ID],
        )?,
        ProtectedCodexFailure::MismatchedJournalCommit => conn.execute(
            "UPDATE narrative_commit_journals SET commit_id = 'wrong-commit'
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_JOURNAL_ID],
        )?,
        ProtectedCodexFailure::MissingReceipt => conn.execute(
            "UPDATE narrative_apply_commits SET receipt_json = NULL
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_COMMIT_ID],
        )?,
        ProtectedCodexFailure::MismatchedReceipt
        | ProtectedCodexFailure::MismatchedReceiptRequest
        | ProtectedCodexFailure::MismatchedReceiptPlanDigest
        | ProtectedCodexFailure::MismatchedReceiptJournal
        | ProtectedCodexFailure::MismatchedReceiptStatus
        | ProtectedCodexFailure::MismatchedReceiptChangeEvent
        | ProtectedCodexFailure::MismatchedReceiptMaintenanceTransaction
        | ProtectedCodexFailure::MismatchedReceiptMaintenanceOriginal
        | ProtectedCodexFailure::MismatchedReceiptMaintenanceEvents
        | ProtectedCodexFailure::MalformedReceipt => {
            let receipt_json = match failure {
                ProtectedCodexFailure::MalformedReceipt => "{malformed".to_string(),
                _ => {
                    let mut receipt = protected_codex_receipt();
                    let object = receipt
                        .as_object_mut()
                        .expect("protected receipt fixture is an object");
                    match failure {
                        ProtectedCodexFailure::MismatchedReceipt => {
                            object.insert(
                                "commitId".to_string(),
                                Value::String("wrong-commit".to_string()),
                            );
                        }
                        ProtectedCodexFailure::MismatchedReceiptRequest => {
                            object.insert(
                                "requestId".to_string(),
                                Value::String("wrong-request".to_string()),
                            );
                        }
                        ProtectedCodexFailure::MismatchedReceiptPlanDigest => {
                            object.insert(
                                "planDigest".to_string(),
                                Value::String("wrong-plan-digest".to_string()),
                            );
                        }
                        ProtectedCodexFailure::MismatchedReceiptJournal => {
                            object.insert(
                                "journalId".to_string(),
                                Value::String("wrong-journal".to_string()),
                            );
                        }
                        ProtectedCodexFailure::MismatchedReceiptStatus => {
                            object
                                .insert("status".to_string(), Value::String("applied".to_string()));
                        }
                        ProtectedCodexFailure::MismatchedReceiptChangeEvent => {
                            object.insert(
                                "changeEventUid".to_string(),
                                Value::String(PROTECTED_CODEX_APPLY_EVENT_UID.to_string()),
                            );
                        }
                        ProtectedCodexFailure::MismatchedReceiptMaintenanceTransaction => {
                            object.insert(
                                "maintenanceTransactionId".to_string(),
                                Value::String("maintenance-id".to_string()),
                            );
                        }
                        ProtectedCodexFailure::MismatchedReceiptMaintenanceOriginal => {
                            object.insert(
                                "maintenanceOriginalTransactionId".to_string(),
                                Value::String("maintenance-original-id".to_string()),
                            );
                        }
                        ProtectedCodexFailure::MismatchedReceiptMaintenanceEvents => {
                            object.insert(
                                "maintenanceEventIds".to_string(),
                                json!(["maintenance-event"]),
                            );
                        }
                        _ => unreachable!("receipt mutation arm is exhaustive"),
                    }
                    receipt.to_string()
                }
            };
            conn.execute(
                "UPDATE narrative_apply_commits SET receipt_json = ?1
                WHERE project_id = ?2 AND id = ?3",
                params![receipt_json, PROJECT_ID, PROTECTED_CODEX_COMMIT_ID],
            )?
        }
        ProtectedCodexFailure::MissingUndo => conn.execute(
            "DELETE FROM change_events
               WHERE project_id = ?1 AND event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_UNDO_EVENT_UID],
        )?,
        ProtectedCodexFailure::MismatchedUndoIdentity => conn.execute(
            "UPDATE change_events SET entity_id = 'wrong-commit'
               WHERE project_id = ?1 AND event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_UNDO_EVENT_UID],
        )?,
        ProtectedCodexFailure::MismatchedUndoOrder => conn.execute(
            "UPDATE change_events SET sequence = 0
               WHERE project_id = ?1 AND event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_UNDO_EVENT_UID],
        )?,
        ProtectedCodexFailure::MalformedUndoPayload
        | ProtectedCodexFailure::MismatchedUndoPayloadCommit
        | ProtectedCodexFailure::MismatchedUndoPayloadRequest => conn.execute(
            "UPDATE change_events SET payload = ?1
               WHERE project_id = ?2 AND event_uid = ?3",
            params![
                match failure {
                    ProtectedCodexFailure::MalformedUndoPayload => "{malformed".to_string(),
                    ProtectedCodexFailure::MismatchedUndoPayloadCommit => json!({
                        "commitId": "wrong-commit",
                        "requestId": "protected-codex-undo-request",
                        "applyRequestId": PROTECTED_CODEX_REQUEST_ID
                    })
                    .to_string(),
                    ProtectedCodexFailure::MismatchedUndoPayloadRequest => json!({
                        "commitId": PROTECTED_CODEX_COMMIT_ID,
                        "requestId": "protected-codex-undo-request",
                        "applyRequestId": "wrong-request"
                    })
                    .to_string(),
                    _ => unreachable!("undo payload mutation arm is exhaustive"),
                },
                PROJECT_ID,
                PROTECTED_CODEX_UNDO_EVENT_UID
            ],
        )?,
        ProtectedCodexFailure::MissingApplication => conn.execute(
            "DELETE FROM narrative_proposal_applications
               WHERE id = ?1 AND commit_id = ?2",
            params![PROTECTED_CODEX_APPLICATION_ID, PROTECTED_CODEX_COMMIT_ID],
        )?,
        ProtectedCodexFailure::ExtraApplication => conn.execute(
            "INSERT INTO narrative_proposal_applications
                (id, commit_id, proposal_id, revision_id,
                 applied_entity_kind, applied_entity_id, created_at)
             VALUES ('protected-codex-extra-application', ?1,
                     'protected-extra-proposal', 'protected-extra-revision',
                     'codex_entry', ?2, '2026-08-31T00:00:00.800Z')",
            params![PROTECTED_CODEX_COMMIT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        ProtectedCodexFailure::MismatchedApplicationCommit => conn.execute(
            "UPDATE narrative_proposal_applications SET commit_id = 'wrong-commit'
               WHERE id = ?1",
            [PROTECTED_CODEX_APPLICATION_ID],
        )?,
        ProtectedCodexFailure::MismatchedApplicationKind => conn.execute(
            "UPDATE narrative_proposal_applications SET applied_entity_kind = 'scene'
               WHERE id = ?1",
            [PROTECTED_CODEX_APPLICATION_ID],
        )?,
        ProtectedCodexFailure::MismatchedApplicationEntity => conn.execute(
            "UPDATE narrative_proposal_applications SET applied_entity_id = 'other-entry'
               WHERE id = ?1",
            [PROTECTED_CODEX_APPLICATION_ID],
        )?,
        ProtectedCodexFailure::MismatchedBody => conn.execute(
            "UPDATE codex_entries SET content = 'tampered-body'
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        ProtectedCodexFailure::MismatchedVersion => conn.execute(
            "UPDATE codex_entries SET version = 2
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        ProtectedCodexFailure::MismatchedSnapshotType => conn.execute(
            "UPDATE state_snapshots SET entity_type = 'scene'
               WHERE project_id = ?1 AND domain = 'codex' AND entity_id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        ProtectedCodexFailure::MismatchedSnapshotSequence => conn.execute(
            "UPDATE state_snapshots SET anchor_sequence = 2
               WHERE project_id = ?1 AND domain = 'codex' AND entity_id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        ProtectedCodexFailure::MismatchedSnapshotTimestamp => conn.execute(
            "UPDATE state_snapshots SET anchor_timestamp = 999
               WHERE project_id = ?1 AND domain = 'codex' AND entity_id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        ProtectedCodexFailure::MismatchedSnapshotPayload => conn.execute(
            "UPDATE state_snapshots SET payload = 'tampered-body'
               WHERE project_id = ?1 AND domain = 'codex' AND entity_id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        ProtectedCodexFailure::MismatchedSnapshotEncoding => conn.execute(
            "UPDATE state_snapshots SET encoding = 'binary'
               WHERE project_id = ?1 AND domain = 'codex' AND entity_id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        ProtectedCodexFailure::MissingSnapshot => conn.execute(
            "DELETE FROM state_snapshots
               WHERE project_id = ?1 AND domain = 'codex' AND entity_id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        ProtectedCodexFailure::DuplicateSnapshot => conn.execute(
            "INSERT INTO state_snapshots
                (project_id, domain, entity_type, entity_id,
                 anchor_sequence, anchor_timestamp, payload, encoding, created_at)
             SELECT project_id, domain, entity_type, entity_id,
                    anchor_sequence, anchor_timestamp, payload, encoding, created_at
               FROM state_snapshots
              WHERE project_id = ?1 AND domain = 'codex' AND entity_id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
        )?,
        _ => 0,
    };

    match failure {
        ProtectedCodexFailure::MalformedPayload => {
            let json_valid: i64 = conn.query_row(
                "SELECT json_valid(payload) FROM change_events
                  WHERE project_id = ?1 AND event_uid = ?2",
                params![PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
                |row| row.get(0),
            )?;
            assert_eq!(json_valid, 0, "apply event payload must be invalid JSON");
        }
        ProtectedCodexFailure::MalformedUndoPayload => {
            let json_valid: i64 = conn.query_row(
                "SELECT json_valid(payload) FROM change_events
                  WHERE project_id = ?1 AND event_uid = ?2",
                params![PROJECT_ID, PROTECTED_CODEX_UNDO_EVENT_UID],
                |row| row.get(0),
            )?;
            assert_eq!(json_valid, 0, "undo event payload must be invalid JSON");
        }
        ProtectedCodexFailure::MalformedReceipt => {
            let json_valid: i64 = conn.query_row(
                "SELECT json_valid(receipt_json) FROM narrative_apply_commits
                  WHERE project_id = ?1 AND id = ?2",
                params![PROJECT_ID, PROTECTED_CODEX_COMMIT_ID],
                |row| row.get(0),
            )?;
            assert_eq!(json_valid, 0, "apply receipt must be invalid JSON");
        }
        _ => {}
    }

    if !matches!(failure, ProtectedCodexFailure::MissingTransaction) {
        let entities = match failure {
            ProtectedCodexFailure::MissingEntity => json!([]),
            ProtectedCodexFailure::NullEntity => json!(null),
            ProtectedCodexFailure::MismatchedEntity => json!([{
                "entityKind": "codex_entry",
                "entityId": "other-entry",
                "version": 1,
                "opKind": "create",
                "snapshot": {
                    "id": "other-entry",
                    "projectId": PROJECT_ID,
                    "content": CODEX_DOC,
                    "version": 1
                }
            }]),
            ProtectedCodexFailure::MismatchedEntityBody => {
                let mut entity = protected_codex_journal_entities()[0].clone();
                entity["snapshot"]["content"] = Value::String("tampered-body".to_string());
                json!([entity])
            }
            ProtectedCodexFailure::MismatchedEntityVersion => {
                let mut entity = protected_codex_journal_entities()[0].clone();
                entity["version"] = Value::from(2);
                entity["snapshot"]["version"] = Value::from(2);
                json!([entity])
            }
            ProtectedCodexFailure::MismatchedEntityOperation => {
                let mut entity = protected_codex_journal_entities()[0].clone();
                entity["opKind"] = Value::String("update".to_string());
                json!([entity])
            }
            ProtectedCodexFailure::MalformedEntity => Value::String("{malformed".to_string()),
            ProtectedCodexFailure::UnknownEntity => json!([
                protected_codex_journal_entities()[0].clone(),
                {
                    "entityKind": "unknown_entity",
                    "entityId": "unknown-id",
                    "version": 1,
                    "opKind": "create",
                    "snapshot": {}
                }
            ]),
            ProtectedCodexFailure::DuplicateEntity => json!([
                protected_codex_journal_entities()[0].clone(),
                protected_codex_journal_entities()[0].clone()
            ]),
            _ => protected_codex_journal_entities(),
        };
        let after_json = if matches!(failure, ProtectedCodexFailure::MalformedEntity) {
            "{malformed".to_string()
        } else {
            match entities {
                Value::String(_) => entities.to_string(),
                value => json!({ "entities": value, "entityBindings": [] }).to_string(),
            }
        };
        conn.execute(
            "UPDATE narrative_commit_journals SET after_json = ?1
               WHERE project_id = ?2 AND id = ?3",
            params![after_json, PROJECT_ID, PROTECTED_CODEX_JOURNAL_ID],
        )?;
    }
    if matches!(failure, ProtectedCodexFailure::MissingTransaction) {
        // Leave the candidate transaction absent so the narrative event's
        // project-scoped foreign key rejects it before the baseline trigger.
        conn.execute(
            "DELETE FROM narrative_change_transactions
              WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, transaction_id],
        )?;
    }
    let event_id = "protected-codex-candidate-event";
    let event_transaction_id = match failure {
        ProtectedCodexFailure::MismatchedNewTransaction => "missing-transaction",
        _ => transaction_id,
    };
    let canonical_uid = match failure {
        ProtectedCodexFailure::MismatchedNewCanonical => PROTECTED_CODEX_TAIL_EVENT_UID,
        _ => PROTECTED_CODEX_APPLY_EVENT_UID,
    };
    let canonical_sequence = match failure {
        ProtectedCodexFailure::MismatchedNewCanonical => 2_i64,
        ProtectedCodexFailure::MismatchedNewSequence => 2_i64,
        _ => 1_i64,
    };
    let object_key = match failure {
        ProtectedCodexFailure::MismatchedNewObject => {
            json!({ "kind": "codex-entry", "entryId": "other-entry" })
        }
        _ => BodyKind::Codex.object_key(PROTECTED_CODEX_ENTRY_ID),
    };
    let change_kind = match failure {
        ProtectedCodexFailure::MismatchedNewChangeKind => "content",
        _ => "metadata",
    };
    let mutation_kind = match failure {
        ProtectedCodexFailure::MismatchedNewMutation => "restore",
        _ => "create",
    };
    let before_version = match failure {
        ProtectedCodexFailure::MismatchedNewBeforeVersion => Some(0_i64),
        _ => None,
    };
    let before_digest = match failure {
        ProtectedCodexFailure::MismatchedNewBeforeDigest => Some("sha256:wrong-before"),
        _ => None,
    };
    let after_version = match failure {
        ProtectedCodexFailure::MismatchedNewAfterVersion => 2_i64,
        _ => 1_i64,
    };
    let changed_paths_json = match failure {
        ProtectedCodexFailure::MismatchedNewChangedPaths => r#"["/content"]"#,
        _ => r#"["/"]"#,
    };
    let occurred_at = match failure {
        ProtectedCodexFailure::MismatchedNewOccurredAt => "2026-08-31T00:00:00.999Z",
        _ => "2026-08-31T00:00:00.801Z",
    };
    conn.execute(
        "INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid,
             canonical_sequence, event_ordinal, object_key_json, change_kind,
             mutation_kind, before_version, before_digest, after_version,
             after_digest, changed_paths_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10, ?11,
                 'sha256:protected-codex-after', ?12, ?13)",
        params![
            event_id,
            PROJECT_ID,
            event_transaction_id,
            canonical_uid,
            canonical_sequence,
            object_key.to_string(),
            change_kind,
            mutation_kind,
            before_version,
            before_digest,
            after_version,
            changed_paths_json,
            occurred_at,
        ],
    )?;
    Ok(())
}

#[test]
fn historical_codex_root_reuses_exact_snapshot_only_with_protected_provenance() {
    let db = setup_protected_codex_historical_fixture().expect("seed protected Codex fixture");
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        append_protected_codex_root(&transaction, PROTECTED_CODEX_REQUEST_ID)?;
        transaction.commit()?;
        Ok(())
    })
    .expect("protected pre-Feed Codex root is reusable after a newer tail");

    db.with_conn(|conn| {
        let lifecycle: (
            i64,
            String,
            String,
            Option<i64>,
            Option<String>,
            i64,
            String,
        ) = conn.query_row(
            "SELECT canonical_sequence, mutation_kind, change_kind,
                        before_version, before_digest, after_version, occurred_at
                   FROM narrative_change_events
                  WHERE project_id = ?1 AND canonical_change_event_uid = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )?;
        assert_eq!(lifecycle.0, 1);
        assert_eq!(lifecycle.1, "create");
        assert_eq!(lifecycle.2, "metadata");
        assert_eq!(lifecycle.3, None);
        assert_eq!(lifecycle.4, None);
        assert_eq!(lifecycle.5, 1);
        assert_eq!(lifecycle.6, "2026-08-31T00:00:00.800Z");

        let (snapshot_count, snapshot): (i64, (i64, i64, String, String)) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(MAX(anchor_sequence), 0),
                    COALESCE(MAX(anchor_timestamp), 0),
                    COALESCE(MAX(payload), ''),
                    COALESCE(MAX(encoding), '')
               FROM state_snapshots
              WHERE project_id = ?1 AND domain = 'codex' AND entity_id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
            |row| {
                Ok((
                    row.get(0)?,
                    (row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?),
                ))
            },
        )?;
        assert_eq!(snapshot_count, 1);
        assert_eq!(
            snapshot,
            (1, 800, CODEX_DOC.to_string(), "json".to_string())
        );
        let application_ids: String = conn.query_row(
            "SELECT application_ids_json
               FROM narrative_change_transactions
              WHERE project_id = ?1 AND id = (
                    SELECT transaction_id FROM narrative_change_events
                     WHERE project_id = ?1
                       AND canonical_change_event_uid = ?2
              )",
            params![PROJECT_ID, PROTECTED_CODEX_APPLY_EVENT_UID],
            |row| row.get(0),
        )?;
        assert_eq!(application_ids, r#"["protected-codex-application"]"#);
        Ok(())
    })
    .expect("inspect protected Codex baseline");
}

#[test]
fn historical_codex_root_accepts_legacy_null_commit_session() {
    let db = setup_protected_codex_historical_fixture().expect("seed protected Codex fixture");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_apply_commits SET session_id = NULL
               WHERE project_id = ?1 AND id = ?2",
            params![PROJECT_ID, PROTECTED_CODEX_COMMIT_ID],
        )?;
        let transaction = conn.unchecked_transaction()?;
        append_protected_codex_root(&transaction, PROTECTED_CODEX_REQUEST_ID)?;
        transaction.commit()?;
        Ok(())
    })
    .expect("legacy null commit session remains valid provenance");
}

#[test]
fn historical_codex_root_rejects_unrelated_exact_snapshot_provenance() {
    let db = setup_protected_codex_historical_fixture().expect("seed protected Codex fixture");
    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        let error = insert_protected_codex_candidate(
            &transaction,
            ProtectedCodexFailure::UnrelatedProvenance,
        )
        .expect_err("unrelated Feed provenance must fail closed");
        assert!(error
            .to_string()
            .contains("TIMELAPSE_CREATION_BASELINE_INVALID_ANCHOR"));
        transaction.rollback()?;
        Ok(())
    })
    .expect("rollback unrelated provenance candidate");
}

#[test]
fn historical_codex_root_rejects_missing_or_tampered_provenance() {
    let failures = [
        ProtectedCodexFailure::MissingTransaction,
        ProtectedCodexFailure::MismatchedTransaction,
        ProtectedCodexFailure::MismatchedRequest,
        ProtectedCodexFailure::MismatchedSourceSequence,
        ProtectedCodexFailure::MismatchedCause,
        ProtectedCodexFailure::MismatchedOrigin,
        ProtectedCodexFailure::MismatchedOriginalTransaction,
        ProtectedCodexFailure::MismatchedUndoJournal,
        ProtectedCodexFailure::MismatchedTransactionCreatedAt,
        ProtectedCodexFailure::MissingCommit,
        ProtectedCodexFailure::MismatchedCommit,
        ProtectedCodexFailure::MismatchedCommitRequest,
        ProtectedCodexFailure::MismatchedCommitPlanDigest,
        ProtectedCodexFailure::MismatchedCommitStatus,
        ProtectedCodexFailure::MissingJournal,
        ProtectedCodexFailure::MismatchedJournal,
        ProtectedCodexFailure::MismatchedJournalCommit,
        ProtectedCodexFailure::MismatchedPayload,
        ProtectedCodexFailure::MismatchedPayloadRequest,
        ProtectedCodexFailure::MismatchedPayloadPlanDigest,
        ProtectedCodexFailure::MalformedPayload,
        ProtectedCodexFailure::MismatchedCanonical,
        ProtectedCodexFailure::MismatchedCanonicalDomain,
        ProtectedCodexFailure::MismatchedCanonicalEntityType,
        ProtectedCodexFailure::MismatchedCanonicalEntityId,
        ProtectedCodexFailure::MismatchedSession,
        ProtectedCodexFailure::MismatchedApplySession,
        ProtectedCodexFailure::MissingReceipt,
        ProtectedCodexFailure::MismatchedReceipt,
        ProtectedCodexFailure::MismatchedReceiptRequest,
        ProtectedCodexFailure::MismatchedReceiptPlanDigest,
        ProtectedCodexFailure::MismatchedReceiptJournal,
        ProtectedCodexFailure::MismatchedReceiptStatus,
        ProtectedCodexFailure::MismatchedReceiptChangeEvent,
        ProtectedCodexFailure::MismatchedReceiptMaintenanceTransaction,
        ProtectedCodexFailure::MismatchedReceiptMaintenanceOriginal,
        ProtectedCodexFailure::MismatchedReceiptMaintenanceEvents,
        ProtectedCodexFailure::MalformedReceipt,
        ProtectedCodexFailure::MissingUndo,
        ProtectedCodexFailure::MismatchedUndoIdentity,
        ProtectedCodexFailure::MismatchedUndoOrder,
        ProtectedCodexFailure::MalformedUndoPayload,
        ProtectedCodexFailure::MismatchedUndoPayloadCommit,
        ProtectedCodexFailure::MismatchedUndoPayloadRequest,
        ProtectedCodexFailure::MissingApplication,
        ProtectedCodexFailure::DuplicateApplication,
        ProtectedCodexFailure::ExtraApplication,
        ProtectedCodexFailure::MismatchedApplication,
        ProtectedCodexFailure::MismatchedApplicationCommit,
        ProtectedCodexFailure::MismatchedApplicationKind,
        ProtectedCodexFailure::MismatchedApplicationEntity,
        ProtectedCodexFailure::MissingEntity,
        ProtectedCodexFailure::NullEntity,
        ProtectedCodexFailure::MismatchedEntity,
        ProtectedCodexFailure::MismatchedEntityBody,
        ProtectedCodexFailure::MismatchedEntityVersion,
        ProtectedCodexFailure::MismatchedEntityOperation,
        ProtectedCodexFailure::MalformedEntity,
        ProtectedCodexFailure::UnknownEntity,
        ProtectedCodexFailure::DuplicateEntity,
        ProtectedCodexFailure::MismatchedBody,
        ProtectedCodexFailure::MismatchedVersion,
        ProtectedCodexFailure::MissingSnapshot,
        ProtectedCodexFailure::DuplicateSnapshot,
        ProtectedCodexFailure::MismatchedSnapshotType,
        ProtectedCodexFailure::MismatchedSnapshotSequence,
        ProtectedCodexFailure::MismatchedSnapshotTimestamp,
        ProtectedCodexFailure::MismatchedSnapshotPayload,
        ProtectedCodexFailure::MismatchedSnapshotEncoding,
        ProtectedCodexFailure::MismatchedNewTransaction,
        ProtectedCodexFailure::MismatchedNewCanonical,
        ProtectedCodexFailure::MismatchedNewSequence,
        ProtectedCodexFailure::MismatchedNewObject,
        ProtectedCodexFailure::MismatchedNewChangeKind,
        ProtectedCodexFailure::MismatchedNewMutation,
        ProtectedCodexFailure::MismatchedNewBeforeVersion,
        ProtectedCodexFailure::MismatchedNewBeforeDigest,
        ProtectedCodexFailure::MismatchedNewAfterVersion,
        ProtectedCodexFailure::MismatchedNewChangedPaths,
        ProtectedCodexFailure::MismatchedNewOccurredAt,
    ];
    for failure in failures {
        let db = setup_protected_codex_historical_fixture().expect("seed protected Codex fixture");
        db.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            let error = insert_protected_codex_candidate(&transaction, failure)
                .expect_err("tampered protected provenance must fail closed");
            assert!(
                error
                    .to_string()
                    .contains("TIMELAPSE_CREATION_BASELINE_INVALID_ANCHOR")
                    || error.to_string().contains("FOREIGN KEY constraint failed")
                    || error.to_string().contains("NEX_IMMUTABLE_APPLICATION"),
                "{failure:?}: {error}"
            );
            transaction.rollback()?;
            Ok(())
        })
        .expect("rollback tampered provenance candidate");

        db.with_conn(|conn| {
            let feed_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_events WHERE project_id = ?1",
                [PROJECT_ID],
                |row| row.get(0),
            )?;
            let snapshot_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM state_snapshots
                  WHERE project_id = ?1 AND domain = 'codex' AND entity_id = ?2",
                params![PROJECT_ID, PROTECTED_CODEX_ENTRY_ID],
                |row| row.get(0),
            )?;
            assert_eq!(feed_count, 0, "{failure:?}: Feed candidate must roll back");
            assert_eq!(
                snapshot_count, 1,
                "{failure:?}: snapshot must remain singular"
            );
            Ok(())
        })
        .expect("inspect tampered provenance rollback");
    }
}

#[test]
fn scene_and_snippet_exact_snapshots_do_not_permit_non_tail_roots() {
    for (index, (kind, content)) in [
        (BodyKind::Scene, SCENE_DOC),
        (BodyKind::Snippet, SNIPPET_DOC),
    ]
    .into_iter()
    .enumerate()
    {
        let db = database();
        let entity_id = format!("non-tail-snapshot-{index}");
        let event_uid = format!("non-tail-snapshot-event-{index}");
        let tail_event_uid = format!("non-tail-snapshot-tail-{index}");
        let timestamp = 160 + i64::try_from(index).expect("small fixture index");
        create_body_with_lifecycle(&db, kind, &entity_id, content, &event_uid, timestamp)
            .expect("create exact snapshot fixture");
        db.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            transaction.execute(
                "DELETE FROM narrative_change_transactions
                  WHERE project_id = ?1 AND source_change_event_uid = ?2",
                params![PROJECT_ID, event_uid],
            )?;
            let append = append_change_events_in_tx(
                &transaction,
                PROJECT_ID,
                SESSION_ID,
                &[AppendChangeEvent {
                    event_uid: tail_event_uid,
                    scene_id: None,
                    domain: "test".to_string(),
                    op_type: "test.tail".to_string(),
                    entity_type: None,
                    entity_id: None,
                    payload: "{}".to_string(),
                    timestamp: timestamp + 1,
                }],
            )?;
            assert_eq!(append.tail_sequence, 2);
            let error = append_pre_feed_narrative_root(&transaction, kind, &entity_id, &event_uid)
                .expect_err("Scene/Snippet non-tail root must fail even with exact snapshot");
            assert!(error
                .to_string()
                .contains("TIMELAPSE_CREATION_BASELINE_INVALID_ANCHOR"));
            transaction.rollback()?;
            Ok(())
        })
        .expect("rollback Scene/Snippet non-tail root");
    }
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
    let db = seed_database(test_support::fresh_migrated_memory().expect("real migration fixture"));
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
