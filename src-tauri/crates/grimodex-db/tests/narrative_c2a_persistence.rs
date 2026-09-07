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
    ChronicleStageProvenanceClosure, CreateHumanDerivedRevisionRequest, CreateRunPayload,
    CreateTaskSeed, FinishTaskPayload, NarrativeAdapterIdentity, ProposalSeed,
    SaveProposalSetPayload,
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
const PARSED_OUTPUT_DIGEST_DOMAIN: &str = "chronicle.parsed-output/1";

fn digest(value: &Value) -> String {
    canonical_json_digest(value).expect("canonical digest")
}

fn canonical(value: &Value) -> String {
    canonical_json_string(value).expect("canonical JSON")
}

fn raw_sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

#[cfg(feature = "nir1-material-diagnostics")]
mod material_roster_diagnostics {
    use super::*;
    use grimodex_db::narrative_extraction::material_roster::{
        inspect_material_roster, RosterStatus,
    };
    use rusqlite::{Connection, OpenFlags};

    fn persisted_fixture() -> (std::path::PathBuf, String) {
        let db = migrated_db();
        let run = "roster-run";
        let task = "roster-task";
        create_run(&db, PROJECT_A, run, task);
        let refs = seal_stage_receipts_for_v2(&db, run, task);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                 (id, project_id, epoch_number, reason, created_at)
                 VALUES ('roster-epoch', ?1, 0, 'initial', '2026-08-25T00:00:00.000Z')",
                [PROJECT_A],
            )?;
            Ok(())
        })
        .expect("epoch");
        let saved = narrative_extraction::narrative_extraction_save_proposal_set(
            &db,
            SaveProposalSetPayload {
                run_id: run.into(),
                project_id: PROJECT_A.into(),
                proposal_set_id: Some("roster-set".into()),
                set_kind: "chronicle.extract.review@1".into(),
                summary_json: Some(json!({"chronicleStageReceiptRefs": refs})),
                proposals: vec![ProposalSeed {
                    proposal_id: Some("roster-proposal".into()),
                    proposal_key: "event:roster".into(),
                    kind: PROPOSAL_KIND.into(),
                    payload_json: proposal_payload("Arrival", false),
                    reconciliation_envelope: Some(envelope_v2(
                        &db, PROJECT_A, run, task, "Arrival",
                    )),
                }],
            },
        )
        .expect("save through Native production persistence");
        let revision = saved["proposals"][0]["revisionId"]
            .as_str()
            .expect("revision")
            .to_owned();
        let path =
            std::env::temp_dir().join(format!("nir1-roster-{}.sqlite", uuid::Uuid::new_v4()));
        db.with_conn(|conn| {
            conn.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])?;
            Ok(())
        })
        .expect("isolated durable copy");
        drop(db);
        (path, revision)
    }

    #[test]
    fn material_roster_reopens_valid_native_rows_without_claiming_membership() {
        let (path, revision) = persisted_fixture();
        let before = std::fs::read(&path).expect("before bytes");
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read only");
        let report = inspect_material_roster(&conn, PROJECT_A, &revision).expect("diagnose");
        assert_eq!(report.status, RosterStatus::Incomplete);
        assert!(!report.verified_receipts.is_empty());
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "snapshot-binding-missing"));
        assert!(
            report.materials.is_empty(),
            "partial receipts are not material authority"
        );
        drop(conn);
        assert_eq!(before, std::fs::read(&path).expect("after bytes"));
        std::fs::remove_file(path).expect("remove isolated fixture");
    }

    #[test]
    fn material_roster_missing_required_receipt_is_not_smaller_complete_roster() {
        let (path, revision) = persisted_fixture();
        let conn = Connection::open(&path).expect("negative copy");
        conn.execute("DELETE FROM narrative_extraction_stage_receipts", [])
            .expect("remove required receipts");
        let report = inspect_material_roster(&conn, PROJECT_A, &revision).expect("diagnose");
        assert_eq!(report.status, RosterStatus::Inconsistent);
        assert!(report.materials.is_empty());
        drop(conn);
        std::fs::remove_file(path).expect("remove isolated fixture");
    }

    #[test]
    fn material_roster_corrupt_receipt_and_foreign_project_are_distinct() {
        let (path, revision) = persisted_fixture();
        let conn = Connection::open(&path).expect("negative copy");
        let foreign = inspect_material_roster(&conn, PROJECT_B, &revision).expect("foreign");
        assert_eq!(foreign.status, RosterStatus::Incomplete);
        assert!(foreign.verified_receipts.is_empty());
        assert_eq!(foreign.issues[0].code, "revision-not-found");
        conn.execute(
            "UPDATE narrative_extraction_stage_receipts SET receipt_digest = ?1",
            [FORGED_DIGEST],
        )
        .expect("tamper well-formed receipt digest");
        let corrupt = inspect_material_roster(&conn, PROJECT_A, &revision).expect("corrupt");
        assert_eq!(corrupt.status, RosterStatus::Inconsistent);
        assert!(corrupt.materials.is_empty());
        drop(conn);
        std::fs::remove_file(path).expect("remove isolated fixture");
    }
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
    create_run_with_task_kind(
        db,
        project_id,
        run_id,
        task_id,
        "chronicle.plan-proposals@1",
    );
}

