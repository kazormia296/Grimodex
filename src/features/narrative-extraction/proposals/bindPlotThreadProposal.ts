import type { PlotPhaseType } from "@/db/schema";
import type { ProposalBase } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type {
  PlotThreadCore,
  PlotThreadId,
} from "@/features/narrative-extraction/ir/inferences/plotThreadHypothesis";

export const BIND_PLOT_THREAD_PROPOSAL_KIND = "plot.thread.bind" as const;

export interface BindPlotThreadProposalPayload {
  readonly threadHypothesisId: PlotThreadId;
  readonly binding:
    | { readonly kind: "create-new" }
    | { readonly kind: "bind-existing"; readonly threadRef: `PT${string}` }
    | {
        readonly kind: "unresolved";
        readonly candidateThreadRefs: readonly `PT${string}`[];
      };
  readonly name: string;
  readonly description:
    | { readonly kind: "set-on-create"; readonly value: string }
    | { readonly kind: "fill-if-empty"; readonly value: string }
    | { readonly kind: "leave" };
  readonly prominence: "primary" | "supporting" | "minor";
  readonly core: PlotThreadCore;
}

export type BindPlotThreadProposal = ProposalBase<
  typeof BIND_PLOT_THREAD_PROPOSAL_KIND,
  { readonly kind: "plot-thread"; readonly logicalRef: string },
  BindPlotThreadProposalPayload
>;

export const PLACE_PLOT_THREAD_MARKER_PROPOSAL_KIND =
  "plot.marker.place" as const;

export interface PlacePlotThreadMarkerProposalPayload {
  readonly threadHypothesisId: PlotThreadId;
  readonly documentRef: string;
  readonly phaseType: PlotPhaseType;
  readonly note: string | null;
  readonly developmentInferenceIds: readonly [string, ...string[]];
  readonly evidenceAnchorIds: readonly [string, ...string[]];
  readonly existing:
    | { readonly status: "absent" }
    | { readonly status: "same"; readonly markerRef: string }
    | {
        readonly status: "same-scene-different-phase";
        readonly markerRefs: readonly string[];
      };
}

export type PlacePlotThreadMarkerProposal = ProposalBase<
  typeof PLACE_PLOT_THREAD_MARKER_PROPOSAL_KIND,
  { readonly kind: "plot-marker"; readonly logicalRef: string },
  PlacePlotThreadMarkerProposalPayload
>;

export const CREATE_PLOT_THREAD_BRANCH_PROPOSAL_KIND =
  "plot.branch.create" as const;

export interface CreatePlotThreadBranchProposalPayload {
  readonly fromThreadHypothesisId: PlotThreadId;
  readonly toThreadHypothesisId: PlotThreadId;
  readonly atDocumentRef: string;
  readonly kind: "branch" | "merge";
  readonly evidenceAnchorIds: readonly [string, ...string[]];
  readonly relationInferenceId: string;
}

export type CreatePlotThreadBranchProposal = ProposalBase<
  typeof CREATE_PLOT_THREAD_BRANCH_PROPOSAL_KIND,
  { readonly kind: "plot-branch"; readonly logicalRef: string },
  CreatePlotThreadBranchProposalPayload
>;
