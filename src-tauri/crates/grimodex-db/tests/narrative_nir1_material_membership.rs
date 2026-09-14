//! Normal UI -> cold storage -> shared typed membership reader.
//! The fixture is an exact compressed copy of a newly generated cold database,
//! not a reconstructed set of envelopes. Mutable cases always get private copies.
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use grimodex_core::narrative_project_scope_authority::{
    build_narrative_project_scope_authority_v1, NarrativeProjectScopeAuthoritySceneInputV1,
};
use grimodex_core::{canonical_json_digest, canonical_json_string};
use grimodex_db::domain_writes::{tree_node_patch, TreeNodePatchPayload};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto,
    read_revision_material_membership, run_incremental_freshness_cycle,
    CreateHumanDerivedRevisionRequest, IncrementalFreshnessCycleOutcome, MaterialMembershipRead,
    NarrativeAdapterIdentity,
};
use grimodex_db::Database;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

struct ColdFixture {
    path: PathBuf,
    manifest: Value,
}

impl ColdFixture {
    fn new() -> Self {
        let manifest: Value =
            serde_json::from_str(include_str!("support/nir1-reviewed-child-cold.json"))
                .expect("fixture manifest");
        let compressed = include_bytes!("support/nir1-reviewed-child-cold.db.gz");
        assert_eq!(
            hex::encode(Sha256::digest(compressed)),
            manifest["compressedDatabaseSha256"]
        );
        let mut bytes = Vec::new();
        GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut bytes)
            .expect("decompress exact cold fixture");
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            manifest["uncompressedDatabaseSha256"]
        );
        let path =
            std::env::temp_dir().join(format!("grimodex-nir1-membership-{}.db", Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private fixture copy");
        Self { path, manifest }
    }

    fn read_only(&self) -> Connection {
        Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read-only cold fixture")
    }

    fn digest(&self) -> String {
        hex::encode(Sha256::digest(
            std::fs::read(&self.path).expect("read fixture bytes"),
        ))
    }

    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project ID")
    }

    fn child(&self) -> &str {
        self.manifest["revisionIds"][0].as_str().expect("child ID")
    }

    fn root(&self) -> &str {
        self.manifest["rootRevisionIds"][0]
            .as_str()
            .expect("root ID")
    }

    // Corruption tests deliberately bypass immutable-row guards on this
    // private copy. Positive cases always use the production Native writers.
    fn corruption_connection(&self) -> Connection {
        let conn = Connection::open(&self.path).expect("private writable fixture");
        conn.execute_batch(
            "DROP TRIGGER narrative_revision_envelope_immutable_update;
             DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard;
             DROP TRIGGER narrative_source_basis_immutable_update;
             DROP TRIGGER narrative_source_basis_immutable_delete;",
        )
        .expect("remove only private corruption-copy guards");
        conn
    }
}

impl Drop for ColdFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        for suffix in ["-wal", "-shm"] {
            let mut path = self.path.as_os_str().to_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

fn assert_unavailable(conn: &Connection, fixture: &ColdFixture, case: &str) {
    let tx = conn
        .unchecked_transaction()
        .expect("coherent read snapshot");
    assert!(
        matches!(
            read_revision_material_membership(&tx, fixture.project(), fixture.child())
                .expect("corrupt persisted membership returns a typed result"),
            MaterialMembershipRead::Unavailable { .. }
        ),
        "{case} must make the whole child membership unavailable"
    );
}

fn load_envelope(conn: &Connection, revision: &str) -> Value {
    let raw: String = conn
        .query_row(
            "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
            [revision],
            |row| row.get(0),
        )
        .expect("saved Envelope");
    serde_json::from_str(&raw).expect("Envelope JSON")
}

fn digest(value: &Value) -> String {
    canonical_json_digest(value).expect("canonical test digest")
}

// Reseal the changed domains so a negative reaches relational validation,
// instead of passing merely because its old digest no longer matches JSON.
fn rewrite_resealed_envelope(conn: &Connection, revision: &str, envelope: &mut Value) {
    let assertion = &envelope["assertion"];
    let mut core = json!({
        "assertionKind": assertion["assertionKind"],
        "payloadSchemaRef": assertion["payloadSchemaRef"],
        "typedSemanticPayload": assertion["payload"],
        "modality": assertion["modality"],
        "polarity": assertion["polarity"],
        "supportClass": assertion["supportClass"],
        "producer": assertion["producer"]
    });
    if let Some(confidence) = assertion.get("producerConfidence") {
        core["producerConfidence"] = confidence.clone();
    }
    let core_digest = digest(&core);
    let scope_digest = digest(&assertion["scope"]);
    envelope["assertionDigests"] = json!({
        "assertionCoreDigest": core_digest,
        "scopeDigest": scope_digest,
        "assertionDigest": digest(&json!({
            "assertionCoreDigest": core_digest,
            "scopeDigest": scope_digest
        }))
    });
    envelope["revisionBasis"]["derivationContextSetDigest"] = json!(digest(&json!({
        "version": "chronicle.context-set/1",
        "entries": envelope["revisionBasis"]["derivationContextSet"]
    })));
    assert_eq!(
        conn.execute(
            "UPDATE narrative_proposal_revisions
                SET reconciliation_envelope_json = ?2, reconciliation_envelope_digest = ?3
              WHERE id = ?1",
            params![
                revision,
                canonical_json_string(envelope).expect("canonical Envelope"),
                digest(envelope)
            ],
        )
        .expect("reseal only the private corruption copy"),
        1
    );
}

fn create_native_child(
    db: &Database,
    fixture: &ColdFixture,
    parent_revision: &str,
    edit: impl FnOnce(&mut Value),
) -> String {
    let (proposal_id, envelope_digest, payload): (String, String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT proposal_id, reconciliation_envelope_digest, payload_json
                   FROM narrative_proposal_revisions WHERE id = ?1",
                [parent_revision],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("Native parent request inputs");
    let mut payload = serde_json::from_str(&payload).expect("parent payload");
    edit(&mut payload);
    let saved =
        narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto(
            db,
            fixture.project(),
            CreateHumanDerivedRevisionRequest {
                proposal_id,
                expected_current_revision_id: parent_revision.to_owned(),
                parent_revision_id: parent_revision.to_owned(),
                expected_parent_envelope_digest: envelope_digest,
                proposal_payload: payload,
                adapter: NarrativeAdapterIdentity {
                    id: "chronicle.scene-event".to_owned(),
                    version: "1".to_owned(),
                },
                surface_id: "chronicle-review".to_owned(),
            },
        )
        .expect("production Native C2B child creation");
    saved["revisionId"]
        .as_str()
        .expect("Native child ID")
        .to_owned()
}

fn scope_token(conn: &Connection, revision: &str) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT revision_token FROM narrative_revision_source_basis
          WHERE revision_id = ?1 AND source_kind IN ('project-scope-authority','scope-dependency-projection-v1')",
        [revision],
        |row| row.get(0),
    )
}

