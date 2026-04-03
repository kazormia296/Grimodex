import { create } from "zustand";
import * as api from "./api";
import type { TreeNode as ApiNode } from "./api";

export type NodeType = "part" | "chapter" | "scene" | "folder" | "note";
export type SceneStatus =
  | "outline"
  | "draft"
  | "complete"
  | "revision"
  | "final";

export interface TreeNodeData {
  id: string;
  projectId: string;
  parentId: string | null;
  nodeType: NodeType;
  title: string;
  synopsis: string | null;
  sortOrder: number;
  status: string | null;
}

/** Validate whether a node type can be placed under a given parent type */
export function isValidParent(
  nodeType: NodeType,
  parentType: NodeType | null,
): boolean {
  switch (nodeType) {
    case "scene":
      return parentType === "chapter";
    case "chapter":
      return parentType === null || parentType === "part";
    case "part":
      return parentType === null;
    case "note":
      return parentType === "folder";
    case "folder":
      return parentType === null || parentType === "folder";
  }
}

/** Flat scene metadata for backward-compat */
export interface SceneMeta {
  id: string;
  title: string;
  sortOrder: number;
}

function toNodeData(n: ApiNode): TreeNodeData {
  return {
    id: n.id,
    projectId: n.projectId,
    parentId: n.parentId ?? null,
    nodeType: n.nodeType as NodeType,
    title: n.title,
    synopsis: n.synopsis ?? null,
    sortOrder: n.sortOrder,
    status: n.status ?? null,
  };
}

function computeScenes(nodes: TreeNodeData[]): SceneMeta[] {
  return nodes
    .filter((n) => n.nodeType === "scene")
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((n) => ({ id: n.id, title: n.title, sortOrder: n.sortOrder }));
}

const DEFAULT_PROJECT_ID = "default-project";
const DEFAULT_CHAPTER_ID = "default-chapter";

export type ViewMode = "tree" | "outline";

interface TreeState {
  nodes: TreeNodeData[];
  scenes: SceneMeta[]; // flat scene list (backward compat)
  activeSceneId: string;
  isLoading: boolean;
  projectId: string;
  expandedIds: string[];
  filterQuery: string;
  viewMode: ViewMode;

  // Display settings
  charCounts: Record<string, number>;
  showWordCounts: boolean;
  showStatusDots: boolean;

  // Codex Quick pinned entries
  pinnedCodexIds: string[];

  // Load full tree for a project
  loadTree: (projectId?: string) => Promise<void>;

  // Backward-compat API (used by ChatPanel, ExportAgentTraceButton, SceneEditor)
  loadScenes: (projectId: string, chapterId: string) => Promise<void>;
  createScene: () => Promise<void>;
  deleteScene: (id: string) => Promise<void>;
  renameScene: (id: string, title: string) => Promise<void>;
  setActiveScene: (id: string) => void;

  // New tree operations
  createNode: (opts: CreateNodeOpts) => Promise<TreeNodeData>;
  updateNodeTitle: (id: string, title: string) => Promise<void>;
  deleteNode: (id: string) => Promise<void>;
  updateSynopsis: (id: string, synopsis: string) => Promise<void>;
  setStatus: (id: string, status: SceneStatus) => Promise<void>;
  moveNode: (
    id: string,
    newParentId: string | null,
    afterId: string | null,
  ) => Promise<void>;

  // UI state
  toggleExpand: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  setFilterQuery: (query: string) => void;
  setViewMode: (mode: ViewMode) => void;

  // Display settings
  setCharCount: (id: string, count: number) => void;
  setShowWordCounts: (v: boolean) => void;
  setShowStatusDots: (v: boolean) => void;

  // Codex Quick
  togglePinnedCodex: (id: string) => void;
}

export interface CreateNodeOpts {
  nodeType: NodeType;
  parentId: string | null;
  afterId?: string | null; // insert after this sibling
  title?: string;
}

/**
 * Compute next sort_order for inserting after `afterId` within the same parent.
 * Returns (afterOrder + nextOrder) / 2 for middle insert,
 * or (maxOrder + 1.0) for appending.
 */
function nextSortOrder(
  siblings: TreeNodeData[],
  afterId: string | null | undefined,
): number {
  const sorted = [...siblings].sort((a, b) => a.sortOrder - b.sortOrder);
  if (!afterId) {
    // Append at end
    const last = sorted[sorted.length - 1];
    return last ? last.sortOrder + 1.0 : 1.0;
  }
  const idx = sorted.findIndex((n) => n.id === afterId);
  if (idx === -1)
    return sorted.length > 0 ? sorted[sorted.length - 1].sortOrder + 1.0 : 1.0;
  const after = sorted[idx];
  const next = sorted[idx + 1];
  if (!next) return after.sortOrder + 1.0;
  return (after.sortOrder + next.sortOrder) / 2;
}

