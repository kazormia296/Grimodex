import type { ForeshadowThreadHypothesisPayload } from "@/features/narrative-extraction/ir/inferences/foreshadowThreadHypothesis";
import {
  BIND_FORESHADOW_THREAD_PROPOSAL_KIND,
  FORESHADOW_QUALITY_REPORT_PROPOSAL_KIND,
  LINK_FORESHADOW_CODEX_PROPOSAL_KIND,
  LINK_SETUP_PAYOFF_EDGE_PROPOSAL_KIND,
  PLACE_FORESHADOW_PAYOFF_PROPOSAL_KIND,
  PLACE_FORESHADOW_SETUP_PROPOSAL_KIND,
  type BindForeshadowThreadProposal,
  type ForeshadowQualityReportProposal,
  type LinkForeshadowCodexProposal,
  type LinkSetupPayoffEdgeProposal,
  type PlaceForeshadowPayoffProposal,
  type PlaceForeshadowSetupProposal,
  type PlaceForeshadowSetupProposalPayload,
} from "@/features/narrative-extraction/proposals/bindForeshadowThreadProposal";
import { meetsNewForeshadowMinimum } from "./foreshadowSignals";
import {
  deriveForeshadowLifecycle,
  deriveForeshadowQuality,
} from "./lifecycle";
import { distinctDocumentRefs } from "./existingForeshadowMatcher";

export interface PlannedForeshadowProposal {
  readonly threadProposal: BindForeshadowThreadProposal;
  readonly setupProposals: readonly PlaceForeshadowSetupProposal[];
  readonly payoffProposals: readonly PlaceForeshadowPayoffProposal[];
  readonly edgeProposals: readonly LinkSetupPayoffEdgeProposal[];
  readonly codexLinkProposals: readonly LinkForeshadowCodexProposal[];
  readonly qualityReport: ForeshadowQualityReportProposal;
  readonly hypothesisId: ForeshadowThreadHypothesisPayload["threadId"];
  readonly blocked: boolean;
  readonly blockedReason?: string;
}

export interface PlanForeshadowProposalsInput {
  readonly hypotheses: readonly ForeshadowThreadHypothesisPayload[];
  readonly resolveExistingSetup?: (
    hypothesis: ForeshadowThreadHypothesisPayload,
    candidate: ForeshadowThreadHypothesisPayload["setupMarkerCandidates"][number],
  ) => PlaceForeshadowSetupProposalPayload["existing"];
  readonly createId?: () => string;
}

function buildSetupProposals(
  hypothesis: ForeshadowThreadHypothesisPayload,
  createId: () => string,
  resolveExistingSetup: PlanForeshadowProposalsInput["resolveExistingSetup"],
): PlaceForeshadowSetupProposal[] {
  return hypothesis.setupMarkerCandidates.map((candidate) => ({
    proposalId: createId(),
    kind: PLACE_FORESHADOW_SETUP_PROPOSAL_KIND,
    target: {
      kind: "foreshadow-setup" as const,
      logicalRef: `${hypothesis.threadId}::setup::${candidate.documentRef}`,
    },
    payload: {
      threadHypothesisId: hypothesis.threadId,
      documentRef: candidate.documentRef,
      setupSignalId: candidate.setupSignalId,
      strength: null,
      note: candidate.noteSuggestion,
      evidenceAnchorIds: candidate.evidenceAnchorIds,
      existing: resolveExistingSetup?.(hypothesis, candidate) ?? {
        status: "absent",
      },
    },
    dependencies: [],
  }));
}

function buildPayoffProposals(
  hypothesis: ForeshadowThreadHypothesisPayload,
  createId: () => string,
): PlaceForeshadowPayoffProposal[] {
  return hypothesis.payoffMarkerCandidates.map((candidate) => ({
    proposalId: createId(),
    kind: PLACE_FORESHADOW_PAYOFF_PROPOSAL_KIND,
    target: {
      kind: "foreshadow-payoff" as const,
      logicalRef: `${hypothesis.threadId}::payoff::${candidate.documentRef}`,
    },
    payload: {
      threadHypothesisId: hypothesis.threadId,
      documentRef: candidate.documentRef,
      payoffSignalId: candidate.payoffSignalId,
      note: candidate.noteSuggestion,
      evidenceAnchorIds: candidate.evidenceAnchorIds,
      existing: { status: "absent" },
    },
    dependencies: [],
  }));
}

