import type { TreeNodeData } from "@/features/tree/treeStore";

export type ContainerTarget =
  | { type: "not_found" }
  | { type: "keep_current" }
  | { type: "set"; containerId: string | null };

/**
 * Resolves which Grid container to display so the given scene is visible.
 *
 * - Scene not found or not a scene node → "not_found"
 * - Scene has no folder parent (loose at root) → "keep_current"
 * - Scene inside a folder (chapter) → "set" with the folder's parent as container
 *   (null = project root)
 */
export function resolveContainerForScene(
  sceneId: string,
  nodesById: Record<string, TreeNodeData>,
): ContainerTarget {
  const scene = nodesById[sceneId];
  if (!scene || scene.nodeType !== "scene") return { type: "not_found" };

  const parentFolder = scene.parentId ? nodesById[scene.parentId] : null;
  if (!parentFolder || parentFolder.nodeType !== "folder") {
    return { type: "keep_current" };
  }

  return { type: "set", containerId: parentFolder.parentId ?? null };
}
