import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { extractUnplacedBeatPreview } from "@/features/editor/beat/unplacedBeatPreview";
import { extractPlacedBeatPreviewFromString } from "@/features/editor/beat/placedBeatPreview";

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
      | "storyTimeOrder"
      | "storyTimeLabel"
      | "povCharacterId"
      | "locationId"
      | "sourceUri"
      | "sourceMtime"
      | "archivedAt"
      | "content"
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

  await db
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
    .where(eq(treeNodes.id, sceneId));

  return { placedBeatPreview, unplacedBeatPreview };
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
