//! C2A RED contract tests.
//!
//! These are Phase 1/TDD fixtures for the persistence and validation seam.
//! They intentionally exercise only the existing Native facade and direct
//! fixture rows.  The C2A lane does not run Cargo until the integration owner
//! grants the shared Rust lane.
//!
//! The V2 fixture is copied from the C1 Chronicle scene-event contract:
//! `narrative.chronicle.scene-event`, `chronicle.create-event@1`, and the
//! observation-derived semantic payload.  Every digest below is computed by
//! the shared Native canonicalizer; there are no placeholder digests.

use grimodex_core::{canonical_json_digest, canonical_json_string};
use grimodex_db::narrative_extraction::{
    self, AppendRevisionPayload, ArtifactInput, ChronicleStageC1ExecutionBinding,
    ChronicleStageProvenanceClosure, CreateRunPayload, CreateTaskSeed, FinishTaskPayload,
    ProposalSeed, SaveProposalSetPayload,
};
use grimodex_db::Database;
use serde_json::{json, Value};
use sha2::{Digest as Sha2Digest, Sha256};

const PROJECT_A: &str = "project-a";
const PROJECT_B: &str = "project-b";
const SCENE_ID: &str = "scene-1";
const SCENE_B_ID: &str = "scene-2";

// C1 Chronicle scene-event adapter constants.
const PROPOSAL_KIND: &str = "chronicle.create-event@1";
const PROPOSAL_SCHEMA_ID: &str = "narrative.chronicle-event.create";
const ASSERTION_SCHEMA_ID: &str = "narrative.chronicle.scene-event";
const ADAPTER_ID: &str = "chronicle.scene-event";
const ADAPTER_VERSION: &str = "1";
const ASSERTION_KIND: &str = "scene-event@1";
const CONTEXT_SET_VERSION: &str = "chronicle.context-set/1";
const COMPONENT_CONTRACT_ID: &str = "chronicle.event-synthesis.prompt";
const EVENT_SYNTHESIS_STAGE_ID: &str = "narrative_event_synthesize";
const OBSERVATION_STAGE_ID: &str = "narrative_observation_extract";
const ARRIVAL_QUOTE_DIGEST: &str =
    "sha256:61b3366c3dc326b93fb56073b11453dea0d2db2fe6f79588ce266188edd24c67";
const FORGED_DIGEST: &str =
    "sha256:1111111111111111111111111111111111111111111111111111111111111111";
// C1 stage provenance constants.
const MODEL_BINDING_KIND: &str = "chronicle-stage-model-binding";
const TERMINAL_RECEIPT_KIND: &str = "chronicle-stage-terminal-receipt";
const CLOSURE_KIND: &str = "chronicle-stage-provenance-closure";
const MODEL_BINDING_DOMAIN: &str = "chronicle-stage-model-binding/1";
const TERMINAL_RECEIPT_DOMAIN: &str = "chronicle-stage-terminal-receipt/1";
const CLOSURE_DOMAIN: &str = "chronicle-stage-provenance-closure/1";

fn digest(value: &Value) -> String {
    canonical_json_digest(value).expect("canonical digest")
}

fn canonical(value: &Value) -> String {
    canonical_json_string(value).expect("canonical JSON")
}

fn raw_sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, ?2)",
            rusqlite::params![PROJECT_A, "Project A"],
        )?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, ?2)",
            rusqlite::params![PROJECT_B, "Project B"],
        )?;
        // These rows are the real scene-body resolver inputs.  The token is
        // always read from version + updated_at, never invented in a test.
        for (scene_id, project_id) in [(SCENE_ID, PROJECT_A), (SCENE_B_ID, PROJECT_B)] {
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, version, updated_at)
                 VALUES (?1, ?2, 'scene', 'Arrival', '{\"body\":\"Arrival.\"}', 0,
                         '2026-01-01T00:00:00.000Z')",
                rusqlite::params![scene_id, project_id],
            )?;
        }
        Ok(())
    })
    .expect("seed projects and resolver-backed scenes");
    db
}

fn scene_id(project_id: &str) -> &'static str {
    match project_id {
        PROJECT_A => SCENE_ID,
        PROJECT_B => SCENE_B_ID,
        other => panic!("unknown fixture project {other}"),
    }
}

fn scene_source_key(project_id: &str) -> String {
    format!("project:scene:{}", scene_id(project_id))
}

/// Mirrors the registered `scene-body` resolver's token, from the live row.
fn scene_revision_token(db: &Database, project_id: &str) -> String {
    db.with_conn(|conn| {
        let (version, updated_at): (i64, String) = conn.query_row(
            "SELECT version, updated_at
               FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            rusqlite::params![scene_id(project_id), project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(format!("v{version}@{updated_at}"))
    })
    .expect("resolve scene-body revision token")
}

/// Advance the actual source row and resolve its new token.  A stale parent
/// fixture retains the old token; C2A must not silently rewrite it or promote
/// a child/current revision (those are C2B journeys).
fn advance_scene_source(db: &Database, project_id: &str) -> (String, String) {
    let before = scene_revision_token(db, project_id);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes
                SET version = version + 1,
                    content = '{\"body\":\"Arrival changed.\"}',
                    updated_at = '2099-01-01T00:00:00.000Z'
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            rusqlite::params![scene_id(project_id), project_id],
        )?;
        Ok(())
    })
    .expect("advance live scene-body source");
    let after = scene_revision_token(db, project_id);
    (before, after)
}

fn create_run(db: &Database, project_id: &str, run_id: &str, task_id: &str) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_owned()),
            project_id: project_id.to_owned(),
            surface_path_id: "chronicle.extract".to_owned(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: format!("spec:{run_id}"),
            snapshot_digest: Some("snapshot-v2".to_owned()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_owned()),
                task_kind: "chronicle.plan-proposals@1".to_owned(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");
}

/// Exact non-secret C1 fixture payload from
/// `policies/narrative/fixtures/narrative-ir/chronicle-scene-event-v2.json`.
fn proposal_payload(title: &str, secret: bool) -> Value {
    json!({
        "eventId": "event:arrival",
        "title": title,
        "note": null,
        "actuality": "actual",
        "significance": "major",
        "evidenceAnchorIds": ["anchor:arrival"],
        "evidenceDocumentRefs": ["document:1"],
        "disclosure": {
            "secret": secret,
            "revealDocumentRef": if secret { "document:3" } else { "document:1" }
        },
        "unresolvedMetadata": {
            "participantSurfaces": [],
            "locationSurface": null,
            "temporalExpressions": []
        }
    })
}

/// Exact observation-derived C1 semantic payload.  Projection/disclosure
/// fields deliberately do not cross into the assertion payload.
fn semantic_payload() -> Value {
    json!({
        "eventId": "event:arrival",
        "summary": "A arrives at the station.",
        "actuality": "actual",
        "significance": "major",
        "attribution": "narrator",
        "narrativeFrame": "story-world",
        "observationRefs": ["observation:arrival"],
        "originalObservationRefs": ["observation:arrival"],
        "mergedObservationRefs": ["observation:arrival"],
        "observationSummaries": [{
            "observationRef": "observation:arrival",
            "predicate": "arrival",
            "semanticType": "arrival",
            "participants": [{"surface": "A", "role": "subject"}],
            "locationSurface": "station",
            "temporalExpressions": ["morning"],
            "durationKind": "instant"
        }]
    })
}

fn scope() -> Value {
    json!({
        "schemaVersion": 2,
        "registryVersion": "narrative-scope/2",
        "timeline": {"kind": "any"},
        "worldline": {"kind": "any"},
        "scene": {"kind": "exact", "ref": "scene:1"},
        "viewpoint": {"kind": "any"},
        "knowledgeHolder": {"kind": "any"},
        "audience": {"kind": "any"},
        "narrativeLayer": {"kind": "any"},
        "storyTime": {"kind": "any"},
        "readingOrder": {"kind": "any"}
    })
}

fn source_basis(project_id: &str, revision_token: &str) -> Value {
    json!([{
        "sourceKind": "scene-body",
        "sourceKey": scene_source_key(project_id),
        "revisionToken": revision_token
    }])
}

fn evidence_set() -> Value {
    let quote_digest = raw_sha256_digest(b"Arrival.");
    assert_eq!(quote_digest, ARRIVAL_QUOTE_DIGEST);
    json!([{
        "evidenceRef": "anchor:arrival",
        "documentRef": "document:1",
        "quote": "Arrival.",
        "quoteDigest": quote_digest,
        "sourceKey": "source:scene:1"
    }])
}

fn context_set() -> Value {
    json!([{
        "contextId": "context:event-synthesis",
        "inputRef": "source:scene:1",
        "stageId": EVENT_SYNTHESIS_STAGE_ID,
        "exposure": "model-visible",
        "selector": {"kind": "whole-source"}
    }])
}

fn component_contract() -> Value {
    json!({
        "contractId": COMPONENT_CONTRACT_ID,
        "contractVersion": "1",
        "instruction": "Extract the Chronicle scene event from the declared context.",
        "outputShape": "JSON object matching chronicle.create-event@1."
    })
}

fn context_set_digest() -> String {
    digest(&json!({
        "version": CONTEXT_SET_VERSION,
        "entries": context_set()
    }))
}

fn component_contract_digest() -> String {
    digest(&json!({
        "schemaVersion": 1,
        "contextSetVersion": CONTEXT_SET_VERSION,
        "stageId": EVENT_SYNTHESIS_STAGE_ID,
        "componentContract": component_contract()
    }))
}

fn final_request_digest() -> String {
    digest(&json!({
        "schemaVersion": 1,
        "contextSetVersion": CONTEXT_SET_VERSION,
        "stageId": EVENT_SYNTHESIS_STAGE_ID,
        "contextSetDigest": context_set_digest(),
        "componentContractDigest": component_contract_digest(),
        "messages": [{
            "role": "user",
            "content": "Extract the Chronicle scene event from the declared context."
        }]
    }))
}

fn dependency_set() -> Value {
    json!([
        {
            "dependencyId": "dependency:evidence",
            "inputRef": "source:scene:1",
            "contextIds": ["context:event-synthesis"],
            "role": "direct-evidence",
            "selector": {"kind": "whole-source"}
        },
        {
            "dependencyId": "dependency:component-contract",
            "inputRef": "component:chronicle.event-synthesis.prompt",
            "contextIds": [],
            "role": "component-contract",
            "selector": {
                "kind": "component-contract",
                "contractId": COMPONENT_CONTRACT_ID,
                "contractDigest": component_contract_digest()
            }
        }
    ])
}

/// Build the canonical C1 envelope shape while computing every digest from
/// its Native-owned domain.  C2A must recompute these values at persistence,
/// even if a caller supplies forged digest strings.
fn envelope_v2(db: &Database, project_id: &str, run_id: &str, task_id: &str, title: &str) -> Value {
    let proposal = proposal_payload(title, false);
    let semantic = semantic_payload();
    let scope_value = scope();
    let source = source_basis(project_id, &scene_revision_token(db, project_id));
    let evidence = evidence_set();
    let dependencies = dependency_set();
    let producer = json!({
        "kind": "reconciler-proposal",
        "id": "chronicle.reconciler",
        "version": "1"
    });
    let assertion_core_digest = digest(&json!({
        "assertionKind": ASSERTION_KIND,
        "payloadSchemaRef": {"id": ASSERTION_SCHEMA_ID, "version": "1"},
        "typedSemanticPayload": semantic,
        "modality": "modality-inference",
        "polarity": "affirmative",
        "supportClass": "direct-source",
        "producer": producer
    }));
    let scope_digest = digest(&scope_value);
    let assertion_digest = digest(&json!({
        "assertionCoreDigest": assertion_core_digest,
        "scopeDigest": scope_digest
    }));
    let dependency_set_digest = digest(&dependencies);
    let material_basis_digest = digest(&json!({
        "sourceBasis": source,
        "evidenceSet": evidence,
        "dependencySet": dependencies
    }));
    let context_digest = context_set_digest();
    let component_digest = component_contract_digest();
    let request_digest = final_request_digest();
    let proposal_digest = digest(&proposal);

    json!({
        "schemaVersion": 2,
        "assertion": {
            "assertionId": null,
            "assertionKind": ASSERTION_KIND,
            "payloadSchemaRef": {"id": ASSERTION_SCHEMA_ID, "version": "1"},
            "payload": semantic,
            "scope": scope_value,
            "modality": "modality-inference",
            "polarity": "affirmative",
            "supportClass": "direct-source",
            "producer": producer
        },
        "assertionDigests": {
            "assertionCoreDigest": assertion_core_digest,
            "scopeDigest": scope_digest,
            "assertionDigest": assertion_digest
        },
        "changeIntent": {"changeKind": "add"},
        "effectiveMaterialBasis": {
            "sourceBasis": source,
            "evidenceSet": evidence,
            "dependencySet": dependencies,
            "dependencySetDigest": dependency_set_digest,
            "materialBasisDigest": material_basis_digest
        },
        "revisionBasis": {
            "kind": "interpretation",
            "runId": run_id,
            "taskId": task_id,
            "producer": producer,
            "contextSet": context_set(),
            "contextSetDigest": context_digest,
            "componentContractDigest": component_digest,
            "finalRequestDigest": request_digest
        },
        "projectionBinding": {
            "proposalKind": PROPOSAL_KIND,
            "proposalSchemaRef": {"id": PROPOSAL_SCHEMA_ID, "version": "1"},
            "proposalPayloadDigest": proposal_digest,
            "adapterContractId": ADAPTER_ID,
            "adapterContractVersion": ADAPTER_VERSION
        }
    })
}

/// A complete V1 envelope whose read-set token resolves against the same live
/// scene row as the V2 fixture. C2A must reject this as a V2-current
/// downgrade before the legacy V1 validator gets to accept it.
fn envelope_v1(db: &Database, project_id: &str, run_id: &str, task_id: &str) -> Value {
    let source_key = scene_source_key(project_id);
    let revision_token = scene_revision_token(db, project_id);
    let read_set = json!([{
        "kind": "snapshot-document",
        "sourceKind": "scene-body",
        "inputRef": source_key,
        "revisionToken": revision_token
    }]);
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "taskId": task_id,
        "reconcilerId": "chronicle.reconciler",
        "reconcilerVersion": "1",
        "proposalSchemaId": PROPOSAL_SCHEMA_ID,
        "proposalSchemaVersion": "1",
        "sourceBasis": [{
            "sourceKind": "scene-body",
            "sourceKey": source_key,
            "revisionToken": revision_token
        }],
        "evidenceSet": [],
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", narrative_extraction::digest_plan(&read_set)),
        "changeKind": "revise"
    })
}

