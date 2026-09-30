import {
  isCurrentMutationAuthority,
  runAuthoritativeMutation,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import { resolveEvidenceReference } from "@/features/narrative-extraction/evidence/resolveEvidence";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { CHRONICLE_EVENT_PROPOSAL_KIND } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { assertProposalPayload as assertChronicleProposalPayload } from "@/features/narrative-extraction/proposals/chronicleSceneEventAdapter";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import {
  digestStableJson,
  stableJsonStringify,
} from "@/features/narrative-extraction/source/digest";
import type {
  CanonicalRange,
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
  Sha256Digest,
} from "@/features/narrative-extraction/source/types";
import {
  assertCapturedEvidenceSpanCatalogCoverage,
  assertEvidenceSpanCatalogCoverage,
  assertEvidenceSpanCatalogCaptureMatches,
  bindCapturedEvidenceSpanCatalog,
  buildEvidenceSpanCatalog,
  captureEvidenceSpanCatalog,
  type EvidenceSpanCatalog,
  type EvidenceSpanCatalogBinding,
  type EvidenceSpanCatalogCapture,
  type EvidenceSpanCatalogWindowInput,
} from "@/features/narrative-extraction/evidence/spanCatalog";
import type { NarrativeScopeAuthorityBasisV2 } from "@/features/narrative-extraction/source/scopeAuthorityBasisV2";
import { clusterEventObservations } from "@/features/chronicle/extraction/eventClustering";
import { chronicleEvidenceTupleKey } from "@/features/chronicle/extraction/evidenceTupleKey";
import { mergeObservationsByEvidence } from "@/features/chronicle/extraction/observationMerger";
import {
  matchExistingChronicleEvent,
  type ChronicleExistingMatch,
  type ExistingChronicleEventCatalogRecord,
} from "@/features/chronicle/extraction/existingEventMatcher";
import { assertSavedPlanActualitySupport } from "@/features/chronicle/extraction/savedPlanActualityGate";
import { planChronicleEventProposalsWithDiagnostics } from "@/features/chronicle/extraction/proposalPlanner";
import {
  checkHypothesisActuality,
  type RejectedHypothesisActuality,
} from "@/features/chronicle/extraction/hypothesisActualityGate";
import {
  synthesizeHypothesesFromClusters,
  type RejectedSynthesisCluster,
} from "@/features/chronicle/extraction/eventSynthesisFallback";
import {
  assertUniqueObservationLocalIds,
  rekeyObservationsForWindow,
} from "@/features/chronicle/extraction/windowExtractor";
import {
  planExtractionWindows,
  type ExtractionWindow,
  type WindowPlan,
} from "@/features/chronicle/extraction/windowPlanner";
import type {
  ChroniclePlanProposalSetFinish,
  ChronicleStageC1ExecutionBinding,
  GetRunReviewBundleResult,
  SavedProposalSeed,
} from "./nativeApi";
import {
  captureNarrativeExtractionWorkspaceBinding,
  narrativeExtractionClaimTask,
  narrativeExtractionFailTask,
  narrativeExtractionFinishTask,
} from "./nativeApi";
import {
  buildInlineJsonArtifact,
  hydrateChronicleStageReceiptsFromNative,
  hydrateInlineArtifactsFromNative,
  loadInlineJsonArtifact,
  rememberInlineJsonArtifact,
  type NarrativeArtifactCacheScope,
} from "./artifactRepository";
import {
  buildSnapshotSourceBasis,
  buildChronicleProposalSetPayload,
} from "./proposalRepository";
import type { ChronicleV2ProductionBatchResult } from "./chronicleV2Production";
import {
  buildChronicleStageProvenanceClosureV1,
  type ChronicleStageTerminalReceiptV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import {
  buildProjectNarrativeSnapshot,
  type ProjectSnapshotAdapterServices,
  type ProjectNarrativeSnapshotResult,
} from "./projectSnapshotAdapter";
import { cancelRun, createRun, getRun } from "./runRepository";
import type {
  NarrativeExtractionRunProjection,
  NarrativeExtractionTask,
} from "@/features/narrative-extraction/runtime/types";
import {
  runObservationExtractionTask,
  type ObservationEvidenceMode,
} from "./aiTasks/runObservationExtractionTask";
import {
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  LEGACY_OBSERVATION_EVIDENCE_MODE,
} from "./aiTasks/citationIdObservation";
import {
  runEventSynthesisTask,
  type ChronicleSynthesisTerminalOutput,
} from "./aiTasks/runEventSynthesisTask";
import {
  createStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "@/features/narrative-extraction/reconciler/stageExecution";
import {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_SURFACE_PATH,
} from "./extractionContract";
export {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_SURFACE_PATH,
} from "./extractionContract";

export const NARRATIVE_IR_V2_PRODUCTION_ENABLED = true as const;

export const CHRONICLE_EXTRACT_TASK_KINDS = {
  snapshot: "source.snapshot@1",
  windowPlan: "source.window-plan@1",
  observe: "chronicle.observe-events@1",
  resolveEvidence: "evidence.resolve@1",
  mergeObservations: "chronicle.merge-local-observations@1",
  cluster: "chronicle.cluster-event-observations@1",
  synthesize: "chronicle.synthesize-event@1",
  matchExisting: "chronicle.match-existing-events@1",
  planProposals: "chronicle.plan-proposals@1",
} as const;

const CHRONICLE_EXTRACT_DAG = [
  CHRONICLE_EXTRACT_TASK_KINDS.snapshot,
  CHRONICLE_EXTRACT_TASK_KINDS.windowPlan,
  CHRONICLE_EXTRACT_TASK_KINDS.observe,
  CHRONICLE_EXTRACT_TASK_KINDS.resolveEvidence,
  CHRONICLE_EXTRACT_TASK_KINDS.mergeObservations,
  CHRONICLE_EXTRACT_TASK_KINDS.cluster,
  CHRONICLE_EXTRACT_TASK_KINDS.synthesize,
  CHRONICLE_EXTRACT_TASK_KINDS.matchExisting,
  CHRONICLE_EXTRACT_TASK_KINDS.planProposals,
] as const;

/** Native validates this exact versioned shape before a Chronicle Run exists. */
export const CHRONICLE_EXTRACT_RUN_SPEC_KIND =
  "chronicle.extract.run-spec@2" as const;

type ChronicleExecutionMode = "ai" | "deterministic-fallback";

interface SealedChronicleRunSpec {
  readonly specJson: Readonly<Record<string, unknown>>;
  /** Native canonical SHA-256 of the complete immutable specJson. */
  readonly specDigest: Sha256Digest;
  /** Exact identity of the ordered existing-event catalog used for matching. */
  readonly catalogDigest: Sha256Digest;
  readonly executionMode: ChronicleExecutionMode;
  /** Defensive copy used by execution after the Run has been sealed. */
  readonly existingEvents: readonly ExistingChronicleEventCatalogRecord[];
}

const EVENT_SENTENCE_PATTERN =
  /[^。]*?(?:切れ|倒れた|崩れ落ちた|焼失した|避難した|移動を始めた|倒壊し|発令され|退避させた)[^。]*。/gu;

const NEGATED_EVENT_PATTERN = /(?:倒れていない|増えていなかった|動かず)/u;

const PLANNED_EVENT_PATTERN = /(?:しよう|するつもり|もし.+れば)/u;

export interface ChronicleExtractionRequest {
  readonly projectId: string;
  readonly folderId: string;
  readonly language: string;
  readonly sceneIds: readonly string[];
  readonly authority: MutationAuthority;
  readonly runId?: string;
  /**
   * Continue one already-created Chronicle Run after a process restart. This
   * mode never creates a Run and therefore requires its exact durable runId.
   */
  readonly resume?: boolean;
  readonly specDigest?: string;
  readonly existingEvents?: readonly ExistingChronicleEventCatalogRecord[];
  /** Optional evidence protocol override; omitted AI runs use citation-id-v2. */
  readonly evidenceMode?: ObservationEvidenceMode;
}

export interface ChronicleExtractionResult {
  readonly runId: string;
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly proposals: readonly CreateChronicleEventProposalPayloadV1[];
  readonly savedProposalSetId: string;
  /**
   * Fresh terminalization has only Native save rows; completed-run hydration
   * additionally carries the current human revision payload and decision
   * choice so the review projection never pairs a mutable revision id with
   * the immutable plan artifact payload.
   */
  readonly savedProposals: readonly ChronicleSavedProposalSeed[];
}

export interface ChronicleSavedProposalSeed extends SavedProposalSeed {
  readonly payload?: CreateChronicleEventProposalPayloadV1;
  readonly probableDuplicateChoice?:
    | "create-as-new"
    | "skip-as-same"
    | "hold"
    | null;
}

export interface ExtractionCoordinatorDeps {
  readonly leaseOwner?: string;
  readonly buildSnapshot?: typeof buildProjectNarrativeSnapshot;
  readonly snapshotServices?: ProjectSnapshotAdapterServices;
  readonly createId?: () => string;
  /** When true, observation/synthesis stages call Stage AI paths. Default: fake regex. */
  readonly useAi?: boolean;
  /** Explicit production evidence protocol; request.evidenceMode wins. */
  readonly evidenceMode?: ObservationEvidenceMode;
  readonly observeWithAi?: typeof runObservationExtractionTask;
  readonly synthesizeWithAi?: typeof runEventSynthesisTask;
  /** Test seam for the post-Snapshot WebCrypto yield before Run creation. */
  readonly digestSnapshotPayload?: typeof digestStableJson;
}

interface SnapshotArtifactPayload {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly sourceViews: readonly NarrativeSourceView[];
  /**
   * Exact ordered catalog used by the matching stage.  The digest is already
   * sealed by the Run spec; retaining the bytes alongside the snapshot lets a
   * cold process reconstruct that same request instead of consulting mutable
   * live Chronicle state.
   */
  readonly existingEventsCatalog?: {
    readonly kind: "chronicle.existing-events-catalog@1";
    readonly events: readonly ExistingChronicleEventCatalogRecord[];
  };
  /**
   * Sealed alongside the corpus so later historical Scope validation never
   * falls back to the live tree. The order is exactly snapshot.documents.
   */
  readonly scopeAuthorityDocuments: readonly {
    readonly documentRef: string;
    readonly sourceKey: `project:scene:${string}`;
    readonly rawStoryKey: string | null;
  }[];
  /** Additive, explicit evidence protocol/catalog companion for cold resume. */
  readonly evidence?: SnapshotEvidenceCompanion;
}

interface SnapshotEvidenceCompanion {
  readonly kind: "chronicle.snapshot-evidence-companion@1";
  readonly version: 1;
  readonly mode: ObservationEvidenceMode;
  readonly catalogVersion: number | null;
  readonly catalogDigest: Sha256Digest | null;
  readonly snapshotDigest: Sha256Digest;
  readonly snapshotArtifactDigest: Sha256Digest;
  readonly catalog: EvidenceSpanCatalog | null;
}

interface WindowPlanArtifactPayload {
  readonly windows: readonly ExtractionWindow[];
}

interface ObservationArtifactPayload {
  readonly observations: readonly RawChronicleEventObservation[];
}

interface ResolvedEvidenceArtifactPayload {
  readonly anchors: readonly ResolvedEvidenceAnchor[];
}

interface ClusterArtifactPayload {
  readonly clusters: readonly {
    readonly clusterRef: string;
    readonly observationRefs: readonly string[];
    readonly blockingKey?: string;
  }[];
}

interface HypothesisArtifactPayload {
  readonly hypotheses: readonly EventHypothesis[];
  readonly rejectedClusters?: readonly RejectedSynthesisCluster[];
}

interface MatchArtifactPayload {
  readonly matches: readonly {
    readonly hypothesisId: string;
    readonly match: ChronicleExistingMatch;
  }[];
}

interface ProposalPlanArtifactPayload {
  readonly rejectedHypotheses?: readonly RejectedHypothesisActuality[];
  readonly rejectedClusters?: readonly RejectedSynthesisCluster[];
  readonly proposals: readonly CreateChronicleEventProposalPayloadV1[];
  readonly proposalSetId?: string;
  /** Planned rows including match metadata for Review UI (PR4). */
  readonly planned?: readonly {
    readonly proposal: CreateChronicleEventProposalPayloadV1;
    readonly match: ChronicleExistingMatch;
    readonly hypothesisId: string;
  }[];
  readonly alreadySatisfied?: readonly {
    readonly hypothesisId: string;
    readonly title: string;
    readonly existingRef: string;
  }[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resumeFailure(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function cloneExistingEventCatalog(
  catalog: readonly ExistingChronicleEventCatalogRecord[],
): readonly ExistingChronicleEventCatalogRecord[] {
  // Preserve catalog order: matching can select the first title/provenance
  // candidate, so sorting would silently change execution semantics.  Clone
  // every matching input instead so mutation by a caller after Run creation
  // cannot alter the sealed decision surface.
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

/**
 * Snapshot all request coordinates before any asynchronous work.  The caller
 * owns this object and may mutate its arrays/records after dispatch; only the
 * returned copy is allowed to reach a claimed Task.
 */
function captureChronicleExtractionRequest(
  request: ChronicleExtractionRequest,
): ChronicleExtractionRequest {
  // `MutationAuthority` is otherwise a mutable caller-owned record. Capture
  // its scalar workspace coordinates before the first async spec digest so a
  // caller cannot dispatch under one workspace and have the snapshot task
  // observe another after yielding.
  const authority: MutationAuthority = {
    projectId: request.authority.projectId,
    currentProjectId: request.authority.currentProjectId,
    workspacePath: request.authority.workspacePath,
    workspaceOpenRevision: request.authority.workspaceOpenRevision,
  };
  return {
    projectId: request.projectId,
    folderId: request.folderId,
    language: request.language,
    sceneIds: [...request.sceneIds],
    authority,
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.resume === undefined ? {} : { resume: request.resume }),
    ...(request.specDigest === undefined
      ? {}
      : { specDigest: request.specDigest }),
    existingEvents: cloneExistingEventCatalog(request.existingEvents ?? []),
    ...(request.evidenceMode === undefined
      ? {}
      : { evidenceMode: request.evidenceMode }),
  };
}

function resolveCoordinatorEvidenceMode(
  request: ChronicleExtractionRequest,
  deps: ExtractionCoordinatorDeps,
): ObservationEvidenceMode {
  if (request.evidenceMode !== undefined) return request.evidenceMode;
  if (deps.evidenceMode !== undefined) return deps.evidenceMode;
  // The coordinator's new AI lane is citation-first regardless of which
  // transport implementation is injected. Historical callers must opt into
  // legacy-v1 explicitly rather than changing protocol by swapping a seam.
  return deps.useAi
    ? CITATION_ID_OBSERVATION_EVIDENCE_MODE
    : LEGACY_OBSERVATION_EVIDENCE_MODE;
}

function evidenceModeFromCoverage(
  coverage: Readonly<Record<string, unknown>> | null | undefined,
): ObservationEvidenceMode | undefined {
  const mode = coverage?.evidenceMode;
  return mode === LEGACY_OBSERVATION_EVIDENCE_MODE ||
    mode === CITATION_ID_OBSERVATION_EVIDENCE_MODE
    ? mode
    : undefined;
}

async function buildSealedChronicleRunSpec(
  request: ChronicleExtractionRequest,
  deps: ExtractionCoordinatorDeps,
): Promise<SealedChronicleRunSpec> {
  // Capture mutable caller inputs before the first async digest operation.
  // `existingEvents` itself is cloned below; these scalars otherwise could be
  // changed while WebCrypto is computing the catalog digest.
  const requestedCoordinatorContractDigest = request.specDigest;
  const requestedExecutionMode: ChronicleExecutionMode = deps.useAi
    ? "ai"
    : "deterministic-fallback";
  const existingEvents = cloneExistingEventCatalog(
    request.existingEvents ?? [],
  );
  const catalogDigest = await digestStableJson({
    kind: "chronicle.existing-events-catalog@1",
    events: existingEvents,
  });
  const coordinatorContractDigest =
    requestedCoordinatorContractDigest ??
    (await digestStableJson({
      kind: "chronicle.extract.coordinator-contract@1",
      version: 1,
    }));
  if (!/^sha256:[0-9a-f]{64}$/u.test(coordinatorContractDigest)) {
    throw new Error(
      "NEX_CHRONICLE_RUN_SPEC_INVALID: specDigest must be a lowercase sha256 coordinator contract digest",
    );
  }
  const executionMode = requestedExecutionMode;
  const specJson = {
    kind: CHRONICLE_EXTRACT_RUN_SPEC_KIND,
    domain: "chronicle",
    version: 2,
    taskChain: [...CHRONICLE_EXTRACT_DAG],
    executionMode,
    existingEventsCatalogDigest: catalogDigest,
    coordinatorContractDigest,
  } as const;
  return {
    specJson,
    specDigest: await digestStableJson(specJson),
    catalogDigest,
    executionMode,
    existingEvents,
  };
}

function canonicalJsonEquals(left: unknown, right: unknown): boolean {
  try {
    return stableJsonStringify(left) === stableJsonStringify(right);
  } catch {
    return false;
  }
}

function chroniclePlanProposalSetId(runId: string, taskId: string): string {
  return `chronicle-plan-proposals:${runId}:${taskId}`;
}

function probableDuplicateChoiceFromDecisionJson(
  decisionJson: Readonly<Record<string, unknown>> | undefined,
): ChronicleSavedProposalSeed["probableDuplicateChoice"] {
  const choice = decisionJson?.probableDuplicateChoice;
  return choice === "create-as-new" ||
    choice === "skip-as-same" ||
    choice === "hold"
    ? choice
    : null;
}

function hydrateCompletedPlanProposalSet(
  bundle: GetRunReviewBundleResult,
  runId: string,
  task: NarrativeExtractionTask,
): {
  readonly proposalSetId: string;
  readonly proposals: readonly ChronicleSavedProposalSeed[];
} {
  const expectedProposalSetId = chroniclePlanProposalSetId(runId, task.taskId);
  const outputProposalSetId = task.outputJson?.proposalSetId;
  const outputProposalCount = task.outputJson?.proposalCount;
  if (
    outputProposalSetId !== expectedProposalSetId ||
    typeof outputProposalCount !== "number" ||
    !Number.isSafeInteger(outputProposalCount) ||
    outputProposalCount < 0
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT",
      "completed plan Task does not bind its deterministic ProposalSet output",
    );
  }
  const proposalSet = bundle.proposalSet;
  if (
    !proposalSet ||
    proposalSet.proposalSetId !== expectedProposalSetId ||
    proposalSet.runId !== runId ||
    proposalSet.setKind !== "chronicle.extract.review@1" ||
    bundle.proposals.length !== outputProposalCount
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT",
      "Native review bundle does not exactly match the completed plan Task",
    );
  }
  const proposalKeys = new Set<string>();
  const proposals = bundle.proposals.map((proposal) => {
    if (
      proposal.proposalSetId !== expectedProposalSetId ||
      !proposal.currentRevisionId ||
      !proposalKeys.add(proposal.proposalKey)
    ) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT",
        "Native review bundle has an invalid terminal ProposalSet proposal roster",
      );
    }
    const currentPayload = proposal.payloadJson;
    try {
      assertChronicleProposalPayload(currentPayload);
    } catch {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_PROPOSAL_SET_INCONSISTENT",
        "Native review bundle has no valid current Chronicle payload for a terminal proposal",
      );
    }
    const probableDuplicateChoice = probableDuplicateChoiceFromDecisionJson(
      proposal.latestDecision?.revisionId === proposal.currentRevisionId
        ? proposal.latestDecision.decisionJson
        : undefined,
    );
    return {
      proposalId: proposal.proposalId,
      proposalKey: proposal.proposalKey,
      revisionId: proposal.currentRevisionId,
      status: proposal.status,
      payload: currentPayload,
      ...(proposal.originKind ? { originKind: proposal.originKind } : {}),
      ...(proposal.reconciliationEnvelopeDigest
        ? {
            reconciliationEnvelopeDigest: proposal.reconciliationEnvelopeDigest,
          }
        : {}),
      ...(proposal.reconciliationEnvelopeSchemaVersion
        ? {
            reconciliationEnvelopeSchemaVersion:
              proposal.reconciliationEnvelopeSchemaVersion,
          }
        : {}),
      ...(probableDuplicateChoice ? { probableDuplicateChoice } : {}),
    } satisfies ChronicleSavedProposalSeed;
  });
  return { proposalSetId: expectedProposalSetId, proposals };
}

/**
 * A restart must continue the exact sealed Run rather than treating `runId`
 * as a suggestion for a new/reclaimed run.  Validate the durable topology
 * before claiming a single task so a caller cannot combine an old snapshot
 * with a new scope or a different DAG.
 */
function indexResumableChronicleRun(
  projection: NarrativeExtractionRunProjection,
  request: ChronicleExtractionRequest,
  sealedSpec: SealedChronicleRunSpec,
): ReadonlyMap<string, NarrativeExtractionTask> {
  const { run } = projection;
  if (run.projectId !== request.projectId) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_RUN_MISMATCH",
      "durable Run belongs to another project",
    );
  }
  if (run.surfacePathId !== CHRONICLE_EXTRACT_SURFACE_PATH) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_RUN_MISMATCH",
      "durable Run does not use the Chronicle extraction surface",
    );
  }
  if (run.status !== "running" && run.status !== "completed") {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_RUN_NOT_RUNNING",
      `durable Run status is '${run.status}'`,
    );
  }
  if (
    run.specDigest !== sealedSpec.specDigest ||
    run.catalogDigest !== sealedSpec.catalogDigest ||
    !canonicalJsonEquals(run.specJson, sealedSpec.specJson)
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_SPEC_MISMATCH",
      "requested Chronicle execution mode, catalog, or canonical specification differs from the sealed Run",
    );
  }
  const scope = run.scopeJson;
  const sealedSceneIds = scope.sceneIds;
  if (
    scope.folderId !== request.folderId ||
    !Array.isArray(sealedSceneIds) ||
    sealedSceneIds.length !== request.sceneIds.length ||
    sealedSceneIds.some(
      (sceneId, index) =>
        typeof sceneId !== "string" || sceneId !== request.sceneIds[index],
    )
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_SCOPE_MISMATCH",
      "requested folder/scene scope differs from the sealed Run",
    );
  }
  if (!run.snapshotDigest || run.snapshotDigest.trim().length === 0) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_SNAPSHOT_MISSING",
      "durable Run has no sealed snapshot digest",
    );
  }

  const tasks = new Map<string, NarrativeExtractionTask>();
  for (const task of projection.tasks) {
    if (
      !CHRONICLE_EXTRACT_DAG.some((expected) => expected === task.taskKind) ||
      tasks.has(task.taskKind)
    ) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID",
        "durable Run task topology is not the exact Chronicle DAG",
      );
    }
    if (
      task.status !== "queued" &&
      task.status !== "running" &&
      task.status !== "completed"
    ) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID",
        `Task '${task.taskKind}' has terminal status '${task.status}'`,
      );
    }
    tasks.set(task.taskKind, task);
  }
  if (
    tasks.size !== CHRONICLE_EXTRACT_DAG.length ||
    CHRONICLE_EXTRACT_DAG.some((taskKind) => !tasks.has(taskKind))
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID",
      "durable Run is missing or duplicating Chronicle DAG tasks",
    );
  }
  // Chronicle is a sequential DAG. A completed suffix after an incomplete
  // task is evidence of an out-of-order/public-IPC terminalization, not a
  // resumable prefix. Do not claim any later work against that ledger.
  let encounteredIncompleteTask = false;
  for (const taskKind of CHRONICLE_EXTRACT_DAG) {
    const task = tasks.get(taskKind);
    if (!task) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID",
        "durable Run lost a Chronicle DAG task during prefix validation",
      );
    }
    if (task.status === "completed") {
      if (encounteredIncompleteTask) {
        resumeFailure(
          "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID",
          "durable Run has a completed Chronicle Task after an incomplete predecessor",
        );
      }
      continue;
    }
    if (task.status === "running" && encounteredIncompleteTask) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID",
        "durable Run has a running Chronicle Task after an incomplete predecessor",
      );
    }
    encounteredIncompleteTask = true;
  }
  if (
    run.status === "completed" &&
    [...tasks.values()].some((task) => task.status !== "completed")
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID",
      "completed Run has a non-completed Chronicle Task",
    );
  }
  const snapshotTask = tasks.get(CHRONICLE_EXTRACT_TASK_KINDS.snapshot);
  if (
    !snapshotTask ||
    snapshotTask.status !== "completed" ||
    snapshotTask.outputJson?.snapshotDigest !== run.snapshotDigest
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_SNAPSHOT_MISSING",
      "source.snapshot@1 was not durably completed against the Run snapshot digest",
    );
  }
  return tasks;
}

