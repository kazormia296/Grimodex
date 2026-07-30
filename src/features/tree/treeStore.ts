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
import { readRuntimeSetting } from "@/features/settings/runtimeSettings";
import {
  activeEditorDocumentIds,
  closeEditorDocumentTabs,
} from "@/features/editor/tabCommands";
import {
  guardInlineAiPending,
  isInlineAiPending,
} from "@/features/editor/inlineAi/pendingGuard";
import { markStart, markEnd } from "@/lib/perfLog";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  cancelPendingTrash,
  captureSceneDeletion,
} from "@/features/trash-bin/captureHooks";
import {
  listPinnedCodexIds,
  addPinnedCodex,
  removePinnedCodex,
} from "./codexQuickPinApi";
import { recomputeCodexSceneOrder } from "@/features/codex/phaseProjection";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { cmpKeys, generateKeyBetween } from "./fractionalIndex";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { moveTreeNode } from "@/application/tree/moveTreeNode";
import { createTreeNode } from "@/application/tree/createTreeNode";
import { deleteTreeSubtree } from "@/application/tree/deleteTreeSubtree";
import { requestOpenEditorDocument } from "@/application/editor/editorNavigationRegistry";
import {
  getCurrentWorkspaceIdentity,
  isCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import {
  hasExternalEditConflictForId,
  hasExternalEditConflictForKind,
} from "@/lib/externalEditConflictRegistry";
import {
  observeTreeNodeMutationTimestamp,
  subscribeTreeNodeMutations,
} from "@/lib/treeNodeMutationRegistry";
import {
  serializeSceneWrite,
  trackSceneContentWrite,
} from "./pendingSceneWrites";
import type { NodeType, SceneStatus, TreeNodeData } from "./types";

export type { NodeType, SceneStatus, TreeNodeData } from "./types";

function activeEditorHasExternalConflict(): boolean {
  const tabs = activeEditorDocumentIds();
  if (tabs.isLinearMode) {
    return hasExternalEditConflictForKind("tree", { includeLegacy: true });
  }
  return [tabs.activeTabId, tabs.secondaryActiveTabId].some(
    (id) => id !== null && hasExternalEditConflictForId(id),
  );
}

/**
 * Application-owned metadata patch. Callers persist through `patchNode` so the
 * Tree projection cannot diverge from the durable row after a partial update.
 */
export type TreeNodePatch = Omit<
  Partial<
    Pick<
      TreeNodeData,
      | "title"
      | "sortOrder"
      | "parentId"
      | "status"
      | "synopsis"
      | "intent"
      | "storyTimeOrder"
      | "storyTimeLabel"
      | "povCharacterId"
      | "locationId"
      | "chronicleStartTime"
      | "chronicleStartMinute"
      | "chronicleStartGranularity"
      | "chronicleEndTime"
      | "chronicleEndMinute"
      | "chronicleEndGranularity"
      | "chroniclePrecision"
      | "sourceUri"
      | "sourceMtime"
      | "archivedAt"
      | "contextMode"
      | "aliases"
      | "excludedAliases"
    >
  >,
  "aliases" | "excludedAliases"
> & {
  aliases?: string;
  excludedAliases?: string;
};

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

const CHRONICLE_DATE_KEYS = [
  "chronicleStartTime",
  "chronicleStartMinute",
  "chronicleStartGranularity",
  "chronicleEndTime",
  "chronicleEndMinute",
  "chronicleEndGranularity",
] as const satisfies readonly (keyof ChronicleDatePatch)[];

const CHRONICLE_GRANULARITIES = new Set([
  "none",
  "season",
  "year",
  "month",
  "day",
  "time",
]);

type CanonicalChronicleDatePatch = Required<
  Pick<
    ChronicleDatePatch,
    | "chronicleStartTime"
    | "chronicleStartMinute"
    | "chronicleStartGranularity"
    | "chronicleEndTime"
    | "chronicleEndMinute"
    | "chronicleEndGranularity"
  >
>;

interface ChronicleEndpointState {
  day: number | null;
  minute: number | null;
  granularity: string;
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): key is K & keyof T {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeChronicleEndpoint(
  label: "start" | "end",
  current: ChronicleEndpointState,
  patch: {
    day?: number | null;
    minute?: number | null;
    granularity?: string;
  },
): ChronicleEndpointState {
  const writesDay = hasOwn(patch, "day");
  const writesMinute = hasOwn(patch, "minute");
  const writesGranularity = hasOwn(patch, "granularity");
  const day = writesDay ? (patch.day ?? null) : current.day;
  const minute = writesMinute ? (patch.minute ?? null) : current.minute;
  let granularity = writesGranularity
    ? (patch.granularity ?? "none")
    : current.granularity;

  // Mirror the native Chronicle resolver for partial human writes. A supplied
  // minute promotes the endpoint to `time`; clearing its day clears the
  // endpoint; and the first supplied day creates a day-level endpoint.
  if (!writesGranularity) {
    if (day === null) {
      granularity = "none";
    } else if (writesMinute) {
      granularity =
        minute === null
          ? granularity === "time" || granularity === "none"
            ? "day"
            : granularity
          : "time";
    } else if (writesDay && granularity === "none") {
      // A legacy `none` row can still carry a non-semantic minute residue.
      // A day-only write creates a day endpoint; it must not resurrect that
      // residue as an intentional time.
      granularity = "day";
    }
  }

  if (!CHRONICLE_GRANULARITIES.has(granularity)) {
    throw new Error(
      `Chronicle ${label} granularity '${granularity}' is not supported`,
    );
  }
  if (granularity === "none") {
    return { day: null, minute: null, granularity };
  }
  if (day === null) {
    throw new Error(
      `Chronicle ${label} granularity '${granularity}' needs a day`,
    );
  }
  if (!Number.isSafeInteger(day)) {
    throw new Error(`Chronicle ${label} day must be a safe integer`);
  }
  if (granularity !== "time") {
    return { day, minute: null, granularity };
  }
  if (
    minute === null ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute >= 1440
  ) {
    throw new Error(
      `Chronicle ${label} time granularity needs a minute from 0 to 1439`,
    );
  }
  return { day, minute, granularity };
}

function canonicalChronicleDatePatch(
  node: TreeNodeData,
  patch: ChronicleDatePatch,
): CanonicalChronicleDatePatch {
  const start = normalizeChronicleEndpoint(
    "start",
    {
      day: node.chronicleStartTime ?? null,
      minute: node.chronicleStartMinute ?? null,
      granularity: node.chronicleStartGranularity ?? "none",
    },
    {
      ...(hasOwn(patch, "chronicleStartTime")
        ? { day: patch.chronicleStartTime }
        : {}),
      ...(hasOwn(patch, "chronicleStartMinute")
        ? { minute: patch.chronicleStartMinute }
        : {}),
      ...(hasOwn(patch, "chronicleStartGranularity")
        ? { granularity: patch.chronicleStartGranularity }
        : {}),
    },
  );
  const end = normalizeChronicleEndpoint(
    "end",
    {
      day: node.chronicleEndTime ?? null,
      minute: node.chronicleEndMinute ?? null,
      granularity: node.chronicleEndGranularity ?? "none",
    },
    {
      ...(hasOwn(patch, "chronicleEndTime")
        ? { day: patch.chronicleEndTime }
        : {}),
      ...(hasOwn(patch, "chronicleEndMinute")
        ? { minute: patch.chronicleEndMinute }
        : {}),
      ...(hasOwn(patch, "chronicleEndGranularity")
        ? { granularity: patch.chronicleEndGranularity }
        : {}),
    },
  );

  if (end.granularity !== "none" && start.granularity === "none") {
    throw new Error("Chronicle end requires a start");
  }
  if (start.day !== null && end.day !== null) {
    const startMinute = start.granularity === "time" ? start.minute! : 0;
    const endMinute = end.granularity === "time" ? end.minute! : 0;
    if (
      end.day < start.day ||
      (end.day === start.day && endMinute < startMinute)
    ) {
      throw new Error("Chronicle end must not precede start");
    }
  }

  return {
    chronicleStartTime: start.day,
    chronicleStartMinute: start.minute,
    chronicleStartGranularity: start.granularity,
    chronicleEndTime: end.day,
    chronicleEndMinute: end.minute,
    chronicleEndGranularity: end.granularity,
  };
}

function chronicleDateTouched(patch: ChronicleDatePatch): boolean {
  return CHRONICLE_DATE_KEYS.some((key) => hasOwn(patch, key));
}

function chroniclePatchChanged(
  node: TreeNodeData,
  patch: ChronicleDatePatch,
): boolean {
  return Object.entries(patch).some(([key, value]) => {
    const current = node[key as keyof TreeNodeData];
    return !Object.is(current ?? null, value ?? null);
  });
}

export type ChronicleSceneBulkProjectionOperation =
  | { kind: "sceneClearDate"; sceneId: string; baseUpdatedAt: string }
  | {
      kind: "sceneSetPov";
      sceneId: string;
      baseUpdatedAt: string;
      povCharacterId: string | null;
    }
  | {
      kind: "sceneSetDate";
      sceneId: string;
      baseUpdatedAt: string;
      startTime: number;
      startMinute: number | null;
      startGranularity: string;
      endTime: number | null;
      endMinute: number | null;
      endGranularity: string;
    };

export interface ChronicleSceneBulkProjectionResult {
  sceneId: string;
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

export interface TreeHydrationSnapshot {
  projectId: string;
  workspaceOpenRevision: number | null;
  nodes: TreeNodeData[];
  scenes: SceneMeta[];
  activeSceneId: string;
  expandedIds: string[];
  charCounts: Record<string, number>;
  nodePreviews: Record<string, NodeBeatPreview>;
  aiRatios: Record<string, number>;
  pinnedCodexIds: string[];
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

/**
 * Phase A of Project switching: load and derive the complete critical tree
 * projection without mutating the currently visible Project.
 */
export async function prepareTreeHydration(
  projectId: string,
  workspaceOpenRevision?: number,
  previousActiveSceneId = useTreeStore.getState().activeSceneId,
): Promise<TreeHydrationSnapshot> {
  const capturedWorkspaceIdentity = getCurrentWorkspaceIdentity();
  const hydrationWorkspaceOpenRevision = resolveWorkspaceOpenRevision(
    workspaceOpenRevision,
  );
  const pinnedCodexIdsPromise = listPinnedCodexIds().catch(() => []);
  const [raw, noteContents] = await Promise.all([
    api.listNodes(projectId),
    api.listNoteContents(projectId),
  ]);
  const nodes = raw.map((node) => toNodeData(node, noteContents.get(node.id)));
  const scenes = computeScenes(nodes);
  const activeNode = previousActiveSceneId
    ? nodes.find((node) => node.id === previousActiveSceneId)
    : undefined;
  const activeStillExists =
    activeNode?.nodeType === "scene" || activeNode?.nodeType === "note";
  const activeSceneId = activeStillExists
    ? previousActiveSceneId
    : (scenes[0]?.id ?? "");
  const charCounts: Record<string, number> = {};
  for (const node of nodes) {
    if (node.nodeType === "scene" || node.nodeType === "note") {
      charCounts[node.id] = node.charCount;
    }
  }
  const nodePreviews: Record<string, NodeBeatPreview> = {};
  for (const node of raw) {
    const placed = node.placedBeatPreview ?? null;
    const unplaced = node.unplacedBeatPreview ?? null;
    if (placed !== null || unplaced !== null) {
      nodePreviews[node.id] = { placed, unplaced };
    }
  }
  // The editor only needs the foreground Scene's attribution ratio at first
  // paint. Loading every Scene here turns a decorative, default-off Tree
  // badge into a critical 10k-ID query and duplicates the char counts already
  // present in this snapshot. The all-Scene projection is loaded lazily when
  // the user enables the badge.
  const activeSceneRatioIds =
    activeNode?.nodeType === "note" || activeSceneId === ""
      ? []
      : [activeSceneId];
  const [aiRatios, pinnedCodexIds] = await Promise.all([
    loadBatchAiRatio(activeSceneRatioIds).catch(
      (): Record<string, number> => ({}),
    ),
    pinnedCodexIdsPromise,
  ]);
  if (
    capturedWorkspaceIdentity &&
    !isCurrentWorkspaceIdentity(capturedWorkspaceIdentity)
  ) {
    throw new Error("Workspace changed while preparing the Project tree");
  }
  return {
    projectId,
    workspaceOpenRevision: hydrationWorkspaceOpenRevision,
    nodes,
    scenes,
    activeSceneId,
    expandedIds: nodes
      .filter((node) => node.nodeType === "folder")
      .map((node) => node.id),
    charCounts,
    nodePreviews,
    aiRatios,
    pinnedCodexIds,
  };
}

/** Phase B: synchronously publish a previously prepared tree snapshot. */
export function applyTreeHydration(snapshot: TreeHydrationSnapshot): void {
  for (const node of snapshot.nodes) {
    observeTreeNodeMutationTimestamp(node.updatedAt);
  }
  useTreeStore.setState({
    nodes: snapshot.nodes,
    scenes: snapshot.scenes,
    activeSceneId: snapshot.activeSceneId,
    selectedIds: [],
    isLoading: false,
    projectId: snapshot.projectId,
    hydratedProjectId: snapshot.projectId,
    hydratedWorkspaceOpenRevision: snapshot.workspaceOpenRevision,
    expandedIds: snapshot.expandedIds,
    charCounts: snapshot.charCounts,
    nodePreviews: snapshot.nodePreviews,
    aiRatios: snapshot.aiRatios,
    pinnedCodexIds: snapshot.pinnedCodexIds,
    pendingRenameId: null,
    pendingRevealId: null,
  });
  recomputeCodexSceneOrder(snapshot.nodes);
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
  /** Project whose tree rows completed a successful hydration. */
  hydratedProjectId: string | null;
  /** Workspace DB generation whose tree rows completed a successful hydration. */
  hydratedWorkspaceOpenRevision: number | null;
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
  loadTree: (
    projectId?: string,
    workspaceOpenRevision?: number,
  ) => Promise<void>;
  /** loadTree と同じ再同期だが、失敗を握りつぶさず throw する版(AI batch executor 用)。 */
  reloadTreeOrThrow: (
    projectId?: string,
    workspaceOpenRevision?: number,
  ) => Promise<void>;

  // Backward-compat API (used by ChatPanel, ExportAgentTraceButton, SceneEditor)
  loadScenes: (projectId: string, chapterId: string) => Promise<void>;
  createScene: () => Promise<string>;
  createNote: () => Promise<string>;
  deleteScene: (id: string) => Promise<void>;
  renameScene: (id: string, title: string) => Promise<void>;
  setActiveScene: (id: string) => void;

  // New tree operations
  createNode: (opts: CreateNodeOpts) => Promise<TreeNodeData>;
  patchNode: (id: string, patch: TreeNodePatch) => Promise<void>;
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
  /**
   * Chronicle の原子的な複数更新結果を、同じ baseUpdatedAt のシーンだけへ反映する。
   * Tree feature が自身の projection 更新を所有し、遅延応答で新しい編集を潰さない。
   */
  applyChronicleBulkSceneProjection: (
    projectId: string,
    operations: readonly ChronicleSceneBulkProjectionOperation[],
    results: readonly ChronicleSceneBulkProjectionResult[],
  ) => void;

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
  /**
   * Implicit creation is a system bootstrap, not a user edit: it selects the
   * created document but does not open rename UI or add an undo command.
   * Mobile creation remains undoable, but auto-names the document and keeps
   * redo inside the single-document phone projection instead of desktop tabs.
   */
  interaction?: "interactive" | "implicit" | "mobile";
}

function resolveWorkspaceOpenRevision(
  explicitRevision?: number,
): number | null {
  return (
    explicitRevision ?? getCurrentWorkspaceIdentity()?.openRevision ?? null
  );
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

async function persistChronicleDate(
  id: string,
  requestedPatch: ChronicleDatePatch,
  recordHistory: boolean,
): Promise<void> {
  const scopedNode = useTreeStore
    .getState()
    .nodes.find((node) => node.id === id);
  if (!scopedNode) return;
  const projectId = scopedNode.projectId;

  const write = serializeSceneWrite(
    `chronicle-date:${projectId}:${id}`,
    async () => {
      // Resolve partial writes only after every earlier date write for this
      // exact project/scene has settled. This prevents two individually
      // valid stale endpoint edits from combining into a reversed range.
      const node = useTreeStore
        .getState()
        .nodes.find(
          (candidate) =>
            candidate.id === id && candidate.projectId === projectId,
        );
      if (!node) return;

      const touchesDate = chronicleDateTouched(requestedPatch);
      const canonicalNext = touchesDate
        ? canonicalChronicleDatePatch(node, requestedPatch)
        : null;
      const persistedPatch: ChronicleDatePatch = {
        ...(canonicalNext ?? {}),
        ...(hasOwn(requestedPatch, "chroniclePrecision")
          ? { chroniclePrecision: requestedPatch.chroniclePrecision }
          : {}),
      };
      if (!chroniclePatchChanged(node, persistedPatch)) return;

      let restorePatch: ChronicleDatePatch;
      if (touchesDate) {
        // Undo never reintroduces a legacy coarse+minute/none+day tuple. A
        // reversed or incomplete legacy range has no safe persisted target,
        // so repairing it establishes the first canonical history boundary.
        let canonicalBefore: CanonicalChronicleDatePatch;
        try {
          canonicalBefore = canonicalChronicleDatePatch(node, {});
        } catch {
          canonicalBefore = canonicalNext!;
        }
        restorePatch = {
          ...canonicalBefore,
          ...(hasOwn(requestedPatch, "chroniclePrecision")
            ? {
                chroniclePrecision: node.chroniclePrecision ?? "exact",
              }
            : {}),
        };
      } else {
        restorePatch = hasOwn(requestedPatch, "chroniclePrecision")
          ? {
              chroniclePrecision: node.chroniclePrecision ?? "exact",
            }
          : {};
      }

      // This outer, project-qualified chain serializes partial-date merge and
      // validation. api.updateNode then joins the row-wide id chain shared
      // with content/metadata writes; the keys intentionally differ, so this
      // nested serialization cannot wait on itself.
      const persisted = await api.updateNode(id, persistedPatch);
      const updatedAt = persisted?.updatedAt ?? node.updatedAt;
      useTreeStore.setState((state) => ({
        nodes: state.nodes.map((candidate) =>
          candidate.id === id && candidate.projectId === projectId
            ? { ...candidate, ...persistedPatch, updatedAt }
            : candidate,
        ),
      }));

      if (recordHistory && !useGlobalHistoryStore.getState().isReplaying) {
        useGlobalHistoryStore.getState().push({
          kind: "scenes",
          label: i18next.t("tree.undo.chronicleDateChanged"),
          entityId: id,
          undo: () => persistChronicleDate(id, restorePatch, false),
          redo: () => persistChronicleDate(id, persistedPatch, false),
        });
      }
    },
  );
  // A reader waits by raw scene id, while the merge chain is qualified by
  // project+scene. Register the outer promise under the raw id immediately,
  // so a queued (not yet dispatched) date write cannot escape the existing
  // read-after-write barrier between two inner api.updateNode calls.
  trackSceneContentWrite(id, write);
  await write;
}

export const useTreeStore = create<TreeState>()((set, get) => ({
  nodes: [],
  scenes: [],
  activeSceneId: "",
  selectedIds: [],
  isLoading: false,
  projectId: getCurrentProjectId(),
  hydratedProjectId: null,
  hydratedWorkspaceOpenRevision: null,
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

  async reloadTreeOrThrow(
    projectId = getCurrentProjectId(),
    workspaceOpenRevision,
  ) {
    // reload 失敗を throw する版。AI バッチ executor のように「DB commit 後の
    // 再同期失敗を成功扱いにできない」呼び出し元が使う。loadTree はこれを
    // try/catch で包んで従来どおり握りつぶす。
    set({ isLoading: true });
    try {
      const snapshot = await prepareTreeHydration(
        projectId,
        workspaceOpenRevision,
      );
      applyTreeHydration(snapshot);
    } catch (e) {
      // 失敗を握りつぶさず再 throw する契約は維持しつつ、isLoading を解除して
      // 「読み込み中のまま固まる」スピナー stuck を防ぐ(直接呼び出し元向け)。
      set({ isLoading: false });
      throw e;
    }
  },

  async loadTree(projectId = getCurrentProjectId(), workspaceOpenRevision) {
    try {
      await get().reloadTreeOrThrow(projectId, workspaceOpenRevision);
    } catch {
      set({ isLoading: false });
    }
  },

  applyChronicleBulkSceneProjection(projectId, operations, results) {
    for (const result of results) {
      observeTreeNodeMutationTimestamp(result.updatedAt);
    }
    const updatedAtBySceneId = new Map(
      results.map((result) => [result.sceneId, result.updatedAt]),
    );
    if (updatedAtBySceneId.size === 0) return;
    const operationBySceneId = new Map(
      operations.map((operation) => [operation.sceneId, operation]),
    );
    set((state) => ({
      nodes: state.nodes.map((node) => {
        const operation = operationBySceneId.get(node.id);
        const updatedAt = updatedAtBySceneId.get(node.id);
        if (
          !operation ||
          !updatedAt ||
          node.projectId !== projectId ||
          node.nodeType !== "scene" ||
          node.updatedAt !== operation.baseUpdatedAt
        ) {
          return node;
        }
        if (operation.kind === "sceneSetPov") {
          return {
            ...node,
            povCharacterId: operation.povCharacterId,
            updatedAt,
          };
        }
        if (operation.kind === "sceneSetDate") {
          return {
            ...node,
            chronicleStartTime: operation.startTime,
            chronicleStartMinute: operation.startMinute,
            chronicleStartGranularity: operation.startGranularity,
            chronicleEndTime: operation.endTime,
            chronicleEndMinute: operation.endMinute,
            chronicleEndGranularity: operation.endGranularity,
            updatedAt,
          };
        }
        return {
          ...node,
          chronicleStartTime: null,
          chronicleStartMinute: null,
          chronicleStartGranularity: "none",
          chronicleEndTime: null,
          chronicleEndMinute: null,
          chronicleEndGranularity: "none",
          updatedAt,
        };
      }),
    }));
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
    recomputeCodexSceneOrder(get().nodes);
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
      return {
        nodes,
        scenes: computeScenes(nodes),
        activeSceneId: newActive,
      };
    });
    recomputeCodexSceneOrder(get().nodes);
  },

  async renameScene(id, title) {
    const persisted = await api.updateNode(id, { title });
    set((state) => {
      const nodes = state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              title,
              updatedAt: persisted?.updatedAt ?? n.updatedAt,
            }
          : n,
      );
      return { nodes, scenes: computeScenes(nodes) };
    });
  },

  async patchNode(id, patch) {
    const persisted = await api.updateNode(id, patch);
    if (!persisted) return;
    set((state) => {
      const nodes = state.nodes.map((node) =>
        node.id === id
          ? { ...node, ...patch, updatedAt: persisted.updatedAt }
          : node,
      );
      return { nodes, scenes: computeScenes(nodes) };
    });
  },

  setActiveScene(id) {
    // 二重防御。TabBar 系の主防御 (tabStore guard) を素通りした直接呼び出しや、
    // activeSceneId 起点の ensure-tab → openPreview 経路を pending 中に止める。
    if (id !== get().activeSceneId && guardInlineAiPending()) return;
    if (id !== get().activeSceneId && activeEditorHasExternalConflict()) return;
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
    if (id !== get().activeSceneId && activeEditorHasExternalConflict()) return;
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
  async createNode({
    nodeType,
    parentId,
    afterId,
    title,
    interaction = "interactive",
  }) {
    const projectId = get().projectId;
    const activeProjectId = getCurrentProjectId();
    const workspaceIdentity = getCurrentWorkspaceIdentity();
    const isCurrentAuthority = (): boolean => {
      const currentWorkspaceIdentity = getCurrentWorkspaceIdentity();
      return (
        get().projectId === projectId &&
        getCurrentProjectId() === activeProjectId &&
        currentWorkspaceIdentity?.path === workspaceIdentity?.path &&
        currentWorkspaceIdentity?.openRevision ===
          workspaceIdentity?.openRevision
      );
    };
    return createTreeNode(
      { nodeType, parentId, afterId, title, interaction },
      {
        ensureWritable: () => {
          if (blockIfUnlicensed()) {
            throw new Error(LICENSE_WRITE_RESTRICTED_ERROR);
          }
        },
        getProjectId: () => projectId,
        getNodes: () => get().nodes,
        isCurrentAuthority,
        getSetting: (key, fallback) => readRuntimeSetting(key, fallback),
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
                mode === "create" && interaction === "interactive"
                  ? node.id
                  : state.pendingRenameId,
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
        recomputeSceneOrder: recomputeCodexSceneOrder,
        closeTabs: closeEditorDocumentTabs,
        revealEditorDocument: (id) =>
          requestOpenEditorDocument({
            target: { kind: "scene", documentId: id },
            mode: "pinned",
            revealEditor: true,
            focusEditor: false,
            syncSceneContext: false,
          }),
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
    const persisted = await api.updateNode(id, { title });
    set((state) => {
      const nodes = state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              title,
              updatedAt: persisted?.updatedAt ?? n.updatedAt,
            }
          : n,
      );
      return { nodes, scenes: computeScenes(nodes) };
    });
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.renamed"),
        entityId: id,
        async undo() {
          const restored = await api.updateNode(id, { title: oldTitle });
          set((state) => {
            const nodes = state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    title: oldTitle,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            );
            return { nodes, scenes: computeScenes(nodes) };
          });
        },
        async redo() {
          const restored = await api.updateNode(id, { title });
          set((state) => {
            const nodes = state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    title,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
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
      recomputeSceneOrder: recomputeCodexSceneOrder,
      isReplaying: () => useGlobalHistoryStore.getState().isReplaying,
      pushHistory: (command) => useGlobalHistoryStore.getState().push(command),
      closeTabs: closeEditorDocumentTabs,
      captureTrash: (input) => captureSceneDeletion(input),
      cancelTrash: cancelPendingTrash,
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
    const persisted = await api.updateNode(id, { synopsis });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              synopsis,
              updatedAt: persisted?.updatedAt ?? n.updatedAt,
            }
          : n,
      ),
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
        entityId: id,
        async undo() {
          const restored = await api.updateNode(id, {
            synopsis: oldSynopsis,
          });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    synopsis: oldSynopsis,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
        },
        async redo() {
          const restored = await api.updateNode(id, { synopsis });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    synopsis,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
        },
      });
    }
  },

  async updateIntent(id, intent) {
    const oldIntent = get().nodes.find((n) => n.id === id)?.intent ?? null;
    const persisted = await api.updateNode(id, { intent });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              intent,
              updatedAt: persisted?.updatedAt ?? n.updatedAt,
            }
          : n,
      ),
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
        entityId: id,
        async undo() {
          const restored = await api.updateNode(id, {
            intent: oldIntent,
          });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    intent: oldIntent,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
        },
        async redo() {
          const restored = await api.updateNode(id, { intent });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    intent,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
        },
      });
    }
  },

  async setStatus(id, status) {
    const oldStatus = get().nodes.find((n) => n.id === id)?.status ?? null;
    const persisted = await api.updateNode(id, { status });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              status,
              updatedAt: persisted?.updatedAt ?? n.updatedAt,
            }
          : n,
      ),
    }));
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.statusChanged"),
        entityId: id,
        async undo() {
          const restored = await api.updateNode(id, {
            status: oldStatus as SceneStatus | null,
          });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    status: oldStatus,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
        },
        async redo() {
          const restored = await api.updateNode(id, { status });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    status,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
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
    const persisted = await api.updateNode(id, patch);
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              storyTimeOrder: order,
              storyTimeLabel: label !== undefined ? label : n.storyTimeLabel,
              updatedAt: persisted?.updatedAt ?? n.updatedAt,
            }
          : n,
      ),
    }));
    recomputeCodexSceneOrder(get().nodes);
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.storyTimeChanged"),
        entityId: id,
        async undo() {
          const undoPatch: Parameters<typeof api.updateNode>[1] = {
            storyTimeOrder: oldOrder,
            storyTimeLabel: oldLabel,
          };
          const restored = await api.updateNode(id, undoPatch);
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    storyTimeOrder: oldOrder,
                    storyTimeLabel: oldLabel,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
          recomputeCodexSceneOrder(get().nodes);
        },
        async redo() {
          const restored = await api.updateNode(id, patch);
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    storyTimeOrder: order,
                    storyTimeLabel:
                      label !== undefined ? label : n.storyTimeLabel,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
          recomputeCodexSceneOrder(get().nodes);
        },
      });
    }
  },

  async updatePovCharacter(id, codexEntryId) {
    const node = get().nodes.find((n) => n.id === id);
    if (!node) return;
    const old = node.povCharacterId ?? null;
    if (old === codexEntryId) return; // 同値は書込み・履歴とも no-op（ドラッグ等の空振り対策）
    const persisted = await api.updateNode(id, {
      povCharacterId: codexEntryId,
    });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              povCharacterId: codexEntryId,
              updatedAt: persisted?.updatedAt ?? n.updatedAt,
            }
          : n,
      ),
    }));
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.povCharacterChanged"),
        entityId: id,
        async undo() {
          const restored = await api.updateNode(id, { povCharacterId: old });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    povCharacterId: old,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
        },
        async redo() {
          const restored = await api.updateNode(id, {
            povCharacterId: codexEntryId,
          });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    povCharacterId: codexEntryId,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
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
    const persisted = await api.updateNode(id, { locationId: codexEntryId });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              locationId: codexEntryId,
              updatedAt: persisted?.updatedAt ?? n.updatedAt,
            }
          : n,
      ),
    }));
    if (!useGlobalHistoryStore.getState().isReplaying) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: i18next.t("tree.undo.locationChanged"),
        entityId: id,
        async undo() {
          const restored = await api.updateNode(id, { locationId: old });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    locationId: old,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
        },
        async redo() {
          const restored = await api.updateNode(id, {
            locationId: codexEntryId,
          });
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    locationId: codexEntryId,
                    updatedAt: restored?.updatedAt ?? n.updatedAt,
                  }
                : n,
            ),
          }));
        },
      });
    }
  },

  async updateChronicleDate(id, patch) {
    await persistChronicleDate(id, patch, true);
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
      persist: async (nodeId, patch) => {
        const persisted = await api.updateNode(nodeId, patch);
        return persisted ? { updatedAt: persisted.updatedAt } : undefined;
      },
      recomputeSceneOrder: recomputeCodexSceneOrder,
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
    const projectId = get().hydratedProjectId;
    const workspaceOpenRevision = get().hydratedWorkspaceOpenRevision;
    try {
      const ratios = await loadBatchAiRatio([nodeId]);
      if (
        get().hydratedProjectId !== projectId ||
        get().hydratedWorkspaceOpenRevision !== workspaceOpenRevision ||
        getCurrentProjectId() !== projectId ||
        (getCurrentWorkspaceIdentity()?.openRevision ?? null) !==
          workspaceOpenRevision
      ) {
        return;
      }
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
    if (!v) return;

    const projectId = get().hydratedProjectId;
    const workspaceOpenRevision = get().hydratedWorkspaceOpenRevision;
    const sceneIds = get()
      .nodes.filter((node) => node.nodeType === "scene")
      .map((node) => node.id);
    void loadBatchAiRatio(sceneIds)
      .then((ratios) => {
        if (
          get().showAiAttribution &&
          get().hydratedProjectId === projectId &&
          get().hydratedWorkspaceOpenRevision === workspaceOpenRevision &&
          getCurrentProjectId() === projectId &&
          (getCurrentWorkspaceIdentity()?.openRevision ?? null) ===
            workspaceOpenRevision
        ) {
          set({ aiRatios: ratios });
        }
      })
      .catch(() => {});
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
    const projectId = get().hydratedProjectId;
    const workspaceOpenRevision = get().hydratedWorkspaceOpenRevision;
    const ids = await listPinnedCodexIds();
    if (
      get().hydratedProjectId !== projectId ||
      get().hydratedWorkspaceOpenRevision !== workspaceOpenRevision ||
      (getCurrentWorkspaceIdentity()?.openRevision ?? null) !==
        workspaceOpenRevision
    ) {
      return;
    }
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

subscribeTreeNodeMutations(
  (mutation) => {
    const workspaceIdentity = getCurrentWorkspaceIdentity();
    if (
      mutation.workspacePath !== (workspaceIdentity?.path ?? null) ||
      mutation.workspaceOpenRevision !==
        (workspaceIdentity?.openRevision ?? null) ||
      getCurrentProjectId() !== mutation.projectId
    ) {
      return;
    }
    useTreeStore.setState((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === mutation.nodeId && node.projectId === mutation.projectId
          ? { ...node, updatedAt: mutation.updatedAt }
          : node,
      ),
    }));
  },
  { replayCurrent: true },
);

/**
 * Consumer 用 hook。preview レコードが未生成の id でも安定参照の空オブジェクトを
 * 返すので、`?? {placed:null,unplaced:null}` を呼び側で書く必要がない
 * (feedback_zustand_selector_new_ref.md)。
 */
export function useNodeBeatPreview(id: string): NodeBeatPreview {
  return useTreeStore((s) => s.nodePreviews[id] ?? EMPTY_NODE_PREVIEW);
}