function buildEdgeProposals(
  hypothesis: ForeshadowThreadHypothesisPayload,
  createId: () => string,
): LinkSetupPayoffEdgeProposal[] {
  if (hypothesis.edgeInferenceIds.length === 0) return [];
  const setupId = hypothesis.setupSignalIds[0];
  const payoffId = hypothesis.payoffSignalIds[0];
  if (!setupId || !payoffId) return [];
  return [
    {
      proposalId: createId(),
      kind: LINK_SETUP_PAYOFF_EDGE_PROPOSAL_KIND,
      target: {
        kind: "foreshadow-edge" as const,
        logicalRef: `${hypothesis.threadId}::edge`,
      },
      payload: {
        threadHypothesisId: hypothesis.threadId,
        edgeInferenceId: hypothesis.edgeInferenceIds[0]!,
        setupSignalId: setupId,
        payoffSignalId: payoffId,
        bridgeKind: hypothesis.core.bridgeKind,
        evidenceAnchorIds: hypothesis.setupMarkerCandidates[0]
          ?.evidenceAnchorIds ?? ["ev:stub"],
      },
      dependencies: [],
    },
  ];
}

function buildQualityReport(
  hypothesis: ForeshadowThreadHypothesisPayload,
  createId: () => string,
  anyWeak: boolean,
): ForeshadowQualityReportProposal {
  const setupCount = hypothesis.setupMarkerCandidates.length;
  const payoffConfirmed = hypothesis.lifecycle === "paid";
  const lifecycle = deriveForeshadowLifecycle({
    abandoned: hypothesis.lifecycle === "abandoned",
    setupCount,
    payoffConfirmed,
  });
  const quality = deriveForeshadowQuality({
    anyWeak,
    loadBearing: hypothesis.loadBearingSuggestion,
    lifecycle,
  });
  return {
    proposalId: createId(),
    kind: FORESHADOW_QUALITY_REPORT_PROPOSAL_KIND,
    target: {
      kind: "foreshadow-quality" as const,
      logicalRef: `${hypothesis.threadId}::quality`,
    },
    payload: {
      threadHypothesisId: hypothesis.threadId,
      lifecycle,
      qualityIssue: quality.qualityIssue,
      anyWeak,
      setupCount,
      payoffConfirmed,
      notes: quality.notes,
    },
    dependencies: [],
  };
}

/**
 * Gate ForeshadowThreadHypothesis rows into bind / place / link proposals.
 */
