/**
 * Project snapshot scope definitions.
 *
 * A "scope" is a user-facing group of tables that can be independently
 * included or excluded when restoring a project snapshot. Snapshot creation
 * always captures every scope (the snapshot is a complete record); selection
 * only applies at restore time.
 *
 * Core entities (tree_nodes / codex_entries / snippets) get dedicated
 * strict tables (`project_snapshot_tree_nodes` etc.). Everything else lives
 * in `project_snapshot_aux(scope, payload_json)` as one row per aux scope.
 * The payload is `{ rows: RawRow[] }` where each row is a verbatim copy of
 * the source table row (column → SQLite primitive value). Restore replays
 * INSERT statements built from `AUX_COLUMNS[scope]`.
 *
 * Keeping payloads as raw rows (string/number/null) avoids drift between
 * drizzle's TS modelled types (Date, boolean) and the underlying storage
 * (INTEGER/TEXT). The snapshot path bypasses drizzle for both reads and
 * writes inside the aux scopes; only the dedicated tables go through
 * drizzle.
 */

export const RESTORE_SCOPES = [
  "body",
  "codex",
  "snippet",
  "map",
  "foreshadow",
  "labels",
  "lint",
] as const;

export type RestoreScope = (typeof RESTORE_SCOPES)[number];

export const RESTORE_SCOPE_LABELS_JA: Record<RestoreScope, string> = {
  body: "本文・章立て",
  codex: "コーデックス",
  snippet: "スニペット",
  map: "マップ・付箋",
  foreshadow: "伏線",
  labels: "ラベル",
  lint: "校閲設定",
};

/**
 * Scope dependencies. If a scope's restore relies on another scope's data
 * to satisfy FK constraints, list the dependency here. Restore reports
 * skipped rows when a dependency is excluded.
 */
export const RESTORE_SCOPE_DEPENDENCIES: Record<RestoreScope, RestoreScope[]> =
  {
    body: [],
    codex: [],
    snippet: [],
    map: [],
    foreshadow: [],
    labels: ["body"], // tree_node_labels.node_id is NOT NULL
    lint: ["body"], // lint_ignored_diagnostics.scene_id is NOT NULL
  };

// ---- aux scopes -----------------------------------------------------------

export const AUX_SCOPES = [
  // owned by `codex`
  "codex_types",
  "codex_tags",
  "codex_entry_tags",
  "codex_detail_definitions",
  "codex_detail_semantic_bindings",
  "codex_detail_values",
  "codex_entry_phases",
  "codex_phase_detail_overrides",
  "codex_quick_pins",
  "codex_dismissed_relations",
  "codex_relations",
  // owned by `snippet`
  "snippet_entry_tags",
  // owned by `labels`
  "labels",
  "tree_node_labels",
  // owned by `foreshadow`
  "foreshadows",
  "foreshadow_setups",
  "foreshadow_codex_links",
  // owned by `map`
  "map_boards",
  "map_ai_branches",
  "map_stickies",
  "editor_stickies",
  "map_node_positions",
  "map_edges",
  "map_frames",
  // owned by `lint`
  "lint_ignored_diagnostics",
  "lint_term_dictionary",
  // owned by `body`
  "authorship_spans",
  "generation_logs",
  "post_effect_annotations",
  "post_effect_annotation_relations",
  "scene_codex_pins",
  "scene_codex_mentions",
  "scene_beat_pov_cache",
  // owned by `body` (plot threads are scene-anchored: markers/branches FK
  // tree_nodes ON DELETE CASCADE, so a body wipe cascade-deletes them; they
  // must be re-inserted on body restore or they are lost permanently).
  "plot_threads",
  "plot_thread_scene_links",
  "plot_thread_branches",
  // owned by `body` (作中年表 / Chronicle). events FK projects; scene_events FK
  // tree_nodes ON DELETE CASCADE (so a body wipe cascade-deletes scene links)
  // and event_participants FK codex_entries ON DELETE CASCADE (so a codex wipe
  // cascade-deletes participants). events/event_relations/project_calendar FK
  // projects (NOT tree_nodes), so the tree_nodes wipe leaves them as orphans —
  // they need an explicit DELETE + re-insert on body restore or they are lost /
  // never reverted. events MUST precede its children so restore re-inserts the
  // parent rows first.
  "events",
  "event_relations",
  "scene_events",
  "event_participants",
  "project_calendar",
] as const;

