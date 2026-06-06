import { db } from "@/db/client";
import { snippets } from "@/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";

export type Snippet = Omit<typeof snippets.$inferSelect, "contentSource"> & {
  contentSource?: string | null;
};
export type NewSnippet = typeof snippets.$inferInsert;

export async function listSnippets(
  projectId: string,
  sceneId?: string,
): Promise<Snippet[]> {
  const scope = eq(snippets.projectId, projectId);
  return db
    .select()
    .from(snippets)
    .where(sceneId ? and(scope, eq(snippets.sceneId, sceneId)) : scope)
    .orderBy(desc(snippets.createdAt));
}

export async function getSnippet(
  projectId: string,
  id: string,
): Promise<Snippet | undefined> {
  const rows = await db
    .select()
    .from(snippets)
    .where(and(eq(snippets.id, id), eq(snippets.projectId, projectId)));
  return rows[0];
}

export async function createSnippet(
  data: Pick<NewSnippet, "id" | "projectId" | "title" | "content"> &
    Partial<
      Pick<
        NewSnippet,
        "tagsCache" | "sceneId" | "sourceChatMessageId" | "contentSource"
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
  projectId: string,
  id: string,
  data: Partial<
    Pick<NewSnippet, "title" | "content" | "tagsCache" | "sceneId">
  >,
): Promise<Snippet | undefined> {
  const rows = await db
    .update(snippets)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(snippets.id, id), eq(snippets.projectId, projectId)))
    .returning();
  return rows[0];
}

export async function deleteSnippet(
  projectId: string,
  id: string,
): Promise<void> {
  await db
    .delete(snippets)
    .where(and(eq(snippets.id, id), eq(snippets.projectId, projectId)));
}

export async function listSnippetsByMessageId(
  messageId: string,
): Promise<Snippet[]> {
  return db
    .select()
    .from(snippets)
    .where(eq(snippets.sourceChatMessageId, messageId));
}

export async function incrementSnippetUsageCount(
  projectId: string,
  id: string,
): Promise<void> {
  await db
    .update(snippets)
    .set({ usageCount: sql`${snippets.usageCount} + 1` })
    .where(and(eq(snippets.id, id), eq(snippets.projectId, projectId)));
}