export function planForeshadowProposals(
  input: PlanForeshadowProposalsInput,
): readonly PlannedForeshadowProposal[] {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const planned: PlannedForeshadowProposal[] = [];

  for (const hypothesis of input.hypotheses) {
    const existing = hypothesis.existingResolution;
    const setupProposals = buildSetupProposals(
      hypothesis,
      createId,
      input.resolveExistingSetup,
    );
    const payoffProposals = buildPayoffProposals(hypothesis, createId);
    const edgeProposals = buildEdgeProposals(hypothesis, createId);
    const qualityReport = buildQualityReport(hypothesis, createId, false);

    if (existing.status === "already-satisfied") {
      planned.push({
        hypothesisId: hypothesis.threadId,
        blocked: true,
        blockedReason: "既存伏線が setup/payoff を満たしています",
        threadProposal: {
          proposalId: createId(),
          kind: BIND_FORESHADOW_THREAD_PROPOSAL_KIND,
          target: {
            kind: "foreshadow-thread",
            logicalRef: hypothesis.threadId,
          },
          payload: {
            threadHypothesisId: hypothesis.threadId,
            binding: {
              kind: "already-satisfied",
              foreshadowRef: existing.ref,
            },
            title: hypothesis.titleSuggestion,
            intent: hypothesis.intentSuggestion.trim()
              ? { kind: "leave" }
              : { kind: "leave" },
            loadBearing: hypothesis.loadBearingSuggestion,
            core: hypothesis.core,
          },
          dependencies: [],
        },
        setupProposals: [],
        payoffProposals: [],
        edgeProposals: [],
        codexLinkProposals: [],
        qualityReport,
      });
      continue;
    }

    if (existing.status === "resolved") {
      planned.push({
        hypothesisId: hypothesis.threadId,
        blocked: false,
        threadProposal: {
          proposalId: createId(),
          kind: BIND_FORESHADOW_THREAD_PROPOSAL_KIND,
          target: {
            kind: "foreshadow-thread",
            logicalRef: hypothesis.threadId,
          },
          payload: {
            threadHypothesisId: hypothesis.threadId,
            binding: {
              kind: "bind-existing",
              foreshadowRef: existing.ref,
            },
            title: hypothesis.titleSuggestion,
            intent: hypothesis.intentSuggestion.trim()
              ? {
                  kind: "fill-if-empty",
                  value: hypothesis.intentSuggestion,
                }
              : { kind: "leave" },
            loadBearing: hypothesis.loadBearingSuggestion,
            core: hypothesis.core,
          },
          dependencies: [],
        },
        setupProposals,
        payoffProposals,
        edgeProposals,
        codexLinkProposals: hypothesis.participantEntityIds.map((entityId) => ({
          proposalId: createId(),
          kind: LINK_FORESHADOW_CODEX_PROPOSAL_KIND,
          target: {
            kind: "foreshadow-codex-link" as const,
            logicalRef: `${hypothesis.threadId}::codex::${entityId}`,
          },
          payload: {
            threadHypothesisId: hypothesis.threadId,
            entityRef: entityId,
            linkRole: "subject",
            existing: { status: "absent" },
          },
          dependencies: [],
        })),
        qualityReport,
      });
      continue;
    }

    if (existing.status === "ambiguous") {
      planned.push({
        hypothesisId: hypothesis.threadId,
        blocked: true,
        blockedReason: "既存伏線候補が複数あり、Binding が未解決です",
        threadProposal: {
          proposalId: createId(),
          kind: BIND_FORESHADOW_THREAD_PROPOSAL_KIND,
          target: {
            kind: "foreshadow-thread",
            logicalRef: hypothesis.threadId,
          },
          payload: {
            threadHypothesisId: hypothesis.threadId,
            binding: {
              kind: "unresolved",
              candidateForeshadowRefs: existing.candidates.map((c) => c.ref),
            },
            title: hypothesis.titleSuggestion,
            intent: hypothesis.intentSuggestion.trim()
              ? {
                  kind: "set-on-create",
                  value: hypothesis.intentSuggestion,
                }
              : { kind: "leave" },
            loadBearing: hypothesis.loadBearingSuggestion,
            core: hypothesis.core,
          },
          dependencies: [],
        },
        setupProposals: [],
        payoffProposals: [],
        edgeProposals: [],
        codexLinkProposals: [],
        qualityReport,
      });
      continue;
    }

    const eligible = meetsNewForeshadowMinimum({
      setupSignalCount: hypothesis.setupSignalIds.length,
      payoffSignalCount: hypothesis.payoffSignalIds.length,
      distinctSceneCount: distinctDocumentRefs(hypothesis).length,
      edgeCount: hypothesis.edgeInferenceIds.length,
      hasCoreConcern: Boolean(hypothesis.core.unifyingConcern.trim()),
    });
    if (!eligible) continue;

    planned.push({
      hypothesisId: hypothesis.threadId,
      blocked: false,
      threadProposal: {
        proposalId: createId(),
        kind: BIND_FORESHADOW_THREAD_PROPOSAL_KIND,
        target: {
          kind: "foreshadow-thread",
          logicalRef: hypothesis.threadId,
        },
        payload: {
          threadHypothesisId: hypothesis.threadId,
          binding: { kind: "create-new" },
          title: hypothesis.titleSuggestion,
          intent: {
            kind: "set-on-create",
            value: hypothesis.intentSuggestion,
          },
          loadBearing: hypothesis.loadBearingSuggestion,
          core: hypothesis.core,
        },
        dependencies: [],
      },
      setupProposals,
      payoffProposals,
      edgeProposals,
      codexLinkProposals: hypothesis.participantEntityIds.map((entityId) => ({
        proposalId: createId(),
        kind: LINK_FORESHADOW_CODEX_PROPOSAL_KIND,
        target: {
          kind: "foreshadow-codex-link" as const,
          logicalRef: `${hypothesis.threadId}::codex::${entityId}`,
        },
        payload: {
          threadHypothesisId: hypothesis.threadId,
          entityRef: entityId,
          linkRole: "subject",
          existing: { status: "absent" },
        },
        dependencies: [],
      })),
      qualityReport,
    });
  }

  return planned;
}
