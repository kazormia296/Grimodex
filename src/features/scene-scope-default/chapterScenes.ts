/** Every Scene under a chapter (folder), at any depth. */
export function chapterSceneIds(
  nodes: readonly {
    id: string;
    parentId?: string | null;
    nodeType: string;
  }[],
  folderId: string,
): string[] {
  const children = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    children.set(node.parentId, [...list, node]);
  }
  const ids: string[] = [];
  const stack = [folderId];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (child.nodeType === "scene") ids.push(child.id);
      stack.push(child.id);
    }
  }
  return ids;
}
