import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { MapNodePositionRecord } from "../types";
import type { LayoutInput, LayoutOutput } from "./types";
import type { ForceLayoutEngine } from "./forceEngine";

export type AutoArrangeType = "reading-order" | "force-directed";

export interface AutoArrangeOptions {
  type: AutoArrangeType;
  /** All tree nodes including folders (needed for reading-order DFS). */
  allTreeNodes: TreeNodeData[];
  /** Visible scene nodes only. */
  scenes: TreeNodeData[];
  positions: MapNodePositionRecord[];
}

const COLS = 5;
const OFFSET = 40;
const CELL = { w: 280, h: 100 };

function gridPlace(
  scenes: TreeNodeData[],
  pinnedIds: Set<string>,
): LayoutOutput {
  const result: LayoutOutput = new Map();
  let col = 0;
  let row = 0;
  for (const scene of scenes) {
    if (pinnedIds.has(scene.id)) continue;
    result.set(`scene:${scene.id}`, {
      x: col * CELL.w + OFFSET,
      y: row * CELL.h + OFFSET,
    });
    col++;
    if (col >= COLS) {
      col = 0;
      row++;
    }
  }
  return result;
}

/** Synchronous auto-arrange: reading-order grid. */
export function autoArrange(options: AutoArrangeOptions): LayoutOutput {
  const { allTreeNodes, scenes, positions } = options;

  const pinnedIds = new Set(
    positions
      .filter((p) => p.pinned === 1 && p.treeNodeId)
      .map((p) => p.treeNodeId!),
  );

  const order = computeGlobalSceneOrder(allTreeNodes);
  const sorted = [...scenes].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );

  return gridPlace(sorted, pinnedIds);
}

/** Async auto-arrange for force-directed layout. */
export async function autoArrangeForceDirected(
  input: LayoutInput,
  engine: ForceLayoutEngine,
  pinnedIds: Set<string>,
  onProgress?: (alpha: number) => void,
): Promise<LayoutOutput> {
  const { layoutForAsync } = await import("./index");
  const positions = await layoutForAsync("theme", input, engine, onProgress);

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
