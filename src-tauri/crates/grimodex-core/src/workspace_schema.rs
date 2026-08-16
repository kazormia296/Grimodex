//! Read-only compatibility probes shared by desktop workspace open and MCP.
//!
//! # Gate B2 schema renumbering (append-only)
//!
//! - **v3** — physical invariants (ai_audit, stickies, live-comment repair, …)
//! - **v4** — `narrative_runtime_policy` singleton (Gate B Foundation)
//! - **v5** — `codex_detail_semantic_bindings`
//! - **v6** — project_calendar OCC `version` column
//! - **v7** — Narrative Extraction persistence tables
//! - **v8** — Codex relation directionality / semantic_key / version
//! - **v9** — Detail Definition / Detail Value OCC columns
//! - **v10** — Temporal Constraint Graph tables (Nodes / Constraints / Projections)
//!
//!
//! These probes deliberately avoid exact whole-schema comparison because
//! legitimate upgraded databases can differ from a freshly-created database in
//! column order and normalized DDL while remaining compatible.

use rusqlite::{Connection, OptionalExtension};

use crate::{
    PREVIOUS_COMPATIBLE_SCHEMA_VERSION, PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION, SCHEMA_VERSION,
};

const AI_AUDIT_COLUMNS: &[(&str, &str, bool, i32)] = &[
    ("id", "INTEGER", false, 1),
    ("scope_id", "TEXT", true, 0),
    ("project_id", "TEXT", false, 0),
    ("sequence", "INTEGER", true, 0),
    ("event_id", "TEXT", true, 0),
    ("execution_id", "TEXT", true, 0),
    ("operation_id", "TEXT", true, 0),
    ("parent_execution_id", "TEXT", false, 0),
    ("path_id", "TEXT", true, 0),
    ("event_type", "TEXT", true, 0),
    ("timestamp", "INTEGER", true, 0),
    ("recorded_at", "INTEGER", true, 0),
    ("payload", "TEXT", true, 0),
    ("payload_sha256", "TEXT", true, 0),
    ("prev_hash", "TEXT", true, 0),
    ("hash", "TEXT", true, 0),
];

const AI_AUDIT_INDEXES: &[(&str, bool, &[&str])] = &[
    ("uq_ai_audit_scope_seq", true, &["scope_id", "sequence"]),
    ("uq_ai_audit_scope_event", true, &["scope_id", "event_id"]),
    (
        "idx_ai_audit_scope_execution",
        false,
        &["scope_id", "execution_id", "sequence"],
    ),
    (
        "idx_ai_audit_scope_execution_event_type",
        false,
        &["scope_id", "execution_id", "event_type"],
    ),
    (
        "idx_ai_audit_scope_operation",
        false,
        &["scope_id", "operation_id", "sequence"],
    ),
    (
        "idx_ai_audit_scope_timestamp",
        false,
        &["scope_id", "timestamp", "sequence"],
    ),
];

/// Whether a released v2 workspace already satisfies every migration added
/// after v2 and can therefore use the v3 open fast path without a schema write.
///
/// This function never mutates the connection. A `false` result asks the
/// caller to run the full idempotent migration; query failures remain errors so
/// corruption is not mistaken for an old-but-repairable schema.
pub fn is_converged_v2_workspace_schema(conn: &Connection) -> anyhow::Result<bool> {
    // The v2 → v3 marker-only fast path is frozen to schema 3. Schema 4+ must
    // run the full migrator so Native-owned tables (e.g. narrative_runtime_policy)
    // are created before the marker advances.
    if SCHEMA_VERSION != 3 || PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION != 3 {
        return Ok(false);
    }
    let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version != 2 {
        return Ok(false);
    }

    has_v3_physical_invariants(conn)
}

/// Whether a workspace carrying the immediately previous marker already
/// satisfies every current physical invariant and can therefore retain write
/// access while the desktop has not yet advanced the marker.
///
/// This function never mutates the connection. A `false` result asks the
/// caller to run the full idempotent migration; query failures remain errors so
/// corruption is not mistaken for an old-but-repairable schema.
pub fn is_previous_workspace_schema_write_compatible(conn: &Connection) -> anyhow::Result<bool> {
    // Fail closed after the next schema bump. The compatibility predicate must
    // always be reviewed together with the new physical checkpoint.
    if SCHEMA_VERSION != PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION {
        return Ok(false);
    }
    let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version != PREVIOUS_COMPATIBLE_SCHEMA_VERSION {
        return Ok(false);
    }

    has_current_schema_checkpoint_invariants(conn)
}

/// Compatibility wrapper used by older call sites／tests that still name the
/// v3 checkpoint explicitly.
pub fn has_v3_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    has_v3_physical_invariants(conn)
}

/// Physical schema and data repairs introduced after v2 that every current
/// schema must still satisfy.
pub fn has_v3_physical_invariants(conn: &Connection) -> anyhow::Result<bool> {
    for table in [
        "ai_audit_events",
        "post_effect_runs",
        "post_effect_annotations",
        "editor_stickies",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }

    let audit_columns = table_columns(conn, "ai_audit_events")?;
    if audit_columns.len() != AI_AUDIT_COLUMNS.len()
        || audit_columns
            .iter()
            .zip(AI_AUDIT_COLUMNS)
            .any(|(actual, expected)| {
                actual.name != expected.0
                    || actual.declared_type != expected.1
                    || actual.not_null != expected.2
                    || actual.default.is_some()
                    || actual.primary_key != expected.3
            })
    {
        return Ok(false);
    }

    let create_sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_audit_events'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )?
        .unwrap_or_default();
    let compact_sql = compact_sql(&create_sql);
    if !compact_sql.contains("idintegerprimarykeyautoincrement")
        || !compact_sql.contains(
            "check((scope_id='workspace'andproject_idisnull)or(project_idisnotnullandscope_id='project:'||project_id))",
        )
    {
        return Ok(false);
    }

    for (name, expected_unique, expected_columns) in AI_AUDIT_INDEXES {
        let properties = conn
            .query_row(
                "SELECT \"unique\", partial
                   FROM pragma_index_list('ai_audit_events')
                  WHERE name = ?1",
                [*name],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        if properties != Some((*expected_unique, false))
            || index_columns(conn, name)? != *expected_columns
        {
            return Ok(false);
        }
    }

    let has_foreign_key: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM pragma_foreign_key_list('ai_audit_events')
        )",
        [],
        |row| row.get(0),
    )?;
    if has_foreign_key {
        return Ok(false);
    }

    let has_unrepaired_live_comment: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM post_effect_annotations AS annotation
              JOIN post_effect_runs AS run ON run.id = annotation.run_id
             WHERE annotation.category = 'pseudo_comment'
               AND run.prompt_version = 'pseudo_comment_live_v1.0'
               AND COALESCE(
                     CASE
                       WHEN json_valid(annotation.metadata)
                       THEN json_extract(annotation.metadata, '$.live')
                       ELSE NULL
                     END,
                     0
                   ) != 1
             LIMIT 1
        )",
        [],
        |row| row.get(0),
    )?;

    Ok(!has_unrepaired_live_comment)
}

