//! Canonical Native D2a policy for persisted conversation/plaintext data.
//!
//! The database authorizer and the Electron main route gate must not grow
//! separate copies of this inventory.  Native publishes this small policy
//! with the startup status; main consumes that wire value for early routing,
//! while SQLite remains the enforcement authority.

use serde::Serialize;

/// Version of the table/column inventory carried by the Native startup status.
/// An unknown version is unavailable at the Electron boundary (fail closed).
pub const PROFILE_EGRESS_POLICY_VERSION: u32 = 1;

/// Persisted tables whose rows contain conversation, prompt, review, audit,
/// or model-generated plaintext.  Table-level protection is intentional: a
/// caller must use the existing typed Native operation when a projection is
/// safe to publish; generic SQL cannot select a supposedly harmless sibling
/// column and bypass the publication boundary.
pub const PROFILE_EGRESS_PROTECTED_TABLES: &[&str] = &[
    "ab_comparison_runs",
    "ab_comparisons",
    "ai_audit_events",
    "chat_message_chunks",
    "chat_messages_fts",
    "chat_messages_fts_en",
    "chat_message_prompts",
    "chat_messages",
    "chat_runtime_threads",
    "chat_sessions",
    "chat_summaries",
    "generation_logs",
    "messages",
    "narrative_apply_commits",
    "narrative_apply_operations",
    "narrative_commit_journals",
    "narrative_extraction_artifacts",
    "narrative_extraction_attempts",
    "narrative_extraction_runs",
    "narrative_extraction_tasks",
    "narrative_proposal_decisions",
    "narrative_proposal_revisions",
    "narrative_proposal_sets",
    "narrative_proposals",
    "post_effect_annotation_relations",
    "post_effect_annotations",
    "post_effect_annotations_fts",
    "post_effect_annotations_fts_en",
    "post_effect_runs",
    "impact_review_baselines",
    "scene_lens_data",
    "scene_chunks",
    "codex_chunks",
    "event_chunks",
    "undo_journal",
    "prose_staging",
];

/// Columns on otherwise readable tables that can carry durable plaintext.
/// `change_events` metadata remains queryable for timelapse cursors, but its
/// payload is never a generic renderer result.  State snapshot metadata has
/// the same shape and keeps the same conservative boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEgressProtectedColumn {
    pub table: &'static str,
    pub column: &'static str,
}

pub const PROFILE_EGRESS_PROTECTED_COLUMNS: &[ProfileEgressProtectedColumn] = &[
    ProfileEgressProtectedColumn {
        table: "change_events",
        column: "payload",
    },
    ProfileEgressProtectedColumn {
        table: "state_snapshots",
        column: "payload",
    },
];

/// Native-owned wire policy consumed by Electron main. Keeping the version,
/// table set, and column set together prevents the two boundaries from
/// silently drifting when a persisted plaintext surface is added.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEgressSqlPolicy {
    pub version: u32,
    pub protected_tables: Vec<String>,
    pub protected_columns: Vec<ProfileEgressProtectedColumn>,
}

pub fn sql_policy_for_status() -> ProfileEgressSqlPolicy {
    ProfileEgressSqlPolicy {
        version: PROFILE_EGRESS_POLICY_VERSION,
        protected_tables: protected_tables_for_status(),
        protected_columns: protected_columns_for_status(),
    }
}

pub fn protected_tables_for_status() -> Vec<String> {
    PROFILE_EGRESS_PROTECTED_TABLES
        .iter()
        .map(|table| (*table).to_string())
        .collect()
}

pub fn protected_columns_for_status() -> Vec<ProfileEgressProtectedColumn> {
    PROFILE_EGRESS_PROTECTED_COLUMNS.to_vec()
}

pub fn is_protected_table(table_name: &str) -> bool {
    PROFILE_EGRESS_PROTECTED_TABLES
        .iter()
        .any(|table| table.eq_ignore_ascii_case(table_name))
}

pub fn is_protected_column(table_name: &str, column_name: &str) -> bool {
    PROFILE_EGRESS_PROTECTED_COLUMNS.iter().any(|column| {
        column.table.eq_ignore_ascii_case(table_name)
            && column.column.eq_ignore_ascii_case(column_name)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn inventory_is_unique_and_contains_every_conversation_plaintext_surface() {
        let tables = PROFILE_EGRESS_PROTECTED_TABLES
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(tables.len(), PROFILE_EGRESS_PROTECTED_TABLES.len());
        for table in [
            "chat_sessions",
            "chat_runtime_threads",
            "chat_messages",
            "chat_message_prompts",
            "chat_summaries",
            "chat_message_chunks",
            "chat_messages_fts",
            "chat_messages_fts_en",
            "generation_logs",
            "ab_comparisons",
            "ab_comparison_runs",
            "post_effect_annotations_fts",
            "post_effect_annotations_fts_en",
            "impact_review_baselines",
            "scene_chunks",
            "codex_chunks",
            "event_chunks",
            "undo_journal",
            "prose_staging",
        ] {
            assert!(is_protected_table(table), "missing policy table {table}");
        }

        let columns = PROFILE_EGRESS_PROTECTED_COLUMNS
            .iter()
            .map(|column| (column.table, column.column))
            .collect::<BTreeSet<_>>();
        assert_eq!(columns.len(), PROFILE_EGRESS_PROTECTED_COLUMNS.len());
        assert!(is_protected_column("change_events", "payload"));
        assert!(is_protected_column("state_snapshots", "payload"));
        assert!(!is_protected_column("change_events", "domain"));
    }
}
