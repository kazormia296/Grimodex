//! Behavioral contract for the C2A Native Human Derivation writer.
//!
//! This file preserves the accepted compile-RED seam's history while now
//! exercising the landed typed request/API against D1's sealed declaration
//! storage.  The tests intentionally use only the policy-shaped request and
//! trusted Native authority arguments.  They do not route forged actor or
//! derivation metadata through the legacy decision JSON facade.
//!
//! The request has no `projectId`, `actor`, `derivation`, `changedPaths`,
//! Scope, source-basis, or child-edge fields.  Project is a trusted Native
//! function boundary; actor is fixed to the Native Human writer; all
//! derivation metadata and child declarations are Native-owned.

use anyhow::Result;
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_core::narrative_ir::derive_chronicle_scene_event_scope;
use grimodex_core::{canonical_json_digest, canonical_json_string};
use grimodex_db::narrative_extraction::human_material_basis::HumanMaterialDerivationKind;
use grimodex_db::narrative_extraction::{
    narrative_extraction_create_human_derived_revision,
    narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization,
    narrative_extraction_create_human_derived_revision_with_scope, narrative_extraction_create_run,
    write_dependency_declaration_set, CreateHumanDerivedRevisionRequest, CreateRunPayload,
    CreateTaskSeed, DependencyDeclaration, DependencyDeclarationSetRequest,
    NarrativeAdapterIdentity, TrustedHumanDerivationScope, TrustedRevealBasis,
    TrustedScopeBoundary, TrustedScopeInterval, TrustedUnresolvedConstraint,
};
use grimodex_db::Database;
use rusqlite::types::ValueRef;
use serde_json::{json, Value};

const PROJECT_A: &str = "project-a";
const PROJECT_B: &str = "project-b";
const ADAPTER_ID: &str = "chronicle.scene-event";
const ADAPTER_VERSION: &str = "1";
const SURFACE_ID: &str = "chronicle-review";
const SCENE_ID: &str = "scene-human";
const RUN_ID: &str = "run-human";
const TASK_ID: &str = "task-human";
const PROPOSAL_ID: &str = "proposal-human";
const PARENT_REVISION_ID: &str = "revision-parent";
const DECLARATION_PRODUCER_ID: &str = "chronicle-human-c2a";
const C2B_DECLARATION_PRODUCER_ID: &str = "proposal-revision-source-basis";
const C2B_EPOCH_ID: &str = "epoch-c2b-parent";
const DECLARATION_CREATED_AT: &str = "2026-08-24T00:00:00.000Z";

const REVISION_CONFLICT: &str = "NEX_PROPOSAL_REVISION_CONFLICT";
const PARENT_DIGEST_CONFLICT: &str = "NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT";
const PROJECT_MISMATCH: &str = "NEX_HUMAN_DERIVATION_PROJECT_MISMATCH";
const ADAPTER_UNSUPPORTED: &str = "NEX_HUMAN_DERIVATION_ADAPTER_UNSUPPORTED";
const SURFACE_UNSUPPORTED: &str = "NEX_HUMAN_DERIVATION_SURFACE_UNSUPPORTED";
const ZERO_EDGE: &str = "NEX_HUMAN_DERIVATION_ZERO_EDGE";
const DECLARATION_HEAD_UNAVAILABLE: &str = "NEX_HUMAN_DERIVATION_DECLARATION_HEAD_UNAVAILABLE";

fn digest(value: &Value) -> String {
    canonical_json_digest(value).expect("canonical digest")
}

fn source_key() -> String {
    format!("project:scene:{SCENE_ID}")
}

fn parent_semantic_payload() -> Value {
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

fn parent_scope() -> Value {
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

fn parent_context_set() -> Value {
    json!([{
        "contextId": "context:event-synthesis",
        "inputRef": source_key(),
        "stageId": "narrative_event_synthesize",
        "exposure": "model-visible",
        "selector": {"kind": "whole-source"}
    }])
}

fn parent_dependency_set() -> Value {
    json!([{
        "dependencyId": "dependency:evidence",
        "inputRef": source_key(),
        "contextIds": ["context:event-synthesis"],
        "role": "direct-evidence",
        "selector": {"kind": "whole-source"}
    }, {
        "dependencyId": "dependency:component-contract",
        "inputRef": "component:chronicle.event-synthesis.prompt",
        "contextIds": [],
        "role": "component-contract",
        "selector": {
            "kind": "component-contract",
            "contractId": "chronicle.event-synthesis.prompt",
            "contractDigest": parent_component_contract_digest()
        }
    }])
}

fn parent_component_contract_digest() -> String {
    digest(&json!({
        "schemaVersion": 1,
        "contextSetVersion": "chronicle.context-set/1",
        "stageId": "narrative_event_synthesize",
        "componentContract": {
            "contractId": "chronicle.event-synthesis.prompt",
            "contractVersion": "1",
            "instruction": "Extract the Chronicle scene event from the declared context.",
            "outputShape": "JSON object matching chronicle.create-event@1."
        }
    }))
}

fn parent_envelope_with_payload(
    source_revision_token: &str,
    proposal: &Value,
    scope: &Value,
) -> Value {
    let semantic = parent_semantic_payload();
    let source = json!([{
        "sourceKind": "scene-body",
        "sourceKey": source_key(),
        "revisionToken": source_revision_token
    }]);
    let evidence = json!([{
        "evidenceRef": "anchor:arrival",
        "documentRef": "document:1",
        "quote": "Arrival.",
        "quoteDigest": "sha256:61b3366c3dc326b93fb56073b11453dea0d2db2fe6f79588ce266188edd24c67",
        "sourceKey": source_key(),
        "revisionToken": source_revision_token
    }]);
    let dependencies = parent_dependency_set();
    let producer = json!({
        "kind": "reconciler-proposal",
        "id": "chronicle.reconciler",
        "version": "1"
    });
    let component_contract = json!({
        "contractId": "chronicle.event-synthesis.prompt",
        "contractVersion": "1",
        "instruction": "Extract the Chronicle scene event from the declared context.",
        "outputShape": "JSON object matching chronicle.create-event@1."
    });
    let context_set = parent_context_set();
    let context_set_digest = digest(&json!({
        "version": "chronicle.context-set/1",
        "entries": context_set
    }));
    let component_contract_digest = digest(&json!({
        "schemaVersion": 1,
        "contextSetVersion": "chronicle.context-set/1",
        "stageId": "narrative_event_synthesize",
        "componentContract": component_contract
    }));
    let final_request_digest = digest(&json!({
        "schemaVersion": 1,
        "contextSetVersion": "chronicle.context-set/1",
        "stageId": "narrative_event_synthesize",
        "contextSetDigest": context_set_digest,
        "componentContractDigest": component_contract_digest,
        "messages": [{
            "role": "user",
            "content": "Extract the Chronicle scene event from the declared context."
        }]
    }));
    let assertion_core_digest = digest(&json!({
        "assertionKind": "scene-event@1",
        "payloadSchemaRef": {
            "id": "narrative.chronicle.scene-event",
            "version": "1"
        },
        "typedSemanticPayload": semantic,
        "modality": "modality-inference",
        "polarity": "affirmative",
        "supportClass": "direct-source",
        "producer": producer
    }));
    let scope_digest = digest(scope);
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
    let proposal_digest = digest(proposal);

    json!({
        "schemaVersion": 2,
        "assertion": {
            "assertionId": null,
            "assertionKind": "scene-event@1",
            "payloadSchemaRef": {
                "id": "narrative.chronicle.scene-event",
                "version": "1"
            },
            "payload": semantic,
            "scope": scope,
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
            "runId": RUN_ID,
            "taskId": TASK_ID,
            "producer": producer,
            "contextSet": context_set,
            "contextSetDigest": context_set_digest,
            "componentContractDigest": component_contract_digest,
            "finalRequestDigest": final_request_digest
        },
        "projectionBinding": {
            "proposalKind": "chronicle.create-event@1",
            "proposalSchemaRef": {
                "id": "narrative.chronicle-event.create",
                "version": "1"
            },
            "proposalPayloadDigest": proposal_digest,
            "adapterContractId": ADAPTER_ID,
            "adapterContractVersion": ADAPTER_VERSION
        }
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ParentFixtureKind {
    C2A,
    C2B,
}

fn fixture_db() -> Database {
    fixture_db_for(PARENT_REVISION_ID, true)
}

fn zero_edge_fixture_db() -> Database {
    fixture_db_for("revision-zero-edge", false)
}

fn fixture_db_for(parent_revision_id: &str, include_v1_edge: bool) -> Database {
    fixture_db_for_payload_kind(
        parent_revision_id,
        include_v1_edge,
        proposal_payload(),
        ParentFixtureKind::C2A,
    )
}

fn fixture_db_for_payload(
    parent_revision_id: &str,
    include_v1_edge: bool,
    parent_payload: Value,
) -> Database {
    fixture_db_for_payload_kind(
        parent_revision_id,
        include_v1_edge,
        parent_payload,
        ParentFixtureKind::C2A,
    )
}

fn c2b_projection_fixture_db() -> Database {
    fixture_db_for_payload_kind(
        PARENT_REVISION_ID,
        true,
        proposal_payload(),
        ParentFixtureKind::C2B,
    )
}

fn fixture_db_for_payload_kind(
    parent_revision_id: &str,
    include_v1_edge: bool,
    parent_payload: Value,
    fixture_kind: ParentFixtureKind,
) -> Database {
    fixture_db_for_payload_kind_with_source_token(
        parent_revision_id,
        include_v1_edge,
        parent_payload,
        fixture_kind,
        None,
    )
}

fn fixture_db_for_payload_kind_with_source_token(
    parent_revision_id: &str,
    include_v1_edge: bool,
    parent_payload: Value,
    fixture_kind: ParentFixtureKind,
    persisted_source_token: Option<&str>,
) -> Database {
    // The typed API and D1 tables are intentionally missing on the frozen
    // base, so this setup is reached only after D1 publishes the contract.
    // Keeping the fixture executable (rather than ignored) makes that missing
    // seam a direct compile RED while still seeding a real parent on landing.
    let db = Database::new(std::path::Path::new(":memory:")).expect("open fixture database");
    db.migrate().expect("migrate fixture database");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, ?2)",
            rusqlite::params![PROJECT_A, "Project A"],
        )?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, ?2)",
            rusqlite::params![PROJECT_B, "Project B"],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, version, updated_at)
             VALUES (?1, ?2, 'scene', 'Arrival', '{\"body\":\"Arrival.\"}', 0,
                     '2026-01-01T00:00:00.000Z')",
            rusqlite::params![SCENE_ID, PROJECT_A],
        )?;
        Ok(())
    })
    .expect("seed fixture projects");

    narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some(RUN_ID.to_owned()),
            project_id: PROJECT_A.to_owned(),
            surface_path_id: "chronicle.extract".to_owned(),
            scope_json: json!({}),
            spec_json: json!({"domain": "chronicle"}),
            spec_digest: "spec:run-human".to_owned(),
            snapshot_digest: Some("snapshot-human-v2".to_owned()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(TASK_ID.to_owned()),
                task_kind: "chronicle.plan-proposals".to_owned(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("seed Human run and task");

    let source_revision_token = source_revision_token(&db);
    let mut parent_scope = parent_scope_for_payload(&parent_payload);
    if fixture_kind == ParentFixtureKind::C2B {
        parent_scope["scene"]["ref"] = json!(format!("scene:{SCENE_ID}"));
    }
    let envelope =
        parent_envelope_with_payload(&source_revision_token, &parent_payload, &parent_scope);
    let envelope_json = canonical_json_string(&envelope).expect("canonical parent Envelope");
    let envelope_digest = digest(&envelope);
    let payload_json = canonical_json_string(&parent_payload).expect("canonical proposal");
    let read_set_json =
        serde_json::to_string(&vec![source_revision_token.clone()]).expect("parent read set JSON");
    let persisted_source_token = persisted_source_token.unwrap_or(&source_revision_token);

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_proposal_sets
                (id, run_id, project_id, set_kind, summary_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'chronicle.extract.review@1', '{}', ?4, ?4)",
            rusqlite::params![
                "set-proposal-human",
                RUN_ID,
                PROJECT_A,
                DECLARATION_CREATED_AT
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposals
                (id, proposal_set_id, proposal_key, kind, status, payload_json,
                 current_revision_id, created_at, updated_at)
             VALUES (?1, 'set-proposal-human', 'event:arrival:0',
                     'chronicle.create-event@1', 'unreviewed', ?2, ?3, ?4, ?4)",
            rusqlite::params![
                PROPOSAL_ID,
                payload_json,
                parent_revision_id,
                DECLARATION_CREATED_AT
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposal_revisions
                (id, proposal_id, revision_number, payload_json, origin_kind,
                 reconciliation_envelope_json, reconciliation_envelope_digest,
                 created_at, created_by)
             VALUES (?1, ?2, 1, ?3, 'enveloped', ?4, ?5, ?6, 'chronicle')",
            rusqlite::params![
                parent_revision_id,
                PROPOSAL_ID,
                payload_json,
                envelope_json,
                envelope_digest,
                DECLARATION_CREATED_AT
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_revision_source_basis
                (revision_id, ordinal, source_kind, source_key, revision_token)
             VALUES (?1, 0, 'scene-body', ?2, ?3)",
            rusqlite::params![parent_revision_id, source_key(), persisted_source_token],
        )?;
        if include_v1_edge {
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at, owning_run_id)
                 VALUES (?1, ?2, 'proposal-revision', ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    format!("edge-{parent_revision_id}"),
                    PROJECT_A,
                    parent_revision_id,
                    source_key(),
                    read_set_json,
                    DECLARATION_CREATED_AT,
                    RUN_ID
                ],
            )?;
        }
        Ok(())
    })
    .expect("seed V2 parent revision and source basis");

    let declarations = match fixture_kind {
        ParentFixtureKind::C2A => vec![DependencyDeclaration {
            source_object_identity: source_key(),
            role: DependencyRole::DirectEvidence,
            selector: DependencySelector::WholeSource,
        }],
        ParentFixtureKind::C2B => vec![
            DependencyDeclaration {
                source_object_identity: source_key(),
                role: DependencyRole::DirectEvidence,
                selector: DependencySelector::WholeSource,
            },
            DependencyDeclaration {
                source_object_identity: "component:chronicle.event-synthesis.prompt".to_owned(),
                role: DependencyRole::ComponentContract,
                selector: DependencySelector::ComponentContract {
                    contract_id: "chronicle.event-synthesis.prompt".to_owned(),
                    contract_digest: parent_component_contract_digest(),
                },
            },
        ],
    };
    let declaration_producer_id = match fixture_kind {
        ParentFixtureKind::C2A => DECLARATION_PRODUCER_ID,
        ParentFixtureKind::C2B => C2B_DECLARATION_PRODUCER_ID,
    };
    let declaration_receipt = write_dependency_declaration_set(
        &db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT_A.to_owned(),
            consumer_kind: "proposal-revision".to_owned(),
            consumer_key: parent_revision_id.to_owned(),
            producer_id: declaration_producer_id.to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations,
            created_at: DECLARATION_CREATED_AT.to_owned(),
        },
    )
    .expect("seed D1 sealed declaration set and active head");
    db.with_conn(|conn| {
        let head: (String, String, i64, i64) = conn.query_row(
            "SELECT active_declaration_set_id, producer_id,
                    producer_generation, version
               FROM narrative_dependency_declaration_heads
              WHERE project_id = ?1
                AND consumer_kind = 'proposal-revision'
                AND consumer_key = ?2",
            rusqlite::params![PROJECT_A, parent_revision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(head.0, declaration_receipt.declaration_set_id);
        assert_eq!(head.1, declaration_producer_id);
        assert_eq!(head.2, 1);
        assert_eq!(head.3, declaration_receipt.head_version);
        Ok::<_, anyhow::Error>(())
    })
    .expect("inspect D1 active declaration head");
    if fixture_kind == ParentFixtureKind::C2B {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES (?1, ?2, 0, 'initial', ?3)",
                rusqlite::params![C2B_EPOCH_ID, PROJECT_A, DECLARATION_CREATED_AT],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed C2B current semantic epoch");
    }
    db
}

fn source_revision_token(db: &Database) -> String {
    db.with_conn(|conn| {
        let (version, updated_at): (i64, String) = conn.query_row(
            "SELECT version, updated_at FROM tree_nodes WHERE id = ?1",
            [SCENE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(format!("v{version}@{updated_at}"))
    })
    .expect("resolve scene-body token")
}

fn parent_envelope_digest(db: &Database) -> String {
    persisted_parent_envelope_digest_for(db, PARENT_REVISION_ID)
}

fn persisted_parent_envelope_digest_for(db: &Database, revision_id: &str) -> String {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT reconciliation_envelope_digest
               FROM narrative_proposal_revisions
              WHERE id = ?1 AND proposal_id = ?2",
            rusqlite::params![revision_id, PROPOSAL_ID],
            |row| row.get(0),
        )?)
    })
    .expect("read persisted parent envelope digest")
}

