//! Public Rust eligibility boundary against the unmodified normal UI cold DB.
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_project_scope_authority::{
    build_narrative_project_scope_authority_v1, NarrativeProjectScopeAuthoritySceneInputV1,
};
use grimodex_db::change_events::AppendChangeEvent;
use grimodex_db::domain_writes::{tree_node_patch, TreeNodePatchPayload};
use grimodex_db::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, get_changes_since,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
    NarrativeChangeOrigin,
};
use grimodex_db::narrative_extraction::{
    read_revision_canonical_freshness, RevisionFreshnessRead, RevisionFreshnessReason,
};
use grimodex_db::Database;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

struct Fixture {
    path: PathBuf,
    manifest: Value,
}

impl Fixture {
    fn new() -> Self {
        let manifest: Value =
            serde_json::from_str(include_str!("support/nir1-reviewed-child-cold.json"))
                .expect("manifest");
        let compressed = include_bytes!("support/nir1-reviewed-child-cold.db.gz");
        assert_eq!(
            hex::encode(Sha256::digest(compressed)),
            manifest["compressedDatabaseSha256"]
        );
        let mut bytes = vec![];
        GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut bytes)
            .expect("exact cold fixture");
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            manifest["uncompressedDatabaseSha256"]
        );
        let path =
            std::env::temp_dir().join(format!("grimodex-nir1-eligibility-{}.db", Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private copy");
        Self { path, manifest }
    }

    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }
    fn child(&self) -> &str {
        self.manifest["revisionIds"][0].as_str().expect("child")
    }
    fn read_only(&self) -> Connection {
        Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read-only DB")
    }
    fn digest(&self) -> String {
        hex::encode(Sha256::digest(std::fs::read(&self.path).expect("DB bytes")))
    }

    // DML in negative tests is confined to an exact private corruption copy.
    // Native writers are used for all positive and live-mutation scenarios.
    fn corruption_connection(&self) -> Connection {
        Connection::open(&self.path).expect("private corruption copy")
    }

    fn scene(&self, key: &str) -> &str {
        self.manifest[key].as_str().expect("fixture Scene")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        for suffix in ["-wal", "-shm"] {
            let mut path = self.path.as_os_str().to_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

fn assert_unavailable(conn: &Connection, fixture: &Fixture, case: &str) {
    let tx = conn
        .unchecked_transaction()
        .expect("coherent unavailable read");
    let actual = read_revision_canonical_freshness(&tx, fixture.project(), fixture.child())
        .expect("missing or inconsistent Freshness has a typed result");
    assert!(
        matches!(actual, RevisionFreshnessRead::Unavailable { .. }),
        "{case}: {actual:?}"
    );
}

fn assert_unavailable_reason(
    conn: &Connection,
    fixture: &Fixture,
    expected: RevisionFreshnessReason,
) {
    let tx = conn
        .unchecked_transaction()
        .expect("exact rejection read snapshot");
    let actual = read_revision_canonical_freshness(&tx, fixture.project(), fixture.child())
        .expect("typed exact rejection");
    let RevisionFreshnessRead::Unavailable { reason } = actual else {
        panic!("expected {expected:?}, got {actual:?}");
    };
    assert_eq!(reason, expected);
}

fn stored_transaction_input(
    conn: &Connection,
    fixture: &Fixture,
    sequence: i64,
) -> (String, String, AppendNarrativeChangeTransactionInput) {
    let (id, sealed, raw): (String, String, String) = conn
        .query_row(
            "SELECT id, payload_digest,
                json_object('projectId', project_id, 'requestId', request_id,
                  'sourceDomain', source_domain, 'sourceChangeEventUid', source_change_event_uid,
                  'causeKind', cause_kind, 'origin', origin,
                  'originalTransactionId', original_transaction_id, 'commitId', commit_id,
                  'journalId', journal_id, 'undoJournalId', undo_journal_id,
                  'applicationIds', json(application_ids_json), 'occurredAt', created_at,
                  'events', json('[]'))
           FROM narrative_change_transactions
          WHERE project_id = ?1 AND source_change_event_sequence = ?2",
            params![fixture.project(), sequence],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("saved Native transaction metadata");
    let mut input: AppendNarrativeChangeTransactionInput =
        serde_json::from_str(&raw).expect("existing Native producer input contract");
    let events = get_changes_since(conn, fixture.project(), sequence - 1, 1)
        .expect("whole saved canonical sequence");
    assert!(!events.is_empty());
    input.events = events
        .into_iter()
        .enumerate()
        .map(|(ordinal, event)| {
            assert_eq!(event.transaction_id, id);
            assert_eq!(event.canonical_sequence, sequence);
            assert_eq!(event.event_ordinal, ordinal as i64);
            NarrativeChangeEventInput {
                object_key: event.object_key,
                change_kind: event.change_kind,
                mutation_kind: event.mutation_kind,
                before_version: event.before_version,
                before_digest: event.before_digest,
                after_version: event.after_version,
                after_digest: event.after_digest,
                changed_paths: event.changed_paths,
                text_impact: event.text_impact,
                structural_impact: event.structural_impact,
            }
        })
        .collect();
    (id, sealed, input)
}

fn native_input_digest(input: &AppendNarrativeChangeTransactionInput) -> String {
    // Match the existing producer: sort application IDs, then canonical JSON
    // over the Serialize contract. Check against an untouched Native seal
    // before using this helper to reseal any private negative mutation.
    let mut input = input.clone();
    input.application_ids.sort();
    canonical_json_digest(&serde_json::to_value(input).expect("Native input serialization"))
        .expect("Native canonical payload digest")
}

fn assert_native_transaction_seal(conn: &Connection, fixture: &Fixture, sequence: i64) {
    let (_, sealed, input) = stored_transaction_input(conn, fixture, sequence);
    assert_eq!(
        native_input_digest(&input),
        sealed,
        "existing Native producer seal"
    );
}

fn reseal_private_transaction(conn: &Connection, fixture: &Fixture, sequence: i64) {
    let (id, _, input) = stored_transaction_input(conn, fixture, sequence);
    assert_eq!(
        conn.execute(
            "UPDATE narrative_change_transactions SET payload_digest = ?2 WHERE id = ?1",
            params![id, native_input_digest(&input)],
        )
        .expect("reseal only the private negative copy's transaction"),
        1
    );
}

fn selected_edges(conn: &Connection, fixture: &Fixture) -> Vec<String> {
    conn.prepare(
        "SELECT id FROM narrative_dependency_edges
          WHERE project_id = ?1 AND consumer_kind = 'proposal-revision' AND consumer_key = ?2
          ORDER BY id",
    )
    .expect("edge query")
    .query_map(params![fixture.project(), fixture.child()], |row| {
        row.get(0)
    })
    .expect("selected edge IDs")
    .collect::<rusqlite::Result<Vec<_>>>()
    .expect("all selected edges")
}

fn saved_state(conn: &Connection, fixture: &Fixture) -> (String, Vec<String>) {
    let canonical = conn
        .query_row(
            "SELECT json_object('freshness', evidence_freshness, 'action', build_action,
                            'epoch', semantic_epoch_id, 'run', last_evaluated_run_id,
                            'digest', dependency_set_digest, 'updatedAt', updated_at)
           FROM narrative_consumer_freshness
          WHERE project_id = ?1 AND consumer_kind = 'proposal-revision' AND consumer_key = ?2",
            params![fixture.project(), fixture.child()],
            |row| row.get(0),
        )
        .expect("saved canonical Freshness");
    let edges = conn
        .prepare(
            "SELECT json_object('id', e.id, 'freshness', s.evidence_freshness,
                            'action', s.build_action, 'reason', s.reason_code,
                            'epoch', s.evaluated_at_epoch_id, 'evaluatedAt', s.evaluated_at,
                            'observedToken', s.observed_source_revision_token,
                            'observedDigest', s.observed_source_digest)
           FROM narrative_dependency_edges e
           JOIN narrative_dependency_edge_states s ON s.edge_id = e.id
          WHERE e.project_id = ?1 AND e.consumer_kind = 'proposal-revision' AND e.consumer_key = ?2
          ORDER BY e.id",
        )
        .expect("saved edge states")
        .query_map(params![fixture.project(), fixture.child()], |row| {
            row.get(0)
        })
        .expect("saved state rows")
        .collect::<rusqlite::Result<Vec<String>>>()
        .expect("complete saved state rows");
    (canonical, edges)
}

fn assert_saved_fresh_none(conn: &Connection, fixture: &Fixture) {
    let (canonical, edges) = saved_state(conn, fixture);
    let canonical: Value = serde_json::from_str(&canonical).expect("canonical JSON");
    assert_eq!(canonical["freshness"], "fresh");
    assert_eq!(canonical["action"], "none");
    assert_eq!(edges.len(), 3);
    for edge in edges {
        let edge: Value = serde_json::from_str(&edge).expect("state JSON");
        assert_eq!(edge["freshness"], "fresh");
        assert_eq!(edge["action"], "none");
        assert!(edge["reason"].is_null());
        assert_eq!(edge["epoch"], canonical["epoch"]);
    }
}

fn scene_token(conn: &Connection, scene: &str) -> String {
    conn.query_row(
        "SELECT 'v' || version || '@' || updated_at FROM tree_nodes WHERE id = ?1",
        [scene],
        |row| row.get(0),
    )
    .expect("Native Scene source coordinates")
}

fn live_scope_token(conn: &Connection, fixture: &Fixture) -> String {
    // The exact cold fixture's Reading DFS order is S1 (inside the first
    // folder), then S2. These tests do not alter Reading order or membership.
    let scenes = ["s1", "s2"]
        .into_iter()
        .map(|key| {
            let raw_story_key = conn
                .query_row(
                    "SELECT story_time_order FROM tree_nodes WHERE project_id = ?1 AND id = ?2",
                    params![fixture.project(), fixture.scene(key)],
                    |row| row.get(0),
                )
                .expect("live story key");
            NarrativeProjectScopeAuthoritySceneInputV1 {
                scene_id: fixture.scene(key).to_owned(),
                raw_story_key,
            }
        })
        .collect::<Vec<_>>();
    build_narrative_project_scope_authority_v1(fixture.project(), &scenes)
        .expect("Native Core live Scope authority")
        .source
        .revision_token
}

fn native_patch(db: &Database, fixture: &Fixture, scene: &str, patch: Value, keep_token: bool) {
    let updated_at = if keep_token {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT updated_at FROM tree_nodes WHERE id = ?1",
                [scene],
                |row| row.get(0),
            )?)
        })
        .expect("retain existing source coordinates")
    } else {
        "2026-09-08T08:00:00.000Z".to_owned()
    };
    let request = Uuid::new_v4().to_string();
    tree_node_patch(
        db,
        TreeNodePatchPayload {
            project_id: fixture.project().to_owned(),
            request_id: format!("nir1-freshness-{request}"),
            session_id: "nir1-canonical-freshness".to_owned(),
            event_uid: request,
            node_id: scene.to_owned(),
            patch: patch.as_object().expect("Native patch object").clone(),
            base_version: None,
            bump_version: !keep_token,
            updated_at,
            change_event: None,
            timelapse_doc_step_coverage: None,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            source_domain: None,
            op_type: None,
            canonical_payload: None,
        },
    )
    .expect("production Native mutation and Feed append");
}