fn create_run_with_task_kind(
    db: &Database,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    task_kind: &str,
) {
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
                task_kind: task_kind.to_owned(),
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

fn scope(project_id: &str) -> Value {
    let scene_ref = match project_id {
        PROJECT_A => "scene:scene-1",
        PROJECT_B => "scene:scene-2",
        other => panic!("unknown fixture project {other}"),
    };
    json!({
        "schemaVersion": 2,
        "registryVersion": "narrative-scope/2",
        "timeline": {"kind": "any"},
        "worldline": {"kind": "any"},
        "scene": {"kind": "exact", "ref": scene_ref},
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

fn evidence_set(project_id: &str, revision_token: &str) -> Value {
    let quote_digest = raw_sha256_digest(b"Arrival.");
    assert_eq!(quote_digest, ARRIVAL_QUOTE_DIGEST);
    json!([{
        "evidenceRef": "anchor:arrival",
        "documentRef": "document:1",
        "quote": "Arrival.",
        "quoteDigest": quote_digest,
        "sourceKey": scene_source_key(project_id),
        "revisionToken": revision_token
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

fn dependency_set(project_id: &str) -> Value {
    json!([
        {
            "dependencyId": "dependency:evidence",
            "inputRef": scene_source_key(project_id),
            "contextIds": ["context:event-synthesis"],
            "role": "direct-evidence",
            "selector": {"kind": "whole-source"}
        },
        {
            "dependencyId": "dependency:context-source",
            "inputRef": "source:scene:1",
            "contextIds": ["context:event-synthesis"],
            "role": "opaque-model-context",
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
    let scope_value = scope(project_id);
    let revision_token = scene_revision_token(db, project_id);
    let source = source_basis(project_id, &revision_token);
    let evidence = evidence_set(project_id, &revision_token);
    let dependencies = dependency_set(project_id);
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

/// Persist the same typed C1 receipts that a V2 ProposalSet must reference.
/// The ProposalSet tests intentionally use this durable roster rather than a
/// transport closure so they exercise the post-terminalization verification
/// boundary.
fn seal_stage_receipts_for_v2(db: &Database, run_id: &str, task_id: &str) -> Value {
    let attempt_id = claim_task(db, PROJECT_A, run_id);
    let closure = valid_stage_closure(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
    );
    finish_bundle(db, run_id, task_id, &attempt_id, closure.clone())
        .expect("persist verified C1 stage receipts for V2 ProposalSet");
    closure["receiptRefs"].clone()
}

/// Minimal completed `source.snapshot@1` corpus for the C2B continuation in
/// this integration fixture.  The reveal target intentionally differs from
/// the event's ordinary document identifiers, so the Human writer must use
/// the sealed corpus binding rather than a live/current Scene shortcut.
fn seal_reveal_snapshot_for_c2b(db: &Database, run_id: &str) {
    const CREATED_AT: &str = "2026-08-25T00:00:00.000Z";
    let projection = json!({
        "schemaVersion": 1,
        "unit": "utf16",
        "canonicalLength": 0,
        "segments": [],
    });
    let source_key = scene_source_key(PROJECT_A);
    let origin = json!({
        "kind": "project-node",
        "projectId": PROJECT_A,
        "nodeId": SCENE_ID,
        "sourceVersion": 0,
        "sourceUpdatedAt": CREATED_AT,
        "sourceUri": null,
    });
    let content_digest = digest(&json!({
        "normalizerVersion": "gdx-canonical-text/1",
        "text": "",
    }));
    let document_digest = digest(&json!({
        "normalizerVersion": "gdx-canonical-text/1",
        "parentSourceKey": null,
        "title": "Reveal document",
        "orderIndex": 0,
        "canonical": {"text": "", "blocks": []},
    }));
    let artifact_digest = digest(&json!({
        "schemaVersion": 1,
        "normalizerVersion": "gdx-canonical-text/1",
        "sourceKey": source_key,
        "parentSourceKey": null,
        "semanticDigest": document_digest,
        "contentDigest": content_digest,
        "projection": projection,
        "origin": origin,
    }));
    let document = json!({
        "ref": "D000001",
        "sourceKey": source_key,
        "parentRef": null,
        "title": "Reveal document",
        "orderIndex": 0,
        "canonical": {
            "unit": "utf16",
            "text": "",
            "blocks": [],
            "projection": projection,
            "projectionMap": projection,
            "diagnostics": [],
        },
        "contentDigest": content_digest,
        "documentDigest": document_digest,
        "artifactDigest": artifact_digest,
        "origin": origin,
    });
    let snapshot_digest = digest(&json!({
        "schemaVersion": 1,
        "language": "ja",
        "normalizerVersion": "gdx-canonical-text/1",
        "documentDigests": [document["documentDigest"]],
        "omissions": [],
    }));
    let snapshot_artifact_digest = digest(&json!({
        "schemaVersion": 1,
        "normalizerVersion": "gdx-canonical-text/1",
        "semanticDigest": snapshot_digest,
        "originProjectId": PROJECT_A,
        "documents": [{
            "sourceKey": document["sourceKey"],
            "artifactDigest": document["artifactDigest"],
        }],
        "omissions": [],
    }));
    let payload = json!({
        "snapshot": {
            "schemaVersion": 1,
            "id": format!("snapshot:{run_id}"),
            "snapshotId": format!("snapshot:{run_id}"),
            "createdAt": CREATED_AT,
            "language": "ja",
            "normalizerVersion": "gdx-canonical-text/1",
            "origin": {"kind": "grimodex-project", "projectId": PROJECT_A},
            "documents": [document],
            "omissions": [],
            "digest": snapshot_digest,
            "artifactDigest": snapshot_artifact_digest,
        },
        "sourceViews": [],
        "scopeAuthorityDocuments": [{
            "documentRef": "D000001",
            "sourceKey": scene_source_key(PROJECT_A),
            "rawStoryKey": null,
        }],
    });
    let payload_json = canonical(&payload);
    let payload_digest = digest(&payload);
    let snapshot_task_id = format!("task:snapshot:{run_id}");
    let snapshot_attempt_id = format!("attempt:snapshot:{run_id}");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, attempt_count, created_at, completed_at)
             VALUES (?1, ?2, 'source.snapshot@1', 'completed', 1, ?3, ?3)",
            rusqlite::params![snapshot_task_id, run_id, CREATED_AT],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at, completed_at, output_json)
             VALUES (?1, ?2, 1, 'completed', ?3, ?3, '{}')",
            rusqlite::params![snapshot_attempt_id, snapshot_task_id, CREATED_AT],
        )?;
        conn.execute(
            "UPDATE narrative_extraction_runs SET snapshot_digest = ?1 WHERE id = ?2",
            rusqlite::params![snapshot_digest, run_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_artifacts
                (id, run_id, task_id, attempt_id, artifact_kind, payload_storage,
                 payload_json, payload_ref, payload_digest, created_at)
             VALUES (?1, ?2, ?3, ?4, 'source.snapshot@1', 'inline-json',
                     ?5, NULL, ?6, ?7)",
            rusqlite::params![
                format!("artifact:snapshot:{run_id}"),
                run_id,
                snapshot_task_id,
                snapshot_attempt_id,
                payload_json,
                payload_digest,
                CREATED_AT,
            ],
        )?;
        Ok(())
    })
    .expect("seed sealed reveal snapshot for C2B");
}

#[test]
fn public_v2_save_is_atomic_and_does_not_break_v1_fallback() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-public-v2-save', ?1, 0, 'initial',
                     '2026-08-25T00:00:00.000Z')",
            [PROJECT_A],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed the current Semantic Epoch for the public V2 save");
    let run_id = "run-public-v2-save";
    let task_id = "task-public-v2-save";
    create_run(&db, PROJECT_A, run_id, task_id);
    let stage_receipt_refs = seal_stage_receipts_for_v2(&db, run_id, task_id);
    let invalid_second_envelope = envelope_v2(&db, PROJECT_A, run_id, task_id, "Arrival");
    let error = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_set_id: Some("set-public-v2-save".to_owned()),
            set_kind: "chronicle.extract.review@1".to_owned(),
            summary_json: Some(json!({
                "chronicleStageReceiptRefs": stage_receipt_refs.clone()
            })),
            proposals: vec![
                ProposalSeed {
                    proposal_id: Some("proposal-public-v2-save".to_owned()),
                    proposal_key: "event:arrival:public-v2-save".to_owned(),
                    kind: PROPOSAL_KIND.to_owned(),
                    payload_json: proposal_payload("Arrival", false),
                    reconciliation_envelope: Some(envelope_v2(
                        &db, PROJECT_A, run_id, task_id, "Arrival",
                    )),
                },
                ProposalSeed {
                    proposal_id: Some("proposal-public-v2-save-invalid".to_owned()),
                    proposal_key: "event:arrival:public-v2-save-invalid".to_owned(),
                    kind: PROPOSAL_KIND.to_owned(),
                    payload_json: proposal_payload("Departure", false),
                    reconciliation_envelope: Some(invalid_second_envelope),
                },
            ],
        },
    )
    .expect_err("invalid V2 ProposalSet must roll back atomically");
    assert!(
        error.to_string().contains("NEX_ENVELOPE_DIGEST_MISMATCH"),
        "unexpected error: {error:#}"
    );
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

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_set_id: Some("set-public-v2-save-valid".to_owned()),
            set_kind: "chronicle.extract.review@1".to_owned(),
            summary_json: Some(json!({
                "chronicleStageReceiptRefs": stage_receipt_refs
            })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-public-v2-save-valid".to_owned()),
                proposal_key: "event:arrival:public-v2-save-valid".to_owned(),
                kind: PROPOSAL_KIND.to_owned(),
                payload_json: proposal_payload("Arrival", false),
                reconciliation_envelope: Some(envelope_v2(
                    &db, PROJECT_A, run_id, task_id, "Arrival",
                )),
            }],
        },
    )
    .expect("activated public V2 save");
    assert_eq!(saved["proposals"][0]["originKind"], "enveloped");
    assert_eq!(
        saved["proposals"][0]["reconciliationEnvelopeSchemaVersion"],
        2
    );
    assert_eq!(saved["proposals"][0]["status"], "unreviewed");
    let (d1_count, freshness_count): (i64, i64) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_dependency_declaration_heads
                      WHERE project_id = ?1
                        AND consumer_kind = 'proposal-revision'
                        AND consumer_key = (
                            SELECT current_revision_id FROM narrative_proposals
                             WHERE id = 'proposal-public-v2-save-valid'
                        )",
                    [PROJECT_A],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_consumer_freshness
                      WHERE project_id = ?1
                        AND consumer_kind = 'proposal-revision'
                        AND consumer_key = (
                            SELECT current_revision_id FROM narrative_proposals
                             WHERE id = 'proposal-public-v2-save-valid'
                        )",
                    [PROJECT_A],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read initial V2 child authorities");
    assert_eq!(d1_count, 1, "initial V2 save must publish a D1 head");
    assert_eq!(
        freshness_count, 1,
        "initial V2 save must publish current-Epoch Freshness"
    );

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
fn v2_proposal_set_rejects_an_absent_or_ephemeral_stage_provenance_proof() {
    let db = migrated_db();
    let run_id = "run-v2-missing-stage-proof";
    let task_id = "task-v2-missing-stage-proof";
    create_run(&db, PROJECT_A, run_id, task_id);
    let missing_error = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_set_id: Some("set-v2-absent-stage-proof".to_owned()),
            set_kind: "chronicle.extract.review@1".to_owned(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-v2-absent-stage-proof".to_owned()),
                proposal_key: "event:arrival:absent-stage-proof".to_owned(),
                kind: PROPOSAL_KIND.to_owned(),
                payload_json: proposal_payload("Arrival", false),
                reconciliation_envelope: Some(envelope_v2(
                    &db, PROJECT_A, run_id, task_id, "Arrival",
                )),
            }],
        },
    )
    .expect_err("V2 ProposalSet must require already-persisted stage receipt refs");
    assert!(
        missing_error
            .to_string()
            .contains("NEX_CHRONICLE_STAGE_PROVENANCE_REQUIRED"),
        "unexpected missing provenance proof error: {missing_error:#}"
    );
    let error = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_set_id: Some("set-v2-missing-stage-proof".to_owned()),
            set_kind: "chronicle.extract.review@1".to_owned(),
            summary_json: Some(json!({
                "stageProvenanceBundle": {"forged": true}
            })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-v2-missing-stage-proof".to_owned()),
                proposal_key: "event:arrival:missing-stage-proof".to_owned(),
                kind: PROPOSAL_KIND.to_owned(),
                payload_json: proposal_payload("Arrival", false),
                reconciliation_envelope: Some(envelope_v2(
                    &db, PROJECT_A, run_id, task_id, "Arrival",
                )),
            }],
        },
    )
    .expect_err("ProposalSet must not persist a transport-only Chronicle closure");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_STAGE_CLOSURE_EPHEMERAL"),
        "unexpected provenance proof error: {error:#}"
    );
    for (set_id, proposal_id, proposal_key, summary_json) in [
        (
            "set-v2-nested-stage-closure",
            "proposal-v2-nested-stage-closure",
            "event:arrival:nested-stage-closure",
            json!({
                "ordinaryMetadata": {
                    "nested": {
                        "kind": CLOSURE_KIND,
                        "version": 1,
                        "receipts": [],
                        "receiptRefs": []
                    }
                }
            }),
        ),
        (
            "set-v2-nested-c1-bundle",
            "proposal-v2-nested-c1-bundle",
            "event:arrival:nested-c1-bundle",
            json!({
                "ordinaryMetadata": {
                    "nested": {
                        "projectId": PROJECT_A,
                        "runId": run_id,
                        "taskId": task_id,
                        "attemptId": "attempt:forged",
                        "stageExecutionOwnerTaskId": task_id,
                        "stageExecutionOwnerAttemptId": "attempt:forged",
                        "stageExecutionOwnerStageExecutionId": "stage:forged",
                        "contextSetDigest": FORGED_DIGEST,
                        "componentContractDigest": FORGED_DIGEST,
                        "finalRequestDigest": FORGED_DIGEST,
                        "stageProvenanceClosureDigest": FORGED_DIGEST,
                        "closure": {"not": "a closure"}
                    }
                }
            }),
        ),
    ] {
        let error = narrative_extraction::narrative_extraction_save_proposal_set(
            &db,
            SaveProposalSetPayload {
                run_id: run_id.to_owned(),
                project_id: PROJECT_A.to_owned(),
                proposal_set_id: Some(set_id.to_owned()),
                set_kind: "chronicle.extract.review@1".to_owned(),
                summary_json: Some(summary_json),
                proposals: vec![ProposalSeed {
                    proposal_id: Some(proposal_id.to_owned()),
                    proposal_key: proposal_key.to_owned(),
                    kind: PROPOSAL_KIND.to_owned(),
                    payload_json: proposal_payload("Arrival", false),
                    reconciliation_envelope: Some(envelope_v2(
                        &db, PROJECT_A, run_id, task_id, "Arrival",
                    )),
                }],
            },
        )
        .expect_err("nested C1 transport proof must not be persisted in a ProposalSet summary");
        assert!(
            error
                .to_string()
                .contains("NEX_CHRONICLE_STAGE_CLOSURE_EPHEMERAL"),
            "unexpected nested provenance proof error: {error:#}"
        );
    }
    let set_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_sets WHERE run_id = ?1",
                [run_id],
                |row| row.get(0),
            )?)
        })
        .expect("read rejected ProposalSet");
    assert_eq!(set_count, 0);
}

