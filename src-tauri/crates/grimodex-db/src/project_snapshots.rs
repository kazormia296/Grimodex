//! Project snapshot persistence owned by the shared database layer.
//!
//! The renderer selects restore scopes and may propose dependency-safe rows,
//! but Native reconstructs the canonical plan from the owned snapshot and
//! trusted live references. Only an exact normalized plan is accepted, then
//! wipe, insert, audit, and Change Feed append commit in one transaction.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::Database;
use crate::change_events::AppendChangeEvent;
use crate::idempotency::{
    insert_idempotent_response, load_idempotent_response, payload_fingerprint, IdempotencyRequest,
};
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
    NarrativeChangeOrigin,
};
use crate::narrative_extraction::rotate_epoch_for_restore_in_tx;

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

impl RestoreScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Body => "body",
            Self::Codex => "codex",
            Self::Snippet => "snippet",
            Self::Map => "map",
            Self::Foreshadow => "foreshadow",
            Self::Labels => "labels",
            Self::Lint => "lint",
        }
    }
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotInsertMode {
    Insert,
    Replace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotRestoreTable {
    CodexTypes,
    CodexEntries,
    CodexTags,
    CodexDetailDefinitions,
    CodexDetailSemanticBindings,
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
    ForeshadowPayoffs,
    ForeshadowSetupPayoffLinks,
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
            Self::CodexDetailSemanticBindings => "codex_detail_semantic_bindings",
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
            Self::ForeshadowPayoffs => "foreshadow_payoffs",
            Self::ForeshadowSetupPayoffLinks => "foreshadow_setup_payoff_links",
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
            | Self::CodexDetailSemanticBindings
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
            Self::Foreshadows
            | Self::ForeshadowSetups
            | Self::ForeshadowPayoffs
            | Self::ForeshadowSetupPayoffLinks
            | Self::ForeshadowCodexLinks => RestoreScope::Foreshadow,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInsertPlan {
    pub table: SnapshotRestoreTable,
    pub row: RawRow,
    pub mode: SnapshotInsertMode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProjectSnapshotRestorePayload {
    pub request_id: String,
    pub session_id: String,
    pub project_id: String,
    pub snapshot_id: String,
    pub scopes: Vec<RestoreScope>,
    pub inserts: Vec<SnapshotInsertPlan>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProjectSnapshotRestoreResult {
    pub canonical_sequence: i64,
    pub change_event_uid: Option<String>,
    pub maintenance_transaction_id: Option<String>,
    pub no_op: bool,
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
    pub live_codex_phase_ids: Vec<String>,
    pub live_tree_node_ids: Vec<String>,
    pub live_snippet_ids: Vec<String>,
    pub live_event_ids: Vec<String>,
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
    AuxSpec { scope: "codex_detail_semantic_bindings", owner: RestoreScope::Codex, table: "codex_detail_semantic_bindings", predicate: "project_id = ?", binds: 1 },
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
    AuxSpec { scope: "foreshadow_payoffs", owner: RestoreScope::Foreshadow, table: "foreshadow_payoffs", predicate: "foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?)", binds: 1 },
    AuxSpec { scope: "foreshadow_setup_payoff_links", owner: RestoreScope::Foreshadow, table: "foreshadow_setup_payoff_links", predicate: "setup_id IN (SELECT id FROM foreshadow_setups WHERE foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?))", binds: 1 },
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

#[derive(Clone)]
struct SnapshotFeedObjectState {
    object_key: Value,
    rows: BTreeMap<String, Value>,
    canonical_snapshot: Value,
    version: Option<i64>,
    has_root_version: bool,
    change_kind: &'static str,
}

fn required_snapshot_row_id<'a>(
    row: &'a RawRow,
    field: &str,
    table: SnapshotRestoreTable,
) -> anyhow::Result<&'a str> {
    row.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "project snapshot Feed row '{}.{}' has no identity",
                table.as_str(),
                field
            )
        })
}

fn snapshot_component(component_kind: &str, id: &str) -> Value {
    json!({
        "kind": "component",
        "componentId": format!("{component_kind}:{id}"),
    })
}