fn pending_coordinates(conn: &Connection, fixture: &Fixture) -> (i64, i64) {
    conn.query_row(
        "SELECT acknowledged_through_sequence,
                (SELECT MAX(source_change_event_sequence) FROM narrative_change_transactions WHERE project_id = ?1)
           FROM narrative_change_cursors
          WHERE project_id = ?1 AND consumer_id = 'narrative-incremental-freshness/v1'",
        [fixture.project()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("canonical Feed cursor/head coordinates")
}

fn append_native_unrelated_two_event_transaction(db: &Database, fixture: &Fixture) -> i64 {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let object_key = json!({"kind":"scene","sceneId":fixture.scene("s2")});
        let (version, digest): (Option<i64>, Option<String>) = tx.query_row(
            "SELECT after_version, after_digest FROM narrative_change_object_heads
              WHERE project_id = ?1 AND object_identity = ?2",
            params![fixture.project(), object_key.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let events = ["/title", "/synopsis"]
            .into_iter()
            .map(|path| NarrativeChangeEventInput {
                object_key: object_key.clone(),
                change_kind: "metadata".to_owned(),
                mutation_kind: "update".to_owned(),
                before_version: version,
                before_digest: digest.clone(),
                after_version: version,
                after_digest: digest.clone(),
                changed_paths: vec![path.to_owned()],
                text_impact: None,
                structural_impact: Some(json!({"nodeType":"scene","changedPaths":[path]})),
            })
            .collect();
        let now = chrono::Utc::now();
        let event_uid = Uuid::new_v4().to_string();
        let input = AppendNarrativeChangeTransactionInput {
            project_id: fixture.project().to_owned(),
            request_id: format!("nir1-multi-event-{event_uid}"),
            source_domain: "tree_node.patch".to_owned(),
            source_change_event_uid: event_uid.clone(),
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            commit_id: None,
            journal_id: None,
            undo_journal_id: None,
            application_ids: vec![],
            occurred_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            events,
        };
        let canonical = AppendChangeEvent {
            event_uid,
            scene_id: Some(fixture.scene("s2").to_owned()),
            domain: "tree".to_owned(),
            op_type: input.source_domain.clone(),
            entity_type: Some("tree_node".to_owned()),
            entity_id: Some(fixture.scene("s2").to_owned()),
            payload: json!({"kind":"nir1-unrelated-two-event-noop"}).to_string(),
            timestamp: now.timestamp_millis(),
        };
        let saved = append_canonical_and_narrative_change_in_tx(
            &tx,
            fixture.project(),
            "nir1-multi-event-session",
            &canonical,
            &input,
        )?;
        assert_eq!(saved.narrative.event_ids.len(), 2);
        tx.commit()?;
        Ok(saved.narrative.canonical_sequence)
    })
    .expect("production Native two-event Feed transaction")
}

fn private_acknowledge_head(conn: &Connection, fixture: &Fixture) {
    assert_eq!(conn.execute(
        "UPDATE narrative_change_cursors
            SET acknowledged_through_sequence = (SELECT MAX(source_change_event_sequence) FROM narrative_change_transactions WHERE project_id = ?1)
          WHERE project_id = ?1 AND consumer_id = 'narrative-incremental-freshness/v1'",
        [fixture.project()],
    ).expect("corrupt only the private ACK to isolate live token validation"), 1);
}

#[test]
fn exact_cold_human_child_has_legitimate_runless_current_epoch_freshness() {
    let fixture = Fixture::new();
    let before = fixture.digest();
    let conn = fixture.read_only();
    let tx = conn.unchecked_transaction().expect("read snapshot");
    let actual = read_revision_canonical_freshness(&tx, fixture.project(), fixture.child())
        .expect("canonical revision read");
    let RevisionFreshnessRead::Fresh(snapshot) = actual else {
        panic!("normal UI current child must have complete canonical Freshness: {actual:?}");
    };
    assert_eq!(snapshot.revision_id, fixture.child());
    assert_eq!(snapshot.edge_count, 3);
    assert!(
        snapshot.last_evaluated_run_id.is_none(),
        "Native runless complete publication is valid"
    );
    assert_eq!(snapshot.feed_acknowledged_through_sequence, 3);
    assert_eq!(snapshot.feed_head_sequence, 3);
    assert!(!snapshot.declaration_set_id.is_empty());
    assert!(!snapshot.declaration_set_digest.is_empty());
    assert!(!snapshot.semantic_epoch_id.is_empty());
    assert!(!snapshot.dependency_set_digest.is_empty());
    assert_saved_fresh_none(&tx, &fixture);
    let (epoch, dependency_digest, declaration_id, declaration_digest): (String, String, String, String) = tx.query_row(
        "SELECT f.semantic_epoch_id, f.dependency_set_digest, h.active_declaration_set_id, d.dependency_set_digest
           FROM narrative_consumer_freshness f
           JOIN narrative_dependency_declaration_heads h
             ON h.project_id = f.project_id AND h.consumer_kind = f.consumer_kind AND h.consumer_key = f.consumer_key
           JOIN narrative_dependency_declaration_sets d ON d.id = h.active_declaration_set_id
          WHERE f.project_id = ?1 AND f.consumer_kind = 'proposal-revision' AND f.consumer_key = ?2",
        params![fixture.project(), fixture.child()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).expect("canonical authority and active D1 exact bindings");
    assert_eq!(snapshot.semantic_epoch_id, epoch);
    assert_eq!(snapshot.dependency_set_digest, dependency_digest);
    assert_eq!(snapshot.declaration_set_id, declaration_id);
    assert_eq!(snapshot.declaration_set_digest, declaration_digest);
    drop(tx);
    drop(conn);
    assert_eq!(
        before,
        fixture.digest(),
        "cold reader writes no receipt, heartbeat or row"
    );
}

#[test]
fn canonical_freshness_requires_a_read_snapshot_and_matching_project() {
    let fixture = Fixture::new();
    let conn = fixture.read_only();
    assert!(read_revision_canonical_freshness(&conn, fixture.project(), fixture.child()).is_err());
    let tx = conn
        .unchecked_transaction()
        .expect("project-scoped read snapshot");
    assert!(matches!(
        read_revision_canonical_freshness(&tx, "different-project", fixture.child())
            .expect("wrong project is typed unavailable"),
        RevisionFreshnessRead::Unavailable { .. }
    ));
}

#[test]
fn every_edge_requires_fresh_none_without_a_reason_including_later_edges() {
    for (freshness, action, reason) in [
        ("fresh", "revalidate-exact", None),
        ("fresh", "none", Some("source-revision-changed")),
        ("stale", "none", None),
    ] {
        let fixture = Fixture::new();
        let conn = fixture.corruption_connection();
        let edges = selected_edges(&conn, &fixture);
        assert_eq!(edges.len(), 3);
        assert_eq!(conn.execute(
            "UPDATE narrative_dependency_edge_states
                SET evidence_freshness = ?2, build_action = ?3, reason_code = ?4 WHERE edge_id = ?1",
            params![edges[2], freshness, action, reason],
        ).expect("corrupt a later edge without changing the canonical summary"), 1);
        for earlier in &edges[..2] {
            let stored: (String, String, Option<String>) = conn
                .query_row(
                    "SELECT evidence_freshness, build_action, reason_code
                   FROM narrative_dependency_edge_states WHERE edge_id = ?1",
                    [earlier],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("earlier fresh/none edge remains intact");
            assert_eq!(stored, ("fresh".to_owned(), "none".to_owned(), None));
        }
        let (canonical, _) = saved_state(&conn, &fixture);
        let canonical: Value = serde_json::from_str(&canonical).expect("canonical JSON");
        assert_eq!(canonical["freshness"], "fresh");
        assert_eq!(canonical["action"], "none");
        assert_unavailable(
            &conn,
            &fixture,
            &format!("later edge {freshness}/{action}/{reason:?}"),
        );
    }
}

#[test]
fn a_nonfresh_or_actionable_canonical_row_cannot_be_overridden_by_fresh_edges() {
    for (freshness, action) in [("stale", "none"), ("fresh", "revalidate-exact")] {
        let fixture = Fixture::new();
        let conn = fixture.corruption_connection();
        assert_eq!(
            conn.execute(
                "UPDATE narrative_consumer_freshness SET evidence_freshness = ?3, build_action = ?4
              WHERE project_id = ?1 AND consumer_kind = 'proposal-revision' AND consumer_key = ?2",
                params![fixture.project(), fixture.child(), freshness, action],
            )
            .expect("corrupt canonical summary only"),
            1
        );
        assert_unavailable(&conn, &fixture, "canonical row disagrees with fresh edges");
    }
}

#[test]
fn missing_canonical_row_edge_state_edge_or_d1_head_is_unavailable() {
    for (case, sql) in [
        ("canonical row", "DELETE FROM narrative_consumer_freshness WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1"),
        ("later edge state", "DELETE FROM narrative_dependency_edge_states WHERE edge_id = (SELECT id FROM narrative_dependency_edges WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1 ORDER BY id DESC LIMIT 1)"),
        ("persisted edge", "DELETE FROM narrative_dependency_edges WHERE id = (SELECT id FROM narrative_dependency_edges WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1 ORDER BY id DESC LIMIT 1)"),
        ("D1 head", "DELETE FROM narrative_dependency_declaration_heads WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1"),
    ] {
        let fixture = Fixture::new();
        let conn = fixture.corruption_connection();
        assert_eq!(conn.execute(sql, [fixture.child()]).expect(case), 1);
        assert_unavailable(&conn, &fixture, &format!("missing {case}"));
    }
}

#[test]
fn canonical_or_edge_state_from_an_older_epoch_is_unavailable() {
    for old_binding in ["canonical", "later-edge"] {
        let fixture = Fixture::new();
        let conn = fixture.corruption_connection();
        let original_epoch: String = conn.query_row(
            "SELECT semantic_epoch_id FROM narrative_consumer_freshness WHERE consumer_key = ?1",
            [fixture.child()], |row| row.get(0),
        ).expect("original Epoch");
        conn.execute(
            "INSERT INTO narrative_semantic_epochs (id, project_id, epoch_number, reason, created_at)
             VALUES ('private-new-current-epoch', ?1, 1, 'restore', '2026-09-08T08:00:00.000Z')",
            [fixture.project()],
        ).expect("advance only the private corruption copy's Epoch");
        conn.execute(
            "UPDATE narrative_consumer_freshness SET semantic_epoch_id = 'private-new-current-epoch'
              WHERE consumer_key = ?1", [fixture.child()],
        ).expect("align canonical copy to new Epoch before one-axis corruption");
        conn.execute(
            "UPDATE narrative_dependency_edge_states SET evaluated_at_epoch_id = 'private-new-current-epoch'
              WHERE edge_id IN (SELECT id FROM narrative_dependency_edges WHERE consumer_key = ?1)",
            [fixture.child()],
        ).expect("align all edge copies to new Epoch before one-axis corruption");
        let sql = if old_binding == "canonical" {
            "UPDATE narrative_consumer_freshness SET semantic_epoch_id = ?2 WHERE consumer_key = ?1"
        } else {
            "UPDATE narrative_dependency_edge_states SET evaluated_at_epoch_id = ?2
              WHERE edge_id = (SELECT id FROM narrative_dependency_edges WHERE consumer_key = ?1 ORDER BY id DESC LIMIT 1)"
        };
        assert_eq!(
            conn.execute(sql, params![fixture.child(), original_epoch])
                .expect(old_binding),
            1
        );
        assert_unavailable(&conn, &fixture, &format!("old Epoch on {old_binding}"));
    }
}

#[test]
fn missing_or_mismatched_dependency_and_declaration_digests_are_unavailable() {
    for (case, sql) in [
        ("missing canonical digest", "UPDATE narrative_consumer_freshness SET dependency_set_digest = NULL WHERE consumer_key = ?1"),
        ("wrong canonical digest", "UPDATE narrative_consumer_freshness SET dependency_set_digest = printf('%064d', 0) WHERE consumer_key = ?1"),
        ("wrong sealed D1 digest", "UPDATE narrative_dependency_declaration_sets SET dependency_set_digest = 'sha256:' || printf('%064d', 0) WHERE consumer_key = ?1"),
    ] {
        let fixture = Fixture::new();
        let conn = fixture.corruption_connection();
        assert_eq!(conn.execute(sql, [fixture.child()]).expect(case), 1);
        assert_unavailable(&conn, &fixture, case);
    }
}

#[test]
fn a_named_evaluation_run_must_be_a_real_compatible_publisher() {
    for run_id in ["missing-evaluation-run", "interpretation"] {
        let fixture = Fixture::new();
        let conn = fixture.corruption_connection();
        let run = if run_id == "interpretation" {
            fixture.manifest["runId"]
                .as_str()
                .expect("owning interpretation Run")
        } else {
            run_id
        };
        assert_eq!(conn.execute(
            "UPDATE narrative_consumer_freshness SET last_evaluated_run_id = ?2 WHERE consumer_key = ?1",
            params![fixture.child(), run],
        ).expect("corrupt only the named evaluator Run"), 1);
        assert_unavailable(&conn, &fixture, "invalid named publisher Run");
    }
}

#[test]
fn native_source_or_scope_changes_block_immediately_and_after_a_forged_ack() {
    for source in ["scene-body", "scope-authority"] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        let (before_saved, before_token) = db
            .with_conn(|conn| {
                Ok((
                    saved_state(conn, &fixture),
                    if source == "scene-body" {
                        scene_token(conn, fixture.scene("s1"))
                    } else {
                        live_scope_token(conn, &fixture)
                    },
                ))
            })
            .expect("saved fresh state and current Native token");
        let (scene, patch) = if source == "scene-body" {
            (
                fixture.scene("s1"),
                json!({"content": "A newly changed Native source body."}),
            )
        } else {
            (
                fixture.scene("s2"),
                json!({"storyTimeOrder": "nir1-changed-story-key"}),
            )
        };
        native_patch(&db, &fixture, scene, patch, false);
        db.with_conn(|conn| {
            assert_eq!(saved_state(conn, &fixture), before_saved);
            assert_saved_fresh_none(conn, &fixture);
            let current = if source == "scene-body" {
                scene_token(conn, fixture.scene("s1"))
            } else {
                live_scope_token(conn, &fixture)
            };
            assert_ne!(current, before_token);
            let (ack, head) = pending_coordinates(conn, &fixture);
            assert!(ack < head);
            assert_unavailable(conn, &fixture, "immediate pending Native source change");
            assert_eq!(saved_state(conn, &fixture), before_saved);
            Ok(())
        })
        .expect("no scheduler delay permits admission after a Native change");
        drop(db);
        let conn = fixture.corruption_connection();
        private_acknowledge_head(&conn, &fixture);
        let (ack, head) = pending_coordinates(&conn, &fixture);
        assert_eq!(ack, head);
        assert_saved_fresh_none(&conn, &fixture);
        assert_unavailable(
            &conn,
            &fixture,
            "current Native token differs even with a forged ACK",
        );
        assert_eq!(saved_state(&conn, &fixture), before_saved);
    }
}

#[test]
fn same_saved_freshness_and_same_source_token_still_reject_relevant_pending_feed() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let (before_saved, before_token) = db
        .with_conn(|conn| {
            Ok((
                saved_state(conn, &fixture),
                scene_token(conn, fixture.scene("s1")),
            ))
        })
        .expect("baseline saved state and source token");
    native_patch(
        &db,
        &fixture,
        fixture.scene("s1"),
        json!({"title": "Relevant pending metadata"}),
        true,
    );
    db.with_conn(|conn| {
        assert_eq!(scene_token(conn, fixture.scene("s1")), before_token);
        assert_eq!(saved_state(conn, &fixture), before_saved);
        assert_saved_fresh_none(conn, &fixture);
        assert!(pending_coordinates(conn, &fixture).0 < pending_coordinates(conn, &fixture).1);
        assert_unavailable(
            conn,
            &fixture,
            "relevant pending Feed despite equal saved source token",
        );
        assert_eq!(saved_state(conn, &fixture), before_saved);
        Ok(())
    })
    .expect("pending relevance is independent of saved fresh rows and source token equality");
}

#[test]
fn bounded_unrelated_native_pending_feed_preserves_freshness_with_ack_behind_head() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let (before_saved, before_scope, before_source) = db
        .with_conn(|conn| {
            Ok((
                saved_state(conn, &fixture),
                live_scope_token(conn, &fixture),
                scene_token(conn, fixture.scene("s1")),
            ))
        })
        .expect("unchanged selected dependencies");
    native_patch(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({"title": "Unrelated pending title"}),
        false,
    );
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert_eq!(saved_state(&tx, &fixture), before_saved);
        assert_eq!(live_scope_token(&tx, &fixture), before_scope);
        assert_eq!(scene_token(&tx, fixture.scene("s1")), before_source);
        assert_saved_fresh_none(&tx, &fixture);
        let (ack, head) = pending_coordinates(&tx, &fixture);
        assert!(ack < head);
        let actual = read_revision_canonical_freshness(&tx, fixture.project(), fixture.child())?;
        let RevisionFreshnessRead::Fresh(snapshot) = actual else {
            panic!("a completely scanned unrelated Native event must not block: {actual:?}");
        };
        assert_eq!(snapshot.feed_acknowledged_through_sequence, ack);
        assert_eq!(snapshot.feed_head_sequence, head);
        assert_eq!(saved_state(&tx, &fixture), before_saved);
        Ok(())
    })
    .expect("relevance-scoped pending gate");
}

