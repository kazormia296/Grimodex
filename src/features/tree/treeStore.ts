import { create } from "zustand";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import * as api from "./api";
import {
  blockIfUnlicensed,
  LICENSE_WRITE_RESTRICTED_ERROR,
} from "@/features/license/gate";
import type { TreeNodeLite as ApiNode } from "./api";
import { loadBatchAiRatio } from "@/features/attribution/api";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useTabStore } from "@/features/editor/tabStore";
import {
  guardInlineAiPending,
  isInlineAiPending,
} from "@/features/editor/inlineAi/pendingGuard";
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
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { moveTreeNode } from "@/application/tree/moveTreeNode";
import { createTreeNode } from "@/application/tree/createTreeNode";
import { deleteTreeSubtree } from "@/application/tree/deleteTreeSubtree";

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
  intent: string | null;
  /** fractional-indexing 文字列キー（base62、辞書順比較） */
  sortOrder: string;
  status: string | null;
  storyTimeOrder: string | null;
  storyTimeLabel: string | null;
  povCharacterId: string | null;
  locationId: string | null;
  /** Chronicle（作中暦日付）— events と同じ日付モデルをシーンに共有（永続化のみ）。
   * 既存の非コア列 (sourceUri 等) と同様 optional。load 時に toNodeData が常に埋める。 */
  chronicleStartTime?: number | null;
  chronicleStartMinute?: number | null;
  chronicleStartGranularity?: string;
  chronicleEndTime?: number | null;
  chronicleEndMinute?: number | null;
  chronicleEndGranularity?: string;
  chroniclePrecision?: string;
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

/** シーンの作中暦日付（chronicle*）への部分更新パッチ。 */
export type ChronicleDatePatch = Partial<
  Pick<
    TreeNodeData,
    | "chronicleStartTime"
    | "chronicleStartMinute"
    | "chronicleStartGranularity"
    | "chronicleEndTime"
    | "chronicleEndMinute"
    | "chronicleEndGranularity"
    | "chroniclePrecision"
  >
>;

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
 * DFS pre-order でプロジェクト全体（`parentId === null` の top-level から）の
 * シーンを sortOrder 順に返す。project スコープの synopsis 集約で使う。
 *
 * treeStore は単一プロジェクト前提のため projectId 引数は不要。
 */
