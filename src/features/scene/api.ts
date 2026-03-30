import { db } from "@/db/client";
import { scenes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { invoke } from "@/lib/tauri";

export type Scene = typeof scenes.$inferSelect;
export type NewScene = typeof scenes.$inferInsert;

export async function listScenes(chapterId: number): Promise<Scene[]> {
  return db.select().from(scenes).where(eq(scenes.chapterId, chapterId));
}

export async function getScene(id: string): Promise<Scene | undefined> {
  const rows = await db.select().from(scenes).where(eq(scenes.id, id));
  return rows[0];
}

export async function createScene(
  data: Pick<NewScene, "id" | "chapterId" | "title" | "sortOrder">,
): Promise<Scene> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(scenes)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
}

export async function updateScene(
  id: string,
  data: Partial<Pick<NewScene, "title" | "sortOrder" | "synopsis">>,
): Promise<Scene | undefined> {
  const rows = await db
    .update(scenes)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(scenes.id, id))
    .returning();
  return rows[0];
}

export async function deleteScene(id: string): Promise<void> {
  await db.delete(scenes).where(eq(scenes.id, id));
  await invoke("content_delete", { sceneId: id });
}

async function getSceneMetadata(sceneId: string) {
  const rows = await db
    .select({
      title: scenes.title,
      sortOrder: scenes.sortOrder,
      chapterId: scenes.chapterId,
    })
    .from(scenes)
    .where(eq(scenes.id, sceneId));
  const scene = rows[0];
  if (!scene) return { title: "untitled", chapterOrder: 0, sceneOrder: 0 };

  // For now, use chapterId as chapterOrder (will be replaced with actual sort_order lookup later)
  return {
    title: scene.title,
    chapterOrder: scene.chapterId,
    sceneOrder: scene.sortOrder,
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
    .update(scenes)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(scenes.id, sceneId));
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
