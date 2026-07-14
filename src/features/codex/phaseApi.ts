import { db } from "@/db/client";
import {
  codexEntries,
  codexEntryPhases,
  codexPhaseDetailOverrides,
  type CodexEntryPhase,
  type CodexPhaseDetailOverride,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  clearImpactBaselinePhaseDeletion,
  markImpactBaselinePhasesRestricted,
  markImpactBaselinePhaseVisible,
  markImpactBaselinePhaseVisibleDeleted,
} from "./impactBaselineVisibility";

export type { CodexEntryPhase, CodexPhaseDetailOverride };

function isAiVisibleMode(mode: unknown): boolean {
  return mode === "always" || mode === "mentioned";
}

async function entryPhaseSetIsProvablyVisible(
  entryId: string,
): Promise<boolean> {
  const [entryRows, phases] = await Promise.all([
    db
      .select({ contextMode: codexEntries.contextMode })
      .from(codexEntries)
      .where(eq(codexEntries.id, entryId)),
    listPhasesByEntry(entryId),
  ]);
  return (
    isAiVisibleMode(entryRows[0]?.contextMode) &&
    phases.every(
      (phase) =>
        phase.contextModeOverride === null ||
        isAiVisibleMode(phase.contextModeOverride),
    )
  );
}

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

type CreatePhaseData = {
  id: string;
  entryId: string;
  anchorNodeId?: string | null;
  label: string;
  summaryOverride?: string | null;
  contentOverride?: string | null;
  contextModeOverride?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export async function createPhase(
  data: CreatePhaseData,
): Promise<CodexEntryPhase> {
  const contextMode = data.contextModeOverride ?? null;
  if (contextMode !== null && !isAiVisibleMode(contextMode)) {
    // Restriction inheritance can affect every later baseline phase. Persist
    // the fail-closed marker before the row becomes active.
    await markImpactBaselinePhasesRestricted(data.entryId);
  }
  const now = new Date().toISOString();
  const createdAt = data.createdAt ?? now;
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
      createdAt,
      updatedAt: data.updatedAt ?? createdAt,
    })
    .returning();
  const created = rows[0];
  if (created) {
    if (isAiVisibleMode(contextMode)) {
      // Failure only leaves a conservative stale restriction marker.
      await markImpactBaselinePhaseVisible(data.entryId, data.id).catch(
        () => {},
      );
    } else {
      await clearImpactBaselinePhaseDeletion(data.entryId, data.id).catch(
        () => {},
      );
    }
  }
  return created;
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
  const changesContextMode = Object.prototype.hasOwnProperty.call(
    data,
    "contextModeOverride",
  );
  const current = changesContextMode ? await getPhase(id) : undefined;
  if (changesContextMode && !current) return undefined;
  const nextContextMode = data.contextModeOverride;
  if (current && changesContextMode && !isAiVisibleMode(nextContextMode)) {
    // null is inherited and therefore not proof of visibility.
    await markImpactBaselinePhasesRestricted(current.entryId);
  }
  const rows = await db
    .update(codexEntryPhases)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(codexEntryPhases.id, id))
    .returning();
  const updated = rows[0];
  if (updated && changesContextMode && isAiVisibleMode(nextContextMode)) {
    // Post-write failure remains fail-closed: Impact will keep redacting.
    await markImpactBaselinePhaseVisible(updated.entryId, id).catch(() => {});
  }
  return updated;
}

export async function deletePhase(id: string): Promise<void> {
  const phase = await getPhase(id);
  if (!phase) return;
  const provablyVisible =
    (phase.contextModeOverride === null ||
      isAiVisibleMode(phase.contextModeOverride)) &&
    (await entryPhaseSetIsProvablyVisible(phase.entryId));
  if (!provablyVisible) {
    // Pre-delete failure aborts the mutation. A successful marker with a
    // failed DELETE only causes an extra redaction and cannot expose content.
    await markImpactBaselinePhasesRestricted(phase.entryId);
  }
  await db.delete(codexEntryPhases).where(eq(codexEntryPhases.id, id));
  if (provablyVisible) {
    // The row is already gone. If this best-effort marker fails, missing
    // provenance makes runImpactReview redact the deletion fail-closed.
    await markImpactBaselinePhaseVisibleDeleted(
      phase.entryId,
      phase.id,
      true,
    ).catch(() => {});
  }
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
