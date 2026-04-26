import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";
import type { MapNodePositionRecord } from "../types";

export interface SceneLayoutInput extends TreeNodeData {
  tags?: string[];
}

export interface LayoutInput {
  /** scene-type nodes only */
  scenes: SceneLayoutInput[];
  codexEntries: CodexEntry[];
  positions: MapNodePositionRecord[];
}

export type LayoutOutput = Map<string, { x: number; y: number }>;