export const useTreeStore = create<TreeState>()((set, get) => ({
  nodes: [],
  scenes: [],
  activeSceneId: "",
  isLoading: false,
  projectId: DEFAULT_PROJECT_ID,
  expandedIds: [],
  filterQuery: "",
  viewMode: "tree",
  charCounts: {},
  showWordCounts: true,
  showStatusDots: true,
  pinnedCodexIds: [],

  async loadTree(projectId = DEFAULT_PROJECT_ID) {
    set({ isLoading: true, projectId });
    try {
      let raw = await api.listNodes(projectId);
      // Auto-create default scene if no scenes exist under default chapter
      const scenes = raw.filter((n) => n.nodeType === "scene");
      if (scenes.length === 0) {
        const defaultChapter = raw.find((n) => n.id === DEFAULT_CHAPTER_ID);
        if (!defaultChapter) {
          // Create a default chapter
          const ch = await api.createNode({
            id: DEFAULT_CHAPTER_ID,
            projectId,
            nodeType: "chapter",
            title: "第1章",
            sortOrder: 1.0,
          });
          raw = [...raw, ch];
        }
        const scene = await api.createNode({
          id: crypto.randomUUID(),
          projectId,
          parentId: DEFAULT_CHAPTER_ID,
          nodeType: "scene",
          title: "シーン 1",
          sortOrder: 1.0,
        });
        raw = [...raw, scene];
      }
      const nodes = raw.map(toNodeData);
      const sc = computeScenes(nodes);
      // Expand chapters by default
      const chapters = nodes.filter(
        (n) => n.nodeType === "chapter" || n.nodeType === "part",
      );
      set({
        nodes,
        scenes: sc,
        activeSceneId: sc[0]?.id ?? "",
        isLoading: false,
        expandedIds: chapters.map((c) => c.id),
      });
    } catch {
      set({ isLoading: false });
    }
  },

  // --- Backward-compat methods ---
  async loadScenes(projectId, _chapterId) {
    await get().loadTree(projectId);
  },

  async createScene() {
    const { projectId, nodes } = get();
    const chapterNode = nodes.find((n) => n.id === DEFAULT_CHAPTER_ID);
    const siblings = nodes.filter(
      (n) => n.parentId === (chapterNode?.id ?? null),
    );
    const sortOrder = nextSortOrder(siblings, null);
    const created = await api.createNode({
      id: crypto.randomUUID(),
      projectId,
      parentId: chapterNode?.id ?? null,
      nodeType: "scene",
      title: `シーン ${siblings.filter((n) => n.nodeType === "scene").length + 1}`,
      sortOrder,
    });
    const newNode = toNodeData(created);
    set((state) => {
      const nodes = [...state.nodes, newNode];
      return { nodes, scenes: computeScenes(nodes) };
    });
  },

  async deleteScene(id) {
    const { scenes } = get();
    if (scenes.length <= 1) return;
    await api.deleteNode(id);
    const { activeSceneId } = get();
    const remaining = scenes.filter((s) => s.id !== id);
    const newActive = activeSceneId === id ? remaining[0].id : activeSceneId;
    set((state) => {
      const nodes = state.nodes.filter((n) => n.id !== id);
      return { nodes, scenes: computeScenes(nodes), activeSceneId: newActive };
    });
  },

  async renameScene(id, title) {
    await api.updateNode(id, { title });
    set((state) => {
      const nodes = state.nodes.map((n) => (n.id === id ? { ...n, title } : n));
      return { nodes, scenes: computeScenes(nodes) };
    });
  },

  setActiveScene(id) {
    set({ activeSceneId: id });
  },

  // --- New tree operations ---
  async createNode({ nodeType, parentId, afterId, title }) {
    const { projectId, nodes } = get();
    const siblings = nodes.filter((n) => n.parentId === parentId);
    const sortOrder = nextSortOrder(siblings, afterId);
    const defaultTitle =
      title ??
      (nodeType === "scene"
        ? `シーン ${siblings.filter((n) => n.nodeType === "scene").length + 1}`
        : nodeType === "chapter"
          ? `第${siblings.filter((n) => n.nodeType === "chapter").length + 1}章`
          : nodeType === "part"
            ? `第${nodes.filter((n) => n.nodeType === "part").length + 1}部`
            : nodeType === "folder"
              ? "フォルダー"
              : "ノート");
    const created = await api.createNode({
      id: crypto.randomUUID(),
      projectId,
      parentId: parentId ?? undefined,
      nodeType,
      title: defaultTitle,
      sortOrder,
    });
    const newNode = toNodeData(created);
    set((state) => {
      const updated = [...state.nodes, newNode];
      const newScenes = computeScenes(updated);
      return {
        nodes: updated,
        scenes: newScenes,
        activeSceneId: nodeType === "scene" ? newNode.id : state.activeSceneId,
      };
    });
    return newNode;
  },

  async updateNodeTitle(id, title) {
    await api.updateNode(id, { title });
    set((state) => {
      const nodes = state.nodes.map((n) => (n.id === id ? { ...n, title } : n));
      return { nodes, scenes: computeScenes(nodes) };
    });
  },

  async deleteNode(id) {
    const { nodes, activeSceneId } = get();
    // Collect all descendants to delete
    const toDelete = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      toDelete.add(cur);
      nodes.filter((n) => n.parentId === cur).forEach((c) => queue.push(c.id));
    }
    // Delete from DB (leaf-first to avoid FK issues)
    for (const delId of [...toDelete].reverse()) {
      await api.deleteNode(delId);
    }
    const remaining = nodes.filter((n) => !toDelete.has(n.id));
    const newScenes = computeScenes(remaining);
    const newActive = toDelete.has(activeSceneId)
      ? (newScenes[0]?.id ?? "")
      : activeSceneId;
    set({ nodes: remaining, scenes: newScenes, activeSceneId: newActive });
  },

  async updateSynopsis(id, synopsis) {
    await api.updateNode(id, { synopsis });
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, synopsis } : n)),
    }));
  },

  async setStatus(id, status) {
    await api.updateNode(id, { status });
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, status } : n)),
    }));
  },

  // --- UI state ---
  toggleExpand(id) {
    set((state) => ({
      expandedIds: state.expandedIds.includes(id)
        ? state.expandedIds.filter((x) => x !== id)
        : [...state.expandedIds, id],
    }));
  },

  expandAll() {
    const containers = get().nodes.filter(
      (n) =>
        n.nodeType === "part" ||
        n.nodeType === "chapter" ||
        n.nodeType === "folder",
    );
    set({ expandedIds: containers.map((n) => n.id) });
  },

  collapseAll() {
    set({ expandedIds: [] });
  },

  setFilterQuery(query) {
    set({ filterQuery: query });
  },

  setViewMode(mode) {
    set({ viewMode: mode });
  },

  async moveNode(id, newParentId, afterId) {
    const { nodes } = get();
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const siblings = nodes
      .filter((n) => n.parentId === newParentId && n.id !== id)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    // afterId semantics:
    //   null      → insert before first sibling (prepend)
    //   undefined → append after last sibling
    //   string    → insert after the named sibling
    let sortOrder: number;
    if (afterId === null) {
      const first = siblings[0];
      sortOrder = first ? first.sortOrder - 1.0 : 1.0;
    } else if (afterId === undefined) {
      const last = siblings[siblings.length - 1];
      sortOrder = last ? last.sortOrder + 1.0 : 1.0;
    } else {
      const idx = siblings.findIndex((n) => n.id === afterId);
      if (idx === -1) {
        const last = siblings[siblings.length - 1];
        sortOrder = last ? last.sortOrder + 1.0 : 1.0;
      } else {
        const after = siblings[idx];
        const next = siblings[idx + 1];
        sortOrder = next
          ? (after.sortOrder + next.sortOrder) / 2
          : after.sortOrder + 1.0;
      }
    }

    await api.updateNode(id, {
      parentId: newParentId ?? undefined,
      sortOrder,
    });
    set((state) => {
      const updated = state.nodes.map((n) =>
        n.id === id ? { ...n, parentId: newParentId, sortOrder } : n,
      );
      return { nodes: updated, scenes: computeScenes(updated) };
    });
  },

  setCharCount(id, count) {
    set((state) => ({ charCounts: { ...state.charCounts, [id]: count } }));
  },

  setShowWordCounts(v) {
    set({ showWordCounts: v });
  },

  setShowStatusDots(v) {
    set({ showStatusDots: v });
  },

  togglePinnedCodex(id) {
    set((state) => ({
      pinnedCodexIds: state.pinnedCodexIds.includes(id)
        ? state.pinnedCodexIds.filter((x) => x !== id)
        : [...state.pinnedCodexIds, id],
    }));
  },
}));
