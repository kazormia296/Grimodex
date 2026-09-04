//! Atomic scene revision restore for the canonical Electron writer path.
//!
//! The renderer identifies an existing `content_versions` row and supplies an
//! OCC base version plus derived caches. Native revalidates every project and
//! revision binding, saves the current persisted body as a manual safety
//! revision, rewrites the scene, and appends both ledgers and the retry receipt
//! in one `BEGIN IMMEDIATE` transaction.

use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    change_events::AppendChangeEvent,
    idempotency::{
        insert_idempotent_response, load_idempotent_response, payload_fingerprint,
        IdempotencyRequest,
    },
    narrative_extraction::change_feed::{
        append_canonical_and_narrative_change_in_tx, narrative_object_key,
        narrative_snapshot_digest, AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind,
        NarrativeChangeEventInput, NarrativeChangeOrigin,
    },
    Database,
};

const IDEMPOTENCY_DOMAIN: &str = "revision_scene_restore";
const SOURCE_DOMAIN: &str = "content.restore";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreSceneRevisionPayload {
    pub request_id: String,
    pub session_id: String,
    pub project_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub revision_id: String,
    pub content: String,
    pub current_content: String,
    pub expected_version: i64,
    pub char_count: i64,
    pub placed_beat_preview: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSceneRevisionResult {
    pub scene_id: String,
    pub revision_id: String,
    pub safety_revision_id: String,
    pub version: i64,
    pub updated_at: String,
    pub change_event_uid: String,
    pub canonical_sequence: i64,
    pub maintenance_transaction_id: String,
    pub replayed: bool,
}

#[derive(Debug)]
struct SceneSnapshot {
    content: String,
    version: i64,
    updated_at: String,
}

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "{field} is required");
    Ok(())
}

fn validate_content(value: &str, field: &str) -> anyhow::Result<Value> {
    let parsed: Value = serde_json::from_str(value)
        .map_err(|error| anyhow::anyhow!("{field} must be valid ProseMirror JSON: {error}"))?;
    anyhow::ensure!(parsed.is_object(), "{field} must be a JSON object");
    Ok(parsed)
}

