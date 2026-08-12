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
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import type { ReconciliationEnvelopeV1 } from "@/features/narrative-extraction/reconciler/types";

export async function buildNativeReconciliationEnvelope(input: {
  readonly runId: string;
  readonly taskId: string;
  readonly sourceRevisionToken: string;
  readonly changeKind?: ReconciliationEnvelopeV1["changeKind"];
}): Promise<ReconciliationEnvelopeV1> {
  const sourceKey = `snapshot:${input.runId}`;
  const readSet = [
    { inputRef: sourceKey, kind: "snapshot-document" as const },
  ];
  return {
    schemaVersion: 1,
    runId: input.runId,
    taskId: input.taskId,
    reconcilerId: "grimodex.extraction",
    reconcilerVersion: "1",
    proposalSchemaId: "narrative.proposal",
    proposalSchemaVersion: "1",
    sourceBasis: [
      {
        sourceKind: "snapshot-document",
        sourceKey,
        revisionToken: input.sourceRevisionToken,
      },
    ],
    evidenceSet: [],
    readSet,
    readSetDigest: await digestStableJson(readSet),
    changeKind: input.changeKind ?? "add",
  };
}

export interface SaveChronicleProposalSetInput {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sourceRevisionToken: string;
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
  const reconciliationEnvelope = await buildNativeReconciliationEnvelope({
    runId: input.runId,
    taskId: input.taskId,
    sourceRevisionToken: input.sourceRevisionToken,
  });
  const proposals: ProposalSeed[] = input.proposals.map((proposal) => ({
    proposalKey: proposal.proposalKey,
    kind: CHRONICLE_EVENT_PROPOSAL_KIND,
    payloadJson: proposal.payload,
    reconciliationEnvelope,
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
