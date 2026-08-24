import type {
  AppendDecisionPayload,
  CreateHumanDerivedRevisionPayload,
  CreateHumanDerivedRevisionResult,
  AppendRevisionPayload,
  ProposalSeed,
  ReviseAndDecidePayload,
  SaveProposalSetPayload,
  SaveProposalSetResult,
} from "./nativeApi";
import {
  narrativeExtractionAppendDecision,
  narrativeExtractionAppendHumanDecision,
  narrativeExtractionAppendRevision,
  createHumanDerivedNarrativeRevisionV2,
  narrativeExtractionReviseAndDecide,
  narrativeExtractionReviseAndDecideAsHuman,
  narrativeExtractionSaveProposalSet,
} from "./nativeApi";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { CHRONICLE_EVENT_PROPOSAL_KIND } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  digestStableJson,
  sha256Digest,
} from "@/features/narrative-extraction/source/digest";
import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";
import type {
  EvidenceSetEntry,
  ReconciliationEnvelopeV1,
  ReconciliationEnvelopeV2,
  ReadSetEntry,
  SourceBasis,
} from "@/features/narrative-extraction/reconciler/types";

export function buildSnapshotSourceBasis(
  runId: string,
  snapshot: NarrativeCorpusSnapshot,
): SourceBasis {
  const sources = new Map<string, SourceBasis[number]>();
  sources.set(`snapshot:${runId}`, {
    sourceKind: "snapshot-document",
    sourceKey: `snapshot:${runId}`,
    revisionToken: snapshot.digest,
  });
  for (const document of snapshot.documents) {
    if (document.origin.kind !== "project-node") continue;
    const sourceKey = `project:scene:${document.origin.nodeId}`;
    sources.set(sourceKey, {
      sourceKind: "scene-body",
      sourceKey,
      revisionToken: `v${document.origin.sourceVersion}@${document.origin.sourceUpdatedAt}`,
    });
  }
  return [...sources.values()];
}

