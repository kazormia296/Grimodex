import { db } from "@/db/client";
import {
  mapBoards,
  mapNodePositions,
  mapEdges,
  mapFrames,
  type MapBoard,
  type MapNodePosition,
  type NewMapNodePosition,
  type MapEdge,
  type NewMapEdge,
  type MapFrame,
  type NewMapFrame,
} from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import type { NodeRefType } from "./types";

// ── Board ──────────────────────────────────────────────────────────────────

export async function getOrCreateBoard(projectId: string): Promise<MapBoard> {
  const rows = await db
    .select()
    .from(mapBoards)
    .where(eq(mapBoards.projectId, projectId))
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
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted[0];
}

// ── Node positions ─────────────────────────────────────────────────────────

export async function listNodePositions(
  boardId: string,
): Promise<MapNodePosition[]> {
  return db
    .select()
    .from(mapNodePositions)
    .where(
      and(
        eq(mapNodePositions.boardId, boardId),
        eq(mapNodePositions.hidden, 0),
      ),
    );
}

/** Returns all positions including hidden ones (needed for Hide feature). */
export async function listAllNodePositions(
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
  x: number;
  y: number;
}): Promise<MapNodePosition> {
  const now = new Date().toISOString();

  // Try to find existing position row
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
    aiNodeId: null,
    x: data.x,
    y: data.y,
    pinned: 0,
    hidden: 0,
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
    hidden?: number;
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

// ── User edges ─────────────────────────────────────────────────────────────

export async function listUserEdges(boardId: string): Promise<MapEdge[]> {
  return db.select().from(mapEdges).where(eq(mapEdges.boardId, boardId));
}

export async function createUserEdge(data: {
  boardId: string;
  fromPositionId: string;
  toPositionId: string;
  label?: string | null;
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
    label: data.label ?? null,
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
    label?: string | null;
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
    background: data.background ?? "#f5f5f5",
    borderColor: data.borderColor ?? "#cccccc",
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