fn stored_freshness(conn: &Connection, fixture: &ColdFixture, revision: &str) -> String {
    conn.query_row(
        "SELECT evidence_freshness FROM narrative_consumer_freshness
          WHERE project_id = ?1 AND consumer_kind = 'proposal-revision' AND consumer_key = ?2",
        params![fixture.project(), revision],
        |row| row.get(0),
    )
    .expect("stored canonical revision Freshness")
}

fn current_revision(conn: &Connection, revision: &str) -> String {
    conn.query_row(
        "SELECT p.current_revision_id FROM narrative_proposals p
          JOIN narrative_proposal_revisions r ON r.proposal_id = p.id WHERE r.id = ?1",
        [revision],
        |row| row.get(0),
    )
    .expect("Native selected revision pointer")
}

fn current_native_scope_token(conn: &Connection, fixture: &ColdFixture) -> String {
    current_native_scope_authority(conn, fixture)
        .source
        .revision_token
}

fn current_native_scope_authority(
    conn: &Connection,
    fixture: &ColdFixture,
) -> grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1 {
    // The exact fixture has S1 under the first root folder, then root S2.
    // These tests change only story order, so this persisted Reading DFS order
    // is fixed. Feed the live story keys through the production Native Core
    // authority builder instead of deriving the expected token from a child.
    let scene_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tree_nodes
              WHERE project_id = ?1 AND node_type = 'scene' AND archived_at IS NULL",
            [fixture.project()],
            |row| row.get(0),
        )
        .expect("fixture active Scene count");
    assert_eq!(scene_count, 2);
    let mut scenes = Vec::new();
    for key in ["s1", "s2"] {
        let scene_id = fixture.manifest[key].as_str().expect("fixture Scene");
        let raw_story_key = conn
            .query_row(
                "SELECT story_time_order FROM tree_nodes
                  WHERE project_id = ?1 AND id = ?2 AND node_type = 'scene'
                    AND archived_at IS NULL",
                params![fixture.project(), scene_id],
                |row| row.get(0),
            )
            .expect("persisted live story key");
        scenes.push(NarrativeProjectScopeAuthoritySceneInputV1 {
            scene_id: scene_id.to_owned(),
            raw_story_key,
        });
    }
    build_narrative_project_scope_authority_v1(fixture.project(), &scenes)
        .expect("Native live Scope authority projection")
}

fn current_projection_token(conn: &Connection, fixture: &ColdFixture, revision: &str) -> String {
    use grimodex_core::narrative_scope_dependency_projection::{
        projection_revision, ScopeDependencyIdentity,
    };
    let key: String = conn.query_row("SELECT source_key FROM narrative_revision_source_basis WHERE revision_id=?1 AND source_kind='scope-dependency-projection-v1'",[revision],|r|r.get(0)).expect("new projection Source");
    let identity = ScopeDependencyIdentity::from_source_key(&key).expect("canonical identity");
    projection_revision(&identity, &current_native_scope_authority(conn, fixture))
        .expect("current projection")
}

fn publish_native_freshness_after_change(db: &Database) {
    let mut processed = false;
    for _ in 0..8 {
        match run_incremental_freshness_cycle(db).expect("production Native Freshness cycle") {
            IncrementalFreshnessCycleOutcome::Processed(_) => processed = true,
            IncrementalFreshnessCycleOutcome::Idle => {
                assert!(processed, "the Native change must be evaluated");
                return;
            }
            IncrementalFreshnessCycleOutcome::Held(_) => panic!("fixture cycle must not be held"),
        }
    }
    panic!("private fixture Feed did not drain within the bounded Native cycles");
}

