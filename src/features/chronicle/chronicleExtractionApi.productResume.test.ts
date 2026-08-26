import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeCreateRunMock = vi.hoisted(() => vi.fn());
const nativeCaptureWorkspaceBindingMock = vi.hoisted(() => vi.fn());
const nativeGetRunMock = vi.hoisted(() => vi.fn());
const nativeCancelRunMock = vi.hoisted(() => vi.fn());
const nativeClaimTaskMock = vi.hoisted(() => vi.fn());
const nativeFinishTaskMock = vi.hoisted(() => vi.fn());
const nativeFailTaskMock = vi.hoisted(() => vi.fn());
const nativeGetRunReviewBundleMock = vi.hoisted(() => vi.fn());
const nativeListTaskResumeCandidatesMock = vi.hoisted(() => vi.fn());
const nativeListResumableRunsMock = vi.hoisted(() => vi.fn());
const projectSnapshotMock = vi.hoisted(() => vi.fn());
const observeWithAiMock = vi.hoisted(() => vi.fn());
const synthesizeWithAiMock = vi.hoisted(() => vi.fn());
const productionV2Mock = vi.hoisted(() => vi.fn());

vi.mock(
  "@/application/narrative-extraction/nativeApi",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/nativeApi")
      >();
    return {
      ...actual,
      captureNarrativeExtractionWorkspaceBinding:
        nativeCaptureWorkspaceBindingMock,
      narrativeExtractionCreateRun: nativeCreateRunMock,
      narrativeExtractionGetRun: nativeGetRunMock,
      narrativeExtractionCancelRun: nativeCancelRunMock,
      narrativeExtractionClaimTask: nativeClaimTaskMock,
      narrativeExtractionFinishTask: nativeFinishTaskMock,
      narrativeExtractionFailTask: nativeFailTaskMock,
      narrativeExtractionGetRunReviewBundle: nativeGetRunReviewBundleMock,
      narrativeExtractionListChronicleTaskResumeCandidates:
        nativeListTaskResumeCandidatesMock,
      narrativeExtractionListResumableRuns: nativeListResumableRunsMock,
    };
  },
);

vi.mock(
  "@/application/narrative-extraction/projectSnapshotAdapter",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/projectSnapshotAdapter")
      >();
    return {
      ...actual,
      buildProjectNarrativeSnapshot: projectSnapshotMock,
    };
  },
);

vi.mock(
  "@/application/narrative-extraction/aiTasks/runObservationExtractionTask",
  () => ({ runObservationExtractionTask: observeWithAiMock }),
);

vi.mock(
  "@/application/narrative-extraction/aiTasks/runEventSynthesisTask",
  () => ({ runEventSynthesisTask: synthesizeWithAiMock }),
);

vi.mock("@/application/narrative-extraction/chronicleV2Production", () => ({
  CHRONICLE_SCENE_EVENT_V2_PRODUCTION: true,
  buildChronicleProductionV2Envelopes: productionV2Mock,
}));

import type {
  ArtifactInput,
  ChronicleTaskResumeCandidate,
  ClaimTaskPayload,
  CreateRunPayload,
  FailTaskPayload,
  FinishTaskPayload,
  GetRunReviewBundleResult,
  ReviewBundleArtifact,
  ReviewBundleProposal,
  ReviewBundleProposalSet,
} from "@/application/narrative-extraction/nativeApi";
import {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_TASK_KINDS,
} from "@/application/narrative-extraction/extractionCoordinator";
import { resetNarrativeArtifactIndexForTests } from "@/application/narrative-extraction/artifactRepository";
import { resetNarrativeExtractionRunIndexForTests } from "@/application/narrative-extraction/runRepository";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import {
  buildChronicleStageTerminalReceiptV1,
  createStageModelExecutionBindingV1,
  type ChronicleStageTerminalReceiptV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import type {
  NarrativeExtractionRun,
  NarrativeExtractionTask,
} from "@/features/narrative-extraction/runtime/types";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  discardChronicleTaskResumeCandidate,
  discoverChronicleTaskResumeCandidates,
  resetChronicleExtractionApiCachesForTests,
  resumeChronicleExtraction,
  startChronicleExtraction,
} from "./chronicleExtractionApi";
import {
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
} from "./chronicleExtractionStore";

const SCOPE = {
  projectId: "project-product-resume",
  workspacePath: "/workspace/product-resume",
  openRevision: 11,
} as const;

