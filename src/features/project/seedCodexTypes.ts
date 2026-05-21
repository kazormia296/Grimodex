import { db } from "@/db/client";
import {
  codexTypes,
  codexDetailDefinitions,
  codexEntries,
  codexDetailValues,
  codexTags,
  codexEntryTags,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

/**
 * Run a SELECT keyed by an id list in chunks so the bound-parameter count
 * stays well under SQLite's limit (~999 on older builds).
 */
async function selectInChunks<T>(
  ids: string[],
  query: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const CHUNK_SIZE = 400;
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    out.push(...(await query(ids.slice(i, i + CHUNK_SIZE))));
  }
  return out;
}

function sortEntriesForInsert<
  T extends { id: string; parentId: string | null },
>(entries: T[]): T[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const sorted: T[] = [];
  const visited = new Set<string>();

  function visit(entry: T) {
    if (visited.has(entry.id)) return;
    if (entry.parentId && byId.has(entry.parentId)) {
      visit(byId.get(entry.parentId)!);
    }
    visited.add(entry.id);
    sorted.push(entry);
  }

  for (const entry of entries) visit(entry);
  return sorted;
}

/**
 * Copy selected codex types (and their definitions, entries, detail values)
 * from one Project to another. Entry / definition ids are remapped; type slugs
 * are preserved so composite FKs resolve on the target Project.
 */
