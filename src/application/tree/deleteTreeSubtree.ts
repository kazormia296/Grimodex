import type { HistoryCommand } from "@/store/globalHistoryStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { TreeNodeRestoreSnapshot } from "@/features/tree/api";
import { debugLog } from "@/lib/debugLog";

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
  /**
   * Read the row as the database holds it, just before a delete (DR-UND-1), so
   * an Undo puts back every column and not only the ones `create` writes.
   * Optional: without it an Undo restores the create fields only.
   */
  loadRestoreSnapshot?(id: string): Promise<TreeNodeRestoreSnapshot | null>;
  deletePersisted(id: string): Promise<void>;
  /**
   * Re-create one node. Returns the fields the database set on the re-created
   * row that the store must take over (OCC token, and references that no longer
   * resolved).
   */
  restorePersisted(
    node: TreeNodeData,
    content?: string,
    snapshot?: TreeNodeRestoreSnapshot,
  ): Promise<TreeRestoredFields | void>;
  applyNodes(nodes: TreeNodeData[], activeSceneId: string): void;
  recomputeSceneOrder(nodes: readonly TreeNodeData[]): void;
  isReplaying(): boolean;
  pushHistory(command: HistoryCommand): void;
  closeTabs(id: string): void;
  captureTrash(input: TrashCapture): void;
  /**
   * Cancel a delayed Trash capture. Returns true when the capture was still
   * pending (so it is now gone and an Undo that stops half way can give it
   * back); false or nothing when it was no longer pending: already written to
   * the Trash, or being written (a write in flight completes even when it is
   * cancelled, so such a scene may be in the Trash twice, never in neither).
   */
  cancelTrash(tempId: string): boolean | void;
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

/** What the database decided when it re-created a node; the store mirrors it. */
export type TreeRestoredFields = Partial<
  Pick<
    TreeNodeData,
    | "version"
    | "updatedAt"
    | "povCharacterId"
    | "locationId"
    | "sourceUri"
    | "sourceMtime"
  >
>;

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

/**
 * The nodes of `nodes` that the delete's Undo Journal recorded, parents first,
 * each one connected to the root through other recorded nodes. A node added
 * to the folder after the Undo is not in the record (a Redo does not rewrite
 * it), so the next Undo cannot re-create it, and neither can one whose parent
 * is such a node.
 */
