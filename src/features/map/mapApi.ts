import { db } from "@/db/client";
import {
  mapBoards,
  mapNodePositions,
  mapAiBranches,
  mapStickies,
  mapEdges,
  mapFrames,
  type MapBoard,
  type NewMapBoard,
  type MapNodePosition,
  type NewMapNodePosition,
  type MapAiBranch,
  type MapSticky,
  type NewMapSticky,
  type MapEdge,
  type NewMapEdge,
  type MapFrame,
  type NewMapFrame,
} from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import type { NodeRefType, StickyColor } from "./types";

// ── Board ──────────────────────────────────────────────────────────────────

export async function listBoards(projectId: string): Promise<MapBoard[]> {
  return db
    .select()
    .from(mapBoards)
    .where(eq(mapBoards.projectId, projectId))
    .orderBy(mapBoards.sortOrder);
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
      title: `${source[0].title} (コピー)`,
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
    const rows = await db
      .select()
      .from(mapNodePositions)
      .where(
        and(
          eq(mapNodePositions.boardId, data.boardId),
          isNotNull(mapNodePositions.treeNodeId),
          eq(mapNodePositions.treeNodeId, data.treeNodeId),
        ),
      )
      .limit(1);
    existing = rows[0];
  } else if (data.codexEntryId) {
    const rows = await db
      .select()
      .from(mapNodePositions)
      .where(
        and(
          eq(mapNodePositions.boardId, data.boardId),
          isNotNull(mapNodePositions.codexEntryId),
          eq(mapNodePositions.codexEntryId, data.codexEntryId),
        ),
      )
      .limit(1);
    existing = rows[0];
  } else if (data.snippetId) {
    const rows = await db
      .select()
      .from(mapNodePositions)
      .where(
        and(
          eq(mapNodePositions.boardId, data.boardId),
          isNotNull(mapNodePositions.snippetId),
          eq(mapNodePositions.snippetId, data.snippetId),
        ),
      )
      .limit(1);
    existing = rows[0];
  } else if (data.stickyId) {
    const rows = await db
      .select()
      .from(mapNodePositions)
      .where(
        and(
          eq(mapNodePositions.boardId, data.boardId),
          isNotNull(mapNodePositions.stickyId),
          eq(mapNodePositions.stickyId, data.stickyId),
        ),
      )
      .limit(1);
    existing = rows[0];
  } else if (data.aiBranchId) {
    const rows = await db
      .select()
      .from(mapNodePositions)
      .where(
        and(
          eq(mapNodePositions.boardId, data.boardId),
          isNotNull(mapNodePositions.aiBranchId),
          eq(mapNodePositions.aiBranchId, data.aiBranchId),
        ),
      )
      .limit(1);
    existing = rows[0];
  }

  if (existing) {
    const updated = await db
      .update(mapNodePositions)
      .set({ x: data.x, y: data.y, updatedAt: now })
      .where(eq(mapNodePositions.id, existing.id))
      .returning();
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
}

// ── Stickies ───────────────────────────────────────────────────────────────

/** Extract first 40 chars of plain text from ProseMirror JSON string. */
export function extractPreviewText(bodyJson: string): string {
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
    const full = texts.join("");
    return full.length > 40 ? full.slice(0, 40) + "…" : full;
  } catch {
    return "";
  }
}

export async function listStickies(boardId: string): Promise<MapSticky[]> {
  return db.select().from(mapStickies).where(eq(mapStickies.boardId, boardId));
}

export async function createSticky(data: {
  boardId: string;
  x: number;
  y: number;
  color?: StickyColor;
  title?: string;
  body?: string;
}): Promise<{ sticky: MapSticky; position: MapNodePosition }> {
  const now = new Date().toISOString();
  const stickyId = crypto.randomUUID();
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
      color: data.color ?? "yellow",
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

  return { sticky, position };
}

export async function updateSticky(
  id: string,
  update: {
    title?: string | null;
    body?: string;
    color?: StickyColor;
    previewText?: string | null;
  },
): Promise<MapSticky | undefined> {
  const now = new Date().toISOString();
  const set: Partial<NewMapSticky> = { updatedAt: now };
  if ("title" in update) set.title = update.title ?? null;
  if (update.body !== undefined) {
    set.body = update.body;
    set.previewText = extractPreviewText(update.body) || null;
  }
  if (update.color !== undefined) set.color = update.color;
  const rows = await db
    .update(mapStickies)
    .set(set)
    .where(eq(mapStickies.id, id))
    .returning();
  return rows[0];
}

export async function deleteSticky(id: string): Promise<void> {
  await db.delete(mapStickies).where(eq(mapStickies.id, id));
}

// ── AI Branches ────────────────────────────────────────────────────────────

export async function listAiBranches(boardId: string): Promise<MapAiBranch[]> {
  return db
    .select()
    .from(mapAiBranches)
    .where(eq(mapAiBranches.boardId, boardId));
}

export async function deleteAiBranch(id: string): Promise<void> {
  await db.delete(mapAiBranches).where(eq(mapAiBranches.id, id));
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
}): Promise<MapEdge> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const insertData: NewMapEdge = {
    id,
    boardId: data.boardId,
    fromPositionId: data.fromPositionId,
    toPositionId: data.toPositionId,
    forwardLabel: data.forwardLabel ?? null,
    backwardLabel: data.backwardLabel ?? null,
    labels: "[]",
    style: data.style ?? "solid",
    color: data.color ?? "#000000",
    direction: data.direction ?? "none",
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db.insert(mapEdges).values(insertData).returning();
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
  return rows[0];
}

export async function deleteUserEdge(id: string): Promise<void> {
  await db.delete(mapEdges).where(eq(mapEdges.id, id));
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
}): Promise<MapFrame> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
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
  return rows[0];
}

export async function deleteFrame(id: string): Promise<void> {
  await db.delete(mapFrames).where(eq(mapFrames.id, id));
}
