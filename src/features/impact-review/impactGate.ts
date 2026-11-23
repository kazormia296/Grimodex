import { canIncludeResolvedCodexContext } from "@/features/codex/context/codexVisibilityPolicy";
import type { CodexSnapshot } from "./diff";

export type ImpactGateReason = "restricted-phase" | "context-mode";

export function currentHasRestrictedPhases(
  snapshot: Pick<CodexSnapshot, "restrictedPhaseIds">,
  hasRestrictedPhases?: boolean,
): boolean {
  return hasRestrictedPhases || (snapshot.restrictedPhaseIds ?? []).length > 0;
}

export function phaseIds(snapshot: CodexSnapshot): Set<string> {
  return new Set(
    snapshot.allPhaseIds ??
      snapshot.phases?.map((phase) => phase.phaseId) ??
      [],
  );
}

export function effectiveRestrictedPhaseIds(
  baseline: CodexSnapshot | null,
  snapshot: CodexSnapshot,
): Set<string> {
  const currentPhaseIds = phaseIds(snapshot);
  const visibleDeletedPhaseIds = new Set(
    baseline?.visibleDeletedPhaseIds ?? [],
  );
  const effective = new Set(snapshot.restrictedPhaseIds ?? []);

  for (const phaseId of baseline?.restrictedPhaseIds ?? []) {
    if (!currentPhaseIds.has(phaseId)) effective.add(phaseId);
  }
  for (const phase of baseline?.phases ?? []) {
    if (
      !currentPhaseIds.has(phase.phaseId) &&
      !visibleDeletedPhaseIds.has(phase.phaseId)
    ) {
      effective.add(phase.phaseId);
    }
  }
  return effective;
}

export function redactRestrictedPhases(
  snapshot: CodexSnapshot,
  restrictedPhaseIds: ReadonlySet<string>,
): CodexSnapshot;
export function redactRestrictedPhases(
  snapshot: CodexSnapshot | null,
  restrictedPhaseIds: ReadonlySet<string>,
): CodexSnapshot | null;
export function redactRestrictedPhases(
  snapshot: CodexSnapshot | null,
  restrictedPhaseIds: ReadonlySet<string>,
): CodexSnapshot | null {
  if (!snapshot || restrictedPhaseIds.size === 0) return snapshot;
  return {
    ...snapshot,
    phases: (snapshot.phases ?? []).filter(
      (phase) => !restrictedPhaseIds.has(phase.phaseId),
    ),
  };
}

export function evaluateImpactGate(input: {
  contextMode: string | undefined;
  currentHasRestrictedPhases: boolean;
}): { currentHasRestrictedPhases: boolean; reason: ImpactGateReason | null } {
  if (input.currentHasRestrictedPhases) {
    return {
      currentHasRestrictedPhases: input.currentHasRestrictedPhases,
      reason: "restricted-phase",
    };
  }
  if (
    !canIncludeResolvedCodexContext(
      input.contextMode as string,
      "current-mention",
    )
  ) {
    return {
      currentHasRestrictedPhases: input.currentHasRestrictedPhases,
      reason: "context-mode",
    };
  }
  return {
    currentHasRestrictedPhases: input.currentHasRestrictedPhases,
    reason: null,
  };
}