fn assert_envelope_digest_fields(envelope: &Value) {
    let assertion = &envelope["assertion"];
    let semantic = &assertion["payload"];
    let producer = &assertion["producer"];
    let assertion_core = digest(&json!({
        "assertionKind": assertion["assertionKind"],
        "payloadSchemaRef": assertion["payloadSchemaRef"],
        "typedSemanticPayload": semantic,
        "modality": assertion["modality"],
        "polarity": assertion["polarity"],
        "supportClass": assertion["supportClass"],
        "producer": producer
    }));
    let assertion_core = if let Some(producer_confidence) = assertion.get("producerConfidence") {
        digest(&json!({
            "assertionKind": assertion["assertionKind"],
            "payloadSchemaRef": assertion["payloadSchemaRef"],
            "typedSemanticPayload": semantic,
            "modality": assertion["modality"],
            "polarity": assertion["polarity"],
            "supportClass": assertion["supportClass"],
            "producer": producer,
            "producerConfidence": producer_confidence
        }))
    } else {
        assertion_core
    };
    let scope_digest = digest(&assertion["scope"]);
    let assertion_digest = digest(&json!({
        "assertionCoreDigest": assertion_core,
        "scopeDigest": scope_digest
    }));
    assert_eq!(
        envelope["assertionDigests"]["assertionCoreDigest"],
        assertion_core
    );
    assert_eq!(envelope["assertionDigests"]["scopeDigest"], scope_digest);
    assert_eq!(
        envelope["assertionDigests"]["assertionDigest"],
        assertion_digest
    );

    let material = &envelope["effectiveMaterialBasis"];
    let dependency_digest = digest(&material["dependencySet"]);
    let material_digest = digest(&json!({
        "sourceBasis": material["sourceBasis"],
        "evidenceSet": material["evidenceSet"],
        "dependencySet": material["dependencySet"]
    }));
    assert_eq!(material["dependencySetDigest"], dependency_digest);
    assert_eq!(material["materialBasisDigest"], material_digest);

    let revision_basis = &envelope["revisionBasis"];
    assert_eq!(
        revision_basis["contextSetDigest"],
        digest(&json!({
            "version": CONTEXT_SET_VERSION,
            "entries": revision_basis["contextSet"]
        }))
    );
    assert_eq!(
        revision_basis["componentContractDigest"],
        component_contract_digest()
    );
    assert_eq!(revision_basis["finalRequestDigest"], final_request_digest());
    assert_eq!(
        envelope["projectionBinding"]["proposalPayloadDigest"],
        digest(&proposal_payload("Arrival", false))
    );
}

fn save_v2_root(
    db: &Database,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    proposal_id: &str,
) -> Value {
    let revision_id = format!("revision-{proposal_id}");
    let source_token = scene_revision_token(db, project_id);
    seed_v2_parent(
        db,
        project_id,
        run_id,
        task_id,
        proposal_id,
        &revision_id,
        &source_token,
    )
}

#[test]
fn public_v2_save_is_activation_disabled_and_rolls_back_without_breaking_v1_save() {
    let db = migrated_db();
    let run_id = "run-public-v2-save";
    let task_id = "task-public-v2-save";
    create_run(&db, PROJECT_A, run_id, task_id);
    let error = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_set_id: Some("set-public-v2-save".to_owned()),
            set_kind: "chronicle.extract.review@1".to_owned(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-public-v2-save".to_owned()),
                proposal_key: "event:arrival:public-v2-save".to_owned(),
                kind: PROPOSAL_KIND.to_owned(),
                payload_json: proposal_payload("Arrival", false),
                reconciliation_envelope: Some(envelope_v2(
                    &db, PROJECT_A, run_id, task_id, "Arrival",
                )),
            }],
        },
    )
    .expect_err("public V2 save must remain dormant");
    assert!(error
        .to_string()
        .contains("NEX_NARRATIVE_V2_ACTIVATION_DISABLED"));
    let set_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_sets WHERE id = 'set-public-v2-save'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("read V2 save rollback");
    assert_eq!(set_count, 0);

    create_run(&db, PROJECT_A, "run-public-v1-save", "task-public-v1-save");
    let legacy = save_legacy_root(
        &db,
        PROJECT_A,
        "run-public-v1-save",
        "task-public-v1-save",
        "proposal-public-v1-save",
    );
    assert_eq!(legacy["originKind"], "legacy-unbound");
}

#[test]
fn v2_ingress_binds_optional_producer_confidence_and_shared_numeric_canonicalization() {
    let db = migrated_db();
    let run_id = "run-v2-canonical-boundary";
    let task_id = "task-v2-canonical-boundary";
    let proposal_id = "proposal-v2-canonical-boundary";
    create_run(&db, PROJECT_A, run_id, task_id);
    let parent = save_legacy_root(&db, PROJECT_A, run_id, task_id, proposal_id);
    let mut child = envelope_v2(&db, PROJECT_A, run_id, task_id, "Arrival");
    child["schemaVersion"] = serde_json::from_str("2.0").expect("integer-valued schema");
    child["assertion"]["scope"]["schemaVersion"] =
        serde_json::from_str("2e0").expect("integer-valued nested schema");
    child["assertion"]["scope"]["scene"]["ref"] = json!("scene:😀");
    child["assertion"]["producerConfidence"] = json!(0.75);
    let assertion_core = digest(&json!({
        "assertionKind": child["assertion"]["assertionKind"],
        "payloadSchemaRef": child["assertion"]["payloadSchemaRef"],
        "typedSemanticPayload": child["assertion"]["payload"],
        "modality": child["assertion"]["modality"],
        "polarity": child["assertion"]["polarity"],
        "supportClass": child["assertion"]["supportClass"],
        "producer": child["assertion"]["producer"],
        "producerConfidence": child["assertion"]["producerConfidence"]
    }));
    let scope_digest = digest(&child["assertion"]["scope"]);
    child["assertionDigests"]["assertionCoreDigest"] = json!(assertion_core);
    child["assertionDigests"]["scopeDigest"] = json!(scope_digest);
    child["assertionDigests"]["assertionDigest"] = json!(digest(&json!({
        "assertionCoreDigest": assertion_core,
        "scopeDigest": scope_digest
    })));
    assert_envelope_digest_fields(&child);

    let error = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: proposal_id.to_owned(),
            payload_json: proposal_payload("Arrival", false),
            reconciliation_envelope: Some(child),
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: parent["revisionId"]
                .as_str()
                .expect("legacy parent revision")
                .to_owned(),
            created_by: Some("c2a-canonical-boundary".to_owned()),
        },
    )
    .expect_err("V2 ingress remains activation-disabled after digest validation");
    assert!(
        error
            .to_string()
            .contains("NEX_NARRATIVE_V2_ACTIVATION_DISABLED"),
        "numeric/producer V2 was not recognized before activation gate: {error:#}"
    );
}

