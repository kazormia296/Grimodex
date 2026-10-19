//! Canonical Native D2a policy for persisted conversation/plaintext data.
//!
//! The database authorizer and the Electron main route gate must not grow
//! separate copies of this inventory.  Native publishes this small policy
//! with the startup status; main consumes that wire value for early routing,
//! while SQLite remains the enforcement authority.
//!
//! Policy version 2 (K3/2 "表の台帳") splits the protected inventory into two
//! classes.  A table is declared exactly once, with its class, in
//! [`PROFILE_EGRESS_TABLES`]; there is no default class and no prefix rule, so
//! adding a table to the ledger without deciding `closed` or `read-open` does
//! not compile, and a schema table that is neither declared here nor pinned as
//! "unlisted" in the tests fails the schema completeness test.

use serde::Serialize;

/// Version of the table/column inventory carried by the Native startup status.
/// An unknown version is unavailable at the Electron boundary (fail closed).
pub const PROFILE_EGRESS_POLICY_VERSION: u32 = 2;

/// Whether restricted generic SQL may read the `read-open` class.
///
/// K3/2 opens read-only access to the author's own data (the `read-open`
/// tables and columns) for `own-data-read`.  The opening is deliberately a
/// single reviewed switch: while it is `false` the authorizer treats the
/// `read-open` class exactly like `closed` for reads (the a153743b behavior),
/// and DML/RETURNING/temp/attached stay rejected either way.  The opening
/// commit (DR-DA1-35 in `docs/plans/nir1-lane-decisions/da1-decisions.md`)
/// flipped it to `true` after the renderer-isolation finding (Y-1) was closed
/// by NC-1.
pub const PROFILE_EGRESS_READ_OPEN_ENABLED: bool = true;

/// Class of a protected table in the D2a ledger.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileEgressTableClass {
    /// Internal NIR/narrative state and unused ledgers.  Generic SQL can
    /// neither read nor write these; typed readers/writers only.
    Closed,
    /// The author's own conversation/audit/version/foreshadow/... data.
    /// Generic SQL may read (when [`PROFILE_EGRESS_READ_OPEN_ENABLED`]), never
    /// write.
    ReadOpen,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProfileEgressTable {
    pub name: &'static str,
    pub class: ProfileEgressTableClass,
}

const fn closed(name: &'static str) -> ProfileEgressTable {
    ProfileEgressTable {
        name,
        class: ProfileEgressTableClass::Closed,
    }
}

const fn read_open(name: &'static str) -> ProfileEgressTable {
    ProfileEgressTable {
        name,
        class: ProfileEgressTableClass::ReadOpen,
    }
}

