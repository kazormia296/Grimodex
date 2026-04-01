import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { invoke } from "@/lib/tauri";

export type TreeNode = typeof treeNodes.$inferSelect;
export type NewTreeNode = typeof treeNodes.$inferInsert;
export type NodeType = "part" | "chapter" | "scene" | "folder" | "note";

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
          and(
            eq(treeNodes.projectId, projectId),
            // parentId IS NULL — top-level nodes
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
    Partial<Pick<NewTreeNode, "parentId" | "status">>,
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
    Pick<NewTreeNode, "title" | "sortOrder" | "parentId" | "status">
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
  // Check if it's a scene to delete content file
  const node = await getNode(id);
  await db.delete(treeNodes).where(eq(treeNodes.id, id));
  if (node?.nodeType === "scene") {
    await invoke("content_delete", { sceneId: id });
  }
}

// --- Scene content operations ---

async function getSceneMetadata(sceneId: string) {
  const rows = await db
    .select({
      title: treeNodes.title,
      sortOrder: treeNodes.sortOrder,
      parentId: treeNodes.parentId,
    })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  const node = rows[0];
  if (!node) return { title: "untitled", chapterOrder: 0, sceneOrder: 0 };

  // Get parent's sort order for file naming
  let chapterOrder = 0;
  if (node.parentId) {
    const parentRows = await db
      .select({ sortOrder: treeNodes.sortOrder })
      .from(treeNodes)
      .where(eq(treeNodes.id, node.parentId));
    chapterOrder = parentRows[0]?.sortOrder ?? 0;
  }

  return {
    title: node.title,
    chapterOrder: Math.round(chapterOrder),
    sceneOrder: Math.round(node.sortOrder),
  };
}

export async function saveSceneContent(
  sceneId: string,
  markdown: string,
): Promise<void> {
  const meta = await getSceneMetadata(sceneId);
  await invoke("content_write", {
    sceneId,
    markdown,
    title: meta.title,
    chapterOrder: meta.chapterOrder,
    sceneOrder: meta.sceneOrder,
  });
  await db
    .update(treeNodes)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(treeNodes.id, sceneId));
}

export async function loadSceneContent(sceneId: string): Promise<string> {
  return invoke<string>("content_read", { sceneId });
}

export async function renameSceneContent(
  sceneId: string,
  title: string,
  chapterOrder: number,
  sceneOrder: number,
): Promise<void> {
  await invoke("content_rename", {
    sceneId,
    title,
    chapterOrder,
    sceneOrder,
  });
}
