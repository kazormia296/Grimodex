import type { RelatedScene } from "./selectRelatedScenes";

/** Safe display projection of a backend-admitted scene, never an envelope. */
export interface Nir1AdmittedScene {
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly irCosine: number;
  readonly interpretation: {
    readonly summary: string;
    readonly actuality: string;
    readonly attribution: string;
    readonly narrativeFrame: string;
  };
  readonly validatedEvidence: {
    /** Display only; click validation supplies the full canonical quote. */
    readonly excerpt: string;
    /** Backend-bound identity; renderer must not decode or synthesize it. */
    readonly navigationIdentity: string;
  };
  readonly review: "human-approved";
  readonly freshness: "fresh";
}

const NIR1_SAFE_UNAVAILABLE_REASONS = [
  "index-unavailable",
  "unsupported-query",
  "invalid-response",
  "failed",
  "timeout",
  "cancelled",
  "invalidated",
] as const;

export type Nir1IrUnavailableReason =
  (typeof NIR1_SAFE_UNAVAILABLE_REASONS)[number];

/** Do not propagate backend exception text or rejected source details. */
export function nir1SafeUnavailableReason(
  reason: unknown,
): Nir1IrUnavailableReason {
  return (
    NIR1_SAFE_UNAVAILABLE_REASONS.find((safe) => safe === reason) ??
    "invalid-response"
  );
}

export interface Nir1IrUnavailable {
  readonly status: "unavailable";
  readonly reason: Nir1IrUnavailableReason;
}

/**
 * Backend admission, cosine scoring, scene-max/tie selection and cap precede
 * this boundary. The renderer does not admit or score an interpretation pool.
 */
export type Nir1RelatedScenesIr =
  | {
      readonly status: "available";
      readonly scenes: readonly Nir1AdmittedScene[];
    }
  | Nir1IrUnavailable;

interface Nir1SceneRank {
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly rank1: number;
}

export type Nir1FusedScene = Nir1SceneRank &
  (
    | { readonly kind: "raw"; readonly raw: RelatedScene }
    | {
        readonly kind: "raw-ir";
        readonly raw: RelatedScene;
        readonly ir: Nir1AdmittedScene;
      }
    | { readonly kind: "ir"; readonly ir: Nir1AdmittedScene }
  );

export type Nir1RelatedScenesResult =
  | {
      readonly kind: "raw";
      /** Exact original Raw list, including its original cosine and excerpt. */
      readonly scenes: readonly RelatedScene[];
      readonly ir: Nir1IrUnavailable | { readonly status: "empty" };
    }
  | {
      readonly kind: "fused";
      readonly scenes: readonly Nir1FusedScene[];
      readonly ir: { readonly status: "available" };
    };
