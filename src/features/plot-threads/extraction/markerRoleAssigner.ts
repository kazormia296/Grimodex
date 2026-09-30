import type { PlotPhaseType } from "@/db/schema";
import type {
  DocumentRef,
  InferenceId,
} from "@/features/narrative-extraction/temporal/nodes";
import type { ThreadAdvancement } from "@/features/narrative-extraction/ir/inferences/threadDevelopment";

export interface MarkerRoleInput {
  readonly documentRef: DocumentRef;
  readonly readingOrderIndex: number;
  readonly advancement: ThreadAdvancement;
  readonly developmentInferenceId: InferenceId;
  readonly evidenceAnchorIds: readonly [string, ...string[]];
  /** True when this is the first development in the analysis scope. */
  readonly isFirstInScope: boolean;
  readonly scopeEntry:
    | "introduced-in-scope"
    | "preexisting-before-scope"
    | "unknown";
  /** True only when Core end-condition evidence exists — never “last marker”. */
  readonly hasStableClosureEvidence: boolean;
}

export interface MarkerRoleAssignment {
  readonly documentRef: DocumentRef;
  readonly primaryPhase: PlotPhaseType;
  readonly developmentInferenceIds: readonly [InferenceId, ...InferenceId[]];
  readonly evidenceAnchorIds: readonly [string, ...string[]];
  readonly roleSupportReason:
    | "first-reader-establishment"
    | "incremental-progress"
    | "new-obstacle"
    | "stakes-escalation"
    | "goal-redirection"
    | "decisive-revelation"
    | "decisive-confrontation"
    | "stable-closure";
}

/**
 * Assign Plot Marker phases from Reading Order developments.
 * Not a hard FSM; never force resolve on last marker; never force introduce
 * when scopeEntry is preexisting-before-scope.
 */
export function assignMarkerRoles(
  inputs: readonly MarkerRoleInput[],
): readonly MarkerRoleAssignment[] {
  const sorted = [...inputs].sort(
    (a, b) =>
      a.readingOrderIndex - b.readingOrderIndex ||
      a.documentRef.localeCompare(b.documentRef),
  );

  return sorted.map((row) => {
    const mapped = mapAdvancement(row);
    return {
      documentRef: row.documentRef,
      primaryPhase: mapped.phase,
      developmentInferenceIds: [row.developmentInferenceId],
      evidenceAnchorIds: row.evidenceAnchorIds,
      roleSupportReason: mapped.reason,
    };
  });
}

function mapAdvancement(row: MarkerRoleInput): {
  phase: PlotPhaseType;
  reason: MarkerRoleAssignment["roleSupportReason"];
} {
  switch (row.advancement) {
    case "establishes":
      if (row.scopeEntry === "preexisting-before-scope") {
        return { phase: "develop", reason: "incremental-progress" };
      }
      return { phase: "introduce", reason: "first-reader-establishment" };
    case "progresses":
      return { phase: "develop", reason: "incremental-progress" };
    case "complicates":
      return { phase: "develop", reason: "new-obstacle" };
    case "escalates":
      return { phase: "develop", reason: "stakes-escalation" };
    case "redirects":
    case "reverses":
      return { phase: "turn", reason: "goal-redirection" };
    case "reveals":
      return { phase: "turn", reason: "decisive-revelation" };
    case "confronts":
      return { phase: "climax", reason: "decisive-confrontation" };
    case "resolves":
      if (!row.hasStableClosureEvidence) {
        return { phase: "develop", reason: "incremental-progress" };
      }
      return { phase: "resolve", reason: "stable-closure" };
    case "reopens":
      return { phase: "develop", reason: "incremental-progress" };
  }
}

/** Marker gate: background co-presence / mere mention is excluded. */
export function shouldCreateMarkerCandidate(input: {
  readonly advancement: ThreadAdvancement;
  readonly materiality: "major" | "moderate" | "minor";
  readonly isBackgroundMentionOnly: boolean;
}): boolean {
  if (input.isBackgroundMentionOnly) return false;
  if (input.materiality === "minor" && input.advancement === "progresses") {
    return false;
  }
  return true;
}

/** New-thread gate for balanced profile. */
export function meetsNewThreadMinimum(input: {
  readonly materialDevelopmentCount: number;
  readonly distinctSceneCount: number;
  readonly hasCoreConcern: boolean;
  readonly exactEvidenceSites: number;
}): boolean {
  return (
    input.materialDevelopmentCount >= 2 &&
    input.distinctSceneCount >= 2 &&
    input.hasCoreConcern &&
    input.exactEvidenceSites >= 2
  );
}