fn advance_source(db: &Database) -> (String, String) {
    let before = source_revision_token(db);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes
                SET version = version + 1,
                    content = '{\"body\":\"Arrival changed.\"}',
                    updated_at = '2099-01-01T00:00:00.000Z'
              WHERE id = ?1",
            [SCENE_ID],
        )?;
        Ok(())
    })
    .expect("advance scene-body source");
    (before, source_revision_token(db))
}

fn proposal_payload() -> Value {
    json!({
        "eventId": "event:arrival",
        "title": "Arrival",
        "note": null,
        "actuality": "actual",
        "significance": "major",
        "evidenceAnchorIds": ["anchor:arrival"],
        "evidenceDocumentRefs": ["document:1"],
        "disclosure": {"secret": false, "revealDocumentRef": "document:1"},
        "unresolvedMetadata": {
            "participantSurfaces": [],
            "locationSurface": null,
            "temporalExpressions": []
        }
    })
}

fn parent_scope_for_payload(payload: &Value) -> Value {
    let secret = payload["disclosure"]["secret"]
        .as_bool()
        .expect("parent disclosure secret");
    if !secret {
        return parent_scope();
    }
    let document_ref = payload["disclosure"]["revealDocumentRef"]
        .as_str()
        .expect("parent reveal document");
    let basis = json!({
        "status": "resolved",
        "documentRef": document_ref,
        "audienceRef": "reader-doc2",
        "readingOrder": {
            "from": {"ref": "reading:2", "inclusive": true},
            "until": {"ref": "reading:4", "inclusive": false}
        },
        "storyTime": {
            "from": {"ref": "story:2", "inclusive": true},
            "until": {"ref": "story:5", "inclusive": false}
        }
    });
    derive_chronicle_scene_event_scope("scene:1", payload, &basis)
        .expect("derive explicit parent reveal scope")
        .scope
}

fn request(
    current_revision_id: &str,
    parent_revision_id: &str,
    parent_envelope_digest: &str,
) -> CreateHumanDerivedRevisionRequest {
    request_with_payload(
        current_revision_id,
        parent_revision_id,
        parent_envelope_digest,
        proposal_payload(),
    )
}

fn request_with_payload(
    current_revision_id: &str,
    parent_revision_id: &str,
    parent_envelope_digest: &str,
    proposal_payload: Value,
) -> CreateHumanDerivedRevisionRequest {
    CreateHumanDerivedRevisionRequest {
        proposal_id: PROPOSAL_ID.to_owned(),
        expected_current_revision_id: current_revision_id.to_owned(),
        parent_revision_id: parent_revision_id.to_owned(),
        expected_parent_envelope_digest: parent_envelope_digest.to_owned(),
        proposal_payload,
        adapter: NarrativeAdapterIdentity {
            id: ADAPTER_ID.to_owned(),
            version: ADAPTER_VERSION.to_owned(),
        },
        surface_id: SURFACE_ID.to_owned(),
    }
}

fn submit(
    db: &Database,
    trusted_project_id: &str,
    request: CreateHumanDerivedRevisionRequest,
) -> Result<Value> {
    // The project boundary is deliberately a separate trusted Native
    // argument. The request cannot smuggle a project or actor identity.
    narrative_extraction_create_human_derived_revision(db, trusted_project_id, request)
}

fn submit_with_scope(
    db: &Database,
    trusted_project_id: &str,
    trusted_scope: Option<TrustedHumanDerivationScope>,
    request: CreateHumanDerivedRevisionRequest,
) -> Result<Value> {
    narrative_extraction_create_human_derived_revision_with_scope(
        db,
        trusted_project_id,
        trusted_scope,
        request,
    )
}

fn assert_code(result: Result<Value>, expected_code: &str) {
    let error = result.expect_err("negative Human Derivation case must fail");
    assert!(
        error.to_string().contains(expected_code),
        "expected {expected_code}, got {error:#}"
    );
}

