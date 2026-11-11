//! Retrieval admission against exact normal UI cold storage and Native writers.
//! Membership, canonical Freshness, current Human review, and query Scope are
//! separate assertions; private corruption copies never manufacture positives.
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use grimodex_core::narrative_nir1::PackingPurpose;
use grimodex_core::{canonical_json_digest, canonical_json_string};
use grimodex_db::agent_writes::{
    agent_codex_create_impl, agent_event_create_impl, AgentCodexCreatePayload,
    AgentEventCreatePayload,
};
use grimodex_db::domain_writes::{
    project_patch, tree_node_patch, ProjectPatchPayload, TreeNodePatchPayload,
};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    narrative_extraction_append_human_decision,
    narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto,
    narrative_extraction_prepare_commit, read_and_pack_native_a2_context,
    read_narrative_scene_scope, read_revision_canonical_freshness,
    read_revision_material_membership, read_revision_retrieval_eligibility,
    run_incremental_freshness_cycle, update_narrative_scene_scope,
    update_narrative_scene_scope_registry, AppendDecisionPayload, CommitApplicationRef,
    CommitOperation, CreateHumanDerivedRevisionRequest, IncrementalFreshnessCycleOutcome,
    MaterialMembershipRead, NarrativeAdapterIdentity, NarrativeSceneScopeRegistryUpdatePayload,
    NarrativeSceneScopeUpdatePayload, NativeNir1PackingRequest, NativeNir1RawContextItem,
    PrepareCommitPayload, RevisionEligibilityRead, RevisionEligibilityReason,
    RevisionFreshnessRead,
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
        assert_eq!(
            hex::encode(Sha256::digest(compressed)),
            manifest["compressedDatabaseSha256"]
        );
        let mut bytes = Vec::new();
        GzDecoder::new(compressed.as_slice())
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

fn create_native_child(
    db: &Database,
    fixture: &Fixture,
    parent: &str,
    edit: impl FnOnce(&mut Value),
) -> String {
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
    ).expect("production Native C2B child creation");
    saved["revisionId"]
        .as_str()
        .expect("Native child ID")
        .to_owned()
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

