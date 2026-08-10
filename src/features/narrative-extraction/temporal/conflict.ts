import type { TemporalEndpointRef } from "./constraints";
import type { TemporalNodeId } from "./nodes";

export interface TemporalConflict {
  readonly conflictId: string;
  readonly constraintIds: readonly string[];
  readonly nodeIds: readonly TemporalNodeId[];
  readonly explanation: string;
  readonly cycle: readonly {
    readonly from: TemporalEndpointRef;
    readonly to: TemporalEndpointRef;
    readonly constraintId: string;
  }[];
}
