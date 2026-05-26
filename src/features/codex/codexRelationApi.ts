import { db } from "@/db/client";
import { codexRelations } from "@/db/schema";
import { and, asc, eq, or, inArray } from "drizzle-orm";

export type CodexRelationRow = typeof codexRelations.$inferSelect;
export type NewCodexRelation = typeof codexRelations.$inferInsert;

export async function listCodexRelations(
  projectId: string,
): Promise<CodexRelationRow[]> {
  return db
    .select()
    .from(codexRelations)
    .where(eq(codexRelations.projectId, projectId));
}

export async function listCodexRelationsForEntry(
  entryId: string,
): Promise<CodexRelationRow[]> {
  return db
    .select()
    .from(codexRelations)
    .where(
      or(
        eq(codexRelations.fromCodexId, entryId),
        eq(codexRelations.toCodexId, entryId),
      ),
    );
}

export async function listCodexRelationsTouchingIds(
  entryIds: string[],
): Promise<CodexRelationRow[]> {
  if (entryIds.length === 0) return [];
  return db
    .select()
    .from(codexRelations)
    .where(
      or(
        inArray(codexRelations.fromCodexId, entryIds),
        inArray(codexRelations.toCodexId, entryIds),
      ),
    );
}

export async function createCodexRelation(
  data: Pick<
    NewCodexRelation,
    | "projectId"
    | "fromCodexId"
    | "toCodexId"
    | "relationType"
    | "label"
    | "depthHint"
    | "sourceMapEdgeId"
  > & { id?: string },
): Promise<CodexRelationRow> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(codexRelations)
    .values({
      id: data.id ?? crypto.randomUUID(),
      projectId: data.projectId,
      fromCodexId: data.fromCodexId,
      toCodexId: data.toCodexId,
      relationType: data.relationType ?? "custom",
      label: data.label ?? null,
      depthHint: data.depthHint ?? null,
      sourceMapEdgeId: data.sourceMapEdgeId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0];
}

export async function deleteCodexRelation(id: string): Promise<void> {
  await db.delete(codexRelations).where(eq(codexRelations.id, id));
}

export async function findCodexRelationByEdgeEndpoints(
  fromCodexId: string,
  toCodexId: string,
  relationType: string,
): Promise<CodexRelationRow | undefined> {
  const rows = await db
    .select()
    .from(codexRelations)
    .where(
      and(
        eq(codexRelations.relationType, relationType),
        or(
          and(
            eq(codexRelations.fromCodexId, fromCodexId),
            eq(codexRelations.toCodexId, toCodexId),
          ),
          and(
            eq(codexRelations.fromCodexId, toCodexId),
            eq(codexRelations.toCodexId, fromCodexId),
          ),
        ),
      ),
    )
    .orderBy(asc(codexRelations.createdAt), asc(codexRelations.id))
    .limit(1);
  return rows[0];
}
