export const NARRATIVE_EVAL_CASE_SCHEMA_VERSION = 1 as const;

export const NARRATIVE_EVAL_DIMENSIONS = [
  "eventDetection",
  "actuality",
  "attribution",
  "narrativeFrame",
  "evidence",
  "clustering",
  "significance",
  "proposalGate",
] as const;

export type NarrativeEvalDimension = (typeof NARRATIVE_EVAL_DIMENSIONS)[number];

export interface NarrativeEvalEvidence {
  readonly documentId: string;
  readonly quote: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

export interface NarrativeEvalDimensions {
  readonly eventDetection?: boolean;
  readonly actuality?: string;
  readonly attribution?: string;
  readonly narrativeFrame?: string;
  readonly evidence?: readonly NarrativeEvalEvidence[];
  readonly clustering?: string;
  readonly significance?: string;
  readonly proposalGate?: string;
}

export interface NarrativeEvalExpectedObservation {
  readonly id: string;
  readonly semanticKey: string;
  readonly dimensions: NarrativeEvalDimensions;
}

export interface NarrativeEvalCriticalViolationClass {
  readonly id: string;
  readonly description: string;
  readonly match: {
    readonly semanticKey: string;
    readonly dimension: NarrativeEvalDimension;
    readonly value: unknown;
  };
}

export interface NarrativeEvalCaseV1 {
  readonly schemaVersion: typeof NARRATIVE_EVAL_CASE_SCHEMA_VERSION;
  readonly id: string;
  readonly scope: {
    readonly slice: string;
    readonly tier: "micro" | "chapter" | "work" | "mutation";
  };
  readonly locale: string;
  readonly timezone: string;
  readonly frozenTime: string;
  readonly coverage: {
    readonly mode: "complete" | "partial";
    readonly includedDocumentIds: readonly string[];
    readonly omittedDocumentIds: readonly string[];
  };
  readonly documents: readonly {
    readonly id: string;
    readonly title: string;
    readonly text: string;
  }[];
  readonly expected: {
    readonly observations: {
      readonly required: readonly NarrativeEvalExpectedObservation[];
      readonly forbidden: readonly NarrativeEvalExpectedObservation[];
    };
  };
  readonly criticalViolationClasses: readonly NarrativeEvalCriticalViolationClass[];
}

export type NarrativeObservedDimension<T = unknown> =
  | { readonly status: "observed"; readonly value: T }
  | { readonly status: "unobservable"; readonly reason: string };

export type NarrativeActualDimensions = Partial<
  Record<NarrativeEvalDimension, NarrativeObservedDimension>
>;

export interface NarrativeActualObservation {
  readonly id: string;
  readonly semanticKey: string;
  readonly dimensions: NarrativeActualDimensions;
}

export interface NarrativeActualGraph {
  readonly observations: readonly NarrativeActualObservation[];
  readonly coverageClaims?: readonly {
    readonly kind: "absence" | "complete" | "resolved";
    readonly value: string;
  }[];
  readonly appliedProposalIds?: readonly string[];
}

export interface NarrativeDimensionScore {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  unobservable: number;
}

export interface NarrativeCriticalViolation {
  readonly classId: string;
  readonly actualObservationId?: string;
  readonly message: string;
}

export interface NarrativeEvalCaseScore {
  readonly passed: boolean;
  readonly dimensions: Record<NarrativeEvalDimension, NarrativeDimensionScore>;
  readonly criticalViolations: readonly NarrativeCriticalViolation[];
  readonly unobservableDimensions: readonly {
    readonly actualObservationId: string;
    readonly dimension: NarrativeEvalDimension;
    readonly reason: string;
  }[];
}
