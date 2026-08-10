import {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_SURFACE_PATH,
  runChronicleExtractionCoordinator,
  type ChronicleExtractionRequest,
} from "@/application/narrative-extraction/extractionCoordinator";
import { loadInlineJsonArtifact } from "@/application/narrative-extraction/artifactRepository";
import {
  getRun,
  listResumableRuns,
} from "@/application/narrative-extraction/runRepository";
import {
  appendDecision,
  appendRevision,
} from "@/application/narrative-extraction/proposalRepository";
import {
  applyChronicleCommit,
  prepareChronicleCommit,
} from "@/application/narrative-extraction/commitCoordinator";
import { compileCreateChronicleEventOperation } from "./extraction/compiler";
import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import type { ChronicleExistingMatch } from "./extraction/existingEventMatcher";
import {
  buildProposalSafetyFlags,
  emptyTaskCounts,
  useChronicleExtractionStore,
  type ChronicleExtractionCoverage,
  type ChronicleExtractionReviewProjection,
  type ChronicleReviewEvidenceQuote,
  type ChronicleReviewProposal,
  type StartChronicleExtractionRequest,
} from "./chronicleExtractionStore";

export type { StartChronicleExtractionRequest };

interface PlannedProposalArtifactRow {
  readonly proposal: CreateChronicleEventProposalPayloadV1;
  readonly match: ChronicleExistingMatch;
  readonly hypothesisId: string;
}

interface ProposalPlanArtifactPayload {
  readonly proposals: readonly CreateChronicleEventProposalPayloadV1[];
  readonly planned?: readonly PlannedProposalArtifactRow[];
  readonly alreadySatisfied?: readonly {
    readonly hypothesisId: string;
    readonly title: string;
    readonly existingRef: string;
  }[];
  readonly proposalSetId?: string;
}

interface ResolvedEvidenceArtifactPayload {
  readonly anchors: readonly ResolvedEvidenceAnchor[];
}

interface SnapshotArtifactPayload {
  readonly snapshot: NarrativeCorpusSnapshot;
}

const proposalSetIdByRunId = new Map<string, string>();

function rememberProposalSetId(runId: string, proposalSetId: string): void {
  proposalSetIdByRunId.set(runId, proposalSetId);
}

function resolveProposalSetId(
  runId: string,
  artifactId?: string | null,
): string | null {
  return artifactId ?? proposalSetIdByRunId.get(runId) ?? null;
}

function sceneIdFromDocumentRef(
  snapshot: NarrativeCorpusSnapshot | null,
  documentRef: string,
): string | undefined {
  const document = snapshot?.documents.find((item) => item.ref === documentRef);
  if (!document || document.origin.kind !== "project-node") return undefined;
  return document.origin.nodeId;
}

function evidenceQuotesForProposal(
  proposal: CreateChronicleEventProposalPayloadV1,
  anchorsById: Map<string, ResolvedEvidenceAnchor>,
  snapshot: NarrativeCorpusSnapshot | null,
  titleBySceneId: ReadonlyMap<string, string>,
): ChronicleReviewEvidenceQuote[] {
  return proposal.evidenceAnchorIds.map((anchorId) => {
    const anchor = anchorsById.get(anchorId);
    if (!anchor) {
      return {
        anchorId,
        quote: "",
        documentRef: proposal.evidenceDocumentRefs[0] ?? "",
        method: "unknown" as const,
        blocked: true,
      };
    }
    const sceneId = sceneIdFromDocumentRef(snapshot, anchor.documentRef);
    return {
      anchorId: anchor.id,
      quote: anchor.quote,
      documentRef: anchor.documentRef,
      sceneId,
      sceneTitle: sceneId ? titleBySceneId.get(sceneId) : undefined,
      method: anchor.method,
      blocked: false,
    };
  });
}