export type AuxScope = (typeof AUX_SCOPES)[number];

export const AUX_SCOPE_OWNER: Record<AuxScope, RestoreScope> = {
  codex_types: "codex",
  codex_tags: "codex",
  codex_entry_tags: "codex",
  codex_detail_definitions: "codex",
  codex_detail_semantic_bindings: "codex",
  codex_detail_values: "codex",
  codex_entry_phases: "codex",
  codex_phase_detail_overrides: "codex",
  codex_quick_pins: "codex",
  codex_dismissed_relations: "codex",
  codex_relations: "codex",
  snippet_entry_tags: "snippet",
  labels: "labels",
  tree_node_labels: "labels",
  foreshadows: "foreshadow",
  foreshadow_setups: "foreshadow",
  foreshadow_codex_links: "foreshadow",
  map_boards: "map",
  map_ai_branches: "map",
  map_stickies: "map",
  editor_stickies: "map",
  map_node_positions: "map",
  map_edges: "map",
  map_frames: "map",
  lint_ignored_diagnostics: "lint",
  lint_term_dictionary: "lint",
  authorship_spans: "body",
  generation_logs: "body",
  post_effect_annotations: "body",
  post_effect_annotation_relations: "body",
  scene_codex_pins: "body",
  scene_codex_mentions: "body",
  scene_beat_pov_cache: "body",
  plot_threads: "body",
  plot_thread_scene_links: "body",
  plot_thread_branches: "body",
  events: "body",
  event_relations: "body",
  scene_events: "body",
  event_participants: "body",
  project_calendar: "body",
};

/**
 * SQL identifier for the source/target table of each aux scope. Aux scope
 * name happens to equal table name in every case, but keep this map so a
 * future rename does not silently break.
 */
export const AUX_TABLE: Record<AuxScope, string> = {
  codex_types: "codex_types",
  codex_tags: "codex_tags",
  codex_entry_tags: "codex_entry_tags",
  codex_detail_definitions: "codex_detail_definitions",
  codex_detail_semantic_bindings: "codex_detail_semantic_bindings",
  codex_detail_values: "codex_detail_values",
  codex_entry_phases: "codex_entry_phases",
  codex_phase_detail_overrides: "codex_phase_detail_overrides",
  codex_quick_pins: "codex_quick_pins",
  codex_dismissed_relations: "codex_dismissed_relations",
  codex_relations: "codex_relations",
  snippet_entry_tags: "snippet_entry_tags",
  labels: "labels",
  tree_node_labels: "tree_node_labels",
  foreshadows: "foreshadows",
  foreshadow_setups: "foreshadow_setups",
  foreshadow_codex_links: "foreshadow_codex_links",
  map_boards: "map_boards",
  map_ai_branches: "map_ai_branches",
  map_stickies: "map_stickies",
  editor_stickies: "editor_stickies",
  map_node_positions: "map_node_positions",
  map_edges: "map_edges",
  map_frames: "map_frames",
  lint_ignored_diagnostics: "lint_ignored_diagnostics",
  lint_term_dictionary: "lint_term_dictionary",
  authorship_spans: "authorship_spans",
  generation_logs: "generation_logs",
  post_effect_annotations: "post_effect_annotations",
  post_effect_annotation_relations: "post_effect_annotation_relations",
  scene_codex_pins: "scene_codex_pins",
  scene_codex_mentions: "scene_codex_mentions",
  scene_beat_pov_cache: "scene_beat_pov_cache",
  plot_threads: "plot_threads",
  plot_thread_scene_links: "plot_thread_scene_links",
  plot_thread_branches: "plot_thread_branches",
  events: "events",
  event_relations: "event_relations",
  scene_events: "scene_events",
  event_participants: "event_participants",
  project_calendar: "project_calendar",
};

