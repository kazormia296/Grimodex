/** NIR-1 two-result wire. All capability and owner identities are opaque. */
export const RELATED_SCENES_INVALIDATED_EVENT = "related-scenes:invalidated";
export const RELATED_SCENES_INDEX_READY_EVENT = "related-scenes:index-ready";

export interface RelatedScenesIndexReadyEvent {
  readonly projectId: string;
}

export function isRelatedScenesIndexReadyEvent(
  value: unknown,
): value is RelatedScenesIndexReadyEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    typeof record.projectId === "string" &&
    record.projectId.trim().length > 0 &&
    record.projectId.length <= 200
  );
}

export interface RelatedScenesInvalidatedEvent {
  readonly queryBinding: string;
}

export function isRelatedScenesInvalidatedEvent(
  value: unknown,
): value is RelatedScenesInvalidatedEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    typeof record.queryBinding === "string" &&
    record.queryBinding.trim().length > 0 &&
    record.queryBinding.length <= 200
  );
}

export interface RelatedScenesBeginRequest {
  readonly expectedWorkspacePath: string;
  readonly projectId: string;
  readonly currentSceneId: string;
  /** Exact existing Raw saved-body tail; Native independently derives it. */
  readonly query: string;
}

export interface RelatedScenesRawHit {
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly chunkText: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly score: number;
  readonly dialogueRatio: number;
}

export interface RelatedScenesSnapshot {
  readonly queryBinding: string;
  /** Eligibility of this call at its first coherent backend snapshot. */
  readonly originalSnapshotUsable: boolean;
  readonly supportedProfile: boolean;
}

export type RelatedScenesUnavailableReason =
  | "index-unavailable"
  | "unsupported-query"
  | "failed"
  | "cancelled"
  | "invalidated"
  | "expired"
  | "capacity";

export interface Nir1AdmittedSceneWire {
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
    /** Display only. Qualification returns the separate full quote. */
    readonly excerpt: string;
    readonly navigationIdentity: string;
  };
  readonly review: "human-approved";
  readonly freshness: "fresh";
}

export interface RelatedScenesBeginResponse {
  readonly status: "raw-ready";
  readonly denseHits: readonly RelatedScenesRawHit[];
  readonly snapshot: RelatedScenesSnapshot;
  /** Relative Native durations only. Never subtract from a renderer clock. */
  readonly timing?: {
    readonly clock: "native-monotonic";
    readonly firstSnapshotElapsedMs: number;
    readonly rawReadyElapsedMs: number;
  };
  readonly ir:
    | { readonly status: "pending"; readonly operationTicket: string }
    | {
        readonly status: "unavailable";
        readonly reason: RelatedScenesUnavailableReason;
      };
}

/** Await work started by begin. This request starts neither IR nor a deadline. */
export interface RelatedScenesContinueRequest {
  readonly operationTicket: string;
}

export type RelatedScenesContinueResponse =
  | {
      readonly status: "available";
      readonly queryBinding: string;
      readonly scenes: readonly Nir1AdmittedSceneWire[];
    }
  | {
      readonly status: "unavailable";
      readonly reason: RelatedScenesUnavailableReason;
    };

/** Keep the ticket while its published IR list remains clickable; release on
 * timeout, supersession, cancellation, or unmount. Release is idempotent. */
export interface RelatedScenesReleaseRequest {
  readonly operationTicket: string;
}
export interface RelatedScenesReleaseResponse {
  readonly status: "released";
}

/** Bound to the original S2 query and current Native authority. Call again
 * after the target editor loads, immediately before the guarded selection. */
export interface Nir1EvidenceQualifyRequest {
  readonly navigationIdentity: string;
}
export type Nir1EvidenceQualifyResponse =
  | {
      readonly status: "qualified";
      readonly bindingKey: string;
      readonly queryBinding: string;
      readonly sceneId: string;
      readonly sourceVersion: number;
      readonly storageDigest: string;
      readonly canonicalTextDigest: string;
      readonly normalizerVersion: string;
      readonly fullQuote: string;
      readonly canonicalRange: { readonly start: number; readonly end: number };
    }
  | {
      readonly status: "unavailable";
      readonly reason: "invalidated" | "expired" | "cancelled" | "failed";
    };
