import type { PlotThreadHypothesisPayload } from "@/features/narrative-extraction/ir/inferences/plotThreadHypothesis";
import {
  BIND_PLOT_THREAD_PROPOSAL_KIND,
  PLACE_PLOT_THREAD_MARKER_PROPOSAL_KIND,
  type BindPlotThreadProposal,
  type PlacePlotThreadMarkerProposal,
  type PlacePlotThreadMarkerProposalPayload,
} from "@/features/narrative-extraction/proposals/bindPlotThreadProposal";
import { meetsNewThreadMinimum } from "./markerRoleAssigner";

export interface PlannedPlotThreadProposal {
  readonly threadProposal: BindPlotThreadProposal;
  readonly markerProposals: readonly PlacePlotThreadMarkerProposal[];
  readonly hypothesisId: PlotThreadHypothesisPayload["threadId"];
  /** True when the create-new gate rejected an unresolved hypothesis. */
  readonly blocked: boolean;
  readonly blockedReason?: string;
}

export interface PlanPlotThreadProposalsInput {
  readonly hypotheses: readonly PlotThreadHypothesisPayload[];
  /**
   * Resolves whether a candidate marker is already present on the bound
   * thread (existing DB state); absent by default (new thread / unknown).
   */
  readonly resolveExistingMarker?: (
    hypothesis: PlotThreadHypothesisPayload,
    candidate: PlotThreadHypothesisPayload["markerCandidates"][number],
  ) => PlacePlotThreadMarkerProposalPayload["existing"];
  readonly createId?: () => string;
}

function hasCoreConcern(hypothesis: PlotThreadHypothesisPayload): boolean {
  // PlotThreadCore is always structurally present once a hypothesis is
  // synthesized; the concrete concern text differs per core kind.
  return Boolean(hypothesis.core);
}

function countExactEvidenceSites(
  hypothesis: PlotThreadHypothesisPayload,
): number {
  const anchors = new Set<string>();
  for (const marker of hypothesis.markerCandidates) {
    for (const anchorId of marker.evidenceAnchorIds) anchors.add(anchorId);
  }
  return anchors.size;
}

function distinctDocumentRefs(
  hypothesis: PlotThreadHypothesisPayload,
): readonly string[] {
  return [...new Set(hypothesis.markerCandidates.map((m) => m.documentRef))];
}

function buildMarkerProposals(
  hypothesis: PlotThreadHypothesisPayload,
  createId: () => string,
  resolveExistingMarker: PlanPlotThreadProposalsInput["resolveExistingMarker"],
): PlacePlotThreadMarkerProposal[] {
  return hypothesis.markerCandidates.map((candidate) => ({
    proposalId: createId(),
    kind: PLACE_PLOT_THREAD_MARKER_PROPOSAL_KIND,
    target: {
      kind: "plot-marker" as const,
      logicalRef: `${hypothesis.threadId}::${candidate.documentRef}`,
    },
    payload: {
      threadHypothesisId: hypothesis.threadId,
      documentRef: candidate.documentRef,
      phaseType: candidate.primaryPhase,
      note: candidate.noteSuggestion,
      developmentInferenceIds: candidate.developmentInferenceIds,
      evidenceAnchorIds: candidate.evidenceAnchorIds,
      existing: resolveExistingMarker?.(hypothesis, candidate) ?? {
        status: "absent",
      },
    },
    dependencies: [],
  }));
}

/**
 * Gate Plot Thread Hypotheses into BindPlotThreadProposal +
 * PlacePlotThreadMarkerProposal rows.
 *
 * - existingResolution="resolved" → bind-existing (never blocked; existing
 *   thread's own type/state is not re-gated here).
 * - existingResolution="ambiguous" → unresolved binding, blocked until the
 *   user disambiguates (candidates are still surfaced for review).
 * - existingResolution="none" → create-new only when meetsNewThreadMinimum
 *   accepts the cluster (reused, unmodified gate); otherwise the hypothesis
 *   is dropped entirely (not enough evidence to justify a new thread row).
 */
export function planPlotThreadProposals(
  input: PlanPlotThreadProposalsInput,
): readonly PlannedPlotThreadProposal[] {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const planned: PlannedPlotThreadProposal[] = [];

  for (const hypothesis of input.hypotheses) {
    const existing = hypothesis.existingResolution;

    if (existing.status === "resolved") {
      planned.push({
        hypothesisId: hypothesis.threadId,
        blocked: false,
        threadProposal: {
          proposalId: createId(),
          kind: BIND_PLOT_THREAD_PROPOSAL_KIND,
          target: { kind: "plot-thread", logicalRef: hypothesis.threadId },
          payload: {
            threadHypothesisId: hypothesis.threadId,
            binding: { kind: "bind-existing", threadRef: existing.ref },
            name: hypothesis.nameSuggestion,
            description: hypothesis.descriptionSuggestion.trim()
              ? {
                  kind: "fill-if-empty",
                  value: hypothesis.descriptionSuggestion,
                }
              : { kind: "leave" },
            prominence: hypothesis.prominence,
            core: hypothesis.core,
          },
          dependencies: [],
        },
        markerProposals: buildMarkerProposals(
          hypothesis,
          createId,
          input.resolveExistingMarker,
        ),
      });
      continue;
    }

    if (existing.status === "ambiguous") {
      planned.push({
        hypothesisId: hypothesis.threadId,
        blocked: true,
        blockedReason:
          "既存プロットスレッド候補が複数あり、Binding が未解決です",
        threadProposal: {
          proposalId: createId(),
          kind: BIND_PLOT_THREAD_PROPOSAL_KIND,
          target: { kind: "plot-thread", logicalRef: hypothesis.threadId },
          payload: {
            threadHypothesisId: hypothesis.threadId,
            binding: {
              kind: "unresolved",
              candidateThreadRefs: existing.candidates.map((c) => c.ref),
            },
            name: hypothesis.nameSuggestion,
            description: hypothesis.descriptionSuggestion.trim()
              ? {
                  kind: "set-on-create",
                  value: hypothesis.descriptionSuggestion,
                }
              : { kind: "leave" },
            prominence: hypothesis.prominence,
            core: hypothesis.core,
          },
          dependencies: [],
        },
        markerProposals: [],
      });
      continue;
    }

    // existing.status === "none"
    const eligible = meetsNewThreadMinimum({
      materialDevelopmentCount: hypothesis.developmentInferenceIds.length,
      distinctSceneCount: distinctDocumentRefs(hypothesis).length,
      hasCoreConcern: hasCoreConcern(hypothesis),
      exactEvidenceSites: countExactEvidenceSites(hypothesis),
    });
    if (!eligible) continue;

    planned.push({
      hypothesisId: hypothesis.threadId,
      blocked: false,
      threadProposal: {
        proposalId: createId(),
        kind: BIND_PLOT_THREAD_PROPOSAL_KIND,
        target: { kind: "plot-thread", logicalRef: hypothesis.threadId },
        payload: {
          threadHypothesisId: hypothesis.threadId,
          binding: { kind: "create-new" },
          name: hypothesis.nameSuggestion,
          description: {
            kind: "set-on-create",
            value: hypothesis.descriptionSuggestion,
          },
          prominence: hypothesis.prominence,
          core: hypothesis.core,
        },
        dependencies: [],
      },
      markerProposals: buildMarkerProposals(
        hypothesis,
        createId,
        input.resolveExistingMarker,
      ),
    });
  }

  return planned;
}