/**
 * Per-aux-scope WHERE predicate that scopes a capture `SELECT *` to the
 * **current project**. `binds` is how many times the current project id must
 * be bound (the predicate uses that many `?`).
 *
 * Invariant: for each table the captured set must equal the set restore
 * *wipes* for the current project. Restore wipes via the project_id'd
 * top-level DELETEs + CASCADE (`DELETE FROM map_boards WHERE project_id=?`
 * clears all map_* children; `DELETE FROM codex_entries WHERE project_id=?`
 * clears codex children; `DELETE FROM tree_nodes WHERE project_id=?` clears
 * scene-anchored children). So each predicate mirrors the *same parent set*
 * CASCADE clears — capture more than that and restore's re-INSERT collides
 * with rows that were never wiped.
 */
export const AUX_PROJECT_FILTER: Record<
  AuxScope,
  { where: string; binds: number }
> = {
  // direct project_id
  codex_types: { where: "project_id = ?", binds: 1 },
  codex_tags: { where: "project_id = ?", binds: 1 },
  codex_detail_definitions: { where: "project_id = ?", binds: 1 },
  codex_detail_semantic_bindings: { where: "project_id = ?", binds: 1 },
  codex_relations: { where: "project_id = ?", binds: 1 },
  generation_logs: { where: "project_id = ?", binds: 1 },
  map_boards: { where: "project_id = ?", binds: 1 },
  foreshadows: { where: "project_id = ?", binds: 1 },
  labels: { where: "project_id = ?", binds: 1 },
  // via codex_entries (entry_id / codex_entry_id → codex_entries.project_id)
  codex_dismissed_relations: {
    where: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)",
    binds: 1,
  },
  codex_quick_pins: {
    where: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)",
    binds: 1,
  },
  codex_entry_tags: {
    where: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)",
    binds: 1,
  },
  codex_detail_values: {
    where: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)",
    binds: 1,
  },
  codex_entry_phases: {
    where: "entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)",
    binds: 1,
  },
  // via codex_entry_phases → codex_entries
  codex_phase_detail_overrides: {
    where:
      "phase_id IN (SELECT id FROM codex_entry_phases WHERE entry_id IN " +
      "(SELECT id FROM codex_entries WHERE project_id = ?))",
    binds: 1,
  },
  // via snippets
  snippet_entry_tags: {
    where: "snippet_id IN (SELECT id FROM snippets WHERE project_id = ?)",
    binds: 1,
  },
  // via tree_nodes (scene_id / node_id → tree_nodes.project_id)
  tree_node_labels: {
    where: "node_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)",
    binds: 1,
  },
  scene_codex_pins: {
    where: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)",
    binds: 1,
  },
  scene_codex_mentions: {
    where: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)",
    binds: 1,
  },
  scene_beat_pov_cache: {
    where: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)",
    binds: 1,
  },
  lint_ignored_diagnostics: {
    where: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)",
    binds: 1,
  },
  // post_effect_annotations.scene_id is the only wipe path (CASCADE from
  // tree_nodes). It also carries project_id, but a NULL-scene row (none in
  // MVP — scene_range only) would be captured-not-wiped → collision; scope by
  // scene to mirror the wipe set exactly.
  post_effect_annotations: {
    where: "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)",
    binds: 1,
  },
  post_effect_annotation_relations: {
    where:
      "annotation_a_id IN (SELECT id FROM post_effect_annotations WHERE " +
      "scene_id IN (SELECT id FROM tree_nodes WHERE project_id = ?))",
    binds: 1,
  },
  // via foreshadows
  foreshadow_setups: {
    where: "foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?)",
    binds: 1,
  },
  foreshadow_codex_links: {
    where: "foreshadow_id IN (SELECT id FROM foreshadows WHERE project_id = ?)",
    binds: 1,
  },
  // via map_boards
  map_ai_branches: {
    where: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)",
    binds: 1,
  },
  map_stickies: {
    where: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)",
    binds: 1,
  },
  editor_stickies: { where: "project_id = ?", binds: 1 },
  map_node_positions: {
    where: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)",
    binds: 1,
  },
  map_edges: {
    where: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)",
    binds: 1,
  },
  map_frames: {
    where: "board_id IN (SELECT id FROM map_boards WHERE project_id = ?)",
    binds: 1,
  },
  // exactly one of 5 anchors is non-null (SQL CHECK); a row belongs to the
  // project when its non-null anchor does.
  authorship_spans: {
    where:
      "(node_id IN (SELECT id FROM tree_nodes WHERE project_id = ?) " +
      "OR codex_entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?) " +
      "OR snippet_id IN (SELECT id FROM snippets WHERE project_id = ?) " +
      "OR detail_value_id IN (SELECT id FROM codex_detail_values WHERE entry_id IN " +
      "(SELECT id FROM codex_entries WHERE project_id = ?)) " +
      "OR sticky_id IN (SELECT id FROM map_stickies WHERE board_id IN " +
      "(SELECT id FROM map_boards WHERE project_id = ?)))",
    binds: 5,
  },
  lint_term_dictionary: { where: "project_id = ?", binds: 1 },
  // Plot threads: direct project_id; wiped by an explicit
  // `DELETE FROM plot_threads WHERE project_id=?` in the body restore (threads
  // FK projects, NOT tree_nodes, so the body tree_nodes wipe does NOT clear
  // them — the explicit DELETE both clears them and cascades links/branches).
  plot_threads: { where: "project_id = ?", binds: 1 },
  // Branches carry denormalized project_id; cascade-wiped via plot_threads
  // (from/to) and tree_nodes (at_node). project_id mirrors that set exactly.
  plot_thread_branches: { where: "project_id = ?", binds: 1 },
  // Scene-links have NO project_id; scope via their thread. Every in-project
  // link's thread is in-project (XPROJ guard), so this equals the cascade
  // wipe set (plot_threads CASCADE + tree_nodes CASCADE).
  plot_thread_scene_links: {
    where: "thread_id IN (SELECT id FROM plot_threads WHERE project_id = ?)",
    binds: 1,
  },
  // Chronicle (作中年表). events/event_relations/project_calendar carry a
  // direct project_id and are wiped by explicit DELETEs in the body restore
  // (events cascades scene_events/event_participants/event_relations; calendar
  // is wiped on its own). scene_events/event_participants have NO project_id;
  // scope them via their event so the captured set equals the cascade wipe set.
  events: { where: "project_id = ?", binds: 1 },
  event_relations: { where: "project_id = ?", binds: 1 },
  project_calendar: { where: "project_id = ?", binds: 1 },
  scene_events: {
    where: "event_id IN (SELECT id FROM events WHERE project_id = ?)",
    binds: 1,
  },
  event_participants: {
    where: "event_id IN (SELECT id FROM events WHERE project_id = ?)",
    binds: 1,
  },
};