#[test]
fn global_or_unknown_pending_feed_cannot_reuse_the_same_saved_fresh_rows() {
    for case in [
        "component-schema",
        "project-reset",
        "unknown-key",
        "unknown-change",
    ] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        native_patch(
            &db,
            &fixture,
            fixture.scene("s2"),
            json!({"title": "Pending marker seed"}),
            false,
        );
        drop(db);
        let conn = fixture.corruption_connection();
        let before_saved = saved_state(&conn, &fixture);
        let (ack, pending_sequence) = pending_coordinates(&conn, &fixture);
        assert!(ack < pending_sequence);
        assert_native_transaction_seal(&conn, &fixture, pending_sequence);
        let (object, change_kind, structural) = match case {
            "component-schema" => (
                json!({"kind":"component","componentId":"extractor"}),
                "schema",
                Some(json!({"event":"schema-component-changed","requiresFullRebuild":true})),
            ),
            "project-reset" => (
                json!({"kind":"project","projectId":fixture.project()}),
                "schema",
                Some(json!({"event":"semantic-epoch-reset","requiresFullRebuild":true})),
            ),
            "unknown-key" => (
                json!({"kind":"unrecognized-source","id":"unresolved"}),
                "metadata",
                None,
            ),
            "unknown-change" => (
                json!({"kind":"scene","sceneId":fixture.scene("s2")}),
                "unknown",
                None,
            ),
            _ => unreachable!("enumerated pending case"),
        };
        assert_eq!(
            conn.execute(
                "UPDATE narrative_change_events SET object_key_json = ?2, change_kind = ?3,
                    structural_impact_json = ?4 WHERE project_id = ?1 AND canonical_sequence = ?5",
                params![
                    fixture.project(),
                    object.to_string(),
                    change_kind,
                    structural.map(|v| v.to_string()),
                    pending_sequence
                ],
            )
            .expect("change only the private pending marker"),
            1
        );
        reseal_private_transaction(&conn, &fixture, pending_sequence);
        assert_saved_fresh_none(&conn, &fixture);
        assert_unavailable_reason(
            &conn,
            &fixture,
            if matches!(case, "component-schema" | "project-reset") {
                RevisionFreshnessReason::PendingGlobalChange
            } else {
                RevisionFreshnessReason::PendingUnknown
            },
        );
        assert_eq!(saved_state(&conn, &fixture), before_saved);
        assert_eq!(
            pending_coordinates(&conn, &fixture),
            (ack, pending_sequence)
        );
    }
}

