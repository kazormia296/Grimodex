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
  "map_node_positions",
  "map_edges",
  "map_frames",
  // owned by `lint`
  "lint_ignored_diagnostics",
  "lint_term_dictionary",
  // owned by `body`
  "authorship_spans",
  "post_effect_annotations",
  "post_effect_annotation_relations",
  "scene_codex_pins",
  "scene_codex_mentions",
  "scene_beat_pov_cache",
] as const;

export type AuxScope = (typeof AUX_SCOPES)[number];

export const AUX_SCOPE_OWNER: Record<AuxScope, RestoreScope> = {
  codex_types: "codex",
  codex_tags: "codex",
  codex_entry_tags: "codex",
  codex_detail_definitions: "codex",
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
  map_node_positions: "map",
  map_edges: "map",
  map_frames: "map",
  lint_ignored_diagnostics: "lint",
  lint_term_dictionary: "lint",
  authorship_spans: "body",
  post_effect_annotations: "body",
  post_effect_annotation_relations: "body",
  scene_codex_pins: "body",
  scene_codex_mentions: "body",
  scene_beat_pov_cache: "body",
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
  map_node_positions: "map_node_positions",
  map_edges: "map_edges",
  map_frames: "map_frames",
  lint_ignored_diagnostics: "lint_ignored_diagnostics",
  lint_term_dictionary: "lint_term_dictionary",
  authorship_spans: "authorship_spans",
  post_effect_annotations: "post_effect_annotations",
  post_effect_annotation_relations: "post_effect_annotation_relations",
  scene_codex_pins: "scene_codex_pins",
  scene_codex_mentions: "scene_codex_mentions",
  scene_beat_pov_cache: "scene_beat_pov_cache",
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
  foreshadowPayoffSceneCleared: number;
  mapNodePositionsLinkCleared: number;
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
    foreshadowPayoffSceneCleared: 0,
    mapNodePositionsLinkCleared: 0,
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
      r.foreshadowPayoffSceneCleared +
      r.mapNodePositionsLinkCleared ===
    0
  );
}
