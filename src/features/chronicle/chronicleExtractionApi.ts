import {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_SURFACE_PATH,
  runChronicleExtractionCoordinator,
  type ChronicleExtractionRequest,
} from "@/application/narrative-extraction/extractionCoordinator";
import {
  hydrateInlineArtifactsFromNative,
  loadInlineJsonArtifact,
} from "@/application/narrative-extraction/artifactRepository";
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
import type {
  GetRunReviewBundleResult,
  ReviewBundleProposal,
  SavedProposalSeed,
} from "@/application/narrative-extraction/nativeApi";
import { compileCreateChronicleEventOperation } from "./extraction/compiler";
import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import type { ChronicleExistingMatch } from "./extraction/existingEventMatcher";
import {
  buildProposalSafetyFlags,
  emptyTaskCounts,
  isSafeForBulkApprove,
  useChronicleExtractionStore,
  type ChronicleExtractionCoverage,
  type ChronicleExtractionReviewProjection,
  type ChronicleReviewEvidenceQuote,
  type ChronicleReviewProposal,
  type ProbableDuplicateChoice,
  type StartChronicleExtractionRequest,
} from "./chronicleExtractionStore";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";

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

export function resetChronicleExtractionApiCachesForTests(): void {
  proposalSetIdByRunId.clear();
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

function isProposalPayload(
  value: unknown,
): value is CreateChronicleEventProposalPayloadV1 {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.eventId === "string" &&
    typeof record.title === "string" &&
    Array.isArray(record.evidenceAnchorIds)
  );
}

function plannedProposalKey(
  planned: PlannedProposalArtifactRow,
  index: number,
): string {
  return `${planned.proposal.eventId}:${index}`;
}

function buildReviewProposalFromPlanned(args: {
  readonly planned: PlannedProposalArtifactRow;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly reconciliationEnvelopeDigest?: string | null;
  readonly proposalKey: string;
  readonly status: NarrativeProposalStatus;
  readonly payload: CreateChronicleEventProposalPayloadV1;
  readonly anchorsById: Map<string, ResolvedEvidenceAnchor>;
  readonly snapshot: NarrativeCorpusSnapshot | null;
  readonly titleBySceneId: ReadonlyMap<string, string>;
  readonly probableDuplicateChoice?: ProbableDuplicateChoice | null;
}): ChronicleReviewProposal {
  const evidence = evidenceQuotesForProposal(
    args.payload,
    args.anchorsById,
    args.snapshot,
    args.titleBySceneId,
  );
  const fragmented = evidence.some(
    (item) => item.method === "fragmented" || item.blocked,
  );
  const safety = buildProposalSafetyFlags({
    match: args.planned.match,
    actuality: args.payload.actuality,
    evidenceMethods: evidence.map((item) => item.method),
    lossless: !fragmented,
  });
  return {
    proposalId: args.proposalId,
    revisionId: args.revisionId,
    reconciliationEnvelopeDigest: args.reconciliationEnvelopeDigest,
    proposalKey: args.proposalKey,
    status: args.status,
    applicability: "applicable",
    displayTitle: args.payload.title,
    payload: args.payload,
    match: args.planned.match,
    evidence,
    safety,
    probableDuplicateChoice: args.probableDuplicateChoice ?? null,
    blockedReason: fragmented
      ? "断片 Evidence のため適用不可（確認のみ）"
      : undefined,
  };
}

type SavedReviewSeed = {
  readonly proposalId: string;
  readonly proposalKey: string;
  readonly revisionId: string;
  readonly status?: NarrativeProposalStatus;
  readonly reconciliationEnvelopeDigest?: string | null;
  readonly payload?: CreateChronicleEventProposalPayloadV1;
  readonly probableDuplicateChoice?: ProbableDuplicateChoice | null;
};

function probableDuplicateChoiceFromDecisionJson(
  decisionJson: Readonly<Record<string, unknown>> | null | undefined,
): ProbableDuplicateChoice | null {
  const raw = decisionJson?.probableDuplicateChoice;
  if (raw === "create-as-new" || raw === "skip-as-same" || raw === "hold") {
    return raw;
  }
  return null;
}

function savedSeedsFromBundle(
  proposals: readonly ReviewBundleProposal[],
): SavedReviewSeed[] {
  return proposals.flatMap((proposal) => {
    if (!proposal.currentRevisionId) return [];
    const payload = isProposalPayload(proposal.payloadJson)
      ? proposal.payloadJson
      : undefined;
    return [
      {
        proposalId: proposal.proposalId,
        proposalKey: proposal.proposalKey,
        revisionId: proposal.currentRevisionId,
        reconciliationEnvelopeDigest: proposal.reconciliationEnvelopeDigest,
        status: proposal.status,
        payload,
        probableDuplicateChoice: probableDuplicateChoiceFromDecisionJson(
          proposal.latestDecision?.decisionJson,
        ),
      },
    ];
  });
}

