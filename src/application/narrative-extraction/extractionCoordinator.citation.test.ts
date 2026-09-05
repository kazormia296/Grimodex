import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import type { NarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/types";
import { CITATION_ID_OBSERVATION_EVIDENCE_MODE } from "./aiTasks/citationIdObservation";
import type {
  CreateRunPayload,
  FinishTaskPayload,
  GetRunReviewBundleResult,
  ReviewBundleArtifact,
} from "./nativeApi";
import { resetNarrativeArtifactIndexForTests } from "./artifactRepository";
import { resetNarrativeExtractionRunIndexForTests } from "./runRepository";

const claimMock = vi.hoisted(() => vi.fn());
const finishMock = vi.hoisted(() => vi.fn());
const failMock = vi.hoisted(() => vi.fn());
const createRunMock = vi.hoisted(() => vi.fn());
const cancelRunMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const getRunReviewBundleMock = vi.hoisted(() => vi.fn());
const buildProposalSetPayloadMock = vi.hoisted(() => vi.fn());
const buildSnapshotSourceBasisMock = vi.hoisted(() => vi.fn());
const buildProductionV2EnvelopesMock = vi.hoisted(() => vi.fn());
const captureWorkspaceBindingMock = vi.hoisted(() => vi.fn());
const planExtractionWindowsMock = vi.hoisted(() => vi.fn());

vi.mock("./nativeApi", () => ({
  captureNarrativeExtractionWorkspaceBinding: captureWorkspaceBindingMock,
  narrativeExtractionClaimTask: claimMock,
  narrativeExtractionFinishTask: finishMock,
  narrativeExtractionFailTask: failMock,
  narrativeExtractionCreateRun: createRunMock,
  narrativeExtractionCancelRun: cancelRunMock,
  narrativeExtractionGetRun: getRunMock,
  narrativeExtractionGetRunReviewBundle: getRunReviewBundleMock,
}));

vi.mock("./runRepository", async () => {
  const actual =
    await vi.importActual<typeof import("./runRepository")>("./runRepository");
  return {
    ...actual,
    createRun: createRunMock,
    cancelRun: cancelRunMock,
    getRun: getRunMock,
  };
});

vi.mock("./proposalRepository", () => ({
  buildChronicleProposalSetPayload: buildProposalSetPayloadMock,
  buildSnapshotSourceBasis: buildSnapshotSourceBasisMock,
}));

vi.mock("./chronicleV2Production", () => ({
  buildChronicleProductionV2Envelopes: buildProductionV2EnvelopesMock,
  CHRONICLE_SCENE_EVENT_V2_PRODUCTION: true,
}));

vi.mock("@/features/chronicle/extraction/windowPlanner", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/chronicle/extraction/windowPlanner")
  >("@/features/chronicle/extraction/windowPlanner");
  planExtractionWindowsMock.mockImplementation(actual.planExtractionWindows);
  return { ...actual, planExtractionWindows: planExtractionWindowsMock };
});

import {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_SURFACE_PATH,
  CHRONICLE_EXTRACT_TASK_KINDS,
  runChronicleExtractionCoordinator,
  type ChronicleExtractionRequest,
  type ExtractionCoordinatorDeps,
} from "./extractionCoordinator";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  buildChronicleStageTerminalReceiptV1,
  createStageModelExecutionBindingV1,
  type ChronicleStageTerminalReceiptV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import type { NarrativeStageExecutionContext } from "@/features/narrative-extraction/reconciler/stageExecution";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";

const TEST_DIGEST = `sha256:${"a".repeat(64)}` as const;
const TEST_WORKSPACE_BINDING = {
  authorityId: "workspace:a",
  generation: 1,
  authorityInstanceId: "1",
} as const;
const CHRONICLE_TASK_CHAIN = [
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
const COMPLETED_PREFIX = new Set(CHRONICLE_TASK_CHAIN.slice(0, 6));

function prose(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text ? [{ type: "text", text }] : [],
      },
    ],
  });
}

