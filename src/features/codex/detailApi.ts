import { db } from "@/db/client";
import {
  codexDetailDefinitions,
  codexDetailValues,
  codexEntries,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { buildDetailDefinitionCatalog } from "./details/detailDefinitionCatalog";
import { detailValueCodec } from "./details/detailValueCodec";
import {
  DetailDefinitionVersionConflictError,
  DetailValueVersionConflictError,
} from "./detailOcc";

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

function encodeStoredDetailValue(
  definition: Pick<
    CodexDetailDefinition,
    | "id"
    | "projectId"
    | "typeSlug"
    | "name"
    | "fieldType"
    | "fieldConfig"
    | "sortOrder"
  >,
  value: string | null,
): string | null {
  if (definition.fieldType !== "text") return value;
  const catalog = buildDetailDefinitionCatalog([
    {
      id: definition.id,
      projectId: definition.projectId,
      typeSlug: definition.typeSlug,
      name: definition.name,
      fieldType: definition.fieldType,
      fieldConfig: definition.fieldConfig,
      sortOrder: definition.sortOrder,
    },
  ]);
  const record = catalog.records[0];
  if (!record) return value;
  const decoded = detailValueCodec.decode(record, value);
  if (decoded === null) return null;
  return detailValueCodec.encodeBase(record, decoded);
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

export async function getDefinition(
  id: string,
): Promise<CodexDetailDefinition | undefined> {
  const rows = await db
    .select()
    .from(codexDetailDefinitions)
    .where(eq(codexDetailDefinitions.id, id));
  return rows[0];
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
  const now = new Date().toISOString();
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
      version: 0,
      createdAt: now,
      updatedAt: now,
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
  opts: { baseVersion: number },
): Promise<CodexDetailDefinition | undefined> {
  const now = new Date().toISOString();
  const rows = await db
    .update(codexDetailDefinitions)
    .set({
      ...data,
      version: opts.baseVersion + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(codexDetailDefinitions.id, id),
        eq(codexDetailDefinitions.version, opts.baseVersion),
      ),
    )
    .returning();
  const updated = rows[0];
  if (!updated) {
    const exists = await db
      .select({ id: codexDetailDefinitions.id })
      .from(codexDetailDefinitions)
      .where(eq(codexDetailDefinitions.id, id))
      .limit(1);
    if (exists[0]) throw new DetailDefinitionVersionConflictError(id);
    return undefined;
  }
  return updated;
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
  opts?: { baseVersion?: number },
): Promise<CodexDetailValue> {
  const definition = await getDefinition(definitionId);
  if (!definition) {
    throw new Error(`Detail definition '${definitionId}' not found`);
  }
  const encoded = encodeStoredDetailValue(definition, value);
  const now = new Date().toISOString();

  const existing = await db
    .select()
    .from(codexDetailValues)
    .where(
      and(
        eq(codexDetailValues.entryId, entryId),
        eq(codexDetailValues.definitionId, definitionId),
      ),
    );

  if (existing.length === 0) {
    const rows = await db
      .insert(codexDetailValues)
      .values({
        id: crypto.randomUUID(),
        entryId,
        definitionId,
        value: encoded,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rows[0];
  }

  if (opts?.baseVersion === undefined) {
    throw new DetailValueVersionConflictError(entryId, definitionId);
  }

  const rows = await db
    .update(codexDetailValues)
    .set({
      value: encoded,
      version: opts.baseVersion + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(codexDetailValues.entryId, entryId),
        eq(codexDetailValues.definitionId, definitionId),
        eq(codexDetailValues.version, opts.baseVersion),
      ),
    )
    .returning();
  const updated = rows[0];
  if (!updated) {
    throw new DetailValueVersionConflictError(entryId, definitionId);
  }
  return updated;
}
