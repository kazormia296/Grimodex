/**
 * Shared scene membership is Convergence, not Branch.
 * Branch requires an independent Core for the target after the anchor.
 * Merge requires source independence to end at the anchor.
 */
export type PlotThreadRelationKind =
  | "branch"
  | "merge"
  | "intersection"
  | "dependency"
  | "causal-handoff";

export interface ThreadRelationGateInput {
  readonly kind: PlotThreadRelationKind;
  readonly bothIdentitiesResolved: boolean;
  readonly anchorExactEvidence: boolean;
  readonly targetHasIndependentCoreAfterAnchor: boolean;
  readonly sourceContinuesIndependentlyAfterAnchor: boolean;
  readonly coverageComplete: boolean;
  readonly mereSharedScene: boolean;
}

export type ThreadRelationGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function evaluateThreadRelationGate(
  input: ThreadRelationGateInput,
): ThreadRelationGateResult {
  if (input.mereSharedScene && input.kind !== "intersection") {
    return {
      ok: false,
      reason: "shared-scene-is-intersection-not-branch",
    };
  }
  if (input.kind === "intersection" || input.kind === "dependency") {
    return { ok: true };
  }
  if (!input.bothIdentitiesResolved) {
    return { ok: false, reason: "unresolved-thread-identity" };
  }
  if (!input.anchorExactEvidence) {
    return { ok: false, reason: "missing-exact-evidence" };
  }
  if (input.kind === "branch") {
    if (!input.targetHasIndependentCoreAfterAnchor) {
      return { ok: false, reason: "branch-target-lacks-independent-core" };
    }
    return { ok: true };
  }
  if (input.kind === "merge") {
    if (!input.coverageComplete) {
      return { ok: false, reason: "partial-scope-cannot-assert-merge" };
    }
    if (input.sourceContinuesIndependentlyAfterAnchor) {
      return { ok: false, reason: "merge-source-still-independent" };
    }
    return { ok: true };
  }
  // causal-handoff: report-only in v1 — ok as report, not as branch row
  return { ok: true };
}