#[test]
fn missing_or_ahead_of_head_cursor_and_incomplete_feed_storage_are_unavailable() {
    for (case, sql) in [
        ("missing cursor", "DELETE FROM narrative_change_cursors WHERE project_id = ?1 AND consumer_id = 'narrative-incremental-freshness/v1' AND acknowledged_through_sequence < ?2"),
        ("ACK beyond head", "UPDATE narrative_change_cursors SET acknowledged_through_sequence = ?2 + 1 WHERE project_id = ?1 AND consumer_id = 'narrative-incremental-freshness/v1'"),
        ("missing pending Feed row", "DELETE FROM narrative_change_events WHERE project_id = ?1 AND canonical_sequence = ?2"),
        ("missing pending Feed transaction", "DELETE FROM narrative_change_transactions WHERE project_id = ?1 AND source_change_event_sequence = ?2"),
    ] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        native_patch(&db, &fixture, fixture.scene("s2"), json!({"title": "Unrelated Feed storage seed"}), false);
        drop(db);
        let conn = fixture.corruption_connection();
        let (ack, pending_sequence) = pending_coordinates(&conn, &fixture);
        assert!(ack < pending_sequence);
        if case == "missing pending Feed transaction" {
            // Retain the orphan event witness. Deleting both transaction and
            // all its events tests writer coverage, outside this L2 boundary.
            conn.execute_batch("PRAGMA foreign_keys = OFF")
                .expect("disable cascading deletion only for the private orphan case");
            let foreign_keys: i64 = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .expect("private orphan copy FK setting");
            assert_eq!(foreign_keys, 0);
        }
        assert_eq!(conn.execute(sql, params![fixture.project(), pending_sequence]).expect(case), 1);
        if case == "missing pending Feed transaction" {
            let retained_events: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_events WHERE project_id = ?1 AND canonical_sequence = ?2",
                params![fixture.project(), pending_sequence], |row| row.get(0),
            ).expect("orphan event witness remains stored");
            assert_eq!(retained_events, 1);
        }
        assert_saved_fresh_none(&conn, &fixture);
        assert_unavailable(&conn, &fixture, case);
    }
}

