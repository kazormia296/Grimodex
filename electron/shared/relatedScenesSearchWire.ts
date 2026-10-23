/** NIR-1 two-result wire. All capability and owner identities are opaque. */
export const RELATED_SCENES_INVALIDATED_EVENT = "related-scenes:invalidated";
export const RELATED_SCENES_INDEX_READY_EVENT = "related-scenes:index-ready";
/** A late Graph result is now cached (CP-3a). The payload is `{ projectId }` only. */
export const RELATED_SCENES_GRAPH_READY_EVENT = "related-scenes:graph-ready";

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

/** Same `{ projectId }` shape and checks as `index-ready`; no other key. */
export interface RelatedScenesGraphReadyEvent {
  readonly projectId: string;
}

export function isRelatedScenesGraphReadyEvent(
  value: unknown,
): value is RelatedScenesGraphReadyEvent {
  return isRelatedScenesIndexReadyEvent(value);
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
  /**
   * Optional Graph seed Entity (CP-3a). A locator claim, not authority: Native
   * re-reads the seed rule and drops the Graph when it differs. When absent the
   * request, and the response, are exactly the non-Graph shape.
   */
  readonly graphSeedEntityId?: string;
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

/**
 * The closed Native Graph reasons (CP-1 allowlist, DSN §1.5). A cached hit is
 * reported as `pending` and awaited through the same continue command.
 */
export type RelatedScenesGraphUnavailableReason =
  | "not-requested"
  | "not-activated"
  | "profile-not-restricted"
  | "warming"
  | "stale"
  | "busy"
  | "limit"
  | "timeout"
  | "registration-unavailable"
  | "invalidated"
  | "cancelled"
  | "restart-required"
  | "worker-unavailable"
  | "failed";

export type RelatedScenesBeginGraph =
  | { readonly status: "pending" }
  | {
      readonly status: "unavailable";
      readonly reason: RelatedScenesGraphUnavailableReason;
    };

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
  /** Present only when the request carried `graphSeedEntityId`. */
  readonly graph?: RelatedScenesBeginGraph;
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

/**
 * Await the Graph started by begin (CP-3a). The same `operationTicket` as IR.
 * `rawSceneIds` is the renderer's Raw R (0..8 Scene IDs, a subset of the dense
 * hits begin returned); a claim, never authority. One wait per operation.
 */
export interface RelatedScenesGraphWaitRequest {
  readonly operationTicket: string;
  readonly rawSceneIds: readonly string[];
}

/** The renderer's declaration for the Graph ticket; carries no plaintext. */
export type RelatedScenesGraphSettle = "used" | "unused" | "cancelled";
export interface RelatedScenesGraphSettleRequest {
  readonly operationTicket: string;
  readonly settle: RelatedScenesGraphSettle;
}
export interface RelatedScenesGraphSettleResponse {
  readonly status: "settled";
}

export interface RelatedScenesGraphPathEntity {
  readonly entityId: string;
  readonly label: string;
}
export interface RelatedScenesGraphPathEdge {
  readonly relationType: string;
  readonly directionality: string;
  readonly from: RelatedScenesGraphPathEntity;
  readonly to: RelatedScenesGraphPathEntity;
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly quote: string;
  }[];
}
/** Display text of the path attached to one displayed (R or R+IR) Scene. */
export interface RelatedScenesGraphPathAttachment {
  readonly sceneId: string;
  readonly hop: number;
  readonly edges: readonly RelatedScenesGraphPathEdge[];
}
/**
 * The one Graph-only row, when Eligible. Every reason it is absent is the same
 * `null`. `navigationIdentity` is opaque; no digest, token or Revision ID.
 */
export interface RelatedScenesGraphOnlyRow {
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly excerpt: string;
  readonly canonicalRange: { readonly start: number; readonly end: number };
  readonly navigationIdentity: string;
  readonly path: {
    readonly hop: number;
    readonly pinEntityId: string;
    readonly edges: readonly RelatedScenesGraphPathEdge[];
  };
}

export type RelatedScenesGraphWaitResponse =
  | {
      readonly status: "available";
      readonly queryBinding: string;
      readonly pathAttachments: readonly RelatedScenesGraphPathAttachment[];
      readonly graphOnly: RelatedScenesGraphOnlyRow | null;
    }
  | {
      readonly status: "unavailable";
      readonly reason: RelatedScenesGraphUnavailableReason;
    };
export type RelatedScenesGraphContinueResponse =
  | RelatedScenesGraphWaitResponse
  | RelatedScenesGraphSettleResponse;

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

/**
 * Click-time answer for a Graph-only row's handle. It never carries a body
 * digest or the full quote: Native re-reads and compares them itself, and the
 * renderer matches its own editor text against the disclosed `excerpt`.
 */
export type Nir1GraphEvidenceQualifyResponse =
  | {
      readonly status: "qualified";
      readonly bindingKey: string;
      readonly queryBinding: string;
      readonly sceneId: string;
      readonly canonicalRange: { readonly start: number; readonly end: number };
    }
  | {
      readonly status: "unavailable";
      readonly reason: "invalidated" | "cancelled" | "failed";
    };
