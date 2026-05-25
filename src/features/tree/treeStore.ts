import { create } from "zustand";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import * as api from "./api";
import type { TreeNode as ApiNode } from "./api";
import { loadBatchAiRatio } from "@/features/attribution/api";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useTabStore } from "@/features/editor/tabStore";
import { markStart, markEnd } from "@/lib/perfLog";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { captureSceneDeletion } from "@/features/trash-bin/captureHooks";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import {
  listPinnedCodexIds,
  addPinnedCodex,
  removePinnedCodex,
} from "./codexQuickPinApi";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { cmpKeys, generateKeyBetween } from "./fractionalIndex";

export type NodeType = "folder" | "scene" | "note";
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
  /** fractional-indexing 文字列キー（base62、辞書順比較） */
  sortOrder: string;
  status: string | null;
  storyTimeOrder: string | null;
  storyTimeLabel: string | null;
  povCharacterId: string | null;
  locationId: string | null;
  charCount: number;
  /** File-backed scene location (null = DB-native). */
  sourceUri?: string | null;
  sourceMtime?: string | null;
  archivedAt?: string | null;
  /** Note body (ProseMirror JSON). Loaded for note nodes only (scene bodies stay out of store). */
  content?: string;
  /** Note-only: AI context injection mode. */
  contextMode?: string | null;
  /** Note-only: alternate names (JSON array string). */
  aliases?: string | null;
  /** Note-only: excluded aliases (JSON array string). */
  excludedAliases?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Returns true when a node type can hold children */
export function canHaveChildren(type: NodeType): boolean {
  return type === "folder";
}

/**
 * DFS pre-order で `folderId` 配下（自身は除く）のシーンを sortOrder 順に
 * 返す。各レベルで sortOrder を使ってソートするので、ツリー上に表示される
 * 並びと一致する。folder スコープの本文集約（Phase 2）で使う。
 *
 * folder 以外の id を渡した場合や見つからない場合は空配列。
 */
export function getDescendantScenesInOrder(
  nodes: TreeNodeData[],
  folderId: string | null | undefined,
): TreeNodeData[] {
  if (!folderId) return [];
  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const n of nodes) {
    const key = n.parentId;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(n);
    childrenByParent.set(key, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  }
  const out: TreeNodeData[] = [];
  const guard = new Set<string>();
  function walk(parentId: string) {
    if (guard.has(parentId)) return;
    guard.add(parentId);
    const kids = childrenByParent.get(parentId) ?? [];
    for (const n of kids) {
      if (n.nodeType === "scene") out.push(n);
      else if (n.nodeType === "folder") walk(n.id);
    }
  }
  walk(folderId);
  return out;
}

/**
 * Walks the parent chain from `nodeId` toward the root and returns folder
 * ancestors in nearest-first order. Used by Chat scope picker and outline
 * walkers to identify Chapter/Act layers without hard-coding a depth scheme.
 */
export function getAncestorFolders(
  nodes: TreeNodeData[],
  nodeId: string | null | undefined,
): TreeNodeData[] {
  if (!nodeId) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = byId.get(nodeId);
  if (!start) return [];
  const result: TreeNodeData[] = [];
  const guard = new Set<string>();
  let parentId = start.parentId;
  while (parentId) {
    if (guard.has(parentId)) break;
    guard.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.nodeType === "folder") result.push(parent);
    parentId = parent.parentId;
  }
  return result;
}

/** Flat scene metadata for backward-compat */
export interface SceneMeta {
  id: string;
  title: string;
  sortOrder: string;
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
    storyTimeOrder: n.storyTimeOrder ?? null,
    storyTimeLabel: n.storyTimeLabel ?? null,
    povCharacterId: n.povCharacterId ?? null,
    locationId: n.locationId ?? null,
    charCount: n.charCount,
    sourceUri: n.sourceUri ?? null,
    sourceMtime: n.sourceMtime ?? null,
    archivedAt: n.archivedAt ?? null,
    ...(n.nodeType === "note" ? { content: n.content } : {}),
    contextMode: n.contextMode ?? null,
    aliases: n.aliases ?? null,
    excludedAliases: n.excludedAliases ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

export interface NodeBeatPreview {
  placed: string | null;
  unplaced: string | null;
}

const EMPTY_NODE_PREVIEW: NodeBeatPreview = { placed: null, unplaced: null };

/**
 * セレクター内で fallback として使う安定参照。`?? {placed:null,unplaced:null}`
 * を毎回作ると Zustand の selector identity が変わって無限ループになる
 * (feedback_zustand_selector_new_ref.md)。
 */
export function emptyNodeBeatPreview(): NodeBeatPreview {
  return EMPTY_NODE_PREVIEW;
}

function computeScenes(nodes: TreeNodeData[]): SceneMeta[] {
  return nodes
    .filter((n) => n.nodeType === "scene")
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder))
    .map((n) => ({ id: n.id, title: n.title, sortOrder: n.sortOrder }));
}

const DEFAULT_CHAPTER_ID = "default-chapter";

export type ViewMode = "tree" | "outline";
export type SortMode = "manual" | "title" | "wordcount" | "status";

