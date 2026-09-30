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
    narrative_extraction_append_human_decision,
    narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto,
    read_and_pack_native_a2_context, read_narrative_scene_scope, read_revision_canonical_freshness,
    read_revision_material_membership, read_revision_retrieval_eligibility,
    run_incremental_freshness_cycle, update_narrative_scene_scope,
    update_narrative_scene_scope_registry, AppendDecisionPayload,
    CreateHumanDerivedRevisionRequest, IncrementalFreshnessCycleOutcome, MaterialMembershipRead,
    NarrativeAdapterIdentity, NarrativeSceneScopeRegistryUpdatePayload,
    NarrativeSceneScopeUpdatePayload, NativeNir1PackingRequest, NativeNir1RawContextItem,
    RevisionEligibilityRead, RevisionEligibilityReason, RevisionFreshnessRead,
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
    let updated_at = if retain_body_token {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT updated_at FROM tree_nodes WHERE id = ?1",
                [scene],
                |row| row.get(0),
            )?)
        })
        .expect("retain unaffected body source coordinates")
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