function authority() {
  return {
    projectId: "project-a",
    currentProjectId: () => "project-a",
    workspacePath: "/workspace/a",
    workspaceOpenRevision: 1,
  } as const;
}

function request(runId: string, resume = false): ChronicleExtractionRequest {
  return {
    projectId: "project-a",
    folderId: "folder-1",
    language: "ja",
    sceneIds: ["scene-one", "scene-two"],
    authority: authority(),
    runId,
    ...(resume ? { resume: true } : {}),
  };
}

async function fixtureSnapshot(
  snapshotId: string,
): Promise<NarrativeCorpusSnapshot> {
  const built = await buildNarrativeCorpusSnapshot({
    snapshotId,
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "project-a" },
    documents: [
      {
        sourceKey: "project:scene:one",
        parentSourceKey: null,
        title: "門",
        orderIndex: 0,
        proseMirrorJson: prose("門が開いた。"),
        origin: {
          kind: "project-node",
          projectId: "project-a",
          nodeId: "scene-one",
          sourceVersion: 1,
          sourceUpdatedAt: "2026-09-05T00:00:00.000Z",
          sourceUri: null,
        },
      },
      {
        sourceKey: "project:scene:two",
        parentSourceKey: null,
        title: "灯り",
        orderIndex: 1,
        proseMirrorJson: prose("灯りが消えた。"),
        origin: {
          kind: "project-node",
          projectId: "project-a",
          nodeId: "scene-two",
          sourceVersion: 1,
          sourceUpdatedAt: "2026-09-05T00:00:00.000Z",
          sourceUri: null,
        },
      },
    ],
    omissions: [],
    createdAt: "2026-09-05T00:00:00.000Z",
  });
  if (!built.ok) throw new Error("synthetic snapshot did not build");
  return built.snapshot;
}

async function emitStageReceipt(input: {
  readonly stageExecution: NarrativeStageExecutionContext | undefined;
  readonly onStageReceipt:
    | ((receipt: ChronicleStageTerminalReceiptV1) => void | Promise<void>)
    | undefined;
}): Promise<void> {
  if (!input.stageExecution) throw new Error("missing stage execution");
  await input.onStageReceipt?.(
    await buildChronicleStageTerminalReceiptV1({
      stageExecution: input.stageExecution,
      contextSetVersion: "chronicle-context-set/1",
      contextSetDigest: TEST_DIGEST,
      componentContractDigest: TEST_DIGEST,
      finalRequestDigest: TEST_DIGEST,
      modelExecutionBinding: createStageModelExecutionBindingV1({
        resolutionStatus: "unresolved",
      }),
      responseDigest: TEST_DIGEST,
      rawObservationsDigest: TEST_DIGEST,
      parsedOutputDigest: TEST_DIGEST,
      parseStatus: "parsed",
      terminalStatus: "succeeded",
    }),
  );
}