/// SCHEMA 4 checkpoint: Native-owned Narrative runtime policy singleton.
///
/// Does **not** chain to v3 inside itself; callers that need the full stack
/// must invoke [`has_v3_physical_invariants`] (or a later checkpoint that does).
pub fn has_v4_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_runtime_policy")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "narrative_runtime_policy")?;
    // INTEGER PRIMARY KEY reports notnull=0 in pragma_table_info even though it
    // is never NULL; match SQLite's physical report rather than SQL intent.
    let expected = [
        ("singleton_id", "INTEGER", false, 1),
        ("runtime_mode", "TEXT", true, 0),
        ("maintenance_enabled", "INTEGER", true, 0),
        ("generic_import_enabled", "INTEGER", true, 0),
        ("background_ai_enabled", "INTEGER", true, 0),
        ("version", "INTEGER", true, 0),
    ];
    if columns.len() != expected.len() {
        return Ok(false);
    }
    for (actual, (name, ty, not_null, pk)) in columns.iter().zip(expected) {
        if actual.name != name
            || actual.declared_type != ty
            || actual.not_null != not_null
            || actual.primary_key != pk
        {
            return Ok(false);
        }
    }
    let singleton: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_runtime_policy WHERE singleton_id = 1",
        [],
        |row| row.get(0),
    )?;
    Ok(singleton == 1)
}

/// SCHEMA 5 checkpoint: durable Detail semantic bindings on top of every v4
/// (runtime policy) invariant.
pub fn has_v5_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v4_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    if !table_exists(conn, "codex_detail_semantic_bindings")? {
        return Ok(false);
    }

    let columns = table_columns(conn, "codex_detail_semantic_bindings")?;
    let expected = [
        ("id", "TEXT", false, None, 1),
        ("project_id", "TEXT", true, None, 0),
        ("definition_id", "TEXT", true, None, 0),
        ("facet_key", "TEXT", true, None, 0),
        ("projection_kind", "TEXT", true, None, 0),
        ("temporal_policy", "TEXT", true, None, 0),
        ("source", "TEXT", true, None, 0),
        ("confirmed", "INTEGER", true, Some("0"), 0),
        ("version", "INTEGER", true, Some("0"), 0),
        ("created_at", "TEXT", true, Some("datetime('now')"), 0),
        ("updated_at", "TEXT", true, Some("datetime('now')"), 0),
    ];
    if columns.len() != expected.len()
        || columns.iter().zip(expected).any(|(actual, expected)| {
            actual.name != expected.0
                || actual.declared_type != expected.1
                || actual.not_null != expected.2
                || actual.default.as_deref() != expected.3
                || actual.primary_key != expected.4
        })
    {
        return Ok(false);
    }

    for (name, unique, expected_columns) in [
        (
            "uq_codex_detail_semantic_binding_definition_facet",
            true,
            &["definition_id", "facet_key"][..],
        ),
        (
            "idx_codex_detail_semantic_bindings_project_facet",
            false,
            &["project_id", "facet_key"][..],
        ),
    ] {
        let properties = conn
            .query_row(
                "SELECT \"unique\", partial
                   FROM pragma_index_list('codex_detail_semantic_bindings')
                  WHERE name = ?1",
                [name],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        if properties != Some((unique, false)) || index_columns(conn, name)? != expected_columns {
            return Ok(false);
        }
    }

    let owner_index = conn
        .query_row(
            "SELECT \"unique\", partial
               FROM pragma_index_list('codex_detail_definitions')
              WHERE name = 'uq_codex_detail_defs_project_id'",
            [],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?;
    if owner_index != Some((true, false))
        || index_columns(conn, "uq_codex_detail_defs_project_id")? != ["project_id", "id"]
    {
        return Ok(false);
    }

    let create_sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master
              WHERE type = 'table' AND name = 'codex_detail_semantic_bindings'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )?
        .unwrap_or_default();
    let compact = compact_sql(&create_sql);
    for required in [
        "check(projection_kindin('scalar-text','summary-text','enum','entity-reference'))",
        "check(temporal_policyin('base-only','phase-on-durable-change','base-and-phase','derived','manual-only'))",
        "check(sourcein('preset','user','reviewed-ai'))",
        "check(confirmedin(0,1))",
        "check(version>=0)",
        "project_idtextnotnullreferencesprojects(id)ondeletecascade",
        "foreignkey(project_id,definition_id)referencescodex_detail_definitions(project_id,id)ondeletecascade",
    ] {
        if !compact.contains(required) {
            return Ok(false);
        }
    }

    Ok(true)
}

/// SCHEMA 6 checkpoint: Calendar OCC token on top of every v5 invariant.
pub fn has_v6_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v5_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    if !table_exists(conn, "project_calendar")? {
        return Ok(false);
    }

    let columns = table_columns(conn, "project_calendar")?;
    Ok(columns.iter().any(|column| {
        column.name == "version"
            && column.declared_type == "INTEGER"
            && column.not_null
            && column.default.as_deref() == Some("0")
            && column.primary_key == 0
    }))
}

/// SCHEMA 7 checkpoint: Narrative Extraction persistence on top of every v6
/// invariant.
pub fn has_v7_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v6_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    Ok(table_exists(conn, "narrative_extraction_runs")?
        && table_exists(conn, "narrative_proposals")?
        && table_exists(conn, "narrative_apply_commits")?)
}

/// SCHEMA 8 checkpoint: Codex relation directionality / semantic_key / version.
pub fn has_v8_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v7_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    if !table_exists(conn, "codex_relations")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "codex_relations")?;
    let has_directionality = columns.iter().any(|column| {
        column.name == "directionality" && column.declared_type == "TEXT" && column.not_null
    });
    let has_inverse_label = columns.iter().any(|column| column.name == "inverse_label");
    let has_semantic_key = columns.iter().any(|column| {
        column.name == "semantic_key" && column.declared_type == "TEXT" && column.not_null
    });
    let has_version = columns.iter().any(|column| {
        column.name == "version"
            && column.declared_type == "INTEGER"
            && column.not_null
            && column.default.as_deref() == Some("1")
    });
    Ok(has_directionality && has_inverse_label && has_semantic_key && has_version)
}

