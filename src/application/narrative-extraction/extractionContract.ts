/** Public Chronicle extraction identifiers used by the review surface. */
export const CHRONICLE_EXTRACT_SURFACE_PATH = "chronicle.extract" as const;

export const CHRONICLE_EXTRACT_ARTIFACT_KINDS = {
  snapshot: "source.snapshot@1",
  windowPlan: "source.window-plan@1",
  observations: "chronicle.raw-observations@1",
  resolvedEvidence: "evidence.resolved@1",
  mergedObservations: "chronicle.merged-observations@1",
  clusters: "chronicle.event-clusters@1",
  hypotheses: "chronicle.event-hypotheses@1",
  /** C1-only per-terminal parser projection; generic raw observations stay V1. */
  stageSynthesisOutputs: "chronicle.stage-synthesis-outputs@1",
  matches: "chronicle.existing-event-matches@1",
  proposals: "chronicle.proposal-plan@1",
} as const;
