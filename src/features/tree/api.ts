import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { extractUnplacedBeatPreview } from "@/features/editor/beat/unplacedBeatPreview";
import { extractPlacedBeatPreviewFromString } from "@/features/editor/beat/placedBeatPreview";
import {
  trackSceneContentWrite,
  awaitPendingSceneContentWrite,
} from "@/features/tree/pendingSceneWrites";
import { debugLog } from "@/lib/debugLog";

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

export async function listNodes(
  projectId: string,
  parentId?: string | null,
): Promise<TreeNode[]> {
  const notArchived = isNull(treeNodes.archivedAt);
  if (parentId !== undefined) {
    if (parentId === null) {
      return db
        .select()
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
      .select()
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
    .select()
    .from(treeNodes)
    .where(and(eq(treeNodes.projectId, projectId), notArchived));
}

/** Includes archived nodes — for external mount reconciliation only. */
export async function listAllNodes(projectId: string): Promise<TreeNode[]> {
  return db.select().from(treeNodes).where(eq(treeNodes.projectId, projectId));
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
  const now = new Date().toISOString();
  const rows = await db
    .insert(treeNodes)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
}

export async function updateNode(
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
  const rows = await db
    .update(treeNodes)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(treeNodes.id, id))
    .returning();
  return rows[0];
}

export async function deleteNode(id: string): Promise<void> {
  await db.delete(treeNodes).where(eq(treeNodes.id, id));
}

// --- Scene content operations ---

export interface SaveScenePayload {
  content: string;
  unplacedBeatsDoc?: string;
  charCount?: number;
}

export interface DerivedPreviews {
  /** Always recomputed from `payload.content`. */
  placedBeatPreview: string | null;
  /** Recomputed from `unplacedBeatsDoc` when that field is part of the payload. */
  unplacedBeatPreview?: string | null;
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

  // Promise.resolve で drizzle の thenable を即 1 回だけ実行に固定してから
  // track する（thenable のまま 2 箇所で await すると UPDATE が二重実行される）。
  // track はこの関数の最初の await より前 = 呼び出しと同期で行うこと。unmount
  // cleanup からの fire-and-forget flush でも、直後の load が pending を見える。
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
        updatedAt: new Date().toISOString(),
      })
      .where(eq(treeNodes.id, sceneId)),
  );
  trackSceneContentWrite(sceneId, write);
  await write;

  return { placedBeatPreview, unplacedBeatPreview };
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
 * Save unplaced beats doc + preview without touching content.
 * Used by Grid "Add unplaced beat" to avoid overwriting in-Editor unsaved changes.
 */
/**
 * Save unplaced beats doc only (no `content` write). The cached preview is
 * derived internally so callers can't forget. Returns the new preview value.
 *
 * Does NOT touch `placed_beat_preview` — that cache is derived from `content`,
 * which this function never modifies.
 */
export async function saveSceneBeatsOnly(
  sceneId: string,
  payload: { unplacedBeatsDoc: string },
): Promise<{ unplacedBeatPreview: string | null }> {
  const unplacedBeatPreview = deriveUnplacedPreview(payload.unplacedBeatsDoc);
  await db
    .update(treeNodes)
    .set({
      unplacedBeatsDoc: payload.unplacedBeatsDoc,
      unplacedBeatPreview,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(treeNodes.id, sceneId));
  return { unplacedBeatPreview };
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
  await db
    .update(treeNodes)
    .set({
      placedBeatPreview,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(treeNodes.id, sceneId));
}

/** Load scene content + unplaced beats doc in one query. */
export async function loadSceneFull(
  sceneId: string,
): Promise<{ content: string; unplacedBeatsDoc: string }> {
  // loadSceneContent と同じ read-after-write バリア (pendingSceneWrites 参照)。
  await awaitPendingSceneContentWrite(sceneId);
  const rows = await db
    .select({
      content: treeNodes.content,
      unplacedBeatsDoc: treeNodes.unplacedBeatsDoc,
    })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  return {
    content: rows[0]?.content ?? "",
    unplacedBeatsDoc: rows[0]?.unplacedBeatsDoc ?? "[]",
  };
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