#[test]
fn normal_ui_child_membership_retains_root_input_and_scope_control_after_cold_reopen() {
    let fixture = ColdFixture::new();
    let before = fixture.digest();
    let mut conn = fixture.read_only();
    let tx = conn.transaction().expect("coherent read snapshot");
    let project = fixture.manifest["projectId"].as_str().expect("project");
    let children = fixture.manifest["revisionIds"]
        .as_array()
        .expect("children");
    for (index, child) in children.iter().enumerate() {
        let child = child.as_str().expect("child ID");
        let root = fixture.manifest["rootRevisionIds"][index]
            .as_str()
            .expect("root ID");
        let MaterialMembershipRead::Complete(membership) =
            read_revision_material_membership(&tx, project, child).expect("membership read")
        else {
            panic!("normal UI Human child must have complete membership");
        };
        assert_eq!(membership.revision_id, child);
        assert_eq!(membership.root_revision_id, root);
        assert_eq!(membership.lineage.len(), 2);
        assert_eq!(membership.materials.len(), 9);
        assert_eq!(membership.replayed_requests.len(), 2);
        assert!(membership
            .materials
            .iter()
            .all(|material| material.source_key
                == format!(
                    "project:scene:{}",
                    fixture.manifest["s1"].as_str().expect("S1")
                )));
        assert_eq!(membership.active_scope_controls.len(), 1);
        let expected_scope_source_key: String = tx
            .query_row(
                "SELECT source_key FROM narrative_revision_source_basis
                  WHERE revision_id = ?1 AND source_kind = 'scope-dependency-projection-v1'",
                [child],
                |row| row.get(0),
            )
            .expect("persisted projection Scope control");
        assert!(expected_scope_source_key.starts_with("scope-dependency:v1:"));
        assert_eq!(
            membership.active_scope_controls[0].source_kind,
            "scope-dependency-projection-v1"
        );
        assert_eq!(
            membership.active_scope_controls[0].source_key,
            expected_scope_source_key
        );
    }
    drop(tx);
    drop(conn);
    assert_eq!(
        before,
        fixture.digest(),
        "a membership read never rewrites a cold fixture"
    );
}

#[test]
fn missing_or_mismatched_persisted_source_basis_rejects_child_and_ancestor() {
    for (case, sql) in [
        (
            "missing Source Basis observation",
            "DELETE FROM narrative_revision_source_basis WHERE revision_id = ?1 AND ordinal = 0",
        ),
        (
            "mismatched Source Basis token",
            "UPDATE narrative_revision_source_basis SET revision_token = revision_token || ':mismatch'
              WHERE revision_id = ?1 AND ordinal = 0",
        ),
    ] {
        for ancestor in [false, true] {
            let fixture = ColdFixture::new();
            let conn = fixture.corruption_connection();
            let revision = if ancestor { fixture.root() } else { fixture.child() };
            assert_eq!(conn.execute(sql, [revision]).expect(case), 1);
            assert_unavailable(&conn, &fixture, &format!("{case}; ancestor={ancestor}"));
        }
    }
}

#[test]
fn missing_or_mismatched_d1_seals_reject_child_and_ancestor() {
    for (case, sql) in [
        (
            "missing D1 head",
            "DELETE FROM narrative_dependency_declaration_heads
              WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1",
        ),
        (
            "missing D1 declaration",
            "DELETE FROM narrative_dependency_declaration_entries WHERE id = (
                SELECT e.id FROM narrative_dependency_declaration_entries e
                JOIN narrative_dependency_declaration_heads h ON h.active_declaration_set_id = e.declaration_set_id
                WHERE h.consumer_kind = 'proposal-revision' AND h.consumer_key = ?1 LIMIT 1)",
        ),
        (
            "mismatched D1 sealed digest",
            "UPDATE narrative_dependency_declaration_sets SET dependency_set_digest = printf('sha256:%064d', 0)
              WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1",
        ),
    ] {
        for ancestor in [false, true] {
            let fixture = ColdFixture::new();
            let conn = fixture.corruption_connection();
            let revision = if ancestor { fixture.root() } else { fixture.child() };
            assert_eq!(conn.execute(sql, [revision]).expect(case), 1);
            assert_unavailable(&conn, &fixture, &format!("{case}; ancestor={ancestor}"));
        }
    }
}

#[test]
fn missing_or_mismatched_v1_seals_reject_child_and_ancestor() {
    for (case, sql) in [
        (
            "missing V1 edge",
            "DELETE FROM narrative_dependency_edges WHERE id = (
                SELECT id FROM narrative_dependency_edges
                WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1 LIMIT 1)",
        ),
        (
            "mismatched V1 read token",
            "UPDATE narrative_dependency_edges SET read_set_json = '[\"different-saved-token\"]'
              WHERE id = (SELECT id FROM narrative_dependency_edges
                WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1 LIMIT 1)",
        ),
        (
            "mismatched V1 owning run",
            "UPDATE narrative_dependency_edges SET owning_run_id = 'different-owning-run'
              WHERE id = (SELECT id FROM narrative_dependency_edges
                WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1 LIMIT 1)",
        ),
    ] {
        for ancestor in [false, true] {
            let fixture = ColdFixture::new();
            let conn = fixture.corruption_connection();
            let revision = if ancestor {
                fixture.root()
            } else {
                fixture.child()
            };
            assert_eq!(conn.execute(sql, [revision]).expect(case), 1);
            assert_unavailable(&conn, &fixture, &format!("{case}; ancestor={ancestor}"));
        }
    }
}