/// SCHEMA 9 checkpoint: Detail Definition / Detail Value OCC columns on top of
/// every v8 invariant.
pub fn has_v9_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v8_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    if !table_exists(conn, "codex_detail_definitions")?
        || !table_exists(conn, "codex_detail_values")?
    {
        return Ok(false);
    }
    let definitions = table_columns(conn, "codex_detail_definitions")?;
    let values = table_columns(conn, "codex_detail_values")?;
    Ok(has_occ_integer_column(&definitions, "version")
        && has_timestamp_text_column(&definitions, "updated_at")
        && has_occ_integer_column(&values, "version")
        && has_timestamp_text_column(&values, "created_at")
        && has_timestamp_text_column(&values, "updated_at"))
}

/// SCHEMA 10 checkpoint: Temporal Constraint Graph persistence tables on top
/// of every v9 invariant.
pub fn has_v10_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v9_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    for table in [
        "narrative_temporal_nodes",
        "narrative_temporal_constraints",
        "narrative_temporal_projections",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }
    let nodes = table_columns(conn, "narrative_temporal_nodes")?;
    let constraints = table_columns(conn, "narrative_temporal_constraints")?;
    let projections = table_columns(conn, "narrative_temporal_projections")?;
    Ok(has_occ_integer_column(&nodes, "version")
        && has_timestamp_text_column(&nodes, "created_at")
        && has_timestamp_text_column(&nodes, "updated_at")
        && has_occ_integer_column(&constraints, "version")
        && has_timestamp_text_column(&constraints, "created_at")
        && has_timestamp_text_column(&constraints, "updated_at")
        && has_occ_integer_column(&projections, "version")
        && has_timestamp_text_column(&projections, "created_at")
        && has_timestamp_text_column(&projections, "updated_at"))
}

/// SCHEMA 11 checkpoint: Plot Thread OCC on top of every v10 invariant.
pub fn has_v11_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v10_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    let threads = table_columns(conn, "plot_threads")?;
    let links = table_columns(conn, "plot_thread_scene_links")?;
    let branches = table_columns(conn, "plot_thread_branches")?;
    Ok(has_occ_integer_column(&threads, "version")
        && has_occ_integer_column(&links, "version")
        && has_text_column(&links, "semantic_key")
        && has_occ_integer_column(&branches, "version")
        && has_text_column(&branches, "semantic_key"))
}

/// SCHEMA 12 checkpoint: Foreshadow Setup/Payoff aggregate tables with root OCC
/// on top of every v11 invariant.
pub fn has_v12_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v11_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    for table in [
        "foreshadows",
        "foreshadow_setups",
        "foreshadow_payoffs",
        "foreshadow_setup_payoff_links",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }

    let foreshadows = table_columns(conn, "foreshadows")?;
    let setups = table_columns(conn, "foreshadow_setups")?;
    let payoffs = table_columns(conn, "foreshadow_payoffs")?;
    let links = table_columns(conn, "foreshadow_setup_payoff_links")?;

    let has_column = |columns: &[ColumnShape], name: &str, declared_type: &str| {
        columns
            .iter()
            .any(|column| column.name == name && column.declared_type == declared_type)
    };

    Ok(has_occ_integer_column(&foreshadows, "version")
        && has_column(&foreshadows, "mechanism", "TEXT")
        && has_text_column(&setups, "role")
        && has_text_column(&setups, "semantic_key")
        && [
            "id",
            "foreshadow_id",
            "scene_id",
            "from_pos",
            "to_pos",
            "role",
            "confirmed",
            "is_primary",
            "attribution",
            "ai_rationale",
            "is_orphan",
            "evidence_anchor_id",
            "semantic_key",
            "created_at",
            "updated_at",
        ]
        .iter()
        .all(|name| payoffs.iter().any(|column| column.name == *name))
        && [
            "foreshadow_id",
            "setup_id",
            "payoff_id",
            "bridge_kind",
            "explanation",
            "created_at",
        ]
        .iter()
        .all(|name| links.iter().any(|column| column.name == *name)))
}

/// SCHEMA 13 checkpoint: Import Session persistence on top of every v12
/// invariant.
pub fn has_v13_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v12_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    if !table_exists(conn, "import_sessions")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "import_sessions")?;
    Ok([
        "id",
        "state",
        "target_json",
        "extraction_run_ids_json",
        "proposal_set_ids_json",
        "version",
        "created_at",
        "updated_at",
    ]
    .iter()
    .all(|name| columns.iter().any(|column| column.name == *name)))
}

/// Whether the live DB satisfies every checkpoint invariant for the *current*
/// [`SCHEMA_VERSION`]. Version 23 adds the Gate C2-01 Semantic Build Graph
/// (Dependency Edge / Edge State / Consumer Freshness / Application
/// Contribution / Finding Observation / Attention / Semantic Epoch tables),
/// per-entity Run/Task/Attempt status CHECK constraints, and Change Feed
/// consumer cursor reservation columns, while preserving the version 22
/// Foundation schema and every Gate B invariant through v20. Version 24 adds
/// the Gate C2 Run Kind Policy's Semantic Index metadata and Repair lease
/// tables, Dependency Edge State / Consumer Freshness baseline-digest
/// columns for Verify, and widens the Run `run_kind` CHECK to admit
/// `dependency-verify`/`dependency-repair`.
pub fn has_current_schema_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    Ok(SCHEMA_VERSION == 25
        && has_v3_physical_invariants(conn)?
        && has_v13_checkpoint_invariants(conn)?
        && table_exists(conn, "import_captures")?
        && has_v15_prepared_commit_columns(conn)?
        && has_v16_scene_event_incarnation_column(conn)?
        && has_v17_reconciliation_envelope_columns(conn)?
        && has_v18_projection_freshness_columns(conn)?
        && has_v19_field_authority_columns(conn)?
        && has_v20_retraction_columns(conn)?
        && has_v21_change_feed_columns(conn)?
        && has_v22_change_feed_writer_correlation(conn)?
        && has_change_feed_object_heads(conn)?
        && has_v23_semantic_build_graph_tables(conn)?
        && has_v23_execution_state_check_constraints(conn)?
        && has_v23_change_cursor_reservation_columns(conn)?
        && has_v24_run_kind_policy_tables(conn)?
        && has_v25_attention_occ_columns(conn)?)
}

/// SCHEMA 25: Maintenance Attention carries the OCC / request-identity /
/// actor columns its ADR 006 route requires. `set_by` is gone — `actor_id`
/// replaces it and is NOT NULL, so an unattributed disposition cannot be
/// written at all.
fn has_v25_attention_occ_columns(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_maintenance_attention")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "narrative_maintenance_attention")?;
    let has_column = |name: &str, declared_type: &str, not_null: bool| {
        columns.iter().any(|column| {
            column.name == name
                && column.declared_type == declared_type
                && column.not_null == not_null
        })
    };
    Ok(has_column("actor_id", "TEXT", true)
        && has_column("request_id", "TEXT", true)
        && has_column("payload_digest", "TEXT", true)
        && has_column("reason", "TEXT", false)
        && has_column("version", "INTEGER", true)
        && !columns.iter().any(|column| column.name == "set_by"))
}