function buildReviewProposalFromPlanned(args: {
  readonly planned: PlannedProposalArtifactRow;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly proposalKey: string;
  readonly anchorsById: Map<string, ResolvedEvidenceAnchor>;
  readonly snapshot: NarrativeCorpusSnapshot | null;
  readonly titleBySceneId: ReadonlyMap<string, string>;
}): ChronicleReviewProposal {
  const evidence = evidenceQuotesForProposal(
    args.planned.proposal,
    args.anchorsById,
    args.snapshot,
    args.titleBySceneId,
  );
  const fragmented = evidence.some(
    (item) => item.method === "fragmented" || item.blocked,
  );
  const safety = buildProposalSafetyFlags({
    match: args.planned.match,
    actuality: args.planned.proposal.actuality,
    evidenceMethods: evidence.map((item) => item.method),
    lossless: !fragmented,
  });
  return {
    proposalId: args.proposalId,
    revisionId: args.revisionId,
    proposalKey: args.proposalKey,
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: args.planned.proposal.title,
    payload: args.planned.proposal,
    match: args.planned.match,
    evidence,
    safety,
    probableDuplicateChoice: null,
    blockedReason: fragmented
      ? "断片 Evidence のため適用不可（確認のみ）"
      : undefined,
  };
}

export function buildChronicleExtractionReviewProjection(args: {
  readonly runId: string;
  readonly projectId: string;
  readonly workspacePath: string | null;
  readonly openRevision: number | null;
  readonly proposalSetId?: string | null;
  readonly status: ChronicleExtractionReviewProjection["status"];
  readonly coverage: ChronicleExtractionCoverage;
  readonly taskCounts: ChronicleExtractionReviewProjection["taskCounts"];
  readonly planned: readonly PlannedProposalArtifactRow[];
  readonly alreadySatisfied?: readonly {
    readonly hypothesisId: string;
    readonly title: string;
    readonly existingRef: string;
  }[];
  readonly savedProposals?: readonly {
    readonly proposalId: string;
    readonly proposalKey: string;
    readonly revisionId: string;
  }[];
  readonly anchors?: readonly ResolvedEvidenceAnchor[];
  readonly snapshot?: NarrativeCorpusSnapshot | null;
  readonly titleBySceneId?: ReadonlyMap<string, string>;
}): ChronicleExtractionReviewProjection {
  const anchorsById = new Map(
    (args.anchors ?? []).map((anchor) => [anchor.id, anchor] as const),
  );
  const titleBySceneId = args.titleBySceneId ?? new Map<string, string>();
  const saved = args.savedProposals ?? [];

  const proposals: ChronicleReviewProposal[] = args.planned.map(
    (planned, index) => {
      const seed = saved[index];
      return buildReviewProposalFromPlanned({
        planned,
        proposalId: seed?.proposalId ?? `local-proposal-${index}`,
        revisionId: seed?.revisionId ?? `local-rev-${index}`,
        proposalKey:
          seed?.proposalKey ?? `${planned.proposal.eventId}:${index}`,
        anchorsById,
        snapshot: args.snapshot ?? null,
        titleBySceneId,
      });
    },
  );

  for (const [index, item] of (args.alreadySatisfied ?? []).entries()) {
    proposals.push({
      proposalId: `already-satisfied-${item.hypothesisId}-${index}`,
      revisionId: null,
      proposalKey: `already-satisfied:${item.existingRef}`,
      status: "approved",
      applicability: "already-satisfied",
      displayTitle: item.title,
      payload: null,
      match: {
        status: "already-satisfied",
        existingRef: item.existingRef,
      },
      evidence: [],
      safety: buildProposalSafetyFlags({
        match: {
          status: "already-satisfied",
          existingRef: item.existingRef,
        },
        actuality: "actual",
        evidenceMethods: ["exact"],
      }),
      probableDuplicateChoice: null,
    });
  }

  return {
    runId: args.runId,
    projectId: args.projectId,
    workspacePath: args.workspacePath,
    openRevision: args.openRevision,
    proposalSetId: resolveProposalSetId(args.runId, args.proposalSetId),
    status: args.status,
    coverage: args.coverage,
    taskCounts: args.taskCounts,
    proposals,
  };
}