/**
 * For aux scopes whose owning scope is **not** `body` but whose rows
 * reference body entities (tree_nodes), how should restore handle a row
 * when body is excluded?
 *
 * - `"skip"` — drop the row entirely (NOT NULL FK or row makes no sense
 *   without the body)
 * - `"null"` — restore the row but NULL the listed column(s)
 *
 * Maps scope → { skip: true } | { nullColumns: string[] }. Scopes not
 * listed have no body-dependent columns or are themselves body-owned.
 */
export const AUX_BODY_DEPENDENCY: Partial<
  Record<AuxScope, { skip: true } | { nullColumns: string[] }>
> = {
  tree_node_labels: { skip: true },
  lint_ignored_diagnostics: { skip: true },
  foreshadow_setups: { skip: true },
  foreshadows: { nullColumns: ["payoff_scene_id"] },
  map_node_positions: { nullColumns: ["tree_node_id"] },
};

/**
 * Likewise for codex-dependent columns on rows whose owner scope is not
 * `codex`. Used when codex scope is excluded.
 */
export const AUX_CODEX_DEPENDENCY: Partial<
  Record<AuxScope, { skip: true } | { nullColumns: string[] }>
> = {
  foreshadow_codex_links: { skip: true },
  map_node_positions: { nullColumns: ["codex_entry_id"] },
  // events.primary_codex_id / location_codex_id are nullable FKs (ON DELETE SET
  // NULL); when codex is excluded and the referenced entry is gone, keep the
  // event but NULL its codex refs.
  events: { nullColumns: ["primary_codex_id", "location_codex_id"] },
  // event_participants.codex_entry_id is NOT NULL — it cannot be NULLed, so a
  // participant whose codex is absent is dropped entirely.
  event_participants: { skip: true },
};

