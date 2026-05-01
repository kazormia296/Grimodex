import { useTreeStore } from "@/features/tree/treeStore";

/**
 * Move all loose scenes into an existing chapter.
 */
export async function consolidateLooseIntoChapter(
  looseSceneIds: string[],
  targetChapterId: string,
): Promise<void> {
  const { moveNode } = useTreeStore.getState();
  for (const sceneId of looseSceneIds) {
    await moveNode(sceneId, targetChapterId, undefined);
  }
}

/**
 * Create a new chapter folder and move all loose scenes into it.
 * Returns the new folder's node ID.
 */
export async function convertLooseToChapter(
  containerId: string | null,
  looseSceneIds: string[],
  chapterTitle?: string,
): Promise<string> {
  const { createNode, moveNode, nodes } = useTreeStore.getState();

  // Auto-number: count existing folders under this container
  const existingFolders = nodes.filter(
    (n) => n.nodeType === "folder" && n.parentId === containerId,
  );
  const title = chapterTitle ?? `Chapter ${existingFolders.length + 1}`;

  const newNode = await createNode({
    nodeType: "folder",
    parentId: containerId,
    title,
  });

  for (const sceneId of looseSceneIds) {
    await moveNode(sceneId, newNode.id, undefined);
  }

  return newNode.id;
}
