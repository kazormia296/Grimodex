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
import { generateKeyBetween } from "@/features/tree/fractionalIndex";
import type { NodeRefType } from "./types";
import { DEFAULT_PALETTE_ID, DEFAULT_COLOR_SLOT } from "@/lib/stickyPalettes";

export type PromoteTargetType = "scene" | "note" | "snippet" | "codex";

/** Sticky IDs that should enter edit mode immediately on first mount. */
export const pendingAutoFocusIds = new Set<string>();

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
  return rows[0];
}

export async function deleteSticky(id: string): Promise<void> {
  await db.delete(mapStickies).where(eq(mapStickies.id, id));
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
  },
): Promise<{
  branch: MapAiBranch;
  stickies: MapSticky[];
  positions: MapNodePosition[];
}> {
  const now = new Date().toISOString();
  const branchId = crypto.randomUUID();
  const spawnX = options?.spawnX ?? 0;
  const spawnY = options?.spawnY ?? 0;

  const [branch] = await db
    .insert(mapAiBranches)
    .values({
      id: branchId,
      boardId,
      prompt,
      seedNodeIds: JSON.stringify(seedNodeIds),
      sessionId: options?.sessionId ?? null,
      model: options?.model ?? null,
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

  const angleStep = cards.length > 0 ? (2 * Math.PI) / cards.length : 0;
  const radius = 280;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const stickyId = crypto.randomUUID();
    const posId = crypto.randomUUID();
    const body = card.body || '{"type":"doc","content":[]}';
    const previewText = extractPreviewText(body);

    const angle = angleStep * i - Math.PI / 2;
    const x = spawnX + Math.round(radius * Math.cos(angle));
    const y = spawnY + Math.round(radius * Math.sin(angle));

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
    await db.insert(mapEdges).values({
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
    } satisfies NewMapEdge);

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
  }

  return { branch, stickies, positions };
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
