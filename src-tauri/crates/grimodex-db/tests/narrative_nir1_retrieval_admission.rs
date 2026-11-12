//! Retrieval admission against exact normal UI cold storage and Native writers.
//! Membership, canonical Freshness, current Human review, and query Scope are
//! separate assertions; private corruption copies never manufacture positives.
//! The one exception is the BAO/1 section: no real fixture holds a scene-level
//! event, so its positives reseal an AI root (payload, Envelope, sealed plan, Plan
//! manifest) consistently, and `assert_sealed_chain_agrees` states the result.
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use grimodex_core::narrative_nir1::PackingPurpose;
use grimodex_core::{canonical_json_digest, canonical_json_string};
use grimodex_db::agent_writes::{agent_codex_create_impl, AgentCodexCreatePayload};
use grimodex_db::domain_writes::{
    project_patch, tree_node_patch, ProjectPatchPayload, TreeNodePatchPayload,
};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    narrative_extraction_append_human_decision, narrative_extraction_apply_commit,
    narrative_extraction_chronicle_bulk_approve, narrative_extraction_get_run_review_bundle,
    ChronicleBulkApprovePayload, ChronicleBulkApproveTarget, RunRefPayload,
    narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto,
    narrative_extraction_prepare_commit, narrative_extraction_redo_commit,
    narrative_extraction_undo_commit, read_and_pack_native_a2_context, read_narrative_scene_scope,
    read_revision_canonical_freshness, read_revision_material_membership,
    read_revision_retrieval_eligibility, run_incremental_freshness_cycle,
    update_narrative_scene_scope, update_narrative_scene_scope_registry, AppendDecisionPayload,
    ApplyCommitPayload, CommitApplicationRef, CommitOperation, CreateHumanDerivedRevisionRequest,
    IncrementalFreshnessCycleOutcome, MaterialMembershipRead, NarrativeAdapterIdentity,
    NarrativeSceneScopeRegistryUpdatePayload, NarrativeSceneScopeUpdatePayload,
    NativeNir1PackingRequest, NativeNir1RawContextItem, PrepareCommitPayload,
    RevisionEligibilityRead, RevisionEligibilityReason, RevisionFreshnessRead, UndoCommitPayload,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};
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
                .expect("normal cold fixture manifest");
        let compressed = include_bytes!("support/nir1-reviewed-child-cold.db.gz");
        Self::open(manifest, compressed)
    }

    /// 2 つの run を持つ fixture。run 4a2327c6 は Snapshot の文書が 2 件（D000001＝ en-distractor-gift、
    /// D000002＝ en-distractor-rumor-fact）で、承認済みの human-derived 1 件（evidence も reveal も
    /// D000002）と、unreviewed の interpretation 1 件（evidence も reveal も D000001）を持つ。
    /// manifest の形が違うため、この試験が使うキー（runId、s1、s2、revisionIds、rootRevisionIds）を
    /// 補う。s1＝D000001 の場面、s2＝D000002 の場面。
    fn two_window() -> Self {
        let mut manifest: Value =
            serde_json::from_str(include_str!("support/nir1-two-window-cold.json"))
                .expect("two-window cold fixture manifest");
        manifest["runId"] = json!("4a2327c6-8d14-4234-aae9-72ce858186a0");
        manifest["s1"] = json!("en-distractor-gift");
        manifest["s2"] = json!("en-distractor-rumor-fact");
        manifest["revisionIds"] = json!(["69760899-1f84-4d8d-a655-b574b1f277ab"]);
        manifest["rootRevisionIds"] = json!(["411f5ebc-84b4-406b-ad00-c94da2c8ccb9"]);
        let compressed = include_bytes!("support/nir1-two-window-cold.db.gz");
        Self::open(manifest, compressed)
    }

    /// The three-window cold fixture (MW/1), seen as one proposal of one Run:
    /// `s1` is a scene of its material, `s2` the scene after both folders.
    /// `crossing` picks the proposal whose cluster folds two windows (the
    /// one-scene folder's), else the three-scene folder's single-scene one.
    fn multi_window(crossing: bool) -> Self {
        let mut manifest: Value =
            serde_json::from_str(include_str!("support/nir1-multi-window-cold.json"))
                .expect("multi-window cold fixture manifest");
        let (shape, title, s1) = if crossing {
            ("long", "Ledger seals at the gate", "mw-long-scene")
        } else {
            ("three", "Writ delivered to the quay", "mw-scene-2")
        };
        let run = manifest["runs"][shape].clone();
        let proposal = run["proposals"]
            .as_array()
            .expect("proposals")
            .iter()
            .find(|p| p["title"] == title)
            .expect("proposal")
            .clone();
        manifest["runId"] = run["runId"].clone();
        manifest["s1"] = json!(s1);
        manifest["s2"] = manifest["scenes"]["after"].clone();
        manifest["revisionIds"] = json!([proposal["revisionId"]]);
        manifest["rootRevisionIds"] = json!([proposal["rootRevisionId"]]);
        let compressed = include_bytes!("support/nir1-multi-window-cold.db.gz");
        Self::open(manifest, compressed)
    }

    fn open(manifest: Value, compressed: &[u8]) -> Self {
        assert_eq!(
            hex::encode(Sha256::digest(compressed)),
            manifest["compressedDatabaseSha256"]
        );
        let mut bytes = Vec::new();
        GzDecoder::new(compressed)
            .read_to_end(&mut bytes)
            .expect("exact cold fixture bytes");
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            manifest["uncompressedDatabaseSha256"]
        );
        let path =
            std::env::temp_dir().join(format!("grimodex-nir1-admission-{}.db", Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private cold fixture copy");
        Self { path, manifest }
    }

    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }
    fn child(&self) -> &str {
        self.manifest["revisionIds"][0]
            .as_str()
            .expect("current child")
    }
    fn root(&self) -> &str {
        self.manifest["rootRevisionIds"][0]
            .as_str()
            .expect("historical root")
    }
    fn scene(&self, key: &str) -> &str {
        self.manifest[key].as_str().expect("fixture Scene")
    }
    fn read_only(&self) -> Connection {
        Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read-only cold fixture")
    }
    fn digest(&self) -> String {
        hex::encode(Sha256::digest(
            std::fs::read(&self.path).expect("cold DB bytes"),
        ))
    }
    fn corruption_connection(&self) -> Connection {
        let conn = Connection::open(&self.path).expect("private corruption copy");
        conn.execute_batch(
            "DROP TRIGGER narrative_revision_envelope_immutable_update;
             DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard;",
        )
        .expect("remove guards only on the private negative copy");
        conn
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

fn assert_unavailable(conn: &mut Connection, fixture: &Fixture, revision: &str, query_scene: &str) {
    let mut tx = grimodex_db::ScopedTransaction::begin(conn).expect("coherent negative retrieval snapshot");
    let actual = read_revision_retrieval_eligibility(&mut tx, fixture.project(), revision, query_scene)
        .expect("retrieval denial is typed unavailable");
    assert!(
        matches!(actual, RevisionEligibilityRead::Unavailable { .. }),
        "revision {revision}, query {query_scene}: {actual:?}"
    );
}

fn assert_eligible(conn: &mut Connection, fixture: &Fixture, revision: &str) {
    let mut tx = grimodex_db::ScopedTransaction::begin(conn).expect("coherent positive retrieval snapshot");
    let actual =
        read_revision_retrieval_eligibility(&mut tx, fixture.project(), revision, fixture.scene("s2"))
            .expect("retrieval eligibility read");
    assert!(
        matches!(actual, RevisionEligibilityRead::Eligible(_)),
        "Native positive: {actual:?}"
    );
}

fn assert_complete_and_fresh(conn: &mut Connection, fixture: &Fixture, revision: &str) {
    let mut tx = grimodex_db::ScopedTransaction::begin(conn).expect("independent membership and Freshness snapshot");
    let membership = read_revision_material_membership(&tx, fixture.project(), revision)
        .expect("typed material membership");
    assert!(
        matches!(membership, MaterialMembershipRead::Complete(_)),
        "membership: {membership:?}"
    );
    let freshness = read_revision_canonical_freshness(&mut tx, fixture.project(), revision)
        .expect("canonical revision Freshness");
    assert!(
        matches!(freshness, RevisionFreshnessRead::Fresh(_)),
        "canonical Freshness: {freshness:?}"
    );
}

fn native_packing_request_for_revision(
    fixture: &Fixture,
    revision_id: &str,
    atomic_group: &str,
    budget_tokens: usize,
) -> NativeNir1PackingRequest {
    NativeNir1PackingRequest {
        project_id: fixture.project().to_owned(),
        revision_id: revision_id.to_owned(),
        query_scene_id: fixture.scene("s2").to_owned(),
        budget_tokens,
        purpose: PackingPurpose::Writing,
        atomic_group: atomic_group.to_owned(),
        raw_items: vec![NativeNir1RawContextItem {
            id: "nir1-db-adapter-raw".into(),
            text: "Raw context".into(),
            tokens: 1,
        }],
    }
}

fn native_packing_request(
    fixture: &Fixture,
    atomic_group: &str,
    budget_tokens: usize,
) -> NativeNir1PackingRequest {
    native_packing_request_for_revision(fixture, fixture.child(), atomic_group, budget_tokens)
}

fn proposal_id(conn: &Connection, revision: &str) -> String {
    conn.query_row(
        "SELECT proposal_id FROM narrative_proposal_revisions WHERE id = ?1",
        [revision],
        |row| row.get(0),
    )
    .expect("revision proposal owner")
}

fn saved_canonical_state(conn: &Connection, revision: &str) -> (String, String) {
    conn.query_row(
        "SELECT evidence_freshness, build_action FROM narrative_consumer_freshness
          WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1",
        [revision],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("stored canonical revision state")
}

fn try_create_native_child(
    db: &Database,
    fixture: &Fixture,
    parent: &str,
    edit: impl FnOnce(&mut Value),
) -> anyhow::Result<String> {
    let (proposal_id, envelope_digest, payload): (String, String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT proposal_id, reconciliation_envelope_digest, payload_json
               FROM narrative_proposal_revisions WHERE id = ?1",
                [parent],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("Native parent request inputs");
    let mut payload: Value = serde_json::from_str(&payload).expect("parent payload");
    edit(&mut payload);
    let saved = narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto(
        db, fixture.project(), CreateHumanDerivedRevisionRequest {
            proposal_id,
            expected_current_revision_id: parent.to_owned(),
            parent_revision_id: parent.to_owned(),
            expected_parent_envelope_digest: envelope_digest,
            proposal_payload: payload,
            adapter: NarrativeAdapterIdentity { id: "chronicle.scene-event".to_owned(), version: "1".to_owned() },
            surface_id: "chronicle-review".to_owned(),
        },
    )?;
    Ok(saved["revisionId"]
        .as_str()
        .expect("Native child ID")
        .to_owned())
}

fn create_native_child(
    db: &Database,
    fixture: &Fixture,
    parent: &str,
    edit: impl FnOnce(&mut Value),
) -> String {
    try_create_native_child(db, fixture, parent, edit)
        .expect("production Native C2B child creation")
}

fn native_human_decision(
    db: &Database,
    fixture: &Fixture,
    revision: &str,
    decision: &str,
) -> String {
    let proposal = db
        .with_conn(|conn| Ok(proposal_id(conn, revision)))
        .expect("proposal owner");
    let choice = match decision {
        "approved" => "create-as-new",
        "rejected" => "skip-as-same",
        "held" => "hold",
        _ => panic!("test uses explicit review decisions"),
    };
    let saved = narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: fixture.manifest["runId"]
                .as_str()
                .expect("owning Run")
                .to_owned(),
            project_id: fixture.project().to_owned(),
            proposal_id: proposal.clone(),
            revision_id: revision.to_owned(),
            decision: decision.to_owned(),
            decision_json: Some(json!({"probableDuplicateChoice":choice})),
            created_by: Some("nir1-retrieval-test".to_owned()),
        },
    )
    .expect("production Native current Human decision");
    let id = saved["decisionId"]
        .as_str()
        .expect("Native decision ID")
        .to_owned();
    db.with_conn(|conn| {
        let stored: (String, String, String, String, String) = conn.query_row(
            "SELECT revision_id, decision, actor_kind, actor_id, authority_scope
               FROM narrative_proposal_decisions WHERE id = ?1",
            [&id],
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
            stored,
            (
                revision.to_owned(),
                decision.to_owned(),
                "human".to_owned(),
                "electron:human-review".to_owned(),
                format!(
                    "project/{}/proposal/{proposal}/revision/{revision}",
                    fixture.project()
                )
            )
        );
        Ok(())
    })
    .expect("Native actor and exact authority scope");
    id
}

fn seed_invalidation_probe(db: &Database, project: &str) {
    // A cache-shaped diagnostic row only: no canonical/D1/native proof is
    // constructed and no test treats this as an admitted search generation.
    db.with_conn(|conn| {
        conn.execute("INSERT INTO narrative_semantic_index_metadata
          (project_id,index_key,generation,built_at,source_digest,dependency_set_digest,dirty_cache_flag)
          VALUES (?1,'nir1-reviewed-chronicle:v1',7,'2026-09-08T00:00:00.000Z','probe','probe',0)",[project])?;
        Ok(())
    }).expect("isolated invalidation probe");
}

fn index_probe(db: &Database, project: &str) -> (i64, bool) {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT generation,dirty_cache_flag FROM narrative_semantic_index_metadata
        WHERE project_id=?1 AND index_key='nir1-reviewed-chronicle:v1'",
            [project],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    })
    .expect("cache generation and dirty state")
}

#[test]
fn native_decision_suspends_index_with_the_same_commit_and_preserves_sealed_generation() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("native fixture");
    seed_invalidation_probe(&db, fixture.project());
    native_human_decision(&db, &fixture, fixture.child(), "held");
    assert_eq!(index_probe(&db, fixture.project()), (7, true));
    db.with_conn_mut(|conn| {
        assert_unavailable(conn, &fixture, fixture.child(), fixture.scene("s2"));
        Ok(())
    })
    .expect("withdrawn revision cannot be admitted");
}

#[test]
fn native_source_and_scope_writers_suspend_the_whole_index() {
    for patch in [
        json!({"content":"changed source"}),
        json!({"sortOrder":"zzzz"}),
        json!({"archivedAt":"2026-09-08T00:00:00.000Z"}),
    ] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("native fixture");
        seed_invalidation_probe(&db, fixture.project());
        native_patch_node(&db, &fixture, fixture.scene("s1"), patch, false);
        assert_eq!(index_probe(&db, fixture.project()), (7, true));
    }
}

#[test]
fn native_child_promotion_suspends_index_before_its_separate_human_approval() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("native fixture");
    seed_invalidation_probe(&db, fixture.project());
    let child = create_native_child(&db, &fixture, fixture.child(), |p| {
        p["title"] = json!("新しい題")
    });
    assert_ne!(child, fixture.child());
    assert_eq!(index_probe(&db, fixture.project()), (7, true));
}

#[test]
fn failed_index_suspension_rolls_back_the_human_decision_and_status() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("native fixture");
    seed_invalidation_probe(&db, fixture.project());
    let (proposal,before): (String,i64)=db.with_conn(|conn|{
        let proposal=proposal_id(conn,fixture.child());
        let count=conn.query_row("SELECT COUNT(*) FROM narrative_proposal_decisions",[],|r|r.get(0))?;
        conn.execute_batch("CREATE TRIGGER reject_nir1_suspend BEFORE UPDATE ON narrative_semantic_index_metadata
          BEGIN SELECT RAISE(ABORT,'nir1-test-suspension-failure'); END;")?;
        Ok((proposal,count))
    }).expect("private transactional failure injection");
    let result = narrative_extraction_append_human_decision(
        &db,
        AppendDecisionPayload {
            run_id: fixture.manifest["runId"].as_str().expect("run").into(),
            project_id: fixture.project().into(),
            proposal_id: proposal.clone(),
            revision_id: fixture.child().into(),
            decision: "held".into(),
            decision_json: Some(json!({"probableDuplicateChoice":"hold"})),
            created_by: None,
        },
    );
    let error = result.expect_err("suspension failure must reject the complete mutation");
    assert!(format!("{error:#}").contains("nir1-test-suspension-failure"));
    assert_eq!(index_probe(&db, fixture.project()), (7, false));
    db.with_conn(|conn| {
        assert!(conn.is_autocommit());
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_decisions",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            before
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM narrative_proposals WHERE id=?1",
                [proposal],
                |r| r.get::<_, String>(0)
            )?,
            "approved"
        );
        Ok(())
    })
    .expect("decision and status rollback together");
}

fn native_patch_node(
    db: &Database,
    fixture: &Fixture,
    scene: &str,
    patch: Value,
    retain_body_token: bool,
) {
    // Native guarantees a `bumpVersion=false` patch moves `updated_at` strictly
    // forward, so a production patch cannot keep the body Source token. To keep
    // the observation (equal token, Feed identity decides), write through the
    // production patch and then restore `updated_at` directly (test-only).
    let previous_updated_at: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT updated_at FROM tree_nodes WHERE id = ?1",
                [scene],
                |row| row.get(0),
            )?)
        })
        .expect("retain unaffected body source coordinates");
    let updated_at = if retain_body_token {
        previous_updated_at.clone()
    } else {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let id = Uuid::new_v4().to_string();
    tree_node_patch(
        db,
        TreeNodePatchPayload {
            project_id: fixture.project().to_owned(),
            request_id: format!("nir1-admission-{id}"),
            session_id: "nir1-admission-session".to_owned(),
            event_uid: id,
            node_id: scene.to_owned(),
            patch: patch.as_object().expect("Native node patch").clone(),
            base_version: None,
            bump_version: !retain_body_token,
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
    .expect("production Native source/order mutation");
    if retain_body_token {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![previous_updated_at, scene],
            )?;
            Ok(())
        })
        .expect("test-only restore of the body Source token");
    }
}

fn native_set_mode(db: &Database, fixture: &Fixture, mode: &str) {
    let (current_mode, base_updated_at): (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT phase_resolution_mode, updated_at FROM projects WHERE id = ?1",
                [fixture.project()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("current project mode and OCC token");
    if current_mode == mode {
        return;
    }
    let id = Uuid::new_v4().to_string();
    project_patch(
        db,
        ProjectPatchPayload {
            project_id: fixture.project().to_owned(),
            request_id: format!("nir1-mode-{id}"),
            session_id: "nir1-admission-session".to_owned(),
            event_uid: id,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            base_updated_at,
            updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            patch: json!({"phaseResolutionMode":mode})
                .as_object()
                .expect("mode patch")
                .clone(),
        },
    )
    .expect("production Native project query mode update");
}

fn update_live_scene_scope(
    db: &Database,
    fixture: &Fixture,
    scene_id: &str,
    request_id: &str,
    mutate: impl FnOnce(&mut Value),
) {
    let current = db.with_read_transaction(|conn| {
        read_narrative_scene_scope(conn, fixture.project(), scene_id)
    }).expect("read Native scene scope before update");
    let mut scope = json!({
        "schemaVersion": current.binding.schema_version,
        "compatibilityMarker": current.binding.compatibility_marker,
        "queryIdentity": current.binding.query_identity,
        "materialConstraint": current.binding.material_constraint,
        "knowledgeHolder": current.binding.knowledge_holder,
        "audience": current.binding.audience,
    });
    mutate(&mut scope);
    let scope = serde_json::from_value(scope).expect("typed Native scene scope update");
    update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: fixture.project().to_owned(),
            scene_id: scene_id.to_owned(),
            request_id: request_id.to_owned(),
            session_id: "nir1-admission-session".to_owned(),
            event_uid: format!("{request_id}-event"),
            base_version: current.binding.version,
            updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            scope,
        },
    )
    .expect("Native scene scope update");
}

fn drain_native_feed(db: &Database) {
    let mut processed = false;
    for _ in 0..8 {
        match run_incremental_freshness_cycle(db).expect("production Native Freshness cycle") {
            IncrementalFreshnessCycleOutcome::Processed(_) => processed = true,
            IncrementalFreshnessCycleOutcome::Idle => {
                assert!(processed, "Native changes must have been evaluated");
                return;
            }
            IncrementalFreshnessCycleOutcome::Held(_) => panic!("private fixture cannot be held"),
        }
    }
    panic!("private Feed did not drain within the bounded cycles");
}

fn native_fresh_nonsecret_child(db: &Database, fixture: &Fixture) -> String {
    let secret = create_native_child(db, fixture, fixture.child(), |payload| {
        assert_eq!(payload["disclosure"]["secret"], false);
        payload["disclosure"]["secret"] = json!(true);
    });
    let current = create_native_child(db, fixture, &secret, |payload| {
        assert_eq!(payload["disclosure"]["secret"], true);
        payload["disclosure"]["secret"] = json!(false);
    });
    native_human_decision(db, fixture, &current, "approved");
    current
}

fn rewrite_resealed_scope(conn: &Connection, revision: &str, axis: &str, replacement: Value) {
    let raw: String = conn
        .query_row(
            "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
            [revision],
            |row| row.get(0),
        )
        .expect("saved Scope envelope");
    let mut envelope: Value = serde_json::from_str(&raw).expect("Envelope JSON");
    envelope["assertion"]["scope"][axis] = replacement;
    let scope_digest =
        canonical_json_digest(&envelope["assertion"]["scope"]).expect("Scope digest");
    envelope["assertionDigests"]["scopeDigest"] = json!(scope_digest);
    envelope["assertionDigests"]["assertionDigest"] = json!(canonical_json_digest(&json!({
        "assertionCoreDigest":envelope["assertionDigests"]["assertionCoreDigest"],
        "scopeDigest":scope_digest,
    }))
    .expect("assertion digest"));
    assert_eq!(
        conn.execute(
            "UPDATE narrative_proposal_revisions SET reconciliation_envelope_json = ?2,
                reconciliation_envelope_digest = ?3 WHERE id = ?1",
            params![
                revision,
                canonical_json_string(&envelope).expect("canonical Envelope"),
                canonical_json_digest(&envelope).expect("Envelope digest")
            ],
        )
        .expect("reseal only the private invalid-lineage Scope copy"),
        1
    );
}

#[test]
fn normal_current_human_approved_child_is_eligible_for_distinct_later_s2() {
    let fixture = Fixture::new();
    let before = fixture.digest();
    let mut conn = fixture.read_only();
    let mut tx = grimodex_db::ScopedTransaction::begin(&mut conn).expect("coherent retrieval read snapshot");
    let actual = read_revision_retrieval_eligibility(
        &mut tx,
        fixture.project(),
        fixture.child(),
        fixture.scene("s2"),
    )
    .expect("public Rust retrieval admission");
    assert!(
        matches!(actual, RevisionEligibilityRead::Eligible(_)),
        "normal approved child: {actual:?}"
    );
    drop(tx);
    drop(conn);
    assert_eq!(
        fixture.digest(),
        before,
        "admission writes no receipt, state, or approval"
    );
}

#[test]
fn native_a2_packing_rejects_chronicle_revision_without_typed_reader() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let request = native_packing_request(&fixture, "nir1-db-adapter", 4096);
    let error = read_and_pack_native_a2_context(&db, request)
        .err()
        .expect("Chronicle revisions are outside the typed Entity/Relation adapter");
    assert!(
        error.to_string().contains("NIR1_NATIVE_A2_UNAVAILABLE"),
        "typed Native reader denial: {error:#}"
    );
}

#[test]
fn native_worldline_only_scope_change_denies_old_revision_after_feed_and_cold_reopen() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let initial_scope = db
        .with_read_transaction(|conn| {
            read_narrative_scene_scope(conn, fixture.project(), fixture.scene("s1"))
        })
        .expect("read Native registry before alternate worldline");
    let mut registry = initial_scope.registry.clone();
    registry.worldline_refs.push("worldline:alternate".to_owned());
    update_narrative_scene_scope_registry(
        &db,
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: fixture.project().to_owned(),
            request_id: "nir1-worldline-alternate-registry".to_owned(),
            session_id: "nir1-admission-session".to_owned(),
            event_uid: "nir1-worldline-alternate-registry-event".to_owned(),
            base_version: initial_scope.registry_revision,
            updated_at: "2026-09-14T00:10:00.000Z".to_owned(),
            registry,
        },
    )
    .expect("Native alternate worldline registry update");

    let current = native_fresh_nonsecret_child(&db, &fixture);
    drain_native_feed(&db);
    db.with_conn_mut(|conn| {
        assert_complete_and_fresh(conn, &fixture, &current);
        assert_eligible(conn, &fixture, &current);
        Ok(())
    })
    .expect("baseline eligibility");

    let source_before: String = db.with_conn(|conn| Ok(conn.query_row(
        "SELECT content FROM tree_nodes WHERE id = ?1", [fixture.scene("s1")], |row| row.get(0),
    )?))
        .expect("material body before scope mutation");
    update_live_scene_scope(
        &db,
        &fixture,
        fixture.scene("s1"),
        "nir1-worldline-only-scope-mutation",
        |scope| {
            scope["materialConstraint"]["worldline"] =
                json!({"kind":"exact","ref":"worldline:alternate"});
        },
    );
    let source_after: String = db.with_conn(|conn| Ok(conn.query_row(
        "SELECT content FROM tree_nodes WHERE id = ?1", [fixture.scene("s1")], |row| row.get(0),
    )?))
        .expect("material body after scope mutation");
    assert_eq!(source_after, source_before, "worldline-only mutation changes no body");
    drain_native_feed(&db);

    let cold_db = Database::new(&fixture.path).expect("cold Database reopen");
    for database in [&db, &cold_db] {
        database.with_conn_mut(|conn| {
            let mut tx = grimodex_db::ScopedTransaction::begin(conn)?;
            let actual = read_revision_retrieval_eligibility(
                &mut tx,
                fixture.project(),
                &current,
                fixture.scene("s2"),
            )?;
            assert!(matches!(
                actual,
                RevisionEligibilityRead::Unavailable {
                    reason: RevisionEligibilityReason::ScopeUnsupported
                }
            ));
            let old_vectors: i64 = tx.query_row(
                "SELECT COUNT(*) FROM narrative_nir1_chronicle_vectors
                  WHERE project_id = ?1 AND revision_id = ?2",
                params![fixture.project(), &current],
                |row| row.get(0),
            )?;
            assert_eq!(old_vectors, 0, "cold reopen cannot restore old IR vector");
            Ok(())
        })
        .expect("worldline-only revision remains denied after feed and reopen");
    }
}

