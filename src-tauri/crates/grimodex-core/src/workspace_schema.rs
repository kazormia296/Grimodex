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

// The generated contract is the canonical, migration-produced definition of
// every SQLite trigger.  The current-schema checkpoint embeds the artifact so
// a same-name trigger with merely plausible fragments cannot make the open
// fast path skip an in-version repair.  `schema-contract` regeneration and its
// parity test keep this read-only authority synchronized with `migrate.rs`.
const GENERATED_SCHEMA_CONTRACT: &str =
    include_str!("../../../../src/db/generated/schema-contract.json");

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
/// `dependency-verify`/`dependency-repair`. Version 28 rewrites Application
/// Contribution target identities into the ratified Object Addressing
/// vocabulary; it changes no table, column, or constraint, so it adds no
/// physical invariant of its own — only the version guard below moves.
/// Version 30 records on each Dependency Edge the Run that declared it, so
/// resolving a `snapshot:<runId>` Source no longer depends on the Consumer
/// key happening to be a Run id. Version 31 adds the bundled Finding Rule
/// identity/digest columns and append-only lifecycle records. Version 32
/// re-keys legacy Backfill Run Edges onto Application Consumers and records
/// the completion marker only after every project passes preflight. Version
/// 33 adds sealed Dependency declaration sets, immutable entries, and
/// optimistic Consumer heads for the NIR-0 D1 storage boundary. Version 34
/// adds C2A's durable stage audit metadata and the structural V2 lineage
/// monotonicity guard. SCHEMA 34 also carries an in-version repair that
/// atomically projects non-empty body creation baselines from the canonical
/// Narrative Change Feed lifecycle event.
pub fn has_current_schema_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    Ok(SCHEMA_VERSION == 35
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
        && has_v25_attention_occ_columns(conn)?
        && has_v26_run_request_identity_columns(conn)?
        && has_v27_repair_lease_run_binding(conn)?
        && has_v30_dependency_edge_owning_run_column(conn)?
        && has_v31_finding_identity_columns(conn)?
        && has_c2_finding_identity_data_migration_marker(conn)?
        // SCHEMA 28 carries a data migration, so without this both of
        // `migrate_impl`'s fast paths skip it: see
        // `has_c2_identity_data_migration_marker`. This supersedes the
        // row-shape probe this branch briefly carried -- see that function
        // for why current rows cannot answer the question.
        && has_c2_identity_data_migration_marker(conn)?
        // Gate C2-2's Consumer grain re-key is a data migration too, and the
        // same fast paths would skip it.
        && has_c2_consumer_grain_data_migration_marker(conn)?
        // Gate C2-ZB's Application re-key is a data migration too. Its
        // marker is written last inside the schema-owned savepoint.
        && has_c2_application_rekey_data_migration_marker(conn)?
        // D1 stores only complete, sealed Dependency declaration sets. The
        // physical shape is checked here before the schema marker advances;
        // V2 remains a non-authoritative shadow until a later cutover lane.
        && has_v33_dependency_declaration_storage(conn)?
        && has_v34_c2a_stage_storage(conn)?
        && has_v35_nir1_index_storage(conn)?
        && has_current_query_indexes(conn)?
        // The durable wake outbox and the V2 pointer monotonicity guard ship
        // as an in-version repair of SCHEMA 34: their absence forces a full
        // idempotent DDL replay rather than a version bump.
        && table_exists(conn, "narrative_maintenance_wake_outbox")?
        && has_timelapse_creation_baseline_triggers(conn)?)
}

