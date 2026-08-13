import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq, and, isNull, isNotNull, inArray, lt } from "drizzle-orm";
import { extractUnplacedBeatPreview } from "@/features/editor/beat/unplacedBeatPreview";
import { extractPlacedBeatPreviewFromString } from "@/features/editor/beat/placedBeatPreview";
import {
  trackSceneContentWrite,
  awaitPendingSceneContentWrite,
  awaitPendingSceneWriteStrict,
  serializeSceneWrite,
} from "@/features/tree/pendingSceneWrites";
import { debugLog } from "@/lib/debugLog";
import { invoke } from "@/lib/tauri";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  nextTreeNodeMutationTimestamp,
  publishTreeNodeMutation,
} from "@/lib/treeNodeMutationRegistry";
import type { ProjectNarrativeSourceRow } from "@/features/narrative-extraction/source/types";
import type { WorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  createCanonicalHistoryWriteLease,
  createCanonicalWriteContext,
  type CanonicalHistoryWriteLease,
  type CanonicalWriteContext,
  type CanonicalWriteLineage,
  type CanonicalWriteOrigin,
  type CanonicalWriteReceipt,
} from "@/features/native-writes/writeContext";

const historyWriteLeases = new WeakMap<
  CanonicalWriteReceipt,
  Partial<Record<"undo" | "redo", CanonicalHistoryWriteLease>>
>();
const activeHistoryWriteContexts = new WeakMap<
  CanonicalWriteContext,
  CanonicalHistoryWriteLease
>();

function commitHistoryWriteContext(context: CanonicalWriteContext): void {
  const lease = activeHistoryWriteContexts.get(context);
  if (!lease) return;
  lease.committed();
  activeHistoryWriteContexts.delete(context);
}

function publishPersistedTreeNodeMutation(
  persisted:
    | { id: string; projectId: string; updatedAt: string }
    | null
    | undefined,
  workspaceIdentity: WorkspaceIdentity | null,
): void {
  if (!persisted) return;
  publishTreeNodeMutation({
    workspacePath: workspaceIdentity?.path ?? null,
    workspaceOpenRevision: workspaceIdentity?.openRevision ?? null,
    projectId: persisted.projectId,
    nodeId: persisted.id,
    updatedAt: persisted.updatedAt,
  });
}

/**
 * Derive `unplaced_beat_preview` from a serialized `unplacedBeatsDoc` JSON
 * array string. Centralised here so every writer of `unplaced_beats_doc` keeps
 * the cache in sync without callers having to remember.
 */
function deriveUnplacedPreview(unplacedBeatsDoc: string): string | null {
  try {
    const parsed: unknown = JSON.parse(unplacedBeatsDoc);
    if (!Array.isArray(parsed)) return null;
    const out = extractUnplacedBeatPreview(
      parsed as { content: { text?: string }[] }[],
    );
    return out === "[]" ? null : out;
  } catch {
    return null;
  }
}

function derivePlacedPreview(contentJsonStr: string): string | null {
  const out = extractPlacedBeatPreviewFromString(contentJsonStr);
  return out === "[]" ? null : out;
}

export type TreeNode = typeof treeNodes.$inferSelect;
export type NewTreeNode = typeof treeNodes.$inferInsert;
export type NodeType = "folder" | "scene" | "note";

export type TreeNodeWriteResult = TreeNode & {
  __writeReceipt?: CanonicalWriteReceipt;
};

