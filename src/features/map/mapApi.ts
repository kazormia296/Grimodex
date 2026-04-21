import { db } from "@/db/client";
import {
  mapBoards,
  mapNodePositions,
  type MapBoard,
  type MapNodePosition,
  type NewMapNodePosition,
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

export async function deleteNodePosition(id: string): Promise<void> {
  await db.delete(mapNodePositions).where(eq(mapNodePositions.id, id));
}