#[test]
fn public_v2_append_is_activation_disabled_for_v2_and_legacy_current_without_pointer_change() {
    for (case, use_v2_current) in [("v2-current", true), ("legacy-current", false)] {
        let db = migrated_db();
        let run_id = format!("run-public-v2-append-{case}");
        let task_id = format!("task-public-v2-append-{case}");
        let proposal_id = format!("proposal-public-v2-append-{case}");
        if !use_v2_current {
            create_run(&db, PROJECT_A, &run_id, &task_id);
        }
        let parent = if use_v2_current {
            save_v2_root(&db, PROJECT_A, &run_id, &task_id, &proposal_id)
        } else {
            save_legacy_root(&db, PROJECT_A, &run_id, &task_id, &proposal_id)
        };
        let expected_current = parent["revisionId"]
            .as_str()
            .expect("parent revision")
            .to_owned();
        let error = narrative_extraction::narrative_extraction_append_revision(
            &db,
            AppendRevisionPayload {
                run_id: run_id.clone(),
                project_id: PROJECT_A.to_owned(),
                proposal_id: proposal_id.clone(),
                payload_json: proposal_payload("Arrival", false),
                reconciliation_envelope: Some(envelope_v2(
                    &db, PROJECT_A, &run_id, &task_id, "Arrival",
                )),
                inherit_reconciliation_envelope: None,
                expected_current_revision_id: expected_current.clone(),
                created_by: Some("c2a-activation-test".to_owned()),
            },
        )
        .expect_err("public V2 append must remain dormant");
        assert!(
            error
                .to_string()
                .contains("NEX_NARRATIVE_V2_ACTIVATION_DISABLED"),
            "{case}: {error:#}"
        );
        let (current_revision, revision_count): (String, i64) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT current_revision_id,
                            (SELECT COUNT(*) FROM narrative_proposal_revisions WHERE proposal_id = ?1)
                       FROM narrative_proposals WHERE id = ?1",
                    rusqlite::params![proposal_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            })
            .expect("read V2 append rollback");
        assert_eq!(
            current_revision, expected_current,
            "{case}: pointer changed"
        );
        assert_eq!(revision_count, 1, "{case}: child revision persisted");
    }
}

#[test]
fn public_v2_append_rejects_forged_digest_at_activation_boundary() {
    let db = migrated_db();
    let run_id = "run-public-v2-forged-digest";
    let task_id = "task-public-v2-forged-digest";
    let proposal_id = "proposal-public-v2-forged-digest";
    create_run(&db, PROJECT_A, run_id, task_id);
    let parent = save_legacy_root(&db, PROJECT_A, run_id, task_id, proposal_id);
    let expected_current = parent["revisionId"]
        .as_str()
        .expect("parent revision")
        .to_owned();
    let mut forged = envelope_v2(&db, PROJECT_A, run_id, task_id, "Arrival");
    forged["projectionBinding"]["proposalPayloadDigest"] = json!(FORGED_DIGEST);

    let error = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: proposal_id.to_owned(),
            payload_json: proposal_payload("Arrival", false),
            reconciliation_envelope: Some(forged),
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: expected_current.clone(),
            created_by: Some("c2a-activation-forged-digest".to_owned()),
        },
    )
    .expect_err("public V2 append must remain activation-disabled");
    assert!(
        error
            .to_string()
            .contains("NEX_NARRATIVE_V2_ACTIVATION_DISABLED"),
        "public V2 activation boundary changed: {error:#}"
    );
    let (current_revision, revision_count): (String, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT current_revision_id,
                        (SELECT COUNT(*) FROM narrative_proposal_revisions WHERE proposal_id = ?1)
                   FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read forged V2 activation rollback");
    assert_eq!(current_revision, expected_current);
    assert_eq!(revision_count, 1);
}

fn save_legacy_root(
    db: &Database,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    proposal_id: &str,
) -> Value {
    narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_owned(),
            project_id: project_id.to_owned(),
            proposal_set_id: Some(format!("set-{proposal_id}")),
            set_kind: "chronicle.extract.review@1".to_owned(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_owned()),
                proposal_key: format!("event:arrival:{task_id}"),
                kind: PROPOSAL_KIND.to_owned(),
                payload_json: proposal_payload("Arrival", false),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect("save legacy fixture")["proposals"][0]
        .clone()
}

fn seed_v2_parent(
    db: &Database,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    proposal_id: &str,
    revision_id: &str,
    source_revision_token: &str,
) -> Value {
    create_run(db, project_id, run_id, task_id);
    let envelope = envelope_v2(db, project_id, run_id, task_id, "Arrival");
    let envelope_json = canonical(&envelope);
    let envelope_digest = digest(&envelope);
    let payload_json = canonical(&proposal_payload("Arrival", false));
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_proposal_sets
                (id, run_id, project_id, set_kind, summary_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'chronicle.extract.review@1', '{}', datetime('now'), datetime('now'))",
            rusqlite::params![format!("set-{proposal_id}"), run_id, project_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposals
                (id, proposal_set_id, proposal_key, kind, status, payload_json,
                 current_revision_id, created_at, updated_at)
             VALUES (?1, ?2, 'event:arrival:0', ?3, 'unreviewed', ?4, ?5,
                     datetime('now'), datetime('now'))",
            rusqlite::params![
                proposal_id,
                format!("set-{proposal_id}"),
                PROPOSAL_KIND,
                payload_json,
                revision_id
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposal_revisions
                (id, proposal_id, revision_number, payload_json, origin_kind,
                 reconciliation_envelope_json, reconciliation_envelope_digest,
                 created_at, created_by)
             VALUES (?1, ?2, 1, ?3, 'enveloped', ?4, ?5, datetime('now'), 'chronicle')",
            rusqlite::params![revision_id, proposal_id, payload_json, envelope_json, envelope_digest],
        )?;
        conn.execute(
            "INSERT INTO narrative_revision_source_basis
                (revision_id, ordinal, source_kind, source_key, revision_token)
             VALUES (?1, 0, 'scene-body', ?2, ?3)",
            rusqlite::params![revision_id, scene_source_key(project_id), source_revision_token],
        )?;
        Ok(())
    })
    .expect("seed V2 parent");
    json!({
        "revisionId": revision_id,
        "envelopeDigest": envelope_digest,
        "observedSourceRevisionToken": source_revision_token
    })
}

fn claim_task(db: &Database, project_id: &str, run_id: &str) -> String {
    let claimed = narrative_extraction::narrative_extraction_claim_task(
        db,
        narrative_extraction::ClaimTaskPayload {
            run_id: run_id.to_owned(),
            project_id: project_id.to_owned(),
            lease_owner: "c2a-test-worker".to_owned(),
            lease_duration_secs: Some(300),
            task_kinds: None,
        },
    )
    .expect("claim task");
    claimed["task"]["attemptId"]
        .as_str()
        .expect("attempt id")
        .to_owned()
}

fn observation_payload() -> Value {
    json!({
        "localId": "observation:arrival",
        "evidence": [{"sourceRef": "source:scene:1", "quote": "Arrival."}],
        "assertion": {"attribution": "narrator", "narrativeFrame": "story-world"},
        "payload": {
            "predicate": "arrival",
            "semanticType": "arrival",
            "actuality": "actual",
            "participants": [{"surface": "A", "role": "subject"}],
            "locationSurface": "station",
            "temporalExpressions": ["morning"],
            "durationKind": "instant"
        }
    })
}

fn raw_observations(local_ids: &[&str]) -> Value {
    let observations = local_ids
        .iter()
        .map(|local_id| {
            let mut observation = observation_payload();
            observation["localId"] = Value::String((*local_id).to_owned());
            observation
        })
        .collect::<Vec<_>>();
    json!({
        "kind": "chronicle.raw-observations@1",
        "version": 1,
        "observations": observations
    })
}

fn model_binding() -> Value {
    json!({
        "kind": MODEL_BINDING_KIND,
        "version": 1,
        "provider": "ollama",
        "endpointBindingId": null,
        "requestedModel": "qwen3:8b",
        "effectiveModel": null,
        "modelFingerprint": null,
        "apiVariant": null,
        "reasoningMode": null,
        "generationMode": "provider-default",
        "resolutionStatus": "requested-only"
    })
}

#[allow(clippy::too_many_arguments)]
fn stage_receipt(
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    stage_id: &str,
    stage_execution_id: &str,
    context_digest: &str,
    component_digest: &str,
    request_digest: &str,
    response: &Value,
) -> Value {
    stage_receipt_with_state(
        project_id,
        run_id,
        task_id,
        attempt_id,
        stage_id,
        stage_execution_id,
        None,
        context_digest,
        component_digest,
        request_digest,
        "parsed",
        "succeeded",
        Some(response),
    )
}