function hideTreeWriteReceipt(
  result: TreeNodeWriteResult,
): TreeNodeWriteResult {
  const receipt = result.__writeReceipt;
  if (!receipt) return result;
  delete result.__writeReceipt;
  Object.defineProperty(result, "__writeReceipt", {
    value: receipt,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return result;
}

type LegacyTreeRestoreWriteContext = {
  requestId: string;
  sessionId: string;
  eventUid: string;
  timestamp: number;
  origin: "restore";
  sourceDomain: "revision";
  opType: "content.restore";
};

function isLegacyTreeRestoreWriteContext(
  value: CanonicalWriteContext | LegacyTreeRestoreWriteContext,
): value is LegacyTreeRestoreWriteContext {
  return "sourceDomain" in value;
}

export function treeWriteReceipt(
  result: TreeNodeWriteResult | CanonicalWriteReceipt | null | undefined,
): CanonicalWriteReceipt | undefined {
  if (!result) return undefined;
  const candidate: CanonicalWriteReceipt | undefined =
    "__writeReceipt" in result
      ? result.__writeReceipt
      : "changeEventUid" in result && "maintenanceTransactionId" in result
        ? result
        : undefined;
  if (
    typeof candidate?.changeEventUid !== "string" ||
    typeof candidate.maintenanceTransactionId !== "string"
  ) {
    return undefined;
  }
  return candidate;
}

export function historyWriteContext(
  origin: Extract<CanonicalWriteOrigin, "undo" | "redo">,
  receipt: CanonicalWriteReceipt | undefined,
): CanonicalWriteContext {
  const undoJournalId = receipt?.undoJournalId;
  if (!receipt || typeof undoJournalId !== "string" || !undoJournalId) {
    throw new Error("Tree history write is missing its Undo Journal lineage");
  }
  const lineage: CanonicalWriteLineage = {
    originalTransactionId: receipt.maintenanceTransactionId,
    undoJournalId,
  };
  let leases = historyWriteLeases.get(receipt);
  if (!leases) {
    leases = {};
    historyWriteLeases.set(receipt, leases);
  }
  const lease =
    leases[origin] ??
    (leases[origin] = createCanonicalHistoryWriteLease(origin, lineage));
  const context = lease.acquire();
  activeHistoryWriteContexts.set(context, lease);
  return context;
}

/**
 * list 系 (listNodes / listAllNodes) の軽量行 (H4 projection)。
 * 重い本文列 content / unplacedBeatsDoc の 2 列だけを除外し、preview キャッシュ
 * や charCount 等のメタ列は全部残す。本文が要る呼び出し元は
 * loadSceneContent / loadSceneContents / loadSceneFull / listNoteContents で
 * 別途ロードする。
 */
export type TreeNodeLite = Omit<TreeNode, "content" | "unplacedBeatsDoc">;

// listNodes / listAllNodes 用の明示 projection。satisfies で TreeNodeLite との
// 列ずれ (漏れ・余剰 = content/unplacedBeatsDoc の混入) をコンパイル時に検出する。
// 関数にしているのは、@/db/schema を部分 mock するテストがこのモジュールを
// import しただけで treeNodes 参照 (undefined.id) で落ちないようにするため。
const treeNodeLiteColumns = () =>
  ({
    id: treeNodes.id,
    projectId: treeNodes.projectId,
    parentId: treeNodes.parentId,
    nodeType: treeNodes.nodeType,
    title: treeNodes.title,
    synopsis: treeNodes.synopsis,
    intent: treeNodes.intent,
    sortOrder: treeNodes.sortOrder,
    storyTimeOrder: treeNodes.storyTimeOrder,
    storyTimeLabel: treeNodes.storyTimeLabel,
    povCharacterId: treeNodes.povCharacterId,
    locationId: treeNodes.locationId,
    chronicleStartTime: treeNodes.chronicleStartTime,
    chronicleStartMinute: treeNodes.chronicleStartMinute,
    chronicleStartGranularity: treeNodes.chronicleStartGranularity,
    chronicleEndTime: treeNodes.chronicleEndTime,
    chronicleEndMinute: treeNodes.chronicleEndMinute,
    chronicleEndGranularity: treeNodes.chronicleEndGranularity,
    chroniclePrecision: treeNodes.chroniclePrecision,
    status: treeNodes.status,
    charCount: treeNodes.charCount,
    unplacedBeatPreview: treeNodes.unplacedBeatPreview,
    placedBeatPreview: treeNodes.placedBeatPreview,
    sourceUri: treeNodes.sourceUri,
    sourceMtime: treeNodes.sourceMtime,
    archivedAt: treeNodes.archivedAt,
    contextMode: treeNodes.contextMode,
    aliases: treeNodes.aliases,
    excludedAliases: treeNodes.excludedAliases,
    createdAt: treeNodes.createdAt,
    updatedAt: treeNodes.updatedAt,
    version: treeNodes.version,
  }) satisfies { [K in keyof TreeNodeLite]: (typeof treeNodes)[K] };

export async function listNodes(
  projectId: string,
  parentId?: string | null,
): Promise<TreeNodeLite[]> {
  const notArchived = isNull(treeNodes.archivedAt);
  if (parentId !== undefined) {
    if (parentId === null) {
      return db
        .select(treeNodeLiteColumns())
        .from(treeNodes)
        .where(
          and(
            eq(treeNodes.projectId, projectId),
            isNull(treeNodes.parentId),
            notArchived,
          ),
        );
    }
    return db
      .select(treeNodeLiteColumns())
      .from(treeNodes)
      .where(
        and(
          eq(treeNodes.projectId, projectId),
          eq(treeNodes.parentId, parentId),
          notArchived,
        ),
      );
  }
  return db
    .select(treeNodeLiteColumns())
    .from(treeNodes)
    .where(and(eq(treeNodes.projectId, projectId), notArchived));
}

/** Includes archived nodes — for external mount reconciliation only. */
export async function listAllNodes(projectId: string): Promise<TreeNodeLite[]> {
  return db
    .select(treeNodeLiteColumns())
    .from(treeNodes)
    .where(eq(treeNodes.projectId, projectId));
}

/**
 * Select only expired archived row IDs without transferring every live Tree
 * row to the renderer. `archivedAt` is always written as an ISO-8601 instant,
 * so lexical ordering is chronological and remains index-friendly.
 */
export async function listExpiredArchivedNodeIds(
  projectId: string,
  archivedBefore: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: treeNodes.id })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.projectId, projectId),
        isNotNull(treeNodes.archivedAt),
        lt(treeNodes.archivedAt, archivedBefore),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * note ノードの本文だけを id → content の Map で返す。
 * listNodes が content を引かなくなった (H4) ため、tree ロード時はこれを
 * ペアで呼んで note にだけ本文をマージする (scene 本文は store に載せない
 * 不変条件はそのまま)。note は通常少数なので追加往復のコストは小さい。
 */
