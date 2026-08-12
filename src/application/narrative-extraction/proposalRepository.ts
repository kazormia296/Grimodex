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
import type {
  EvidenceSetEntry,
  ReconciliationEnvelopeV1,
} from "@/features/narrative-extraction/reconciler/types";

export async function buildNativeReconciliationEnvelope(input: {
  readonly runId: string;
  readonly taskId: string;
  readonly sourceRevisionToken: string;
  readonly proposalSchemaId: string;
  readonly proposalSchemaVersion?: string;
  readonly evidenceSet: readonly EvidenceSetEntry[];
  readonly reconcilerId?: string;
  readonly reconcilerVersion?: string;
  readonly changeKind?: ReconciliationEnvelopeV1["changeKind"];
}): Promise<ReconciliationEnvelopeV1> {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.sourceRevisionToken)) {
    throw new Error(
      "Cannot persist an enveloped proposal without an immutable source revision token",
    );
  }
  if (input.evidenceSet.length === 0) {
    throw new Error(
      `Cannot persist ${input.proposalSchemaId} without proposal evidence`,
    );
  }
  const evidenceRefs = new Set<string>();
  for (const evidence of input.evidenceSet) {
    if (
      !evidence.evidenceRef.trim() ||
      !evidence.documentRef?.trim() ||
      evidenceRefs.has(evidence.evidenceRef)
    ) {
      throw new Error(
        `Invalid or duplicate proposal evidence ref for ${input.proposalSchemaId}`,
      );
    }
    evidenceRefs.add(evidence.evidenceRef);
  }
  const sourceKey = `snapshot:${input.runId}`;
  if (evidenceRefs.has(sourceKey)) {
    throw new Error(
      `Proposal evidence ref collides with source snapshot for ${input.proposalSchemaId}`,
    );
  }
  const readSet = [
    { inputRef: sourceKey, kind: "snapshot-document" as const },
    ...input.evidenceSet.map((evidence) => ({
      inputRef: evidence.evidenceRef,
      kind: "evidence" as const,
    })),
  ];
  return {
    schemaVersion: 1,
    runId: input.runId,
    taskId: input.taskId,
    reconcilerId: input.reconcilerId ?? "grimodex.extraction",
    reconcilerVersion: input.reconcilerVersion ?? "1",
    proposalSchemaId: input.proposalSchemaId,
    proposalSchemaVersion: input.proposalSchemaVersion ?? "1",
    sourceBasis: [
      {
        sourceKind: "snapshot-document",
        sourceKey,
        revisionToken: input.sourceRevisionToken,
      },
    ],
    evidenceSet: input.evidenceSet,
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
  readonly evidenceById?: ReadonlyMap<
    string,
    {
      readonly documentRef: string;
      readonly quoteDigest?: EvidenceSetEntry["quoteDigest"];
    }
  >;
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
  const proposals: ProposalSeed[] = await Promise.all(
    input.proposals.map(async (proposal) => ({
      proposalKey: proposal.proposalKey,
      kind: CHRONICLE_EVENT_PROPOSAL_KIND,
      payloadJson: proposal.payload,
      reconciliationEnvelope: await buildNativeReconciliationEnvelope({
        runId: input.runId,
        taskId: input.taskId,
        sourceRevisionToken: input.sourceRevisionToken,
        proposalSchemaId: "narrative.chronicle-event.create",
        reconcilerId: "grimodex.chronicle-extraction",
        evidenceSet: proposal.payload.evidenceAnchorIds.map(
          (evidenceRef, index) => {
            const resolved = input.evidenceById?.get(evidenceRef);
            const evidence = {
              evidenceRef,
              documentRef:
                resolved?.documentRef ??
                proposal.payload.evidenceDocumentRefs[index] ??
                proposal.payload.evidenceDocumentRefs[0],
              ...(resolved?.quoteDigest
                ? { quoteDigest: resolved.quoteDigest }
                : {}),
            };
            return evidence;
          },
        ),
      }),
    })),
  );
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
