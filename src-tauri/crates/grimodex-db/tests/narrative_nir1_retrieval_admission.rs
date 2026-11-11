//! Retrieval admission against exact normal UI cold storage and Native writers.
//! Membership, canonical Freshness, current Human review, and query Scope are
//! separate assertions; private corruption copies never manufacture positives.
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

fn assert_unavailable(conn: &Connection, fixture: &Fixture, revision: &str, query_scene: &str) {
    let tx = conn
        .unchecked_transaction()
        .expect("coherent negative retrieval snapshot");
    let actual = read_revision_retrieval_eligibility(&tx, fixture.project(), revision, query_scene)
        .expect("retrieval denial is typed unavailable");
    assert!(
        matches!(actual, RevisionEligibilityRead::Unavailable { .. }),
        "revision {revision}, query {query_scene}: {actual:?}"
    );
}

fn assert_eligible(conn: &Connection, fixture: &Fixture, revision: &str) {
    let tx = conn
        .unchecked_transaction()
        .expect("coherent positive retrieval snapshot");
    let actual =
        read_revision_retrieval_eligibility(&tx, fixture.project(), revision, fixture.scene("s2"))
            .expect("retrieval eligibility read");
    assert!(
        matches!(actual, RevisionEligibilityRead::Eligible(_)),
        "Native positive: {actual:?}"
    );
}

fn assert_complete_and_fresh(conn: &Connection, fixture: &Fixture, revision: &str) {
    let tx = conn
        .unchecked_transaction()
        .expect("independent membership and Freshness snapshot");
    let membership = read_revision_material_membership(&tx, fixture.project(), revision)
        .expect("typed material membership");
    assert!(
        matches!(membership, MaterialMembershipRead::Complete(_)),
        "membership: {membership:?}"
    );
    let freshness = read_revision_canonical_freshness(&tx, fixture.project(), revision)
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
    db.with_conn(|conn| {
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
    let conn = fixture.read_only();
    let tx = conn
        .unchecked_transaction()
        .expect("coherent retrieval read snapshot");
    let actual = read_revision_retrieval_eligibility(
        &tx,
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
    db.with_conn(|conn| {
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
        database.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let actual = read_revision_retrieval_eligibility(
                &tx,
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
            let old_vectors: i64 = conn.query_row(
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
    db.with_conn(|conn| {
        assert_complete_and_fresh(conn, &fixture, &current);
        let tx = conn.unchecked_transaction()?;
        let actual = read_revision_retrieval_eligibility(
            &tx,
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
    let conn = fixture.read_only();
    assert!(read_revision_retrieval_eligibility(
        &conn,
        fixture.project(),
        fixture.child(),
        fixture.scene("s2"),
    )
    .is_err());
}

#[test]
fn same_missing_or_absent_query_scene_cannot_admit_a_fresh_approved_child() {
    let fixture = Fixture::new();
    let conn = fixture.read_only();
    assert_complete_and_fresh(&conn, &fixture, fixture.child());
    for query in [fixture.scene("s1"), "missing-query-scene", ""] {
        assert_unavailable(&conn, &fixture, fixture.child(), query);
    }
}

#[test]
fn a_foreign_project_cannot_read_another_projects_approved_revision() {
    let fixture = Fixture::new();
    let conn = fixture.read_only();
    let tx = conn
        .unchecked_transaction()
        .expect("cross-project read snapshot");
    let actual = read_revision_retrieval_eligibility(
        &tx,
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
    let conn = fixture.read_only();
    assert_complete_and_fresh(&conn, &fixture, fixture.root());
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
    assert_unavailable(&conn, &fixture, fixture.root(), fixture.scene("s2"));
}

#[test]
fn a_native_projection_child_requires_its_own_current_human_approval() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let child = create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["title"] = json!("A Human projection requiring its own review");
    });
    db.with_conn(|conn| {
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
    db.with_conn(|conn| {
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
    db.with_conn(|conn| {
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
        let conn = fixture.corruption_connection();
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
        assert_complete_and_fresh(&conn, &fixture, fixture.child());
        assert_unavailable(&conn, &fixture, fixture.child(), fixture.scene("s2"));
    }
}

#[test]
fn missing_current_decision_denies_even_with_an_approved_proposal_status() {
    let fixture = Fixture::new();
    let conn = fixture.corruption_connection();
    assert_eq!(
        conn.execute(
            "DELETE FROM narrative_proposal_decisions WHERE revision_id = ?1",
            [fixture.child()]
        )
        .expect("remove only the private approval row"),
        1
    );
    assert_complete_and_fresh(&conn, &fixture, fixture.child());
    assert_unavailable(&conn, &fixture, fixture.child(), fixture.scene("s2"));
}

#[test]
fn a_native_secret_scope_child_stays_ineligible_after_its_own_human_approval() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let secret = create_native_child(&db, &fixture, fixture.child(), |payload| {
        payload["disclosure"]["secret"] = json!(true);
    });
    native_human_decision(&db, &fixture, &secret, "approved");
    db.with_conn(|conn| {
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
        db.with_conn(|conn| {
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
    db.with_conn(|conn| {
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
        db.with_conn(|conn| {
            assert_eq!(
                saved_canonical_state(conn, fixture.child()),
                ("fresh".to_owned(), "none".to_owned())
            );
            assert_unavailable(conn, &fixture, fixture.child(), fixture.scene("s2"));
            Ok(())
        })
        .expect("saved fresh summary does not create an admission window after Native mutation");
        drain_native_feed(&db);
        db.with_conn(|conn| {
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
                    let tx = conn.unchecked_transaction()?;
                    let actual = read_revision_retrieval_eligibility(
                        &tx,
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
        let conn = fixture.corruption_connection();
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
        assert_unavailable(&conn, &fixture, fixture.child(), fixture.scene("s2"));
    }
}

#[test]
fn retrieval_sql_failures_remain_errors() {
    for table in ["narrative_proposal_decisions", "tree_nodes"] {
        let fixture = Fixture::new();
        let conn = fixture.corruption_connection();
        conn.execute_batch(&format!("DROP TABLE {table}"))
            .expect("private SQL error copy");
        let tx = conn
            .unchecked_transaction()
            .expect("SQL error read snapshot");
        let error = read_revision_retrieval_eligibility(
            &tx,
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
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let read = read_revision_retrieval_eligibility(
            &tx,
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
    db.with_conn(|conn| {
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
    db.with_conn(|conn| {
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
    db.with_conn(|conn| {
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
