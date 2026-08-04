import { invoke } from "@/lib/tauri";

import type { RawRow, RestoreScope } from "./projectSnapshotScopes";

export const SNAPSHOT_RESTORE_TABLES = [
  "codex_types",
  "codex_entries",
  "codex_tags",
  "codex_detail_definitions",
  "codex_entry_tags",
  "codex_detail_values",
  "codex_entry_phases",
  "codex_phase_detail_overrides",
  "codex_quick_pins",
  "codex_dismissed_relations",
  "codex_relations",
  "tree_nodes",
  "authorship_spans",
  "generation_logs",
  "post_effect_annotations",
  "post_effect_annotation_relations",
  "scene_codex_pins",
  "scene_codex_mentions",
  "scene_beat_pov_cache",
  "plot_threads",
  "plot_thread_scene_links",
  "plot_thread_branches",
  "events",
  "scene_events",
  "event_participants",
  "event_relations",
  "project_calendar",
  "snippets",
  "snippet_entry_tags",
  "labels",
  "tree_node_labels",
  "foreshadows",
  "foreshadow_setups",
  "foreshadow_codex_links",
  "map_boards",
  "map_ai_branches",
  "map_stickies",
  "editor_stickies",
  "map_frames",
  "map_node_positions",
  "map_edges",
  "lint_term_dictionary",
  "lint_ignored_diagnostics",
] as const;

export type SnapshotRestoreTable = (typeof SNAPSHOT_RESTORE_TABLES)[number];

export interface ProjectSnapshotCreatePayload {
  projectId: string;
  snapshotId: string;
  name: string;
  description: string | null;
  createdAt: string;
  treeRows: RawRow[];
  codexRows: RawRow[];
  snippetRows: RawRow[];
  versionIds: string[];
}

export interface ProjectSnapshotRestoreContext {
  structural: boolean;
  liveTables: string[];
  treeRows: RawRow[];
  codexRows: RawRow[];
  snippetRows: RawRow[];
  auxRows: Array<{ scope: string; payloadJson: string }>;
  contentRows: Array<{ id: string; content: string }>;
  liveCodexIds: string[];
  liveCodexPhaseIds: string[];
  liveTreeNodeIds: string[];
  liveSnippetIds: string[];
  liveEventIds: string[];
  liveCodexTagIds: string[];
}

export interface SnapshotInsertPlan {
  table: SnapshotRestoreTable;
  row: RawRow;
  mode: "insert" | "replace";
}

export async function createNativeProjectSnapshot(
  payload: ProjectSnapshotCreatePayload,
): Promise<void> {
  await invoke("project_snapshot_create", { payload });
}

export async function loadNativeProjectSnapshotRestoreContext(
  projectId: string,
  snapshotId: string,
  scopes: ReadonlySet<RestoreScope>,
): Promise<ProjectSnapshotRestoreContext> {
  return invoke<ProjectSnapshotRestoreContext>(
    "project_snapshot_restore_context",
    {
      projectId,
      snapshotId,
      scopes: [...scopes],
    },
  );
}

export async function applyNativeProjectSnapshotRestore(payload: {
  projectId: string;
  snapshotId: string;
  scopes: RestoreScope[];
  inserts: SnapshotInsertPlan[];
}): Promise<void> {
  await invoke("project_snapshot_apply_restore", { payload });
}
