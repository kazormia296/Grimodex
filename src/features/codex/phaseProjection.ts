import type { TreeNodeData } from "@/features/tree/types";
import { usePhaseStore } from "./phaseStore";

/** Update Codex phase ordering without exposing the concrete phase store. */
export function recomputeCodexSceneOrder(nodes: readonly TreeNodeData[]): void {
  usePhaseStore.getState().recomputeSceneOrder([...nodes]);
}