/**
 * Launch Chronicle Narrative Extraction Run and project results into the
 * review store. Product default uses Stage AI (`useAi: true`); tests may
 * pass `useAi: false` for the deterministic fake extractor.
 */
export async function startChronicleExtraction(
  request: StartChronicleExtractionRequest,
): Promise<{ runId: string }> {
  const coordinatorRequest: ChronicleExtractionRequest = {
    projectId: request.projectId,
    folderId: request.folderId,
    language: request.language ?? "ja",
    sceneIds: request.sceneIds,
    authority: request.authority,
    existingEvents: request.existingEvents,
  };

  const result = await runChronicleExtractionCoordinator(coordinatorRequest, {
    useAi: request.useAi ?? true,
  });

  rememberProposalSetId(result.runId, result.savedProposalSetId);

  const proposalArtifact =
    await loadInlineJsonArtifact<ProposalPlanArtifactPayload>(
      result.runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
    );
  const evidenceArtifact =
    await loadInlineJsonArtifact<ResolvedEvidenceArtifactPayload>(
      result.runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
    );

  let coverage: ChronicleExtractionCoverage = {
    mode: "complete",
    documentCount: result.snapshot.documents.length,
    windowCount: 0,
    completedWindows: 0,
    gaps: [],
  };
  let taskCounts = emptyTaskCounts();
  let status: ChronicleExtractionReviewProjection["status"] = "completed";

  try {
    const runProjection = await getRun(result.runId, request.projectId);
    status = runProjection.run.status;
    coverage = {
      mode:
        typeof runProjection.run.coverageJson.mode === "string"
          ? runProjection.run.coverageJson.mode
          : coverage.mode,
      documentCount:
        typeof runProjection.run.coverageJson.documentCount === "number"
          ? runProjection.run.coverageJson.documentCount
          : coverage.documentCount,
      windowCount:
        typeof runProjection.run.coverageJson.windowCount === "number"
          ? runProjection.run.coverageJson.windowCount
          : coverage.windowCount,
      completedWindows:
        typeof runProjection.run.coverageJson.completedWindows === "number"
          ? runProjection.run.coverageJson.completedWindows
          : typeof runProjection.run.coverageJson.windowCount === "number"
            ? runProjection.run.coverageJson.windowCount
            : 0,
      gaps: Array.isArray(runProjection.run.coverageJson.gaps)
        ? (runProjection.run.coverageJson.gaps as ChronicleExtractionCoverage["gaps"])
        : [],
    };
    taskCounts = runProjection.taskCounts;
  } catch {
    // Native get_run may be unavailable in unit tests; keep local defaults.
  }

  const planned =
    proposalArtifact?.planned ??
    (proposalArtifact?.proposals ?? result.proposals).map((proposal) => ({
      proposal,
      match: { status: "none" } as const,
      hypothesisId: proposal.eventId,
    }));

  const titleBySceneId = new Map<string, string>();
  for (const document of result.snapshot.documents) {
    if (document.origin.kind !== "project-node") continue;
    titleBySceneId.set(document.origin.nodeId, document.origin.nodeId);
  }

  const projection = buildChronicleExtractionReviewProjection({
    runId: result.runId,
    projectId: request.projectId,
    workspacePath: request.workspacePath,
    openRevision: request.openRevision,
    proposalSetId: result.savedProposalSetId,
    status,
    coverage,
    taskCounts,
    planned,
    alreadySatisfied: proposalArtifact?.alreadySatisfied,
    savedProposals: result.savedProposals,
    anchors: evidenceArtifact?.anchors,
    snapshot: result.snapshot,
    titleBySceneId,
  });

  useChronicleExtractionStore.getState().setProjection(projection);
  return { runId: result.runId };
}

/**
 * Return the in-memory review projection for a Run owned by the given project.
 * Foreign project/workspace runs are rejected (dialog scope isolation).
 */