#[test]
fn missing_immediate_parent_makes_the_whole_child_membership_unavailable() {
    let fixture = ColdFixture::new();
    let conn = fixture.corruption_connection();
    assert_eq!(
        conn.execute(
            "DELETE FROM narrative_proposal_revisions WHERE id = ?1",
            [fixture.root()]
        )
        .expect("remove parent only on private copy"),
        1
    );
    assert_unavailable(&conn, &fixture, "missing immediate parent");
}

#[test]
fn cross_proposal_or_run_parent_chain_never_publishes_complete_membership() {
    for cross_run in [false, true] {
        let fixture = ColdFixture::new();
        let conn = fixture.corruption_connection();
        let other_root = fixture.manifest["rootRevisionIds"][1]
            .as_str()
            .expect("second normal proposal root");
        let other_proposal: String = conn
            .query_row(
                "SELECT proposal_id FROM narrative_proposal_revisions WHERE id = ?1",
                [other_root],
                |row| row.get(0),
            )
            .expect("second proposal identity");
        if cross_run {
            assert_eq!(
                conn.execute(
                    "INSERT INTO narrative_proposal_sets
                        (id, run_id, project_id, set_kind, status, summary_json,
                         created_at, updated_at, version)
                     SELECT 'corrupt-cross-run-set',
                            (SELECT id FROM narrative_extraction_runs
                              WHERE project_id = s.project_id AND id <> s.run_id
                              ORDER BY id LIMIT 1),
                            s.project_id, s.set_kind, s.status, s.summary_json,
                            s.created_at, s.updated_at, s.version
                       FROM narrative_proposal_sets s JOIN narrative_proposals p
                         ON p.proposal_set_id = s.id WHERE p.id = ?1",
                    [&other_proposal],
                )
                .expect("corrupt only the private parent Run binding"),
                1
            );
            assert_eq!(
                conn.execute(
                    "UPDATE narrative_proposals SET proposal_set_id = 'corrupt-cross-run-set'
                      WHERE id = ?1",
                    [&other_proposal],
                )
                .expect("move only the private other proposal"),
                1
            );
        }
        assert_eq!(
            conn.execute(
                "UPDATE narrative_proposal_revisions SET proposal_id = ?2 WHERE id = ?1",
                params![fixture.root(), other_proposal],
            )
            .expect("corrupt the immediate parent's ownership"),
            1
        );
        let (child_proposal, parent_proposal, child_run, parent_run): (
            String,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT cp.id, pp.id, cs.run_id, ps.run_id
                   FROM narrative_proposal_revisions c
                   JOIN narrative_proposals cp ON cp.id = c.proposal_id
                   JOIN narrative_proposal_sets cs ON cs.id = cp.proposal_set_id
                   JOIN narrative_proposal_revisions p ON p.id = ?2
                   JOIN narrative_proposals pp ON pp.id = p.proposal_id
                   JOIN narrative_proposal_sets ps ON ps.id = pp.proposal_set_id
                  WHERE c.id = ?1",
                params![fixture.child(), fixture.root()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("prove the corrupted parent ownership boundary");
        assert_ne!(child_proposal, parent_proposal);
        assert_eq!(child_run != parent_run, cross_run);
        assert_unavailable(&conn, &fixture, &format!("cross-Run parent={cross_run}"));
    }
}

#[test]
fn cyclic_parent_reference_never_publishes_complete_membership() {
    let fixture = ColdFixture::new();
    let conn = fixture.corruption_connection();
    let mut envelope = load_envelope(&conn, fixture.child());
    envelope["revisionBasis"]["parentRevisionId"] = json!(fixture.child());
    rewrite_resealed_envelope(&conn, fixture.child(), &mut envelope);
    assert_unavailable(&conn, &fixture, "self-cycle in the selected parent chain");
}

#[test]
fn missing_scope_control_observation_never_publishes_complete_membership() {
    let fixture = ColdFixture::new();
    let conn = fixture.corruption_connection();
    assert_eq!(
        conn.execute(
            "DELETE FROM narrative_revision_source_basis
              WHERE revision_id = ?1 AND source_kind = 'scope-dependency-projection-v1'",
            [fixture.child()],
        )
        .expect("remove the selected Scope control only on the private copy"),
        1
    );
    assert_unavailable(
        &conn,
        &fixture,
        "missing selected Scope control observation",
    );
}

#[test]
fn missing_unselected_root_input_span_never_publishes_complete_membership() {
    let fixture = ColdFixture::new();
    let conn = fixture.corruption_connection();
    let (artifact_id, raw): (String, String) = conn
        .query_row(
            "SELECT id, payload_json FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@1'",
            [fixture.manifest["runId"].as_str().expect("fixture Run")],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("sealed whole-request root input");
    let mut snapshot: Value = serde_json::from_str(&raw).expect("snapshot JSON");
    let root = load_envelope(&conn, fixture.root());
    let selected_evidence = root["effectiveMaterialBasis"]["evidenceSet"]
        .as_array()
        .expect("selected assertion evidence");
    let catalog = snapshot["evidence"]["catalog"]["entries"]
        .as_array_mut()
        .expect("root span catalog");
    let removed_index = catalog
        .iter()
        .position(|entry| {
            !selected_evidence
                .iter()
                .any(|evidence| evidence["quote"] == entry["quote"])
        })
        .expect("an unselected root span");
    let removed = catalog.remove(removed_index);
    assert!(selected_evidence
        .iter()
        .all(|evidence| evidence["quote"] != removed["quote"]));
    {
        let tx = conn
            .unchecked_transaction()
            .expect("uncorrupted baseline snapshot");
        let MaterialMembershipRead::Complete(membership) =
            read_revision_material_membership(&tx, fixture.project(), fixture.child())
                .expect("normal whole-input membership")
        else {
            panic!("normal input must be Complete before removing its unselected span");
        };
        assert!(membership.materials.iter().any(|material| {
            material.kind == "span" && material.canonical_range == removed["canonicalRange"]
        }));
    }
    assert_eq!(
        conn.execute(
            "UPDATE narrative_extraction_artifacts SET payload_json = ?2, payload_digest = ?3
              WHERE id = ?1",
            params![
                artifact_id,
                canonical_json_string(&snapshot).expect("snapshot JSON"),
                digest(&snapshot)
            ],
        )
        .expect("remove only the private copy's unselected root input span"),
        1
    );
    assert_unavailable(
        &conn,
        &fixture,
        "unselected root span missing from sealed input",
    );
}

#[test]
fn sql_failures_remain_errors_separate_from_missing_or_corrupt_membership() {
    for table in [
        "narrative_proposal_revisions",
        "narrative_extraction_artifacts",
    ] {
        let fixture = ColdFixture::new();
        let conn = fixture.corruption_connection();
        conn.execute_batch(&format!("DROP TABLE {table}"))
            .expect("remove SQL storage only from the private error copy");
        let tx = conn
            .unchecked_transaction()
            .expect("SQL-error read snapshot");
        let error = read_revision_material_membership(&tx, fixture.project(), fixture.child())
            .expect_err("SQL failure must remain Err, never typed missing/corrupt or Complete");
        assert!(
            error.downcast_ref::<rusqlite::Error>().is_some(),
            "{table}: {error:#}"
        );
    }
}

#[test]
fn resealed_human_envelopes_must_still_match_their_parent_and_scope_control() {
    for case in [
        "parent digest mismatch",
        "root revision mismatch",
        "parent assertion digest mismatch",
        "missing inherited context",
        "changed inherited exposure",
        "changed semantic core",
        "changed-path mismatch",
        "wrong Scope scene",
        "wrong Scope resolver stage",
        "missing Scope control context",
    ] {
        let fixture = ColdFixture::new();
        let conn = fixture.corruption_connection();
        let mut envelope = load_envelope(&conn, fixture.child());
        match case {
            "parent digest mismatch" => {
                envelope["revisionBasis"]["expectedParentEnvelopeDigest"] =
                    json!(format!("sha256:{}", "0".repeat(64)));
            }
            "root revision mismatch" => {
                envelope["revisionBasis"]["rootInterpretationRevisionId"] =
                    fixture.manifest["rootRevisionIds"][1].clone();
            }
            "parent assertion digest mismatch" => {
                envelope["revisionBasis"]["parentAssertionDigest"] =
                    json!(format!("sha256:{}", "0".repeat(64)));
            }
            "missing inherited context" => {
                envelope["revisionBasis"]["derivationContextSet"]
                    .as_array_mut()
                    .expect("contexts")
                    .remove(0);
            }
            "changed inherited exposure" => {
                envelope["revisionBasis"]["derivationContextSet"][0]["exposure"] =
                    json!("deterministic-stage");
            }
            "changed semantic core" => {
                envelope["assertion"]["payload"]["summary"] = json!("A different event meaning.");
            }
            "changed-path mismatch" => {
                envelope["revisionBasis"]["derivation"]["proposalPayloadChangedPaths"] =
                    json!(["/title"]);
            }
            "wrong Scope scene" => {
                envelope["assertion"]["scope"]["scene"]["ref"] = json!(format!(
                    "scene:{}",
                    fixture.manifest["s2"].as_str().expect("S2")
                ));
            }
            "wrong Scope resolver stage" => {
                let control = envelope["revisionBasis"]["derivationContextSet"]
                    .as_array_mut()
                    .expect("contexts")
                    .last_mut()
                    .expect("Scope context");
                assert!(control.get("inheritedFromRevisionId").is_none());
                control["stageId"] = json!("narrative_event_synthesize");
            }
            "missing Scope control context" => {
                let removed = envelope["revisionBasis"]["derivationContextSet"]
                    .as_array_mut()
                    .expect("contexts")
                    .pop()
                    .expect("Scope context");
                assert_eq!(removed["stageId"], "chronicle_scene_event_scope_resolver");
                assert!(removed.get("inheritedFromRevisionId").is_none());
            }
            _ => unreachable!("enumerated corruption case"),
        }
        rewrite_resealed_envelope(&conn, fixture.child(), &mut envelope);
        assert_unavailable(&conn, &fixture, case);
    }
}

#[test]
fn project_boundary_and_read_snapshot_are_required() {
    let fixture = ColdFixture::new();
    let conn = fixture.read_only();
    assert!(read_revision_material_membership(&conn, fixture.project(), fixture.child()).is_err());
    let tx = conn
        .unchecked_transaction()
        .expect("coherent read snapshot");
    assert!(matches!(
        read_revision_material_membership(&tx, "another-project", fixture.child())
            .expect("wrong project is typed unavailable"),
        MaterialMembershipRead::Unavailable { .. }
    ));
}

#[test]
fn native_unapproved_projection_child_retains_complete_historical_membership() {
    let fixture = ColdFixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let grandchild = create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["title"] = json!("Human projection title edit");
    });
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let decisions: i64 = tx.query_row(
            "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE revision_id = ?1",
            [&grandchild],
            |row| row.get(0),
        )?;
        assert_eq!(decisions, 0, "membership does not confer Human approval");
        for (revision, expected_depth) in [(&grandchild[..], 3), (fixture.child(), 2)] {
            let MaterialMembershipRead::Complete(membership) =
                read_revision_material_membership(&tx, fixture.project(), revision)?
            else {
                panic!("unapproved projection and historical parent retain membership");
            };
            assert_eq!(membership.root_revision_id, fixture.root());
            assert_eq!(membership.lineage.len(), expected_depth);
            assert_eq!(membership.materials.len(), 9);
            assert_eq!(membership.replayed_requests.len(), 2);
            assert_eq!(membership.active_scope_controls.len(), 1);
        }
        Ok(())
    })
    .expect("projection lineage read");
}