/// DR-CAS-7 f：作者が承認した非 secret の版は、年表の出来事が secret で取り込まれた後も、
/// 資格の本体（read_revision_retrieval_eligibility）で eligible のまま。
#[test]
fn approved_nonsecret_child_stays_eligible_after_its_secret_chronicle_apply() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let run_id = fixture.manifest["runId"].as_str().expect("run").to_owned();

    // 取り込みの前：承認済みの非 secret の版は、どちらも eligible。
    let revisions: Vec<String> = fixture.manifest["revisionIds"]
        .as_array()
        .expect("revision ids")
        .iter()
        .map(|id| id.as_str().expect("revision id").to_owned())
        .collect();
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

    // 承認済みの版は human-derived（作者が秘密を外した子）なので、本物の取り込みは
    // prepare で拒否される（NEX_V2_APPLY_BASIS_UNSUPPORTED、v2_apply_sources.rs の
    // ensure_supported_intent）。そこで、取り込みが書く行を直接書く：
    //   - 年表の出来事（apply_event_create_in_tx と同じ Native writer。secret=1、reveal の場面、
    //     場面への結び付け）
    //   - narrative_proposal_applications の行
    // 操作は、版の payload・Envelope の evidenceSet・封印済み snapshot から、Native の組み立て
    // と同じ形で組む（操作の secret は常に true）。
    let operations: Vec<(String, String, Value)> = db
        .with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT id, current_revision_id FROM narrative_proposals ORDER BY id")?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows
                .into_iter()
                .map(|(proposal_id, revision_id)| {
                    let operation = chronicle_apply_operation(conn, &run_id, &revision_id);
                    (proposal_id, revision_id, operation)
                })
                .collect())
        })
        .expect("compiled Chronicle operations");
    assert_eq!(operations.len(), 2);
    for (index, (proposal_id, revision_id, operation)) in operations.iter().enumerate() {
        assert_eq!(operation["secret"], true);
        let event_id = operation["eventId"].as_str().expect("event id").to_owned();
        let scene_ids: Vec<String> = operation["evidenceSceneLinks"]
            .as_array()
            .expect("evidence links")
            .iter()
            .map(|link| link["sceneId"].as_str().expect("scene").to_owned())
            .collect();
        agent_event_create_impl(
            &db,
            AgentEventCreatePayload {
                request_id: format!("nir1-cas-event-{index}"),
                event_id: Some(event_id.clone()),
                project_id: fixture.project().to_owned(),
                session_id: "nir1-cas-apply-session".to_owned(),
                surface: Some("narrative-extraction".to_owned()),
                title: operation["title"].as_str().map(str::to_owned),
                note: None,
                detail: None,
                ordinal: Some(format!("a{index}")),
                primary_codex_id: None,
                lane_group: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: Some("none".to_owned()),
                end_granularity: Some("none".to_owned()),
                precision: Some("unknown".to_owned()),
                kind: Some("generic".to_owned()),
                secret: operation["secret"].as_bool(),
                reveal_scene_id: operation["revealSceneId"].as_str().map(str::to_owned),
                participant_codex_ids: None,
                scene_ids: Some(scene_ids),
            },
        )
        .expect("Native Chronicle Event create for the applied proposal");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_proposal_applications
                    (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                     applied_entity_id, created_at, application_kind, compensates_application_id)
                 VALUES (?1, 'nir1-cas-direct-commit', ?2, ?3, 'event', ?4,
                         '2026-11-11T00:00:00.000Z', 'normal', NULL)",
                params![
                    Uuid::new_v4().to_string(),
                    proposal_id,
                    revision_id,
                    event_id
                ],
            )?;
            Ok(())
        })
        .expect("proposal application row");
    }

    // 年表の出来事は secret で、reveal の場面は版の reveal の文書の場面。場面にも結び付く。
    db.with_conn(|conn| {
        let rows: Vec<(String, i64, Option<String>)> = conn
            .prepare("SELECT id, secret, reveal_scene_id FROM events ORDER BY id")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<_, _>>()?;
        assert_eq!(rows.len(), 2);
        for (event_id, secret, reveal) in rows {
            assert_eq!(secret, 1, "Chronicle Event {event_id} must be secret");
            assert_eq!(reveal.as_deref(), Some(fixture.scene("s1")));
            let linked: i64 = conn.query_row(
                "SELECT COUNT(*) FROM scene_events WHERE event_id = ?1 AND scene_id = ?2",
                params![event_id, fixture.scene("s1")],
                |row| row.get(0),
            )?;
            assert_eq!(linked, 1);
        }
        Ok(())
    })
    .expect("applied Chronicle Events are secret");

    // 書いた直後（Freshness の変更を処理する前）も、資格は変わらない。
    for revision in &revisions {
        let read = retrieval_read(&db, &fixture, revision);
        assert!(
            read.starts_with("Eligible("),
            "immediately after the Chronicle writes: {read}"
        );
    }

    // 既存の試験と同じ手順：Native の Freshness の周期を最後まで処理する。
    let mut cycles = 0;
    for _ in 0..8 {
        if matches!(
            run_incremental_freshness_cycle(&db).expect("production Native Freshness cycle"),
            IncrementalFreshnessCycleOutcome::Idle
        ) {
            break;
        }
        cycles += 1;
    }
    assert!(
        cycles >= 1,
        "the Chronicle writes must have been evaluated by the Feed"
    );

    db.with_conn(|conn| {
        for revision in &revisions {
            assert_complete_and_fresh(conn, &fixture, revision);
            assert_eligible(conn, &fixture, revision);
        }
        Ok(())
    })
    .expect("the approved non-secret revisions stay eligible after a secret Chronicle apply");
}

