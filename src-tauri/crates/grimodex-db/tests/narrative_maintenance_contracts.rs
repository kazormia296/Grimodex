//! C2-5B Rust-owned maintenance coordinate contracts.
//!
//! This red-first contract intentionally names the production API before the
//! implementation lands. Coordinates must be derived from bundled Rust
//! contracts, not supplied by the Electron wake request or copied constants.

use grimodex_db::narrative_extraction::maintenance_contracts::{
    bundled_dependency_producer_registry, current_maintenance_coordinates,
};
use grimodex_db::narrative_extraction::PROPOSAL_REVISION_D1_PRODUCER_GENERATION;
use serde_json::Value;

#[test]
fn current_coordinates_are_domain_separated_and_canonical() {
    let coordinates = current_maintenance_coordinates().expect("current coordinates");
    for digest in [
        &coordinates.graph_contract_digest,
        &coordinates.rule_registry_digest,
        &coordinates.producer_generation_set_digest,
    ] {
        assert!(digest.starts_with("sha256:"));
        assert_eq!(digest.len(), "sha256:".len() + 64);
        assert!(digest["sha256:".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }
    assert_ne!(
        coordinates.graph_contract_digest,
        coordinates.rule_registry_digest
    );
    assert_ne!(
        coordinates.rule_registry_digest,
        coordinates.producer_generation_set_digest
    );
}

#[test]
fn bundled_producer_registry_is_traceable_to_current_writer_paths() {
    let registry = bundled_dependency_producer_registry().expect("bundled producer registry");
    assert_eq!(registry.schema_version(), 1);
    let writers = registry
        .entries()
        .iter()
        .map(|entry| (entry.writer.module.as_str(), entry.writer.symbol.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        writers,
        vec![
            (
                "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs",
                "record_legacy_dependency_edges_in_tx"
            ),
            (
                "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
                "record_revision_dependency_edges_in_tx"
            )
        ]
    );
    assert!(registry
        .entries()
        .iter()
        .all(|entry| !entry.generation.is_empty() && !entry.declaration.is_empty()));
}

#[test]
fn proposal_revision_registry_declares_numeric_d1_generation_parity() {
    let registry = bundled_dependency_producer_registry().expect("bundled producer registry");
    let entry = registry
        .entries()
        .iter()
        .find(|entry| entry.id == "proposal-revision-source-basis")
        .expect("proposal revision producer");

    assert_eq!(
        entry.declaration_set_generation,
        Some(PROPOSAL_REVISION_D1_PRODUCER_GENERATION)
    );
}

#[test]
fn producer_registry_policy_satisfies_its_bundled_schema_shape() {
    let policy: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../policies/narrative/narrative-dependency-producer-registry.json"
    )))
    .expect("producer policy JSON");
    let schema: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../policies/narrative/schemas/narrative-dependency-producer-registry.schema.json"
    )))
    .expect("producer policy schema JSON");

    assert_eq!(
        policy.get("schemaVersion"),
        schema
            .get("properties")
            .and_then(|properties| properties.get("schemaVersion"))
            .and_then(|property| property.get("const"))
    );
    assert_eq!(
        policy.get("contract"),
        schema
            .get("properties")
            .and_then(|properties| properties.get("contract"))
            .and_then(|property| property.get("const"))
    );
    let entries = policy
        .get("entries")
        .and_then(Value::as_array)
        .expect("policy entries array");
    let entry_schema = schema
        .get("$defs")
        .and_then(|defs| defs.get("entry"))
        .expect("entry schema");
    let required = entry_schema
        .get("required")
        .and_then(Value::as_array)
        .expect("entry required fields");
    for entry in entries {
        for field in ["id", "writer", "generation", "consumerKind", "declaration"] {
            assert!(
                required
                    .iter()
                    .any(|required| required.as_str() == Some(field)),
                "schema must require entry.{field}"
            );
            assert!(entry.get(field).is_some(), "policy entry lacks {field}");
        }
        assert!(entry
            .get("writer")
            .and_then(Value::as_object)
            .is_some_and(|writer| writer.contains_key("module") && writer.contains_key("symbol")));
    }
}
