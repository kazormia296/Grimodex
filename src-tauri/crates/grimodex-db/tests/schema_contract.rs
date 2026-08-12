use grimodex_db::{schema_contract::inspect_connection, Database};
use rusqlite::Connection;

const GENERATED_CONTRACT: &str = include_str!("../../../../src/db/generated/schema-contract.json");

#[test]
fn migrated_database_contract_contains_constraints_and_indexes() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");

    let contract = db
        .with_conn(inspect_connection)
        .expect("inspect schema contract");

    let projects = contract.tables.get("projects").expect("projects table");
    assert_eq!(projects.columns["id"].primary_key, 1);
    assert!(projects.columns["title"].not_null);
    assert_eq!(projects.columns["title"].declared_type, "TEXT");

    let tree_nodes = contract.tables.get("tree_nodes").expect("tree_nodes table");
    assert!(tree_nodes
        .foreign_keys
        .iter()
        .any(|foreign_key| foreign_key.table == "projects"));
    assert!(contract.indexes.contains_key("idx_tree_parent"));
    assert!(contract
        .tables
        .get("codex_types")
        .expect("codex_types table")
        .unique_constraints
        .iter()
        .any(|constraint| constraint.columns == ["project_id", "slug"]));
    assert!(contract.triggers.contains_key("seed_builtin_codex_types"));
}

#[test]
fn contract_json_is_stable_and_includes_schema_version() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    let contract = db
        .with_conn(inspect_connection)
        .expect("inspect schema contract");

    let json = serde_json::to_value(contract).expect("serialize schema contract");
    assert_eq!(
        json["schemaVersion"],
        serde_json::Value::from(grimodex_core::SCHEMA_VERSION)
    );
    assert!(json["tables"].get("projects").is_some());
    assert!(json["indexes"].get("idx_tree_parent").is_some());
    assert!(json["triggers"].get("seed_builtin_codex_types").is_some());
}

#[test]
fn committed_contract_matches_a_fresh_migration() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    let current = db
        .with_conn(inspect_connection)
        .expect("inspect schema contract");
    let generated: serde_json::Value =
        serde_json::from_str(GENERATED_CONTRACT).expect("parse generated contract");

    assert_eq!(
        serde_json::to_value(current).expect("serialize current contract"),
        generated,
        "run `pnpm generate:db-contract` after changing migrate.rs",
    );
}

#[test]
fn contract_excludes_sqlite_internal_objects() {
    let conn = Connection::open_in_memory().expect("open sqlite");
    conn.execute_batch("CREATE TABLE visible (id TEXT PRIMARY KEY);")
        .expect("create test schema");

    let contract = inspect_connection(&conn).expect("inspect schema contract");
    assert!(contract.tables.contains_key("visible"));
    assert!(contract
        .indexes
        .keys()
        .all(|name| !name.starts_with("sqlite_autoindex_")));
}

#[test]
fn provenance_and_field_authority_rows_have_no_domain_cascade_foreign_keys() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    let contract = db
        .with_conn(inspect_connection)
        .expect("inspect schema contract");

    for table_name in [
        "narrative_projection_freshness",
        "narrative_projection_dependencies",
        "narrative_field_authority",
    ] {
        let table = contract.tables.get(table_name).expect("provenance table");
        assert!(
            table.foreign_keys.is_empty(),
            "{table_name} must remain a logical reference table"
        );
    }
}