export async function listNoteContents(
  projectId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: treeNodes.id, content: treeNodes.content })
    .from(treeNodes)
    .where(
      and(eq(treeNodes.projectId, projectId), eq(treeNodes.nodeType, "note")),
    );
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.id, r.content ?? "");
  return out;
}

export async function listProjectSceneDocuments(
  projectId: string,
): Promise<Array<{ id: string; title: string; content: string | null }>> {
  return db
    .select({
      id: treeNodes.id,
      title: treeNodes.title,
      content: treeNodes.content,
    })
    .from(treeNodes)
    .where(
      and(eq(treeNodes.projectId, projectId), eq(treeNodes.nodeType, "scene")),
    );
}

/**
 * Load the persisted Scene rows used to build an immutable narrative corpus.
 *
 * The caller supplies the already-resolved DFS order. One Project-scoped
 * SELECT provides a single SQLite statement snapshot and the function fails
 * closed instead of splitting a corpus above its safe parameter bound.
 * `sortOrder` is only meaningful among siblings, so requested rows are
 * reassembled against the input order here. Missing, foreign-Project,
 * non-Scene, and archived IDs are omitted.
 */
export async function loadProjectNarrativeSourceRows(
  projectId: string,
  orderedSceneIds: readonly string[],
): Promise<ProjectNarrativeSourceRow[]> {
  if (orderedSceneIds.length === 0) return [];
  // Keep one statement below SQLite's historical 999-bound-variable limit.
  // Larger corpora fail closed until the native snapshot reader lands.
  const MAX_SINGLE_SNAPSHOT_SCENES = 900;
  if (orderedSceneIds.length > MAX_SINGLE_SNAPSHOT_SCENES) {
    throw new RangeError(
      `Narrative corpus exceeds the ${MAX_SINGLE_SNAPSHOT_SCENES}-Scene single-read limit`,
    );
  }

  await Promise.all(
    orderedSceneIds.map((sceneId) => awaitPendingSceneWriteStrict(sceneId)),
  );

  const rows = await db
    .select({
      nodeId: treeNodes.id,
      parentId: treeNodes.parentId,
      title: treeNodes.title,
      content: treeNodes.content,
      sortOrder: treeNodes.sortOrder,
      version: treeNodes.version,
      updatedAt: treeNodes.updatedAt,
      sourceUri: treeNodes.sourceUri,
    })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.projectId, projectId),
        eq(treeNodes.nodeType, "scene"),
        isNull(treeNodes.archivedAt),
        inArray(treeNodes.id, [...orderedSceneIds]),
      ),
    );
  const rowsById = new Map<
    string,
    Omit<ProjectNarrativeSourceRow, "orderIndex">
  >();
  for (const row of rows) rowsById.set(row.nodeId, row);

  const orderedRows: ProjectNarrativeSourceRow[] = [];
  orderedSceneIds.forEach((nodeId, orderIndex) => {
    const row = rowsById.get(nodeId);
    if (row) orderedRows.push({ ...row, orderIndex });
  });
  return orderedRows;
}

export async function getNode(id: string): Promise<TreeNode | undefined> {
  const rows = await db.select().from(treeNodes).where(eq(treeNodes.id, id));
  return rows[0];
}

