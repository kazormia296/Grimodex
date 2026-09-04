import type {
  ChronicleExtractionRequest,
  ChronicleExtractionResult,
  ChronicleSavedProposalSeed,
} from "@/application/narrative-extraction/extractionCoordinator";
import {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_SURFACE_PATH,
} from "@/application/narrative-extraction/extractionContract";
import {
  hydrateInlineArtifactsFromNative,
  loadInlineJsonArtifact,
  type NarrativeArtifactCacheScope,
} from "@/application/narrative-extraction/artifactRepository";
import {
  cancelRun,
  getRun,
  listChronicleTaskResumeCandidates,
  listResumableRuns,
} from "@/application/narrative-extraction/runRepository";
import {
  appendHumanDecision,
  appendRevision,
  createHumanDerivedRevision,
} from "@/application/narrative-extraction/proposalRepository";
import {
  applyChronicleCommit,
  prepareChronicleCommit,
} from "@/application/narrative-extraction/commitCoordinator";
import {
  captureNarrativeExtractionWorkspaceBinding,
  narrativeExtractionIsRunResumableForReview,
  type ChronicleBlockedDiscardExpectation,
  type ChronicleTaskResumeCandidate,
  type GetRunReviewBundleResult,
  type ReviewBundleProposal,
  type ReviewBundleProposalApplication,
} from "@/application/narrative-extraction/nativeApi";
import {
  isCurrentMutationAuthority,
  runAuthoritativeMutation,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import { compileCreateChronicleEventOperation } from "./extraction/compiler";
import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { assertProposalPayload as assertChronicleProposalPayload } from "@/features/narrative-extraction/proposals/chronicleSceneEventAdapter";
import { stableJsonStringify } from "@/features/narrative-extraction/source/digest";
import type {
  ChronicleExistingMatch,
  ExistingChronicleEventCatalogRecord,
} from "./extraction/existingEventMatcher";
import { matchChronicleEventTitleAgainstCatalog } from "./extraction/existingEventMatcher";
import {
  buildProposalSafetyFlags,
  emptyTaskCounts,
  isSafeForBulkApprove,
  selectChronicleProposalsForAtomicApply,
  useChronicleExtractionStore,
  type ChronicleExtractionCoverage,
  type ChronicleExtractionRecoveryScope,
  type ChronicleExtractionReviewProjection,
  type ChronicleReviewEvidenceQuote,
  type ChronicleReviewProposal,
  type ProbableDuplicateChoice,
  type StartChronicleExtractionRequest,
} from "./chronicleExtractionStore";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";

export type { StartChronicleExtractionRequest };

export interface ResumeChronicleExtractionRequest {
  readonly candidate: ChronicleTaskResumeCandidate;
  readonly authority: MutationAuthority;
  readonly workspacePath: string;
  readonly openRevision: number;
}

export interface DiscardChronicleTaskResumeCandidateRequest {
  readonly candidate: ChronicleTaskResumeCandidate;
  readonly authority: MutationAuthority;
  readonly workspacePath: string;
  readonly openRevision: number;
}

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
  readonly existingEventsCatalog?: {
    readonly kind: "chronicle.existing-events-catalog@1";
    readonly events: readonly ExistingChronicleEventCatalogRecord[];
  };
}

const proposalSetIdByRunId = new Map<string, string>();
const resumeInFlight = new Map<string, Promise<{ runId: string }>>();
const discardInFlight = new Map<string, Promise<{ runId: string }>>();

function artifactCacheScope(input: {
  readonly projectId: string;
  readonly workspacePath?: string | null;
  readonly openRevision?: number | null;
}): NarrativeArtifactCacheScope {
  return {
    projectId: input.projectId,
    workspacePath: input.workspacePath ?? null,
    workspaceOpenRevision: input.openRevision ?? null,
  };
}

function rememberProposalSetId(runId: string, proposalSetId: string): void {
  proposalSetIdByRunId.set(runId, proposalSetId);
}

export function resetChronicleExtractionApiCachesForTests(): void {
  proposalSetIdByRunId.clear();
  resumeInFlight.clear();
  discardInFlight.clear();
}

function resolveProposalSetId(
  runId: string,
  artifactId?: string | null,
): string | null {
  return artifactId ?? proposalSetIdByRunId.get(runId) ?? null;
}

/**
 * `startChronicleExtraction` dynamically imports the coordinator, so it must
 * capture all caller-owned coordinates before that first await.  The
 * coordinator independently seals its own request; this outer copy prevents
 * the review projection from later being labelled with a mutated workspace,
 * scope, or catalog after the durable Run was created.
 */
function captureStartChronicleExtractionRequest(
  request: StartChronicleExtractionRequest,
): StartChronicleExtractionRequest {
  return {
    projectId: request.projectId,
    folderId: request.folderId,
    ...(request.language === undefined ? {} : { language: request.language }),
    sceneIds: [...request.sceneIds],
    authority: {
      projectId: request.authority.projectId,
      currentProjectId: request.authority.currentProjectId,
      workspacePath: request.authority.workspacePath,
      workspaceOpenRevision: request.authority.workspaceOpenRevision,
    },
    workspacePath: request.workspacePath,
    openRevision: request.openRevision,
    ...(request.existingEvents === undefined
      ? {}
      : { existingEvents: cloneCatalog(request.existingEvents) ?? [] }),
    ...(request.useAi === undefined ? {} : { useAi: request.useAi }),
  };
}

