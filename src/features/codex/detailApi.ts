import { db } from "@/db/client";
import {
  codexDetailDefinitions,
  codexDetailValues,
  codexEntries,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

export interface ContextDetail {
  entryId: string;
  definitionId: string;
  fieldName: string;
  fieldType: string;
  value: string | null;
}

export async function listContextDetailsByEntryIds(
  entryIds: string[],
): Promise<ContextDetail[]> {
  if (entryIds.length === 0) return [];
  const rows = await db
    .select({
      entryId: codexEntries.id,
      definitionId: codexDetailDefinitions.id,
      fieldName: codexDetailDefinitions.name,
      fieldType: codexDetailDefinitions.fieldType,
      value: codexDetailValues.value,
    })
    .from(codexEntries)
    .innerJoin(
      codexDetailDefinitions,
      and(
        eq(codexDetailDefinitions.projectId, codexEntries.projectId),
        eq(codexDetailDefinitions.typeSlug, codexEntries.type),
        eq(codexDetailDefinitions.includeInContext, 1),
      ),
    )
    .leftJoin(
      codexDetailValues,
      and(
        eq(codexDetailValues.entryId, codexEntries.id),
        eq(codexDetailValues.definitionId, codexDetailDefinitions.id),
      ),
    )
    .where(inArray(codexEntries.id, entryIds))
    .orderBy(
      codexEntries.id,
      codexDetailDefinitions.sortOrder,
      codexDetailDefinitions.id,
    );
  return rows;
}

export type CodexDetailDefinition = typeof codexDetailDefinitions.$inferSelect;
export type CodexDetailValue = typeof codexDetailValues.$inferSelect;

export interface DetailValueWithDefinition {
  value: CodexDetailValue;
  definition: CodexDetailDefinition;
}

export async function listDefinitionsByType(
  projectId: string,
  typeSlug: string,
): Promise<CodexDetailDefinition[]> {
  return db
    .select()
    .from(codexDetailDefinitions)
    .where(
      and(
        eq(codexDetailDefinitions.projectId, projectId),
        eq(codexDetailDefinitions.typeSlug, typeSlug),
      ),
    )
    .orderBy(codexDetailDefinitions.sortOrder);
}

export async function createDefinition(data: {
  id: string;
  projectId: string;
  typeSlug: string;
  name: string;
  fieldType?: string;
  fieldConfig?: string | null;
  sortOrder?: number;
  includeInContext?: number;
}): Promise<CodexDetailDefinition> {
  const rows = await db
    .insert(codexDetailDefinitions)
    .values({
      id: data.id,
      projectId: data.projectId,
      typeSlug: data.typeSlug,
      name: data.name,
      fieldType: data.fieldType ?? "text",
      fieldConfig: data.fieldConfig ?? null,
      sortOrder: data.sortOrder ?? 0.0,
      includeInContext: data.includeInContext ?? 0,
      createdAt: new Date().toISOString(),
    })
    .returning();
  return rows[0];
}

export async function updateDefinition(
  id: string,
  data: Partial<
    Pick<
      CodexDetailDefinition,
      "name" | "fieldType" | "fieldConfig" | "sortOrder" | "includeInContext"
    >
  >,
): Promise<CodexDetailDefinition | undefined> {
  const rows = await db
    .update(codexDetailDefinitions)
    .set(data)
    .where(eq(codexDetailDefinitions.id, id))
    .returning();
  return rows[0];
}

export async function deleteDefinition(id: string): Promise<void> {
  await db
    .delete(codexDetailDefinitions)
    .where(eq(codexDetailDefinitions.id, id));
}

export async function listRawDetailValuesByEntryIds(
  entryIds: string[],
): Promise<
  Array<{ entryId: string; definitionId: string; value: string | null }>
> {
  if (entryIds.length === 0) return [];
  const rows = await db
    .select({
      entryId: codexDetailValues.entryId,
      definitionId: codexDetailValues.definitionId,
      value: codexDetailValues.value,
    })
    .from(codexDetailValues)
    .where(inArray(codexDetailValues.entryId, entryIds));
  return rows;
}

export async function listValuesByDefinitionIds(
  definitionIds: string[],
): Promise<Array<{ definitionId: string; value: string | null }>> {
  if (definitionIds.length === 0) return [];
  return db
    .select({
      definitionId: codexDetailValues.definitionId,
      value: codexDetailValues.value,
    })
    .from(codexDetailValues)
    .where(inArray(codexDetailValues.definitionId, definitionIds));
}

export async function listValuesByEntry(
  entryId: string,
): Promise<DetailValueWithDefinition[]> {
  const rows = await db
    .select({
      value: codexDetailValues,
      definition: codexDetailDefinitions,
    })
    .from(codexDetailValues)
    .innerJoin(
      codexDetailDefinitions,
      eq(codexDetailValues.definitionId, codexDetailDefinitions.id),
    )
    .where(eq(codexDetailValues.entryId, entryId));
  return rows;
}

export async function upsertValue(
  entryId: string,
  definitionId: string,
  value: string | null,
): Promise<CodexDetailValue> {
  // Check if value exists
  const existing = await db
    .select()
    .from(codexDetailValues)
    .where(
      and(
        eq(codexDetailValues.entryId, entryId),
        eq(codexDetailValues.definitionId, definitionId),
      ),
    );

  if (existing.length > 0) {
    const rows = await db
      .update(codexDetailValues)
      .set({ value })
      .where(
        and(
          eq(codexDetailValues.entryId, entryId),
          eq(codexDetailValues.definitionId, definitionId),
        ),
      )
      .returning();
    return rows[0];
  } else {
    const rows = await db
      .insert(codexDetailValues)
      .values({
        id: crypto.randomUUID(),
        entryId,
        definitionId,
        value,
      })
      .returning();
    return rows[0];
  }
}