#[test]
fn native_character_material_principal_is_only_scope_unsupported_after_fresh_approval() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let character_id = "nir1-scope-principal-character";
    agent_codex_create_impl(
        &db,
        AgentCodexCreatePayload {
            request_id: Some("nir1-scope-principal-character-create".to_owned()),
            entry_id: Some(character_id.to_owned()),
            project_id: fixture.project().to_owned(),
            session_id: "nir1-admission-session".to_owned(),
            surface: Some("manual".to_owned()),
            type_slug: "character".to_owned(),
            name: "NIR1 Scope Principal".to_owned(),
            summary: Some(String::new()),
            content: Some("{}".to_owned()),
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
        },
    )
    .expect("production Codex character create");
    update_live_scene_scope(
        &db,
        &fixture,
        fixture.scene("s1"),
        "nir1-character-principal-scope",
        |scope| {
            scope["knowledgeHolder"] = json!({"kind":"character","ref":character_id});
        },
    );

    let current = native_fresh_nonsecret_child(&db, &fixture);
    drain_native_feed(&db);
    db.with_conn_mut(|conn| {
        assert_complete_and_fresh(conn, &fixture, &current);
        let mut tx = grimodex_db::ScopedTransaction::begin(conn)?;
        let actual = read_revision_retrieval_eligibility(
            &mut tx,
            fixture.project(),
            &current,
            fixture.scene("s2"),
        )?;
        assert!(matches!(
            actual,
            RevisionEligibilityRead::Unavailable {
                reason: RevisionEligibilityReason::ScopeUnsupported
            }
        ));
        Ok(())
    })
    .expect("only unsupported material principal denies the fresh approved child");
}

#[test]
fn retrieval_requires_a_caller_owned_read_transaction() {
    let fixture = Fixture::new();
    let mut conn = fixture.read_only();
    assert!(read_revision_retrieval_eligibility(
        &mut conn,
        fixture.project(),
        fixture.child(),
        fixture.scene("s2"),
    )
    .is_err());
}

#[test]
fn same_missing_or_absent_query_scene_cannot_admit_a_fresh_approved_child() {
    let fixture = Fixture::new();
    let mut conn = fixture.read_only();
    assert_complete_and_fresh(&mut conn, &fixture, fixture.child());
    for query in [fixture.scene("s1"), "missing-query-scene", ""] {
        assert_unavailable(&mut conn, &fixture, fixture.child(), query);
    }
}

#[test]
fn a_foreign_project_cannot_read_another_projects_approved_revision() {
    let fixture = Fixture::new();
    let mut conn = fixture.read_only();
    let mut tx = grimodex_db::ScopedTransaction::begin(&mut conn).expect("cross-project read snapshot");
    let actual = read_revision_retrieval_eligibility(
        &mut tx,
        "another-project",
        fixture.child(),
        fixture.scene("s2"),
    )
    .expect("foreign project is typed unavailable");
    assert!(matches!(
        actual,
        RevisionEligibilityRead::Unavailable { .. }
    ));
}

#[test]
fn a_complete_fresh_historical_root_is_not_the_current_approved_child() {
    let fixture = Fixture::new();
    let mut conn = fixture.read_only();
    assert_complete_and_fresh(&mut conn, &fixture, fixture.root());
    let current: String = conn
        .query_row(
            "SELECT p.current_revision_id FROM narrative_proposals p
          JOIN narrative_proposal_revisions r ON r.proposal_id = p.id WHERE r.id = ?1",
            [fixture.root()],
            |row| row.get(0),
        )
        .expect("historical root current pointer");
    assert_eq!(current, fixture.child());
    assert_ne!(current, fixture.root());
    assert_unavailable(&mut conn, &fixture, fixture.root(), fixture.scene("s2"));
}

#[test]
fn a_native_projection_child_requires_its_own_current_human_approval() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let child = create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["title"] = json!("A Human projection requiring its own review");
    });
    db.with_conn_mut(|conn| {
        assert_complete_and_fresh(conn, &fixture, &child);
        let decisions: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE revision_id = ?1",
            [&child],
            |row| row.get(0),
        )?;
        assert_eq!(decisions, 0);
        assert_unavailable(conn, &fixture, &child, fixture.scene("s2"));
        Ok(())
    })
    .expect("a parent's approval cannot authorize a new Native child");
    native_human_decision(&db, &fixture, &child, "approved");
    db.with_conn_mut(|conn| {
        assert_complete_and_fresh(conn, &fixture, &child);
        assert_eligible(conn, &fixture, &child);
        assert_complete_and_fresh(conn, &fixture, fixture.child());
        assert_unavailable(conn, &fixture, fixture.child(), fixture.scene("s2"));
        Ok(())
    })
    .expect("current approved child is eligible while the approved ancestor is historical");
}

#[test]
fn native_withdrawal_of_the_own_review_denies_the_still_complete_fresh_child() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let withdrawal = native_human_decision(&db, &fixture, fixture.child(), "rejected");
    db.with_conn_mut(|conn| {
        assert_complete_and_fresh(conn, &fixture, fixture.child());
        let (status, decision): (String, String) = conn.query_row(
            "SELECT p.status, d.decision FROM narrative_proposals p
              JOIN narrative_proposal_decisions d ON d.proposal_id = p.id WHERE d.id = ?1",
            [&withdrawal],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(
            (status.as_str(), decision.as_str()),
            ("rejected", "rejected")
        );
        assert_unavailable(conn, &fixture, fixture.child(), fixture.scene("s2"));
        Ok(())
    })
    .expect("withdrawal affects admission without destroying historical membership");
}

#[test]
fn an_approved_status_does_not_replace_exact_human_actor_revision_and_scope() {
    for case in [
        "actor-kind",
        "actor-id",
        "scope-project",
        "scope-proposal",
        "scope-revision",
        "scope-suffix",
        "decision-revision",
    ] {
        let fixture = Fixture::new();
        let mut conn = fixture.corruption_connection();
        let proposal = proposal_id(&conn, fixture.child());
        let expected = format!(
            "project/{}/proposal/{proposal}/revision/{}",
            fixture.project(),
            fixture.child()
        );
        let (column, value) = match case {
            "actor-kind" => ("actor_kind", "automated".to_owned()),
            "actor-id" => ("actor_id", "electron:automated-review".to_owned()),
            "scope-project" => (
                "authority_scope",
                format!(
                    "project/foreign/proposal/{proposal}/revision/{}",
                    fixture.child()
                ),
            ),
            "scope-proposal" => (
                "authority_scope",
                format!(
                    "project/{}/proposal/foreign/revision/{}",
                    fixture.project(),
                    fixture.child()
                ),
            ),
            "scope-revision" => (
                "authority_scope",
                format!(
                    "project/{}/proposal/{proposal}/revision/{}",
                    fixture.project(),
                    fixture.root()
                ),
            ),
            "scope-suffix" => ("authority_scope", format!("{expected}/extra")),
            "decision-revision" => ("revision_id", fixture.root().to_owned()),
            _ => unreachable!("enumerated private decision corruption"),
        };
        assert_eq!(
            conn.execute(
                &format!(
                    "UPDATE narrative_proposal_decisions SET {column} = ?2 WHERE id = (
                SELECT id FROM narrative_proposal_decisions WHERE proposal_id = ?1
                ORDER BY created_at DESC, id DESC LIMIT 1)"
                ),
                params![proposal, value],
            )
            .expect("corrupt only the private latest decision"),
            1
        );
        let status: String = conn
            .query_row(
                "SELECT status FROM narrative_proposals WHERE id = ?1",
                [&proposal],
                |row| row.get(0),
            )
            .expect("approved status remains stored");
        assert_eq!(status, "approved");
        assert_complete_and_fresh(&mut conn, &fixture, fixture.child());
        assert_unavailable(&mut conn, &fixture, fixture.child(), fixture.scene("s2"));
    }
}

#[test]
fn missing_current_decision_denies_even_with_an_approved_proposal_status() {
    let fixture = Fixture::new();
    let mut conn = fixture.corruption_connection();
    assert_eq!(
        conn.execute(
            "DELETE FROM narrative_proposal_decisions WHERE revision_id = ?1",
            [fixture.child()]
        )
        .expect("remove only the private approval row"),
        1
    );
    assert_complete_and_fresh(&mut conn, &fixture, fixture.child());
    assert_unavailable(&mut conn, &fixture, fixture.child(), fixture.scene("s2"));
}

#[test]
fn a_native_secret_scope_child_stays_ineligible_after_its_own_human_approval() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let secret = create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["disclosure"]["secret"] = json!(true);
    });
    native_human_decision(&db, &fixture, &secret, "approved");
    db.with_conn_mut(|conn| {
        assert_complete_and_fresh(conn, &fixture, &secret);
        assert_unavailable(conn, &fixture, &secret, fixture.scene("s2"));
        Ok(())
    })
    .expect("approval does not override the secret admission constraint");
}

#[test]
fn effective_story_queries_reject_a_new_current_nonsecret_fresh_approved_child() {
    for mode in ["story", "auto"] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        native_patch_node(
            &db,
            &fixture,
            fixture.scene("s1"),
            json!({"storyTimeOrder":"a0"}),
            true,
        );
        native_patch_node(
            &db,
            &fixture,
            fixture.scene("s2"),
            json!({"storyTimeOrder":"a1"}),
            true,
        );
        native_set_mode(&db, &fixture, mode);
        drain_native_feed(&db);
        let current = native_fresh_nonsecret_child(&db, &fixture);
        db.with_conn_mut(|conn| {
            let (stored_mode, explicit_story_scenes): (String, i64) = conn.query_row(
                "SELECT phase_resolution_mode, (SELECT COUNT(*) FROM tree_nodes
                  WHERE project_id = ?1 AND node_type = 'scene' AND archived_at IS NULL
                    AND story_time_order IS NOT NULL) FROM projects WHERE id = ?1",
                [fixture.project()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(stored_mode, mode);
            assert_eq!(
                explicit_story_scenes, 2,
                "auto has complete explicit story coverage"
            );
            assert_complete_and_fresh(conn, &fixture, &current);
            assert_unavailable(conn, &fixture, &current, fixture.scene("s2"));
            Ok(())
        })
        .expect("effective story is unsupported independently of canonical Freshness");
    }
}

#[test]
fn material_after_the_query_is_denied_even_after_native_fresh_scope_and_approval() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    native_patch_node(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({"sortOrder":"Zz"}),
        false,
    );
    drain_native_feed(&db);
    let current = native_fresh_nonsecret_child(&db, &fixture);
    db.with_conn_mut(|conn| {
        let query_before_source: bool = conn.query_row(
            "SELECT q.sort_order < parent.sort_order FROM tree_nodes q
              JOIN tree_nodes s ON s.id = ?2 JOIN tree_nodes parent ON parent.id = s.parent_id
             WHERE q.id = ?1",
            params![fixture.scene("s2"), fixture.scene("s1")],
            |row| row.get(0),
        )?;
        assert!(
            query_before_source,
            "S2 now precedes S1's root folder in Reading order"
        );
        assert_complete_and_fresh(conn, &fixture, &current);
        assert_unavailable(conn, &fixture, &current, fixture.scene("s2"));
        Ok(())
    })
    .expect("future material is denied by retrieval Scope after Freshness is restored");
}

#[test]
fn native_source_scope_archive_and_order_changes_deny_before_and_after_evaluation() {
    for case in [
        "source-body",
        "source-archived",
        "scope-story",
        "reading-order",
    ] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        let (scene, patch) = match case {
            "source-body" => (
                fixture.scene("s1"),
                json!({"content":"The Native source has changed."}),
            ),
            "source-archived" => (
                fixture.scene("s1"),
                json!({"archivedAt":"2026-09-08T09:00:00.000Z"}),
            ),
            "scope-story" => (fixture.scene("s2"), json!({"storyTimeOrder":"z9"})),
            "reading-order" => (fixture.scene("s2"), json!({"sortOrder":"Zz"})),
            _ => unreachable!("enumerated Native mutation"),
        };
        native_patch_node(&db, &fixture, scene, patch, false);
        db.with_conn_mut(|conn| {
            assert_eq!(
                saved_canonical_state(conn, fixture.child()),
                ("fresh".to_owned(), "none".to_owned())
            );
            assert_unavailable(conn, &fixture, fixture.child(), fixture.scene("s2"));
            Ok(())
        })
        .expect("saved fresh summary does not create an admission window after Native mutation");
        drain_native_feed(&db);
        db.with_conn_mut(|conn| {
            match case {
                "source-body" | "source-archived" => {
                    assert_ne!(saved_canonical_state(conn, fixture.child()).0, "fresh");
                    assert_unavailable(conn, &fixture, fixture.child(), fixture.scene("s2"));
                }
                "scope-story" => {
                    assert_eq!(
                        saved_canonical_state(conn, fixture.child()),
                        ("fresh".to_owned(), "none".to_owned())
                    );
                    assert_eligible(conn, &fixture, fixture.child());
                }
                "reading-order" => {
                    assert_eq!(
                        saved_canonical_state(conn, fixture.child()),
                        ("fresh".to_owned(), "none".to_owned())
                    );
                    let mut tx = grimodex_db::ScopedTransaction::begin(conn)?;
                    let actual = read_revision_retrieval_eligibility(
                        &mut tx,
                        fixture.project(),
                        fixture.child(),
                        fixture.scene("s2"),
                    )?;
                    assert!(matches!(
                        actual,
                        RevisionEligibilityRead::Unavailable {
                            reason: RevisionEligibilityReason::SourceNotBeforeQuery
                        }
                    ));
                }
                _ => unreachable!("enumerated Native mutation"),
            }
            Ok(())
        })
        .expect("stored canonical state is re-evaluated for the Native mutation");
    }
}

#[test]
fn resealed_unresolved_or_mismatched_scope_cannot_bypass_immutable_lineage_validation() {
    for case in [
        "unresolved-scene",
        "unresolved-reading",
        "different-exact-scene",
    ] {
        let fixture = Fixture::new();
        let mut conn = fixture.corruption_connection();
        let (axis, replacement) = match case {
            "unresolved-scene" => (
                "scene",
                json!({"kind":"unresolved","constraintId":"scene:unresolved","reason":"not-provided"}),
            ),
            "unresolved-reading" => (
                "readingOrder",
                json!({"kind":"unresolved","constraintId":"reading:unresolved","reason":"not-provided"}),
            ),
            "different-exact-scene" => (
                "scene",
                json!({"kind":"exact","ref":format!("scene:{}", fixture.scene("s2"))}),
            ),
            _ => unreachable!("enumerated private Scope corruption"),
        };
        rewrite_resealed_scope(&conn, fixture.child(), axis, replacement);
        // These are deliberately invalid historical derivations. The Native
        // secret/story/order tests above isolate valid membership from policy.
        assert_unavailable(&mut conn, &fixture, fixture.child(), fixture.scene("s2"));
    }
}

#[test]
fn retrieval_sql_failures_remain_errors() {
    for table in ["narrative_proposal_decisions", "tree_nodes"] {
        let fixture = Fixture::new();
        let mut conn = fixture.corruption_connection();
        conn.execute_batch(&format!("DROP TABLE {table}"))
            .expect("private SQL error copy");
        let mut tx = grimodex_db::ScopedTransaction::begin(&mut conn).expect("SQL error read snapshot");
        let error = read_revision_retrieval_eligibility(
            &mut tx,
            fixture.project(),
            fixture.child(),
            fixture.scene("s2"),
        )
        .expect_err("SQL failure must remain an error");
        assert!(
            error.downcast_ref::<rusqlite::Error>().is_some(),
            "{table}: {error:#}"
        );
    }
}

/// 版（revision）の payload・Envelope の evidenceSet・封印済み snapshot の文書から、
/// 取り込みの操作を Native の組み立て（compile_current_chronicle_event_operation_payload）と
/// 同じ形に組む。操作の secret は常に true（DR-CAS-1、2）。
fn chronicle_apply_operation(conn: &Connection, run_id: &str, revision: &str) -> Value {
    let (payload, envelope): (String, String) = conn
        .query_row(
            "SELECT payload_json, reconciliation_envelope_json
               FROM narrative_proposal_revisions WHERE id = ?1",
            [revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("approved revision payload and Envelope");
    let payload: Value = serde_json::from_str(&payload).expect("revision payload");
    let envelope: Value = serde_json::from_str(&envelope).expect("revision Envelope");
    let snapshot: String = conn
        .query_row(
            "SELECT payload_json FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@1'",
            [run_id],
            |row| row.get(0),
        )
        .expect("sealed Snapshot artifact");
    let snapshot: Value = serde_json::from_str(&snapshot).expect("Snapshot JSON");
    let documents = snapshot["snapshot"]["documents"]
        .as_array()
        .expect("Snapshot documents");
    let evidence_set = envelope
        .pointer("/effectiveMaterialBasis/evidenceSet")
        .or_else(|| envelope.get("evidenceSet"))
        .and_then(Value::as_array)
        .expect("Envelope evidenceSet");
    let anchors = payload["evidenceAnchorIds"].as_array().expect("anchors");
    let mut links: Vec<Value> = Vec::new();
    for document_ref in payload["evidenceDocumentRefs"]
        .as_array()
        .expect("evidence document refs")
    {
        let document = documents
            .iter()
            .find(|document| document["ref"] == *document_ref)
            .expect("Snapshot document of the evidence ref");
        let scene_id = document["origin"]["nodeId"].clone();
        let anchor_ids: Vec<Value> = anchors
            .iter()
            .filter(|anchor| {
                evidence_set.iter().any(|evidence| {
                    evidence["evidenceRef"] == **anchor && evidence["documentRef"] == *document_ref
                })
            })
            .cloned()
            .collect();
        links.push(json!({
            "sceneId": scene_id,
            "expectedSceneVersion": document["origin"]["sourceVersion"],
            "evidenceAnchorIds": anchor_ids,
        }));
    }
    let reveal_ref = &payload["disclosure"]["revealDocumentRef"];
    let reveal_scene = documents
        .iter()
        .find(|document| document["ref"] == *reveal_ref)
        .expect("reveal Snapshot document")["origin"]["nodeId"]
        .clone();
    json!({
        "eventId": payload["eventId"],
        "title": payload["title"],
        "note": payload["note"],
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": true,
        "revealSceneId": reveal_scene,
        "evidenceSceneLinks": links,
        "detail": null,
        "primaryCodexId": null,
        "locationCodexId": null,
        "participants": [],
        "startTime": null,
        "endTime": null,
        "startGranularity": "none",
        "endGranularity": "none",
    })
}

fn retrieval_read(db: &Database, fixture: &Fixture, revision: &str) -> String {
    db.with_conn_mut(|conn| {
        let mut tx = grimodex_db::ScopedTransaction::begin(conn)?;
        let read = read_revision_retrieval_eligibility(
            &mut tx,
            fixture.project(),
            revision,
            fixture.scene("s2"),
        )?;
        Ok(format!("{read:?}"))
    })
    .expect("retrieval eligibility read")
}

fn enable_manual_apply(db: &Database) {
    let before = load_narrative_runtime_policy_from_db(db).expect("runtime policy");
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".into(),
            maintenance_enabled: before.maintenance_enabled,
            generic_import_enabled: before.generic_import_enabled,
            background_ai_enabled: before.background_ai_enabled,
        },
    )
    .expect("enable manual-apply without changing other policy flags");
}

/// fixture の 2 つの提案の現行の版（承認済みの、secret を外した human-derived の子）。
fn current_revisions(db: &Database) -> Vec<String> {
    db.with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT current_revision_id FROM narrative_proposals ORDER BY proposal_key")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("current revisions")
}

