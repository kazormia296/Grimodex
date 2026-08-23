//! Compile-RED contract for the C2A Native Human Derivation writer.
//!
//! D1 must publish the public typed request/API before this file can compile.
//! The tests intentionally use only the policy-shaped request and the
//! trusted Native project argument.  They do not route forged actor or
//! derivation metadata through the legacy decision JSON facade.
//!
//! The request has no `projectId`, `actor`, `derivation`, `changedPaths`,
//! Scope, source-basis, or child-edge fields.  Project is a trusted Native
//! function boundary; actor is fixed to the Native Human writer; all
//! derivation metadata and child declarations are Native-owned.

use anyhow::Result;
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_core::{canonical_json_digest, canonical_json_string};
use grimodex_db::narrative_extraction::{
    narrative_extraction_create_human_derived_revision, narrative_extraction_create_run,
    write_dependency_declaration_set, CreateHumanDerivedRevisionRequest, CreateRunPayload,
    CreateTaskSeed, DependencyDeclaration, DependencyDeclarationSetRequest,
    NarrativeAdapterIdentity,
};
use grimodex_db::Database;
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
const DECLARATION_CREATED_AT: &str = "2026-08-24T00:00:00.000Z";

const REVISION_CONFLICT: &str = "NEX_PROPOSAL_REVISION_CONFLICT";
const PARENT_DIGEST_CONFLICT: &str = "NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT";
const PROJECT_MISMATCH: &str = "NEX_HUMAN_DERIVATION_PROJECT_MISMATCH";
const ADAPTER_UNSUPPORTED: &str = "NEX_HUMAN_DERIVATION_ADAPTER_UNSUPPORTED";
const SURFACE_UNSUPPORTED: &str = "NEX_HUMAN_DERIVATION_SURFACE_UNSUPPORTED";
const ZERO_EDGE: &str = "NEX_HUMAN_DERIVATION_ZERO_EDGE";

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
    }])
}

fn parent_envelope(source_revision_token: &str) -> Value {
    let semantic = parent_semantic_payload();
    let scope = parent_scope();
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
    let proposal = proposal_payload();
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
    let scope_digest = digest(&scope);
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
    let proposal_digest = digest(&proposal);

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

fn fixture_db() -> Database {
    fixture_db_for(PARENT_REVISION_ID, true)
}

fn zero_edge_fixture_db() -> Database {
    fixture_db_for("revision-zero-edge", false)
}

fn fixture_db_for(parent_revision_id: &str, include_v1_edge: bool) -> Database {
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
    let envelope = parent_envelope(&source_revision_token);
    let envelope_json = canonical_json_string(&envelope).expect("canonical parent Envelope");
    let envelope_digest = digest(&envelope);
    let payload_json = canonical_json_string(&proposal_payload()).expect("canonical proposal");
    let read_set_json = serde_json::to_string(&json!([{
        "inputRef": source_key(),
        "kind": "snapshot-document",
        "sourceKind": "scene-body",
        "revisionToken": source_revision_token.clone()
    }]))
    .expect("parent read set JSON");

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
            rusqlite::params![parent_revision_id, source_key(), source_revision_token],
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

    let declaration_receipt = write_dependency_declaration_set(
        &db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT_A.to_owned(),
            consumer_kind: "proposal-revision".to_owned(),
            consumer_key: parent_revision_id.to_owned(),
            producer_id: DECLARATION_PRODUCER_ID.to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![DependencyDeclaration {
                source_object_identity: source_key(),
                role: DependencyRole::DirectEvidence,
                selector: DependencySelector::WholeSource,
            }],
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
        assert_eq!(head.1, DECLARATION_PRODUCER_ID);
        assert_eq!(head.2, 1);
        assert_eq!(head.3, declaration_receipt.head_version);
        Ok::<_, anyhow::Error>(())
    })
    .expect("inspect D1 active declaration head");
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
    digest(&parent_envelope(&source_revision_token(db)))
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

fn request(
    current_revision_id: &str,
    parent_revision_id: &str,
    parent_envelope_digest: &str,
) -> CreateHumanDerivedRevisionRequest {
    CreateHumanDerivedRevisionRequest {
        proposal_id: PROPOSAL_ID.to_owned(),
        expected_current_revision_id: current_revision_id.to_owned(),
        parent_revision_id: parent_revision_id.to_owned(),
        expected_parent_envelope_digest: parent_envelope_digest.to_owned(),
        proposal_payload: proposal_payload(),
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

fn assert_code(result: Result<Value>, expected_code: &str) {
    let error = result.expect_err("negative Human Derivation case must fail");
    assert!(
        error.to_string().contains(expected_code),
        "expected {expected_code}, got {error:#}"
    );
}

#[test]
fn accepts_native_verified_human_request_and_persists_native_human_actor() {
    let db = fixture_db();
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
                &parent_envelope_digest(&db),
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
    let (before, observed_after) = advance_source(&db);
    assert_eq!(before, observed_before);
    assert_ne!(observed_before, observed_after);

    let saved = submit(
        &db,
        PROJECT_A,
        request(
            PARENT_REVISION_ID,
            PARENT_REVISION_ID,
            &parent_envelope_digest(&db),
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
