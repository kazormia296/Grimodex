import type { DomainObjectKey } from "./domainObjectKey";
import type { EvidenceReanchorCandidate } from "./rangeImpact";

export type NarrativeMaintenanceProposalKind =
  | "reanchor-evidence"
  | "reevaluate-contribution"
  | "mark-stale-acknowledged"
  | "component-refresh";

/** Adopt a deterministic reanchor candidate for evidence that moved. */
export interface ReanchorEvidenceProposalPayload {
  readonly kind: "reanchor-evidence";
  readonly objectKey: DomainObjectKey;
  readonly candidate: EvidenceReanchorCandidate;
}

/** Re-run the AI task that produced a contribution against fresh evidence. */
export interface ReevaluateContributionProposalPayload {
  readonly kind: "reevaluate-contribution";
  readonly applicationId: string;
  readonly targetObjectKey: DomainObjectKey;
}

/** Dismiss a staleness marker without any content change (human reviewed it). */
export interface MarkStaleAcknowledgedProposalPayload {
  readonly kind: "mark-stale-acknowledged";
  readonly objectKey: DomainObjectKey;
}

/** Adopt a newer pipeline component version for a committed artifact. */
export interface ComponentRefreshProposalPayload {
  readonly kind: "component-refresh";
  readonly componentId: string;
  readonly targetVersion: string;
}

export type NarrativeMaintenanceProposalPayload =
  | ReanchorEvidenceProposalPayload
  | ReevaluateContributionProposalPayload
  | MarkStaleAcknowledgedProposalPayload
  | ComponentRefreshProposalPayload;

/**
 * A proposed maintenance action. Proposals are always surfaced for
 * resolution (see `maintenanceResolution.ts`) — nothing in this module
 * applies a proposal on its own.
 */
export interface NarrativeMaintenanceProposal {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly payload: NarrativeMaintenanceProposalPayload;
  readonly rationale?: string;
}