function cloneCatalog(
  catalog: readonly ExistingChronicleEventCatalogRecord[] | null | undefined,
): readonly ExistingChronicleEventCatalogRecord[] | null | undefined {
  if (catalog === null || catalog === undefined) return catalog;
  return catalog.map((event) => ({
    ref: event.ref,
    sourceKey: event.sourceKey,
    title: event.title,
    note: event.note,
    version: event.version,
    linkedDocumentSourceKeys: [...event.linkedDocumentSourceKeys],
    participantEntityRefs: [...event.participantEntityRefs],
    startTime: event.startTime,
    endTime: event.endTime,
    digest: event.digest,
    applicationProvenanceKeys: [...(event.applicationProvenanceKeys ?? [])],
  }));
}

function rematchHumanTitleRevision(
  title: string,
  catalog: readonly ExistingChronicleEventCatalogRecord[] | null | undefined,
): Extract<ChronicleExistingMatch, { status: "probable-duplicate" }> {
  const titleMatch = matchChronicleEventTitleAgainstCatalog(
    title,
    catalog ?? [],
  );
  return titleMatch.status === "probable-duplicate"
    ? titleMatch
    : {
        status: "probable-duplicate",
        candidates: [],
        reasons: ["human-title-revision"],
      };
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

function assertCurrentChronicleProposalPayload(
  value: unknown,
): asserts value is CreateChronicleEventProposalPayloadV1 {
  try {
    assertChronicleProposalPayload(value);
  } catch {
    throw new Error(
      "NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT: Native review bundle has an invalid current Chronicle payload",
    );
  }
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
  readonly reconciliationEnvelopeSchemaVersion?: 1 | 2 | null;
  readonly proposalKey: string;
  readonly status: NarrativeProposalStatus;
  readonly payload: CreateChronicleEventProposalPayloadV1;
  readonly anchorsById: Map<string, ResolvedEvidenceAnchor>;
  readonly snapshot: NarrativeCorpusSnapshot | null;
  readonly titleBySceneId: ReadonlyMap<string, string>;
  readonly existingEventsCatalog?:
    | readonly ExistingChronicleEventCatalogRecord[]
    | null;
  readonly probableDuplicateChoice?: ProbableDuplicateChoice | null;
  readonly application?: ReviewBundleProposalApplication | null;
}): ChronicleReviewProposal {
  // Match/safety is computed against the immutable plan-time payload. A
  // human-derived revision may change title/disclosure after the sealed Event
  // catalog is no longer available, so reusing that old match result would
  // make bulk approval treat an unevaluated revision as duplicate-safe.
  const payloadStillMatchesPlan =
    stableJsonStringify(args.payload) ===
    stableJsonStringify(args.planned.proposal);
  const titleChangedFromPlan =
    args.payload.title !== args.planned.proposal.title;
  const effectiveMatch = !titleChangedFromPlan
    ? args.planned.match
    : rematchHumanTitleRevision(args.payload.title, args.existingEventsCatalog);
  const evidence = evidenceQuotesForProposal(
    args.payload,
    args.anchorsById,
    args.snapshot,
    args.titleBySceneId,
  );
  const fragmented = evidence.some(
    (item) => item.method === "fragmented" || item.blocked,
  );
  const planSafety = buildProposalSafetyFlags({
    match: effectiveMatch,
    actuality: args.payload.actuality,
    evidenceMethods: evidence.map((item) => item.method),
    lossless: !fragmented,
  });
  const safety = payloadStillMatchesPlan
    ? planSafety
    : {
        ...planSafety,
        fresh: false,
        noDuplicate: false,
        riskLow: false,
      };
  return {
    proposalId: args.proposalId,
    revisionId: args.revisionId,
    reconciliationEnvelopeDigest: args.reconciliationEnvelopeDigest,
    reconciliationEnvelopeSchemaVersion:
      args.reconciliationEnvelopeSchemaVersion,
    proposalKey: args.proposalKey,
    status: args.status,
    applicability: "applicable",
    displayTitle: args.payload.title,
    payload: args.payload,
    plannedTitle: args.planned.proposal.title,
    plannedMatch: args.planned.match,
    match: effectiveMatch,
    evidence,
    safety,
    // Callers already bind this choice to the current revision. A new human
    // revision clears the parent choice in the store, while a decision made
    // after that edit must survive cold hydration even though its match proof
    // remains conservatively non-bulk-safe.
    probableDuplicateChoice: args.probableDuplicateChoice ?? null,
    application: args.application ?? null,
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
  readonly reconciliationEnvelopeSchemaVersion?: 1 | 2 | null;
  readonly payload?: CreateChronicleEventProposalPayloadV1;
  readonly probableDuplicateChoice?: ProbableDuplicateChoice | null;
  readonly application?: ReviewBundleProposalApplication | null;
};

function cloneReviewApplication(
  application: ReviewBundleProposalApplication | null | undefined,
): ReviewBundleProposalApplication | null {
  if (!application) return null;
  return {
    commitId: application.commitId,
    revisionId: application.revisionId,
    appliedEntityKind: application.appliedEntityKind,
    appliedEntityId: application.appliedEntityId,
    createdAt: application.createdAt,
    applicationKind: application.applicationKind,
    compensatesApplicationId: application.compensatesApplicationId,
  };
}

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
    const payload = proposal.payloadJson;
    assertCurrentChronicleProposalPayload(payload);
    return [
      {
        proposalId: proposal.proposalId,
        proposalKey: proposal.proposalKey,
        revisionId: proposal.currentRevisionId,
        reconciliationEnvelopeDigest: proposal.reconciliationEnvelopeDigest,
        reconciliationEnvelopeSchemaVersion:
          proposal.reconciliationEnvelopeSchemaVersion,
        status: proposal.status,
        payload,
        application: cloneReviewApplication(proposal.application),
        probableDuplicateChoice:
          proposal.latestDecision?.revisionId === proposal.currentRevisionId
            ? probableDuplicateChoiceFromDecisionJson(
                proposal.latestDecision.decisionJson,
              )
            : null,
      },
    ];
  });
}