/// run の組（proposal set）の、承認済みの提案の現行の版。
fn approved_current_revisions_of_run(db: &Database, run_id: &str) -> Vec<String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT p.current_revision_id FROM narrative_proposals p
               JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
              WHERE s.run_id = ?1 AND p.status = 'approved' ORDER BY p.proposal_key",
        )?;
        let rows = stmt
            .query_map([run_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("approved current revisions of the run")
}

/// 指定した版を取り込む prepare の入力。操作は Native の組み立てと同じ形（secret は常に true）。
fn chronicle_prepare_payload(
    db: &Database,
    fixture: &Fixture,
    request_id: &str,
    revisions: &[String],
) -> PrepareCommitPayload {
    let run_id = fixture.manifest["runId"].as_str().expect("run").to_owned();
    db.with_conn(|conn| {
        let mut set_id = String::new();
        let mut operations = Vec::new();
        let mut applications = Vec::new();
        for revision in revisions {
            let (proposal, set): (String, String) = conn.query_row(
                "SELECT p.id, p.proposal_set_id FROM narrative_proposals p
                   JOIN narrative_proposal_revisions r ON r.proposal_id = p.id
                  WHERE r.id = ?1",
                [revision],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            set_id = set;
            let operation = chronicle_apply_operation(conn, &run_id, revision);
            assert_eq!(operation["secret"], true);
            operations.push(CommitOperation {
                kind: "chronicle.event.create".to_owned(),
                payload: operation,
                proposal_id: proposal.clone(),
                revision_id: revision.clone(),
            });
            applications.push(CommitApplicationRef {
                proposal_id: proposal,
                revision_id: revision.clone(),
            });
        }
        Ok(PrepareCommitPayload {
            project_id: fixture.project().to_owned(),
            run_id: run_id.clone(),
            proposal_set_id: set_id,
            request_id: request_id.to_owned(),
            plan_digest: "ignored".to_owned(),
            session_id: format!("session-{request_id}"),
            surface: Some("narrative-extraction".to_owned()),
            operations,
            applications,
            expected_tail_ordinal: None,
            entity_bindings: vec![],
            expected_calendar_version: None,
        })
    })
    .expect("prepare payload for the approved revisions")
}

fn prepare_and_apply(db: &Database, prepare: &PrepareCommitPayload) -> Value {
    let prepared = narrative_extraction_prepare_commit(db, prepare.clone())
        .expect("Chronicle prepare of the edited revisions");
    narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: prepare.project_id.clone(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("preparedCommitId")
                .to_owned(),
            request_id: prepare.request_id.clone(),
            session_id: prepare.session_id.clone(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("Chronicle apply of the edited revisions")
}

/// (events, narrative_apply_commits, narrative_proposal_applications)
fn apply_counts(db: &Database) -> (i64, i64, i64) {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT (SELECT COUNT(*) FROM events),
                    (SELECT COUNT(*) FROM narrative_apply_commits),
                    (SELECT COUNT(*) FROM narrative_proposal_applications)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?)
    })
    .expect("apply counts")
}

/// 取り込みが拒まれ、年表の出来事と取り込みの記録が増えないこと。エラーの文面を返す。
fn assert_prepare_refused(db: &Database, prepare: &PrepareCommitPayload) -> String {
    let before = apply_counts(db);
    let error = narrative_extraction_prepare_commit(db, prepare.clone())
        .expect_err("the edited revision must be refused");
    assert_eq!(apply_counts(db), before, "a refused prepare writes nothing");
    format!("{error:#}")
}

/// 実機（N-API の変換）が画面へ渡す文字列。anyhow の連鎖の最も外側の文だけである。
fn assert_prepare_refused_outermost(db: &Database, prepare: &PrepareCommitPayload) -> String {
    let before = apply_counts(db);
    let error = narrative_extraction_prepare_commit(db, prepare.clone())
        .expect_err("the edited revision must be refused");
    assert_eq!(apply_counts(db), before, "a refused prepare writes nothing");
    error.to_string()
}

/// 取り込んだ出来事の (secret, reveal_scene_id, title)。
fn event_rows(db: &Database) -> Vec<(i64, Option<String>, Option<String>)> {
    db.with_conn(|conn| {
        let rows = conn
            .prepare("SELECT secret, reveal_scene_id, title FROM events ORDER BY ordinal")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("event rows")
}

/// 版の payload の eventId の出来事の (secret, reveal_scene_id, title)。
fn event_row_of(db: &Database, revision: &str) -> (i64, Option<String>, Option<String>) {
    db.with_conn(|conn| {
        let payload: String = conn.query_row(
            "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?1",
            [revision],
            |row| row.get(0),
        )?;
        let payload: Value = serde_json::from_str(&payload)?;
        let event_id = payload["eventId"].as_str().expect("eventId").to_owned();
        Ok(conn.query_row(
            "SELECT secret, reveal_scene_id, title FROM events WHERE id = ?1",
            [event_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?)
    })
    .expect("event of the revision")
}

fn revision_title(db: &Database, revision: &str) -> String {
    db.with_conn(|conn| {
        let payload: String = conn.query_row(
            "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?1",
            [revision],
            |row| row.get(0),
        )?;
        let payload: Value = serde_json::from_str(&payload)?;
        Ok(payload["title"].as_str().expect("title").to_owned())
    })
    .expect("revision title")
}

fn drain_freshness(db: &Database) {
    let mut cycles = 0;
    for _ in 0..8 {
        if matches!(
            run_incremental_freshness_cycle(db).expect("production Native Freshness cycle"),
            IncrementalFreshnessCycleOutcome::Idle
        ) {
            break;
        }
        cycles += 1;
    }
    assert!(
        cycles >= 1,
        "the writes must have been evaluated by the Feed"
    );
}

/// 承認済みの 2 つの編集した版（fixture の現行の版）が、年表に取り込める。
/// 出来事は secret で、reveal は版の reveal の場面、題は版の題（E6、CAS/1）。
#[test]
fn edited_revisions_pass_chronicle_prepare_and_apply_as_secret_events() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let revisions = current_revisions(&db);
    assert_eq!(revisions.len(), 2);
    db.with_conn(|conn| {
        for revision in &revisions {
            // 現行の版は human-derived の子（承認済み）。
            let basis: String = conn.query_row(
                "SELECT json_extract(reconciliation_envelope_json, '$.revisionBasis.kind')
                   FROM narrative_proposal_revisions WHERE id = ?1",
                [revision],
                |row| row.get(0),
            )?;
            assert_eq!(basis, "human-derived");
        }
        Ok(())
    })
    .expect("fixture revisions are human-derived");
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-fixture-request", &revisions);
    let applied = prepare_and_apply(&db, &prepare);
    assert_eq!(applied["status"], "applied");
    assert_eq!(apply_counts(&db), (2, 1, 2));
    let mut titles: Vec<String> = revisions
        .iter()
        .map(|revision| revision_title(&db, revision))
        .collect();
    titles.sort();
    let rows = event_rows(&db);
    for (secret, reveal, _) in &rows {
        assert_eq!(*secret, 1, "Chronicle Event must be secret");
        assert_eq!(reveal.as_deref(), Some(fixture.scene("s1")));
    }
    let mut actual: Vec<String> = rows.into_iter().filter_map(|(_, _, title)| title).collect();
    actual.sort();
    assert_eq!(actual, titles);
    db.with_conn(|conn| {
        let rows: Vec<(String, i64)> = conn
            .prepare("SELECT event_id, COUNT(*) FROM scene_events GROUP BY event_id")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|(_, linked)| *linked >= 1));
        Ok(())
    })
    .expect("Events are linked to evidence scenes");
}

/// DR-CAS-7 f／DR-ERA-6：承認した非 secret の版は、本物の取り込み（prepare → apply）で
/// 年表の出来事が secret で作られた後も、資格の本体で eligible のまま。
/// 取り込みの直後も、Freshness の周期の後も変わらない。
#[test]
fn approved_nonsecret_child_stays_eligible_after_its_secret_chronicle_apply() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let revisions = current_revisions(&db);
    assert_eq!(revisions.len(), 2);
    db.with_conn_mut(|conn| {
        for revision in &revisions {
            let payload: String = conn.query_row(
                "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?1",
                [revision],
                |row| row.get(0),
            )?;
            let payload: Value = serde_json::from_str(&payload)?;
            assert_eq!(payload["disclosure"]["secret"], false);
            assert_eligible(conn, &fixture, revision);
        }
        Ok(())
    })
    .expect("non-secret approved revisions are eligible before the apply");

    let prepare = chronicle_prepare_payload(&db, &fixture, "era-eligible-request", &revisions);
    prepare_and_apply(&db, &prepare);
    assert_eq!(apply_counts(&db), (2, 1, 2));
    for (secret, reveal, _) in event_rows(&db) {
        assert_eq!(secret, 1);
        assert_eq!(reveal.as_deref(), Some(fixture.scene("s1")));
    }

    // 書いた直後（Freshness の変更を処理する前）も、資格は変わらない。
    for revision in &revisions {
        let read = retrieval_read(&db, &fixture, revision);
        assert!(
            read.starts_with("Eligible("),
            "immediately after the Chronicle apply: {read}"
        );
    }
    drain_freshness(&db);
    db.with_conn_mut(|conn| {
        for revision in &revisions {
            assert_complete_and_fresh(conn, &fixture, revision);
            assert_eligible(conn, &fixture, revision);
        }
        Ok(())
    })
    .expect("the approved non-secret revisions stay eligible after a secret Chronicle apply");
}

fn undo_replay(commit_id: &str, project: &str, session: &str, action: &str) -> UndoCommitPayload {
    UndoCommitPayload {
        project_id: project.to_owned(),
        session_id: session.to_owned(),
        surface: None,
        commit_id: Some(commit_id.to_owned()),
        request_id: Some(format!("era-{action}:{commit_id}")),
    }
}

/// 取り込みの記録（application）の依存の辺の数と、そのうち scope の投影の辺の数。
fn application_dependency_edges(db: &Database) -> (i64, i64) {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(source_object_identity LIKE '%scope-dependency%'), 0)
               FROM narrative_dependency_edges WHERE consumer_kind = 'application'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })
    .expect("application dependency edges")
}

/// 編集した版から取り込んだ出来事は、取り消し（undo）とやり直し（redo）の後も動き、
/// redo の後も secret である。
#[test]
fn edited_revision_apply_survives_undo_and_redo_as_secret_events() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let revisions = current_revisions(&db);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-undo-request", &revisions);
    let edges_before = application_dependency_edges(&db);
    let applied = prepare_and_apply(&db, &prepare);
    // 取り込みの記録の依存：取り込みの前は 0 本。取り込むと、秘密を外した 2 版の scope の投影の
    // 辺（各 1 本）が材料の辺に加わる（取り消し後の辺の扱いは固定しない）。
    let edges_applied = application_dependency_edges(&db);
    assert_eq!(edges_before, (0, 0));
    assert_eq!(
        edges_applied.1, 2,
        "one scope-projection edge per edited revision"
    );
    assert!(edges_applied.0 > edges_applied.1);
    let commit_id = applied["commitId"].as_str().expect("commit id").to_owned();
    assert_eq!(apply_counts(&db).0, 2);

    let undone = narrative_extraction_undo_commit(
        &db,
        undo_replay(&commit_id, fixture.project(), &prepare.session_id, "undo"),
    )
    .expect("undo of the edited-revision apply");
    assert_eq!(undone["status"], "undone");
    assert_eq!(apply_counts(&db).0, 0, "undo removes the created Events");

    let redone = narrative_extraction_redo_commit(
        &db,
        undo_replay(&commit_id, fixture.project(), &prepare.session_id, "redo"),
    )
    .expect("redo of the edited-revision apply");
    assert_eq!(redone["status"], "redone");
    let rows = event_rows(&db);
    assert_eq!(rows.len(), 2);
    for (secret, reveal, _) in rows {
        assert_eq!(secret, 1, "Events stay secret after redo");
        assert_eq!(reveal.as_deref(), Some(fixture.scene("s1")));
    }
    drain_freshness(&db);
    db.with_conn_mut(|conn| {
        for revision in &revisions {
            assert_eligible(conn, &fixture, revision);
        }
        Ok(())
    })
    .expect("eligibility is unchanged after undo and redo");
}

/// 作者が編集して承認した版を、承認済みの現行の全提案と一緒に取り込む（取り込みの計画は、
/// 承認済みの現行の全提案を過不足なく覆う必要がある）。
fn apply_all_current(db: &Database, fixture: &Fixture, request_id: &str) -> PrepareCommitPayload {
    let revisions = current_revisions(db);
    assert_eq!(revisions.len(), 2);
    let prepare = chronicle_prepare_payload(db, fixture, request_id, &revisions);
    prepare_and_apply(db, &prepare);
    assert_eq!(apply_counts(db), (2, 1, 2));
    prepare
}

/// 題だけ直した版（projection-only）を承認して取り込むと、出来事の題は編集後の値になる。
#[test]
fn title_only_edited_revision_applies_with_the_edited_title() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let edited = create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["title"] = json!("作者が直した題");
    });
    native_human_decision(&db, &fixture, &edited, "approved");
    apply_all_current(&db, &fixture, "era-title-request");
    assert_eq!(
        event_row_of(&db, &edited),
        (
            1,
            Some(fixture.scene("s1").to_owned()),
            Some("作者が直した題".to_owned())
        )
    );
}

/// 開示の項目を 2 回編集した版（secret を付ける → 外す）を承認して取り込む。
/// 同じ id の文脈が親から引き継がれて複数になる形で、系譜の検証が通ること。
#[test]
fn twice_edited_disclosure_revision_applies() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let current = native_fresh_nonsecret_child(&db, &fixture);
    apply_all_current(&db, &fixture, "era-twice-request");
    let row = event_row_of(&db, &current);
    assert_eq!(row.0, 1);
    assert_eq!(row.1.as_deref(), Some(fixture.scene("s1")));
}

/// 開示の項目を繰り返し編集した版（secret を付ける → 外す → 付ける → 外す）を承認して取り込む。
#[test]
fn four_times_edited_disclosure_revision_applies() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let mut current = fixture.child().to_owned();
    for secret in [true, false, true, false] {
        current = create_native_child(&db, &fixture, &current, |payload| {
            payload["disclosure"]["secret"] = json!(secret);
        });
    }
    native_human_decision(&db, &fixture, &current, "approved");
    apply_all_current(&db, &fixture, "era-four-request");
    let row = event_row_of(&db, &current);
    assert_eq!(row.0, 1);
    assert_eq!(row.1.as_deref(), Some(fixture.scene("s1")));
}

/// この fixture の Snapshot には文書が 1 つ（D000001＝s1）しか無い。reveal を別の場面へ
/// 変える編集は、Native の版の作成が拒む（reveal の文書は Snapshot の文書でなければならない）。
/// そのため「reveal を別の場面に変えた版」の取り込みは、この fixture では作れない。
#[test]
fn reveal_edit_to_a_document_outside_the_snapshot_cannot_be_created() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let error = try_create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["disclosure"]["revealDocumentRef"] = json!("D000002");
    })
    .expect_err("a reveal document outside the Snapshot must be refused at creation");
    eprintln!("reveal outside snapshot: {error:#}");
}

fn reseal(conn: &Connection, revision: &str, edit: impl FnOnce(&mut Value)) {
    let raw: String = conn
        .query_row(
            "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
            [revision],
            |row| row.get(0),
        )
        .expect("Envelope to rewrite");
    let mut envelope: Value = serde_json::from_str(&raw).expect("Envelope JSON");
    edit(&mut envelope);
    conn.execute(
        "UPDATE narrative_proposal_revisions SET reconciliation_envelope_json = ?2,
            reconciliation_envelope_digest = ?3 WHERE id = ?1",
        params![
            revision,
            canonical_json_string(&envelope).expect("canonical Envelope"),
            canonical_json_digest(&envelope).expect("Envelope digest")
        ],
    )
    .expect("reseal the private corrupted copy");
}

/// 親（最初の AI の版）の Envelope を書き換えて封印し直す。子の「親の digest」が合わなくなる。
/// 選んだ版には触らない。
#[test]
fn edited_revision_with_a_mismatched_parent_digest_is_refused_before_apply() {
    let fixture = Fixture::new();
    let conn = fixture.corruption_connection();
    rewrite_resealed_scope(
        &conn,
        fixture.root(),
        "audience",
        json!({"kind":"exact","ref":"reader"}),
    );
    drop(conn);
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let revisions = current_revisions(&db);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-parent-request", &revisions);
    let error = assert_prepare_refused(&db, &prepare);
    // 親（最初の AI の版）の行の改ざんは、取り込みの計画の段（提案の組の整合）が先に拒む。
    assert!(
        error.contains("NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT"),
        "unexpected parent-digest error: {error}"
    );
}

/// 親の payload を書き換える（payload の digest が Envelope と合わなくなる）。
#[test]
fn edited_revision_with_a_tampered_root_payload_is_refused_before_apply() {
    let fixture = Fixture::new();
    let conn = fixture.corruption_connection();
    let raw: String = conn
        .query_row(
            "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?1",
            [fixture.root()],
            |row| row.get(0),
        )
        .expect("root payload");
    let mut payload: Value = serde_json::from_str(&raw).expect("payload JSON");
    payload["title"] = json!("tampered root title");
    conn.execute(
        "UPDATE narrative_proposal_revisions SET payload_json = ?2 WHERE id = ?1",
        params![fixture.root(), payload.to_string()],
    )
    .expect("tamper the private root payload");
    drop(conn);
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let revisions = current_revisions(&db);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-rootpayload-request", &revisions);
    let error = assert_prepare_refused(&db, &prepare);
    assert!(
        error.contains("NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT"),
        "unexpected root-payload error: {error}"
    );
}

/// 子の Envelope が指す「最初の AI の版」の id を別の id に変えて封印し直す。
/// 取り込みの計画の段を通り、系譜の検証（作り直した形との不一致）が拒む。
#[test]
fn edited_revision_with_a_wrong_root_identity_is_refused() {
    let fixture = Fixture::new();
    let conn = fixture.corruption_connection();
    let child = fixture.child().to_owned();
    reseal(&conn, &child, |envelope| {
        envelope["revisionBasis"]["rootInterpretationRevisionId"] =
            json!(Uuid::new_v4().to_string());
    });
    drop(conn);
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let revisions = current_revisions(&db);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-rootid-request", &revisions);
    let error = assert_prepare_refused(&db, &prepare);
    assert!(
        error.contains("NEX_V2_APPLY_LINEAGE_INVALID"),
        "unexpected root-identity error: {error}"
    );
}

/// 最初の AI の版の受領書が無いとき、編集した版は拒まれる。
#[test]
fn edited_revision_without_the_root_receipt_is_refused() {
    let fixture = Fixture::new();
    let conn = fixture.corruption_connection();
    let run_id = fixture.manifest["runId"].as_str().expect("run").to_owned();
    let summary: String = conn
        .query_row(
            "SELECT summary_json FROM narrative_proposal_sets WHERE run_id = ?1",
            [&run_id],
            |row| row.get(0),
        )
        .expect("set summary");
    let mut summary: Value = serde_json::from_str(&summary).expect("summary JSON");
    summary
        .as_object_mut()
        .expect("summary object")
        .remove("chronicleStageReceiptRefs");
    conn.execute(
        "UPDATE narrative_proposal_sets SET summary_json = ?2 WHERE run_id = ?1",
        params![run_id, summary.to_string()],
    )
    .expect("remove the receipt roster of the private copy");
    drop(conn);
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let revisions = current_revisions(&db);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-receipt-request", &revisions);
    let error = assert_prepare_refused(&db, &prepare);
    assert!(
        error.contains("NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED"),
        "unexpected receipt error: {error}"
    );
}

/// 根拠の場面の本文が変わった後は、編集した版も拒まれる。Native の通常の更新（版が上がる）は、
/// 計画の段（場面の版の照合）が先に拒む。版を上げずに updated_at だけを動かした場合は、
/// 材料の今の値との照合が拒む。
#[test]
fn edited_revision_is_refused_after_the_evidence_scene_changed() {
    for case in ["native-version-bump", "token-only"] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        enable_manual_apply(&db);
        if case == "native-version-bump" {
            native_patch_node(
                &db,
                &fixture,
                fixture.scene("s1"),
                json!({"content":"The Native source has changed."}),
                false,
            );
        } else {
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE tree_nodes SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?1",
                    [fixture.scene("s1")],
                )?;
                Ok(())
            })
            .expect("test-only token change");
        }
        let revisions = current_revisions(&db);
        let prepare = chronicle_prepare_payload(&db, &fixture, "era-stale-request", &revisions);
        let error = assert_prepare_refused(&db, &prepare);
        eprintln!("{case}: {error}");
        let expected = if case == "native-version-bump" {
            "NEX_SCENE_VERSION_MISMATCH"
        } else {
            "NEX_SOURCE_BASIS_STALE"
        };
        assert!(
            error.contains(expected),
            "{case}: unexpected error: {error}"
        );
    }
}

/// secret の版（scope の投影が材料に入る）は、場面の並び（reading order の順位）が変わると、
/// 材料が古くなって拒まれる。secret を外した版と、並び以外の変更は影響を受けない。
/// reveal を別の場面へ変える編集はこの fixture で作れない（上の試験）ため、spec の
/// 「secret のまま reveal を別の場面に変えた版」そのものは作れず、reveal が s1 の secret の版で
/// 確かめる（投影の形は同じで、順位の対象の場面だけが違う）。
#[test]
fn scope_projection_material_goes_stale_when_the_reading_order_changes() {
    for (case, secret, scene, patch, retain, stale) in [
        (
            "secret / s2 sortOrder",
            true,
            "s2",
            json!({"sortOrder":"Zz"}),
            false,
            true,
        ),
        (
            "secret / s2 storyTimeOrder",
            true,
            "s2",
            json!({"storyTimeOrder":"z9"}),
            false,
            false,
        ),
        (
            "secret / s1 sortOrder (token kept)",
            true,
            "s1",
            json!({"sortOrder":"Zz"}),
            true,
            false,
        ),
        (
            "nonsecret / s2 sortOrder",
            false,
            "s2",
            json!({"sortOrder":"Zz"}),
            false,
            false,
        ),
    ] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        enable_manual_apply(&db);
        if secret {
            let edited = create_native_child(&db, &fixture, fixture.child(), |payload| {
                payload["disclosure"]["secret"] = json!(true);
            });
            native_human_decision(&db, &fixture, &edited, "approved");
        }
        let revisions = current_revisions(&db);
        let prepare = chronicle_prepare_payload(&db, &fixture, "era-order-request", &revisions);
        native_patch_node(&db, &fixture, fixture.scene(scene), patch, retain);
        if stale {
            let error = assert_prepare_refused(&db, &prepare);
            assert!(
                error.contains("NEX_SOURCE_BASIS_STALE") && error.contains("scope-dependency:v1:"),
                "{case}: unexpected error: {error}"
            );
        } else {
            narrative_extraction_prepare_commit(&db, prepare.clone())
                .unwrap_or_else(|error| panic!("{case}: must stay applicable: {error:#}"));
        }
    }
}

/// changeKind が add でない版は拒まれる。選んだ版の Envelope を書き換えるので、
/// 版の種類の検査より前の段が先に拒む可能性がある（実際の拒否の理由を固定する）。
#[test]
fn edited_revision_with_a_non_add_change_kind_is_refused() {
    let fixture = Fixture::new();
    let conn = fixture.corruption_connection();
    let child = fixture.child().to_owned();
    reseal(&conn, &child, |envelope| {
        envelope["changeIntent"]["changeKind"] = json!("patch");
    });
    drop(conn);
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let revisions = current_revisions(&db);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-kind-request", &revisions);
    let error = assert_prepare_refused(&db, &prepare);
    // 選んだ版の Envelope の検証（schema）が、版の種類の検査より先に拒む。
    assert!(
        error.contains("NEX_ENVELOPE_V2_INVALID"),
        "unexpected change-kind error: {error}"
    );
}

/// 親の版の id を付け替え、文脈の「引き継ぎ元」と文脈一覧の digest も合わせる
/// （Envelope の schema 検証は通し、系譜の検証だけが拒む形にする）。
fn repoint_parent(envelope: &mut Value, parent: &str) {
    envelope["revisionBasis"]["parentRevisionId"] = json!(parent);
    let entries = envelope["revisionBasis"]["derivationContextSet"]
        .as_array_mut()
        .expect("derivationContextSet");
    for entry in entries.iter_mut() {
        entry["inheritedFromRevisionId"] = json!(parent);
    }
    let digest =
        canonical_json_digest(&json!({"version":"chronicle.context-set/1","entries":entries}))
            .expect("context set digest");
    envelope["revisionBasis"]["derivationContextSetDigest"] = json!(digest);
}

/// 材料を書き換えた後、依存の digest と材料の digest を封印し直す。
fn reseal_material_digests(envelope: &mut Value) {
    let material = &mut envelope["effectiveMaterialBasis"];
    let dependency_digest =
        canonical_json_digest(&material["dependencySet"]).expect("dependencySet digest");
    material["dependencySetDigest"] = json!(dependency_digest);
    let material_digest = canonical_json_digest(&json!({
        "sourceBasis": material["sourceBasis"],
        "evidenceSet": material["evidenceSet"],
        "dependencySet": material["dependencySet"],
    }))
    .expect("materialBasis digest");
    material["materialBasisDigest"] = json!(material_digest);
}

/// 子の Envelope を書き換えて封印し直した形（親の digest、親の id、材料）が、系譜の検証
/// （`NEX_V2_APPLY_LINEAGE_INVALID`）に届いて拒まれる。取り込みの計画の段は通り、
/// `events` と `narrative_apply_commits` は増えない。
#[test]
fn resealed_child_lineage_corruptions_reach_the_lineage_verification() {
    let mut failures = Vec::new();
    for case in [
        "expected-parent-digest",
        "parent-revision-id-unknown",
        "parent-revision-id-sibling",
        "material-scope-token",
        "material-extra-dependency",
    ] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        // 「同じ提案の別の版」を作るため、子の子（題だけ直した版）を承認しておく。
        let target = if case == "parent-revision-id-sibling" {
            let grandchild = create_native_child(&db, &fixture, fixture.child(), |payload| {
                payload["title"] = json!("孫の題");
            });
            native_human_decision(&db, &fixture, &grandchild, "approved");
            grandchild
        } else {
            fixture.child().to_owned()
        };
        drop(db);
        let conn = fixture.corruption_connection();
        let root = fixture.root().to_owned();
        reseal(&conn, &target, |envelope| match case {
            "expected-parent-digest" => {
                envelope["revisionBasis"]["expectedParentEnvelopeDigest"] =
                    json!(format!("sha256:{}", "0".repeat(64)));
            }
            "parent-revision-id-unknown" => {
                repoint_parent(envelope, &Uuid::new_v4().to_string());
            }
            // 孫の親を、直接の親（子）ではなく同じ提案の最初の版へ付け替える。
            "parent-revision-id-sibling" => repoint_parent(envelope, &root),
            "material-scope-token" => {
                let sources = envelope["effectiveMaterialBasis"]["sourceBasis"]
                    .as_array_mut()
                    .expect("sourceBasis");
                let scope = sources
                    .iter_mut()
                    .find(|s| {
                        s["sourceKind"]
                            .as_str()
                            .is_some_and(|kind| kind.starts_with("scope-"))
                    })
                    .expect("a scope projection material");
                scope["revisionToken"] = json!(format!("sha256:{}", "1".repeat(64)));
                reseal_material_digests(envelope);
            }
            "material-extra-dependency" => {
                let dependencies = envelope["effectiveMaterialBasis"]["dependencySet"]
                    .as_array_mut()
                    .expect("dependencySet");
                let mut extra = dependencies[0].clone();
                extra["dependencyId"] = json!("dependency:era-extra");
                dependencies.push(extra);
                reseal_material_digests(envelope);
            }
            _ => unreachable!("enumerated corruption"),
        });
        if case == "material-scope-token" {
            // 正規化した行も合わせる（Envelope と行の不一致が先に拒まないようにする）。
            // 行の更新を止める trigger は、この私的な複製でだけ外す。
            conn.execute_batch("DROP TRIGGER narrative_source_basis_immutable_update;")
                .expect("remove the row guard only on the private negative copy");
            conn.execute(
                "UPDATE narrative_revision_source_basis SET revision_token = ?2
                  WHERE revision_id = ?1 AND source_kind LIKE 'scope-%'",
                params![target, format!("sha256:{}", "1".repeat(64))],
            )
            .expect("align the normalized source-basis row of the private copy");
        }
        drop(conn);
        let db = Database::new(&fixture.path).expect("Native private fixture");
        enable_manual_apply(&db);
        let revisions = current_revisions(&db);
        let prepare = chronicle_prepare_payload(&db, &fixture, "era-lineage-case", &revisions);
        let error = assert_prepare_refused(&db, &prepare);
        // scope の投影の token を書き換えた形は、今の値との照合（prepare の手前のループ）が
        // 系譜の検証より先に拒む。ほかは系譜の検証に届く。
        let expected = if case == "material-scope-token" {
            "NEX_SOURCE_BASIS_STALE"
        } else {
            "NEX_V2_APPLY_LINEAGE_INVALID"
        };
        if !error.contains(expected) {
            failures.push(format!("{case}: {error}"));
        }
    }
    assert!(
        failures.is_empty(),
        "cases refused by an unexpected check:\n{}",
        failures.join("\n")
    );
}

