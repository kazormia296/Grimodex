import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { eq } from "drizzle-orm";

export type CodexEntry = typeof codexEntries.$inferSelect;
export type NewCodexEntry = typeof codexEntries.$inferInsert;
export type CodexEntryType = "character" | "location" | "item" | "lore";

export async function listCodexEntries(
  type?: CodexEntryType,
): Promise<CodexEntry[]> {
  if (type) {
    return db.select().from(codexEntries).where(eq(codexEntries.type, type));
  }
  return db.select().from(codexEntries);
}

export async function getCodexEntry(
  id: number,
): Promise<CodexEntry | undefined> {
  const rows = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.id, id));
  return rows[0];
}

export async function createCodexEntry(
  data: Pick<NewCodexEntry, "type" | "name" | "summary" | "content" | "tags"> &
    Partial<Pick<NewCodexEntry, "sourceChatMessageId" | "source">>,
): Promise<CodexEntry> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(codexEntries)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
}

export async function updateCodexEntry(
  id: number,
  data: Partial<
    Pick<NewCodexEntry, "type" | "name" | "summary" | "content" | "tags">
  >,
): Promise<CodexEntry | undefined> {
  const rows = await db
    .update(codexEntries)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(codexEntries.id, id))
    .returning();
  return rows[0];
}

export async function deleteCodexEntry(id: number): Promise<void> {
  await db.delete(codexEntries).where(eq(codexEntries.id, id));
}

export async function listCodexEntriesByMessageId(
  messageId: string,
): Promise<CodexEntry[]> {
  return db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.sourceChatMessageId, messageId));
}