/// 今の制限の固定（characterization）。作者が編集した版（human-derived）は、承認済みでも
/// 現行の形式の取り込みの prepare で拒否される（v2_apply_sources.rs の ensure_supported_intent）。
/// 操作の secret が true でも変わらない。編集した版の取り込みを許す変更のときは、この試験を
/// 「prepare と apply が通り、events.secret = 1」へ書き換える（資格の確認は上の試験の形）。
#[test]
fn current_limit_human_derived_revision_is_refused_by_chronicle_prepare() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let run_id = fixture.manifest["runId"].as_str().expect("run").to_owned();

    let before = load_narrative_runtime_policy_from_db(&db).expect("runtime policy");
    set_narrative_runtime_policy(
        &db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".into(),
            maintenance_enabled: before.maintenance_enabled,
            generic_import_enabled: before.generic_import_enabled,
            background_ai_enabled: before.background_ai_enabled,
        },
    )
    .expect("enable manual-apply without changing other policy flags");

    let (set_id, mut planned): (String, Vec<(String, String, Value)>) = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, current_revision_id, proposal_key, proposal_set_id
                   FROM narrative_proposals ORDER BY id",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let set_id = rows[0].3.clone();
            let mut planned = Vec::new();
            for (proposal_id, revision_id, key, _) in rows {
                // 現行の版は human-derived の子（承認済み）。
                let basis: String = conn.query_row(
                    "SELECT json_extract(reconciliation_envelope_json, '$.revisionBasis.kind')
                       FROM narrative_proposal_revisions WHERE id = ?1",
                    [&revision_id],
                    |row| row.get(0),
                )?;
                assert_eq!(basis, "human-derived");
                let operation = chronicle_apply_operation(conn, &run_id, &revision_id);
                assert_eq!(operation["secret"], true);
                planned.push((key, (proposal_id, revision_id, operation)));
            }
            planned.sort_by_key(|(key, _)| {
                key.rsplit(':')
                    .next()
                    .and_then(|index| index.parse::<usize>().ok())
                    .expect("proposal key index")
            });
            Ok((set_id, planned.into_iter().map(|(_, row)| row).collect()))
        })
        .expect("approved human-derived proposals and compiled operations");

    let error = narrative_extraction_prepare_commit(
        &db,
        PrepareCommitPayload {
            project_id: fixture.project().to_owned(),
            run_id: run_id.clone(),
            proposal_set_id: set_id,
            request_id: "nir1-cas-limit-request".to_owned(),
            plan_digest: "ignored".to_owned(),
            session_id: "nir1-cas-limit-session".to_owned(),
            surface: Some("narrative-extraction".to_owned()),
            operations: planned
                .iter()
                .map(|(proposal_id, revision_id, operation)| CommitOperation {
                    kind: "chronicle.event.create".to_owned(),
                    payload: operation.clone(),
                    proposal_id: proposal_id.clone(),
                    revision_id: revision_id.clone(),
                })
                .collect(),
            applications: planned
                .drain(..)
                .map(|(proposal_id, revision_id, _)| CommitApplicationRef {
                    proposal_id,
                    revision_id,
                })
                .collect(),
            expected_tail_ordinal: None,
            entity_bindings: vec![],
            expected_calendar_version: None,
        },
    )
    .expect_err("a human-derived revision is outside the current V2 Apply basis");
    assert!(
        error.to_string().contains("NEX_V2_APPLY_BASIS_UNSUPPORTED"),
        "unexpected human-derived prepare error: {error:#}"
    );
    db.with_conn(|conn| {
        let events: i64 = conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?;
        let commits: i64 =
            conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                row.get(0)
            })?;
        assert_eq!((events, commits), (0, 0));
        Ok(())
    })
    .expect("a refused prepare writes no Event and no commit");
}
