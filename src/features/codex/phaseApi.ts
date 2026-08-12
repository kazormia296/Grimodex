import { db } from "@/db/client";
import {
  codexEntries,
  codexEntryPhases,
  codexPhaseDetailOverrides,
  type CodexEntryPhase,
  type CodexPhaseDetailOverride,
} from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import {
  clearImpactBaselinePhaseDeletion,
  markImpactBaselinePhasesRestricted,
  markImpactBaselinePhaseVisible,
  markImpactBaselinePhaseVisibleDeleted,
} from "./impactBaselineVisibility";
import { PhaseVersionConflictError } from "./phaseOcc";
import { getRecorderSessionId } from "@/features/timelapse/recorder";

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
  version?: number;
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
  const createdAt = data.createdAt ?? new Date().toISOString();
  let rows: CodexEntryPhase[];
  try {
    await invoke("agent_codex_mutate", {
      payload: {
        operation: "phase.create",
        projectId: (
          await db
            .select({ projectId: codexEntries.projectId })
            .from(codexEntries)
            .where(eq(codexEntries.id, data.entryId))
            .limit(1)
        )[0]?.projectId,
        sessionId: getRecorderSessionId(),
        surface: "manual",
        phaseId: data.id,
        entryId: data.entryId,
        anchorNodeId: data.anchorNodeId ?? null,
        label: data.label,
        summaryOverride: data.summaryOverride ?? null,
        contentOverride: data.contentOverride ?? null,
        contextModeOverride: data.contextModeOverride ?? null,
        version: data.version ?? 0,
        createdAt,
        detailOverrides: [],
      },
    });
    const created = await getPhase(data.id);
    rows = created ? [created] : [];
  } catch (error) {
    const existing = await getPhase(data.id).catch(() => undefined);
    if (existing) throw new PhaseVersionConflictError(data.id);
    throw error;
  }
  const created = rows[0];
  if (!created) {
    throw new Error(`Failed to create Phase '${data.id}'`);
  }
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
  opts: { baseVersion: number },
): Promise<CodexEntryPhase | undefined> {
  const changesContextMode = Object.prototype.hasOwnProperty.call(
    data,
    "contextModeOverride",
  );
  const current = await getPhase(id);
  if (!current) return undefined;
  const nextContextMode = data.contextModeOverride;
  if (current && changesContextMode && !isAiVisibleMode(nextContextMode)) {
    // null is inherited and therefore not proof of visibility.
    await markImpactBaselinePhasesRestricted(current.entryId);
  }
  try {
    await invoke("agent_codex_mutate", {
      payload: {
        operation: "phase.update",
        projectId: (
          await db
            .select({ projectId: codexEntries.projectId })
            .from(codexEntries)
            .where(eq(codexEntries.id, current.entryId))
            .limit(1)
        )[0]?.projectId,
        sessionId: getRecorderSessionId(),
        surface: "manual",
        phaseId: id,
        baseVersion: opts.baseVersion,
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...(data.anchorNodeId !== undefined
          ? { anchorNodeId: data.anchorNodeId }
          : {}),
        ...(data.summaryOverride !== undefined
          ? { summaryOverride: data.summaryOverride }
          : {}),
        ...(data.contentOverride !== undefined
          ? { contentOverride: data.contentOverride }
          : {}),
        ...(data.contextModeOverride !== undefined
          ? { contextModeOverride: data.contextModeOverride }
          : {}),
      },
    });
  } catch (error) {
    if (String(error).toLowerCase().includes("version conflict")) {
      throw new PhaseVersionConflictError(id);
    }
    throw error;
  }
  const updated = await getPhase(id);
  if (!updated) return undefined;
  if (updated && changesContextMode && isAiVisibleMode(nextContextMode)) {
    // Post-write failure remains fail-closed: Impact will keep redacting.
    await markImpactBaselinePhaseVisible(updated.entryId, id).catch(() => {});
  }
  return updated;
}