function savedSeedsFromCoordinator(
  proposals: readonly SavedProposalSeed[],
): SavedReviewSeed[] {
  return proposals.map((proposal) => ({
    proposalId: proposal.proposalId,
    proposalKey: proposal.proposalKey,
    revisionId: proposal.revisionId,
    status: proposal.status,
    reconciliationEnvelopeDigest: proposal.reconciliationEnvelopeDigest,
  }));
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
  readonly savedProposals?: readonly SavedReviewSeed[];
  readonly anchors?: readonly ResolvedEvidenceAnchor[];
  readonly snapshot?: NarrativeCorpusSnapshot | null;
  readonly titleBySceneId?: ReadonlyMap<string, string>;
}): ChronicleExtractionReviewProjection {
  const anchorsById = new Map(
    (args.anchors ?? []).map((anchor) => [anchor.id, anchor] as const),
  );
  const titleBySceneId = args.titleBySceneId ?? new Map<string, string>();
  const savedByKey = new Map(
    (args.savedProposals ?? []).map(
      (seed) => [seed.proposalKey, seed] as const,
    ),
  );

  const proposals: ChronicleReviewProposal[] = args.planned.map(
    (planned, index) => {
      const proposalKey = plannedProposalKey(planned, index);
      const seed = savedByKey.get(proposalKey);
      if (!seed?.revisionId) {
        throw new Error(
          `Missing Native proposal revision for key ${proposalKey} on run ${args.runId}`,
        );
      }
      const payload = seed.payload ?? planned.proposal;
      return buildReviewProposalFromPlanned({
        planned,
        proposalId: seed.proposalId,
        revisionId: seed.revisionId,
        reconciliationEnvelopeDigest: seed.reconciliationEnvelopeDigest,
        proposalKey: seed.proposalKey,
        status: seed.status ?? "unreviewed",
        payload,
        anchorsById,
        snapshot: args.snapshot ?? null,
        titleBySceneId,
        probableDuplicateChoice: seed.probableDuplicateChoice ?? null,
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
      { projectId: request.projectId },
    );
  const evidenceArtifact =
    await loadInlineJsonArtifact<ResolvedEvidenceArtifactPayload>(
      result.runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
      { projectId: request.projectId },
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
        ? (runProjection.run.coverageJson
            .gaps as ChronicleExtractionCoverage["gaps"])
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
    savedProposals: savedSeedsFromCoordinator(result.savedProposals),
    anchors: evidenceArtifact?.anchors,
    snapshot: result.snapshot,
    titleBySceneId,
  });

  useChronicleExtractionStore.getState().setProjection(projection);
  return { runId: result.runId };
}

function coverageFromRunJson(
  coverageJson: Readonly<Record<string, unknown>>,
): ChronicleExtractionCoverage {
  return {
    mode: typeof coverageJson.mode === "string" ? coverageJson.mode : undefined,
    documentCount:
      typeof coverageJson.documentCount === "number"
        ? coverageJson.documentCount
        : undefined,
    windowCount:
      typeof coverageJson.windowCount === "number"
        ? coverageJson.windowCount
        : undefined,
    completedWindows:
      typeof coverageJson.completedWindows === "number"
        ? coverageJson.completedWindows
        : typeof coverageJson.windowCount === "number"
          ? coverageJson.windowCount
          : undefined,
    gaps: Array.isArray(coverageJson.gaps)
      ? (coverageJson.gaps as ChronicleExtractionCoverage["gaps"])
      : [],
  };
}

function plannedRowsFromArtifact(
  proposalArtifact: ProposalPlanArtifactPayload | null,
): PlannedProposalArtifactRow[] {
  if (proposalArtifact?.planned) {
    return [...proposalArtifact.planned];
  }
  return (proposalArtifact?.proposals ?? []).map((proposal) => ({
    proposal,
    match: { status: "none" } as const,
    hypothesisId: proposal.eventId,
  }));
}

/**
 * Return the in-memory review projection for a Run owned by the given project.
 * Foreign project/workspace runs are rejected (dialog scope isolation).
 * Cold start: hydrates artifacts + proposals from Native review bundle.
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

  let bundle: GetRunReviewBundleResult;
  try {
    bundle = await hydrateInlineArtifactsFromNative({
      runId,
      projectId: scope.projectId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to restore chronicle extraction review from Native: ${message}`,
      { cause: error },
    );
  }

  if (!bundle.proposalSet) {
    throw new Error(
      `Chronicle extraction run ${runId} has no Native proposal set`,
    );
  }
  rememberProposalSetId(runId, bundle.proposalSet.proposalSetId);

  const proposalArtifact =
    await loadInlineJsonArtifact<ProposalPlanArtifactPayload>(
      runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
      { projectId: scope.projectId },
    );
  const evidenceArtifact =
    await loadInlineJsonArtifact<ResolvedEvidenceArtifactPayload>(
      runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
      { projectId: scope.projectId },
    );
  const snapshotArtifact =
    await loadInlineJsonArtifact<SnapshotArtifactPayload>(
      runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
      { projectId: scope.projectId },
    );

  const planned = plannedRowsFromArtifact(proposalArtifact);
  if (planned.length === 0 && bundle.proposals.length > 0) {
    for (const [index, native] of bundle.proposals.entries()) {
      if (!isProposalPayload(native.payloadJson)) {
        throw new Error(
          `Native proposal ${native.proposalId} missing chronicle payload`,
        );
      }
      planned.push({
        proposal: native.payloadJson,
        match: { status: "none" },
        hypothesisId: native.payloadJson.eventId || `native-${index}`,
      });
    }
  }

  const titleBySceneId = new Map<string, string>();
  for (const document of snapshotArtifact?.snapshot.documents ?? []) {
    if (document.origin.kind !== "project-node") continue;
    titleBySceneId.set(document.origin.nodeId, document.origin.nodeId);
  }

  const projection = buildChronicleExtractionReviewProjection({
    runId,
    projectId: scope.projectId,
    workspacePath: scope.workspacePath ?? null,
    openRevision: scope.openRevision ?? null,
    proposalSetId:
      proposalArtifact?.proposalSetId ?? bundle.proposalSet.proposalSetId,
    status: runProjection.run.status,
    coverage: coverageFromRunJson(runProjection.run.coverageJson),
    taskCounts: runProjection.taskCounts,
    planned,
    alreadySatisfied: proposalArtifact?.alreadySatisfied,
    savedProposals: savedSeedsFromBundle(bundle.proposals),
    anchors: evidenceArtifact?.anchors,
    snapshot: snapshotArtifact?.snapshot ?? null,
    titleBySceneId,
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
    for (const candidate of resumable) {
      try {
        return await getChronicleExtractionReview(candidate.run.runId, scope);
      } catch {
        // Newer crashed runs without a durable ProposalSet must not hide
        // older completed reviews that still hydrate.
        continue;
      }
    }
    return null;
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
      { projectId: input.projectId },
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

  const prepared = await prepareChronicleCommit(commitInput);
  const applied = await applyChronicleCommit(commitInput, prepared);
  return applied.created?.length ?? operations.length;
}

/**
 * Persist a decision for the current revision. Fail-closed: errors propagate.
 * Callers must update Zustand only after this resolves.
 */
export async function recordChronicleProposalDecision(args: {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly decision: "approved" | "rejected" | "deferred" | "held";
  readonly decisionJson?: Readonly<Record<string, unknown>>;
}): Promise<void> {
  await appendDecision({
    runId: args.runId,
    projectId: args.projectId,
    proposalId: args.proposalId,
    revisionId: args.revisionId,
    decision: args.decision,
    decisionJson: args.decisionJson,
    createdBy: "chronicle-extract-dialog",
  });
}

/**
 * Append a Native revision and return the server-issued revision id.
 * Fail-closed: never invents client revision ids.
 */
export async function recordChronicleProposalRevision(args: {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly expectedCurrentRevisionId: string;
  readonly payload: CreateChronicleEventProposalPayloadV1;
  readonly inheritReconciliationEnvelope?: {
    readonly parentRevisionId: string;
    readonly expectedEnvelopeDigest: string;
  };
}): Promise<string> {
  const result = await appendRevision({
    runId: args.runId,
    projectId: args.projectId,
    proposalId: args.proposalId,
    expectedCurrentRevisionId: args.expectedCurrentRevisionId,
    payloadJson: args.payload as unknown as Readonly<Record<string, unknown>>,
    inheritReconciliationEnvelope: args.inheritReconciliationEnvelope,
    createdBy: "chronicle-extract-dialog",
  });
  return result.revisionId;
}

/**
 * Approve / reject / hold via Native, then mirror status into the store.
 */
export async function decideChronicleProposal(args: {
  readonly proposalId: string;
  readonly status: NarrativeProposalStatus;
  readonly decisionJson?: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const projection = useChronicleExtractionStore.getState().projection;
  if (!projection) {
    throw new Error("No active chronicle extraction review");
  }
  const proposal = projection.proposals.find(
    (item) => item.proposalId === args.proposalId,
  );
  if (!proposal?.revisionId) {
    throw new Error(`Proposal ${args.proposalId} missing revisionId`);
  }
  if (args.status === "unreviewed") {
    useChronicleExtractionStore
      .getState()
      .updateProposalStatus(args.proposalId, args.status);
    return;
  }
  const decision =
    args.status === "approved"
      ? "approved"
      : args.status === "rejected"
        ? "rejected"
        : args.status === "held"
          ? "held"
          : "deferred";
  await recordChronicleProposalDecision({
    runId: projection.runId,
    projectId: projection.projectId,
    proposalId: args.proposalId,
    revisionId: proposal.revisionId,
    decision,
    decisionJson: args.decisionJson,
  });
  useChronicleExtractionStore
    .getState()
    .updateProposalStatus(args.proposalId, args.status);
}

/**
 * Persist probable-duplicate resolution (including create-as-new) via Native
 * Decision ledger, then mirror into the review store.
 */
export async function decideChronicleProbableDuplicate(args: {
  readonly proposalId: string;
  readonly choice: ProbableDuplicateChoice;
}): Promise<void> {
  const status =
    args.choice === "hold"
      ? ("held" as const)
      : args.choice === "skip-as-same"
        ? ("rejected" as const)
        : ("approved" as const);
  await decideChronicleProposal({
    proposalId: args.proposalId,
    status,
    decisionJson: { probableDuplicateChoice: args.choice },
  });
  useChronicleExtractionStore
    .getState()
    .setProbableDuplicateChoice(args.proposalId, args.choice);
}

/**
 * Persist field edits as a Native revision, then update the local projection.
 */
export async function reviseChronicleProposal(args: {
  readonly proposalId: string;
  readonly patch: {
    title?: string;
    note?: string | null;
    secret?: boolean;
    revealDocumentRef?: string;
  };
}): Promise<void> {
  const projection = useChronicleExtractionStore.getState().projection;
  if (!projection) {
    throw new Error("No active chronicle extraction review");
  }
  const current = projection.proposals.find(
    (item) => item.proposalId === args.proposalId,
  );
  if (!current?.payload || !current.revisionId) {
    throw new Error(`Proposal ${args.proposalId} missing payload/revision`);
  }
  const nextPayload: CreateChronicleEventProposalPayloadV1 = {
    ...current.payload,
    title:
      args.patch.title !== undefined
        ? args.patch.title.trim()
        : current.payload.title,
    note:
      args.patch.note !== undefined
        ? args.patch.note === null
          ? null
          : args.patch.note.trim() || null
        : current.payload.note,
    disclosure: {
      secret:
        args.patch.secret !== undefined
          ? args.patch.secret
          : current.payload.disclosure.secret,
      revealDocumentRef:
        args.patch.revealDocumentRef ??
        current.payload.disclosure.revealDocumentRef,
    },
  };
  const revisionId = await recordChronicleProposalRevision({
    runId: projection.runId,
    projectId: projection.projectId,
    proposalId: args.proposalId,
    expectedCurrentRevisionId: current.revisionId,
    payload: nextPayload,
    inheritReconciliationEnvelope: current.reconciliationEnvelopeDigest
      ? {
          parentRevisionId: current.revisionId,
          expectedEnvelopeDigest: current.reconciliationEnvelopeDigest,
        }
      : undefined,
  });
  useChronicleExtractionStore
    .getState()
    .reviseProposalFields(args.proposalId, revisionId, args.patch);
}

/**
 * Bulk-approve safe proposals with Native persistence. Stops on first failure.
 */
export async function bulkApproveSafeChronicleProposals(): Promise<number> {
  const projection = useChronicleExtractionStore.getState().projection;
  if (!projection) return 0;
  let approved = 0;
  for (const proposal of projection.proposals) {
    if (
      proposal.applicability !== "applicable" ||
      proposal.status !== "unreviewed" ||
      !isSafeForBulkApprove(proposal.safety) ||
      !proposal.revisionId
    ) {
      continue;
    }
    await recordChronicleProposalDecision({
      runId: projection.runId,
      projectId: projection.projectId,
      proposalId: proposal.proposalId,
      revisionId: proposal.revisionId,
      decision: "approved",
    });
    useChronicleExtractionStore
      .getState()
      .updateProposalStatus(proposal.proposalId, "approved");
    approved += 1;
  }
  return approved;
}

export type {
  ChronicleExtractionReviewProjection,
  ChronicleReviewProposal,
} from "./chronicleExtractionStore";