function savedSeedsFromCoordinator(
  proposals: readonly ChronicleSavedProposalSeed[],
): SavedReviewSeed[] {
  return proposals.map((proposal) => ({
    proposalId: proposal.proposalId,
    proposalKey: proposal.proposalKey,
    revisionId: proposal.revisionId,
    status: proposal.status,
    reconciliationEnvelopeDigest: proposal.reconciliationEnvelopeDigest,
    reconciliationEnvelopeSchemaVersion:
      proposal.reconciliationEnvelopeSchemaVersion,
    payload: proposal.payload,
    probableDuplicateChoice: proposal.probableDuplicateChoice,
    application: null,
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
  readonly existingEventsCatalog?:
    | readonly ExistingChronicleEventCatalogRecord[]
    | null;
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
        reconciliationEnvelopeSchemaVersion:
          seed.reconciliationEnvelopeSchemaVersion,
        proposalKey: seed.proposalKey,
        status: seed.status ?? "unreviewed",
        payload,
        anchorsById,
        snapshot: args.snapshot ?? null,
        titleBySceneId,
        existingEventsCatalog: args.existingEventsCatalog,
        probableDuplicateChoice: seed.probableDuplicateChoice ?? null,
        application: seed.application ?? null,
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
      plannedTitle: item.title,
      plannedMatch: {
        status: "already-satisfied",
        existingRef: item.existingRef,
      },
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
      application: null,
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
    existingEventsCatalog: cloneCatalog(args.existingEventsCatalog),
    proposals,
  };
}

async function projectChronicleCoordinatorResult(
  result: ChronicleExtractionResult,
  scope: {
    readonly projectId: string;
    readonly workspacePath: string;
    readonly openRevision: number;
    readonly existingEvents?: readonly ExistingChronicleEventCatalogRecord[];
  },
): Promise<{ runId: string }> {
  rememberProposalSetId(result.runId, result.savedProposalSetId);

  const proposalArtifact =
    await loadInlineJsonArtifact<ProposalPlanArtifactPayload>(
      result.runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
      { scope: artifactCacheScope(scope) },
    );
  const evidenceArtifact =
    await loadInlineJsonArtifact<ResolvedEvidenceArtifactPayload>(
      result.runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
      { scope: artifactCacheScope(scope) },
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
    const runProjection = await getRun(result.runId, scope.projectId);
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
    projectId: scope.projectId,
    workspacePath: scope.workspacePath,
    openRevision: scope.openRevision,
    proposalSetId: result.savedProposalSetId,
    status,
    coverage,
    taskCounts,
    planned,
    alreadySatisfied: proposalArtifact?.alreadySatisfied,
    savedProposals: savedSeedsFromCoordinator(result.savedProposals),
    anchors: evidenceArtifact?.anchors,
    snapshot: result.snapshot,
    existingEventsCatalog: scope.existingEvents ?? null,
    titleBySceneId,
  });

  useChronicleExtractionStore.getState().setProjection(projection);
  return { runId: result.runId };
}

/**
 * Launch Chronicle Narrative Extraction Run and project results into the
 * review store. Product default uses Stage AI (`useAi: true`); tests may
 * pass `useAi: false` for the deterministic fake extractor.
 */
export async function startChronicleExtraction(
  request: StartChronicleExtractionRequest,
): Promise<{ runId: string }> {
  const capturedRequest = captureStartChronicleExtractionRequest(request);
  const coordinatorRequest: ChronicleExtractionRequest = {
    projectId: capturedRequest.projectId,
    folderId: capturedRequest.folderId,
    language: capturedRequest.language ?? "ja",
    sceneIds: capturedRequest.sceneIds,
    authority: capturedRequest.authority,
    existingEvents: capturedRequest.existingEvents,
  };

  const { runChronicleExtractionCoordinator } =
    await import("@/application/narrative-extraction/extractionCoordinator");
  const result = await runChronicleExtractionCoordinator(coordinatorRequest, {
    useAi: capturedRequest.useAi ?? true,
  });
  return projectChronicleCoordinatorResult(result, capturedRequest);
}

function errorCodeFrom(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/\bNEX_[A-Z0-9_]+\b/u)?.[0] ?? fallback;
}

function recoveryScopeMatches(
  left: ChronicleExtractionRecoveryScope | null,
  right: ChronicleExtractionRecoveryScope,
): boolean {
  return (
    left?.projectId === right.projectId &&
    left.workspacePath === right.workspacePath &&
    left.openRevision === right.openRevision
  );
}

function cloneResumeCandidate(
  candidate: ChronicleTaskResumeCandidate,
): ChronicleTaskResumeCandidate {
  return JSON.parse(JSON.stringify(candidate)) as ChronicleTaskResumeCandidate;
}

/**
 * Discover durable Task-resume work independently from Review restoration.
 * Errors are retained in the store and propagated: treating an unreadable
 * ledger as "no candidates" would let Analyze create a duplicate Run.
 */