fn has_v35_nir1_index_storage(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_nir1_chronicle_vectors")? {
        return Ok(false);
    }
    let metadata = table_columns(conn, "narrative_semantic_index_metadata")?;
    if !["producer_id", "producer_version"].iter().all(|name| {
        metadata.iter().any(|column| {
            column.name == *name && column.declared_type == "TEXT" && !column.not_null
        })
    }) {
        return Ok(false);
    }
    let columns = table_columns(conn, "narrative_nir1_chronicle_vectors")?;
    let expected = [
        ("project_id", "TEXT"),
        ("revision_id", "TEXT"),
        ("generation", "INTEGER"),
        ("envelope_digest", "TEXT"),
        ("statement_digest", "TEXT"),
        ("serializer_ref", "TEXT"),
        ("model_id", "TEXT"),
        ("artifact_sha256", "TEXT"),
        ("tokenizer_sha256", "TEXT"),
        ("embedding_dim", "INTEGER"),
        ("chunker_version", "TEXT"),
        ("audit_operation_id", "TEXT"),
        ("audit_execution_id", "TEXT"),
        ("embedding", "BLOB"),
    ];
    let shape = columns.len() == expected.len()
        && columns
            .iter()
            .zip(expected)
            .enumerate()
            .all(|(i, (column, (name, kind)))| {
                column.name == name
                    && column.declared_type == kind
                    && column.not_null
                    && column.primary_key == if i < 2 { (i + 1) as i32 } else { 0 }
            });
    let sql = compact_sql(&table_sql(conn, "narrative_nir1_chronicle_vectors")?);
    Ok(shape
        && sql.contains("check(generation>0)")
        && sql.contains("check(embedding_dim>0)")
        && sql.contains("check(length(embedding)=embedding_dim*4)")
        && foreign_key_matches(
            conn,
            "narrative_nir1_chronicle_vectors",
            "project_id",
            "projects",
            "id",
        )?)
}

/// Keep Timelapse and NIR1 accepted-artifact lookup indexes in the physical
/// checkpoint. Older workspaces repair them through the idempotent migrator
/// instead of repeatedly scanning unrelated projects, Runs and Attempts.
fn has_current_query_indexes(conn: &Connection) -> anyhow::Result<bool> {
    for (table, name, expected_columns) in [
        (
            "change_events",
            "idx_change_events_project_domain_op_entity_seq",
            ["project_id", "domain", "op_type", "entity_id", "sequence"].as_slice(),
        ),
        (
            "state_snapshots",
            "idx_state_snap_project_domain_type_entity_seq",
            [
                "project_id",
                "domain",
                "entity_id",
                "entity_type",
                "anchor_sequence",
            ]
            .as_slice(),
        ),
        (
            "narrative_extraction_tasks",
            "idx_narrative_tasks_run_kind_status",
            ["run_id", "task_kind", "status"].as_slice(),
        ),
        (
            "narrative_extraction_attempts",
            "idx_narrative_attempts_task_number_status",
            ["task_id", "attempt_number", "status"].as_slice(),
        ),
        (
            "narrative_extraction_artifacts",
            "idx_narrative_artifacts_run_task_attempt_kind",
            [
                "run_id",
                "task_id",
                "attempt_id",
                "artifact_kind",
                "payload_storage",
            ]
            .as_slice(),
        ),
    ] {
        let properties = conn
            .query_row(
                &format!(
                    "SELECT \"unique\", partial
                       FROM pragma_index_list('{table}')
                      WHERE name = ?1"
                ),
                [name],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        if properties != Some((false, false)) || index_columns(conn, name)? != expected_columns {
            return Ok(false);
        }
    }
    Ok(true)
}

fn has_timelapse_creation_baseline_triggers(conn: &Connection) -> anyhow::Result<bool> {
    let generated_contract = serde_json::from_str::<serde_json::Value>(GENERATED_SCHEMA_CONTRACT)?;
    let expected_triggers = generated_contract
        .get("triggers")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("generated schema contract has no triggers object"))?;

    for name in [
        "timelapse_scene_creation_baseline",
        "timelapse_codex_creation_baseline",
        "timelapse_snippet_creation_baseline",
    ] {
        let expected = expected_triggers
            .get(name)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!("generated schema contract is missing trigger {name}")
            })?;
        let actual = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
                [name],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let actual = actual.as_deref().map(compact_sql);
        let expected = compact_sql(expected);
        if actual.as_deref() != Some(expected.as_str()) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// SCHEMA 34 / NIR-0 C2A: durable, non-authoritative Stage model bindings and
