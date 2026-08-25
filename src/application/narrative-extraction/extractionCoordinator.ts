import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import { resolveEvidenceReference } from "@/features/narrative-extraction/evidence/resolveEvidence";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { CHRONICLE_EVENT_PROPOSAL_KIND } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import type {
  CanonicalRange,
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
  Sha256Digest,
} from "@/features/narrative-extraction/source/types";
import type { NarrativeScopeAuthorityBasisV2 } from "@/features/narrative-extraction/source/scopeAuthorityBasisV2";
import { clusterEventObservations } from "@/features/chronicle/extraction/eventClustering";
import { chronicleEvidenceTupleKey } from "@/features/chronicle/extraction/evidenceTupleKey";
import { mergeObservationsByEvidence } from "@/features/chronicle/extraction/observationMerger";
import {
  matchExistingChronicleEvent,
  type ChronicleExistingMatch,
  type ExistingChronicleEventCatalogRecord,
} from "@/features/chronicle/extraction/existingEventMatcher";
import { planChronicleEventProposals } from "@/features/chronicle/extraction/proposalPlanner";
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
  ChronicleStageC1ExecutionBinding,
  SavedProposalSeed,
} from "./nativeApi";
import {
  narrativeExtractionClaimTask,
  narrativeExtractionFailTask,
  narrativeExtractionFinishTask,
} from "./nativeApi";
import {
  buildInlineJsonArtifact,
  hydrateChronicleStageReceiptsFromNative,
  loadInlineJsonArtifact,
  rememberInlineJsonArtifact,
} from "./artifactRepository";
import {
  buildSnapshotSourceBasis,
  saveChronicleProposalSet,
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
import { runObservationExtractionTask } from "./aiTasks/runObservationExtractionTask";
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
}

export interface ChronicleExtractionResult {
  readonly runId: string;
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly proposals: readonly CreateChronicleEventProposalPayloadV1[];
  readonly savedProposalSetId: string;
  readonly savedProposals: readonly SavedProposalSeed[];
}

export interface ExtractionCoordinatorDeps {
  readonly leaseOwner?: string;
  readonly buildSnapshot?: typeof buildProjectNarrativeSnapshot;
  readonly snapshotServices?: ProjectSnapshotAdapterServices;
  readonly createId?: () => string;
  /** When true, observation/synthesis stages call Stage AI paths. Default: fake regex. */
  readonly useAi?: boolean;
  readonly observeWithAi?: typeof runObservationExtractionTask;
  readonly synthesizeWithAi?: typeof runEventSynthesisTask;
}

interface SnapshotArtifactPayload {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly sourceViews: readonly NarrativeSourceView[];
  /**
   * Sealed alongside the corpus so later historical Scope validation never
   * falls back to the live tree. The order is exactly snapshot.documents.
   */
  readonly scopeAuthorityDocuments: readonly {
    readonly documentRef: string;
    readonly sourceKey: `project:scene:${string}`;
    readonly rawStoryKey: string | null;
  }[];
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
}

interface MatchArtifactPayload {
  readonly matches: readonly {
    readonly hypothesisId: string;
    readonly match: ChronicleExistingMatch;
  }[];
}

