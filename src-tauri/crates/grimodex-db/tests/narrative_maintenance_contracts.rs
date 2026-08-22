//! C2-5B Rust-owned maintenance coordinate contracts.
//!
//! This red-first contract intentionally names the production API before the
//! implementation lands. Coordinates must be derived from bundled Rust
//! contracts, not supplied by the Electron wake request or copied constants.

use grimodex_db::narrative_extraction::maintenance_contracts::{
    bundled_dependency_producer_registry, current_maintenance_coordinates,
};

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
    assert!(registry
        .entries()
        .iter()
        .any(|entry| entry.writer.symbol == "record_revision_dependency_edges_in_tx"));
    assert!(registry
        .entries()
        .iter()
        .any(|entry| entry.writer.symbol == "record_legacy_dependency_edges_in_tx"));
}
