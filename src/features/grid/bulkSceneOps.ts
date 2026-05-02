import { useTreeStore } from "@/features/tree/treeStore";

/**
 * Move multiple scenes to a target chapter, preserving relative order.
 * Uses the same moveNode as single-scene D&D (appended to end of target).
 */
export async function moveScenesToChapter(
  orderedSceneIds: string[],
  targetParentId: string | null,
): Promise<void> {
  const { moveNode } = useTreeStore.getState();
  for (const sceneId of orderedSceneIds) {
    await moveNode(sceneId, targetParentId, undefined);
  }
}

/**
 * Delete multiple scenes. Each deletion is recorded individually in undo history.
 */
export async function deleteScenes(sceneIds: string[]): Promise<void> {
  const { deleteNode } = useTreeStore.getState();
  for (const sceneId of sceneIds) {
    await deleteNode(sceneId);
  }
}