export async function getChronicleExtractionReview(
  runId: string,
  scope?: {
    readonly projectId: string;
    readonly workspacePath?: string;
    readonly openRevision?: number;
  },
): Promise<ChronicleExtractionReviewProjection> {
  const current = useChronicleExtractionStore.getState().projection;
  if (current && current.runId === runId) {
    if (scope && current.projectId !== scope.projectId) {
      throw new Error("Chronicle extraction run belongs to another project");
    }
    if (
      scope?.workspacePath !== undefined &&
      current.workspacePath !== null &&
      current.workspacePath !== scope.workspacePath
    ) {
      throw new Error("Chronicle extraction run belongs to another workspace");
    }
    if (
      scope?.openRevision !== undefined &&
      current.openRevision !== null &&
      current.openRevision !== scope.openRevision
    ) {
      throw new Error(
        "Chronicle extraction run belongs to another workspace revision",
      );
    }
    return current;
  }

  if (!scope) {
    throw new Error(`Chronicle extraction review not loaded for run ${runId}`);
  }

  const runProjection = await getRun(runId, scope.projectId);
  if (runProjection.run.surfacePathId !== CHRONICLE_EXTRACT_SURFACE_PATH) {
    throw new Error("Run is not a chronicle extraction surface");
  }

  const proposalArtifact =
    await loadInlineJsonArtifact<ProposalPlanArtifactPayload>(
      runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
    );
  const evidenceArtifact =
    await loadInlineJsonArtifact<ResolvedEvidenceArtifactPayload>(
      runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
    );
  const snapshotArtifact =
    await loadInlineJsonArtifact<SnapshotArtifactPayload>(
      runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
    );

  const planned =
    proposalArtifact?.planned ??
    (proposalArtifact?.proposals ?? []).map((proposal) => ({
      proposal,
      match: { status: "none" } as const,
      hypothesisId: proposal.eventId,
    }));

  const projection = buildChronicleExtractionReviewProjection({
    runId,
    projectId: scope.projectId,
    workspacePath: scope.workspacePath ?? null,
    openRevision: scope.openRevision ?? null,
    proposalSetId: proposalArtifact?.proposalSetId ?? null,
    status: runProjection.run.status,
    coverage: {
      mode:
        typeof runProjection.run.coverageJson.mode === "string"
          ? runProjection.run.coverageJson.mode
          : undefined,
      documentCount:
        typeof runProjection.run.coverageJson.documentCount === "number"
          ? runProjection.run.coverageJson.documentCount
          : undefined,
      windowCount:
        typeof runProjection.run.coverageJson.windowCount === "number"
          ? runProjection.run.coverageJson.windowCount
          : undefined,
      completedWindows:
        typeof runProjection.run.coverageJson.completedWindows === "number"
          ? runProjection.run.coverageJson.completedWindows
          : typeof runProjection.run.coverageJson.windowCount === "number"
            ? runProjection.run.coverageJson.windowCount
            : undefined,
      gaps: Array.isArray(runProjection.run.coverageJson.gaps)
        ? (runProjection.run.coverageJson.gaps as ChronicleExtractionCoverage["gaps"])
        : [],
    },
    taskCounts: runProjection.taskCounts,
    planned,
    alreadySatisfied: proposalArtifact?.alreadySatisfied,
    anchors: evidenceArtifact?.anchors,
    snapshot: snapshotArtifact?.snapshot ?? null,
  });

  useChronicleExtractionStore.getState().setProjection(projection);
  return projection;
}

/**
 * Restore the newest resumable Chronicle extraction review for a dialog scope.
 * Soft-fails (returns null) when Native ledger has no matching run.
 */
export async function restoreChronicleExtractionReview(scope: {
  readonly projectId: string;
  readonly workspacePath: string;
  readonly openRevision: number;
}): Promise<ChronicleExtractionReviewProjection | null> {
  const current = useChronicleExtractionStore.getState().projection;
  if (
    current &&
    current.projectId === scope.projectId &&
    current.workspacePath === scope.workspacePath &&
    current.openRevision === scope.openRevision
  ) {
    return current;
  }

  try {
    const resumable = await listResumableRuns({
      projectId: scope.projectId,
      surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
      limit: 5,
    });
    const candidate = resumable[0];
    if (!candidate) return null;
    return await getChronicleExtractionReview(candidate.run.runId, scope);
  } catch {
    return null;
  }
}

