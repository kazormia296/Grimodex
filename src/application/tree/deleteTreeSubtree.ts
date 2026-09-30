import type { HistoryCommand } from "@/store/globalHistoryStore";
import type { TreeNodeData } from "@/features/tree/treeStore";

interface TrashCapture {
  projectId: string;
  node: TreeNodeData;
  content: string;
  folderHintName: string | null;
  tempId: string;
}

interface TreeNavigationAuthority {
  release(): void;
}

export interface DeleteTreeSubtreePorts {
  guardPending(): boolean;
  tryAcquireNavigationAuthority(): TreeNavigationAuthority | null;
  getNodes(): readonly TreeNodeData[];
  getActiveSceneId(): string;
  loadSceneContent(id: string): Promise<string>;
  deletePersisted(id: string): Promise<void>;
  restorePersisted(node: TreeNodeData, content?: string): Promise<void>;
  applyNodes(nodes: TreeNodeData[], activeSceneId: string): void;
  recomputeSceneOrder(nodes: readonly TreeNodeData[]): void;
  isReplaying(): boolean;
  pushHistory(command: HistoryCommand): void;
  closeTabs(id: string): void;
  captureTrash(input: TrashCapture): void;
  cancelTrash(tempId: string): void;
  makeTrashTempId(node: TreeNodeData): string;
  recordChange(input: {
    rootId: string;
    deletedIds: string[];
    partialFailure: boolean;
    previousActiveSceneId: string;
  }): void;
  notifyDeleteFailure(error: unknown): void;
  deletedLabel: string;
}

function descendants(
  nodes: readonly TreeNodeData[],
  rootId: string,
): Set<string> {
  const result = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (result.has(current)) continue;
    result.add(current);
    for (const child of nodes) {
      if (child.parentId === current) queue.push(child.id);
    }
  }
  return result;
}

function parentsFirst(nodes: readonly TreeNodeData[]): TreeNodeData[] {
  const ids = new Set(nodes.map((node) => node.id));
  const result: TreeNodeData[] = [];
  const visited = new Set<string>();
  function visit(node: TreeNodeData): void {
    if (visited.has(node.id)) return;
    if (node.parentId && ids.has(node.parentId)) {
      const parent = nodes.find((candidate) => candidate.id === node.parentId);
      if (parent) visit(parent);
    }
    visited.add(node.id);
    result.push(node);
  }
  for (const node of nodes) visit(node);
  return result;
}

/**
 * Delete a subtree while preserving partial-failure, trash, and history
 * semantics. The command owns cross-feature ordering; stores only apply the
 * resulting tree snapshots through ports.
 */
export async function deleteTreeSubtree(
  id: string,
  ports: DeleteTreeSubtreePorts,
): Promise<void> {
  if (ports.guardPending()) return;
  const navigationAuthority = ports.tryAcquireNavigationAuthority();
  if (!navigationAuthority) return;
  try {
    await deleteTreeSubtreeWithAuthority(id, ports);
  } finally {
    navigationAuthority.release();
  }
}

async function deleteTreeSubtreeWithAuthority(
  id: string,
  ports: DeleteTreeSubtreePorts,
): Promise<void> {
  const nodes = [...ports.getNodes()];
  const targetIds = descendants(nodes, id);
  const deletedNodes = nodes.filter((node) => targetIds.has(node.id));
  const previousActiveSceneId = ports.getActiveSceneId();
  const trackHistory = !ports.isReplaying();
  const contentSnapshots: Record<string, string> = {};

  if (trackHistory) {
    for (const node of deletedNodes) {
      if (node.nodeType !== "scene") continue;
      try {
        contentSnapshots[node.id] = await ports.loadSceneContent(node.id);
      } catch {
        contentSnapshots[node.id] = "";
      }
    }
  }

  try {
    await ports.deletePersisted(id);
  } catch (error) {
    ports.notifyDeleteFailure(error);
    return;
  }
  const successfullyDeleted = targetIds;

  const remaining = nodes.filter((node) => !successfullyDeleted.has(node.id));
  const nextActive = successfullyDeleted.has(previousActiveSceneId)
    ? (remaining.find((node) => node.nodeType === "scene")?.id ?? "")
    : previousActiveSceneId;
  ports.applyNodes(remaining, nextActive);
  ports.recomputeSceneOrder(remaining);
  if (successfullyDeleted.size === 0) return;

  ports.recordChange({
    rootId: id,
    deletedIds: [...successfullyDeleted],
    partialFailure: false,
    previousActiveSceneId,
  });
  for (const deletedId of successfullyDeleted) ports.closeTabs(deletedId);
  const trashTempIds = new Map<string, string>();
  if (trackHistory) {
    for (const node of deletedNodes) {
      if (!successfullyDeleted.has(node.id) || node.nodeType !== "scene")
        continue;
      const tempId = ports.makeTrashTempId(node);
      trashTempIds.set(node.id, tempId);
      ports.captureTrash({
        projectId: node.projectId,
        node,
        content: contentSnapshots[node.id] ?? "",
        folderHintName:
          deletedNodes.find((candidate) => candidate.id === node.parentId)
            ?.title ??
          nodes.find((candidate) => candidate.id === node.parentId)?.title ??
          null,
        tempId,
      });
    }
  }

  if (!trackHistory) return;
  const restoredIds = new Set<string>();
  ports.pushHistory({
    kind: "scenes",
    label: ports.deletedLabel,
    entityId: id,
    affectedEntities: deletedNodes.map((node) => ({
      kind: "scenes",
      entityId: node.id,
    })),
    async undo() {
      const navigationAuthority = ports.tryAcquireNavigationAuthority();
      if (!navigationAuthority) return;
      try {
        for (const tempId of trashTempIds.values()) ports.cancelTrash(tempId);
        for (const node of parentsFirst(deletedNodes)) {
          if (restoredIds.has(node.id)) continue;
          await ports.restorePersisted(
            node,
            node.nodeType === "scene" ? contentSnapshots[node.id] : undefined,
          );
          restoredIds.add(node.id);
        }
        const restored = [...ports.getNodes(), ...deletedNodes];
        ports.applyNodes(restored, previousActiveSceneId);
        ports.recomputeSceneOrder(restored);
      } finally {
        navigationAuthority.release();
      }
    },
    async redo() {
      const navigationAuthority = ports.tryAcquireNavigationAuthority();
      if (!navigationAuthority) return;
      try {
        const current = [...ports.getNodes()];
        const currentIds = descendants(current, id);
        await ports.deletePersisted(id);
        restoredIds.clear();
        const next = current.filter((node) => !currentIds.has(node.id));
        const active = currentIds.has(ports.getActiveSceneId())
          ? (next.find((node) => node.nodeType === "scene")?.id ?? "")
          : ports.getActiveSceneId();
        ports.applyNodes(next, active);
        ports.recomputeSceneOrder(next);
        for (const deletedId of currentIds) ports.closeTabs(deletedId);
      } finally {
        navigationAuthority.release();
      }
    },
  });
}