#[test]
fn a_missing_trailing_event_cannot_match_the_native_multi_event_transaction_seal() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let sequence = append_native_unrelated_two_event_transaction(&db, &fixture);
    db.with_conn(|conn| {
        assert_native_transaction_seal(conn, &fixture, sequence);
        let (_, _, input) = stored_transaction_input(conn, &fixture, sequence);
        assert_eq!(input.events.len(), 2);
        let tx = conn.unchecked_transaction()?;
        let actual = read_revision_canonical_freshness(&tx, fixture.project(), fixture.child())?;
        assert!(
            matches!(actual, RevisionFreshnessRead::Fresh(_)),
            "Native two-event baseline: {actual:?}"
        );
        Ok(())
    })
    .expect("complete Native unrelated multi-event transaction is Fresh");
    drop(db);
    let conn = fixture.corruption_connection();
    let before_saved = saved_state(&conn, &fixture);
    let (_, original_seal, _) = stored_transaction_input(&conn, &fixture, sequence);
    assert_eq!(
        conn.execute(
            "DELETE FROM narrative_change_events
          WHERE project_id = ?1 AND canonical_sequence = ?2 AND event_ordinal = 1",
            params![fixture.project(), sequence],
        )
        .expect("remove only the final event on the private corruption copy"),
        1
    );
    let (_, retained_seal, surviving_input) = stored_transaction_input(&conn, &fixture, sequence);
    assert_eq!(surviving_input.events.len(), 1);
    assert_eq!(retained_seal, original_seal);
    assert_ne!(native_input_digest(&surviving_input), retained_seal);
    assert_saved_fresh_none(&conn, &fixture);
    assert_unavailable_reason(&conn, &fixture, RevisionFreshnessReason::PendingUnknown);
    assert_eq!(saved_state(&conn, &fixture), before_saved);
}

