import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { MapNodePositionRecord } from "../types";
import type { LayoutInput, LayoutOutput } from "./types";
import type { ForceLayoutEngine } from "./forceEngine";

export type AutoArrangeType =
  | "reading-order"
  | "story-time"
  | "pov-order"
  | "force-directed";

export interface AutoArrangeOptions {
  type: AutoArrangeType;
  /** All tree nodes including folders (needed for reading-order DFS). */
  allTreeNodes: TreeNodeData[];
  /** Visible scene nodes only. */
  scenes: TreeNodeData[];
  positions: MapNodePositionRecord[];
  variant: "compact" | "card" | "image";
}

const COLS = 5;
const OFFSET = 40;

const CELL_SIZE: Record<
  "compact" | "card" | "image",
  { w: number; h: number }
> = {
  compact: { w: 280, h: 220 },
  card: { w: 320, h: 240 },
  image: { w: 320, h: 240 },
};

function gridPlace(
  scenes: TreeNodeData[],
  pinnedIds: Set<string>,
  cell: { w: number; h: number },
  startRow = 0,
  startCol = 0,
): LayoutOutput {
  const result: LayoutOutput = new Map();
  let col = startCol;
  let row = startRow;
  for (const scene of scenes) {
    if (pinnedIds.has(scene.id)) continue;
    result.set(`scene:${scene.id}`, {
      x: col * cell.w + OFFSET,
      y: row * cell.h + OFFSET,
    });
    col++;
    if (col >= COLS) {
      col = 0;
      row++;
    }
  }
  return result;
}

/** Synchronous auto-arrange: reading-order, story-time, pov-order. */
export function autoArrange(options: AutoArrangeOptions): LayoutOutput {
  const { type, allTreeNodes, scenes, positions, variant } = options;
  const cell = CELL_SIZE[variant] ?? CELL_SIZE.compact;

  const pinnedIds = new Set(
    positions
      .filter((p) => p.pinned === 1 && p.treeNodeId)
      .map((p) => p.treeNodeId!),
  );

  if (type === "pov-order") {
    // Group by POV, each group occupies consecutive rows
    const povOrder: (string | null)[] = [];
    const seen = new Set<string | null>();
    for (const scene of scenes) {
      const key = scene.povCharacterId ?? null;
      if (!seen.has(key)) {
        seen.add(key);
        povOrder.push(key);
      }
    }
    const sorted = [
      ...povOrder.filter((p) => p !== null),
      ...(povOrder.includes(null) ? [null] : []),
    ];

    const result: LayoutOutput = new Map();
    let currentRow = 0;

    const readingOrder = computeGlobalSceneOrder(allTreeNodes);

    for (const povId of sorted) {
      const group = scenes
        .filter((s) => (s.povCharacterId ?? null) === povId)
        .sort(
          (a, b) =>
            (readingOrder.get(a.id) ?? 0) - (readingOrder.get(b.id) ?? 0),
        );
      const groupResult = gridPlace(group, pinnedIds, cell, currentRow);
      for (const [k, v] of groupResult) result.set(k, v);
      const nonPinned = group.filter((s) => !pinnedIds.has(s.id));
      const rowsUsed = Math.ceil(nonPinned.length / COLS);
      currentRow += Math.max(rowsUsed, 1);
    }
    return result;
  }

  let sorted: TreeNodeData[];
  if (type === "reading-order") {
    const order = computeGlobalSceneOrder(allTreeNodes);
    sorted = [...scenes].sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
  } else {
    // story-time: null goes last
    sorted = [...scenes].sort((a, b) => {
      if (a.storyTimeOrder == null && b.storyTimeOrder == null) return 0;
      if (a.storyTimeOrder == null) return 1;
      if (b.storyTimeOrder == null) return -1;
      return cmpKeys(a.storyTimeOrder, b.storyTimeOrder);
    });
  }

  return gridPlace(sorted, pinnedIds, cell);
}

/** Async auto-arrange for force-directed layout.
 *  Returns LayoutOutput of scene + codex keys. */
export async function autoArrangeForceDirected(
  input: LayoutInput,
  engine: ForceLayoutEngine,
  pinnedIds: Set<string>,
  onProgress?: (alpha: number) => void,
): Promise<LayoutOutput> {
  const { layoutForAsync } = await import("./index");
  const positions = await layoutForAsync("theme", input, engine, onProgress);

  // Remove pinned nodes from the result so they aren't moved
  for (const pos of input.positions) {
    if (pos.pinned !== 1) continue;
    const key = pos.treeNodeId
      ? `scene:${pos.treeNodeId}`
      : pos.codexEntryId
        ? `codex:${pos.codexEntryId}`
        : null;
    if (key) positions.delete(key);
  }
  for (const id of pinnedIds) {
    positions.delete(`scene:${id}`);
  }

  return positions;
}