const TWO_WINDOW_RUN: &str = "4a2327c6-8d14-4234-aae9-72ce858186a0";
const TWO_WINDOW_UNREVIEWED_REVISION: &str = "34aa64ae-35df-4ab7-a8ed-b833e7dbbc98";

/// reveal を、evidence とは別の場面の文書へ変えた版を承認して取り込む（2 window の fixture）。
/// この fixture のスキーマは現行より古く、scope の保存先の表が無い（reveal や secret を変える編集が
/// 版の作成で拒まれる）。そのため、私的な複製に `Database::migrate` を掛けてから使う。
/// 承認済みの版（evidence も reveal も D000002＝ en-distractor-rumor-fact）から、reveal を
/// D000001（＝ en-distractor-gift）へ変えた子を作る。もう 1 件（unreviewed の AI の版）は承認する。
/// 出来事の reveal は編集後の場面、場面への結び付けは根拠の場面、secret である。
#[test]
fn two_window_reveal_scene_edited_revision_applies_with_the_edited_reveal_scene() {
    let fixture = Fixture::two_window();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    db.migrate().expect("migrate the private two-window copy");
    enable_manual_apply(&db);
    native_human_decision(&db, &fixture, TWO_WINDOW_UNREVIEWED_REVISION, "approved");
    let edited = create_native_child(&db, &fixture, fixture.child(), |payload| {
        assert_eq!(payload["disclosure"]["revealDocumentRef"], "D000002");
        payload["disclosure"]["revealDocumentRef"] = json!("D000001");
    });
    native_human_decision(&db, &fixture, &edited, "approved");
    let revisions = approved_current_revisions_of_run(&db, TWO_WINDOW_RUN);
    assert_eq!(revisions.len(), 2);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-two-window-reveal", &revisions);
    prepare_and_apply(&db, &prepare);
    assert_eq!(apply_counts(&db), (2, 1, 2));
    let row = event_row_of(&db, &edited);
    assert_eq!(row.0, 1, "the Event is secret");
    assert_eq!(
        row.1.as_deref(),
        Some(fixture.scene("s1")),
        "reveal = edited Scene"
    );
    // 場面への結び付けは、reveal ではなく根拠の場面（D000002）。
    db.with_conn(|conn| {
        let payload: String = conn.query_row(
            "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?1",
            [&edited],
            |r| r.get(0),
        )?;
        let payload: Value = serde_json::from_str(&payload)?;
        let event_id = payload["eventId"].as_str().expect("eventId").to_owned();
        let linked: Vec<String> = conn
            .prepare("SELECT scene_id FROM scene_events WHERE event_id = ?1")?
            .query_map([event_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        assert_eq!(linked, vec![fixture.scene("s2").to_owned()]);
        Ok(())
    })
    .expect("scene links of the edited-reveal Event");
    // 併せて取り込んだ AI の版の出来事も secret。
    for revision in revisions.iter().filter(|r| **r != edited) {
        assert_eq!(event_row_of(&db, revision).0, 1);
    }
}

/// secret のまま reveal を別の場面（D000001）へ変えた版を承認した後、場面の並び
/// （別の場面の sortOrder）を変えて reveal の場面の順位が動くと、材料（scope の投影）が古くなって prepare が拒まれる。
/// 親の run の unreviewed の版は却下して計画から外す。
#[test]
fn two_window_secret_reveal_edited_revision_is_refused_after_the_reveal_scene_order_changed() {
    let fixture = Fixture::two_window();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    db.migrate().expect("migrate the private two-window copy");
    enable_manual_apply(&db);
    native_human_decision(&db, &fixture, TWO_WINDOW_UNREVIEWED_REVISION, "rejected");
    let first = create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["disclosure"]["revealDocumentRef"] = json!("D000001");
    });
    let second = create_native_child(&db, &fixture, &first, |payload| {
        payload["disclosure"]["secret"] = json!(true);
    });
    native_human_decision(&db, &fixture, &second, "approved");
    let revisions = approved_current_revisions_of_run(&db, TWO_WINDOW_RUN);
    assert_eq!(revisions, vec![second.clone()]);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-two-window-order", &revisions);
    // reveal の場面（D000001）より後ろにある別の場面を先頭へ動かし、reveal の場面の順位を変える。
    // reveal の場面自身の sortOrder を変えても（本文の token を保っても）、この形では古くならない。
    native_patch_node(
        &db,
        &fixture,
        "en-query-05",
        json!({"sortOrder":"Zz"}),
        false,
    );
    let error = assert_prepare_refused(&db, &prepare);
    assert!(
        error.contains("NEX_SOURCE_BASIS_STALE") && error.contains("scope-dependency:v1:"),
        "unexpected error after the reveal Scene order change: {error}"
    );
}

/// 画面の案内（取り込みの拒否の分類）は、実機では連鎖の最も外側の文だけを見る。
/// 系譜の検証の拒否は、最も外側の文にコードが入る。
#[test]
fn outermost_error_message_carries_the_lineage_code() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let target = fixture.child().to_owned();
    drop(db);
    let conn = fixture.corruption_connection();
    reseal(&conn, &target, |envelope| {
        envelope["revisionBasis"]["expectedParentEnvelopeDigest"] =
            json!(format!("sha256:{}", "0".repeat(64)));
    });
    drop(conn);
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    let revisions = current_revisions(&db);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-outermost-lineage", &revisions);
    let error = assert_prepare_refused_outermost(&db, &prepare);
    assert!(
        error.contains("NEX_V2_APPLY_LINEAGE_INVALID"),
        "outermost message lacks the lineage code: {error}"
    );
}

/// secret の版で場面の並びが変わった拒否は、最も外側の文に code と scope の投影の目印が入る。
#[test]
fn outermost_error_message_carries_the_scope_dependency_stale_marker() {
    let fixture = Fixture::two_window();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    db.migrate().expect("migrate the private two-window copy");
    enable_manual_apply(&db);
    native_human_decision(&db, &fixture, TWO_WINDOW_UNREVIEWED_REVISION, "rejected");
    let first = create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["disclosure"]["revealDocumentRef"] = json!("D000001");
    });
    let second = create_native_child(&db, &fixture, &first, |payload| {
        payload["disclosure"]["secret"] = json!(true);
    });
    native_human_decision(&db, &fixture, &second, "approved");
    let revisions = approved_current_revisions_of_run(&db, TWO_WINDOW_RUN);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-outermost-scope", &revisions);
    native_patch_node(
        &db,
        &fixture,
        "en-query-05",
        json!({"sortOrder":"Zz"}),
        false,
    );
    let error = assert_prepare_refused_outermost(&db, &prepare);
    assert!(
        error.contains("NEX_SOURCE_BASIS_STALE") && error.contains("scope-dependency:v1:"),
        "outermost message lacks the scope marker: {error}"
    );
}

/// 根拠の場面の本文が変わった拒否は、最も外側の文に code が入り、scope の投影の目印は入らない。
#[test]
fn outermost_error_message_carries_the_source_stale_code_without_scope_marker() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    enable_manual_apply(&db);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?1",
            [fixture.scene("s1")],
        )?;
        Ok(())
    })
    .expect("test-only token change");
    let revisions = current_revisions(&db);
    let prepare = chronicle_prepare_payload(&db, &fixture, "era-outermost-source", &revisions);
    let error = assert_prepare_refused_outermost(&db, &prepare);
    assert!(
        error.contains("NEX_SOURCE_BASIS_STALE") && !error.contains("scope-dependency:v1:"),
        "unexpected outermost message: {error}"
    );
}

/// MW/1 (DR-MW-8), carried over from the two-window checks: material that now
/// lies after the query is refused by the disclosure order alone. The proposal
/// stays approved, current and fresh, and its sealed material is unchanged.
#[test]
fn three_window_material_moved_after_the_query_is_denied_by_disclosure_alone() {
    for crossing in [true, false] {
        let fixture = Fixture::multi_window(crossing);
        let db = Database::new(&fixture.path).expect("Native private fixture");
        db.migrate().expect("migrate the private multi-window copy");
        let membership = |conn: &Connection, revision: &str| {
            let tx = conn.unchecked_transaction().expect("membership snapshot");
            let MaterialMembershipRead::Complete(m) =
                read_revision_material_membership(&tx, fixture.project(), revision)
                    .expect("typed material membership")
            else {
                panic!("three-window material must be complete")
            };
            m.materials
                .iter()
                .map(|s| (s.context_id.clone(), s.content_digest.clone()))
                .collect::<Vec<_>>()
        };
        let before = db
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                assert!(
                    matches!(
                        read_revision_retrieval_eligibility(
                            &tx,
                            fixture.project(),
                            fixture.child(),
                            fixture.scene("s2"),
                        )
                        .expect("public Rust retrieval admission"),
                        RevisionEligibilityRead::Eligible(_)
                    ),
                    "crossing={crossing}: eligible before the move"
                );
                drop(tx);
                Ok(membership(conn, fixture.child()))
            })
            .expect("pristine verdict");
        assert!(before.len() > 3, "every window and its context");
        // The scene after both folders now comes first in Reading order.
        native_patch_node(
            &db,
            &fixture,
            fixture.scene("s2"),
            json!({"sortOrder":"Zz"}),
            false,
        );
        drain_native_feed(&db);
        let current = native_fresh_nonsecret_child(&db, &fixture);
        db.with_conn(|conn| {
            assert_complete_and_fresh(conn, &fixture, &current);
            assert_eq!(membership(conn, &current), before, "the material is kept");
            let tx = conn.unchecked_transaction()?;
            let verdict = read_revision_retrieval_eligibility(
                &tx,
                fixture.project(),
                &current,
                fixture.scene("s2"),
            )
            .expect("public Rust retrieval admission");
            assert!(
                matches!(
                    verdict,
                    RevisionEligibilityRead::Unavailable {
                        reason: RevisionEligibilityReason::SourceNotBeforeQuery
                    }
                ),
                "crossing={crossing}: only the disclosure order refuses: {verdict:?}"
            );
            let approved: String = conn.query_row(
                "SELECT decision FROM narrative_proposal_decisions WHERE revision_id=?1",
                [&current],
                |row| row.get(0),
            )?;
            assert_eq!(
                approved, "approved",
                "approval is kept on the current child"
            );
            Ok(())
        })
        .expect("the move is refused by the disclosure order alone");
    }
}

/// MW/1 (DR-MW-8): proposals whose material now lies after the query are
/// mixed in with ones that do not. The verdict of the others is the verdict
/// they had without the mix (here: before the mix existed), and each refusal is
/// the disclosure order alone.
#[test]
fn three_window_proposals_with_later_material_do_not_change_the_verdict_of_the_others() {
    let fixture = Fixture::multi_window(true);
    let db = Database::new(&fixture.path).expect("Native private fixture");
    db.migrate().expect("migrate the private multi-window copy");
    let long: Vec<String> = fixture.manifest["runs"]["long"]["proposals"]
        .as_array()
        .expect("proposals")
        .iter()
        .map(|p| p["revisionId"].as_str().expect("child").to_owned())
        .collect();
    let three: Vec<String> = fixture.manifest["runs"]["three"]["proposals"]
        .as_array()
        .expect("proposals")
        .iter()
        .filter(|p| p["title"] == "Writ delivered to the quay")
        .map(|p| p["revisionId"].as_str().expect("child").to_owned())
        .collect();
    let verdicts = |revisions: &[String]| -> Vec<String> {
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            Ok(revisions
                .iter()
                .map(|revision| {
                    let text = format!(
                        "{:?}",
                        read_revision_retrieval_eligibility(
                            &tx,
                            fixture.project(),
                            revision,
                            fixture.scene("s2"),
                        )
                        .expect("public Rust retrieval admission")
                    );
                    // Keep what belongs to the proposal (its revision, Run,
                    // Decision, material basis, dependencies, document and
                    // evidence). The query side (reading rank, scope authority
                    // token, freshness) is what the move itself changes.
                    match (text.find("query_context:"), text.find("document: ")) {
                        (Some(query), Some(document)) => {
                            format!("{}|{}", &text[..query], &text[document..])
                        }
                        _ => text,
                    }
                })
                .collect())
        })
        .expect("verdicts")
    };
    let control = verdicts(&long);
    assert!(
        control.iter().all(|v| v.starts_with("Eligible")),
        "the control is eligible: {control:?}"
    );
    assert!(verdicts(&three)[0].starts_with("Eligible"));
    // Put the three-scene folder after the query scene.
    native_patch_node(
        &db,
        &fixture,
        "mw-folder-three",
        json!({"sortOrder":"a9"}),
        false,
    );
    drain_native_feed(&db);
    assert_eq!(verdicts(&long), control, "the others are answered alike");
    assert!(
        verdicts(&three)[0].contains("SourceNotBeforeQuery"),
        "{:?}",
        verdicts(&three)
    );
}

