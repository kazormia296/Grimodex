import { db } from "@/db/client";
import {
  mapBoards,
  mapNodePositions,
  mapAiBranches,
  mapStickies,
  mapEdges,
  mapFrames,
  treeNodes,
  codexEntries,
  snippets,
  authorshipSpans,
  type MapBoard,
  type NewMapBoard,
  type MapNodePosition,
  type NewMapNodePosition,
  type MapAiBranch,
  type NewMapAiBranch,
  type MapSticky,
  type NewMapSticky,
  type MapEdge,
  type NewMapEdge,
  type MapFrame,
  type NewMapFrame,
  type AuthorshipSpan,
  type NewAuthorshipSpan,
} from "@/db/schema";
import { eq, and, isNotNull, inArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { generateKeyBetween } from "@/features/tree/fractionalIndex";
import type {
  NodeRefType,
  ShowFlags,
  MapBoardRecord,
  MapNodePositionRecord,
  ColorByAxis,
} from "./types";
import { DEFAULT_SHOW } from "./types";
import { DEFAULT_PALETTE_ID, DEFAULT_COLOR_SLOT } from "@/lib/stickyPalettes";
import { seedAuthorshipMarksJson } from "@/features/attribution/seedAuthorshipMarks";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { computeDocDiff, type BodyDiff } from "@/features/timelapse/bodyDiff";
import i18next from "@/lib/i18n";

/**
 * 執筆タイムラプス: Map 系操作を統一窓口で capture する。drag 中の
 * upsertNodePosition は将来 coalescing (200ms quiet / pointerup) を入れたい
 * が、現状は全 op を逐次記録する (チェーン健全性のみ担保、UI 影響は無視できる
 * 程度を想定)。
 */
function recordMapEvent(
  opType: string,
  entityId: string | null,
  payload: Record<string, unknown>,
): void {
  recordChangeEvent({
    domain: "map",
    opType,
    entityType: "map",
    entityId,
    payload,
  });
}

export { DEFAULT_SHOW } from "./types";

export function parseShowConfig(json: string): ShowFlags {
  try {
    const parsed = JSON.parse(json) as Partial<ShowFlags>;
    return { ...DEFAULT_SHOW, ...parsed };
  } catch {
    return { ...DEFAULT_SHOW };
  }
}

export function serializeShowConfig(show: ShowFlags): string {
  return JSON.stringify(show);
}

export type PromoteTargetType = "scene" | "note" | "snippet" | "codex";

/** Sticky IDs that should enter edit mode immediately on first mount. */
export const pendingAutoFocusIds = new Set<string>();

/**
 * UserEdge IDs (without "user:" prefix) that should auto-open the inline
 * label editor for the given field. Consumed by InlineLabel on the next
 * render and immediately cleared. Used by EdgeContextMenu「ラベル編集」.
 */
export const pendingEdgeLabelEdits = new Map<
  string,
  "forwardLabel" | "backwardLabel"
>();

// ── Board ──────────────────────────────────────────────────────────────────

export async function listBoards(projectId: string): Promise<MapBoard[]> {
  return db
    .select()
    .from(mapBoards)
    .where(eq(mapBoards.projectId, projectId))
    .orderBy(mapBoards.sortOrder);
}

export async function getMapBoard(
  boardId: string,
): Promise<MapBoard | undefined> {
  const rows = await db
    .select()
    .from(mapBoards)
    .where(eq(mapBoards.id, boardId))
    .limit(1);
  return rows[0];
}

export async function updateMapBoardSettings(
  boardId: string,
  partial: {
    mode?: MapBoardRecord["mode"];
    viewportX?: number;
    viewportY?: number;
    viewportZoom?: number;
    showConfig?: string;
    colorBy?: ColorByAxis;
  },
): Promise<MapBoard | undefined> {
  const now = new Date().toISOString();
  const rows = await db
    .update(mapBoards)
    .set({ ...partial, updatedAt: now })
    .where(eq(mapBoards.id, boardId))
    .returning();
  return rows[0];
}

export async function getOrCreateBoard(projectId: string): Promise<MapBoard> {
  const rows = await db
    .select()
    .from(mapBoards)
    .where(eq(mapBoards.projectId, projectId))
    .orderBy(mapBoards.sortOrder)
    .limit(1);

  if (rows.length > 0) return rows[0];

  const now = new Date().toISOString();
  const id = `${projectId}-main-board`;
  const inserted = await db
    .insert(mapBoards)
    .values({
      id,
      projectId,
      title: "Main",
      sortOrder: 0.0,
      mode: "free",
      viewportX: 0,
      viewportY: 0,
      viewportZoom: 1.0,
      showConfig: "{}",
      colorBy: "none",
      createdAt: now,
      updatedAt: now,
    } satisfies NewMapBoard)
    .returning();
  return inserted[0];
}

export async function createBoard(
  projectId: string,
  title: string,
): Promise<MapBoard> {
  const existing = await listBoards(projectId);
  const maxOrder = existing.reduce((m, b) => Math.max(m, b.sortOrder), 0);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(mapBoards)
    .values({
      id,
      projectId,
      title,
      sortOrder: maxOrder + 1.0,
      mode: "free",
      viewportX: 0,
      viewportY: 0,
      viewportZoom: 1.0,
      showConfig: "{}",
      colorBy: "none",
      createdAt: now,
      updatedAt: now,
    } satisfies NewMapBoard)
    .returning();
  return inserted[0];
}

export async function renameBoard(
  id: string,
  title: string,
): Promise<MapBoard | undefined> {
  const rows = await db
    .update(mapBoards)
    .set({ title, updatedAt: new Date().toISOString() })
    .where(eq(mapBoards.id, id))
    .returning();
  return rows[0];
}

export async function deleteBoard(id: string): Promise<void> {
  await db.delete(mapBoards).where(eq(mapBoards.id, id));
}

export type BoardEntityCounts = {
  stickies: number;
  aiBranches: number;
  userEdges: number;
  frames: number;
};

export async function countBoardEntities(
  boardId: string,
): Promise<BoardEntityCounts> {
  const [stickiesRows, aiBranchesRows, edgesRows, framesRows] =
    await Promise.all([
      db.select().from(mapStickies).where(eq(mapStickies.boardId, boardId)),
      db.select().from(mapAiBranches).where(eq(mapAiBranches.boardId, boardId)),
      db.select().from(mapEdges).where(eq(mapEdges.boardId, boardId)),
      db.select().from(mapFrames).where(eq(mapFrames.boardId, boardId)),
    ]);
  return {
    stickies: stickiesRows.length,
    aiBranches: aiBranchesRows.length,
    userEdges: edgesRows.length,
    frames: framesRows.length,
  };
}

export async function duplicateBoard(
  sourceId: string,
  projectId: string,
): Promise<MapBoard> {
  const source = await db
    .select()
    .from(mapBoards)
    .where(eq(mapBoards.id, sourceId))
    .limit(1);
  if (!source[0]) throw new Error(`Board ${sourceId} not found`);

  const existing = await listBoards(projectId);
  const maxOrder = existing.reduce((m, b) => Math.max(m, b.sortOrder), 0);
  const now = new Date().toISOString();
  const newBoardId = crypto.randomUUID();

  const newBoard = await db
    .insert(mapBoards)
    .values({
      id: newBoardId,
      projectId,
      title: i18next.t("map.board.duplicateTitle", { title: source[0].title }),
      sortOrder: maxOrder + 1.0,
      mode: source[0].mode,
      viewportX: source[0].viewportX,
      viewportY: source[0].viewportY,
      viewportZoom: source[0].viewportZoom,
      showConfig: source[0].showConfig,
      colorBy: source[0].colorBy,
      createdAt: now,
      updatedAt: now,
    } satisfies NewMapBoard)
    .returning();

  // Copy stickies
  const srcStickies = await db
    .select()
    .from(mapStickies)
    .where(eq(mapStickies.boardId, sourceId));
  const stickyIdMap = new Map<string, string>();
  for (const s of srcStickies) {
    const newId = crypto.randomUUID();
    stickyIdMap.set(s.id, newId);
    await db.insert(mapStickies).values({
      ...s,
      id: newId,
      boardId: newBoardId,
      aiBranchId: null,
      sourceChatMessageId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Copy positions
  const srcPositions = await db
    .select()
    .from(mapNodePositions)
    .where(eq(mapNodePositions.boardId, sourceId));
  const posIdMap = new Map<string, string>();
  for (const p of srcPositions) {
    const newId = crypto.randomUUID();
    posIdMap.set(p.id, newId);
    await db.insert(mapNodePositions).values({
      ...p,
      id: newId,
      boardId: newBoardId,
      stickyId: p.stickyId ? (stickyIdMap.get(p.stickyId) ?? null) : null,
      aiBranchId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Copy edges
  const srcEdges = await db
    .select()
    .from(mapEdges)
    .where(eq(mapEdges.boardId, sourceId));
  for (const e of srcEdges) {
    const newFrom = posIdMap.get(e.fromPositionId);
    const newTo = posIdMap.get(e.toPositionId);
    if (!newFrom || !newTo) continue;
    await db.insert(mapEdges).values({
      ...e,
      id: crypto.randomUUID(),
      boardId: newBoardId,
      fromPositionId: newFrom,
      toPositionId: newTo,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Copy frames
  const srcFrames = await db
    .select()
    .from(mapFrames)
    .where(eq(mapFrames.boardId, sourceId));
  for (const f of srcFrames) {
    await db.insert(mapFrames).values({
      ...f,
      id: crypto.randomUUID(),
      boardId: newBoardId,
      createdAt: now,
      updatedAt: now,
    });
  }

  return newBoard[0];
}

// ── Node positions ─────────────────────────────────────────────────────────

export async function listNodePositions(
  boardId: string,
): Promise<MapNodePosition[]> {
  return db
    .select()
    .from(mapNodePositions)
    .where(eq(mapNodePositions.boardId, boardId));
}

/** Find an existing position row on a board by one node-ref column.
 *  The redundant isNotNull keeps the generated SQL identical to the
 *  original per-column queries — eq already excludes NULL, do not remove. */
async function findExistingPosition(
  boardId: string,
  column: SQLiteColumn,
  value: string,
): Promise<MapNodePosition | undefined> {
  const rows = await db
    .select()
    .from(mapNodePositions)
    .where(
      and(
        eq(mapNodePositions.boardId, boardId),
        isNotNull(column),
        eq(column, value),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function upsertNodePosition(data: {
  boardId: string;
  nodeRefType: NodeRefType;
  treeNodeId?: string | null;
  codexEntryId?: string | null;
  snippetId?: string | null;
  stickyId?: string | null;
  aiBranchId?: string | null;
  x: number;
  y: number;
}): Promise<MapNodePosition> {
  const now = new Date().toISOString();

  let existing: MapNodePosition | undefined;
  if (data.treeNodeId) {
    existing = await findExistingPosition(
      data.boardId,
      mapNodePositions.treeNodeId,
      data.treeNodeId,
    );
  } else if (data.codexEntryId) {
    existing = await findExistingPosition(
      data.boardId,
      mapNodePositions.codexEntryId,
      data.codexEntryId,
    );
  } else if (data.snippetId) {
    existing = await findExistingPosition(
      data.boardId,
      mapNodePositions.snippetId,
      data.snippetId,
    );
  } else if (data.stickyId) {
    existing = await findExistingPosition(
      data.boardId,
      mapNodePositions.stickyId,
      data.stickyId,
    );
  } else if (data.aiBranchId) {
    existing = await findExistingPosition(
      data.boardId,
      mapNodePositions.aiBranchId,
      data.aiBranchId,
    );
  }

  if (existing) {
    const updated = await db
      .update(mapNodePositions)
      .set({ x: data.x, y: data.y, updatedAt: now })
      .where(eq(mapNodePositions.id, existing.id))
      .returning();
    recordMapEvent("position.move", updated[0]?.id ?? null, {
      boardId: data.boardId,
      x: data.x,
      y: data.y,
      ref: data.nodeRefType,
    });
    return updated[0];
  }

  const id = crypto.randomUUID();
  const insertData: NewMapNodePosition = {
    id,
    boardId: data.boardId,
    nodeRefType: data.nodeRefType,
    treeNodeId: data.treeNodeId ?? null,
    codexEntryId: data.codexEntryId ?? null,
    snippetId: data.snippetId ?? null,
    stickyId: data.stickyId ?? null,
    aiBranchId: data.aiBranchId ?? null,
    x: data.x,
    y: data.y,
    pinned: 0,
    zIndex: 0,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db
    .insert(mapNodePositions)
    .values(insertData)
    .returning();
  recordMapEvent("position.create", id, {
    boardId: data.boardId,
    x: data.x,
    y: data.y,
    ref: data.nodeRefType,
  });
  return inserted[0];
}

export async function updateNodePosition(
  id: string,
  update: {
    x?: number;
    y?: number;
    pinned?: number;
    zIndex?: number;
  },
): Promise<MapNodePosition | undefined> {
  const now = new Date().toISOString();
  const rows = await db
    .update(mapNodePositions)
    .set({ ...update, updatedAt: now })
    .where(eq(mapNodePositions.id, id))
    .returning();
  return rows[0];
}

export async function setNodePinned(
  positionId: string,
  pinned: boolean,
): Promise<MapNodePosition | undefined> {
  return updateNodePosition(positionId, { pinned: pinned ? 1 : 0 });
}

export async function deleteNodePosition(id: string): Promise<void> {
  await db.delete(mapNodePositions).where(eq(mapNodePositions.id, id));
  recordMapEvent("position.delete", id, {});
}

// ── Stickies ───────────────────────────────────────────────────────────────

/** Extract first 40 chars of plain text from ProseMirror JSON string. */
function extractAllText(bodyJson: string): string {
  try {
    const doc = JSON.parse(bodyJson) as { content?: unknown[] };
    const texts: string[] = [];
    function walk(node: unknown) {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: string; text?: string; content?: unknown[] };
      if (n.type === "text" && n.text) texts.push(n.text);
      else if (n.type === "table") {
        texts.push("(table)");
        return;
      } else if (n.type === "image") {
        texts.push("(image)");
        return;
      }
      if (n.content) for (const child of n.content) walk(child);
    }
    if (doc.content) for (const child of doc.content) walk(child);
    return texts.join("");
  } catch {
    return "";
  }
}

export function extractPreviewText(bodyJson: string): string {
  const full = extractAllText(bodyJson);
  return full.length > 40 ? full.slice(0, 40) + "…" : full;
}

export async function listStickies(boardId: string): Promise<MapSticky[]> {
  return db.select().from(mapStickies).where(eq(mapStickies.boardId, boardId));
}

export async function getSticky(id: string): Promise<MapSticky | undefined> {
  const rows = await db
    .select()
    .from(mapStickies)
    .where(eq(mapStickies.id, id))
    .limit(1);
  return rows[0];
}

export async function createSticky(data: {
  boardId: string;
  x: number;
  y: number;
  paletteId?: string;
  colorSlot?: number;
  title?: string;
  body?: string;
  id?: string;
}): Promise<{ sticky: MapSticky; position: MapNodePosition }> {
  const now = new Date().toISOString();
  const stickyId = data.id ?? crypto.randomUUID();
  const body = data.body ?? '{"type":"doc","content":[]}';
  const previewText = extractPreviewText(body);

  const [sticky] = await db
    .insert(mapStickies)
    .values({
      id: stickyId,
      boardId: data.boardId,
      title: data.title ?? null,
      body,
      previewText: previewText || null,
      paletteId: data.paletteId ?? DEFAULT_PALETTE_ID,
      colorSlot: data.colorSlot ?? DEFAULT_COLOR_SLOT,
      aiBranchId: null,
      sourceChatMessageId: null,
      createdAt: now,
      updatedAt: now,
    } satisfies NewMapSticky)
    .returning();

  const position = await upsertNodePosition({
    boardId: data.boardId,
    nodeRefType: "sticky",
    stickyId,
    x: data.x,
    y: data.y,
  });

  recordMapEvent("sticky.create", stickyId, {
    boardId: data.boardId,
    title: data.title ?? null,
  });
  return { sticky, position };
}

export async function updateSticky(
  id: string,
  update: {
    title?: string | null;
    body?: string;
    paletteId?: string;
    colorSlot?: number;
    previewText?: string | null;
  },
): Promise<MapSticky | undefined> {
  const now = new Date().toISOString();
  // body を更新するときだけ、差分記録用に旧 body を 1 件読む (頻度の低い
  // テキスト編集なので追加 SELECT は許容)。
  let beforeBody: string | null | undefined;
  if (update.body !== undefined) {
    const existing = await db
      .select({ body: mapStickies.body })
      .from(mapStickies)
      .where(eq(mapStickies.id, id))
      .limit(1);
    beforeBody = existing[0]?.body;
  }
  const set: Partial<NewMapSticky> = { updatedAt: now };
  if ("title" in update) set.title = update.title ?? null;
  if (update.body !== undefined) {
    set.body = update.body;
    set.previewText = extractPreviewText(update.body) || null;
  }
  if (update.paletteId !== undefined) set.paletteId = update.paletteId;
  if (update.colorSlot !== undefined) set.colorSlot = update.colorSlot;
  const rows = await db
    .update(mapStickies)
    .set(set)
    .where(eq(mapStickies.id, id))
    .returning();
  // 本文 (body, ProseMirror JSON) の変更差分を timelapse に記録する。
  const diffs: Record<string, BodyDiff> = {};
  if (update.body !== undefined) {
    const d = computeDocDiff(beforeBody ?? "", update.body ?? "");
    if (d) diffs.body = d;
  }
  recordMapEvent("sticky.update", id, {
    fields: Object.keys(update),
    ...(diffs.body ? { diffs } : {}),
  });
  return rows[0];
}

export async function deleteSticky(id: string): Promise<void> {
  await db.delete(mapStickies).where(eq(mapStickies.id, id));
  recordMapEvent("sticky.delete", id, {});
}

/**
 * 「採用」: AI Branch 由来 Sticky を branch から切り離して通常 Sticky 化する。
 * - aiBranchId を null にする (= branch 所属を解除)。これで derivedStickyCount
 *   から外れ、branch 削除に巻き込まれなくなり、他の Sticky と同じ扱いになる。
 * - branch→sticky の点線エッジ (createAiBranch が永続化したもの) を削除する。
 * - **ai_derived は維持する** (Plan B): 「AI が生成した」出自は採用後も残し、
 *   StickyNode の onCopy 帰属ラベルが "ai" のままになるようにする。本文 JSON の
 *   authorship マークと authorshipSpans 行も触らない。
 *
 * 戻り値は undo (reattachSticky) に必要な情報。aiBranchId が既に null の
 * (= 通常 Sticky / 採用済み) 場合は no-op で removedEdge=null を返す。
 */
export async function adoptSticky(stickyId: string): Promise<{
  sticky: MapSticky;
  previousAiBranchId: string | null;
  removedEdge: MapEdge | null;
}> {
  const [sticky] = await db
    .select()
    .from(mapStickies)
    .where(eq(mapStickies.id, stickyId))
    .limit(1);
  if (!sticky) throw new Error(`Sticky ${stickyId} not found`);

  const branchId = sticky.aiBranchId;
  let removedEdge: MapEdge | null = null;

  if (branchId) {
    // 点線エッジ branchPos → stickyPos を特定して削除する。
    const [stickyPos] = await db
      .select()
      .from(mapNodePositions)
      .where(
        and(
          eq(mapNodePositions.boardId, sticky.boardId),
          eq(mapNodePositions.stickyId, stickyId),
        ),
      )
      .limit(1);
    const [branchPos] = await db
      .select()
      .from(mapNodePositions)
      .where(
        and(
          eq(mapNodePositions.boardId, sticky.boardId),
          eq(mapNodePositions.aiBranchId, branchId),
        ),
      )
      .limit(1);
    if (stickyPos && branchPos) {
      const [edge] = await db
        .select()
        .from(mapEdges)
        .where(
          and(
            eq(mapEdges.fromPositionId, branchPos.id),
            eq(mapEdges.toPositionId, stickyPos.id),
          ),
        )
        .limit(1);
      if (edge) {
        await db.delete(mapEdges).where(eq(mapEdges.id, edge.id));
        removedEdge = edge;
      }
    }
  }

  const now = new Date().toISOString();
  const [updated] = await db
    .update(mapStickies)
    .set({ aiBranchId: null, updatedAt: now })
    .where(eq(mapStickies.id, stickyId))
    .returning();
  recordMapEvent("sticky.adopt", stickyId, { branchId });
  return { sticky: updated, previousAiBranchId: branchId, removedEdge };
}

/**
 * `adoptSticky` の逆操作 (undo 用)。aiBranchId を元の branch に戻し、削除済みの
 * 点線エッジを (あれば) 復元する。restoreAiBranchSnapshot の orphan 再リンクと
 * 同型。branch が既に消えている場合 FK 制約で失敗しうるが、採用直後の undo を
 * 想定しているため通常は branch が生きている。
 */
export async function reattachSticky(
  stickyId: string,
  branchId: string,
  edge: MapEdge | null,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(mapStickies)
    .set({ aiBranchId: branchId, updatedAt: now })
    .where(eq(mapStickies.id, stickyId));
  if (edge) {
    await db.insert(mapEdges).values(edge).onConflictDoNothing();
  }
  recordMapEvent("sticky.reattach", stickyId, { branchId });
}

/**
 * AI Branch の派生 Sticky を全件「採用」する (一括採用、コンテキストメニュー用)。
 * 各 Sticky を adoptSticky で処理し、undo に必要な結果配列を返す。
 */
export async function adoptAllForBranch(branchId: string): Promise<
  Array<{
    sticky: MapSticky;
    previousAiBranchId: string | null;
    removedEdge: MapEdge | null;
  }>
> {
  const derived = await db
    .select()
    .from(mapStickies)
    .where(eq(mapStickies.aiBranchId, branchId));
  const results: Array<{
    sticky: MapSticky;
    previousAiBranchId: string | null;
    removedEdge: MapEdge | null;
  }> = [];
  for (const s of derived) {
    results.push(await adoptSticky(s.id));
  }
  return results;
}

/**
 * Promote a Sticky to a structured entity (Scene/Note/Snippet/Codex).
 * - Creates the new entity with sticky title + body as content
 * - Updates the map_node_positions row in-place (same ID, new entity reference)
 * - Deletes the sticky
 */
export async function promoteSticky(
  stickyId: string,
  positionId: string,
  targetType: PromoteTargetType,
  options: { projectId: string; codexType?: string },
): Promise<{ newEntityId: string; updatedPosition: MapNodePosition }> {
  const [sticky] = await db
    .select()
    .from(mapStickies)
    .where(eq(mapStickies.id, stickyId))
    .limit(1);
  if (!sticky) throw new Error(`Sticky ${stickyId} not found`);

  const title = sticky.title || "Untitled";
  const body = sticky.body || '{"type":"doc","content":[]}';
  const now = new Date().toISOString();
  let newEntityId: string;
  let nodeRefType: NodeRefType;

  if (targetType === "scene" || targetType === "note") {
    newEntityId = crypto.randomUUID();
    // Place under the default chapter with a proper sort order
    const DEFAULT_CHAPTER_ID = "default-chapter";
    const siblings = await db
      .select()
      .from(treeNodes)
      .where(eq(treeNodes.parentId, DEFAULT_CHAPTER_ID));
    const lastKey = siblings.length
      ? siblings.sort((a, b) => (a.sortOrder > b.sortOrder ? 1 : -1)).at(-1)!
          .sortOrder
      : null;
    const sortOrder = generateKeyBetween(lastKey, null);
    await db.insert(treeNodes).values({
      id: newEntityId,
      projectId: options.projectId,
      parentId: DEFAULT_CHAPTER_ID,
      nodeType: targetType,
      title,
      sortOrder,
      content: body,
      createdAt: now,
      updatedAt: now,
    });
    nodeRefType = targetType;
  } else if (targetType === "snippet") {
    newEntityId = crypto.randomUUID();
    await db.insert(snippets).values({
      id: newEntityId,
      projectId: options.projectId,
      title,
      content: body,
      createdAt: now,
      updatedAt: now,
    });
    nodeRefType = "snippet";
  } else {
    // codex
    newEntityId = crypto.randomUUID();
    const type = options.codexType ?? "character";
    await db.insert(codexEntries).values({
      id: newEntityId,
      projectId: options.projectId,
      type,
      name: title,
      content: body,
      createdAt: now,
      updatedAt: now,
    });
    nodeRefType = "codex";
  }

  const [updatedPosition] = await db
    .update(mapNodePositions)
    .set({
      nodeRefType,
      treeNodeId:
        targetType === "scene" || targetType === "note" ? newEntityId : null,
      codexEntryId: targetType === "codex" ? newEntityId : null,
      snippetId: targetType === "snippet" ? newEntityId : null,
      stickyId: null,
      aiBranchId: null,
      updatedAt: now,
    })
    .where(eq(mapNodePositions.id, positionId))
    .returning();

  // Migrate authorship spans to the new entity before CASCADE deletes them
  await db
    .update(authorshipSpans)
    .set({
      nodeId:
        targetType === "scene" || targetType === "note" ? newEntityId : null,
      codexEntryId: targetType === "codex" ? newEntityId : null,
      snippetId: targetType === "snippet" ? newEntityId : null,
      stickyId: null,
    })
    .where(eq(authorshipSpans.stickyId, stickyId));

  await db.delete(mapStickies).where(eq(mapStickies.id, stickyId));

  return { newEntityId, updatedPosition };
}

// ── AI Branches ────────────────────────────────────────────────────────────

export async function listAiBranches(boardId: string): Promise<MapAiBranch[]> {
  return db
    .select()
    .from(mapAiBranches)
    .where(eq(mapAiBranches.boardId, boardId));
}

export type AiBranchCard = { title: string; body: string };

export async function createAiBranch(
  boardId: string,
  prompt: string,
  seedNodeIds: string[],
  cards: AiBranchCard[],
  options?: {
    sessionId?: string | null;
    model?: string | null;
    spawnX?: number;
    spawnY?: number;
    /**
     * Top-left coordinates for each card, in the same order as `cards`.
     * Caller is expected to compute these via computeAiBranchLayout so it can
     * factor in existing on-board positions. When omitted or length mismatch,
     * falls back to a radial layout around the spawn point (legacy behavior).
     */
    cardPositions?: { x: number; y: number }[];
  },
): Promise<{
  branch: MapAiBranch;
  stickies: MapSticky[];
  positions: MapNodePosition[];
  edges: MapEdge[];
}> {
  const now = new Date().toISOString();
  const branchId = crypto.randomUUID();
  const spawnX = options?.spawnX ?? 0;
  const spawnY = options?.spawnY ?? 0;
  const cardPositions =
    options?.cardPositions && options.cardPositions.length === cards.length
      ? options.cardPositions
      : null;

  const [branch] = await db
    .insert(mapAiBranches)
    .values({
      id: branchId,
      boardId,
      prompt,
      seedNodeIds: JSON.stringify(seedNodeIds),
      sessionId: options?.sessionId ?? null,
      model: options?.model ?? null,
      // N4: トークン使用量は ai_usage 台帳 (surface='map_branch') に記録する。
      // この列は読み手の無いレガシー placeholder のため null のまま据え置く。
      tokenUsage: null,
      createdAt: now,
      updatedAt: now,
    } satisfies NewMapAiBranch)
    .returning();

  // Place branch node at the spawn position
  const branchPosId = crypto.randomUUID();
  const [branchPosition] = await db
    .insert(mapNodePositions)
    .values({
      id: branchPosId,
      boardId,
      nodeRefType: "ai_branch",
      aiBranchId: branchId,
      treeNodeId: null,
      codexEntryId: null,
      snippetId: null,
      stickyId: null,
      x: spawnX,
      y: spawnY,
      pinned: 0,
      zIndex: 0,
      createdAt: now,
      updatedAt: now,
    } satisfies NewMapNodePosition)
    .returning();

  const stickies: MapSticky[] = [];
  const positions: MapNodePosition[] = [branchPosition];
  const edges: MapEdge[] = [];

  const angleStep = cards.length > 0 ? (2 * Math.PI) / cards.length : 0;
  const radius = 280;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const stickyId = crypto.randomUUID();
    const posId = crypto.randomUUID();
    // Seed the body with "ai" authorship marks so the sticky is self-describing:
    // when a human later edits it, AiEditedPlugin strips the mark from inserted
    // text, leaving per-span provenance that copy serialization carries. The
    // authorshipSpans row below tracks sticky-level provenance for promotion.
    const body = seedAuthorshipMarksJson(
      card.body || '{"type":"doc","content":[]}',
      { source: "ai", timestamp: now, model: options?.model ?? null },
    );
    const previewText = extractPreviewText(body);

    let x: number;
    let y: number;
    if (cardPositions) {
      x = cardPositions[i].x;
      y = cardPositions[i].y;
    } else {
      const angle = angleStep * i - Math.PI / 2;
      x = spawnX + Math.round(radius * Math.cos(angle));
      y = spawnY + Math.round(radius * Math.sin(angle));
    }

    const [sticky] = await db
      .insert(mapStickies)
      .values({
        id: stickyId,
        boardId,
        title: card.title || null,
        body,
        previewText: previewText || null,
        paletteId: DEFAULT_PALETTE_ID,
        colorSlot: DEFAULT_COLOR_SLOT,
        aiBranchId: branchId,
        aiDerived: 1,
        sourceChatMessageId: null,
        createdAt: now,
        updatedAt: now,
      } satisfies NewMapSticky)
      .returning();

    const [pos] = await db
      .insert(mapNodePositions)
      .values({
        id: posId,
        boardId,
        nodeRefType: "sticky",
        stickyId,
        aiBranchId: null,
        treeNodeId: null,
        codexEntryId: null,
        snippetId: null,
        x,
        y,
        pinned: 0,
        zIndex: 0,
        createdAt: now,
        updatedAt: now,
      } satisfies NewMapNodePosition)
      .returning();

    // Dashed edge: branch → sticky
    const [edge] = await db
      .insert(mapEdges)
      .values({
        id: crypto.randomUUID(),
        boardId,
        fromPositionId: branchPosId,
        toPositionId: posId,
        forwardLabel: null,
        backwardLabel: null,
        labels: "[]",
        style: "dashed",
        color: "#888888",
        direction: "forward",
        createdAt: now,
        updatedAt: now,
      } satisfies NewMapEdge)
      .returning();

    // Authorship span covering the full body (use full text, not truncated preview)
    const bodyLen = extractAllText(body).length;
    await db.insert(authorshipSpans).values({
      id: crypto.randomUUID(),
      stickyId,
      nodeId: null,
      codexEntryId: null,
      snippetId: null,
      detailValueId: null,
      fromPos: 0,
      toPos: Math.max(bodyLen, 1),
      source: "ai",
      model: options?.model ?? null,
      timestamp: now,
      chatMsgId: null,
      phaseId: null,
    } satisfies NewAuthorshipSpan);

    stickies.push(sticky);
    positions.push(pos);
    edges.push(edge);
  }

  return { branch, stickies, positions, edges };
}

export async function deleteAiBranch(id: string): Promise<void> {
  await db.delete(mapAiBranches).where(eq(mapAiBranches.id, id));
}

export interface AiBranchSnapshot {
  branch: MapAiBranch;
  branchPosition: MapNodePosition;
  stickies: MapSticky[];
  stickyPositions: MapNodePosition[];
  edges: MapEdge[];
  spans: AuthorshipSpan[];
}

/**
 * Capture the full state of an AI branch (branch row + branch position +
 * derived stickies + their positions + dashed edges + authorship spans) for
 * Undo/Redo snapshot-restore.
 */
export async function getAiBranchSnapshot(
  id: string,
): Promise<AiBranchSnapshot | null> {
  const branchRows = await db
    .select()
    .from(mapAiBranches)
    .where(eq(mapAiBranches.id, id))
    .limit(1);
  const branch = branchRows[0];
  if (!branch) return null;

  const branchPosRows = await db
    .select()
    .from(mapNodePositions)
    .where(
      and(
        eq(mapNodePositions.boardId, branch.boardId),
        isNotNull(mapNodePositions.aiBranchId),
        eq(mapNodePositions.aiBranchId, id),
      ),
    )
    .limit(1);
  const branchPosition = branchPosRows[0];
  if (!branchPosition) return null;

  const stickies = await db
    .select()
    .from(mapStickies)
    .where(eq(mapStickies.aiBranchId, id));

  const stickyIds = stickies.map((s) => s.id);
  const stickyPositions =
    stickyIds.length > 0
      ? await db
          .select()
          .from(mapNodePositions)
          .where(
            and(
              eq(mapNodePositions.boardId, branch.boardId),
              inArray(mapNodePositions.stickyId, stickyIds),
            ),
          )
      : [];

  const edges = await db
    .select()
    .from(mapEdges)
    .where(eq(mapEdges.fromPositionId, branchPosition.id));

  const spans =
    stickyIds.length > 0
      ? await db
          .select()
          .from(authorshipSpans)
          .where(inArray(authorshipSpans.stickyId, stickyIds))
      : [];

  return { branch, branchPosition, stickies, stickyPositions, edges, spans };
}

/**
 * Re-insert all rows captured by getAiBranchSnapshot. Use as the redo path
 * for an AI branch creation undo, or the undo path for a deletion (whether
 * the prior deletion was a full erase or an explicit `deleteAiBranch` that
 * preserved orphan stickies — onConflictDoNothing handles both, and the
 * explicit aiBranchId UPDATE re-links any orphans back to this branch).
 */
export async function restoreAiBranchSnapshot(
  snapshot: AiBranchSnapshot,
): Promise<void> {
  await db.insert(mapAiBranches).values(snapshot.branch).onConflictDoNothing();
  await db
    .insert(mapNodePositions)
    .values(snapshot.branchPosition)
    .onConflictDoNothing();
  for (const sticky of snapshot.stickies) {
    await db.insert(mapStickies).values(sticky).onConflictDoNothing();
    // Re-link orphan stickies (aiBranchId was set NULL by ON DELETE SET NULL)
    await db
      .update(mapStickies)
      .set({ aiBranchId: snapshot.branch.id })
      .where(eq(mapStickies.id, sticky.id));
  }
  for (const pos of snapshot.stickyPositions) {
    await db.insert(mapNodePositions).values(pos).onConflictDoNothing();
  }
  for (const edge of snapshot.edges) {
    await db.insert(mapEdges).values(edge).onConflictDoNothing();
  }
  for (const span of snapshot.spans) {
    await db.insert(authorshipSpans).values(span).onConflictDoNothing();
  }
}

/**
 * Delete all rows captured in the snapshot. Use as the redo path for a
 * deletion (or the undo path for a creation). Deletes go in reverse FK order.
 */
export async function eraseAiBranchSnapshot(
  snapshot: AiBranchSnapshot,
): Promise<void> {
  // mapAiBranches deletion cascades to: branch position (ai_branch_id cascade),
  // and edges from that position (position cascade). Stickies' aiBranchId is
  // set null. So we still need to explicitly delete the derived stickies and
  // their positions and authorship spans.
  for (const span of snapshot.spans) {
    await db.delete(authorshipSpans).where(eq(authorshipSpans.id, span.id));
  }
  for (const pos of snapshot.stickyPositions) {
    await db.delete(mapNodePositions).where(eq(mapNodePositions.id, pos.id));
  }
  for (const sticky of snapshot.stickies) {
    await db.delete(mapStickies).where(eq(mapStickies.id, sticky.id));
  }
  // Branch deletion cascades to branch position + edges from that position
  await db
    .delete(mapAiBranches)
    .where(eq(mapAiBranches.id, snapshot.branch.id));
}

// ── User edges ─────────────────────────────────────────────────────────────

export async function listUserEdges(boardId: string): Promise<MapEdge[]> {
  return db.select().from(mapEdges).where(eq(mapEdges.boardId, boardId));
}

export async function createUserEdge(data: {
  boardId: string;
  fromPositionId: string;
  toPositionId: string;
  forwardLabel?: string | null;
  backwardLabel?: string | null;
  style?: NewMapEdge["style"];
  color?: string;
  direction?: NewMapEdge["direction"];
  id?: string;
}): Promise<MapEdge> {
  const now = new Date().toISOString();
  const id = data.id ?? crypto.randomUUID();
  const insertData: NewMapEdge = {
    id,
    boardId: data.boardId,
    fromPositionId: data.fromPositionId,
    toPositionId: data.toPositionId,
    forwardLabel: data.forwardLabel ?? null,
    backwardLabel: data.backwardLabel ?? null,
    labels: "[]",
    style: data.style ?? "solid",
    color: data.color ?? "currentColor",
    direction: data.direction ?? "none",
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db.insert(mapEdges).values(insertData).returning();
  recordMapEvent("edge.create", id, {
    boardId: data.boardId,
    from: data.fromPositionId,
    to: data.toPositionId,
  });
  return inserted[0];
}

export async function updateUserEdge(
  id: string,
  update: {
    forwardLabel?: string | null;
    backwardLabel?: string | null;
    labels?: string;
    style?: NewMapEdge["style"];
    color?: string;
    direction?: NewMapEdge["direction"];
  },
): Promise<MapEdge | undefined> {
  const now = new Date().toISOString();
  const rows = await db
    .update(mapEdges)
    .set({ ...update, updatedAt: now })
    .where(eq(mapEdges.id, id))
    .returning();
  recordMapEvent("edge.update", id, { fields: Object.keys(update) });
  return rows[0];
}

export async function deleteUserEdge(id: string): Promise<void> {
  await db.delete(mapEdges).where(eq(mapEdges.id, id));
  recordMapEvent("edge.delete", id, {});
}

/**
 * Phase C: Promote a User edge (both ends Codex) to a formal codex_relation.
 * Deletes the user edge after creating the relation (derived edge renders instead).
 */
export async function promoteUserEdgeToCodexRelation(
  edgeId: string,
  projectId: string,
  positions: MapNodePositionRecord[],
): Promise<{ relationId: string } | null> {
  const edges = await db.select().from(mapEdges).where(eq(mapEdges.id, edgeId));
  const edge = edges[0];
  if (!edge) return null;

  const fromPos = positions.find((p) => p.id === edge.fromPositionId);
  const toPos = positions.find((p) => p.id === edge.toPositionId);
  const fromCodexId =
    fromPos?.nodeRefType === "codex" ? fromPos.codexEntryId : null;
  const toCodexId = toPos?.nodeRefType === "codex" ? toPos.codexEntryId : null;
  if (!fromCodexId || !toCodexId) return null;

  const { createCodexRelation, findCodexRelationByEdgeEndpoints } =
    await import("@/features/codex/codexRelationApi");
  const { slugifyRelationType } =
    await import("@/features/codex/relationExpansion");

  const relationType = slugifyRelationType(edge.forwardLabel);
  const existing = await findCodexRelationByEdgeEndpoints(
    fromCodexId,
    toCodexId,
    relationType,
  );
  if (existing) {
    await deleteUserEdge(edgeId);
    return { relationId: existing.id };
  }

  const relation = await createCodexRelation({
    projectId,
    fromCodexId,
    toCodexId,
    relationType,
    label: edge.forwardLabel?.trim() || null,
    sourceMapEdgeId: edgeId,
  });
  await deleteUserEdge(edgeId);
  return { relationId: relation.id };
}

// ── Frames ─────────────────────────────────────────────────────────────────

export async function listFrames(boardId: string): Promise<MapFrame[]> {
  return db.select().from(mapFrames).where(eq(mapFrames.boardId, boardId));
}

export async function createFrame(data: {
  boardId: string;
  title?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  background?: string;
  borderColor?: string;
  id?: string;
}): Promise<MapFrame> {
  const now = new Date().toISOString();
  const id = data.id ?? crypto.randomUUID();
  const insertData: NewMapFrame = {
    id,
    boardId: data.boardId,
    title: data.title ?? "Frame",
    x: data.x,
    y: data.y,
    width: data.width,
    height: data.height,
    background: data.background ?? "transparent",
    borderColor: data.borderColor ?? "var(--muted-foreground)",
    zIndex: -1,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db.insert(mapFrames).values(insertData).returning();
  recordMapEvent("frame.create", id, { boardId: data.boardId });
  return inserted[0];
}

export async function updateFrame(
  id: string,
  update: {
    title?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    background?: string;
    borderColor?: string;
  },
): Promise<MapFrame | undefined> {
  const now = new Date().toISOString();
  const rows = await db
    .update(mapFrames)
    .set({ ...update, updatedAt: now })
    .where(eq(mapFrames.id, id))
    .returning();
  recordMapEvent("frame.update", id, { fields: Object.keys(update) });
  return rows[0];
}

export async function deleteFrame(id: string): Promise<void> {
  await db.delete(mapFrames).where(eq(mapFrames.id, id));
  recordMapEvent("frame.delete", id, {});
}

/**
 * Promote a Frame to a Codex entry by aggregating contained Sticky bodies.
 * - Stickies whose center (x,y) falls inside the frame bounds are collected
 * - Their titles (if any) become H3 headings; bodies are concatenated
 * - A new Codex entry is created; the frame + its stickies are deleted
 * - A new map_node_positions row is created at the frame center
 */
export async function promoteFrame(
  frameId: string,
  boardId: string,
  options: { projectId: string; codexType?: string },
): Promise<{ newEntityId: string }> {
  const [frame] = await db
    .select()
    .from(mapFrames)
    .where(eq(mapFrames.id, frameId))
    .limit(1);
  if (!frame) throw new Error(`Frame ${frameId} not found`);

  // Find sticky positions within frame bounds
  const allPositions = await db
    .select()
    .from(mapNodePositions)
    .where(
      and(
        eq(mapNodePositions.boardId, boardId),
        isNotNull(mapNodePositions.stickyId),
      ),
    );

  // Use center of sticky node (fixed width 240px, approximate height 80px)
  const STICKY_HALF_W = 120;
  const STICKY_HALF_H = 40;
  const insidePositions = allPositions.filter(
    (p) =>
      p.x + STICKY_HALF_W >= frame.x &&
      p.x + STICKY_HALF_W <= frame.x + frame.width &&
      p.y + STICKY_HALF_H >= frame.y &&
      p.y + STICKY_HALF_H <= frame.y + frame.height,
  );

  // Load sticky bodies
  const insideStickyIds = insidePositions
    .map((p) => p.stickyId)
    .filter(Boolean) as string[];

  const insideStickies =
    insideStickyIds.length > 0
      ? await db
          .select()
          .from(mapStickies)
          .where(
            insideStickyIds.length === 1
              ? eq(mapStickies.id, insideStickyIds[0])
              : eq(mapStickies.boardId, boardId),
          )
          .then((rows) => rows.filter((s) => insideStickyIds.includes(s.id)))
      : [];

  // Build merged ProseMirror JSON
  const mergedContent: unknown[] = [];
  for (const sticky of insideStickies) {
    if (sticky.title) {
      mergedContent.push({
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: sticky.title }],
      });
    }
    try {
      const doc = JSON.parse(sticky.body) as { content?: unknown[] };
      if (doc.content) mergedContent.push(...doc.content);
    } catch {
      // ignore malformed body
    }
  }

  const now = new Date().toISOString();
  const codexId = crypto.randomUUID();
  const codexType = options.codexType ?? "lore";

  await db.insert(codexEntries).values({
    id: codexId,
    projectId: options.projectId,
    type: codexType,
    name: frame.title || "Untitled",
    content: JSON.stringify({ type: "doc", content: mergedContent }),
    createdAt: now,
    updatedAt: now,
  });

  // Migrate authorship spans to the new Codex entry before CASCADE deletes them
  for (const stickyId of insideStickyIds) {
    await db
      .update(authorshipSpans)
      .set({ codexEntryId: codexId, stickyId: null })
      .where(eq(authorshipSpans.stickyId, stickyId));
  }

  // Delete stickies (cascades to positions via stickyId FK)
  for (const stickyId of insideStickyIds) {
    await db.delete(mapStickies).where(eq(mapStickies.id, stickyId));
  }

  // Create position for the new Codex entry at frame center
  await upsertNodePosition({
    boardId,
    nodeRefType: "codex",
    codexEntryId: codexId,
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  });

  // Delete the frame
  await db.delete(mapFrames).where(eq(mapFrames.id, frameId));

  return { newEntityId: codexId };
}