fn has_v16_scene_event_incarnation_column(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "scene_events")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "scene_events")?;
    Ok(columns.iter().any(|column| {
        column.name == "incarnation_token"
            && column.declared_type == "TEXT"
            && column.not_null
            && column.default.as_deref() == Some("''")
    }))
}

fn has_v15_prepared_commit_columns(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_apply_commits")?
        || !table_exists(conn, "narrative_proposal_revisions")?
    {
        return Ok(false);
    }
    let commit_cols = table_columns(conn, "narrative_apply_commits")?;
    let revision_cols = table_columns(conn, "narrative_proposal_revisions")?;
    let has_text = |cols: &[ColumnShape], name: &str| {
        cols.iter()
            .any(|c| c.name == name && c.declared_type == "TEXT")
    };
    let has_int = |cols: &[ColumnShape], name: &str| {
        cols.iter()
            .any(|c| c.name == name && c.declared_type == "INTEGER")
    };
    Ok(has_text(&commit_cols, "prepared_plan_json")
        && has_int(&commit_cols, "prepared_policy_version")
        && has_text(&commit_cols, "prepared_at")
        && has_text(&commit_cols, "authority_digest")
        && has_text(&revision_cols, "plan_fragment_json")
        && has_text(&revision_cols, "plan_fragment_digest"))
}

fn has_v17_reconciliation_envelope_columns(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_proposal_revisions")?
        || !table_exists(conn, "narrative_revision_source_basis")?
    {
        return Ok(false);
    }
    let revisions = table_columns(conn, "narrative_proposal_revisions")?;
    let source_basis = table_columns(conn, "narrative_revision_source_basis")?;
    let has_text = |columns: &[ColumnShape], name: &str| {
        columns
            .iter()
            .any(|column| column.name == name && column.declared_type == "TEXT")
    };
    Ok(has_text(&revisions, "origin_kind")
        && has_text(&revisions, "reconciliation_envelope_json")
        && has_text(&revisions, "reconciliation_envelope_digest")
        && has_text(&source_basis, "revision_id")
        && has_text(&source_basis, "source_kind")
        && has_text(&source_basis, "source_key")
        && has_text(&source_basis, "revision_token"))
}

fn has_v18_projection_freshness_columns(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_projection_freshness")?
        || !table_exists(conn, "narrative_projection_dependencies")?
    {
        return Ok(false);
    }
    let freshness = table_columns(conn, "narrative_projection_freshness")?;
    let dependencies = table_columns(conn, "narrative_projection_dependencies")?;
    let has_text = |columns: &[ColumnShape], name: &str| {
        columns
            .iter()
            .any(|column| column.name == name && column.declared_type == "TEXT")
    };
    Ok(has_text(&freshness, "application_id")
        && has_text(&freshness, "status")
        && has_text(&freshness, "updated_at")
        && has_text(&dependencies, "application_id")
        && has_text(&dependencies, "source_kind")
        && has_text(&dependencies, "source_key")
        && has_text(&dependencies, "observed_revision_token")
        && has_text(&dependencies, "propagation"))
}

fn has_v19_field_authority_columns(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_field_authority")?
        || !table_exists(conn, "narrative_proposal_decisions")?
    {
        return Ok(false);
    }
    let authority = table_columns(conn, "narrative_field_authority")?;
    let decisions = table_columns(conn, "narrative_proposal_decisions")?;
    let has_text = |columns: &[ColumnShape], name: &str| {
        columns
            .iter()
            .any(|column| column.name == name && column.declared_type == "TEXT")
    };
    let has_int = |columns: &[ColumnShape], name: &str| {
        columns
            .iter()
            .any(|column| column.name == name && column.declared_type == "INTEGER")
    };
    Ok(has_text(&authority, "project_id")
        && has_text(&authority, "entity_kind")
        && has_text(&authority, "entity_id")
        && has_text(&authority, "field_path")
        && has_text(&authority, "owner_kind")
        && has_int(&authority, "explicit_lock")
        && has_int(&authority, "version")
        && has_text(&authority, "updated_at")
        && has_text(&decisions, "actor_kind")
        && has_text(&decisions, "actor_id")
        && has_text(&decisions, "authority_scope")
        && has_text(&decisions, "override_field_paths_json"))
}

fn has_v20_retraction_columns(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_proposal_applications")? {
        return Ok(false);
    }
    let applications = table_columns(conn, "narrative_proposal_applications")?;
    let has_text = |name: &str| {
        applications
            .iter()
            .any(|column| column.name == name && column.declared_type == "TEXT")
    };
    let triggers: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM sqlite_master
          WHERE type = 'trigger'
            AND name IN (
              'narrative_revision_immutable_after_apply_update',
              'narrative_revision_envelope_immutable_update',
              'narrative_source_basis_immutable_update',
              'narrative_source_basis_immutable_delete',
              'narrative_revision_immutable_after_apply_delete',
              'narrative_decision_immutable_after_apply_update',
              'narrative_decision_immutable_after_apply_delete',
              'narrative_application_immutable_update',
              'narrative_application_immutable_delete',
              'narrative_application_kind_guard',
              'narrative_application_compensation_guard'
            )",
        [],
        |row| row.get(0),
    )?;
    let source_delete_trigger: Option<String> = conn
        .query_row(
            "SELECT sql
               FROM sqlite_master
              WHERE type = 'trigger'
                AND name = 'narrative_source_basis_immutable_delete'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(has_text("application_kind")
        && has_text("compensates_application_id")
        && triggers == 11
        && source_delete_trigger
            .as_deref()
            .map(compact_sql)
            .is_some_and(|sql| {
                sql.contains(
                    "whenexists(select1fromnarrative_proposal_applicationswhererevision_id=old.revision_id)",
                )
            }))
}

