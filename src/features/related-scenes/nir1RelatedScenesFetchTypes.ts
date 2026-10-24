import type { Nir1EvidenceOrigin } from "./nir1EvidenceNavigationState";
import type {
  Nir1InitialUsabilitySnapshot,
  Nir1RelatedScenesCompletion,
} from "./nir1RelatedScenesDeadline";
import type { Nir1RelatedScenesResult } from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";
import type { RelatedScene } from "./selectRelatedScenes";
import type { Nir1GraphJoinOutcome } from "./nir1RelatedScenesGraphJoin";
import type {
  RelatedScenesBeginResponse,
  RelatedScenesGraphOnlyRow,
  RelatedScenesGraphPathAttachment,
} from "@/../electron/shared/relatedScenesSearchWire";

/**
 * A Graph answer Native re-qualified for this query: display text only. It is
 * attached to the R/R+IR fusion result and shown by nothing yet (CP-3b).
 */
export interface Nir1RelatedScenesGraphPayload {
  readonly queryBinding: string;
  readonly pathAttachments: readonly RelatedScenesGraphPathAttachment[];
  readonly graphOnly: RelatedScenesGraphOnlyRow | null;
}

export interface Nir1RelatedScenesFetchOptions {
  readonly mode: "hybrid";
  /** Fresh Raw recovery after revocation, independent of IR readiness. */
  readonly rawOnly?: boolean;
  readonly signal?: AbortSignal;
  /** Assigned by a consumer at fetch start, never when a response arrives. */
  readonly queryGeneration?: number;
  readonly isCurrent?: () => boolean;
  /**
   * Test/CP-3b injection point: when present, begin carries the seed and the
   * Graph is joined with IR. No production caller passes it yet. Ignored for
   * `rawOnly` (no begin).
   */
  readonly graphSeedEntityId?: string;
}

export interface Nir1RelatedScenesFetchResult {
  readonly status: "completed" | "cancelled" | "invalidated" | "failed";
  readonly rawStatus: "not-started" | "completed" | "failed";
  readonly origin: Nir1EvidenceOrigin | null;
  readonly queryBinding: string | null;
  readonly initialSnapshot: Nir1InitialUsabilitySnapshot | null;
  readonly completion: Nir1RelatedScenesCompletion | null;
  readonly rawScenes: readonly RelatedScene[];
  readonly result: Nir1RelatedScenesResult;
  /** Present only for a seeded query: how the Graph joined the result. */
  readonly graphOutcome?: Nir1GraphJoinOutcome;
  /** Present only for `graph-ready`; the fusion result itself is unchanged. */
  readonly graph?: Nir1RelatedScenesGraphPayload;
  /** Release the UI owner on replacement/unmount; retain only for navigation. */
  readonly session: Nir1RelatedScenesSession | null;
  readonly timing: {
    readonly native?: RelatedScenesBeginResponse["timing"];
    readonly tFetchMs: number;
    readonly tRawReadyMs: number | null;
    readonly tReturnMs: number;
  };
}