/// terminal receipts. The C1 closure is validated transaction-locally and is
/// intentionally ephemeral (ADR 011 §2.1/plan 34f).
fn has_v34_c2a_stage_storage(conn: &Connection) -> anyhow::Result<bool> {
    for table in [
        "narrative_extraction_stage_model_bindings",
        "narrative_extraction_stage_receipts",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }

    let binding_table_columns = table_columns(conn, "narrative_extraction_stage_model_bindings")?;
    let receipt_table_columns = table_columns(conn, "narrative_extraction_stage_receipts")?;
    let binding_columns = [
        ("id", "TEXT", true),
        ("project_id", "TEXT", true),
        ("run_id", "TEXT", true),
        ("task_id", "TEXT", true),
        ("attempt_id", "TEXT", true),
        ("stage_execution_id", "TEXT", true),
        ("binding_json", "TEXT", true),
        ("binding_digest", "TEXT", true),
        ("created_at", "TEXT", true),
    ];
    let receipt_columns = [
        ("id", "TEXT", true),
        ("project_id", "TEXT", true),
        ("run_id", "TEXT", true),
        ("task_id", "TEXT", true),
        ("attempt_id", "TEXT", true),
        ("stage_execution_id", "TEXT", true),
        ("receipt_json", "TEXT", true),
        ("receipt_digest", "TEXT", true),
        ("model_binding_digest", "TEXT", true),
        ("terminal_status", "TEXT", true),
        ("created_at", "TEXT", true),
    ];
    let columns_ok = |table_columns: &[ColumnShape], columns: &[(&str, &str, bool)]| {
        table_columns.len() == columns.len()
            && columns
                .iter()
                .enumerate()
                .all(|(index, (name, declared_type, not_null))| {
                    let Some(column) = table_columns.get(index) else {
                        return false;
                    };
                    column.name == *name
                        && column.declared_type == *declared_type
                        && column.not_null == *not_null
                        && (index != 0 || column.primary_key == 1)
                        && (index == 0 || column.primary_key == 0)
                })
    };
    let index_matches = |index: &str, expected: &[&str]| -> anyhow::Result<bool> {
        Ok(index_columns(conn, index)?
            .iter()
            .map(String::as_str)
            .eq(expected.iter().copied()))
    };
    let fk_matches = |table: &str, from: &str, parent: &str, to: &str| {
        foreign_key_matches(conn, table, from, parent, to)
    };
    let binding_sql = compact_sql(&table_sql(
        conn,
        "narrative_extraction_stage_model_bindings",
    )?);
    let receipt_sql = compact_sql(&table_sql(conn, "narrative_extraction_stage_receipts")?);
    let digest_check = |sql: &str, field: &str| {
        sql.contains(&format!(
            "check(length({field})=71and{field}glob'sha256:*'andsubstr({field},8)notglob'*[^0-9a-f]*')"
        ))
    };
    let trigger_sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master
              WHERE type = 'trigger'
                AND name = 'narrative_proposal_revisions_v2_monotonicity_guard'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|sql| compact_sql(&sql));
    let pointer_trigger_sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master
              WHERE type = 'trigger'
                AND name = 'narrative_proposals_v2_pointer_monotonicity_guard'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|sql| compact_sql(&sql));
    let v2_immutable_update_trigger_sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master
              WHERE type = 'trigger'
                AND name = 'narrative_proposal_revisions_v2_immutable_update_guard'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|sql| compact_sql(&sql));

    Ok(columns_ok(&binding_table_columns, &binding_columns)
        && columns_ok(&receipt_table_columns, &receipt_columns)
        && index_matches(
            "sqlite_autoindex_narrative_extraction_stage_model_bindings_1",
            &["id"],
        )?
        && index_matches(
            "sqlite_autoindex_narrative_extraction_stage_model_bindings_2",
            &["project_id", "stage_execution_id"],
        )?
        && index_matches(
            "idx_narrative_stage_model_bindings_owner",
            &["project_id", "run_id", "task_id", "attempt_id"],
        )?
        && index_matches(
            "sqlite_autoindex_narrative_extraction_stage_receipts_1",
            &["id"],
        )?
        && index_matches(
            "sqlite_autoindex_narrative_extraction_stage_receipts_2",
            &["project_id", "stage_execution_id"],
        )?
        && index_matches(
            "idx_narrative_stage_receipts_owner",
            &["project_id", "run_id", "task_id", "attempt_id"],
        )?
        && fk_matches(
            "narrative_extraction_stage_model_bindings",
            "project_id",
            "projects",
            "id",
        )?
        && fk_matches(
            "narrative_extraction_stage_receipts",
            "project_id",
            "projects",
            "id",
        )?
        && binding_sql.contains(
            "check(json_valid(binding_json)andjson_type(binding_json)='object')",
        )
        && digest_check(&binding_sql, "binding_digest")
        && binding_sql.contains("unique(project_id,stage_execution_id)")
        && receipt_sql.contains(
            "check(json_valid(receipt_json)andjson_type(receipt_json)='object')",
        )
        && digest_check(&receipt_sql, "receipt_digest")
        && digest_check(&receipt_sql, "model_binding_digest")
        && receipt_sql.contains(
            "check(terminal_statusin('succeeded','failed','cancelled','skipped'))",
        )
        && receipt_sql.contains("unique(project_id,stage_execution_id)")
        && trigger_sql.is_some_and(|sql| {
            sql.contains("beforeinsertonnarrative_proposal_revisions")
                && sql.contains("whenexists(select1fromnarrative_proposalspjoinnarrative_proposal_revisionscurrent_revision")
                && sql.contains("current_revision.origin_kind='enveloped'")
                && sql.contains("json_extract(current_revision.reconciliation_envelope_json,'$.schemaversion')=2")
                && sql.contains("new.origin_kind<>'enveloped'")
                && sql.contains("new.reconciliation_envelope_jsonisnull")
                && sql.contains("json_extract(new.reconciliation_envelope_json,'$.schemaversion')isnot2")
                && sql.contains("nex_revision_envelope_downgrade_forbidden")
        })
        && pointer_trigger_sql.is_some_and(|sql| {
            sql.contains("beforeupdateofcurrent_revision_idonnarrative_proposals")
                && sql.contains("old_revision.id=old.current_revision_id")
                && sql.contains("old_revision.origin_kind='enveloped'")
                && sql.contains(
                    "json_extract(old_revision.reconciliation_envelope_json,'$.schemaversion')=2",
                )
                && sql.contains("andnotexists(")
                && sql.contains("new_revision.id=new.current_revision_id")
                && sql.contains("new_revision.origin_kind='enveloped'")
                && sql.contains(
                    "json_extract(new_revision.reconciliation_envelope_json,'$.schemaversion')=2",
                )
                && sql.contains("nex_revision_envelope_downgrade_forbidden")
        })
        && v2_immutable_update_trigger_sql.is_some_and(|sql| {
            sql.contains("beforeupdateonnarrative_proposal_revisions")
                && sql.contains("old.origin_kind='enveloped'")
                && sql.contains("json_extract(old.reconciliation_envelope_json,'$.schemaversion')=2")
                && sql.contains("old.payload_jsonisnotnew.payload_json")
                && sql.contains("old.reconciliation_envelope_digestisnotnew.reconciliation_envelope_digest")
                && sql.contains("nex_revision_v2_immutable")
        }))
}