fn has_v21_change_feed_columns(conn: &Connection) -> anyhow::Result<bool> {
    for table in [
        "narrative_change_transactions",
        "narrative_change_events",
        "narrative_change_cursors",
        "narrative_change_sets",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }

    let transactions = table_columns(conn, "narrative_change_transactions")?;
    let events = table_columns(conn, "narrative_change_events")?;
    let cursors = table_columns(conn, "narrative_change_cursors")?;
    let change_sets = table_columns(conn, "narrative_change_sets")?;
    let has_column = |columns: &[ColumnShape], name: &str, declared_type: &str, not_null: bool| {
        columns.iter().any(|column| {
            column.name == name
                && column.declared_type == declared_type
                && column.not_null == not_null
        })
    };

    let required_indexes = [
        (
            "idx_narrative_change_transactions_project_sequence",
            &["project_id", "source_change_event_sequence"][..],
        ),
        (
            "idx_narrative_change_events_project_sequence",
            &["project_id", "canonical_sequence", "event_ordinal"][..],
        ),
        (
            "idx_narrative_change_cursors_project",
            &["project_id", "consumer_id"][..],
        ),
        (
            "idx_narrative_change_sets_project_range",
            &[
                "project_id",
                "from_sequence_exclusive",
                "through_sequence_inclusive",
            ][..],
        ),
    ];
    for (index, expected_columns) in required_indexes {
        let actual_columns = index_columns(conn, index)?;
        if !actual_columns
            .iter()
            .map(String::as_str)
            .eq(expected_columns.iter().copied())
        {
            return Ok(false);
        }
    }

    let transaction_sql = compact_sql(&table_sql(conn, "narrative_change_transactions")?);
    let event_sql = compact_sql(&table_sql(conn, "narrative_change_events")?);

    Ok(has_column(&transactions, "id", "TEXT", true)
        && has_column(&transactions, "project_id", "TEXT", true)
        && has_column(&transactions, "request_id", "TEXT", true)
        && has_column(&transactions, "source_domain", "TEXT", true)
        && has_column(
            &transactions,
            "source_change_event_uid",
            "TEXT",
            true,
        )
        && has_column(
            &transactions,
            "source_change_event_sequence",
            "INTEGER",
            true,
        )
        && has_column(&transactions, "cause_kind", "TEXT", true)
        && has_column(
            &transactions,
            "original_transaction_id",
            "TEXT",
            false,
        )
        && has_column(&transactions, "commit_id", "TEXT", false)
        && has_column(&transactions, "journal_id", "TEXT", false)
        && has_column(&transactions, "application_ids_json", "TEXT", true)
        && has_column(&transactions, "payload_digest", "TEXT", true)
        && has_column(&transactions, "created_at", "TEXT", true)
        && has_column(&events, "id", "TEXT", true)
        && has_column(&events, "project_id", "TEXT", true)
        && has_column(&events, "transaction_id", "TEXT", true)
        && has_column(&events, "canonical_change_event_uid", "TEXT", true)
        && has_column(&events, "canonical_sequence", "INTEGER", true)
        && has_column(&events, "event_ordinal", "INTEGER", true)
        && has_column(&events, "object_key_json", "TEXT", true)
        && has_column(&events, "change_kind", "TEXT", true)
        && has_column(&events, "mutation_kind", "TEXT", true)
        && has_column(&events, "before_version", "INTEGER", false)
        && has_column(&events, "before_digest", "TEXT", false)
        && has_column(&events, "after_version", "INTEGER", false)
        && has_column(&events, "after_digest", "TEXT", false)
        && has_column(&events, "changed_paths_json", "TEXT", true)
        && has_column(&events, "text_impact_json", "TEXT", false)
        && has_column(&events, "structural_impact_json", "TEXT", false)
        && has_column(&events, "occurred_at", "TEXT", true)
        && has_column(&cursors, "project_id", "TEXT", true)
        && has_column(&cursors, "consumer_id", "TEXT", true)
        && has_column(
            &cursors,
            "acknowledged_through_sequence",
            "INTEGER",
            true,
        )
        && has_column(&cursors, "lease_owner", "TEXT", false)
        && has_column(&cursors, "lease_expires_at", "TEXT", false)
        && has_column(&cursors, "last_error", "TEXT", false)
        && has_column(&cursors, "updated_at", "TEXT", true)
        && has_column(&change_sets, "id", "TEXT", true)
        && has_column(&change_sets, "project_id", "TEXT", true)
        && has_column(
            &change_sets,
            "from_sequence_exclusive",
            "INTEGER",
            true,
        )
        && has_column(
            &change_sets,
            "through_sequence_inclusive",
            "INTEGER",
            true,
        )
        && has_column(&change_sets, "event_ids_json", "TEXT", true)
        && has_column(&change_sets, "affected_objects_json", "TEXT", true)
        && has_column(&change_sets, "digest", "TEXT", true)
        && has_column(&change_sets, "created_at", "TEXT", true)
        && transaction_sql.contains(
            "foreignkey(project_id,source_change_event_uid)referenceschange_events(project_id,event_uid)",
        )
        && transaction_sql.contains(
            "foreignkey(project_id,original_transaction_id)referencesnarrative_change_transactions(project_id,id)ondeletecascade",
        )
        && event_sql.contains(
            "foreignkey(project_id,transaction_id)referencesnarrative_change_transactions(project_id,id)",
        )
        && event_sql.contains(
            "foreignkey(project_id,canonical_change_event_uid)referenceschange_events(project_id,event_uid)",
        ))
}

fn has_v22_change_feed_writer_correlation(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_change_transactions")? {
        return Ok(false);
    }
    let transactions = table_columns(conn, "narrative_change_transactions")?;
    let has_required_origin = transactions.iter().any(|column| {
        column.name == "origin"
            && column.declared_type == "TEXT"
            && column.not_null
            && column.default.is_none()
    });
    let has_optional_undo_journal = transactions.iter().any(|column| {
        column.name == "undo_journal_id"
            && column.declared_type == "TEXT"
            && !column.not_null
            && column.default.is_none()
    });
    if !has_required_origin || !has_optional_undo_journal {
        return Ok(false);
    }
    let transaction_sql = compact_sql(&table_sql(conn, "narrative_change_transactions")?);
    Ok(transaction_sql.contains(
        "check(originin('human','ai-apply','import','undo','redo','restore','migration'))",
    ))
}

fn has_change_feed_object_heads(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_change_object_heads")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "narrative_change_object_heads")?;
    let required_columns = [
        ("project_id", "TEXT", true),
        ("object_identity", "TEXT", true),
        ("after_version", "INTEGER", false),
        ("after_digest", "TEXT", false),
        ("event_id", "TEXT", true),
        ("canonical_sequence", "INTEGER", true),
        ("event_ordinal", "INTEGER", true),
        ("updated_at", "TEXT", true),
    ];
    let has_columns = required_columns.iter().all(|(name, declared, not_null)| {
        columns.iter().any(|column| {
            column.name == *name
                && column.declared_type == *declared
                && column.not_null == *not_null
        })
    });
    if !has_columns {
        return Ok(false);
    }
    let identity_index = index_columns(conn, "sqlite_autoindex_narrative_change_object_heads_1")?;
    let sequence_index = index_columns(conn, "idx_narrative_change_object_heads_project_sequence")?;
    Ok(identity_index
        .iter()
        .map(String::as_str)
        .eq(["project_id", "object_identity"])
        && sequence_index.iter().map(String::as_str).eq([
            "project_id",
            "canonical_sequence",
            "event_ordinal",
        ]))
}