export async function deletePhase(
  id: string,
  opts?: { expectedVersion?: number },
): Promise<boolean> {
  const phase = await getPhase(id);
  if (!phase) {
    if (opts?.expectedVersion !== undefined) {
      throw new PhaseVersionConflictError(id);
    }
    return false;
  }
  if (
    opts?.expectedVersion !== undefined &&
    phase.version !== opts.expectedVersion
  ) {
    throw new PhaseVersionConflictError(id);
  }
  const provablyVisible =
    (phase.contextModeOverride === null ||
      isAiVisibleMode(phase.contextModeOverride)) &&
    (await entryPhaseSetIsProvablyVisible(phase.entryId));
  if (!provablyVisible) {
    // Pre-delete failure aborts the mutation. A successful marker with a
    // failed DELETE only causes an extra redaction and cannot expose content.
    await markImpactBaselinePhasesRestricted(phase.entryId);
  }
  try {
    await invoke("agent_codex_mutate", {
      payload: {
        operation: "phase.delete",
        projectId: (
          await db
            .select({ projectId: codexEntries.projectId })
            .from(codexEntries)
            .where(eq(codexEntries.id, phase.entryId))
            .limit(1)
        )[0]?.projectId,
        sessionId: getRecorderSessionId(),
        surface: "manual",
        phaseId: id,
        expectedVersion: opts?.expectedVersion ?? null,
      },
    });
  } catch (error) {
    if (opts?.expectedVersion !== undefined) {
      throw new PhaseVersionConflictError(id);
    }
    throw error;
  }
  if (provablyVisible) {
    // The row is already gone. If this best-effort marker fails, missing
    // provenance makes runImpactReview redact the deletion fail-closed.
    await markImpactBaselinePhaseVisibleDeleted(
      phase.entryId,
      phase.id,
      true,
    ).catch(() => {});
  }
  return true;
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

export type PhaseDetailOverrideExactAfter = {
  definitionId: string;
  value: string | null;
};

export type PatchPhaseAggregateInput = {
  phaseId: string;
  baseVersion: number;
  label?: string;
  anchorNodeId?: string | null;
  summary?: string | null;
  content?: string | null;
  contextMode?: string | null;
  /** Exact-after override collection (missing definitions are deleted). */
  detailOverrides: readonly PhaseDetailOverrideExactAfter[];
};

export type PatchPhaseAggregateResult = {
  phase: CodexEntryPhase;
  overrides: CodexPhaseDetailOverride[];
};

/**
 * Atomically update Phase root fields and replace detail overrides, bumping
 * `codex_entry_phases.version` exactly once under OCC.
 */
export async function patchPhaseAggregate(
  input: PatchPhaseAggregateInput,
): Promise<PatchPhaseAggregateResult> {
  const current = await getPhase(input.phaseId);
  if (!current) {
    throw new Error(`Phase '${input.phaseId}' not found`);
  }

  const changesContextMode = Object.prototype.hasOwnProperty.call(
    input,
    "contextMode",
  );
  const nextContextMode = changesContextMode
    ? (input.contextMode ?? null)
    : current.contextModeOverride;
  if (changesContextMode && !isAiVisibleMode(nextContextMode)) {
    await markImpactBaselinePhasesRestricted(current.entryId);
  }

  try {
    await invoke("agent_codex_mutate", {
      payload: {
        operation: "phase.aggregate",
        projectId: (
          await db
            .select({ projectId: codexEntries.projectId })
            .from(codexEntries)
            .where(eq(codexEntries.id, current.entryId))
            .limit(1)
        )[0]?.projectId,
        sessionId: getRecorderSessionId(),
        surface: "manual",
        phaseId: input.phaseId,
        baseVersion: input.baseVersion,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(Object.prototype.hasOwnProperty.call(input, "anchorNodeId")
          ? { anchorNodeId: input.anchorNodeId }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, "summary")
          ? { summaryOverride: input.summary ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, "content")
          ? { contentOverride: input.content ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, "contextMode")
          ? { contextModeOverride: input.contextMode ?? null }
          : {}),
        detailOverrides: input.detailOverrides,
      },
    });
  } catch (error) {
    const message = String(error);
    if (
      message.includes("Phase version conflict") ||
      message.includes("version conflict")
    ) {
      throw new PhaseVersionConflictError(input.phaseId);
    }
    throw error;
  }

  const phase = await getPhase(input.phaseId);
  if (!phase || phase.version !== input.baseVersion + 1) {
    throw new PhaseVersionConflictError(input.phaseId);
  }
  const overrides = await listDetailOverridesByPhase(input.phaseId);

  if (changesContextMode && isAiVisibleMode(nextContextMode)) {
    await markImpactBaselinePhaseVisible(phase.entryId, phase.id).catch(
      () => {},
    );
  }

  return { phase, overrides };
}

/**
 * @deprecated Product path should use {@link patchPhaseAggregate}. This wrapper
 * loads the current Phase version and exact-after collection then delegates.
 */
export async function upsertDetailOverride(
  phaseId: string,
  definitionId: string,
  value: string | null,
): Promise<CodexPhaseDetailOverride> {
  const phase = await getPhase(phaseId);
  if (!phase) {
    throw new Error(`Phase '${phaseId}' not found`);
  }
  const existing = await listDetailOverridesByPhase(phaseId);
  const detailOverrides = [
    ...existing
      .filter((row) => row.definitionId !== definitionId)
      .map((row) => ({
        definitionId: row.definitionId,
        value: row.value ?? null,
      })),
    { definitionId, value },
  ];
  const { overrides } = await patchPhaseAggregate({
    phaseId,
    baseVersion: phase.version,
    detailOverrides,
  });
  const updated = overrides.find((row) => row.definitionId === definitionId);
  if (!updated) {
    throw new Error(
      `Failed to upsert detail override for phase '${phaseId}' definition '${definitionId}'`,
    );
  }
  return updated;
}

/**
 * @deprecated Product path should use {@link patchPhaseAggregate}. This wrapper
 * loads the current Phase version and exact-after collection then delegates.
 */
export async function deleteDetailOverride(
  phaseId: string,
  definitionId: string,
): Promise<void> {
  const phase = await getPhase(phaseId);
  if (!phase) {
    throw new Error(`Phase '${phaseId}' not found`);
  }
  const existing = await listDetailOverridesByPhase(phaseId);
  const detailOverrides = existing
    .filter((row) => row.definitionId !== definitionId)
    .map((row) => ({
      definitionId: row.definitionId,
      value: row.value ?? null,
    }));
  await patchPhaseAggregate({
    phaseId,
    baseVersion: phase.version,
    detailOverrides,
  });
}