interface TreeState {
  nodes: TreeNodeData[];
  scenes: SceneMeta[]; // flat scene list (backward compat)
  activeSceneId: string;
  selectedIds: string[]; // multi-selection
  isLoading: boolean;
  projectId: string;
  expandedIds: string[];
  filterQuery: string;
  viewMode: ViewMode;
  sortMode: SortMode;
  statusFilter: SceneStatus | null; // null = show all
  labelFilter: string[]; // [] = show all; OR semantics

  /**
   * Beat preview を nodes[] から分離して保持する。Phase 4 で打鍵中/autosave 時に
   * `nodes: nodes.map(...)` で新配列を作るのを避けるため (whole-array selector
   * 29 サイトが notify されていた)。consumer は useNodeBeatPreview / nodePreviews
   * セレクター経由で読む。
   */
  nodePreviews: Record<string, NodeBeatPreview>;

  // Display settings
  charCounts: Record<string, number>;
  aiRatios: Record<string, number>; // nodeId → AI attribution % (0-100)
  showWordCounts: boolean;
  showStatusDots: boolean;
  showLabelDots: boolean;
  showAiAttribution: boolean;
  autoRevealActiveScene: boolean;

  // Codex Quick pinned entries
  pinnedCodexIds: string[];

  // Pending rename: set after createNode to trigger auto-edit in TreeNodeItem
  pendingRenameId: string | null;
  setPendingRenameId: (id: string | null) => void;

  // Pending reveal: set to make ScenesPanel scroll a node into view
  pendingRevealId: string | null;
  revealInTree: (id: string) => void;

  // Load full tree for a project
  loadTree: (projectId?: string) => Promise<void>;

  // Backward-compat API (used by ChatPanel, ExportAgentTraceButton, SceneEditor)
  loadScenes: (projectId: string, chapterId: string) => Promise<void>;
  createScene: () => Promise<string>;
  createNote: () => Promise<string>;
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
    afterId: string | null | undefined,
  ) => Promise<void>;

  updateStoryTime: (
    id: string,
    order: string | null,
    label?: string,
  ) => Promise<void>;

  updatePovCharacter: (
    id: string,
    codexEntryId: string | null,
  ) => Promise<void>;
  updateLocation: (id: string, codexEntryId: string | null) => Promise<void>;

  // Multi-selection
  selectNode: (id: string, extend: boolean) => void;
  rangeSelectNode: (id: string, orderedNodes: TreeNodeData[]) => void;
  clearSelection: () => void;

  // UI state
  toggleExpand: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  setFilterQuery: (query: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setSortMode: (mode: SortMode) => void;
  setStatusFilter: (status: SceneStatus | null) => void;
  toggleLabelFilter: (id: string) => void;
  setLabelFilter: (ids: string[]) => void;
  clearLabelFilter: () => void;

  /**
   * Beat preview を更新する。同値なら set 自体を skip して subscriber 全員への
   * notify を回避する (feedback_zustand_set_empty_object.md)。partial 指定可。
   */
  setNodePreview: (
    id: string,
    next: { placed?: string | null; unplaced?: string | null },
  ) => void;

  // Display settings
  setCharCount: (id: string, count: number) => void;
  setAiRatios: (ratios: Record<string, number>) => void;
  refreshAiRatio: (nodeId: string) => Promise<void>;
  setShowWordCounts: (v: boolean) => void;
  setShowStatusDots: (v: boolean) => void;
  setShowLabelDots: (v: boolean) => void;
  setShowAiAttribution: (v: boolean) => void;
  setAutoRevealActiveScene: (v: boolean) => void;

  // Codex Quick
  togglePinnedCodex: (id: string) => void;
  loadPinnedCodexIds: () => Promise<void>;
}

export interface CreateNodeOpts {
  nodeType: NodeType;
  parentId: string | null;
  afterId?: string | null; // insert after this sibling
  title?: string;
}