fn golden_case(case_id: &str) -> Value {
    let corpus: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../policies/narrative/fixtures/narrative-ir/chronicle-scene-event-v2.json"
    )))
    .expect("read shared Chronicle golden corpus");
    corpus["cases"]
        .as_array()
        .expect("golden cases")
        .iter()
        .find(|case| case["id"] == case_id)
        .cloned()
        .expect("golden scope case")
}

fn golden_parent_payload(case_id: &str) -> Value {
    golden_case(case_id)["input"]["parentPayload"].clone()
}

fn golden_edited_payload(case_id: &str) -> Value {
    golden_case(case_id)["input"]["editedPayload"].clone()
}

fn trusted_scope_for_case(db: &Database, case_id: &str) -> TrustedHumanDerivationScope {
    let case = golden_case(case_id);
    let input = &case["input"];
    let edited_document_ref = input["editedPayload"]["disclosure"]["revealDocumentRef"]
        .as_str()
        .expect("golden edited reveal document")
        .to_owned();
    trusted_scope_with_basis(
        db,
        input["sceneRef"].as_str().expect("golden scene ref"),
        &edited_document_ref,
        trusted_reveal_basis(&input["revealBasis"]),
    )
}

fn trusted_scope_with_basis(
    db: &Database,
    scene_ref: &str,
    edited_document_ref: &str,
    reveal_basis: TrustedRevealBasis,
) -> TrustedHumanDerivationScope {
    let source_revision_token = source_revision_token(db);
    let source_revision_digest = digest(&json!({
        "sourceKind": "scene-body",
        "sourceKey": source_key(),
        "revisionToken": source_revision_token.clone()
    }));
    TrustedHumanDerivationScope {
        project_id: PROJECT_A.to_owned(),
        parent_revision_id: PARENT_REVISION_ID.to_owned(),
        expected_parent_envelope_digest: parent_envelope_digest(db),
        edited_document_ref: edited_document_ref.to_owned(),
        source_key: source_key(),
        source_revision_token,
        source_revision_digest,
        scene_ref: scene_ref.to_owned(),
        reveal_basis,
    }
}

fn trusted_reveal_basis(value: &Value) -> TrustedRevealBasis {
    match value["status"].as_str().expect("golden reveal status") {
        "not-secret" => TrustedRevealBasis::NotSecret,
        "resolved" => TrustedRevealBasis::Resolved {
            document_ref: value["documentRef"]
                .as_str()
                .expect("resolved document ref")
                .to_owned(),
            audience_ref: value["audienceRef"]
                .as_str()
                .expect("resolved audience ref")
                .to_owned(),
            reading_order: trusted_interval(&value["readingOrder"]),
            story_time: trusted_interval(&value["storyTime"]),
        },
        "unresolved" => TrustedRevealBasis::Unresolved {
            document_ref: value["documentRef"]
                .as_str()
                .expect("unresolved document ref")
                .to_owned(),
            audience: trusted_unresolved(&value["audience"]),
            reading_order: trusted_unresolved(&value["readingOrder"]),
        },
        status => panic!("unexpected golden reveal status: {status}"),
    }
}

fn trusted_interval(value: &Value) -> TrustedScopeInterval {
    TrustedScopeInterval {
        from: value.get("from").map(trusted_boundary),
        until: value.get("until").map(trusted_boundary),
    }
}

fn trusted_boundary(value: &Value) -> TrustedScopeBoundary {
    TrustedScopeBoundary {
        reference: value["ref"]
            .as_str()
            .expect("golden boundary ref")
            .to_owned(),
        inclusive: value["inclusive"]
            .as_bool()
            .expect("golden boundary inclusivity"),
    }
}

fn trusted_unresolved(value: &Value) -> TrustedUnresolvedConstraint {
    TrustedUnresolvedConstraint {
        reason: value["reason"]
            .as_str()
            .expect("golden unresolved reason")
            .to_owned(),
        constraint_id: value["constraintId"]
            .as_str()
            .expect("golden unresolved constraint id")
            .to_owned(),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct C2BStateSnapshot {
    current_revision_id: Option<String>,
    revision_count: i64,
    semantic_epoch_count: i64,
    current_epoch_id: Option<String>,
    consumer_freshness_count: i64,
    projection_freshness_count: i64,
    edge_state_count: i64,
    declaration_set_count: i64,
    declaration_head_count: i64,
    declaration_entry_count: i64,
    dependency_edge_count: i64,
    run_count: i64,
    task_count: i64,
    attempt_count: i64,
    cursor_count: i64,
    run_rows: Vec<Vec<String>>,
    task_rows: Vec<Vec<String>>,
    attempt_rows: Vec<Vec<String>>,
    cursor_rows: Vec<Vec<String>>,
    semantic_epoch_rows: Vec<Vec<String>>,
}

fn exact_table_rows(
    conn: &rusqlite::Connection,
    table: &str,
) -> rusqlite::Result<Vec<Vec<String>>> {
    assert!(matches!(
        table,
        "narrative_extraction_runs"
            | "narrative_extraction_tasks"
            | "narrative_extraction_attempts"
            | "narrative_change_cursors"
            | "narrative_semantic_epochs"
    ));
    let mut statement = conn.prepare(&format!("SELECT * FROM {table} ORDER BY 1"))?;
    let column_count = statement.column_count();
    let rows = statement
        .query_map([], |row| {
            (0..column_count)
                .map(|index| {
                    Ok(match row.get_ref(index)? {
                        ValueRef::Null => "null".to_owned(),
                        ValueRef::Integer(value) => format!("integer:{value}"),
                        ValueRef::Real(value) => format!("real:{:016x}", value.to_bits()),
                        ValueRef::Text(value) => format!("text:{value:?}"),
                        ValueRef::Blob(value) => format!("blob:{value:?}"),
                    })
                })
                .collect::<rusqlite::Result<Vec<_>>>()
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn c2b_state_snapshot(db: &Database) -> C2BStateSnapshot {
    db.with_conn(|conn| {
        let run_rows = exact_table_rows(conn, "narrative_extraction_runs")?;
        let task_rows = exact_table_rows(conn, "narrative_extraction_tasks")?;
        let attempt_rows = exact_table_rows(conn, "narrative_extraction_attempts")?;
        let cursor_rows = exact_table_rows(conn, "narrative_change_cursors")?;
        let semantic_epoch_rows = exact_table_rows(conn, "narrative_semantic_epochs")?;
        Ok(conn.query_row(
            "SELECT p.current_revision_id,
                    (SELECT COUNT(*) FROM narrative_proposal_revisions
                      WHERE proposal_id = ?1),
                    (SELECT COUNT(*) FROM narrative_semantic_epochs
                      WHERE project_id = ?2),
                    (SELECT id FROM narrative_semantic_epochs
                      WHERE project_id = ?2 ORDER BY epoch_number DESC LIMIT 1),
                    (SELECT COUNT(*) FROM narrative_consumer_freshness),
                    (SELECT COUNT(*) FROM narrative_projection_freshness),
                    (SELECT COUNT(*) FROM narrative_dependency_edge_states),
                    (SELECT COUNT(*) FROM narrative_dependency_declaration_sets),
                    (SELECT COUNT(*) FROM narrative_dependency_declaration_heads),
                    (SELECT COUNT(*) FROM narrative_dependency_declaration_entries),
                    (SELECT COUNT(*) FROM narrative_dependency_edges),
                    (SELECT COUNT(*) FROM narrative_extraction_runs),
                    (SELECT COUNT(*) FROM narrative_extraction_tasks),
                    (SELECT COUNT(*) FROM narrative_extraction_attempts),
                    (SELECT COUNT(*) FROM narrative_change_cursors)
               FROM narrative_proposals p
              WHERE p.id = ?3",
            rusqlite::params![PROPOSAL_ID, PROJECT_A, PROPOSAL_ID],
            |row| {
                Ok(C2BStateSnapshot {
                    current_revision_id: row.get(0)?,
                    revision_count: row.get(1)?,
                    semantic_epoch_count: row.get(2)?,
                    current_epoch_id: row.get(3)?,
                    consumer_freshness_count: row.get(4)?,
                    projection_freshness_count: row.get(5)?,
                    edge_state_count: row.get(6)?,
                    declaration_set_count: row.get(7)?,
                    declaration_head_count: row.get(8)?,
                    declaration_entry_count: row.get(9)?,
                    dependency_edge_count: row.get(10)?,
                    run_count: row.get(11)?,
                    task_count: row.get(12)?,
                    attempt_count: row.get(13)?,
                    cursor_count: row.get(14)?,
                    run_rows,
                    task_rows,
                    attempt_rows,
                    cursor_rows,
                    semantic_epoch_rows,
                })
            },
        )?)
    })
    .expect("snapshot C2B materialization state")
}

#[test]
fn accepts_native_verified_human_request_and_persists_native_human_actor() {
    let db = fixture_db();
    let before: (String, i64, i64, i64, i64, i64, i64, i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT p.current_revision_id,
                        (SELECT COUNT(*) FROM narrative_semantic_epochs),
                        (SELECT COUNT(*) FROM narrative_consumer_freshness),
                        (SELECT COUNT(*) FROM narrative_projection_freshness),
                        (SELECT COUNT(*) FROM narrative_dependency_edge_states),
                        (SELECT COUNT(*) FROM narrative_dependency_declaration_sets
                          WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1),
                        (SELECT COUNT(*) FROM narrative_dependency_declaration_heads
                          WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1),
                        (SELECT COUNT(*) FROM narrative_dependency_declaration_entries e
                           JOIN narrative_dependency_declaration_sets s
                             ON s.id = e.declaration_set_id
                          WHERE s.consumer_kind = 'proposal-revision' AND s.consumer_key = ?1),
                        (SELECT COUNT(*) FROM narrative_dependency_edges
                          WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1)
                   FROM narrative_proposals p
                  WHERE p.id = ?2",
                rusqlite::params![PARENT_REVISION_ID, PROPOSAL_ID],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )?)
        })
        .expect("snapshot dormant Human side effects before write");
    let saved = submit(
        &db,
        PROJECT_A,
        request(
            PARENT_REVISION_ID,
            PARENT_REVISION_ID,
            &parent_envelope_digest(&db),
        ),
    )
    .expect("valid typed Human request");

    let revision_id = saved["revisionId"].as_str().expect("saved revision id");
    let envelope_json: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT reconciliation_envelope_json
                   FROM narrative_proposal_revisions
                  WHERE id = ?1",
                [revision_id],
                |row| row.get(0),
            )?)
        })
        .expect("read persisted Human-derived revision");
    let envelope: Value = serde_json::from_str(&envelope_json).expect("stored Envelope JSON");
    // The writer, not the request, fixes the persisted actor and authority
    // scope.  The exact row shape is part of the typed-writer contract.
    assert_eq!(envelope["revisionBasis"]["revisionActor"]["kind"], "human");
    assert_eq!(
        envelope["revisionBasis"]["revisionActor"]["surfaceId"],
        SURFACE_ID
    );
    let child_revision_id = revision_id.to_owned();
    let after: (String, i64, i64, i64, i64, i64, i64, i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT p.current_revision_id,
                        (SELECT COUNT(*) FROM narrative_semantic_epochs),
                        (SELECT COUNT(*) FROM narrative_consumer_freshness),
                        (SELECT COUNT(*) FROM narrative_projection_freshness),
                        (SELECT COUNT(*) FROM narrative_dependency_edge_states),
                        (SELECT COUNT(*) FROM narrative_dependency_declaration_sets
                          WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1),
                        (SELECT COUNT(*) FROM narrative_dependency_declaration_heads
                          WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1),
                        (SELECT COUNT(*) FROM narrative_dependency_declaration_entries e
                           JOIN narrative_dependency_declaration_sets s
                             ON s.id = e.declaration_set_id
                          WHERE s.consumer_kind = 'proposal-revision' AND s.consumer_key = ?1),
                        (SELECT COUNT(*) FROM narrative_dependency_edges
                          WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1)
                   FROM narrative_proposals p
                  WHERE p.id = ?2",
                rusqlite::params![child_revision_id, PROPOSAL_ID],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )?)
        })
        .expect("snapshot dormant Human side effects after write");
    assert_eq!(
        after.0, before.0,
        "Human writer must not promote current revision"
    );
    assert_eq!(
        (after.1, after.2, after.3, after.4),
        (before.1, before.2, before.3, before.4),
        "Human writer must not initialize new C2B global state"
    );
    assert_eq!(
        (after.5, after.6, after.7, after.8),
        (0, 0, 0, 0),
        "Human writer must not initialize child declarations or edges"
    );
}