export async function discoverChronicleTaskResumeCandidates(
  scope: ChronicleExtractionRecoveryScope,
): Promise<readonly ChronicleTaskResumeCandidate[]> {
  const capturedScope = { ...scope };
  const store = useChronicleExtractionStore.getState();
  store.beginRecoveryDiscovery(capturedScope);
  try {
    const listed = await listChronicleTaskResumeCandidates({
      projectId: capturedScope.projectId,
      limit: 20,
    });
    const candidates = listed.map(cloneResumeCandidate);
    if (
      candidates.some(
        (candidate) => candidate.projectId !== capturedScope.projectId,
      )
    ) {
      throw new Error(
        "NEX_CHRONICLE_RESUME_CANDIDATE_FOREIGN: Native returned a candidate for another project",
      );
    }
    const current = useChronicleExtractionStore.getState().recovery;
    if (recoveryScopeMatches(current.scope, capturedScope)) {
      useChronicleExtractionStore
        .getState()
        .setRecoveryCandidates(capturedScope, candidates);
    }
    return candidates;
  } catch (error) {
    const current = useChronicleExtractionStore.getState().recovery;
    if (recoveryScopeMatches(current.scope, capturedScope)) {
      useChronicleExtractionStore
        .getState()
        .blockRecovery(
          capturedScope,
          errorCodeFrom(error, "NEX_CHRONICLE_RESUME_DISCOVERY_FAILED"),
        );
    }
    throw error;
  }
}

function captureDiscardCandidateRequest(
  request: DiscardChronicleTaskResumeCandidateRequest,
): {
  readonly candidate: ChronicleTaskResumeCandidate;
  readonly authority: MutationAuthority;
  readonly scope: ChronicleExtractionRecoveryScope;
} {
  const authority: MutationAuthority = {
    projectId: request.authority.projectId,
    currentProjectId: request.authority.currentProjectId,
    workspacePath: request.authority.workspacePath,
    workspaceOpenRevision: request.authority.workspaceOpenRevision,
  };
  const scope: ChronicleExtractionRecoveryScope = {
    projectId: request.candidate.projectId,
    workspacePath: request.workspacePath,
    openRevision: request.openRevision,
  };
  const recovery = useChronicleExtractionStore.getState().recovery;
  const durableCandidate = recoveryScopeMatches(recovery.scope, scope)
    ? recovery.candidates.find(
        (candidate) => candidate.runId === request.candidate.runId,
      )
    : undefined;
  if (
    !durableCandidate ||
    durableCandidate.projectId !== request.candidate.projectId ||
    durableCandidate.availability !== "blocked"
  ) {
    throw new Error(
      "NEX_CHRONICLE_RESUME_DISCARD_NOT_ALLOWED: exact blocked candidate is not present in the current recovery scope",
    );
  }
  if (
    authority.projectId !== durableCandidate.projectId ||
    authority.workspacePath !== request.workspacePath ||
    authority.workspaceOpenRevision !== request.openRevision ||
    !isCurrentMutationAuthority(authority)
  ) {
    throw new Error(
      "NEX_CHRONICLE_RESUME_AUTHORITY_STALE: workspace or project authority changed before discard",
    );
  }
  return {
    candidate: cloneResumeCandidate(durableCandidate),
    authority,
    scope,
  };
}

function blockedDiscardExpectation(
  candidate: ChronicleTaskResumeCandidate,
): ChronicleBlockedDiscardExpectation {
  if (candidate.availability !== "blocked" || candidate.blockedCode === null) {
    throw new Error(
      "NEX_CHRONICLE_RESUME_DISCARD_NOT_ALLOWED: candidate is no longer durably blocked",
    );
  }
  return {
    nextTaskId: candidate.nextTask.taskId,
    blockedCode: candidate.blockedCode,
    runSpecDigest: candidate.runSpecDigest,
    snapshotDigest: candidate.snapshotDigest,
    catalogDigest: candidate.catalogDigest,
  };
}

/**
 * Explicitly cancel one exact blocked Chronicle Run, then re-read Native
 * recovery state before fresh extraction is enabled. This is intentionally
 * limited to durable candidates that cannot be resumed; lease-held and ready
 * Runs keep their existing recovery actions.
 */
