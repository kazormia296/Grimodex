import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type { DocumentRef, InferenceId } from "../../temporal/nodes";
import type { ForeshadowSetupSignalKind } from "./foreshadowSetupSignal";
import type { ForeshadowPayoffSignalKind } from "./foreshadowPayoffSignal";
import type { SetupPayoffBridgeKind } from "./setupPayoffSupportEdge";

export type ForeshadowThreadId = `foreshadow-thread:${string}`;

export interface ForeshadowThreadCore {
  readonly kind: "setup-payoff-thread";
  readonly bridgeKind: SetupPayoffBridgeKind;
  readonly setupSignalKind: ForeshadowSetupSignalKind;
  readonly payoffSignalKind: ForeshadowPayoffSignalKind;
  readonly unifyingConcern: string;
}

export type ForeshadowExistingResolution =
  | { readonly status: "none" }
  | {
      readonly status: "resolved";
      readonly ref: `FS${string}`;
      readonly method:
        | "application-provenance"
        | "core-and-marker-overlap"
        | "user-confirmed";
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly {
        readonly ref: `FS${string}`;
        readonly score: number;
        readonly reasons: readonly string[];
      }[];
    }
  | {
      readonly status: "already-satisfied";
      readonly ref: `FS${string}`;
      readonly reason: "setup-and-payoff-present" | "payoff-only-orphan";
    };

export interface ForeshadowSetupMarkerCandidate {
  readonly documentRef: DocumentRef;
  readonly setupSignalId: string;
  readonly readingOrderIndex: number;
  readonly noteSuggestion: string | null;
  readonly evidenceAnchorIds: readonly [string, ...string[]];
}

export interface ForeshadowPayoffMarkerCandidate {
  readonly documentRef: DocumentRef;
  readonly payoffSignalId: string;
  readonly readingOrderIndex: number;
  readonly noteSuggestion: string | null;
  readonly evidenceAnchorIds: readonly [string, ...string[]];
}

export interface ForeshadowThreadHypothesisPayload {
  readonly threadId: ForeshadowThreadId;
  readonly core: ForeshadowThreadCore;
  readonly titleSuggestion: string;
  readonly intentSuggestion: string;
  readonly loadBearingSuggestion: "critical" | "supporting" | "optional" | null;
  readonly participantEntityIds: readonly NarrativeEntityId[];
  readonly setupSignalIds: readonly [string, ...string[]];
  readonly payoffSignalIds: readonly [string, ...string[]];
  readonly edgeInferenceIds: readonly InferenceId[];
  readonly setupMarkerCandidates: readonly ForeshadowSetupMarkerCandidate[];
  readonly payoffMarkerCandidates: readonly ForeshadowPayoffMarkerCandidate[];
  readonly lifecycle:
    | "open"
    | "seeded"
    | "paid"
    | "orphan-payoff"
    | "abandoned"
    | "unknown";
  readonly coverage: "complete" | "partial";
  readonly existingResolution: ForeshadowExistingResolution;
}