/// SCHEMA 33 / NIR-0 D1: durable Dependency declaration storage is append
/// only at the set/entry level and mutable only at the Consumer head. A set
/// can cross the durable boundary only in the `sealed` state; the writer
/// computes all digests and performs the head CAS inside one transaction.
fn has_v33_dependency_declaration_storage(conn: &Connection) -> anyhow::Result<bool> {
    for table in [
        "narrative_dependency_declaration_sets",
        "narrative_dependency_declaration_entries",
        "narrative_dependency_declaration_heads",
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
    let sets = table_columns(conn, "narrative_dependency_declaration_sets")?;
    let entries = table_columns(conn, "narrative_dependency_declaration_entries")?;
    let heads = table_columns(conn, "narrative_dependency_declaration_heads")?;

    let sets_ok = has_column(&sets, "id", "TEXT", true)
        && has_column(&sets, "project_id", "TEXT", true)
        && has_column(&sets, "consumer_kind", "TEXT", true)
        && has_column(&sets, "consumer_key", "TEXT", true)
        && has_column(&sets, "producer_id", "TEXT", true)
        && has_column(&sets, "producer_generation", "INTEGER", true)
        && has_column(&sets, "dependency_set_digest", "TEXT", true)
        && has_column(&sets, "state", "TEXT", true)
        && has_column(&sets, "created_at", "TEXT", true)
        && index_columns(
            conn,
            "sqlite_autoindex_narrative_dependency_declaration_sets_1",
        )?
        .iter()
        .map(String::as_str)
        .eq(["id"])
        && index_columns(
            conn,
            "sqlite_autoindex_narrative_dependency_declaration_sets_2",
        )?
        .iter()
        .map(String::as_str)
        .eq([
            "project_id",
            "consumer_kind",
            "consumer_key",
            "producer_generation",
        ])
        && index_columns(conn, "idx_narrative_dependency_declaration_sets_consumer")?
            .iter()
            .map(String::as_str)
            .eq(["project_id", "consumer_kind", "consumer_key"]);

    let entries_ok = has_column(&entries, "id", "TEXT", true)
        && has_column(&entries, "declaration_set_id", "TEXT", true)
        && has_column(&entries, "source_object_identity", "TEXT", true)
        && has_column(&entries, "dependency_key", "TEXT", true)
        && has_column(&entries, "dependency_role", "TEXT", true)
        && has_column(&entries, "role_contract_version", "TEXT", true)
        && has_column(&entries, "selector_json", "TEXT", true)
        && has_column(&entries, "selector_digest", "TEXT", true)
        && has_column(&entries, "created_at", "TEXT", true)
        && index_columns(
            conn,
            "sqlite_autoindex_narrative_dependency_declaration_entries_1",
        )?
        .iter()
        .map(String::as_str)
        .eq(["id"])
        && index_columns(
            conn,
            "sqlite_autoindex_narrative_dependency_declaration_entries_2",
        )?
        .iter()
        .map(String::as_str)
        .eq([
            "declaration_set_id",
            "source_object_identity",
            "dependency_key",
        ])
        && index_columns(conn, "idx_narrative_dependency_declaration_entries_set")?
            .iter()
            .map(String::as_str)
            .eq(["declaration_set_id"])
        && index_columns(conn, "idx_narrative_dependency_declaration_entries_source")?
            .iter()
            .map(String::as_str)
            .eq(["source_object_identity"]);

    let heads_ok = has_column(&heads, "project_id", "TEXT", true)
        && has_column(&heads, "consumer_kind", "TEXT", true)
        && has_column(&heads, "consumer_key", "TEXT", true)
        && has_column(&heads, "active_declaration_set_id", "TEXT", true)
        && has_column(&heads, "producer_id", "TEXT", true)
        && has_column(&heads, "producer_generation", "INTEGER", true)
        && has_column(&heads, "version", "INTEGER", true)
        && has_column(&heads, "updated_at", "TEXT", true)
        && index_columns(
            conn,
            "sqlite_autoindex_narrative_dependency_declaration_heads_1",
        )?
        .iter()
        .map(String::as_str)
        .eq(["project_id", "consumer_kind", "consumer_key"])
        && index_columns(conn, "idx_narrative_dependency_declaration_heads_set")?
            .iter()
            .map(String::as_str)
            .eq(["active_declaration_set_id"]);

    let sets_sql = compact_sql(&table_sql(conn, "narrative_dependency_declaration_sets")?);
    let entries_sql = compact_sql(&table_sql(
        conn,
        "narrative_dependency_declaration_entries",
    )?);
    let heads_sql = compact_sql(&table_sql(conn, "narrative_dependency_declaration_heads")?);

    Ok(sets_ok
        && entries_ok
        && heads_ok
        && sets_sql.contains("check(state='sealed')")
        && sets_sql.contains("check(producer_generation>=0)")
        && sets_sql.contains("andsubstr(dependency_set_digest,8)notglob'*[^0-9a-f]*'")
        && entries_sql
            .contains("check(json_valid(selector_json)andjson_type(selector_json)='object')")
        && entries_sql.contains("andsubstr(dependency_key,8)notglob'*[^0-9a-f]*'")
        && entries_sql.contains("andsubstr(selector_digest,8)notglob'*[^0-9a-f]*'")
        && heads_sql.contains("check(producer_generation>=0)")
        && heads_sql.contains("check(version>=1)")
        && sets_sql.contains("referencesprojects(id)ondeletecascade")
        && entries_sql
            .contains("referencesnarrative_dependency_declaration_sets(id)ondeletecascade")
        && heads_sql.contains("referencesprojects(id)ondeletecascade")
        && heads_sql.contains("referencesnarrative_dependency_declaration_sets(id)"))
}

fn has_v31_finding_identity_columns(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_maintenance_finding_observations")?
        || !table_exists(conn, "narrative_maintenance_attention")?
        || !table_exists(conn, "narrative_maintenance_finding_lifecycle")?
    {
        return Ok(false);
    }
    let observations = table_columns(conn, "narrative_maintenance_finding_observations")?;
    let attention = table_columns(conn, "narrative_maintenance_attention")?;
    let lifecycle = table_columns(conn, "narrative_maintenance_finding_lifecycle")?;
    let has = |columns: &[ColumnShape], name: &str, ty: &str, not_null: bool| {
        columns.iter().any(|column| {
            column.name == name && column.declared_type == ty && column.not_null == not_null
        })
    };
    let observation_columns = has(&observations, "finding_identity", "TEXT", false)
        && has(&observations, "rule_id", "TEXT", true)
        && has(&observations, "rule_version", "INTEGER", true)
        && has(&observations, "observation_digest", "TEXT", true);
    let attention_columns = has(&attention, "finding_identity", "TEXT", false)
        && has(&attention, "identity_resolution_status", "TEXT", true);
    let lifecycle_columns = has(&lifecycle, "id", "TEXT", true)
        && has(&lifecycle, "project_id", "TEXT", true)
        && has(&lifecycle, "finding_identity", "TEXT", true)
        && has(&lifecycle, "finding_key", "TEXT", true)
        && has(&lifecycle, "rule_id", "TEXT", true)
        && has(&lifecycle, "rule_version", "INTEGER", true)
        && has(&lifecycle, "lifecycle_state", "TEXT", true)
        && has(&lifecycle, "observation_digest", "TEXT", false)
        && has(&lifecycle, "material_basis_digest", "TEXT", false)
        && has(&lifecycle, "run_id", "TEXT", true)
        && has(&lifecycle, "semantic_epoch_id", "TEXT", true)
        && has(&lifecycle, "observed_at", "TEXT", true);
    let lifecycle_sql = compact_sql(&table_sql(conn, "narrative_maintenance_finding_lifecycle")?);
    Ok(observation_columns
        && attention_columns
        && lifecycle_columns
        && lifecycle_sql
            .contains("check(lifecycle_statein('new','recurring','changed','resolved'))")
        && has_c2_finding_identity_data_migration_marker(conn)?)
}

/// SCHEMA 30: a Dependency Edge records the Run that declared it. Nullable by
/// design — an Edge under a Consumer kind this build cannot resolve a Run for
/// carries NULL, and `restore_rebuild` reports that rather than guessing.
fn has_v30_dependency_edge_owning_run_column(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_dependency_edges")? {
        return Ok(false);
    }
    Ok(table_columns(conn, "narrative_dependency_edges")?
        .iter()
        .any(|column| column.name == "owning_run_id" && column.declared_type == "TEXT"))
}

