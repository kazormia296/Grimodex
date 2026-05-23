import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";
import type { MapNodePositionRecord } from "../types";

export interface SceneLayoutInput extends TreeNodeData {
  tags?: string[];
}

export interface LayoutUserEdge {
  fromPositionId: string;
  toPositionId: string;
}

export interface LayoutInput {
  /** scene-type nodes only */
  scenes: SceneLayoutInput[];
  codexEntries: CodexEntry[];
  positions: MapNodePositionRecord[];
  userEdges?: LayoutUserEdge[];
  /** seeded fallback for force layout */
  boardId?: string;
}

export type LayoutOutput = Map<string, { x: number; y: number }>;