/**
 * Compile approved review proposals and apply via Native commit coordinator.
 * Does not use legacy compensation-delete importExtractedEvents.
 */
export async function applyChronicleExtractionCommit(input: {
  readonly projectId: string;
  readonly proposals: readonly ChronicleReviewProposal[];
}): Promise<number> {
  const projection = useChronicleExtractionStore.getState().projection;
  if (!projection || projection.projectId !== input.projectId) {
    throw new Error("No active chronicle extraction review for project");
  }
  const proposalSetId = resolveProposalSetId(
    projection.runId,
    projection.proposalSetId,
  );
  if (!proposalSetId) {
    throw new Error("Missing proposalSetId for chronicle commit");
  }

  const snapshotArtifact =
    await loadInlineJsonArtifact<SnapshotArtifactPayload>(
      projection.runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
    );
  if (!snapshotArtifact?.snapshot) {
    throw new Error("Missing snapshot artifact for chronicle commit");
  }

  const approved = input.proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "approved" &&
      proposal.payload &&
      proposal.revisionId &&
      (proposal.match.status !== "probable-duplicate" ||
        proposal.probableDuplicateChoice === "create-as-new"),
  );

  if (approved.length === 0) return 0;

  const operations = approved.map((proposal) => {
    const payload = proposal.payload;
    const revisionId = proposal.revisionId;
    if (!payload || !revisionId) {
      throw new Error(
        `Proposal ${proposal.proposalId} missing payload/revision`,
      );
    }

    const anchorsByDocumentRef = new Map<string, string[]>();
    for (const evidence of proposal.evidence) {
      if (evidence.blocked) continue;
      const existing = anchorsByDocumentRef.get(evidence.documentRef) ?? [];
      if (!existing.includes(evidence.anchorId)) {
        existing.push(evidence.anchorId);
      }
      anchorsByDocumentRef.set(evidence.documentRef, existing);
    }

    return {
      operation: compileCreateChronicleEventOperation(payload, {
        snapshot: snapshotArtifact.snapshot,
        anchorsByDocumentRef,
      }),
      proposalId: proposal.proposalId,
      revisionId,
    };
  });

  const commitInput = {
    projectId: input.projectId,
    runId: projection.runId,
    proposalSetId,
    requestId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    surface: CHRONICLE_EXTRACT_SURFACE_PATH,
    operations,
  };

  await prepareChronicleCommit(commitInput);
  const applied = await applyChronicleCommit(commitInput);
  return applied.created?.length ?? operations.length;
}

/**
 * Persist a decision for the selected revision when Native ledger is available.
 * Local store status is the source of truth for the dialog until commit.
 */
export async function recordChronicleProposalDecision(args: {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly decision: "approved" | "rejected" | "deferred" | "held";
}): Promise<void> {
  try {
    await appendDecision({
      runId: args.runId,
      projectId: args.projectId,
      proposalId: args.proposalId,
      revisionId: args.revisionId,
      decision: args.decision,
      createdBy: "chronicle-extract-dialog",
    });
  } catch {
    // Ledger write is best-effort until commit path is mandatory.
  }
}

export async function recordChronicleProposalRevision(args: {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly payload: CreateChronicleEventProposalPayloadV1;
}): Promise<string | null> {
  try {
    const result = await appendRevision({
      runId: args.runId,
      projectId: args.projectId,
      proposalId: args.proposalId,
      payloadJson: args.payload as unknown as Readonly<Record<string, unknown>>,
      createdBy: "chronicle-extract-dialog",
    });
    return result.revisionId;
  } catch {
    return null;
  }
}

export type {
  ChronicleExtractionReviewProjection,
  ChronicleReviewProposal,
} from "./chronicleExtractionStore";