export async function createNode(
  data: Pick<
    NewTreeNode,
    "id" | "projectId" | "nodeType" | "title" | "sortOrder"
  > &
    Partial<
      Pick<
        NewTreeNode,
        | "parentId"
        | "status"
        | "synopsis"
        | "sourceUri"
        | "sourceMtime"
        | "content"
      >
    >,
  options: { writeContext?: CanonicalWriteContext } = {},
): Promise<TreeNodeWriteResult> {
  const writeContext = options.writeContext ?? createCanonicalWriteContext();
  const result = await invoke<TreeNodeWriteResult>("tree_node_create", {
    payload: Object.fromEntries(
      Object.entries({
        ...data,
        ...writeContext,
        canonicalPayload: {
          parentId: data.parentId ?? null,
          sortOrder: data.sortOrder,
          title: data.title,
        },
      }).filter(([, value]) => value !== undefined),
    ),
  });
  commitHistoryWriteContext(writeContext);
  return hideTreeWriteReceipt(result);
}

async function patchTreeNodeNative(
  id: string,
  projectId: string,
  patch: Record<string, unknown>,
  options: {
    baseVersion?: number;
    bumpVersion: boolean;
    updatedAt?: string;
    writeContext?: LegacyTreeRestoreWriteContext | CanonicalWriteContext;
  },
): Promise<TreeNodeWriteResult> {
  const auditBefore = await getNode(id);
  const legacyRestoreContext =
    options.writeContext &&
    isLegacyTreeRestoreWriteContext(options.writeContext)
      ? options.writeContext
      : undefined;
  let canonicalContext: CanonicalWriteContext;
  if (legacyRestoreContext) {
    canonicalContext = {
      requestId: legacyRestoreContext.requestId,
      sessionId: legacyRestoreContext.sessionId,
      eventUid: legacyRestoreContext.eventUid,
      origin: legacyRestoreContext.origin,
      originalTransactionId: null,
      undoJournalId: null,
    };
  } else if (options.writeContext) {
    canonicalContext = options.writeContext as CanonicalWriteContext;
  } else {
    canonicalContext = createCanonicalWriteContext();
  }
  const payload = {
    ...canonicalContext,
    projectId,
    nodeId: id,
    canonicalPayload: {
      fields: Object.keys(patch).sort(),
      before: Object.fromEntries(
        Object.keys(patch).map((key) => [
          key,
          (auditBefore as unknown as Record<string, unknown> | undefined)?.[
            key
          ] ?? null,
        ]),
      ),
      after: patch,
    },
    patch: Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
    bumpVersion: options.bumpVersion,
    updatedAt: options.updatedAt ?? nextTreeNodeMutationTimestamp(),
    ...(options.baseVersion === undefined
      ? {}
      : { baseVersion: options.baseVersion }),
    ...(legacyRestoreContext
      ? {
          origin: legacyRestoreContext.origin,
          sourceDomain: legacyRestoreContext.sourceDomain,
          opType: legacyRestoreContext.opType,
          changeEvent: {
            eventUid: legacyRestoreContext.eventUid,
            sessionId: legacyRestoreContext.sessionId,
            timestamp: legacyRestoreContext.timestamp,
          },
        }
      : {}),
  };
  const result = await invoke<TreeNodeWriteResult>("tree_node_patch", {
    payload,
  });
  commitHistoryWriteContext(canonicalContext);
  return hideTreeWriteReceipt(result);
}

