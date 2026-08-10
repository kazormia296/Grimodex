import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys, generateKeyBetween } from "@/features/tree/fractionalIndex";
import type { HistoryCommand } from "@/store/globalHistoryStore";

export interface MoveTreeNodePorts {
  tryAcquireNavigationAuthority(): { release(): void } | null;
  getNodes(): readonly TreeNodeData[];
  applyNodes(nodes: TreeNodeData[]): void;
  persist(
    id: string,
    patch: { parentId: string | null; sortOrder: string },
  ): Promise<{ updatedAt?: string } | void>;
  recomputeSceneOrder(nodes: readonly TreeNodeData[]): void;
  isReplaying(): boolean;
  pushHistory(command: HistoryCommand): void;
  recordChange(input: {
    entityType: string;
    entityId: string;
    sceneId: string | null;
    payload: Record<string, unknown>;
  }): void;
  movedLabel: string;
}

function nextSortOrder(
  nodes: readonly TreeNodeData[],
  id: string,
  newParentId: string | null,
  afterId: string | null | undefined,
): string {
  const siblings = nodes
    .filter((node) => node.parentId === newParentId && node.id !== id)
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  if (afterId === null) {
    return generateKeyBetween(null, siblings[0]?.sortOrder ?? null);
  }
  if (afterId === undefined) {
    return generateKeyBetween(siblings.at(-1)?.sortOrder ?? null, null);
  }

  const index = siblings.findIndex((node) => node.id === afterId);
  if (index === -1) {
    return generateKeyBetween(siblings.at(-1)?.sortOrder ?? null, null);
  }
  return generateKeyBetween(
    siblings[index]!.sortOrder,
    siblings[index + 1]?.sortOrder ?? null,
  );
}

/**
 * Move a tree node while keeping optimistic state, phase invalidation, change
 * event capture, and undo/redo as one application-level workflow.
 */
export async function moveTreeNode(
  id: string,
  newParentId: string | null,
  afterId: string | null | undefined,
  ports: MoveTreeNodePorts,
): Promise<void> {
  const navigationAuthority = ports.tryAcquireNavigationAuthority();
  if (!navigationAuthority) return;
  try {
    await moveTreeNodeWithAuthority(id, newParentId, afterId, ports);
  } finally {
    navigationAuthority.release();
  }
}

async function moveTreeNodeWithAuthority(
  id: string,
  newParentId: string | null,
  afterId: string | null | undefined,
  ports: MoveTreeNodePorts,
): Promise<void> {
  const nodes = [...ports.getNodes()];
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return;

  const oldParentId = node.parentId;
  const oldSortOrder = node.sortOrder;
  const sortOrder = nextSortOrder(nodes, id, newParentId, afterId);
  const apply = (
    parentId: string | null,
    nextSortOrderValue: string,
    updatedAt?: string,
  ) => {
    const next = ports.getNodes().map((candidate) =>
      candidate.id === id
        ? {
            ...candidate,
            parentId,
            sortOrder: nextSortOrderValue,
            ...(updatedAt === undefined ? {} : { updatedAt }),
          }
        : candidate,
    );
    ports.applyNodes(next);
    ports.recomputeSceneOrder(next);
  };

  // Optimistic state is intentionally applied before the DB round-trip.
  apply(newParentId, sortOrder);
  ports.recordChange({
    entityType: node.nodeType,
    entityId: id,
    sceneId: node.nodeType === "scene" ? id : null,
    payload: {
      parentBefore: oldParentId,
      parentAfter: newParentId,
      sortBefore: oldSortOrder,
      sortAfter: sortOrder,
    },
  });

  if (!ports.isReplaying()) {
    ports.pushHistory({
      kind: "scenes",
      label: ports.movedLabel,
      entityId: id,
      async undo() {
        const navigationAuthority = ports.tryAcquireNavigationAuthority();
        if (!navigationAuthority) return;
        try {
          const persisted = await ports.persist(id, {
            parentId: oldParentId,
            sortOrder: oldSortOrder,
          });
          apply(oldParentId, oldSortOrder, persisted?.updatedAt);
        } finally {
          navigationAuthority.release();
        }
      },
      async redo() {
        const navigationAuthority = ports.tryAcquireNavigationAuthority();
        if (!navigationAuthority) return;
        try {
          const persisted = await ports.persist(id, {
            parentId: newParentId,
            sortOrder,
          });
          apply(newParentId, sortOrder, persisted?.updatedAt);
        } finally {
          navigationAuthority.release();
        }
      },
    });
  }

  // Keep null as null: undefined would make Drizzle omit parent_id and break
  // moves to the project root.
  const persisted = await ports.persist(id, {
    parentId: newParentId,
    sortOrder,
  });
  apply(newParentId, sortOrder, persisted?.updatedAt);
}