fn has_v23_semantic_build_graph_tables(conn: &Connection) -> anyhow::Result<bool> {
    for table in [
        "narrative_semantic_epochs",
        "narrative_dependency_edges",
        "narrative_dependency_edge_states",
        "narrative_consumer_freshness",
        "narrative_application_contributions",
        "narrative_maintenance_finding_observations",
        "narrative_maintenance_attention",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }

    let has_column = |columns: &[ColumnShape], name: &str, declared_type: &str, not_null: bool| {
        columns.iter().any(|column| {
            column.name == name
                && column.declared_type == declared_type
                && column.not_null == not_null
        })
    };

    let epochs = table_columns(conn, "narrative_semantic_epochs")?;
    let edges = table_columns(conn, "narrative_dependency_edges")?;
    let edge_states = table_columns(conn, "narrative_dependency_edge_states")?;
    let freshness = table_columns(conn, "narrative_consumer_freshness")?;
    let contributions = table_columns(conn, "narrative_application_contributions")?;
    let observations = table_columns(conn, "narrative_maintenance_finding_observations")?;
    let attention = table_columns(conn, "narrative_maintenance_attention")?;

    let epochs_ok = has_column(&epochs, "id", "TEXT", true)
        && has_column(&epochs, "project_id", "TEXT", true)
        && has_column(&epochs, "epoch_number", "INTEGER", true)
        && has_column(&epochs, "reason", "TEXT", true)
        && has_column(&epochs, "triggered_by_change_event_uid", "TEXT", false)
        && has_column(&epochs, "created_at", "TEXT", true);

    let edges_ok = has_column(&edges, "id", "TEXT", true)
        && has_column(&edges, "project_id", "TEXT", true)
        && has_column(&edges, "consumer_kind", "TEXT", true)
        && has_column(&edges, "consumer_key", "TEXT", true)
        && has_column(&edges, "source_object_identity", "TEXT", true)
        && has_column(&edges, "read_set_json", "TEXT", true)
        && has_column(&edges, "generated_by_transaction_id", "TEXT", false)
        && has_column(&edges, "created_at", "TEXT", true);

    let edge_states_ok = has_column(&edge_states, "edge_id", "TEXT", true)
        && has_column(&edge_states, "project_id", "TEXT", true)
        && has_column(&edge_states, "evidence_freshness", "TEXT", true)
        && has_column(&edge_states, "reason_code", "TEXT", false)
        && has_column(&edge_states, "build_action", "TEXT", true)
        && has_column(&edge_states, "evaluated_at_epoch_id", "TEXT", true)
        && has_column(&edge_states, "evaluated_at", "TEXT", true);

    let freshness_ok = has_column(&freshness, "project_id", "TEXT", true)
        && has_column(&freshness, "consumer_kind", "TEXT", true)
        && has_column(&freshness, "consumer_key", "TEXT", true)
        && has_column(&freshness, "evidence_freshness", "TEXT", true)
        && has_column(&freshness, "build_action", "TEXT", true)
        && has_column(&freshness, "semantic_epoch_id", "TEXT", true)
        && has_column(&freshness, "last_evaluated_run_id", "TEXT", false)
        && has_column(&freshness, "updated_at", "TEXT", true);

    let contributions_ok = has_column(&contributions, "id", "TEXT", true)
        && has_column(&contributions, "project_id", "TEXT", true)
        && has_column(&contributions, "application_id", "TEXT", true)
        && has_column(&contributions, "target_object_identity", "TEXT", true)
        && has_column(&contributions, "field_path", "TEXT", true)
        && has_column(&contributions, "target_state", "TEXT", true)
        && has_column(&contributions, "created_at", "TEXT", true);

    let observations_ok = has_column(&observations, "id", "TEXT", true)
        && has_column(&observations, "project_id", "TEXT", true)
        && has_column(&observations, "run_id", "TEXT", true)
        && has_column(&observations, "semantic_epoch_id", "TEXT", true)
        && has_column(&observations, "edge_id", "TEXT", false)
        && has_column(&observations, "finding_key", "TEXT", true)
        && has_column(&observations, "reason_code", "TEXT", true)
        && has_column(&observations, "evidence_freshness_snapshot", "TEXT", true)
        && has_column(&observations, "material_basis_digest", "TEXT", true)
        && has_column(&observations, "observed_at", "TEXT", true);

    let attention_ok = has_column(&attention, "project_id", "TEXT", true)
        && has_column(&attention, "finding_key", "TEXT", true)
        && has_column(&attention, "disposition", "TEXT", true)
        && has_column(&attention, "material_basis_digest", "TEXT", true)
        && has_column(&attention, "snoozed_until", "TEXT", false)
        && has_column(&attention, "set_at", "TEXT", true);
    // `set_by` deliberately absent: SCHEMA 25 replaced that nullable column
    // with the NOT NULL `actor_id`, checked by
    // `has_v25_attention_occ_columns`. Asserting it here would make the
    // current schema fail its own invariants.

    let attention_sql = compact_sql(&table_sql(conn, "narrative_maintenance_attention")?);
    let freshness_sql = compact_sql(&table_sql(conn, "narrative_consumer_freshness")?);

    Ok(epochs_ok
        && edges_ok
        && edge_states_ok
        && freshness_ok
        && contributions_ok
        && observations_ok
        && attention_ok
        // Attention is a durable, non-epoch-bound, no-backflow typed-writer
        // table: its disposition enum must never include a Freshness value,
        // which would make it look like a second Freshness authority.
        && attention_sql.contains("check(dispositionin('snoozed','dismissed','flagged'))")
        // The one Freshness authority: evidence_freshness stays a closed
        // enum on the canonical current-value table.
        && freshness_sql.contains(
            "check(evidence_freshnessin('fresh','stale','source-missing','anchor-mismatch','read-set-drift','unknown'))",
        ))
}

fn has_v23_execution_state_check_constraints(conn: &Connection) -> anyhow::Result<bool> {
    for table in [
        "narrative_extraction_runs",
        "narrative_extraction_tasks",
        "narrative_extraction_attempts",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }

    let runs = table_columns(conn, "narrative_extraction_runs")?;
    let attempts = table_columns(conn, "narrative_extraction_attempts")?;
    let has_column = |columns: &[ColumnShape], name: &str, declared_type: &str, not_null: bool| {
        columns.iter().any(|column| {
            column.name == name
                && column.declared_type == declared_type
                && column.not_null == not_null
        })
    };

    let runs_columns_ok = has_column(&runs, "run_kind", "TEXT", true)
        && has_column(&runs, "consumer_id", "TEXT", false)
        && has_column(&runs, "semantic_epoch_id", "TEXT", false)
        && has_column(&runs, "work_key", "TEXT", false)
        && has_column(&runs, "terminal_reason_code", "TEXT", false)
        && has_column(&runs, "superseded_by_run_id", "TEXT", false);

    let attempts_columns_ok = has_column(&attempts, "failure_code", "TEXT", false)
        && has_column(&attempts, "retry_disposition", "TEXT", false)
        && has_column(&attempts, "policy_version", "TEXT", false)
        && has_column(&attempts, "next_attempt_at", "TEXT", false);

    let runs_sql = compact_sql(&table_sql(conn, "narrative_extraction_runs")?);
    let tasks_sql = compact_sql(&table_sql(conn, "narrative_extraction_tasks")?);
    let attempts_sql = compact_sql(&table_sql(conn, "narrative_extraction_attempts")?);

    Ok(runs_columns_ok
        && attempts_columns_ok
        && runs_sql.contains(
            "check(statusin('pending','running','completed','failed','cancelled','superseded'))",
        )
        && tasks_sql.contains(
            "check(statusin('queued','running','completed','failed','cancelled'))",
        )
        && attempts_sql.contains("check(statusin('running','completed','failed'))")
        && attempts_sql.contains("check(failure_codeisnullorfailure_codeglob'nex_*')")
        && attempts_sql.contains(
            "check(retry_dispositionisnullorretry_dispositionin('retryable','terminal','superseded','manual'))",
        ))
}