#[allow(clippy::too_many_arguments)]
fn stage_receipt_with_state(
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    stage_id: &str,
    stage_execution_id: &str,
    parent_stage_execution_id: Option<&str>,
    context_digest: &str,
    component_digest: &str,
    request_digest: &str,
    parse_status: &str,
    terminal_status: &str,
    response: Option<&Value>,
) -> Value {
    let binding = model_binding();
    let binding_digest = digest(&json!({
        "domain": MODEL_BINDING_DOMAIN,
        "binding": binding
    }));
    let response_digest = response.map(digest);
    let mut stage_execution = json!({
        "projectId": project_id,
        "runId": run_id,
        "taskId": task_id,
        "attemptId": attempt_id,
        "stageId": stage_id,
        "stageExecutionId": stage_execution_id
    });
    if let Some(parent_stage_execution_id) = parent_stage_execution_id {
        stage_execution["parentStageExecutionId"] =
            Value::String(parent_stage_execution_id.to_owned());
    }
    let without_digest = json!({
        "kind": TERMINAL_RECEIPT_KIND,
        "version": 1,
        "stageExecution": stage_execution,
        "contextSetVersion": CONTEXT_SET_VERSION,
        "contextSetDigest": context_digest,
        "componentContractDigest": component_digest,
        "finalRequestDigest": request_digest,
        "modelExecutionBinding": binding,
        "modelBindingDigest": binding_digest,
        "responseDigest": response_digest,
        "parseStatus": parse_status,
        "terminalStatus": terminal_status
    });
    let receipt_digest = digest(&json!({
        "domain": TERMINAL_RECEIPT_DOMAIN,
        "stageExecution": without_digest["stageExecution"],
        "contextSetVersion": without_digest["contextSetVersion"],
        "contextSetDigest": without_digest["contextSetDigest"],
        "componentContractDigest": without_digest["componentContractDigest"],
        "finalRequestDigest": without_digest["finalRequestDigest"],
        "modelBindingDigest": without_digest["modelBindingDigest"],
        "responseDigest": without_digest["responseDigest"],
        "parseStatus": without_digest["parseStatus"],
        "terminalStatus": without_digest["terminalStatus"]
    }));
    let mut receipt = without_digest;
    receipt["stageExecutionReceiptDigest"] = Value::String(receipt_digest);
    receipt
}

fn valid_stage_closure(
    project_id: &str,
    run_id: &str,
    owner_task_id: &str,
    owner_attempt_id: &str,
    context_digest: &str,
    component_digest: &str,
    request_digest: &str,
) -> Value {
    let observation_receipt = stage_receipt(
        project_id,
        run_id,
        "task:observation",
        "attempt:observation",
        OBSERVATION_STAGE_ID,
        "stage:observation",
        context_digest,
        component_digest,
        request_digest,
        &json!({"observations": [observation_payload()]}),
    );
    let synthesis_receipt = stage_receipt(
        project_id,
        run_id,
        owner_task_id,
        owner_attempt_id,
        EVENT_SYNTHESIS_STAGE_ID,
        "stage:event-synthesis",
        context_digest,
        component_digest,
        request_digest,
        &json!({"proposal": proposal_payload("Arrival", false)}),
    );
    // C1 requires canonical code-unit ordering by stageExecutionId.
    let receipts = json!([synthesis_receipt, observation_receipt]);
    closure_for_receipts(
        project_id,
        run_id,
        owner_task_id,
        owner_attempt_id,
        receipts,
    )
}

fn closure_for_receipts(
    project_id: &str,
    run_id: &str,
    owner_task_id: &str,
    owner_attempt_id: &str,
    receipts: Value,
) -> Value {
    let receipt_refs = json!(receipts
        .as_array()
        .expect("closure receipts")
        .iter()
        .map(|receipt| {
            json!({
                "stageExecutionId": receipt["stageExecution"]["stageExecutionId"],
                "stageExecutionReceiptDigest": receipt["stageExecutionReceiptDigest"]
            })
        })
        .collect::<Vec<_>>());
    let mut receipt_refs = receipt_refs;
    let refs = receipt_refs.as_array_mut().expect("closure receipt refs");
    refs.sort_by(|left, right| {
        left["stageExecutionId"]
            .as_str()
            .cmp(&right["stageExecutionId"].as_str())
            .then_with(|| {
                left["stageExecutionReceiptDigest"]
                    .as_str()
                    .cmp(&right["stageExecutionReceiptDigest"].as_str())
            })
    });
    let without_digest = json!({
        "kind": CLOSURE_KIND,
        "version": 1,
        "projectId": project_id,
        "runId": run_id,
        "ownerTaskId": owner_task_id,
        "ownerAttemptId": owner_attempt_id,
        "receipts": receipts,
        "receiptRefs": receipt_refs
    });
    let closure_digest = digest(&json!({
        "domain": CLOSURE_DOMAIN,
        "projectId": without_digest["projectId"],
        "runId": without_digest["runId"],
        "ownerTaskId": without_digest["ownerTaskId"],
        "ownerAttemptId": without_digest["ownerAttemptId"],
        "receipts": without_digest["receipts"],
        "receiptRefs": without_digest["receiptRefs"]
    }));
    let mut closure = without_digest;
    closure["stageProvenanceClosureDigest"] = Value::String(closure_digest);
    closure
}

/// Seed the durable lifecycle rows a stage receipt binds to. Receipts are
/// CAS'd against the ledger, so fixtures must own real Task/Attempt rows.
fn seed_stage_task_attempt(
    db: &Database,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    task_kind: &str,
) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, created_at)
             VALUES (?1, ?2, ?3, 'completed', datetime('now'))",
            rusqlite::params![task_id, run_id, task_kind],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at)
             VALUES (?1, ?2, 1, 'completed', datetime('now'))",
            rusqlite::params![attempt_id, task_id],
        )?;
        Ok(())
    })
    .expect("seed stage lifecycle rows");
}

/// Seed one AI-audit ledger event binding a receipt's stage execution and
/// response digest, mirroring the transport's terminal metadata shape.
fn seed_stage_audit_event(
    db: &Database,
    project_id: &str,
    stage_execution_id: &str,
    response_digest: &str,
) {
    db.with_conn(|conn| {
        let scope_id = format!("project:{project_id}");
        let sequence: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM ai_audit_events WHERE scope_id = ?1",
            rusqlite::params![scope_id],
            |row| row.get(0),
        )?;
        let payload = json!({
            "metadata": {"chronicleStage": {
                "stageExecution": {"stageExecutionId": stage_execution_id},
                "responseDigest": response_digest,
            }}
        })
        .to_string();
        conn.execute(
            "INSERT INTO ai_audit_events
                (scope_id, project_id, sequence, event_id, execution_id, operation_id,
                 path_id, event_type, timestamp, recorded_at, payload, payload_sha256,
                 prev_hash, hash)
             VALUES (?1, ?2, ?3, ?4, ?5, 'op-test', 'path-test', 'completion', 0, 0,
                     ?6, 'sha256:test', 'sha256:test', 'sha256:test')",
            rusqlite::params![
                scope_id,
                project_id,
                sequence,
                format!("audit-{stage_execution_id}-{sequence}"),
                format!("exec-{stage_execution_id}"),
                payload,
            ],
        )?;
        Ok(())
    })
    .expect("seed stage audit event");
}

/// Seed lifecycle + audit evidence for every receipt in a fixture closure.
/// Non-owner synthesis roots are deliberately NOT seeded as synthesize
/// tasks: an unrelated synthesis owner must stay unknown to the ledger.
fn seed_closure_evidence(db: &Database, run_id: &str, owner_task_id: &str, closure: &Value) {
    for receipt in closure["receipts"].as_array().expect("closure receipts") {
        let execution = &receipt["stageExecution"];
        let task_id = execution["taskId"].as_str().expect("receipt taskId");
        let attempt_id = execution["attemptId"].as_str().expect("receipt attemptId");
        let stage_id = execution["stageId"].as_str().expect("receipt stageId");
        if task_id != owner_task_id && stage_id == OBSERVATION_STAGE_ID {
            seed_stage_task_attempt(db, run_id, task_id, attempt_id, "chronicle.observe-events@1");
        }
        if let Some(response_digest) = receipt["responseDigest"].as_str() {
            seed_stage_audit_event(
                db,
                PROJECT_A,
                execution["stageExecutionId"]
                    .as_str()
                    .expect("stage execution id"),
                response_digest,
            );
        }
    }
}

fn artifact(id: &str, kind: &str, payload: Value) -> ArtifactInput {
    ArtifactInput {
        artifact_id: Some(id.to_owned()),
        artifact_kind: kind.to_owned(),
        payload_storage: Some("inline-json".to_owned()),
        payload_digest: Some(digest(&payload)),
        payload_json: Some(payload),
        payload_ref: None,
    }
}

fn finish_bundle(
    db: &Database,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    closure: Value,
) -> anyhow::Result<Value> {
    let raw = raw_observations(&["observation:arrival"]);
    finish_bundle_with_raw(db, run_id, task_id, attempt_id, closure, raw, None, None)
}

