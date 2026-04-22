import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";
import type { MapNodePositionRecord } from "../types";

export interface LayoutInput {
  /** scene-type nodes only */
  scenes: TreeNodeData[];
  codexEntries: CodexEntry[];
  positions: MapNodePositionRecord[];
}

export type LayoutOutput = Map<string, { x: number; y: number }>;