#[test]
fn native_scope_grandchild_accepts_ancestor_with_an_older_scope_authority_token() {
    let fixture = ColdFixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let old_scope_token = db
        .with_conn(|conn| {
            assert_eq!(current_revision(conn, fixture.child()), fixture.child());
            assert_eq!(stored_freshness(conn, &fixture, fixture.child()), "fresh");
            let token = scope_token(conn, fixture.child())?;
            assert_eq!(
                token,
                current_projection_token(conn, &fixture, fixture.child())
            );
            Ok(token)
        })
        .expect("initial selected child and current Native authority");
    tree_node_patch(
        &db,
        TreeNodePatchPayload {
            project_id: fixture.project().to_owned(),
            request_id: "nir1-scope-request".to_owned(),
            session_id: "nir1-scope-session".to_owned(),
            event_uid: "nir1-scope-event".to_owned(),
            node_id: fixture.manifest["s2"].as_str().expect("S2").to_owned(),
            patch: json!({"storyTimeOrder": "nir1-later-order"})
                .as_object()
                .expect("patch")
                .clone(),
            base_version: None,
            bump_version: false,
            updated_at: "2026-09-08T06:00:00.000Z".to_owned(),
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
    .expect("production Native live Scope authority update");
    publish_native_freshness_after_change(&db);
    let new_scope_token = db
        .with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            assert_eq!(current_revision(&tx, fixture.child()), fixture.child());
            assert_eq!(stored_freshness(&tx, &fixture, fixture.child()), "fresh");
            assert_eq!(scope_token(&tx, fixture.child())?, old_scope_token);
            let current = current_native_scope_token(&tx, &fixture);
            assert_ne!(current, old_scope_token);
            let MaterialMembershipRead::Complete(membership) =
                read_revision_material_membership(&tx, fixture.project(), fixture.child())?
            else {
                panic!("the still-current stale child must retain immutable membership");
            };
            assert_eq!(membership.active_scope_controls.len(), 1);
            assert_eq!(
                membership.active_scope_controls[0].revision_token,
                old_scope_token
            );
            assert_eq!(stored_freshness(&tx, &fixture, fixture.child()), "fresh");
            Ok(current)
        })
        .expect("Complete membership does not refresh the selected stale child");
    let grandchild = create_native_child(&db, &fixture, fixture.child(), |payload| {
        assert_eq!(payload["disclosure"]["secret"], false);
        payload["disclosure"]["secret"] = json!(true);
    });
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert_eq!(current_revision(&tx, fixture.child()), grandchild);
        assert_eq!(stored_freshness(&tx, &fixture, fixture.child()), "fresh");
        assert_eq!(scope_token(&tx, fixture.child())?, old_scope_token);
        let new_projection_token = current_projection_token(&tx, &fixture, &grandchild);
        assert_eq!(scope_token(&tx, &grandchild)?, new_projection_token);
        assert_ne!(new_projection_token, new_scope_token);
        assert_eq!(current_native_scope_token(&tx, &fixture), new_scope_token);
        for (revision, expected_depth, expected_token) in [
            (&grandchild[..], 3, &new_projection_token),
            (fixture.child(), 2, &old_scope_token),
        ] {
            let MaterialMembershipRead::Complete(membership) =
                read_revision_material_membership(&tx, fixture.project(), revision)?
            else {
                panic!("older ancestor Scope tokens must not invalidate immutable membership");
            };
            assert_eq!(membership.root_revision_id, fixture.root());
            assert_eq!(membership.lineage.len(), expected_depth);
            assert_eq!(membership.materials.len(), 9);
            assert_eq!(membership.replayed_requests.len(), 2);
            assert_eq!(membership.active_scope_controls.len(), 1);
            assert_eq!(
                membership.active_scope_controls[0].revision_token,
                *expected_token
            );
        }
        assert_eq!(stored_freshness(&tx, &fixture, fixture.child()), "fresh");
        Ok(())
    })
    .expect("historical Scope lineage read");
}