/// The D2a table ledger: 26 `closed` and 58 `read-open` tables, enumerated by
/// name (never by prefix).  FTS shadow tables carry the class of their
/// content table because they hold the same plaintext.
pub const PROFILE_EGRESS_TABLES: &[ProfileEgressTable] = &[
    // closed (26)
    closed("narrative_apply_commits"),
    closed("narrative_apply_operations"),
    closed("narrative_commit_journals"),
    closed("narrative_consumer_freshness"),
    closed("narrative_extraction_artifacts"),
    closed("narrative_extraction_attempts"),
    closed("narrative_extraction_runs"),
    closed("narrative_extraction_stage_model_bindings"),
    closed("narrative_extraction_stage_receipts"),
    closed("narrative_extraction_tasks"),
    closed("narrative_maintenance_attention"),
    closed("narrative_maintenance_finding_lifecycle"),
    closed("narrative_maintenance_finding_observations"),
    closed("narrative_proposal_applications"),
    closed("narrative_proposal_decisions"),
    closed("narrative_proposal_revisions"),
    closed("narrative_proposal_sets"),
    closed("narrative_proposals"),
    closed("nir1_chat_input_captures"),
    closed("nir1_chat_input_submission_keys"),
    closed("nir1_generation_attempts"),
    closed("nir1_generation_input_refs"),
    closed("nir1_generation_message_versions"),
    closed("nir1_generation_qualification_refs"),
    closed("idempotency_requests"),
    closed("messages"),
    // read-open (58)
    read_open("ab_comparison_runs"),
    read_open("ab_comparisons"),
    read_open("ai_audit_events"),
    read_open("chat_message_chunks"),
    read_open("chat_messages_fts"),
    read_open("chat_messages_fts_en"),
    read_open("chat_message_prompts"),
    read_open("chat_messages"),
    read_open("chat_runtime_threads"),
    read_open("chat_sessions"),
    read_open("chat_summaries"),
    read_open("generation_logs"),
    read_open("project_snapshot_tree_nodes"),
    read_open("project_snapshot_codex_entries"),
    read_open("project_snapshot_snippets"),
    read_open("project_snapshot_aux"),
    read_open("content_versions"),
    read_open("post_effect_annotation_relations"),
    read_open("post_effect_annotations"),
    read_open("post_effect_annotations_fts"),
    read_open("post_effect_annotations_fts_en"),
    read_open("post_effect_runs"),
    read_open("impact_review_baselines"),
    read_open("scene_lens_data"),
    read_open("scene_chunks"),
    read_open("codex_chunks"),
    read_open("event_chunks"),
    read_open("undo_journal"),
    read_open("prose_staging"),
    read_open("trash_items"),
    read_open("foreshadows"),
    read_open("foreshadow_setups"),
    read_open("foreshadow_payoffs"),
    read_open("foreshadow_setup_payoff_links"),
    read_open("foreshadow_codex_links"),
    read_open("plot_threads"),
    read_open("plot_thread_scene_links"),
    read_open("plot_thread_branches"),
    read_open("lint_ignored_diagnostics"),
    read_open("lint_term_dictionary"),
    read_open("chat_messages_fts_config"),
    read_open("chat_messages_fts_data"),
    read_open("chat_messages_fts_docsize"),
    read_open("chat_messages_fts_idx"),
    read_open("chat_messages_fts_en_config"),
    read_open("chat_messages_fts_en_content"),
    read_open("chat_messages_fts_en_data"),
    read_open("chat_messages_fts_en_docsize"),
    read_open("chat_messages_fts_en_idx"),
    read_open("post_effect_annotations_fts_config"),
    read_open("post_effect_annotations_fts_data"),
    read_open("post_effect_annotations_fts_docsize"),
    read_open("post_effect_annotations_fts_idx"),
    read_open("post_effect_annotations_fts_en_config"),
    read_open("post_effect_annotations_fts_en_content"),
    read_open("post_effect_annotations_fts_en_data"),
    read_open("post_effect_annotations_fts_en_docsize"),
    read_open("post_effect_annotations_fts_en_idx"),
];

/// Columns on otherwise unlisted tables that can carry durable plaintext and
/// belong to the `read-open` class.  `change_events` metadata is queryable for
/// timelapse cursors and external-write feeds, and its `payload` is the
/// author's own data (a copy of chat message text when timelapse recording is
/// on).  State snapshot metadata has the same shape and class.  Writes to the
/// two tables stay rejected as a whole.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEgressProtectedColumn {
    pub table: &'static str,
    pub column: &'static str,
}

pub const PROFILE_EGRESS_READ_OPEN_COLUMNS: &[ProfileEgressProtectedColumn] = &[
    ProfileEgressProtectedColumn {
        table: "change_events",
        column: "payload",
    },
    ProfileEgressProtectedColumn {
        table: "state_snapshots",
        column: "payload",
    },
];

/// Tables that are not in [`PROFILE_EGRESS_TABLES`] but whose generic-SQL
/// writes the authorizer still rejects as a whole (their `payload` column is
/// a read-open column, see above).
pub const PROFILE_EGRESS_WRITE_PROTECTED_FEED_TABLES: &[&str] =
    &["change_events", "state_snapshots"];

/// Native-owned wire policy consumed by Electron main. Keeping the version,
/// table classes, and column set together prevents the two boundaries from
/// silently drifting when a persisted plaintext surface is added.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEgressSqlPolicy {
    pub version: u32,
    pub closed_tables: Vec<String>,
    pub read_open_tables: Vec<String>,
    pub read_open_columns: Vec<ProfileEgressProtectedColumn>,
}

pub fn sql_policy_for_status() -> ProfileEgressSqlPolicy {
    ProfileEgressSqlPolicy {
        version: PROFILE_EGRESS_POLICY_VERSION,
        closed_tables: tables_of_class(ProfileEgressTableClass::Closed),
        read_open_tables: tables_of_class(ProfileEgressTableClass::ReadOpen),
        read_open_columns: PROFILE_EGRESS_READ_OPEN_COLUMNS.to_vec(),
    }
}