const RUN_ID = "run-product-resume";
const STAGE_DIGEST = `sha256:${"a".repeat(64)}` as const;
const CREATED_AT = "2026-08-26T00:00:00.000Z";
const STARTED_AT = "2026-08-26T00:00:01.000Z";

const TASK_CHAIN = [
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

interface MutableTask {
  taskId: string;
  runId: string;
  taskKind: string;
  status: NarrativeExtractionTask["status"];
  inputJson: Readonly<Record<string, unknown>>;
  outputJson: Readonly<Record<string, unknown>> | null;
  priority: number;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  version: number;
}

interface DurableAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  status: "running" | "completed" | "failed";
  readonly startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

interface DurableRunState {
  run: NarrativeExtractionRun;
  readonly tasks: MutableTask[];
  readonly attempts: Map<string, DurableAttempt>;
  readonly artifacts: ReviewBundleArtifact[];
  readonly stageReceipts: ChronicleStageTerminalReceiptV1[];
  proposalSet: ReviewBundleProposalSet | null;
  proposals: ReviewBundleProposal[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function authority(): MutationAuthority {
  return {
    projectId: SCOPE.projectId,
    currentProjectId: () => SCOPE.projectId,
    workspacePath: SCOPE.workspacePath,
    workspaceOpenRevision: SCOPE.openRevision,
  };
}

class StatefulNarrativeNative {
  readonly runs = new Map<string, DurableRunState>();
  createCount = 0;
  crashBeforeSnapshotFinish = false;
  crashBeforeSynthesis = false;
  private processExited = false;
  private artifactOrdinal = 0;

  createRun(payload: CreateRunPayload) {
    this.createCount += 1;
    const runId =
      payload.runId ??
      (this.createCount === 1 ? RUN_ID : `${RUN_ID}-${this.createCount}`);
    if (this.runs.has(runId)) {
      throw new Error(`duplicate run ${runId}`);
    }
    const tasks = payload.tasks.map<MutableTask>((seed, index) => ({
      taskId: seed.taskId ?? `task-product-${index + 1}`,
      runId,
      taskKind: seed.taskKind,
      status: "queued",
      inputJson: cloneJson(seed.inputJson ?? {}),
      outputJson: null,
      priority: seed.priority ?? 0,
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      errorMessage: null,
      createdAt: CREATED_AT,
      startedAt: null,
      completedAt: null,
      version: 0,
    }));
    const run: NarrativeExtractionRun = {
      runId,
      projectId: payload.projectId,
      surfacePathId: payload.surfacePathId,
      scopeJson: cloneJson(payload.scopeJson),
      specJson: cloneJson(payload.specJson),
      specDigest: payload.specDigest,
      snapshotDigest: payload.snapshotDigest ?? null,
      catalogDigest: payload.catalogDigest ?? null,
      registryDigest: payload.registryDigest ?? null,
      status: "running",
      coverageJson: cloneJson(payload.coverageJson ?? {}),
      outcomeSummaryJson: null,
      createdAt: CREATED_AT,
      startedAt: STARTED_AT,
      completedAt: null,
      version: 0,
    };
    this.runs.set(runId, {
      run,
      tasks,
      attempts: new Map(),
      artifacts: [],
      stageReceipts: [],
      proposalSet: null,
      proposals: [],
    });
    return {
      runId,
      status: "running",
      taskIds: tasks.map((task) => task.taskId),
    };
  }

  getRun(runId: string, projectId: string) {
    const state = this.requireRun(runId, projectId);
    return cloneJson({
      run: state.run,
      tasks: state.tasks,
      taskCounts: this.taskCounts(state),
    });
  }

  claim(payload: ClaimTaskPayload) {
    const state = this.requireRun(payload.runId, payload.projectId);
    const requestedKinds = new Set(payload.taskKinds ?? []);
    const task = state.tasks.find(
      (candidate) =>
        candidate.status === "queued" &&
        (requestedKinds.size === 0 || requestedKinds.has(candidate.taskKind)),
    );
    if (!task) return { claimed: false };
    if (
      this.crashBeforeSynthesis &&
      task.taskKind === CHRONICLE_EXTRACT_TASK_KINDS.synthesize
    ) {
      this.crashBeforeSynthesis = false;
      this.processExited = true;
      throw new Error("SIMULATED_PROCESS_EXIT_BEFORE_SYNTHESIS");
    }
    task.status = "running";
    task.attemptCount += 1;
    task.leaseOwner = payload.leaseOwner;
    task.leaseExpiresAt = "2099-01-01T00:00:00.000Z";
    task.startedAt = STARTED_AT;
    task.version += 1;
    const attemptId = `attempt-product-${task.taskId}-${task.attemptCount}`;
    state.attempts.set(attemptId, {
      attemptId,
      taskId: task.taskId,
      attemptNumber: task.attemptCount,
      status: "running",
      startedAt: STARTED_AT,
      completedAt: null,
      errorMessage: null,
    });
    return {
      claimed: true,
      task: {
        taskId: task.taskId,
        runId: task.runId,
        taskKind: task.taskKind,
        status: task.status,
        inputJson: cloneJson(task.inputJson),
        attemptId,
        attemptNumber: task.attemptCount,
        leaseOwner: payload.leaseOwner,
        leaseExpiresAt: task.leaseExpiresAt,
      },
    };
  }

  finish(payload: FinishTaskPayload) {
    const state = this.requireRun(payload.runId, payload.projectId);
    const task = this.requireTask(state, payload.taskId);
    const attempt = this.requireAttempt(state, payload.attemptId, task.taskId);
    if (
      this.crashBeforeSnapshotFinish &&
      task.taskKind === CHRONICLE_EXTRACT_TASK_KINDS.snapshot
    ) {
      this.crashBeforeSnapshotFinish = false;
      this.processExited = true;
      throw new Error("SIMULATED_PROCESS_EXIT_BEFORE_SNAPSHOT_FINISH");
    }
    task.status = "completed";
    task.outputJson = cloneJson(payload.outputJson ?? {});
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.completedAt = "2026-08-26T00:00:10.000Z";
    task.version += 1;
    attempt.status = "completed";
    attempt.completedAt = task.completedAt;
    for (const artifact of payload.artifacts ?? []) {
      this.persistArtifact(state, task, attempt, artifact);
    }
    this.persistReceipts(state, payload.chronicleStageReceipts ?? []);
    this.persistReceipts(
      state,
      payload.chronicleStageBundle?.closure.receipts ?? [],
    );

    let savedProposalSet:
      | {
          proposalSetId: string;
          proposals: {
            proposalId: string;
            proposalKey: string;
            revisionId: string;
            status: "unreviewed";
          }[];
        }
      | undefined;
    const terminal = payload.chroniclePlanProposalSet?.proposalSet;
    if (terminal) {
      const proposalSetId = terminal.proposalSetId;
      if (!proposalSetId)
        throw new Error("missing deterministic ProposalSet id");
      state.proposalSet = {
        proposalSetId,
        runId: payload.runId,
        projectId: payload.projectId,
        setKind: terminal.setKind,
        status: "draft",
        summaryJson: cloneJson(terminal.summaryJson ?? {}),
        createdAt: task.completedAt,
        updatedAt: task.completedAt,
        version: 0,
      };
      state.proposals = terminal.proposals.map((proposal, index) => {
        const proposalId = `proposal-product-${index + 1}`;
        const revisionId = `revision-product-${index + 1}`;
        return {
          proposalId,
          proposalSetId,
          proposalKey: proposal.proposalKey,
          kind: proposal.kind,
          status: "unreviewed" as const,
          payloadJson: cloneJson(
            proposal.payloadJson as Readonly<Record<string, unknown>>,
          ),
          currentRevisionId: revisionId,
          createdAt: task.completedAt!,
          updatedAt: task.completedAt!,
          originKind: proposal.reconciliationEnvelope
            ? ("enveloped" as const)
            : ("legacy-unbound" as const),
          reconciliationEnvelopeDigest: null,
          reconciliationEnvelopeSchemaVersion:
            proposal.reconciliationEnvelope?.schemaVersion === 2 ? 2 : 1,
          latestDecision: null,
        };
      });
      savedProposalSet = {
        proposalSetId,
        proposals: state.proposals.map((proposal) => ({
          proposalId: proposal.proposalId,
          proposalKey: proposal.proposalKey,
          revisionId: proposal.currentRevisionId!,
          status: "unreviewed" as const,
        })),
      };
    }
    if (state.tasks.every((candidate) => candidate.status === "completed")) {
      state.run = {
        ...state.run,
        status: "completed",
        completedAt: task.completedAt,
        outcomeSummaryJson: { proposalSetId: state.proposalSet?.proposalSetId },
        version: state.run.version + 1,
      };
    }
    return {
      taskId: task.taskId,
      attemptId: attempt.attemptId,
      status: task.status,
      ...(savedProposalSet ? { proposalSet: savedProposalSet } : {}),
    };
  }

  fail(payload: FailTaskPayload) {
    if (this.processExited) {
      throw new Error("SIMULATED_PROCESS_ALREADY_GONE");
    }
    const state = this.requireRun(payload.runId, payload.projectId);
    const task = this.requireTask(state, payload.taskId);
    const attempt = this.requireAttempt(state, payload.attemptId, task.taskId);
    task.status = payload.requeue ? "queued" : "failed";
    task.errorMessage = payload.errorMessage;
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    attempt.status = "failed";
    attempt.errorMessage = payload.errorMessage;
    attempt.completedAt = "2026-08-26T00:00:10.000Z";
    return {
      taskId: task.taskId,
      attemptId: attempt.attemptId,
      status: task.status,
    };
  }

  cancel(runId: string, projectId: string) {
    const state = this.requireRun(runId, projectId);
    if (this.processExited) {
      this.processExited = false;
      throw new Error("SIMULATED_PROCESS_ALREADY_GONE");
    }
    state.run = {
      ...state.run,
      status: "cancelled",
      completedAt: "2026-08-26T00:00:10.000Z",
    };
    for (const task of state.tasks) {
      if (task.status === "queued" || task.status === "running") {
        task.status = "cancelled";
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
        task.completedAt = "2026-08-26T00:00:10.000Z";
      }
    }
    return { runId, status: "cancelled" };
  }

  reviewBundle(runId: string, projectId: string): GetRunReviewBundleResult {
    const state = this.requireRun(runId, projectId);
    return cloneJson({
      runId,
      projectId,
      artifacts: state.artifacts,
      stageReceipts: state.stageReceipts,
      proposalSet: state.proposalSet,
      proposals: state.proposals,
    });
  }

  taskResumeCandidates(projectId: string): ChronicleTaskResumeCandidate[] {
    const candidates: ChronicleTaskResumeCandidate[] = [];
    for (const state of this.runs.values()) {
      if (
        state.run.projectId !== projectId ||
        (state.run.status !== "pending" && state.run.status !== "running")
      ) {
        continue;
      }
      const nextTask = state.tasks.find((task) => task.status !== "completed");
      const snapshotArtifact = state.artifacts.find(
        (artifact) =>
          artifact.artifactKind === CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
      );
      const snapshotPayload = snapshotArtifact?.payloadJson as
        | {
            readonly snapshot?: { readonly language?: string };
            readonly existingEventsCatalog?: ChronicleTaskResumeCandidate["existingEventsCatalog"];
          }
        | undefined;
      const spec = state.run.specJson as {
        readonly executionMode?: ChronicleTaskResumeCandidate["executionMode"];
        readonly coordinatorContractDigest?: string;
      };
      const snapshotComplete = Boolean(snapshotArtifact);
      if (
        !nextTask ||
        (nextTask.status !== "queued" && nextTask.status !== "running") ||
        !state.run.snapshotDigest ||
        !state.run.catalogDigest ||
        !spec.executionMode ||
        !spec.coordinatorContractDigest
      ) {
        continue;
      }
      const leaseHeld =
        nextTask.status === "running" &&
        nextTask.leaseExpiresAt !== null &&
        Date.parse(nextTask.leaseExpiresAt) >= Date.now();
      candidates.push({
        runId: state.run.runId,
        projectId: state.run.projectId,
        status: state.run.status,
        scopeJson: cloneJson(
          state.run.scopeJson as ChronicleTaskResumeCandidate["scopeJson"],
        ),
        specJson: cloneJson(state.run.specJson),
        runSpecDigest: state.run.specDigest,
        snapshotDigest: state.run.snapshotDigest,
        catalogDigest: state.run.catalogDigest,
        executionMode: spec.executionMode,
        coordinatorContractDigest: spec.coordinatorContractDigest,
        completedTaskKinds: state.tasks
          .filter((task) => task.status === "completed")
          .map((task) => task.taskKind),
        nextTask: {
          taskId: nextTask.taskId,
          taskKind: nextTask.taskKind,
          status: nextTask.status,
          leaseExpiresAt: nextTask.leaseExpiresAt,
        },
        availability: leaseHeld
          ? "lease-held"
          : !snapshotComplete
            ? "blocked"
            : "ready",
        blockedCode:
          !leaseHeld && !snapshotComplete
            ? "NEX_CHRONICLE_RESUME_SNAPSHOT_INCOMPLETE"
            : null,
        language: snapshotComplete
          ? (snapshotPayload?.snapshot?.language ?? null)
          : null,
        existingEventsCatalog: snapshotComplete
          ? (cloneJson(snapshotPayload?.existingEventsCatalog) ?? null)
          : null,
        createdAt: state.run.createdAt,
        startedAt: state.run.startedAt,
      });
    }
    return candidates;
  }

  restartProcess(): void {
    this.processExited = false;
    // Model the first cold-start recovery read after the old renderer/worker
    // is gone. A running Task keeps its durable status/Attempt, but its old
    // process lease is no longer live and may be classified for recovery.
    for (const state of this.runs.values()) {
      for (const task of state.tasks) {
        if (task.status === "running") {
          task.leaseExpiresAt = "2000-01-01T00:00:00.000Z";
        }
      }
    }
  }

  private persistArtifact(
    state: DurableRunState,
    task: MutableTask,
    attempt: DurableAttempt,
    artifact: ArtifactInput,
  ): void {
    this.artifactOrdinal += 1;
    state.artifacts.push({
      artifactId: artifact.artifactId ?? `artifact-${this.artifactOrdinal}`,
      runId: task.runId,
      taskId: task.taskId,
      attemptId: attempt.attemptId,
      artifactKind: artifact.artifactKind,
      payloadStorage: artifact.payloadStorage ?? "inline-json",
      payloadJson: cloneJson(artifact.payloadJson ?? null),
      payloadRef: artifact.payloadRef ?? null,
      payloadDigest: artifact.payloadDigest ?? STAGE_DIGEST,
      createdAt: `2026-08-26T00:00:${String(this.artifactOrdinal).padStart(2, "0")}.000Z`,
    });
  }

  private persistReceipts(
    state: DurableRunState,
    receipts: readonly ChronicleStageTerminalReceiptV1[],
  ): void {
    const existingIds = new Set(
      state.stageReceipts.map(
        (receipt) => receipt.stageExecution.stageExecutionId,
      ),
    );
    for (const receipt of receipts) {
      if (existingIds.has(receipt.stageExecution.stageExecutionId)) continue;
      state.stageReceipts.push(cloneJson(receipt));
      existingIds.add(receipt.stageExecution.stageExecutionId);
    }
  }

  private taskCounts(state: DurableRunState) {
    return {
      queued: state.tasks.filter((task) => task.status === "queued").length,
      running: state.tasks.filter((task) => task.status === "running").length,
      completed: state.tasks.filter((task) => task.status === "completed")
        .length,
      failed: state.tasks.filter((task) => task.status === "failed").length,
      cancelled: state.tasks.filter((task) => task.status === "cancelled")
        .length,
    };
  }

  private requireRun(runId: string, projectId: string): DurableRunState {
    const state = this.runs.get(runId);
    if (!state || state.run.projectId !== projectId) {
      throw new Error(`unknown run ${runId}`);
    }
    return state;
  }

  private requireTask(state: DurableRunState, taskId: string): MutableTask {
    const task = state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    return task;
  }

  private requireAttempt(
    state: DurableRunState,
    attemptId: string,
    taskId: string,
  ): DurableAttempt {
    const attempt = state.attempts.get(attemptId);
    if (!attempt || attempt.taskId !== taskId) {
      throw new Error(`unknown attempt ${attemptId}`);
    }
    return attempt;
  }
}

describe("Chronicle product cold-start Task resume journey", () => {
  let native: StatefulNarrativeNative;

  afterEach(() => {
    setCurrentWorkspaceIdentity(null);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    native = new StatefulNarrativeNative();
    resetChronicleExtractionApiCachesForTests();
    resetChronicleExtractionStoreForTests();
    resetNarrativeArtifactIndexForTests();
    resetNarrativeExtractionRunIndexForTests();
    setCurrentWorkspaceIdentity({
      path: SCOPE.workspacePath,
      openRevision: SCOPE.openRevision,
    });

    nativeCreateRunMock.mockImplementation((payload: CreateRunPayload) =>
      native.createRun(payload),
    );
    nativeCaptureWorkspaceBindingMock.mockResolvedValue({
      authorityId: "workspace-authority-product-resume",
      generation: 1,
      authorityInstanceId: "1",
    });
    nativeGetRunMock.mockImplementation(
      (payload: { runId: string; projectId: string }) =>
        native.getRun(payload.runId, payload.projectId),
    );
    nativeCancelRunMock.mockImplementation(
      (payload: { runId: string; projectId: string }) =>
        native.cancel(payload.runId, payload.projectId),
    );
    nativeClaimTaskMock.mockImplementation((payload: ClaimTaskPayload) =>
      native.claim(payload),
    );
    nativeFinishTaskMock.mockImplementation((payload: FinishTaskPayload) =>
      native.finish(payload),
    );
    nativeFailTaskMock.mockImplementation((payload: FailTaskPayload) =>
      native.fail(payload),
    );
    nativeGetRunReviewBundleMock.mockImplementation(
      async (payload: { runId: string; projectId: string }) =>
        native.reviewBundle(payload.runId, payload.projectId),
    );
    nativeListTaskResumeCandidatesMock.mockImplementation(
      (payload: { projectId: string }) =>
        native.taskResumeCandidates(payload.projectId),
    );
    nativeListResumableRunsMock.mockResolvedValue([]);

    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-product-resume",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: SCOPE.projectId },
      documents: [
        {
          sourceKey: "project:scene:scene-product-resume",
          parentSourceKey: null,
          title: "再開される場面",
          orderIndex: 0,
          proseMirrorJson: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "教会の尖塔が砲撃で崩れ落ちた。",
                  },
                ],
              },
            ],
          }),
          origin: {
            kind: "project-node",
            projectId: SCOPE.projectId,
            nodeId: "scene-product-resume",
            sourceVersion: 4,
            sourceUpdatedAt: "2026-08-25T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
      omissions: [],
      createdAt: CREATED_AT,
    });
    if (!built.ok) throw new Error("test snapshot must be valid");
    projectSnapshotMock.mockResolvedValue({
      ok: true,
      snapshot: built.snapshot,
      scopeAuthorityDocuments: [],
      flush: { status: "already-clean", blockedDocuments: [] },
    });

    observeWithAiMock.mockImplementation(
      async ({ windows, stageExecution, onStageReceipt }) => {
        if (!stageExecution) throw new Error("missing observation execution");
        await onStageReceipt?.(
          await buildChronicleStageTerminalReceiptV1({
            stageExecution,
            contextSetVersion: "chronicle-context-set/1",
            contextSetDigest: STAGE_DIGEST,
            componentContractDigest: STAGE_DIGEST,
            finalRequestDigest: STAGE_DIGEST,
            modelExecutionBinding: createStageModelExecutionBindingV1({
              resolutionStatus: "unresolved",
            }),
            responseDigest: STAGE_DIGEST,
            parseStatus: "parsed",
            terminalStatus: "succeeded",
          }),
        );
        return [
          {
            localId: "observation-product-resume",
            evidence: [
              {
                sourceRef: windows[0]?.sourceRef ?? "S0001",
                quote: "教会の尖塔が砲撃で崩れ落ちた。",
              },
            ],
            assertion: {
              attribution: "narrator",
              narrativeFrame: "story-world",
            },
            payload: {
              predicate: "教会の尖塔が砲撃で崩れ落ちた",
              actuality: "actual",
              participants: [],
              temporalExpressions: [],
              durationKind: "instant",
            },
          },
        ];
      },
    );
    synthesizeWithAiMock.mockImplementation(
      async ({
        clusterRef,
        observations,
        createId,
        stageExecution,
        onStageReceipt,
        onTerminalOutput,
      }) => {
        if (!stageExecution) throw new Error("missing synthesis execution");
        const hypotheses = [
          {
            hypothesisId: (createId ?? (() => "hypothesis-product-resume"))(),
            clusterRef,
            observationRefs: observations.map(
              (observation: RawChronicleEventObservation) =>
                observation.localId,
            ),
            titleSuggestion: "尖塔の倒壊",
            summary: "教会の尖塔が砲撃で崩れ落ちた。",
            actuality: "actual",
            significance: "major",
          } satisfies EventHypothesis,
        ];
        const eventOutput = {
          clusterRef,
          resolution: "single-event",
          events: [
            {
              observationRefs: observations.map(
                (observation: RawChronicleEventObservation) =>
                  observation.localId,
              ),
              titleSuggestion: "尖塔の倒壊",
              summary: "教会の尖塔が砲撃で崩れ落ちた。",
              actuality: "actual",
              significance: "major",
            },
          ],
        } as const;
        await onStageReceipt?.(
          await buildChronicleStageTerminalReceiptV1({
            stageExecution,
            contextSetVersion: "chronicle-context-set/1",
            contextSetDigest: STAGE_DIGEST,
            componentContractDigest: STAGE_DIGEST,
            finalRequestDigest: STAGE_DIGEST,
            modelExecutionBinding: createStageModelExecutionBindingV1({
              resolutionStatus: "unresolved",
            }),
            responseDigest: STAGE_DIGEST,
            rawObservationsDigest: STAGE_DIGEST,
            parsedOutputDigest: STAGE_DIGEST,
            parseStatus: "parsed",
            terminalStatus: "succeeded",
          }),
        );
        await onTerminalOutput?.({
          rootStageExecution: stageExecution,
          terminalStageExecution: stageExecution,
          disposition: "root-success",
          clusterRef,
          rawObservations: observations,
          eventOutput,
          hypotheses,
          rawObservationsDigest: STAGE_DIGEST,
          parsedOutputDigest: STAGE_DIGEST,
        });
        return hypotheses;
      },
    );
    productionV2Mock.mockResolvedValue({
      envelopeByProposalKey: new Map(),
      stageReceiptRefs: [],
    });
  });

  it("starts once, discovers the durable prefix after a cold start, and resumes the same Run to its ProposalSet", async () => {
    native.crashBeforeSynthesis = true;
    await expect(
      startChronicleExtraction({
        projectId: SCOPE.projectId,
        folderId: "folder-product-resume",
        language: "ja",
        sceneIds: ["scene-product-resume"],
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
        existingEvents: [],
        useAi: true,
      }),
    ).rejects.toThrow("SIMULATED_PROCESS_EXIT_BEFORE_SYNTHESIS");

    expect(native.createCount).toBe(1);
    expect(nativeCreateRunMock).toHaveBeenCalledTimes(1);
    const durable = native.runs.get(RUN_ID);
    expect(durable?.run.status).toBe("running");
    expect(durable?.tasks.map((task) => [task.taskKind, task.status])).toEqual([
      [CHRONICLE_EXTRACT_TASK_KINDS.snapshot, "completed"],
      [CHRONICLE_EXTRACT_TASK_KINDS.windowPlan, "completed"],
      [CHRONICLE_EXTRACT_TASK_KINDS.observe, "completed"],
      [CHRONICLE_EXTRACT_TASK_KINDS.resolveEvidence, "completed"],
      [CHRONICLE_EXTRACT_TASK_KINDS.mergeObservations, "completed"],
      [CHRONICLE_EXTRACT_TASK_KINDS.cluster, "completed"],
      [CHRONICLE_EXTRACT_TASK_KINDS.synthesize, "queued"],
      [CHRONICLE_EXTRACT_TASK_KINDS.matchExisting, "queued"],
      [CHRONICLE_EXTRACT_TASK_KINDS.planProposals, "queued"],
    ]);
    const observationTask = durable?.tasks.find(
      (task) => task.taskKind === CHRONICLE_EXTRACT_TASK_KINDS.observe,
    );
    const observationAttempt = [...(durable?.attempts.values() ?? [])].find(
      (attempt) => attempt.taskId === observationTask?.taskId,
    );
    expect(observationAttempt?.status).toBe("completed");
    expect(
      durable?.artifacts.some(
        (artifact) =>
          artifact.taskId === observationTask?.taskId &&
          artifact.attemptId === observationAttempt?.attemptId &&
          artifact.artifactKind ===
            CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
      ),
    ).toBe(true);
    expect(durable?.stageReceipts).toEqual([
      expect.objectContaining({
        stageExecution: expect.objectContaining({
          runId: RUN_ID,
          taskId: observationTask?.taskId,
          attemptId: observationAttempt?.attemptId,
        }),
      }),
    ]);
    expect(durable?.proposalSet).toBeNull();

    // Simulate a renderer/process restart: all product and repository-local
    // projections disappear, while the stateful Native ledger above survives.
    resetChronicleExtractionApiCachesForTests();
    resetChronicleExtractionStoreForTests();
    resetNarrativeArtifactIndexForTests();
    resetNarrativeExtractionRunIndexForTests();
    native.restartProcess();

    const discovered = await discoverChronicleTaskResumeCandidates(SCOPE);
    expect(nativeListTaskResumeCandidatesMock).toHaveBeenCalledWith({
      projectId: SCOPE.projectId,
      limit: 20,
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      runId: RUN_ID,
      projectId: SCOPE.projectId,
      completedTaskKinds: TASK_CHAIN.slice(0, 6),
      nextTask: {
        taskKind: CHRONICLE_EXTRACT_TASK_KINDS.synthesize,
        status: "queued",
      },
      availability: "ready",
      language: "ja",
      existingEventsCatalog: {
        kind: "chronicle.existing-events-catalog@1",
        events: [],
      },
    });

    await expect(
      resumeChronicleExtraction({
        candidate: discovered[0]!,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).resolves.toEqual({ runId: RUN_ID });

    expect(native.createCount).toBe(1);
    expect(nativeCreateRunMock).toHaveBeenCalledTimes(1);
    expect(native.runs).toHaveLength(1);
    const terminal = native.runs.get(RUN_ID);
    expect(terminal?.run.status).toBe("completed");
    expect(terminal?.tasks.every((task) => task.status === "completed")).toBe(
      true,
    );
    expect(terminal?.proposalSet).toMatchObject({
      runId: RUN_ID,
      projectId: SCOPE.projectId,
      setKind: "chronicle.extract.review@1",
      status: "draft",
    });
    expect(terminal?.proposals).toHaveLength(1);
    expect(useChronicleExtractionStore.getState().projection).toMatchObject({
      runId: RUN_ID,
      projectId: SCOPE.projectId,
      workspacePath: SCOPE.workspacePath,
      openRevision: SCOPE.openRevision,
      proposalSetId: terminal?.proposalSet?.proposalSetId,
      status: "completed",
    });
    expect(useChronicleExtractionStore.getState().recovery.candidates).toEqual(
      [],
    );
  });

  it("discards a cold-start blocked Run whose Snapshot never finished, then permits a fresh Run", async () => {
    native.crashBeforeSnapshotFinish = true;
    await expect(
      startChronicleExtraction({
        projectId: SCOPE.projectId,
        folderId: "folder-product-resume",
        language: "ja",
        sceneIds: ["scene-product-resume"],
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
        existingEvents: [],
        useAi: true,
      }),
    ).rejects.toThrow("SIMULATED_PROCESS_EXIT_BEFORE_SNAPSHOT_FINISH");

    expect(native.createCount).toBe(1);
    const interrupted = native.runs.get(RUN_ID);
    expect(interrupted?.run.status).toBe("running");
    expect(interrupted?.tasks[0]).toMatchObject({
      taskKind: CHRONICLE_EXTRACT_TASK_KINDS.snapshot,
      status: "running",
    });
    expect(interrupted?.artifacts).toEqual([]);
    expect(native.taskResumeCandidates(SCOPE.projectId)).toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        availability: "lease-held",
        blockedCode: null,
      }),
    ]);

    // Renderer process state is gone, but the Native ledger still contains the
    // Run created before Snapshot terminalization.
    resetChronicleExtractionApiCachesForTests();
    resetChronicleExtractionStoreForTests();
    resetNarrativeArtifactIndexForTests();
    resetNarrativeExtractionRunIndexForTests();
    native.restartProcess();

    const discovered = await discoverChronicleTaskResumeCandidates(SCOPE);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      runId: RUN_ID,
      availability: "blocked",
      blockedCode: "NEX_CHRONICLE_RESUME_SNAPSHOT_INCOMPLETE",
      completedTaskKinds: [],
      nextTask: {
        taskKind: CHRONICLE_EXTRACT_TASK_KINDS.snapshot,
        status: "running",
      },
      language: null,
      existingEventsCatalog: null,
    });

    await expect(
      discardChronicleTaskResumeCandidate({
        candidate: discovered[0]!,
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
      }),
    ).resolves.toEqual({ runId: RUN_ID });

    expect(native.runs.get(RUN_ID)?.run.status).toBe("cancelled");
    expect(
      native.runs
        .get(RUN_ID)
        ?.tasks.every(
          (task) => task.status === "completed" || task.status === "cancelled",
        ),
    ).toBe(true);
    await expect(discoverChronicleTaskResumeCandidates(SCOPE)).resolves.toEqual(
      [],
    );
    expect(useChronicleExtractionStore.getState().recovery.candidates).toEqual(
      [],
    );

    await expect(
      startChronicleExtraction({
        projectId: SCOPE.projectId,
        folderId: "folder-product-resume",
        language: "ja",
        sceneIds: ["scene-product-resume"],
        authority: authority(),
        workspacePath: SCOPE.workspacePath,
        openRevision: SCOPE.openRevision,
        existingEvents: [],
        useAi: true,
      }),
    ).resolves.toEqual({ runId: `${RUN_ID}-2` });

    expect(native.createCount).toBe(2);
    expect(native.runs.get(`${RUN_ID}-2`)?.run.status).toBe("completed");
  });
});