#[allow(clippy::too_many_arguments)]
fn finish_bundle_with_raw(
    db: &Database,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    closure: Value,
    raw_observations: Value,
    output_closure_digest: Option<&str>,
    raw_payload_digest: Option<&str>,
) -> anyhow::Result<Value> {
    let observation_refs = raw_observations["observations"]
        .as_array()
        .expect("raw observations")
        .iter()
        .map(|observation| observation["localId"].clone())
        .collect::<Vec<_>>();
    let observation_count = raw_observations["observations"]
        .as_array()
        .expect("raw observations")
        .len() as u64;
    let mut raw_artifact = artifact(
        &format!("{task_id}-raw-observations"),
        "chronicle.raw-observations@1",
        raw_observations,
    );
    if let Some(payload_digest) = raw_payload_digest {
        raw_artifact.payload_digest = Some(payload_digest.to_owned());
    }
    finish_bundle_with_artifacts(
        db,
        run_id,
        task_id,
        attempt_id,
        closure,
        observation_count,
        Value::Array(observation_refs),
        vec![raw_artifact],
        output_closure_digest,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_bundle_with_artifacts(
    db: &Database,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    closure: Value,
    observation_count: u64,
    observation_refs: Value,
    artifacts: Vec<ArtifactInput>,
    output_closure_digest: Option<&str>,
) -> anyhow::Result<Value> {
    let closure_digest = closure["stageProvenanceClosureDigest"]
        .as_str()
        .expect("closure digest")
        .to_owned();
    seed_closure_evidence(db, run_id, task_id, &closure);
    let typed_closure: ChronicleStageProvenanceClosure =
        serde_json::from_value(closure.clone()).expect("typed ephemeral closure");
    let raw_observations_digest = artifacts
        .iter()
        .find(|artifact| artifact.artifact_kind == "chronicle.raw-observations@1")
        .and_then(|artifact| artifact.payload_digest.clone())
        .unwrap_or_else(|| FORGED_DIGEST.to_owned());
    let output = json!({
        "kind": "chronicle.event-synthesis-output@1",
        "observationCount": observation_count,
        "observationRefs": observation_refs,
        "rawObservationsDigest": raw_observations_digest,
        "stageProvenanceClosureDigest": output_closure_digest
            .map_or_else(|| closure["stageProvenanceClosureDigest"].clone(), |digest| json!(digest))
    });
    narrative_extraction::narrative_extraction_finish_task(
        db,
        FinishTaskPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            task_id: task_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            lease_owner: "c2a-test-worker".to_owned(),
            output_json: Some(output),
            artifacts,
            chronicle_stage_bundle: Some(ChronicleStageC1ExecutionBinding {
                project_id: PROJECT_A.to_owned(),
                run_id: run_id.to_owned(),
                task_id: task_id.to_owned(),
                attempt_id: attempt_id.to_owned(),
                context_set_digest: context_set_digest(),
                component_contract_digest: component_contract_digest(),
                final_request_digest: final_request_digest(),
                stage_provenance_closure_digest: closure_digest,
                closure: typed_closure,
            }),
            historical_scope_authority_basis: None,
        },
    )
}

#[test]
fn persists_native_canonical_envelope_v2_and_project_qualified_identity() {
    let db = migrated_db();
    let expected_a = envelope_v2(&db, PROJECT_A, "run-v2-a", "task-v2-a", "Arrival");
    let expected_b = envelope_v2(&db, PROJECT_B, "run-v2-b", "task-v2-b", "Arrival");
    assert_envelope_digest_fields(&expected_a);
    assert_envelope_digest_fields(&expected_b);

    let first = save_v2_root(&db, PROJECT_A, "run-v2-a", "task-v2-a", "proposal-a");
    let second = save_v2_root(&db, PROJECT_B, "run-v2-b", "task-v2-b", "proposal-b");
    let first_revision = first["revisionId"].as_str().expect("first revision");
    let second_revision = second["revisionId"].as_str().expect("second revision");
    assert_ne!(
        first_revision, second_revision,
        "revision identity is project-scoped"
    );

    let (origin, envelope_json, envelope_digest, project_id): (String, String, String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT r.origin_kind, r.reconciliation_envelope_json,
                        r.reconciliation_envelope_digest, s.project_id
                   FROM narrative_proposal_revisions r
                   JOIN narrative_proposals p ON p.id = r.proposal_id
                   JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                  WHERE r.id = ?1 AND s.project_id = ?2",
                rusqlite::params![first_revision, PROJECT_A],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .expect("read project-qualified V2 root");
    let persisted: Value = serde_json::from_str(&envelope_json).expect("canonical envelope");
    assert_eq!(origin, "enveloped");
    assert_eq!(persisted, expected_a);
    assert_eq!(envelope_json, canonical(&expected_a));
    assert_envelope_digest_fields(&persisted);
    assert_eq!(envelope_digest, digest(&persisted));
    assert_eq!(first["envelopeDigest"], envelope_digest);
    assert_eq!(project_id, PROJECT_A);
    let wrong_project_lookup: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*)
                   FROM narrative_proposal_revisions r
                   JOIN narrative_proposals p ON p.id = r.proposal_id
                   JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                  WHERE r.id = ?1 AND s.project_id = ?2",
                rusqlite::params![first_revision, PROJECT_B],
                |row| row.get(0),
            )?)
        })
        .expect("project-qualified negative lookup");
    assert_eq!(wrong_project_lookup, 0);
}

#[test]
fn persists_a_valid_atomic_stage_bundle_with_receipts_bindings_output_and_artifact() {
    let db = migrated_db();
    let run_id = "run-stage-valid";
    let task_id = "task-stage-valid";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let closure = valid_stage_closure(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
    );
    assert_eq!(closure["receipts"].as_array().unwrap().len(), 2);
    for receipt in closure["receipts"].as_array().expect("closure receipts") {
        assert_eq!(
            receipt["modelBindingDigest"],
            digest(&json!({
                "domain": MODEL_BINDING_DOMAIN,
                "binding": receipt["modelExecutionBinding"]
            }))
        );
        assert_eq!(
            receipt["stageExecutionReceiptDigest"],
            digest(&json!({
                "domain": TERMINAL_RECEIPT_DOMAIN,
                "stageExecution": receipt["stageExecution"],
                "contextSetVersion": receipt["contextSetVersion"],
                "contextSetDigest": receipt["contextSetDigest"],
                "componentContractDigest": receipt["componentContractDigest"],
                "finalRequestDigest": receipt["finalRequestDigest"],
                "modelBindingDigest": receipt["modelBindingDigest"],
                "responseDigest": receipt["responseDigest"],
                "parseStatus": receipt["parseStatus"],
                "terminalStatus": receipt["terminalStatus"]
            }))
        );
    }
    let expected_closure_digest = digest(&json!({
        "domain": CLOSURE_DOMAIN,
        "projectId": closure["projectId"],
        "runId": closure["runId"],
        "ownerTaskId": closure["ownerTaskId"],
        "ownerAttemptId": closure["ownerAttemptId"],
        "receipts": closure["receipts"],
        "receiptRefs": closure["receiptRefs"]
    }));
    assert_eq!(
        closure["stageProvenanceClosureDigest"],
        expected_closure_digest
    );

    finish_bundle(&db, run_id, task_id, &attempt_id, closure.clone())
        .expect("valid C1 closure bundle must finish atomically");
    let (task_status, attempt_status, output_json, artifact_count): (String, String, String, i64) =
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT t.status, a.status, t.output_json,
                        (SELECT COUNT(*) FROM narrative_extraction_artifacts
                          WHERE run_id = ?1 AND task_id = ?2)
                   FROM narrative_extraction_tasks t
                   JOIN narrative_extraction_attempts a ON a.id = ?3
                  WHERE t.id = ?2 AND t.run_id = ?1",
                rusqlite::params![run_id, task_id, attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .expect("read valid atomic bundle");
    assert_eq!(task_status, "completed");
    assert_eq!(attempt_status, "completed");
    let output: Value = serde_json::from_str(&output_json).expect("task output JSON");
    assert_eq!(
        output["stageProvenanceClosureDigest"],
        closure["stageProvenanceClosureDigest"]
    );
    assert_eq!(
        artifact_count, 1,
        "only durable raw observations are retained"
    );
}

#[test]
fn persists_a_valid_structured_repair_path_without_new_task_or_attempt() {
    let db = migrated_db();
    let run_id = "run-stage-repair";
    let task_id = "task-stage-repair";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let context_digest = context_set_digest();
    let component_digest = component_contract_digest();
    let request_digest = final_request_digest();
    let failed_observation = stage_receipt_with_state(
        PROJECT_A,
        run_id,
        "task:observation",
        "attempt:observation",
        OBSERVATION_STAGE_ID,
        "stage:observation-failed",
        None,
        &context_digest,
        &component_digest,
        &request_digest,
        "invalid",
        "failed",
        Some(&json!({"error": "invalid observation shape"})),
    );
    let repaired_observation = stage_receipt_with_state(
        PROJECT_A,
        run_id,
        "task:observation",
        "attempt:observation",
        "narrative_structured_repair",
        "stage:observation-repair",
        Some("stage:observation-failed"),
        &context_digest,
        &component_digest,
        &request_digest,
        "parsed",
        "succeeded",
        Some(&json!({"observations": [observation_payload()]})),
    );
    let synthesis = stage_receipt(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        EVENT_SYNTHESIS_STAGE_ID,
        "stage:event-synthesis",
        &context_digest,
        &component_digest,
        &request_digest,
        &json!({"proposal": proposal_payload("Arrival", false)}),
    );
    let closure = closure_for_receipts(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        json!([synthesis, failed_observation, repaired_observation]),
    );
    finish_bundle(&db, run_id, task_id, &attempt_id, closure)
        .expect("failed root plus parsed repair child must close atomically");

    let (receipt_count, binding_count): (i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM narrative_extraction_stage_receipts
                      WHERE project_id = ?1 AND run_id = ?2),
                    (SELECT COUNT(*) FROM narrative_extraction_stage_model_bindings
                      WHERE project_id = ?1 AND run_id = ?2)",
                rusqlite::params![PROJECT_A, run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read persisted repair closure");
    assert_eq!(receipt_count, 3);
    assert_eq!(binding_count, 3);
}

#[test]
fn rejects_owner_synthesis_c1_digest_forgery_against_trusted_binding_atomically() {
    let db = migrated_db();
    let run_id = "run-stage-owner-digest-forged";
    let task_id = "task-stage-owner-digest-forged";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let forged_context_digest = digest(&json!({"forged": "owner-context"}));
    let closure = valid_stage_closure(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        &forged_context_digest,
        &component_contract_digest(),
        &final_request_digest(),
    );
    let error = finish_bundle(&db, run_id, task_id, &attempt_id, closure)
        .expect_err("owner synthesis C1 digest must be bound to trusted execution input");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_STAGE_BUNDLE_DIGEST_MISMATCH"),
        "unexpected owner digest error: {error:#}"
    );
    let (task_status, attempt_status, artifact_count, receipt_count, binding_count): (
        String,
        String,
        i64,
        i64,
        i64,
    ) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT t.status, a.status,
                        (SELECT COUNT(*) FROM narrative_extraction_artifacts
                          WHERE run_id = ?1 AND task_id = ?2),
                        (SELECT COUNT(*) FROM narrative_extraction_stage_receipts
                          WHERE run_id = ?1),
                        (SELECT COUNT(*) FROM narrative_extraction_stage_model_bindings
                          WHERE run_id = ?1)
                   FROM narrative_extraction_tasks t
                   JOIN narrative_extraction_attempts a ON a.id = ?3
                  WHERE t.id = ?2 AND t.run_id = ?1",
                rusqlite::params![run_id, task_id, attempt_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?)
        })
        .expect("read owner digest rollback");
    assert_eq!(task_status, "running");
    assert_eq!(attempt_status, "running");
    assert_eq!(artifact_count, 0);
    assert_eq!(receipt_count, 0);
    assert_eq!(binding_count, 0);
}