fn tables_of_class(class: ProfileEgressTableClass) -> Vec<String> {
    PROFILE_EGRESS_TABLES
        .iter()
        .filter(|table| table.class == class)
        .map(|table| table.name.to_string())
        .collect()
}

/// Class of `table_name` in the ledger (ASCII case-insensitive), or `None` for
/// a table the ledger does not list ("上記以外の表").
pub fn table_class(table_name: &str) -> Option<ProfileEgressTableClass> {
    PROFILE_EGRESS_TABLES
        .iter()
        .find(|table| table.name.eq_ignore_ascii_case(table_name))
        .map(|table| table.class)
}

pub fn is_closed_table(table_name: &str) -> bool {
    table_class(table_name) == Some(ProfileEgressTableClass::Closed)
}

pub fn is_read_open_table(table_name: &str) -> bool {
    table_class(table_name) == Some(ProfileEgressTableClass::ReadOpen)
}

/// Closed or read-open: every ledger table.  Generic SQL writes to these are
/// rejected in both classes.
pub fn is_protected_table(table_name: &str) -> bool {
    table_class(table_name).is_some()
}

pub fn is_read_open_column(table_name: &str, column_name: &str) -> bool {
    PROFILE_EGRESS_READ_OPEN_COLUMNS.iter().any(|column| {
        column.table.eq_ignore_ascii_case(table_name)
            && column.column.eq_ignore_ascii_case(column_name)
    })
}

/// `change_events` / `state_snapshots`: unlisted tables whose generic-SQL
/// writes are rejected as a whole.
pub fn is_write_protected_feed_table(table_name: &str) -> bool {
    PROFILE_EGRESS_WRITE_PROTECTED_FEED_TABLES
        .iter()
        .any(|table| table.eq_ignore_ascii_case(table_name))
}

