import { db } from "@/db/client";
import { chapters } from "@/db/schema";
import { eq } from "drizzle-orm";

export type Chapter = typeof chapters.$inferSelect;
export type NewChapter = typeof chapters.$inferInsert;

export async function listChapters(projectId: number): Promise<Chapter[]> {
  return db.select().from(chapters).where(eq(chapters.projectId, projectId));
}

export async function getChapter(id: number): Promise<Chapter | undefined> {
  const rows = await db.select().from(chapters).where(eq(chapters.id, id));
  return rows[0];
}

export async function createChapter(
  data: Pick<NewChapter, "projectId" | "title" | "sortOrder">,
): Promise<Chapter> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(chapters)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
}

export async function updateChapter(
  id: number,
  data: Partial<Pick<NewChapter, "title" | "sortOrder">>,
): Promise<Chapter | undefined> {
  const rows = await db
    .update(chapters)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(chapters.id, id))
    .returning();
  return rows[0];
}

export async function deleteChapter(id: number): Promise<void> {
  await db.delete(chapters).where(eq(chapters.id, id));
}