#[test]
fn pending_event_budget_exhaustion_cannot_treat_a_partial_scan_as_unrelated() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    native_patch(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({"title": "Unrelated pending budget seed"}),
        false,
    );
    drop(db);
    let conn = fixture.corruption_connection();
    let (ack, pending_sequence) = pending_coordinates(&conn, &fixture);
    assert!(ack < pending_sequence);
    // Keep one canonical sequence with 4097 event rows: head equality alone
    // cannot prove that a bounded scan examined every event in that sequence.
    assert_eq!(conn.execute(
        "WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM copies WHERE n < 4096)
         INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid, canonical_sequence,
             event_ordinal, object_key_json, change_kind, mutation_kind, before_version,
             before_digest, after_version, after_digest, changed_paths_json,
             text_impact_json, structural_impact_json, occurred_at)
         SELECT 'private-over-budget-' || copies.n, e.project_id, e.transaction_id,
                e.canonical_change_event_uid, e.canonical_sequence, copies.n,
                e.object_key_json, e.change_kind, e.mutation_kind, e.before_version,
                e.before_digest, e.after_version, e.after_digest, e.changed_paths_json,
                e.text_impact_json, e.structural_impact_json, e.occurred_at
           FROM narrative_change_events e CROSS JOIN copies
          WHERE e.project_id = ?1 AND e.canonical_sequence = ?2 AND e.event_ordinal = 0",
        params![fixture.project(), pending_sequence],
    ).expect("expand only the private Feed budget corruption copy"), 4096);
    assert_saved_fresh_none(&conn, &fixture);
    assert_unavailable(
        &conn,
        &fixture,
        "4097 pending events exceed the complete-scan budget",
    );
}