export async function buildNativeReconciliationEnvelope(input: {
  readonly runId: string;
  readonly taskId: string;
  /** Legacy single-snapshot input; new callers should provide sourceBasis. */
  readonly sourceRevisionToken?: string;
  readonly sourceBasis?: SourceBasis;
  readonly proposalSchemaId: string;
  readonly proposalSchemaVersion?: string;
  readonly evidenceSet: readonly EvidenceSetEntry[];
  readonly reconcilerId?: string;
  readonly reconcilerVersion?: string;
  readonly changeKind?: ReconciliationEnvelopeV1["changeKind"];
}): Promise<ReconciliationEnvelopeV1> {
  if (
    !input.sourceBasis?.length &&
    !/^sha256:[0-9a-f]{64}$/.test(input.sourceRevisionToken ?? "")
  ) {
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
      !evidence.quote?.trim() ||
      evidenceRefs.has(evidence.evidenceRef)
    ) {
      throw new Error(
        `Invalid or duplicate proposal evidence ref for ${input.proposalSchemaId}`,
      );
    }
    evidenceRefs.add(evidence.evidenceRef);
  }
  const sourceBasis: SourceBasis = input.sourceBasis?.length
    ? input.sourceBasis.map((source) => ({ ...source }))
    : [
        {
          sourceKind: "snapshot-document",
          sourceKey: `snapshot:${input.runId}`,
          revisionToken: input.sourceRevisionToken!,
        },
      ];
  const readKindForSourceKind = (sourceKind: string): ReadSetEntry["kind"] => {
    if (sourceKind === "projection" || sourceKind === "domain-projection") {
      return "projection";
    }
    if (
      sourceKind === "evidence" ||
      sourceKind === "evidence-anchor" ||
      sourceKind === "narrative-artifact" ||
      sourceKind === "import-capture"
    ) {
      return "evidence";
    }
    if (sourceKind === "signal") return "signal";
    if (sourceKind === "codex-catalog") return "projection";
    return "snapshot-document";
  };
  const readSetByRef = new Map<string, ReadSetEntry>();
  for (const source of sourceBasis) {
    if (readSetByRef.has(source.sourceKey)) {
      throw new Error(
        `Duplicate source key in ${input.proposalSchemaId}: ${source.sourceKey}`,
      );
    }
    readSetByRef.set(source.sourceKey, {
      inputRef: source.sourceKey,
      kind: readKindForSourceKind(source.sourceKind),
      sourceKind: source.sourceKind,
      revisionToken: source.revisionToken,
    });
  }
  const snapshotKey = `snapshot:${input.runId}`;
  if (evidenceRefs.has(snapshotKey)) {
    throw new Error(
      `Proposal evidence ref collides with source snapshot for ${input.proposalSchemaId}`,
    );
  }
  const evidenceSet = await Promise.all(
    input.evidenceSet.map(async (evidence) => {
      const sourceKey =
        evidence.sourceKey ?? `evidence:${evidence.evidenceRef}`;
      const revisionToken = evidence.revisionToken ?? input.sourceRevisionToken;
      if (!revisionToken) {
        throw new Error(
          `Missing current evidence revision token for ${input.proposalSchemaId}: ${evidence.evidenceRef}`,
        );
      }
      if (!readSetByRef.has(sourceKey)) {
        readSetByRef.set(sourceKey, {
          inputRef: sourceKey,
          kind: "evidence",
          sourceKind: "evidence-anchor",
          revisionToken,
        });
      }
      const quoteDigest = await sha256Digest(evidence.quote!);
      if (evidence.quoteDigest && evidence.quoteDigest !== quoteDigest) {
        throw new Error(
          `Evidence quote digest mismatch for ${input.proposalSchemaId}: ${evidence.evidenceRef}`,
        );
      }
      return {
        ...evidence,
        quote: evidence.quote,
        quoteDigest,
        sourceKey,
        revisionToken,
      };
    }),
  );
  const readSet = [...readSetByRef.values()];
  return {
    schemaVersion: 1,
    runId: input.runId,
    taskId: input.taskId,
    reconcilerId: input.reconcilerId ?? "grimodex.extraction",
    reconcilerVersion: input.reconcilerVersion ?? "1",
    proposalSchemaId: input.proposalSchemaId,
    proposalSchemaVersion: input.proposalSchemaVersion ?? "1",
    sourceBasis,
    evidenceSet,
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
  readonly sourceBasis?: SourceBasis;
  readonly proposalSetId?: string;
  readonly summaryJson?: Readonly<Record<string, unknown>>;
  readonly evidenceById?: ReadonlyMap<
    string,
    {
      readonly documentRef: string;
      readonly quote: string;
      readonly quoteDigest?: EvidenceSetEntry["quoteDigest"];
      readonly sourceKey?: string;
      readonly revisionToken?: string;
    }
  >;
  readonly v2EnvelopeByProposalKey?: ReadonlyMap<string, ReconciliationEnvelopeV2<unknown>>;
  readonly stageProvenanceBundle?: Readonly<{
    readonly closure: unknown;
    readonly binding: unknown;
  }>;
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
      reconciliationEnvelope:
        input.v2EnvelopeByProposalKey?.get(proposal.proposalKey) ??
        (await buildNativeReconciliationEnvelope({
          runId: input.runId,
          taskId: input.taskId,
          sourceRevisionToken: input.sourceRevisionToken,
          sourceBasis: input.sourceBasis,
          proposalSchemaId: "narrative.chronicle-event.create",
          reconcilerId: "grimodex.chronicle-extraction",
          evidenceSet: proposal.payload.evidenceAnchorIds.map(
            (evidenceRef, index) => {
              const resolved = input.evidenceById?.get(evidenceRef);
              const documentRef =
                resolved?.documentRef ??
                proposal.payload.evidenceDocumentRefs[index] ??
                proposal.payload.evidenceDocumentRefs[0];
              if (!documentRef || !resolved?.quote) {
                throw new Error(
                  `Missing resolved evidence quote for chronicle proposal: ${evidenceRef}`,
                );
              }
              return {
                evidenceRef,
                documentRef,
                quote: resolved.quote,
                ...(resolved?.quoteDigest
                  ? { quoteDigest: resolved.quoteDigest }
                  : {}),
                ...(resolved?.sourceKey
                  ? { sourceKey: resolved.sourceKey }
                  : {}),
                ...(resolved?.revisionToken
                  ? { revisionToken: resolved.revisionToken }
                  : {}),
              };
            },
          ),
        })),
    })),
  );
  return saveProposalSet({
    runId: input.runId,
    projectId: input.projectId,
    proposalSetId: input.proposalSetId,
    setKind: "chronicle.extract.review@1",
    summaryJson: {
      ...(input.summaryJson ?? {}),
      proposalCount: proposals.length,
      ...(input.stageProvenanceBundle
        ? { stageProvenanceBundle: input.stageProvenanceBundle }
        : {}),
    },
    proposals,
  });
}

export async function createHumanDerivedRevision(
  payload: CreateHumanDerivedRevisionPayload,
): Promise<CreateHumanDerivedRevisionResult> {
  return createHumanDerivedNarrativeRevisionV2(payload);
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

export async function appendHumanDecision(
  payload: AppendDecisionPayload,
): Promise<Awaited<ReturnType<typeof narrativeExtractionAppendHumanDecision>>> {
  return narrativeExtractionAppendHumanDecision(payload);
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

export async function reviseAndDecideAsHuman(
  payload: ReviseAndDecidePayload,
): Promise<
  Awaited<ReturnType<typeof narrativeExtractionReviseAndDecideAsHuman>>
> {
  return narrativeExtractionReviseAndDecideAsHuman(payload);
}