function assertResumedSnapshotPayload(
  payload: SnapshotArtifactPayload | null,
  expectedSnapshotDigest: string,
): SnapshotArtifactPayload {
  if (!isRecord(payload) || !isRecord(payload.snapshot)) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_SNAPSHOT_MISSING",
      "source.snapshot@1 artifact is absent or malformed",
    );
  }
  const snapshot = payload.snapshot;
  if (
    snapshot.digest !== expectedSnapshotDigest ||
    !Array.isArray(snapshot.documents) ||
    !Array.isArray(payload.sourceViews) ||
    !Array.isArray(payload.scopeAuthorityDocuments) ||
    payload.scopeAuthorityDocuments.length !== snapshot.documents.length
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH",
      "source.snapshot@1 artifact does not match its sealed Run coordinates",
    );
  }
  for (let index = 0; index < snapshot.documents.length; index += 1) {
    const document = snapshot.documents[index];
    const authorityDocument = payload.scopeAuthorityDocuments[index];
    if (
      !document ||
      !authorityDocument ||
      document.ref !== authorityDocument.documentRef ||
      document.sourceKey !== authorityDocument.sourceKey ||
      !authorityDocument.sourceKey.startsWith("project:scene:") ||
      (authorityDocument.rawStoryKey !== null &&
        typeof authorityDocument.rawStoryKey !== "string")
    ) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH",
        "source.snapshot@1 authority documents are not a sealed one-to-one corpus companion",
      );
    }
  }
  return payload;
}

