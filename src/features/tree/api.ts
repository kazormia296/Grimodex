import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

export type TreeNode = typeof treeNodes.$inferSelect;
export type NewTreeNode = typeof treeNodes.$inferInsert;
export type NodeType = "folder" | "scene" | "note";

export async function listNodes(
  projectId: string,
  parentId?: string | null,
): Promise<TreeNode[]> {
  if (parentId !== undefined) {
    if (parentId === null) {
      return db
        .select()
        .from(treeNodes)
        .where(
          and(eq(treeNodes.projectId, projectId), isNull(treeNodes.parentId)),
        );
    }
    return db
      .select()
      .from(treeNodes)
      .where(
        and(
          eq(treeNodes.projectId, projectId),
          eq(treeNodes.parentId, parentId),
        ),
      );
  }
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
    Partial<Pick<NewTreeNode, "parentId" | "status" | "synopsis">>,
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
      | "storyTimeOrder"
      | "storyTimeLabel"
      | "povCharacterId"
      | "locationId"
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
  unplacedBeatPreview?: string | null;
  placedBeatPreview?: string | null;
}

/**
 * Save scene content to the DB.
 * Accepts either a plain JSON string (legacy callers) or a full payload object.
 */
export async function saveSceneContent(
  sceneId: string,
  payloadOrContent: string | SaveScenePayload,
): Promise<void> {
  const payload: SaveScenePayload =
    typeof payloadOrContent === "string"
      ? { content: payloadOrContent }
      : payloadOrContent;

  await db
    .update(treeNodes)
    .set({
      content: payload.content,
      ...(payload.unplacedBeatsDoc !== undefined && {
        unplacedBeatsDoc: payload.unplacedBeatsDoc,
      }),
      ...(payload.charCount !== undefined && {
        charCount: payload.charCount,
      }),
      ...(payload.unplacedBeatPreview !== undefined && {
        unplacedBeatPreview: payload.unplacedBeatPreview,
      }),
      ...(payload.placedBeatPreview !== undefined && {
        placedBeatPreview: payload.placedBeatPreview,
      }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(treeNodes.id, sceneId));
}

/** Load ProseMirror JSON content for a scene from the DB. Returns empty string if not found. */
export async function loadSceneContent(sceneId: string): Promise<string> {
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
export async function saveSceneBeatsOnly(
  sceneId: string,
  payload: {
    unplacedBeatsDoc: string;
    unplacedBeatPreview: string | null;
    placedBeatPreview?: string | null;
  },
): Promise<void> {
  await db
    .update(treeNodes)
    .set({
      unplacedBeatsDoc: payload.unplacedBeatsDoc,
      unplacedBeatPreview: payload.unplacedBeatPreview,
      ...(payload.placedBeatPreview !== undefined && {
        placedBeatPreview: payload.placedBeatPreview,
      }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(treeNodes.id, sceneId));
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