function idObserver(
  calls: Array<{
    readonly windowId: string;
    readonly bindingDigest: string;
    readonly bindingWindowCount: number;
  }>,
): NonNullable<ExtractionCoordinatorDeps["observeWithAi"]> {
  return async ({
    windows,
    evidenceMode,
    evidenceSpanCatalogBinding,
    stageExecution,
    onStageReceipt,
  }) => {
    if (windows.length !== 1)
      throw new Error("observer received multiple windows");
    if (
      evidenceMode !== CITATION_ID_OBSERVATION_EVIDENCE_MODE ||
      !evidenceSpanCatalogBinding
    ) {
      throw new Error("observer did not receive the citation binding");
    }
    const window = windows[0];
    if (!window?.windowId) throw new Error("observer window id is missing");
    const bindingWindow = evidenceSpanCatalogBinding.windows[0];
    if (!bindingWindow || bindingWindow.windowId !== window.windowId) {
      throw new Error("observer binding is not the exact request window");
    }
    const alias = evidenceSpanCatalogBinding.aliases.find((entry) =>
      entry.windowIds.includes(window.windowId!),
    );
    if (!alias) throw new Error("observer binding has no visible alias");
    const catalogEntry = evidenceSpanCatalogBinding.catalog.entries.find(
      (entry) => entry.sourceRef === alias.canonicalSourceRef,
    );
    if (!catalogEntry) throw new Error("observer alias has no catalog entry");
    calls.push({
      windowId: window.windowId,
      bindingDigest: evidenceSpanCatalogBinding.catalogDigest,
      bindingWindowCount: evidenceSpanCatalogBinding.windows.length,
    });
    await emitStageReceipt({ stageExecution, onStageReceipt });
    return [
      {
        localId: "model-observation-1",
        evidence: [
          {
            sourceRef: catalogEntry.sourceRef,
            quote: catalogEntry.quote,
          },
        ],
        assertion: {
          attribution: "narrator",
          narrativeFrame: "story-world",
        },
        payload: {
          predicate: catalogEntry.quote.replace(/。$/u, ""),
          actuality: "actual",
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      },
    ];
  };
}

function successfulSynthesizer(): NonNullable<
  ExtractionCoordinatorDeps["synthesizeWithAi"]
> {
  return async ({
    clusterRef,
    observations,
    stageExecution,
    onStageReceipt,
    onTerminalOutput,
  }) => {
    if (!stageExecution) throw new Error("missing synthesis stage execution");
    const hypotheses = [
      {
        hypothesisId: `hypothesis-${clusterRef}`,
        clusterRef,
        observationRefs: observations.map((observation) => observation.localId),
        titleSuggestion: "観測された出来事",
        summary: observations[0]?.payload.predicate ?? "観測",
        actuality: "actual",
        significance: "major",
      } satisfies EventHypothesis,
    ];
    await emitStageReceipt({ stageExecution, onStageReceipt });
    await onTerminalOutput?.({
      rootStageExecution: stageExecution,
      terminalStageExecution: stageExecution,
      disposition: "root-success",
      clusterRef,
      rawObservations: observations,
      eventOutput: {
        clusterRef,
        resolution: "single-event",
        events: [
          {
            observationRefs: observations.map(
              (observation) => observation.localId,
            ),
            titleSuggestion: "観測された出来事",
            summary: observations[0]?.payload.predicate ?? "観測",
            actuality: "actual",
            significance: "major",
          },
        ],
      },
      hypotheses,
      rawObservationsDigest: TEST_DIGEST,
      parsedOutputDigest: TEST_DIGEST,
    });
    return hypotheses;
  };
}

function installNativeMocks(): void {
  captureWorkspaceBindingMock.mockResolvedValue(TEST_WORKSPACE_BINDING);
  let taskSequence = 0;
  createRunMock.mockImplementation(async (payload: CreateRunPayload) => ({
    runId: payload.runId ?? "run-citation-coordinator",
    status: "running",
    taskIds: [],
  }));
  claimMock.mockImplementation(
    async (payload: { taskKinds?: readonly string[] }) => {
      taskSequence += 1;
      const taskKind = payload.taskKinds?.[0] ?? "unknown";
      return {
        claimed: true,
        task: {
          taskId: `task-${taskSequence}`,
          runId: "run-citation-coordinator",
          taskKind,
          status: "running",
          inputJson: {},
          attemptId: `attempt-${taskSequence}`,
          attemptNumber: 1,
          leaseOwner: "test",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      };
    },
  );
  finishMock.mockImplementation(async (payload: FinishTaskPayload) => ({
    taskId: payload.taskId,
    attemptId: payload.attemptId,
    status: "completed",
    ...(payload.chroniclePlanProposalSet
      ? {
          proposalSet: {
            proposalSetId:
              payload.chroniclePlanProposalSet.proposalSet.proposalSetId ??
              "missing-proposal-set-id",
            proposals:
              payload.chroniclePlanProposalSet.proposalSet.proposals.map(
                (proposal, index) => ({
                  proposalId: `proposal-${index + 1}`,
                  proposalKey: proposal.proposalKey,
                  revisionId: `revision-${index + 1}`,
                  status: "unreviewed" as const,
                }),
              ),
          },
        }
      : {}),
  }));
  failMock.mockResolvedValue({ status: "failed" });
  cancelRunMock.mockResolvedValue({ status: "cancelled" });
  getRunReviewBundleMock.mockRejectedValue(
    new Error("unexpected cold-process hydration"),
  );
  buildSnapshotSourceBasisMock.mockReturnValue([]);
  buildProposalSetPayloadMock.mockImplementation(
    async (input: {
      readonly runId: string;
      readonly projectId: string;
      readonly proposalSetId?: string;
      readonly summaryJson?: Readonly<Record<string, unknown>>;
      readonly proposals: readonly {
        readonly proposalKey: string;
        readonly payload: Readonly<Record<string, unknown>>;
      }[];
    }) => ({
      runId: input.runId,
      projectId: input.projectId,
      proposalSetId: input.proposalSetId,
      setKind: "chronicle.extract.review@1",
      summaryJson: input.summaryJson,
      proposals: input.proposals.map((proposal) => ({
        proposalKey: proposal.proposalKey,
        kind: "chronicle.create-event@1",
        payloadJson: proposal.payload,
      })),
    }),
  );
  buildProductionV2EnvelopesMock.mockResolvedValue({
    envelopeByProposalKey: new Map(),
    stageReceiptRefs: [],
  });
}

function snapshotBuild(snapshot: NarrativeCorpusSnapshot) {
  return async () => ({
    ok: true as const,
    snapshot,
    scopeAuthorityDocuments: [],
    flush: {
      status: "already-clean" as const,
      blockedDocuments: [],
    },
  });
}

function createIdFactory(prefix: string) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

interface DurablePrefix {
  readonly runPayload: CreateRunPayload;
  readonly artifacts: readonly ReviewBundleArtifact[];
  readonly stageReceipts: readonly ChronicleStageTerminalReceiptV1[];
  readonly taskIdByKind: ReadonlyMap<string, string>;
  readonly finishByTaskId: ReadonlyMap<string, FinishTaskPayload>;
}

function finishPayloads(): readonly FinishTaskPayload[] {
  return finishMock.mock.calls.map(([payload]) => payload as FinishTaskPayload);
}

function durableArtifacts(runId: string): readonly ReviewBundleArtifact[] {
  let artifactIndex = 0;
  return finishPayloads().flatMap((payload, payloadIndex) =>
    (payload.artifacts ?? []).map((artifact, itemIndex) => {
      artifactIndex += 1;
      return {
        artifactId:
          artifact.artifactId ??
          `durable-artifact-${payloadIndex + 1}-${itemIndex + 1}-${artifactIndex}`,
        runId,
        taskId: payload.taskId,
        attemptId: payload.attemptId,
        artifactKind: artifact.artifactKind,
        payloadStorage: artifact.payloadStorage ?? "inline-json",
        payloadJson: artifact.payloadJson ?? null,
        payloadRef: artifact.payloadRef ?? null,
        payloadDigest: TEST_DIGEST,
        createdAt: `2026-09-05T00:00:${String(artifactIndex).padStart(2, "0")}.000Z`,
      } satisfies ReviewBundleArtifact;
    }),
  );
}

function captureDurablePrefix(
  runPayload: CreateRunPayload,
  runId: string,
): DurablePrefix {
  const taskIdByKind = new Map<string, string>();
  claimMock.mock.calls.forEach(([rawPayload], index) => {
    const payload = rawPayload as { taskKinds?: readonly string[] };
    const taskKind = payload.taskKinds?.[0];
    if (taskKind) taskIdByKind.set(taskKind, `task-${index + 1}`);
  });
  const finishByTaskId = new Map(
    finishPayloads().map((payload) => [payload.taskId, payload] as const),
  );
  const stageReceipts = finishPayloads().flatMap(
    (payload) => payload.chronicleStageReceipts ?? [],
  );
  return {
    runPayload,
    artifacts: durableArtifacts(runId),
    stageReceipts,
    taskIdByKind,
    finishByTaskId,
  };
}

function coordinatorContractDigest(prefix: DurablePrefix): string {
  const digest = prefix.runPayload.specJson.coordinatorContractDigest;
  if (typeof digest !== "string") {
    throw new Error("sealed coordinator contract digest is missing");
  }
  return digest;
}

function runProjection(prefix: DurablePrefix, runId: string) {
  const tasks = CHRONICLE_TASK_CHAIN.map((taskKind, index) => {
    const taskId = prefix.taskIdByKind.get(taskKind) ?? `task-${index + 1}`;
    const finished = prefix.finishByTaskId.get(taskId);
    const status = COMPLETED_PREFIX.has(taskKind) ? "completed" : "queued";
    return {
      taskId,
      runId,
      taskKind,
      status,
      inputJson: { stage: index + 1 },
      outputJson: finished?.outputJson ?? null,
      priority: CHRONICLE_TASK_CHAIN.length - index,
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      errorMessage: null,
      createdAt: "2026-09-05T00:00:00.000Z",
      startedAt: null,
      completedAt: status === "completed" ? "2026-09-05T00:00:00.000Z" : null,
      version: 1,
    };
  });
  return {
    run: {
      runId,
      projectId: "project-a",
      surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
      scopeJson: { folderId: "folder-1", sceneIds: ["scene-one", "scene-two"] },
      specJson: prefix.runPayload.specJson,
      specDigest: prefix.runPayload.specDigest,
      snapshotDigest: prefix.runPayload.snapshotDigest,
      catalogDigest: prefix.runPayload.catalogDigest,
      registryDigest: null,
      status: "running" as const,
      coverageJson: prefix.runPayload.coverageJson ?? {},
      outcomeSummaryJson: null,
      createdAt: "2026-09-05T00:00:00.000Z",
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: null,
      version: 1,
    },
    tasks,
    taskCounts: {
      queued: 3,
      running: 0,
      completed: 6,
      failed: 0,
      cancelled: 0,
    },
  };
}

function installResumeMocks(
  prefix: DurablePrefix,
  runId: string,
  artifacts = prefix.artifacts,
): void {
  resetNarrativeArtifactIndexForTests();
  resetNarrativeExtractionRunIndexForTests();
  vi.clearAllMocks();
  setCurrentWorkspaceIdentity({ path: "/workspace/a", openRevision: 1 });
  installNativeMocks();
  let taskSequence = 6;
  claimMock.mockImplementation(
    async (payload: { taskKinds?: readonly string[] }) => {
      taskSequence += 1;
      return {
        claimed: true,
        task: {
          taskId: `task-${taskSequence}`,
          runId,
          taskKind: payload.taskKinds?.[0] ?? "unknown",
          status: "running",
          inputJson: {},
          attemptId: `resume-attempt-${taskSequence}`,
          attemptNumber: 1,
          leaseOwner: "test",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      };
    },
  );
  getRunMock.mockResolvedValue(runProjection(prefix, runId));
  const bundle: GetRunReviewBundleResult = {
    runId,
    projectId: "project-a",
    artifacts,
    stageReceipts: prefix.stageReceipts,
    proposalSet: null,
    proposals: [],
  };
  getRunReviewBundleMock.mockResolvedValue(bundle);
}

async function createInterruptedIdRun(
  snapshot: NarrativeCorpusSnapshot,
  runId: string,
): Promise<DurablePrefix> {
  const observationCalls: Array<{
    readonly windowId: string;
    readonly bindingDigest: string;
    readonly bindingWindowCount: number;
  }> = [];
  const runPayloadPromise = new Promise<CreateRunPayload>((resolve) => {
    createRunMock.mockImplementationOnce(async (payload: CreateRunPayload) => {
      resolve(payload);
      return { runId, status: "running", taskIds: [] };
    });
  });
  await expect(
    runChronicleExtractionCoordinator(request(runId), {
      useAi: true,
      createId: createIdFactory("prefix"),
      buildSnapshot: snapshotBuild(snapshot),
      observeWithAi: idObserver(observationCalls),
      synthesizeWithAi: async () => {
        throw new Error("simulated process exit after ID observation");
      },
    }),
  ).rejects.toThrow("simulated process exit after ID observation");
  const runPayload = await runPayloadPromise;
  return captureDurablePrefix(runPayload, runId);
}

function snapshotArtifact(prefix: DurablePrefix): ReviewBundleArtifact {
  const artifact = prefix.artifacts.find(
    (candidate) =>
      candidate.artifactKind === CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
  );
  if (!artifact) throw new Error("durable snapshot artifact is missing");
  return artifact;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tamperSnapshotArtifact(
  prefix: DurablePrefix,
  mutate: (evidence: Record<string, unknown>) => Record<string, unknown>,
): readonly ReviewBundleArtifact[] {
  return prefix.artifacts.map((artifact) => {
    if (
      artifact.artifactKind !== CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot ||
      !artifact.payloadJson
    ) {
      return artifact;
    }
    const payload = cloneJson(artifact.payloadJson);
    const evidence = payload.evidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new Error("snapshot evidence companion is missing in fixture");
    }
    return {
      ...artifact,
      payloadJson: {
        ...payload,
        evidence: mutate(evidence as Record<string, unknown>),
      },
    };
  });
}

describe("runChronicleExtractionCoordinator citation-ID lane", () => {
  beforeEach(() => {
    setCurrentWorkspaceIdentity({ path: "/workspace/a", openRevision: 1 });
    resetNarrativeArtifactIndexForTests();
    resetNarrativeExtractionRunIndexForTests();
    vi.clearAllMocks();
    planExtractionWindowsMock.mockClear();
    installNativeMocks();
  });

  it("defaults AI runs to citation-ID, binds exactly one window, and persists the companion", async () => {
    const snapshot = await fixtureSnapshot("snapshot-citation-fresh");
    const observationCalls: Array<{
      readonly windowId: string;
      readonly bindingDigest: string;
      readonly bindingWindowCount: number;
    }> = [];

    const result = await runChronicleExtractionCoordinator(
      request("run-citation-fresh"),
      {
        useAi: true,
        createId: createIdFactory("fresh"),
        buildSnapshot: snapshotBuild(snapshot),
        observeWithAi: idObserver(observationCalls),
        synthesizeWithAi: successfulSynthesizer(),
      },
    );

    expect(result.runId).toBe("run-citation-fresh");
    expect(observationCalls).toHaveLength(snapshot.documents.length);
    expect(
      observationCalls.every((call) => call.bindingWindowCount === 1),
    ).toBe(true);
    expect(
      new Set(observationCalls.map((call) => call.bindingDigest)).size,
    ).toBe(1);

    const createPayload = createRunMock.mock.calls[0]?.[0] as
      | CreateRunPayload
      | undefined;
    expect(createPayload?.coverageJson).toMatchObject({
      mode: "complete",
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      evidenceCatalogDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const snapshotFinish = finishPayloads().find((payload) =>
      payload.artifacts?.some(
        (artifact) =>
          artifact.artifactKind === CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
      ),
    );
    const snapshotInput = snapshotFinish?.artifacts?.find(
      (artifact) =>
        artifact.artifactKind === CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
    );
    const snapshotPayload = snapshotInput?.payloadJson;
    const companion = snapshotPayload?.evidence;
    expect(companion).toMatchObject({
      kind: "chronicle.snapshot-evidence-companion@1",
      version: 1,
      mode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      snapshotDigest: snapshot.digest,
      snapshotArtifactDigest: snapshot.artifactDigest,
      catalogDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      catalog: expect.objectContaining({
        kind: "narrative-evidence-span-catalog",
        version: 1,
      }),
    });
    if (
      !companion ||
      typeof companion !== "object" ||
      Array.isArray(companion)
    ) {
      throw new Error("citation companion was not persisted");
    }
    const typedCompanion = companion as {
      readonly catalogDigest?: unknown;
      readonly catalog?: { readonly digest?: unknown };
    };
    expect(typedCompanion.catalogDigest).toBe(typedCompanion.catalog?.digest);
    expect(createPayload?.coverageJson?.evidenceCatalogDigest).toBe(
      typedCompanion.catalogDigest,
    );
    expect(snapshotFinish?.outputJson).toMatchObject({
      snapshotDigest: snapshot.digest,
      corpusPayloadDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const observationFinish = finishPayloads().find((payload) =>
      payload.artifacts?.some(
        (artifact) =>
          artifact.artifactKind ===
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
      ),
    );
    expect(observationFinish?.outputJson).toEqual({ observationCount: 2 });
  });

  it("cold-resumes an ID run from sealed artifacts without rebuilding a live snapshot", async () => {
    const snapshot = await fixtureSnapshot("snapshot-citation-resume");
    const prefix = await createInterruptedIdRun(
      snapshot,
      "run-citation-resume",
    );
    const originalSnapshot = snapshotArtifact(prefix);
    const originalPayload = originalSnapshot.payloadJson;
    if (!originalPayload) throw new Error("snapshot payload is missing");
    const originalCompanion = originalPayload.evidence;
    if (!originalCompanion || typeof originalCompanion !== "object") {
      throw new Error("snapshot companion is missing");
    }

    installResumeMocks(prefix, "run-citation-resume");
    const buildSnapshot = vi.fn(async () => {
      throw new Error("resume must not rebuild a live snapshot");
    });
    const observeWithAi: NonNullable<
      ExtractionCoordinatorDeps["observeWithAi"]
    > = async () => {
      throw new Error("completed ID observation must not dispatch again");
    };
    const resumed = await runChronicleExtractionCoordinator(
      {
        ...request("run-citation-resume", true),
        specDigest: coordinatorContractDigest(prefix),
      },
      {
        useAi: true,
        createId: createIdFactory("resume"),
        buildSnapshot,
        observeWithAi,
        synthesizeWithAi: successfulSynthesizer(),
      },
    );

    expect(resumed.runId).toBe("run-citation-resume");
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(createRunMock).not.toHaveBeenCalled();
    expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);
    expect(originalCompanion).toMatchObject({
      mode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    });
    const resumeClaims = claimMock.mock.calls.map(
      ([payload]) =>
        (payload as { taskKinds?: readonly string[] }).taskKinds?.[0],
    );
    expect(resumeClaims).toEqual([
      CHRONICLE_EXTRACT_TASK_KINDS.synthesize,
      CHRONICLE_EXTRACT_TASK_KINDS.matchExisting,
      CHRONICLE_EXTRACT_TASK_KINDS.planProposals,
    ]);
  });

  it("rejects app-like cold resume when an ID coverage marker has no companion", async () => {
    const snapshot = await fixtureSnapshot(
      "snapshot-citation-missing-companion",
    );
    const prefix = await createInterruptedIdRun(
      snapshot,
      "run-citation-missing-companion",
    );
    const artifacts = prefix.artifacts.map((artifact) => {
      if (
        artifact.artifactKind !== CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot ||
        !artifact.payloadJson
      ) {
        return artifact;
      }
      const payload = cloneJson(artifact.payloadJson);
      const { evidence: _evidence, ...withoutEvidence } = payload;
      return { ...artifact, payloadJson: withoutEvidence };
    });
    installResumeMocks(prefix, "run-citation-missing-companion", artifacts);

    await expect(
      runChronicleExtractionCoordinator(
        {
          ...request("run-citation-missing-companion", true),
          specDigest: coordinatorContractDigest(prefix),
        },
        {
          useAi: true,
          createId: createIdFactory("missing-companion"),
          buildSnapshot: vi.fn(async () => {
            throw new Error("resume must not rebuild a live snapshot");
          }),
          observeWithAi: async () => {
            throw new Error("missing companion must reject before observe");
          },
          synthesizeWithAi: successfulSynthesizer(),
        },
      ),
    ).rejects.toThrow(/NEX_CHRONICLE_RESUME_EVIDENCE_COMPANION_MISSING/u);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "stale catalog entry",
      mutate: (evidence: Record<string, unknown>) => {
        const catalog = cloneJson(evidence.catalog) as Record<string, unknown>;
        const entries = Array.isArray(catalog.entries)
          ? [...catalog.entries]
          : [];
        const first = entries[0];
        if (!first || typeof first !== "object") {
          throw new Error("catalog fixture entry is missing");
        }
        entries[0] = { ...(first as Record<string, unknown>), quote: "改竄" };
        return { ...evidence, catalog: { ...catalog, entries } };
      },
      error: /NEX_CHRONICLE_RESUME_EVIDENCE_CATALOG_INVALID/u,
    },
    {
      label: "tampered catalog digest",
      mutate: (evidence: Record<string, unknown>) => ({
        ...evidence,
        catalogDigest: `sha256:${"b".repeat(64)}`,
      }),
      error: /NEX_CHRONICLE_RESUME_EVIDENCE_(?:COMPANION|CATALOG)/u,
    },
    {
      label: "unknown companion mode",
      mutate: (evidence: Record<string, unknown>) => ({
        ...evidence,
        mode: "citation-id-v3",
      }),
      error: /NEX_CHRONICLE_RESUME_EVIDENCE_COMPANION_MISMATCH/u,
    },
    {
      label: "unknown companion version",
      mutate: (evidence: Record<string, unknown>) => ({
        ...evidence,
        version: 99,
      }),
      error: /NEX_CHRONICLE_RESUME_EVIDENCE_COMPANION_MISMATCH/u,
    },
  ])(
    "rejects $label before any resumed provider dispatch",
    async ({ mutate, error }) => {
      const snapshot = await fixtureSnapshot(
        `snapshot-citation-${String(mutate)}`,
      );
      const runId = "run-citation-tamper";
      const prefix = await createInterruptedIdRun(snapshot, runId);
      const artifacts = tamperSnapshotArtifact(prefix, mutate);
      installResumeMocks(prefix, runId, artifacts);

      await expect(
        runChronicleExtractionCoordinator(
          {
            ...request(runId, true),
            specDigest: coordinatorContractDigest(prefix),
          },
          {
            useAi: true,
            createId: createIdFactory("tampered"),
            buildSnapshot: vi.fn(async () => {
              throw new Error("tampered resume must not rebuild snapshot");
            }),
            observeWithAi: async () => {
              throw new Error("tampered companion must reject before observe");
            },
            synthesizeWithAi: successfulSynthesizer(),
          },
        ),
      ).rejects.toThrow(error);
      expect(claimMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an evidence coverage hole before the first observer dispatch", async () => {
    const snapshot = await fixtureSnapshot("snapshot-citation-coverage-hole");
    planExtractionWindowsMock.mockImplementationOnce(() => ({ windows: [] }));
    const observeWithAi = vi.fn(async () => {
      throw new Error("coverage hole must reject before provider dispatch");
    });

    await expect(
      runChronicleExtractionCoordinator(request("run-citation-coverage-hole"), {
        useAi: true,
        createId: createIdFactory("coverage-hole"),
        buildSnapshot: snapshotBuild(snapshot),
        observeWithAi,
        synthesizeWithAi: successfulSynthesizer(),
      }),
    ).rejects.toThrow(/Evidence span catalog coverage hole/u);
    expect(observeWithAi).not.toHaveBeenCalled();
    expect(createRunMock).not.toHaveBeenCalled();
  });
});