#[test]
fn native_projection_then_scope_chain_retains_all_historical_material() {
    let fixture = ColdFixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let projection = create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["title"] = json!("Projection parent before a Scope edit");
    });
    let scope = create_native_child(&db, &fixture, &projection, |payload| {
        assert_eq!(payload["disclosure"]["secret"], false);
        payload["disclosure"]["secret"] = json!(true);
    });
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert_eq!(current_revision(&tx, fixture.child()), scope);
        for (revision, expected_depth) in
            [(fixture.child(), 2), (&projection[..], 3), (&scope[..], 4)]
        {
            let MaterialMembershipRead::Complete(membership) =
                read_revision_material_membership(&tx, fixture.project(), revision)?
            else {
                panic!("Scope -> projection -> Scope retains the complete sealed root input");
            };
            assert_eq!(membership.root_revision_id, fixture.root());
            assert_eq!(membership.lineage.len(), expected_depth);
            assert_eq!(membership.materials.len(), 9);
            assert_eq!(membership.replayed_requests.len(), 2);
            assert_eq!(membership.active_scope_controls.len(), 1);
            assert_eq!(
                membership.active_scope_controls[0].revision_token,
                current_projection_token(&tx, &fixture, revision)
            );
        }
        let selected_envelope = load_envelope(&tx, &scope);
        assert_eq!(
            selected_envelope["revisionBasis"]["parentRevisionId"],
            projection
        );
        assert_eq!(
            selected_envelope["revisionBasis"]["derivation"]["kind"],
            "scope-override"
        );
        assert_eq!(
            load_envelope(&tx, &projection)["revisionBasis"]["derivation"]["kind"],
            "projection-only"
        );
        Ok(())
    })
    .expect("Native projection-to-Scope lineage");
}

