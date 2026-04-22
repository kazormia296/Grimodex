import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { MapNodePositionRecord } from "../types";
import type { LayoutOutput } from "./types";

export type AutoArrangeType = "reading-order" | "story-time";

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

export function autoArrange(options: AutoArrangeOptions): LayoutOutput {
  const { type, allTreeNodes, scenes, positions, variant } = options;
  const cell = CELL_SIZE[variant] ?? CELL_SIZE.compact;

  const pinnedIds = new Set(
    positions
      .filter((p) => p.pinned === 1 && p.treeNodeId)
      .map((p) => p.treeNodeId!),
  );

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

  const result: LayoutOutput = new Map();
  let col = 0;
  let row = 0;

  for (const scene of sorted) {
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
