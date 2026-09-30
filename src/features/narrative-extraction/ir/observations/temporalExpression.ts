import type { TemporalLiteral } from "../../temporal/constraints";

export type TemporalExpressionAttachmentHint =
  | "event-time"
  | "scene-frame"
  | "state-start"
  | "state-end"
  | "duration"
  | "anchor-reference"
  | "unknown";

export interface TemporalExpressionPayload {
  readonly surface: string;
  readonly expression: TemporalLiteral;
  readonly attachmentHint: TemporalExpressionAttachmentHint;
}

export interface RawTemporalExpressionObservation {
  readonly localId: string;
  readonly documentRef: string;
  readonly surfaceOffsets: {
    readonly from: number;
    readonly to: number;
  };
  readonly payload: TemporalExpressionPayload;
}