fn has_v23_change_cursor_reservation_columns(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_change_cursors")? {
        return Ok(false);
    }
    let cursors = table_columns(conn, "narrative_change_cursors")?;
    let has_column = |columns: &[ColumnShape], name: &str, declared_type: &str, not_null: bool| {
        columns.iter().any(|column| {
            column.name == name
                && column.declared_type == declared_type
                && column.not_null == not_null
        })
    };
    let columns_ok = has_column(&cursors, "semantic_epoch_id", "TEXT", false)
        && has_column(&cursors, "reserved_through_sequence", "INTEGER", false)
        && has_column(&cursors, "active_run_id", "TEXT", false);
    if !columns_ok {
        return Ok(false);
    }
    let cursors_sql = compact_sql(&table_sql(conn, "narrative_change_cursors")?);
    Ok(cursors_sql.contains(
        "check((active_run_idisnullandreserved_through_sequenceisnull)or(active_run_idisnotnullandreserved_through_sequenceisnotnullandsemantic_epoch_idisnotnull))",
    ) && cursors_sql.contains(
        "check(reserved_through_sequenceisnullorreserved_through_sequence>=acknowledged_through_sequence)",
    ))
}

fn has_v24_run_kind_policy_tables(conn: &Connection) -> anyhow::Result<bool> {
    for table in [
        "narrative_semantic_index_metadata",
        "narrative_maintenance_repair_leases",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }
    if !table_exists(conn, "narrative_dependency_edge_states")?
        || !table_exists(conn, "narrative_consumer_freshness")?
        || !table_exists(conn, "narrative_extraction_runs")?
    {
        return Ok(false);
    }

    let has_column = |columns: &[ColumnShape], name: &str, declared_type: &str, not_null: bool| {
        columns.iter().any(|column| {
            column.name == name
                && column.declared_type == declared_type
                && column.not_null == not_null
        })
    };

    let index_metadata = table_columns(conn, "narrative_semantic_index_metadata")?;
    let repair_leases = table_columns(conn, "narrative_maintenance_repair_leases")?;
    let edge_states = table_columns(conn, "narrative_dependency_edge_states")?;
    let freshness = table_columns(conn, "narrative_consumer_freshness")?;

    let index_metadata_ok = has_column(&index_metadata, "project_id", "TEXT", true)
        && has_column(&index_metadata, "index_key", "TEXT", true)
        && has_column(&index_metadata, "generation", "INTEGER", true)
        && has_column(&index_metadata, "built_at", "TEXT", true)
        && has_column(&index_metadata, "source_digest", "TEXT", true)
        && has_column(&index_metadata, "dependency_set_digest", "TEXT", true)
        && has_column(&index_metadata, "dirty_cache_flag", "INTEGER", true);

    let repair_leases_ok = has_column(&repair_leases, "project_id", "TEXT", true)
        && has_column(&repair_leases, "lease_owner", "TEXT", true)
        && has_column(&repair_leases, "verify_run_id", "TEXT", true)
        && has_column(&repair_leases, "repair_plan_digest", "TEXT", true)
        && has_column(&repair_leases, "semantic_epoch_id", "TEXT", true)
        && has_column(&repair_leases, "claimed_at", "TEXT", true)
        && has_column(&repair_leases, "expires_at", "TEXT", true);

    let baseline_columns_ok =
        has_column(
            &edge_states,
            "observed_source_revision_token",
            "TEXT",
            false,
        ) && has_column(&edge_states, "observed_source_digest", "TEXT", false)
            && has_column(&freshness, "dependency_set_digest", "TEXT", false);

    if !(index_metadata_ok && repair_leases_ok && baseline_columns_ok) {
        return Ok(false);
    }

    let index_metadata_sql = compact_sql(&table_sql(conn, "narrative_semantic_index_metadata")?);
    let repair_leases_sql = compact_sql(&table_sql(conn, "narrative_maintenance_repair_leases")?);
    let runs_sql = compact_sql(&table_sql(conn, "narrative_extraction_runs")?);

    Ok(index_metadata_sql.contains("check(generation>=0)")
        && index_metadata_sql.contains("check(dirty_cache_flagin(0,1))")
        && repair_leases_sql.contains("primarykey(project_id)")
        && runs_sql.contains(
            "check(run_kindin('interpretation','freshness-evaluation','semantic-index-rebuild','manual-rebuild','backfill','dependency-verify','dependency-repair'))",
        ))
}

fn has_occ_integer_column(columns: &[ColumnShape], name: &str) -> bool {
    columns.iter().any(|column| {
        column.name == name
            && column.declared_type == "INTEGER"
            && column.not_null
            && column.default.as_deref() == Some("0")
    })
}

fn has_timestamp_text_column(columns: &[ColumnShape], name: &str) -> bool {
    columns
        .iter()
        .any(|column| column.name == name && column.declared_type == "TEXT" && column.not_null)
}

fn has_text_column(columns: &[ColumnShape], name: &str) -> bool {
    columns
        .iter()
        .any(|column| column.name == name && column.declared_type == "TEXT" && column.not_null)
}