async function resolveResumedExistingEventsCatalog(
  payload: SnapshotArtifactPayload,
  sealedSpec: SealedChronicleRunSpec,
): Promise<readonly ExistingChronicleEventCatalogRecord[]> {
  const durableCatalog = payload.existingEventsCatalog;
  if (durableCatalog === undefined) {
    // Compatibility for already-created @2 Runs. The caller-provided catalog
    // has passed the full spec/catalog CAS before this point; product discovery
    // classifies rows without the durable companion as blocked, so only an
    // explicit direct resume can take this legacy seam.
    return cloneExistingEventCatalog(sealedSpec.existingEvents);
  }
  if (
    durableCatalog.kind !== "chronicle.existing-events-catalog@1" ||
    !Array.isArray(durableCatalog.events)
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_CATALOG_MALFORMED",
      "source.snapshot@1 has no valid sealed existing-event catalog",
    );
  }
  const durableDigest = await digestStableJson({
    kind: durableCatalog.kind,
    events: durableCatalog.events,
  });
  if (durableDigest !== sealedSpec.catalogDigest) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_CATALOG_MISMATCH",
      "source.snapshot@1 existing-event catalog differs from the sealed Run spec",
    );
  }
  return cloneExistingEventCatalog(durableCatalog.events);
}

async function loadCoordinatorInlineArtifact<T extends object>(
  runId: string,
  authority: MutationAuthority,
  artifactKind: string,
  requireNativeConfirmation = false,
): Promise<T | null> {
  return loadInlineJsonArtifact<T>(runId, artifactKind, {
    scope: artifactCacheScope(authority),
    requireNativeConfirmation,
  });
}

function artifactCacheScope(
  authority: MutationAuthority,
): NarrativeArtifactCacheScope {
  return {
    projectId: authority.projectId,
    workspacePath: authority.workspacePath,
    workspaceOpenRevision: authority.workspaceOpenRevision,
  };
}

async function assertCompletedResumeArtifacts(
  runId: string,
  authority: MutationAuthority,
  tasks: ReadonlyMap<string, NarrativeExtractionTask>,
): Promise<void> {
  const artifactsByTask: readonly (readonly [string, string])[] = [
    [
      CHRONICLE_EXTRACT_TASK_KINDS.windowPlan,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.windowPlan,
    ],
    [
      CHRONICLE_EXTRACT_TASK_KINDS.observe,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
    ],
    [
      CHRONICLE_EXTRACT_TASK_KINDS.resolveEvidence,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
    ],
    [
      CHRONICLE_EXTRACT_TASK_KINDS.mergeObservations,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
    ],
    [
      CHRONICLE_EXTRACT_TASK_KINDS.cluster,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.clusters,
    ],
    [
      CHRONICLE_EXTRACT_TASK_KINDS.synthesize,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
    ],
    [
      CHRONICLE_EXTRACT_TASK_KINDS.matchExisting,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.matches,
    ],
    [
      CHRONICLE_EXTRACT_TASK_KINDS.planProposals,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
    ],
  ];
  for (const [taskKind, artifactKind] of artifactsByTask) {
    if (tasks.get(taskKind)?.status !== "completed") continue;
    const artifact = await loadCoordinatorInlineArtifact(
      runId,
      authority,
      artifactKind,
      true,
    );
    if (!isRecord(artifact)) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_ARTIFACT_MISSING",
        `completed Task '${taskKind}' has no durable '${artifactKind}' artifact`,
      );
    }
  }
}

function hasAcceptedObservationTerminal(
  receipts: readonly ChronicleStageTerminalReceiptV1[],
  taskId: string,
): boolean {
  const roots = receipts.filter(
    (receipt) =>
      receipt.stageExecution.stageId ===
        NARRATIVE_STAGE_IDS.observationExtraction &&
      receipt.stageExecution.taskId === taskId &&
      receipt.stageExecution.parentStageExecutionId === undefined,
  );
  return roots.some((root) => {
    if (root.parseStatus === "parsed" && root.terminalStatus === "succeeded") {
      return true;
    }
    return (
      root.parseStatus === "invalid" &&
      root.terminalStatus === "failed" &&
      receipts.some(
        (receipt) =>
          receipt.stageExecution.parentStageExecutionId ===
            root.stageExecution.stageExecutionId &&
          receipt.stageExecution.taskId === root.stageExecution.taskId &&
          receipt.stageExecution.attemptId === root.stageExecution.attemptId &&
          receipt.parseStatus === "parsed" &&
          receipt.terminalStatus === "succeeded",
      )
    );
  });
}

