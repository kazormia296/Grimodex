import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { enqueueRescan } from "./mentionRescanQueue";

export type CodexEntry = typeof codexEntries.$inferSelect;
export type NewCodexEntry = typeof codexEntries.$inferInsert;
export const BUILTIN_CODEX_TYPES = [
  "character",
  "location",
  "item",
  "lore",
] as const;
export type BuiltinCodexEntryType = (typeof BUILTIN_CODEX_TYPES)[number];
export type CodexEntryType = string;

export async function listCodexEntries(
  projectId: string,
  type?: CodexEntryType,
): Promise<CodexEntry[]> {
  const scope = eq(codexEntries.projectId, projectId);
  return db
    .select()
    .from(codexEntries)
    .where(type ? and(scope, eq(codexEntries.type, type)) : scope);
}

export async function getCodexEntry(
  projectId: string,
  id: string,
): Promise<CodexEntry | undefined> {
  const rows = await db
    .select()
    .from(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
  return rows[0];
}

export async function createCodexEntry(
  data: Pick<NewCodexEntry, "id" | "projectId" | "type" | "name"> &
    Partial<
      Pick<
        NewCodexEntry,
        | "summary"
        | "tagsCache"
        | "aliases"
        | "excludedAliases"
        | "parentId"
        | "sourceChatMessageId"
      >
    >,
): Promise<CodexEntry> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(codexEntries)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
}

export async function updateCodexEntry(
  projectId: string,
  id: string,
  data: Partial<
    Pick<
      NewCodexEntry,
      | "type"
      | "name"
      | "summary"
      | "content"
      | "tagsCache"
      | "aliases"
      | "excludedAliases"
      | "parentId"
      | "contextMode"
      | "icon"
      | "childrenBudget"
      | "notes"
    >
  >,
): Promise<CodexEntry | undefined> {
  const rows = await db
    .update(codexEntries)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)))
    .returning();

  // If name/aliases/excludedAliases changed, body-mention cache may be stale
  if (
    data.name !== undefined ||
    data.aliases !== undefined ||
    data.excludedAliases !== undefined
  ) {
    enqueueRescan(id);
  }

  return rows[0];
}

export async function deleteCodexEntry(
  projectId: string,
  id: string,
): Promise<void> {
  await db
    .delete(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
}

export async function listCodexEntriesByMessageId(
  messageId: string,
): Promise<CodexEntry[]> {
  return db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.sourceChatMessageId, messageId));
}