fn table_exists(conn: &Connection, table: &str) -> anyhow::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
        )",
        [table],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn table_sql(conn: &Connection, table: &str) -> anyhow::Result<String> {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

struct ColumnShape {
    name: String,
    declared_type: String,
    not_null: bool,
    default: Option<String>,
    primary_key: i32,
}

fn table_columns(conn: &Connection, table: &str) -> anyhow::Result<Vec<ColumnShape>> {
    let mut statement = conn.prepare(
        "SELECT name, type, \"notnull\", dflt_value, pk
           FROM pragma_table_info(?1)
          ORDER BY cid",
    )?;
    let columns = statement
        .query_map([table], |row| {
            Ok(ColumnShape {
                name: row.get(0)?,
                declared_type: row.get::<_, String>(1)?.to_ascii_uppercase(),
                not_null: row.get(2)?,
                default: row.get(3)?,
                primary_key: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow::Error::from)?;
    Ok(columns)
}

fn index_columns(conn: &Connection, index: &str) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")?;
    let columns = statement
        .query_map([index], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow::Error::from)?;
    Ok(columns)
}

fn compact_sql(sql: &str) -> String {
    sql.chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn converged_v2_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open fixture database");
        conn.execute_batch(
            "PRAGMA user_version = 2;
             CREATE TABLE ai_audit_events (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                scope_id            TEXT NOT NULL,
                project_id          TEXT,
                sequence            INTEGER NOT NULL,
                event_id            TEXT NOT NULL,
                execution_id        TEXT NOT NULL,
                operation_id        TEXT NOT NULL,
                parent_execution_id TEXT,
                path_id             TEXT NOT NULL,
                event_type          TEXT NOT NULL,
                timestamp           INTEGER NOT NULL,
                recorded_at         INTEGER NOT NULL,
                payload             TEXT NOT NULL,
                payload_sha256      TEXT NOT NULL,
                prev_hash           TEXT NOT NULL,
                hash                TEXT NOT NULL,
                CHECK (
                    (scope_id = 'workspace' AND project_id IS NULL)
                    OR
                    (project_id IS NOT NULL AND scope_id = 'project:' || project_id)
                )
             );
             CREATE UNIQUE INDEX uq_ai_audit_scope_seq
                ON ai_audit_events(scope_id, sequence);
             CREATE UNIQUE INDEX uq_ai_audit_scope_event
                ON ai_audit_events(scope_id, event_id);
             CREATE INDEX idx_ai_audit_scope_execution
                ON ai_audit_events(scope_id, execution_id, sequence);
             CREATE INDEX idx_ai_audit_scope_execution_event_type
                ON ai_audit_events(scope_id, execution_id, event_type);
             CREATE INDEX idx_ai_audit_scope_operation
                ON ai_audit_events(scope_id, operation_id, sequence);
             CREATE INDEX idx_ai_audit_scope_timestamp
                ON ai_audit_events(scope_id, timestamp, sequence);
             CREATE TABLE post_effect_runs (
                id TEXT PRIMARY KEY,
                prompt_version TEXT NOT NULL
             );
             CREATE TABLE post_effect_annotations (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                category TEXT NOT NULL,
                metadata TEXT
             );
             CREATE TABLE editor_stickies (
                id TEXT PRIMARY KEY
             );",
        )
        .expect("create converged v2 fixture");
        conn
    }

    #[test]
    fn schema_4_disables_v2_marker_fast_path() {
        let conn = converged_v2_connection();
        assert!(!is_converged_v2_workspace_schema(&conn).expect("inspect fixture"));
        assert!(has_v3_physical_invariants(&conn).expect("v3 physical still holds"));
    }

    #[test]
    fn recognizes_the_historical_v3_checkpoint_but_does_not_skip_v4() {
        let conn = converged_v2_connection();
        assert!(has_v3_checkpoint_invariants(&conn).expect("inspect v3 fixture"));
        // Current is v7; previous-marker write compat needs full current invariants.
        assert!(!is_previous_workspace_schema_write_compatible(&conn)
            .expect("inspect current compatibility"));

        conn.execute_batch("DROP INDEX idx_ai_audit_scope_timestamp")
            .expect("remove required index");
        assert!(!has_v3_checkpoint_invariants(&conn).expect("inspect partial fixture"));
    }

    #[test]
    fn rejects_unrepaired_live_comment_metadata() {
        let conn = converged_v2_connection();
        conn.execute(
            "INSERT INTO post_effect_runs (id, prompt_version)
             VALUES ('live-run', 'pseudo_comment_live_v1.0')",
            [],
        )
        .expect("insert live run");
        conn.execute(
            "INSERT INTO post_effect_annotations (id, run_id, category, metadata)
             VALUES ('live-ann', 'live-run', 'pseudo_comment', '{}')",
            [],
        )
        .expect("insert unrepaired annotation");

        assert!(!has_v3_physical_invariants(&conn).expect("inspect legacy metadata"));
    }

    #[test]
    fn rejects_v2_schema_without_editor_stickies() {
        let conn = converged_v2_connection();
        conn.execute_batch("DROP TABLE editor_stickies")
            .expect("remove editor sticky invariant");

        assert!(!has_v3_physical_invariants(&conn).expect("inspect missing stickies"));
    }

    #[test]
    fn rejects_partial_audit_index() {
        let conn = converged_v2_connection();
        conn.execute_batch(
            "DROP INDEX uq_ai_audit_scope_event;
             CREATE UNIQUE INDEX uq_ai_audit_scope_event
                ON ai_audit_events(scope_id, event_id)
                WHERE 0;",
        )
        .expect("replace required index with partial index");

        assert!(!has_v3_physical_invariants(&conn).expect("inspect partial index"));
    }

    #[test]
    fn rejects_audit_schema_without_scope_constraint() {
        let conn = converged_v2_connection();
        conn.execute_batch(
            "DROP TABLE ai_audit_events;
             CREATE TABLE ai_audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope_id TEXT NOT NULL,
                project_id TEXT,
                sequence INTEGER NOT NULL,
                event_id TEXT NOT NULL,
                execution_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                parent_execution_id TEXT,
                path_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                recorded_at INTEGER NOT NULL,
                payload TEXT NOT NULL,
                payload_sha256 TEXT NOT NULL,
                prev_hash TEXT NOT NULL,
                hash TEXT NOT NULL
             );",
        )
        .expect("replace audit table without CHECK");

        assert!(!has_v3_physical_invariants(&conn).expect("inspect missing CHECK"));
    }

    #[test]
    fn v4_checkpoint_requires_singleton_policy_row() {
        let conn = converged_v2_connection();
        assert!(!has_v4_checkpoint_invariants(&conn).expect("missing table"));
        conn.execute_batch(
            "CREATE TABLE narrative_runtime_policy (
                singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                runtime_mode TEXT NOT NULL,
                maintenance_enabled INTEGER NOT NULL,
                generic_import_enabled INTEGER NOT NULL,
                background_ai_enabled INTEGER NOT NULL,
                version INTEGER NOT NULL DEFAULT 1
             );
             INSERT INTO narrative_runtime_policy (
                singleton_id, runtime_mode, maintenance_enabled,
                generic_import_enabled, background_ai_enabled, version
             ) VALUES (1, 'review-only', 0, 0, 0, 1);",
        )
        .expect("create policy");
        assert!(has_v4_checkpoint_invariants(&conn).expect("policy present"));
    }
}