/// MW/1 (DR-MW-8): the material's Scenes (a Run's folder) move after the query
/// Scene. Every retrievable proposal of that Run is refused by
/// the disclosure order alone, with its original current child and its original
/// approval: no new child, no new decision, and the sealed material is kept.
/// The other Run's proposals are answered as before.
#[test]
fn moving_the_material_folder_after_the_query_refuses_the_original_child_and_approval() {
    for (moved, other, folder) in [
        ("long", "three", "mw-folder-long"),
        ("three", "long", "mw-folder-three"),
    ] {
        let fixture = Fixture::multi_window(true);
        let db = Database::new(&fixture.path).expect("Native private fixture");
        db.migrate().expect("migrate the private multi-window copy");
        // The folder Run's other proposal folds the evidence of two Scenes into
        // one Event, which one exact Scope Scene cannot hold: it is refused with
        // `EvidenceMismatch` before any move, so it is not part of this check.
        let revisions = |shape: &str| -> Vec<String> {
            fixture.manifest["runs"][shape]["proposals"]
                .as_array()
                .expect("proposals")
                .iter()
                .filter(|p| p["title"] != "Signal fire on the quay")
                .map(|p| p["revisionId"].as_str().expect("child").to_owned())
                .collect()
        };
        let (moved_revisions, other_revisions) = (revisions(moved), revisions(other));
        assert_eq!(moved_revisions.len(), if moved == "long" { 2 } else { 1 });
        // Everything a proposal keeps: its current child, its decision rows and
        // its sealed material (context ids and content digests).
        type Kept = (String, Vec<(String, String, String)>, Vec<(String, String)>);
        let kept = |revision: &str| -> Kept {
            db.with_read_transaction(|conn| {
                let current: String = conn.query_row(
                    "SELECT p.current_revision_id FROM narrative_proposals p
                       JOIN narrative_proposal_revisions r ON r.proposal_id = p.id
                      WHERE r.id = ?1",
                    [revision],
                    |row| row.get(0),
                )?;
                let decisions = conn
                    .prepare(
                        "SELECT id, revision_id, decision FROM narrative_proposal_decisions
                          WHERE revision_id = ?1 ORDER BY id",
                    )?
                    .query_map([revision], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let MaterialMembershipRead::Complete(m) =
                    read_revision_material_membership(conn, fixture.project(), revision)?
                else {
                    panic!("the material must stay complete")
                };
                let material = m
                    .materials
                    .iter()
                    .map(|s| (s.context_id.clone(), s.content_digest.clone()))
                    .collect();
                Ok((current, decisions, material))
            })
            .expect("kept state")
        };
        let verdict = |revision: &str| -> RevisionEligibilityRead {
            db.with_read_transaction(|conn| {
                read_revision_retrieval_eligibility(
                    conn,
                    fixture.project(),
                    revision,
                    fixture.scene("s2"),
                )
            })
            .expect("public Rust retrieval admission")
        };
        let before: Vec<_> = moved_revisions
            .iter()
            .chain(&other_revisions)
            .map(|r| kept(r))
            .collect();
        for revision in moved_revisions.iter().chain(&other_revisions) {
            assert!(
                matches!(verdict(revision), RevisionEligibilityRead::Eligible(_)),
                "{moved}: {revision} eligible before the move: {:?}",
                verdict(revision)
            );
        }
        for (current, decisions, material) in &before {
            assert_eq!(decisions.len(), 1, "one approval");
            assert_eq!(decisions[0].2, "approved");
            assert!(material.len() > 3, "every window and its context");
            assert!(!current.is_empty());
        }
        // The Run's folder now comes after the query Scene ("after" is a3).
        native_patch_node(&db, &fixture, folder, json!({"sortOrder":"a9"}), false);
        drain_native_feed(&db);
        for revision in &moved_revisions {
            assert!(
                matches!(
                    verdict(revision),
                    RevisionEligibilityRead::Unavailable {
                        reason: RevisionEligibilityReason::SourceNotBeforeQuery
                    }
                ),
                "{moved}: {revision} must be refused by the disclosure order alone: {:?}",
                verdict(revision)
            );
        }
        for revision in &other_revisions {
            assert!(
                matches!(verdict(revision), RevisionEligibilityRead::Eligible(_)),
                "{moved}: the other Run is answered as before"
            );
        }
        let after: Vec<_> = moved_revisions
            .iter()
            .chain(&other_revisions)
            .map(|r| kept(r))
            .collect();
        assert_eq!(
            after, before,
            "{moved}: same child, same approval, same material"
        );
        for revision in &moved_revisions {
            let (current, _, _) = kept(revision);
            assert_eq!(
                &current, revision,
                "{moved}: the original child is still current"
            );
        }
    }
}


// ───────────────────────── BAO/1: Chronicle bulk approve ─────────────────────────
//
// The cold fixtures are real normal-UI runs, but every sealed value in them is
// `significance: major`, so no real proposal in them is a bulk-approval target,
// and no public Rust writer can build a whole Chronicle run (Snapshot, evidence,
// plan, Envelope, D1 declaration) from nothing. The one exception to "private
// corruption copies never manufacture positives" is therefore the *scene-level*
// reseal of an AI root below. It is not an Envelope-only edit: it rewrites the
// payload, the Envelope (assertion value, `proposalPayloadDigest`, assertion
// digests), the sealed plan (`proposals[]`, `planned[].proposal`) and the Plan
// manifest binding together, so the copy is the state a real writer leaves for a
// scene-level event. The upstream model-output records (event hypotheses, stage
// synthesis) are bound to the stage receipts / response digests and keep what the
// model recorded. Material-roster replay does read the stage synthesis outputs, to
// check material membership (the observation refs and receipts); it never reads
// the rewritten values (significance, actuality), and no writer or judgement under
// test reads those from the upstream records.
// `assert_sealed_chain_agrees` states that, and the writers under test (the child
// writer re-verifies the parent's payload digest and Envelope; the review read
// re-verifies the Plan binding and the payload) run on top of it. The values the
// writers verify are rewritten consistently, never left in disagreement; the
// writers' own checks are never skipped. No proposal pointer, decision or child
// revision is moved: the second proposal of the run stays what the real product
// left it (approved, edited), i.e. not a target. (Rust has no public path that
// builds a Chronicle run with Snapshot, evidence, plan, V2 Envelope and D1
// declarations: the other fixture builders in this repository insert the plan and
// Snapshot by SQL, or save a legacy-kind proposal without Chronicle stage
// provenance.)

const TWO_WINDOW_FIRST_PROPOSAL: &str = "f3baa553-d148-4cab-a0e7-a8b3f10dc0ef";
const TWO_WINDOW_SECOND_PROPOSAL: &str = "78f95d27-b8de-4aa6-9854-1bf447834a3f";
/// 2 つの場面（s1、s2）の後ろの場面。
const BULK_QUERY_SCENE: &str = "en-query-05";
const TWO_WINDOW_OTHER_RUN_PROPOSAL: &str = "5a8a5fb7-91d0-45f6-9072-79c0706430ac";

/// Recompute the Plan manifest digest of the set that owns `proposal_set_id`
/// from the stored rows and store it in the set's Native binding.
fn rebind_plan_manifest(conn: &Connection, proposal_set_id: &str) {
    let (project, run, set_kind, summary_json): (String, String, String, String) = conn
        .query_row(
            "SELECT project_id, run_id, set_kind, summary_json
               FROM narrative_proposal_sets WHERE id = ?1",
            [proposal_set_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("ProposalSet to rebind");
    let mut summary: Value = serde_json::from_str(&summary_json).expect("summary");
    let mut binding = summary
        .as_object_mut()
        .expect("summary object")
        .remove("chroniclePlanTaskBinding")
        .expect("Native plan binding");
    let plan_digest: String = conn
        .query_row(
            "SELECT payload_digest FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1'",
            [&run],
            |row| row.get(0),
        )
        .expect("plan artifact digest");
    let proposals: Vec<Value> = conn
        .prepare(
            "SELECT p.proposal_key, p.kind, r.payload_json,
                    r.reconciliation_envelope_json, r.reconciliation_envelope_digest
               FROM narrative_proposals p
               JOIN narrative_proposal_revisions r
                 ON r.proposal_id = p.id AND r.revision_number = 1
              WHERE p.proposal_set_id = ?1
              ORDER BY p.proposal_key ASC",
        )
        .expect("manifest rows")
        .query_map([proposal_set_id], |row| {
            let payload: String = row.get(2)?;
            let envelope: String = row.get(3)?;
            Ok(json!({
                "proposalKey": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "payloadJson": serde_json::from_str::<Value>(&payload).expect("payload"),
                "reconciliationEnvelope": serde_json::from_str::<Value>(&envelope).expect("envelope"),
                "reconciliationEnvelopeDigest": row.get::<_, String>(4)?,
            }))
        })
        .expect("manifest query")
        .collect::<Result<_, _>>()
        .expect("manifest proposals");
    let manifest = json!({
        "kind": "chronicle.plan-proposal-set-manifest@1",
        "version": 1,
        "projectId": project,
        "runId": run,
        "taskId": binding["taskId"],
        "attemptId": binding["attemptId"],
        "proposalSetId": proposal_set_id,
        "setKind": set_kind,
        "summaryJson": summary,
        "proposalPlanArtifactDigest": plan_digest,
        "proposals": proposals,
    });
    binding["proposalManifestDigest"] = json!(canonical_json_digest(&manifest).expect("digest"));
    summary["chroniclePlanTaskBinding"] = binding;
    conn.execute(
        "UPDATE narrative_proposal_sets SET summary_json = ?2 WHERE id = ?1",
        params![proposal_set_id, serde_json::to_string(&summary).expect("summary")],
    )
    .expect("store rebound manifest digest");
}

fn set_of_revision(conn: &Connection, revision: &str) -> String {
    conn.query_row(
        "SELECT p.proposal_set_id FROM narrative_proposals p
           JOIN narrative_proposal_revisions r ON r.proposal_id = p.id WHERE r.id = ?1",
        [revision],
        |row| row.get(0),
    )
    .expect("set of the revision")
}

const CHAIN_VALUE_FIELDS: [&str; 4] = ["significance", "actuality", "narrativeFrame", "attribution"];

fn chain_value_is_valid(field: &str, value: &str) -> bool {
    match field {
        "significance" => matches!(value, "major" | "scene-level"),
        "actuality" => matches!(value, "actual" | "attempted" | "prevented"),
        _ => true,
    }
}

/// Rewrite a stored artifact of the Run (by kind) and its canonical digest.
fn rewrite_run_artifact(conn: &Connection, run: &str, kind: &str, edit: impl FnOnce(&mut Value)) {
    let (id, payload): (String, String) = conn
        .query_row(
            "SELECT id, payload_json FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = ?2",
            params![run, kind],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("one artifact of the kind");
    let mut value: Value = serde_json::from_str(&payload).expect("artifact JSON");
    edit(&mut value);
    conn.execute(
        "UPDATE narrative_extraction_artifacts SET payload_json = ?2, payload_digest = ?3 WHERE id = ?1",
        params![
            id,
            canonical_json_string(&value).expect("canonical artifact"),
            canonical_json_digest(&value).expect("artifact digest")
        ],
    )
    .expect("store the rewritten artifact");
}

/// Rewrite values of the event of a first (AI root) revision the way a real
/// writer would have sealed them. `significance` / `actuality` (when the value is
/// a real one) go to the payload, the Envelope and the sealed plan together; the
/// Envelope digests and the Plan manifest are re-sealed. `narrativeFrame` /
/// `attribution` (and a value the product never writes, such as an empty
/// significance, used by negatives) live in the Envelope only: the Envelope is the
/// only place the judgement reads them. The upstream model-output records
/// (hypotheses, stage synthesis) are bound to the stage receipts and the model
/// response digests, so they keep what the model recorded; no writer or judgement
/// under test reads them.
fn reseal_assertion_values(conn: &Connection, revision: &str, edits: &[(&str, &str)]) {
    reseal_event(conn, revision, &|_| {}, edits);
}

/// [`reseal_assertion_values`] that also edits the proposal payload itself
/// (`edit_payload`), carried through the same sealed chain.
fn reseal_event(
    conn: &Connection,
    revision: &str,
    edit_payload: &dyn Fn(&mut Value),
    edits: &[(&str, &str)],
) {
    let (proposal, run, payload_text, raw): (String, String, String, String) = conn
        .query_row(
            "SELECT r.proposal_id, s.run_id, r.payload_json, r.reconciliation_envelope_json
               FROM narrative_proposal_revisions r
               JOIN narrative_proposals p ON p.id = r.proposal_id
               JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
              WHERE r.id = ?1 AND r.revision_number = 1",
            [revision],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("AI root revision");
    let mut payload: Value = serde_json::from_str(&payload_text).expect("payload JSON");
    let mut envelope: Value = serde_json::from_str(&raw).expect("Envelope JSON");
    let event_id = payload["eventId"].as_str().expect("eventId").to_owned();
    edit_payload(&mut payload);
    let mut sealed_fields = Vec::new();
    for (field, value) in edits {
        assert!(CHAIN_VALUE_FIELDS.contains(field), "{field}");
        envelope["assertion"]["payload"][*field] = json!(value);
        if matches!(*field, "significance" | "actuality") && chain_value_is_valid(field, value) {
            payload[*field] = json!(value);
            sealed_fields.push((*field, *value));
        }
    }
    envelope["projectionBinding"]["proposalPayloadDigest"] =
        json!(canonical_json_digest(&payload).expect("payload digest"));
    // The payload, on the revision and on the Proposal's initial copy.
    let payload_stored = serde_json::to_string(&payload).expect("payload text");
    conn.execute(
        "UPDATE narrative_proposal_revisions SET payload_json = ?2 WHERE id = ?1",
        params![revision, payload_stored],
    )
    .expect("store the payload");
    let updated = conn
        .execute(
            "UPDATE narrative_proposals SET payload_json = ?2 WHERE id = ?1 AND payload_json = ?3",
            params![proposal, payload_stored, payload_text],
        )
        .expect("store the Proposal's initial payload");
    assert_eq!(updated, 1, "the Proposal's initial payload copy is rewritten");
    // The sealed plan of the Run.
    rewrite_run_artifact(conn, &run, "chronicle.proposal-plan@1", |plan| {
        for entry in plan["proposals"].as_array_mut().expect("proposals") {
            if entry["eventId"] == event_id.as_str() {
                *entry = payload.clone();
            }
        }
        for planned in plan["planned"].as_array_mut().expect("planned") {
            if planned["proposal"]["eventId"] == event_id.as_str() {
                planned["proposal"] = payload.clone();
            }
        }
    });
    // The Envelope's assertion digests follow the assertion value.
    let (core_digest, assertion_digest) = assertion_digests_of(&envelope);
    envelope["assertionDigests"]["assertionCoreDigest"] = json!(core_digest);
    envelope["assertionDigests"]["assertionDigest"] = json!(assertion_digest);
    store_envelope(conn, revision, &envelope);
}

/// (assertionCoreDigest, assertionDigest) of an Envelope's assertion value.
fn assertion_digests_of(envelope: &Value) -> (String, String) {
    let assertion = &envelope["assertion"];
    let mut core = json!({
        "assertionKind": assertion["assertionKind"],
        "payloadSchemaRef": assertion["payloadSchemaRef"],
        "typedSemanticPayload": assertion["payload"],
        "modality": assertion["modality"],
        "polarity": assertion["polarity"],
        "supportClass": assertion["supportClass"],
        "producer": assertion["producer"],
    });
    if let Some(confidence) = assertion.get("producerConfidence") {
        core["producerConfidence"] = confidence.clone();
    }
    let core_digest = canonical_json_digest(&core).expect("assertion core digest");
    let scope_digest = envelope["assertionDigests"]["scopeDigest"].clone();
    let assertion_digest = canonical_json_digest(&json!({
        "assertionCoreDigest": core_digest,
        "scopeDigest": scope_digest,
    }))
    .expect("assertion digest");
    (core_digest, assertion_digest)
}

/// The sealed chain of an AI root agrees with itself the way a real writer's
/// output does: the payload digest the Envelope binds is the payload's, the
/// Envelope's assertion value is the payload's, the stored Envelope digest is the
/// Envelope's canonical digest, and the sealed plan carries the same payload.
fn assert_sealed_chain_agrees(conn: &Connection, revision: &str) {
    let (run, payload_text, raw, digest): (String, String, String, String) = conn
        .query_row(
            "SELECT s.run_id, r.payload_json, r.reconciliation_envelope_json,
                    r.reconciliation_envelope_digest
               FROM narrative_proposal_revisions r
               JOIN narrative_proposals p ON p.id = r.proposal_id
               JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
              WHERE r.id = ?1",
            [revision],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("revision of the chain");
    let payload: Value = serde_json::from_str(&payload_text).expect("payload");
    let envelope: Value = serde_json::from_str(&raw).expect("Envelope");
    assert_eq!(
        envelope["projectionBinding"]["proposalPayloadDigest"],
        json!(canonical_json_digest(&payload).expect("payload digest")),
        "the Envelope binds this payload"
    );
    assert_eq!(digest, canonical_json_digest(&envelope).expect("Envelope digest"));
    let (core_digest, assertion_digest) = assertion_digests_of(&envelope);
    assert_eq!(envelope["assertionDigests"]["assertionCoreDigest"], json!(core_digest));
    assert_eq!(envelope["assertionDigests"]["assertionDigest"], json!(assertion_digest));
    for field in ["significance", "actuality"] {
        assert_eq!(
            envelope["assertion"]["payload"][field], payload[field],
            "{field}: Envelope and payload agree"
        );
    }
    let plan: Value = serde_json::from_str(
        &conn
            .query_row(
                "SELECT payload_json FROM narrative_extraction_artifacts
                  WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1'",
                [&run],
                |row| row.get::<_, String>(0),
            )
            .expect("plan"),
    )
    .expect("plan JSON");
    assert!(plan["proposals"].as_array().expect("proposals").contains(&payload), "plan roster");
    assert!(
        plan["planned"]
            .as_array()
            .expect("planned")
            .iter()
            .any(|planned| planned["proposal"] == payload),
        "planned roster"
    );
}

/// Store an Envelope with its canonical digest and rebind the Plan manifest.
fn store_envelope(conn: &Connection, revision: &str, envelope: &Value) {
    conn.execute(
        "UPDATE narrative_proposal_revisions SET reconciliation_envelope_json = ?2,
            reconciliation_envelope_digest = ?3 WHERE id = ?1",
        params![
            revision,
            canonical_json_string(envelope).expect("canonical Envelope"),
            canonical_json_digest(envelope).expect("Envelope digest")
        ],
    )
    .expect("store the re-sealed Envelope");
    rebind_plan_manifest(conn, &set_of_revision(conn, revision));
}

/// Rewrite the sealed duplicate judgement of the planned entry of `event_id`.
fn reseal_plan_match(conn: &Connection, run: &str, event_id: &str, status: &str) {
    let (artifact_id, payload): (String, String) = conn
        .query_row(
            "SELECT id, payload_json FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1'",
            [run],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("plan artifact");
    let mut plan: Value = serde_json::from_str(&payload).expect("plan JSON");
    let mut changed = false;
    for planned in plan["planned"].as_array_mut().expect("planned roster") {
        if planned["proposal"]["eventId"] == event_id {
            planned["match"] = json!({ "status": status });
            changed = true;
        }
    }
    assert!(changed, "planned entry of the event");
    conn.execute(
        "UPDATE narrative_extraction_artifacts SET payload_json = ?2, payload_digest = ?3 WHERE id = ?1",
        params![
            artifact_id,
            canonical_json_string(&plan).expect("canonical plan"),
            canonical_json_digest(&plan).expect("plan digest")
        ],
    )
    .expect("store the re-sealed plan");
    rebind_plan_manifest(
        conn,
        plan["proposalSetId"].as_str().expect("plan ProposalSet"),
    );
}

/// A private two-window copy where the first proposal's AI root is a bulk
/// approval target (`scene-level`, the rest already `story-world` / `narrator` /
/// `actual`), after `setup` ran on a plain connection.
fn bulk_two_window(setup: impl FnOnce(&Connection)) -> (Fixture, Database) {
    let fixture = Fixture::two_window();
    {
        let conn = fixture.corruption_connection();
        reseal_assertion_values(&conn, TWO_WINDOW_UNREVIEWED_REVISION, &[("significance", "scene-level")]);
        setup(&conn);
    }
    let db = Database::new(&fixture.path).expect("Native private fixture");
    db.migrate().expect("migrate the private two-window copy");
    enable_manual_apply(&db);
    (fixture, db)
}

fn bulk_targets(db: &Database, proposals: &[&str]) -> Vec<ChronicleBulkApproveTarget> {
    db.with_conn(|conn| {
        proposals
            .iter()
            .map(|proposal| {
                Ok(ChronicleBulkApproveTarget {
                    proposal_id: (*proposal).to_owned(),
                    revision_id: conn.query_row(
                        "SELECT current_revision_id FROM narrative_proposals WHERE id = ?1",
                        [proposal],
                        |row| row.get(0),
                    )?,
                })
            })
            .collect()
    })
    .expect("current revisions of the targets")
}

fn bulk_approve_targets(
    db: &Database,
    fixture: &Fixture,
    run: &str,
    targets: Vec<ChronicleBulkApproveTarget>,
) -> Value {
    narrative_extraction_chronicle_bulk_approve(
        db,
        ChronicleBulkApprovePayload {
            project_id: fixture.project().to_owned(),
            run_id: run.to_owned(),
            targets,
        },
        &mut || false,
    )
    .expect("bulk approve")
}

/// proposalId -> `bulkApproval` of the review read.
fn read_bulk_approvals(db: &Database, fixture: &Fixture, run: &str) -> std::collections::BTreeMap<String, Value> {
    let bundle = narrative_extraction_get_run_review_bundle(
        db,
        RunRefPayload {
            run_id: run.to_owned(),
            project_id: fixture.project().to_owned(),
            chronicle_blocked_discard: None,
        },
    )
    .expect("review bundle");
    bundle["proposals"]
        .as_array()
        .expect("proposals")
        .iter()
        .map(|proposal| {
            (
                proposal["proposalId"].as_str().expect("id").to_owned(),
                proposal["bulkApproval"].clone(),
            )
        })
        .collect()
}

/// Everything a bulk approval may write, as one comparable string: Revisions,
/// Decisions, Freshness, Edges, the D1 declaration heads, the revision source basis,
/// the semantic-index cache flag and every proposal pointer.
fn bulk_state(db: &Database) -> String {
    db.with_conn(|conn| {
        let counts: (i64, i64, i64, i64, i64, i64, i64) = conn.query_row(
            "SELECT (SELECT COUNT(*) FROM narrative_proposal_revisions),
                    (SELECT COUNT(*) FROM narrative_proposal_decisions),
                    (SELECT COUNT(*) FROM narrative_consumer_freshness),
                    (SELECT COUNT(*) FROM narrative_dependency_edges),
                    (SELECT COUNT(*) FROM narrative_dependency_declaration_sets),
                    (SELECT COUNT(*) FROM narrative_dependency_declaration_heads),
                    (SELECT COUNT(*) FROM narrative_revision_source_basis)",
            [],
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
        let rows = |sql: &str| -> anyhow::Result<Vec<String>> {
            Ok(conn
                .prepare(sql)?
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?)
        };
        let pointers = rows("SELECT id || '|' || status || '|' || COALESCE(current_revision_id,'') FROM narrative_proposals ORDER BY id")?;
        let heads = rows(
            "SELECT consumer_kind || '|' || consumer_key || '|' || active_declaration_set_id || '|' || version
               FROM narrative_dependency_declaration_heads ORDER BY consumer_kind, consumer_key",
        )?;
        let source_basis = rows(
            "SELECT revision_id || '|' || source_key || '|' || revision_token
               FROM narrative_revision_source_basis ORDER BY revision_id, source_key, revision_token",
        )?;
        let cache = rows(
            "SELECT index_key || '|' || generation || '|' || dirty_cache_flag
               FROM narrative_semantic_index_metadata ORDER BY index_key",
        )?;
        Ok(format!("{counts:?} {pointers:?} {heads:?} {source_basis:?} {cache:?}"))
    })
    .expect("bulk state")
}

fn reasons_of(value: &Value) -> Vec<String> {
    value["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|reason| reason.as_str().expect("reason code").to_owned())
        .collect()
}

/// The review read and the write path agree, and an ineligible target writes nothing.
fn assert_bulk_refused(
    db: &Database,
    fixture: &Fixture,
    proposal: &str,
    expected: &[&str],
) {
    let read = read_bulk_approvals(db, fixture, TWO_WINDOW_RUN);
    let judged = &read[proposal];
    assert_eq!(judged["eligible"], false, "{proposal}: {judged}");
    let read_reasons = reasons_of(judged);
    let mut exact: Vec<String> = expected.iter().map(|code| (*code).to_owned()).collect();
    exact.sort();
    let mut sorted = read_reasons.clone();
    sorted.sort();
    assert_eq!(sorted, exact, "{proposal}: exactly these reasons");
    let before = bulk_state(db);
    let result = bulk_approve_targets(db, fixture, TWO_WINDOW_RUN, bulk_targets(db, &[proposal]));
    assert_eq!(result["approved"], json!([]), "{proposal}");
    assert_eq!(result["failed"], json!([]), "{proposal}");
    let skipped = result["skipped"].as_array().expect("skipped");
    assert_eq!(skipped.len(), 1, "{proposal}: {result}");
    assert_eq!(skipped[0]["proposalId"], proposal);
    assert_eq!(
        reasons_of(&skipped[0]),
        read_reasons,
        "{proposal}: the write path judges exactly like the read"
    );
    assert_eq!(bulk_state(db), before, "{proposal}: a refused target writes nothing");
}

const TWO_WINDOW_SECOND_ROOT: &str = "411f5ebc-84b4-406b-ad00-c94da2c8ccb9";

/// A private two-window copy where both proposals of the run are bulk-approval
/// targets: the second proposal's current Revision is moved back to its AI root
/// (resealed `scene-level`, like the first), its approval removed. The child
/// Revision the real product left stays as an unreferenced Revision 2.
fn bulk_two_window_two_targets() -> (Fixture, Database) {
    bulk_two_window(|conn| {
        conn.execute(
            "UPDATE narrative_proposals
                SET status = 'unreviewed', current_revision_id = ?2,
                    payload_json = (SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?2)
              WHERE id = ?1",
            params![TWO_WINDOW_SECOND_PROPOSAL, TWO_WINDOW_SECOND_ROOT],
        )
        .expect("move the second proposal back to its AI root");
        conn.execute(
            "DELETE FROM narrative_proposal_decisions WHERE proposal_id = ?1",
            params![TWO_WINDOW_SECOND_PROPOSAL],
        )
        .expect("remove the second proposal's approval");
        reseal_assertion_values(conn, TWO_WINDOW_SECOND_ROOT, &[("significance", "scene-level")]);
    })
}

/// `text` with what differs between two runs of the same operation masked: UUIDs,
/// 32- and 64-hex ids and digests and `YYYY-MM-DD[ T]HH:MM:SS[.fff][Z]` timestamps.
fn mask_volatile(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let hex = |c: char| c.is_ascii_hexdigit();
    let run = |from: usize, pred: &dyn Fn(char) -> bool| {
        chars[from..].iter().take_while(|c| pred(**c)).count()
    };
    let matches_at = |from: usize, shape: &str| {
        // `x` hex, `d` digit, any other character literal.
        let shape: Vec<char> = shape.chars().collect();
        from + shape.len() <= chars.len()
            && shape.iter().enumerate().all(|(offset, expected)| {
                let c = chars[from + offset];
                match expected {
                    'x' => hex(c),
                    'd' => c.is_ascii_digit(),
                    'T' => c == 'T' || c == ' ',
                    literal => c == *literal,
                }
            })
    };
    let mut masked = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let before_is_word = index > 0 && (chars[index - 1].is_ascii_alphanumeric());
        let hex_run = run(index, &hex);
        if !before_is_word
            && (hex_run == 32 || hex_run == 64)
            && run(index, &|c| c.is_ascii_alphanumeric()) == hex_run
        {
            masked.push_str("<HEX>");
            index += hex_run;
        } else if matches_at(index, "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx") {
            masked.push_str("<ID>");
            index += 36;
        } else if matches_at(index, "dddd-dd-ddTdd:dd:dd") {
            index += 19;
            if chars.get(index) == Some(&'.') {
                index += 1 + run(index + 1, &|c| c.is_ascii_digit());
            }
            if chars.get(index) == Some(&'Z') {
                index += 1;
            }
            masked.push_str("<T>");
        } else {
            masked.push(chars[index]);
            index += 1;
        }
    }
    masked
}

/// Every row of every ordinary table, masked and sorted: two databases hold the
/// same data exactly when these maps are equal (ids, digests and times of rows
/// that two runs of the same operation must differ in are masked).
fn masked_database_rows(db: &Database) -> std::collections::BTreeMap<String, Vec<String>> {
    db.with_conn(|conn| {
        let tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master
                  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                    AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
                  ORDER BY name",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let mut dump = std::collections::BTreeMap::new();
        for table in tables {
            let mut statement = conn.prepare(&format!("SELECT * FROM \"{table}\""))?;
            let columns = statement.column_count();
            let mut rows: Vec<String> = statement
                .query_map([], |row| {
                    let mut cells = Vec::with_capacity(columns);
                    for column in 0..columns {
                        cells.push(match row.get_ref(column)? {
                            rusqlite::types::ValueRef::Null => "NULL".to_owned(),
                            rusqlite::types::ValueRef::Integer(value) => value.to_string(),
                            rusqlite::types::ValueRef::Real(value) => value.to_string(),
                            rusqlite::types::ValueRef::Text(value) => {
                                String::from_utf8_lossy(value).into_owned()
                            }
                            rusqlite::types::ValueRef::Blob(value) => hex::encode(value),
                        });
                    }
                    Ok(mask_volatile(&cells.join(" | ")))
                })?
                .collect::<Result<_, _>>()?;
            rows.sort();
            dump.insert(table, rows);
        }
        Ok(dump)
    })
    .expect("masked database rows")
}

fn assert_same_database_rows(left: &Database, right: &Database, what: &str) {
    let (left, right) = (masked_database_rows(left), masked_database_rows(right));
    assert_eq!(left.keys().collect::<Vec<_>>(), right.keys().collect::<Vec<_>>(), "{what}: tables");
    let mut compared_rows = 0;
    for (table, rows) in &left {
        assert_eq!(rows, &right[table], "{what}: table {table}");
        compared_rows += rows.len();
    }
    assert!(compared_rows > 500, "{what}: a real comparison ({compared_rows} rows)");
}

/// 一括の承認は、「1 件ずつ、子の版を作って、承認する」の連続と、DB のどの行も同じにする。
/// 違ってよいのは、行の id、封印の digest（id を含む）、時刻だけ。
#[test]
fn bulk_approve_writes_the_same_rows_as_creating_and_approving_one_proposal_at_a_time() {
    let (fixture_bulk, db_bulk) = bulk_two_window_two_targets();
    let (fixture_each, db_each) = bulk_two_window_two_targets();
    let both = [TWO_WINDOW_FIRST_PROPOSAL, TWO_WINDOW_SECOND_PROPOSAL];

    let result = bulk_approve_targets(&db_bulk, &fixture_bulk, TWO_WINDOW_RUN, bulk_targets(&db_bulk, &both));
    assert_eq!(result["approved"].as_array().expect("approved").len(), 2, "{result}");
    assert_eq!(result["skipped"], json!([]), "{result}");
    assert_eq!(result["failed"], json!([]), "{result}");

    for proposal in both {
        let parent = bulk_targets(&db_each, &[proposal])[0].revision_id.clone();
        let child = try_create_native_child(&db_each, &fixture_each, &parent, |payload| {
            payload["disclosure"]["secret"] = json!(false);
        })
        .expect("one-at-a-time child");
        narrative_extraction_append_human_decision(
            &db_each,
            AppendDecisionPayload {
                run_id: TWO_WINDOW_RUN.to_owned(),
                project_id: fixture_each.project().to_owned(),
                proposal_id: proposal.to_owned(),
                revision_id: child,
                decision: "approved".to_owned(),
                decision_json: None,
                created_by: Some("chronicle-extract-dialog".to_owned()),
            },
        )
        .expect("one-at-a-time approval");
    }
    assert_same_database_rows(&db_bulk, &db_each, "after");
}

/// Corrupt the sealed plan artifact of the run BEFORE the command, so the up-front
/// (warm) verification of the command fails and nothing is reused. A rewrite DURING
/// the command is the tests of `bulk_approve_stops_like_one_at_a_time_when_a_reused_row_is_rewritten_between_proposals`.
/// The same outcome as before the plan was verified once (every target is `plan-unavailable`,
/// nothing is written) and the one-proposal writer still fails with its own code.
fn assert_broken_plan_is_refused(corrupt: impl FnOnce(&Connection), what: &str) {
    let (fixture, db) = bulk_two_window_two_targets();
    {
        let conn = fixture.corruption_connection();
        corrupt(&conn);
    }
    drop(db);
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let both = [TWO_WINDOW_FIRST_PROPOSAL, TWO_WINDOW_SECOND_PROPOSAL];
    let before = bulk_state(&db);
    let result = bulk_approve_targets(&db, &fixture, TWO_WINDOW_RUN, bulk_targets(&db, &both));
    assert_eq!(result["approved"], json!([]), "{what}: {result}");
    assert_eq!(result["failed"], json!([]), "{what}: {result}");
    let skipped = result["skipped"].as_array().expect("skipped");
    assert_eq!(skipped.len(), 2, "{what}: {result}");
    for target in skipped {
        assert!(reasons_of(target).iter().any(|r| r == "plan-unavailable"), "{what}: {result}");
    }
    assert_eq!(bulk_state(&db), before, "{what}: nothing is written");
    // The one-at-a-time writer verifies the plan itself and stops with its own code.
    let parent = bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL])[0].revision_id.clone();
    let error = narrative_extraction_append_human_decision(
        &db,
        AppendDecisionPayload {
            run_id: TWO_WINDOW_RUN.to_owned(),
            project_id: fixture.project().to_owned(),
            proposal_id: TWO_WINDOW_FIRST_PROPOSAL.to_owned(),
            revision_id: parent,
            decision: "rejected".to_owned(),
            decision_json: Some(json!({"probableDuplicateChoice": "skip-as-same"})),
            created_by: Some("nir1-bulk-test".to_owned()),
        },
    )
    .expect_err("a broken plan stops the one-at-a-time decision");
    assert!(
        format!("{error:#}").contains("NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT"),
        "{what}: {error:#}"
    );
    assert_eq!(bulk_state(&db), before, "{what}: the refused decision writes nothing");
}

#[test]
fn bulk_approve_with_a_plan_artifact_missing_before_the_command_stops_at_the_up_front_verification() {
    assert_broken_plan_is_refused(
        |conn| {
            conn.execute(
                "DELETE FROM narrative_extraction_artifacts
                  WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1'",
                [TWO_WINDOW_RUN],
            )
            .expect("remove the plan artifact");
        },
        "missing",
    );
}

#[test]
fn bulk_approve_with_a_plan_artifact_corrupted_before_the_command_stops_at_the_up_front_verification() {
    assert_broken_plan_is_refused(
        |conn| {
            conn.execute(
                "UPDATE narrative_extraction_artifacts
                    SET payload_json = json_set(payload_json, '$.planned[0].match.status', 'probable-duplicate')
                  WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1'",
                [TWO_WINDOW_RUN],
            )
            .expect("change a sealed match without its digest");
        },
        "corrupted",
    );
}

#[test]
fn bulk_approve_with_another_runs_plan_artifact_before_the_command_stops_at_the_up_front_verification() {
    assert_broken_plan_is_refused(
        |conn| {
            let other_run: String = conn
                .query_row(
                    "SELECT s.run_id FROM narrative_proposals p
                       JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id WHERE p.id = ?1",
                    [TWO_WINDOW_OTHER_RUN_PROPOSAL],
                    |row| row.get(0),
                )
                .expect("the other run");
            assert_ne!(other_run, TWO_WINDOW_RUN);
            let swapped = conn
                .execute(
                    "UPDATE narrative_extraction_artifacts
                        SET payload_json = (SELECT payload_json FROM narrative_extraction_artifacts
                                             WHERE run_id = ?2 AND artifact_kind = 'chronicle.proposal-plan@1'),
                            payload_digest = (SELECT payload_digest FROM narrative_extraction_artifacts
                                               WHERE run_id = ?2 AND artifact_kind = 'chronicle.proposal-plan@1')
                      WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1'",
                    params![TWO_WINDOW_RUN, other_run],
                )
                .expect("put the other run's plan in this run");
            assert_eq!(swapped, 1);
        },
        "another run's",
    );
}

/// 一括の途中（提案と提案の間）で、別の書き手が組を消費（取り込み）すると、次の提案は、今と同じ理由
/// （`set-applied`）で止まり、書かれない。消費の見張りは、提案ごとに、その提案の transaction の中で読む。
#[test]
fn bulk_approve_stops_the_next_proposal_when_the_set_is_consumed_between_proposals() {
    let (fixture, db) = bulk_two_window_two_targets();
    let both = [TWO_WINDOW_FIRST_PROPOSAL, TWO_WINDOW_SECOND_PROPOSAL];
    let targets = bulk_targets(&db, &both);
    let mut asked = 0;
    let result = narrative_extraction_chronicle_bulk_approve(
        &db,
        ChronicleBulkApprovePayload {
            project_id: fixture.project().to_owned(),
            run_id: TWO_WINDOW_RUN.to_owned(),
            targets,
        },
        &mut || {
            asked += 1;
            if asked == 2 {
                // Another writer consumes the set after the first proposal was approved.
                db.with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO narrative_proposal_applications
                            (id, commit_id, proposal_id, revision_id, applied_entity_kind, applied_entity_id, created_at)
                         SELECT 'bao-consumed', 'bao-commit', ?1, current_revision_id, 'event', 'bao-event', datetime('now')
                           FROM narrative_proposals WHERE id = ?1",
                        [TWO_WINDOW_FIRST_PROPOSAL],
                    )?;
                    Ok(())
                })
                .expect("consume the set");
            }
            false
        },
    )
    .expect("bulk approve");
    let approved = result["approved"].as_array().expect("approved");
    assert_eq!(approved.len(), 1, "{result}");
    assert_eq!(approved[0]["proposalId"], TWO_WINDOW_FIRST_PROPOSAL);
    assert_eq!(result["failed"], json!([]), "{result}");
    let skipped = result["skipped"].as_array().expect("skipped");
    assert_eq!(skipped.len(), 1, "{result}");
    assert_eq!(skipped[0]["proposalId"], TWO_WINDOW_SECOND_PROPOSAL);
    assert!(reasons_of(&skipped[0]).iter().any(|r| r == "set-applied"), "{result}");
    db.with_conn(|conn| {
        let (status, revisions): (String, i64) = conn.query_row(
            "SELECT p.status, (SELECT COUNT(*) FROM narrative_proposal_revisions WHERE proposal_id = p.id)
               FROM narrative_proposals p WHERE p.id = ?1",
            [TWO_WINDOW_SECOND_PROPOSAL],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!((status.as_str(), revisions), ("unreviewed", 2), "the stopped proposal is untouched");
        Ok(())
    })
    .expect("the stopped proposal");
}

/// 一括を 2 件で走らせ、1 件目を承認した後・2 件目の前（「止めるか」を聞かれる所）で、別の接続が
/// `between` で DB を書き換える。
fn bulk_approve_both_with_a_write_between(
    fixture: &Fixture,
    db: &Database,
    between: impl FnOnce(&Connection),
) -> Value {
    let both = [TWO_WINDOW_FIRST_PROPOSAL, TWO_WINDOW_SECOND_PROPOSAL];
    let targets = bulk_targets(db, &both);
    let mut between = Some(between);
    let mut asked = 0;
    narrative_extraction_chronicle_bulk_approve(
        db,
        ChronicleBulkApprovePayload {
            project_id: fixture.project().to_owned(),
            run_id: TWO_WINDOW_RUN.to_owned(),
            targets,
        },
        &mut || {
            asked += 1;
            if asked == 2 {
                if let Some(between) = between.take() {
                    let other = Connection::open(&fixture.path).expect("another connection");
                    other
                        .busy_timeout(std::time::Duration::from_secs(5))
                        .expect("busy timeout");
                    between(&other);
                }
            }
            false
        },
    )
    .expect("bulk approve")
}

/// `NEX_...` の先頭の符号（失敗の鎖の文面から）。
fn first_nex_code(text: &str) -> String {
    let start = text.find("NEX_").expect("a NEX_ code");
    text[start..]
        .chars()
        .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_')
        .collect()
}

/// 同じ書き換えを先に済ませた DB で、2 件目を「1 件ずつ（子の版を作って承認）」で通したときの、
/// 最初の失敗の符号。通れば `None`。
fn one_at_a_time_second_proposal_failure(mutate: impl FnOnce(&Connection)) -> Option<String> {
    let (fixture, db) = bulk_two_window_two_targets();
    mutate(&Connection::open(&fixture.path).expect("another connection"));
    let parent = bulk_targets(&db, &[TWO_WINDOW_SECOND_PROPOSAL])[0].revision_id.clone();
    let child = match try_create_native_child(&db, &fixture, &parent, |payload| {
        payload["disclosure"]["secret"] = json!(false);
    }) {
        Ok(child) => child,
        Err(error) => return Some(first_nex_code(&format!("{error:#}"))),
    };
    narrative_extraction_append_human_decision(
        &db,
        AppendDecisionPayload {
            run_id: TWO_WINDOW_RUN.to_owned(),
            project_id: fixture.project().to_owned(),
            proposal_id: TWO_WINDOW_SECOND_PROPOSAL.to_owned(),
            revision_id: child,
            decision: "approved".to_owned(),
            decision_json: None,
            created_by: Some("chronicle-extract-dialog".to_owned()),
        },
    )
    .err()
    .map(|error| first_nex_code(&format!("{error:#}")))
}

/// 使い回す行（計画の artifact の digest、計画／Snapshot の Task の status、Run の digest）を、
/// command の途中（提案と提案の間）で別の接続が書き換えると、2 件目は 1 件ずつの経路と同じ失敗の符号で
/// 止まり、何も書かれない（1 件目は承認済みのまま）。書く transaction の中の照合（主キーの読み）が
/// 使い回しをやめ、書き手が全検証に落ちるから。照合が無い使い回しだけの版では、2 件目が承認されてしまう
/// （Run の catalog digest だけは、子の版を書く側の別の検査でも止まるので、照合が無くても通る）。
#[test]
fn bulk_approve_stops_like_one_at_a_time_when_a_reused_row_is_rewritten_between_proposals() {
    type Rewrite = fn(&Connection);
    let cases: [(&str, Rewrite); 5] = [
        ("plan artifact digest", |conn| {
            conn.execute(
                "UPDATE narrative_extraction_artifacts SET payload_digest = payload_digest || '0'
                  WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1'",
                [TWO_WINDOW_RUN],
            )
            .expect("rewrite the plan artifact digest");
        }),
        ("plan owner task status", |conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks SET status = 'failed'
                  WHERE id = (SELECT task_id FROM narrative_extraction_artifacts
                               WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1')",
                [TWO_WINDOW_RUN],
            )
            .expect("rewrite the plan owner task status");
        }),
        ("snapshot task status", |conn| {
            conn.execute(
                "UPDATE narrative_extraction_tasks SET status = 'failed'
                  WHERE run_id = ?1 AND task_kind = 'source.snapshot@1'",
                [TWO_WINDOW_RUN],
            )
            .expect("rewrite the snapshot task status");
        }),
        ("run snapshot digest", |conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs SET snapshot_digest = snapshot_digest || '0' WHERE id = ?1",
                [TWO_WINDOW_RUN],
            )
            .expect("rewrite the run snapshot digest");
        }),
        ("run catalog digest", |conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs SET catalog_digest = catalog_digest || '0' WHERE id = ?1",
                [TWO_WINDOW_RUN],
            )
            .expect("rewrite the run catalog digest");
        }),
    ];
    for (label, rewrite) in cases {
        let expected = one_at_a_time_second_proposal_failure(rewrite)
            .unwrap_or_else(|| panic!("{label}: the one-at-a-time path must stop on this rewrite"));
        let (fixture, db) = bulk_two_window_two_targets();
        let result = bulk_approve_both_with_a_write_between(&fixture, &db, rewrite);
        let approved = result["approved"].as_array().expect("approved");
        assert_eq!(approved.len(), 1, "{label}: {result}");
        assert_eq!(approved[0]["proposalId"], TWO_WINDOW_FIRST_PROPOSAL, "{label}: {result}");
        assert_eq!(result["skipped"], json!([]), "{label}: {result}");
        assert_eq!(
            result["failed"],
            json!([{"proposalId": TWO_WINDOW_SECOND_PROPOSAL, "code": expected}]),
            "{label}: stops with the one-at-a-time failure code"
        );
        db.with_conn(|conn| {
            let (status, revisions): (String, i64) = conn.query_row(
                "SELECT p.status, (SELECT COUNT(*) FROM narrative_proposal_revisions WHERE proposal_id = p.id)
                   FROM narrative_proposals p WHERE p.id = ?1",
                [TWO_WINDOW_SECOND_PROPOSAL],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!((status.as_str(), revisions), ("unreviewed", 2), "{label}: the stopped proposal is untouched");
            Ok(())
        })
        .expect("the stopped proposal");
    }
}