/// Whether restricted generic SQL may read the read-open class at all.
pub fn read_open_enabled() -> bool {
    PROFILE_EGRESS_READ_OPEN_ENABLED
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn names_of(class: ProfileEgressTableClass) -> BTreeSet<&'static str> {
        PROFILE_EGRESS_TABLES
            .iter()
            .filter(|table| table.class == class)
            .map(|table| table.name)
            .collect()
    }

    #[test]
    fn ledger_is_unique_and_has_the_confirmed_class_sizes() {
        let all = PROFILE_EGRESS_TABLES
            .iter()
            .map(|table| table.name)
            .collect::<BTreeSet<_>>();
        assert_eq!(all.len(), PROFILE_EGRESS_TABLES.len(), "duplicate table");
        assert_eq!(PROFILE_EGRESS_TABLES.len(), 84);
        // K3/2 "表の台帳": closed 26 + read-open 58 = the 84-table inventory.
        assert_eq!(names_of(ProfileEgressTableClass::Closed).len(), 26);
        assert_eq!(names_of(ProfileEgressTableClass::ReadOpen).len(), 58);
        for table in PROFILE_EGRESS_TABLES {
            assert_eq!(table.name, table.name.to_ascii_lowercase());
            assert_eq!(table.name, table.name.trim());
        }
    }

    #[test]
    fn closed_class_is_exactly_the_confirmed_enumeration_not_a_prefix_rule() {
        let expected: BTreeSet<&str> = [
            "narrative_apply_commits",
            "narrative_apply_operations",
            "narrative_commit_journals",
            "narrative_consumer_freshness",
            "narrative_extraction_artifacts",
            "narrative_extraction_attempts",
            "narrative_extraction_runs",
            "narrative_extraction_stage_model_bindings",
            "narrative_extraction_stage_receipts",
            "narrative_extraction_tasks",
            "narrative_maintenance_attention",
            "narrative_maintenance_finding_lifecycle",
            "narrative_maintenance_finding_observations",
            "narrative_proposal_applications",
            "narrative_proposal_decisions",
            "narrative_proposal_revisions",
            "narrative_proposal_sets",
            "narrative_proposals",
            "nir1_chat_input_captures",
            "nir1_chat_input_submission_keys",
            "nir1_generation_attempts",
            "nir1_generation_input_refs",
            "nir1_generation_message_versions",
            "nir1_generation_qualification_refs",
            "idempotency_requests",
            "messages",
        ]
        .into_iter()
        .collect();
        assert_eq!(names_of(ProfileEgressTableClass::Closed), expected);
        // Tables outside the enumeration are not closed merely because of
        // their prefix (K3/2: 27 `narrative_` tables are unlisted).
        for unlisted in [
            "narrative_scope_registries",
            "narrative_scene_scope_bindings",
            "narrative_change_events",
            "nir1_unknown_future_table",
        ] {
            assert_eq!(table_class(unlisted), None, "{unlisted}");
        }
    }

    #[test]
    fn read_open_class_holds_the_authors_own_data_surfaces() {
        for table in [
            "chat_sessions",
            "chat_messages",
            "chat_message_prompts",
            "chat_summaries",
            "chat_message_chunks",
            "chat_runtime_threads",
            "chat_messages_fts",
            "chat_messages_fts_en",
            "generation_logs",
            "ab_comparisons",
            "ab_comparison_runs",
            "ai_audit_events",
            "project_snapshot_tree_nodes",
            "project_snapshot_codex_entries",
            "project_snapshot_snippets",
            "project_snapshot_aux",
            "content_versions",
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
            "trash_items",
            "foreshadows",
            "foreshadow_setups",
            "foreshadow_payoffs",
            "foreshadow_setup_payoff_links",
            "foreshadow_codex_links",
            "plot_threads",
            "plot_thread_scene_links",
            "plot_thread_branches",
            "lint_ignored_diagnostics",
            "lint_term_dictionary",
        ] {
            assert!(is_read_open_table(table), "{table} must be read-open");
            assert!(!is_closed_table(table), "{table} must not be closed");
            assert!(is_protected_table(table), "{table} stays DML-protected");
        }
        assert!(is_closed_table("NARRATIVE_PROPOSALS"), "case-insensitive");
        assert!(is_read_open_table("Chat_Messages"), "case-insensitive");
    }

    #[test]
    fn fts_shadow_tables_carry_the_class_of_their_content_table() {
        // 18 shadow tables: chat_messages_fts(_en) and
        // post_effect_annotations_fts(_en), 4 + 5 each.
        let mut shadow_count = 0;
        for table in PROFILE_EGRESS_TABLES {
            for fts in [
                "chat_messages_fts",
                "chat_messages_fts_en",
                "post_effect_annotations_fts",
                "post_effect_annotations_fts_en",
            ] {
                let is_shadow = table
                    .name
                    .strip_prefix(&format!("{fts}_"))
                    .is_some_and(|suffix| {
                        matches!(suffix, "config" | "content" | "data" | "docsize" | "idx")
                    });
                if is_shadow {
                    shadow_count += 1;
                    assert_eq!(
                        Some(table.class),
                        table_class(fts),
                        "{} must share the class of {fts}",
                        table.name
                    );
                }
            }
        }
        assert_eq!(shadow_count, 18);
    }

    #[test]
    fn read_open_columns_are_the_two_feed_payloads_on_unlisted_tables() {
        assert_eq!(PROFILE_EGRESS_READ_OPEN_COLUMNS.len(), 2);
        assert!(is_read_open_column("change_events", "payload"));
        assert!(is_read_open_column("STATE_SNAPSHOTS", "Payload"));
        assert!(!is_read_open_column("change_events", "domain"));
        for column in PROFILE_EGRESS_READ_OPEN_COLUMNS {
            assert_eq!(table_class(column.table), None, "{}", column.table);
            assert!(is_write_protected_feed_table(column.table));
        }
        assert!(!is_write_protected_feed_table("app_settings"));
    }

    #[test]
    fn status_policy_is_version_two_with_three_separate_sets() {
        let policy = sql_policy_for_status();
        assert_eq!(policy.version, 2);
        assert_eq!(policy.closed_tables.len(), 26);
        assert_eq!(policy.read_open_tables.len(), 58);
        assert_eq!(policy.read_open_columns.len(), 2);
        let closed = policy.closed_tables.iter().collect::<BTreeSet<_>>();
        assert!(policy
            .read_open_tables
            .iter()
            .all(|table| !closed.contains(table)));
        let json = serde_json::to_value(&policy).expect("policy JSON");
        let mut keys = json
            .as_object()
            .expect("policy object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "closedTables",
                "readOpenColumns",
                "readOpenTables",
                "version"
            ]
        );
    }

    #[test]
    fn read_open_switch_is_open_after_the_opening_commit() {
        // The opening commit flipped PROFILE_EGRESS_READ_OPEN_ENABLED and this
        // assertion together (docs/plans/nir1-lane-decisions/da1-decisions.md).
        assert!(read_open_enabled());
    }
}
