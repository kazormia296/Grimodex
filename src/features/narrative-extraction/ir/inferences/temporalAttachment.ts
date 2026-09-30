import type { ObservationId } from "../../temporal/nodes";
import type { TemporalNodeId } from "../../temporal/nodes";

export interface TemporalAttachmentInferencePayload {
  readonly expressionObservationId: ObservationId;
  readonly target:
    | { readonly status: "resolved"; readonly nodeId: TemporalNodeId }
    | {
        readonly status: "ambiguous";
        readonly candidates: readonly TemporalNodeId[];
      }
    | { readonly status: "unresolved" };
  readonly anchor:
    | { readonly status: "resolved"; readonly nodeId: TemporalNodeId }
    | { readonly status: "absolute" }
    | {
        readonly status: "ambiguous";
        readonly candidates: readonly TemporalNodeId[];
      }
    | { readonly status: "unresolved" };
  readonly role:
    | "occurs-at"
    | "starts-at"
    | "ends-at"
    | "duration"
    | "relative-to";
}

export interface TemporalAttachmentInference {
  readonly inferenceId: string;
  readonly kind: "temporal.attachment";
  readonly payload: TemporalAttachmentInferencePayload;
}