#[test]
fn title_only_human_derivation_preserves_parent_assertion_digests() {
    let db = fixture_db();
    let parent_digest = parent_envelope_digest(&db);
    let parent: Value = db
        .with_conn(|conn| {
            let json: String = conn.query_row(
                "SELECT reconciliation_envelope_json
                   FROM narrative_proposal_revisions
                  WHERE id = ?1",
                [PARENT_REVISION_ID],
                |row| row.get(0),
            )?;
            Ok(serde_json::from_str(&json)?)
        })
        .expect("read parent envelope");
    let mut edited = proposal_payload();
    edited["title"] = json!("Arrival at Dawn");
    let saved = submit(
        &db,
        PROJECT_A,
        request_with_payload(
            PARENT_REVISION_ID,
            PARENT_REVISION_ID,
            &parent_digest,
            edited,
        ),
    )
    .expect("title-only Human derivation");
    let child: Value = db
        .with_conn(|conn| {
            let json: String = conn.query_row(
                "SELECT reconciliation_envelope_json
                   FROM narrative_proposal_revisions
                  WHERE id = ?1",
                [saved["revisionId"].as_str().expect("child revision")],
                |row| row.get(0),
            )?;
            Ok(serde_json::from_str(&json)?)
        })
        .expect("read child envelope");
    for field in ["assertionCoreDigest", "scopeDigest", "assertionDigest"] {
        assert_eq!(
            child["assertionDigests"][field],
            parent["assertionDigests"][field]
        );
    }
    let context_entries = child["revisionBasis"]["derivationContextSet"]
        .as_array()
        .expect("projection derivation context set");
    assert!(context_entries
        .iter()
        .all(|entry| entry["contextId"] != "context:chronicle-scope-resolver"));
    // Inherited parent Contexts are carried verbatim under an explicit
    // lineage marker: the original model-visible exposure is preserved as
    // audit provenance instead of being renamed to author-supplied.
    let inherited = context_entries
        .iter()
        .find(|entry| entry["contextId"] == "context:event-synthesis")
        .expect("inherited parent context entry");
    assert_eq!(inherited["exposure"], "model-visible");
    assert_eq!(inherited["inheritedFromRevisionId"], PARENT_REVISION_ID);
    assert!(context_entries
        .iter()
        .all(|entry| entry["exposure"] != "author-supplied"));
}

#[test]
fn true_to_false_scope_override_fails_closed_without_persisting_a_child() {
    // A non-secret return does not need a reveal resolver, but any
    // scope-override child would still require a re-derived Material Basis
    // (§6.3). Until that materialization is wired, C2A fails closed.
    let parent_payload = golden_parent_payload("reveal-document-only-edit");
    let db = fixture_db_for_payload(PARENT_REVISION_ID, true, parent_payload);
    let parent_digest = parent_envelope_digest(&db);
    let mut edited = golden_parent_payload("reveal-document-only-edit");
    edited["disclosure"]["secret"] = json!(false);
    assert_code(
        submit_with_scope(
            &db,
            PROJECT_A,
            None,
            request_with_payload(
                PARENT_REVISION_ID,
                PARENT_REVISION_ID,
                &parent_digest,
                edited,
            ),
        ),
        "NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE",
    );
    let revision_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_revisions",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("count revisions");
    assert_eq!(revision_count, 1, "no scope-override child may persist");
}

#[test]
fn scope_override_fails_closed_after_trusted_scope_validation() {
    // Even a fully valid trusted Native reveal basis cannot yet persist a
    // scope-override child: the parent-cloned Envelope would omit the
    // scope-resolution Dependency and stale Material Basis digests (§6.3).
    // The trusted-scope authority checks still run first, so a forged
    // sidecar keeps its specific mismatch code (covered by the dedicated
    // mismatch tests); a well-formed override fails closed here.
    for case_id in [
        "secret-only-edit",
        "reveal-document-only-edit",
        "mixed-title-secret-uses-scope-override",
        "mixed-note-reveal-document-uses-scope-override",
    ] {
        let db = fixture_db_for_payload(PARENT_REVISION_ID, true, golden_parent_payload(case_id));
        let parent_digest = parent_envelope_digest(&db);
        let trusted_scope = trusted_scope_for_case(&db, case_id);
        let edited = golden_edited_payload(case_id);
        assert_code(
            submit_with_scope(
                &db,
                PROJECT_A,
                Some(trusted_scope),
                request_with_payload(
                    PARENT_REVISION_ID,
                    PARENT_REVISION_ID,
                    &parent_digest,
                    edited,
                ),
            ),
            "NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE",
        );
        let revision_count: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_revisions",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("count revisions");
        assert_eq!(
            revision_count, 1,
            "no scope-override child may persist for case {case_id}"
        );
    }
}

#[test]
fn unsupported_human_path_is_rejected_before_scope_derivation() {
    let db = fixture_db();
    let mut edited = proposal_payload();
    edited["actuality"] = json!("prevented");
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request_with_payload(
                PARENT_REVISION_ID,
                PARENT_REVISION_ID,
                &parent_envelope_digest(&db),
                edited,
            ),
        ),
        "NEX_HUMAN_DERIVATION_UNSUPPORTED_PATH",
    );
}

#[test]
fn secret_scope_override_without_trusted_reveal_basis_fails_closed() {
    let db = fixture_db();
    let parent_digest = parent_envelope_digest(&db);
    let mut edited = proposal_payload();
    edited["disclosure"]["secret"] = json!(true);
    edited["disclosure"]["revealDocumentRef"] = json!("document:3");
    assert_code(
        submit_with_scope(
            &db,
            PROJECT_A,
            None,
            request_with_payload(
                PARENT_REVISION_ID,
                PARENT_REVISION_ID,
                &parent_digest,
                edited,
            ),
        ),
        "NEX_HUMAN_DERIVATION_REVEAL_BASIS_UNAVAILABLE",
    );
}

#[test]
fn explicit_unresolved_reveal_basis_scope_override_fails_closed() {
    // An unresolved reveal basis is a valid trusted sidecar, but the
    // scope-override child it would produce still needs the §6.3 Material
    // Basis re-derivation, so C2A fails closed without persisting.
    let db = fixture_db();
    let parent_digest = parent_envelope_digest(&db);
    let mut edited = proposal_payload();
    edited["disclosure"]["secret"] = json!(true);
    edited["disclosure"]["revealDocumentRef"] = json!("document:missing");
    let unresolved_basis = trusted_reveal_basis(
        &golden_case("secret-event-with-unresolved-reveal")["input"]["revealBasis"],
    );
    let trusted_scope =
        trusted_scope_with_basis(&db, "scene:1", "document:missing", unresolved_basis);
    assert_code(
        submit_with_scope(
            &db,
            PROJECT_A,
            Some(trusted_scope),
            request_with_payload(
                PARENT_REVISION_ID,
                PARENT_REVISION_ID,
                &parent_digest,
                edited,
            ),
        ),
        "NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE",
    );
}

#[test]
fn mismatched_trusted_reveal_document_fails_closed() {
    let db = fixture_db();
    let parent_digest = parent_envelope_digest(&db);
    let mut edited = proposal_payload();
    edited["disclosure"]["secret"] = json!(true);
    edited["disclosure"]["revealDocumentRef"] = json!("document:3");
    let mut trusted_scope = trusted_scope_for_case(&db, "secret-only-edit");
    trusted_scope.expected_parent_envelope_digest = parent_digest.clone();
    trusted_scope.edited_document_ref = "document:wrong".to_owned();
    assert_code(
        submit_with_scope(
            &db,
            PROJECT_A,
            Some(trusted_scope),
            request_with_payload(
                PARENT_REVISION_ID,
                PARENT_REVISION_ID,
                &parent_digest,
                edited,
            ),
        ),
        "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH",
    );
}