function isValidOrderKey(key: string): boolean {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute next sort_order key for inserting after `afterId` within the same parent.
 * 文字列 fractional-indexing で afterId の次（または末尾）のキーを生成する。
 *
 * 古いシードや手動編集で不正な fractional-indexing キー（例: "z0" は 'z'
 * 始まりで 27 文字必要だが 2 文字）が混入することがある。`generateKeyBetween`
 * は不正キーで例外を投げるので、無効な兄弟は事前に除外する。
 */
function nextSortOrder(
  siblings: TreeNodeData[],
  afterId: string | null | undefined,
): string {
  const sorted = siblings
    .filter((n) => isValidOrderKey(n.sortOrder))
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  if (!afterId) {
    const last = sorted[sorted.length - 1];
    return generateKeyBetween(last ? last.sortOrder : null, null);
  }
  const idx = sorted.findIndex((n) => n.id === afterId);
  if (idx === -1) {
    const last = sorted[sorted.length - 1];
    return generateKeyBetween(last ? last.sortOrder : null, null);
  }
  const after = sorted[idx];
  const next = sorted[idx + 1];
  return generateKeyBetween(after.sortOrder, next ? next.sortOrder : null);
}

/** Extract trailing integer from a title like "シーン 3" → 3, or null */
function extractTrailingNumber(title: string, prefix: string): number | null {
  if (!prefix) return null;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = title.match(new RegExp(`^${escaped}\\s*(\\d+)$`));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Compute the next number for a scene or note, filling gaps at the insertion point.
 * scope="project": uses numbers across all nodes of that type in the project.
 * scope="folder":  uses numbers only within the same parent.
 */
function computeNextNumber(
  nodeType: "scene" | "note",
  parentId: string | null,
  afterId: string | null | undefined,
  allNodes: TreeNodeData[],
  prefix: string,
  scope: string,
): number {
  const scopeNodes =
    scope === "folder"
      ? allNodes.filter(
          (n) => n.nodeType === nodeType && n.parentId === parentId,
        )
      : allNodes.filter((n) => n.nodeType === nodeType);

  const usedNumbers = new Set(
    scopeNodes
      .map((n) => extractTrailingNumber(n.title, prefix))
      .filter((n): n is number => n !== null),
  );

  // Siblings in insertion-order for boundary detection
  const siblings = allNodes
    .filter((n) => n.nodeType === nodeType && n.parentId === parentId)
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  let numBefore = 0;
  let numAfter = Infinity;

  if (afterId != null) {
    const afterNode = allNodes.find((n) => n.id === afterId);
    if (afterNode) {
      numBefore = extractTrailingNumber(afterNode.title, prefix) ?? 0;
    }
    const afterIdx = siblings.findIndex((n) => n.id === afterId);
    if (afterIdx >= 0 && afterIdx + 1 < siblings.length) {
      numAfter =
        extractTrailingNumber(siblings[afterIdx + 1].title, prefix) ?? Infinity;
    }
  } else {
    // Appending at end: look at all scope nodes for the max
    numBefore = usedNumbers.size > 0 ? Math.max(...usedNumbers) : 0;
    numAfter = Infinity;
  }

  // Smallest integer in (numBefore, numAfter) not yet used
  for (
    let x = Math.max(1, numBefore + 1);
    x < numAfter && x < numBefore + 1000;
    x++
  ) {
    if (!usedNumbers.has(x)) return x;
  }

  // Fallback: max + 1
  return usedNumbers.size > 0 ? Math.max(...usedNumbers) + 1 : 1;
}

/**
 * Compute the auto-generated folder title based on nesting depth.
 * Depth 0 (root): "Part.{N}"
 * Depth 1 (inside root folder): "Chapter {N}"
 * Depth 2+: フォルダー (no numbering)
 */
function computeFolderTitle(
  parentId: string | null,
  allNodes: TreeNodeData[],
  folderNaming: string,
): string {
  if (folderNaming !== "auto") return i18next.t("tree.defaultFolder");

  // Determine depth by counting ancestors
  let depth = 0;
  let cur = parentId;
  while (cur !== null) {
    depth++;
    cur = allNodes.find((n) => n.id === cur)?.parentId ?? null;
  }

  if (depth === 0) {
    // Root level → Part.{N}
    const prefix = "Part.";
    const usedNums = new Set(
      allNodes
        .filter((n) => n.nodeType === "folder" && n.parentId === null)
        .map((n) => extractTrailingNumber(n.title, prefix))
        .filter((n): n is number => n !== null),
    );
    let i = 1;
    while (usedNums.has(i)) i++;
    return `${prefix}${i}`;
  } else if (depth === 1) {
    // One level deep → Chapter {N}
    const prefix = "Chapter ";
    const usedNums = new Set(
      allNodes
        .filter((n) => n.nodeType === "folder" && n.parentId === parentId)
        .map((n) => extractTrailingNumber(n.title, prefix))
        .filter((n): n is number => n !== null),
    );
    let i = 1;
    while (usedNums.has(i)) i++;
    return `${prefix}${i}`;
  }

  return i18next.t("tree.defaultFolder");
}

/** Sort nodes so parents appear before their children (for restore operations). */
function topologicalSort(nodes: TreeNodeData[]): TreeNodeData[] {
  const ids = new Set(nodes.map((n) => n.id));
  const result: TreeNodeData[] = [];
  const visited = new Set<string>();
  function visit(node: TreeNodeData) {
    if (visited.has(node.id)) return;
    if (node.parentId && ids.has(node.parentId)) {
      visit(nodes.find((n) => n.id === node.parentId)!);
    }
    visited.add(node.id);
    result.push(node);
  }
  for (const node of nodes) visit(node);
  return result;
}

export const useTreeStore = create<TreeState>()((set, get) => ({
  nodes: [],
  scenes: [],
  activeSceneId: "",
  selectedIds: [],
  isLoading: false,
  projectId: getCurrentProjectId(),
  expandedIds: [],
  filterQuery: "",
  viewMode: "tree",
  sortMode: "manual",
  statusFilter: null,
  labelFilter: [],
  charCounts: {},
  nodePreviews: {},
  aiRatios: {},
  showWordCounts: true,
  showStatusDots: true,
  showLabelDots: true,
  showAiAttribution: false,
  autoRevealActiveScene: true,
  pinnedCodexIds: [],
  pendingRenameId: null,

  async loadTree(projectId = getCurrentProjectId()) {
    set({ isLoading: true, projectId });
    try {
      const raw = await api.listNodes(projectId);
      const nodes = raw.map(toNodeData);
      const sc = computeScenes(nodes);
      // Expand folders by default
      const chapters = nodes.filter((n) => n.nodeType === "folder");
      // Prime char counts from the cached `tree_nodes.char_count` column.
      // EditorPane writes this on every save, so it is the authoritative
      // source — no need to re-tokenize ProseMirror docs on tree load.
      const charCounts: Record<string, number> = {};
      for (const n of nodes) {
        if (n.nodeType === "scene" || n.nodeType === "note") {
          charCounts[n.id] = n.charCount;
        }
      }
      // Beat preview は TreeNodeData から外したので raw から直接取り出す。
      // null/null のエントリは読まれた際に EMPTY_NODE_PREVIEW で受けるので
      // 入れずに省略する。
      const nodePreviews: Record<string, NodeBeatPreview> = {};
      for (const n of raw) {
        const placed = n.placedBeatPreview ?? null;
        const unplaced = n.unplacedBeatPreview ?? null;
        if (placed !== null || unplaced !== null) {
          nodePreviews[n.id] = { placed, unplaced };
        }
      }
      const prevActive = get().activeSceneId;
      const prevNode = prevActive
        ? nodes.find((n) => n.id === prevActive)
        : undefined;
      const activeStillExists =
        prevNode != null &&
        (prevNode.nodeType === "scene" || prevNode.nodeType === "note");
      set({
        nodes,
        scenes: sc,
        activeSceneId: activeStillExists ? prevActive : (sc[0]?.id ?? ""),
        isLoading: false,
        expandedIds: chapters.map((c) => c.id),
        charCounts,
        nodePreviews,
      });
      // Recompute phase scene order for phase resolution
      usePhaseStore.getState().recomputeSceneOrder(nodes);
      // Load AI attribution ratios for all scene nodes
      const sceneIds = nodes
        .filter((n) => n.nodeType === "scene")
        .map((n) => n.id);
      loadBatchAiRatio(sceneIds)
        .then((ratios) => set({ aiRatios: ratios }))
        .catch(() => {});
      // Load persisted Codex Quick pins
      get()
        .loadPinnedCodexIds()
        .catch(() => {});
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
      title: `${i18next.t("tree.defaultScene")} ${siblings.filter((n) => n.nodeType === "scene").length + 1}`,
      sortOrder,
    });
    const newNode = toNodeData(created);
    set((state) => {
      const nodes = [...state.nodes, newNode];
      return { nodes, scenes: computeScenes(nodes) };
    });
    return created.id;
  },

  async createNote() {
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
      nodeType: "note",
      title: "新しいノート",
      sortOrder,
    });
    const newNode = toNodeData(created);
    set((state) => {
      const nodes = [...state.nodes, newNode];
      return { nodes, scenes: computeScenes(nodes) };
    });
    return created.id;
  },

  async deleteScene(id) {
    const { scenes } = get();
    await api.deleteNode(id);
    const { activeSceneId } = get();
    const remaining = scenes.filter((s) => s.id !== id);
    const newActive =
      activeSceneId === id ? (remaining[0]?.id ?? "") : activeSceneId;
    set((state) => {
      const nodes = state.nodes.filter((n) => n.id !== id);
      return { nodes, scenes: computeScenes(nodes), activeSceneId: newActive };
    });
    usePhaseStore.getState().recomputeSceneOrder(get().nodes);
  },

  async renameScene(id, title) {
    await api.updateNode(id, { title });
    set((state) => {
      const nodes = state.nodes.map((n) => (n.id === id ? { ...n, title } : n));
      return { nodes, scenes: computeScenes(nodes) };
    });
  },

  setActiveScene(id) {
    markStart("treeStore.setActiveScene");
    try {
      set({ activeSceneId: id });
    } finally {
      markEnd("treeStore.setActiveScene");
    }
  },

  // --- Multi-selection ---
  selectNode(id, extend) {
    if (extend) {
      set((state) => {
        const already = state.selectedIds.includes(id);
        return {
          selectedIds: already
            ? state.selectedIds.filter((x) => x !== id)
            : [...state.selectedIds, id],
          activeSceneId: id,
        };
      });
    } else {
      set({ selectedIds: [id], activeSceneId: id });
    }
  },

  rangeSelectNode(id, orderedNodes) {
    const { activeSceneId } = get();
    const anchorIdx = orderedNodes.findIndex((n) => n.id === activeSceneId);
    const targetIdx = orderedNodes.findIndex((n) => n.id === id);
    if (anchorIdx === -1 || targetIdx === -1) {
      set({ selectedIds: [id] });
      return;
    }
    const start = Math.min(anchorIdx, targetIdx);
    const end = Math.max(anchorIdx, targetIdx);
    const range = orderedNodes.slice(start, end + 1).map((n) => n.id);
    set({ selectedIds: range });
  },

  clearSelection() {
    set({ selectedIds: [] });
  },

  // --- New tree operations ---
  async createNode({ nodeType, parentId, afterId, title }) {
    const { projectId, nodes } = get();
    const siblings = nodes.filter((n) => n.parentId === parentId);
    const sortOrder = nextSortOrder(siblings, afterId);
    const settingsState = useSettingsStore.getState();
    const scenePrefix = settingsState.get(
      "tree.sceneNaming",
      i18next.t("tree.defaultScene"),
    );
    const notePrefix = settingsState.get(
      "tree.noteNaming",
      i18next.t("tree.defaultNote"),
    );
    const folderNaming = settingsState.get("tree.folderNaming", "auto");
    const numberingScope = settingsState.get("tree.numberingScope", "project");

    let defaultTitle: string;
    if (title !== undefined) {
      defaultTitle = title;
    } else if (nodeType === "folder") {
      defaultTitle = computeFolderTitle(parentId, nodes, folderNaming);
    } else {
      const prefix = nodeType === "scene" ? scenePrefix : notePrefix;
      if (prefix) {
        const n = computeNextNumber(
          nodeType,
          parentId,
          afterId,
          nodes,
          prefix,
          numberingScope,
        );
        defaultTitle = `${prefix} ${n}`;
      } else {
        defaultTitle =
          nodeType === "scene"
            ? i18next.t("tree.defaultScene")
            : i18next.t("tree.defaultNote");
      }
    }
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
      // Expand parent folder so the new node is visible
      const expandedIds =
        parentId && !state.expandedIds.includes(parentId)
          ? [...state.expandedIds, parentId]
          : state.expandedIds;
      return {
        nodes: updated,
        scenes: newScenes,
        activeSceneId: nodeType === "scene" ? newNode.id : state.activeSceneId,
        expandedIds,
        pendingRenameId: newNode.id,
        // Folders don't open a tab, so trigger reveal explicitly to scroll
        // the new folder into view. Scenes/notes scroll via the activeSceneId
        // path (notes through tab open → setActiveScene), so leave those.
        // Gate on autoRevealActiveScene to keep parity with scene/note —
        // turning the setting off should suppress folder auto-scroll too.
        pendingRevealId:
          nodeType === "folder" && state.autoRevealActiveScene
            ? newNode.id
            : state.pendingRevealId,
      };
    });
    usePhaseStore.getState().recomputeSceneOrder(get().nodes);

    if (!useGlobalHistoryStore.getState().isReplaying) {
      const captured = { ...newNode };
      const createLabel =
        newNode.nodeType === "scene"
          ? "シーン作成"
          : newNode.nodeType === "folder"
            ? "フォルダー作成"
            : "ノート作成";
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: createLabel,
        async undo() {
          await api.deleteNode(captured.id);
          set((state) => {
            const nodes = state.nodes.filter((n) => n.id !== captured.id);
            return { nodes, scenes: computeScenes(nodes) };
          });
          useTabStore.getState().closeTab(captured.id);
          useTabStore.getState().closeSecondaryTab(captured.id);
        },
        async redo() {
          const recreated = await api.createNode({
            id: captured.id,
            projectId: captured.projectId,
            parentId: captured.parentId ?? undefined,
            nodeType: captured.nodeType,
            title: captured.title,
            sortOrder: captured.sortOrder,
            status: captured.status ?? undefined,
          });
          const node = toNodeData(recreated);
          set((state) => {
            const updated = [...state.nodes, node];
            const expandedIds =
              captured.parentId &&
              !state.expandedIds.includes(captured.parentId)
                ? [...state.expandedIds, captured.parentId]
                : state.expandedIds;
            return {
              nodes: updated,
              scenes: computeScenes(updated),
              activeSceneId:
                node.nodeType === "scene" ? node.id : state.activeSceneId,
              expandedIds,
            };
          });
          if (node.nodeType === "scene" || node.nodeType === "note") {
            useTabStore.getState().openPinned(node.id);
          }
        },
      });
    }

    return newNode;
  },

  async updateNodeTitle(id, title) {
    const oldTitle = get().nodes.find((n) => n.id === id)?.title ?? "";
    await api.updateNode(id, { title });
    set((state) => {
      const nodes = state.nodes.map((n) => (n.id === id ? { ...n, title } : n));
      return { nodes, scenes: computeScenes(nodes) };
    });
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "リネーム",
        async undo() {
          await api.updateNode(id, { title: oldTitle });
          set((state) => {
            const nodes = state.nodes.map((n) =>
              n.id === id ? { ...n, title: oldTitle } : n,
            );
            return { nodes, scenes: computeScenes(nodes) };
          });
        },
        async redo() {
          await api.updateNode(id, { title });
          set((state) => {
            const nodes = state.nodes.map((n) =>
              n.id === id ? { ...n, title } : n,
            );
            return { nodes, scenes: computeScenes(nodes) };
          });
        },
      });
    }
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

    // Capture snapshots before deletion so we can restore on undo
    const trackHistory = !useGlobalHistoryStore.getState().isReplaying;
    const deletedNodes = nodes.filter((n) => toDelete.has(n.id));
    const contentSnapshots: Record<string, string> = {};
    if (trackHistory) {
      for (const node of deletedNodes) {
        if (node.nodeType === "scene") {
          try {
            contentSnapshots[node.id] = await api.loadSceneContent(node.id);
          } catch {
            contentSnapshots[node.id] = "";
          }
        }
      }
    }
    const prevActiveSceneId = activeSceneId;

    // Delete from DB (leaf-first to avoid FK issues). Track ids that
    // succeeded so a partial failure leaves in-memory state and DB in sync
    // and we can skip pushing an un-redoable history entry.
    const successfullyDeleted = new Set<string>();
    let partialFailure = false;
    for (const delId of [...toDelete].reverse()) {
      try {
        await api.deleteNode(delId);
        successfullyDeleted.add(delId);
      } catch (err) {
        partialFailure = true;
        toast.error("ノード削除に失敗しました", { description: String(err) });
        break;
      }
    }
    const remaining = nodes.filter((n) => !successfullyDeleted.has(n.id));
    const newScenes = computeScenes(remaining);
    const newActive = successfullyDeleted.has(activeSceneId)
      ? (newScenes[0]?.id ?? "")
      : activeSceneId;
    set({ nodes: remaining, scenes: newScenes, activeSceneId: newActive });
    usePhaseStore.getState().recomputeSceneOrder(remaining);
    // Close editor tabs only for nodes that actually got deleted.
    const tabStore = useTabStore.getState();
    for (const delId of successfullyDeleted) {
      tabStore.closeTab(delId);
      tabStore.closeSecondaryTab(delId);
    }

    // Partial failure: undo would try to recreate rows still present in DB
    // and redo would re-traverse a tree whose shape we never finished
    // mutating. Skip the history push entirely so the timeline cannot
    // replay an inconsistent state.
    if (partialFailure) return;

    // Trash 連携: 削除に成功した scene のみをキャプチャ。
    // フォルダ自体はキャプチャしない (中の scene だけが trash に積まれる仕様)。
    // note も対象外 (未対応 subKind)。
    const trashTempIds = new Map<string, string>();
    if (trackHistory) {
      for (const node of deletedNodes) {
        if (!successfullyDeleted.has(node.id)) continue;
        if (node.nodeType !== "scene") continue;
        const tempId = `trash-${node.nodeType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${node.id}`;
        trashTempIds.set(node.id, tempId);
        const folderHintName =
          deletedNodes.find((n) => n.id === node.parentId)?.title ??
          nodes.find((n) => n.id === node.parentId)?.title ??
          null;
        captureSceneDeletion({
          projectId: node.projectId,
          node,
          content: contentSnapshots[node.id] ?? "",
          folderHintName,
          tempId,
        });
      }
    }

    if (trackHistory) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "削除",
        async undo() {
          // 1500ms 以内 Ctrl+Z 吸収: trash 保留を全 cancel
          for (const tempId of trashTempIds.values()) {
            useTrashBinStore.getState().cancelPending({ tempId });
          }
          // Restore nodes (parents before children)
          const sorted = topologicalSort(deletedNodes);
          for (const node of sorted) {
            await api.createNode({
              id: node.id,
              projectId: node.projectId,
              parentId: node.parentId ?? undefined,
              nodeType: node.nodeType,
              title: node.title,
              synopsis: node.synopsis ?? undefined,
              sortOrder: node.sortOrder,
              status: node.status ?? undefined,
            });
            if (
              node.nodeType === "scene" &&
              contentSnapshots[node.id] !== undefined
            ) {
              await api.saveSceneContent(node.id, contentSnapshots[node.id]);
            }
          }
          set((state) => {
            const updated = [...state.nodes, ...deletedNodes];
            return {
              nodes: updated,
              scenes: computeScenes(updated),
              activeSceneId: prevActiveSceneId,
            };
          });
        },
        async redo() {
          // Re-delete from the same root, collecting current descendants
          const currentNodes = get().nodes;
          const currentToDelete = new Set<string>();
          const q = [id];
          while (q.length > 0) {
            const cur = q.shift()!;
            if (!currentNodes.find((n) => n.id === cur)) continue;
            currentToDelete.add(cur);
            currentNodes
              .filter((n) => n.parentId === cur)
              .forEach((c) => q.push(c.id));
          }
          for (const delId of [...currentToDelete].reverse()) {
            await api.deleteNode(delId);
          }
          const rem = currentNodes.filter((n) => !currentToDelete.has(n.id));
          const sc = computeScenes(rem);
          const curActive = get().activeSceneId;
          const nextActive = currentToDelete.has(curActive)
            ? (sc[0]?.id ?? "")
            : curActive;
          set({ nodes: rem, scenes: sc, activeSceneId: nextActive });
          const tb = useTabStore.getState();
          for (const delId of [...currentToDelete]) {
            tb.closeTab(delId);
            tb.closeSecondaryTab(delId);
          }
        },
      });
    }
  },

  async updateSynopsis(id, synopsis) {
    const oldSynopsis = get().nodes.find((n) => n.id === id)?.synopsis ?? null;
    await api.updateNode(id, { synopsis });
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, synopsis } : n)),
    }));
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "synopsis 更新",
        async undo() {
          await api.updateNode(id, { synopsis: oldSynopsis ?? undefined });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, synopsis: oldSynopsis } : n,
            ),
          }));
        },
        async redo() {
          await api.updateNode(id, { synopsis });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, synopsis } : n,
            ),
          }));
        },
      });
    }
  },

  async setStatus(id, status) {
    const oldStatus = get().nodes.find((n) => n.id === id)?.status ?? null;
    await api.updateNode(id, { status });
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, status } : n)),
    }));
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "ステータス変更",
        async undo() {
          await api.updateNode(id, {
            status: (oldStatus as SceneStatus) ?? undefined,
          });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, status: oldStatus } : n,
            ),
          }));
        },
        async redo() {
          await api.updateNode(id, { status });
          set((state) => ({
            nodes: state.nodes.map((n) => (n.id === id ? { ...n, status } : n)),
          }));
        },
      });
    }
  },

  async updateStoryTime(id, order, label) {
    const node = get().nodes.find((n) => n.id === id);
    if (!node) return;
    const oldOrder = node.storyTimeOrder;
    const oldLabel = node.storyTimeLabel;
    const patch: Parameters<typeof api.updateNode>[1] = {
      storyTimeOrder: order ?? undefined,
    };
    if (label !== undefined) patch.storyTimeLabel = label;
    await api.updateNode(id, patch);
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              storyTimeOrder: order,
              storyTimeLabel: label !== undefined ? label : n.storyTimeLabel,
            }
          : n,
      ),
    }));
    usePhaseStore.getState().recomputeSceneOrder(get().nodes);
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "時系列順変更",
        async undo() {
          const undoPatch: Parameters<typeof api.updateNode>[1] = {
            storyTimeOrder: oldOrder ?? undefined,
            storyTimeLabel: oldLabel ?? undefined,
          };
          await api.updateNode(id, undoPatch);
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? { ...n, storyTimeOrder: oldOrder, storyTimeLabel: oldLabel }
                : n,
            ),
          }));
          usePhaseStore.getState().recomputeSceneOrder(get().nodes);
        },
        async redo() {
          await api.updateNode(id, patch);
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    storyTimeOrder: order,
                    storyTimeLabel:
                      label !== undefined ? label : n.storyTimeLabel,
                  }
                : n,
            ),
          }));
          usePhaseStore.getState().recomputeSceneOrder(get().nodes);
        },
      });
    }
  },

  async updatePovCharacter(id, codexEntryId) {
    await api.updateNode(id, {
      povCharacterId: codexEntryId,
    });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, povCharacterId: codexEntryId } : n,
      ),
    }));
  },

  async updateLocation(id, codexEntryId) {
    await api.updateNode(id, {
      locationId: codexEntryId,
    });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, locationId: codexEntryId } : n,
      ),
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
    const containers = get().nodes.filter((n) => n.nodeType === "folder");
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

  setSortMode(mode) {
    set({ sortMode: mode });
  },

  setStatusFilter(status) {
    set({ statusFilter: status });
  },

  toggleLabelFilter(id) {
    set((state) => ({
      labelFilter: state.labelFilter.includes(id)
        ? state.labelFilter.filter((x) => x !== id)
        : [...state.labelFilter, id],
    }));
  },

  setLabelFilter(ids) {
    set({ labelFilter: ids });
  },

  clearLabelFilter() {
    set({ labelFilter: [] });
  },

  async moveNode(id, newParentId, afterId) {
    const { nodes } = get();
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const siblings = nodes
      .filter((n) => n.parentId === newParentId && n.id !== id)
      .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

    // afterId semantics:
    //   null      → insert before first sibling (prepend)
    //   undefined → append after last sibling
    //   string    → insert after the named sibling
    let sortOrder: string;
    if (afterId === null) {
      const first = siblings[0];
      sortOrder = generateKeyBetween(null, first ? first.sortOrder : null);
    } else if (afterId === undefined) {
      const last = siblings[siblings.length - 1];
      sortOrder = generateKeyBetween(last ? last.sortOrder : null, null);
    } else {
      const idx = siblings.findIndex((n) => n.id === afterId);
      if (idx === -1) {
        const last = siblings[siblings.length - 1];
        sortOrder = generateKeyBetween(last ? last.sortOrder : null, null);
      } else {
        const after = siblings[idx];
        const next = siblings[idx + 1];
        sortOrder = generateKeyBetween(
          after.sortOrder,
          next ? next.sortOrder : null,
        );
      }
    }

    const oldParentId = node.parentId;
    const oldSortOrder = node.sortOrder;

    // Optimistic update: apply state change immediately so the UI reflects the
    // new order without waiting for the DB round-trip.
    set((state) => {
      const updated = state.nodes.map((n) =>
        n.id === id ? { ...n, parentId: newParentId, sortOrder } : n,
      );
      return { nodes: updated, scenes: computeScenes(updated) };
    });
    usePhaseStore.getState().recomputeSceneOrder(get().nodes);

    // Register Undo immediately, BEFORE the DB await. The in-memory state is
    // already updated; making Undo wait on the DB round-trip means a freshly-
    // dropped card cannot be undone for 100s of ms (visible UX glitch under
    // slow disk). Both undo() and redo() do their own api.updateNode call, so
    // ordering with the foreground write is fine.
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "移動",
        async undo() {
          await api.updateNode(id, {
            parentId: oldParentId,
            sortOrder: oldSortOrder,
          });
          set((state) => {
            const updated = state.nodes.map((n) =>
              n.id === id
                ? { ...n, parentId: oldParentId, sortOrder: oldSortOrder }
                : n,
            );
            return { nodes: updated, scenes: computeScenes(updated) };
          });
        },
        async redo() {
          await api.updateNode(id, {
            parentId: newParentId,
            sortOrder,
          });
          set((state) => {
            const updated = state.nodes.map((n) =>
              n.id === id ? { ...n, parentId: newParentId, sortOrder } : n,
            );
            return { nodes: updated, scenes: computeScenes(updated) };
          });
        },
      });
    }

    // NOTE: pass `newParentId` directly — `?? undefined` would coerce null to
    // undefined, and Drizzle omits undefined keys from the SET clause, so the
    // parent_id column would never be cleared. That made "move to root" silently
    // skip the DB write while still applying the optimistic in-memory update.
    await api.updateNode(id, {
      parentId: newParentId,
      sortOrder,
    });
  },

  setCharCount(id, count) {
    // Zustand v5 の setState は updater が `{}` を返しても新 state を作って
    // listener 全員に通知してしまうため、updater 内で早期 return すると無駄な
    // 再評価が走る (Phase 3 計測で打鍵中 longtask の主犯と判明)。set 自体を
    // skip する。statSync (200ms debounce) 経由で打鍵中に呼ばれる。
    if (get().charCounts[id] === count) return;
    set((state) => ({ charCounts: { ...state.charCounts, [id]: count } }));
  },

  setNodePreview(id, next) {
    const prev = get().nodePreviews[id];
    const placedNext =
      next.placed === undefined ? (prev?.placed ?? null) : next.placed;
    const unplacedNext =
      next.unplaced === undefined ? (prev?.unplaced ?? null) : next.unplaced;
    if (prev && prev.placed === placedNext && prev.unplaced === unplacedNext) {
      return;
    }
    if (!prev && placedNext === null && unplacedNext === null) {
      return;
    }
    set((state) => ({
      nodePreviews: {
        ...state.nodePreviews,
        [id]: { placed: placedNext, unplaced: unplacedNext },
      },
    }));
  },

  setAiRatios(ratios) {
    set({ aiRatios: ratios });
  },

  async refreshAiRatio(nodeId) {
    try {
      const ratios = await loadBatchAiRatio([nodeId]);
      set((state) => ({
        aiRatios: { ...state.aiRatios, ...ratios },
      }));
    } catch {
      // ignore
    }
  },

  setShowWordCounts(v) {
    set({ showWordCounts: v });
  },

  setShowStatusDots(v) {
    set({ showStatusDots: v });
  },

  setShowLabelDots(v) {
    set({ showLabelDots: v });
  },

  setShowAiAttribution(v) {
    set({ showAiAttribution: v });
  },

  setAutoRevealActiveScene(v) {
    set({ autoRevealActiveScene: v });
  },

  togglePinnedCodex(id) {
    const wasPinned = get().pinnedCodexIds.includes(id);
    set((state) => ({
      pinnedCodexIds: wasPinned
        ? state.pinnedCodexIds.filter((x) => x !== id)
        : [...state.pinnedCodexIds, id],
    }));
    if (wasPinned) {
      removePinnedCodex(id).catch(() => {});
    } else {
      addPinnedCodex(id).catch(() => {});
    }
  },

  async loadPinnedCodexIds() {
    const ids = await listPinnedCodexIds();
    set({ pinnedCodexIds: ids });
  },

  setPendingRenameId(id) {
    set({ pendingRenameId: id });
  },

  pendingRevealId: null,

  revealInTree(id) {
    // Expand all ancestor folders so the node is visible
    const nodeMap = Object.fromEntries(get().nodes.map((n) => [n.id, n]));
    const ancestors: string[] = [];
    let cur = nodeMap[id];
    while (cur?.parentId) {
      ancestors.push(cur.parentId);
      cur = nodeMap[cur.parentId];
    }
    if (ancestors.length > 0) {
      set((state) => ({
        expandedIds: [...new Set([...state.expandedIds, ...ancestors])],
      }));
    }
    set({ pendingRevealId: id, selectedIds: [id] });
  },
}));

/**
 * Consumer 用 hook。preview レコードが未生成の id でも安定参照の空オブジェクトを
 * 返すので、`?? {placed:null,unplaced:null}` を呼び側で書く必要がない
 * (feedback_zustand_selector_new_ref.md)。
 */
export function useNodeBeatPreview(id: string): NodeBeatPreview {
  return useTreeStore((s) => s.nodePreviews[id] ?? EMPTY_NODE_PREVIEW);
}