fn json_content_matches(left: &str, right: &str) -> bool {
    match (
        serde_json::from_str::<Value>(left),
        serde_json::from_str::<Value>(right),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn validate_payload(payload: &RestoreSceneRevisionPayload) -> anyhow::Result<()> {
    for (value, field) in [
        (&payload.request_id, "requestId"),
        (&payload.session_id, "sessionId"),
        (&payload.project_id, "projectId"),
        (&payload.entity_type, "entityType"),
        (&payload.entity_id, "entityId"),
        (&payload.revision_id, "revisionId"),
    ] {
        require_non_empty(value, field)?;
    }
    anyhow::ensure!(
        payload.entity_type == "scene",
        "REVISION_CONTENT_RESTORE_UNSUPPORTED_ENTITY_TYPE: only scene revisions can be restored"
    );
    anyhow::ensure!(
        payload.expected_version >= 0,
        "expectedVersion must be non-negative"
    );
    anyhow::ensure!(payload.char_count >= 0, "charCount must be non-negative");
    validate_content(&payload.content, "content")?;
    validate_content(&payload.current_content, "currentContent")?;
    if let Some(preview) = payload.placed_beat_preview.as_deref() {
        let parsed: Value = serde_json::from_str(preview)
            .map_err(|error| anyhow::anyhow!("placedBeatPreview must be JSON: {error}"))?;
        anyhow::ensure!(
            parsed.is_array(),
            "placedBeatPreview must be a JSON array or null"
        );
    }
    Ok(())
}

fn scene_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    scene_id: &str,
) -> anyhow::Result<SceneSnapshot> {
    conn.query_row(
        "SELECT content, version, updated_at
           FROM tree_nodes
          WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
        params![scene_id, project_id],
        |row| {
            Ok(SceneSnapshot {
                content: row.get(0)?,
                version: row.get(1)?,
                updated_at: row.get(2)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| {
        anyhow::anyhow!(
            "REVISION_CONTENT_RESTORE_PROJECT_MISMATCH: scene '{}' is not owned by project '{}'",
            scene_id,
            project_id
        )
    })
}

pub fn restore_scene_revision(
    db: &Database,
    payload: RestoreSceneRevisionPayload,
) -> anyhow::Result<RestoreSceneRevisionResult> {
    validate_payload(&payload)?;
    let mut fingerprint_payload = payload.clone();
    fingerprint_payload.session_id.clear();
    let request_hash = payload_fingerprint(IDEMPOTENCY_DOMAIN, &fingerprint_payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: IDEMPOTENCY_DOMAIN,
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "REVISION_CONTENT_RESTORE_IDEMPOTENCY_CONFLICT",
    };

    db.with_conn(|conn| {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<RestoreSceneRevisionResult> {
            if let Some(response) = load_idempotent_response(conn, &idempotency_request)? {
                let mut replay: RestoreSceneRevisionResult = serde_json::from_value(response)?;
                replay.replayed = true;
                return Ok(replay);
            }

            let before = scene_snapshot(conn, &payload.project_id, &payload.entity_id)?;
            let before_feed = crate::canonical_feed_snapshots::canonical_scene_snapshot(
                conn,
                &payload.project_id,
                &payload.entity_id,
            )?;
            anyhow::ensure!(
                before.version == payload.expected_version,
                "REVISION_CONTENT_RESTORE_VERSION_MISMATCH: expected scene version {}, found {}",
                payload.expected_version,
                before.version
            );
            anyhow::ensure!(
                json_content_matches(&before.content, &payload.current_content),
                "REVISION_CONTENT_RESTORE_CURRENT_CONTENT_MISMATCH: editor content is not the persisted scene head"
            );

            let (revision_entity_type, revision_entity_id, revision_content): (
                String,
                String,
                String,
            ) = conn
                .query_row(
                    "SELECT entity_type, entity_id, content
                       FROM content_versions
                      WHERE id = ?1",
                    params![payload.revision_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "REVISION_CONTENT_RESTORE_REVISION_NOT_FOUND: revision '{}' does not exist",
                        payload.revision_id
                    )
                })?;
            anyhow::ensure!(
                revision_entity_type == "scene" && revision_entity_id == payload.entity_id,
                "REVISION_CONTENT_RESTORE_REVISION_SCOPE_MISMATCH: revision is not owned by the target scene"
            );
            anyhow::ensure!(
                json_content_matches(&revision_content, &payload.content),
                "REVISION_CONTENT_RESTORE_REVISION_CONTENT_MISMATCH: selected content does not match the persisted revision"
            );

            let occurred = chrono::Utc::now();
            let occurred_at =
                occurred.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let timestamp = occurred.timestamp_millis();
            let safety_revision_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO content_versions
                    (id, entity_type, entity_id, content, version_number,
                     snapshot_type, created_at)
                 VALUES (
                    ?1, 'scene', ?2, ?3,
                    (SELECT COALESCE(MAX(version_number), 0) + 1
                       FROM content_versions
                      WHERE entity_type = 'scene' AND entity_id = ?2),
                    'manual', ?4
                 )",
                params![
                    safety_revision_id,
                    payload.entity_id,
                    before.content,
                    occurred_at,
                ],
            )?;

            let updated = conn.execute(
                "UPDATE tree_nodes
                    SET content = ?1,
                        char_count = ?2,
                        placed_beat_preview = ?3,
                        version = version + 1,
                        updated_at = ?4
                  WHERE id = ?5 AND project_id = ?6
                    AND node_type = 'scene' AND version = ?7",
                params![
                    revision_content,
                    payload.char_count,
                    payload.placed_beat_preview,
                    occurred_at,
                    payload.entity_id,
                    payload.project_id,
                    payload.expected_version,
                ],
            )?;
            anyhow::ensure!(
                updated == 1,
                "REVISION_CONTENT_RESTORE_VERSION_MISMATCH: scene changed during restore"
            );
            let after = scene_snapshot(conn, &payload.project_id, &payload.entity_id)?;

            crate::narrative_extraction::record_human_field_write(
                conn,
                &payload.project_id,
                "scene",
                &payload.entity_id,
                &["/content"],
                &after.updated_at,
            )?;
            let source_key = format!("project:scene:{}", payload.entity_id);
            let source_token = format!("v{}@{}", after.version, after.updated_at);
            crate::narrative_extraction::propagate_source_change_freshness_in_tx(
                conn,
                &payload.project_id,
                "scene-body",
                &source_key,
                Some(&source_token),
                &after.updated_at,
                &payload.session_id,
            )?;

            let change_event_uid = uuid::Uuid::new_v4().to_string();
            let canonical_payload = json!({
                "sceneId": payload.entity_id,
                "revisionId": payload.revision_id,
                "safetyRevisionId": safety_revision_id,
                "version": after.version,
            });
            let after_feed = crate::canonical_feed_snapshots::canonical_scene_snapshot(
                conn,
                &payload.project_id,
                &payload.entity_id,
            )?;
            let append = append_canonical_and_narrative_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: change_event_uid.clone(),
                    scene_id: Some(payload.entity_id.clone()),
                    domain: "revision".to_string(),
                    op_type: SOURCE_DOMAIN.to_string(),
                    entity_type: Some("scene".to_string()),
                    entity_id: Some(payload.entity_id.clone()),
                    payload: canonical_payload.to_string(),
                    timestamp,
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: SOURCE_DOMAIN.to_string(),
                    source_change_event_uid: change_event_uid.clone(),
                    cause_kind: NarrativeChangeCauseKind::Forward,
                    origin: NarrativeChangeOrigin::Restore,
                    original_transaction_id: None,
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: None,
                    application_ids: Vec::new(),
                    occurred_at: occurred_at.clone(),
                    events: vec![NarrativeChangeEventInput {
                        object_key: narrative_object_key("scene", &payload.entity_id),
                        change_kind: "content".to_string(),
                        // A content restore replaces an existing canonical
                        // state, so it carries both before and after digests;
                        // the transaction origin remains `restore` to make
                        // the operation explicit without violating the
                        // create-like `restore` event contract.
                        mutation_kind: "update".to_string(),
                        before_version: Some(before.version),
                        before_digest: Some(narrative_snapshot_digest(&before_feed)?),
                        after_version: Some(after.version),
                        after_digest: Some(narrative_snapshot_digest(&after_feed)?),
                        changed_paths: vec![
                            "/charCount".to_string(),
                            "/content".to_string(),
                            "/placedBeatPreview".to_string(),
                        ],
                        // Revision restore has no persisted Canonical Text
                        // position map at this boundary. Keep it as a full
                        // content invalidation until a producer can attach
                        // the versioned TextChangeImpact contract.
                        text_impact: None,
                        structural_impact: None,
                    }],
                },
            )?;
            crate::timelapse::append_timelapse_body_snapshots_in_tx(
                conn,
                &payload.project_id,
                append.canonical.tail_sequence,
                timestamp,
                &[crate::timelapse::TimelapseBodySnapshotTarget::scene(
                    payload.entity_id.clone(),
                )],
            )?;

            let response = RestoreSceneRevisionResult {
                scene_id: payload.entity_id.clone(),
                revision_id: payload.revision_id.clone(),
                safety_revision_id,
                version: after.version,
                updated_at: after.updated_at,
                change_event_uid,
                canonical_sequence: append.narrative.canonical_sequence,
                maintenance_transaction_id: append.narrative.transaction_id,
                replayed: false,
            };
            insert_idempotent_response(
                conn,
                &idempotency_request,
                &payload.project_id,
                &serde_json::to_value(&response)?,
            )?;
            Ok(response)
        })();

        match result {
            Ok(value) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::path::Path;

    use super::*;

    const PROJECT: &str = "default-project";
    const OLD: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"old"}]}]}"#;
    const TARGET: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"restored"}]}]}"#;

    fn fixture() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open test db");
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            conn.execute_batch(&format!(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, char_count,
                     placed_beat_preview, version)
                 VALUES ('scene-1', '{PROJECT}', 'scene', 'Scene', '{OLD}', 3,
                         '[\"old beat\"]', 4);
                 INSERT INTO content_versions
                    (id, entity_type, entity_id, content, version_number,
                     snapshot_type)
                 VALUES ('revision-target', 'scene', 'scene-1', '{TARGET}', 1,
                         'auto');"
            ))?;
            Ok(())
        })
        .expect("seed revision fixture");
        db
    }

    fn payload() -> RestoreSceneRevisionPayload {
        RestoreSceneRevisionPayload {
            request_id: "restore-request-1".to_string(),
            session_id: "session-1".to_string(),
            project_id: PROJECT.to_string(),
            entity_type: "scene".to_string(),
            entity_id: "scene-1".to_string(),
            revision_id: "revision-target".to_string(),
            content: TARGET.to_string(),
            current_content: OLD.to_string(),
            expected_version: 4,
            char_count: 8,
            placed_beat_preview: None,
        }
    }

    #[test]
    fn restores_scene_with_safety_revision_and_both_ledgers_atomically() {
        let db = fixture();
        let result = restore_scene_revision(&db, payload()).expect("restore revision");
        assert_eq!(result.version, 5);
        assert!(!result.replayed);

        db.with_conn(|conn| {
            let scene: (String, i64, i64, Option<String>) = conn.query_row(
                "SELECT content, char_count, version, placed_beat_preview
                   FROM tree_nodes WHERE id = 'scene-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(scene, (TARGET.to_string(), 8, 5, None));
            let safety: (String, String) = conn.query_row(
                "SELECT content, snapshot_type FROM content_versions WHERE id = ?1",
                params![result.safety_revision_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(safety, (OLD.to_string(), "manual".to_string()));
            let canonical: (String, String, String) = conn.query_row(
                "SELECT domain, op_type, entity_id FROM change_events",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(
                canonical,
                (
                    "revision".to_string(),
                    SOURCE_DOMAIN.to_string(),
                    "scene-1".to_string()
                )
            );
            let feed: (String, String, String, i64) = conn.query_row(
                "SELECT t.origin, e.mutation_kind, e.change_kind, e.event_ordinal
                   FROM narrative_change_transactions t
                   JOIN narrative_change_events e ON e.transaction_id = t.id",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(
                feed,
                (
                    "restore".to_string(),
                    "update".to_string(),
                    "content".to_string(),
                    0
                )
            );
            let baseline: (i64, String) = conn.query_row(
                "SELECT anchor_sequence, payload FROM state_snapshots
                  WHERE project_id = ?1 AND domain = 'editor'
                    AND entity_id = 'scene-1'",
                [PROJECT],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(baseline, (result.canonical_sequence, TARGET.to_string()));
            Ok(())
        })
        .expect("inspect atomic restore");
    }

    #[test]
    fn cross_session_retry_returns_receipt_without_duplicate_events_or_safety_revision() {
        let db = fixture();
        let first = restore_scene_revision(&db, payload()).expect("first restore");
        let mut replay = payload();
        replay.session_id = "session-after-restart".to_string();
        let second = restore_scene_revision(&db, replay).expect("cross-session retry restore");
        assert!(second.replayed);
        assert_eq!(second.safety_revision_id, first.safety_revision_id);
        assert_eq!(second.change_event_uid, first.change_event_uid);

        db.with_conn(|conn| {
            for (table, expected) in [
                ("change_events", 1_i64),
                ("narrative_change_transactions", 1),
                ("narrative_change_events", 1),
                ("idempotency_requests", 1),
                ("content_versions", 2),
                ("state_snapshots", 1),
            ] {
                let count =
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })?;
                assert_eq!(count, expected, "duplicate row in {table}");
            }
            Ok(())
        })
        .expect("inspect retry");
    }

    #[test]
    fn rejects_stale_or_cross_project_targets_without_partial_writes() {
        let db = fixture();
        let mut stale = payload();
        stale.expected_version = 3;
        assert!(restore_scene_revision(&db, stale)
            .expect_err("stale OCC must fail")
            .to_string()
            .contains("VERSION_MISMATCH"));

        let mut foreign = payload();
        foreign.request_id = "restore-request-foreign".to_string();
        foreign.project_id = "foreign-project".to_string();
        assert!(restore_scene_revision(&db, foreign)
            .expect_err("cross-project restore must fail")
            .to_string()
            .contains("PROJECT_MISMATCH"));

        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT version FROM tree_nodes WHERE id = 'scene-1'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                4
            );
            for table in [
                "change_events",
                "narrative_change_transactions",
                "narrative_change_events",
                "idempotency_requests",
            ] {
                assert_eq!(
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    0,
                    "partial state in {table}"
                );
            }
            Ok(())
        })
        .expect("inspect rejected restore");
    }

    #[test]
    fn feed_append_failure_rolls_back_scene_safety_revision_and_receipt() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER reject_revision_restore_feed
                 BEFORE INSERT ON narrative_change_events
                 BEGIN
                   SELECT RAISE(ABORT, 'forced revision restore feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install failure trigger");

        let error = restore_scene_revision(&db, payload()).expect_err("Feed failure must abort");
        assert!(error
            .to_string()
            .contains("forced revision restore feed failure"));
        db.with_conn(|conn| {
            let scene: (String, i64) = conn.query_row(
                "SELECT content, version FROM tree_nodes WHERE id = 'scene-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(scene, (OLD.to_string(), 4));
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM content_versions", [], |row| {
                    row.get::<_, i64>(0)
                })?,
                1
            );
            for table in [
                "change_events",
                "narrative_change_transactions",
                "narrative_change_events",
                "idempotency_requests",
            ] {
                assert_eq!(
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    0,
                    "partial state in {table}"
                );
            }
            Ok(())
        })
        .expect("inspect Feed rollback");
    }

    #[test]
    fn snapshot_failure_rolls_back_scene_safety_revision_ledgers_and_receipt() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER reject_revision_restore_snapshot
                 BEFORE INSERT ON state_snapshots
                 BEGIN
                   SELECT RAISE(ABORT, 'forced revision restore snapshot failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install snapshot failure trigger");

        let error = restore_scene_revision(&db, payload()).expect_err("snapshot failure aborts");
        assert!(error
            .to_string()
            .contains("forced revision restore snapshot failure"));
        db.with_conn(|conn| {
            let scene: (String, i64, i64, Option<String>) = conn.query_row(
                "SELECT content, char_count, version, placed_beat_preview
                   FROM tree_nodes WHERE id = 'scene-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(
                scene,
                (OLD.to_string(), 3, 4, Some("[\"old beat\"]".to_string()))
            );
            for (table, expected) in [
                ("content_versions", 1_i64),
                ("change_events", 0),
                ("narrative_change_transactions", 0),
                ("narrative_change_events", 0),
                ("state_snapshots", 0),
                ("idempotency_requests", 0),
            ] {
                let count =
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })?;
                assert_eq!(count, expected, "partial state in {table}");
            }
            Ok(())
        })
        .expect("inspect snapshot rollback");
    }
}