export function updateNode(
  id: string,
  data: Partial<
    Pick<
      NewTreeNode,
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
      | "content"
      | "contextMode"
      | "aliases"
      | "excludedAliases"
    >
  >,
  options: { writeContext?: CanonicalWriteContext } = {},
): Promise<TreeNodeWriteResult | undefined> {
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  // Metadata, Chronicle, preview, and content all share one tree_nodes row.
  // Keep generic metadata writes on the same per-scene issue-order chain as
  // content writes so their returned updatedAt token cannot arrive out of
  // order and poison a later Chronicle bulk OCC request.
  return serializeSceneWrite(id, async () => {
    const current = await getNode(id);
    if (!current) return undefined;
    const temporalKeys = new Set([
      "storyTimeOrder",
      "storyTimeLabel",
      "chronicleStartTime",
      "chronicleStartMinute",
      "chronicleStartGranularity",
      "chronicleEndTime",
      "chronicleEndMinute",
      "chronicleEndGranularity",
      "chroniclePrecision",
    ]);
    if (Object.keys(data).some((key) => temporalKeys.has(key))) {
      const value = <K extends keyof typeof data, T>(key: K, fallback: T): T =>
        data[key] === undefined ? fallback : (data[key] as T);
      const temporalResult = await updateTemporalScene(
        current.projectId,
        id,
        {
          storyTimeOrder: value(
            "storyTimeOrder",
            current.storyTimeOrder ?? null,
          ),
          storyTimeLabel: value(
            "storyTimeLabel",
            current.storyTimeLabel ?? null,
          ),
          chronicleStartTime: value(
            "chronicleStartTime",
            current.chronicleStartTime ?? null,
          ),
          chronicleStartMinute: value(
            "chronicleStartMinute",
            current.chronicleStartMinute ?? null,
          ),
          chronicleStartGranularity: value(
            "chronicleStartGranularity",
            current.chronicleStartGranularity ?? "none",
          ),
          chronicleEndTime: value(
            "chronicleEndTime",
            current.chronicleEndTime ?? null,
          ),
          chronicleEndMinute: value(
            "chronicleEndMinute",
            current.chronicleEndMinute ?? null,
          ),
          chronicleEndGranularity: value(
            "chronicleEndGranularity",
            current.chronicleEndGranularity ?? "none",
          ),
          chroniclePrecision: value(
            "chroniclePrecision",
            current.chroniclePrecision ?? "exact",
          ),
          baseVersion: current.version,
        },
        { writeContext: options.writeContext },
      );
      const persisted = hideTreeWriteReceipt({
        ...current,
        ...data,
        version: temporalResult.version,
        updatedAt: temporalResult.updatedAt,
        __writeReceipt: {
          changeEventUid: temporalResult.changeEventUid,
          maintenanceTransactionId: temporalResult.maintenanceTransactionId,
          undoJournalId: temporalResult.undoJournalId,
        },
      });
      publishPersistedTreeNodeMutation(persisted, workspaceIdentity);
      return persisted;
    }
    const persisted = await patchTreeNodeNative(id, current.projectId, data, {
      bumpVersion: false,
      writeContext: options.writeContext,
    });
    publishPersistedTreeNodeMutation(persisted, workspaceIdentity);
    return persisted;
  });
}

export async function deleteNode(
  id: string,
  projectId?: string,
  options: { writeContext?: CanonicalWriteContext } = {},
): Promise<CanonicalWriteReceipt | undefined> {
  const current = await getNode(id);
  const scopedProjectId = projectId ?? current?.projectId;
  if (!scopedProjectId) return;
  const writeContext = options.writeContext ?? createCanonicalWriteContext();
  const result = await invoke<CanonicalWriteReceipt>("tree_node_delete", {
    payload: {
      projectId: scopedProjectId,
      nodeId: id,
      ...writeContext,
      canonicalPayload: { id },
    },
  });
  commitHistoryWriteContext(writeContext);
  return treeWriteReceipt(result);
}

export interface TemporalScenePatch {
  storyTimeOrder: string | null;
  storyTimeLabel: string | null;
  chronicleStartTime: number | null;
  chronicleStartMinute: number | null;
  chronicleStartGranularity: string;
  chronicleEndTime: number | null;
  chronicleEndMinute: number | null;
  chronicleEndGranularity: string;
  chroniclePrecision: string;
  baseVersion: number;
}

export interface TemporalScenePatchResult {
  sceneId: string;
  version: number;
  updatedAt: string;
  changeEventUid: string;
  maintenanceTransactionId: string;
  undoJournalId: string;
}

export async function updateTemporalScene(
  projectId: string,
  sceneId: string,
  patch: TemporalScenePatch,
  options: { writeContext?: CanonicalWriteContext } = {},
): Promise<TemporalScenePatchResult> {
  const writeContext = options.writeContext ?? createCanonicalWriteContext();
  const result = await invoke<TemporalScenePatchResult>(
    "temporal_scene_patch",
    {
      payload: {
        ...writeContext,
        projectId,
        targetId: sceneId,
        baseVersion: patch.baseVersion,
        storyTimeOrder: patch.storyTimeOrder,
        storyTimeLabel: patch.storyTimeLabel,
        startTime: patch.chronicleStartTime,
        startMinute: patch.chronicleStartMinute,
        startGranularity: patch.chronicleStartGranularity,
        endTime: patch.chronicleEndTime,
        endMinute: patch.chronicleEndMinute,
        endGranularity: patch.chronicleEndGranularity,
        precision: patch.chroniclePrecision,
      },
    },
  );
  commitHistoryWriteContext(writeContext);
  return result;
}

// --- Scene content operations ---