#[test]
fn new_nonsecret_scope_replaces_legacy_dependency_and_survives_unrelated_story_change() {
    use grimodex_db::narrative_extraction::{
        read_revision_canonical_freshness, RevisionFreshnessRead,
    };
    let fixture = ColdFixture::new();
    let db = Database::new(&fixture.path).expect("private normal-operation fixture");
    let secret = create_native_child(&db, &fixture, fixture.child(), |p| {
        p["disclosure"]["secret"] = json!(true)
    });
    let child = create_native_child(&db, &fixture, &secret, |p| {
        p["disclosure"]["secret"] = json!(false)
    });
    let projection = create_native_child(&db, &fixture, &child, |p| {
        p["title"] = json!("Inherited new Scope basis")
    });
    let original = db.with_conn(|conn| {
        let tx=conn.unchecked_transaction()?;
        for (revision,generation) in [(fixture.child(),2),(&secret,2),(&child,2),(&projection,2)] {
            let actual: i64=tx.query_row("SELECT producer_generation FROM narrative_dependency_declaration_heads WHERE consumer_kind='proposal-revision' AND consumer_key=?1",[revision],|r|r.get(0))?;
            assert_eq!(actual,generation);
        }
        let child_basis=load_envelope(&tx,&child)["effectiveMaterialBasis"].clone();
        assert_eq!(load_envelope(&tx,&projection)["effectiveMaterialBasis"],child_basis);
        assert_eq!(child_basis["evidenceSet"],load_envelope(&tx,fixture.child())["effectiveMaterialBasis"]["evidenceSet"]);
        for table in ["narrative_revision_source_basis", "narrative_dependency_edges"] {
            let (column,idcolumn)=if table == "narrative_revision_source_basis" { ("source_key","revision_id") } else { ("source_object_identity","consumer_key") };
            let count:i64=tx.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE {idcolumn}=?1 AND {column} LIKE 'project:scope-authority:%'"),[&projection],|r|r.get(0))?;
            assert_eq!(count,0,"obsolete Scope-only dependency removed from {table}");
        }
        assert!(matches!(read_revision_canonical_freshness(&tx,fixture.project(),&projection)?,RevisionFreshnessRead::Fresh(_)));
        Ok(scope_token(&tx,&projection)?)
    }).expect("new and legacy contracts coexist");
    tree_node_patch(
        &db,
        TreeNodePatchPayload {
            project_id: fixture.project().into(),
            request_id: "scope-delta-request".into(),
            session_id: "scope-delta-session".into(),
            event_uid: "scope-delta-event".into(),
            node_id: fixture.manifest["s2"].as_str().expect("S2").into(),
            patch: json!({"storyTimeOrder":"unrelated-story-order"})
                .as_object()
                .expect("patch")
                .clone(),
            base_version: None,
            bump_version: false,
            updated_at: "2026-09-08T06:00:00.000Z".into(),
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
    .expect("normal Native tree writer");
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert!(
            !matches!(
                read_revision_canonical_freshness(&tx, fixture.project(), &projection)?,
                RevisionFreshnessRead::Fresh(_)
            ),
            "pending notification still blocks old query authority"
        );
        Ok(())
    })
    .expect("pending check");
    publish_native_freshness_after_change(&db);
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert_eq!(
            scope_token(&tx, &projection)?,
            original,
            "sealed observation unchanged"
        );
        assert_eq!(
            current_projection_token(&tx, &fixture, &projection),
            original,
            "nonsecret necessary inputs unchanged"
        );
        assert_eq!(
            stored_freshness(&tx, &fixture, fixture.child()),
            "fresh",
            "nonsecret projection ignores unrelated story change"
        );
        let fresh = read_revision_canonical_freshness(&tx, fixture.project(), &projection)?;
        assert!(
            matches!(fresh, RevisionFreshnessRead::Fresh(_)),
            "new contract canonical recovery: {fresh:?}"
        );
        Ok(())
    })
    .expect("new projection re-evaluated through actual Feed");
}

