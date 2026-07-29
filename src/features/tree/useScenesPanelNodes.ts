import { useMemo } from "react";
import { useTreeStore, type TreeNodeData } from "./treeStore";

type TreeNodesSlice = { nodes: TreeNodeData[] };

function sameNodePresentation(
  previous: TreeNodeData,
  next: TreeNodeData,
): boolean {
  if (previous === next) return true;

  const previousRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord).filter(
    (key) => key !== "updatedAt",
  );
  const nextKeys = Object.keys(nextRecord).filter((key) => key !== "updatedAt");
  if (previousKeys.length !== nextKeys.length) return false;

  return previousKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(nextRecord, key) &&
      Object.is(previousRecord[key], nextRecord[key]),
  );
}

function sameTreePresentation(
  previous: TreeNodeData[],
  next: TreeNodeData[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((node, index) =>
    sameNodePresentation(node, next[index]),
  );
}

/**
 * Keep the structural/presentation snapshot stable when a content commit only
 * advances a node's OCC timestamp. LensDot subscribes to that timestamp by id,
 * so one save does not rebuild the complete 500+ row tree projection.
 */
export function createScenesPanelNodesSelector() {
  let selected: TreeNodeData[] | null = null;

  return (state: TreeNodesSlice): TreeNodeData[] => {
    if (selected && sameTreePresentation(selected, state.nodes)) {
      return selected;
    }
    selected = state.nodes;
    return state.nodes;
  };
}

export function useScenesPanelNodes(): TreeNodeData[] {
  const selector = useMemo(createScenesPanelNodesSelector, []);
  return useTreeStore(selector);
}