// ---- payload wire format --------------------------------------------------

/** A raw row as serialised by SQLite. Values are JSON-safe primitives. */
export type RawRow = Record<string, string | number | null>;

export interface AuxPayload {
  rows: RawRow[];
}

export function serializeAuxPayload(payload: AuxPayload): string {
  return JSON.stringify(payload);
}

export function parseAuxPayload(json: string): AuxPayload {
  const parsed = JSON.parse(json) as Partial<AuxPayload>;
  return { rows: Array.isArray(parsed?.rows) ? parsed.rows : [] };
}

// ---- restore options ------------------------------------------------------

export const ALL_RESTORE_SCOPES: ReadonlySet<RestoreScope> = new Set(
  RESTORE_SCOPES,
);

export function fullRestoreScopeSet(): Set<RestoreScope> {
  return new Set(RESTORE_SCOPES);
}

/** Diagnostic info returned by restore: row counts skipped or NULL-patched. */
export interface SkipReport {
  treeNodeLabels: number;
  lintIgnoredDiagnostics: number;
  foreshadowSetups: number;
  foreshadowCodexLinks: number;
  postEffectAnnotations: number;
  postEffectAnnotationRelations: number;
  authorshipSpans: number;
  sceneCodexPins: number;
  sceneCodexMentions: number;
  sceneBeatPovCache: number;
  eventParticipants: number;
  foreshadowPayoffSceneCleared: number;
  mapNodePositionsLinkCleared: number;
  eventCodexRefCleared: number;
  eventRevealSceneCleared: number;
  editorStickies: number;
}

export function emptySkipReport(): SkipReport {
  return {
    treeNodeLabels: 0,
    lintIgnoredDiagnostics: 0,
    foreshadowSetups: 0,
    foreshadowCodexLinks: 0,
    postEffectAnnotations: 0,
    postEffectAnnotationRelations: 0,
    authorshipSpans: 0,
    sceneCodexPins: 0,
    sceneCodexMentions: 0,
    sceneBeatPovCache: 0,
    eventParticipants: 0,
    foreshadowPayoffSceneCleared: 0,
    mapNodePositionsLinkCleared: 0,
    eventCodexRefCleared: 0,
    eventRevealSceneCleared: 0,
    editorStickies: 0,
  };
}

export function skipReportIsEmpty(r: SkipReport): boolean {
  return (
    r.treeNodeLabels +
      r.lintIgnoredDiagnostics +
      r.foreshadowSetups +
      r.foreshadowCodexLinks +
      r.postEffectAnnotations +
      r.postEffectAnnotationRelations +
      r.authorshipSpans +
      r.sceneCodexPins +
      r.sceneCodexMentions +
      r.sceneBeatPovCache +
      r.eventParticipants +
      r.foreshadowPayoffSceneCleared +
      r.mapNodePositionsLinkCleared +
      r.eventCodexRefCleared +
      r.eventRevealSceneCleared +
      r.editorStickies ===
    0
  );
}