/// 照合が違いを見つけても、書き手の全検証が通る書き換え（Task の version だけ）なら、2 件目は
/// 1 件ずつの経路と同じく承認される（照合は余計に止めない）。
#[test]
fn bulk_approve_still_approves_when_only_a_checked_version_changes_between_proposals() {
    let (fixture, db) = bulk_two_window_two_targets();
    let result = bulk_approve_both_with_a_write_between(&fixture, &db, |conn| {
        conn.execute(
            "UPDATE narrative_extraction_tasks SET version = version + 1
              WHERE run_id = ?1 AND task_kind = 'source.snapshot@1'",
            [TWO_WINDOW_RUN],
        )
        .expect("bump the snapshot task version");
    });
    assert_eq!(result["approved"].as_array().expect("approved").len(), 2, "{result}");
    assert_eq!(result["skipped"], json!([]), "{result}");
    assert_eq!(result["failed"], json!([]), "{result}");
}

/// 提案ごとに読み直す物は、これまで通り止める：2 件目の現在の版が変わった（作者が編集した）なら
/// 「変わった」、Run の spec が変わったなら書き手の失敗（符号は 1 件ずつの経路と同じ）。
#[test]
fn bulk_approve_stops_the_next_proposal_when_its_revision_or_the_run_spec_changes_between_proposals() {
    // 作者が 2 件目を編集した。
    let (fixture, db) = bulk_two_window_two_targets();
    let result = bulk_approve_both_with_a_write_between(&fixture, &db, |_| {
        create_native_child(&db, &fixture, TWO_WINDOW_SECOND_ROOT, |payload| {
            payload["title"] = json!("Edited between proposals");
        });
    });
    assert_eq!(result["approved"].as_array().expect("approved").len(), 1, "{result}");
    assert_eq!(result["failed"], json!([]), "{result}");
    assert_eq!(
        result["skipped"],
        json!([{"proposalId": TWO_WINDOW_SECOND_PROPOSAL, "reasons": ["revision-changed"]}]),
        "{result}"
    );

    // Run の spec が変わった。
    let respec: fn(&Connection) = |conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs SET spec_json = json_set(spec_json, '$.bulkApproveTest', 1) WHERE id = ?1",
            [TWO_WINDOW_RUN],
        )
        .expect("rewrite the run spec");
    };
    let expected = one_at_a_time_second_proposal_failure(respec)
        .expect("the one-at-a-time path stops on a changed Run spec");
    let (fixture, db) = bulk_two_window_two_targets();
    let result = bulk_approve_both_with_a_write_between(&fixture, &db, respec);
    assert_eq!(result["approved"].as_array().expect("approved").len(), 1, "{result}");
    assert_eq!(result["skipped"], json!([]), "{result}");
    assert_eq!(
        result["failed"],
        json!([{"proposalId": TWO_WINDOW_SECOND_PROPOSAL, "code": expected}]),
        "{result}"
    );
}

/// 正例：対象の提案が、command 1 回で、秘密の印を外した子の版（human-derived、変わった項目は
/// `/disclosure/secret` だけ）と、その版への Human の承認を持つ。承認の actor／権限の範囲は
/// 1 件ずつの承認と同じで、子の版は IR の資格を通る。その後、取り込みが通り、出来事は secret。
#[test]
fn bulk_approve_writes_the_unsealed_child_and_its_human_approval() {
    let (fixture, db) = bulk_two_window(|_| {});
    let root = TWO_WINDOW_UNREVIEWED_REVISION;
    assert_sealed_chain_agrees(&fixture.read_only(), root);
    let read = read_bulk_approvals(&db, &fixture, TWO_WINDOW_RUN);
    assert_eq!(read[TWO_WINDOW_FIRST_PROPOSAL]["eligible"], true, "{read:?}");
    assert_eq!(reasons_of(&read[TWO_WINDOW_FIRST_PROPOSAL]), Vec::<String>::new());
    // 承認済みの編集版は、承認済み・編集済み・見せる理由（major）で対象外。
    assert_eq!(read[TWO_WINDOW_SECOND_PROPOSAL]["eligible"], false);
    let second = reasons_of(&read[TWO_WINDOW_SECOND_PROPOSAL]);
    for code in ["approved", "edited", "r3-significance"] {
        assert!(second.iter().any(|r| r == code), "{code} in {second:?}");
    }
    db.with_conn(|conn| {
        // 未承認・secret の AI の版は、資格を通らない（漏れ 0）。
        assert_unavailable(conn, &fixture, root, fixture.scene("s2"));
        Ok(())
    })
    .expect("root is not retrievable before");

    let targets = bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]);
    let result = bulk_approve_targets(&db, &fixture, TWO_WINDOW_RUN, targets);
    assert_eq!(result["skipped"], json!([]), "{result}");
    assert_eq!(result["failed"], json!([]), "{result}");
    assert_eq!(result["stopped"], false);
    let approved = result["approved"].as_array().expect("approved");
    assert_eq!(approved.len(), 1, "{result}");
    let child = approved[0]["revisionId"].as_str().expect("child").to_owned();
    let decision = approved[0]["decisionId"].as_str().expect("decision").to_owned();
    assert_eq!(approved[0]["proposalId"], TWO_WINDOW_FIRST_PROPOSAL);
    assert_ne!(child, root);

    db.with_conn(|conn| {
        let (basis, parent, number, root_payload, child_payload): (String, String, i64, String, String) = conn.query_row(
            "SELECT json_extract(c.reconciliation_envelope_json, '$.revisionBasis.kind'),
                    json_extract(c.reconciliation_envelope_json, '$.revisionBasis.parentRevisionId'),
                    c.revision_number, r.payload_json, c.payload_json
               FROM narrative_proposal_revisions c, narrative_proposal_revisions r
              WHERE c.id = ?1 AND r.id = ?2",
            params![child, root],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )?;
        assert_eq!((basis.as_str(), parent.as_str(), number), ("human-derived", root, 2));
        let mut expected: Value = serde_json::from_str(&root_payload)?;
        assert_eq!(expected["disclosure"]["secret"], true);
        expected["disclosure"]["secret"] = json!(false);
        assert_eq!(
            serde_json::from_str::<Value>(&child_payload)?,
            expected,
            "only /disclosure/secret changed"
        );
        // 承認の記録は、1 件ずつの承認（native_human_decision）と同じ actor／権限の範囲。
        let stored: (String, String, String, String, String, String, String) = conn.query_row(
            "SELECT revision_id, decision, actor_kind, actor_id, authority_scope, created_by, decision_json
               FROM narrative_proposal_decisions WHERE id = ?1",
            [&decision],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )?;
        assert_eq!(
            stored,
            (
                child.clone(),
                "approved".to_owned(),
                "human".to_owned(),
                "electron:human-review".to_owned(),
                format!("project/{}/proposal/{TWO_WINDOW_FIRST_PROPOSAL}/revision/{child}", fixture.project()),
                "chronicle-extract-dialog".to_owned(),
                "{}".to_owned(),
            )
        );
        let (status, current): (String, String) = conn.query_row(
            "SELECT status, current_revision_id FROM narrative_proposals WHERE id = ?1",
            [TWO_WINDOW_FIRST_PROPOSAL],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!((status, current), ("approved".to_owned(), child.clone()));
        Ok(())
    })
    .expect("child revision and approval");
    // Freshness の周期が空になるまで回す（この作りでは、版の作成が出した分は既に評価済みのこともある）。
    for _ in 0..8 {
        if matches!(
            run_incremental_freshness_cycle(&db).expect("production Native Freshness cycle"),
            IncrementalFreshnessCycleOutcome::Idle
        ) {
            break;
        }
    }
    db.with_conn(|conn| {
        assert_complete_and_fresh(conn, &fixture, &child);
        // この fixture の 2 つの場面は、どちらも版の材料（source basis）に入る。問い合わせの場面は、
        // 両方より後の場面（en-query-05）にする。
        let tx = conn.unchecked_transaction()?;
        let read = read_revision_retrieval_eligibility(&tx, fixture.project(), &child, BULK_QUERY_SCENE)?;
        assert!(matches!(read, RevisionEligibilityRead::Eligible(_)), "approved unsealed child: {read:?}");
        // 元の AI の版は、今も資格を通らない。
        let read = read_revision_retrieval_eligibility(&tx, fixture.project(), root, BULK_QUERY_SCENE)?;
        assert!(matches!(read, RevisionEligibilityRead::Unavailable { .. }), "AI root: {read:?}");
        Ok(())
    })
    .expect("the approved unsealed child passes the retrieval eligibility");

    // 取り込み（prepare → apply）が通り、年表の出来事は secret。
    let revisions = approved_current_revisions_of_run(&db, TWO_WINDOW_RUN);
    assert_eq!(revisions.len(), 2);
    let prepare = chronicle_prepare_payload(&db, &fixture, "bao-two-window-apply", &revisions);
    prepare_and_apply(&db, &prepare);
    assert_eq!(event_row_of(&db, &child).0, 1, "the Chronicle Event is secret");
    // 取り込み済みの組は、対象にならない（読み出しも、command も）。
    let again = read_bulk_approvals(&db, &fixture, TWO_WINDOW_RUN);
    for proposal in [TWO_WINDOW_FIRST_PROPOSAL, TWO_WINDOW_SECOND_PROPOSAL] {
        let reasons = reasons_of(&again[proposal]);
        assert!(reasons.iter().any(|r| r == "applied") && reasons.iter().any(|r| r == "set-applied"), "{reasons:?}");
    }
    let before = bulk_state(&db);
    let consumed = bulk_approve_targets(
        &db,
        &fixture,
        TWO_WINDOW_RUN,
        bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL, TWO_WINDOW_SECOND_PROPOSAL]),
    );
    assert_eq!(consumed["approved"], json!([]), "{consumed}");
    for skipped in consumed["skipped"].as_array().expect("skipped") {
        let reasons = reasons_of(skipped);
        assert!(reasons.iter().any(|r| r == "set-applied"), "{reasons:?}");
    }
    assert_eq!(consumed["skipped"].as_array().expect("skipped").len(), 2);
    assert_eq!(bulk_state(&db), before, "a consumed set is never written to");
}

const TWO_WINDOW_FIRST_EVENT: &str = "fbe1f4a3-bd22-4dd4-a6d1-87456eb7fc08";

/// 見せる理由（R1〜R4、未知の値は R0）が付く提案は、一覧に入れても書かれず、理由が返る。
/// 読み出しの判定と、書く直前の判定は同じ。
#[test]
fn bulk_approve_refuses_every_review_reason() {
    for (edits, expected) in [
        (vec![("narrativeFrame", "flashback")], "r1-narrative-frame"),
        (vec![("narrativeFrame", "dream")], "r1-narrative-frame"),
        (vec![("attribution", "character:mara")], "r2-attribution"),
        (vec![("attribution", "unknown")], "r2-attribution"),
        (vec![("significance", "major")], "r3-significance"),
        (vec![("actuality", "attempted")], "r4-actuality"),
        (vec![("actuality", "prevented")], "r4-actuality"),
        (vec![("narrativeFrame", "mystery")], "r0-material-unavailable"),
        (vec![("significance", "")], "r0-material-unavailable"),
    ] {
        let (fixture, db) = bulk_two_window(|conn| {
            reseal_assertion_values(conn, TWO_WINDOW_UNREVIEWED_REVISION, &edits);
        });
        assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &[expected]);
    }
}

/// 版が V2 でない（値が読めない）提案は、R0 で対象外。
#[test]
fn bulk_approve_refuses_a_revision_that_is_not_v2() {
    let (fixture, db) = bulk_two_window(|conn| {
        let raw: String = conn
            .query_row(
                "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
                [TWO_WINDOW_UNREVIEWED_REVISION],
                |row| row.get(0),
            )
            .expect("Envelope");
        let mut envelope: Value = serde_json::from_str(&raw).expect("Envelope JSON");
        envelope["schemaVersion"] = json!(1);
        store_envelope(conn, TWO_WINDOW_UNREVIEWED_REVISION, &envelope);
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["r0-material-unavailable"]);
}

/// 保留・延期・却下・承認済みは、それぞれ別の理由で対象外。
#[test]
fn bulk_approve_refuses_every_non_unreviewed_status() {
    for (status, expected) in [
        ("approved", "approved"),
        ("rejected", "rejected"),
        ("held", "held"),
        ("deferred", "deferred"),
    ] {
        let (fixture, db) = bulk_two_window(|conn| {
            conn.execute(
                "UPDATE narrative_proposals SET status = ?2 WHERE id = ?1",
                params![TWO_WINDOW_FIRST_PROPOSAL, status],
            )
            .expect("status of the private copy");
        });
        assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &[expected]);
    }
}