#[test]
fn public_v2_save_root_enters_the_human_c2b_scope_override_route() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-public-v2-c2b', ?1, 0, 'initial',
                     '2026-08-25T00:00:00.000Z')",
            [PROJECT_A],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed the current Semantic Epoch for the public V2 to C2B route");
    let run_id = "run-public-v2-c2b";
    let task_id = "task-public-v2-c2b";
    let proposal_id = "proposal-public-v2-c2b";
    create_run(&db, PROJECT_A, run_id, task_id);
    seal_reveal_snapshot_for_c2b(&db, run_id);
    let stage_receipt_refs = seal_stage_receipts_for_v2(&db, run_id, task_id);

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_set_id: Some("set-public-v2-c2b".to_owned()),
            set_kind: "chronicle.extract.review@1".to_owned(),
            summary_json: Some(json!({
                "chronicleStageReceiptRefs": stage_receipt_refs
            })),
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_owned()),
                proposal_key: "event:arrival:public-v2-c2b".to_owned(),
                kind: PROPOSAL_KIND.to_owned(),
                payload_json: proposal_payload("Arrival", false),
                reconciliation_envelope: Some(envelope_v2(
                    &db, PROJECT_A, run_id, task_id, "Arrival",
                )),
            }],
        },
    )
    .expect("public V2 root must save with parent authorities");
    let parent_revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("public V2 parent revision")
        .to_owned();
    let parent_digest = saved["proposals"][0]["reconciliationEnvelopeDigest"]
        .as_str()
        .expect("public V2 parent Envelope digest")
        .to_owned();
    let mut scope_override_payload = proposal_payload("Arrival", true);
    scope_override_payload["disclosure"]["revealDocumentRef"] = json!("D000001");
    let child = narrative_extraction::narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto(
            &db,
            PROJECT_A,
            CreateHumanDerivedRevisionRequest {
                proposal_id: proposal_id.to_owned(),
                expected_current_revision_id: parent_revision_id.clone(),
                parent_revision_id: parent_revision_id.clone(),
                expected_parent_envelope_digest: parent_digest,
                proposal_payload: scope_override_payload,
                adapter: NarrativeAdapterIdentity {
                    id: ADAPTER_ID.to_owned(),
                    version: ADAPTER_VERSION.to_owned(),
                },
                surface_id: "chronicle-review".to_owned(),
            },
        )
        .expect("public V2 root must enter the Human ScopeOverride writer");
    let child_revision_id = child["revisionId"]
        .as_str()
        .expect("public V2 to C2B child revision")
        .to_owned();
    assert_ne!(child_revision_id, parent_revision_id);
    let (child_schema_version, source_count, edge_count, d1_count, freshness_count): (
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT json_extract(reconciliation_envelope_json, '$.schemaVersion')
                       FROM narrative_proposal_revisions WHERE id = ?1",
                    [&child_revision_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_revision_source_basis WHERE revision_id = ?1",
                    [&child_revision_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_dependency_edges
                      WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1",
                    [&child_revision_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_dependency_declaration_heads
                      WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1",
                    [&child_revision_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_consumer_freshness
                      WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1",
                    [&child_revision_id],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read public V2 to C2B child authorities");
    assert_eq!(child_schema_version, 2);
    assert_eq!(
        source_count, 2,
        "ScopeOverride adds live authority SourceBasis"
    );
    assert_eq!(edge_count, 2, "ScopeOverride adds the live authority edge");
    assert_eq!(d1_count, 1, "ScopeOverride publishes one D1 head");
    assert_eq!(
        freshness_count, 1,
        "ScopeOverride publishes current-Epoch Freshness"
    );
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

fn raw_observation_refs(raw_observations: &Value) -> Vec<String> {
    raw_observations["observations"]
        .as_array()
        .expect("raw observations array")
        .iter()
        .map(|observation| {
            observation["localId"]
                .as_str()
                .expect("raw observation localId")
                .to_owned()
        })
        .collect()
}

fn event_output_for_refs(observation_refs: &[String]) -> Value {
    json!({
        "clusterRef": "cluster:arrival",
        "resolution": if observation_refs.is_empty() { "no-events" } else { "single-event" },
        "events": if observation_refs.is_empty() {
            Vec::<Value>::new()
        } else {
            vec![json!({
                "observationRefs": observation_refs,
                "titleSuggestion": "Arrival",
                "summary": "A traveler arrives.",
                "actuality": "actual",
                "significance": "major",
                "semanticType": "story.event.arrival"
            })]
        }
    })
}

fn parsed_output_digest_for_output(raw_observations: &Value, event_output: &Value) -> String {
    let observation_refs = raw_observation_refs(raw_observations);
    digest(&json!({
        "domain": PARSED_OUTPUT_DIGEST_DOMAIN,
        "kind": "chronicle.event-synthesis-output@1",
        "observationCount": observation_refs.len(),
        "eventCount": event_output["events"].as_array().expect("event array").len(),
        "observationRefs": observation_refs,
        "rawObservationsDigest": digest(raw_observations),
        "eventOutputDigest": digest(event_output)
    }))
}

fn refresh_stage_receipt_digest(receipt: &mut Value) {
    receipt["stageExecutionReceiptDigest"] = Value::String(digest(&json!({
        "domain": TERMINAL_RECEIPT_DOMAIN,
        "stageExecution": receipt["stageExecution"],
        "contextSetVersion": receipt["contextSetVersion"],
        "contextSetDigest": receipt["contextSetDigest"],
        "componentContractDigest": receipt["componentContractDigest"],
        "finalRequestDigest": receipt["finalRequestDigest"],
        "modelBindingDigest": receipt["modelBindingDigest"],
        "responseDigest": receipt["responseDigest"],
        "rawObservationsDigest": receipt["rawObservationsDigest"],
        "parsedOutputDigest": receipt["parsedOutputDigest"],
        "parseStatus": receipt["parseStatus"],
        "terminalStatus": receipt["terminalStatus"]
    })));
}

fn bind_terminal_output(receipt: &mut Value, raw_observations: &Value, event_output: &Value) {
    receipt["rawObservationsDigest"] = Value::String(digest(raw_observations));
    receipt["parsedOutputDigest"] = Value::String(parsed_output_digest_for_output(
        raw_observations,
        event_output,
    ));
    refresh_stage_receipt_digest(receipt);
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
        "rawObservationsDigest": null,
        "parsedOutputDigest": null,
        "parseStatus": parse_status,
        "terminalStatus": terminal_status
    });
    let mut receipt = without_digest;
    if stage_id == EVENT_SYNTHESIS_STAGE_ID
        && parse_status == "parsed"
        && terminal_status == "succeeded"
    {
        let raw = raw_observations(&["observation:arrival"]);
        let refs = raw_observation_refs(&raw);
        bind_terminal_output(&mut receipt, &raw, &event_output_for_refs(&refs));
    } else {
        refresh_stage_receipt_digest(&mut receipt);
    }
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
    valid_stage_closure_with_raw_refs(
        project_id,
        run_id,
        owner_task_id,
        owner_attempt_id,
        context_digest,
        component_digest,
        request_digest,
        &["observation:arrival"],
    )
}

#[allow(clippy::too_many_arguments)]
fn valid_stage_closure_with_raw_refs(
    project_id: &str,
    run_id: &str,
    owner_task_id: &str,
    owner_attempt_id: &str,
    context_digest: &str,
    component_digest: &str,
    request_digest: &str,
    raw_refs: &[&str],
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
    let raw = raw_observations(raw_refs);
    let refs = raw_observation_refs(&raw);
    let mut synthesis_receipt = if refs.is_empty() {
        stage_receipt_with_state(
            project_id,
            run_id,
            owner_task_id,
            owner_attempt_id,
            EVENT_SYNTHESIS_STAGE_ID,
            "stage:event-synthesis",
            None,
            context_digest,
            component_digest,
            request_digest,
            "not-attempted",
            "skipped",
            None,
        )
    } else {
        stage_receipt(
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
        )
    };
    bind_terminal_output(&mut synthesis_receipt, &raw, &event_output_for_refs(&refs));
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
                (id, run_id, task_kind, status, attempt_count, created_at)
             VALUES (?1, ?2, ?3, 'completed', 1, datetime('now'))",
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

/// Seed one AI-audit ledger event binding a receipt's stage execution,
/// response digest, and terminal receipt digest, mirroring the transport's
/// identity semantics: `execution_id` = stageExecutionId, `operation_id` =
/// "runId:taskId:attemptId" (chronicleStageAudit.ts).
fn seed_stage_audit_event(db: &Database, project_id: &str, receipt: &Value) {
    let execution = &receipt["stageExecution"];
    let stage_execution_id = execution["stageExecutionId"]
        .as_str()
        .expect("stage execution id");
    let operation_id = format!(
        "{}:{}:{}",
        execution["runId"].as_str().expect("receipt runId"),
        execution["taskId"].as_str().expect("receipt taskId"),
        execution["attemptId"].as_str().expect("receipt attemptId"),
    );
    let response_digest = receipt["responseDigest"].clone();
    let receipt_digest = receipt["stageExecutionReceiptDigest"]
        .as_str()
        .expect("receipt digest");
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
                "stageExecutionReceiptDigest": receipt_digest,
                "parseStatus": receipt["parseStatus"],
                "terminalStatus": receipt["terminalStatus"],
            }}
        })
        .to_string();
        conn.execute(
            "INSERT INTO ai_audit_events
                (scope_id, project_id, sequence, event_id, execution_id, operation_id,
                 path_id, event_type, timestamp, recorded_at, payload, payload_sha256,
                 prev_hash, hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'path-test', 'completion', 0, 0,
                     ?7, 'sha256:test', 'sha256:test', 'sha256:test')",
            rusqlite::params![
                scope_id,
                project_id,
                sequence,
                format!("audit-{stage_execution_id}-{sequence}"),
                stage_execution_id,
                operation_id,
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
            seed_stage_task_attempt(
                db,
                run_id,
                task_id,
                attempt_id,
                "chronicle.observe-events@1",
            );
        }
        seed_stage_audit_event(db, PROJECT_A, receipt);
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

fn accepted_synthesis_terminal_ids(closure: &Value) -> Vec<(String, String, String)> {
    let receipts = closure["receipts"].as_array().expect("closure receipts");
    receipts
        .iter()
        .filter(|receipt| {
            receipt["stageExecution"]["stageId"] == EVENT_SYNTHESIS_STAGE_ID
                && receipt["stageExecution"]
                    .get("parentStageExecutionId")
                    .is_none()
        })
        .filter_map(|root| {
            let root_id = root["stageExecution"]["stageExecutionId"]
                .as_str()?
                .to_owned();
            match (
                root["parseStatus"].as_str(),
                root["terminalStatus"].as_str(),
            ) {
                (Some("parsed"), Some("succeeded")) => {
                    Some((root_id.clone(), root_id, "root-success".to_owned()))
                }
                (Some("not-attempted"), Some("skipped")) => {
                    Some((root_id.clone(), root_id, "deterministic-empty".to_owned()))
                }
                (Some("invalid"), Some("failed")) => receipts
                    .iter()
                    .find(|child| {
                        child["stageExecution"]["stageId"] == "narrative_structured_repair"
                            && child["stageExecution"]["parentStageExecutionId"] == root_id
                            && child["parseStatus"] == "parsed"
                            && child["terminalStatus"] == "succeeded"
                    })
                    .and_then(|child| {
                        child["stageExecution"]["stageExecutionId"]
                            .as_str()
                            .map(|terminal_id| {
                                (root_id, terminal_id.to_owned(), "repair-success".to_owned())
                            })
                    }),
                _ => None,
            }
        })
        .collect()
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
    finish_bundle_with_artifacts_and_parsed_output_digest(
        db,
        run_id,
        task_id,
        attempt_id,
        closure,
        observation_count,
        observation_refs,
        artifacts,
        output_closure_digest,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_bundle_with_artifacts_and_parsed_output_digest(
    db: &Database,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    closure: Value,
    observation_count: u64,
    observation_refs: Value,
    artifacts: Vec<ArtifactInput>,
    output_closure_digest: Option<&str>,
    parsed_output_digest_override: Option<&str>,
) -> anyhow::Result<Value> {
    finish_bundle_with_companion_mutation(
        db,
        run_id,
        task_id,
        attempt_id,
        closure,
        observation_count,
        observation_refs,
        artifacts,
        output_closure_digest,
        parsed_output_digest_override,
        None,
    )
}

enum SynthesisCompanionMutation {
    HypothesisField(&'static str, Value),
    HypothesisAndEventActuality(&'static str),
    EventOutputField(&'static str, Value),
    EventRowField(&'static str, Value),
    DuplicateHypothesisId,
    EmptySemanticTypeNormalization,
}

#[allow(clippy::too_many_arguments)]
fn finish_bundle_with_companion_mutation(
    db: &Database,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    closure: Value,
    observation_count: u64,
    observation_refs: Value,
    artifacts: Vec<ArtifactInput>,
    output_closure_digest: Option<&str>,
    parsed_output_digest_override: Option<&str>,
    companion_mutation: Option<SynthesisCompanionMutation>,
) -> anyhow::Result<Value> {
    let closure_digest = closure["stageProvenanceClosureDigest"]
        .as_str()
        .expect("closure digest")
        .to_owned();
    seed_closure_evidence(db, run_id, task_id, &closure);
    let terminal_outputs = accepted_synthesis_terminal_ids(&closure);
    let typed_closure: ChronicleStageProvenanceClosure =
        serde_json::from_value(closure.clone()).expect("typed ephemeral closure");
    let raw_observations = artifacts
        .iter()
        .find(|artifact| artifact.artifact_kind == "chronicle.raw-observations@1")
        .and_then(|artifact| artifact.payload_json.clone())
        .unwrap_or(Value::Null);
    let mut event_output = if observation_count == 0 {
        json!({"clusterRef": "cluster:arrival", "resolution": "no-events", "events": []})
    } else {
        json!({
            "clusterRef": "cluster:arrival",
            "resolution": "single-event",
            "events": [{
                "observationRefs": observation_refs,
                "titleSuggestion": "Arrival",
                "summary": "A traveler arrives.",
                "actuality": "actual",
                "significance": "major",
                "semanticType": "story.event.arrival"
            }]
        })
    };
    let hypothesis_count = event_output["events"].as_array().expect("event rows").len();
    let mut hypotheses = if hypothesis_count == 0 {
        Vec::<Value>::new()
    } else {
        vec![json!({
            "hypothesisId": "hypothesis:arrival",
            "clusterRef": "cluster:arrival",
            "observationRefs": observation_refs,
            "titleSuggestion": "Arrival",
            "summary": "A traveler arrives.",
            "actuality": "actual",
            "significance": "major",
            "semanticType": "story.event.arrival"
        })]
    };
    match companion_mutation {
        Some(SynthesisCompanionMutation::HypothesisAndEventActuality(actuality)) => {
            event_output["events"][0]["actuality"] = json!(actuality);
            hypotheses[0]["actuality"] = json!(actuality);
        }
        Some(SynthesisCompanionMutation::HypothesisField(field, value)) => {
            hypotheses
                .first_mut()
                .and_then(Value::as_object_mut)
                .expect("hypothesis-field mutation requires one hypothesis")
                .insert(field.to_owned(), value);
        }
        Some(SynthesisCompanionMutation::EventOutputField(field, value)) => {
            event_output
                .as_object_mut()
                .expect("event output object")
                .insert(field.to_owned(), value);
        }
        Some(SynthesisCompanionMutation::EventRowField(field, value)) => {
            event_output["events"]
                .as_array_mut()
                .and_then(|events| events.first_mut())
                .and_then(Value::as_object_mut)
                .expect("event-row mutation requires one event")
                .insert(field.to_owned(), value);
        }
        Some(SynthesisCompanionMutation::DuplicateHypothesisId) => {
            let event = event_output["events"]
                .as_array()
                .and_then(|events| events.first())
                .expect("duplicate-id mutation requires one event")
                .clone();
            event_output["events"]
                .as_array_mut()
                .expect("event rows")
                .push(event);
            let hypothesis = hypotheses
                .first()
                .expect("duplicate-id mutation requires one hypothesis")
                .clone();
            hypotheses.push(hypothesis);
        }
        Some(SynthesisCompanionMutation::EmptySemanticTypeNormalization) => {
            event_output["events"]
                .as_array_mut()
                .and_then(|events| events.first_mut())
                .and_then(Value::as_object_mut)
                .expect("empty-semantic-type mutation requires one event")
                .insert("semanticType".to_owned(), json!(""));
            hypotheses
                .first_mut()
                .and_then(Value::as_object_mut)
                .expect("empty-semantic-type mutation requires one hypothesis")
                .remove("semanticType");
        }
        None => {}
    }
    let raw_observations_digest = digest(&raw_observations);
    let parsed_output_digest = parsed_output_digest_override.map_or_else(
        || {
            if raw_observations["observations"].as_array().is_some() {
                parsed_output_digest_for_output(&raw_observations, &event_output)
            } else {
                FORGED_DIGEST.to_owned()
            }
        },
        str::to_owned,
    );
    let outputs = terminal_outputs
        .iter()
        .map(|(root_id, terminal_id, disposition)| {
            json!({
                "rootStageExecutionId": root_id,
                "terminalStageExecutionId": terminal_id,
                "disposition": disposition,
                "clusterRef": "cluster:arrival",
                "rawObservations": raw_observations,
                "eventOutput": event_output,
                "output": {
                    "kind": "chronicle.event-synthesis-output@1",
                    "observationCount": observation_count,
                    "eventCount": event_output["events"].as_array().expect("event rows").len(),
                    "observationRefs": observation_refs,
                    "rawObservationsDigest": raw_observations_digest,
                    "parsedOutputDigest": parsed_output_digest,
                    "eventOutputDigest": digest(&event_output)
                }
            })
        })
        .collect::<Vec<_>>();
    let hypothesis_count = hypotheses.len();
    let mut all_artifacts = artifacts;
    all_artifacts.push(artifact(
        &format!("{task_id}-hypotheses"),
        "chronicle.event-hypotheses@1",
        json!({"hypotheses": hypotheses}),
    ));
    all_artifacts.push(artifact(
        &format!("{task_id}-stage-synthesis-outputs"),
        "chronicle.stage-synthesis-outputs@1",
        json!({
            "kind": "chronicle.stage-synthesis-outputs@1",
            "version": 1,
            "outputs": outputs
        }),
    ));
    let owner_receipt = closure["receipts"]
        .as_array()
        .expect("closure receipts")
        .iter()
        .find(|receipt| {
            receipt["stageExecution"]["stageId"] == EVENT_SYNTHESIS_STAGE_ID
                && receipt["stageExecution"]
                    .get("parentStageExecutionId")
                    .is_none()
        })
        .expect("synthesis root owner");
    let owner_execution = &owner_receipt["stageExecution"];
    let owner_task_id = owner_execution["taskId"]
        .as_str()
        .expect("synthesis owner taskId")
        .to_owned();
    let owner_attempt_id = owner_execution["attemptId"]
        .as_str()
        .expect("synthesis owner attemptId")
        .to_owned();
    let owner_stage_execution_id = owner_execution["stageExecutionId"]
        .as_str()
        .expect("synthesis owner stageExecutionId")
        .to_owned();
    let binding_closure_digest = output_closure_digest.unwrap_or(&closure_digest);
    let output = json!({"hypothesisCount": hypothesis_count});
    narrative_extraction::narrative_extraction_finish_task(
        db,
        FinishTaskPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            task_id: task_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            lease_owner: "c2a-test-worker".to_owned(),
            output_json: Some(output),
            artifacts: all_artifacts,
            chronicle_stage_bundle: Some(ChronicleStageC1ExecutionBinding {
                project_id: PROJECT_A.to_owned(),
                run_id: run_id.to_owned(),
                task_id: task_id.to_owned(),
                attempt_id: attempt_id.to_owned(),
                stage_execution_owner_task_id: owner_task_id,
                stage_execution_owner_attempt_id: owner_attempt_id,
                stage_execution_owner_stage_execution_id: owner_stage_execution_id,
                // Fixture-side trusted execution coordinates are intentionally
                // independent of the closure. This verifies Native rejects a
                // self-consistent but forged receipt instead of letting the
                // helper copy its values into the trusted binding.
                context_set_digest: context_set_digest(),
                component_contract_digest: component_contract_digest(),
                final_request_digest: final_request_digest(),
                stage_provenance_closure_digest: binding_closure_digest.to_owned(),
                closure: typed_closure,
            }),
            chronicle_stage_receipts: vec![],
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
        },
    )
}

fn assert_stage_finish_rolled_back(
    db: &Database,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    case: &str,
) {
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
        .unwrap_or_else(|error| panic!("read {case} rollback: {error:#}"));
    assert_eq!(task_status, "running", "{case}");
    assert_eq!(attempt_status, "running", "{case}");
    assert_eq!(artifact_count, 0, "{case}");
    assert_eq!(receipt_count, 0, "{case}");
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
                "rawObservationsDigest": receipt["rawObservationsDigest"],
                "parsedOutputDigest": receipt["parsedOutputDigest"],
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
    assert_eq!(output, json!({"hypothesisCount": 1}));
    assert_eq!(
        artifact_count, 3,
        "only the generic raw artifact, hypotheses, and typed output companion are durable; the closure stays ephemeral"
    );
}

#[test]
fn observation_terminal_receipt_is_durable_before_a_later_synthesis_closure() {
    let db = migrated_db();
    let run_id = "run-observation-terminal-before-synthesis";
    let task_id = "task-observation-terminal-before-synthesis";
    create_run_with_task_kind(
        &db,
        PROJECT_A,
        run_id,
        task_id,
        "chronicle.observe-events@1",
    );
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let receipt_json = stage_receipt(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        OBSERVATION_STAGE_ID,
        "stage:observation-terminal-before-synthesis",
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
        &json!({ "observations": [observation_payload()] }),
    );
    seed_stage_audit_event(&db, PROJECT_A, &receipt_json);
    let receipt: narrative_extraction::ChronicleStageTerminalReceipt =
        serde_json::from_value(receipt_json.clone()).expect("typed Observation receipt");
    let raw = raw_observations(&["observation:arrival"]);

    narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            task_id: task_id.to_owned(),
            attempt_id,
            lease_owner: "c2a-test-worker".to_owned(),
            output_json: Some(json!({ "observationCount": 1 })),
            artifacts: vec![artifact(
                "artifact-observation-terminal-before-synthesis",
                "chronicle.raw-observations@1",
                raw,
            )],
            chronicle_stage_bundle: None,
            chronicle_stage_receipts: vec![receipt],
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
        },
    )
    .expect("Observation terminalization must seal its receipt before synthesis exists");

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
        .expect("read durable Observation receipt sidecars");
    assert_eq!((receipt_count, binding_count), (1, 1));

    let bundle = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        narrative_extraction::RunRefPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            chronicle_blocked_discard: None,
        },
    )
    .expect("restart hydration must reconstruct the pre-synthesis Observation receipt");
    let hydrated = bundle["stageReceipts"]
        .as_array()
        .expect("Native stage receipt roster");
    assert_eq!(hydrated.len(), 1);
    assert_eq!(
        hydrated[0]["stageExecution"]["stageExecutionId"],
        "stage:observation-terminal-before-synthesis"
    );
    assert_eq!(
        hydrated[0]["stageExecutionReceiptDigest"],
        receipt_json["stageExecutionReceiptDigest"]
    );
}

#[test]
fn later_synthesis_bundle_reuses_the_previously_terminalized_observation_receipt() {
    let db = migrated_db();
    let run_id = "run-observation-terminal-then-synthesis";
    let plan_task_id = "task-plan-after-observation";
    let observation_task_id = "task-observation-before-synthesis";
    create_run(&db, PROJECT_A, run_id, plan_task_id);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, attempt_count, created_at)
             VALUES (?1, ?2, 'chronicle.observe-events@1', 'queued', 0, datetime('now'))",
            rusqlite::params![observation_task_id, run_id],
        )?;
        Ok(())
    })
    .expect("seed Observation task before plan aggregator");

    let observation_claim = narrative_extraction::narrative_extraction_claim_task(
        &db,
        narrative_extraction::ClaimTaskPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            lease_owner: "c2a-test-worker".to_owned(),
            lease_duration_secs: Some(300),
            task_kinds: Some(vec!["chronicle.observe-events@1".to_owned()]),
        },
    )
    .expect("claim Observation task");
    let observation_attempt_id = observation_claim["task"]["attemptId"]
        .as_str()
        .expect("Observation attempt id")
        .to_owned();
    let observation_receipt = stage_receipt(
        PROJECT_A,
        run_id,
        observation_task_id,
        &observation_attempt_id,
        OBSERVATION_STAGE_ID,
        "stage:observation-before-synthesis",
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
        &json!({ "observations": [observation_payload()] }),
    );
    seed_stage_audit_event(&db, PROJECT_A, &observation_receipt);
    let typed_observation_receipt: narrative_extraction::ChronicleStageTerminalReceipt =
        serde_json::from_value(observation_receipt.clone())
            .expect("typed Observation terminal receipt");
    narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            task_id: observation_task_id.to_owned(),
            attempt_id: observation_attempt_id,
            lease_owner: "c2a-test-worker".to_owned(),
            output_json: Some(json!({ "observationCount": 1 })),
            artifacts: vec![artifact(
                "artifact-observation-before-synthesis",
                "chronicle.raw-observations@1",
                raw_observations(&["observation:arrival"]),
            )],
            chronicle_stage_bundle: None,
            chronicle_stage_receipts: vec![typed_observation_receipt],
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
        },
    )
    .expect("terminalize Observation before the later synthesis closure");

    let plan_attempt_id = claim_task(&db, PROJECT_A, run_id);
    let synthesis_receipt = stage_receipt(
        PROJECT_A,
        run_id,
        plan_task_id,
        &plan_attempt_id,
        EVENT_SYNTHESIS_STAGE_ID,
        "stage:synthesis-after-observation",
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
        &json!({ "proposal": proposal_payload("Arrival", false) }),
    );
    let closure = closure_for_receipts(
        PROJECT_A,
        run_id,
        plan_task_id,
        &plan_attempt_id,
        json!([observation_receipt, synthesis_receipt]),
    );
    finish_bundle(&db, run_id, plan_task_id, &plan_attempt_id, closure)
        .expect("later closure must reuse, not reject or duplicate, the prior Observation receipt");

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
        .expect("read durable receipt roster");
    assert_eq!(
        (receipt_count, binding_count),
        (2, 2),
        "the closure must retain one durable observation and one synthesis receipt"
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
fn persists_a_successful_synthesis_repair_child_as_the_only_terminal_output() {
    let db = migrated_db();
    let run_id = "run-stage-synthesis-repair-terminal";
    let task_id = "task-stage-synthesis-repair-terminal";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let context_digest = context_set_digest();
    let component_digest = component_contract_digest();
    let request_digest = final_request_digest();
    // A real structured-repair invocation has its own prompt coordinates.
    // The V2 Envelope must nevertheless bind the failed synthesis root's
    // coordinates while its terminal output digest comes from this child.
    let repair_context_digest = digest(&json!({"repair": "context"}));
    let repair_component_digest = digest(&json!({"repair": "component"}));
    let repair_request_digest = digest(&json!({"repair": "request"}));
    let observation = stage_receipt(
        PROJECT_A,
        run_id,
        "task:observation",
        "attempt:observation",
        OBSERVATION_STAGE_ID,
        "stage:observation-repair-terminal",
        &context_digest,
        &component_digest,
        &request_digest,
        &json!({"observations": [observation_payload()]}),
    );
    let failed_root = stage_receipt_with_state(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        EVENT_SYNTHESIS_STAGE_ID,
        "stage:synthesis-root-failed",
        None,
        &context_digest,
        &component_digest,
        &request_digest,
        "invalid",
        "failed",
        Some(&json!({"invalid": "model response"})),
    );
    let raw = raw_observations(&["observation:arrival"]);
    let refs = raw_observation_refs(&raw);
    let mut successful_repair = stage_receipt_with_state(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        "narrative_structured_repair",
        "stage:synthesis-repair-success",
        Some("stage:synthesis-root-failed"),
        &repair_context_digest,
        &repair_component_digest,
        &repair_request_digest,
        "parsed",
        "succeeded",
        Some(&json!({"clusterRef": "cluster:arrival", "events": []})),
    );
    bind_terminal_output(&mut successful_repair, &raw, &event_output_for_refs(&refs));
    let closure = closure_for_receipts(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        json!([observation, successful_repair, failed_root]),
    );
    let receipt_refs = closure["receiptRefs"].clone();

    finish_bundle(&db, run_id, task_id, &attempt_id, closure)
        .expect("a parsed repair child must be accepted as the synthesis terminal output");
    let (root_raw, repair_raw, repair_parsed): (Option<String>, Option<String>, Option<String>) =
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT
                    MAX(CASE WHEN stage_execution_id = 'stage:synthesis-root-failed'
                             THEN json_extract(receipt_json, '$.rawObservationsDigest') END),
                    MAX(CASE WHEN stage_execution_id = 'stage:synthesis-repair-success'
                             THEN json_extract(receipt_json, '$.rawObservationsDigest') END),
                    MAX(CASE WHEN stage_execution_id = 'stage:synthesis-repair-success'
                             THEN json_extract(receipt_json, '$.parsedOutputDigest') END)
                   FROM narrative_extraction_stage_receipts
                  WHERE run_id = ?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read persisted repair terminal receipt");
    assert_eq!(root_raw, None);
    assert!(repair_raw.is_some());
    assert!(repair_parsed.is_some());

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-repair-terminal-v2', ?1, 0, 'initial',
                     '2026-08-25T00:00:00.000Z')",
            [PROJECT_A],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed Epoch for V2 repair-terminal ProposalSet");
    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_set_id: Some("set-synthesis-repair-terminal".to_owned()),
            set_kind: "chronicle.extract.review@1".to_owned(),
            summary_json: Some(json!({
                "chronicleStageReceiptRefs": receipt_refs
            })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-synthesis-repair-terminal".to_owned()),
                proposal_key: "event:arrival:synthesis-repair-terminal".to_owned(),
                kind: PROPOSAL_KIND.to_owned(),
                payload_json: proposal_payload("Arrival", false),
                reconciliation_envelope: Some(envelope_v2(
                    &db, PROJECT_A, run_id, task_id, "Arrival",
                )),
            }],
        },
    )
    .expect(
        "V2 ProposalSet must resolve its failed synthesis root through the parsed repair child",
    );
    assert_eq!(saved["proposals"][0]["originKind"], "enveloped");
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
fn invalid_unrepaired_synthesis_root_cannot_be_hidden_by_an_unrelated_success() {
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
        .expect_err("an invalid unrepaired synthesis root must not be hidden by another success");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_SYNTHESIS_PROVENANCE_MISSING"),
        "unexpected mixed-cluster terminal-path error: {error:#}"
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
            chronicle_stage_receipts: vec![],
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
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
            .contains("NEX_INLINE_ARTIFACT_DIGEST_MISMATCH"),
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

fn closure_with_authored_terminal_output(
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    raw: &Value,
    event_output: &Value,
) -> Value {
    let closure = valid_stage_closure(
        PROJECT_A,
        run_id,
        task_id,
        attempt_id,
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
    );
    let mut receipts = closure["receipts"]
        .as_array()
        .expect("closure receipts")
        .clone();
    let synthesis = receipts
        .iter_mut()
        .find(|receipt| receipt["stageExecution"]["stageId"] == EVENT_SYNTHESIS_STAGE_ID)
        .expect("synthesis receipt");
    bind_terminal_output(synthesis, raw, event_output);
    closure_for_receipts(
        PROJECT_A,
        run_id,
        task_id,
        attempt_id,
        Value::Array(receipts),
    )
}

fn assert_chronicle_synthesis_preserves_rumored_raw(event_actuality: &'static str) {
    let db = migrated_db();
    let run_id = format!("run-stage-rumored-{event_actuality}");
    let task_id = format!("task-stage-rumored-{event_actuality}");
    create_run(&db, PROJECT_A, &run_id, &task_id);
    let attempt_id = claim_task(&db, PROJECT_A, &run_id);
    let mut raw = raw_observations(&["observation:arrival"]);
    raw["observations"][0]["payload"]["actuality"] = json!("rumored");
    let mut event_output = event_output_for_refs(&raw_observation_refs(&raw));
    event_output["events"][0]["actuality"] = json!(event_actuality);
    let closure =
        closure_with_authored_terminal_output(&run_id, &task_id, &attempt_id, &raw, &event_output);
    finish_bundle_with_companion_mutation(
        &db, &run_id, &task_id, &attempt_id, closure, 1,
        json!(["observation:arrival"]),
        vec![artifact(&format!("{task_id}-raw-observations"), "chronicle.raw-observations@1", raw.clone())],
        None, None,
        Some(SynthesisCompanionMutation::HypothesisAndEventActuality(event_actuality)),
    ).unwrap_or_else(|error| panic!("rumored raw and {event_actuality} terminal must retain their original modalities: {error:#}"));

    // This fixture terminalizes one stage, not the complete extraction DAG.
    // Read the Native-persisted rows directly, as the other atomic C2A tests do.
    let saved = |kind: &str| -> Value {
        let records: Vec<(String, String)> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT payload_json, payload_digest FROM narrative_extraction_artifacts
                 WHERE run_id = ?1 AND task_id = ?2 AND artifact_kind = ?3",
                )?;
                let records = statement
                    .query_map(rusqlite::params![run_id, task_id, kind], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(records)
            })
            .expect("read persisted stage artifact");
        assert_eq!(records.len(), 1, "one saved {kind}");
        let payload: Value = serde_json::from_str(&records[0].0).expect("saved JSON artifact");
        assert_eq!(records[0].1, digest(&payload));
        payload
    };
    assert_eq!(saved("chronicle.raw-observations@1"), raw);
    let companion = saved("chronicle.stage-synthesis-outputs@1");
    let terminal = &companion["outputs"][0];
    assert_eq!(terminal["rawObservations"], raw);
    assert_eq!(terminal["eventOutput"], event_output);
    assert_eq!(terminal["output"]["rawObservationsDigest"], digest(&raw));
    assert_eq!(
        terminal["output"]["eventOutputDigest"],
        digest(&event_output)
    );
    assert_eq!(
        terminal["output"]["parsedOutputDigest"],
        parsed_output_digest_for_output(&raw, &event_output)
    );
    let hypotheses = saved("chronicle.event-hypotheses@1");
    let hypothesis = &hypotheses["hypotheses"][0];
    let mut expected_hypothesis = event_output["events"][0].clone();
    expected_hypothesis["hypothesisId"] = json!("hypothesis:arrival");
    expected_hypothesis["clusterRef"] = json!("cluster:arrival");
    assert_eq!(hypothesis, &expected_hypothesis);
    let (receipt_json, task_status, proposal_count): (String, String, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT r.receipt_json, t.status,
                    (SELECT COUNT(*) FROM narrative_proposals p
                     JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                     WHERE s.run_id = ?1 AND s.project_id = ?4)
             FROM narrative_extraction_stage_receipts r
             JOIN narrative_extraction_tasks t ON t.id = r.task_id AND t.run_id = r.run_id
             WHERE r.run_id = ?1 AND r.task_id = ?2 AND r.attempt_id = ?3 AND r.project_id = ?4
               AND json_extract(r.receipt_json, '$.stageExecution.stageId') = ?5",
                rusqlite::params![
                    run_id,
                    task_id,
                    attempt_id,
                    PROJECT_A,
                    EVENT_SYNTHESIS_STAGE_ID
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read persisted receipt and task state");
    let receipt: Value = serde_json::from_str(&receipt_json).expect("saved receipt JSON");
    assert_eq!(receipt["rawObservationsDigest"], digest(&raw));
    assert_eq!(
        receipt["parsedOutputDigest"],
        parsed_output_digest_for_output(&raw, &event_output)
    );
    assert_eq!(task_status, "completed");
    assert_eq!(
        proposal_count, 0,
        "stage preservation itself must not write a Proposal"
    );
}

#[test]
fn chronicle_synthesis_preserves_rumored_raw_without_correcting_an_actual_hypothesis() {
    // Provenance retains the model output; the later planner rejects unsupported promotion.
    assert_chronicle_synthesis_preserves_rumored_raw("actual");
}

#[test]
fn chronicle_synthesis_preserves_rumored_raw_hypothesis_and_terminal() {
    assert_chronicle_synthesis_preserves_rumored_raw("rumored");
}

#[test]
fn chronicle_synthesis_rejects_unknown_raw_actuality_atomically() {
    let db = migrated_db();
    let run_id = "run-stage-unknown-raw-actuality";
    let task_id = "task-stage-unknown-raw-actuality";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let mut raw = raw_observations(&["observation:arrival"]);
    raw["observations"][0]["payload"]["actuality"] = json!("future-actuality");
    let event_output = event_output_for_refs(&raw_observation_refs(&raw));
    let closure =
        closure_with_authored_terminal_output(run_id, task_id, &attempt_id, &raw, &event_output);
    let error = finish_bundle_with_raw(&db, run_id, task_id, &attempt_id, closure, raw, None, None)
        .expect_err("unknown raw actuality must remain invalid");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID"),
        "unexpected invalid-actuality error: {error:#}"
    );
    assert_stage_finish_rolled_back(&db, run_id, task_id, &attempt_id, "unknown-raw-actuality");
}