#[test]
fn new_scope_detects_archived_anchor_through_native_feed_without_rewriting_history() {
    use grimodex_db::narrative_extraction::{
        read_revision_canonical_freshness, RevisionFreshnessRead,
    };
    let fixture = ColdFixture::new();
    let db = Database::new(&fixture.path).expect("private fixture");
    let secret = create_native_child(&db, &fixture, fixture.child(), |p| {
        p["disclosure"]["secret"] = json!(true)
    });
    let child = create_native_child(&db, &fixture, &secret, |p| {
        p["disclosure"]["secret"] = json!(false)
    });
    let before = db
        .with_conn(|c| Ok::<_, anyhow::Error>(load_envelope(c, &child)))
        .expect("sealed child");
    tree_node_patch(
        &db,
        TreeNodePatchPayload {
            project_id: fixture.project().into(),
            request_id: "scope-archive-request".into(),
            session_id: "scope-archive-session".into(),
            event_uid: "scope-archive-event".into(),
            node_id: fixture.manifest["s1"].as_str().expect("S1").into(),
            patch: json!({"archivedAt":"2026-09-08T06:00:00.000Z"})
                .as_object()
                .expect("patch")
                .clone(),
            base_version: None,
            bump_version: false,
            updated_at: "2026-09-08T06:00:00.000Z".into(),
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
    .expect("archive through Native writer");
    publish_native_freshness_after_change(&db);
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert_eq!(load_envelope(&tx, &child), before);
        let result = read_revision_canonical_freshness(&tx, fixture.project(), &child)?;
        assert!(
            !matches!(result, RevisionFreshnessRead::Fresh(_)),
            "archived target must fail closed"
        );
        Ok(())
    })
    .expect("canonical unavailable after archive");
}

fn patch_scope_story(db: &Database, fixture: &ColdFixture, scene: &str, story: &str, event: &str) {
    tree_node_patch(
        db,
        TreeNodePatchPayload {
            project_id: fixture.project().into(),
            request_id: format!("request-{event}"),
            session_id: "scope-story-session".into(),
            event_uid: event.into(),
            node_id: scene.into(),
            patch: json!({"storyTimeOrder":story})
                .as_object()
                .expect("patch")
                .clone(),
            base_version: None,
            bump_version: false,
            updated_at: "2026-09-08T06:00:00.000Z".into(),
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
    .expect("normal story writer");
    publish_native_freshness_after_change(db);
}

#[test]
fn new_secret_scope_becomes_stale_when_another_scene_ambiguates_its_story_key() {
    use grimodex_db::narrative_extraction::{
        read_revision_canonical_freshness, RevisionFreshnessRead,
    };
    let fixture = ColdFixture::new();
    let db = Database::new(&fixture.path).expect("private fixture");
    let anchor = fixture.manifest["s1"].as_str().expect("anchor");
    let other = fixture.manifest["s2"].as_str().expect("other");
    patch_scope_story(&db, &fixture, anchor, "10", "anchor-story-10");
    patch_scope_story(&db, &fixture, other, "30", "other-story-30");
    let secret = create_native_child(&db, &fixture, fixture.child(), |p| {
        p["disclosure"]["secret"] = json!(true)
    });
    let sealed = db
        .with_conn(|c| Ok::<_, anyhow::Error>(scope_token(c, &secret)?))
        .expect("sealed projection token");
    patch_scope_story(&db, &fixture, other, "10", "other-story-10");
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert_eq!(scope_token(&tx, &secret)?, sealed);
        assert_ne!(current_projection_token(&tx, &fixture, &secret), sealed);
        assert_eq!(stored_freshness(&tx, &fixture, &secret), "stale");
        assert!(!matches!(
            read_revision_canonical_freshness(&tx, fixture.project(), &secret)?,
            RevisionFreshnessRead::Fresh(_)
        ));
        let value: String = tx.query_row(
            "SELECT story_time_order FROM tree_nodes WHERE id=?1",
            [anchor],
            |r| r.get(0),
        )?;
        assert_eq!(
            value, "10",
            "reveal row unchanged; ambiguity was introduced by another Scene"
        );
        Ok(())
    })
    .expect("secret invalidated through normal Feed");
}
