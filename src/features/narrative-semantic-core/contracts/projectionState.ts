import {
  isProjectionApplicationState,
  type ProjectionApplicationState,
} from "./stateVocabulary";

export interface NarrativeProjectionState {
  readonly revisionId: string;
  readonly projectionRef: string;
  readonly projectionKind: string;
  readonly applicationId: string | null;
  readonly state: ProjectionApplicationState;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isNarrativeProjectionState(
  value: unknown,
): value is NarrativeProjectionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.revisionId) &&
    isNonEmptyString(candidate.projectionRef) &&
    isNonEmptyString(candidate.projectionKind) &&
    (candidate.applicationId === null ||
      isNonEmptyString(candidate.applicationId)) &&
    typeof candidate.state === "string" &&
    isProjectionApplicationState(candidate.state)
  );
}

export function assertNarrativeProjectionState(
  value: NarrativeProjectionState,
): void {
  if (!isNarrativeProjectionState(value)) {
    throw new Error("Invalid narrative projection state");
  }
}

export function groupProjectionStatesByRevision(
  states: readonly NarrativeProjectionState[],
): ReadonlyMap<string, readonly NarrativeProjectionState[]> {
  const grouped = new Map<string, NarrativeProjectionState[]>();
  for (const state of states) {
    assertNarrativeProjectionState(state);
    const existing = grouped.get(state.revisionId);
    if (existing) existing.push(state);
    else grouped.set(state.revisionId, [state]);
  }
  return grouped;
}
