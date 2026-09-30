import type { ProposalBase } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type {
  ForeshadowThreadCore,
  ForeshadowThreadId,
} from "@/features/narrative-extraction/ir/inferences/foreshadowThreadHypothesis";
import type { SetupPayoffBridgeKind } from "@/features/narrative-extraction/ir/inferences/setupPayoffSupportEdge";
import type { ForeshadowStrength } from "@/features/foreshadow/types";

export const BIND_FORESHADOW_THREAD_PROPOSAL_KIND =
  "foreshadow.thread.bind" as const;

export interface BindForeshadowThreadProposalPayload {
  readonly threadHypothesisId: ForeshadowThreadId;
  readonly binding:
    | { readonly kind: "create-new" }
    | { readonly kind: "bind-existing"; readonly foreshadowRef: `FS${string}` }
    | {
        readonly kind: "unresolved";
        readonly candidateForeshadowRefs: readonly `FS${string}`[];
      }
    | {
        readonly kind: "already-satisfied";
        readonly foreshadowRef: `FS${string}`;
      };
  readonly title: string;
  readonly intent:
    | { readonly kind: "set-on-create"; readonly value: string }
    | { readonly kind: "fill-if-empty"; readonly value: string }
    | { readonly kind: "leave" };
  readonly loadBearing: "critical" | "supporting" | "optional" | null;
  readonly core: ForeshadowThreadCore;
}

export type BindForeshadowThreadProposal = ProposalBase<
  typeof BIND_FORESHADOW_THREAD_PROPOSAL_KIND,
  { readonly kind: "foreshadow-thread"; readonly logicalRef: string },
  BindForeshadowThreadProposalPayload
>;

export const PLACE_FORESHADOW_SETUP_PROPOSAL_KIND =
  "foreshadow.setup.place" as const;

export interface PlaceForeshadowSetupProposalPayload {
  readonly threadHypothesisId: ForeshadowThreadId;
  readonly documentRef: string;
  readonly setupSignalId: string;
  readonly strength: ForeshadowStrength | null;
  readonly note: string | null;
  readonly evidenceAnchorIds: readonly [string, ...string[]];
  readonly existing:
    | { readonly status: "absent" }
    | { readonly status: "same"; readonly setupRef: string }
    | {
        readonly status: "same-scene-different-anchor";
        readonly setupRefs: readonly string[];
      };
}

export type PlaceForeshadowSetupProposal = ProposalBase<
  typeof PLACE_FORESHADOW_SETUP_PROPOSAL_KIND,
  { readonly kind: "foreshadow-setup"; readonly logicalRef: string },
  PlaceForeshadowSetupProposalPayload
>;

export const PLACE_FORESHADOW_PAYOFF_PROPOSAL_KIND =
  "foreshadow.payoff.place" as const;

export interface PlaceForeshadowPayoffProposalPayload {
  readonly threadHypothesisId: ForeshadowThreadId;
  readonly documentRef: string;
  readonly payoffSignalId: string;
  readonly note: string | null;
  readonly evidenceAnchorIds: readonly [string, ...string[]];
  readonly existing:
    | { readonly status: "absent" }
    | { readonly status: "same"; readonly payoffRef: string }
    | { readonly status: "confirmed" };
}

export type PlaceForeshadowPayoffProposal = ProposalBase<
  typeof PLACE_FORESHADOW_PAYOFF_PROPOSAL_KIND,
  { readonly kind: "foreshadow-payoff"; readonly logicalRef: string },
  PlaceForeshadowPayoffProposalPayload
>;

export const LINK_SETUP_PAYOFF_EDGE_PROPOSAL_KIND =
  "foreshadow.edge.link" as const;

export interface LinkSetupPayoffEdgeProposalPayload {
  readonly threadHypothesisId: ForeshadowThreadId;
  readonly edgeInferenceId: string;
  readonly setupSignalId: string;
  readonly payoffSignalId: string;
  readonly bridgeKind: SetupPayoffBridgeKind;
  readonly evidenceAnchorIds: readonly [string, ...string[]];
}

export type LinkSetupPayoffEdgeProposal = ProposalBase<
  typeof LINK_SETUP_PAYOFF_EDGE_PROPOSAL_KIND,
  { readonly kind: "foreshadow-edge"; readonly logicalRef: string },
  LinkSetupPayoffEdgeProposalPayload
>;

export const LINK_FORESHADOW_CODEX_PROPOSAL_KIND =
  "foreshadow.codex.link" as const;

export interface LinkForeshadowCodexProposalPayload {
  readonly threadHypothesisId: ForeshadowThreadId;
  readonly entityRef: string;
  readonly linkRole: "subject" | "object" | "motif" | "other";
  readonly existing:
    | { readonly status: "absent" }
    | { readonly status: "linked"; readonly linkRef: string };
}

export type LinkForeshadowCodexProposal = ProposalBase<
  typeof LINK_FORESHADOW_CODEX_PROPOSAL_KIND,
  { readonly kind: "foreshadow-codex-link"; readonly logicalRef: string },
  LinkForeshadowCodexProposalPayload
>;

export const FORESHADOW_QUALITY_REPORT_PROPOSAL_KIND =
  "foreshadow.quality.report" as const;

export interface ForeshadowQualityReportProposalPayload {
  readonly threadHypothesisId: ForeshadowThreadId;
  readonly lifecycle:
    | "planned"
    | "seeded"
    | "paid"
    | "orphan-payoff"
    | "abandoned";
  readonly qualityIssue: "too-subtle" | "needs-strengthening" | "none";
  readonly anyWeak: boolean;
  readonly setupCount: number;
  readonly payoffConfirmed: boolean;
  readonly notes: string | null;
}

export type ForeshadowQualityReportProposal = ProposalBase<
  typeof FORESHADOW_QUALITY_REPORT_PROPOSAL_KIND,
  { readonly kind: "foreshadow-quality"; readonly logicalRef: string },
  ForeshadowQualityReportProposalPayload
>;
