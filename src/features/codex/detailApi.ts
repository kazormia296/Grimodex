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
import { invoke } from "@/lib/tauri";
import {
  createCanonicalWriteContext,
  type CanonicalWriteContext,
} from "@/features/native-writes/writeContext";
import type {
  DetailBindingSource,
  DetailProjectionKind,
  DetailTemporalPolicy,
  StateFacet,
} from "./details/semanticBindingTypes";

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

export async function createDefinition(
  data: {
    id: string;
    projectId: string;
    typeSlug: string;
    name: string;
    fieldType?: string;
    fieldConfig?: string | null;
    sortOrder?: number;
    includeInContext?: number;
    semanticBinding?: {
      id: string;
      facetKey: StateFacet;
      projectionKind: DetailProjectionKind;
      temporalPolicy: DetailTemporalPolicy;
      source: DetailBindingSource;
      confirmed: boolean;
    };
  },
  opts?: { writeContext?: CanonicalWriteContext },
): Promise<CodexDetailDefinition> {
  await invoke("codex_mutate", {
    payload: {
      operation: "detail.definition.create",
      projectId: data.projectId,
      ...(opts?.writeContext ?? createCanonicalWriteContext()),
      surface: "manual",
      definitionId: data.id,
      typeSlug: data.typeSlug,
      name: data.name,
      fieldType: data.fieldType ?? "text",
      fieldConfig: data.fieldConfig ?? null,
      sortOrder: data.sortOrder ?? 0,
      includeInContext: data.includeInContext ?? 0,
      ...(data.semanticBinding
        ? { semanticBinding: data.semanticBinding }
        : {}),
    },
  });
  const rows = await db
    .select()
    .from(codexDetailDefinitions)
    .where(eq(codexDetailDefinitions.id, data.id))
    .limit(1);
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
  const current = await getDefinition(id);
  if (!current) return undefined;
  try {
    await invoke("codex_mutate", {
      payload: {
        operation: "detail.definition.update",
        projectId: current.projectId,
        ...createCanonicalWriteContext(),
        surface: "manual",
        definitionId: id,
        baseVersion: opts.baseVersion,
        ...data,
      },
    });
  } catch (error) {
    if (String(error).toLowerCase().includes("version conflict")) {
      throw new DetailDefinitionVersionConflictError(id);
    }
    throw error;
  }
  return getDefinition(id);
}

export async function deleteDefinition(id: string): Promise<void> {
  const definition = await getDefinition(id);
  if (!definition) return;
  await invoke("codex_mutate", {
    payload: {
      operation: "detail.definition.delete",
      projectId: definition.projectId,
      ...createCanonicalWriteContext(),
      surface: "manual",
      definitionId: id,
    },
  });
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
  opts?: {
    baseVersion?: number;
    raw?: boolean;
    writeContext?: CanonicalWriteContext;
  },
): Promise<CodexDetailValue> {
  const definition = await getDefinition(definitionId);
  if (!definition) {
    throw new Error(`Detail definition '${definitionId}' not found`);
  }
  const encoded = opts?.raw
    ? value
    : encodeStoredDetailValue(definition, value);
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
    const entry = await db
      .select({ projectId: codexEntries.projectId })
      .from(codexEntries)
      .where(eq(codexEntries.id, entryId))
      .limit(1);
    if (!entry[0]) throw new Error(`Codex entry '${entryId}' not found`);
    await invoke("codex_mutate", {
      payload: {
        operation: "detail.value.upsert",
        projectId: entry[0].projectId,
        ...(opts?.writeContext ?? createCanonicalWriteContext()),
        surface: "manual",
        valueId: crypto.randomUUID(),
        entryId,
        definitionId,
        value: encoded,
      },
    });
    const created = await db
      .select()
      .from(codexDetailValues)
      .where(
        and(
          eq(codexDetailValues.entryId, entryId),
          eq(codexDetailValues.definitionId, definitionId),
        ),
      );
    return created[0];
  }

  if (opts?.baseVersion === undefined) {
    throw new DetailValueVersionConflictError(entryId, definitionId);
  }

  const entry = await db
    .select({ projectId: codexEntries.projectId })
    .from(codexEntries)
    .where(eq(codexEntries.id, entryId))
    .limit(1);
  if (!entry[0]) throw new Error(`Codex entry '${entryId}' not found`);
  try {
    await invoke("codex_mutate", {
      payload: {
        operation: "detail.value.upsert",
        projectId: entry[0].projectId,
        ...(opts?.writeContext ?? createCanonicalWriteContext()),
        surface: "manual",
        entryId,
        definitionId,
        value: encoded,
        baseVersion: opts.baseVersion,
      },
    });
  } catch (error) {
    if (String(error).toLowerCase().includes("version conflict")) {
      throw new DetailValueVersionConflictError(entryId, definitionId);
    }
    throw error;
  }
  const updated = await db
    .select()
    .from(codexDetailValues)
    .where(
      and(
        eq(codexDetailValues.entryId, entryId),
        eq(codexDetailValues.definitionId, definitionId),
      ),
    );
  if (!updated[0])
    throw new DetailValueVersionConflictError(entryId, definitionId);
  return updated[0];
}
