import type { DocumentRef, TemporalNodeId } from "../../temporal/nodes";

export interface SceneTemporalProfile {
  readonly documentRef: DocumentRef;
  readonly profile:
    | "single-period"
    | "bounded-span"
    | "multi-period"
    | "atemporal"
    | "unknown";
  readonly primaryTemporalNodeId: TemporalNodeId | null;
  readonly embeddedTemporalNodeIds: readonly TemporalNodeId[];
  readonly evidenceAnchorIds: readonly string[];
}
