import {
  isEvidenceFreshness,
  isReviewState,
  type EvidenceFreshness,
  type ReviewState,
} from "./stateVocabulary";

export interface NarrativeAssertionState {
  readonly revisionId: string;
  readonly review: ReviewState;
  readonly evidenceFreshness: EvidenceFreshness;
  /** Optional until cross-run merge, deduplication, or graph traversal needs it. */
  readonly assertionId?: string | null;
}

export type NarrativeAssertionStateInput = Omit<
  NarrativeAssertionState,
  "assertionId"
> &
  Partial<Pick<NarrativeAssertionState, "assertionId">>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createNarrativeAssertionState(
  input: NarrativeAssertionStateInput,
): NarrativeAssertionState {
  if (!isNonEmptyString(input.revisionId)) {
    throw new Error("Narrative assertion revisionId is required");
  }
  if (!isReviewState(input.review)) {
    throw new Error(
      `Invalid narrative assertion review state: ${input.review}`,
    );
  }
  if (!isEvidenceFreshness(input.evidenceFreshness)) {
    throw new Error(
      `Invalid narrative assertion evidence freshness: ${input.evidenceFreshness}`,
    );
  }
  if (
    input.assertionId !== undefined &&
    input.assertionId !== null &&
    !isNonEmptyString(input.assertionId)
  ) {
    throw new Error(
      "Narrative assertion assertionId must be non-empty or null",
    );
  }

  const state: NarrativeAssertionState = {
    revisionId: input.revisionId,
    review: input.review,
    evidenceFreshness: input.evidenceFreshness,
  };
  if (input.assertionId !== undefined) {
    return { ...state, assertionId: input.assertionId };
  }
  return state;
}

export function isNarrativeAssertionState(
  value: unknown,
): value is NarrativeAssertionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.revisionId) &&
    typeof candidate.review === "string" &&
    isReviewState(candidate.review) &&
    typeof candidate.evidenceFreshness === "string" &&
    isEvidenceFreshness(candidate.evidenceFreshness) &&
    (candidate.assertionId === undefined ||
      candidate.assertionId === null ||
      isNonEmptyString(candidate.assertionId)) &&
    !Object.hasOwn(candidate, "projection")
  );
}