#[test]
fn mismatched_trusted_scope_project_cas_or_source_fails_closed() {
    for mutate in ["project", "cas", "token", "digest"] {
        let db = fixture_db();
        let parent_digest = parent_envelope_digest(&db);
        let mut edited = proposal_payload();
        edited["disclosure"]["secret"] = json!(true);
        edited["disclosure"]["revealDocumentRef"] = json!("document:3");
        let mut trusted_scope = trusted_scope_for_case(&db, "secret-only-edit");
        trusted_scope.expected_parent_envelope_digest = parent_digest.clone();
        match mutate {
            "project" => trusted_scope.project_id = PROJECT_B.to_owned(),
            "cas" => trusted_scope.parent_revision_id = "revision-other".to_owned(),
            "token" => trusted_scope.source_revision_token = "v999@forged".to_owned(),
            "digest" => {
                trusted_scope.source_revision_digest =
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        .to_owned()
            }
            _ => unreachable!(),
        }
        assert_code(
            submit_with_scope(
                &db,
                PROJECT_A,
                Some(trusted_scope),
                request_with_payload(
                    PARENT_REVISION_ID,
                    PARENT_REVISION_ID,
                    &parent_digest,
                    edited,
                ),
            ),
            "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH",
        );
    }
}

#[test]
fn typed_human_request_rejects_forged_project_actor_and_derivation_fields() {
    let mut wire = serde_json::to_value(request(
        PARENT_REVISION_ID,
        PARENT_REVISION_ID,
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ))
    .expect("serialize typed request");
    let object = wire.as_object_mut().expect("typed request object");
    object.insert("projectId".to_owned(), json!(PROJECT_A));
    object.insert("actor".to_owned(), json!("forged-actor"));
    object.insert("derivation".to_owned(), json!({"kind": "forged"}));
    assert!(serde_json::from_value::<CreateHumanDerivedRevisionRequest>(wire).is_err());
}

#[test]
fn rejects_wrong_current_revision_with_cas_error() {
    let db = fixture_db();
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request(
                "revision-stale-current",
                PARENT_REVISION_ID,
                &parent_envelope_digest(&db),
            ),
        ),
        REVISION_CONFLICT,
    );
}

#[test]
fn rejects_wrong_parent_envelope_digest() {
    let db = fixture_db();
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request(
                PARENT_REVISION_ID,
                PARENT_REVISION_ID,
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ),
        ),
        PARENT_DIGEST_CONFLICT,
    );
}

#[test]
fn rejects_wrong_parent_revision_with_current_cas_correct() {
    let db = fixture_db();
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request(
                PARENT_REVISION_ID,
                "revision-not-current",
                &parent_envelope_digest(&db),
            ),
        ),
        PARENT_DIGEST_CONFLICT,
    );
}

#[test]
fn rejects_wrong_trusted_project_boundary() {
    let db = fixture_db();
    assert_code(
        submit(
            &db,
            PROJECT_B,
            request(
                PARENT_REVISION_ID,
                PARENT_REVISION_ID,
                &parent_envelope_digest(&db),
            ),
        ),
        PROJECT_MISMATCH,
    );
}

#[test]
fn rejects_a_forged_d1_head_even_when_the_head_foreign_key_is_valid() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_dependency_declaration_heads
                SET producer_id = 'forged-producer'
              WHERE project_id = ?1
                AND consumer_kind = 'proposal-revision'
                AND consumer_key = ?2",
            rusqlite::params![PROJECT_A, PARENT_REVISION_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("forge only the D1 head producer identity");
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request(
                PARENT_REVISION_ID,
                PARENT_REVISION_ID,
                &parent_envelope_digest(&db),
            ),
        ),
        DECLARATION_HEAD_UNAVAILABLE,
    );
}

#[test]
fn rejects_wrong_adapter_identity() {
    let db = fixture_db();
    let mut invalid = request(
        PARENT_REVISION_ID,
        PARENT_REVISION_ID,
        &parent_envelope_digest(&db),
    );
    invalid.adapter.id = "forged.adapter".to_owned();
    assert_code(submit(&db, PROJECT_A, invalid), ADAPTER_UNSUPPORTED);
}

#[test]
fn rejects_wrong_adapter_version() {
    let db = fixture_db();
    let mut invalid = request(
        PARENT_REVISION_ID,
        PARENT_REVISION_ID,
        &parent_envelope_digest(&db),
    );
    invalid.adapter.version = "999".to_owned();
    assert_code(submit(&db, PROJECT_A, invalid), ADAPTER_UNSUPPORTED);
}

#[test]
fn rejects_wrong_surface_identity() {
    let db = fixture_db();
    let mut invalid = request(
        PARENT_REVISION_ID,
        PARENT_REVISION_ID,
        &parent_envelope_digest(&db),
    );
    invalid.surface_id = "forged-surface".to_owned();
    assert_code(submit(&db, PROJECT_A, invalid), SURFACE_UNSUPPORTED);
}

#[test]
fn rejects_zero_edge_parent_without_c2b_child_declaration() {
    let db = zero_edge_fixture_db();
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request(
                "revision-zero-edge",
                "revision-zero-edge",
                &persisted_parent_envelope_digest_for(&db, "revision-zero-edge"),
            ),
        ),
        ZERO_EDGE,
    );
}

#[test]
fn stale_cas_is_distinct_from_stale_source_observation() {
    let db = fixture_db();
    // The request has no caller-owned source token. Native validates the
    // parent's observed token and keeps it immutable; this negative is only
    // the optimistic current-revision CAS boundary.
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request(
                "revision-old-observed",
                PARENT_REVISION_ID,
                &parent_envelope_digest(&db),
            ),
        ),
        REVISION_CONFLICT,
    );
}

#[test]
fn stale_resolver_parent_reaches_typed_writer_without_rewriting_observed_token() {
    let db = fixture_db();
    let observed_before = source_revision_token(&db);
    let parent_envelope_digest_before: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT reconciliation_envelope_digest
                   FROM narrative_proposal_revisions
                  WHERE id = ?1 AND proposal_id = ?2",
                rusqlite::params![PARENT_REVISION_ID, PROPOSAL_ID],
                |row| row.get(0),
            )?)
        })
        .expect("read persisted parent Envelope digest before source advance");
    let (before, observed_after) = advance_source(&db);
    assert_eq!(before, observed_before);
    assert_ne!(observed_before, observed_after);

    let saved = submit(
        &db,
        PROJECT_A,
        request(
            PARENT_REVISION_ID,
            PARENT_REVISION_ID,
            &parent_envelope_digest_before,
        ),
    )
    .expect("stale parent must reach the typed Human writer");
    let revision_id = saved["revisionId"].as_str().expect("saved revision id");
    let retained_token: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT revision_token
                   FROM narrative_revision_source_basis
                  WHERE revision_id = ?1
                  ORDER BY ordinal LIMIT 1",
                [revision_id],
                |row| row.get(0),
            )?)
        })
        .expect("read retained parent token");
    assert_eq!(retained_token, observed_before);
}

mod c2b_atomic_materialization_red {
    use super::*;
    use grimodex_core::canonical_json_string;
    use grimodex_core::narrative_dependency::{
        canonicalize_dependency_selector, compute_dependency_key, compute_dependency_set_digest,
        DependencySetDigestEntry,
    };
    use grimodex_db::narrative_extraction::{
        read_active_dependency_declaration_set, DependencyDeclarationSetState,
    };
    use serde_json::json;
    use sha2::{Digest, Sha256};

    fn c2b_request(db: &Database) -> CreateHumanDerivedRevisionRequest {
        request(
            PARENT_REVISION_ID,
            PARENT_REVISION_ID,
            &parent_envelope_digest(db),
        )
    }

    fn assert_execution_authority_unchanged(before: &C2BStateSnapshot, after: &C2BStateSnapshot) {
        assert_eq!(before.run_count, after.run_count);
        assert_eq!(before.task_count, after.task_count);
        assert_eq!(before.attempt_count, after.attempt_count);
        assert_eq!(before.cursor_count, after.cursor_count);
        assert_eq!(before.semantic_epoch_count, after.semantic_epoch_count);
        assert_eq!(before.current_epoch_id, after.current_epoch_id);
        assert_eq!(before.run_rows, after.run_rows);
        assert_eq!(before.task_rows, after.task_rows);
        assert_eq!(before.attempt_rows, after.attempt_rows);
        assert_eq!(before.cursor_rows, after.cursor_rows);
        assert_eq!(before.semantic_epoch_rows, after.semantic_epoch_rows);
    }

    fn projection_source_basis(
        db: &Database,
        revision_id: &str,
    ) -> Vec<(i64, String, String, String, Option<String>)> {
        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT ordinal, source_kind, source_key, revision_token, observed_at
                   FROM narrative_revision_source_basis
                  WHERE revision_id = ?1
                  ORDER BY ordinal",
            )?;
            let rows = statement
                .query_map([revision_id], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("read projected SourceBasis")
    }

    fn canonical_whole_source_selector() -> String {
        canonical_json_string(&json!({"kind": "whole-source"})).expect("canonical selector")
    }

    fn canonical_component_selector() -> String {
        canonical_json_string(&json!({
            "kind": "component-contract",
            "contractId": "chronicle.event-synthesis.prompt",
            "contractDigest": parent_component_contract_digest()
        }))
        .expect("canonical component selector")
    }

    fn v1_identity_set_digest(identities: &[String]) -> String {
        let mut sorted = identities.iter().map(String::as_str).collect::<Vec<_>>();
        sorted.sort_unstable();
        let mut canonical = String::new();
        for identity in sorted {
            canonical.push_str(&identity.len().to_string());
            canonical.push(':');
            canonical.push_str(identity);
            canonical.push('\n');
        }
        hex::encode(Sha256::digest(canonical.as_bytes()))
    }

    fn d1_digest_entry(
        source_object_identity: String,
        role: &str,
        selector: &DependencySelector,
    ) -> DependencySetDigestEntry {
        let selector_json =
            canonicalize_dependency_selector(selector).expect("canonical D1 selector");
        DependencySetDigestEntry {
            source_object_identity,
            dependency_key: compute_dependency_key(role, selector).expect("canonical D1 key"),
            selector_digest: format!(
                "sha256:{}",
                hex::encode(Sha256::digest(selector_json.as_bytes()))
            ),
        }
    }

    fn install_child_revision_dml_guard(db: &Database) {
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TEMP TRIGGER c2b_test_abort_child_revision_dml
                   BEFORE INSERT ON narrative_proposal_revisions
                   BEGIN
                       SELECT RAISE(ABORT, 'C2B_TEST_CHILD_DML_REACHED');
                   END;

                 CREATE TEMP TRIGGER c2b_test_abort_proposal_dml
                   BEFORE UPDATE ON narrative_proposals
                   BEGIN
                       SELECT RAISE(ABORT, 'C2B_TEST_PROPOSAL_DML_REACHED');
                   END;",
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("install child-revision DML guard");
    }