export interface SaveScenePayload {
  content: string;
  unplacedBeatsDoc?: string;
  charCount?: number;
  /** Loaded scene version for editor OCC. Omit for authoritative headless writers. */
  baseVersion?: number;
  /** Renderer-wide monotonic tree token shared with the native bundle. */
  updatedAt?: string;
  writeContext?: CanonicalWriteContext | LegacyTreeRestoreWriteContext;
}

export class SceneContentConflictError extends Error {
  constructor(sceneId: string) {
    super(`Scene content conflict or missing scene: ${sceneId}`);
    this.name = "SceneContentConflictError";
  }
}

export interface DerivedPreviews {
  /** Always recomputed from `payload.content`. */
  placedBeatPreview: string | null;
  /** Recomputed from `unplacedBeatsDoc` when that field is part of the payload. */
  unplacedBeatPreview?: string | null;
  /** Exact scene revision written with this content. */
  contentVersion: number;
  contentUpdatedAt: string;
}

/**
 * Save scene content to the DB.
 * Accepts either a plain JSON string (legacy callers) or a full payload object.
 *
 * Both preview caches (`placed_beat_preview` and `unplaced_beat_preview`) are
 * derived inside this function from `content` / `unplacedBeatsDoc`, so every
 * writer of `content` keeps the caches in sync without having to remember.
 *
 * The derived preview values are returned so callers can update in-memory
 * state (e.g. tree store) without recomputing.
 */
export async function saveSceneContent(
  sceneId: string,
  payloadOrContent: string | SaveScenePayload,
): Promise<DerivedPreviews> {
  // serializeSceneWrite で同一シーンの先行 write の後ろにチェーンし、
  // 「発行順 = コミット順」を保証する（M3 async 化で UPDATE 同士が並行しうる）。
  // チェーン entry は同期登録されるので、unmount cleanup からの fire-and-forget
  // flush でも直後の load が pending を見える (awaitPendingSceneContentWrite は
  // writeChains も待つ)。
  return serializeSceneWrite(sceneId, () =>
    saveSceneContentInner(sceneId, payloadOrContent),
  );
}

/**
 * `saveSceneContent` のチェーン非経由の内部実装。
 *
 * serializeSceneWrite の**チェーン単位の内側**から呼ぶためのもの
 * (persistSceneBody は content 書き込みと authorship/foreshadow/annotation の
 * full-replace cascade を単一チェーン単位として実行する)。チェーン単位の中で
 * 公開 `saveSceneContent` を呼ぶと、同一チェーンへの自己 await でデッドロック
 * するため、この分離が必要。直接呼ぶのはチェーン単位内のみ — 通常の呼び出し
 * 側は必ず `saveSceneContent` を使うこと。
 */
export async function saveSceneContentInner(
  sceneId: string,
  payloadOrContent: string | SaveScenePayload,
): Promise<DerivedPreviews> {
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  const payload: SaveScenePayload =
    typeof payloadOrContent === "string"
      ? { content: payloadOrContent }
      : payloadOrContent;

  const placedBeatPreview = derivePlacedPreview(payload.content);
  const unplacedBeatPreview =
    payload.unplacedBeatsDoc !== undefined
      ? deriveUnplacedPreview(payload.unplacedBeatsDoc)
      : undefined;

  // 本文消失系の調査用 catch-all: content を書く全 writer がここを通る。
  // 「いつ・どの scene に・何バイトの content が書かれたか」を残す。
  debugLog.debug(
    "SceneAPI",
    `write ${sceneId.slice(0, 8)}`,
    JSON.stringify({ contentLen: payload.content.length }),
  );

  const contentUpdatedAt = payload.updatedAt ?? nextTreeNodeMutationTimestamp();

  const write = (async () => {
    const current = await getNode(sceneId);
    if (!current) return [];
    const persisted = await patchTreeNodeNative(
      sceneId,
      current.projectId,
      {
        content: payload.content,
        ...(payload.unplacedBeatsDoc !== undefined && {
          unplacedBeatsDoc: payload.unplacedBeatsDoc,
          unplacedBeatPreview,
        }),
        ...(payload.charCount !== undefined && {
          charCount: payload.charCount,
        }),
        placedBeatPreview,
      },
      {
        baseVersion:
          payload.baseVersion ??
          (payload.writeContext ? current.version : undefined),
        bumpVersion: true,
        updatedAt: contentUpdatedAt,
        writeContext: payload.writeContext,
      },
    );
    return [
      {
        id: persisted.id,
        projectId: persisted.projectId,
        contentVersion: persisted.version,
        contentUpdatedAt: persisted.updatedAt,
      },
    ];
  })();
  trackSceneContentWrite(sceneId, write);
  const rows = await write;
  const persisted = rows[0];
  if (!persisted && payload.baseVersion !== undefined) {
    throw new SceneContentConflictError(sceneId);
  }
  publishPersistedTreeNodeMutation(
    persisted
      ? {
          id: persisted.id,
          projectId: persisted.projectId,
          updatedAt: persisted.contentUpdatedAt,
        }
      : null,
    workspaceIdentity,
  );

  return {
    placedBeatPreview,
    unplacedBeatPreview,
    contentVersion: rows[0]?.contentVersion ?? 0,
    contentUpdatedAt: rows[0]?.contentUpdatedAt ?? contentUpdatedAt,
  };
}