function compareStageExecutionIds(
  left: ChronicleStageTerminalReceiptV1,
  right: ChronicleStageTerminalReceiptV1,
): number {
  const leftId = left.stageExecution.stageExecutionId;
  const rightId = right.stageExecution.stageExecutionId;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** Build the transport-only Native C1 binding; the closure is never stored. */
async function buildChronicleStageC1Bundle(input: {
  readonly projectId: string;
  readonly runId: string;
  readonly closureAggregatorTaskId: string;
  readonly closureAggregatorAttemptId: string;
  readonly receipts: readonly ChronicleStageTerminalReceiptV1[];
  /** Roots that actually produced an accepted typed terminal output. */
  readonly acceptedTerminalOutputRootIds: readonly string[];
}): Promise<ChronicleStageC1ExecutionBinding> {
  const acceptedRootIds = new Set(input.acceptedTerminalOutputRootIds);
  if (acceptedRootIds.size !== input.acceptedTerminalOutputRootIds.length) {
    throw new Error(
      "NEX_CHRONICLE_STAGE_BUNDLE_OWNER_AMBIGUOUS: duplicate accepted synthesis terminal roots",
    );
  }
  const roots = input.receipts
    .filter(
      (receipt) =>
        receipt.stageExecution.stageId === NARRATIVE_STAGE_IDS.eventSynthesis &&
        receipt.stageExecution.parentStageExecutionId === undefined &&
        acceptedRootIds.has(receipt.stageExecution.stageExecutionId),
    )
    .sort(compareStageExecutionIds);
  const owner = roots[0];
  if (!owner) {
    throw new Error(
      "NEX_CHRONICLE_STAGE_BUNDLE_OWNER_MISSING: no synthesis stage execution was recorded",
    );
  }
  const closure = await buildChronicleStageProvenanceClosureV1({
    projectId: input.projectId,
    runId: input.runId,
    ownerTaskId: input.closureAggregatorTaskId,
    ownerAttemptId: input.closureAggregatorAttemptId,
    receipts: input.receipts,
  });
  return {
    projectId: input.projectId,
    runId: input.runId,
    taskId: input.closureAggregatorTaskId,
    attemptId: input.closureAggregatorAttemptId,
    stageExecutionOwnerTaskId: owner.stageExecution.taskId,
    stageExecutionOwnerAttemptId: owner.stageExecution.attemptId,
    stageExecutionOwnerStageExecutionId: owner.stageExecution.stageExecutionId,
    contextSetDigest: owner.contextSetDigest,
    componentContractDigest: owner.componentContractDigest,
    finalRequestDigest: owner.finalRequestDigest,
    stageProvenanceClosureDigest: closure.stageProvenanceClosureDigest,
    closure,
  };
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}

function mergeRanges(ranges: readonly CanonicalRange[]): CanonicalRange {
  const start = Math.min(...ranges.map((range) => range.start));
  const end = Math.max(...ranges.map((range) => range.end));
  return { start, end };
}

async function buildSourceViewsForPlan(
  snapshot: NarrativeCorpusSnapshot,
  plan: WindowPlan,
): Promise<readonly NarrativeSourceView[]> {
  const documentByRef = new Map(
    snapshot.documents.map((document) => [document.ref, document] as const),
  );
  const views: NarrativeSourceView[] = [];
  for (const window of plan.windows) {
    const document = documentByRef.get(window.documentRef);
    if (!document) continue;
    const covering = mergeRanges([
      ...window.ownedRanges,
      ...window.contextRanges,
    ]);
    views.push(
      await buildNarrativeSourceView({
        ref: window.sourceRef,
        document,
        documentRange: covering,
      }),
    );
  }
  return views;
}

function buildEvidenceSpanCatalogWindowInputs(
  snapshot: NarrativeCorpusSnapshot,
  plan: WindowPlan,
  sourceViews: readonly NarrativeSourceView[],
): readonly EvidenceSpanCatalogWindowInput[] {
  const sourceViewByRef = new Map(
    sourceViews.map((sourceView) => [sourceView.ref, sourceView] as const),
  );
  const documentByRef = new Map(
    snapshot.documents.map((document) => [document.ref, document] as const),
  );
  return plan.windows.map((window) => {
    const sourceView = sourceViewByRef.get(window.sourceRef);
    const document = documentByRef.get(window.documentRef);
    if (!sourceView || !document) {
      throw new Error(
        `NEX_CHRONICLE_EVIDENCE_CATALOG_WINDOW_MISSING: ${window.windowId}`,
      );
    }
    return {
      windowId: window.windowId,
      documentRef: document.ref,
      sourceView,
      ownedRanges: window.ownedRanges,
      contextRanges: window.contextRanges,
    };
  });
}

function buildSnapshotEvidenceCompanion(
  snapshot: NarrativeCorpusSnapshot,
  mode: ObservationEvidenceMode,
  catalog: EvidenceSpanCatalog | null,
): SnapshotEvidenceCompanion {
  if (mode === CITATION_ID_OBSERVATION_EVIDENCE_MODE && !catalog) {
    throw new Error(
      "NEX_CHRONICLE_EVIDENCE_CATALOG_MISSING: citation-id-v2 requires a sealed catalog",
    );
  }
  return {
    kind: "chronicle.snapshot-evidence-companion@1",
    version: 1,
    mode,
    catalogVersion: catalog?.version ?? null,
    catalogDigest: catalog?.digest ?? null,
    snapshotDigest: snapshot.digest,
    snapshotArtifactDigest: snapshot.artifactDigest,
    catalog,
  };
}

function assertSnapshotEvidenceCompanionShape(
  companion: unknown,
  snapshot: NarrativeCorpusSnapshot,
  expectedMode?: ObservationEvidenceMode,
): asserts companion is SnapshotEvidenceCompanion {
  if (!isRecord(companion)) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_EVIDENCE_COMPANION_MISSING",
      "source.snapshot@1 has no explicit evidence protocol companion",
    );
  }
  const mode = companion.mode;
  if (
    companion.kind !== "chronicle.snapshot-evidence-companion@1" ||
    companion.version !== 1 ||
    (mode !== LEGACY_OBSERVATION_EVIDENCE_MODE &&
      mode !== CITATION_ID_OBSERVATION_EVIDENCE_MODE) ||
    companion.snapshotDigest !== snapshot.digest ||
    companion.snapshotArtifactDigest !== snapshot.artifactDigest ||
    !(companion.catalog === null || isRecord(companion.catalog))
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_EVIDENCE_COMPANION_MISMATCH",
      "source.snapshot@1 evidence companion identity or mode is inconsistent with the sealed snapshot",
    );
  }
  if (expectedMode !== undefined && mode !== expectedMode) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_EVIDENCE_MODE_MISMATCH",
      "requested evidence mode differs from the mode sealed in source.snapshot@1",
    );
  }
  if (mode === CITATION_ID_OBSERVATION_EVIDENCE_MODE) {
    if (
      companion.catalog === null ||
      companion.catalogDigest !== companion.catalog.digest ||
      companion.catalogVersion !== companion.catalog.version
    ) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_EVIDENCE_CATALOG_MISSING",
        "citation-id-v2 source.snapshot@1 companion has no complete catalog digest",
      );
    }
  } else if (
    companion.catalog !== null ||
    companion.catalogDigest !== null ||
    companion.catalogVersion !== null
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_EVIDENCE_COMPANION_MISMATCH",
      "legacy-v1 source.snapshot@1 companion unexpectedly carries a citation catalog",
    );
  }
}

async function validateResumedEvidenceCompanion(
  payload: SnapshotArtifactPayload,
  requestedMode: ObservationEvidenceMode | undefined,
): Promise<{
  readonly mode: ObservationEvidenceMode;
  readonly catalogCapture?: EvidenceSpanCatalogCapture;
}> {
  const companion = payload.evidence;
  if (companion === undefined) {
    if (requestedMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_EVIDENCE_COMPANION_MISSING",
        "citation-id-v2 resume requires the persisted snapshot evidence companion",
      );
    }
    // Historical @2 artifacts predate this additive companion and remain on
    // their quote-based compatibility lane.
    return { mode: requestedMode ?? LEGACY_OBSERVATION_EVIDENCE_MODE };
  }
  assertSnapshotEvidenceCompanionShape(
    companion,
    payload.snapshot,
    requestedMode,
  );
  if (companion.mode === CITATION_ID_OBSERVATION_EVIDENCE_MODE) {
    let catalogCapture: EvidenceSpanCatalogCapture;
    try {
      // Capture is the resume precheck and the handle later used by every
      // observation window. This keeps the complete persisted catalog
      // validation and entry rebuild to one operation for this run.
      catalogCapture = await captureEvidenceSpanCatalog(
        payload.snapshot,
        companion.catalog!,
      );
    } catch (error) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_EVIDENCE_CATALOG_INVALID",
        error instanceof Error
          ? error.message
          : "persisted evidence catalog validation failed",
      );
    }
    return {
      mode: companion.mode,
      catalogCapture,
    };
  }
  return { mode: companion.mode };
}

function observationActuality(
  sentence: string,
): RawChronicleEventObservation["payload"]["actuality"] {
  if (PLANNED_EVENT_PATTERN.test(sentence)) return "planned";
  if (/したが、.+動かず/u.test(sentence) || /回そうとしたが/u.test(sentence)) {
    return "attempted";
  }
  return "actual";
}

function extractEventSentences(text: string): readonly string[] {
  const matches = [...text.matchAll(EVENT_SENTENCE_PATTERN)].map(
    (match) => match[0]?.trim() ?? "",
  );
  return matches.filter(
    (sentence) =>
      sentence.length > 0 &&
      !NEGATED_EVENT_PATTERN.test(sentence) &&
      !PLANNED_EVENT_PATTERN.test(sentence),
  );
}

