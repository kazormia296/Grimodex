import { useSceneStore } from "./store";
import { useTreeStore } from "./treeStore";

export interface TreeNodeSummary {
  id: string;
  nodeType: string;
  title: string;
}

export interface TreeSceneSummary {
  id: string;
  parentId: string | null;
  title: string;
  sortOrder: string;
}

/** Read one lightweight Tree projection without exposing Zustand ownership. */
export function findTreeNodeSummary(id: string): TreeNodeSummary | null {
  const node = useSceneStore
    .getState()
    .nodes.find((candidate) => candidate.id === id);
  return node
    ? { id: node.id, nodeType: node.nodeType, title: node.title }
    : null;
}

/** Read the active scene identity without exposing the Tree Zustand store. */
export function getActiveTreeSceneId(): string | null {
  return useSceneStore.getState().activeSceneId;
}

/** Read the Project identity currently owned by the Tree projection. */
export function getTreeProjectId(): string {
  return useTreeStore.getState().projectId;
}

/** Read the lightweight scene ordering projection used by feature workflows. */
export function listTreeSceneSummaries(): TreeSceneSummary[] {
  return useSceneStore
    .getState()
    .nodes.filter((node) => node.nodeType === "scene")
    .map(({ id, parentId, title, sortOrder }) => ({
      id,
      parentId,
      title,
      sortOrder,
    }));
}

/** Persist and project a synopsis update through the Tree-owned command. */
export function updateTreeSynopsis(
  id: string,
  synopsis: string,
): Promise<void> {
  return useTreeStore.getState().updateSynopsis(id, synopsis);
}
