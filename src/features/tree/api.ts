import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq, and, isNull, isNotNull, inArray, lt, sql } from "drizzle-orm";
import { extractUnplacedBeatPreview } from "@/features/editor/beat/unplacedBeatPreview";
import { extractPlacedBeatPreviewFromString } from "@/features/editor/beat/placedBeatPreview";
import {
  trackSceneContentWrite,
  awaitPendingSceneContentWrite,
  serializeSceneWrite,
} from "@/features/tree/pendingSceneWrites";
import { debugLog } from "@/lib/debugLog";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  nextTreeNodeMutationTimestamp,
  publishTreeNodeMutation,
} from "@/lib/treeNodeMutationRegistry";
import type { WorkspaceIdentity } from "@/runtime/workspaceIdentity";

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
): Promise<TreeNode> {
  const now = nextTreeNodeMutationTimestamp();
  const rows = await db
    .insert(treeNodes)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
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
): Promise<TreeNode | undefined> {
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  // Metadata, Chronicle, preview, and content all share one tree_nodes row.
  // Keep generic metadata writes on the same per-scene issue-order chain as
  // content writes so their returned updatedAt token cannot arrive out of
  // order and poison a later Chronicle bulk OCC request.
  return serializeSceneWrite(id, async () => {
    const updatedAt = nextTreeNodeMutationTimestamp();
    const rows = await db
      .update(treeNodes)
      .set({ ...data, updatedAt })
      .where(eq(treeNodes.id, id))
      .returning();
    const persisted = rows[0];
    publishPersistedTreeNodeMutation(persisted, workspaceIdentity);
    return persisted;
  });
}

export async function deleteNode(id: string): Promise<void> {
  await db.delete(treeNodes).where(eq(treeNodes.id, id));
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

  // Promise.resolve で drizzle の thenable を即 1 回だけ実行に固定してから
  // track する（thenable のまま 2 箇所で await すると UPDATE が二重実行される）。
  const write = Promise.resolve(
    db
      .update(treeNodes)
      .set({
        content: payload.content,
        ...(payload.unplacedBeatsDoc !== undefined && {
          unplacedBeatsDoc: payload.unplacedBeatsDoc,
          unplacedBeatPreview,
        }),
        ...(payload.charCount !== undefined && {
          charCount: payload.charCount,
        }),
        placedBeatPreview,
        // Editor saves provide the version observed at load time. Headless
        // authoritative writers omit it and intentionally retain the legacy
        // unconditional write contract.
        version: sql`${treeNodes.version} + 1`,
        updatedAt: contentUpdatedAt,
      })
      .where(
        payload.baseVersion === undefined
          ? eq(treeNodes.id, sceneId)
          : and(
              eq(treeNodes.id, sceneId),
              eq(treeNodes.version, payload.baseVersion),
            ),
      )
      .returning({
        id: treeNodes.id,
        projectId: treeNodes.projectId,
        contentVersion: treeNodes.version,
        contentUpdatedAt: treeNodes.updatedAt,
      }),
  );
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
  const rows = await serializeSceneWrite(sceneId, () =>
    Promise.resolve(
      db
        .update(treeNodes)
        .set({
          unplacedBeatsDoc: payload.unplacedBeatsDoc,
          unplacedBeatPreview,
          version: sql`${treeNodes.version} + 1`,
          updatedAt: nextTreeNodeMutationTimestamp(),
        })
        .where(
          and(
            eq(treeNodes.id, sceneId),
            eq(treeNodes.projectId, payload.projectId),
            eq(treeNodes.version, payload.baseVersion),
          ),
        )
        .returning({
          id: treeNodes.id,
          projectId: treeNodes.projectId,
          contentVersion: treeNodes.version,
          contentUpdatedAt: treeNodes.updatedAt,
        }),
    ),
  );
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
 * nodes but no cached preview yet.
 */
export async function savePlacedBeatPreviewOnly(
  sceneId: string,
  placedBeatPreview: string | null,
): Promise<void> {
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  // 同一 tree_nodes 行を書くため saveSceneContent と同じ per-scene チェーンに載せる。
  const rows = await serializeSceneWrite(sceneId, () =>
    Promise.resolve(
      db
        .update(treeNodes)
        .set({
          placedBeatPreview,
          updatedAt: nextTreeNodeMutationTimestamp(),
        })
        .where(eq(treeNodes.id, sceneId))
        .returning({
          id: treeNodes.id,
          projectId: treeNodes.projectId,
          updatedAt: treeNodes.updatedAt,
        }),
    ),
  );
  publishPersistedTreeNodeMutation(rows[0], workspaceIdentity);
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