#[test]
fn owner_synthesis_binding_cannot_use_unrelated_successful_root() {
    let db = migrated_db();
    let run_id = "run-stage-owner-path";
    let task_id = "task-stage-owner-path";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let context_digest = context_set_digest();
    let component_digest = component_contract_digest();
    let request_digest = final_request_digest();
    let failed_owner = stage_receipt_with_state(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        EVENT_SYNTHESIS_STAGE_ID,
        "stage:owner-failed",
        None,
        &context_digest,
        &component_digest,
        &request_digest,
        "invalid",
        "failed",
        Some(&json!({"error": "owner synthesis failed"})),
    );
    let unrelated_success = stage_receipt(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        EVENT_SYNTHESIS_STAGE_ID,
        "stage:owner-unrelated-success",
        &digest(&json!({"unrelated": "context"})),
        &component_digest,
        &request_digest,
        &json!({"proposal": proposal_payload("Unrelated", false)}),
    );
    let observation = stage_receipt(
        PROJECT_A,
        run_id,
        "task:observation",
        "attempt:observation",
        OBSERVATION_STAGE_ID,
        "stage:observation-owner-path",
        &context_digest,
        &component_digest,
        &request_digest,
        &json!({"observations": [observation_payload()]}),
    );
    let closure = closure_for_receipts(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        json!([failed_owner, unrelated_success, observation]),
    );
    let error = finish_bundle(&db, run_id, task_id, &attempt_id, closure)
        .expect_err("unrelated synthesis success must not satisfy owner binding");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_STAGE_BUNDLE_OWNER_PATH_MISMATCH"),
        "unexpected owner path error: {error:#}"
    );
}

#[test]
fn chronicle_synthesis_requires_typed_closure_raw_output_link_atomically() {
    let db = migrated_db();
    let run_id = "run-stage-companion-missing";
    let task_id = "task-stage-companion-missing";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let output = json!({
        "kind": "chronicle.event-synthesis-output@1",
        "observationCount": 1,
        "eventCount": 1,
        "observationRefs": ["observation:arrival"],
        "stageProvenanceClosureDigest": FORGED_DIGEST
    });
    let raw = json!({
        "kind": "chronicle.raw-observations@1",
        "version": 1,
        "observations": [observation_payload()]
    });
    let error = narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            task_id: task_id.to_owned(),
            attempt_id: attempt_id.clone(),
            lease_owner: "c2a-test-worker".to_owned(),
            output_json: Some(output),
            artifacts: vec![artifact(
                "missing-closure-raw",
                "chronicle.raw-observations@1",
                raw,
            )],
            // The output/raw reserved pair intentionally enters the generic
            // path here to prove the typed closure bundle cannot be omitted.
            chronicle_stage_bundle: None,
            historical_scope_authority_basis: None,
        },
    )
    .expect_err("typed Chronicle output without closure must fail closed");
    assert!(error
        .to_string()
        .contains("NEX_CHRONICLE_STAGE_BUNDLE_REQUIRED"));
    let (task_status, attempt_status, artifact_count): (String, String, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT t.status, a.status,
                        (SELECT COUNT(*) FROM narrative_extraction_artifacts
                          WHERE run_id = ?1 AND task_id = ?2)
                   FROM narrative_extraction_tasks t
                   JOIN narrative_extraction_attempts a ON a.id = ?3
                  WHERE t.id = ?2 AND t.run_id = ?1",
                rusqlite::params![run_id, task_id, attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read missing-companion rollback");
    assert_eq!(task_status, "running");
    assert_eq!(attempt_status, "running");
    assert_eq!(artifact_count, 0);
}

#[test]
fn chronicle_synthesis_rejects_forged_output_link_and_sensitive_raw_sibling() {
    for (case, output_digest, raw_extra) in [
        ("output-link", Some(FORGED_DIGEST), None),
        (
            "raw-sensitive",
            None,
            Some(json!({"rawResponse": "secret"})),
        ),
    ] {
        let db = migrated_db();
        let run_id = format!("run-stage-companion-{case}");
        let task_id = format!("task-stage-companion-{case}");
        create_run(&db, PROJECT_A, &run_id, &task_id);
        let attempt_id = claim_task(&db, PROJECT_A, &run_id);
        let closure = valid_stage_closure(
            PROJECT_A,
            &run_id,
            &task_id,
            &attempt_id,
            &context_set_digest(),
            &component_contract_digest(),
            &final_request_digest(),
        );
        let mut raw = json!({
            "kind": "chronicle.raw-observations@1",
            "version": 1,
            "observations": [observation_payload()]
        });
        if let Some(extra) = raw_extra {
            raw.as_object_mut()
                .expect("raw object")
                .extend(extra.as_object().expect("raw extra object").clone());
        }
        let error = finish_bundle_with_raw(
            &db,
            &run_id,
            &task_id,
            &attempt_id,
            closure,
            raw,
            output_digest,
            None,
        )
        .expect_err("companion forgery must roll back atomically");
        let expected = if case == "output-link" {
            "NEX_CHRONICLE_SYNTHESIS_CLOSURE_DIGEST_MISMATCH"
        } else {
            "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID"
        };
        assert!(error.to_string().contains(expected), "{case}: {error:#}");
        let (task_status, attempt_status, artifact_count): (String, String, i64) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT t.status, a.status,
                            (SELECT COUNT(*) FROM narrative_extraction_artifacts
                              WHERE run_id = ?1 AND task_id = ?2)
                       FROM narrative_extraction_tasks t
                       JOIN narrative_extraction_attempts a ON a.id = ?3
                      WHERE t.id = ?2 AND t.run_id = ?1",
                    rusqlite::params![run_id, task_id, attempt_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .expect("read companion rollback");
        assert_eq!(task_status, "running");
        assert_eq!(attempt_status, "running");
        assert_eq!(artifact_count, 0);
    }
}

#[test]
fn chronicle_synthesis_requires_native_raw_observation_digest() {
    let db = migrated_db();
    let run_id = "run-stage-raw-digest";
    let task_id = "task-stage-raw-digest";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let closure = valid_stage_closure(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
    );
    let error = finish_bundle_with_raw(
        &db,
        run_id,
        task_id,
        &attempt_id,
        closure,
        json!({
            "kind": "chronicle.raw-observations@1",
            "version": 1,
            "observations": [observation_payload()]
        }),
        None,
        Some(FORGED_DIGEST),
    )
    .expect_err("forged raw observation digest must roll back atomically");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_RAW_OBSERVATIONS_DIGEST_MISMATCH"),
        "unexpected raw digest error: {error:#}"
    );
    let (task_status, attempt_status, artifact_count, receipt_count): (String, String, i64, i64) =
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT t.status, a.status,
                        (SELECT COUNT(*) FROM narrative_extraction_artifacts
                          WHERE run_id = ?1 AND task_id = ?2),
                        (SELECT COUNT(*) FROM narrative_extraction_stage_receipts
                          WHERE run_id = ?1 AND task_id = ?2)
                   FROM narrative_extraction_tasks t
                   JOIN narrative_extraction_attempts a ON a.id = ?3
                  WHERE t.id = ?2 AND t.run_id = ?1",
                rusqlite::params![run_id, task_id, attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .expect("read raw digest rollback");
    assert_eq!(task_status, "running");
    assert_eq!(attempt_status, "running");
    assert_eq!(artifact_count, 0);
    assert_eq!(receipt_count, 0);
}

#[test]
fn typed_stage_bundle_requires_exactly_one_native_raw_artifact() {
    for case in ["extra-artifact", "missing-payload", "missing-digest"] {
        let db = migrated_db();
        let run_id = format!("run-stage-raw-shape-{case}");
        let task_id = format!("task-stage-raw-shape-{case}");
        create_run(&db, PROJECT_A, &run_id, &task_id);
        let attempt_id = claim_task(&db, PROJECT_A, &run_id);
        let closure = valid_stage_closure(
            PROJECT_A,
            &run_id,
            &task_id,
            &attempt_id,
            &context_set_digest(),
            &component_contract_digest(),
            &final_request_digest(),
        );
        let raw = raw_observations(&["observation:arrival"]);
        let mut raw_artifact = artifact(
            &format!("{task_id}-raw-observations"),
            "chronicle.raw-observations@1",
            raw,
        );
        let mut artifacts = vec![raw_artifact.clone()];
        let expected_code = match case {
            "extra-artifact" => {
                artifacts.push(artifact(
                    &format!("{task_id}-unexpected"),
                    "chronicle.unexpected@1",
                    json!({"unexpected": true}),
                ));
                "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID"
            }
            "missing-payload" => {
                raw_artifact.payload_json = None;
                artifacts = vec![raw_artifact];
                "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID"
            }
            "missing-digest" => {
                raw_artifact.payload_digest = None;
                artifacts = vec![raw_artifact];
                "NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID"
            }
            _ => unreachable!("known raw artifact case"),
        };
        let error = finish_bundle_with_artifacts(
            &db,
            &run_id,
            &task_id,
            &attempt_id,
            closure,
            1,
            json!(["observation:arrival"]),
            artifacts,
            None,
        )
        .expect_err("raw companion shape must fail closed");
        assert!(
            error.to_string().contains(expected_code),
            "{case}: unexpected error: {error:#}"
        );
        let (task_status, attempt_status, artifact_count, receipt_count): (
            String,
            String,
            i64,
            i64,
        ) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT t.status, a.status,
                            (SELECT COUNT(*) FROM narrative_extraction_artifacts
                              WHERE run_id = ?1 AND task_id = ?2),
                            (SELECT COUNT(*) FROM narrative_extraction_stage_receipts
                              WHERE run_id = ?1 AND task_id = ?2)
                       FROM narrative_extraction_tasks t
                       JOIN narrative_extraction_attempts a ON a.id = ?3
                      WHERE t.id = ?2 AND t.run_id = ?1",
                    rusqlite::params![run_id, task_id, attempt_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?)
            })
            .expect("read exact raw artifact rollback");
        assert_eq!(task_status, "running");
        assert_eq!(attempt_status, "running");
        assert_eq!(artifact_count, 0);
        assert_eq!(receipt_count, 0);
    }
}

#[test]
fn typed_stage_bundle_requires_observation_refs_exact_raw_local_id_set() {
    let db = migrated_db();
    let run_id = "run-stage-raw-cardinality";
    let task_id = "task-stage-raw-cardinality";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let closure = valid_stage_closure(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
    );
    let raw = raw_observations(&["observation:arrival", "observation:departure"]);
    let raw_artifact = artifact(
        &format!("{task_id}-raw-observations"),
        "chronicle.raw-observations@1",
        raw,
    );
    let error = finish_bundle_with_artifacts(
        &db,
        run_id,
        task_id,
        &attempt_id,
        closure.clone(),
        2,
        json!(["observation:arrival"]),
        vec![raw_artifact.clone()],
        None,
    )
    .expect_err("one observationRef cannot claim two raw observations");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID"),
        "unexpected cardinality error: {error:#}"
    );

    finish_bundle_with_artifacts(
        &db,
        run_id,
        task_id,
        &attempt_id,
        closure,
        2,
        json!(["observation:arrival", "observation:departure"]),
        vec![raw_artifact],
        None,
    )
    .expect("exact raw localId set must finish atomically");
    let artifact_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_artifacts
                  WHERE run_id = ?1 AND task_id = ?2",
                rusqlite::params![run_id, task_id],
                |row| row.get(0),
            )?)
        })
        .expect("read exact raw localId artifact");
    assert_eq!(artifact_count, 1);
}

