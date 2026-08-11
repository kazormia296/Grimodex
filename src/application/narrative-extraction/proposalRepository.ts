import type {
  AppendDecisionPayload,
  AppendRevisionPayload,
  ProposalSeed,
  ReviseAndDecidePayload,
  SaveProposalSetPayload,
  SaveProposalSetResult,
} from "./nativeApi";
import {
  narrativeExtractionAppendDecision,
  narrativeExtractionAppendRevision,
  narrativeExtractionReviseAndDecide,
  narrativeExtractionSaveProposalSet,
} from "./nativeApi";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { CHRONICLE_EVENT_PROPOSAL_KIND } from "@/features/narrative-extraction/proposals/chronicleEventProposal";

export interface SaveChronicleProposalSetInput {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalSetId?: string;
  readonly summaryJson?: Readonly<Record<string, unknown>>;
  readonly proposals: readonly {
    readonly proposalKey: string;
    readonly payload: CreateChronicleEventProposalPayloadV1;
  }[];
}

export async function saveProposalSet(
  payload: SaveProposalSetPayload,
): Promise<SaveProposalSetResult> {
  return narrativeExtractionSaveProposalSet(payload);
}

export async function saveChronicleProposalSet(
  input: SaveChronicleProposalSetInput,
): Promise<SaveProposalSetResult> {
  const proposals: ProposalSeed[] = input.proposals.map((proposal) => ({
    proposalKey: proposal.proposalKey,
    kind: CHRONICLE_EVENT_PROPOSAL_KIND,
    payloadJson: proposal.payload,
  }));
  return saveProposalSet({
    runId: input.runId,
    projectId: input.projectId,
    proposalSetId: input.proposalSetId,
    setKind: "chronicle.extract.review@1",
    summaryJson: input.summaryJson ?? {
      proposalCount: proposals.length,
    },
    proposals,
  });
}

export async function appendRevision(
  payload: AppendRevisionPayload,
): Promise<Awaited<ReturnType<typeof narrativeExtractionAppendRevision>>> {
  return narrativeExtractionAppendRevision(payload);
}

export async function appendDecision(
  payload: AppendDecisionPayload,
): Promise<Awaited<ReturnType<typeof narrativeExtractionAppendDecision>>> {
  return narrativeExtractionAppendDecision(payload);
}

/**
 * Atomic revision + decision in ONE Native transaction so an approve can never
 * persist a fresh revision without its decision (or vice versa).
 */
export async function reviseAndDecide(
  payload: ReviseAndDecidePayload,
): Promise<Awaited<ReturnType<typeof narrativeExtractionReviseAndDecide>>> {
  return narrativeExtractionReviseAndDecide(payload);
}
