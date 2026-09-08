import type { Nir1EvidenceOrigin } from "./nir1EvidenceNavigationState";
import type {
  Nir1InitialUsabilitySnapshot,
  Nir1RelatedScenesCompletion,
} from "./nir1RelatedScenesDeadline";
import type { Nir1RelatedScenesResult } from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";
import type { RelatedScene } from "./selectRelatedScenes";
import type { RelatedScenesBeginResponse } from "@/../electron/shared/relatedScenesSearchWire";

export interface Nir1RelatedScenesFetchOptions {
  readonly mode: "hybrid";
  readonly signal?: AbortSignal;
  /** Assigned by a consumer at fetch start, never when a response arrives. */
  readonly queryGeneration?: number;
  readonly isCurrent?: () => boolean;
}

export interface Nir1RelatedScenesFetchResult {
  readonly status: "completed" | "cancelled" | "failed";
  readonly rawStatus: "not-started" | "completed" | "failed";
  readonly origin: Nir1EvidenceOrigin | null;
  readonly queryBinding: string | null;
  readonly initialSnapshot: Nir1InitialUsabilitySnapshot | null;
  readonly completion: Nir1RelatedScenesCompletion | null;
  readonly rawScenes: readonly RelatedScene[];
  readonly result: Nir1RelatedScenesResult;
  /** Release the UI owner on replacement/unmount; retain only for navigation. */
  readonly session: Nir1RelatedScenesSession | null;
  readonly timing: {
    readonly native?: RelatedScenesBeginResponse["timing"];
    readonly tFetchMs: number;
    readonly tRawReadyMs: number | null;
    readonly tReturnMs: number;
  };
}