export async function seedCodexTypesFromProject(
  sourceProjectId: string,
  targetProjectId: string,
  typeSlugs: string[],
): Promise<void> {
  const uniqueSlugs = [...new Set(typeSlugs.filter(Boolean))];
  if (uniqueSlugs.length === 0) return;

  const entryIdMap = new Map<string, string>();
  const definitionIdMap = new Map<string, string>();

  for (const typeSlug of uniqueSlugs) {
    const [sourceType] = await db
      .select()
      .from(codexTypes)
      .where(
        and(
          eq(codexTypes.projectId, sourceProjectId),
          eq(codexTypes.slug, typeSlug),
        ),
      );
    if (!sourceType) continue;

    const [existingTargetType] = await db
      .select()
      .from(codexTypes)
      .where(
        and(
          eq(codexTypes.projectId, targetProjectId),
          eq(codexTypes.slug, typeSlug),
        ),
      );

    if (!existingTargetType) {
      await db.insert(codexTypes).values({
        id: crypto.randomUUID(),
        projectId: targetProjectId,
        slug: sourceType.slug,
        label: sourceType.label,
        color: sourceType.color,
        paletteIndex: sourceType.paletteIndex,
        icon: sourceType.icon,
        isBuiltin: sourceType.isBuiltin,
        sortOrder: sourceType.sortOrder,
        createdAt: new Date().toISOString(),
      });
    } else {
      // 同 slug の type が既にある (builtin 等) 場合は、コピー元の見た目
      // (label / color / icon …) をシード先へ反映する。slug / isBuiltin は据え置く。
      await db
        .update(codexTypes)
        .set({
          label: sourceType.label,
          color: sourceType.color,
          paletteIndex: sourceType.paletteIndex,
          icon: sourceType.icon,
          sortOrder: sourceType.sortOrder,
        })
        .where(eq(codexTypes.id, existingTargetType.id));
    }

    const sourceDefs = await db
      .select()
      .from(codexDetailDefinitions)
      .where(
        and(
          eq(codexDetailDefinitions.projectId, sourceProjectId),
          eq(codexDetailDefinitions.typeSlug, typeSlug),
        ),
      );

    const targetDefs = await db
      .select()
      .from(codexDetailDefinitions)
      .where(
        and(
          eq(codexDetailDefinitions.projectId, targetProjectId),
          eq(codexDetailDefinitions.typeSlug, typeSlug),
        ),
      );
    const targetDefByName = new Map(targetDefs.map((d) => [d.name, d]));

    for (const def of sourceDefs) {
      const existing = targetDefByName.get(def.name);
      if (existing) {
        definitionIdMap.set(def.id, existing.id);
        continue;
      }
      const newDefId = crypto.randomUUID();
      definitionIdMap.set(def.id, newDefId);
      await db.insert(codexDetailDefinitions).values({
        id: newDefId,
        projectId: targetProjectId,
        typeSlug: def.typeSlug,
        name: def.name,
        fieldType: def.fieldType,
        fieldConfig: def.fieldConfig,
        sortOrder: def.sortOrder,
        includeInContext: def.includeInContext,
        createdAt: new Date().toISOString(),
      });
    }

    const sourceEntries = await db
      .select()
      .from(codexEntries)
      .where(
        and(
          eq(codexEntries.projectId, sourceProjectId),
          eq(codexEntries.type, typeSlug),
        ),
      );

    for (const entry of sortEntriesForInsert(sourceEntries)) {
      const newEntryId = crypto.randomUUID();
      entryIdMap.set(entry.id, newEntryId);
      const newParentId = entry.parentId
        ? (entryIdMap.get(entry.parentId) ?? null)
        : null;

      await db.insert(codexEntries).values({
        id: newEntryId,
        projectId: targetProjectId,
        parentId: newParentId,
        type: entry.type,
        name: entry.name,
        aliases: entry.aliases,
        excludedAliases: entry.excludedAliases,
        summary: entry.summary,
        content: entry.content,
        icon: entry.icon,
        tagsCache: entry.tagsCache,
        contextMode: entry.contextMode,
        childrenBudget: entry.childrenBudget,
        sourceChatMessageId: null,
        notes: entry.notes,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const copiedSourceEntryIds = [...entryIdMap.keys()];
  if (copiedSourceEntryIds.length === 0) return;

  const values = await selectInChunks(copiedSourceEntryIds, (chunk) =>
    db
      .select()
      .from(codexDetailValues)
      .where(inArray(codexDetailValues.entryId, chunk)),
  );

  for (const val of values) {
    const newEntryId = entryIdMap.get(val.entryId);
    const newDefId = definitionIdMap.get(val.definitionId);
    if (!newEntryId || !newDefId) continue;

    await db.insert(codexDetailValues).values({
      id: crypto.randomUUID(),
      entryId: newEntryId,
      definitionId: newDefId,
      value: val.value,
    });
  }

  await copyEntryTags(copiedSourceEntryIds, entryIdMap, targetProjectId);
}

/**
 * Copy codex tag rows + entry↔tag links for the seeded entries. Tags are
 * deduplicated against the target Project by name (codex_tags has a unique
 * index on (project_id, name)).
 */
async function copyEntryTags(
  sourceEntryIds: string[],
  entryIdMap: Map<string, string>,
  targetProjectId: string,
): Promise<void> {
  const tagLinks = await selectInChunks(sourceEntryIds, (chunk) =>
    db
      .select()
      .from(codexEntryTags)
      .where(inArray(codexEntryTags.entryId, chunk)),
  );
  if (tagLinks.length === 0) return;

  const sourceTagIds = [...new Set(tagLinks.map((l) => l.tagId))];
  const sourceTags = await selectInChunks(sourceTagIds, (chunk) =>
    db.select().from(codexTags).where(inArray(codexTags.id, chunk)),
  );

  const existingTargetTags = await db
    .select()
    .from(codexTags)
    .where(eq(codexTags.projectId, targetProjectId));
  const targetTagByName = new Map(existingTargetTags.map((t) => [t.name, t]));

  const tagIdMap = new Map<string, string>();
  for (const tag of sourceTags) {
    const existing = targetTagByName.get(tag.name);
    if (existing) {
      tagIdMap.set(tag.id, existing.id);
      continue;
    }
    const newTagId = crypto.randomUUID();
    tagIdMap.set(tag.id, newTagId);
    await db.insert(codexTags).values({
      id: newTagId,
      projectId: targetProjectId,
      name: tag.name,
      color: tag.color,
      typeFilter: tag.typeFilter,
      createdAt: new Date().toISOString(),
    });
  }

  for (const link of tagLinks) {
    const newEntryId = entryIdMap.get(link.entryId);
    const newTagId = tagIdMap.get(link.tagId);
    if (!newEntryId || !newTagId) continue;
    await db.insert(codexEntryTags).values({
      entryId: newEntryId,
      tagId: newTagId,
    });
  }
}
