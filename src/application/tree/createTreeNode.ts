import i18next from "@/lib/i18n";
import type { HistoryCommand } from "@/store/globalHistoryStore";
import type {
  CreateNodeOpts,
  NodeType,
  TreeNodeData,
} from "@/features/tree/treeStore";
import { cmpKeys, generateKeyBetween } from "@/features/tree/fractionalIndex";

interface CreateTreeNodeRecord {
  id: string;
  projectId: string;
  parentId: string | null;
  nodeType: NodeType;
  title: string;
  sortOrder: string;
}

interface TreeNavigationAuthority {
  release(): void;
}

export interface CreateTreeNodePorts {
  ensureWritable(): void;
  getProjectId(): string;
  getNodes(): readonly TreeNodeData[];
  isCurrentAuthority(): boolean;
  getSetting(key: string, fallback: string): string;
  createPersisted(record: CreateTreeNodeRecord): Promise<TreeNodeData>;
  deletePersisted(id: string): Promise<void>;
  recreatePersisted(node: TreeNodeData): Promise<TreeNodeData>;
  tryAcquireNavigationAuthority(): TreeNavigationAuthority | null;
  applyCreated(node: TreeNodeData, mode: "create" | "redo"): void;
  applyRemoved(id: string): void;
  recomputeSceneOrder(nodes: readonly TreeNodeData[]): void;
  closeTabs(id: string): void;
  revealEditorDocument(id: string): void;
  isReplaying(): boolean;
  pushHistory(command: HistoryCommand): void;
  recordChange(input: {
    entityType: NodeType;
    entityId: string;
    sceneId: string | null;
    payload: Record<string, unknown>;
  }): void;
}

