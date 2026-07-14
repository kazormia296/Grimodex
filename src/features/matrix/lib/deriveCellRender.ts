import type { CellInfo, CellSource, MentionRole } from "./deriveCells";
import type { DisplayMode } from "@/features/matrix/matrixStore";
import type { ShowMode } from "./deriveColumns";

export type DisplayCell =
  | { kind: "dot"; source: CellSource }
  | { kind: "count"; count: number; source: CellSource }
  | { kind: "heatmap"; intensity: 1 | 2 | 3; source: CellSource }
  | { kind: "pov"; isPov: true; isBeatOverride?: boolean }
  | {
      kind: "role-aware";
      role: MentionRole;
      isPov: boolean;
      source: CellSource;
    }
  | null;

/** Map topSource to a heatmap intensity level */
const HEATMAP_INTENSITY: Record<CellSource, 1 | 2 | 3> = {
  relation: 1,
  beat: 2,
  body: 3,
  semantic: 3,
};

/**
 * Derive a DisplayCell from raw cell data and rendering context.
 *
 * @param cellInfo  - aggregated mention data for this (scene, codex) pair, or undefined if empty
 * @param colEntryId - the Codex entry ID for this column
 * @param povCharacterId - the scene's pov_character_id (from tree_nodes)
 * @param locationId - the scene's location_id (from tree_nodes)
 * @param displayMode - current Display mode setting
 * @param showMode - current Show mode (needed for pov/location short-circuit)
 */
export function deriveCellDisplay(
  cellInfo: CellInfo | undefined,
  colEntryId: string,
  povCharacterId: string | null | undefined,
  locationId: string | null | undefined,
  displayMode: DisplayMode,
  showMode?: ShowMode,
  isBeatPovOverride?: boolean,
): DisplayCell {
  // POV/Location show modes: cell is determined by direct tree_nodes reference,
  // not by scene_codex_mentions.
  if (showMode === "pov") {
    if (povCharacterId && povCharacterId === colEntryId) {
      return { kind: "pov", isPov: true };
    }
    if (isBeatPovOverride) {
      return { kind: "pov", isPov: true, isBeatOverride: true };
    }
    return null;
  }
  if (showMode === "location") {
    if (locationId && locationId === colEntryId) {
      return { kind: "pov", isPov: true };
    }
    return null;
  }

  if (!cellInfo) return null;

  const { topSource, sources, role } = cellInfo;

  switch (displayMode) {
    case "dot":
      return { kind: "dot", source: topSource };

    case "count":
      return { kind: "count", count: sources.size, source: topSource };

    case "heatmap":
      return {
        kind: "heatmap",
        intensity: HEATMAP_INTENSITY[topSource],
        source: topSource,
      };

    case "role-aware": {
      const isPov = !!(povCharacterId && povCharacterId === colEntryId);
      return { kind: "role-aware", role, isPov, source: topSource };
    }

    default:
      return { kind: "dot", source: topSource };
  }
}