/// 作者が 1 度でも編集した提案は、元に戻していても対象外（版の id で判定し、中身の比較は使わない）。
/// 一覧が古い（版の id が違う）提案は「変わった」で返る。
#[test]
fn bulk_approve_refuses_an_edited_proposal_even_when_restored() {
    // 題を直した版。
    let (fixture, db) = bulk_two_window(|_| {});
    let title: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT json_extract(payload_json, '$.title') FROM narrative_proposal_revisions WHERE id = ?1",
                [TWO_WINDOW_UNREVIEWED_REVISION],
                |row| row.get(0),
            )?)
        })
        .expect("title");
    let stale = bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]);
    let edited = create_native_child(&db, &fixture, TWO_WINDOW_UNREVIEWED_REVISION, |payload| {
        payload["title"] = json!("Another title");
    });
    // 題が封印済みの計画の題と違うので、重複の可能性の再確認も付く（今の承認の検査と同じ保守的な扱い）。
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["edited", "probable-duplicate"]);
    // 題を元に戻した版（中身は AI の版と同じ）。
    let restored = create_native_child(&db, &fixture, &edited, |payload| {
        payload["title"] = json!(title);
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["edited"]);
    // 作者が secret を外し、まだ承認していない版。
    create_native_child(&db, &fixture, &restored, |payload| {
        payload["disclosure"]["secret"] = json!(false);
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["edited"]);
    // 画面が持っていた古い版の id。
    let before = bulk_state(&db);
    let result = bulk_approve_targets(&db, &fixture, TWO_WINDOW_RUN, stale);
    assert_eq!(result["approved"], json!([]));
    assert_eq!(result["skipped"], json!([{"proposalId": TWO_WINDOW_FIRST_PROPOSAL, "reasons": ["revision-changed"]}]));
    assert_eq!(bulk_state(&db), before);
}

/// 重複の可能性（封印済みの計画の判定）、根拠の対応が欠ける提案、開示の場面が解決できない提案は対象外。
#[test]
fn bulk_approve_refuses_duplicate_evidence_and_unresolvable_reveal() {
    let (fixture, db) = bulk_two_window(|conn| {
        reseal_plan_match(conn, TWO_WINDOW_RUN, TWO_WINDOW_FIRST_EVENT, "probable-duplicate");
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["probable-duplicate"]);

    // 根拠の記録（evidence.resolved@1）に、Envelope の根拠が 1 件も対応しない。
    let (fixture, db) = bulk_two_window(|conn| {
        let (id, payload): (String, String) = conn
            .query_row(
                "SELECT id, payload_json FROM narrative_extraction_artifacts
                  WHERE run_id = ?1 AND artifact_kind = 'evidence.resolved@1'",
                [TWO_WINDOW_RUN],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("evidence artifact");
        let mut artifact: Value = serde_json::from_str(&payload).expect("artifact JSON");
        artifact["anchors"]
            .as_array_mut()
            .expect("anchors")
            .retain(|anchor| anchor["id"] != "anchor-0001");
        conn.execute(
            "UPDATE narrative_extraction_artifacts SET payload_json = ?2, payload_digest = ?3 WHERE id = ?1",
            params![
                id,
                canonical_json_string(&artifact).expect("canonical"),
                canonical_json_digest(&artifact).expect("digest")
            ],
        )
        .expect("evidence artifact without the anchor");
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["evidence-unverified"]);

    // 根拠の対応は取れるが、解決の方法が完全一致（exact／exact-with-context）でない。
    let (fixture, db) = bulk_two_window(|conn| {
        rewrite_run_artifact(conn, TWO_WINDOW_RUN, "evidence.resolved@1", |artifact| {
            for anchor in artifact["anchors"].as_array_mut().expect("anchors") {
                if anchor["id"] == "anchor-0001" {
                    anchor["method"] = json!("fragmented");
                }
            }
        });
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["evidence-unverified"]);

    // 開示の場面が、今の場面の一覧から消えた（子の版を今は作れない）。
    let (fixture, db) = bulk_two_window(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET archived_at = datetime('now') WHERE id = 'en-distractor-gift'",
            [],
        )
        .expect("archive the reveal Scene");
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["reveal-scene-unresolved"]);
}

/// 別の抽出の提案・存在しない提案は書かれず、同じコードで返る。別の抽出・不正な入力は拒まれる。
#[test]
fn bulk_approve_refuses_foreign_targets_and_invalid_requests() {
    let (fixture, db) = bulk_two_window(|_| {});
    let before = bulk_state(&db);
    let mut targets = bulk_targets(&db, &[TWO_WINDOW_OTHER_RUN_PROPOSAL]);
    targets.push(ChronicleBulkApproveTarget {
        proposal_id: "no-such-proposal".to_owned(),
        revision_id: "no-such-revision".to_owned(),
    });
    let result = bulk_approve_targets(&db, &fixture, TWO_WINDOW_RUN, targets);
    assert_eq!(result["approved"], json!([]));
    assert_eq!(
        result["skipped"],
        json!([
            {"proposalId": TWO_WINDOW_OTHER_RUN_PROPOSAL, "reasons": ["proposal-not-found"]},
            {"proposalId": "no-such-proposal", "reasons": ["proposal-not-found"]},
        ])
    );
    assert_eq!(bulk_state(&db), before);

    let first = bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]);
    let request = |project: &str, run: &str, targets: Vec<ChronicleBulkApproveTarget>| {
        narrative_extraction_chronicle_bulk_approve(
            &db,
            ChronicleBulkApprovePayload {
                project_id: project.to_owned(),
                run_id: run.to_owned(),
                targets,
            },
            &mut || false,
        )
    };
    assert!(request(fixture.project(), TWO_WINDOW_RUN, vec![]).is_err(), "empty list");
    let twice = vec![first[0].clone(), first[0].clone()];
    assert!(request(fixture.project(), TWO_WINDOW_RUN, twice).is_err(), "duplicate target");
    assert!(request("another-project", TWO_WINDOW_RUN, first.clone()).is_err(), "another project");
    assert!(request(fixture.project(), "another-run", first).is_err(), "unknown run");
    assert_eq!(bulk_state(&db), before, "an invalid request writes nothing");

    // 入力は未知の項目を拒む。中身、secret の値、actor、要求の識別は受け取らない。
    for extra in [
        ("proposalPayload", json!({"title": "x"})),
        ("secret", json!(false)),
        ("actor", json!("electron:human-review")),
        ("requestId", json!("r1")),
    ] {
        let mut wire = json!({
            "projectId": "p", "runId": "r",
            "targets": [{"proposalId": "a", "revisionId": "b"}],
        });
        wire[extra.0] = extra.1;
        assert!(serde_json::from_value::<ChronicleBulkApprovePayload>(wire).is_err(), "{}", extra.0);
    }
    let mut wire = json!({"projectId": "p", "runId": "r", "targets": [{"proposalId": "a", "revisionId": "b", "payload": {}}]});
    assert!(serde_json::from_value::<ChronicleBulkApprovePayload>(wire.clone()).is_err());
    wire["targets"][0] = json!({"proposalId": "a", "revisionId": "b"});
    assert!(serde_json::from_value::<ChronicleBulkApprovePayload>(wire).is_ok());
}

/// 子の版の前提（project の意味の世代の記録、親の版の封印の記録）が無い提案は、対象外。
#[test]
fn bulk_approve_refuses_when_the_child_prerequisites_are_missing() {
    let (fixture, db) = bulk_two_window(|conn| {
        conn.execute_batch("PRAGMA foreign_keys = OFF; DELETE FROM narrative_semantic_epochs;")
            .expect("remove the Semantic Epoch records of the private copy");
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["semantic-epoch-missing"]);

    let (fixture, db) = bulk_two_window(|conn| {
        conn.execute(
            "DELETE FROM narrative_dependency_declaration_heads
              WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1",
            [TWO_WINDOW_UNREVIEWED_REVISION],
        )
        .expect("remove the parent's D1 head of the private copy");
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["parent-seal-missing"]);
}

/// 承認が途中（子の版を書いた後）で失敗した提案は、何も書かれず（子の版だけが残らない）、後ろの
/// 対象の判定は続く。失敗を取り除いて同じ要求を送ると処理され、もう一度送っても二重にならない。
#[test]
fn bulk_approve_rolls_back_a_failed_proposal_continues_and_is_idempotent() {
    let (fixture, db) = bulk_two_window(|_| {});
    let pointer = |db: &Database, proposal: &str| -> (String, String, i64) {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT p.status, p.current_revision_id,
                        (SELECT COUNT(*) FROM narrative_proposal_revisions WHERE proposal_id = p.id)
                   FROM narrative_proposals p WHERE p.id = ?1",
                [proposal],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("proposal pointer")
    };
    let first_before = pointer(&db, TWO_WINDOW_FIRST_PROPOSAL);
    let state_before = bulk_state(&db);

    // 一覧に無い提案は、対象であっても書かれない。
    let only_second = bulk_targets(&db, &[TWO_WINDOW_SECOND_PROPOSAL]);
    let result = bulk_approve_targets(&db, &fixture, TWO_WINDOW_RUN, only_second);
    assert_eq!(result["approved"], json!([]), "{result}");
    assert_eq!(result["skipped"].as_array().expect("skipped").len(), 1, "{result}");
    assert_eq!(bulk_state(&db), state_before, "not listed -> not written");
    assert_eq!(pointer(&db, TWO_WINDOW_FIRST_PROPOSAL), first_before);

    // 1 件目の承認だけが失敗する。
    db.with_conn(|conn| {
        conn.execute_batch(&format!(
            "CREATE TRIGGER bao_injected_failure BEFORE INSERT ON narrative_proposal_decisions
               WHEN NEW.proposal_id = '{TWO_WINDOW_FIRST_PROPOSAL}'
             BEGIN SELECT RAISE(ABORT, 'bao-injected-failure'); END;"
        ))?;
        Ok(())
    })
    .expect("failure injection on the private copy");
    let both = bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL, TWO_WINDOW_SECOND_PROPOSAL]);
    let result = bulk_approve_targets(&db, &fixture, TWO_WINDOW_RUN, both.clone());
    assert_eq!(result["approved"], json!([]), "{result}");
    assert_eq!(result["failed"].as_array().expect("failed").len(), 1, "{result}");
    assert_eq!(result["failed"][0]["proposalId"], TWO_WINDOW_FIRST_PROPOSAL);
    assert!(result["failed"][0]["code"].as_str().expect("code").starts_with("NEX_"), "{result}");
    let skipped = result["skipped"].as_array().expect("skipped");
    assert_eq!(skipped.len(), 1, "the target after the failure is still judged: {result}");
    assert_eq!(skipped[0]["proposalId"], TWO_WINDOW_SECOND_PROPOSAL);
    assert_eq!(result["stopped"], false);
    assert_eq!(
        pointer(&db, TWO_WINDOW_FIRST_PROPOSAL),
        first_before,
        "the failed proposal keeps no child revision and no decision"
    );
    assert_eq!(bulk_state(&db), state_before, "a failed proposal leaves nothing behind");
    db.with_conn(|conn| {
        assert!(conn.is_autocommit());
        Ok(())
    })
    .expect("no transaction is left open");

    // 失敗を取り除くと処理される。済んだ分は二重にならない。
    db.with_conn(|conn| Ok(conn.execute_batch("DROP TRIGGER bao_injected_failure")?))
        .expect("remove the injected failure");
    let result = bulk_approve_targets(&db, &fixture, TWO_WINDOW_RUN, both.clone());
    assert_eq!(result["failed"], json!([]), "{result}");
    let approved = result["approved"].as_array().expect("approved");
    assert_eq!(approved.len(), 1, "{result}");
    assert_eq!(approved[0]["proposalId"], TWO_WINDOW_FIRST_PROPOSAL);
    assert_eq!(result["skipped"].as_array().expect("skipped").len(), 1, "{result}");
    let after = bulk_state(&db);
    assert_ne!(after, state_before);
    let again = bulk_approve_targets(&db, &fixture, TWO_WINDOW_RUN, both);
    assert_eq!(again["approved"], json!([]), "{again}");
    assert_eq!(again["skipped"].as_array().expect("skipped").len(), 2, "{again}");
    assert_eq!(bulk_state(&db), after, "the same request again writes nothing");
    // 片方だけ（子の版だけ、承認だけ）が残る提案が無い。
    db.with_conn(|conn| {
        let half: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_proposals p
              WHERE p.status = 'approved'
                AND NOT EXISTS (SELECT 1 FROM narrative_proposal_decisions d
                                 WHERE d.proposal_id = p.id AND d.revision_id = p.current_revision_id
                                   AND d.decision = 'approved' AND d.actor_kind = 'human')",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(half, 0);
        Ok(())
    })
    .expect("every approved proposal has its human approval on the current revision");
}

/// 終了や workspace の切り替えの要求が来たら、提案と提案の間で止まり、それまでの結果を返す。
/// 止まった後の提案は判定もされない。
#[test]
fn bulk_approve_stops_between_proposals_when_asked() {
    let (fixture, db) = bulk_two_window(|_| {});
    let targets = bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL, TWO_WINDOW_SECOND_PROPOSAL]);
    let second_before = bulk_state(&db);
    let mut asked = 0;
    let result = narrative_extraction_chronicle_bulk_approve(
        &db,
        ChronicleBulkApprovePayload {
            project_id: fixture.project().to_owned(),
            run_id: TWO_WINDOW_RUN.to_owned(),
            targets,
        },
        &mut || {
            asked += 1;
            asked > 1
        },
    )
    .expect("a stopped run still returns its results");
    assert_eq!(result["stopped"], true);
    assert_eq!(result["approved"].as_array().expect("approved").len(), 1, "{result}");
    assert_eq!(result["approved"][0]["proposalId"], TWO_WINDOW_FIRST_PROPOSAL);
    assert_eq!(result["skipped"], json!([]), "the proposal after the stop is not even judged: {result}");
    assert_eq!(result["failed"], json!([]));
    assert_ne!(bulk_state(&db), second_before);
    // 止める要求が最初から来ていれば、何も書かない。
    let (fixture, db) = bulk_two_window(|_| {});
    let before = bulk_state(&db);
    let result = narrative_extraction_chronicle_bulk_approve(
        &db,
        ChronicleBulkApprovePayload {
            project_id: fixture.project().to_owned(),
            run_id: TWO_WINDOW_RUN.to_owned(),
            targets: bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]),
        },
        &mut || true,
    )
    .expect("stopped before the first proposal");
    assert_eq!(result["stopped"], true);
    assert_eq!(result["approved"], json!([]));
    assert_eq!(bulk_state(&db), before);
}

/// DB の接続は 1 本の mutex で、本文の自動保存などの書き込みと共有する。まとめて承認は提案ごとに
/// 接続を取り直し、提案と提案の間（と最初の提案の前）は放している。確かめる側の thread は scope の
/// 外（`Arc<Database>` を持つ detach の thread）で動かし、退行して lock が握られたままなら、その
/// thread は止まるが、`recv_timeout` の時間切れで試験が失敗する（試験自体は固まらない）。
#[test]
fn bulk_approve_releases_the_database_lock_between_proposals() {
    let (fixture, db) = bulk_two_window(|_| {});
    let db = std::sync::Arc::new(db);
    let targets = bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL, TWO_WINDOW_SECOND_PROPOSAL]);
    let mut observed = Vec::new();
    let result = {
        let reader_db = std::sync::Arc::clone(&db);
        narrative_extraction_chronicle_bulk_approve(
            &db,
            ChronicleBulkApprovePayload {
                project_id: fixture.project().to_owned(),
                run_id: TWO_WINDOW_RUN.to_owned(),
                targets,
            },
            &mut || {
                // 別 thread が、同じ Database から読めること（lock が放されていること）。
                let (sender, receiver) = std::sync::mpsc::channel();
                let thread_db = std::sync::Arc::clone(&reader_db);
                std::thread::spawn(move || {
                    let outcome = thread_db.with_conn(|conn| {
                        Ok(conn.query_row(
                            "SELECT COUNT(*) FROM narrative_proposals",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?)
                    });
                    let _ = sender.send(outcome.is_ok());
                });
                observed.push(receiver.recv_timeout(std::time::Duration::from_secs(20)));
                false
            },
        )
        .expect("bulk approve")
    };
    assert_eq!(observed.len(), 2, "asked before each proposal");
    for read in &observed {
        assert_eq!(read, &Ok(true), "the connection is free while should_stop runs: {observed:?}");
    }
    assert_eq!(result["approved"].as_array().expect("approved").len(), 1, "{result}");
}

/// 前の提案が処理されなかった（対象外で skipped）後でも、次の提案は承認される。
#[test]
fn bulk_approve_approves_a_proposal_after_a_skipped_one() {
    let (fixture, db) = bulk_two_window(|_| {});
    let targets = bulk_targets(&db, &[TWO_WINDOW_SECOND_PROPOSAL, TWO_WINDOW_FIRST_PROPOSAL]);
    let result = bulk_approve_targets(&db, &fixture, TWO_WINDOW_RUN, targets);
    assert_eq!(result["failed"], json!([]), "{result}");
    assert_eq!(result["stopped"], false);
    let skipped = result["skipped"].as_array().expect("skipped");
    assert_eq!(skipped.len(), 1, "{result}");
    assert_eq!(skipped[0]["proposalId"], TWO_WINDOW_SECOND_PROPOSAL);
    let approved = result["approved"].as_array().expect("approved");
    assert_eq!(approved.len(), 1, "{result}");
    assert_eq!(approved[0]["proposalId"], TWO_WINDOW_FIRST_PROPOSAL);
    let child = approved[0]["revisionId"].as_str().expect("child").to_owned();
    let decision = approved[0]["decisionId"].as_str().expect("decision").to_owned();
    db.with_conn(|conn| {
        let (number, parent): (i64, String) = conn.query_row(
            "SELECT revision_number, json_extract(reconciliation_envelope_json, '$.revisionBasis.parentRevisionId')
               FROM narrative_proposal_revisions WHERE id = ?1 AND proposal_id = ?2",
            params![child, TWO_WINDOW_FIRST_PROPOSAL],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!((number, parent.as_str()), (2, TWO_WINDOW_UNREVIEWED_REVISION));
        let decided: (String, String) = conn.query_row(
            "SELECT revision_id, decision FROM narrative_proposal_decisions WHERE id = ?1",
            [&decision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(decided, (child.clone(), "approved".to_owned()));
        Ok(())
    })
    .expect("the child revision and approval of the proposal after the skipped one");
}

/// 提案の前に ctx（Scope authority、意味の世代）を読んだ後で、その値が古くなっても、書く直前の
/// 子の版の作成が今の値で検査して失敗する（`failed`）。古い ctx のために書かれることは無い。
#[test]
fn bulk_approve_with_a_stale_scope_authority_fails_in_the_child_writer_and_writes_nothing() {
    let (fixture, db) = bulk_two_window(|_| {});
    let before = bulk_state(&db);
    let mut asked = 0;
    let result = narrative_extraction_chronicle_bulk_approve(
        &db,
        ChronicleBulkApprovePayload {
            project_id: fixture.project().to_owned(),
            run_id: TWO_WINDOW_RUN.to_owned(),
            targets: bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]),
        },
        &mut || {
            asked += 1;
            // ctx を読んだ後、最初の提案の前に、開示の場面が一覧から消える。
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE tree_nodes SET archived_at = datetime('now') WHERE id = 'en-distractor-gift'",
                    [],
                )?;
                Ok(())
            })
            .expect("archive the reveal Scene after the run-level read");
            false
        },
    )
    .expect("bulk approve");
    assert_eq!(asked, 1);
    assert_eq!(result["approved"], json!([]), "{result}");
    assert_eq!(result["skipped"], json!([]), "the stale pre-check still said eligible: {result}");
    let failed = result["failed"].as_array().expect("failed");
    assert_eq!(failed.len(), 1, "{result}");
    assert_eq!(failed[0]["proposalId"], TWO_WINDOW_FIRST_PROPOSAL);
    assert!(
        failed[0]["code"].as_str().expect("code").starts_with("NEX_C2B_SCOPE_AUTHORITY"),
        "the writer judges with today's authority: {result}"
    );
    let after = bulk_state(&db);
    // 場面の archive 以外（子の版、承認、宣言、Freshness）は、何も書かれていない。
    assert_eq!(after, before, "nothing of the bulk approval was written");
}

/// 子の版を作って承認し、Freshness の周期が空になるまで回す。
fn bulk_approve_first_and_settle(db: &Database, fixture: &Fixture) -> String {
    let result = bulk_approve_targets(
        db,
        fixture,
        TWO_WINDOW_RUN,
        bulk_targets(db, &[TWO_WINDOW_FIRST_PROPOSAL]),
    );
    assert_eq!(result["failed"], json!([]), "{result}");
    let child = result["approved"][0]["revisionId"].as_str().expect("child").to_owned();
    for _ in 0..8 {
        if matches!(
            run_incremental_freshness_cycle(db).expect("production Native Freshness cycle"),
            IncrementalFreshnessCycleOutcome::Idle
        ) {
            break;
        }
    }
    child
}

/// 漏れの負例（§4）：まとめて承認した子の版は、材料の場面より後ろの場面からだけ使える。材料の場面
/// より前の場面、材料の場面と同じ場面からの問い合わせでは、同じ理由（材料が問い合わせの場面より前でない）
/// で使えない。
#[test]
fn bulk_approved_child_is_not_retrievable_from_earlier_or_the_same_scene() {
    let (fixture, db) = bulk_two_window(|_| {});
    let child = bulk_approve_first_and_settle(&db, &fixture);
    db.with_conn(|conn| {
        assert_complete_and_fresh(conn, &fixture, &child);
        let read_from = |scene: &str| {
            let tx = conn.unchecked_transaction().expect("snapshot");
            read_revision_retrieval_eligibility(&tx, fixture.project(), &child, scene)
                .expect("typed retrieval read")
        };
        assert!(
            matches!(read_from(BULK_QUERY_SCENE), RevisionEligibilityRead::Eligible(_)),
            "a Scene after every material Scene reads it"
        );
        // 材料の場面（s1、s2）より前の場面（根の場面、フォルダの場面）、材料と同じ場面。
        for scene in [
            "en-raw-dialogue",
            "en-raw-non-event",
            "en-broken-passage",
            fixture.scene("s1"),
            fixture.scene("s2"),
        ] {
            let actual = read_from(scene);
            assert!(
                matches!(
                    actual,
                    RevisionEligibilityRead::Unavailable {
                        reason: RevisionEligibilityReason::SourceNotBeforeQuery
                    }
                ),
                "query {scene}: {actual:?}"
            );
        }
        Ok(())
    })
    .expect("the approved child never leaks to an earlier or the same Scene");
}

/// 根拠・計画の記録が無い Run：review の読み出しは、その前の検査（記録の完全性）で拒む（変更前と
/// 同じ）。まとめて承認の command は、読めない記録を「根拠が対応しない」「計画が無い」として対象外にし、
/// 何も書かない。Chronicle でない Run の応答には `bulkApproval` が付かない。
#[test]
fn bulk_approval_without_run_material_is_refused_not_failed() {
    let read_bundle = |db: &Database, fixture: &Fixture| {
        narrative_extraction_get_run_review_bundle(
            db,
            RunRefPayload {
                run_id: TWO_WINDOW_RUN.to_owned(),
                project_id: fixture.project().to_owned(),
                chronicle_blocked_discard: None,
            },
        )
    };
    // 根拠の記録（evidence.resolved@1）が無い。
    let (fixture, db) = bulk_two_window(|conn| {
        conn.execute(
            "DELETE FROM narrative_extraction_artifacts WHERE run_id = ?1 AND artifact_kind = 'evidence.resolved@1'",
            [TWO_WINDOW_RUN],
        )
        .expect("remove the evidence artifact of the private copy");
    });
    assert!(read_bundle(&db, &fixture).is_err(), "the bundle's own integrity check refuses first");
    let before = bulk_state(&db);
    let result = bulk_approve_targets(
        &db,
        &fixture,
        TWO_WINDOW_RUN,
        bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]),
    );
    assert_eq!(result["approved"], json!([]), "{result}");
    assert_eq!(
        result["skipped"],
        json!([{"proposalId": TWO_WINDOW_FIRST_PROPOSAL, "reasons": ["evidence-unverified"]}])
    );
    assert_eq!(bulk_state(&db), before);

    // 計画の記録が無い。
    let (fixture, db) = bulk_two_window(|conn| {
        conn.execute(
            "DELETE FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1'",
            [TWO_WINDOW_RUN],
        )
        .expect("remove the plan artifact of the private copy");
    });
    assert!(read_bundle(&db, &fixture).is_err(), "the bundle's own integrity check refuses first");
    let before = bulk_state(&db);
    let result = bulk_approve_targets(
        &db,
        &fixture,
        TWO_WINDOW_RUN,
        bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]),
    );
    assert_eq!(result["approved"], json!([]), "{result}");
    assert_eq!(
        result["skipped"],
        json!([{"proposalId": TWO_WINDOW_FIRST_PROPOSAL, "reasons": ["plan-unavailable"]}])
    );
    assert_eq!(bulk_state(&db), before);

    // Chronicle でない Run（依存の検証 Run）：提案が無く、`bulkApproval` も付かない（下の注意を参照）。
    let (fixture, db) = bulk_two_window(|_| {});
    let other_run: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM narrative_extraction_runs WHERE surface_path_id = 'dependency-verify' LIMIT 1",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("a non-Chronicle Run");
    let bundle = narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: other_run,
            project_id: fixture.project().to_owned(),
            chronicle_blocked_discard: None,
        },
    )
    .expect("a non-Chronicle review bundle still reads");
    // 注意：この fixture に、提案を持つ Chronicle でない Run は無い（提案を持つ Run は
    // chronicle.extract の 2 つだけ）。だからこの確認は「提案を持たない Run では付かない」までで、
    // 「Chronicle でない Run の提案には付かない」は示さない。後者を守るコードは `repository.rs` の
    // review bundle の読み出しにある `if current_chronicle_spec { ... attach_bulk_approval(..) }`。
    assert_eq!(bundle["proposals"], json!([]), "{bundle}");
    // 別の Chronicle Run の提案は、その Run の読み出しで、その Run の材料で判定される。
    let other = read_bulk_approvals(&db, &fixture, "dc741c52-091b-4aa2-8ed4-9f9c7490014d");
    assert_eq!(other.len(), 1);
    assert_eq!(other[TWO_WINDOW_OTHER_RUN_PROPOSAL]["eligible"], false);
    // その Run は Chronicle の計画を書く command にも使えない（別の run の提案を渡しても書かれない）。
    let before = bulk_state(&db);
    let result = bulk_approve_targets(
        &db,
        &fixture,
        "dc741c52-091b-4aa2-8ed4-9f9c7490014d",
        bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]),
    );
    assert_eq!(
        result["skipped"],
        json!([{"proposalId": TWO_WINDOW_FIRST_PROPOSAL, "reasons": ["proposal-not-found"]}])
    );
    assert_eq!(bulk_state(&db), before);
    // Chronicle の Run でないものに command を向けると、何も書かず拒む。
    let not_chronicle = narrative_extraction_chronicle_bulk_approve(
        &db,
        ChronicleBulkApprovePayload {
            project_id: fixture.project().to_owned(),
            run_id: "92b21f23-3d7c-48f7-be69-d3299e497d18".to_owned(),
            targets: bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]),
        },
        &mut || false,
    );
    assert!(not_chronicle.is_err(), "a non-Chronicle Run is refused");
    assert_eq!(bulk_state(&db), before);
}