interface ProposalPlanArtifactPayload {
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

/**
 * A restart must continue the exact sealed Run rather than treating `runId`
 * as a suggestion for a new/reclaimed run.  Validate the durable topology
 * before claiming a single task so a caller cannot combine an old snapshot
 * with a new scope or a different DAG.
 */
function indexResumableChronicleRun(
  projection: NarrativeExtractionRunProjection,
  request: ChronicleExtractionRequest,
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
  if (run.status !== "running") {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_RUN_NOT_RUNNING",
      `durable Run status is '${run.status}'`,
    );
  }
  if (
    run.specDigest !==
    (request.specDigest ?? digestStableString("chronicle.extract.v1"))
  ) {
    resumeFailure(
      "NEX_CHRONICLE_RESUME_SPEC_MISMATCH",
      "requested Chronicle specification differs from the sealed Run",
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

async function loadCoordinatorInlineArtifact<T extends object>(
  runId: string,
  projectId: string,
  artifactKind: string,
): Promise<T | null> {
  return loadInlineJsonArtifact<T>(runId, artifactKind, { projectId });
}

async function assertCompletedResumeArtifacts(
  runId: string,
  projectId: string,
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
      projectId,
      artifactKind,
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
    if (
      root.parseStatus === "parsed" &&
      root.terminalStatus === "succeeded"
    ) {
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

function digestStableString(value: string): Sha256Digest {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return `sha256:${hash.toString(16).padStart(64, "0")}` as Sha256Digest;
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

function titleFromSentence(sentence: string): string {
  const trimmed = sentence.replace(/。$/u, "").trim();
  return trimmed.length <= 32 ? trimmed : `${trimmed.slice(0, 29)}...`;
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

function synthesizeHypothesesFromClusters(
  clusters: ClusterArtifactPayload["clusters"],
  observations: readonly RawChronicleEventObservation[],
  createId: () => string,
): readonly EventHypothesis[] {
  const observationById = new Map(
    observations.map((observation) => [observation.localId, observation]),
  );
  return clusters.flatMap((cluster) => {
    const clusterObservations = cluster.observationRefs
      .map((ref) => observationById.get(ref))
      .filter(
        (observation): observation is RawChronicleEventObservation =>
          observation !== undefined,
      );
    if (clusterObservations.length === 0) return [];
    const primary = clusterObservations[0];
    const actuality = primary.payload.actuality;
    if (
      actuality !== "actual" &&
      actuality !== "attempted" &&
      actuality !== "prevented"
    ) {
      return [];
    }
    return [
      {
        hypothesisId: createId(),
        clusterRef: cluster.clusterRef,
        observationRefs: cluster.observationRefs,
        titleSuggestion: titleFromSentence(primary.payload.predicate),
        summary: primary.payload.predicate,
        actuality,
        significance: "major" as const,
      },
    ];
  });
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
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
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
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
        );
      const windowPayload =
        await loadCoordinatorInlineArtifact<WindowPlanArtifactPayload>(
          runId,
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.windowPlan,
        );
      if (!snapshotPayload || !windowPayload) {
        throw new Error("Missing snapshot or window-plan artifacts");
      }

      let observations: readonly RawChronicleEventObservation[];
      if (deps.useAi) {
        const observe = deps.observeWithAi ?? runObservationExtractionTask;
        const sourceByRef = new Map(
          snapshotPayload.sourceViews.map((view) => [view.ref, view] as const),
        );
        const collected: RawChronicleEventObservation[] = [];
        for (const window of windowPayload.windows) {
          const view = sourceByRef.get(window.sourceRef);
          if (!view) continue;
          const batch = await observe({
            windows: [{ sourceRef: window.sourceRef, text: view.text }],
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
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
        );
      const observationPayload =
        await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
          runId,
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
        );
      if (!snapshotPayload || !observationPayload) {
        throw new Error("Missing snapshot or observation artifacts");
      }
      const anchors = await resolveObservationEvidence(
        snapshotPayload.snapshot,
        snapshotPayload.sourceViews,
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
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
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
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
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
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
        );
      const clusterPayload =
        await loadCoordinatorInlineArtifact<ClusterArtifactPayload>(
          runId,
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.clusters,
        );
      if (!mergedPayload || !clusterPayload) {
        throw new Error("Missing merge/cluster artifacts");
      }

      let hypotheses: readonly EventHypothesis[];
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
        hypotheses = synthesizeHypothesesFromClusters(
          clusterPayload.clusters,
          mergedPayload.observations,
          createId,
        );
      }

      const draft = buildInlineJsonArtifact(
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
        { hypotheses },
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
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
        );
      const observationPayload =
        await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
          runId,
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
        );
      const evidencePayload =
        await loadCoordinatorInlineArtifact<ResolvedEvidenceArtifactPayload>(
          runId,
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
        );
      const hypothesisPayload =
        await loadCoordinatorInlineArtifact<HypothesisArtifactPayload>(
          runId,
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
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
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
        );
      const evidencePayload =
        await loadCoordinatorInlineArtifact<ResolvedEvidenceArtifactPayload>(
          runId,
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
        );
      const hypothesisPayload =
        await loadCoordinatorInlineArtifact<HypothesisArtifactPayload>(
          runId,
          taskExecution.projectId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
        );
      const matchPayload = await loadCoordinatorInlineArtifact<MatchArtifactPayload>(
        runId,
        taskExecution.projectId,
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.matches,
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
      const planned = planChronicleEventProposals({
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
        if (!hypothesis) return [];
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
  const createId = deps.createId ?? defaultCreateId;
  const leaseOwner = deps.leaseOwner ?? "narrative-extraction-coordinator";
  const buildSnapshot = deps.buildSnapshot ?? buildProjectNarrativeSnapshot;
  let snapshotResult: ProjectNarrativeSnapshotResult;
  let snapshotDraft: ReturnType<typeof buildInlineJsonArtifact> | undefined;
  let corpusPayloadDigest: Sha256Digest | undefined;
  let historicalScopeAuthorityBasis: NarrativeScopeAuthorityBasisV2 | undefined;
  let runId: string;
  let resumedTasks: ReadonlyMap<string, NarrativeExtractionTask> | undefined;
  let stageReceipts: ChronicleStageTerminalReceiptV1[];

  if (request.resume) {
    if (!request.runId) {
      resumeFailure(
        "NEX_CHRONICLE_RESUME_RUN_ID_REQUIRED",
        "resume:true requires the exact durable runId",
      );
    }
    const projection = await getRun(request.runId, request.projectId);
    resumedTasks = indexResumableChronicleRun(projection, request);
    const hydratedReceipts = await hydrateChronicleStageReceiptsFromNative({
      runId: request.runId,
      projectId: request.projectId,
    });
    const snapshotPayload = assertResumedSnapshotPayload(
      await loadCoordinatorInlineArtifact<SnapshotArtifactPayload>(
        request.runId,
        request.projectId,
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
      ),
      projection.run.snapshotDigest!,
    );
    snapshotResult = {
      ok: true,
      snapshot: snapshotPayload.snapshot,
      scopeAuthorityDocuments: snapshotPayload.scopeAuthorityDocuments,
      flush: { status: "already-clean", blockedDocuments: [] },
    };
    await assertCompletedResumeArtifacts(
      request.runId,
      request.projectId,
      resumedTasks,
    );
    const completedObservation = resumedTasks.get(
      CHRONICLE_EXTRACT_TASK_KINDS.observe,
    );
    if (deps.useAi && completedObservation?.status === "completed") {
      const observationCount = completedObservation.outputJson?.observationCount;
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
      if (
        observationCount > 0 &&
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
    runId = request.runId;
    stageReceipts = [...hydratedReceipts];
  } else {
    snapshotResult = await buildSnapshot(
      {
        projectId: request.projectId,
        folderId: request.folderId,
        language: request.language,
        sceneIds: request.sceneIds,
        authority: request.authority,
      },
      deps.snapshotServices,
    );
    if (!snapshotResult.ok) {
      throw new Error(
        `Snapshot build failed: ${snapshotResult.diagnostics
          .map((diagnostic) => diagnostic.code)
          .join(", ")}`,
      );
    }

    const windowPlan = planExtractionWindows(snapshotResult.snapshot);
    const sourceViews = await buildSourceViewsForPlan(
      snapshotResult.snapshot,
      windowPlan,
    );
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
        scopeAuthorityDocuments: sealedScopeAuthorityDocuments,
      },
    );
    // The artifact writer recomputes this digest before persistence, but the
    // snapshot task output also carries it as a CAS coordinate.  Native checks
    // this assertion against its own canonical recomputation in the same finish
    // transaction, so a cross-window caller cannot bind a T1 task result to a
    // different corpus payload.
    corpusPayloadDigest = await digestStableJson(snapshotDraft.payloadJson);

    const createdRun = await createRun({
      runId: request.runId,
      projectId: request.projectId,
      surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
      scopeJson: {
        folderId: request.folderId,
        sceneIds: [...request.sceneIds],
      },
      specJson: {
        domain: "chronicle",
        version: 1,
        taskChain: [...CHRONICLE_EXTRACT_DAG],
      },
      specDigest:
        request.specDigest ?? digestStableString("chronicle.extract.v1"),
      snapshotDigest: snapshotResult.snapshot.digest,
      coverageJson: {
        mode: "complete",
        documentCount: snapshotResult.snapshot.documents.length,
        windowCount: windowPlan.windows.length,
      },
      tasks: CHRONICLE_EXTRACT_DAG.map((taskKind, index) => ({
        taskKind,
        priority: CHRONICLE_EXTRACT_DAG.length - index,
        inputJson: { stage: index + 1 },
      })),
    });

    runId = createdRun.runId;
    try {
      if (sealedScopeAuthorityDocuments.length > 0) {
        const { buildNarrativeScopeAuthorityBasisV2 } =
          await import("@/features/narrative-extraction/source/scopeAuthorityBasisV2");
        historicalScopeAuthorityBasis =
          await buildNarrativeScopeAuthorityBasisV2({
            projectId: request.projectId,
            runId,
            corpusDigest: snapshotResult.snapshot.digest,
            documents: sealedScopeAuthorityDocuments,
          });
      }
    } catch (error) {
      try {
        await cancelRun(runId, request.projectId);
      } catch {
        // Prefer the invalid historical authority failure; cancel is best-effort.
      }
      throw error;
    }
    stageReceipts = [];
  }

  if (!snapshotResult.ok) {
    throw new Error("NEX_CHRONICLE_RESUME_SNAPSHOT_MISSING: snapshot is not usable");
  }
  let savedProposalSetId: string | undefined;
  let savedProposals: readonly SavedProposalSeed[] = [];

  for (const taskKind of CHRONICLE_EXTRACT_DAG) {
    if (resumedTasks?.get(taskKind)?.status === "completed") {
      continue;
    }
    let claim;
    try {
      claim = await narrativeExtractionClaimTask({
        runId,
        projectId: request.projectId,
        leaseOwner,
        taskKinds: [taskKind],
      });
    } catch (error) {
      if (!request.resume) {
        try {
          await cancelRun(runId, request.projectId);
        } catch {
          // Prefer original claim failure; cancel is best-effort.
        }
      }
      throw error;
    }
    if (!claim.claimed || !claim.task) {
      if (!request.resume) {
        try {
          await cancelRun(runId, request.projectId);
        } catch {
          // Prefer original claim failure; cancel is best-effort.
        }
      }
      throw new Error(
        request.resume
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
        rememberInlineJsonArtifact({
          runId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          draft: snapshotDraft,
        });
        await narrativeExtractionFinishTask({
          runId,
          projectId: request.projectId,
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
        });
        continue;
      }

      const receiptStart = stageReceipts.length;
      const executed = await executeTask(
        taskKind,
        runId,
        {
          projectId: request.projectId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
        },
        request,
        deps,
        createId,
        stageReceipts,
      );

      let artifacts = executed.artifacts;
      let outputJson = executed.outputJson;
      const chronicleStageBundle = executed.chronicleStageBundle;
      const taskStageReceipts = stageReceipts.slice(receiptStart);

      // Persist ProposalSet before finishing the last task so Run cannot become
      // `completed` without a durable review ledger.
      if (taskKind === CHRONICLE_EXTRACT_TASK_KINDS.planProposals) {
        const proposalDraft = artifacts.find(
          (draft) =>
            draft.artifactKind === CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
        );
        const proposalPayload =
          (proposalDraft?.payloadJson as
            | ProposalPlanArtifactPayload
            | undefined) ?? null;
        const proposals = proposalPayload?.proposals ?? [];
        const evidencePayload =
          await loadCoordinatorInlineArtifact<ResolvedEvidenceArtifactPayload>(
            runId,
            request.projectId,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
          );
        if (!evidencePayload) {
          throw new Error("Missing resolved evidence for proposal persistence");
        }
        const originalObservationPayload =
          await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
            runId,
            request.projectId,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
          );
        if (!originalObservationPayload) {
          throw new Error(
            "Missing original observations for proposal persistence",
          );
        }
        const mergedObservationPayload =
          await loadCoordinatorInlineArtifact<ObservationArtifactPayload>(
            runId,
            request.projectId,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
          );
        const hypothesisPayload =
          await loadCoordinatorInlineArtifact<HypothesisArtifactPayload>(
            runId,
            request.projectId,
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
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
          deps.useAi &&
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
          productionV2 = await buildChronicleProductionV2Envelopes({
            projectId: request.projectId,
            runId,
            plannedProposals: plannedRows,
            hypotheses: hypothesisPayload.hypotheses,
            originalObservations: originalObservationPayload.observations,
            mergedObservations: mergedObservationPayload.observations,
            evidenceAnchors: evidencePayload.anchors,
            snapshot: snapshotResult.snapshot,
            sourceBasis,
            stageReceipts,
          });
        }
        const saved = await saveChronicleProposalSet({
          runId,
          projectId: request.projectId,
          taskId: claim.task.taskId,
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
        savedProposalSetId = saved.proposalSetId;
        savedProposals = saved.proposals;
        if (proposalDraft && proposalPayload) {
          const bound = buildInlineJsonArtifact(
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
            {
              ...proposalPayload,
              proposalSetId: saved.proposalSetId,
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
            proposalSetId: saved.proposalSetId,
            proposalCount: proposals.length,
          };
        }
      }

      for (const draft of artifacts) {
        rememberInlineJsonArtifact({
          runId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          draft,
        });
      }
      await narrativeExtractionFinishTask({
        runId,
        projectId: request.projectId,
        taskId: claim.task.taskId,
        attemptId: claim.task.attemptId,
        leaseOwner,
        outputJson,
        artifacts: artifacts.map((draft) => draft.artifactInput),
        ...(taskStageReceipts.length > 0
          ? { chronicleStageReceipts: taskStageReceipts }
          : {}),
        ...(chronicleStageBundle ? { chronicleStageBundle } : {}),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "chronicle extraction task failed";
      try {
        await narrativeExtractionFailTask({
          runId,
          projectId: request.projectId,
          taskId: claim.task.taskId,
          attemptId: claim.task.attemptId,
          leaseOwner,
          errorMessage: message,
          requeue: false,
        });
      } catch {
        // Prefer original task failure; ledger fail is best-effort after primary error.
      }
      throw error;
    }
  }

  const proposalPayload =
    await loadCoordinatorInlineArtifact<ProposalPlanArtifactPayload>(
      runId,
      request.projectId,
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
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