export async function observeChronicleEventsFromSnapshot(
  _snapshot: NarrativeCorpusSnapshot,
  sourceViews: readonly NarrativeSourceView[],
  createId: () => string = defaultCreateId,
): Promise<readonly RawChronicleEventObservation[]> {
  const observations: RawChronicleEventObservation[] = [];
  for (const sourceView of sourceViews) {
    for (const sentence of extractEventSentences(sourceView.text)) {
      observations.push({
        localId: createId(),
        evidence: [{ sourceRef: sourceView.ref, quote: sentence }],
        assertion: {
          attribution: "narrator",
          narrativeFrame: "story-world",
        },
        payload: {
          predicate: sentence.replace(/。$/u, ""),
          actuality: observationActuality(sentence),
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      });
    }
  }
  return observations;
}

function evidenceFingerprint(sourceRef: string, quote: string): string {
  return chronicleEvidenceTupleKey(sourceRef, quote);
}

async function resolveObservationEvidence(
  snapshot: NarrativeCorpusSnapshot,
  sourceViews: readonly NarrativeSourceView[],
  observations: readonly RawChronicleEventObservation[],
): Promise<readonly ResolvedEvidenceAnchor[]> {
  let anchorIndex = 0;
  const anchors: ResolvedEvidenceAnchor[] = [];
  for (const observation of observations) {
    for (const evidence of observation.evidence) {
      const resolution = await resolveEvidenceReference(evidence, {
        snapshot,
        sourceViews,
        createAnchorId: () =>
          `anchor-${String(++anchorIndex).padStart(4, "0")}`,
      });
      if (resolution.status === "resolved") {
        anchors.push(resolution.anchor);
      }
    }
  }
  return anchors;
}

function documentSourceKeyForRef(
  snapshot: NarrativeCorpusSnapshot,
  documentRef: string,
): string | null {
  return (
    snapshot.documents.find((document) => document.ref === documentRef)
      ?.sourceKey ?? null
  );
}

async function executeTask(
  taskKind: string,
  runId: string,
  taskExecution: {
    readonly projectId: string;
    readonly taskId: string;
    readonly attemptId: string;
  },
  request: ChronicleExtractionRequest,
  deps: ExtractionCoordinatorDeps,
  createId: () => string,
  stageReceipts: ChronicleStageTerminalReceiptV1[],
  catalogCapture?: EvidenceSpanCatalogCapture,
): Promise<{
  outputJson: Readonly<Record<string, unknown>>;
  artifacts: ReturnType<typeof buildInlineJsonArtifact>[];
  chronicleStageBundle?: ChronicleStageC1ExecutionBinding;
}> {
  switch (taskKind) {
    case CHRONICLE_EXTRACT_TASK_KINDS.snapshot: {
      throw new Error(
        "source.snapshot@1 must be seeded before the coordinator loop",
      );
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.windowPlan: {
      const snapshotPayload =
        await loadCoordinatorInlineArtifact<SnapshotArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
          request.resume === true,
        );
      if (!snapshotPayload) {
        throw new Error("Missing source.snapshot@1 artifact");
      }
      const plan = planExtractionWindows(snapshotPayload.snapshot);
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.windowPlan,
        { windows: plan.windows },
      );
      return {
        outputJson: { windowCount: plan.windows.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.observe: {
      const snapshotPayload =
        await loadCoordinatorInlineArtifact<SnapshotArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
          request.resume === true,
        );
      const windowPayload =
        await loadCoordinatorInlineArtifact<WindowPlanArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.windowPlan,
          request.resume === true,
        );
      if (!snapshotPayload || !windowPayload) {
        throw new Error("Missing snapshot or window-plan artifacts");
      }

      let observations: readonly RawChronicleEventObservation[];
      const evidenceMode =
        request.evidenceMode ?? LEGACY_OBSERVATION_EVIDENCE_MODE;
      if (deps.useAi) {
        const observe = deps.observeWithAi ?? runObservationExtractionTask;
        const sourceByRef = new Map(
          snapshotPayload.sourceViews.map((view) => [view.ref, view] as const),
        );
        const collected: RawChronicleEventObservation[] = [];
        let citationCatalog: EvidenceSpanCatalog | undefined;
        let verifiedCatalogCapture = catalogCapture;
        let bindingCatalogCapture: EvidenceSpanCatalogCapture | undefined;
        let catalogWindowInputs: readonly EvidenceSpanCatalogWindowInput[] = [];
        if (evidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE) {
          const companion = snapshotPayload.evidence;
          if (
            !companion ||
            companion.mode !== CITATION_ID_OBSERVATION_EVIDENCE_MODE ||
            !companion.catalog
          ) {
            throw new Error(
              "NEX_CHRONICLE_EVIDENCE_CATALOG_MISSING: citation-id-v2 observation requires the sealed snapshot catalog",
            );
          }
          if (!verifiedCatalogCapture) {
            try {
              verifiedCatalogCapture = await captureEvidenceSpanCatalog(
                snapshotPayload.snapshot,
                companion.catalog,
              );
            } catch (error) {
              throw new Error(
                `NEX_CHRONICLE_EVIDENCE_CATALOG_INVALID: ${
                  error instanceof Error
                    ? error.message
                    : "persisted evidence catalog validation failed"
                }`,
                { cause: error },
              );
            }
          }
          if (!verifiedCatalogCapture) {
            throw new Error(
              "NEX_CHRONICLE_EVIDENCE_CATALOG_CAPTURE_MISSING: citation-id-v2 observation has no verified catalog capture",
            );
          }
          bindingCatalogCapture = verifiedCatalogCapture;
          try {
            assertEvidenceSpanCatalogCaptureMatches(
              verifiedCatalogCapture,
              snapshotPayload.snapshot,
              companion.catalog,
            );
          } catch (error) {
            throw new Error(
              `NEX_CHRONICLE_EVIDENCE_CATALOG_CAPTURE_MISMATCH: ${
                error instanceof Error
                  ? error.message
                  : "verified catalog capture does not match the loaded artifact"
              }`,
              { cause: error },
            );
          }
          citationCatalog = companion.catalog;
          catalogWindowInputs = buildEvidenceSpanCatalogWindowInputs(
            snapshotPayload.snapshot,
            { windows: windowPayload.windows },
            snapshotPayload.sourceViews,
          );
          // This check intentionally happens before the first provider call.
          // A hole must fail the whole observe task, never dispatch a partial
          // planner roster and silently lose catalog occurrences.
          assertCapturedEvidenceSpanCatalogCoverage(
            verifiedCatalogCapture,
            catalogWindowInputs,
          );
        }
        for (const window of windowPayload.windows) {
          const view = sourceByRef.get(window.sourceRef);
          if (!view) {
            throw new Error(
              `NEX_CHRONICLE_SOURCE_VIEW_MISSING: ${window.sourceRef}`,
            );
          }
          let evidenceSpanCatalogBinding:
            | EvidenceSpanCatalogBinding
            | undefined;
          if (citationCatalog) {
            if (!bindingCatalogCapture) {
              throw new Error(
                "NEX_CHRONICLE_EVIDENCE_CATALOG_CAPTURE_MISSING: citation-id-v2 observation has no verified catalog capture",
              );
            }
            const windowInput = catalogWindowInputs.find(
              (candidate) => candidate.windowId === window.windowId,
            );
            if (!windowInput) {
              throw new Error(
                `NEX_CHRONICLE_EVIDENCE_CATALOG_WINDOW_MISSING: ${window.windowId}`,
              );
            }
            evidenceSpanCatalogBinding = await bindCapturedEvidenceSpanCatalog(
              bindingCatalogCapture,
              {
                requestIdentity: `run:${runId}:task:${taskExecution.taskId}:attempt:${taskExecution.attemptId}:window:${window.windowId}`,
                windows: [windowInput],
              },
            );
          }
          const batch = await observe({
            windows: [
              {
                windowId: window.windowId,
                sourceRef: window.sourceRef,
                text: view.text,
              },
            ],
            ...(evidenceSpanCatalogBinding
              ? {
                  evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
                  evidenceSpanCatalogBinding,
                }
              : {}),
            projectId: request.projectId,
            createId,
            stageExecution: createStageExecutionContext({
              projectId: taskExecution.projectId,
              runId,
              taskId: taskExecution.taskId,
              attemptId: taskExecution.attemptId,
              stageId: NARRATIVE_STAGE_IDS.observationExtraction,
              stageExecutionId: createId(),
            }),
            createStageExecutionId: createId,
            onStageReceipt: (receipt) => {
              stageReceipts.push(receipt);
            },
          });
          collected.push(...rekeyObservationsForWindow(window.windowId, batch));
        }
        observations = collected;
      } else {
        observations = await observeChronicleEventsFromSnapshot(
          snapshotPayload.snapshot,
          snapshotPayload.sourceViews,
          createId,
        );
      }
      assertUniqueObservationLocalIds(observations);

      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
        { observations },
      );
      return {
        outputJson: { observationCount: observations.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.resolveEvidence: {
      const snapshotPayload =
        await loadCoordinatorInlineArtifact<SnapshotArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
          request.resume === true,
        );
      const observationPayload =
        await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
          request.resume === true,
        );
      if (!snapshotPayload || !observationPayload) {
        throw new Error("Missing snapshot or observation artifacts");
      }
      const anchors = await resolveObservationEvidence(
        snapshotPayload.snapshot,
        snapshotPayload.evidence?.catalog
          ? [
              ...snapshotPayload.sourceViews,
              ...snapshotPayload.evidence.catalog.entries.map(
                (entry) => entry.sourceView,
              ),
            ]
          : snapshotPayload.sourceViews,
        observationPayload.observations,
      );
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
        { anchors },
      );
      return {
        outputJson: { anchorCount: anchors.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.mergeObservations: {
      const observationPayload =
        await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
          request.resume === true,
        );
      if (!observationPayload) {
        throw new Error("Missing observation artifact");
      }
      const observations = mergeObservationsByEvidence(
        observationPayload.observations,
      );
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
        { observations },
      );
      return {
        outputJson: { observationCount: observations.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.cluster: {
      const mergedPayload =
        await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
          request.resume === true,
        );
      if (!mergedPayload) {
        throw new Error("Missing merged observation artifact");
      }
      const clusters = clusterEventObservations(mergedPayload.observations);
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.clusters,
        { clusters },
      );
      return {
        outputJson: { clusterCount: clusters.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.synthesize: {
      const mergedPayload =
        await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
          request.resume === true,
        );
      const clusterPayload =
        await loadCoordinatorInlineArtifact<ClusterArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.clusters,
          request.resume === true,
        );
      if (!mergedPayload || !clusterPayload) {
        throw new Error("Missing merge/cluster artifacts");
      }

      let hypotheses: readonly EventHypothesis[];
      let rejectedClusters: readonly RejectedSynthesisCluster[] = [];
      const terminalOutputs: ChronicleSynthesisTerminalOutput[] = [];
      if (deps.useAi) {
        const synthesize = deps.synthesizeWithAi ?? runEventSynthesisTask;
        const observationById = new Map(
          mergedPayload.observations.map(
            (observation) => [observation.localId, observation] as const,
          ),
        );
        const collected: EventHypothesis[] = [];
        for (const cluster of clusterPayload.clusters) {
          const clusterObservations = cluster.observationRefs
            .map((ref) => observationById.get(ref))
            .filter(
              (observation): observation is RawChronicleEventObservation =>
                observation !== undefined,
            );
          const batch = await synthesize({
            clusterRef: cluster.clusterRef,
            observations: clusterObservations,
            projectId: request.projectId,
            createId,
            stageExecution: createStageExecutionContext({
              projectId: taskExecution.projectId,
              runId,
              taskId: taskExecution.taskId,
              attemptId: taskExecution.attemptId,
              stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
              stageExecutionId: createId(),
            }),
            createStageExecutionId: createId,
            onStageReceipt: (receipt) => {
              stageReceipts.push(receipt);
            },
            onTerminalOutput: (terminalOutput) => {
              terminalOutputs.push(terminalOutput);
            },
          });
          collected.push(...batch);
        }
        hypotheses = collected;
      } else {
        const fallback = synthesizeHypothesesFromClusters(
          clusterPayload.clusters,
          mergedPayload.observations,
          createId,
        );
        hypotheses = fallback.hypotheses;
        rejectedClusters = fallback.rejectedClusters;
      }

      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
        {
          hypotheses,
          ...(rejectedClusters.length > 0 ? { rejectedClusters } : {}),
        },
      );
      if (deps.useAi && clusterPayload.clusters.length > 0) {
        const expectedClusters = new Set(
          clusterPayload.clusters.map((cluster) => cluster.clusterRef),
        );
        const terminalRoots = new Set(
          terminalOutputs.map(
            (terminalOutput) =>
              terminalOutput.rootStageExecution.stageExecutionId,
          ),
        );
        const terminalClusters = new Set(
          terminalOutputs.map((terminalOutput) => terminalOutput.clusterRef),
        );
        if (
          expectedClusters.size !== clusterPayload.clusters.length ||
          terminalOutputs.length !== clusterPayload.clusters.length ||
          terminalRoots.size !== terminalOutputs.length ||
          terminalClusters.size !== terminalOutputs.length ||
          [...expectedClusters].some(
            (clusterRef) => !terminalClusters.has(clusterRef),
          )
        ) {
          throw new Error(
            "NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED: every dispatched synthesis cluster requires exactly one accepted typed terminal output",
          );
        }
        const outputs = await Promise.all(
          terminalOutputs.map(async (terminalOutput) => ({
            rootStageExecutionId:
              terminalOutput.rootStageExecution.stageExecutionId,
            terminalStageExecutionId:
              terminalOutput.terminalStageExecution.stageExecutionId,
            disposition: terminalOutput.disposition,
            clusterRef: terminalOutput.clusterRef,
            rawObservations: {
              kind: "chronicle.raw-observations@1",
              version: 1,
              observations: terminalOutput.rawObservations,
            },
            eventOutput: terminalOutput.eventOutput,
            output: {
              kind: "chronicle.event-synthesis-output@1",
              observationCount: terminalOutput.rawObservations.length,
              eventCount: terminalOutput.hypotheses.length,
              observationRefs: terminalOutput.rawObservations.map(
                (observation) => observation.localId,
              ),
              rawObservationsDigest: terminalOutput.rawObservationsDigest,
              parsedOutputDigest: terminalOutput.parsedOutputDigest,
              eventOutputDigest: await digestStableJson(
                terminalOutput.eventOutput,
              ),
            },
          })),
        );
        const companion = buildInlineJsonArtifact(
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.stageSynthesisOutputs,
          {
            kind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.stageSynthesisOutputs,
            version: 1,
            outputs,
          },
        );
        const chronicleStageBundle = await buildChronicleStageC1Bundle({
          projectId: taskExecution.projectId,
          runId,
          closureAggregatorTaskId: taskExecution.taskId,
          closureAggregatorAttemptId: taskExecution.attemptId,
          receipts: stageReceipts,
          acceptedTerminalOutputRootIds: terminalOutputs.map(
            (terminalOutput) =>
              terminalOutput.rootStageExecution.stageExecutionId,
          ),
        });
        return {
          outputJson: { hypothesisCount: hypotheses.length },
          artifacts: [draft, companion],
          chronicleStageBundle,
        };
      }
      return {
        outputJson: { hypothesisCount: hypotheses.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.matchExisting: {
      const snapshotPayload =
        await loadCoordinatorInlineArtifact<SnapshotArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
          request.resume === true,
        );
      const observationPayload =
        await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
          request.resume === true,
        );
      const evidencePayload =
        await loadCoordinatorInlineArtifact<ResolvedEvidenceArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
          request.resume === true,
        );
      const hypothesisPayload =
        await loadCoordinatorInlineArtifact<HypothesisArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
          request.resume === true,
        );
      if (
        !snapshotPayload ||
        !observationPayload ||
        !evidencePayload ||
        !hypothesisPayload
      ) {
        throw new Error("Missing artifacts for existing-event match");
      }

      const observationById = new Map(
        observationPayload.observations.map(
          (observation) => [observation.localId, observation] as const,
        ),
      );
      const anchorsByQuote = new Map<
        string,
        Map<string, ResolvedEvidenceAnchor | null>
      >();
      for (const anchor of evidencePayload.anchors) {
        const anchorsBySource =
          anchorsByQuote.get(anchor.sourceRef) ?? new Map();
        const existing = anchorsBySource.get(anchor.quote);
        if (!anchorsBySource.has(anchor.quote)) {
          anchorsBySource.set(anchor.quote, anchor);
        } else if (
          existing === null ||
          existing?.documentRef !== anchor.documentRef
        ) {
          anchorsBySource.set(anchor.quote, null);
        }
        anchorsByQuote.set(anchor.sourceRef, anchorsBySource);
      }

      const matches = hypothesisPayload.hypotheses.map((hypothesis) => {
        const provenanceKeys: string[] = [];
        const documentSourceKeys: string[] = [];
        for (const observationRef of hypothesis.observationRefs) {
          const observation = observationById.get(observationRef);
          if (!observation) continue;
          for (const evidence of observation.evidence) {
            const anchor = anchorsByQuote
              .get(evidence.sourceRef)
              ?.get(evidence.quote);
            if (!anchor) continue;
            provenanceKeys.push(
              evidenceFingerprint(evidence.sourceRef, evidence.quote),
            );
            const sourceKey = documentSourceKeyForRef(
              snapshotPayload.snapshot,
              anchor.documentRef,
            );
            if (sourceKey) documentSourceKeys.push(sourceKey);
          }
        }
        const match = matchExistingChronicleEvent(
          {
            hypothesis,
            evidenceDocumentSourceKeys: [...new Set(documentSourceKeys)],
            provenanceKeys,
          },
          request.existingEvents ?? [],
        );
        return { hypothesisId: hypothesis.hypothesisId, match };
      });

      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.matches,
        { matches },
      );
      return {
        outputJson: { matchCount: matches.length },
        artifacts: [draft],
      };
    }
    case CHRONICLE_EXTRACT_TASK_KINDS.planProposals: {
      const observationPayload =
        await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
          request.resume === true,
        );
      const evidencePayload =
        await loadCoordinatorInlineArtifact<ResolvedEvidenceArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
          request.resume === true,
        );
      const hypothesisPayload =
        await loadCoordinatorInlineArtifact<HypothesisArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
          request.resume === true,
        );
      const matchPayload =
        await loadCoordinatorInlineArtifact<MatchArtifactPayload>(
          runId,
          request.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.matches,
          request.resume === true,
        );
      if (
        !observationPayload ||
        !evidencePayload ||
        !hypothesisPayload ||
        !matchPayload
      ) {
        throw new Error("Missing synthesis inputs for proposal planning");
      }
      const matchesByHypothesisId = new Map(
        matchPayload.matches.map(
          (entry) => [entry.hypothesisId, entry.match] as const,
        ),
      );
      const { planned, rejectedHypotheses } =
        planChronicleEventProposalsWithDiagnostics({
          hypotheses: hypothesisPayload.hypotheses,
          observations: observationPayload.observations,
          anchors: evidencePayload.anchors,
          matchesByHypothesisId,
          createId,
        });
      const proposals = planned.map((entry) => entry.proposal);
      const hypothesisById = new Map(
        hypothesisPayload.hypotheses.map(
          (hypothesis) => [hypothesis.hypothesisId, hypothesis] as const,
        ),
      );
      const alreadySatisfied = matchPayload.matches.flatMap((entry) => {
        if (entry.match.status !== "already-satisfied") return [];
        const hypothesis = hypothesisById.get(entry.hypothesisId);
        if (
          !hypothesis ||
          !checkHypothesisActuality(hypothesis, observationPayload.observations)
            .ok
        )
          return [];
        return [
          {
            hypothesisId: entry.hypothesisId,
            title: hypothesis.titleSuggestion,
            existingRef: entry.match.existingRef,
          },
        ];
      });
      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
        {
          proposals,
          rejectedHypotheses,
          rejectedClusters: hypothesisPayload.rejectedClusters ?? [],
          planned: planned.map((entry) => ({
            proposal: entry.proposal,
            match: entry.match,
            hypothesisId: entry.hypothesisId,
          })),
          alreadySatisfied,
        },
      );
      return {
        outputJson: {
          proposalCount: proposals.length,
          alreadySatisfiedCount: alreadySatisfied.length,
          rejectedHypothesisCount: rejectedHypotheses.length,
        },
        artifacts: [draft],
      };
    }
    default:
      throw new Error(
        `Unsupported narrative extraction task kind: ${taskKind}`,
      );
  }
}