/**
 * 現在の scene 行の OCC version を返す (不在なら 0)。
 * prose_staging.base_version (propose 時点の version) との突き合わせ =
 * headless 自動適用の stale 検知用 (agent-writes/autoApplyProse.ts)。
 */
export async function getSceneVersion(sceneId: string): Promise<number> {
  // load 系と同じ read-after-write バリア: 未着の content 書き込み (とその
  // version bump) を追い越して古い version を読まない。
  await awaitPendingSceneContentWrite(sceneId);
  const rows = await db
    .select({ version: treeNodes.version })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  return rows[0]?.version ?? 0;
}

/** Load ProseMirror JSON content for a scene from the DB. Returns empty string if not found. */
export async function loadSceneContent(sceneId: string): Promise<string> {
  // 未着の content 書き込み (unmount flush 等の fire-and-forget) を追い越して
  // 編集前の行を読まないよう、pending write を待ってから SELECT する。
  await awaitPendingSceneContentWrite(sceneId);
  const rows = await db
    .select({ content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  return rows[0]?.content ?? "";
}

/**
 * Save unplaced beats doc + preview without touching `content`.
 *
 * This still mutates the same tree_nodes aggregate as a full scene save, so it
 * participates in the same OCC version stream. A Grid writer must provide the
 * project identity and version it observed when loading the aggregate; without
 * that predicate a stale Grid edit could be followed by a full-editor save and
 * silently restore the old unplaced-beats document.
 *
 * Does NOT touch `placed_beat_preview` — that cache is derived from `content`,
 * which this function never modifies.
 */
export async function saveSceneBeatsOnly(
  sceneId: string,
  payload: {
    unplacedBeatsDoc: string;
    projectId: string;
    baseVersion: number;
  },
): Promise<{
  unplacedBeatPreview: string | null;
  contentVersion: number;
  contentUpdatedAt: string;
}> {
  const unplacedBeatPreview = deriveUnplacedPreview(payload.unplacedBeatsDoc);
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  // 同一 tree_nodes 行を書くため saveSceneContent と同じ per-scene チェーンに載せる。
  const rows = await serializeSceneWrite(sceneId, async () => {
    const persisted = await patchTreeNodeNative(
      sceneId,
      payload.projectId,
      {
        unplacedBeatsDoc: payload.unplacedBeatsDoc,
        unplacedBeatPreview,
      },
      {
        baseVersion: payload.baseVersion,
        bumpVersion: true,
      },
    );
    return [
      {
        id: persisted.id,
        projectId: persisted.projectId,
        contentVersion: persisted.version,
        contentUpdatedAt: persisted.updatedAt,
      },
    ];
  });
  const persisted = rows[0];
  if (!persisted) {
    throw new SceneContentConflictError(sceneId);
  }
  publishPersistedTreeNodeMutation(
    {
      id: persisted.id,
      projectId: persisted.projectId,
      updatedAt: persisted.contentUpdatedAt,
    },
    workspaceIdentity,
  );
  return {
    unplacedBeatPreview,
    contentVersion: persisted.contentVersion,
    contentUpdatedAt: persisted.contentUpdatedAt,
  };
}

/**
 * Persist only the cached `placed_beat_preview` column. Used by the lazy
 * backfill path when a legacy scene is loaded that has placed sceneBeat
 * nodes but no cached preview yet. The cache lives on the same tree_nodes
 * aggregate as content, so the write uses the loaded project/version token
 * and advances that version exactly like other aggregate mutations.
 */
export async function savePlacedBeatPreviewOnly(
  sceneId: string,
  payload: {
    placedBeatPreview: string | null;
    projectId: string;
    baseVersion: number;
  },
): Promise<{
  contentVersion: number;
  contentUpdatedAt: string;
}> {
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  // 同一 tree_nodes 行を書くため saveSceneContent と同じ per-scene チェーンに載せる。
  const rows = await serializeSceneWrite(sceneId, async () => {
    const persisted = await patchTreeNodeNative(
      sceneId,
      payload.projectId,
      { placedBeatPreview: payload.placedBeatPreview },
      {
        baseVersion: payload.baseVersion,
        bumpVersion: true,
      },
    );
    return [
      {
        id: persisted.id,
        projectId: persisted.projectId,
        contentVersion: persisted.version,
        contentUpdatedAt: persisted.updatedAt,
      },
    ];
  });
  const persisted = rows[0];
  if (!persisted) {
    throw new SceneContentConflictError(sceneId);
  }
  publishPersistedTreeNodeMutation(
    {
      id: persisted.id,
      projectId: persisted.projectId,
      updatedAt: persisted.contentUpdatedAt,
    },
    workspaceIdentity,
  );
  return {
    contentVersion: persisted.contentVersion,
    contentUpdatedAt: persisted.contentUpdatedAt,
  };
}

/** Load scene content + unplaced beats doc in one query. */
export async function loadSceneFull(sceneId: string): Promise<{
  content: string;
  unplacedBeatsDoc: string;
  projectId: string;
  version: number;
}> {
  // loadSceneContent と同じ read-after-write バリア (pendingSceneWrites 参照)。
  await awaitPendingSceneContentWrite(sceneId);
  const rows = await db
    .select({
      content: treeNodes.content,
      unplacedBeatsDoc: treeNodes.unplacedBeatsDoc,
      projectId: treeNodes.projectId,
      version: treeNodes.version,
    })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  return {
    content: rows[0]?.content ?? "",
    unplacedBeatsDoc: rows[0]?.unplacedBeatsDoc ?? "[]",
    projectId: rows[0]?.projectId ?? "",
    version: rows[0]?.version ?? 0,
  };
}

/**
 * 複数シーンの content のみを取得する content 専用バッチ版。
 * loadScenesFull と同型 (inArray 500 件 chunk + read-after-write バリア) だが
 * unplacedBeatsDoc は引かない。renameEngine / mountManager のように本文だけ
 * 必要な呼び出し元の IPC ペイロードを削減する (H4)。
 * 返却は id → content の Map。存在しない id は含まれない。
 */
export async function loadSceneContents(
  sceneIds: string[],
): Promise<Map<string, string>> {
  await Promise.all(sceneIds.map((id) => awaitPendingSceneContentWrite(id)));
  const out = new Map<string, string>();
  const CHUNK = 500;
  for (let i = 0; i < sceneIds.length; i += CHUNK) {
    const slice = sceneIds.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    const rows = await db
      .select({ id: treeNodes.id, content: treeNodes.content })
      .from(treeNodes)
      .where(inArray(treeNodes.id, slice));
    for (const r of rows) out.set(r.id, r.content ?? "");
  }
  return out;
}

/**
 * 複数シーンの content + unplacedBeatsDoc を 1 クエリで取得するバッチ版。
 * loadSceneFull を N 連発すると 1 件ごとに IPC 往復 + drizzle sqlite-proxy の
 * warmed microtask(~150ms/件)が積み上がり、Mutex<Connection> で直列化される。
 * inArray で 1 往復に畳む(SQLite 変数上限を避けるため内部で 500 件ずつ分割)。
 * 返却は id → {content, unplacedBeatsDoc} の Map。存在しない id は含まれない。
 */
export async function loadScenesFull(
  sceneIds: string[],
): Promise<Map<string, { content: string; unplacedBeatsDoc: string }>> {
  // 単発の loadSceneContent / loadSceneFull と同じ read-after-write バリア
  // (pendingSceneWrites 参照)。pending の無い id は即解決するので、バッチでも
  // 追加コストは実質ゼロ。
  await Promise.all(sceneIds.map((id) => awaitPendingSceneContentWrite(id)));
  const out = new Map<string, { content: string; unplacedBeatsDoc: string }>();
  const CHUNK = 500;
  for (let i = 0; i < sceneIds.length; i += CHUNK) {
    const slice = sceneIds.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    const rows = await db
      .select({
        id: treeNodes.id,
        content: treeNodes.content,
        unplacedBeatsDoc: treeNodes.unplacedBeatsDoc,
      })
      .from(treeNodes)
      .where(inArray(treeNodes.id, slice));
    for (const r of rows) {
      out.set(r.id, {
        content: r.content ?? "",
        unplacedBeatsDoc: r.unplacedBeatsDoc ?? "[]",
      });
    }
  }
  return out;
}
