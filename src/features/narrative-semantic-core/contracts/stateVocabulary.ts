export const REVIEW_STATES = [
  "unreviewed",
  "accepted",
  "rejected",
  "held",
  "superseded",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const EVIDENCE_FRESHNESS_STATES = [
  "fresh",
  "stale",
  "source-missing",
  "anchor-mismatch",
  "read-set-drift",
  "unknown",
] as const;
export type EvidenceFreshness = (typeof EVIDENCE_FRESHNESS_STATES)[number];

export const RECONCILIATION_SIGNALS = ["needs-reconciliation"] as const;
export type ReconciliationSignal = (typeof RECONCILIATION_SIGNALS)[number];

export const BUILD_ACTIONS = [
  "none",
  "revalidate-exact",
  "reanchor-candidate",
  "resolve-only",
  "recompile-only",
  "rebuild-required",
  "refresh-available",
  "manual",
] as const;
export type BuildAction = (typeof BUILD_ACTIONS)[number];

export const COMPONENT_COMPATIBILITY = [
  "compatible",
  "quality-refresh-available",
  "compatibility-refresh-required",
] as const;
export type ComponentCompatibility = (typeof COMPONENT_COMPATIBILITY)[number];

export const PROJECTION_APPLICATION_STATES = [
  "unapplied",
  "applied",
  "compensated",
  "undone",
  "stale",
  "not-applicable",
] as const;
export type ProjectionApplicationState =
  (typeof PROJECTION_APPLICATION_STATES)[number];

export const STATE_VOCABULARY_AXES = [
  "review",
  "evidence-freshness",
  "reconciliation-signal",
  "build-action",
  "component-compatibility",
  "projection",
] as const;
export type StateVocabularyAxis = (typeof STATE_VOCABULARY_AXES)[number];

const AXIS_VALUES: Readonly<Record<StateVocabularyAxis, readonly string[]>> = {
  review: REVIEW_STATES,
  "evidence-freshness": EVIDENCE_FRESHNESS_STATES,
  "reconciliation-signal": RECONCILIATION_SIGNALS,
  "build-action": BUILD_ACTIONS,
  "component-compatibility": COMPONENT_COMPATIBILITY,
  projection: PROJECTION_APPLICATION_STATES,
};

function includesValue(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

export function isReviewState(value: string): value is ReviewState {
  return includesValue(REVIEW_STATES, value);
}

export function isEvidenceFreshness(value: string): value is EvidenceFreshness {
  return includesValue(EVIDENCE_FRESHNESS_STATES, value);
}

export function isReconciliationSignal(
  value: string,
): value is ReconciliationSignal {
  return includesValue(RECONCILIATION_SIGNALS, value);
}

export function isBuildAction(value: string): value is BuildAction {
  return includesValue(BUILD_ACTIONS, value);
}

export function isComponentCompatibility(
  value: string,
): value is ComponentCompatibility {
  return includesValue(COMPONENT_COMPATIBILITY, value);
}

export function isProjectionApplicationState(
  value: string,
): value is ProjectionApplicationState {
  return includesValue(PROJECTION_APPLICATION_STATES, value);
}

export function assertStateValueBelongsToAxis(
  value: string,
  axis: StateVocabularyAxis,
): void {
  if (!AXIS_VALUES[axis].includes(value)) {
    throw new Error(`State value '${value}' does not belong to ${axis} axis`);
  }
}

export function stateValuesForAxis(
  axis: StateVocabularyAxis,
): readonly string[] {
  return AXIS_VALUES[axis];
}