export function getAllProjectScenesInOrder(
  nodes: TreeNodeData[],
): TreeNodeData[] {
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
  const roots = childrenByParent.get(null) ?? [];
  for (const root of roots) {
    if (root.nodeType === "scene") out.push(root);
    else if (root.nodeType === "folder") walk(root.id);
  }
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

/**
 * list 系の軽量行 (TreeNodeLite) と createNode 等の全列行 (TreeNode) の両方を
 * 受ける。note 本文は list 経路では別クエリ (listNoteContents) の結果を
 * `noteContent` で注入し、全列行では行自身の content をそのまま使う。
 * scene の content はどちらの経路でも store に載せない (不変条件)。
 */
function toNodeData(
  n: ApiNode & { content?: string },
  noteContent?: string,
): TreeNodeData {
  const noteBody = noteContent ?? n.content;
  return {
    id: n.id,
    projectId: n.projectId,
    parentId: n.parentId ?? null,
    nodeType: n.nodeType as NodeType,
    title: n.title,
    synopsis: n.synopsis ?? null,
    intent: n.intent ?? null,
    sortOrder: n.sortOrder,
    status: n.status ?? null,
    storyTimeOrder: n.storyTimeOrder ?? null,
    storyTimeLabel: n.storyTimeLabel ?? null,
    povCharacterId: n.povCharacterId ?? null,
    locationId: n.locationId ?? null,
    chronicleStartTime: n.chronicleStartTime ?? null,
    chronicleStartMinute: n.chronicleStartMinute ?? null,
    chronicleStartGranularity: n.chronicleStartGranularity ?? "none",
    chronicleEndTime: n.chronicleEndTime ?? null,
    chronicleEndMinute: n.chronicleEndMinute ?? null,
    chronicleEndGranularity: n.chronicleEndGranularity ?? "none",
    chroniclePrecision: n.chroniclePrecision ?? "exact",
    charCount: n.charCount,
    sourceUri: n.sourceUri ?? null,
    sourceMtime: n.sourceMtime ?? null,
    archivedAt: n.archivedAt ?? null,
    ...(n.nodeType === "note" && noteBody !== undefined
      ? { content: noteBody }
      : {}),
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
  threadFilter: string[]; // plot-thread ids; [] = show all; OR semantics

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
  showPlotThreadTrack: boolean;
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
  /** loadTree と同じ再同期だが、失敗を握りつぶさず throw する版(AI batch executor 用)。 */
  reloadTreeOrThrow: (projectId?: string) => Promise<void>;

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
  updateIntent: (id: string, intent: string) => Promise<void>;
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
  /** シーンの作中暦日付（chronicle*）を永続化＋store 楽観更新する。 */
  updateChronicleDate: (id: string, patch: ChronicleDatePatch) => Promise<void>;

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
  toggleThreadFilter: (id: string) => void;
  setThreadFilter: (ids: string[]) => void;
  clearThreadFilter: () => void;

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
  setShowPlotThreadTrack: (v: boolean) => void;
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

/** Sort nodes so parents appear before their children (for restore operations). */

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
  threadFilter: [],
  charCounts: {},
  nodePreviews: {},
  aiRatios: {},
  showWordCounts: true,
  showStatusDots: true,
  showLabelDots: true,
  showPlotThreadTrack: true,
  showAiAttribution: false,
  autoRevealActiveScene: true,
  pinnedCodexIds: [],
  pendingRenameId: null,

  async reloadTreeOrThrow(projectId = getCurrentProjectId()) {
    // reload 失敗を throw する版。AI バッチ executor のように「DB commit 後の
    // 再同期失敗を成功扱いにできない」呼び出し元が使う。loadTree はこれを
    // try/catch で包んで従来どおり握りつぶす。
    set({ isLoading: true, projectId });
    try {
      // listNodes は content / unplacedBeatsDoc を引かない軽量 projection (H4)。
      // note 本文だけ 2 段目クエリで取り、note ノードにマージする
      // (scene 本文は store 外に保つ不変条件は toNodeData 側で維持)。
      const [raw, noteContents] = await Promise.all([
        api.listNodes(projectId),
        api.listNoteContents(projectId),
      ]);
      const nodes = raw.map((n) => toNodeData(n, noteContents.get(n.id)));
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
    } catch (e) {
      // 失敗を握りつぶさず再 throw する契約は維持しつつ、isLoading を解除して
      // 「読み込み中のまま固まる」スピナー stuck を防ぐ(直接呼び出し元向け)。
      set({ isLoading: false });
      throw e;
    }
  },

  async loadTree(projectId = getCurrentProjectId()) {
    try {
      await get().reloadTreeOrThrow(projectId);
    } catch {
      set({ isLoading: false });
    }
  },

  // --- Backward-compat methods ---
  async loadScenes(projectId, _chapterId) {
    await get().loadTree(projectId);
  },

  async createScene() {
    if (blockIfUnlicensed()) throw new Error(LICENSE_WRITE_RESTRICTED_ERROR);
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
    usePhaseStore.getState().recomputeSceneOrder(get().nodes);
    recordChangeEvent({
      domain: "grid",
      opType: "scene.create",
      entityType: "scene",
      entityId: created.id,
      sceneId: created.id,
      payload: {
        parentId: newNode.parentId,
        sortOrder: newNode.sortOrder,
        title: newNode.title,
      },
    });
    return created.id;
  },

  async createNote() {
    if (blockIfUnlicensed()) throw new Error(LICENSE_WRITE_RESTRICTED_ERROR);
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
      title: i18next.t("tree.defaultNewNote"),
      sortOrder,
    });
    const newNode = toNodeData(created);
    set((state) => {
      const nodes = [...state.nodes, newNode];
      return { nodes, scenes: computeScenes(nodes) };
    });
    recordChangeEvent({
      domain: "grid",
      opType: "note.create",
      entityType: "note",
      entityId: created.id,
      payload: {
        parentId: newNode.parentId,
        sortOrder: newNode.sortOrder,
        title: newNode.title,
      },
    });
    return created.id;
  },

  async deleteScene(id) {
    const { scenes } = get();
    await api.deleteNode(id);
    recordChangeEvent({
      domain: "grid",
      opType: "scene.delete",
      entityType: "scene",
      entityId: id,
      sceneId: null,
      payload: { id },
    });
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
    // 二重防御。TabBar 系の主防御 (tabStore guard) を素通りした直接呼び出しや、
    // activeSceneId 起点の ensure-tab → openPreview 経路を pending 中に止める。
    if (id !== get().activeSceneId && guardInlineAiPending()) return;
    markStart("treeStore.setActiveScene");
    try {
      set({ activeSceneId: id });
    } finally {
      markEnd("treeStore.setActiveScene");
    }
  },

  // --- Multi-selection ---
  selectNode(id, extend) {
    // selectNode は activeSceneId=id を必ずセットする (= owner エディタが reload)。
    if (id !== get().activeSceneId && guardInlineAiPending()) return;
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
    return createTreeNode(
      { nodeType, parentId, afterId, title },
      {
        ensureWritable: () => {
          if (blockIfUnlicensed()) {
            throw new Error(LICENSE_WRITE_RESTRICTED_ERROR);
          }
        },
        getProjectId: () => get().projectId,
        getNodes: () => get().nodes,
        getSetting: (key, fallback) =>
          useSettingsStore.getState().get(key, fallback),
        createPersisted: async (record) => {
          const created = await api.createNode({
            id: record.id,
            projectId: record.projectId,
            parentId: record.parentId ?? undefined,
            nodeType: record.nodeType,
            title: record.title,
            sortOrder: record.sortOrder,
          });
          return toNodeData(created);
        },
        deletePersisted: (id) => api.deleteNode(id),
        recreatePersisted: async (node) => {
          const recreated = await api.createNode({
            id: node.id,
            projectId: node.projectId,
            parentId: node.parentId ?? undefined,
            nodeType: node.nodeType,
            title: node.title,
            sortOrder: node.sortOrder,
            synopsis: node.synopsis ?? undefined,
            status: node.status ?? undefined,
          });
          return toNodeData(recreated);
        },
        applyCreated: (node, mode) => {
          set((state) => {
            const nodes = [...state.nodes, node];
            const expandedIds =
              node.parentId && !state.expandedIds.includes(node.parentId)
                ? [...state.expandedIds, node.parentId]
                : state.expandedIds;
            return {
              nodes,
              scenes: computeScenes(nodes),
              activeSceneId:
                node.nodeType === "scene" &&
                (mode === "redo" || !isInlineAiPending())
                  ? node.id
                  : state.activeSceneId,
              expandedIds,
              pendingRenameId:
                mode === "create" ? node.id : state.pendingRenameId,
              pendingRevealId:
                mode === "create" &&
                node.nodeType === "folder" &&
                state.autoRevealActiveScene
                  ? node.id
                  : state.pendingRevealId,
            };
          });
        },
        applyRemoved: (id) => {
          set((state) => {
            const nodes = state.nodes.filter((node) => node.id !== id);
            return { nodes, scenes: computeScenes(nodes) };
          });
        },
        recomputeSceneOrder: (nodes) =>
          usePhaseStore.getState().recomputeSceneOrder([...nodes]),
        closeTabs: (id) => {
          useTabStore.getState().closeTab(id);
          useTabStore.getState().closeSecondaryTab(id);
        },
        openPinned: (id) => useTabStore.getState().openPinned(id),
        isReplaying: () => useGlobalHistoryStore.getState().isReplaying,
        pushHistory: (command) =>
          useGlobalHistoryStore.getState().push(command),
        recordChange: ({ entityType, entityId, sceneId, payload }) =>
          recordChangeEvent({
            domain: "grid",
            opType: "node.create",
            entityType,
            entityId,
            sceneId,
            payload,
          }),
      },
    );
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
        label: i18next.t("tree.undo.renamed"),
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
    await deleteTreeSubtree(id, {
      guardPending: guardInlineAiPending,
      getNodes: () => get().nodes,
      getActiveSceneId: () => get().activeSceneId,
      loadSceneContent: (nodeId) => api.loadSceneContent(nodeId),
      deletePersisted: (nodeId) => api.deleteNode(nodeId),
      restorePersisted: async (node) => {
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
      },
      saveSceneContent: (nodeId, content) =>
        api.saveSceneContent(nodeId, content).then(() => {}),
      applyNodes: (nodes, activeSceneId) =>
        set({ nodes, scenes: computeScenes(nodes), activeSceneId }),
      recomputeSceneOrder: (nodes) =>
        usePhaseStore.getState().recomputeSceneOrder([...nodes]),
      isReplaying: () => useGlobalHistoryStore.getState().isReplaying,
      pushHistory: (command) => useGlobalHistoryStore.getState().push(command),
      closeTabs: (nodeId) => {
        useTabStore.getState().closeTab(nodeId);
        useTabStore.getState().closeSecondaryTab(nodeId);
      },
      captureTrash: (input) => captureSceneDeletion(input),
      cancelTrash: (tempId) =>
        useTrashBinStore.getState().cancelPending({ tempId }),
      makeTrashTempId: (node) =>
        `trash-${node.nodeType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${node.id}`,
      recordChange: ({
        rootId,
        deletedIds,
        partialFailure,
        previousActiveSceneId,
      }) =>
        recordChangeEvent({
          domain: "grid",
          opType: "node.delete",
          entityType: "node",
          entityId: id,
          sceneId: null,
          payload: {
            rootId,
            deletedIds,
            partialFailure,
            prevActiveSceneId: previousActiveSceneId,
          },
        }),
      notifyDeleteFailure: (error) =>
        toast.error(i18next.t("tree.errors.deleteFailed"), {
          description: String(error),
        }),
      deletedLabel: i18next.t("tree.undo.deleted"),
    });
  },

  async updateSynopsis(id, synopsis) {
    const oldSynopsis = get().nodes.find((n) => n.id === id)?.synopsis ?? null;
    await api.updateNode(id, { synopsis });
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, synopsis } : n)),
    }));
    recordChangeEvent({
      domain: "synopsis",
      opType: "update",
      entityType: "tree_node",
      entityId: id,
      sceneId: id,
      payload: { before: oldSynopsis, after: synopsis },
    });
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.synopsisUpdated"),
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

  async updateIntent(id, intent) {
    const oldIntent = get().nodes.find((n) => n.id === id)?.intent ?? null;
    await api.updateNode(id, { intent });
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, intent } : n)),
    }));
    recordChangeEvent({
      domain: "intent",
      opType: "update",
      entityType: "tree_node",
      entityId: id,
      sceneId: id,
      payload: { before: oldIntent, after: intent },
    });
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.intentUpdated"),
        async undo() {
          await api.updateNode(id, { intent: oldIntent ?? undefined });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, intent: oldIntent } : n,
            ),
          }));
        },
        async redo() {
          await api.updateNode(id, { intent });
          set((state) => ({
            nodes: state.nodes.map((n) => (n.id === id ? { ...n, intent } : n)),
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
        label: i18next.t("tree.undo.statusChanged"),
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
      // null is a persisted value (Unscheduled), while undefined means
      // "leave unchanged" to Drizzle. Never collapse null into undefined.
      storyTimeOrder: order,
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
        label: i18next.t("tree.undo.storyTimeChanged"),
        async undo() {
          const undoPatch: Parameters<typeof api.updateNode>[1] = {
            storyTimeOrder: oldOrder,
            storyTimeLabel: oldLabel,
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
    const node = get().nodes.find((n) => n.id === id);
    if (!node) return;
    const old = node.povCharacterId ?? null;
    if (old === codexEntryId) return; // 同値は書込み・履歴とも no-op（ドラッグ等の空振り対策）
    await api.updateNode(id, { povCharacterId: codexEntryId });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, povCharacterId: codexEntryId } : n,
      ),
    }));
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.povCharacterChanged"),
        entityId: id,
        async undo() {
          await api.updateNode(id, { povCharacterId: old });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, povCharacterId: old } : n,
            ),
          }));
        },
        async redo() {
          await api.updateNode(id, { povCharacterId: codexEntryId });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, povCharacterId: codexEntryId } : n,
            ),
          }));
        },
      });
    }
  },

  async updateLocation(id, codexEntryId) {
    const node = get().nodes.find((n) => n.id === id);
    if (!node) return;
    const old = node.locationId ?? null;
    if (old === codexEntryId) return; // 同値は no-op
    await api.updateNode(id, { locationId: codexEntryId });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, locationId: codexEntryId } : n,
      ),
    }));
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.locationChanged"),
        entityId: id,
        async undo() {
          await api.updateNode(id, { locationId: old });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, locationId: old } : n,
            ),
          }));
        },
        async redo() {
          await api.updateNode(id, { locationId: codexEntryId });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, locationId: codexEntryId } : n,
            ),
          }));
        },
      });
    }
  },

  async updateChronicleDate(id, patch) {
    const node = get().nodes.find((n) => n.id === id);
    if (!node) return;
    // 変更キーの旧値を集め、実変更が無ければ no-op（履歴を汚さない）。
    // 時刻/分は nullable → null 復元、粒度/確度は NOT NULL → 既定へ復元。
    const restore: ChronicleDatePatch = {};
    let changed = false;
    if ("chronicleStartTime" in patch) {
      restore.chronicleStartTime = node.chronicleStartTime ?? null;
      if (
        (node.chronicleStartTime ?? null) !== (patch.chronicleStartTime ?? null)
      )
        changed = true;
    }
    if ("chronicleStartMinute" in patch) {
      restore.chronicleStartMinute = node.chronicleStartMinute ?? null;
      if (
        (node.chronicleStartMinute ?? null) !==
        (patch.chronicleStartMinute ?? null)
      )
        changed = true;
    }
    if ("chronicleStartGranularity" in patch) {
      restore.chronicleStartGranularity =
        node.chronicleStartGranularity ?? "none";
      if (
        (node.chronicleStartGranularity ?? "none") !==
        (patch.chronicleStartGranularity ?? "none")
      )
        changed = true;
    }
    if ("chronicleEndTime" in patch) {
      restore.chronicleEndTime = node.chronicleEndTime ?? null;
      if ((node.chronicleEndTime ?? null) !== (patch.chronicleEndTime ?? null))
        changed = true;
    }
    if ("chronicleEndMinute" in patch) {
      restore.chronicleEndMinute = node.chronicleEndMinute ?? null;
      if (
        (node.chronicleEndMinute ?? null) !== (patch.chronicleEndMinute ?? null)
      )
        changed = true;
    }
    if ("chronicleEndGranularity" in patch) {
      restore.chronicleEndGranularity = node.chronicleEndGranularity ?? "none";
      if (
        (node.chronicleEndGranularity ?? "none") !==
        (patch.chronicleEndGranularity ?? "none")
      )
        changed = true;
    }
    if ("chroniclePrecision" in patch) {
      restore.chroniclePrecision = node.chroniclePrecision ?? "exact";
      if (
        (node.chroniclePrecision ?? "exact") !==
        (patch.chroniclePrecision ?? "exact")
      )
        changed = true;
    }
    if (!changed) return;
    await api.updateNode(id, patch);
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }));
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.chronicleDateChanged"),
        entityId: id,
        async undo() {
          await api.updateNode(id, restore);
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, ...restore } : n,
            ),
          }));
        },
        async redo() {
          await api.updateNode(id, patch);
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id ? { ...n, ...patch } : n,
            ),
          }));
        },
      });
    }
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

  toggleThreadFilter(id) {
    set((state) => ({
      threadFilter: state.threadFilter.includes(id)
        ? state.threadFilter.filter((x) => x !== id)
        : [...state.threadFilter, id],
    }));
  },

  setThreadFilter(ids) {
    set({ threadFilter: ids });
  },

  clearThreadFilter() {
    set({ threadFilter: [] });
  },

  async moveNode(id, newParentId, afterId) {
    await moveTreeNode(id, newParentId, afterId, {
      getNodes: () => get().nodes,
      applyNodes: (nodes) => set({ nodes, scenes: computeScenes(nodes) }),
      persist: (nodeId, patch) => api.updateNode(nodeId, patch).then(() => {}),
      recomputeSceneOrder: (nodes) =>
        usePhaseStore.getState().recomputeSceneOrder([...nodes]),
      isReplaying: () => useGlobalHistoryStore.getState().isReplaying,
      pushHistory: (command) => useGlobalHistoryStore.getState().push(command),
      recordChange: ({ entityType, entityId, sceneId, payload }) =>
        recordChangeEvent({
          domain: "grid",
          opType: "node.move",
          entityType,
          entityId,
          sceneId,
          payload,
        }),
      movedLabel: i18next.t("tree.undo.moved"),
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
      // 結果に無いノード (シーンが空になった等) は key ごと削除する。
      // spread マージだけだと旧 % がツリー再ロードまで残留するし、
      // 0 を書くと初期一括ロード (省略=key無し) と表示が食い違う。
      set((state) => {
        const next = { ...state.aiRatios };
        if (nodeId in ratios) next[nodeId] = ratios[nodeId];
        else delete next[nodeId];
        return { aiRatios: next };
      });
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

  setShowPlotThreadTrack(v) {
    set({ showPlotThreadTrack: v });
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
