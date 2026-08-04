//! Project snapshot persistence owned by the shared database layer.
//!
//! The renderer may decide which snapshot rows to restore, but it never sends
//! SQL. This module validates project/snapshot ownership, captures auxiliary
//! tables, and applies the wipe + insert plan in one SQLite transaction.

use std::collections::HashSet;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::Database;

pub type RawRow = Map<String, Value>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RestoreScope {
    Body,
    Codex,
    Snippet,
    Map,
    Foreshadow,
    Labels,
    Lint,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectSnapshotPayload {
    pub project_id: String,
    pub snapshot_id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub tree_rows: Vec<RawRow>,
    pub codex_rows: Vec<RawRow>,
    pub snippet_rows: Vec<RawRow>,
    pub version_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotInsertMode {
    Insert,
    Replace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotRestoreTable {
    CodexTypes,
    CodexEntries,
    CodexTags,
    CodexDetailDefinitions,
    CodexEntryTags,
    CodexDetailValues,
    CodexEntryPhases,
    CodexPhaseDetailOverrides,
    CodexQuickPins,
    CodexDismissedRelations,
    CodexRelations,
    TreeNodes,
    AuthorshipSpans,
    GenerationLogs,
    PostEffectAnnotations,
    PostEffectAnnotationRelations,
    SceneCodexPins,
    SceneCodexMentions,
    SceneBeatPovCache,
    PlotThreads,
    PlotThreadSceneLinks,
    PlotThreadBranches,
    Events,
    SceneEvents,
    EventParticipants,
    EventRelations,
    ProjectCalendar,
    Snippets,
    SnippetEntryTags,
    Labels,
    TreeNodeLabels,
    Foreshadows,
    ForeshadowSetups,
    ForeshadowCodexLinks,
    MapBoards,
    MapAiBranches,
    MapStickies,
    EditorStickies,
    MapFrames,
    MapNodePositions,
    MapEdges,
    LintTermDictionary,
    LintIgnoredDiagnostics,
}

impl SnapshotRestoreTable {
    fn as_str(self) -> &'static str {
        match self {
            Self::CodexTypes => "codex_types",
            Self::CodexEntries => "codex_entries",
            Self::CodexTags => "codex_tags",
            Self::CodexDetailDefinitions => "codex_detail_definitions",
            Self::CodexEntryTags => "codex_entry_tags",
            Self::CodexDetailValues => "codex_detail_values",
            Self::CodexEntryPhases => "codex_entry_phases",
            Self::CodexPhaseDetailOverrides => "codex_phase_detail_overrides",
            Self::CodexQuickPins => "codex_quick_pins",
            Self::CodexDismissedRelations => "codex_dismissed_relations",
            Self::CodexRelations => "codex_relations",
            Self::TreeNodes => "tree_nodes",
            Self::AuthorshipSpans => "authorship_spans",
            Self::GenerationLogs => "generation_logs",
            Self::PostEffectAnnotations => "post_effect_annotations",
            Self::PostEffectAnnotationRelations => "post_effect_annotation_relations",
            Self::SceneCodexPins => "scene_codex_pins",
            Self::SceneCodexMentions => "scene_codex_mentions",
            Self::SceneBeatPovCache => "scene_beat_pov_cache",
            Self::PlotThreads => "plot_threads",
            Self::PlotThreadSceneLinks => "plot_thread_scene_links",
            Self::PlotThreadBranches => "plot_thread_branches",
            Self::Events => "events",
            Self::SceneEvents => "scene_events",
            Self::EventParticipants => "event_participants",
            Self::EventRelations => "event_relations",
            Self::ProjectCalendar => "project_calendar",
            Self::Snippets => "snippets",
            Self::SnippetEntryTags => "snippet_entry_tags",
            Self::Labels => "labels",
            Self::TreeNodeLabels => "tree_node_labels",
            Self::Foreshadows => "foreshadows",
            Self::ForeshadowSetups => "foreshadow_setups",
            Self::ForeshadowCodexLinks => "foreshadow_codex_links",
            Self::MapBoards => "map_boards",
            Self::MapAiBranches => "map_ai_branches",
            Self::MapStickies => "map_stickies",
            Self::EditorStickies => "editor_stickies",
            Self::MapFrames => "map_frames",
            Self::MapNodePositions => "map_node_positions",
            Self::MapEdges => "map_edges",
            Self::LintTermDictionary => "lint_term_dictionary",
            Self::LintIgnoredDiagnostics => "lint_ignored_diagnostics",
        }
    }

    fn owner(self) -> RestoreScope {
        match self {
            Self::CodexTypes
            | Self::CodexEntries
            | Self::CodexTags
            | Self::CodexDetailDefinitions
            | Self::CodexEntryTags
            | Self::CodexDetailValues
            | Self::CodexEntryPhases
            | Self::CodexPhaseDetailOverrides
            | Self::CodexQuickPins
            | Self::CodexDismissedRelations
            | Self::CodexRelations => RestoreScope::Codex,
            Self::TreeNodes
            | Self::AuthorshipSpans
            | Self::GenerationLogs
            | Self::PostEffectAnnotations
            | Self::PostEffectAnnotationRelations
            | Self::SceneCodexPins
            | Self::SceneCodexMentions
            | Self::SceneBeatPovCache
            | Self::PlotThreads
            | Self::PlotThreadSceneLinks
            | Self::PlotThreadBranches
            | Self::Events
            | Self::SceneEvents
            | Self::EventParticipants
            | Self::EventRelations
            | Self::ProjectCalendar => RestoreScope::Body,
            Self::Snippets | Self::SnippetEntryTags => RestoreScope::Snippet,
            Self::Labels | Self::TreeNodeLabels => RestoreScope::Labels,
            Self::Foreshadows | Self::ForeshadowSetups | Self::ForeshadowCodexLinks => {
                RestoreScope::Foreshadow
            }
            Self::MapBoards
            | Self::MapAiBranches
            | Self::MapStickies
            | Self::EditorStickies
            | Self::MapFrames
            | Self::MapNodePositions
            | Self::MapEdges => RestoreScope::Map,
            Self::LintTermDictionary | Self::LintIgnoredDiagnostics => RestoreScope::Lint,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInsertPlan {
    pub table: SnapshotRestoreTable,
    pub row: RawRow,
    pub mode: SnapshotInsertMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProjectSnapshotRestorePayload {
    pub project_id: String,
    pub snapshot_id: String,
    pub scopes: Vec<RestoreScope>,
    pub inserts: Vec<SnapshotInsertPlan>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotAuxRow {
    pub scope: String,
    pub payload_json: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotContentRow {
    pub id: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshotRestoreContext {
    pub structural: bool,
    pub live_tables: Vec<String>,
    pub tree_rows: Vec<RawRow>,
    pub codex_rows: Vec<RawRow>,
    pub snippet_rows: Vec<RawRow>,
    pub aux_rows: Vec<SnapshotAuxRow>,
    pub content_rows: Vec<SnapshotContentRow>,
    pub live_codex_ids: Vec<String>,
    pub live_tree_node_ids: Vec<String>,
    pub live_codex_tag_ids: Vec<String>,
}

struct AuxSpec {
    scope: &'static str,
    owner: RestoreScope,
    table: &'static str,
    predicate: &'static str,
    binds: usize,
}

const AUX_SPECS: &[AuxSpec] = &[
    AuxSpec { scope: "codex_types", owner: RestoreScope::Codex, table: "codex_types", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "codex_tags", owner: RestoreScope::Codex, table: "codex_tags", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "codex_entry_tags", owner: RestoreScope::Codex, table: "codex_entry_tags", predicate: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "codex_detail_definitions", owner: RestoreScope::Codex, table: "codex_detail_definitions", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "codex_detail_values", owner: RestoreScope::Codex, table: "codex_detail_values", predicate: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "codex_entry_phases", owner: RestoreScope::Codex, table: "codex_entry_phases", predicate: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "codex_phase_detail_overrides", owner: RestoreScope::Codex, table: "codex_phase_detail_overrides", predicate: "phase_id IN (SELECT id FROM codex_entry_phases WHERE entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?))", binds: 1 },
    AuxSpec { scope: "codex_quick_pins", owner: RestoreScope::Codex, table: "codex_quick_pins", predicate: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "codex_dismissed_relations", owner: RestoreScope::Codex, table: "codex_dismissed_relations", predicate: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "codex_relations", owner: RestoreScope::Codex, table: "codex_relations", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "snippet_entry_tags", owner: RestoreScope::Snippet, table: "snippet_entry_tags", predicate: "snippet_id IN (SELECT id FROM snippets WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "labels", owner: RestoreScope::Labels, table: "labels", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "tree_node_labels", owner: RestoreScope::Labels, table: "tree_node_labels", predicate: "node_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "foreshadows", owner: RestoreScope::Foreshadow, table: "foreshadows", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "foreshadow_setups", owner: RestoreScope::Foreshadow, table: "foreshadow_setups", predicate: "foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "foreshadow_codex_links", owner: RestoreScope::Foreshadow, table: "foreshadow_codex_links", predicate: "foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "map_boards", owner: RestoreScope::Map, table: "map_boards", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "map_ai_branches", owner: RestoreScope::Map, table: "map_ai_branches", predicate: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "map_stickies", owner: RestoreScope::Map, table: "map_stickies", predicate: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "editor_stickies", owner: RestoreScope::Map, table: "editor_stickies", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "map_node_positions", owner: RestoreScope::Map, table: "map_node_positions", predicate: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "map_edges", owner: RestoreScope::Map, table: "map_edges", predicate: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "map_frames", owner: RestoreScope::Map, table: "map_frames", predicate: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "lint_ignored_diagnostics", owner: RestoreScope::Lint, table: "lint_ignored_diagnostics", predicate: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "lint_term_dictionary", owner: RestoreScope::Lint, table: "lint_term_dictionary", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "authorship_spans", owner: RestoreScope::Body, table: "authorship_spans", predicate: "(node_id IN (SELECT id FROM tree_nodes WHERE project_id = ?) OR codex_entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?) OR snippet_id IN (SELECT id FROM snippets WHERE project_id = ?) OR detail_value_id IN (SELECT id FROM codex_detail_values WHERE entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)) OR sticky_id IN (SELECT id FROM map_stickies WHERE board_id IN (SELECT id FROM map_boards WHERE project_id = ?)))", binds: 5 },
    AuxSpec { scope: "generation_logs", owner: RestoreScope::Body, table: "generation_logs", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "post_effect_annotations", owner: RestoreScope::Body, table: "post_effect_annotations", predicate: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "post_effect_annotation_relations", owner: RestoreScope::Body, table: "post_effect_annotation_relations", predicate: "annotation_a_id IN (SELECT id FROM post_effect_annotations WHERE scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?))", binds: 1 },
    AuxSpec { scope: "scene_codex_pins", owner: RestoreScope::Body, table: "scene_codex_pins", predicate: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "scene_codex_mentions", owner: RestoreScope::Body, table: "scene_codex_mentions", predicate: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "scene_beat_pov_cache", owner: RestoreScope::Body, table: "scene_beat_pov_cache", predicate: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "plot_threads", owner: RestoreScope::Body, table: "plot_threads", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "plot_thread_scene_links", owner: RestoreScope::Body, table: "plot_thread_scene_links", predicate: "thread_id IN (SELECT id FROM plot_threads WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "plot_thread_branches", owner: RestoreScope::Body, table: "plot_thread_branches", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "events", owner: RestoreScope::Body, table: "events", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "event_relations", owner: RestoreScope::Body, table: "event_relations", predicate: "project_id = ?", binds: 1 },
    AuxSpec { scope: "scene_events", owner: RestoreScope::Body, table: "scene_events", predicate: "event_id IN (SELECT id FROM events WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "event_participants", owner: RestoreScope::Body, table: "event_participants", predicate: "event_id IN (SELECT id FROM events WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "project_calendar", owner: RestoreScope::Body, table: "project_calendar", predicate: "project_id = ?", binds: 1 },
];

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    if value.is_empty() {
        anyhow::bail!("project snapshot {field} must not be empty");
    }
    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> anyhow::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn ensure_project_exists(conn: &Connection, project_id: &str) -> anyhow::Result<()> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1",
            params![project_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        anyhow::bail!("project snapshot project '{project_id}' does not exist");
    }
    Ok(())
}

fn ensure_snapshot_owned(
    conn: &Connection,
    project_id: &str,
    snapshot_id: &str,
) -> anyhow::Result<()> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM project_snapshots WHERE id = ?1 AND project_id = ?2",
            params![snapshot_id, project_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        anyhow::bail!("project snapshot '{snapshot_id}' is not owned by project '{project_id}'");
    }
    Ok(())
}

fn raw_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::Number(number.into()),
        ValueRef::Real(number) => serde_json::Number::from_f64(number)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(blob) => Value::String(format!("[blob {} bytes]", blob.len())),
    }
}

fn query_rows(conn: &Connection, sql: &str, params: &[SqlValue]) -> anyhow::Result<Vec<RawRow>> {
    let mut statement = conn.prepare(sql)?;
    let column_names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    let rows = statement.query_map(params_from_iter(params.iter()), |row| {
        let mut result = RawRow::new();
        for (index, name) in column_names.iter().enumerate() {
            result.insert(name.clone(), raw_value(row.get_ref(index)?));
        }
        Ok(result)
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn query_strings(conn: &Connection, sql: &str, params: &[SqlValue]) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(params_from_iter(params.iter()), |row| row.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn sql_value(value: &Value, field: &str) -> anyhow::Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                SqlValue::Integer(value)
            } else if let Some(value) = value.as_f64() {
                SqlValue::Real(value)
            } else {
                anyhow::bail!("project snapshot row field '{field}' is outside SQLite range");
            }
        }
        Value::Bool(_) | Value::Array(_) | Value::Object(_) => {
            anyhow::bail!("project snapshot row field '{field}' is not a SQLite scalar");
        }
    })
}

fn table_columns(conn: &Connection, table: &str) -> anyhow::Result<HashSet<String>> {
    let sql = format!("PRAGMA table_info(\"{table}\")");
    let mut statement = conn.prepare(&sql)?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(columns.collect::<Result<HashSet<_>, _>>()?)
}

fn insert_record(
    conn: &Connection,
    table: &str,
    row: &RawRow,
    replace: bool,
) -> anyhow::Result<()> {
    if row.is_empty() {
        anyhow::bail!("project snapshot insert for '{table}' must not be empty");
    }
    if !table_exists(conn, table)? {
        return Ok(());
    }
    let actual_columns = table_columns(conn, table)?;
    let mut columns: Vec<&String> = row.keys().collect();
    columns.sort_unstable();
    for column in &columns {
        if !actual_columns.contains(column.as_str()) {
            anyhow::bail!("project snapshot insert has invalid {table} column '{column}'");
        }
    }
    let values = columns
        .iter()
        .map(|column| sql_value(&row[*column], column))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let column_sql = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=columns.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let verb = if replace {
        "INSERT OR REPLACE"
    } else {
        "INSERT"
    };
    let sql = format!("{verb} INTO \"{table}\" ({column_sql}) VALUES ({placeholders})");
    conn.execute(&sql, params_from_iter(values.iter()))?;
    Ok(())
}

fn validate_snapshot_row(row: &RawRow, snapshot_id: &str, row_kind: &str) -> anyhow::Result<()> {
    if row.get("snapshot_id").and_then(Value::as_str) != Some(snapshot_id) {
        anyhow::bail!("project snapshot {row_kind} row has a foreign snapshot_id");
    }
    Ok(())
}

pub fn create_project_snapshot(
    db: &Database,
    payload: CreateProjectSnapshotPayload,
) -> anyhow::Result<()> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.snapshot_id, "snapshotId")?;
    require_non_empty(&payload.name, "name")?;
    require_non_empty(&payload.created_at, "createdAt")?;
    for version_id in &payload.version_ids {
        require_non_empty(version_id, "versionIds[]")?;
    }
    for row in &payload.tree_rows {
        validate_snapshot_row(row, &payload.snapshot_id, "tree")?;
    }
    for row in &payload.codex_rows {
        validate_snapshot_row(row, &payload.snapshot_id, "codex")?;
    }
    for row in &payload.snippet_rows {
        validate_snapshot_row(row, &payload.snapshot_id, "snippet")?;
    }

    db.with_conn(|conn| {
        ensure_project_exists(conn, &payload.project_id)?;
        let transaction = conn.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO project_snapshots
                 (id, project_id, name, description, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                payload.snapshot_id,
                payload.project_id,
                payload.name,
                payload.description,
                payload.created_at
            ],
        )?;
        for row in &payload.tree_rows {
            insert_record(&transaction, "project_snapshot_tree_nodes", row, false)?;
        }
        for row in &payload.codex_rows {
            insert_record(&transaction, "project_snapshot_codex_entries", row, false)?;
        }
        for row in &payload.snippet_rows {
            insert_record(&transaction, "project_snapshot_snippets", row, false)?;
        }
        for version_id in &payload.version_ids {
            transaction.execute(
                "INSERT INTO project_snapshot_entries (snapshot_id, version_id)
                 VALUES (?1, ?2)",
                params![payload.snapshot_id, version_id],
            )?;
        }

        for spec in AUX_SPECS {
            let rows = if table_exists(&transaction, spec.table)? {
                let sql = format!("SELECT * FROM \"{}\" WHERE {}", spec.table, spec.predicate);
                let params = (0..spec.binds)
                    .map(|_| SqlValue::Text(payload.project_id.clone()))
                    .collect::<Vec<_>>();
                query_rows(&transaction, &sql, &params)?
            } else {
                Vec::new()
            };
            let payload_json = serde_json::json!({ "rows": rows }).to_string();
            transaction.execute(
                "INSERT INTO project_snapshot_aux (snapshot_id, scope, payload_json)
                 VALUES (?1, ?2, ?3)",
                params![payload.snapshot_id, spec.scope, payload_json],
            )?;
        }
        transaction.commit()?;
        Ok(())
    })
}

pub fn project_snapshot_restore_context(
    db: &Database,
    project_id: String,
    snapshot_id: String,
    scopes: Vec<RestoreScope>,
) -> anyhow::Result<ProjectSnapshotRestoreContext> {
    require_non_empty(&project_id, "projectId")?;
    require_non_empty(&snapshot_id, "snapshotId")?;
    let requested_scopes = scopes.into_iter().collect::<HashSet<_>>();

    db.with_conn(|conn| {
        ensure_snapshot_owned(conn, &project_id, &snapshot_id)?;
        let structural = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM project_snapshot_aux WHERE snapshot_id = ?1
             )",
            params![snapshot_id],
            |row| row.get::<_, i64>(0),
        )? != 0;
        let live_tables = query_strings(
            conn,
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
            &[],
        )?;
        let snapshot_param = [SqlValue::Text(snapshot_id.clone())];
        let tree_rows = query_rows(
            conn,
            "SELECT * FROM project_snapshot_tree_nodes WHERE snapshot_id = ?1",
            &snapshot_param,
        )?;
        let codex_rows = query_rows(
            conn,
            "SELECT * FROM project_snapshot_codex_entries WHERE snapshot_id = ?1",
            &snapshot_param,
        )?;
        let snippet_rows = query_rows(
            conn,
            "SELECT * FROM project_snapshot_snippets WHERE snapshot_id = ?1",
            &snapshot_param,
        )?;
        let allowed_aux = AUX_SPECS
            .iter()
            .filter(|spec| requested_scopes.contains(&spec.owner))
            .map(|spec| spec.scope)
            .collect::<HashSet<_>>();
        let aux_rows = query_rows(
            conn,
            "SELECT scope, payload_json
               FROM project_snapshot_aux
              WHERE snapshot_id = ?1
              ORDER BY scope",
            &snapshot_param,
        )?
        .into_iter()
        .filter_map(|mut row| {
            let scope = row.remove("scope")?.as_str()?.to_string();
            if !allowed_aux.contains(scope.as_str()) {
                return None;
            }
            let payload_json = row.remove("payload_json")?.as_str()?.to_string();
            Some(SnapshotAuxRow {
                scope,
                payload_json,
            })
        })
        .collect();
        let content_rows = query_rows(
            conn,
            "SELECT id, content
               FROM content_versions
              WHERE id IN (
                    SELECT body_version_id
                      FROM project_snapshot_tree_nodes
                     WHERE snapshot_id = ?1 AND body_version_id IS NOT NULL
                    UNION
                    SELECT body_version_id
                      FROM project_snapshot_codex_entries
                     WHERE snapshot_id = ?1 AND body_version_id IS NOT NULL
                    UNION
                    SELECT body_version_id
                      FROM project_snapshot_snippets
                     WHERE snapshot_id = ?1 AND body_version_id IS NOT NULL
              )",
            &snapshot_param,
        )?
        .into_iter()
        .filter_map(|mut row| {
            Some(SnapshotContentRow {
                id: row.remove("id")?.as_str()?.to_string(),
                content: row.remove("content")?.as_str()?.to_string(),
            })
        })
        .collect();
        let project_param = [SqlValue::Text(project_id.clone())];
        let live_codex_ids = query_strings(
            conn,
            "SELECT id FROM codex_entries WHERE project_id = ?1",
            &project_param,
        )?;
        let live_tree_node_ids = query_strings(
            conn,
            "SELECT id FROM tree_nodes WHERE project_id = ?1",
            &project_param,
        )?;
        let live_codex_tag_ids = query_strings(
            conn,
            "SELECT id FROM codex_tags WHERE project_id = ?1",
            &project_param,
        )?;
        Ok(ProjectSnapshotRestoreContext {
            structural,
            live_tables,
            tree_rows,
            codex_rows,
            snippet_rows,
            aux_rows,
            content_rows,
            live_codex_ids,
            live_tree_node_ids,
            live_codex_tag_ids,
        })
    })
}

fn snapshot_has_aux(
    transaction: &Transaction<'_>,
    snapshot_id: &str,
    scope: &str,
) -> anyhow::Result<bool> {
    Ok(transaction
        .query_row(
            "SELECT 1 FROM project_snapshot_aux
              WHERE snapshot_id = ?1 AND scope = ?2",
            params![snapshot_id, scope],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn delete_for_project(
    transaction: &Transaction<'_>,
    table: &str,
    sql: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    if table_exists(transaction, table)? {
        transaction.execute(sql, params![project_id])?;
    }
    Ok(())
}

fn validate_insert_project(
    project_id: &str,
    table: SnapshotRestoreTable,
    row: &RawRow,
) -> anyhow::Result<()> {
    if let Some(value) = row.get("project_id") {
        if value.as_str() != Some(project_id) {
            anyhow::bail!(
                "project snapshot insert for '{}' has a foreign project_id",
                table.as_str()
            );
        }
    }
    Ok(())
}

fn park_map_reference(
    transaction: &Transaction<'_>,
    project_id: &str,
    column: &str,
    prefix: &str,
) -> anyhow::Result<()> {
    let sql = format!(
        "UPDATE map_node_positions
            SET \"{column}\" = ?1 || \"{column}\"
          WHERE \"{column}\" IS NOT NULL
            AND board_id IN (SELECT id FROM map_boards WHERE project_id = ?2)"
    );
    transaction.execute(&sql, params![prefix, project_id])?;
    Ok(())
}

fn restore_parked_map_reference(
    transaction: &Transaction<'_>,
    project_id: &str,
    column: &str,
    target_table: &str,
    prefix: &str,
) -> anyhow::Result<()> {
    let restore_sql = format!(
        "UPDATE map_node_positions
            SET \"{column}\" = substr(\"{column}\", length(?1) + 1)
          WHERE substr(\"{column}\", 1, length(?1)) = ?1
            AND board_id IN (SELECT id FROM map_boards WHERE project_id = ?2)
            AND EXISTS (
                SELECT 1 FROM \"{target_table}\" target
                 WHERE target.id = substr(map_node_positions.\"{column}\", length(?1) + 1)
                   AND target.project_id = ?2
            )"
    );
    transaction.execute(&restore_sql, params![prefix, project_id])?;
    let delete_sql = format!(
        "DELETE FROM map_node_positions
          WHERE substr(\"{column}\", 1, length(?1)) = ?1
            AND board_id IN (SELECT id FROM map_boards WHERE project_id = ?2)"
    );
    transaction.execute(&delete_sql, params![prefix, project_id])?;
    Ok(())
}

pub fn apply_project_snapshot_restore(
    db: &Database,
    payload: ApplyProjectSnapshotRestorePayload,
) -> anyhow::Result<()> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.snapshot_id, "snapshotId")?;
    let scopes = payload.scopes.iter().copied().collect::<HashSet<_>>();
    for insert in &payload.inserts {
        if !scopes.contains(&insert.table.owner()) {
            anyhow::bail!(
                "project snapshot insert for '{}' is outside the selected scopes",
                insert.table.as_str()
            );
        }
        if insert.mode == SnapshotInsertMode::Replace
            && insert.table != SnapshotRestoreTable::CodexTypes
        {
            anyhow::bail!("project snapshot replace mode is only valid for codex_types");
        }
        validate_insert_project(&payload.project_id, insert.table, &insert.row)?;
    }

    db.with_conn(|conn| {
        ensure_snapshot_owned(conn, &payload.project_id, &payload.snapshot_id)?;
        let structural = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM project_snapshot_aux WHERE snapshot_id = ?1
             )",
            params![payload.snapshot_id],
            |row| row.get::<_, i64>(0),
        )? != 0;
        if !structural {
            anyhow::bail!("legacy project snapshots cannot use structural restore");
        }

        let transaction = conn.unchecked_transaction()?;
        transaction.execute_batch("PRAGMA defer_foreign_keys = ON;")?;

        let tree_prefix = format!("__grimodex_snapshot_tree_{}__", payload.snapshot_id);
        let codex_prefix = format!("__grimodex_snapshot_codex_{}__", payload.snapshot_id);
        let park_tree = scopes.contains(&RestoreScope::Body)
            && !scopes.contains(&RestoreScope::Map)
            && table_exists(&transaction, "map_node_positions")?;
        let park_codex = scopes.contains(&RestoreScope::Codex)
            && !scopes.contains(&RestoreScope::Map)
            && table_exists(&transaction, "map_node_positions")?;
        if park_tree {
            park_map_reference(
                &transaction,
                &payload.project_id,
                "tree_node_id",
                &tree_prefix,
            )?;
        }
        if park_codex {
            park_map_reference(
                &transaction,
                &payload.project_id,
                "codex_entry_id",
                &codex_prefix,
            )?;
        }

        if scopes.contains(&RestoreScope::Body) {
            delete_for_project(
                &transaction,
                "tree_nodes",
                "DELETE FROM tree_nodes WHERE project_id = ?1",
                &payload.project_id,
            )?;
            delete_for_project(
                &transaction,
                "plot_threads",
                "DELETE FROM plot_threads WHERE project_id = ?1",
                &payload.project_id,
            )?;
            if snapshot_has_aux(&transaction, &payload.snapshot_id, "events")? {
                delete_for_project(
                    &transaction,
                    "events",
                    "DELETE FROM events WHERE project_id = ?1",
                    &payload.project_id,
                )?;
            }
            if snapshot_has_aux(&transaction, &payload.snapshot_id, "project_calendar")? {
                delete_for_project(
                    &transaction,
                    "project_calendar",
                    "DELETE FROM project_calendar WHERE project_id = ?1",
                    &payload.project_id,
                )?;
            }
        }
        if scopes.contains(&RestoreScope::Codex) {
            for (table, sql) in [
                (
                    "codex_entries",
                    "DELETE FROM codex_entries WHERE project_id = ?1",
                ),
                (
                    "codex_types",
                    "DELETE FROM codex_types WHERE project_id = ?1",
                ),
                ("codex_tags", "DELETE FROM codex_tags WHERE project_id = ?1"),
                (
                    "codex_detail_definitions",
                    "DELETE FROM codex_detail_definitions WHERE project_id = ?1",
                ),
            ] {
                delete_for_project(&transaction, table, sql, &payload.project_id)?;
            }
        }
        if scopes.contains(&RestoreScope::Snippet) {
            delete_for_project(
                &transaction,
                "snippets",
                "DELETE FROM snippets WHERE project_id = ?1",
                &payload.project_id,
            )?;
        }
        if scopes.contains(&RestoreScope::Map) {
            delete_for_project(
                &transaction,
                "map_boards",
                "DELETE FROM map_boards WHERE project_id = ?1",
                &payload.project_id,
            )?;
            delete_for_project(
                &transaction,
                "editor_stickies",
                "DELETE FROM editor_stickies WHERE project_id = ?1",
                &payload.project_id,
            )?;
        }
        if scopes.contains(&RestoreScope::Foreshadow) {
            delete_for_project(
                &transaction,
                "foreshadows",
                "DELETE FROM foreshadows WHERE project_id = ?1",
                &payload.project_id,
            )?;
        }
        if scopes.contains(&RestoreScope::Labels) {
            delete_for_project(
                &transaction,
                "labels",
                "DELETE FROM labels WHERE project_id = ?1",
                &payload.project_id,
            )?;
        }
        if scopes.contains(&RestoreScope::Lint) {
            delete_for_project(
                &transaction,
                "lint_ignored_diagnostics",
                "DELETE FROM lint_ignored_diagnostics
                  WHERE scene_id IN (
                      SELECT id FROM tree_nodes WHERE project_id = ?1
                  )",
                &payload.project_id,
            )?;
            delete_for_project(
                &transaction,
                "lint_term_dictionary",
                "DELETE FROM lint_term_dictionary WHERE project_id = ?1",
                &payload.project_id,
            )?;
        }

        for insert in &payload.inserts {
            insert_record(
                &transaction,
                insert.table.as_str(),
                &insert.row,
                insert.mode == SnapshotInsertMode::Replace,
            )?;
        }

        if park_tree {
            restore_parked_map_reference(
                &transaction,
                &payload.project_id,
                "tree_node_id",
                "tree_nodes",
                &tree_prefix,
            )?;
        }
        if park_codex {
            restore_parked_map_reference(
                &transaction,
                &payload.project_id,
                "codex_entry_id",
                "codex_entries",
                &codex_prefix,
            )?;
        }
        transaction.commit()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::*;

    fn fixture() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('p1', 'One'), ('p2', 'Two')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
                 VALUES ('t1', 'p1', 'scene', 'One', 'a'),
                        ('t2', 'p2', 'scene', 'Two', 'a')",
                [],
            )?;
            conn.execute(
                "INSERT INTO labels (id, project_id, name, color)
                 VALUES ('l1', 'p1', 'One', '#111111'),
                        ('l2', 'p2', 'Two', '#222222')",
                [],
            )?;
            Ok(())
        })
        .expect("seed database");
        db
    }

    fn raw(value: Value) -> RawRow {
        value.as_object().expect("raw row").clone()
    }

    fn empty_snapshot(snapshot_id: &str) -> CreateProjectSnapshotPayload {
        CreateProjectSnapshotPayload {
            project_id: "p1".to_string(),
            snapshot_id: snapshot_id.to_string(),
            name: format!("Snapshot {snapshot_id}"),
            description: None,
            created_at: "2026-07-30T00:00:00.000Z".to_string(),
            tree_rows: Vec::new(),
            codex_rows: Vec::new(),
            snippet_rows: Vec::new(),
            version_ids: Vec::new(),
        }
    }

    #[test]
    fn create_captures_aux_rows_only_from_the_requested_project() {
        let db = fixture();
        create_project_snapshot(&db, empty_snapshot("s1")).expect("create snapshot");
        let context = project_snapshot_restore_context(
            &db,
            "p1".to_string(),
            "s1".to_string(),
            vec![RestoreScope::Labels],
        )
        .expect("restore context");
        let labels = context
            .aux_rows
            .iter()
            .find(|row| row.scope == "labels")
            .expect("labels aux row");
        let parsed: Value = serde_json::from_str(&labels.payload_json).expect("payload json");
        let ids = parsed["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .filter_map(|row| row["id"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["l1"]);
    }

    #[test]
    fn body_restore_preserves_only_this_projects_live_map_reference() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO map_boards (id, project_id, title)
                 VALUES ('b1', 'p1', 'One'), ('b2', 'p2', 'Two')",
                [],
            )?;
            conn.execute(
                "INSERT INTO map_node_positions
                    (id, board_id, node_ref_type, tree_node_id, x, y)
                 VALUES ('m1', 'b1', 'scene', 't1', 1, 2),
                        ('m2', 'b2', 'scene', 't2', 3, 4)",
                [],
            )?;
            Ok(())
        })
        .expect("seed maps");
        create_project_snapshot(&db, empty_snapshot("s-map")).expect("create snapshot");

        apply_project_snapshot_restore(
            &db,
            ApplyProjectSnapshotRestorePayload {
                project_id: "p1".to_string(),
                snapshot_id: "s-map".to_string(),
                scopes: vec![RestoreScope::Body],
                inserts: vec![SnapshotInsertPlan {
                    table: SnapshotRestoreTable::TreeNodes,
                    mode: SnapshotInsertMode::Insert,
                    row: raw(json!({
                        "id": "t1",
                        "project_id": "p1",
                        "node_type": "scene",
                        "title": "Restored",
                        "sort_order": "a"
                    })),
                }],
            },
        )
        .expect("restore body");

        db.with_conn(|conn| {
            let project_one_ref: String = conn.query_row(
                "SELECT tree_node_id FROM map_node_positions WHERE id = 'm1'",
                [],
                |row| row.get(0),
            )?;
            let project_two_ref: String = conn.query_row(
                "SELECT tree_node_id FROM map_node_positions WHERE id = 'm2'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(project_one_ref, "t1");
            assert_eq!(project_two_ref, "t2");
            Ok(())
        })
        .expect("read map references");
    }

    #[test]
    fn restore_context_rejects_a_foreign_snapshot() {
        let db = fixture();
        create_project_snapshot(&db, empty_snapshot("s-foreign")).expect("create snapshot");
        assert!(project_snapshot_restore_context(
            &db,
            "p2".to_string(),
            "s-foreign".to_string(),
            vec![RestoreScope::Body],
        )
        .is_err());
    }
}
