import { db } from "@/db/client";
import { snippets } from "@/db/schema";
import { eq } from "drizzle-orm";

export type Snippet = typeof snippets.$inferSelect;
export type NewSnippet = typeof snippets.$inferInsert;

export async function listSnippets(sceneId?: string): Promise<Snippet[]> {
  if (sceneId) {
    return db.select().from(snippets).where(eq(snippets.sceneId, sceneId));
  }
  return db.select().from(snippets);
}

export async function getSnippet(id: number): Promise<Snippet | undefined> {
  const rows = await db.select().from(snippets).where(eq(snippets.id, id));
  return rows[0];
}

export async function createSnippet(
  data: Pick<NewSnippet, "title" | "content" | "tags"> &
    Partial<Pick<NewSnippet, "sceneId" | "sourceChatMessageId">>,
): Promise<Snippet> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(snippets)
    .values({ ...data, createdAt: now })
    .returning();
  return rows[0];
}

export async function updateSnippet(
  id: number,
  data: Partial<Pick<NewSnippet, "title" | "content" | "tags" | "sceneId">>,
): Promise<Snippet | undefined> {
  const rows = await db
    .update(snippets)
    .set(data)
    .where(eq(snippets.id, id))
    .returning();
  return rows[0];
}

export async function deleteSnippet(id: number): Promise<void> {
  await db.delete(snippets).where(eq(snippets.id, id));
}
