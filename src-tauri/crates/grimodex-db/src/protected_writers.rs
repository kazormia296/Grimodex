//! Protected Narrative writer registry (Release Gate B).
//!
//! Domain PRs flip `enforcement` from `deferred` to `active` when Native
//! cutover lands. Active entries are denied for untrusted SQL origins and
//! checked by `scripts/quality/validate-narrative-writers.mjs`.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

pub const PROTECTED_WRITER_SQL_ERROR: &str = "PROTECTED_WRITER_SQL";

const REGISTRY_JSON: &str = include_str!("../../../../policies/narrative/protected-writers.json");

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WriterEnforcement {
    Deferred,
    Active,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WriterProtection {
    Table,
    Columns,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedWriterEntry {
    pub aggregate: String,
    pub table: String,
    pub protection: WriterProtection,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub version_column: Option<String>,
    pub writer: String,
    pub enforcement: WriterEnforcement,
}

impl ProtectedWriterEntry {
    fn effective_protected_columns(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.columns.iter().map(String::as_str).collect();
        if let Some(version) = self.version_column.as_deref() {
            if !names.iter().any(|name| name.eq_ignore_ascii_case(version)) {
                names.push(version);
            }
        }
        names
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProtectedWriterRegistry {
    by_table: HashMap<String, ProtectedWriterEntry>,
}

impl ProtectedWriterRegistry {
    pub fn from_json(json: &str) -> anyhow::Result<Self> {
        let entries: Vec<ProtectedWriterEntry> = serde_json::from_str(json)?;
        let mut by_table = HashMap::new();
        for entry in entries {
            by_table.insert(entry.table.to_ascii_lowercase(), entry);
        }
        Ok(Self { by_table })
    }

    pub fn get(&self, table: &str) -> Option<&ProtectedWriterEntry> {
        self.by_table.get(&table.to_ascii_lowercase())
    }

    pub fn active_entries(&self) -> impl Iterator<Item = &ProtectedWriterEntry> {
        self.by_table
            .values()
            .filter(|entry| entry.enforcement == WriterEnforcement::Active)
    }
}

pub fn bundled_protected_writer_registry() -> &'static ProtectedWriterRegistry {
    static REGISTRY: OnceLock<ProtectedWriterRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        ProtectedWriterRegistry::from_json(REGISTRY_JSON)
            .expect("policies/narrative/protected-writers.json must parse")
    })
}

/// Reject untrusted mutations against active protected writers.
pub fn untrusted_mutation_rejection(
    registry: &ProtectedWriterRegistry,
    table: &str,
    column: Option<&str>,
    is_insert: bool,
    is_delete: bool,
    insert_columns: Option<&[String]>,
) -> Option<String> {
    let entry = registry.get(table)?;
    if entry.enforcement != WriterEnforcement::Active {
        return None;
    }

    match entry.protection {
        WriterProtection::Table => Some(format!(
            "mutation of protected narrative table {} (writer {})",
            entry.table, entry.writer
        )),
        WriterProtection::Columns => {
            // Shared tables: untrusted INSERT/DELETE can still rewrite protected
            // columns via DEFAULT values or INSERT OR REPLACE. Fail closed and
            // require typed Native writers for structural changes.
            if is_delete {
                return Some(format!(
                    "delete from protected shared table {} (writer {})",
                    entry.table, entry.writer
                ));
            }
            if is_insert {
                let Some(columns) = insert_columns else {
                    return Some(format!(
                        "unclassified insert into protected shared table {} (writer {})",
                        entry.table, entry.writer
                    ));
                };
                let protected_names = entry.effective_protected_columns();
                let hits_protected = columns.iter().any(|column_name| {
                    protected_names
                        .iter()
                        .any(|protected| protected.eq_ignore_ascii_case(column_name))
                });
                if hits_protected {
                    return Some(format!(
                        "insert into protected columns on {} (writer {})",
                        entry.table, entry.writer
                    ));
                }
                // Even when the explicit column list omits protected fields,
                // SQLite may fill them from DEFAULT. Untrusted INSERT is
                // therefore denied for column-protected shared tables.
                return Some(format!(
                    "insert into protected shared table {} (writer {})",
                    entry.table, entry.writer
                ));
            }
            let column_name = column?;
            if entry
                .effective_protected_columns()
                .iter()
                .any(|protected| protected.eq_ignore_ascii_case(column_name))
            {
                return Some(format!(
                    "update of protected column {}.{} (writer {})",
                    entry.table, column_name, entry.writer
                ));
            }
            None
        }
    }
}

/// Best-effort INSERT column list for canonical Drizzle SQL.
/// Fail closed (returns None) when the statement cannot be classified.
pub fn classify_insert_columns(sql: &str) -> Option<Vec<String>> {
    let lowered = sql.to_ascii_lowercase();
    // INSERT OR REPLACE / REPLACE INTO rewrite whole rows and can reset
    // DEFAULT-backed protected columns even when they are omitted.
    if lowered.trim_start().starts_with("replace")
        || lowered.contains(" insert or replace ")
        || lowered.trim_start().starts_with("insert or replace")
    {
        return None;
    }
    let insert_idx = lowered.find("insert")?;
    let into_idx = lowered[insert_idx..].find("into").map(|i| insert_idx + i)?;
    let after_into = sql[into_idx + 4..].trim_start();
    let table_end = after_into
        .find(|c: char| c.is_whitespace() || c == '(')
        .unwrap_or(after_into.len());
    let after_table = after_into[table_end..].trim_start();
    if !after_table.starts_with('(') {
        return None;
    }
    let close = after_table.find(')')?;
    let inner = &after_table[1..close];
    if inner.trim().is_empty() {
        return None;
    }
    Some(
        inner
            .split(',')
            .map(|part| {
                part.trim()
                    .trim_matches('"')
                    .trim_matches('`')
                    .trim_matches('[')
                    .trim_matches(']')
                    .to_string()
            })
            .filter(|name| !name.is_empty())
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_includes_active_domain_and_active_fixtures() {
        let registry = bundled_protected_writer_registry();
        let foreshadow = registry.get("foreshadows").expect("foreshadows");
        assert_eq!(foreshadow.enforcement, WriterEnforcement::Active);
        let events = registry.get("events").expect("events");
        assert_eq!(events.enforcement, WriterEnforcement::Active);
        let tree_nodes = registry.get("tree_nodes").expect("tree_nodes");
        assert_eq!(tree_nodes.protection, WriterProtection::Table);
        let fixture = registry
            .get("narrative_protected_fixture")
            .expect("fixture");
        assert_eq!(fixture.enforcement, WriterEnforcement::Active);
    }

    #[test]
    fn bundled_tree_writer_rejects_every_untrusted_mutation() {
        let registry = bundled_protected_writer_registry();
        for rejection in [
            untrusted_mutation_rejection(registry, "tree_nodes", Some("title"), false, false, None),
            untrusted_mutation_rejection(
                registry,
                "tree_nodes",
                None,
                true,
                false,
                Some(&["id".into(), "title".into()]),
            ),
            untrusted_mutation_rejection(registry, "tree_nodes", None, false, true, None),
        ] {
            assert!(
                rejection
                    .as_deref()
                    .is_some_and(|reason| reason.contains("protected narrative table")),
                "unexpected rejection: {rejection:?}"
            );
        }
    }

    #[test]
    fn project_lifecycle_rejects_insert_and_delete_but_allows_metadata_update() {
        let registry = bundled_protected_writer_registry();
        let project = registry.get("projects").expect("project lifecycle");
        assert_eq!(project.protection, WriterProtection::Columns);
        assert!(project.columns.is_empty());
        assert!(untrusted_mutation_rejection(
            registry,
            "projects",
            None,
            true,
            false,
            Some(&["id".into(), "title".into()]),
        )
        .is_some());
        assert!(
            untrusted_mutation_rejection(registry, "projects", None, false, true, None,).is_some()
        );
        assert_eq!(
            untrusted_mutation_rejection(registry, "projects", Some("title"), false, false, None,),
            None
        );
    }

    #[test]
    fn active_table_mutations_are_rejected() {
        let registry = bundled_protected_writer_registry();
        let rejection = untrusted_mutation_rejection(
            registry,
            "narrative_protected_fixture",
            None,
            false,
            true,
            None,
        );
        assert!(rejection.unwrap().contains("protected narrative table"));
    }

    #[test]
    fn shared_column_updates_are_rejected_and_other_columns_pass() {
        let registry = bundled_protected_writer_registry();
        let denied = untrusted_mutation_rejection(
            registry,
            "narrative_protected_shared_fixture",
            Some("protected_col"),
            false,
            false,
            None,
        );
        assert!(denied.unwrap().contains("protected column"));

        let version_denied = untrusted_mutation_rejection(
            registry,
            "narrative_protected_shared_fixture",
            Some("version"),
            false,
            false,
            None,
        );
        assert!(version_denied.unwrap().contains("protected column"));

        let allowed = untrusted_mutation_rejection(
            registry,
            "narrative_protected_shared_fixture",
            Some("title"),
            false,
            false,
            None,
        );
        assert!(allowed.is_none());
    }

    #[test]
    fn active_tree_columns_reject_structural_mutations_but_allow_metadata_updates() {
        let registry = ProtectedWriterRegistry::from_json(
            r#"[
                {
                    "aggregate": "temporal-scene",
                    "table": "tree_nodes",
                    "protection": "columns",
                    "columns": ["story_time_order"],
                    "versionColumn": "version",
                    "writer": "temporal.scene",
                    "enforcement": "active"
                }
            ]"#,
        )
        .expect("parse test registry");

        assert!(untrusted_mutation_rejection(
            &registry,
            "tree_nodes",
            Some("title"),
            false,
            false,
            None,
        )
        .is_none());
        assert!(untrusted_mutation_rejection(
            &registry,
            "tree_nodes",
            Some("story_time_order"),
            false,
            false,
            None,
        )
        .is_some());
        assert!(untrusted_mutation_rejection(
            &registry,
            "tree_nodes",
            None,
            true,
            false,
            Some(&["id".into(), "title".into()]),
        )
        .is_some());
        assert!(
            untrusted_mutation_rejection(&registry, "tree_nodes", None, false, true, None,)
                .is_some()
        );
    }

    #[test]
    fn shared_table_insert_and_delete_fail_closed() {
        let registry = bundled_protected_writer_registry();
        let insert = untrusted_mutation_rejection(
            registry,
            "narrative_protected_shared_fixture",
            None,
            true,
            false,
            Some(&["id".into(), "title".into()]),
        );
        assert!(insert
            .unwrap()
            .contains("insert into protected shared table"));

        let delete = untrusted_mutation_rejection(
            registry,
            "narrative_protected_shared_fixture",
            None,
            false,
            true,
            None,
        );
        assert!(delete
            .unwrap()
            .contains("delete from protected shared table"));
    }

    #[test]
    fn insert_or_replace_is_unclassified() {
        assert!(classify_insert_columns(
            "INSERT OR REPLACE INTO narrative_protected_shared_fixture (id, title) VALUES (?, ?)",
        )
        .is_none());
    }

    #[test]
    fn insert_classifier_parses_drizzle_shape() {
        let columns = classify_insert_columns(
            "INSERT INTO narrative_protected_shared_fixture (id, protected_col, title) VALUES (?, ?, ?)",
        )
        .expect("classify");
        assert_eq!(
            columns,
            vec![
                "id".to_string(),
                "protected_col".to_string(),
                "title".to_string()
            ]
        );
    }
}