#[test]
fn rejects_stage_closure_shape_and_digest_forgeries_atomically() {
    for mutation in [
        "missing-binding-field",
        "extra-receipt-field",
        "forged-binding-digest",
        "missing-receipt-digest",
    ] {
        let db = migrated_db();
        let run_id = format!("run-stage-shape-{mutation}");
        let task_id = format!("task-stage-shape-{mutation}");
        create_run(&db, PROJECT_A, &run_id, &task_id);
        let attempt_id = claim_task(&db, PROJECT_A, &run_id);
        let mut closure = valid_stage_closure(
            PROJECT_A,
            &run_id,
            &task_id,
            &attempt_id,
            &context_set_digest(),
            &component_contract_digest(),
            &final_request_digest(),
        );
        match mutation {
            "missing-binding-field" => {
                closure["receipts"][0]["modelExecutionBinding"]
                    .as_object_mut()
                    .expect("model binding")
                    .remove("provider");
            }
            "extra-receipt-field" => {
                closure["receipts"][0]["unexpectedField"] = json!(true);
            }
            "forged-binding-digest" => {
                closure["receipts"][0]["modelBindingDigest"] =
                    Value::String(FORGED_DIGEST.to_owned());
            }
            "missing-receipt-digest" => {
                closure["receipts"][0]
                    .as_object_mut()
                    .expect("receipt")
                    .remove("stageExecutionReceiptDigest");
            }
            _ => unreachable!(),
        }
        let error = match serde_json::from_value::<ChronicleStageProvenanceClosure>(closure.clone())
        {
            Ok(_) => finish_bundle(&db, &run_id, &task_id, &attempt_id, closure)
                .expect_err("malformed closure must fail closed"),
            Err(error) => anyhow::anyhow!("NEX_STAGE_TYPED_INGRESS: {error}"),
        };
        assert!(
            error.to_string().contains("NEX_STAGE_"),
            "unexpected {mutation} error: {error:#}"
        );
        let (task_status, attempt_status, artifact_count, receipt_count): (
            String,
            String,
            i64,
            i64,
        ) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT t.status, a.status,
                            (SELECT COUNT(*) FROM narrative_extraction_artifacts
                              WHERE run_id = ?1 AND task_id = ?2),
                            (SELECT COUNT(*) FROM narrative_extraction_stage_receipts
                              WHERE run_id = ?1)
                       FROM narrative_extraction_tasks t
                       JOIN narrative_extraction_attempts a ON a.id = ?3
                      WHERE t.id = ?2 AND t.run_id = ?1",
                    rusqlite::params![run_id, task_id, attempt_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?)
            })
            .expect("read atomic rollback state");
        assert_eq!(task_status, "running");
        assert_eq!(attempt_status, "running");
        assert_eq!(artifact_count, 0);
        assert_eq!(receipt_count, 0);
    }
}

#[test]
fn rejects_only_corrupt_closure_and_rolls_back_all_siblings() {
    let db = migrated_db();
    let run_id = "run-stage-corrupt";
    let task_id = "task-stage-corrupt";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let mut corrupt_closure = valid_stage_closure(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
    );
    // Only the typed ephemeral closure's internal digest is corrupted; the
    // durable raw-observation artifact remains valid and must roll back with
    // the task output and receipt/model-binding siblings.
    corrupt_closure["stageProvenanceClosureDigest"] =
        Value::String(digest(&json!({"corrupt": "closure-only"})));
    let error = finish_bundle(&db, run_id, task_id, &attempt_id, corrupt_closure)
        .expect_err("closure validation must fail closed");
    assert!(
        error.to_string().contains("closure") || error.to_string().contains("provenance"),
        "unexpected closure error: {error:#}"
    );

    let (task_status, attempt_status, task_output, attempt_output, artifact_count): (
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
    ) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT t.status, a.status, t.output_json, a.output_json,
                        (SELECT COUNT(*) FROM narrative_extraction_artifacts
                          WHERE run_id = ?1 AND task_id = ?2)
                   FROM narrative_extraction_tasks t
                   JOIN narrative_extraction_attempts a ON a.id = ?3
                  WHERE t.id = ?2 AND t.run_id = ?1",
                rusqlite::params![run_id, task_id, attempt_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?)
        })
        .expect("read rolled-back closure bundle");
    assert_eq!(task_status, "running");
    assert_eq!(attempt_status, "running");
    assert!(task_output.is_none());
    assert!(attempt_output.is_none());
    assert_eq!(
        artifact_count, 0,
        "raw artifact and closure must roll back together"
    );
}

#[test]
fn resolver_advance_preserves_observed_parent_token_without_c2b_promotion() {
    let db = migrated_db();
    let run_id = "run-stale-parent";
    let task_id = "task-stale-parent";
    let old_token = scene_revision_token(&db, PROJECT_A);
    let parent = seed_v2_parent(
        &db,
        PROJECT_A,
        run_id,
        task_id,
        "proposal-stale-parent",
        "revision-stale-parent",
        &old_token,
    );
    let (before, after) = advance_scene_source(&db, PROJECT_A);
    assert_eq!(before, old_token);
    assert_ne!(before, after, "resolver-backed source must advance");
    let (observed_token, current_revision, child_edges): (String, String, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT b.revision_token, p.current_revision_id,
                        (SELECT COUNT(*) FROM narrative_dependency_edges
                          WHERE consumer_kind = 'proposal-revision'
                            AND consumer_key = 'revision-stale-parent')
                   FROM narrative_revision_source_basis b
                   JOIN narrative_proposals p ON p.id = 'proposal-stale-parent'
                  WHERE b.revision_id = 'revision-stale-parent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read stale parent token and current identity");
    assert_eq!(observed_token, parent["observedSourceRevisionToken"]);
    assert_eq!(current_revision, "revision-stale-parent");
    assert_eq!(
        child_edges, 0,
        "C2A must not own child Consumer declaration"
    );
}

#[test]
fn zero_edge_parent_remains_dormant_until_c2b_child_declaration() {
    let db = migrated_db();
    let parent = seed_v2_parent(
        &db,
        PROJECT_A,
        "run-zero-edge",
        "task-zero-edge",
        "proposal-zero-edge",
        "revision-zero-edge",
        &scene_revision_token(&db, PROJECT_A),
    );
    let (edge_count, current_revision): (i64, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM narrative_dependency_edges
                      WHERE consumer_kind = 'proposal-revision'
                        AND consumer_key = 'revision-zero-edge'),
                    current_revision_id
                   FROM narrative_proposals WHERE id = 'proposal-zero-edge'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read zero-edge parent");
    assert_eq!(edge_count, 0);
    assert_eq!(current_revision, parent["revisionId"]);
}

#[test]
fn v2_to_v1_downgrade_and_legacy_inheritance_have_stable_boundaries() {
    // No-envelope append from a V2 current must be rejected with the typed
    // monotonicity code, not accepted as a legacy child.
    let db = migrated_db();
    let parent = seed_v2_parent(
        &db,
        PROJECT_A,
        "run-monotonic-none",
        "task-monotonic-none",
        "proposal-monotonic-none",
        "revision-monotonic-none-parent",
        &scene_revision_token(&db, PROJECT_A),
    );
    let append_error = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-monotonic-none".to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: "proposal-monotonic-none".to_owned(),
            payload_json: proposal_payload("Legacy downgrade", false),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: parent["revisionId"].as_str().unwrap().to_owned(),
            created_by: Some("legacy-client".to_owned()),
        },
    )
    .expect_err("V2 to legacy-unbound append must be rejected");
    assert!(append_error
        .to_string()
        .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"));

    // A real, live-token-bound V1 envelope is also forbidden from a V2
    // current. This is distinct from the no-envelope case above: the frozen
    // V1 validator can otherwise accept this request and create a downgrade.
    let db = migrated_db();
    let parent = seed_v2_parent(
        &db,
        PROJECT_A,
        "run-monotonic-v1",
        "task-monotonic-v1",
        "proposal-monotonic-v1",
        "revision-monotonic-v1-parent",
        &scene_revision_token(&db, PROJECT_A),
    );
    let v1_error = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-monotonic-v1".to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: "proposal-monotonic-v1".to_owned(),
            payload_json: proposal_payload("V1 downgrade", false),
            reconciliation_envelope: Some(envelope_v1(
                &db,
                PROJECT_A,
                "run-monotonic-v1",
                "task-monotonic-v1",
            )),
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: parent["revisionId"].as_str().unwrap().to_owned(),
            created_by: Some("legacy-v1-client".to_owned()),
        },
    )
    .expect_err("V2 current must reject a real V1-envelope child");
    assert!(v1_error
        .to_string()
        .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"));

    // The legacy `inheritReconciliationEnvelope` request is itself a
    // forbidden V2 transition, even when its expected parent digest matches.
    let db = migrated_db();
    let parent = seed_v2_parent(
        &db,
        PROJECT_A,
        "run-monotonic-inherit",
        "task-monotonic-inherit",
        "proposal-monotonic-inherit",
        "revision-monotonic-inherit-parent",
        &scene_revision_token(&db, PROJECT_A),
    );
    let inherit_error = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-monotonic-inherit".to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: "proposal-monotonic-inherit".to_owned(),
            payload_json: proposal_payload("Legacy inheritance", false),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: Some(
                narrative_extraction::ReconciliationEnvelopeInheritance {
                    parent_revision_id: parent["revisionId"].as_str().unwrap().to_owned(),
                    expected_envelope_digest: parent["envelopeDigest"].as_str().unwrap().to_owned(),
                },
            ),
            expected_current_revision_id: parent["revisionId"].as_str().unwrap().to_owned(),
            created_by: Some("legacy-inherit-client".to_owned()),
        },
    )
    .expect_err("V2 current must reject legacy envelope inheritance");
    assert!(inherit_error
        .to_string()
        .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"));

    // A legacy current cannot be upgraded by pretending to inherit an
    // envelope; the boundary error is distinct and stable.
    let db = migrated_db();
    create_run(&db, PROJECT_A, "run-legacy-inherit", "task-legacy-inherit");
    let legacy = save_legacy_root(
        &db,
        PROJECT_A,
        "run-legacy-inherit",
        "task-legacy-inherit",
        "proposal-legacy-inherit",
    );
    let legacy_error = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-legacy-inherit".to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: "proposal-legacy-inherit".to_owned(),
            payload_json: proposal_payload("Inherited legacy", false),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: Some(
                narrative_extraction::ReconciliationEnvelopeInheritance {
                    parent_revision_id: legacy["revisionId"].as_str().unwrap().to_owned(),
                    expected_envelope_digest: digest(&json!({"legacy": true})),
                },
            ),
            expected_current_revision_id: legacy["revisionId"].as_str().unwrap().to_owned(),
            created_by: Some("legacy-client".to_owned()),
        },
    )
    .expect_err("legacy current must not accept explicit envelope inheritance");
    assert!(legacy_error
        .to_string()
        .contains("NEX_REVISION_ENVELOPE_INHERIT_UNAVAILABLE"));

    // Direct SQL cannot bypass the same monotonicity rule once C2A adds its
    // trigger; the frozen base currently accepts this insert (RED).
    let db = migrated_db();
    let parent = seed_v2_parent(
        &db,
        PROJECT_A,
        "run-monotonic-sql",
        "task-monotonic-sql",
        "proposal-monotonic-sql",
        "revision-monotonic-sql-parent",
        &scene_revision_token(&db, PROJECT_A),
    );
    let sql_error = db
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, origin_kind,
                     created_at, created_by)
                 VALUES ('revision-monotonic-sql-child', 'proposal-monotonic-sql', 2, '{}',
                         'legacy-unbound', datetime('now'), 'sql-test')",
                [],
            )?;
            Ok(())
        })
        .expect_err("SQL downgrade insert must be blocked by the C2A trigger");
    assert!(sql_error
        .to_string()
        .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"));
    assert_eq!(parent["revisionId"], "revision-monotonic-sql-parent");
}

