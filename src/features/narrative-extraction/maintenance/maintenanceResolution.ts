import type { DomainObjectKey } from "./domainObjectKey";

export type NarrativeMaintenanceResolutionOutcome =
  | "accepted"
  | "rejected"
  | "deferred";

export type NarrativeMaintenanceResolutionActor =
  | { readonly kind: "human"; readonly actorId?: string }
  | { readonly kind: "automatic-policy"; readonly policyId: string };

/** Terminal (or deferred) outcome of one `NarrativeMaintenanceProposal`. */
export interface NarrativeMaintenanceResolution {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly outcome: NarrativeMaintenanceResolutionOutcome;
  readonly resolvedAt: string;
  readonly resolvedBy: NarrativeMaintenanceResolutionActor;
  /** Set when `outcome === "accepted"` and applying it touched an object. */
  readonly appliedObjectKey?: DomainObjectKey;
  readonly note?: string;
}
