import { db } from "@/db/client";
import {
  codexEntryPhases,
  codexPhaseDetailOverrides,
  type CodexEntryPhase,
  type CodexPhaseDetailOverride,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

export type { CodexEntryPhase, CodexPhaseDetailOverride };

export async function listPhasesByEntry(
  entryId: string,
): Promise<CodexEntryPhase[]> {
  return db
    .select()
    .from(codexEntryPhases)
    .where(eq(codexEntryPhases.entryId, entryId))
    .orderBy(codexEntryPhases.createdAt);
}

export async function listPhasesByEntryIds(
  entryIds: string[],
): Promise<CodexEntryPhase[]> {
  if (entryIds.length === 0) return [];
  return db
    .select()
    .from(codexEntryPhases)
    .where(inArray(codexEntryPhases.entryId, entryIds))
    .orderBy(codexEntryPhases.createdAt);
}

export async function getPhase(
  id: string,
): Promise<CodexEntryPhase | undefined> {
  const rows = await db
    .select()
    .from(codexEntryPhases)
    .where(eq(codexEntryPhases.id, id));
  return rows[0];
}

export async function createPhase(data: {
  id: string;
  entryId: string;
  anchorNodeId?: string | null;
  label: string;
  summaryOverride?: string | null;
  contentOverride?: string | null;
  contextModeOverride?: string | null;
}): Promise<CodexEntryPhase> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(codexEntryPhases)
    .values({
      id: data.id,
      entryId: data.entryId,
      anchorNodeId: data.anchorNodeId ?? null,
      label: data.label,
      summaryOverride: data.summaryOverride ?? null,
      contentOverride: data.contentOverride ?? null,
      contextModeOverride: data.contextModeOverride ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0];
}

export async function updatePhase(
  id: string,
  data: Partial<
    Pick<
      CodexEntryPhase,
      | "label"
      | "anchorNodeId"
      | "summaryOverride"
      | "contentOverride"
      | "contextModeOverride"
    >
  >,
): Promise<CodexEntryPhase | undefined> {
  const rows = await db
    .update(codexEntryPhases)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(codexEntryPhases.id, id))
    .returning();
  return rows[0];
}

export async function deletePhase(id: string): Promise<void> {
  await db.delete(codexEntryPhases).where(eq(codexEntryPhases.id, id));
}

export async function listDetailOverridesByPhase(
  phaseId: string,
): Promise<CodexPhaseDetailOverride[]> {
  return db
    .select()
    .from(codexPhaseDetailOverrides)
    .where(eq(codexPhaseDetailOverrides.phaseId, phaseId));
}

export async function listDetailOverridesByPhaseIds(
  phaseIds: string[],
): Promise<CodexPhaseDetailOverride[]> {
  if (phaseIds.length === 0) return [];
  return db
    .select()
    .from(codexPhaseDetailOverrides)
    .where(inArray(codexPhaseDetailOverrides.phaseId, phaseIds));
}

export async function upsertDetailOverride(
  phaseId: string,
  definitionId: string,
  value: string | null,
): Promise<CodexPhaseDetailOverride> {
  const existing = await db
    .select()
    .from(codexPhaseDetailOverrides)
    .where(
      and(
        eq(codexPhaseDetailOverrides.phaseId, phaseId),
        eq(codexPhaseDetailOverrides.definitionId, definitionId),
      ),
    );

  if (existing.length > 0) {
    const rows = await db
      .update(codexPhaseDetailOverrides)
      .set({ value })
      .where(
        and(
          eq(codexPhaseDetailOverrides.phaseId, phaseId),
          eq(codexPhaseDetailOverrides.definitionId, definitionId),
        ),
      )
      .returning();
    return rows[0];
  } else {
    const rows = await db
      .insert(codexPhaseDetailOverrides)
      .values({
        phaseId,
        definitionId,
        value,
      })
      .returning();
    return rows[0];
  }
}

export async function deleteDetailOverride(
  phaseId: string,
  definitionId: string,
): Promise<void> {
  await db
    .delete(codexPhaseDetailOverrides)
    .where(
      and(
        eq(codexPhaseDetailOverrides.phaseId, phaseId),
        eq(codexPhaseDetailOverrides.definitionId, definitionId),
      ),
    );
}
