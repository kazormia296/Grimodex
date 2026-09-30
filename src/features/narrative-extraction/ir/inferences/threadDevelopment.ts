import type { DocumentRef, InferenceId } from "../../temporal/nodes";

export type ThreadAdvancement =
  | "establishes"
  | "progresses"
  | "complicates"
  | "escalates"
  | "redirects"
  | "reveals"
  | "reverses"
  | "confronts"
  | "resolves"
  | "reopens";

export interface ThreadDevelopmentInferencePayload {
  readonly developmentId: string;
  readonly documentRef: DocumentRef;
  readonly sourceEventInferenceIds: readonly InferenceId[];
  readonly sourceStateInferenceIds: readonly InferenceId[];
  readonly sourceGoalInferenceIds: readonly InferenceId[];
  readonly sourceConflictInferenceIds: readonly InferenceId[];
  readonly sourceQuestionInferenceIds: readonly InferenceId[];
  readonly advancement: ThreadAdvancement;
  readonly materiality: "major" | "moderate" | "minor";
  readonly centrality: "primary" | "secondary";
  readonly explanation: string;
}

export interface ThreadDevelopmentInference {
  readonly inferenceId: InferenceId;
  readonly kind: "plot.thread-development";
  readonly payload: ThreadDevelopmentInferencePayload;
}

/** Background mention / mere co-presence is not a development. */
export function isMaterialDevelopment(
  payload: ThreadDevelopmentInferencePayload,
): boolean {
  return payload.materiality !== "minor" || payload.centrality === "primary";
}