export async function discardChronicleTaskResumeCandidate(
  request: DiscardChronicleTaskResumeCandidateRequest,
): Promise<{ runId: string }> {
  const captured = captureDiscardCandidateRequest(request);
  const inFlightKey = [
    captured.scope.workspacePath,
    String(captured.scope.openRevision),
    captured.candidate.projectId,
    captured.candidate.runId,
  ].join("\u0000");
  const existing = discardInFlight.get(inFlightKey);
  if (existing) return existing;

  const pending = (async () => {
    const bindingOutcome = await runAuthoritativeMutation(
      captured.authority,
      () =>
        captureNarrativeExtractionWorkspaceBinding(
          captured.scope.workspacePath,
        ),
    );
    if (
      bindingOutcome.status !== "current" ||
      !bindingOutcome.value ||
      !isCurrentMutationAuthority(captured.authority)
    ) {
      throw new Error(
        "NEX_CHRONICLE_RESUME_AUTHORITY_STALE: workspace or project authority changed before bound discard",
      );
    }
    const workspaceBinding = bindingOutcome.value;
    const outcome = await runAuthoritativeMutation(captured.authority, () =>
      cancelRun(
        captured.candidate.runId,
        captured.candidate.projectId,
        workspaceBinding,
        blockedDiscardExpectation(captured.candidate),
      ),
    );
    if (outcome.status === "stale") {
      throw new Error(
        "NEX_CHRONICLE_RESUME_AUTHORITY_STALE: workspace or project authority changed during bound discard",
      );
    }
    const cancelled = outcome.value;
    if (
      cancelled.runId !== captured.candidate.runId ||
      cancelled.status !== "cancelled"
    ) {
      throw new Error(
        "NEX_CHRONICLE_RESUME_DISCARD_FAILED: Native did not cancel the exact blocked Run",
      );
    }
    if (!isCurrentMutationAuthority(captured.authority)) {
      throw new Error(
        "NEX_CHRONICLE_RESUME_AUTHORITY_STALE: workspace or project authority changed during discard",
      );
    }
    const remaining = await discoverChronicleTaskResumeCandidates(
      captured.scope,
    );
    if (
      remaining.some(
        (candidate) => candidate.runId === captured.candidate.runId,
      )
    ) {
      useChronicleExtractionStore
        .getState()
        .blockRecovery(
          captured.scope,
          "NEX_CHRONICLE_RESUME_DISCARD_NOT_DURABLE",
        );
      throw new Error(
        "NEX_CHRONICLE_RESUME_DISCARD_NOT_DURABLE: cancelled Run remained discoverable",
      );
    }
    if (!isCurrentMutationAuthority(captured.authority)) {
      throw new Error(
        "NEX_CHRONICLE_RESUME_AUTHORITY_STALE: workspace or project authority changed while confirming discard",
      );
    }
    return { runId: captured.candidate.runId };
  })();
  discardInFlight.set(inFlightKey, pending);
  try {
    return await pending;
  } finally {
    if (discardInFlight.get(inFlightKey) === pending) {
      discardInFlight.delete(inFlightKey);
    }
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function captureCandidateCatalog(
  candidate: ChronicleTaskResumeCandidate,
): readonly ExistingChronicleEventCatalogRecord[] {
  const catalog = candidate.existingEventsCatalog;
  if (
    catalog?.kind !== "chronicle.existing-events-catalog@1" ||
    !Array.isArray(catalog.events)
  ) {
    throw new Error(
      "NEX_CHRONICLE_RESUME_CATALOG_MISSING: resume candidate has no sealed existing-event catalog",
    );
  }
  return catalog.events.map((unknownEvent, index) => {
    if (typeof unknownEvent !== "object" || unknownEvent === null) {
      throw new Error(
        `NEX_CHRONICLE_RESUME_CATALOG_MALFORMED: catalog event ${index} is not an object`,
      );
    }
    const event = unknownEvent as Readonly<Record<string, unknown>>;
    if (
      typeof event.ref !== "string" ||
      typeof event.sourceKey !== "string" ||
      typeof event.title !== "string" ||
      (event.note !== null && typeof event.note !== "string") ||
      typeof event.version !== "number" ||
      !Number.isSafeInteger(event.version) ||
      !isStringArray(event.linkedDocumentSourceKeys) ||
      !isStringArray(event.participantEntityRefs) ||
      (event.startTime !== null && typeof event.startTime !== "number") ||
      (event.endTime !== null && typeof event.endTime !== "number") ||
      typeof event.digest !== "string" ||
      (event.applicationProvenanceKeys !== undefined &&
        !isStringArray(event.applicationProvenanceKeys))
    ) {
      throw new Error(
        `NEX_CHRONICLE_RESUME_CATALOG_MALFORMED: catalog event ${index} has an unsupported shape`,
      );
    }
    return {
      ref: event.ref,
      sourceKey: event.sourceKey,
      title: event.title,
      note: event.note,
      version: event.version,
      linkedDocumentSourceKeys: [...event.linkedDocumentSourceKeys],
      participantEntityRefs: [...event.participantEntityRefs],
      startTime: event.startTime,
      endTime: event.endTime,
      digest: event.digest,
      ...(event.applicationProvenanceKeys === undefined
        ? {}
        : {
            applicationProvenanceKeys: [...event.applicationProvenanceKeys],
          }),
    } satisfies ExistingChronicleEventCatalogRecord;
  });
}

function captureResumeRequest(request: ResumeChronicleExtractionRequest): {
  readonly candidate: ChronicleTaskResumeCandidate;
  readonly authority: MutationAuthority;
  readonly workspacePath: string;
  readonly openRevision: number;
} {
  const candidate = cloneResumeCandidate(request.candidate);
  const authority: MutationAuthority = {
    projectId: request.authority.projectId,
    currentProjectId: request.authority.currentProjectId,
    workspacePath: request.authority.workspacePath,
    workspaceOpenRevision: request.authority.workspaceOpenRevision,
  };
  if (
    candidate.availability !== "ready" ||
    (candidate.status !== "pending" && candidate.status !== "running")
  ) {
    throw new Error(
      candidate.blockedCode ??
        (candidate.availability === "lease-held"
          ? "NEX_CHRONICLE_RESUME_LEASE_HELD"
          : "NEX_CHRONICLE_RESUME_CANDIDATE_BLOCKED"),
    );
  }
  if (
    typeof candidate.scopeJson.folderId !== "string" ||
    !candidate.scopeJson.folderId ||
    !isStringArray(candidate.scopeJson.sceneIds) ||
    typeof candidate.language !== "string" ||
    !candidate.language ||
    (candidate.executionMode !== "ai" &&
      candidate.executionMode !== "deterministic-fallback") ||
    candidate.specJson.executionMode !== candidate.executionMode ||
    candidate.specJson.coordinatorContractDigest !==
      candidate.coordinatorContractDigest ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate.coordinatorContractDigest)
  ) {
    throw new Error(
      "NEX_CHRONICLE_RESUME_CANDIDATE_INVALID: candidate scope/spec is incomplete",
    );
  }
  if (
    candidate.projectId !== authority.projectId ||
    authority.workspacePath !== request.workspacePath ||
    authority.workspaceOpenRevision !== request.openRevision ||
    !isCurrentMutationAuthority(authority)
  ) {
    throw new Error(
      "NEX_CHRONICLE_RESUME_AUTHORITY_STALE: workspace or project authority changed before resume",
    );
  }
  // Reject a malformed caller-supplied candidate up front, but never dispatch
  // this advisory catalog. Resume re-reads and parses the current Native row.
  captureCandidateCatalog(candidate);
  return {
    candidate,
    authority,
    workspacePath: request.workspacePath,
    openRevision: request.openRevision,
  };
}

function sameImmutableResumeCoordinates(
  sealed: ChronicleTaskResumeCandidate,
  current: ChronicleTaskResumeCandidate,
): boolean {
  return (
    sealed.runId === current.runId &&
    sealed.projectId === current.projectId &&
    sealed.runSpecDigest === current.runSpecDigest &&
    sealed.snapshotDigest === current.snapshotDigest &&
    sealed.catalogDigest === current.catalogDigest &&
    sealed.executionMode === current.executionMode &&
    sealed.coordinatorContractDigest === current.coordinatorContractDigest &&
    sealed.language === current.language &&
    stableJsonStringify(sealed.scopeJson) ===
      stableJsonStringify(current.scopeJson) &&
    stableJsonStringify(sealed.specJson) ===
      stableJsonStringify(current.specJson)
  );
}

/**
 * Re-read Native immediately before coordinator dispatch. Discovery is only
 * an advisory snapshot; the live Event Catalog or lease state may have
 * changed while the recovery CTA was visible. Native also repeats the same
 * Catalog CAS in each claim/finish transaction to close the remaining race.
 */
async function revalidateChronicleResumeCandidate(
  captured: ReturnType<typeof captureResumeRequest>,
  scope: ChronicleExtractionRecoveryScope,
): Promise<readonly ExistingChronicleEventCatalogRecord[]> {
  if (!isCurrentMutationAuthority(captured.authority)) {
    throw new Error(
      "NEX_CHRONICLE_RESUME_AUTHORITY_STALE: workspace or project authority changed before resume revalidation",
    );
  }
  const currentCandidates = await listChronicleTaskResumeCandidates({
    projectId: captured.candidate.projectId,
    limit: 100,
  });
  if (!isCurrentMutationAuthority(captured.authority)) {
    throw new Error(
      "NEX_CHRONICLE_RESUME_AUTHORITY_STALE: workspace or project authority changed during resume revalidation",
    );
  }
  const current = currentCandidates.find(
    (candidate) => candidate.runId === captured.candidate.runId,
  );
  if (
    !current ||
    !sameImmutableResumeCoordinates(captured.candidate, current)
  ) {
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(scope, currentCandidates);
    throw new Error(
      "NEX_CHRONICLE_RESUME_CANDIDATE_STALE: exact durable Run coordinates changed before resume",
    );
  }
  if (current.availability !== "ready") {
    useChronicleExtractionStore
      .getState()
      .setRecoveryCandidates(scope, currentCandidates);
    throw new Error(
      current.blockedCode ??
        (current.availability === "lease-held"
          ? "NEX_CHRONICLE_RESUME_LEASE_HELD"
          : "NEX_CHRONICLE_RESUME_CANDIDATE_BLOCKED"),
    );
  }
  return captureCandidateCatalog(current);
}

/** Continue one exact durable Chronicle Run. Never creates or falls back. */
export async function resumeChronicleExtraction(
  request: ResumeChronicleExtractionRequest,
): Promise<{ runId: string }> {
  const captured = captureResumeRequest(request);
  const scope: ChronicleExtractionRecoveryScope = {
    projectId: captured.candidate.projectId,
    workspacePath: captured.workspacePath,
    openRevision: captured.openRevision,
  };
  const inFlightKey = [
    captured.workspacePath,
    String(captured.openRevision),
    captured.candidate.projectId,
    captured.candidate.runId,
  ].join("\u0000");
  const existing = resumeInFlight.get(inFlightKey);
  if (existing) return existing;

  useChronicleExtractionStore
    .getState()
    .beginCandidateResume(captured.candidate.runId);
  const pending = (async () => {
    try {
      const currentExistingEvents = await revalidateChronicleResumeCandidate(
        captured,
        scope,
      );
      const { runChronicleExtractionCoordinator } =
        await import("@/application/narrative-extraction/extractionCoordinator");
      const coordinatorRequest: ChronicleExtractionRequest = {
        projectId: captured.candidate.projectId,
        folderId: captured.candidate.scopeJson.folderId,
        language: captured.candidate.language!,
        sceneIds: [...captured.candidate.scopeJson.sceneIds],
        authority: captured.authority,
        runId: captured.candidate.runId,
        resume: true,
        specDigest: captured.candidate.coordinatorContractDigest,
        existingEvents: currentExistingEvents,
      };
      const result = await runChronicleExtractionCoordinator(
        coordinatorRequest,
        { useAi: captured.candidate.executionMode === "ai" },
      );
      if (
        result.runId !== captured.candidate.runId ||
        !isCurrentMutationAuthority(captured.authority)
      ) {
        throw new Error(
          "NEX_CHRONICLE_RESUME_AUTHORITY_STALE: resumed Run completed outside its captured workspace authority",
        );
      }
      const projected = await projectChronicleCoordinatorResult(result, {
        ...scope,
        existingEvents: currentExistingEvents,
      });
      useChronicleExtractionStore
        .getState()
        .completeCandidateResume(captured.candidate.runId);
      return projected;
    } catch (error) {
      const errorCode = errorCodeFrom(error, "NEX_CHRONICLE_RESUME_FAILED");
      const recovery = useChronicleExtractionStore.getState().recovery;
      const retained = recovery.candidates.find(
        (candidate) => candidate.runId === captured.candidate.runId,
      );
      let refreshedNativeState =
        errorCode === "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT" &&
        recoveryScopeMatches(recovery.scope, scope) &&
        retained?.availability === "blocked";
      if (
        errorCode === "NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT" &&
        !refreshedNativeState &&
        isCurrentMutationAuthority(captured.authority)
      ) {
        try {
          await discoverChronicleTaskResumeCandidates(scope);
          refreshedNativeState = true;
        } catch {
          // Discovery owns its explicit failure state. Preserve the original
          // claim/finish error code below instead of treating drift as absent.
        }
      }
      const latestRecovery = useChronicleExtractionStore.getState().recovery;
      const latestCandidate = latestRecovery.candidates.find(
        (candidate) => candidate.runId === captured.candidate.runId,
      );
      if (
        !refreshedNativeState ||
        latestCandidate?.availability === "blocked"
      ) {
        useChronicleExtractionStore.getState().blockRecovery(scope, errorCode);
      }
      throw error;
    }
  })();
  resumeInFlight.set(inFlightKey, pending);
  try {
    return await pending;
  } finally {
    if (resumeInFlight.get(inFlightKey) === pending) {
      resumeInFlight.delete(inFlightKey);
    }
  }
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
      scope: artifactCacheScope(scope),
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
      {
        scope: artifactCacheScope(scope),
        requireNativeConfirmation: true,
      },
    );
  const evidenceArtifact =
    await loadInlineJsonArtifact<ResolvedEvidenceArtifactPayload>(
      runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
      {
        scope: artifactCacheScope(scope),
        requireNativeConfirmation: true,
      },
    );
  const snapshotArtifact =
    await loadInlineJsonArtifact<SnapshotArtifactPayload>(
      runId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
      {
        scope: artifactCacheScope(scope),
        requireNativeConfirmation: true,
      },
    );

  const planned = plannedRowsFromArtifact(proposalArtifact);
  if (planned.length === 0 && bundle.proposals.length > 0) {
    for (const [index, native] of bundle.proposals.entries()) {
      assertCurrentChronicleProposalPayload(native.payloadJson);
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
    existingEventsCatalog:
      snapshotArtifact?.existingEventsCatalog?.kind ===
      "chronicle.existing-events-catalog@1"
        ? snapshotArtifact.existingEventsCatalog.events
        : null,
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
      {
        scope: artifactCacheScope({
          projectId: input.projectId,
          workspacePath: projection.workspacePath,
          openRevision: projection.openRevision,
        }),
        requireNativeConfirmation: true,
      },
    );
  if (!snapshotArtifact?.snapshot) {
    throw new Error("Missing snapshot artifact for chronicle commit");
  }

  const approved = selectChronicleProposalsForAtomicApply(input.proposals);

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
  await appendHumanDecision({
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
 * Append a Native revision and return the server-issued revision receipt.
 * Fail-closed: never invents client revision ids.
 */
export interface ChronicleProposalRevisionReceipt {
  readonly revisionId: string;
  /**
   * Every V2 child receives a newly sealed envelope. Keeping this together
   * with its revision id is required for the next parent-envelope CAS.
   */
  readonly reconciliationEnvelopeDigest: string | null;
}

export async function recordChronicleProposalRevision(args: {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly expectedCurrentRevisionId: string;
  readonly payload: CreateChronicleEventProposalPayloadV1;
  readonly useHumanDerivedRevision?: boolean;
  readonly inheritReconciliationEnvelope?: {
    readonly parentRevisionId: string;
    readonly expectedEnvelopeDigest: string;
  };
}): Promise<ChronicleProposalRevisionReceipt> {
  if (args.useHumanDerivedRevision) {
    if (!args.inheritReconciliationEnvelope) {
      throw new Error(
        "V2 Chronicle revision requires an explicit parent Envelope inheritance",
      );
    }
    const result = await createHumanDerivedRevision({
      projectId: args.projectId,
      request: {
        proposalId: args.proposalId,
        expectedCurrentRevisionId: args.expectedCurrentRevisionId,
        parentRevisionId: args.inheritReconciliationEnvelope.parentRevisionId,
        expectedParentEnvelopeDigest:
          args.inheritReconciliationEnvelope.expectedEnvelopeDigest,
        proposalPayload: args.payload as unknown as Readonly<
          Record<string, unknown>
        >,
        adapter: {
          id: "chronicle.scene-event",
          version: "1",
        },
        surfaceId: "chronicle-review",
      },
    });
    if (!result.reconciliationEnvelopeDigest) {
      throw new Error(
        "Human C2B revision response missing reconciliationEnvelopeDigest",
      );
    }
    return {
      revisionId: result.revisionId,
      reconciliationEnvelopeDigest: result.reconciliationEnvelopeDigest,
    };
  }
  const result = await appendRevision({
    runId: args.runId,
    projectId: args.projectId,
    proposalId: args.proposalId,
    expectedCurrentRevisionId: args.expectedCurrentRevisionId,
    payloadJson: args.payload as unknown as Readonly<Record<string, unknown>>,
    inheritReconciliationEnvelope: undefined,
    createdBy: "chronicle-extract-dialog",
  });
  return {
    revisionId: result.revisionId,
    reconciliationEnvelopeDigest: null,
  };
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
  if (proposal.application !== null) {
    throw new Error(
      "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH: applied Chronicle proposal is immutable",
    );
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

export interface AbandonChroniclePartialReviewRequest {
  readonly runId: string;
  readonly projectId: string;
}

export interface AbandonChroniclePartialReviewResult {
  readonly runId: string;
  readonly terminalizedProposalCount: number;
}

/**
 * Terminalize the unapplied remainder of a historical partial Chronicle
 * review, then prove that Native no longer advertises the exact Run for review
 * restore. The facade owns the exclusive Apply/review mutation lease.
 */
export async function abandonChroniclePartialReview(
  args: AbandonChroniclePartialReviewRequest,
): Promise<AbandonChroniclePartialReviewResult> {
  const initialState = useChronicleExtractionStore.getState();
  if (
    !initialState.applyMutationInFlight ||
    initialState.reviewMutationCount !== 0
  ) {
    throw new Error(
      "NEX_CHRONICLE_PARTIAL_REVIEW_LEASE_REQUIRED: exclusive review settlement lease is required",
    );
  }
  const projection = initialState.projection;
  if (
    !projection ||
    projection.runId !== args.runId ||
    projection.projectId !== args.projectId
  ) {
    throw new Error(
      "NEX_CHRONICLE_PARTIAL_REVIEW_STATE_CHANGED: active review does not match the requested Run",
    );
  }

  const applicable = projection.proposals.filter(
    (proposal) => proposal.applicability === "applicable",
  );
  const hasPriorApplication = applicable.some(
    (proposal) => proposal.application !== null,
  );
  const unapplied = applicable.filter(
    (proposal) => proposal.application === null,
  );
  if (!hasPriorApplication || unapplied.length === 0) {
    throw new Error(
      "NEX_CHRONICLE_PARTIAL_REVIEW_NOT_APPLICABLE: review is not a historical partial Apply",
    );
  }
  for (const proposal of unapplied) {
    if (
      proposal.revisionId === null ||
      proposal.revisionId.length === 0 ||
      proposal.revisionId.trim() !== proposal.revisionId
    ) {
      throw new Error(
        `NEX_CHRONICLE_PARTIAL_REVIEW_REVISION_REQUIRED: proposal ${proposal.proposalId} has no exact current revision`,
      );
    }
  }

  let terminalizedProposalCount = 0;
  for (const proposal of unapplied) {
    if (proposal.match.status === "probable-duplicate") {
      if (
        proposal.status === "rejected" &&
        proposal.probableDuplicateChoice === "skip-as-same"
      ) {
        continue;
      }
      await decideChronicleProbableDuplicate({
        proposalId: proposal.proposalId,
        choice: "skip-as-same",
      });
      terminalizedProposalCount += 1;
      continue;
    }
    if (proposal.status === "rejected") continue;
    await decideChronicleProposal({
      proposalId: proposal.proposalId,
      status: "rejected",
      decisionJson: { reason: "historical-partial-review-abandoned" },
    });
    terminalizedProposalCount += 1;
  }

  const resumability = await narrativeExtractionIsRunResumableForReview({
    runId: args.runId,
    projectId: args.projectId,
    surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
  });
  if (
    resumability.runId !== args.runId ||
    resumability.projectId !== args.projectId ||
    resumability.surfacePathId !== CHRONICLE_EXTRACT_SURFACE_PATH ||
    typeof resumability.resumable !== "boolean"
  ) {
    throw new Error(
      "NEX_CHRONICLE_PARTIAL_REVIEW_RESUMABILITY_MISMATCH: Native returned an invalid exact Run result",
    );
  }
  if (resumability.resumable) {
    throw new Error(
      "NEX_CHRONICLE_PARTIAL_REVIEW_STILL_RESUMABLE: Native still advertises the abandoned Run",
    );
  }

  const settledState = useChronicleExtractionStore.getState();
  if (
    settledState.projection?.runId !== args.runId ||
    settledState.projection.projectId !== args.projectId
  ) {
    throw new Error(
      "NEX_CHRONICLE_PARTIAL_REVIEW_STATE_CHANGED: active review changed before settlement completed",
    );
  }
  settledState.clearProjection();
  return { runId: args.runId, terminalizedProposalCount };
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
  if (current.application !== null) {
    throw new Error(
      "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH: applied Chronicle proposal is immutable",
    );
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
  let effectiveMatch = current.match;
  if (nextPayload.title === current.plannedTitle) {
    effectiveMatch = current.plannedMatch;
  } else if (current.payload.title !== nextPayload.title) {
    effectiveMatch = rematchHumanTitleRevision(
      nextPayload.title,
      projection.existingEventsCatalog,
    );
  }
  const revision = await recordChronicleProposalRevision({
    runId: projection.runId,
    projectId: projection.projectId,
    proposalId: args.proposalId,
    expectedCurrentRevisionId: current.revisionId,
    payload: nextPayload,
    useHumanDerivedRevision: current.reconciliationEnvelopeSchemaVersion === 2,
    inheritReconciliationEnvelope:
      current.reconciliationEnvelopeSchemaVersion === 2 &&
      current.reconciliationEnvelopeDigest
        ? {
            parentRevisionId: current.revisionId,
            expectedEnvelopeDigest: current.reconciliationEnvelopeDigest,
          }
        : undefined,
  });
  useChronicleExtractionStore
    .getState()
    .reviseProposalFields(
      args.proposalId,
      revision.revisionId,
      revision.reconciliationEnvelopeDigest,
      effectiveMatch,
      args.patch,
    );
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
      proposal.application !== null ||
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
