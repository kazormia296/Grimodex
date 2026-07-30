import { db } from "@/db/client";
import { codexTags, codexEntryTags, snippetEntryTags } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { invoke } from "@/lib/tauri";

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

export async function listSnippetEntryTags(
  snippetId: string,
): Promise<CodexTag[]> {
  const rows = await db
    .select({ tag: codexTags })
    .from(snippetEntryTags)
    .innerJoin(codexTags, eq(snippetEntryTags.tagId, codexTags.id))
    .where(eq(snippetEntryTags.snippetId, snippetId))
    .orderBy(asc(codexTags.name));
  return rows.map((r) => r.tag);
}

export async function setSnippetEntryTags(
  snippetId: string,
  tagIds: string[],
): Promise<void> {
  await invoke("entity_tags_set", {
    payload: {
      entityKind: "snippet",
      entityId: snippetId,
      tagIds,
      updatedAt: null,
    },
  });
}

export async function setEntryTags(
  entryId: string,
  tagIds: string[],
): Promise<void> {
  await invoke("entity_tags_set", {
    payload: {
      entityKind: "codex",
      entityId: entryId,
      tagIds,
      updatedAt: new Date().toISOString(),
    },
  });
}
