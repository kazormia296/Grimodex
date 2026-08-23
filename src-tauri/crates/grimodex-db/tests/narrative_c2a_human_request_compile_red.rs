//! Compile-RED contract for the C2A Native Human Derivation writer.
//!
//! D1 must publish the public typed request/API before this file can compile.
//! Keeping the contract in a test-only file makes the missing seam explicit
//! without adding a speculative production type or activating Chronicle V2.
//!
//! The request intentionally has no `projectId`, `actor`, `derivation`,
//! `changedPaths`, Scope, source-basis, or child-edge fields.  Project is a
//! trusted Native function boundary; actor is fixed to the Native Human
//! writer; all derivation metadata and child declarations are Native-owned.

use anyhow::Result;
use grimodex_db::narrative_extraction::{
    narrative_extraction_create_human_derived_revision, CreateHumanDerivedRevisionRequest,
    NarrativeAdapterIdentity,
};
use grimodex_db::Database;
use serde_json::{json, Value};

const PROJECT_A: &str = "project-a";
const PROJECT_B: &str = "project-b";
const ADAPTER_ID: &str = "chronicle.scene-event";
const ADAPTER_VERSION: &str = "1";
const SURFACE_ID: &str = "chronicle-review";

const REVISION_CONFLICT: &str = "NEX_PROPOSAL_REVISION_CONFLICT";
const PARENT_DIGEST_CONFLICT: &str = "NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT";
const PROJECT_MISMATCH: &str = "NEX_HUMAN_DERIVATION_PROJECT_MISMATCH";
const ADAPTER_UNSUPPORTED: &str = "NEX_HUMAN_DERIVATION_ADAPTER_UNSUPPORTED";
const SURFACE_UNSUPPORTED: &str = "NEX_HUMAN_DERIVATION_SURFACE_UNSUPPORTED";
const ZERO_EDGE: &str = "NEX_HUMAN_DERIVATION_ZERO_EDGE";

fn fixture_db() -> Database {
    Database::new(std::path::Path::new(":memory:")).expect("open fixture database")
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
        proposal_id: "proposal-human".to_owned(),
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

// The tests are ignored after the API lands until D1 supplies the migrated
// fixture rows. They still compile as the contract becomes available.
#[test]
#[ignore = "C2A compile-red contract; D1 fixture rows required"]
fn accepts_native_verified_human_request_with_trusted_boundaries() {
    let db = fixture_db();
    submit(
        &db,
        PROJECT_A,
        request(
            "revision-parent",
            "revision-parent",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    )
    .expect("valid typed Human request");
}

#[test]
#[ignore = "C2A compile-red contract; D1 fixture rows required"]
fn rejects_wrong_current_revision_with_cas_error() {
    let db = fixture_db();
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request(
                "revision-stale-current",
                "revision-parent",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        ),
        REVISION_CONFLICT,
    );
}

#[test]
#[ignore = "C2A compile-red contract; D1 fixture rows required"]
fn rejects_wrong_parent_envelope_digest() {
    let db = fixture_db();
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request(
                "revision-parent",
                "revision-parent",
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ),
        ),
        PARENT_DIGEST_CONFLICT,
    );
}

#[test]
#[ignore = "C2A compile-red contract; D1 fixture rows required"]
fn rejects_wrong_trusted_project_boundary() {
    let db = fixture_db();
    assert_code(
        submit(
            &db,
            PROJECT_B,
            request(
                "revision-parent",
                "revision-parent",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        ),
        PROJECT_MISMATCH,
    );
}

#[test]
#[ignore = "C2A compile-red contract; D1 fixture rows required"]
fn rejects_wrong_adapter_identity() {
    let db = fixture_db();
    let mut invalid = request(
        "revision-parent",
        "revision-parent",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    invalid.adapter.id = "forged.adapter".to_owned();
    assert_code(submit(&db, PROJECT_A, invalid), ADAPTER_UNSUPPORTED);
}

#[test]
#[ignore = "C2A compile-red contract; D1 fixture rows required"]
fn rejects_wrong_surface_identity() {
    let db = fixture_db();
    let mut invalid = request(
        "revision-parent",
        "revision-parent",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    invalid.surface_id = "forged-surface".to_owned();
    assert_code(submit(&db, PROJECT_A, invalid), SURFACE_UNSUPPORTED);
}

#[test]
#[ignore = "C2A compile-red contract; D1 fixture rows required"]
fn rejects_zero_edge_parent_without_c2b_child_declaration() {
    let db = fixture_db();
    assert_code(
        submit(
            &db,
            PROJECT_A,
            request(
                "revision-zero-edge",
                "revision-zero-edge",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        ),
        ZERO_EDGE,
    );
}

#[test]
#[ignore = "C2A compile-red contract; D1 fixture rows required"]
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
                "revision-parent",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        ),
        REVISION_CONFLICT,
    );
}