#[test]
fn direct_sql_v2_current_rejects_missing_or_null_schema_version_in_enveloped_children() {
    for (case, envelope_json) in [
        ("missing-schema-version", "{}"),
        ("null-schema-version", r#"{"schemaVersion":null}"#),
    ] {
        let db = migrated_db();
        let run_id = format!("run-monotonic-sql-{case}");
        let task_id = format!("task-monotonic-sql-{case}");
        let proposal_id = format!("proposal-monotonic-sql-{case}");
        let child_id = format!("revision-monotonic-sql-{case}-child");
        let parent = seed_v2_parent(
            &db,
            PROJECT_A,
            &run_id,
            &task_id,
            &proposal_id,
            &format!("revision-monotonic-sql-{case}-parent"),
            &scene_revision_token(&db, PROJECT_A),
        );

        let sql_error = db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_proposal_revisions
                        (id, proposal_id, revision_number, payload_json, origin_kind,
                         reconciliation_envelope_json, created_at, created_by)
                     VALUES (?1, ?2, 2, '{}', 'enveloped', ?3, datetime('now'), 'sql-test')",
                    rusqlite::params![child_id, proposal_id, envelope_json],
                )?;
                Ok(())
            })
            .expect_err("an enveloped child without schemaVersion 2 must be blocked");
        assert!(
            sql_error
                .to_string()
                .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"),
            "{case}: unexpected SQL error: {sql_error:#}"
        );

        let (current_revision, revision_count, child_count): (String, i64, i64) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT current_revision_id,
                            (SELECT COUNT(*) FROM narrative_proposal_revisions
                              WHERE proposal_id = ?1),
                            (SELECT COUNT(*) FROM narrative_proposal_revisions
                              WHERE id = ?2)
                       FROM narrative_proposals WHERE id = ?1",
                    rusqlite::params![proposal_id, child_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .expect("read failed monotonic child state");
        assert_eq!(
            current_revision, parent["revisionId"],
            "{case}: current revision pointer changed"
        );
        assert_eq!(revision_count, 1, "{case}: child revision persisted");
        assert_eq!(child_count, 0, "{case}: rejected child persisted");
    }
}

#[test]
fn direct_sql_v2_current_accepts_integer_valued_schema_version_2_0_at_monotonic_boundary() {
    let db = migrated_db();
    let run_id = "run-monotonic-sql-numeric-boundary";
    let task_id = "task-monotonic-sql-numeric-boundary";
    let proposal_id = "proposal-monotonic-sql-numeric-boundary";
    let parent = seed_v2_parent(
        &db,
        PROJECT_A,
        run_id,
        task_id,
        proposal_id,
        "revision-monotonic-sql-numeric-boundary-parent",
        &scene_revision_token(&db, PROJECT_A),
    );

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_proposal_revisions
                (id, proposal_id, revision_number, payload_json, origin_kind,
                 reconciliation_envelope_json, created_at, created_by)
             VALUES ('revision-monotonic-sql-numeric-boundary-child', ?1, 2, '{}',
                     'enveloped', '{\"schemaVersion\":2.0}', datetime('now'), 'sql-test')",
            rusqlite::params![proposal_id],
        )?;
        Ok(())
    })
    .unwrap_or_else(|error| {
        panic!("the monotonic trigger must not reject SQLite's integer-valued 2.0 boundary; this test does not assert full envelope validity: {error:#}")
    });

    let (current_revision, child_count): (String, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT current_revision_id,
                        (SELECT COUNT(*) FROM narrative_proposal_revisions
                          WHERE id = 'revision-monotonic-sql-numeric-boundary-child')
                   FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read numeric boundary state");
    assert_eq!(current_revision, parent["revisionId"]);
    assert_eq!(child_count, 1);
}

#[test]
fn direct_sql_v2_pointer_repoint_to_non_v2_revision_is_rejected() {
    // A V2 current revision must stay V2: repointing the proposal's
    // current_revision_id at a legacy revision (or clearing it) is the one
    // remaining downgrade vector after the INSERT guard and the revision
    // immutability triggers, and it must be blocked at the DB layer.
    let db = migrated_db();
    let parent = seed_v2_parent(
        &db,
        PROJECT_A,
        "run-pointer-guard",
        "task-pointer-guard",
        "proposal-pointer-guard",
        "revision-pointer-guard-parent",
        &scene_revision_token(&db, PROJECT_A),
    );
    create_run(&db, PROJECT_A, "run-pointer-legacy", "task-pointer-legacy");
    let legacy = save_legacy_root(
        &db,
        PROJECT_A,
        "run-pointer-legacy",
        "task-pointer-legacy",
        "proposal-pointer-legacy",
    );

    // Repoint V2 -> legacy revision: rejected.
    let repoint_error = db
        .with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposals SET current_revision_id = ?1
                  WHERE id = 'proposal-pointer-guard'",
                rusqlite::params![legacy["revisionId"].as_str().unwrap()],
            )?;
            Ok(())
        })
        .expect_err("repointing a V2 proposal at a legacy revision must be blocked");
    assert!(repoint_error
        .to_string()
        .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"));

    // Clearing the pointer from a V2 current is the same downgrade.
    let clear_error = db
        .with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposals SET current_revision_id = NULL
                  WHERE id = 'proposal-pointer-guard'",
                [],
            )?;
            Ok(())
        })
        .expect_err("clearing a V2 proposal's current revision must be blocked");
    assert!(clear_error
        .to_string()
        .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"));

    let current_revision: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT current_revision_id FROM narrative_proposals
                  WHERE id = 'proposal-pointer-guard'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("read guarded pointer");
    assert_eq!(current_revision, parent["revisionId"]);

    // A legacy proposal's pointer stays freely movable between legacy
    // revisions: the guard fires only on a V2 -> non-V2 transition.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_proposals SET current_revision_id = ?1
              WHERE id = 'proposal-pointer-legacy'",
            rusqlite::params![legacy["revisionId"].as_str().unwrap()],
        )?;
        Ok(())
    })
    .expect("legacy pointer update must not be blocked");
}

#[test]
fn production_dag_synthesis_task_receipt_finishes_the_plan_proposals_bundle() {
    // The production coordinator runs AI synthesis under its own
    // `chronicle.synthesize-event@1` task and stamps that task/attempt into
    // the stage execution; the later `chronicle.plan-proposals@1` finish
    // owner assembles proposals deterministically. An honest receipt from
    // that topology must be accepted without rewriting history.
    let db = migrated_db();
    let run_id = "run-stage-production-topology";
    let task_id = "task-stage-production-topology";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    seed_stage_task_attempt(
        &db,
        run_id,
        "task:synthesize-production",
        "attempt:synthesize-production",
        "chronicle.synthesize-event@1",
    );

    let observation_receipt = stage_receipt(
        PROJECT_A,
        run_id,
        "task:observation",
        "attempt:observation",
        OBSERVATION_STAGE_ID,
        "stage:observation",
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
        &json!({"observations": [observation_payload()]}),
    );
    let synthesis_receipt = stage_receipt(
        PROJECT_A,
        run_id,
        "task:synthesize-production",
        "attempt:synthesize-production",
        EVENT_SYNTHESIS_STAGE_ID,
        "stage:event-synthesis",
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
        &json!({"proposal": proposal_payload("Arrival", false)}),
    );
    let closure = closure_for_receipts(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        json!([synthesis_receipt, observation_receipt]),
    );

    finish_bundle(&db, run_id, task_id, &attempt_id, closure)
        .expect("an honest production-topology receipt must finish the bundle");
    let receipt_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_stage_receipts WHERE run_id = ?1",
                [run_id],
                |row| row.get(0),
            )?)
        })
        .expect("count persisted receipts");
    assert_eq!(receipt_count, 2);
}

#[test]
fn c2a_stays_dormant_and_chronicle_v2_activation_is_disabled() {
    let activation = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../policies/narrative/narrative-ir-contract.json"
    ));
    assert!(activation.contains("\"state\": \"disabled\""));
    assert!(activation.contains("\"productionEntryPoints\": []"));
    assert!(activation.contains("\"v2Emission\": \"blocked-until-c2b\""));
    assert!(activation.contains("\"humanDerivedV2Ui\": \"blocked-until-c2b\""));
    assert!(activation.contains("\"currentRevisionPromotion\": \"blocked-until-c2b\""));
    assert!(activation.contains("\"productionFallback\": \"existing-v1-path\""));
}
