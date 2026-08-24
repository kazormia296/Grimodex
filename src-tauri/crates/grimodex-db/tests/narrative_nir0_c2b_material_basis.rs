//! NIR-0 C2B pure material-basis contract RED.
//!
//! This test names the Native-only typed seam before the implementation is
//! present.  It must remain independent of SQLite writes, current-pointer
//! promotion, Freshness publication, and Electron transport.

use grimodex_db::narrative_extraction::human_material_basis::{
    resolve_human_material_basis, HumanMaterialDerivationKind,
    HumanMaterialResolutionContext, MaterialBasis,
};
use serde_json::json;

#[test]
fn projection_only_material_resolution_is_typed_and_dormant() {
    let material: MaterialBasis = serde_json::from_value(json!({
        "sourceBasis": [{
            "sourceKind": "scene-body",
            "sourceKey": "project:scene:scene-1",
            "revisionToken": "v0@2026-01-01T00:00:00.000Z"
        }],
        "evidenceSet": [{
            "evidenceRef": "anchor:arrival",
            "documentRef": "document:1",
            "quote": "Arrival.",
            "quoteDigest": "sha256:61b3366c3dc326b93fb56073b11453dea0d2db2fe6f79588ce266188edd24c67",
            "sourceKey": "project:scene:scene-1",
            "revisionToken": "v0@2026-01-01T00:00:00.000Z"
        }],
        "dependencySet": [{
            "dependencyId": "dependency:evidence",
            "inputRef": "project:scene:scene-1",
            "contextIds": [],
            "role": "direct-evidence",
            "selector": {"kind": "whole-source"}
        }],
        "dependencySetDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "materialBasisDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    }))
    .expect("typed material basis");

    let context = HumanMaterialResolutionContext {
        project_id: "project-a".to_owned(),
        parent_revision_id: "revision-parent".to_owned(),
        expected_parent_envelope_digest:
            "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                .to_owned(),
        scene_ref: "scene:1".to_owned(),
        edited_document_ref: "document:1".to_owned(),
        secret_scope: false,
    };

    let resolved = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &material,
        &context,
        None,
    )
    .expect("projection-only material resolution");
    assert_eq!(resolved.material_basis.source_basis, material.source_basis);
    assert_eq!(resolved.material_basis.evidence_set, material.evidence_set);
    assert_eq!(resolved.material_basis.dependency_set, material.dependency_set);
    assert_ne!(
        resolved.material_basis.material_basis_digest,
        material.material_basis_digest
    );
}