/// SCHEMA 27: a Repair lease names the Run entitled to apply it, so the
/// mutation transaction can compare-and-swap the whole lease row instead of
/// trusting a claim it made before a slow backup. Nullable by design — a
/// lease claimed before this migration carries NULL and fails the CAS,
/// which is the safe direction.
fn has_v27_repair_lease_run_binding(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_maintenance_repair_leases")? {
        return Ok(false);
    }
    Ok(table_columns(conn, "narrative_maintenance_repair_leases")?
        .iter()
        .any(|column| column.name == "active_run_id" && column.declared_type == "TEXT"))
}

/// SCHEMA 26: a system Run records the request that asked for it, kept
/// separate from `work_key`'s work equivalence. Nullable by design —
/// interpretation Runs and every Run created before this have no request
/// identity — so this checks presence and type, not NOT NULL.
fn has_v26_run_request_identity_columns(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_extraction_runs")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "narrative_extraction_runs")?;
    Ok([
        "request_id",
        "idempotency_domain",
        "request_payload_digest",
        "actor_id",
    ]
    .iter()
    .all(|name| {
        columns
            .iter()
            .any(|column| column.name == *name && column.declared_type == "TEXT")
    }))
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
        && has_column(&contributions, "created_at", "TEXT", true)
        // SCHEMA 29: provenance, value baseline, and the Maintenance
        // ownership axis. The three provenance columns are NOT NULL because
        // every Contribution is produced by an Application that has them;
        // the rest are nullable because "not known" is a real answer for a
        // row the Backfill wrote.
        && has_column(&contributions, "commit_id", "TEXT", true)
        && has_column(&contributions, "proposal_id", "TEXT", true)
        && has_column(&contributions, "revision_id", "TEXT", true)
        && has_column(&contributions, "operation_id", "TEXT", false)
        && has_column(&contributions, "maintenance_ownership", "TEXT", true)
        && has_column(&contributions, "baseline_sequence", "INTEGER", false)
        && has_column(&contributions, "target_state_sequence", "INTEGER", false)
        && has_column(&contributions, "target_state_updated_at", "TEXT", false);

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

/// Whether this workspace has seen the current revision of the SCHEMA 28 C2
/// identity data migration.
///
/// SCHEMA 28's repair is a data migration, so on physical evidence alone a
/// complete SCHEMA 27 database already satisfies every other clause here --
/// and both of `migrate_impl`'s fast paths would then skip it. This is what
/// makes the repair's completion part of the checkpoint.
///
/// It reads a durable marker rather than inspecting today's rows, because
/// the two questions differ. "Are any repairable identities left?" cannot
/// separate a workspace the migration never touched from one an earlier
/// SCHEMA 28 build already rewrote *without* invalidating the Freshness that
/// had been decided against the identities it replaced. Both look clean; only
/// one is. The evidence that distinguishes them is what that build did, which
/// exists nowhere unless it was written down.
///
/// The marker carries a contract version so the migration can gain a side
/// effect inside one `SCHEMA_VERSION` and still re-run on workspaces that
/// only saw the earlier revision.
fn has_c2_identity_data_migration_marker(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "schema_data_migrations")? {
        return Ok(false);
    }
    let applied: Option<i64> = conn
        .query_row(
            "SELECT contract_version FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_IDENTITY_MIGRATION_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(applied.is_some_and(|version| version >= C2_IDENTITY_CONTRACT_VERSION))
}

/// Gate C2-2 moved the live Producer's Dependency Edges from Run grain onto
/// the Proposal Revisions that declared them. Like SCHEMA 28's identity
/// repair this changes rows rather than shape, so nothing physical
/// distinguishes a workspace it has run on from one it has not -- only the
/// marker does.
fn has_c2_consumer_grain_data_migration_marker(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "schema_data_migrations")? {
        return Ok(false);
    }
    let applied: Option<i64> = conn
        .query_row(
            "SELECT contract_version FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_CONSUMER_GRAIN_MIGRATION_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(applied.is_some_and(|version| version >= C2_CONSUMER_GRAIN_CONTRACT_VERSION))
}

/// Mirrors `migrate.rs`'s constants of the same name; a test pins them.
pub const C2_CONSUMER_GRAIN_MIGRATION_ID: &str = "narrative-c2-consumer-grain-v30";
/// See [`C2_CONSUMER_GRAIN_MIGRATION_ID`].
pub const C2_CONSUMER_GRAIN_CONTRACT_VERSION: i64 = 1;

/// Mirrors `migrate.rs`'s SCHEMA 31 data migration marker.
pub const C2_FINDING_IDENTITY_MIGRATION_ID: &str = "narrative-c2-finding-identity-v31";
pub const C2_FINDING_IDENTITY_CONTRACT_VERSION: i64 = 1;

fn has_c2_finding_identity_data_migration_marker(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "schema_data_migrations")? {
        return Ok(false);
    }
    let applied: Option<i64> = conn
        .query_row(
            "SELECT contract_version FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_FINDING_IDENTITY_MIGRATION_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(applied.is_some_and(|version| version >= C2_FINDING_IDENTITY_CONTRACT_VERSION))
}

/// Mirrors `migrate.rs`'s SCHEMA 32 data migration marker.
pub const C2_APPLICATION_REKEY_MIGRATION_ID: &str = "narrative-c2-application-rekey-v32";
pub const C2_APPLICATION_REKEY_CONTRACT_VERSION: i64 = 1;

fn has_c2_application_rekey_data_migration_marker(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "schema_data_migrations")? {
        return Ok(false);
    }
    let applied: Option<i64> = conn
        .query_row(
            "SELECT contract_version FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_APPLICATION_REKEY_MIGRATION_ID],
            |row| row.get(0),
        )
        .optional()?;
    // Exact-version contract, shared with the C2-ZB migration body: a future
    // marker version is unsupported and must not checkpoint as complete.
    Ok(applied.is_some_and(|version| version == C2_APPLICATION_REKEY_CONTRACT_VERSION))
}

/// Mirrors `migrate.rs`'s constants of the same name; a test pins them.
pub const C2_IDENTITY_MIGRATION_ID: &str = "narrative-c2-identity-v28";
/// See [`C2_IDENTITY_MIGRATION_ID`].
pub const C2_IDENTITY_CONTRACT_VERSION: i64 = 2;

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

fn foreign_key_matches(
    conn: &Connection,
    table: &str,
    from: &str,
    parent: &str,
    to: &str,
) -> anyhow::Result<bool> {
    let mut statement = conn.prepare(
        "SELECT \"from\", \"table\", \"to\", on_delete
           FROM pragma_foreign_key_list(?1)",
    )?;
    let foreign_keys = statement
        .query_map([table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(foreign_keys
        .iter()
        .any(|(actual_from, actual_parent, actual_to, on_delete)| {
            actual_from == from
                && actual_parent == parent
                && actual_to == to
                && on_delete.eq_ignore_ascii_case("CASCADE")
        }))
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