#[test]
fn pending_sequence_budget_exhaustion_cannot_treat_a_partial_scan_as_unrelated() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    native_patch(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({"title": "Unrelated sequence budget seed"}),
        false,
    );
    drop(db);
    let conn = fixture.corruption_connection();
    let (ack, pending_sequence) = pending_coordinates(&conn, &fixture);
    assert!(ack < pending_sequence);
    let sequence_base: i64 = conn
        .query_row(
            "SELECT MAX(sequence) FROM change_events WHERE project_id = ?1",
            [fixture.project()],
            |row| row.get(0),
        )
        .expect("allocate budget copies strictly after the actual canonical audit head");
    assert_native_transaction_seal(&conn, &fixture, pending_sequence);
    // Preserve a joined canonical/transaction/event row for each sequence so
    // rejection reaches the 64-sequence * 16-page bound, below the event bound.
    assert_eq!(conn.execute(
        "WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM copies WHERE n < 1024)
         INSERT INTO change_events
            (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id,
             payload, session_id, sequence, timestamp, prev_hash, hash)
         SELECT 'private-sequence-uid-' || copies.n, e.project_id, e.scene_id,
                e.domain, e.op_type, e.entity_type, e.entity_id, e.payload,
                e.session_id, ?3 + copies.n, e.timestamp, e.prev_hash, e.hash
           FROM change_events e CROSS JOIN copies WHERE e.project_id = ?1 AND e.sequence = ?2",
        params![fixture.project(), pending_sequence, sequence_base],
    ).expect("private canonical sequence budget copy"), 1024);
    assert_eq!(conn.execute(
        "WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM copies WHERE n < 1024)
         INSERT INTO narrative_change_transactions
            (id, project_id, request_id, source_domain, source_change_event_uid,
             source_change_event_sequence, cause_kind, origin, original_transaction_id,
             commit_id, journal_id, undo_journal_id, application_ids_json, payload_digest, created_at)
         SELECT 'private-sequence-tx-' || copies.n, t.project_id,
                'private-sequence-request-' || copies.n, t.source_domain,
                'private-sequence-uid-' || copies.n, ?3 + copies.n, t.cause_kind,
                t.origin, t.original_transaction_id, t.commit_id, t.journal_id,
                t.undo_journal_id, t.application_ids_json, t.payload_digest, t.created_at
           FROM narrative_change_transactions t CROSS JOIN copies
          WHERE t.project_id = ?1 AND t.source_change_event_sequence = ?2",
        params![fixture.project(), pending_sequence, sequence_base],
    ).expect("private transaction sequence budget copy"), 1024);
    assert_eq!(conn.execute(
        "WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM copies WHERE n < 1024)
         INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid, canonical_sequence,
             event_ordinal, object_key_json, change_kind, mutation_kind, before_version,
             before_digest, after_version, after_digest, changed_paths_json,
             text_impact_json, structural_impact_json, occurred_at)
         SELECT 'private-sequence-event-' || copies.n, e.project_id,
                'private-sequence-tx-' || copies.n, 'private-sequence-uid-' || copies.n,
                ?3 + copies.n, 0, e.object_key_json, e.change_kind, e.mutation_kind,
                e.before_version, e.before_digest, e.after_version, e.after_digest,
                e.changed_paths_json, e.text_impact_json, e.structural_impact_json, e.occurred_at
           FROM narrative_change_events e CROSS JOIN copies
          WHERE e.project_id = ?1 AND e.canonical_sequence = ?2 AND e.event_ordinal = 0",
        params![fixture.project(), pending_sequence, sequence_base],
    ).expect("private event sequence budget copy"), 1024);
    {
        let tx = conn
            .unchecked_transaction()
            .expect("batch private negative resealing");
        for offset in 1..=1024 {
            reseal_private_transaction(&tx, &fixture, sequence_base + offset);
        }
        tx.commit().expect("commit only private negative seals");
    }
    assert_eq!(
        pending_coordinates(&conn, &fixture),
        (ack, sequence_base + 1024)
    );
    assert_saved_fresh_none(&conn, &fixture);
    assert_unavailable_reason(&conn, &fixture, RevisionFreshnessReason::PendingUnknown);
}

#[test]
fn canonical_freshness_sql_failures_remain_errors() {
    for table in [
        "narrative_consumer_freshness",
        "narrative_dependency_edge_states",
        "narrative_change_events",
    ] {
        let fixture = Fixture::new();
        let conn = fixture.corruption_connection();
        conn.execute_batch(&format!("DROP TABLE {table}"))
            .expect("private SQL-error copy");
        let tx = conn.unchecked_transaction().expect("SQL-error snapshot");
        let error = read_revision_canonical_freshness(&tx, fixture.project(), fixture.child())
            .expect_err("SQL failure must not become a typed unavailable result or Fresh");
        assert!(
            error.downcast_ref::<rusqlite::Error>().is_some(),
            "{table}: {error:#}"
        );
    }
}
