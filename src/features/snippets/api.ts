import { db } from "@/db/client";
import { snippets } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export type Snippet = Omit<typeof snippets.$inferSelect, "contentSource"> & {
  contentSource?: string | null;
};
export type NewSnippet = typeof snippets.$inferInsert;

export async function listSnippets(sceneId?: string): Promise<Snippet[]> {
  if (sceneId) {
    return db.select().from(snippets).where(eq(snippets.sceneId, sceneId));
  }
  return db.select().from(snippets);
}

export async function getSnippet(id: string): Promise<Snippet | undefined> {
  const rows = await db.select().from(snippets).where(eq(snippets.id, id));
  return rows[0];
}

export async function createSnippet(
  data: Pick<NewSnippet, "id" | "projectId" | "title" | "content"> &
    Partial<
      Pick<
        NewSnippet,
        "tags" | "sceneId" | "sourceChatMessageId" | "contentSource"
      >
    >,
): Promise<Snippet> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(snippets)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
}

export async function updateSnippet(
  id: string,
  data: Partial<Pick<NewSnippet, "title" | "content" | "tags" | "sceneId">>,
): Promise<Snippet | undefined> {
  const rows = await db
    .update(snippets)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(snippets.id, id))
    .returning();
  return rows[0];
}

export async function deleteSnippet(id: string): Promise<void> {
  await db.delete(snippets).where(eq(snippets.id, id));
}

export async function listSnippetsByMessageId(
  messageId: string,
): Promise<Snippet[]> {
  return db
    .select()
    .from(snippets)
    .where(eq(snippets.sourceChatMessageId, messageId));
}

export async function incrementSnippetUsageCount(id: string): Promise<void> {
  await db
    .update(snippets)
    .set({ usageCount: sql`${snippets.usageCount} + 1` })
    .where(eq(snippets.id, id));
}