#[test]
fn chronicle_synthesis_requires_native_parsed_output_digest() {
    let db = migrated_db();
    let run_id = "run-stage-parsed-output-digest";
    let task_id = "task-stage-parsed-output-digest";
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
    let error = finish_bundle_with_artifacts_and_parsed_output_digest(
        &db,
        run_id,
        task_id,
        &attempt_id,
        closure,
        1,
        json!(["observation:arrival"]),
        vec![artifact(
            &format!("{task_id}-raw-observations"),
            "chronicle.raw-observations@1",
            raw_observations(&["observation:arrival"]),
        )],
        None,
        Some(FORGED_DIGEST),
    )
    .expect_err("forged parsed output digest must roll back atomically");
    assert!(error
        .to_string()
        .contains("NEX_CHRONICLE_SYNTHESIS_OUTPUT_DIGEST_MISMATCH"));
    let (task_status, attempt_status, artifact_count, receipt_count): (String, String, i64, i64) =
        db.with_conn(|conn| {
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
        .expect("read parsed output digest rollback");
    assert_eq!(task_status, "running");
    assert_eq!(attempt_status, "running");
    assert_eq!(artifact_count, 0);
    assert_eq!(receipt_count, 0);
}

#[test]
fn chronicle_synthesis_rejects_hypothesis_semantics_not_bound_to_terminal_output() {
    for (case, field, altered_value) in [
        ("title", "titleSuggestion", json!("Altered title")),
        ("summary", "summary", json!("Altered summary")),
        ("actuality", "actuality", json!("prevented")),
        ("rumored-actuality", "actuality", json!("rumored")),
        ("significance", "significance", json!("minor")),
        (
            "semantic-type",
            "semanticType",
            json!("story.event.departure"),
        ),
    ] {
        let db = migrated_db();
        let run_id = format!("run-stage-semantic-binding-{case}");
        let task_id = format!("task-stage-semantic-binding-{case}");
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
        let error = finish_bundle_with_companion_mutation(
            &db,
            &run_id,
            &task_id,
            &attempt_id,
            closure,
            1,
            json!(["observation:arrival"]),
            vec![artifact(
                &format!("{task_id}-raw-observations"),
                "chronicle.raw-observations@1",
                raw_observations(&["observation:arrival"]),
            )],
            None,
            None,
            Some(SynthesisCompanionMutation::HypothesisField(
                field,
                altered_value,
            )),
        )
        .expect_err("hypothesis semantics must be equal to the sealed terminal output");
        assert!(
            error
                .to_string()
                .contains("NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID"),
            "{case}: unexpected semantic-binding error: {error:#}"
        );
        assert_stage_finish_rolled_back(&db, &run_id, &task_id, &attempt_id, case);
    }
}

#[test]
fn chronicle_synthesis_accepts_generated_id_independence_and_empty_semantic_type_normalization() {
    for (case, mutation) in [
        (
            "generated-id",
            SynthesisCompanionMutation::HypothesisField(
                "hypothesisId",
                json!("hypothesis:independent-generated-id"),
            ),
        ),
        (
            "empty-semantic-type",
            SynthesisCompanionMutation::EmptySemanticTypeNormalization,
        ),
    ] {
        let db = migrated_db();
        let run_id = format!("run-stage-normalized-binding-{case}");
        let task_id = format!("task-stage-normalized-binding-{case}");
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
        if case == "empty-semantic-type" {
            let raw = raw_observations(&["observation:arrival"]);
            let mut event_output = event_output_for_refs(&raw_observation_refs(&raw));
            event_output["events"][0]["semanticType"] = json!("");
            let mut receipts = closure["receipts"]
                .as_array()
                .expect("closure receipts")
                .clone();
            let synthesis = receipts
                .iter_mut()
                .find(|receipt| receipt["stageExecution"]["stageId"] == EVENT_SYNTHESIS_STAGE_ID)
                .expect("synthesis receipt");
            bind_terminal_output(synthesis, &raw, &event_output);
            closure = closure_for_receipts(
                PROJECT_A,
                &run_id,
                &task_id,
                &attempt_id,
                Value::Array(receipts),
            );
        }
        finish_bundle_with_companion_mutation(
            &db,
            &run_id,
            &task_id,
            &attempt_id,
            closure,
            1,
            json!(["observation:arrival"]),
            vec![artifact(
                &format!("{task_id}-raw-observations"),
                "chronicle.raw-observations@1",
                raw_observations(&["observation:arrival"]),
            )],
            None,
            None,
            Some(mutation),
        )
        .unwrap_or_else(|error| panic!("{case} must match TS normalization: {error:#}"));
    }
}

#[test]
fn chronicle_synthesis_rejects_noncanonical_hypothesis_and_event_shapes_atomically() {
    for (case, mutation, expected_code) in [
        (
            "hypothesis-planned-actuality",
            SynthesisCompanionMutation::HypothesisField("actuality", json!("planned")),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID",
        ),
        (
            "event-planned-actuality",
            SynthesisCompanionMutation::EventRowField("actuality", json!("planned")),
            "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID",
        ),
        (
            "hypothesis-dreamed-actuality",
            SynthesisCompanionMutation::HypothesisField("actuality", json!("dreamed")),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID",
        ),
        (
            "event-dreamed-actuality",
            SynthesisCompanionMutation::EventRowField("actuality", json!("dreamed")),
            "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID",
        ),
        (
            "hypothesis-unknown-actuality",
            SynthesisCompanionMutation::HypothesisField("actuality", json!("unknown")),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID",
        ),
        (
            "event-unknown-actuality",
            SynthesisCompanionMutation::EventRowField("actuality", json!("unknown")),
            "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID",
        ),
        (
            "hypothesis-future-actuality-actuality",
            SynthesisCompanionMutation::HypothesisField("actuality", json!("future-actuality")),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID",
        ),
        (
            "event-future-actuality-actuality",
            SynthesisCompanionMutation::EventRowField("actuality", json!("future-actuality")),
            "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID",
        ),
        (
            "blank-hypothesis-id",
            SynthesisCompanionMutation::HypothesisField("hypothesisId", json!(" ")),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID",
        ),
        (
            "duplicate-hypothesis-id",
            SynthesisCompanionMutation::DuplicateHypothesisId,
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID",
        ),
        (
            "hypothesis-semantic-type-null",
            SynthesisCompanionMutation::HypothesisField("semanticType", Value::Null),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID",
        ),
        (
            "hypothesis-unknown-field",
            SynthesisCompanionMutation::HypothesisField("unknownSemanticField", json!(true)),
            "NEX_CHRONICLE_SYNTHESIS_COMPANION_INVALID",
        ),
        (
            "event-semantic-type-null",
            SynthesisCompanionMutation::EventRowField("semanticType", Value::Null),
            "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID",
        ),
        (
            "event-row-unknown-field",
            SynthesisCompanionMutation::EventRowField("unknownSemanticField", json!(true)),
            "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID",
        ),
        (
            "event-output-unknown-field",
            SynthesisCompanionMutation::EventOutputField("unknownSemanticField", json!(true)),
            "NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID",
        ),
    ] {
        let db = migrated_db();
        let run_id = format!("run-stage-noncanonical-binding-{case}");
        let task_id = format!("task-stage-noncanonical-binding-{case}");
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
        let error = finish_bundle_with_companion_mutation(
            &db,
            &run_id,
            &task_id,
            &attempt_id,
            closure,
            1,
            json!(["observation:arrival"]),
            vec![artifact(
                &format!("{task_id}-raw-observations"),
                "chronicle.raw-observations@1",
                raw_observations(&["observation:arrival"]),
            )],
            None,
            None,
            Some(mutation),
        )
        .expect_err("noncanonical companion shape must fail before DML");
        assert!(
            error.to_string().contains(expected_code),
            "{case}: unexpected error: {error:#}"
        );
        assert_stage_finish_rolled_back(&db, &run_id, &task_id, &attempt_id, case);
    }
}

#[test]
fn chronicle_synthesis_reserves_no_events_for_deterministic_empty() {
    for case in ["root-success", "repair-success"] {
        let db = migrated_db();
        let run_id = format!("run-stage-no-events-{case}");
        let task_id = format!("task-stage-no-events-{case}");
        create_run(&db, PROJECT_A, &run_id, &task_id);
        let attempt_id = claim_task(&db, PROJECT_A, &run_id);
        let context_digest = context_set_digest();
        let component_digest = component_contract_digest();
        let request_digest = final_request_digest();
        let closure = if case == "root-success" {
            valid_stage_closure(
                PROJECT_A,
                &run_id,
                &task_id,
                &attempt_id,
                &context_digest,
                &component_digest,
                &request_digest,
            )
        } else {
            let observation = stage_receipt(
                PROJECT_A,
                &run_id,
                "task:observation",
                "attempt:observation",
                OBSERVATION_STAGE_ID,
                "stage:observation-no-events-repair",
                &context_digest,
                &component_digest,
                &request_digest,
                &json!({"observations": [observation_payload()]}),
            );
            let failed_root = stage_receipt_with_state(
                PROJECT_A,
                &run_id,
                &task_id,
                &attempt_id,
                EVENT_SYNTHESIS_STAGE_ID,
                "stage:synthesis-no-events-root",
                None,
                &context_digest,
                &component_digest,
                &request_digest,
                "invalid",
                "failed",
                Some(&json!({"invalid": "model response"})),
            );
            let mut repair = stage_receipt_with_state(
                PROJECT_A,
                &run_id,
                &task_id,
                &attempt_id,
                "narrative_structured_repair",
                "stage:synthesis-no-events-repair",
                Some("stage:synthesis-no-events-root"),
                &digest(&json!({"repair": "context"})),
                &digest(&json!({"repair": "component"})),
                &digest(&json!({"repair": "request"})),
                "parsed",
                "succeeded",
                Some(&json!({"clusterRef": "cluster:arrival"})),
            );
            let raw = raw_observations(&["observation:arrival"]);
            bind_terminal_output(
                &mut repair,
                &raw,
                &event_output_for_refs(&raw_observation_refs(&raw)),
            );
            closure_for_receipts(
                PROJECT_A,
                &run_id,
                &task_id,
                &attempt_id,
                json!([observation, repair, failed_root]),
            )
        };
        let error = finish_bundle_with_companion_mutation(
            &db,
            &run_id,
            &task_id,
            &attempt_id,
            closure,
            1,
            json!(["observation:arrival"]),
            vec![artifact(
                &format!("{task_id}-raw-observations"),
                "chronicle.raw-observations@1",
                raw_observations(&["observation:arrival"]),
            )],
            None,
            None,
            Some(SynthesisCompanionMutation::EventOutputField(
                "resolution",
                json!("no-events"),
            )),
        )
        .expect_err("no-events must be exclusive to deterministic-empty");
        assert!(
            error
                .to_string()
                .contains("NEX_CHRONICLE_SYNTHESIS_OUTPUT_INVALID"),
            "{case}: unexpected no-events error: {error:#}"
        );
        assert_stage_finish_rolled_back(&db, &run_id, &task_id, &attempt_id, case);
    }
}

#[test]
fn chronicle_synthesis_accepts_a_valid_zero_result() {
    let db = migrated_db();
    let run_id = "run-stage-zero-result";
    let task_id = "task-stage-zero-result";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let closure = valid_stage_closure_with_raw_refs(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
        &[],
    );
    finish_bundle_with_raw(
        &db,
        run_id,
        task_id,
        &attempt_id,
        closure,
        raw_observations(&[]),
        None,
        None,
    )
    .expect("zero raw observations are a valid typed synthesis result");
}

#[test]
fn typed_stage_bundle_keeps_generic_raw_artifacts_unreserved_and_native_fills_digests() {
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
        match case {
            "extra-artifact" => {
                artifacts.push(artifact(
                    &format!("{task_id}-unexpected"),
                    "chronicle.unexpected@1",
                    json!({"unexpected": true}),
                ));
            }
            "missing-payload" => {
                raw_artifact.payload_json = None;
                artifacts = vec![raw_artifact];
            }
            "missing-digest" => {
                raw_artifact.payload_digest = None;
                artifacts = vec![raw_artifact];
            }
            _ => unreachable!("known raw artifact case"),
        }
        let result = finish_bundle_with_artifacts(
            &db,
            &run_id,
            &task_id,
            &attempt_id,
            closure,
            1,
            json!(["observation:arrival"]),
            artifacts,
            None,
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
        match case {
            "missing-payload" => {
                let error = result.expect_err("inline-json payload omission must fail closed");
                assert!(
                    error
                        .to_string()
                        .contains("NEX_INLINE_ARTIFACT_PAYLOAD_REQUIRED"),
                    "{case}: unexpected error: {error:#}"
                );
                assert_eq!(task_status, "running");
                assert_eq!(attempt_status, "running");
                assert_eq!(artifact_count, 0);
                assert_eq!(receipt_count, 0);
            }
            "extra-artifact" => {
                result.expect("ordinary generic artifacts remain legal beside C1 companion");
                assert_eq!(task_status, "completed");
                assert_eq!(attempt_status, "completed");
                assert_eq!(artifact_count, 4);
                assert_eq!(receipt_count, 1);
            }
            "missing-digest" => {
                result.expect("Native must fill a missing inline payload digest");
                assert_eq!(task_status, "completed");
                assert_eq!(attempt_status, "completed");
                assert_eq!(artifact_count, 3);
                assert_eq!(receipt_count, 1);
            }
            _ => unreachable!("known raw artifact case"),
        }
    }
}

#[test]
fn typed_stage_bundle_requires_observation_refs_exact_raw_local_id_set() {
    let db = migrated_db();
    let run_id = "run-stage-raw-cardinality";
    let task_id = "task-stage-raw-cardinality";
    create_run(&db, PROJECT_A, run_id, task_id);
    let attempt_id = claim_task(&db, PROJECT_A, run_id);
    let closure = valid_stage_closure_with_raw_refs(
        PROJECT_A,
        run_id,
        task_id,
        &attempt_id,
        &context_set_digest(),
        &component_contract_digest(),
        &final_request_digest(),
        &["observation:arrival", "observation:departure"],
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
    assert_eq!(artifact_count, 3);
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
fn direct_sql_v2_current_rejects_every_immutable_revision_update_surface() {
    for (field, value_sql) in [
        ("id", "'revision-v2-update-forged-id'"),
        ("proposal_id", "'proposal-v2-update-forged'"),
        ("revision_number", "99"),
        ("payload_json", r#"'{"forged":true}'"#),
        ("plan_fragment_json", "'{}'"),
        (
            "plan_fragment_digest",
            "'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
        ),
        ("origin_kind", "'legacy-unbound'"),
        ("reconciliation_envelope_json", "'{\"schemaVersion\":2}'"),
        (
            "reconciliation_envelope_digest",
            "'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
        ),
        ("created_at", "'2099-01-01T00:00:00.000Z'"),
        ("created_by", "'forged-writer'"),
    ] {
        let db = migrated_db();
        let parent = seed_v2_parent(
            &db,
            PROJECT_A,
            &format!("run-v2-update-{field}"),
            &format!("task-v2-update-{field}"),
            &format!("proposal-v2-update-{field}"),
            &format!("revision-v2-update-{field}"),
            &scene_revision_token(&db, PROJECT_A),
        );
        let revision_id = parent["revisionId"].as_str().expect("revision id");
        let sql =
            format!("UPDATE narrative_proposal_revisions SET {field} = {value_sql} WHERE id = ?1");
        let error = db
            .with_conn(|conn| {
                conn.execute(&sql, rusqlite::params![revision_id])?;
                Ok(())
            })
            .expect_err("V2 revision updates must be immutable");
        assert!(
            error.to_string().contains("NEX_REVISION_V2_IMMUTABLE"),
            "{field}: unexpected immutable update error: {error:#}"
        );

        let row_count: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_revisions WHERE id = ?1",
                    rusqlite::params![revision_id],
                    |row| row.get(0),
                )?)
            })
            .expect("read immutable V2 revision");
        assert_eq!(row_count, 1, "{field}: rejected update must not remove row");
    }
}

#[test]
fn c2b_activation_enables_chronicle_v2_and_keeps_the_v1_fallback() {
    let activation = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../policies/narrative/narrative-ir-contract.json"
    ));
    assert!(activation.contains("\"state\": \"enabled\""));
    assert!(activation.contains("runChronicleExtractionCoordinator"));
    assert!(activation.contains("narrative_extraction_save_proposal_set"));
    assert!(activation.contains("createHumanDerivedNarrativeRevisionV2"));
    assert!(activation.contains("\"v2Emission\": \"enabled\""));
    assert!(activation.contains("\"humanDerivedV2Ui\": \"enabled\""));
    assert!(activation.contains("\"currentRevisionPromotion\": \"enabled\""));
    assert!(activation.contains("\"productionFallback\": \"existing-v1-path\""));
}
