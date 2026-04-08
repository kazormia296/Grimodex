import { db } from "@/db/client";
import { codexTags, codexEntryTags, codexEntries } from "@/db/schema";
import { asc, eq, inArray } from "drizzle-orm";

export type CodexTag = typeof codexTags.$inferSelect;

export async function listCodexTags(projectId: string): Promise<CodexTag[]> {
  return db.select().from(codexTags).where(eq(codexTags.projectId, projectId));
}

export async function createCodexTag(data: {
  id: string;
  projectId: string;
  name: string;
  color?: string;
  typeFilter?: string[];
}): Promise<CodexTag> {
  const rows = await db
    .insert(codexTags)
    .values({
      id: data.id,
      projectId: data.projectId,
      name: data.name,
      color: data.color ?? null,
      typeFilter: data.typeFilter ? JSON.stringify(data.typeFilter) : null,
      createdAt: new Date().toISOString(),
    })
    .returning();
  return rows[0];
}

export async function updateCodexTag(
  id: string,
  data: {
    name?: string;
    color?: string;
    typeFilter?: string[] | null;
  },
): Promise<CodexTag | undefined> {
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.color !== undefined) updateData.color = data.color;
  if ("typeFilter" in data) {
    updateData.typeFilter =
      data.typeFilter != null ? JSON.stringify(data.typeFilter) : null;
  }
  const rows = await db
    .update(codexTags)
    .set(updateData)
    .where(eq(codexTags.id, id))
    .returning();
  return rows[0];
}

export async function deleteCodexTag(id: string): Promise<void> {
  await db.delete(codexTags).where(eq(codexTags.id, id));
}

export async function listEntryTags(entryId: string): Promise<CodexTag[]> {
  const rows = await db
    .select({ tag: codexTags })
    .from(codexEntryTags)
    .innerJoin(codexTags, eq(codexEntryTags.tagId, codexTags.id))
    .where(eq(codexEntryTags.entryId, entryId))
    .orderBy(asc(codexTags.name));
  return rows.map((r) => r.tag);
}

export async function setEntryTags(
  entryId: string,
  tagIds: string[],
): Promise<void> {
  // Delete all existing associations
  await db.delete(codexEntryTags).where(eq(codexEntryTags.entryId, entryId));

  // Insert new associations
  if (tagIds.length > 0) {
    await db
      .insert(codexEntryTags)
      .values(tagIds.map((tagId) => ({ entryId, tagId })));
  }

  // Update tagsCache on codex entry (sorted alphabetically, consistent with listEntryTags)
  // Format: {name: string, color: string | null}[] — stores color for display in entry list
  let tagCache: { name: string; color: string | null }[] = [];
  if (tagIds.length > 0) {
    const tags = await db
      .select()
      .from(codexTags)
      .where(inArray(codexTags.id, tagIds))
      .orderBy(asc(codexTags.name));
    tagCache = tags.map((t) => ({ name: t.name, color: t.color }));
  }

  await db
    .update(codexEntries)
    .set({
      tagsCache: JSON.stringify(tagCache),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(codexEntries.id, entryId));
}
