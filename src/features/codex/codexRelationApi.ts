import { db } from "@/db/client";
import { codexRelations } from "@/db/schema";
import { and, asc, eq, or, inArray } from "drizzle-orm";
import {
  buildCodexRelationSemanticKey,
  type CodexRelationDirectionalityStored,
} from "@/features/codex/extraction/relationVocabulary";
import { notifyCodexRelationsChanged } from "./codexRelationEvents";

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
  > & {
    id?: string;
    directionality?: CodexRelationDirectionalityStored;
    inverseLabel?: string | null;
  },
): Promise<CodexRelationRow> {
  const now = new Date().toISOString();
  const directionality = data.directionality ?? "directed";
  const forwardLabel = data.label ?? "";
  const inverseLabel =
    directionality === "symmetric"
      ? (data.inverseLabel ?? forwardLabel)
      : (data.inverseLabel ?? null);
  const relationType = data.relationType ?? "custom";
  const semanticKey = buildCodexRelationSemanticKey({
    projectId: data.projectId,
    fromCodexId: data.fromCodexId,
    toCodexId: data.toCodexId,
    relationType,
    directionality,
    forwardLabel,
    inverseLabel,
  });
  const rows = await db
    .insert(codexRelations)
    .values({
      id: data.id ?? crypto.randomUUID(),
      projectId: data.projectId,
      fromCodexId: data.fromCodexId,
      toCodexId: data.toCodexId,
      relationType,
      label: data.label ?? null,
      directionality,
      inverseLabel,
      semanticKey,
      version: 1,
      depthHint: data.depthHint ?? null,
      sourceMapEdgeId: data.sourceMapEdgeId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  notifyCodexRelationsChanged(data.projectId);
  return rows[0];
}

export async function deleteCodexRelation(id: string): Promise<void> {
  // projectId は (id) 引数からは知れないため、削除前に row を読んで保持する。
  const existing = await db
    .select({ projectId: codexRelations.projectId })
    .from(codexRelations)
    .where(eq(codexRelations.id, id))
    .limit(1);
  await db.delete(codexRelations).where(eq(codexRelations.id, id));
  const projectId = existing[0]?.projectId;
  if (projectId) notifyCodexRelationsChanged(projectId);
}

/**
 * 厳密一致(方向込み)の relation を 1 件返す。`findCodexRelationByEdgeEndpoints`
 * は reverse も同一視するが、relation 作成 UI は方向を明示するためこちらを使う。
 */
export async function findCodexRelationExact(
  projectId: string,
  fromCodexId: string,
  toCodexId: string,
  relationType: string,
): Promise<CodexRelationRow | undefined> {
  const rows = await db
    .select()
    .from(codexRelations)
    .where(
      and(
        eq(codexRelations.projectId, projectId),
        eq(codexRelations.fromCodexId, fromCodexId),
        eq(codexRelations.toCodexId, toCodexId),
        eq(codexRelations.relationType, relationType),
      ),
    )
    .limit(1);
  return rows[0];
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