function isValidOrderKey(key: string): boolean {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

function nextSortOrder(
  siblings: readonly TreeNodeData[],
  afterId: string | null | undefined,
): string {
  const sorted = siblings
    .filter((node) => isValidOrderKey(node.sortOrder))
    .slice()
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  if (!afterId)
    return generateKeyBetween(sorted.at(-1)?.sortOrder ?? null, null);
  const index = sorted.findIndex((node) => node.id === afterId);
  if (index === -1)
    return generateKeyBetween(sorted.at(-1)?.sortOrder ?? null, null);
  return generateKeyBetween(
    sorted[index]!.sortOrder,
    sorted[index + 1]?.sortOrder ?? null,
  );
}

function extractTrailingNumber(title: string, prefix: string): number | null {
  if (!prefix) return null;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = title.match(new RegExp(`^${escaped}\\s*(\\d+)$`));
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function nextNumber(
  nodeType: "scene" | "note",
  parentId: string | null,
  afterId: string | null | undefined,
  nodes: readonly TreeNodeData[],
  prefix: string,
  scope: string,
): number {
  const scopeNodes = nodes.filter(
    (node) =>
      node.nodeType === nodeType &&
      (scope !== "folder" || node.parentId === parentId),
  );
  const used = new Set(
    scopeNodes
      .map((node) => extractTrailingNumber(node.title, prefix))
      .filter((value): value is number => value !== null),
  );
  const siblings = nodes
    .filter((node) => node.nodeType === nodeType && node.parentId === parentId)
    .slice()
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  let before: number;
  let after = Infinity;
  if (afterId != null) {
    const afterNode = nodes.find((node) => node.id === afterId);
    before = afterNode
      ? (extractTrailingNumber(afterNode.title, prefix) ?? 0)
      : 0;
    const index = siblings.findIndex((node) => node.id === afterId);
    if (index >= 0 && siblings[index + 1]) {
      after =
        extractTrailingNumber(siblings[index + 1]!.title, prefix) ?? Infinity;
    }
  } else {
    before = used.size > 0 ? Math.max(...used) : 0;
  }
  for (
    let value = Math.max(1, before + 1);
    value < after && value < before + 1000;
    value++
  ) {
    if (!used.has(value)) return value;
  }
  return used.size > 0 ? Math.max(...used) + 1 : 1;
}

function folderTitle(
  parentId: string | null,
  nodes: readonly TreeNodeData[],
  naming: string,
): string {
  if (naming !== "auto") return i18next.t("tree.defaultFolder");
  let depth = 0;
  let current = parentId;
  while (current !== null) {
    depth += 1;
    current = nodes.find((node) => node.id === current)?.parentId ?? null;
  }
  if (depth === 0 || depth === 1) {
    const prefix = depth === 0 ? "Part." : "Chapter ";
    const siblings = nodes.filter(
      (node) =>
        node.nodeType === "folder" &&
        (depth === 0 ? node.parentId === null : node.parentId === parentId),
    );
    const used = new Set(
      siblings
        .map((node) => extractTrailingNumber(node.title, prefix))
        .filter((value): value is number => value !== null),
    );
    let value = 1;
    while (used.has(value)) value += 1;
    return `${prefix}${value}`;
  }
  return i18next.t("tree.defaultFolder");
}

function resolveTitle(
  opts: CreateNodeOpts,
  nodes: readonly TreeNodeData[],
  ports: CreateTreeNodePorts,
): string {
  if (opts.title !== undefined) return opts.title;
  if (opts.nodeType === "folder") {
    return folderTitle(
      opts.parentId,
      nodes,
      ports.getSetting("tree.folderNaming", "auto"),
    );
  }
  const prefix = ports.getSetting(
    opts.nodeType === "scene" ? "tree.sceneNaming" : "tree.noteNaming",
    i18next.t(
      opts.nodeType === "scene" ? "tree.defaultScene" : "tree.defaultNote",
    ),
  );
  if (!prefix) {
    return i18next.t(
      opts.nodeType === "scene" ? "tree.defaultScene" : "tree.defaultNote",
    );
  }
  return `${prefix} ${nextNumber(
    opts.nodeType,
    opts.parentId,
    opts.afterId,
    nodes,
    prefix,
    ports.getSetting("tree.numberingScope", "project"),
  )}`;
}

/** Application workflow for create + history + tree side effects. */
export async function createTreeNode(
  opts: CreateNodeOpts,
  ports: CreateTreeNodePorts,
): Promise<TreeNodeData | null> {
  const navigationAuthority = ports.tryAcquireNavigationAuthority();
  if (!navigationAuthority) return null;
  try {
    return await createTreeNodeWithAuthority(opts, ports);
  } finally {
    navigationAuthority.release();
  }
}

async function createTreeNodeWithAuthority(
  opts: CreateNodeOpts,
  ports: CreateTreeNodePorts,
): Promise<TreeNodeData> {
  ports.ensureWritable();
  const nodes = [...ports.getNodes()];
  const title = resolveTitle(opts, nodes, ports);
  const record: CreateTreeNodeRecord = {
    id: crypto.randomUUID(),
    projectId: ports.getProjectId(),
    parentId: opts.parentId,
    nodeType: opts.nodeType,
    title,
    sortOrder: nextSortOrder(
      nodes.filter((node) => node.parentId === opts.parentId),
      opts.afterId,
    ),
  };
  const created = await ports.createPersisted(record);
  if (!ports.isCurrentAuthority()) return created;
  ports.applyCreated(created, "create");
  ports.recomputeSceneOrder(ports.getNodes());
  ports.recordChange({
    entityType: created.nodeType,
    entityId: created.id,
    sceneId: created.nodeType === "scene" ? created.id : null,
    payload: {
      parentId: created.parentId,
      sortOrder: created.sortOrder,
      title: created.title,
      nodeType: created.nodeType,
    },
  });

  if (opts.interaction !== "implicit" && !ports.isReplaying()) {
    const captured = { ...created };
    const label =
      created.nodeType === "scene"
        ? i18next.t("tree.undo.sceneCreated")
        : created.nodeType === "folder"
          ? i18next.t("tree.undo.folderCreated")
          : i18next.t("tree.undo.noteCreated");
    ports.pushHistory({
      kind: "scenes",
      label,
      entityId: captured.id,
      async undo() {
        const navigationAuthority = ports.tryAcquireNavigationAuthority();
        if (!navigationAuthority) return;
        try {
          await ports.deletePersisted(captured.id);
          if (!ports.isCurrentAuthority()) return;
          ports.applyRemoved(captured.id);
          ports.recomputeSceneOrder(ports.getNodes());
          ports.closeTabs(captured.id);
        } finally {
          navigationAuthority.release();
        }
      },
      async redo() {
        const navigationAuthority = ports.tryAcquireNavigationAuthority();
        if (!navigationAuthority) return;
        try {
          const recreated = await ports.recreatePersisted(captured);
          if (!ports.isCurrentAuthority()) return;
          ports.applyCreated(recreated, "redo");
          ports.recomputeSceneOrder(ports.getNodes());
          if (
            opts.interaction !== "mobile" &&
            (recreated.nodeType === "scene" || recreated.nodeType === "note")
          ) {
            ports.revealEditorDocument(recreated.id);
          }
        } finally {
          navigationAuthority.release();
        }
      },
    });
  }
  return created;
}
