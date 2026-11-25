use grimodex_db::narrative_extraction::maintenance_contracts::bundled_dependency_producer_registry;
use serde_json::Value;

const DECLARATIONS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../policies/narrative/narrative-object-identity-declarations.json"
));
const ENTITY_RELATION_INDEX_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/narrative_extraction/nir1_entity_relation_index.rs"
));

#[test]
fn declared_producers_exist_and_use_the_allowed_kind() {
    let declarations: Value = serde_json::from_str(DECLARATIONS).expect("declarations JSON");
    let registry = bundled_dependency_producer_registry().expect("producer registry");
    let entries = declarations
        .get("entries")
        .and_then(Value::as_array)
        .expect("declaration entries");

    for entry in entries {
        let producer_id = entry
            .get("producerId")
            .and_then(Value::as_str)
            .expect("producerId");
        assert!(
            registry
                .entries()
                .iter()
                .any(|producer| producer.id == producer_id),
            "unknown producerId: {producer_id}"
        );
        assert_eq!(
            entry.get("kind").and_then(Value::as_str),
            Some("producer-declared-object-key")
        );
    }
}

#[test]
fn key_templates_match_entity_relation_source_identity_formats() {
    let declarations: Value = serde_json::from_str(DECLARATIONS).expect("declarations JSON");
    let entries = declarations
        .get("entries")
        .and_then(Value::as_array)
        .expect("declaration entries");

    for object in entries.iter().flat_map(|entry| {
        entry
            .get("objects")
            .and_then(Value::as_array)
            .expect("objects")
    }) {
        let (prefix, source_format) = match object.get("materialKind").and_then(Value::as_str) {
            Some("entity") => ("codex:", "format!(\"codex:{}\""),
            Some("relation") => ("codex-relation:", "format!(\"codex-relation:{}\""),
            other => panic!("unexpected materialKind: {other:?}"),
        };
        let key_template = object
            .get("keyTemplate")
            .and_then(Value::as_str)
            .expect("keyTemplate");
        assert!(
            key_template.starts_with(prefix),
            "unexpected keyTemplate: {key_template}"
        );
        assert!(
            ENTITY_RELATION_INDEX_SOURCE.contains(source_format),
            "index source is missing {source_format}"
        );
    }
}