    fn install_final_pointer_cas_order_guard(db: &Database) {
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TEMP TRIGGER c2b_test_require_material_before_pointer
                   BEFORE UPDATE OF payload_json, current_revision_id ON narrative_proposals
                   WHEN OLD.id = 'proposal-human'
                    AND (NEW.payload_json IS NOT OLD.payload_json
                         OR NEW.current_revision_id IS NOT OLD.current_revision_id)
                   BEGIN
                       SELECT CASE WHEN
                           NEW.payload_json IS NOT OLD.payload_json
                           AND NEW.current_revision_id IS OLD.current_revision_id
                           THEN RAISE(ABORT, 'C2B_TEST_PAYLOAD_PROMOTION_NOT_ATOMIC')
                       END;
                       SELECT CASE WHEN
                           NOT EXISTS (
                               SELECT 1 FROM narrative_revision_source_basis b
                                WHERE b.revision_id = NEW.current_revision_id
                           )
                           OR NOT EXISTS (
                               SELECT 1 FROM narrative_dependency_edges e
                                WHERE e.project_id = 'project-a'
                                  AND e.consumer_kind = 'proposal-revision'
                                  AND e.consumer_key = NEW.current_revision_id
                           )
                           OR NOT EXISTS (
                               SELECT 1
                                 FROM narrative_dependency_declaration_heads h
                                 JOIN narrative_dependency_declaration_sets s
                                   ON s.id = h.active_declaration_set_id
                                WHERE h.project_id = 'project-a'
                                  AND h.consumer_kind = 'proposal-revision'
                                  AND h.consumer_key = NEW.current_revision_id
                                  AND s.state = 'sealed'
                           )
                           OR NOT EXISTS (
                               SELECT 1
                                 FROM narrative_dependency_edges e
                                 JOIN narrative_dependency_edge_states s ON s.edge_id = e.id
                                WHERE e.project_id = 'project-a'
                                  AND e.consumer_kind = 'proposal-revision'
                                  AND e.consumer_key = NEW.current_revision_id
                           )
                           OR NOT EXISTS (
                               SELECT 1 FROM narrative_consumer_freshness f
                                WHERE f.project_id = 'project-a'
                                  AND f.consumer_kind = 'proposal-revision'
                                  AND f.consumer_key = NEW.current_revision_id
                           )
                           THEN RAISE(ABORT, 'C2B_TEST_POINTER_BEFORE_MATERIALIZATION')
                       END;
                   END;",
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("install final pointer-CAS order guard");
    }

    fn install_post_freshness_pointer_competitor(db: &Database) {
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, summary_json, created_at, updated_at)
                 VALUES ('set-competing-c2b', 'run-human', 'project-a',
                         'chronicle.extract.review@1', '{}',
                         '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z');