fn snapshot_feed_object_keys(
    conn: &Connection,
    table: SnapshotRestoreTable,
    row: &RawRow,
) -> anyhow::Result<Vec<(Value, bool)>> {
    let one = |key: Value, root: bool| Ok(vec![(key, root)]);
    match table {
        SnapshotRestoreTable::TreeNodes => {
            let id = required_snapshot_row_id(row, "id", table)?;
            if row.get("node_type").and_then(Value::as_str) == Some("scene") {
                one(json!({ "kind": "scene", "sceneId": id }), true)
            } else {
                one(snapshot_component("tree-node", id), true)
            }
        }
        SnapshotRestoreTable::CodexEntries => one(
            json!({
                "kind": "codex-entry",
                "entryId": required_snapshot_row_id(row, "id", table)?,
            }),
            true,
        ),
        SnapshotRestoreTable::CodexRelations => one(
            json!({
                "kind": "codex-relation",
                "relationId": required_snapshot_row_id(row, "id", table)?,
            }),
            true,
        ),
        SnapshotRestoreTable::CodexEntryPhases => one(
            json!({
                "kind": "codex-phase",
                "phaseId": required_snapshot_row_id(row, "id", table)?,
            }),
            true,
        ),
        SnapshotRestoreTable::PlotThreads => one(
            json!({
                "kind": "plot-thread",
                "threadId": required_snapshot_row_id(row, "id", table)?,
            }),
            true,
        ),
        SnapshotRestoreTable::Events => one(
            json!({
                "kind": "chronicle-event",
                "eventId": required_snapshot_row_id(row, "id", table)?,
            }),
            true,
        ),
        SnapshotRestoreTable::ProjectCalendar => one(
            json!({
                "kind": "calendar",
                "calendarRef": required_snapshot_row_id(row, "project_id", table)?,
            }),
            true,
        ),
        SnapshotRestoreTable::Foreshadows => one(
            json!({
                "kind": "foreshadow",
                "foreshadowId": required_snapshot_row_id(row, "id", table)?,
            }),
            true,
        ),
        SnapshotRestoreTable::Snippets => one(
            snapshot_component("snippet", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::CodexTypes => one(
            snapshot_component("codex-type", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::CodexTags => one(
            snapshot_component("codex-tag", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::CodexDetailDefinitions => one(
            snapshot_component(
                "codex-detail-definition",
                required_snapshot_row_id(row, "id", table)?,
            ),
            true,
        ),
        SnapshotRestoreTable::CodexDetailSemanticBindings => one(
            snapshot_component(
                "codex_semantic_binding",
                required_snapshot_row_id(row, "id", table)?,
            ),
            true,
        ),
        SnapshotRestoreTable::CodexDetailValues => one(
            snapshot_component(
                "codex-detail-value",
                &format!(
                    "{}:{}",
                    required_snapshot_row_id(row, "entry_id", table)?,
                    required_snapshot_row_id(row, "definition_id", table)?,
                ),
            ),
            true,
        ),
        SnapshotRestoreTable::CodexEntryTags
        | SnapshotRestoreTable::CodexQuickPins
        | SnapshotRestoreTable::CodexDismissedRelations => one(
            json!({
                "kind": "codex-entry",
                "entryId": required_snapshot_row_id(row, "entry_id", table)?,
            }),
            false,
        ),
        SnapshotRestoreTable::CodexPhaseDetailOverrides => one(
            json!({
                "kind": "codex-phase",
                "phaseId": required_snapshot_row_id(row, "phase_id", table)?,
            }),
            false,
        ),
        SnapshotRestoreTable::SnippetEntryTags => one(
            snapshot_component(
                "snippet",
                required_snapshot_row_id(row, "snippet_id", table)?,
            ),
            false,
        ),
        SnapshotRestoreTable::Labels => one(
            snapshot_component("label", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::TreeNodeLabels => {
            let node_id = required_snapshot_row_id(row, "node_id", table)?;
            let node_type = conn
                .query_row(
                    "SELECT node_type FROM tree_nodes WHERE id = ?1",
                    params![node_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if node_type.as_deref() == Some("scene") {
                one(json!({ "kind": "scene", "sceneId": node_id }), false)
            } else {
                one(snapshot_component("tree-node", node_id), false)
            }
        }
        SnapshotRestoreTable::SceneCodexPins
        | SnapshotRestoreTable::SceneCodexMentions
        | SnapshotRestoreTable::SceneBeatPovCache
        | SnapshotRestoreTable::PostEffectAnnotations
        | SnapshotRestoreTable::LintIgnoredDiagnostics => {
            let field = match table {
                SnapshotRestoreTable::PostEffectAnnotations
                | SnapshotRestoreTable::LintIgnoredDiagnostics
                | SnapshotRestoreTable::SceneCodexPins
                | SnapshotRestoreTable::SceneCodexMentions
                | SnapshotRestoreTable::SceneBeatPovCache => "scene_id",
                _ => unreachable!(),
            };
            one(
                json!({
                    "kind": "scene",
                    "sceneId": required_snapshot_row_id(row, field, table)?,
                }),
                false,
            )
        }
        SnapshotRestoreTable::ForeshadowSetups
        | SnapshotRestoreTable::ForeshadowPayoffs
        | SnapshotRestoreTable::ForeshadowSetupPayoffLinks
        | SnapshotRestoreTable::ForeshadowCodexLinks => one(
            json!({
                "kind": "foreshadow",
                "foreshadowId": required_snapshot_row_id(row, "foreshadow_id", table)?,
            }),
            false,
        ),
        SnapshotRestoreTable::PlotThreadSceneLinks => one(
            snapshot_component(
                "plot_thread_marker",
                required_snapshot_row_id(row, "id", table)?,
            ),
            true,
        ),
        SnapshotRestoreTable::PlotThreadBranches => one(
            snapshot_component(
                "plot_thread_branch",
                required_snapshot_row_id(row, "id", table)?,
            ),
            true,
        ),
        SnapshotRestoreTable::SceneEvents | SnapshotRestoreTable::EventParticipants => one(
            json!({
                "kind": "chronicle-event",
                "eventId": required_snapshot_row_id(row, "event_id", table)?,
            }),
            false,
        ),
        SnapshotRestoreTable::EventRelations => {
            let cause = required_snapshot_row_id(row, "cause_event_id", table)?;
            let effect = required_snapshot_row_id(row, "effect_event_id", table)?;
            let mut keys = vec![(
                json!({ "kind": "chronicle-event", "eventId": cause }),
                false,
            )];
            if effect != cause {
                keys.push((
                    json!({ "kind": "chronicle-event", "eventId": effect }),
                    false,
                ));
            }
            Ok(keys)
        }
        SnapshotRestoreTable::MapBoards => one(
            snapshot_component("map-board", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::MapAiBranches => one(
            snapshot_component("map-ai-branch", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::MapStickies => one(
            snapshot_component("map-sticky", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::EditorStickies => one(
            snapshot_component("editor-sticky", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::MapFrames => one(
            snapshot_component("map-frame", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::MapNodePositions => one(
            snapshot_component("map-position", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::MapEdges => one(
            snapshot_component("map-edge", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::LintTermDictionary => one(
            snapshot_component("lint-term", required_snapshot_row_id(row, "id", table)?),
            true,
        ),
        SnapshotRestoreTable::GenerationLogs => {
            if let Some(scene_id) = row.get("scene_node_id").and_then(Value::as_str) {
                one(json!({ "kind": "scene", "sceneId": scene_id }), false)
            } else {
                one(
                    snapshot_component(
                        "generation-log",
                        required_snapshot_row_id(row, "id", table)?,
                    ),
                    true,
                )
            }
        }
        SnapshotRestoreTable::PostEffectAnnotationRelations => one(
            snapshot_component(
                "post-effect-relation",
                required_snapshot_row_id(row, "id", table)?,
            ),
            true,
        ),
        SnapshotRestoreTable::AuthorshipSpans => {
            for (field, kind) in [
                ("node_id", "scene"),
                ("codex_entry_id", "codex-entry"),
                ("snippet_id", "snippet"),
                ("detail_value_id", "codex_detail_value"),
                ("sticky_id", "map-sticky"),
            ] {
                let Some(id) = row.get(field).and_then(Value::as_str) else {
                    continue;
                };
                return match kind {
                    "scene" => one(json!({ "kind": "scene", "sceneId": id }), false),
                    "codex-entry" => one(json!({ "kind": "codex-entry", "entryId": id }), false),
                    component => one(snapshot_component(component, id), false),
                };
            }
            one(
                snapshot_component(
                    "authorship-span",
                    required_snapshot_row_id(row, "id", table)?,
                ),
                true,
            )
        }
    }
}

fn snapshot_feed_change_kind(table: SnapshotRestoreTable) -> &'static str {
    match table {
        SnapshotRestoreTable::TreeNodes
        | SnapshotRestoreTable::AuthorshipSpans
        | SnapshotRestoreTable::GenerationLogs
        | SnapshotRestoreTable::PostEffectAnnotations => "content",
        SnapshotRestoreTable::ProjectCalendar => "calendar",
        SnapshotRestoreTable::LintTermDictionary | SnapshotRestoreTable::LintIgnoredDiagnostics => {
            "policy"
        }
        SnapshotRestoreTable::PlotThreadSceneLinks
        | SnapshotRestoreTable::PlotThreadBranches
        | SnapshotRestoreTable::SceneEvents
        | SnapshotRestoreTable::EventParticipants
        | SnapshotRestoreTable::EventRelations
        | SnapshotRestoreTable::CodexEntryTags
        | SnapshotRestoreTable::SnippetEntryTags
        | SnapshotRestoreTable::TreeNodeLabels
        | SnapshotRestoreTable::ForeshadowSetupPayoffLinks
        | SnapshotRestoreTable::ForeshadowCodexLinks
        | SnapshotRestoreTable::MapNodePositions
        | SnapshotRestoreTable::MapEdges => "association",
        _ => "metadata",
    }
}

fn merge_snapshot_change_kind(current: &'static str, incoming: &'static str) -> &'static str {
    let rank = |kind: &str| match kind {
        "content" => 4,
        "calendar" | "policy" => 3,
        "association" => 2,
        _ => 1,
    };
    if rank(incoming) > rank(current) {
        incoming
    } else {
        current
    }
}

fn snapshot_table_has_canonical_narrative_root(table: SnapshotRestoreTable) -> bool {
    !matches!(
        table,
        SnapshotRestoreTable::AuthorshipSpans
            | SnapshotRestoreTable::GenerationLogs
            | SnapshotRestoreTable::PostEffectAnnotations
            | SnapshotRestoreTable::PostEffectAnnotationRelations
            | SnapshotRestoreTable::LintIgnoredDiagnostics
            | SnapshotRestoreTable::LintTermDictionary
            | SnapshotRestoreTable::Labels
            | SnapshotRestoreTable::SceneCodexPins
            | SnapshotRestoreTable::SceneCodexMentions
            | SnapshotRestoreTable::SceneBeatPovCache
            | SnapshotRestoreTable::CodexQuickPins
            | SnapshotRestoreTable::CodexDismissedRelations
            | SnapshotRestoreTable::EditorStickies
    )
}

fn capture_snapshot_feed_state(
    conn: &Connection,
    project_id: &str,
    snapshot_id: &str,
    scopes: &HashSet<RestoreScope>,
) -> anyhow::Result<BTreeMap<String, SnapshotFeedObjectState>> {
    let mut tables = Vec::<(SnapshotRestoreTable, &'static str, usize)>::new();
    for (scope, table) in [
        (RestoreScope::Body, SnapshotRestoreTable::TreeNodes),
        (RestoreScope::Codex, SnapshotRestoreTable::CodexEntries),
        (RestoreScope::Snippet, SnapshotRestoreTable::Snippets),
    ] {
        if scopes.contains(&scope) {
            tables.push((table, "project_id = ?", 1));
        }
    }
    for spec in AUX_SPECS.iter().filter(|spec| scopes.contains(&spec.owner)) {
        let table: SnapshotRestoreTable =
            serde_json::from_value(Value::String(spec.scope.to_string()))?;
        tables.push((table, spec.predicate, spec.binds));
    }

    let mut state = BTreeMap::<String, SnapshotFeedObjectState>::new();
    for (table, predicate, binds) in tables {
        if !table_exists(conn, table.as_str())? {
            continue;
        }
        let sql = format!("SELECT * FROM \"{}\" WHERE {predicate}", table.as_str());
        let params = (0..binds)
            .map(|_| SqlValue::Text(project_id.to_string()))
            .collect::<Vec<_>>();
        let primary_keys = table_primary_key_columns(conn, table.as_str())?;
        let mut rows = query_rows(conn, &sql, &params)?;
        rows.sort_by_cached_key(|row| {
            row_primary_key(row, &primary_keys, table.as_str()).unwrap_or_default()
        });
        for row in rows {
            let primary_key = row_primary_key(&row, &primary_keys, table.as_str())?;
            let row_token = format!("{}:{primary_key}", table.as_str());
            let row_version = row.get("version").and_then(Value::as_i64);
            let object_keys = if snapshot_table_has_canonical_narrative_root(table) {
                snapshot_feed_object_keys(conn, table, &row)?
            } else {
                // Provenance/UI/derived tables are restored atomically but do
                // not share the owning Scene/Codex Narrative digest. Group
                // them under the snapshot scope's own typed component so the
                // restore remains audited without poisoning root continuity.
                vec![(
                    snapshot_component(
                        "project-snapshot",
                        &format!("{snapshot_id}:{}", table.owner().as_str()),
                    ),
                    false,
                )]
            };
            for (object_key, is_root) in object_keys {
                let object_token = serde_json::to_string(&object_key)?;
                let entry = state
                    .entry(object_token)
                    .or_insert_with(|| SnapshotFeedObjectState {
                        object_key: object_key.clone(),
                        rows: BTreeMap::new(),
                        canonical_snapshot: Value::Null,
                        version: None,
                        has_root_version: false,
                        change_kind: snapshot_feed_change_kind(table),
                    });
                entry.change_kind =
                    merge_snapshot_change_kind(entry.change_kind, snapshot_feed_change_kind(table));
                if (is_root || !entry.has_root_version) && row_version.is_some() {
                    entry.version = row_version;
                    entry.has_root_version = is_root;
                }
                entry
                    .rows
                    .insert(row_token.clone(), Value::Object(row.clone()));
            }
        }
    }
    for object in state.values_mut() {
        let is_snapshot_scope = object
            .object_key
            .get("componentId")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("project-snapshot:"));
        object.canonical_snapshot = if is_snapshot_scope {
            json!({
                "objectKey": object.object_key,
                "rows": object.rows.iter().map(|(identity, row)| {
                    json!({ "identity": identity, "row": row })
                }).collect::<Vec<_>>(),
            })
        } else {
            crate::canonical_feed_snapshots::canonical_snapshot_for_object_key(
                conn,
                project_id,
                &object.object_key,
            )?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "project snapshot Narrative root has no canonical state: {}",
                    object.object_key
                )
            })?
        };
        object.version = object
            .canonical_snapshot
            .get("version")
            .and_then(Value::as_i64)
            .or(object.version);
    }
    Ok(state)
}

fn build_snapshot_restore_feed_events(
    project_id: &str,
    before: &BTreeMap<String, SnapshotFeedObjectState>,
    after: &BTreeMap<String, SnapshotFeedObjectState>,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    fn state_digest(state: &BTreeMap<String, SnapshotFeedObjectState>) -> anyhow::Result<String> {
        let value = Value::Object(
            state
                .iter()
                .map(|(token, object)| {
                    (
                        token.clone(),
                        json!({
                            "objectKey": object.object_key,
                            "rows": object.rows,
                            "canonicalSnapshot": object.canonical_snapshot,
                            "version": object.version,
                            "changeKind": object.change_kind,
                        }),
                    )
                })
                .collect(),
        );
        narrative_snapshot_digest(&value)
    }

    let before_digest = state_digest(before)?;
    let after_digest = state_digest(after)?;
    if before_digest == after_digest {
        return Ok(Vec::new());
    }

    // Restore replaces a scoped projection. It is a semantic epoch reset, not
    // an audit replay: one deterministic marker lets C2 rebuild dependencies
    // without flooding the Feed with one event per restored row.
    Ok(vec![NarrativeChangeEventInput {
        object_key: json!({ "kind": "project", "projectId": project_id }),
        change_kind: "schema".to_string(),
        mutation_kind: "update".to_string(),
        before_version: None,
        before_digest: Some(before_digest),
        after_version: None,
        after_digest: Some(after_digest),
        changed_paths: vec!["/".to_string()],
        text_impact: None,
        structural_impact: Some(json!({
            "event": "project-restored",
            "requiresFullRebuild": true,
        })),
    }])
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

fn table_primary_key_columns(conn: &Connection, table: &str) -> anyhow::Result<Vec<String>> {
    let sql = format!("PRAGMA table_info(\"{table}\")");
    let mut statement = conn.prepare(&sql)?;
    let mut columns = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    columns.retain(|(_, ordinal)| *ordinal > 0);
    columns.sort_by_key(|(_, ordinal)| *ordinal);
    anyhow::ensure!(
        !columns.is_empty(),
        "project snapshot restore table '{table}' has no primary key"
    );
    Ok(columns.into_iter().map(|(name, _)| name).collect())
}

fn row_primary_key(row: &RawRow, columns: &[String], table: &str) -> anyhow::Result<String> {
    let values = columns
        .iter()
        .map(|column| {
            row.get(column).cloned().ok_or_else(|| {
                anyhow::anyhow!(
                    "project snapshot insert for '{table}' is missing primary key '{column}'"
                )
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(serde_json::to_string(&values)?)
}

fn maybe_aux_snapshot_rows(
    conn: &Connection,
    snapshot_id: &str,
    scope: &str,
) -> anyhow::Result<Vec<RawRow>> {
    let payload_json = conn
        .query_row(
            "SELECT payload_json FROM project_snapshot_aux
              WHERE snapshot_id = ?1 AND scope = ?2",
            params![snapshot_id, scope],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(payload_json) = payload_json else {
        return Ok(Vec::new());
    };
    let payload: Value = serde_json::from_str(&payload_json)?;
    payload
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("project snapshot '{scope}' payload has no rows"))?
        .iter()
        .map(|row| {
            row.as_object()
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("project snapshot '{scope}' row is not an object"))
        })
        .collect()
}

fn snapshot_value(row: &RawRow, field: &str) -> Value {
    row.get(field).cloned().unwrap_or(Value::Null)
}

fn snapshot_value_or(row: &RawRow, field: &str, default: Value) -> Value {
    row.get(field)
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(default)
}

fn nullable_row_id(row: &RawRow, field: &str, table: &str) -> anyhow::Result<Option<String>> {
    match row.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(Value::String(_)) => {
            anyhow::bail!("project snapshot '{table}' row has an empty reference '{field}'")
        }
        Some(_) => anyhow::bail!(
            "project snapshot '{table}' row reference '{field}' must be a string or null"
        ),
    }
}

fn live_id_set(conn: &Connection, sql: &str, project_id: &str) -> anyhow::Result<HashSet<String>> {
    Ok(
        query_strings(conn, sql, &[SqlValue::Text(project_id.to_string())])?
            .into_iter()
            .collect(),
    )
}

fn snapshot_content(conn: &Connection, row: &RawRow) -> anyhow::Result<Value> {
    let Some(version_id) = nullable_row_id(row, "body_version_id", "body")? else {
        return Ok(Value::String("{}".to_string()));
    };
    let content = conn
        .query_row(
            "SELECT content FROM content_versions WHERE id = ?1",
            params![version_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| "{}".to_string());
    Ok(Value::String(content))
}

fn push_canonical_rows(
    conn: &Connection,
    inserts: &mut Vec<SnapshotInsertPlan>,
    table: SnapshotRestoreTable,
    mut rows: Vec<RawRow>,
    mode: SnapshotInsertMode,
) -> anyhow::Result<()> {
    if !table_exists(conn, table.as_str())? {
        return Ok(());
    }
    let primary_keys = table_primary_key_columns(conn, table.as_str())?;
    rows.sort_by_cached_key(|row| {
        row_primary_key(row, &primary_keys, table.as_str()).unwrap_or_default()
    });
    for row in rows {
        inserts.push(SnapshotInsertPlan { table, row, mode });
    }
    Ok(())
}

fn canonical_core_rows(
    conn: &Connection,
    project_id: &str,
    snapshot_id: &str,
    scopes: &HashSet<RestoreScope>,
    live_codex_ids: &HashSet<String>,
    live_tree_node_ids: &HashSet<String>,
) -> anyhow::Result<Vec<SnapshotInsertPlan>> {
    let mut inserts = Vec::new();
    let snapshot_param = [SqlValue::Text(snapshot_id.to_string())];

    if scopes.contains(&RestoreScope::Codex) {
        let rows = query_rows(
            conn,
            "SELECT * FROM project_snapshot_codex_entries
              WHERE snapshot_id = ?1 ORDER BY entry_id",
            &snapshot_param,
        )?
        .into_iter()
        .map(|row| {
            let content = snapshot_content(conn, &row)?;
            raw_row(json!({
                "id": snapshot_value(&row, "entry_id"),
                "project_id": project_id,
                "parent_id": snapshot_value(&row, "parent_id"),
                "type": snapshot_value(&row, "type"),
                "name": snapshot_value(&row, "name"),
                "aliases": snapshot_value(&row, "aliases"),
                "excluded_aliases": snapshot_value(&row, "excluded_aliases"),
                "summary": snapshot_value(&row, "summary"),
                "content": content,
                "icon": snapshot_value(&row, "icon"),
                "tags_cache": null,
                "context_mode": snapshot_value(&row, "context_mode"),
                "children_budget": snapshot_value(&row, "children_budget"),
                "source_chat_message_id": null,
                "notes": snapshot_value(&row, "notes"),
                "created_at": snapshot_value(&row, "created_at"),
                "updated_at": snapshot_value(&row, "updated_at")
            }))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::CodexEntries,
            rows,
            SnapshotInsertMode::Insert,
        )?;
    }

    if scopes.contains(&RestoreScope::Body) {
        let rows = query_rows(
            conn,
            "SELECT * FROM project_snapshot_tree_nodes
              WHERE snapshot_id = ?1 ORDER BY node_id",
            &snapshot_param,
        )?
        .into_iter()
        .map(|row| {
            let content = snapshot_content(conn, &row)?;
            let pov_id = nullable_row_id(&row, "pov_character_id", "tree_nodes")?;
            let location_id = nullable_row_id(&row, "location_id", "tree_nodes")?;
            let safe_pov = if scopes.contains(&RestoreScope::Codex)
                || pov_id
                    .as_ref()
                    .is_none_or(|value| live_codex_ids.contains(value))
            {
                pov_id.map_or(Value::Null, Value::String)
            } else {
                Value::Null
            };
            let safe_location = if scopes.contains(&RestoreScope::Codex)
                || location_id
                    .as_ref()
                    .is_none_or(|value| live_codex_ids.contains(value))
            {
                location_id.map_or(Value::Null, Value::String)
            } else {
                Value::Null
            };
            raw_row(json!({
                "id": snapshot_value(&row, "node_id"),
                "project_id": project_id,
                "parent_id": snapshot_value(&row, "parent_id"),
                "node_type": snapshot_value(&row, "node_type"),
                "title": snapshot_value(&row, "title"),
                "synopsis": snapshot_value(&row, "synopsis"),
                "intent": snapshot_value(&row, "intent"),
                "sort_order": snapshot_value(&row, "sort_order"),
                "story_time_order": snapshot_value(&row, "story_time_order"),
                "story_time_label": snapshot_value(&row, "story_time_label"),
                "pov_character_id": safe_pov,
                "location_id": safe_location,
                "chronicle_start_time": snapshot_value(&row, "chronicle_start_time"),
                "chronicle_start_minute": snapshot_value(&row, "chronicle_start_minute"),
                "chronicle_start_granularity": snapshot_value_or(
                    &row,
                    "chronicle_start_granularity",
                    Value::String("none".to_string()),
                ),
                "chronicle_end_time": snapshot_value(&row, "chronicle_end_time"),
                "chronicle_end_minute": snapshot_value(&row, "chronicle_end_minute"),
                "chronicle_end_granularity": snapshot_value_or(
                    &row,
                    "chronicle_end_granularity",
                    Value::String("none".to_string()),
                ),
                "chronicle_precision": snapshot_value_or(
                    &row,
                    "chronicle_precision",
                    Value::String("exact".to_string()),
                ),
                "status": snapshot_value(&row, "status"),
                "content": content,
                "unplaced_beats_doc": snapshot_value_or(
                    &row,
                    "unplaced_beats_doc",
                    Value::String("[]".to_string()),
                ),
                "char_count": snapshot_value_or(&row, "char_count", Value::from(0)),
                "unplaced_beat_preview": null,
                "placed_beat_preview": null,
                "created_at": snapshot_value(&row, "created_at"),
                "updated_at": snapshot_value(&row, "updated_at")
            }))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::TreeNodes,
            rows,
            SnapshotInsertMode::Insert,
        )?;
    }

    if scopes.contains(&RestoreScope::Snippet) {
        let rows = query_rows(
            conn,
            "SELECT * FROM project_snapshot_snippets
              WHERE snapshot_id = ?1 ORDER BY snippet_id",
            &snapshot_param,
        )?
        .into_iter()
        .map(|row| {
            let content = snapshot_content(conn, &row)?;
            let scene_id = nullable_row_id(&row, "scene_id", "snippets")?;
            let safe_scene = if scopes.contains(&RestoreScope::Body)
                || scene_id
                    .as_ref()
                    .is_none_or(|value| live_tree_node_ids.contains(value))
            {
                scene_id.map_or(Value::Null, Value::String)
            } else {
                Value::Null
            };
            raw_row(json!({
                "id": snapshot_value(&row, "snippet_id"),
                "project_id": project_id,
                "title": snapshot_value(&row, "title"),
                "scene_id": safe_scene,
                "source_chat_message_id": snapshot_value(&row, "source_chat_message_id"),
                "content": content,
                "tags_cache": null,
                "content_source": null,
                "usage_count": 0,
                "version": 0,
                "created_at": snapshot_value(&row, "created_at"),
                "updated_at": snapshot_value(&row, "updated_at")
            }))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::Snippets,
            rows,
            SnapshotInsertMode::Insert,
        )?;
    }

    Ok(inserts)
}

fn raw_row(value: Value) -> anyhow::Result<RawRow> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("canonical project snapshot row is not an object"))
}

fn take_aux_rows(aux_rows: &mut HashMap<String, Vec<RawRow>>, scope: &str) -> Vec<RawRow> {
    aux_rows.remove(scope).unwrap_or_default()
}

fn push_aux_scope(
    conn: &Connection,
    inserts: &mut Vec<SnapshotInsertPlan>,
    aux_rows: &mut HashMap<String, Vec<RawRow>>,
    scope: &str,
    mode: SnapshotInsertMode,
) -> anyhow::Result<()> {
    let table: SnapshotRestoreTable = serde_json::from_value(Value::String(scope.to_string()))
        .map_err(|_| {
            anyhow::anyhow!("project snapshot aux scope '{scope}' has no restore table")
        })?;
    push_canonical_rows(conn, inserts, table, take_aux_rows(aux_rows, scope), mode)
}

fn build_canonical_restore_plan(
    conn: &Connection,
    project_id: &str,
    snapshot_id: &str,
    scopes: &HashSet<RestoreScope>,
) -> anyhow::Result<Vec<SnapshotInsertPlan>> {
    let live_codex_ids = live_id_set(
        conn,
        "SELECT id FROM codex_entries WHERE project_id = ?1",
        project_id,
    )?;
    let live_codex_phase_ids = live_id_set(
        conn,
        "SELECT id FROM codex_entry_phases
          WHERE entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?1)",
        project_id,
    )?;
    let live_tree_node_ids = live_id_set(
        conn,
        "SELECT id FROM tree_nodes WHERE project_id = ?1",
        project_id,
    )?;
    let live_snippet_ids = live_id_set(
        conn,
        "SELECT id FROM snippets WHERE project_id = ?1",
        project_id,
    )?;
    let live_event_ids = live_id_set(
        conn,
        "SELECT id FROM events WHERE project_id = ?1",
        project_id,
    )?;
    let live_codex_tag_ids = live_id_set(
        conn,
        "SELECT id FROM codex_tags WHERE project_id = ?1",
        project_id,
    )?;

    let mut aux_rows = HashMap::<String, Vec<RawRow>>::new();
    for spec in AUX_SPECS.iter().filter(|spec| scopes.contains(&spec.owner)) {
        aux_rows.insert(
            spec.scope.to_string(),
            maybe_aux_snapshot_rows(conn, snapshot_id, spec.scope)?,
        );
    }
    let mut core_rows = canonical_core_rows(
        conn,
        project_id,
        snapshot_id,
        scopes,
        &live_codex_ids,
        &live_tree_node_ids,
    )?
    .into_iter()
    .fold(
        HashMap::<SnapshotRestoreTable, Vec<SnapshotInsertPlan>>::new(),
        |mut grouped, insert| {
            grouped.entry(insert.table).or_default().push(insert);
            grouped
        },
    );
    let mut inserts = Vec::new();

    if scopes.contains(&RestoreScope::Codex) {
        push_aux_scope(
            conn,
            &mut inserts,
            &mut aux_rows,
            "codex_types",
            SnapshotInsertMode::Replace,
        )?;
        inserts.extend(
            core_rows
                .remove(&SnapshotRestoreTable::CodexEntries)
                .unwrap_or_default(),
        );
        for scope in [
            "codex_tags",
            "codex_detail_definitions",
            "codex_detail_semantic_bindings",
            "codex_entry_tags",
            "codex_detail_values",
            "codex_entry_phases",
            "codex_phase_detail_overrides",
            "codex_quick_pins",
            "codex_dismissed_relations",
            "codex_relations",
        ] {
            push_aux_scope(
                conn,
                &mut inserts,
                &mut aux_rows,
                scope,
                SnapshotInsertMode::Insert,
            )?;
        }
    }

    if scopes.contains(&RestoreScope::Body) {
        inserts.extend(
            core_rows
                .remove(&SnapshotRestoreTable::TreeNodes)
                .unwrap_or_default(),
        );
        for scope in [
            "authorship_spans",
            "post_effect_annotations",
            "post_effect_annotation_relations",
        ] {
            push_aux_scope(
                conn,
                &mut inserts,
                &mut aux_rows,
                scope,
                SnapshotInsertMode::Insert,
            )?;
        }

        for (scope, reference_field) in [
            ("scene_codex_pins", "entry_id"),
            ("scene_codex_mentions", "codex_entry_id"),
            ("scene_beat_pov_cache", "pov_character_id"),
        ] {
            let rows = take_aux_rows(&mut aux_rows, scope)
                .into_iter()
                .filter(|row| {
                    scopes.contains(&RestoreScope::Codex)
                        || row
                            .get(reference_field)
                            .and_then(Value::as_str)
                            .is_none_or(|value| live_codex_ids.contains(value))
                })
                .collect();
            let table: SnapshotRestoreTable =
                serde_json::from_value(Value::String(scope.to_string()))?;
            push_canonical_rows(conn, &mut inserts, table, rows, SnapshotInsertMode::Insert)?;
        }
        for scope in [
            "plot_threads",
            "plot_thread_scene_links",
            "plot_thread_branches",
        ] {
            push_aux_scope(
                conn,
                &mut inserts,
                &mut aux_rows,
                scope,
                SnapshotInsertMode::Insert,
            )?;
        }

        let event_rows = take_aux_rows(&mut aux_rows, "events")
            .into_iter()
            .map(|mut row| {
                if !scopes.contains(&RestoreScope::Codex) {
                    for field in ["primary_codex_id", "location_codex_id"] {
                        if nullable_row_id(&row, field, "events")?
                            .as_ref()
                            .is_some_and(|value| !live_codex_ids.contains(value))
                        {
                            row.insert(field.to_string(), Value::Null);
                        }
                    }
                }
                Ok(row)
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::Events,
            event_rows,
            SnapshotInsertMode::Insert,
        )?;
        push_aux_scope(
            conn,
            &mut inserts,
            &mut aux_rows,
            "scene_events",
            SnapshotInsertMode::Insert,
        )?;
        let participant_rows = take_aux_rows(&mut aux_rows, "event_participants")
            .into_iter()
            .filter(|row| {
                scopes.contains(&RestoreScope::Codex)
                    || row
                        .get("codex_entry_id")
                        .and_then(Value::as_str)
                        .is_none_or(|value| live_codex_ids.contains(value))
            })
            .collect();
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::EventParticipants,
            participant_rows,
            SnapshotInsertMode::Insert,
        )?;
        for scope in ["event_relations", "project_calendar"] {
            push_aux_scope(
                conn,
                &mut inserts,
                &mut aux_rows,
                scope,
                SnapshotInsertMode::Insert,
            )?;
        }
    }

    if scopes.contains(&RestoreScope::Snippet) {
        inserts.extend(
            core_rows
                .remove(&SnapshotRestoreTable::Snippets)
                .unwrap_or_default(),
        );
        let rows = take_aux_rows(&mut aux_rows, "snippet_entry_tags")
            .into_iter()
            .filter(|row| {
                scopes.contains(&RestoreScope::Codex)
                    || row
                        .get("tag_id")
                        .and_then(Value::as_str)
                        .is_none_or(|value| live_codex_tag_ids.contains(value))
            })
            .collect();
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::SnippetEntryTags,
            rows,
            SnapshotInsertMode::Insert,
        )?;
    }

    if scopes.contains(&RestoreScope::Labels) {
        push_aux_scope(
            conn,
            &mut inserts,
            &mut aux_rows,
            "labels",
            SnapshotInsertMode::Insert,
        )?;
        let rows = take_aux_rows(&mut aux_rows, "tree_node_labels")
            .into_iter()
            .filter(|row| {
                scopes.contains(&RestoreScope::Body)
                    || row
                        .get("node_id")
                        .and_then(Value::as_str)
                        .is_some_and(|value| live_tree_node_ids.contains(value))
            })
            .collect();
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::TreeNodeLabels,
            rows,
            SnapshotInsertMode::Insert,
        )?;
    }

    if scopes.contains(&RestoreScope::Foreshadow) {
        let rows = take_aux_rows(&mut aux_rows, "foreshadows")
            .into_iter()
            .map(|mut row| {
                if !scopes.contains(&RestoreScope::Body)
                    && nullable_row_id(&row, "payoff_scene_id", "foreshadows")?
                        .as_ref()
                        .is_some_and(|value| !live_tree_node_ids.contains(value))
                {
                    row.insert("payoff_scene_id".to_string(), Value::Null);
                }
                Ok(row)
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::Foreshadows,
            rows,
            SnapshotInsertMode::Insert,
        )?;
        let setup_rows = take_aux_rows(&mut aux_rows, "foreshadow_setups")
            .into_iter()
            .filter(|row| {
                scopes.contains(&RestoreScope::Body)
                    || row
                        .get("scene_id")
                        .and_then(Value::as_str)
                        .is_some_and(|value| live_tree_node_ids.contains(value))
            })
            .collect::<Vec<_>>();
        let restored_setup_ids = setup_rows
            .iter()
            .filter_map(|row| row.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<HashSet<_>>();
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::ForeshadowSetups,
            setup_rows,
            SnapshotInsertMode::Insert,
        )?;
        let payoff_rows = take_aux_rows(&mut aux_rows, "foreshadow_payoffs")
            .into_iter()
            .filter(|row| {
                scopes.contains(&RestoreScope::Body)
                    || row
                        .get("scene_id")
                        .and_then(Value::as_str)
                        .is_some_and(|value| live_tree_node_ids.contains(value))
            })
            .collect::<Vec<_>>();
        let restored_payoff_ids = payoff_rows
            .iter()
            .filter_map(|row| row.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<HashSet<_>>();
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::ForeshadowPayoffs,
            payoff_rows,
            SnapshotInsertMode::Insert,
        )?;
        let link_rows = take_aux_rows(&mut aux_rows, "foreshadow_setup_payoff_links")
            .into_iter()
            .filter(|row| {
                row.get("setup_id")
                    .and_then(Value::as_str)
                    .is_some_and(|value| restored_setup_ids.contains(value))
                    && row
                        .get("payoff_id")
                        .and_then(Value::as_str)
                        .is_some_and(|value| restored_payoff_ids.contains(value))
            })
            .collect();
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::ForeshadowSetupPayoffLinks,
            link_rows,
            SnapshotInsertMode::Insert,
        )?;
        let codex_link_rows = take_aux_rows(&mut aux_rows, "foreshadow_codex_links")
            .into_iter()
            .filter(|row| {
                scopes.contains(&RestoreScope::Codex)
                    || row
                        .get("codex_entry_id")
                        .and_then(Value::as_str)
                        .is_none_or(|value| live_codex_ids.contains(value))
            })
            .collect();
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::ForeshadowCodexLinks,
            codex_link_rows,
            SnapshotInsertMode::Insert,
        )?;
    }

    if scopes.contains(&RestoreScope::Map) {
        for scope in ["map_boards", "map_ai_branches", "map_stickies"] {
            push_aux_scope(
                conn,
                &mut inserts,
                &mut aux_rows,
                scope,
                SnapshotInsertMode::Insert,
            )?;
        }
        let sticky_rows = take_aux_rows(&mut aux_rows, "editor_stickies")
            .into_iter()
            .filter(|row| {
                let owner_missing = [
                    (RestoreScope::Body, "tree_node_id", &live_tree_node_ids),
                    (RestoreScope::Codex, "codex_entry_id", &live_codex_ids),
                    (RestoreScope::Codex, "phase_id", &live_codex_phase_ids),
                    (RestoreScope::Snippet, "snippet_id", &live_snippet_ids),
                    (RestoreScope::Body, "chronicle_event_id", &live_event_ids),
                ]
                .into_iter()
                .any(|(owner, field, live_ids)| {
                    !scopes.contains(&owner)
                        && row
                            .get(field)
                            .and_then(Value::as_str)
                            .is_some_and(|value| !live_ids.contains(value))
                });
                !owner_missing
            })
            .collect();
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::EditorStickies,
            sticky_rows,
            SnapshotInsertMode::Insert,
        )?;
        push_aux_scope(
            conn,
            &mut inserts,
            &mut aux_rows,
            "map_frames",
            SnapshotInsertMode::Insert,
        )?;
        let position_rows = take_aux_rows(&mut aux_rows, "map_node_positions")
            .into_iter()
            .map(|mut row| {
                for (owner, field, live_ids) in [
                    (RestoreScope::Body, "tree_node_id", &live_tree_node_ids),
                    (RestoreScope::Codex, "codex_entry_id", &live_codex_ids),
                ] {
                    if !scopes.contains(&owner)
                        && nullable_row_id(&row, field, "map_node_positions")?
                            .as_ref()
                            .is_some_and(|value| !live_ids.contains(value))
                    {
                        row.insert(field.to_string(), Value::Null);
                    }
                }
                Ok(row)
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::MapNodePositions,
            position_rows,
            SnapshotInsertMode::Insert,
        )?;
        push_aux_scope(
            conn,
            &mut inserts,
            &mut aux_rows,
            "map_edges",
            SnapshotInsertMode::Insert,
        )?;
    }

    if scopes.contains(&RestoreScope::Lint) {
        push_aux_scope(
            conn,
            &mut inserts,
            &mut aux_rows,
            "lint_term_dictionary",
            SnapshotInsertMode::Insert,
        )?;
        let rows = take_aux_rows(&mut aux_rows, "lint_ignored_diagnostics")
            .into_iter()
            .filter(|row| {
                scopes.contains(&RestoreScope::Body)
                    || row
                        .get("scene_id")
                        .and_then(Value::as_str)
                        .is_some_and(|value| live_tree_node_ids.contains(value))
            })
            .collect();
        push_canonical_rows(
            conn,
            &mut inserts,
            SnapshotRestoreTable::LintIgnoredDiagnostics,
            rows,
            SnapshotInsertMode::Insert,
        )?;
    }

    Ok(inserts)
}

const JS_SAFE_INTEGER_MAX: f64 = 9_007_199_254_740_991.0;

/// Keep JSON values equivalent across SQLite -> N-API -> JavaScript roundtrips.
///
/// SQLite REAL `0.0` can arrive at the Native boundary as a JavaScript integer
/// `0`. Only integral binary64 values in JavaScript's safe-integer range are
/// canonicalized; fractional values and larger values retain their original
/// representation so unsafe numeric coercion cannot make distinct rows equal.
fn normalize_restore_plan_value(value: &mut Value) {
    match value {
        Value::Number(number) if number.is_f64() => {
            if let Some(float) = number.as_f64() {
                if float.is_finite() && float.fract() == 0.0 && float.abs() <= JS_SAFE_INTEGER_MAX {
                    *number = serde_json::Number::from(float as i64);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                normalize_restore_plan_value(value);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                normalize_restore_plan_value(value);
            }
        }
        _ => {}
    }
}

fn normalize_restore_plan_row(row: &mut RawRow) {
    for value in row.values_mut() {
        normalize_restore_plan_value(value);
    }
}

fn ensure_restore_plan_is_snapshot_derived(
    conn: &Connection,
    project_id: &str,
    snapshot_id: &str,
    scopes: &HashSet<RestoreScope>,
    inserts: &[SnapshotInsertPlan],
) -> anyhow::Result<Vec<SnapshotInsertPlan>> {
    let canonical = build_canonical_restore_plan(conn, project_id, snapshot_id, scopes)?;

    fn normalized_insert(
        conn: &Connection,
        insert: &SnapshotInsertPlan,
    ) -> anyhow::Result<((SnapshotRestoreTable, String), Value)> {
        anyhow::ensure!(
            table_exists(conn, insert.table.as_str())?,
            "project snapshot restore plan contains unavailable table '{}'",
            insert.table.as_str()
        );
        let primary_keys = table_primary_key_columns(conn, insert.table.as_str())?;
        let mut row = insert.row.clone();
        match insert.table {
            SnapshotRestoreTable::SceneEvents => {
                row.insert(
                    "incarnation_token".to_string(),
                    Value::String("<native-generated>".to_string()),
                );
            }
            SnapshotRestoreTable::ProjectCalendar => {
                row.insert(
                    "version".to_string(),
                    Value::String("<native-generated>".to_string()),
                );
                row.insert(
                    "updated_at".to_string(),
                    Value::String("<native-generated>".to_string()),
                );
            }
            _ => {}
        }
        normalize_restore_plan_row(&mut row);
        let key = row_primary_key(&row, &primary_keys, insert.table.as_str())?;
        Ok((
            (insert.table, key),
            json!({ "mode": insert.mode, "row": row }),
        ))
    }

    let mut expected = HashMap::<(SnapshotRestoreTable, String), Value>::new();
    for insert in &canonical {
        let (key, value) = normalized_insert(conn, insert)?;
        anyhow::ensure!(
            expected.insert(key, value).is_none(),
            "owned project snapshot contains duplicate canonical rows"
        );
    }
    let mut incoming = HashMap::<(SnapshotRestoreTable, String), Value>::new();
    for insert in inserts {
        let (key, value) = normalized_insert(conn, insert)?;
        anyhow::ensure!(
            incoming.insert(key, value).is_none(),
            "project snapshot restore plan contains a duplicate '{}' row",
            insert.table.as_str()
        );
    }

    let missing = expected
        .keys()
        .filter(|key| !incoming.contains_key(*key))
        .map(|(table, key)| format!("{}:{key}", table.as_str()))
        .collect::<Vec<_>>();
    anyhow::ensure!(
        missing.is_empty(),
        "project snapshot restore plan omits owned snapshot rows: {}",
        missing.join(", ")
    );
    let extra = incoming
        .keys()
        .filter(|key| !expected.contains_key(*key))
        .map(|(table, key)| format!("{}:{key}", table.as_str()))
        .collect::<Vec<_>>();
    anyhow::ensure!(
        extra.is_empty(),
        "project snapshot restore plan contains rows outside the owned snapshot: {}",
        extra.join(", ")
    );
    for (key, expected_value) in &expected {
        anyhow::ensure!(
            incoming.get(key) == Some(expected_value),
            "project snapshot restore row '{}:{}' does not match the owned snapshot",
            key.0.as_str(),
            key.1
        );
    }
    Ok(canonical)
}

fn ensure_inserted_row_is_project_scoped(
    conn: &Connection,
    project_id: &str,
    insert: &SnapshotInsertPlan,
) -> anyhow::Result<()> {
    let table = insert.table.as_str();
    if !table_exists(conn, table)? {
        return Ok(());
    }
    let primary_keys = table_primary_key_columns(conn, table)?;
    let (predicate, project_binds) = match insert.table {
        SnapshotRestoreTable::TreeNodes
        | SnapshotRestoreTable::CodexEntries
        | SnapshotRestoreTable::Snippets => ("project_id = ?", 1),
        table => {
            let spec = AUX_SPECS
                .iter()
                .find(|spec| spec.table == table.as_str())
                .ok_or_else(|| {
                    anyhow::anyhow!("project snapshot table '{table:?}' has no ownership rule")
                })?;
            (spec.predicate, spec.binds)
        }
    };
    let key_predicate = primary_keys
        .iter()
        .map(|column| format!("\"{column}\" = ?"))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!(
        "SELECT EXISTS(
            SELECT 1 FROM \"{table}\"
             WHERE {key_predicate} AND ({predicate})
         )"
    );
    let mut values = primary_keys
        .iter()
        .map(|column| {
            let value = insert.row.get(column).ok_or_else(|| {
                anyhow::anyhow!("project snapshot insert for '{table}' is missing '{column}'")
            })?;
            sql_value(value, column)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    values.extend((0..project_binds).map(|_| SqlValue::Text(project_id.to_string())));
    let owned: bool = conn.query_row(&sql, params_from_iter(values.iter()), |row| row.get(0))?;
    anyhow::ensure!(
        owned,
        "project snapshot insert for '{table}' is not scoped to project '{project_id}'"
    );
    Ok(())
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

fn validate_snapshot_entity_row(
    conn: &Connection,
    project_id: &str,
    row: &RawRow,
    id_field: &str,
    entity_table: &str,
    entity_type: impl Fn(&RawRow) -> anyhow::Result<Option<&'static str>>,
) -> anyhow::Result<Option<String>> {
    let entity_id = row
        .get(id_field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("project snapshot row requires '{id_field}'"))?;
    let owned = conn
        .query_row(
            &format!("SELECT 1 FROM \"{entity_table}\" WHERE id = ?1 AND project_id = ?2"),
            params![entity_id, project_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        owned,
        "project snapshot {entity_table} row is not owned by project '{project_id}'"
    );

    let Some(version_id) = row.get("body_version_id").and_then(Value::as_str) else {
        anyhow::ensure!(
            row.get("body_version_id").is_none_or(Value::is_null),
            "project snapshot body_version_id must be a string or null"
        );
        return Ok(None);
    };
    let expected_entity_type = entity_type(row)?
        .ok_or_else(|| anyhow::anyhow!("project snapshot row cannot reference a body version"))?;
    let version_owned = conn
        .query_row(
            "SELECT 1 FROM content_versions
              WHERE id = ?1 AND entity_type = ?2 AND entity_id = ?3",
            params![version_id, expected_entity_type, entity_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        version_owned,
        "project snapshot body version is not owned by the captured project entity"
    );
    Ok(Some(version_id.to_string()))
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
        let mut captured_version_ids = HashSet::new();
        for row in &payload.tree_rows {
            if let Some(version_id) = validate_snapshot_entity_row(
                &transaction,
                &payload.project_id,
                row,
                "node_id",
                "tree_nodes",
                |row| match row.get("node_type").and_then(Value::as_str) {
                    Some("scene") => Ok(Some("scene")),
                    Some("note") => Ok(Some("note")),
                    Some("folder") => Ok(None),
                    _ => anyhow::bail!("project snapshot tree row has an invalid node_type"),
                },
            )? {
                anyhow::ensure!(
                    captured_version_ids.insert(version_id),
                    "project snapshot body versions must be unique"
                );
            }
        }
        for row in &payload.codex_rows {
            if let Some(version_id) = validate_snapshot_entity_row(
                &transaction,
                &payload.project_id,
                row,
                "entry_id",
                "codex_entries",
                |_| Ok(Some("codex_entry")),
            )? {
                anyhow::ensure!(
                    captured_version_ids.insert(version_id),
                    "project snapshot body versions must be unique"
                );
            }
        }
        for row in &payload.snippet_rows {
            if let Some(version_id) = validate_snapshot_entity_row(
                &transaction,
                &payload.project_id,
                row,
                "snippet_id",
                "snippets",
                |_| Ok(Some("snippet")),
            )? {
                anyhow::ensure!(
                    captured_version_ids.insert(version_id),
                    "project snapshot body versions must be unique"
                );
            }
        }
        let requested_version_ids = payload.version_ids.iter().cloned().collect::<HashSet<_>>();
        anyhow::ensure!(
            requested_version_ids.len() == payload.version_ids.len()
                && requested_version_ids == captured_version_ids,
            "project snapshot versionIds must exactly match captured body versions"
        );
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
        let live_codex_phase_ids = query_strings(
            conn,
            "SELECT id FROM codex_entry_phases WHERE entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?1)",
            &project_param,
        )?;
        let live_tree_node_ids = query_strings(
            conn,
            "SELECT id FROM tree_nodes WHERE project_id = ?1",
            &project_param,
        )?;
        let live_snippet_ids = query_strings(
            conn,
            "SELECT id FROM snippets WHERE project_id = ?1",
            &project_param,
        )?;
        let live_event_ids = query_strings(
            conn,
            "SELECT id FROM events WHERE project_id = ?1",
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
            live_codex_phase_ids,
            live_tree_node_ids,
            live_snippet_ids,
            live_event_ids,
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

fn calendar_version_from_snapshot(
    transaction: &Transaction<'_>,
    snapshot_id: &str,
    project_id: &str,
) -> anyhow::Result<Option<i64>> {
    let payload_json = transaction
        .query_row(
            "SELECT payload_json FROM project_snapshot_aux
              WHERE snapshot_id = ?1 AND scope = 'project_calendar'",
            params![snapshot_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(payload_json) = payload_json else {
        return Ok(None);
    };
    let payload: Value = serde_json::from_str(&payload_json)?;
    let rows = payload
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("project_calendar snapshot payload has no rows"))?;
    let snapshot_row = rows
        .iter()
        .find(|row| row.get("project_id").and_then(Value::as_str) == Some(project_id))
        .ok_or_else(|| anyhow::anyhow!("project_calendar snapshot has no project row"))?;
    let Some(version) = snapshot_row.get("version") else {
        // Structural snapshots created before Calendar OCC did not include a
        // version. Treat that historical generation as zero, but never accept
        // a present malformed value.
        return Ok(Some(0));
    };
    let version = version
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("project_calendar snapshot version must be an integer"))?;
    if version < 0 {
        anyhow::bail!("project_calendar snapshot version must be non-negative");
    }
    Ok(Some(version))
}

fn next_calendar_restore_version(
    transaction: &Transaction<'_>,
    snapshot_id: &str,
    project_id: &str,
) -> anyhow::Result<i64> {
    let live_version = transaction
        .query_row(
            "SELECT version FROM project_calendar WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if live_version.is_some_and(|value| value < 0) {
        anyhow::bail!("live project_calendar version must be non-negative");
    }
    let snapshot_version = calendar_version_from_snapshot(transaction, snapshot_id, project_id)?;
    let baseline = live_version
        .into_iter()
        .chain(snapshot_version)
        .max()
        .unwrap_or(-1);
    baseline
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("project_calendar version overflow during restore"))
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

const EDITOR_STICKY_PARK_TABLE: &str = "__grimodex_editor_sticky_restore_park";

/// Protect display-only editor stickies while an owner scope is replaced.
///
/// `editor_stickies` is owned by several different scope tables, so deleting
/// one of those tables' rows can cascade-delete a sticky even when the map
/// scope is deliberately not being restored. A temporary table keeps the
/// current rows inside the same transaction; rows whose owner is not rebuilt
/// are intentionally omitted during restore rather than reintroducing an
/// orphaned foreign key.
fn park_editor_stickies(transaction: &Transaction<'_>, project_id: &str) -> anyhow::Result<()> {
    transaction.execute_batch(&format!(
        "DROP TABLE IF EXISTS temp.{EDITOR_STICKY_PARK_TABLE};"
    ))?;
    let sql = format!(
        "CREATE TEMP TABLE {EDITOR_STICKY_PARK_TABLE} AS
         SELECT id, project_id, document_key, body, palette_id, color_slot,
                inline_offset, block_offset, z_index, version, tree_node_id,
                codex_entry_id, phase_id, snippet_id, chronicle_event_id,
                created_at, updated_at
           FROM editor_stickies
          WHERE project_id = ?1"
    );
    transaction.execute(&sql, params![project_id])?;
    Ok(())
}

fn restore_parked_editor_stickies(
    transaction: &Transaction<'_>,
    project_id: &str,
) -> anyhow::Result<()> {
    let sql = format!(
        "INSERT OR IGNORE INTO editor_stickies (
             id, project_id, document_key, body, palette_id, color_slot,
             inline_offset, block_offset, z_index, version, tree_node_id,
             codex_entry_id, phase_id, snippet_id, chronicle_event_id,
             created_at, updated_at
         )
         SELECT parked.id, parked.project_id, parked.document_key, parked.body,
                parked.palette_id, parked.color_slot, parked.inline_offset,
                parked.block_offset, parked.z_index, parked.version,
                parked.tree_node_id, parked.codex_entry_id, parked.phase_id,
                parked.snippet_id, parked.chronicle_event_id, parked.created_at,
                parked.updated_at
           FROM temp.{EDITOR_STICKY_PARK_TABLE} AS parked
          WHERE parked.project_id = ?1
            AND (
                (parked.tree_node_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM tree_nodes
                     WHERE tree_nodes.id = parked.tree_node_id
                       AND tree_nodes.project_id = ?1
                ))
                OR
                (parked.codex_entry_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM codex_entries
                     WHERE codex_entries.id = parked.codex_entry_id
                       AND codex_entries.project_id = ?1
                ) AND (
                    parked.phase_id IS NULL OR EXISTS (
                        SELECT 1 FROM codex_entry_phases
                         WHERE codex_entry_phases.id = parked.phase_id
                           AND codex_entry_phases.entry_id = parked.codex_entry_id
                    )
                ))
                OR
                (parked.snippet_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM snippets
                     WHERE snippets.id = parked.snippet_id
                       AND snippets.project_id = ?1
                ))
                OR
                (parked.chronicle_event_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM events
                     WHERE events.id = parked.chronicle_event_id
                       AND events.project_id = ?1
                ))
            )"
    );
    transaction.execute(&sql, params![project_id])?;
    transaction.execute_batch(&format!(
        "DROP TABLE IF EXISTS temp.{EDITOR_STICKY_PARK_TABLE};"
    ))?;
    Ok(())
}

pub fn apply_project_snapshot_restore(
    db: &Database,
    payload: ApplyProjectSnapshotRestorePayload,
) -> anyhow::Result<ApplyProjectSnapshotRestoreResult> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.snapshot_id, "snapshotId")?;
    require_non_empty(&payload.request_id, "requestId")?;
    require_non_empty(&payload.session_id, "sessionId")?;
    let scopes = payload.scopes.iter().copied().collect::<HashSet<_>>();
    anyhow::ensure!(
        !scopes.is_empty(),
        "project snapshot restore requires at least one scope"
    );
    anyhow::ensure!(
        scopes.len() == payload.scopes.len(),
        "project snapshot restore scopes must be unique"
    );
    let mut fingerprint_scopes = scopes
        .iter()
        .copied()
        .map(RestoreScope::as_str)
        .collect::<Vec<_>>();
    fingerprint_scopes.sort_unstable();
    // Renderer-generated placeholders (for example scene association
    // incarnation tokens) may differ on an exact retry. The operation's
    // identity is the owned snapshot + selected scopes + captured authority;
    // the insert rows are validated against Native's canonical plan below.
    let request_hash = payload_fingerprint(
        "project_snapshot_restore",
        &json!({
            "projectId": payload.project_id,
            "snapshotId": payload.snapshot_id,
            "scopes": fingerprint_scopes,
        }),
    )?;
    let idempotency_request = IdempotencyRequest {
        domain: "project_snapshot_restore",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "PROJECT_SNAPSHOT_RESTORE_IDEMPOTENCY_CONFLICT",
    };
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
        let transaction = conn.unchecked_transaction()?;
        ensure_snapshot_owned(&transaction, &payload.project_id, &payload.snapshot_id)?;
        let structural = transaction.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM project_snapshot_aux WHERE snapshot_id = ?1
             )",
            params![payload.snapshot_id],
            |row| row.get::<_, i64>(0),
        )? != 0;
        if !structural {
            anyhow::bail!("legacy project snapshots cannot use structural restore");
        }
        let canonical_inserts = ensure_restore_plan_is_snapshot_derived(
            &transaction,
            &payload.project_id,
            &payload.snapshot_id,
            &scopes,
            &payload.inserts,
        )?;
        if let Some(response) = load_idempotent_response(&transaction, &idempotency_request)? {
            let result = serde_json::from_value(response)?;
            transaction.commit()?;
            return Ok(result);
        }
        // Capture trusted live state before any parking, deletion, or insert.
        // The resulting Feed diff is therefore about the project-owned domain
        // objects that actually changed, rather than the restore scopes that
        // happened to be selected by the caller.
        let feed_before = capture_snapshot_feed_state(
            &transaction,
            &payload.project_id,
            &payload.snapshot_id,
            &scopes,
        )?;
        transaction.execute_batch("PRAGMA defer_foreign_keys = ON;")?;

        // A body restore is a new Calendar generation, not a resurrection of
        // the version captured in the snapshot. Derive the token from trusted
        // DB state before deleting the live row; never trust renderer input.
        let calendar_restore_version = if scopes.contains(&RestoreScope::Body)
            && canonical_inserts
                .iter()
                .any(|insert| insert.table == SnapshotRestoreTable::ProjectCalendar)
        {
            Some(next_calendar_restore_version(
                &transaction,
                &payload.snapshot_id,
                &payload.project_id,
            )?)
        } else {
            None
        };
        let calendar_restore_updated_at = if calendar_restore_version.is_some() {
            Some(transaction.query_row(
                "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                [],
                |row| row.get::<_, String>(0),
            )?)
        } else {
            None
        };

        let tree_prefix = format!("__grimodex_snapshot_tree_{}__", payload.snapshot_id);
        let codex_prefix = format!("__grimodex_snapshot_codex_{}__", payload.snapshot_id);
        let park_tree = scopes.contains(&RestoreScope::Body)
            && !scopes.contains(&RestoreScope::Map)
            && table_exists(&transaction, "map_node_positions")?;
        let park_codex = scopes.contains(&RestoreScope::Codex)
            && !scopes.contains(&RestoreScope::Map)
            && table_exists(&transaction, "map_node_positions")?;
        let park_editor_stickies_needed = !scopes.contains(&RestoreScope::Map)
            && (scopes.contains(&RestoreScope::Body)
                || scopes.contains(&RestoreScope::Codex)
                || scopes.contains(&RestoreScope::Snippet))
            && table_exists(&transaction, "editor_stickies")?;
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
        if park_editor_stickies_needed {
            park_editor_stickies(&transaction, &payload.project_id)?;
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

        let mut applied_inserts = Vec::with_capacity(canonical_inserts.len());
        for insert in &canonical_inserts {
            let mut row = insert.row.clone();
            if insert.table == SnapshotRestoreTable::ProjectCalendar {
                let version = calendar_restore_version.ok_or_else(|| {
                    anyhow::anyhow!("project_calendar restore version was not prepared")
                })?;
                row.insert("version".to_string(), Value::from(version));
                let updated_at = calendar_restore_updated_at.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("project_calendar restore timestamp was not prepared")
                })?;
                row.insert("updated_at".to_string(), Value::from(updated_at.clone()));
            }
            if insert.table == SnapshotRestoreTable::SceneEvents {
                // Structural restore creates a new physical association. Do
                // not trust or revive the captured incarnation token, because
                // a pre-restore journal could otherwise pass its stale CAS.
                row.insert(
                    "incarnation_token".to_string(),
                    Value::from(uuid::Uuid::new_v4().to_string()),
                );
            }
            insert_record(
                &transaction,
                insert.table.as_str(),
                &row,
                insert.mode == SnapshotInsertMode::Replace,
            )?;
            applied_inserts.push(SnapshotInsertPlan {
                table: insert.table,
                row,
                mode: insert.mode,
            });
        }
        for insert in &applied_inserts {
            ensure_inserted_row_is_project_scoped(&transaction, &payload.project_id, insert)?;
        }

        if park_editor_stickies_needed {
            restore_parked_editor_stickies(&transaction, &payload.project_id)?;
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

        let feed_after = capture_snapshot_feed_state(
            &transaction,
            &payload.project_id,
            &payload.snapshot_id,
            &scopes,
        )?;

        let mut ordered_scopes = scopes.iter().copied().collect::<Vec<_>>();
        ordered_scopes.sort_by_key(|scope| scope.as_str());
        let feed_events =
            build_snapshot_restore_feed_events(&payload.project_id, &feed_before, &feed_after)?;
        if feed_events.is_empty() {
            // A net no-op must not manufacture a project restore marker merely
            // to satisfy the non-empty Feed transaction contract.
            // Persist the retry receipt at the current canonical tail instead.
            let canonical_sequence = transaction.query_row(
                "SELECT COALESCE(MAX(sequence), 0)
                   FROM change_events
                  WHERE project_id = ?1",
                params![payload.project_id],
                |row| row.get::<_, i64>(0),
            )?;
            let result = ApplyProjectSnapshotRestoreResult {
                canonical_sequence,
                change_event_uid: None,
                maintenance_transaction_id: None,
                no_op: true,
            };
            insert_idempotent_response(
                &transaction,
                &idempotency_request,
                &payload.project_id,
                &serde_json::to_value(&result)?,
            )?;
            transaction.commit()?;
            return Ok(result);
        }
        let change_event_uid = uuid::Uuid::new_v4().to_string();
        let occurred_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let timestamp = chrono::Utc::now().timestamp_millis();
        let canonical_payload = json!({
            "snapshotId": payload.snapshot_id,
            "requestId": payload.request_id,
            "scopes": ordered_scopes.iter().map(|scope| scope.as_str()).collect::<Vec<_>>(),
        });
        let append = append_canonical_and_narrative_change_in_tx(
            &transaction,
            &payload.project_id,
            &payload.session_id,
            &AppendChangeEvent {
                event_uid: change_event_uid.clone(),
                scene_id: None,
                domain: "revision".to_string(),
                op_type: "project.snapshot.restore".to_string(),
                entity_type: Some("project_snapshot".to_string()),
                entity_id: Some(payload.snapshot_id.clone()),
                payload: canonical_payload.to_string(),
                timestamp,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: payload.project_id.clone(),
                request_id: payload.request_id.clone(),
                source_domain: "project.snapshot.restore".to_string(),
                source_change_event_uid: change_event_uid.clone(),
                cause_kind: NarrativeChangeCauseKind::Forward,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                commit_id: None,
                journal_id: None,
                undo_journal_id: None,
                application_ids: vec![],
                occurred_at,
                events: feed_events,
            },
        )?;
        // Gate C2 Lane A/N (`semantic_epoch.rs`/`restore_rebuild.rs`, wired
        // in C2-T1): a Restore is always the `"project-restored"` structural
        // impact `build_snapshot_restore_feed_events` above unconditionally
        // sets whenever `feed_events` is non-empty (the only way this line
        // is reached; a net no-op already returned earlier). Mint a new
        // Semantic Epoch in the same transaction as the Change Feed append,
        // so a rebuild after Restore sees the Dependency Edge graph as
        // reset from this exact point, not from whatever the prior Epoch
        // was tracking.
        rotate_epoch_for_restore_in_tx(
            &transaction,
            &payload.project_id,
            "project-restored",
            Some(&change_event_uid),
        )?;
        let result = ApplyProjectSnapshotRestoreResult {
            canonical_sequence: append.canonical.tail_sequence,
            change_event_uid: Some(change_event_uid),
            maintenance_transaction_id: Some(append.narrative.transaction_id),
            no_op: false,
        };
        insert_idempotent_response(
            &transaction,
            &idempotency_request,
            &payload.project_id,
            &serde_json::to_value(&result)?,
        )?;
        transaction.commit()?;
        Ok(result)
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

    #[test]
    fn restore_plan_comparison_accepts_js_safe_integral_real_spelling() {
        let mut expected = json!({"sort_order": 0.0});
        let mut incoming = json!({"sort_order": 0});
        normalize_restore_plan_value(&mut expected);
        normalize_restore_plan_value(&mut incoming);
        assert_eq!(expected, incoming);
    }

    #[test]
    fn restore_plan_comparison_rejects_fractional_real_against_integer() {
        let mut expected = json!({"sort_order": 0.5});
        let mut incoming = json!({"sort_order": 0});
        normalize_restore_plan_value(&mut expected);
        normalize_restore_plan_value(&mut incoming);
        assert_ne!(expected, incoming);
    }

    #[test]
    fn restore_plan_comparison_rejects_unsafe_integral_real_against_integer() {
        let mut expected = json!({"sort_order": 9_007_199_254_740_994.0_f64});
        let mut incoming = json!({"sort_order": 9_007_199_254_740_994_i64});
        normalize_restore_plan_value(&mut expected);
        normalize_restore_plan_value(&mut incoming);
        assert_ne!(expected, incoming);
        assert!(expected["sort_order"].is_f64());
    }

    fn empty_snapshot(snapshot_id: &str) -> CreateProjectSnapshotPayload {
        CreateProjectSnapshotPayload {
            project_id: "p1".to_string(),
            snapshot_id: snapshot_id.to_string(),
            name: format!("Snapshot {snapshot_id}"),
            description: None,
            created_at: "2026-07-30T00:00:00.000Z".to_string(),
            tree_rows: vec![raw(json!({
                "snapshot_id": snapshot_id,
                "node_id": "t1",
                "parent_id": null,
                "node_type": "scene",
                "title": "One",
                "synopsis": null,
                "intent": null,
                "sort_order": "a",
                "story_time_order": null,
                "story_time_label": null,
                "pov_character_id": null,
                "location_id": null,
                "chronicle_start_time": null,
                "chronicle_start_minute": null,
                "chronicle_start_granularity": "none",
                "chronicle_end_time": null,
                "chronicle_end_minute": null,
                "chronicle_end_granularity": "none",
                "chronicle_precision": "exact",
                "status": null,
                "body_version_id": null,
                "unplaced_beats_doc": "[]",
                "char_count": 0,
                "created_at": "2026-07-30T00:00:00.000Z",
                "updated_at": "2026-07-30T00:00:00.000Z"
            }))],
            codex_rows: Vec::new(),
            snippet_rows: Vec::new(),
            version_ids: Vec::new(),
        }
    }

    fn canonical_restore_payload(
        db: &Database,
        request_id: &str,
        snapshot_id: &str,
        scopes: Vec<RestoreScope>,
    ) -> ApplyProjectSnapshotRestorePayload {
        let selected = scopes.iter().copied().collect::<HashSet<_>>();
        let inserts = db
            .with_conn(|conn| build_canonical_restore_plan(conn, "p1", snapshot_id, &selected))
            .expect("build canonical test restore plan");
        ApplyProjectSnapshotRestorePayload {
            request_id: request_id.to_string(),
            session_id: "test-session".to_string(),
            project_id: "p1".to_string(),
            snapshot_id: snapshot_id.to_string(),
            scopes,
            inserts,
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
    fn body_restore_assigns_scene_event_a_fresh_incarnation() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO events
                    (id, project_id, title, ordinal, created_at, updated_at)
                 VALUES ('e1', 'p1', 'Event', 'a0', datetime('now'), datetime('now'));
                 INSERT INTO scene_events (scene_id, event_id, incarnation_token)
                 VALUES ('t1', 'e1', 'captured-incarnation');",
            )?;
            Ok(())
        })
        .expect("seed scene-event incarnation");
        create_project_snapshot(&db, empty_snapshot("s-scene-event"))
            .expect("create scene-event snapshot");

        let mut first = canonical_restore_payload(
            &db,
            "restore-scene-event",
            "s-scene-event",
            vec![RestoreScope::Body],
        );
        first
            .inserts
            .iter_mut()
            .find(|insert| insert.table == SnapshotRestoreTable::SceneEvents)
            .expect("scene-event insert")
            .row
            .insert(
                "incarnation_token".to_string(),
                Value::String("renderer-first-token".to_string()),
            );
        let mut retry = first.clone();
        retry.session_id = "snapshot-session-after-restart".to_string();
        retry
            .inserts
            .iter_mut()
            .find(|insert| insert.table == SnapshotRestoreTable::SceneEvents)
            .expect("scene-event retry insert")
            .row
            .insert(
                "incarnation_token".to_string(),
                Value::String("renderer-retry-token".to_string()),
            );
        let first_result =
            apply_project_snapshot_restore(&db, first).expect("restore scene-event snapshot");
        let retry_result =
            apply_project_snapshot_restore(&db, retry).expect("retry scene-event snapshot");
        assert_eq!(retry_result, first_result);

        db.with_conn(|conn| {
            let token: String = conn.query_row(
                "SELECT incarnation_token FROM scene_events
                  WHERE scene_id = 't1' AND event_id = 'e1'",
                [],
                |row| row.get(0),
            )?;
            assert!(!token.is_empty());
            assert_ne!(token, "captured-incarnation");
            assert_ne!(token, "renderer-first-token");
            assert_ne!(token, "renderer-retry-token");
            let feed_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE request_id = 'restore-scene-event'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(
                feed_count, 1,
                "retry must not append a second Feed transaction"
            );
            Ok(())
        })
        .expect("verify fresh scene-event incarnation");
    }

    #[test]
    fn body_restore_advances_calendar_generation_past_the_live_version() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO project_calendar
                    (project_id, days_per_year, season_boundaries, version)
                 VALUES ('p1', 400, '[]', 2)",
                [],
            )?;
            Ok(())
        })
        .expect("seed snapshot calendar");
        create_project_snapshot(&db, empty_snapshot("s-calendar"))
            .expect("create calendar snapshot");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE project_calendar
                    SET days_per_year = 999, version = 8
                  WHERE project_id = 'p1'",
                [],
            )?;
            Ok(())
        })
        .expect("advance live calendar");

        let first_payload = canonical_restore_payload(
            &db,
            "restore-calendar-first",
            "s-calendar",
            vec![RestoreScope::Body],
        );
        let mut malformed_payload = first_payload.clone();
        malformed_payload.request_id = "restore-calendar-second".to_string();
        apply_project_snapshot_restore(&db, first_payload).expect("restore body calendar");

        db.with_conn(|conn| {
            let (days_per_year, version, updated_at): (i64, i64, String) = conn.query_row(
                "SELECT days_per_year, version, updated_at
                   FROM project_calendar
                  WHERE project_id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(days_per_year, 400);
            assert_eq!(version, 9);
            assert_ne!(updated_at, "2000-01-01T00:00:00.000Z");
            let recorded: (String, String, Option<i64>, Option<i64>, String, String) = conn
                .query_row(
                    "SELECT object_key_json, mutation_kind, before_version,
                        after_version, before_digest, after_digest
                   FROM narrative_change_events
                  WHERE project_id = 'p1'
                    AND object_key_json LIKE '%\"kind\":\"project\"%'",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )?;
            assert_eq!(
                serde_json::from_str::<Value>(&recorded.0)?,
                json!({ "kind": "project", "projectId": "p1" })
            );
            assert_eq!(recorded.1, "update");
            assert_eq!((recorded.2, recorded.3), (None, None));
            assert_ne!(recorded.4, recorded.5);
            let structural: String = conn.query_row(
                "SELECT structural_impact_json
                   FROM narrative_change_events
                  WHERE project_id = 'p1'
                    AND object_key_json LIKE '%\"kind\":\"project\"%'",
                [],
                |row| row.get(0),
            )?;
            let structural: Value = serde_json::from_str(&structural)?;
            assert_eq!(structural["event"], "project-restored");
            assert_eq!(structural["requiresFullRebuild"], true);
            let stale_write = conn.execute(
                "UPDATE project_calendar
                    SET days_per_year = 401, version = version + 1
                  WHERE project_id = 'p1' AND version = 2",
                [],
            )?;
            assert_eq!(stale_write, 0);
            let stale_live_write = conn.execute(
                "UPDATE project_calendar
                    SET days_per_year = 402, version = version + 1
                  WHERE project_id = 'p1' AND version = 8",
                [],
            )?;
            assert_eq!(stale_live_write, 0);
            Ok(())
        })
        .expect("verify restored calendar generation");

        db.with_conn(|conn| {
            let payload_json: String = conn.query_row(
                "SELECT payload_json FROM project_snapshot_aux
                  WHERE snapshot_id = 's-calendar' AND scope = 'project_calendar'",
                [],
                |row| row.get(0),
            )?;
            let mut snapshot_payload: Value = serde_json::from_str(&payload_json)?;
            snapshot_payload["rows"][0]["version"] = json!("not-an-integer");
            conn.execute(
                "UPDATE project_snapshot_aux SET payload_json = ?1
                  WHERE snapshot_id = 's-calendar' AND scope = 'project_calendar'",
                params![snapshot_payload.to_string()],
            )?;
            Ok(())
        })
        .expect("corrupt snapshot calendar version");
        let malformed_restore = apply_project_snapshot_restore(&db, malformed_payload);
        assert!(malformed_restore.is_err());
        db.with_conn(|conn| {
            let (days_per_year, version): (i64, i64) = conn.query_row(
                "SELECT days_per_year, version FROM project_calendar WHERE project_id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!((days_per_year, version), (400, 9));
            Ok(())
        })
        .expect("malformed restore leaves live calendar untouched");
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
            canonical_restore_payload(&db, "restore-map-body", "s-map", vec![RestoreScope::Body]),
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
    fn restore_plan_cannot_rebind_a_snapshot_child_to_another_project() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO map_boards (id, project_id, title)
                 VALUES ('b1', 'p1', 'One'), ('b2', 'p2', 'Two')",
                [],
            )?;
            conn.execute(
                "INSERT INTO map_stickies (id, board_id, title)
                 VALUES ('sticky-1', 'b1', 'Owned')",
                [],
            )?;
            Ok(())
        })
        .expect("seed map child ownership");
        create_project_snapshot(&db, empty_snapshot("s-map-scope")).expect("capture map snapshot");

        let mut payload = canonical_restore_payload(
            &db,
            "restore-map-xproj",
            "s-map-scope",
            vec![RestoreScope::Map],
        );
        payload
            .inserts
            .iter_mut()
            .find(|insert| {
                insert.table == SnapshotRestoreTable::MapStickies
                    && insert.row.get("id").and_then(Value::as_str) == Some("sticky-1")
            })
            .expect("captured sticky plan")
            .row
            .insert("board_id".to_string(), Value::String("b2".to_string()));
        let error = apply_project_snapshot_restore(&db, payload)
            .expect_err("snapshot child must remain in the owned project");
        assert!(error
            .to_string()
            .contains("does not match the owned snapshot"));

        db.with_conn(|conn| {
            let board_id: String = conn.query_row(
                "SELECT board_id FROM map_stickies WHERE id = 'sticky-1'",
                [],
                |row| row.get(0),
            )?;
            let receipt_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = 'project_snapshot_restore'
                    AND request_id = 'restore-map-xproj'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(board_id, "b1");
            assert_eq!(receipt_count, 0);
            Ok(())
        })
        .expect("verify cross-project plan rollback");
    }

    #[test]
    fn owner_scope_restore_preserves_editor_stickies_without_map_scope() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO codex_types (id, project_id, slug, label)
                 VALUES ('type-review-character', 'p1', 'review-character', 'Review Character')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name)
                 VALUES ('cx1', 'p1', 'review-character', 'Hero')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entry_phases (id, entry_id, label)
                 VALUES ('phase1', 'cx1', 'Older')",
                [],
            )?;
            conn.execute(
                "INSERT INTO snippets (id, project_id, title)
                 VALUES ('snippet1', 'p1', 'A note')",
                [],
            )?;
            conn.execute(
                "INSERT INTO events (id, project_id, title, ordinal, precision, kind)
                 VALUES ('event1', 'p1', 'Arrival', 'a0', 'exact', 'generic')",
                [],
            )?;
            conn.execute(
                "INSERT INTO editor_stickies
                    (id, project_id, document_key, tree_node_id)
                 VALUES ('sticky-tree', 'p1', 'tree: t1', 't1')",
                [],
            )?;
            conn.execute(
                "INSERT INTO editor_stickies
                    (id, project_id, document_key, codex_entry_id, phase_id)
                 VALUES ('sticky-codex', 'p1', 'codex: cx1', 'cx1', 'phase1')",
                [],
            )?;
            conn.execute(
                "INSERT INTO editor_stickies
                    (id, project_id, document_key, snippet_id)
                 VALUES ('sticky-snippet', 'p1', 'snippet: snippet1', 'snippet1')",
                [],
            )?;
            conn.execute(
                "INSERT INTO editor_stickies
                    (id, project_id, document_key, chronicle_event_id)
                 VALUES ('sticky-event', 'p1', 'chronicle-event: event1', 'event1')",
                [],
            )?;
            Ok(())
        })
        .expect("seed editor sticky owners");

        let mut snapshot = empty_snapshot("s-sticky-owners");
        snapshot.codex_rows.push(raw(json!({
            "snapshot_id": "s-sticky-owners",
            "entry_id": "cx1",
            "type": "review-character",
            "name": "Hero",
            "parent_id": null,
            "aliases": null,
            "excluded_aliases": null,
            "summary": null,
            "icon": null,
            "context_mode": "mentioned",
            "children_budget": "compact",
            "notes": null,
            "body_version_id": null,
            "created_at": "2026-07-30T00:00:00.000Z",
            "updated_at": "2026-07-30T00:00:00.000Z"
        })));
        snapshot.snippet_rows.push(raw(json!({
            "snapshot_id": "s-sticky-owners",
            "snippet_id": "snippet1",
            "title": "A note",
            "scene_id": null,
            "source_chat_message_id": null,
            "body_version_id": null,
            "created_at": "2026-07-30T00:00:00.000Z",
            "updated_at": "2026-07-30T00:00:00.000Z"
        })));
        create_project_snapshot(&db, snapshot).expect("create sticky owner snapshot");

        apply_project_snapshot_restore(
            &db,
            canonical_restore_payload(
                &db,
                "restore-sticky-body",
                "s-sticky-owners",
                vec![RestoreScope::Body],
            ),
        )
        .expect("restore body without map");

        apply_project_snapshot_restore(
            &db,
            canonical_restore_payload(
                &db,
                "restore-sticky-codex",
                "s-sticky-owners",
                vec![RestoreScope::Codex],
            ),
        )
        .expect("restore codex without map");

        apply_project_snapshot_restore(
            &db,
            canonical_restore_payload(
                &db,
                "restore-sticky-snippet",
                "s-sticky-owners",
                vec![RestoreScope::Snippet],
            ),
        )
        .expect("restore snippet without map");

        db.with_conn(|conn| {
            let ids = query_strings(
                conn,
                "SELECT id FROM editor_stickies WHERE project_id = 'p1' ORDER BY id",
                &[],
            )?;
            assert_eq!(
                ids,
                vec![
                    "sticky-codex".to_string(),
                    "sticky-event".to_string(),
                    "sticky-snippet".to_string(),
                    "sticky-tree".to_string(),
                ]
            );
            Ok(())
        })
        .expect("read restored editor stickies");
    }

    #[test]
    fn parked_editor_sticky_with_missing_owner_is_skipped() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO editor_stickies
                    (id, project_id, document_key, tree_node_id)
                 VALUES ('sticky-missing-owner', 'p1', 'tree: t1', 't1')",
                [],
            )?;
            Ok(())
        })
        .expect("seed editor sticky");
        let mut snapshot = empty_snapshot("s-missing-owner");
        snapshot.tree_rows.clear();
        create_project_snapshot(&db, snapshot).expect("create missing-owner snapshot");

        apply_project_snapshot_restore(
            &db,
            ApplyProjectSnapshotRestorePayload {
                request_id: "restore-missing-owner".to_string(),
                session_id: "test-session".to_string(),
                project_id: "p1".to_string(),
                snapshot_id: "s-missing-owner".to_string(),
                scopes: vec![RestoreScope::Body],
                inserts: Vec::new(),
            },
        )
        .expect("restore body without rebuilding owner");

        db.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM editor_stickies WHERE id = 'sticky-missing-owner'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count, 0);
            Ok(())
        })
        .expect("verify missing-owner sticky was skipped");
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

    #[test]
    fn restore_emits_one_ordered_feed_transaction_and_replays_without_duplicates() {
        let db = fixture();
        create_project_snapshot(&db, empty_snapshot("s-feed")).expect("create snapshot");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET title = 'Live title' WHERE id = 't1'",
                [],
            )?;
            conn.execute(
                "UPDATE labels SET name = 'Live label', color = '#abcdef' WHERE id = 'l1'",
                [],
            )?;
            Ok(())
        })
        .expect("mutate live state after snapshot");
        let payload = canonical_restore_payload(
            &db,
            "restore-feed",
            "s-feed",
            vec![RestoreScope::Labels, RestoreScope::Body],
        );
        let mut replay = payload.clone();
        replay.session_id = "snapshot-session-after-restart".to_string();
        apply_project_snapshot_restore(&db, payload).expect("first restore");
        apply_project_snapshot_restore(&db, replay).expect("idempotent replay");

        db.with_conn(|conn| {
            let transactions: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE project_id = 'p1' AND source_domain = 'project.snapshot.restore'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(transactions, 1);
            let origin: String = conn.query_row(
                "SELECT origin FROM narrative_change_transactions
                  WHERE project_id = 'p1' AND source_domain = 'project.snapshot.restore'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(origin, "restore");
            let mut statement = conn.prepare(
                "SELECT object_key_json, event_ordinal, mutation_kind,
                        before_digest, after_digest, changed_paths_json
                   FROM narrative_change_events
                  WHERE project_id = 'p1'
                  ORDER BY event_ordinal",
            )?;
            let events = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(events.len(), 1);
            let object_key = serde_json::from_str::<Value>(&events[0].0).expect("object key");
            assert_eq!(
                object_key,
                json!({
                    "kind": "project",
                    "projectId": "p1",
                })
            );
            assert_eq!(events[0].1, 0);
            assert_eq!(events[0].2, "update");
            assert!(events[0].3.is_some(), "before digest must be recorded");
            assert!(events[0].4.is_some(), "after digest must be recorded");
            assert_ne!(events[0].3, events[0].4);
            assert_eq!(events[0].5, "[\"/\"]");

            let structural: Value = conn
                .query_row(
                    "SELECT structural_impact_json FROM narrative_change_events
                  WHERE project_id = 'p1' LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map(|raw| serde_json::from_str(&raw))??;
            assert_eq!(structural["event"], "project-restored");
            assert_eq!(structural["requiresFullRebuild"], true);
            let foreign_events: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_events
                  WHERE object_key_json LIKE '%t2%' OR object_key_json LIKE '%l2%'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(foreign_events, 0);

            // Gate C2 Lane A/N: a real Restore mints exactly one Semantic
            // Epoch, even though `apply_project_snapshot_restore` above was
            // called twice -- the second call is the idempotent replay,
            // which short-circuits on the stored response before ever
            // reaching the epoch-rotation call.
            let epochs: Vec<(i64, String, Option<String>)> = {
                let mut statement = conn.prepare(
                    "SELECT epoch_number, reason, triggered_by_change_event_uid
                       FROM narrative_semantic_epochs
                      WHERE project_id = 'p1'
                      ORDER BY epoch_number ASC",
                )?;
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            assert_eq!(
                epochs.len(),
                1,
                "the idempotent replay must not mint a second Epoch: {epochs:?}"
            );
            assert_eq!(epochs[0].0, 0);
            assert_eq!(epochs[0].1, "restore");
            assert!(
                epochs[0].2.is_some(),
                "the Epoch must record the triggering change event uid"
            );
            Ok(())
        })
        .expect("inspect restore Feed");
    }

    #[test]
    fn net_no_op_restore_persists_only_its_retry_receipt() {
        let db = fixture();
        create_project_snapshot(&db, empty_snapshot("s-no-op"))
            .expect("create unchanged label snapshot");
        let payload =
            canonical_restore_payload(&db, "restore-no-op", "s-no-op", vec![RestoreScope::Labels]);
        let mut retry = payload.clone();
        retry.session_id = "snapshot-no-op-after-restart".to_string();
        let first = apply_project_snapshot_restore(&db, payload).expect("first no-op restore");
        let replay = apply_project_snapshot_restore(&db, retry).expect("replay no-op restore");
        assert_eq!(replay, first);
        assert!(first.no_op);
        assert_eq!(first.canonical_sequence, 0);
        assert_eq!(first.change_event_uid, None);
        assert_eq!(first.maintenance_transaction_id, None);

        db.with_conn(|conn| {
            for table in [
                "change_events",
                "narrative_change_transactions",
                "narrative_change_events",
                "narrative_semantic_epochs",
            ] {
                assert_eq!(
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    0,
                    "no-op restore created history in {table}"
                );
            }
            let receipt_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = 'project_snapshot_restore'
                    AND request_id = 'restore-no-op'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(receipt_count, 1);
            Ok(())
        })
        .expect("inspect no-op restore receipt");
    }

    #[test]
    fn label_restore_does_not_report_a_non_scene_tree_node_as_a_scene() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, sort_order)
                 VALUES ('note-1', 'p1', 'note', 'Note', 'b')",
                [],
            )?;
            conn.execute(
                "INSERT INTO tree_node_labels (node_id, label_id)
                 VALUES ('note-1', 'l1')",
                [],
            )?;
            Ok(())
        })
        .expect("seed labeled note");
        create_project_snapshot(&db, empty_snapshot("s-note-label"))
            .expect("create note label snapshot");
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM tree_node_labels
                  WHERE node_id = 'note-1' AND label_id = 'l1'",
                [],
            )?;
            Ok(())
        })
        .expect("remove live note label");

        apply_project_snapshot_restore(
            &db,
            canonical_restore_payload(
                &db,
                "restore-note-label",
                "s-note-label",
                vec![RestoreScope::Labels],
            ),
        )
        .expect("restore note label");

        db.with_conn(|conn| {
            let keys = query_strings(
                conn,
                "SELECT object_key_json
                   FROM narrative_change_events
                  WHERE project_id = 'p1'
                  ORDER BY event_ordinal",
                &[],
            )?;
            assert!(keys.iter().any(|key| {
                serde_json::from_str::<Value>(key).ok()
                    == Some(json!({ "kind": "project", "projectId": "p1" }))
            }));
            assert!(!keys.iter().any(|key| {
                serde_json::from_str::<Value>(key).ok()
                    == Some(json!({ "kind": "scene", "sceneId": "note-1" }))
            }));
            Ok(())
        })
        .expect("inspect note label Feed object key");
    }

    #[test]
    fn feed_failure_rolls_back_snapshot_restore_domain_and_canonical_event() {
        let db = fixture();
        create_project_snapshot(&db, empty_snapshot("s-feed-failure")).expect("create snapshot");
        db.with_conn(|conn| {
            conn.execute("UPDATE labels SET name = 'Live label' WHERE id = 'l1'", [])?;
            conn.execute_batch(
                "CREATE TRIGGER reject_snapshot_feed
                 BEFORE INSERT ON narrative_change_events
                 BEGIN
                   SELECT RAISE(ABORT, 'forced snapshot feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install failure trigger");
        let error = apply_project_snapshot_restore(
            &db,
            canonical_restore_payload(
                &db,
                "restore-feed-failure",
                "s-feed-failure",
                vec![RestoreScope::Labels],
            ),
        )
        .expect_err("Feed failure must abort restore");
        assert!(error.to_string().contains("forced snapshot feed failure"));
        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM labels
                      WHERE id = 'l1' AND project_id = 'p1' AND name = 'Live label'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                1
            );
            for table in [
                "change_events",
                "narrative_change_transactions",
                "narrative_change_events",
                "idempotency_requests",
            ] {
                assert_eq!(
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    0,
                    "partial restore state remains in {table}"
                );
            }
            Ok(())
        })
        .expect("inspect rollback");
    }

    #[test]
    fn restore_rejects_same_snapshot_key_with_tampered_content() {
        let db = fixture();
        create_project_snapshot(&db, empty_snapshot("s-tampered-content"))
            .expect("create snapshot");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET title = 'Live title' WHERE id = 't1'",
                [],
            )?;
            Ok(())
        })
        .expect("change live title");

        let mut payload = canonical_restore_payload(
            &db,
            "restore-tampered-content",
            "s-tampered-content",
            vec![RestoreScope::Body],
        );
        payload
            .inserts
            .iter_mut()
            .find(|insert| insert.table == SnapshotRestoreTable::TreeNodes)
            .expect("canonical tree row")
            .row
            .insert(
                "title".to_string(),
                Value::String("Injected title".to_string()),
            );
        let error = apply_project_snapshot_restore(&db, payload)
            .expect_err("same-key content injection must be rejected");
        assert!(error
            .to_string()
            .contains("does not match the owned snapshot"));

        db.with_conn(|conn| {
            let title: String =
                conn.query_row("SELECT title FROM tree_nodes WHERE id = 't1'", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(
                title, "Live title",
                "failed validation must not wipe live data"
            );
            Ok(())
        })
        .expect("verify rollback");
    }

    #[test]
    fn restore_rejects_omitted_snapshot_rows_before_wiping_live_data() {
        let db = fixture();
        create_project_snapshot(&db, empty_snapshot("s-omitted-row")).expect("create snapshot");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET title = 'Live title' WHERE id = 't1'",
                [],
            )?;
            Ok(())
        })
        .expect("change live title");

        let error = apply_project_snapshot_restore(
            &db,
            ApplyProjectSnapshotRestorePayload {
                request_id: "restore-omitted-row".to_string(),
                session_id: "test-session".to_string(),
                project_id: "p1".to_string(),
                snapshot_id: "s-omitted-row".to_string(),
                scopes: vec![RestoreScope::Body],
                inserts: Vec::new(),
            },
        )
        .expect_err("incomplete restore plan must be rejected");
        assert!(error.to_string().contains("omits owned snapshot rows"));

        db.with_conn(|conn| {
            let title: String =
                conn.query_row("SELECT title FROM tree_nodes WHERE id = 't1'", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(
                title, "Live title",
                "failed validation must not wipe live data"
            );
            Ok(())
        })
        .expect("verify rollback");
    }
}
