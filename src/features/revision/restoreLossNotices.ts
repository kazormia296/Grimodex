import type { RestoreLossNotice } from "./projectSnapshotNative";

export const KNOWN_RESTORE_LOSS_KINDS = [
  "event_participants",
  "event_primary_or_location",
  "event_reveal_scene",
  "event_scene_links",
  "scene_pov_or_location",
  "scene_codex_links",
  "foreshadow_codex_links",
  "snippet_tags",
  "snippet_scene_link",
  "foreshadow_scene_links",
  "scene_labels",
  "phase_anchor",
  "lint_ignores",
  "map_placements",
  "editor_stickies",
  "chat_pins_or_anchors",
  "trash_items",
  "ai_scene_proposals",
  "analysis_records",
  "map_edges",
  "map_source_links",
  "snippet_source_message",
  "analysis_run_links",
  "analysis_annotations",
  "scene_scope_bindings_reset",
] as const;

const RESET_KIND = "scene_scope_bindings_reset";
const KNOWN_KINDS = new Set<string>(KNOWN_RESTORE_LOSS_KINDS);

export interface RestoreLossDescription {
  items: Array<{ kind: string; count: number }>;
  otherCount: number;
  resetCount: number;
  lostCount: number;
  total: number;
}

export function describeRestoreLoss(
  notices: readonly RestoreLossNotice[] | undefined,
): RestoreLossDescription {
  const counts = new Map<string, number>();
  let otherCount = 0;
  let resetCount = 0;

  for (const { kind, count } of notices ?? []) {
    if (!Number.isFinite(count) || !Number.isInteger(count) || count <= 0) {
      continue;
    }
    if (kind === RESET_KIND) resetCount += count;
    else if (KNOWN_KINDS.has(kind))
      counts.set(kind, (counts.get(kind) ?? 0) + count);
    else otherCount += count;
  }

  const items = KNOWN_RESTORE_LOSS_KINDS.filter((kind) => kind !== RESET_KIND)
    .filter((kind) => counts.has(kind))
    .map((kind) => ({ kind, count: counts.get(kind)! }));
  const lostCount =
    items.reduce((sum, item) => sum + item.count, 0) + otherCount;
  return {
    items,
    otherCount,
    resetCount,
    lostCount,
    total: lostCount + resetCount,
  };
}