                 INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, status, payload_json,
                     current_revision_id, created_at, updated_at)
                 SELECT 'proposal-competing-c2b', 'set-competing-c2b', 'event:competing:0',
                        kind, status, payload_json, 'revision-competing-c2b',
                        created_at, updated_at
                   FROM narrative_proposals
                  WHERE id = 'proposal-human';

                 INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, origin_kind,
                     reconciliation_envelope_json, reconciliation_envelope_digest,
                     created_at, created_by)
                 SELECT 'revision-competing-c2b', 'proposal-competing-c2b', 1,
                        payload_json, 'enveloped',
                        reconciliation_envelope_json, reconciliation_envelope_digest,
                        created_at, created_by
                   FROM narrative_proposal_revisions
                  WHERE id = 'revision-parent' AND proposal_id = 'proposal-human';

                 CREATE TEMP TRIGGER c2b_test_compete_after_freshness
                    AFTER INSERT ON narrative_consumer_freshness
                    WHEN NEW.project_id = 'project-a'
                     AND NEW.consumer_kind = 'proposal-revision'
                     AND NEW.consumer_key <> 'revision-parent'
                    BEGIN
                        UPDATE narrative_proposals
                           SET current_revision_id = 'revision-competing-c2b'
                         WHERE id = 'proposal-human'
                           AND current_revision_id = 'revision-parent';
                    END;",
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("install post-Freshness competing pointer");
    }

    fn scope_override_request(db: &Database) -> CreateHumanDerivedRevisionRequest {
        let mut edited = proposal_payload();
        edited["disclosure"]["secret"] = json!(true);
        request_with_payload(
            PARENT_REVISION_ID,
            PARENT_REVISION_ID,
            &parent_envelope_digest(db),
            edited,
        )
    }

    #[test]
    fn c2b_projection_materializes_exact_child_basis_v1_d1_epoch_and_runless_freshness() {
        let db = c2b_projection_fixture_db();
        let before_execution = c2b_state_snapshot(&db);
        install_final_pointer_cas_order_guard(&db);
        let saved =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                c2b_request(&db),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect("C2B projection-only materialization");
        let child_revision_id = saved["revisionId"]
            .as_str()
            .expect("C2B child revision id")
            .to_owned();
        let after_execution = c2b_state_snapshot(&db);
        assert_execution_authority_unchanged(&before_execution, &after_execution);

        let current_revision_id: String = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT current_revision_id FROM narrative_proposals WHERE id = ?1",
                    [PROPOSAL_ID],
                    |row| row.get(0),
                )?)
            })
            .expect("read promoted current revision");
        assert_eq!(current_revision_id, child_revision_id);

        assert_eq!(
            projection_source_basis(&db, &child_revision_id),
            vec![(
                (0_i64),
                "scene-body".to_owned(),
                source_key(),
                source_revision_token(&db),
                None,
            )]
        );

        let v1_edges: Vec<(String, String, String, String, String, Option<String>)> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT project_id, consumer_kind, consumer_key, source_object_identity,
                        read_set_json, owning_run_id
                   FROM narrative_dependency_edges
                  WHERE project_id = ?1
                    AND consumer_kind = 'proposal-revision'
                    AND consumer_key = ?2
                  ORDER BY source_object_identity",
                )?;
                let rows = statement
                    .query_map(rusqlite::params![PROJECT_A, child_revision_id], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read projected V1 edges");
        assert_eq!(
            v1_edges,
            vec![(
                PROJECT_A.to_owned(),
                "proposal-revision".to_owned(),
                child_revision_id.clone(),
                source_key(),
                serde_json::to_string(&vec![source_revision_token(&db)]).expect("V1 read set"),
                Some(RUN_ID.to_owned()),
            )]
        );

        #[allow(clippy::type_complexity)]
        let d1_entries: Vec<(String, String, String, i64, String, String, String, String)> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT s.consumer_kind, s.consumer_key, s.producer_id,
                            s.producer_generation, s.state, e.source_object_identity,
                            e.dependency_role, e.selector_json
                       FROM narrative_dependency_declaration_sets s
                       JOIN narrative_dependency_declaration_entries e
                         ON e.declaration_set_id = s.id
                      WHERE s.project_id = ?1
                        AND s.consumer_kind = 'proposal-revision'
                        AND s.consumer_key = ?2
                      ORDER BY e.source_object_identity",
                )?;
                let rows = statement
                    .query_map(rusqlite::params![PROJECT_A, child_revision_id], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read projected D1 entries");
        assert_eq!(
            d1_entries,
            vec![
                (
                    "proposal-revision".to_owned(),
                    child_revision_id.clone(),
                    C2B_DECLARATION_PRODUCER_ID.to_owned(),
                    1,
                    "sealed".to_owned(),
                    "component:chronicle.event-synthesis.prompt".to_owned(),
                    "component-contract".to_owned(),
                    canonical_component_selector(),
                ),
                (
                    "proposal-revision".to_owned(),
                    child_revision_id.clone(),
                    C2B_DECLARATION_PRODUCER_ID.to_owned(),
                    1,
                    "sealed".to_owned(),
                    source_key(),
                    "direct-evidence".to_owned(),
                    canonical_whole_source_selector(),
                ),
            ]
        );

        let component_selector = DependencySelector::ComponentContract {
            contract_id: "chronicle.event-synthesis.prompt".to_owned(),
            contract_digest: parent_component_contract_digest(),
        };
        let expected_d1_digest = compute_dependency_set_digest(&[
            d1_digest_entry(
                "component:chronicle.event-synthesis.prompt".to_owned(),
                "component-contract",
                &component_selector,
            ),
            d1_digest_entry(
                source_key(),
                "direct-evidence",
                &DependencySelector::WholeSource,
            ),
        ])
        .expect("expected child D1 digest");
        let active_d1 = read_active_dependency_declaration_set(
            &db,
            PROJECT_A,
            "proposal-revision",
            &child_revision_id,
        )
        .expect("read child active D1 head")
        .expect("child active D1 head must exist");
        assert_eq!(active_d1.project_id, PROJECT_A);
        assert_eq!(active_d1.consumer_kind, "proposal-revision");
        assert_eq!(active_d1.consumer_key, child_revision_id);
        assert_eq!(active_d1.producer_id, C2B_DECLARATION_PRODUCER_ID);
        assert_eq!(active_d1.producer_generation, 1);
        assert_eq!(active_d1.state, DependencyDeclarationSetState::Sealed);
        assert_eq!(active_d1.dependency_set_digest, expected_d1_digest);
        assert_eq!(active_d1.entries.len(), 2);
        let active_head: (String, String, i64, i64) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT active_declaration_set_id, producer_id,
                            producer_generation, version
                       FROM narrative_dependency_declaration_heads
                      WHERE project_id = ?1
                        AND consumer_kind = 'proposal-revision'
                        AND consumer_key = ?2",
                    rusqlite::params![PROJECT_A, child_revision_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?)
            })
            .expect("read child D1 head identity");
        assert_eq!(active_head.0, active_d1.declaration_set_id);
        assert_eq!(active_head.1, C2B_DECLARATION_PRODUCER_ID);
        assert_eq!(active_head.2, 1);
        assert_eq!(active_head.3, 1);

        let edge_states: Vec<(String, String, String, String)> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT e.source_object_identity, s.evidence_freshness,
                            s.build_action, s.evaluated_at_epoch_id
                       FROM narrative_dependency_edges e
                       JOIN narrative_dependency_edge_states s ON s.edge_id = e.id
                      WHERE e.project_id = ?1
                        AND e.consumer_kind = 'proposal-revision'
                        AND e.consumer_key = ?2
                      ORDER BY e.source_object_identity",
                )?;
                let rows = statement
                    .query_map(rusqlite::params![PROJECT_A, child_revision_id], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read projected current-epoch edge states");
        assert_eq!(
            edge_states,
            vec![(
                source_key(),
                "fresh".to_owned(),
                "none".to_owned(),
                C2B_EPOCH_ID.to_owned(),
            )]
        );

        let expected_v1_dependency_set_digest = v1_identity_set_digest(&[source_key()]);
        let consumer_freshness: (String, String, String, Option<String>, String) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT evidence_freshness, build_action, semantic_epoch_id,
                            last_evaluated_run_id, dependency_set_digest
                       FROM narrative_consumer_freshness
                      WHERE project_id = ?1
                        AND consumer_kind = 'proposal-revision'
                        AND consumer_key = ?2",
                    rusqlite::params![PROJECT_A, child_revision_id],
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
            .expect("read projected Consumer Freshness");
        assert_eq!(
            consumer_freshness,
            (
                "fresh".to_owned(),
                "none".to_owned(),
                C2B_EPOCH_ID.to_owned(),
                None,
                expected_v1_dependency_set_digest,
            )
        );
    }

    #[test]
    fn c2b_scope_override_without_native_authority_fails_before_any_dml() {
        let db = c2b_projection_fixture_db();
        install_child_revision_dml_guard(&db);
        let before = c2b_state_snapshot(&db);
        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                c2b_request(&db),
                HumanMaterialDerivationKind::ScopeOverride,
            )
            .expect_err("C2B scope override must fail closed without Native authority");
        assert!(
            error
                .to_string()
                .contains("NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE"),
            "unexpected C2B scope error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_projection_freshness_trigger_rolls_back_every_materialization_side_effect() {
        let db = c2b_projection_fixture_db();
        let before = c2b_state_snapshot(&db);
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TEMP TRIGGER c2b_test_abort_freshness
                   BEFORE INSERT ON narrative_consumer_freshness
                   BEGIN
                       SELECT RAISE(ABORT, 'C2B_TEST_FRESHNESS_ABORT');
                   END;",
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("install test-only Freshness abort trigger");

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                c2b_request(&db),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect_err("Freshness trigger must abort C2B materialization");
        assert!(
            error.to_string().contains("C2B_TEST_FRESHNESS_ABORT"),
            "unexpected Freshness trigger error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_scope_affecting_payload_cannot_lie_as_projection_only() {
        let db = c2b_projection_fixture_db();
        let mut edited = proposal_payload();
        edited["disclosure"]["secret"] = json!(true);
        install_child_revision_dml_guard(&db);
        let before = c2b_state_snapshot(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                request_with_payload(
                    PARENT_REVISION_ID,
                    PARENT_REVISION_ID,
                    &parent_envelope_digest(&db),
                    edited,
                ),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect_err("scope-affecting payload must not enter projection-only C2B");
        assert!(
            error
                .to_string()
                .contains("NEX_C2B_DERIVATION_KIND_MISMATCH")
                || error
                    .to_string()
                    .contains("NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE"),
            "unexpected scope classification error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_scope_override_materializes_live_scope_authority_and_all_child_authorities_atomically() {
        let db = c2b_projection_fixture_db();
        install_final_pointer_cas_order_guard(&db);

        let saved =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                scope_override_request(&db),
                HumanMaterialDerivationKind::ScopeOverride,
            )
            .expect("live ScopeOverride materialization");
        let child_revision_id = saved["revisionId"]
            .as_str()
            .expect("ScopeOverride child revision id")
            .to_owned();

        let (child_envelope, source_rows, edge_count, scope_declaration_count, freshness_count): (
            Value,
            Vec<(String, String, String)>,
            i64,
            i64,
            i64,
        ) = db
            .with_conn(|conn| {
                let envelope_json: String = conn.query_row(
                    "SELECT reconciliation_envelope_json
                       FROM narrative_proposal_revisions
                      WHERE id = ?1",
                    [child_revision_id.as_str()],
                    |row| row.get(0),
                )?;
                let mut statement = conn.prepare(
                    "SELECT source_kind, source_key, revision_token
                       FROM narrative_revision_source_basis
                      WHERE revision_id = ?1
                      ORDER BY ordinal",
                )?;
                let source_rows = statement
                    .query_map([child_revision_id.as_str()], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let edge_count: i64 = conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_dependency_edges
                      WHERE project_id = ?1
                        AND consumer_kind = 'proposal-revision'
                        AND consumer_key = ?2",
                    rusqlite::params![PROJECT_A, child_revision_id],
                    |row| row.get(0),
                )?;
                let scope_declaration_count: i64 = conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_dependency_declaration_entries e
                       JOIN narrative_dependency_declaration_sets s
                         ON s.id = e.declaration_set_id
                      WHERE s.project_id = ?1
                        AND s.consumer_kind = 'proposal-revision'
                        AND s.consumer_key = ?2
                        AND e.dependency_role = 'scope-resolution'",
                    rusqlite::params![PROJECT_A, child_revision_id],
                    |row| row.get(0),
                )?;
                let freshness_count: i64 = conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_consumer_freshness
                      WHERE project_id = ?1
                        AND consumer_kind = 'proposal-revision'
                        AND consumer_key = ?2",
                    rusqlite::params![PROJECT_A, child_revision_id],
                    |row| row.get(0),
                )?;
                Ok((
                    serde_json::from_str(&envelope_json)?,
                    source_rows,
                    edge_count,
                    scope_declaration_count,
                    freshness_count,
                ))
            })
            .expect("read live ScopeOverride materialization");

        assert_eq!(
            child_envelope["assertion"]["scope"]["audience"],
            json!({"kind": "exact", "ref": "reader"})
        );
        assert_eq!(
            child_envelope["assertion"]["scope"]["readingOrder"],
            json!({
                "kind": "interval",
                "from": {"ref": format!("reading:{SCENE_ID}"), "inclusive": true},
                "until": {"ref": format!("reading:{SCENE_ID}"), "inclusive": true}
            })
        );
        assert_eq!(
            child_envelope["assertion"]["scope"]["storyTime"],
            json!({"kind": "unresolved", "reason": "not-provided"})
        );
        assert_eq!(
            child_envelope["effectiveMaterialBasis"]["sourceBasis"]
                .as_array()
                .expect("child material source basis")
                .iter()
                .filter_map(|source| source["sourceKind"].as_str())
                .collect::<Vec<_>>(),
            vec!["scene-body", "project-scope-authority"]
        );
        assert_eq!(source_rows.len(), 2);
        assert_eq!(source_rows[1].0, "project-scope-authority");
        assert_eq!(
            source_rows[1].1,
            format!("project:scope-authority:{PROJECT_A}")
        );
        assert_eq!(edge_count, 2, "V1 must include the live authority Source");
        assert_eq!(
            scope_declaration_count, 1,
            "D1 must include one re-derived ScopeResolution dependency"
        );
        assert_eq!(
            freshness_count, 1,
            "current-Epoch Freshness is part of the transaction"
        );
        assert_eq!(
            db.with_conn(|conn| Ok::<_, anyhow::Error>(conn.query_row(
                "SELECT current_revision_id FROM narrative_proposals WHERE id = ?1",
                [PROPOSAL_ID],
                |row| row.get::<_, String>(0),
            )?))
            .expect("read promoted child pointer"),
            child_revision_id
        );
    }

    #[test]
    fn c2b_scope_override_rederives_after_live_authority_advanced() {
        let db = c2b_projection_fixture_db();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET story_time_order = 'live-story' WHERE id = ?1",
                [SCENE_ID],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("advance live Scope authority after the parent was sealed");

        let saved =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                scope_override_request(&db),
                HumanMaterialDerivationKind::ScopeOverride,
            )
            .expect("ScopeOverride must re-derive the current authority");
        let child_revision_id = saved["revisionId"].as_str().expect("child revision");
        let (story_scope, authority_token): (Value, String) = db
            .with_conn(|conn| {
                let envelope_json: String = conn.query_row(
                    "SELECT reconciliation_envelope_json
                       FROM narrative_proposal_revisions WHERE id = ?1",
                    [child_revision_id],
                    |row| row.get(0),
                )?;
                let authority_token: String = conn.query_row(
                    "SELECT revision_token
                       FROM narrative_revision_source_basis
                      WHERE revision_id = ?1 AND source_kind = 'project-scope-authority'",
                    [child_revision_id],
                    |row| row.get(0),
                )?;
                let envelope: Value = serde_json::from_str(&envelope_json)?;
                Ok((
                    envelope["assertion"]["scope"]["storyTime"].clone(),
                    authority_token,
                ))
            })
            .expect("read current live authority binding");
        assert_eq!(
            story_scope,
            json!({
                "kind": "interval",
                "from": {"ref": format!("story:{SCENE_ID}"), "inclusive": true},
                "until": {"ref": format!("story:{SCENE_ID}"), "inclusive": true}
            })
        );
        assert!(!authority_token.is_empty());
    }

    #[test]
    fn c2b_scope_override_missing_live_scene_fails_before_dml_and_rolls_back() {
        let db = c2b_projection_fixture_db();
        db.with_conn(|conn| {
            conn.execute("DELETE FROM tree_nodes WHERE id = ?1", [SCENE_ID])?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("remove the live Scope target");
        let before = c2b_state_snapshot(&db);
        install_child_revision_dml_guard(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                scope_override_request(&db),
                HumanMaterialDerivationKind::ScopeOverride,
            )
            .expect_err("missing live Scope target must fail closed");
        assert!(
            error
                .to_string()
                .contains("NEX_C2B_SCOPE_AUTHORITY_SCENE_MISSING"),
            "unexpected missing authority error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_scope_override_ambiguous_story_is_persisted_as_unresolved() {
        let db = c2b_projection_fixture_db();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET story_time_order = 'ambiguous-story' WHERE id = ?1",
                [SCENE_ID],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, sort_order, story_time_order,
                     content, version, created_at, updated_at)
                 VALUES ('scene-ambiguous', ?1, 'scene', 'Ambiguous', 'z0',
                         'ambiguous-story', '{\"type\":\"doc\",\"content\":[]}', 0, ?2, ?2)",
                rusqlite::params![PROJECT_A, DECLARATION_CREATED_AT],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed an ambiguous live Story authority");

        let saved =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                scope_override_request(&db),
                HumanMaterialDerivationKind::ScopeOverride,
            )
            .expect("ambiguous Story must remain an explicit unresolved Scope");
        let child_revision_id = saved["revisionId"].as_str().expect("child revision");
        let story_scope: Value = db
            .with_conn(|conn| {
                let envelope_json: String = conn.query_row(
                    "SELECT reconciliation_envelope_json
                       FROM narrative_proposal_revisions WHERE id = ?1",
                    [child_revision_id],
                    |row| row.get(0),
                )?;
                let envelope: Value = serde_json::from_str(&envelope_json)?;
                Ok(envelope["assertion"]["scope"]["storyTime"].clone())
            })
            .expect("read unresolved Story Scope");
        assert_eq!(
            story_scope,
            json!({"kind": "unresolved", "reason": "ambiguous"})
        );
    }

    #[test]
    fn c2b_scope_override_final_pointer_race_rolls_back_live_authority_materialization() {
        let db = c2b_projection_fixture_db();
        install_post_freshness_pointer_competitor(&db);
        let before = c2b_state_snapshot(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                scope_override_request(&db),
                HumanMaterialDerivationKind::ScopeOverride,
            )
            .expect_err("ScopeOverride pointer race must rollback every child side effect");
        assert!(
            error.to_string().contains(REVISION_CONFLICT),
            "unexpected ScopeOverride race error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_parent_source_basis_token_drift_fails_before_child_dml() {
        let db = fixture_db_for_payload_kind_with_source_token(
            PARENT_REVISION_ID,
            true,
            proposal_payload(),
            ParentFixtureKind::C2B,
            Some("v99@2099-01-01T00:00:00.000Z"),
        );
        install_child_revision_dml_guard(&db);
        let before = c2b_state_snapshot(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                c2b_request(&db),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect_err("parent SourceBasis drift must fail before child DML");
        assert!(
            error
                .to_string()
                .contains("NEX_C2B_MATERIAL_PARENT_SOURCE_MISMATCH"),
            "unexpected parent SourceBasis drift error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_parent_v1_owner_drift_fails_before_child_dml() {
        let db = c2b_projection_fixture_db();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET owning_run_id = 'run-drift'
                  WHERE project_id = ?1
                    AND consumer_kind = 'proposal-revision'
                    AND consumer_key = ?2",
                rusqlite::params![PROJECT_A, PARENT_REVISION_ID],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("forge parent V1 owning Run for drift test");
        install_child_revision_dml_guard(&db);
        let before = c2b_state_snapshot(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                c2b_request(&db),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect_err("parent V1 owner drift must fail before child DML");
        assert!(
            error
                .to_string()
                .contains("NEX_C2B_MATERIAL_V1_OWNER_MISMATCH"),
            "unexpected parent V1 drift error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_parent_d1_generation_drift_fails_before_child_dml() {
        let db = c2b_projection_fixture_db();
        write_dependency_declaration_set(
            &db,
            DependencyDeclarationSetRequest {
                project_id: PROJECT_A.to_owned(),
                consumer_kind: "proposal-revision".to_owned(),
                consumer_key: PARENT_REVISION_ID.to_owned(),
                producer_id: C2B_DECLARATION_PRODUCER_ID.to_owned(),
                producer_generation: 2,
                expected_head_version: 1,
                declarations: vec![
                    DependencyDeclaration {
                        source_object_identity: source_key(),
                        role: DependencyRole::DirectEvidence,
                        selector: DependencySelector::WholeSource,
                    },
                    DependencyDeclaration {
                        source_object_identity: "component:chronicle.event-synthesis.prompt"
                            .to_owned(),
                        role: DependencyRole::ComponentContract,
                        selector: DependencySelector::ComponentContract {
                            contract_id: "chronicle.event-synthesis.prompt".to_owned(),
                            contract_digest: parent_component_contract_digest(),
                        },
                    },
                ],
                created_at: DECLARATION_CREATED_AT.to_owned(),
            },
        )
        .expect("advance parent D1 generation for drift test");
        install_child_revision_dml_guard(&db);
        let before = c2b_state_snapshot(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                c2b_request(&db),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect_err("parent D1 generation drift must fail before child DML");
        assert!(
            error
                .to_string()
                .contains("NEX_C2B_MATERIAL_D1_GENERATION_INVALID"),
            "unexpected parent D1 drift error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_missing_current_semantic_epoch_fails_before_child_dml() {
        let db = c2b_projection_fixture_db();
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_semantic_epochs WHERE project_id = ?1",
                [PROJECT_A],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("remove current Semantic Epoch for negative test");
        install_child_revision_dml_guard(&db);
        let before = c2b_state_snapshot(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                c2b_request(&db),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect_err("C2B must fail closed without a current Semantic Epoch");
        assert!(
            error
                .to_string()
                .contains("NEX_C2B_CURRENT_SEMANTIC_EPOCH_UNAVAILABLE"),
            "unexpected missing-epoch error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_success_preserves_execution_state_and_separates_d1_from_v1_digest() {
        let db = c2b_projection_fixture_db();
        install_final_pointer_cas_order_guard(&db);
        let mut edited = proposal_payload();
        edited["title"] = json!("Arrival at Dawn");
        let before = c2b_state_snapshot(&db);
        let saved =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                request_with_payload(
                    PARENT_REVISION_ID,
                    PARENT_REVISION_ID,
                    &parent_envelope_digest(&db),
                    edited.clone(),
                ),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect("C2B edited projection materialization");
        let child_revision_id = saved["revisionId"]
            .as_str()
            .expect("C2B child revision id")
            .to_owned();
        let after = c2b_state_snapshot(&db);
        assert_execution_authority_unchanged(&before, &after);

        let child_payload: Value = db
            .with_conn(|conn| {
                let payload_json: String = conn.query_row(
                    "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?1",
                    [child_revision_id.as_str()],
                    |row| row.get(0),
                )?;
                Ok(serde_json::from_str(&payload_json)?)
            })
            .expect("read edited child payload");
        assert_eq!(child_payload, edited);

        let (proposal_current_revision_id, proposal_payload): (String, Value) = db
            .with_conn(|conn| {
                let (current_revision_id, payload_json): (String, String) = conn.query_row(
                    "SELECT current_revision_id, payload_json
                       FROM narrative_proposals
                      WHERE id = ?1",
                    [PROPOSAL_ID],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                Ok((current_revision_id, serde_json::from_str(&payload_json)?))
            })
            .expect("read promoted proposal state");
        assert_eq!(proposal_current_revision_id, child_revision_id);
        assert_eq!(proposal_payload, edited);

        let (d1_state, d1_digest, freshness_digest): (String, String, String) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT s.state, s.dependency_set_digest,
                            f.dependency_set_digest
                       FROM narrative_dependency_declaration_sets s
                       JOIN narrative_consumer_freshness f
                         ON f.project_id = s.project_id
                        AND f.consumer_kind = s.consumer_kind
                        AND f.consumer_key = s.consumer_key
                      WHERE s.project_id = ?1
                        AND s.consumer_kind = 'proposal-revision'
                        AND s.consumer_key = ?2",
                    rusqlite::params![PROJECT_A, child_revision_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .expect("read child D1 and Consumer Freshness digests");
        assert_eq!(d1_state, "sealed");
        assert_ne!(
            d1_digest, freshness_digest,
            "D1 declaration digest and V1 Consumer Freshness digest have distinct authorities"
        );
    }

    #[test]
    fn c2b_post_freshness_pointer_race_fails_final_cas_and_rolls_back() {
        let db = c2b_projection_fixture_db();
        install_post_freshness_pointer_competitor(&db);
        let before = c2b_state_snapshot(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                c2b_request(&db),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect_err("post-Freshness pointer race must fail the final parent CAS");
        assert!(
            error.to_string().contains(REVISION_CONFLICT),
            "unexpected post-Freshness pointer race error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_lost_response_retry_does_not_duplicate_child_materialization() {
        let db = c2b_projection_fixture_db();
        let request = c2b_request(&db);
        let _lost_response =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                request.clone(),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect("first C2B materialization");
        install_child_revision_dml_guard(&db);
        let after_first = c2b_state_snapshot(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                request,
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect_err("retrying a completed C2B request must hit the parent CAS");
        assert!(
            error.to_string().contains("NEX_PROPOSAL_REVISION_CONFLICT"),
            "unexpected duplicate retry error: {error:#}"
        );
        assert_eq!(after_first, c2b_state_snapshot(&db));
    }

    #[test]
    fn c2b_foreign_current_revision_pointer_fails_before_child_dml() {
        let db = c2b_projection_fixture_db();
        let parent_digest = parent_envelope_digest(&db);
        let parent_envelope_json: String = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT reconciliation_envelope_json
                       FROM narrative_proposal_revisions
                      WHERE id = ?1",
                    [PARENT_REVISION_ID],
                    |row| row.get(0),
                )?)
            })
            .expect("read parent envelope for foreign pointer fixture");
        let payload_json = canonical_json_string(&proposal_payload()).expect("canonical payload");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, summary_json, created_at, updated_at)
                 VALUES ('set-foreign-c2b', ?1, ?2, 'chronicle.extract.review@1', '{}', ?3, ?3)",
                rusqlite::params![RUN_ID, PROJECT_A, DECLARATION_CREATED_AT],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, status, payload_json,
                     current_revision_id, created_at, updated_at)
                 VALUES ('proposal-foreign-c2b', 'set-foreign-c2b', 'event:foreign:0',
                         'chronicle.create-event@1', 'unreviewed', ?1, 'revision-foreign-c2b', ?2, ?2)",
                rusqlite::params![payload_json, DECLARATION_CREATED_AT],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, origin_kind,
                     reconciliation_envelope_json, reconciliation_envelope_digest,
                     created_at, created_by)
                 VALUES ('revision-foreign-c2b', 'proposal-foreign-c2b', 1, ?1,
                         'enveloped', ?2, ?3, ?4, 'chronicle')",
                rusqlite::params![
                    canonical_json_string(&proposal_payload())?,
                    parent_envelope_json,
                    parent_digest,
                    DECLARATION_CREATED_AT
                ],
            )?;
            conn.execute(
                "UPDATE narrative_proposals
                    SET current_revision_id = 'revision-foreign-c2b'
                  WHERE id = ?1",
                [PROPOSAL_ID],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("repoint proposal to a foreign proposal revision");
        install_child_revision_dml_guard(&db);
        let before = c2b_state_snapshot(&db);

        let error =
            narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
                &db,
                PROJECT_A,
                request_with_payload(
                    "revision-foreign-c2b",
                    "revision-foreign-c2b",
                    &parent_digest,
                    proposal_payload(),
                ),
                HumanMaterialDerivationKind::ProjectionOnly,
            )
            .expect_err("foreign current revision pointer must fail closed");
        assert!(
            error
                .to_string()
                .contains("NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT"),
            "unexpected foreign-pointer error: {error:#}"
        );
        assert_eq!(before, c2b_state_snapshot(&db));
    }
}