export async function runChronicleExtractionCoordinator(
  request: ChronicleExtractionRequest,
  deps: ExtractionCoordinatorDeps = {},
): Promise<ChronicleExtractionResult> {
  const capturedRequest = captureChronicleExtractionRequest(request);
  const expectedWorkspacePath = capturedRequest.authority.workspacePath;
  if (!expectedWorkspacePath) {
    throw new Error(
      "NEX_CHRONICLE_WORKSPACE_PATH_REQUIRED: Chronicle extraction requires an open Workspace",
    );
  }
  const bindingOutcome = await runAuthoritativeMutation(
    capturedRequest.authority,
    () => captureNarrativeExtractionWorkspaceBinding(expectedWorkspacePath),
  );
  if (
    bindingOutcome.status !== "current" ||
    !bindingOutcome.value ||
    !isCurrentMutationAuthority(capturedRequest.authority)
  ) {
    throw new Error(
      "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED: Workspace or Project authority changed before extraction started",
    );
  }
  const workspaceBinding = bindingOutcome.value;
  const capturedDeps: ExtractionCoordinatorDeps = { ...deps };
  const sealedRunSpec = await buildSealedChronicleRunSpec(
    capturedRequest,
    capturedDeps,
  );
  const explicitlyRequestedEvidenceMode =
    capturedRequest.evidenceMode ?? capturedDeps.evidenceMode;
  let effectiveEvidenceMode = resolveCoordinatorEvidenceMode(
    capturedRequest,
    capturedDeps,
  );
  let sealedRequest: ChronicleExtractionRequest = {
    ...capturedRequest,
    existingEvents: sealedRunSpec.existingEvents,
    evidenceMode: effectiveEvidenceMode,
  };
  const sealedDeps: ExtractionCoordinatorDeps = {
    ...capturedDeps,
    useAi: sealedRunSpec.executionMode === "ai",
  };
  const createId = capturedDeps.createId ?? defaultCreateId;
  const leaseOwner =
    capturedDeps.leaseOwner ?? "narrative-extraction-coordinator";
  const buildSnapshot =
    capturedDeps.buildSnapshot ?? buildProjectNarrativeSnapshot;
  let snapshotResult: ProjectNarrativeSnapshotResult;
  let snapshotDraft: ReturnType<typeof buildInlineJsonArtifact> | undefined;
  let corpusPayloadDigest: Sha256Digest | undefined;
  let historicalScopeAuthorityBasis: NarrativeScopeAuthorityBasisV2 | undefined;
  let runId: string;
  let resumedTasks: ReadonlyMap<string, NarrativeExtractionTask> | undefined;
  let stageReceipts: ChronicleStageTerminalReceiptV1[];
  let resumedTerminalProposalSet:
    | {
        readonly proposalSetId: string;
        readonly proposals: readonly ChronicleSavedProposalSeed[];
      }
    | undefined;
  let catalogCapture: EvidenceSpanCatalogCapture | undefined;

  if (sealedRequest.resume) {
    const resumedRunId = sealedRequest.runId;
    if (!resumedRunId) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_RUN_ID_REQUIRED",
        "resume:true requires the exact durable runId",
      );
    }
    const projection = await getRun(resumedRunId, sealedRequest.projectId);
    resumedTasks = indexResumableChronicleRun(
      projection,
      sealedRequest,
      sealedRunSpec,
    );
    const reviewBundle = await hydrateInlineArtifactsFromNative({
      runId: resumedRunId,
      scope: artifactCacheScope(sealedRequest.authority),
    });
    const hydratedReceipts = await hydrateChronicleStageReceiptsFromNative({
      runId: resumedRunId,
      scope: artifactCacheScope(sealedRequest.authority),
      bundle: reviewBundle,
    });
    const snapshotPayload = assertResumedSnapshotPayload(
      await loadCoordinatorInlineArtifact<SnapshotArtifactPayload>(
        resumedRunId,
        sealedRequest.authority,
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
        true,
      ),
      projection.run.snapshotDigest!,
    );
    const durableEvidenceMode = evidenceModeFromCoverage(
      projection.run.coverageJson,
    );
    const resumedEvidence = await validateResumedEvidenceCompanion(
      snapshotPayload,
      explicitlyRequestedEvidenceMode ?? durableEvidenceMode,
    );
    effectiveEvidenceMode = resumedEvidence.mode;
    catalogCapture = resumedEvidence.catalogCapture;
    if (
      durableEvidenceMode !== undefined &&
      effectiveEvidenceMode !== durableEvidenceMode
    ) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_EVIDENCE_MODE_MISMATCH",
        "source.snapshot@1 evidence companion differs from the mode sealed in the durable Run coverage",
      );
    }
    if (effectiveEvidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE) {
      const snapshotTask = resumedTasks.get(
        CHRONICLE_EXTRACT_TASK_KINDS.snapshot,
      );
      const expectedPayloadDigest = await (
        capturedDeps.digestSnapshotPayload ?? digestStableJson
      )(snapshotPayload);
      if (
        snapshotTask?.outputJson?.corpusPayloadDigest !== expectedPayloadDigest
      ) {
        resumeFailure(
          "NEX_CHRONICLE_RESUME_SNAPSHOT_DIGEST_MISMATCH",
          "citation-id-v2 resume snapshot artifact payload and completed Task output do not share the same corpus payload digest",
        );
      }
    }
    sealedRequest = {
      ...sealedRequest,
      evidenceMode: effectiveEvidenceMode,
      existingEvents: await resolveResumedExistingEventsCatalog(
        snapshotPayload,
        sealedRunSpec,
      ),
    };
    snapshotResult = {
      ok: true,
      snapshot: snapshotPayload.snapshot,
      scopeAuthorityDocuments: snapshotPayload.scopeAuthorityDocuments,
      flush: { status: "already-clean", blockedDocuments: [] },
    };
    await assertCompletedResumeArtifacts(
      resumedRunId,
      sealedRequest.authority,
      resumedTasks,
    );
    const completedObservation = resumedTasks.get(
      CHRONICLE_EXTRACT_TASK_KINDS.observe,
    );
    const completedPlan = resumedTasks.get(
      CHRONICLE_EXTRACT_TASK_KINDS.planProposals,
    );
    if (completedPlan?.status === "completed") {
      resumedTerminalProposalSet = hydrateCompletedPlanProposalSet(
        reviewBundle,
        resumedRunId,
        completedPlan,
      );
      const [planPayload, hypothesesPayload, observationsPayload] =
        await Promise.all([
          loadCoordinatorInlineArtifact<ProposalPlanArtifactPayload>(
            resumedRunId,
            sealedRequest.authority,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
            true,
          ),
          loadCoordinatorInlineArtifact<HypothesisArtifactPayload>(
            resumedRunId,
            sealedRequest.authority,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
            true,
          ),
          loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
            resumedRunId,
            sealedRequest.authority,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
            true,
          ),
        ]);
      assertSavedPlanActualitySupport({
        alreadySatisfied: planPayload?.alreadySatisfied,
        proposalPayloads: planPayload?.proposals,
        planned: planPayload?.planned,
        hypotheses: hypothesesPayload?.hypotheses,
        observations: observationsPayload?.observations,
        currentProposals: resumedTerminalProposalSet.proposals.map(
          (proposal) => proposal.payload!,
        ),
      });
    }
    if (sealedDeps.useAi && completedObservation?.status === "completed") {
      const observationCount =
        completedObservation.outputJson?.observationCount;
      if (
        typeof observationCount !== "number" ||
        !Number.isSafeInteger(observationCount) ||
        observationCount < 0
      ) {
        resumeFailure(
          "NEX_CHRONICLE_RESUME_STAGE_PROVENANCE_MISSING",
          "completed Observation Task has no valid observationCount output",
        );
      }
      const observationPayload =
        await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
          resumedRunId,
          sealedRequest.authority,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
          true,
        );
      const durableObservationCount = observationPayload?.observations.length;
      if (
        typeof durableObservationCount !== "number" ||
        durableObservationCount !== observationCount
      ) {
        resumeFailure(
          "NEX_CHRONICLE_RESUME_STAGE_PROVENANCE_MISSING",
          "completed Observation output observationCount does not match its durable raw-observations artifact",
        );
      }
      if (
        durableObservationCount > 0 &&
        !hasAcceptedObservationTerminal(
          hydratedReceipts,
          completedObservation.taskId,
        )
      ) {
        resumeFailure(
          "NEX_CHRONICLE_RESUME_STAGE_PROVENANCE_MISSING",
          "completed Observation Task has no accepted durable terminal receipt path",
        );
      }
    }
    runId = resumedRunId;
    stageReceipts = [...hydratedReceipts];
  } else {
    snapshotResult = await buildSnapshot(
      {
        projectId: sealedRequest.projectId,
        folderId: sealedRequest.folderId,
        language: sealedRequest.language,
        sceneIds: sealedRequest.sceneIds,
        authority: sealedRequest.authority,
      },
      sealedDeps.snapshotServices,
    );
    if (!snapshotResult.ok) {
      throw new Error(
        `Snapshot build failed: ${snapshotResult.diagnostics
          .map((diagnostic) => diagnostic.code)
          .join(", ")}`,
      );
    }

    // The catalog is derived only after the immutable snapshot is sealed and
    // before the planner can dispatch any model work. Its bytes are retained
    // in the source.snapshot@1 companion for cold resume.
    const evidenceCatalog =
      sealedDeps.useAi &&
      effectiveEvidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE
        ? await buildEvidenceSpanCatalog(snapshotResult.snapshot)
        : null;
    catalogCapture = evidenceCatalog
      ? await captureEvidenceSpanCatalog(
          snapshotResult.snapshot,
          evidenceCatalog,
        )
      : undefined;
    const windowPlan = planExtractionWindows(snapshotResult.snapshot);
    const sourceViews = await buildSourceViewsForPlan(
      snapshotResult.snapshot,
      windowPlan,
    );
    if (evidenceCatalog) {
      const catalogWindowInputs = buildEvidenceSpanCatalogWindowInputs(
        snapshotResult.snapshot,
        windowPlan,
        sourceViews,
      );
      // Coverage is a pre-dispatch assertion over the complete planner
      // roster, separate from each request's one-window alias binding.
      assertEvidenceSpanCatalogCoverage(evidenceCatalog, catalogWindowInputs);
    }
    const suppliedAuthorityDocuments = new Map(
      snapshotResult.scopeAuthorityDocuments.map((document) => [
        document.documentRef,
        document,
      ]),
    );
    const sealedScopeAuthorityDocuments = snapshotResult.snapshot.documents.map(
      (document) => {
        const supplied = suppliedAuthorityDocuments.get(document.ref);
        if (supplied) {
          if (supplied.sourceKey !== document.sourceKey) {
            throw new Error(
              `NEX_SCOPE_AUTHORITY_SNAPSHOT_MISMATCH: ${document.ref} sourceKey does not match the sealed snapshot`,
            );
          }
          return {
            documentRef: supplied.documentRef,
            sourceKey: supplied.sourceKey,
            rawStoryKey: supplied.rawStoryKey,
          };
        }
        if (!document.sourceKey.startsWith("project:scene:")) {
          throw new Error(
            `NEX_SCOPE_AUTHORITY_SNAPSHOT_MISSING: ${document.ref} has no project Scene authority source`,
          );
        }
        return {
          documentRef: document.ref,
          sourceKey: document.sourceKey as `project:scene:${string}`,
          rawStoryKey: null,
        };
      },
    );
    if (
      suppliedAuthorityDocuments.size > 0 &&
      suppliedAuthorityDocuments.size !== sealedScopeAuthorityDocuments.length
    ) {
      throw new Error(
        "NEX_SCOPE_AUTHORITY_SNAPSHOT_MISMATCH: authority document set does not match sealed snapshot documents",
      );
    }

    snapshotDraft = buildInlineJsonArtifact(
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
      {
        snapshot: snapshotResult.snapshot,
        sourceViews,
        existingEventsCatalog: {
          kind: "chronicle.existing-events-catalog@1",
          events: sealedRunSpec.existingEvents,
        },
        evidence: buildSnapshotEvidenceCompanion(
          snapshotResult.snapshot,
          effectiveEvidenceMode,
          evidenceCatalog,
        ),
        scopeAuthorityDocuments: sealedScopeAuthorityDocuments,
      },
    );
    // The artifact writer recomputes this digest before persistence, but the
    // snapshot task output also carries it as a CAS coordinate.  Native checks
    // this assertion against its own canonical recomputation in the same finish
    // transaction, so a cross-window caller cannot bind a T1 task result to a
    // different corpus payload.
    corpusPayloadDigest = await (
      capturedDeps.digestSnapshotPayload ?? digestStableJson
    )(snapshotDraft.payloadJson);

    const createdRun = await createRun(
      {
        runId: sealedRequest.runId,
        projectId: sealedRequest.projectId,
        surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
        scopeJson: {
          folderId: sealedRequest.folderId,
          sceneIds: [...sealedRequest.sceneIds],
        },
        specJson: sealedRunSpec.specJson,
        specDigest: sealedRunSpec.specDigest,
        catalogDigest: sealedRunSpec.catalogDigest,
        snapshotDigest: snapshotResult.snapshot.digest,
        coverageJson: {
          mode: "complete",
          documentCount: snapshotResult.snapshot.documents.length,
          windowCount: windowPlan.windows.length,
          evidenceMode: effectiveEvidenceMode,
          evidenceCatalogDigest: evidenceCatalog?.digest ?? null,
        },
        tasks: CHRONICLE_EXTRACT_DAG.map((taskKind, index) => ({
          taskKind,
          priority: CHRONICLE_EXTRACT_DAG.length - index,
          inputJson: { stage: index + 1 },
        })),
      },
      workspaceBinding,
    );

    runId = createdRun.runId;
    try {
      if (sealedScopeAuthorityDocuments.length > 0) {
        const { buildNarrativeScopeAuthorityBasisV2 } =
          await import("@/features/narrative-extraction/source/scopeAuthorityBasisV2");
        historicalScopeAuthorityBasis =
          await buildNarrativeScopeAuthorityBasisV2({
            projectId: sealedRequest.projectId,
            runId,
            corpusDigest: snapshotResult.snapshot.digest,
            documents: sealedScopeAuthorityDocuments,
          });
      }
    } catch (error) {
      try {
        await cancelRun(runId, sealedRequest.projectId, workspaceBinding);
      } catch {
        // Prefer the invalid historical authority failure; cancel is best-effort.
      }
      throw error;
    }
    stageReceipts = [];
  }

  if (!snapshotResult.ok) {
    throw new Error(
      "NEX_CHRONICLE_RESUME_SNAPSHOT_MISSING: snapshot is not usable",
    );
  }
  let savedProposalSetId = resumedTerminalProposalSet?.proposalSetId;
  let savedProposals: readonly ChronicleSavedProposalSeed[] =
    resumedTerminalProposalSet?.proposals ?? [];

  for (const taskKind of CHRONICLE_EXTRACT_DAG) {
    if (resumedTasks?.get(taskKind)?.status === "completed") {
      continue;
    }
    let claim;
    try {
      claim = await narrativeExtractionClaimTask(
        {
          runId,
          projectId: sealedRequest.projectId,
          leaseOwner,
          taskKinds: [taskKind],
        },
        workspaceBinding,
      );
    } catch (error) {
      if (!sealedRequest.resume) {
        try {
          await cancelRun(runId, sealedRequest.projectId, workspaceBinding);
        } catch {
          // Prefer original claim failure; cancel is best-effort.
        }
      }
      throw error;
    }
    if (!claim.claimed || !claim.task) {
      if (!sealedRequest.resume) {
        try {
          await cancelRun(runId, sealedRequest.projectId, workspaceBinding);
        } catch {
          // Prefer original claim failure; cancel is best-effort.
        }
      }
      throw new Error(
        sealedRequest.resume
          ? `NEX_CHRONICLE_RESUME_TASK_UNAVAILABLE: failed to claim durable Task ${taskKind}`
          : `Failed to claim task ${taskKind}`,
      );
    }

    try {
      if (taskKind === CHRONICLE_EXTRACT_TASK_KINDS.snapshot) {
        if (!snapshotDraft || !corpusPayloadDigest) {
          throw new Error(
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISSING: resume cannot recreate source.snapshot@1",
          );
        }
        await narrativeExtractionFinishTask(
          {
            runId,
            projectId: sealedRequest.projectId,
            taskId: claim.task.taskId,
            attemptId: claim.task.attemptId,
            leaseOwner,
            outputJson: {
              snapshotDigest: snapshotResult.snapshot.digest,
              documentCount: snapshotResult.snapshot.documents.length,
              corpusPayloadDigest,
              scopeAuthorityCompositeDigest:
                historicalScopeAuthorityBasis?.digests.compositeDigest ?? null,
            },
            artifacts: [snapshotDraft.artifactInput],
            ...(historicalScopeAuthorityBasis
              ? { historicalScopeAuthorityBasis }
              : {}),
          },
          workspaceBinding,
        );
        rememberInlineJsonArtifact({
          runId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          scope: artifactCacheScope(sealedRequest.authority),
          draft: snapshotDraft,
        });
        continue;
      }

      const receiptStart = stageReceipts.length;
      const executed = await executeTask(
        taskKind,
        runId,
        {
          projectId: sealedRequest.projectId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
        },
        sealedRequest,
        sealedDeps,
        createId,
        stageReceipts,
        catalogCapture,
      );

      let artifacts = executed.artifacts;
      let outputJson = executed.outputJson;
      const chronicleStageBundle = executed.chronicleStageBundle;
      const taskStageReceipts = stageReceipts.slice(receiptStart);

      // The terminal ProposalSet is built here, but Native persists it only in
      // this Task's finish transaction together with the bound artifact and
      // Task/Run completion.  There is deliberately no public save between
      // those durability coordinates.
      let chroniclePlanProposalSet: ChroniclePlanProposalSetFinish | undefined;
      let expectedProposalSetId: string | undefined;
      if (taskKind === CHRONICLE_EXTRACT_TASK_KINDS.planProposals) {
        const proposalDraft = artifacts.find(
          (draft) =>
            draft.artifactKind === CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
        );
        const proposalPayload =
          (proposalDraft?.payloadJson as
            | ProposalPlanArtifactPayload
            | undefined) ?? null;
        if (!proposalDraft || !proposalPayload) {
          throw new Error(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_ARTIFACT_MISSING: plan task did not emit chronicle.proposal-plan@1",
          );
        }
        const proposals = proposalPayload?.proposals ?? [];
        const evidencePayload =
          await loadCoordinatorInlineArtifact<ResolvedEvidenceArtifactPayload>(
            runId,
            sealedRequest.authority,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
            sealedRequest.resume === true,
          );
        if (!evidencePayload) {
          throw new Error("Missing resolved evidence for proposal persistence");
        }
        const originalObservationPayload =
          await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
            runId,
            sealedRequest.authority,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
            sealedRequest.resume === true,
          );
        if (!originalObservationPayload) {
          throw new Error(
            "Missing original observations for proposal persistence",
          );
        }
        const mergedObservationPayload =
          await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
            runId,
            sealedRequest.authority,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
            sealedRequest.resume === true,
          );
        const hypothesisPayload =
          await loadCoordinatorInlineArtifact<HypothesisArtifactPayload>(
            runId,
            sealedRequest.authority,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
            sealedRequest.resume === true,
          );
        if (!mergedObservationPayload || !hypothesisPayload) {
          throw new Error(
            "Missing merged observations or hypotheses for proposal persistence",
          );
        }
        const sourceBasis = buildSnapshotSourceBasis(
          runId,
          snapshotResult.snapshot,
        );
        const plannedRows = proposalPayload?.planned ?? [];
        let productionV2: ChronicleV2ProductionBatchResult | undefined;
        if (
          NARRATIVE_IR_V2_PRODUCTION_ENABLED &&
          sealedDeps.useAi &&
          proposals.length > 0 &&
          stageReceipts.length > 0
        ) {
          const {
            buildChronicleProductionV2Envelopes,
            CHRONICLE_SCENE_EVENT_V2_PRODUCTION,
          } = await import("./chronicleV2Production");
          if (!CHRONICLE_SCENE_EVENT_V2_PRODUCTION) {
            throw new Error(
              "NEX_CHRONICLE_V2_PRODUCTION_DISABLED: Chronicle V2 production marker is disabled",
            );
          }
          const clusterPayload =
            await loadCoordinatorInlineArtifact<ClusterArtifactPayload>(
              runId,
              sealedRequest.authority,
              CHRONICLE_EXTRACT_ARTIFACT_KINDS.clusters,
              sealedRequest.resume === true,
            );
          if (!clusterPayload)
            throw new Error(
              "Missing synthesis clusters for proposal persistence",
            );
          productionV2 = await buildChronicleProductionV2Envelopes({
            projectId: sealedRequest.projectId,
            runId,
            plannedProposals: plannedRows,
            synthesisClusters: clusterPayload.clusters,
            hypotheses: hypothesisPayload.hypotheses,
            originalObservations: originalObservationPayload.observations,
            mergedObservations: mergedObservationPayload.observations,
            evidenceAnchors: evidencePayload.anchors,
            snapshot: snapshotResult.snapshot,
            sourceBasis,
            stageReceipts,
          });
        }
        expectedProposalSetId = chroniclePlanProposalSetId(
          runId,
          claim.task.taskId,
        );
        const proposalSetPayload = await buildChronicleProposalSetPayload({
          runId,
          projectId: sealedRequest.projectId,
          taskId: claim.task.taskId,
          proposalSetId: expectedProposalSetId,
          sourceRevisionToken: snapshotResult.snapshot.digest,
          sourceBasis,
          summaryJson: {
            proposalCount: proposals.length,
            surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
          },
          evidenceById: new Map(
            evidencePayload.anchors.map((anchor) => [
              anchor.id,
              {
                documentRef: anchor.documentRef,
                quote: anchor.quote,
                quoteDigest: anchor.quoteDigest,
                sourceKey:
                  snapshotResult.snapshot.documents.find(
                    (document) => document.ref === anchor.documentRef,
                  )?.origin.kind === "project-node"
                    ? `project:scene:${snapshotResult.snapshot.documents.find((document) => document.ref === anchor.documentRef)?.origin.nodeId}`
                    : undefined,
                revisionToken: (() => {
                  const document = snapshotResult.snapshot.documents.find(
                    (item) => item.ref === anchor.documentRef,
                  );
                  return document?.origin.kind === "project-node"
                    ? `v${document.origin.sourceVersion}@${document.origin.sourceUpdatedAt}`
                    : undefined;
                })(),
              },
            ]),
          ),
          proposals: proposals.map((proposal, index) => ({
            proposalKey: `${proposal.eventId}:${index}`,
            payload: proposal,
          })),
          ...(productionV2 && productionV2.envelopeByProposalKey.size > 0
            ? { v2EnvelopeByProposalKey: productionV2.envelopeByProposalKey }
            : {}),
          ...(productionV2?.stageReceiptRefs
            ? { stageReceiptRefs: productionV2.stageReceiptRefs }
            : {}),
        });
        chroniclePlanProposalSet = { proposalSet: proposalSetPayload };
        const bound = buildInlineJsonArtifact(
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
          {
            ...proposalPayload,
            proposalSetId: expectedProposalSetId,
          },
          proposalDraft.artifactId,
        );
        artifacts = artifacts.map((draft) =>
          draft.artifactKind === CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals
            ? bound
            : draft,
        );
        outputJson = {
          ...outputJson,
          proposalSetId: expectedProposalSetId,
          proposalCount: proposals.length,
        };
      }

      const finished = await narrativeExtractionFinishTask(
        {
          runId,
          projectId: sealedRequest.projectId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          leaseOwner,
          outputJson,
          artifacts: artifacts.map((draft) => draft.artifactInput),
          ...(taskStageReceipts.length > 0
            ? { chronicleStageReceipts: taskStageReceipts }
            : {}),
          ...(chronicleStageBundle ? { chronicleStageBundle } : {}),
          ...(chroniclePlanProposalSet ? { chroniclePlanProposalSet } : {}),
        },
        workspaceBinding,
      );
      if (expectedProposalSetId) {
        const saved = finished.proposalSet;
        if (!saved || saved.proposalSetId !== expectedProposalSetId) {
          throw new Error(
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_RESULT_MISSING: Native finish did not return the terminal deterministic ProposalSet",
          );
        }
        savedProposalSetId = saved.proposalSetId;
        savedProposals = saved.proposals;
      }
      for (const draft of artifacts) {
        rememberInlineJsonArtifact({
          runId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          scope: artifactCacheScope(sealedRequest.authority),
          draft,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "chronicle extraction task failed";
      try {
        await narrativeExtractionFailTask(
          {
            runId,
            projectId: sealedRequest.projectId,
            taskId: claim.task.taskId,
            attemptId: claim.task.attemptId,
            leaseOwner,
            errorMessage: message,
            requeue: false,
          },
          workspaceBinding,
        );
      } catch {
        // Prefer original task failure; ledger fail is best-effort after primary error.
      }
      throw error;
    }
  }

  const proposalPayload =
    await loadCoordinatorInlineArtifact<ProposalPlanArtifactPayload>(
      runId,
      sealedRequest.authority,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
      sealedRequest.resume === true,
    );
  const proposals = proposalPayload?.proposals ?? [];
  if (!savedProposalSetId) {
    throw new Error("Missing proposalSetId after chronicle extraction");
  }

  return {
    runId,
    snapshot: snapshotResult.snapshot,
    proposals,
    savedProposalSetId,
    savedProposals,
  };
}

export { CHRONICLE_EVENT_PROPOSAL_KIND };