/// 試験の無かった理由のコード（取り込みの印のある提案を除く）：secret でない版、読めない状態、
/// 場面の一覧が読めない。
#[test]
fn bulk_approve_refuses_with_the_remaining_reason_codes() {
    // 版が既に secret でない（印を外す対象が無い）。
    let (fixture, db) = bulk_two_window(|conn| {
        reseal_event(
            conn,
            TWO_WINDOW_UNREVIEWED_REVISION,
            &|payload| payload["disclosure"]["secret"] = json!(false),
            &[],
        );
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["already-nonsecret"]);

    // 状態が既知の値のどれでもない。
    let (fixture, db) = bulk_two_window(|conn| {
        conn.execute(
            "UPDATE narrative_proposals SET status = 'withdrawn' WHERE id = ?1",
            [TWO_WINDOW_FIRST_PROPOSAL],
        )
        .expect("unknown status of the private copy");
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["status-other"]);

    // 現行の場面の一覧（Scope authority）が読めない：木に、根から辿れない有効な節がある。
    let (fixture, db) = bulk_two_window(|conn| {
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             UPDATE tree_nodes SET parent_id = 'nir1-folder-en-distractor-medicine'
              WHERE id = 'nir1-folder-en-distractor-bridge-plan';
             UPDATE tree_nodes SET parent_id = 'nir1-folder-en-distractor-bridge-plan'
              WHERE id = 'nir1-folder-en-distractor-medicine';",
        )
        .expect("make the live tree unreadable on the private copy");
    });
    assert_bulk_refused(&db, &fixture, TWO_WINDOW_FIRST_PROPOSAL, &["scope-authority-unavailable"]);
}

/// 入力の境界：件数 0 と上限超過、trim していない id（project、run、提案、版）は、何も書かず拒まれる。
#[test]
fn bulk_approve_rejects_input_boundaries() {
    let (fixture, db) = bulk_two_window(|_| {});
    let before = bulk_state(&db);
    let first = bulk_targets(&db, &[TWO_WINDOW_FIRST_PROPOSAL]);
    let request = |project: &str, run: &str, targets: Vec<ChronicleBulkApproveTarget>| {
        narrative_extraction_chronicle_bulk_approve(
            &db,
            ChronicleBulkApprovePayload {
                project_id: project.to_owned(),
                run_id: run.to_owned(),
                targets,
            },
            &mut || false,
        )
    };
    let target = |proposal: &str, revision: &str| ChronicleBulkApproveTarget {
        proposal_id: proposal.to_owned(),
        revision_id: revision.to_owned(),
    };
    let limit = grimodex_db::narrative_extraction::BULK_APPROVE_MAX_TARGETS;
    let too_many = (0..=limit).map(|n| target(&format!("p{n}"), "r")).collect();
    assert!(request(fixture.project(), TWO_WINDOW_RUN, too_many).is_err(), "over the limit");
    let at_limit: Vec<_> = (0..limit).map(|n| target(&format!("p{n}"), "r")).collect();
    let result = request(fixture.project(), TWO_WINDOW_RUN, at_limit).expect("exactly the limit is accepted");
    assert_eq!(result["skipped"].as_array().expect("skipped").len(), limit, "every unknown proposal is skipped");
    let revision = first[0].revision_id.clone();
    for (project, run, proposal, rev) in [
        (format!(" {}", fixture.project()), TWO_WINDOW_RUN.to_owned(), TWO_WINDOW_FIRST_PROPOSAL.to_owned(), revision.clone()),
        (fixture.project().to_owned(), format!("{TWO_WINDOW_RUN} "), TWO_WINDOW_FIRST_PROPOSAL.to_owned(), revision.clone()),
        (fixture.project().to_owned(), TWO_WINDOW_RUN.to_owned(), format!(" {TWO_WINDOW_FIRST_PROPOSAL}"), revision.clone()),
        (fixture.project().to_owned(), TWO_WINDOW_RUN.to_owned(), TWO_WINDOW_FIRST_PROPOSAL.to_owned(), format!("{revision} ")),
        (String::new(), TWO_WINDOW_RUN.to_owned(), TWO_WINDOW_FIRST_PROPOSAL.to_owned(), revision.clone()),
        (fixture.project().to_owned(), TWO_WINDOW_RUN.to_owned(), TWO_WINDOW_FIRST_PROPOSAL.to_owned(), String::new()),
    ] {
        assert!(
            request(&project, &run, vec![target(&proposal, &rev)]).is_err(),
            "{project:?} {run:?} {proposal:?} {rev:?}"
        );
    }
    assert_eq!(bulk_state(&db), before, "an invalid request writes nothing");
}
// ---------------------------------------------------------------------------
// DMS/1: a proposal declares only the scenes its synthesis request read.
// `support/nir1-declared-scope-cold.db.gz` is the MW/1 setup
// (`electron/scripts/nir1-multi-window-cold-fixture.mjs`) run again with the
// product of DMS/1: the normal planner, the production extraction path (which
// now narrows each proposal's source basis and dependency declarations) and
// the Human review UI made every row. Mutations are confined to private copies.
// The MW/1 database above stays: it is the old form (every proposal declares
// every scene of its extraction), which Native keeps reading unchanged.
// ---------------------------------------------------------------------------

impl Fixture {
    /// One proposal of the declared-scope database, as a single-proposal fixture
    /// (`s1` the first scene of its material, `s2` the scene after both folders).
    fn declared_scope(shape: &str, title: &str) -> Self {
        let mut manifest: Value =
            serde_json::from_str(include_str!("support/nir1-declared-scope-cold.json"))
                .expect("declared-scope cold fixture manifest");
        let run = manifest["runs"][shape].clone();
        let proposal = run["proposals"]
            .as_array()
            .expect("proposals")
            .iter()
            .find(|p| p["title"] == title)
            .expect("proposal")
            .clone();
        manifest["runId"] = run["runId"].clone();
        manifest["s2"] = manifest["scenes"]["after"].clone();
        manifest["revisionIds"] = json!([proposal["revisionId"]]);
        manifest["rootRevisionIds"] = json!([proposal["rootRevisionId"]]);
        let compressed = include_bytes!("support/nir1-declared-scope-cold.db.gz");
        Self::open(manifest, compressed)
    }

    /// The scenes of the split folder, in order (`mw-split-1..3`): the dawn
    /// proposal read scene 1; the tide proposal's request read scenes 2 and 3
    /// and its evidence is in scene 2 only.
    fn split_scene(&self, index: usize) -> String {
        self.manifest["scenes"]["split"][index]
            .as_str()
            .expect("split scene")
            .to_owned()
    }

    /// The scenes of the three-scene folder, in order (`mw-scene-1..3`).
    fn folder_scene(&self, index: usize) -> String {
        self.manifest["scenes"]["three"][index]
            .as_str()
            .expect("folder scene")
            .to_owned()
    }
}

const FIRE: &str = "Signal fire on the quay";
const WRIT: &str = "Writ delivered to the quay";
const SEAL: &str = "Ledger seals at the gate";
const BELL: &str = "Harbour bell at dusk";
const DAWN: &str = "Lamp trimmed at dawn";
const TIDE: &str = "Tide chart pinned to the post";

fn scene_keys(envelope: &Value) -> Vec<String> {
    envelope["effectiveMaterialBasis"]["sourceBasis"]
        .as_array()
        .expect("sourceBasis")
        .iter()
        .filter(|s| s["sourceKind"] == "scene-body")
        .map(|s| s["sourceKey"].as_str().expect("key").to_owned())
        .collect()
}

fn declared_scene_dependencies(envelope: &Value) -> Vec<String> {
    let mut keys: Vec<String> = envelope["effectiveMaterialBasis"]["dependencySet"]
        .as_array()
        .expect("dependencySet")
        .iter()
        .filter_map(|d| d["inputRef"].as_str())
        .filter(|k| k.starts_with("project:scene:"))
        .map(str::to_owned)
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

fn envelope_of(conn: &Connection, revision: &str) -> Value {
    let raw: String = conn
        .query_row(
            "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
            [revision],
            |row| row.get(0),
        )
        .expect("saved Envelope");
    serde_json::from_str(&raw).expect("Envelope JSON")
}

fn declared_verdict(fixture: &Fixture, conn: &Connection, query: &str) -> RevisionEligibilityRead {
    let tx = conn.unchecked_transaction().expect("snapshot");
    read_revision_retrieval_eligibility(&tx, fixture.project(), fixture.child(), query)
        .expect("public Rust retrieval admission")
}

fn assert_source_not_before(read: &RevisionEligibilityRead, context: &str) {
    assert!(
        matches!(
            read,
            RevisionEligibilityRead::Unavailable {
                reason: RevisionEligibilityReason::SourceNotBeforeQuery
            }
        ),
        "{context}: only the disclosure order may refuse: {read:?}"
    );
}

#[test]
fn the_declared_scope_golden_is_the_run_recorded_with_its_cold_database() {
    let fixture = Fixture::declared_scope("three", WRIT);
    let text = include_str!(
        "../src/narrative_extraction/material_roster/production-declared-scope-folder-golden.json"
    );
    assert_eq!(
        hex::encode(Sha256::digest(text.as_bytes())),
        fixture.manifest["runs"]["three"]["goldenSha256"]
    );
    let golden: Value = serde_json::from_str(text).expect("golden");
    assert_eq!(
        golden["snapshot"]["snapshot"]["documents"][0]["sourceKey"],
        json!(format!("project:scene:{}", fixture.folder_scene(0))),
        "the golden is the Run of this database"
    );
    let split_text = include_str!(
        "../src/narrative_extraction/material_roster/production-declared-scope-split-golden.json"
    );
    assert_eq!(
        hex::encode(Sha256::digest(split_text.as_bytes())),
        fixture.manifest["runs"]["split"]["goldenSha256"]
    );
    let split: Value = serde_json::from_str(split_text).expect("split golden");
    assert_eq!(
        split["snapshot"]["snapshot"]["documents"][0]["sourceKey"],
        json!(format!("project:scene:{}", fixture.split_scene(0))),
        "the split golden is the Run of this database"
    );
}

/// DR-DMS-1/4 as persisted by the normal path: every revision of every
/// proposal (root and Human child) declares exactly the scenes of the windows
/// its synthesis request read, and Native replays it completely with exactly
/// those windows as material.
#[test]
fn a_proposal_declares_and_replays_only_the_scenes_its_synthesis_request_read() {
    let scene = |shape: &str, index: usize| -> String {
        let fixture = Fixture::declared_scope(shape, if shape == "long" { SEAL } else { FIRE });
        if shape == "long" {
            format!(
                "project:scene:{}",
                fixture.manifest["scenes"]["long"].as_str().expect("long")
            )
        } else {
            format!("project:scene:{}", fixture.folder_scene(index))
        }
    };
    // (shape, title, declared scenes, windows read, replayed requests)
    let cases = [
        (
            "three",
            FIRE,
            vec![scene("three", 0), scene("three", 2)],
            vec!["window-001", "window-003"],
        ),
        ("three", WRIT, vec![scene("three", 1)], vec!["window-002"]),
        // One scene cut into three windows: the scene is declared once and
        // every one of its windows is material, whichever observation read it.
        (
            "long",
            SEAL,
            vec![scene("long", 0)],
            vec!["window-001", "window-002", "window-003"],
        ),
        (
            "long",
            BELL,
            vec![scene("long", 0)],
            vec!["window-001", "window-002", "window-003"],
        ),
    ];
    for (shape, title, declared, windows) in cases {
        let fixture = Fixture::declared_scope(shape, title);
        let conn = fixture.read_only();
        for revision in [fixture.root().to_owned(), fixture.child().to_owned()] {
            let envelope = envelope_of(&conn, &revision);
            let mut expected = declared.clone();
            expected.sort();
            let mut actual = scene_keys(&envelope);
            actual.sort();
            assert_eq!(actual, expected, "{shape} {title}: declared source basis");
            assert_eq!(
                declared_scene_dependencies(&envelope),
                expected,
                "{shape} {title}: every declared scene has a declaration and no other scene does"
            );
            // The extraction's seal stays declared.
            assert!(
                envelope["effectiveMaterialBasis"]["sourceBasis"]
                    .as_array()
                    .expect("sourceBasis")
                    .iter()
                    .any(|s| s["sourceKind"] == "snapshot-document"),
                "{shape} {title}: the Snapshot seal is kept"
            );
            let tx = conn.unchecked_transaction().expect("snapshot");
            let MaterialMembershipRead::Complete(m) =
                read_revision_material_membership(&tx, fixture.project(), &revision)
                    .expect("typed material membership")
            else {
                panic!("{shape} {title}: a narrowed record must replay completely")
            };
            let read: std::collections::BTreeSet<_> = m
                .materials
                .iter()
                .map(|s| {
                    s.context_id
                        .strip_prefix("observation-citation-window:")
                        .expect("a window material")
                        .to_owned()
                })
                .collect();
            assert_eq!(
                read.into_iter().collect::<Vec<_>>(),
                windows.iter().map(|w| w.to_string()).collect::<Vec<_>>(),
                "{shape} {title}: only the declared scenes' windows are material"
            );
            assert_eq!(m.replayed_requests.len(), windows.len() + 1);
            for proof in &m.replayed_requests {
                assert_eq!(proof.reconstructed, proof.persisted);
            }
            drop(tx);
            if revision == fixture.child() {
                assert_complete_and_fresh(&conn, &fixture, &revision);
            }
        }
    }
}

/// (a) and (b): a three-scene folder's proposal that reads only scene 2 is
/// shown to scene 3, which comes after its material but is still inside the
/// extraction (the MW/1 database refuses it there: its record declared scene
/// 3); it is not shown to scenes at or before its material.
#[test]
fn a_proposal_is_eligible_after_its_own_scenes_even_inside_the_extraction() {
    let writ = Fixture::declared_scope("three", WRIT);
    let conn = writ.read_only();
    let before = writ.digest();
    let verdict = |query: &str| declared_verdict(&writ, &conn, query);
    let (s1, s2, s3) = (
        writ.folder_scene(0),
        writ.folder_scene(1),
        writ.folder_scene(2),
    );
    for query in [
        writ.manifest["scenes"]["before"]
            .as_str()
            .expect("before")
            .to_owned(),
        s1.clone(),
        s2.clone(),
    ] {
        assert_source_not_before(&verdict(&query), &format!("writ from {query}"));
    }
    for query in [s3.clone(), writ.scene("s2").to_owned()] {
        assert!(
            matches!(verdict(&query), RevisionEligibilityRead::Eligible(_)),
            "writ from {query}: {:?}",
            verdict(&query)
        );
    }
    // The same proposal of the MW/1 database (broad record) is refused from
    // scene 3: the difference is the declared scope alone.
    let old = Fixture::multi_window(false);
    let old_conn = old.read_only();
    let tx = old_conn.unchecked_transaction().expect("snapshot");
    let broad = read_revision_retrieval_eligibility(&tx, old.project(), old.child(), &s3)
        .expect("admission");
    assert_source_not_before(&broad, "MW/1 writ from scene 3");
    drop(conn);
    assert_eq!(writ.digest(), before, "admission writes nothing");

    // A proposal whose observations span scenes 1 and 3 is not shown from any
    // scene here. Its evidence is in two scenes, which Native refuses by its own
    // rule whatever the declared scope is: this block does not test the declared
    // scope. The tide proposal below (request in two scenes, evidence in one) does.
    let fire = Fixture::declared_scope("three", FIRE);
    let conn = fire.read_only();
    for query in [s1, s2, s3, fire.scene("s2").to_owned()] {
        assert!(
            !matches!(
                declared_verdict(&fire, &conn, &query),
                RevisionEligibilityRead::Eligible(_)
            ),
            "fire from {query}"
        );
    }
    // One scene cut into windows: nothing changes for it (shown after its
    // scene, not before or at it).
    let seal = Fixture::declared_scope("long", SEAL);
    let conn = seal.read_only();
    assert!(matches!(
        declared_verdict(&seal, &conn, &seal.folder_scene(0)),
        RevisionEligibilityRead::Eligible(_)
    ));
    assert_source_not_before(
        &declared_verdict(
            &seal,
            &conn,
            seal.manifest["scenes"]["long"].as_str().expect("long"),
        ),
        "seal from its own scene",
    );
}

fn freshness_of(conn: &Connection, fixture: &Fixture, revision: &str) -> bool {
    let tx = conn.unchecked_transaction().expect("snapshot");
    matches!(
        read_revision_canonical_freshness(&tx, fixture.project(), revision)
            .expect("canonical revision Freshness"),
        RevisionFreshnessRead::Fresh(_)
    )
}

impl Fixture {
    /// The current approved child of another proposal of the same Run.
    fn child_of(&self, shape: &str, title: &str) -> String {
        self.manifest["runs"][shape]["proposals"]
            .as_array()
            .expect("proposals")
            .iter()
            .find(|p| p["title"] == title)
            .expect("proposal")["revisionId"]
            .as_str()
            .expect("child")
            .to_owned()
    }
}

/// The envelope's evidence scenes (`project:scene:*` of the evidence set).
fn evidence_scene_keys(envelope: &Value) -> Vec<String> {
    let mut keys: Vec<String> = envelope["effectiveMaterialBasis"]["evidenceSet"]
        .as_array()
        .expect("evidenceSet")
        .iter()
        .filter_map(|e| e["sourceKey"].as_str())
        .filter(|k| k.starts_with("project:scene:"))
        .map(str::to_owned)
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// The dangerous shape (DMS/1 D1): the synthesis request read scenes 2 and 3
/// (an actual Observation of scene 2 and a planned one of scene 3 in one
/// cluster), the event cites scene 2 only. The record must declare both scenes
/// and Native must treat both as material: the proposal is not shown from scene
/// 3 (its request read it), is shown after it. A proposal whose request read
/// scene 1 only is shown from scenes 2 and 3 (the declared scope alone).
#[test]
fn a_request_that_read_two_scenes_keeps_both_material_though_the_evidence_is_in_one() {
    let tide = Fixture::declared_scope("split", TIDE);
    let conn = tide.read_only();
    let before = tide.digest();
    let (s1, s2, s3) = (
        tide.split_scene(0),
        tide.split_scene(1),
        tide.split_scene(2),
    );
    let key = |id: &str| format!("project:scene:{id}");
    for revision in [tide.root().to_owned(), tide.child().to_owned()] {
        let envelope = envelope_of(&conn, &revision);
        let mut declared = scene_keys(&envelope);
        declared.sort();
        assert_eq!(declared, vec![key(&s2), key(&s3)], "declared source basis");
        assert_eq!(
            declared_scene_dependencies(&envelope),
            vec![key(&s2), key(&s3)],
            "both scenes have a declaration, scene 1 has none"
        );
        assert_eq!(
            evidence_scene_keys(&envelope),
            vec![key(&s2)],
            "the evidence is in scene 2 only"
        );
        // Native replays it completely, with the windows of both scenes.
        let tx = conn.unchecked_transaction().expect("snapshot");
        let MaterialMembershipRead::Complete(m) =
            read_revision_material_membership(&tx, tide.project(), &revision)
                .expect("typed material membership")
        else {
            panic!("a narrowed record must replay completely")
        };
        let windows: std::collections::BTreeSet<String> = m
            .materials
            .iter()
            .map(|s| {
                s.context_id
                    .strip_prefix("observation-citation-window:")
                    .expect("a window material")
                    .to_owned()
            })
            .collect();
        assert_eq!(
            windows.into_iter().collect::<Vec<_>>(),
            vec!["window-002", "window-003"]
        );
        drop(tx);
    }
    let verdict = |query: &str| declared_verdict(&tide, &conn, query);
    // Scene 1 and the scene before the folder: before the material.
    // Scene 2: the evidence. Scene 3: no evidence, but the request read it.
    for query in [
        tide.manifest["scenes"]["before"]
            .as_str()
            .expect("before")
            .to_owned(),
        s1.clone(),
        s2.clone(),
        s3.clone(),
    ] {
        assert_source_not_before(&verdict(&query), &format!("tide from {query}"));
    }
    assert!(
        matches!(
            verdict(tide.scene("s2")),
            RevisionEligibilityRead::Eligible(_)
        ),
        "tide after its material: {:?}",
        verdict(tide.scene("s2"))
    );
    // Control, same Run: the proposal that read scene 1 only is shown from
    // scenes 2 and 3 and after, never from scene 1 or before it.
    let dawn = Fixture::declared_scope("split", DAWN);
    let dawn_conn = dawn.read_only();
    for query in [s2, s3, dawn.scene("s2").to_owned()] {
        assert!(
            matches!(
                declared_verdict(&dawn, &dawn_conn, &query),
                RevisionEligibilityRead::Eligible(_)
            ),
            "dawn from {query}: {:?}",
            declared_verdict(&dawn, &dawn_conn, &query)
        );
    }
    assert_source_not_before(
        &declared_verdict(&dawn, &dawn_conn, &s1),
        "dawn from scene 1",
    );
    drop(conn);
    assert_eq!(tide.digest(), before, "admission writes nothing");
}

/// (c) for the same shape: editing scene 3, which the event does not cite but
/// the request read, makes the tide proposal stale; editing scene 1 does not.
#[test]
fn a_scene_the_request_read_but_the_event_did_not_cite_still_stales_the_proposal() {
    // (scene edited, tide fresh, dawn fresh); tide read scenes 2 and 3, dawn 1.
    let declared = [(0, true, false), (1, false, true), (2, false, true)];
    for (index, tide_fresh, dawn_fresh) in declared {
        let fixture = Fixture::declared_scope("split", TIDE);
        let db = Database::new(&fixture.path).expect("Native private fixture");
        let (tide, dawn) = (
            fixture.child_of("split", TIDE),
            fixture.child_of("split", DAWN),
        );
        native_patch_node(
            &db,
            &fixture,
            &fixture.split_scene(index),
            json!({"title": "Stair, revised"}),
            false,
        );
        drain_native_feed(&db);
        let conn = fixture.read_only();
        assert_eq!(
            freshness_of(&conn, &fixture, &tide),
            tide_fresh,
            "edit scene {}: tide",
            index + 1
        );
        assert_eq!(
            freshness_of(&conn, &fixture, &dawn),
            dawn_fresh,
            "edit scene {}: dawn",
            index + 1
        );
    }
}

/// (c): editing a scene a proposal's observations did not come from leaves it
/// fresh; editing a scene they came from makes it stale. The MW/1 database
/// (every proposal declares every scene) is stale for every folder scene.
#[test]
fn editing_an_unrelated_scene_leaves_a_declared_scope_proposal_fresh() {
    // (scene edited, writ fresh, fire fresh); writ read scene 2, fire 1 and 3.
    let declared = [(0, true, false), (1, false, true), (2, true, false)];
    for (index, writ_fresh, fire_fresh) in declared {
        let fixture = Fixture::declared_scope("three", WRIT);
        let db = Database::new(&fixture.path).expect("Native private fixture");
        let (writ, fire) = (
            fixture.child_of("three", WRIT),
            fixture.child_of("three", FIRE),
        );
        native_patch_node(
            &db,
            &fixture,
            &fixture.folder_scene(index),
            json!({"title": "Quay, revised"}),
            false,
        );
        drain_native_feed(&db);
        let conn = fixture.read_only();
        assert_eq!(
            freshness_of(&conn, &fixture, &writ),
            writ_fresh,
            "edit scene {}: writ",
            index + 1
        );
        assert_eq!(
            freshness_of(&conn, &fixture, &fire),
            fire_fresh,
            "edit scene {}: fire",
            index + 1
        );
    }
    // A scene outside the extraction never matters.
    let fixture = Fixture::declared_scope("three", WRIT);
    let db = Database::new(&fixture.path).expect("Native private fixture");
    native_patch_node(
        &db,
        &fixture,
        fixture.manifest["scenes"]["after"].as_str().expect("after"),
        json!({"title": "After, revised"}),
        false,
    );
    drain_native_feed(&db);
    let conn = fixture.read_only();
    for title in [WRIT, FIRE] {
        assert!(
            freshness_of(&conn, &fixture, &fixture.child_of("three", title)),
            "{title}"
        );
    }
    // Control, the MW/1 database: editing scene 3 stales the proposal that
    // never read it, because its record declared every scene.
    let old = Fixture::multi_window(false);
    let db = Database::new(&old.path).expect("Native private fixture");
    native_patch_node(
        &db,
        &old,
        "mw-scene-3",
        json!({"title": "Quay, revised"}),
        false,
    );
    drain_native_feed(&db);
    let conn = old.read_only();
    assert!(
        !freshness_of(&conn, &old, old.child()),
        "MW/1 writ is stale from the scene-3 edit"
    );
}

/// (c) for the import: with the proposal that read scene 3 set aside, editing
/// scene 3 does not stop the import of the one that read scene 2. In the
/// MW/1 database the same edit stops it.
#[test]
fn editing_an_unrelated_scene_does_not_stop_the_import() {
    for declared in [true, false] {
        let fixture = if declared {
            Fixture::declared_scope("three", WRIT)
        } else {
            Fixture::multi_window(false)
        };
        let db = Database::new(&fixture.path).expect("Native private fixture");
        enable_manual_apply(&db);
        let (writ, fire) = (
            fixture.child_of("three", WRIT),
            fixture.child_of("three", FIRE),
        );
        native_human_decision(&db, &fixture, &fire, "rejected");
        native_patch_node(
            &db,
            &fixture,
            &fixture.folder_scene(2),
            json!({"title": "Quay 3, revised"}),
            false,
        );
        drain_native_feed(&db);
        let run = fixture.manifest["runId"].as_str().expect("run").to_owned();
        let revisions = approved_current_revisions_of_run(&db, &run);
        assert_eq!(
            revisions,
            vec![writ.clone()],
            "only the writ stays approved"
        );
        let prepare = chronicle_prepare_payload(&db, &fixture, "dms-request", &revisions);
        if declared {
            let applied = prepare_and_apply(&db, &prepare);
            assert_eq!(applied["status"], "applied");
            assert_eq!(apply_counts(&db), (1, 1, 1));
        } else {
            let error = assert_prepare_refused(&db, &prepare);
            assert!(error.contains("STALE"), "MW/1 writ must be stale: {error}");
        }
    }
}