function recordedSubtree(
  nodes: readonly TreeNodeData[],
  recordedIds: ReadonlySet<string>,
  rootId: string,
): TreeNodeData[] {
  const kept = new Set<string>();
  const result: TreeNodeData[] = [];
  for (const node of parentsFirst(nodes)) {
    if (!recordedIds.has(node.id)) continue;
    if (node.id !== rootId && !(node.parentId && kept.has(node.parentId))) {
      continue;
    }
    kept.add(node.id);
    result.push(node);
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
  const restoreSnapshots: Record<string, TreeNodeRestoreSnapshot> = {};

  // Read what an Undo must put back. A failed read keeps the older snapshot
  // (the redo path) or, on the first delete, falls back to the create fields.
  async function captureSnapshots(
    targets: readonly TreeNodeData[],
    keepOnFailure: boolean,
  ): Promise<void> {
    for (const node of targets) {
      let snapshot: TreeNodeRestoreSnapshot | null = null;
      if (ports.loadRestoreSnapshot) {
        try {
          snapshot = await ports.loadRestoreSnapshot(node.id);
        } catch (error) {
          snapshot = null;
          // Fail open on purpose (an Undo must stay possible), but say so: this
          // Undo restores the create fields only, so after a reload the node's
          // other columns (including a note's context mode) are the defaults.
          debugLog.warn(
            "tree",
            "undo snapshot unreadable",
            `${node.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (snapshot) restoreSnapshots[node.id] = snapshot;
      if (node.nodeType !== "scene") continue;
      if (snapshot) {
        contentSnapshots[node.id] = snapshot.content;
        continue;
      }
      if (keepOnFailure && node.id in contentSnapshots) continue;
      try {
        contentSnapshots[node.id] = await ports.loadSceneContent(node.id);
      } catch {
        contentSnapshots[node.id] = "";
      }
    }
  }

  if (trackHistory) await captureSnapshots(deletedNodes, false);

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
  const trashCaptures = new Map<string, Omit<TrashCapture, "tempId">>();
  if (trackHistory) {
    for (const node of deletedNodes) {
      if (!successfullyDeleted.has(node.id) || node.nodeType !== "scene")
        continue;
      const tempId = ports.makeTrashTempId(node);
      trashTempIds.set(node.id, tempId);
      const capture = {
        projectId: node.projectId,
        node,
        content: contentSnapshots[node.id] ?? "",
        folderHintName:
          deletedNodes.find((candidate) => candidate.id === node.parentId)
            ?.title ??
          nodes.find((candidate) => candidate.id === node.parentId)?.title ??
          null,
      };
      trashCaptures.set(node.id, capture);
      ports.captureTrash({ ...capture, tempId });
    }
  }

  if (!trackHistory) return;
  const restoredIds = new Set<string>();
  const restoredFields = new Map<string, TreeRestoredFields>();
  // The nodes an Undo puts back into the store. A Redo refreshes them, so an
  // edit made between the Undo and the Redo is not lost by the next Undo.
  let undoNodes: TreeNodeData[] = deletedNodes;
  // Scenes whose delayed Trash capture an Undo cancelled in time.
  const outOfTrash = new Set<string>();
  // Put the restored nodes into the store. A complete Undo shows the active
  // Scene it started from; one that stopped half way shows only what came
  // back and leaves the active Scene alone unless that Scene is among them.
  // A retry after an unknown outcome sees nodes it already showed, so the
  // store's copy of a restored id is replaced and never duplicated.
  function reflectRestored(complete: boolean): void {
    const shown = undoNodes
      .filter((node) => restoredIds.has(node.id))
      .map((node) => {
        const fields = restoredFields.get(node.id);
        return fields ? { ...node, ...fields } : node;
      });
    if (shown.length === 0) return;
    const shownIds = new Set(shown.map((node) => node.id));
    const restored = [
      ...ports.getNodes().filter((node) => !shownIds.has(node.id)),
      ...shown,
    ];
    ports.applyNodes(
      restored,
      complete || shownIds.has(previousActiveSceneId)
        ? previousActiveSceneId
        : ports.getActiveSceneId(),
    );
    ports.recomputeSceneOrder(restored);
  }
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
        // The delayed Trash captures are cancelled up front, so a scene this
        // Undo restores is not also written to the Trash. A scene whose
        // capture was cancelled is in neither the Trash nor the database
        // until it is restored (it stays so through a Redo, which does not
        // capture again): if an Undo stops half way, those that were not
        // restored are given back (below) instead of being lost.
        for (const [nodeId, tempId] of trashTempIds) {
          if (outOfTrash.has(nodeId)) continue;
          if (ports.cancelTrash(tempId) === true) outOfTrash.add(nodeId);
        }
        try {
          for (const node of parentsFirst(undoNodes)) {
            if (restoredIds.has(node.id)) continue;
            const content =
              node.nodeType === "scene" ? contentSnapshots[node.id] : undefined;
            const snapshot = restoreSnapshots[node.id];
            const fields = snapshot
              ? await ports.restorePersisted(node, content, snapshot)
              : await ports.restorePersisted(node, content);
            if (fields) restoredFields.set(node.id, fields);
            restoredIds.add(node.id);
          }
        } catch (error) {
          // The database holds the nodes restored so far: show them, and put
          // the scenes that did not come back into the Trash again.
          reflectRestored(false);
          for (const nodeId of [...outOfTrash]) {
            if (restoredIds.has(nodeId)) continue;
            const capture = trashCaptures.get(nodeId);
            if (!capture) continue;
            const tempId = ports.makeTrashTempId(capture.node);
            trashTempIds.set(nodeId, tempId);
            outOfTrash.delete(nodeId);
            ports.captureTrash({ ...capture, tempId });
          }
          throw error;
        }
        reflectRestored(true);
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
        const refreshed = recordedSubtree(
          current.filter((node) => currentIds.has(node.id)),
          targetIds,
          id,
        );
        await captureSnapshots(refreshed, true);
        // What a later Undo gives back to the Trash is the body as of now.
        for (const node of refreshed) {
          const capture = trashCaptures.get(node.id);
          if (!capture) continue;
          trashCaptures.set(node.id, {
            ...capture,
            node,
            content: contentSnapshots[node.id] ?? capture.content,
          });
        }
        await ports.deletePersisted(id);
        restoredIds.clear();
        restoredFields.clear();
        if (refreshed.length > 0) undoNodes = refreshed;
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
