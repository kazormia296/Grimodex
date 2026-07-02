import { db } from "@/db/client";
import {
  codexTags,
  codexEntryTags,
  codexEntries,
  snippetEntryTags,
  snippets,
} from "@/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
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
  // tagsCache の値は書き込み前に tag 名/色を読み取って算出する（read-only、tx 外）。
  let tagCache: { name: string; color: string | null }[] = [];
  if (tagIds.length > 0) {
    const tags = await db
      .select()
      .from(codexTags)
      .where(inArray(codexTags.id, tagIds))
      .orderBy(asc(codexTags.name));
    tagCache = tags.map((t) => ({ name: t.name, color: t.color }));
  }

  // 既存 DELETE → 新規 INSERT → tagsCache UPDATE を 1 tx で原子化する
  // （別 IPC だと途中失敗で tag 不整合が残るため）。SQL は drizzle .toSQL() 由来。
  const del = db
    .delete(snippetEntryTags)
    .where(eq(snippetEntryTags.snippetId, snippetId))
    .toSQL();
  const statements: { sql: string; params: unknown[]; method: string }[] = [
    { sql: del.sql, params: del.params, method: "run" },
  ];
  if (tagIds.length > 0) {
    const ins = db
      .insert(snippetEntryTags)
      .values(tagIds.map((tagId) => ({ snippetId, tagId })))
      .toSQL();
    statements.push({ sql: ins.sql, params: ins.params, method: "run" });
  }
  const upd = db
    .update(snippets)
    .set({ tagsCache: JSON.stringify(tagCache) })
    .where(eq(snippets.id, snippetId))
    .toSQL();
  statements.push({ sql: upd.sql, params: upd.params, method: "run" });

  await invoke("db_execute_batch", { statements });
}

export async function setEntryTags(
  entryId: string,
  tagIds: string[],
): Promise<void> {
  // Compute tagsCache first (sorted alphabetically, consistent with listEntryTags).
  // Format: {name: string, color: string | null}[] — stores color for display in entry list.
  // This is a read; it stays outside the write tx below.
  let tagCache: { name: string; color: string | null }[] = [];
  if (tagIds.length > 0) {
    const tags = await db
      .select()
      .from(codexTags)
      .where(inArray(codexTags.id, tagIds))
      .orderBy(asc(codexTags.name));
    tagCache = tags.map((t) => ({ name: t.name, color: t.color }));
  }

  // 既存 DELETE → 新規 INSERT → tagsCache UPDATE を 1 tx で原子化する
  // （別 IPC だと途中失敗で tag 不整合が残るため）。SQL は drizzle .toSQL() 由来。
  const del = db
    .delete(codexEntryTags)
    .where(eq(codexEntryTags.entryId, entryId))
    .toSQL();
  const statements: { sql: string; params: unknown[]; method: string }[] = [
    { sql: del.sql, params: del.params, method: "run" },
  ];
  if (tagIds.length > 0) {
    const ins = db
      .insert(codexEntryTags)
      .values(tagIds.map((tagId) => ({ entryId, tagId })))
      .toSQL();
    statements.push({ sql: ins.sql, params: ins.params, method: "run" });
  }
  const upd = db
    .update(codexEntries)
    .set({
      tagsCache: JSON.stringify(tagCache),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(codexEntries.id, entryId))
    .toSQL();
  statements.push({ sql: upd.sql, params: upd.params, method: "run" });

  await invoke("db_execute_batch", { statements });
}
