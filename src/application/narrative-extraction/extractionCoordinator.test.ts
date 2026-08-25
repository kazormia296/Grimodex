import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import { resetNarrativeArtifactIndexForTests } from "./artifactRepository";
import { resetNarrativeExtractionRunIndexForTests } from "./runRepository";

const claimMock = vi.hoisted(() => vi.fn());
const finishMock = vi.hoisted(() => vi.fn());
const failMock = vi.hoisted(() => vi.fn());
const createRunMock = vi.hoisted(() => vi.fn());
const cancelRunMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const getRunReviewBundleMock = vi.hoisted(() => vi.fn());
const saveProposalSetMock = vi.hoisted(() => vi.fn());
const buildSnapshotSourceBasisMock = vi.hoisted(() => vi.fn());
const buildProductionV2EnvelopesMock = vi.hoisted(() => vi.fn());

vi.mock("./nativeApi", () => ({
  narrativeExtractionClaimTask: claimMock,
  narrativeExtractionFinishTask: finishMock,
  narrativeExtractionFailTask: failMock,
  narrativeExtractionCreateRun: createRunMock,
  narrativeExtractionCancelRun: cancelRunMock,
  narrativeExtractionGetRun: getRunMock,
  narrativeExtractionGetRunReviewBundle: getRunReviewBundleMock,
  narrativeExtractionSaveProposalSet: saveProposalSetMock,
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
  saveChronicleProposalSet: saveProposalSetMock,
  buildSnapshotSourceBasis: buildSnapshotSourceBasisMock,
}));

vi.mock("./chronicleV2Production", () => ({
  buildChronicleProductionV2Envelopes: buildProductionV2EnvelopesMock,
  CHRONICLE_SCENE_EVENT_V2_PRODUCTION: true,
}));

import {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_SURFACE_PATH,
  CHRONICLE_EXTRACT_TASK_KINDS,
  runChronicleExtractionCoordinator,
} from "./extractionCoordinator";
import { loadInlineJsonArtifact } from "./artifactRepository";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import { clusterEventObservations } from "@/features/chronicle/extraction/eventClustering";
import {
  buildChronicleStageTerminalReceiptV1,
  createStageModelExecutionBindingV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";

const TEST_STAGE_DIGEST = `sha256:${"a".repeat(64)}` as const;

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

function authority(): MutationAuthority {
  return {
    projectId: "project-a",
    currentProjectId: () => "project-a",
    workspacePath: null,
    workspaceOpenRevision: null,
  };
}

describe("runChronicleExtractionCoordinator (fake path)", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    resetNarrativeExtractionRunIndexForTests();
    vi.clearAllMocks();

    let taskSeq = 0;
    createRunMock.mockImplementation(async (payload: { runId?: string }) => ({
      runId: payload.runId ?? "run-1",
      status: "running",
      taskIds: [],
    }));
    cancelRunMock.mockResolvedValue({ runId: "run-1", status: "cancelled" });
    getRunReviewBundleMock.mockRejectedValue(
      new Error("unexpected cold-process hydration"),
    );
    buildSnapshotSourceBasisMock.mockReturnValue([]);
    claimMock.mockImplementation(async (payload: { taskKinds?: string[] }) => {
      taskSeq += 1;
      const taskKind = payload.taskKinds?.[0] ?? "unknown";
      return {
        claimed: true,
        task: {
          taskId: `task-${taskSeq}`,
          runId: "run-1",
          taskKind,
          status: "running",
          inputJson: {},
          attemptId: `attempt-${taskSeq}`,
          attemptNumber: 1,
          leaseOwner: "test",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      };
    });
    finishMock.mockResolvedValue({
      taskId: "task",
      attemptId: "attempt",
      status: "completed",
    });
    failMock.mockResolvedValue({
      taskId: "task",
      attemptId: "attempt",
      status: "failed",
    });
    saveProposalSetMock.mockResolvedValue({
      proposalSetId: "proposal-set-1",
      proposals: [
        {
          proposalId: "proposal-1",
          proposalKey: "key",
          revisionId: "rev-1",
          status: "unreviewed",
        },
      ],
    });
    buildProductionV2EnvelopesMock.mockResolvedValue({
      envelopeByProposalKey: new Map([
        ["test-proposal-key", { schemaVersion: 2 }],
      ]),
      stageReceiptRefs: [
        {
          stageExecutionId: "stage:test-synthesis",
          stageExecutionReceiptDigest: `sha256:${"a".repeat(64)}`,
        },
      ],
    });
  });

  it("runs the fake extractor DAG and persists proposals", async () => {
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-coord",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "籠城",
          orderIndex: 0,
          proseMirrorJson: prose(
            "教会の尖塔が砲撃で崩れ落ちた。兵士たちは避難した。",
          ),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-one",
            sourceVersion: 3,
            sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
      omissions: [],
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const result = await runChronicleExtractionCoordinator(
      {
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-one"],
        authority: authority(),
        runId: "run-1",
      },
      {
        useAi: false,
        createId: (() => {
          let n = 0;
          return () => `id-${++n}`;
        })(),
        buildSnapshot: async () => ({
          ok: true as const,
          snapshot: built.snapshot,
          scopeAuthorityDocuments: [
            {
              documentRef: "D000001",
              sourceKey: "project:scene:one",
              rawStoryKey: "story-10",
            },
          ],
          flush: {
            status: "already-clean" as const,
            blockedDocuments: [],
          },
        }),
      },
    );

    expect(result.runId).toBe("run-1");
    expect(result.savedProposalSetId).toBe("proposal-set-1");
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals[0]).toMatchObject({
      actuality: "actual",
      significance: "major",
      disclosure: { secret: true },
    });
    expect(result.proposals[0].evidenceAnchorIds.length).toBeGreaterThan(0);

    expect(createRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
        projectId: "project-a",
      }),
    );
    expect(claimMock).toHaveBeenCalled();
    expect(finishMock).toHaveBeenCalled();
    expect(finishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        historicalScopeAuthorityBasis: expect.objectContaining({
          schemaVersion: 2,
          contractId: "narrative-scope-authority-basis/2",
          basisKind: "historical-run-snapshot",
          projectId: "project-a",
          source: {
            sourceKind: "snapshot-document",
            sourceKey: "snapshot:run-1",
          },
          mappings: [
            expect.objectContaining({
              documentRef: "D000001",
              sourceKey: "project:scene:one",
              sceneRef: "scene:one",
              readingOrderRef: "reading:one",
              storyTimeRef: "story:one",
              readingRank: 0,
              storyTimeOrder: {
                status: "resolved",
                rawStoryKey: "story-10",
                storyRank: 0,
              },
            }),
          ],
          digests: expect.objectContaining({
            corpusDigest: built.snapshot.digest,
            compositeDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          }),
        }),
      }),
    );
    const finishPayloads = finishMock.mock.calls.map(
      ([payload]) => payload as Record<string, unknown>,
    );
    expect(finishPayloads[0]?.historicalScopeAuthorityBasis).toBeDefined();
    expect(
      finishPayloads
        .slice(1)
        .every((payload) => !("historicalScopeAuthorityBasis" in payload)),
    ).toBe(true);
    expect(saveProposalSetMock).toHaveBeenCalled();
  });

  it("rekeys AI observe localIds so multi-window obs-1 batches do not collide", async () => {
    const quoteOne = "教会の尖塔が砲撃で崩れ落ちた。";
    const quoteTwo = "兵士たちは避難した。";
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-coord-ai-observe",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "籠城",
          orderIndex: 0,
          proseMirrorJson: prose(quoteOne),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-one",
            sourceVersion: 3,
            sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
            sourceUri: null,
          },
        },
        {
          sourceKey: "project:scene:two",
          parentSourceKey: null,
          title: "避難",
          orderIndex: 1,
          proseMirrorJson: prose(quoteTwo),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-two",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
      omissions: [],
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const observeCalls: string[] = [];
    const synthesizeObservationIds: string[][] = [];

    const result = await runChronicleExtractionCoordinator(
      {
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-one", "scene-two"],
        authority: authority(),
        runId: "run-ai-observe",
      },
      {
        useAi: true,
        createId: (() => {
          let n = 0;
          return () => `id-${++n}`;
        })(),
        buildSnapshot: async () => ({
          ok: true as const,
          snapshot: built.snapshot,
          scopeAuthorityDocuments: [],
          flush: {
            status: "already-clean" as const,
            blockedDocuments: [],
          },
        }),
        observeWithAi: async ({ windows }) => {
          const window = windows[0];
          if (!window) return [];
          observeCalls.push(window.sourceRef);
          return [
            {
              localId: "obs-1",
              evidence: [
                {
                  sourceRef: window.sourceRef,
                  quote: window.text.includes(quoteOne) ? quoteOne : quoteTwo,
                },
              ],
              assertion: {
                attribution: "narrator",
                narrativeFrame: "story-world",
              },
              payload: {
                // Shared predicate → same cluster; Map collision would drop one.
                predicate: "砲撃で崩れ落ちた",
                actuality: "actual",
                participants: [],
                temporalExpressions: [],
                durationKind: "instant",
              },
            },
          ];
        },
        synthesizeWithAi: async ({
          clusterRef,
          observations,
          createId,
          onStageReceipt,
          onTerminalOutput,
          stageExecution,
        }) => {
          if (!stageExecution) throw new Error("missing synthesis stage");
          synthesizeObservationIds.push(
            observations.map((observation) => observation.localId),
          );
          const nextId = createId ?? (() => "hypothesis-test-id");
          const hypotheses = [
            {
              hypothesisId: nextId(),
              clusterRef,
              observationRefs: observations.map(
                (observation) => observation.localId,
              ),
              titleSuggestion: "砲撃",
              summary: "砲撃で崩れ落ちた",
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
                  (observation) => observation.localId,
                ),
                titleSuggestion: "砲撃",
                summary: "砲撃で崩れ落ちた",
                actuality: "actual",
                significance: "major",
              },
            ],
          } as const;
          await onStageReceipt?.(
            await buildChronicleStageTerminalReceiptV1({
              stageExecution,
              contextSetVersion: "chronicle-context-set/1",
              contextSetDigest: TEST_STAGE_DIGEST,
              componentContractDigest: TEST_STAGE_DIGEST,
              finalRequestDigest: TEST_STAGE_DIGEST,
              modelExecutionBinding: createStageModelExecutionBindingV1({
                resolutionStatus: "unresolved",
              }),
              responseDigest: TEST_STAGE_DIGEST,
              rawObservationsDigest: TEST_STAGE_DIGEST,
              parsedOutputDigest: TEST_STAGE_DIGEST,
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
            rawObservationsDigest: TEST_STAGE_DIGEST,
            parsedOutputDigest: TEST_STAGE_DIGEST,
          });
          return hypotheses;
        },
      },
    );

    expect(observeCalls).toHaveLength(2);

    const observationPayload = await loadInlineJsonArtifact<{
      observations: readonly RawChronicleEventObservation[];
    }>("run-ai-observe", CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations);
    expect(observationPayload?.observations).toHaveLength(2);
    const localIds =
      observationPayload?.observations.map((item) => item.localId) ?? [];
    expect(localIds).toEqual(["window-001:obs-001", "window-002:obs-001"]);
    expect(new Set(localIds).size).toBe(2);

    const clusters = clusterEventObservations(
      observationPayload?.observations ?? [],
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.observationRefs).toEqual([
      "window-001:obs-001",
      "window-002:obs-001",
    ]);

    expect(synthesizeObservationIds).toEqual([
      ["window-001:obs-001", "window-002:obs-001"],
    ]);

    // Downstream Maps keyed by localId must retain both observations.
    const observationById = new Map(
      (observationPayload?.observations ?? []).map((observation) => [
        observation.localId,
        observation,
      ]),
    );
    expect(observationById.size).toBe(2);
    expect(localIds.every((id) => observationById.has(id))).toBe(true);
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(buildProductionV2EnvelopesMock).toHaveBeenCalledTimes(1);
    expect(saveProposalSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        v2EnvelopeByProposalKey: expect.any(Map),
        stageReceiptRefs: [
          expect.objectContaining({
            stageExecutionId: "stage:test-synthesis",
          }),
        ],
      }),
    );
  });

  it("hydrates a completed Observation receipt after restart and continues the same Run at Synthesis", async () => {
    const quote = "教会の尖塔が砲撃で崩れ落ちた。";
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-resume-observation",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "再開",
          orderIndex: 0,
          proseMirrorJson: prose(quote),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-one",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
      omissions: [],
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Produce the durable prefix exactly as the original process would. The
    // injected synthesis failure stands in for its exit after Observation;
    // only completed Task outputs/receipt transport are carried into the
    // fresh-process half below.
    await expect(
      runChronicleExtractionCoordinator(
        {
          projectId: "project-a",
          folderId: "folder-1",
          language: "ja",
          sceneIds: ["scene-one"],
          authority: authority(),
          runId: "run-resume-observation",
        },
        {
          useAi: true,
          createId: (() => {
            let n = 0;
            return () => `first-${++n}`;
          })(),
          buildSnapshot: async () => ({
            ok: true as const,
            snapshot: built.snapshot,
            scopeAuthorityDocuments: [],
            flush: { status: "already-clean" as const, blockedDocuments: [] },
          }),
          observeWithAi: async ({ windows, stageExecution, onStageReceipt }) => {
            if (!stageExecution) throw new Error("missing observation stage");
            await onStageReceipt?.(
              await buildChronicleStageTerminalReceiptV1({
                stageExecution,
                contextSetVersion: "chronicle-context-set/1",
                contextSetDigest: TEST_STAGE_DIGEST,
                componentContractDigest: TEST_STAGE_DIGEST,
                finalRequestDigest: TEST_STAGE_DIGEST,
                modelExecutionBinding: createStageModelExecutionBindingV1({
                  resolutionStatus: "unresolved",
                }),
                responseDigest: TEST_STAGE_DIGEST,
                parseStatus: "parsed",
                terminalStatus: "succeeded",
              }),
            );
            return [
              {
                localId: "resume-observation",
                evidence: [
                  {
                    sourceRef: windows[0]?.sourceRef ?? "S0001",
                    quote,
                  },
                ],
                assertion: {
                  attribution: "narrator",
                  narrativeFrame: "story-world",
                },
                payload: {
                  predicate: "砲撃で崩れ落ちた",
                  actuality: "actual",
                  participants: [],
                  temporalExpressions: [],
                  durationKind: "instant",
                },
              },
            ];
          },
          synthesizeWithAi: async () => {
            throw new Error("simulated process exit before synthesis output");
          },
        },
      ),
    ).rejects.toThrow("simulated process exit before synthesis output");

    const prefixFinishes = finishMock.mock.calls.map(
      ([payload]) => payload as import("./nativeApi").FinishTaskPayload,
    );
    const observationFinish = prefixFinishes.find(
      (payload) => payload.taskId === "task-3",
    );
    expect(observationFinish?.chronicleStageReceipts).toHaveLength(1);
    const durableReceipts = observationFinish?.chronicleStageReceipts ?? [];
    const durableArtifacts = prefixFinishes.flatMap((payload, payloadIndex) =>
      (payload.artifacts ?? []).map((artifact, artifactIndex) => ({
        artifactId:
          artifact.artifactId ?? `durable-${payloadIndex}-${artifactIndex}`,
        runId: "run-resume-observation",
        taskId: payload.taskId,
        attemptId: payload.attemptId,
        artifactKind: artifact.artifactKind,
        payloadStorage: artifact.payloadStorage ?? "inline-json",
        payloadJson: artifact.payloadJson ?? null,
        payloadRef: artifact.payloadRef ?? null,
        // The real Native writer recomputes this digest. The mock only needs
        // to represent a hydrated artifact; Native digest corruption is
        // covered separately below.
        payloadDigest: TEST_STAGE_DIGEST,
        createdAt: `2026-08-10T00:00:0${payloadIndex}.000Z`,
      })),
    );
    const outputFor = (taskId: string) =>
      prefixFinishes.find((payload) => payload.taskId === taskId)?.outputJson ??
      null;

    // Simulate a new renderer process: only Native's review bundle survives.
    resetNarrativeArtifactIndexForTests();
    resetNarrativeExtractionRunIndexForTests();
    vi.clearAllMocks();
    let resumedTaskSeq = 6;
    claimMock.mockImplementation(async (payload: { taskKinds?: string[] }) => {
      resumedTaskSeq += 1;
      return {
        claimed: true,
        task: {
          taskId: `task-${resumedTaskSeq}`,
          runId: "run-resume-observation",
          taskKind: payload.taskKinds?.[0] ?? "unknown",
          status: "running",
          inputJson: {},
          attemptId: `resumed-attempt-${resumedTaskSeq}`,
          attemptNumber: 1,
          leaseOwner: "test",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      };
    });
    finishMock.mockResolvedValue({
      taskId: "task",
      attemptId: "attempt",
      status: "completed",
    });
    failMock.mockResolvedValue({ status: "failed" });
    saveProposalSetMock.mockResolvedValue({
      proposalSetId: "proposal-set-resumed",
      proposals: [
        {
          proposalId: "proposal-resumed",
          proposalKey: "resumed-key",
          revisionId: "revision-resumed",
          status: "unreviewed",
        },
      ],
    });
    buildSnapshotSourceBasisMock.mockReturnValue([]);
    buildProductionV2EnvelopesMock.mockResolvedValue({
      envelopeByProposalKey: new Map(),
      stageReceiptRefs: [],
    });
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-resume-observation",
        projectId: "project-a",
        surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-1", sceneIds: ["scene-one"] },
        specJson: { domain: "chronicle", version: 1 },
        specDigest: `sha256:${"0".repeat(64)}`,
        snapshotDigest: built.snapshot.digest,
        catalogDigest: null,
        registryDigest: null,
        status: "running",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: "2026-08-10T00:00:00.000Z",
        completedAt: null,
        version: 1,
      },
      tasks: [
        [CHRONICLE_EXTRACT_TASK_KINDS.snapshot, "completed", outputFor("task-1")],
        [CHRONICLE_EXTRACT_TASK_KINDS.windowPlan, "completed", outputFor("task-2")],
        [CHRONICLE_EXTRACT_TASK_KINDS.observe, "completed", outputFor("task-3")],
        [CHRONICLE_EXTRACT_TASK_KINDS.resolveEvidence, "completed", outputFor("task-4")],
        [CHRONICLE_EXTRACT_TASK_KINDS.mergeObservations, "completed", outputFor("task-5")],
        [CHRONICLE_EXTRACT_TASK_KINDS.cluster, "completed", outputFor("task-6")],
        [CHRONICLE_EXTRACT_TASK_KINDS.synthesize, "queued", null],
        [CHRONICLE_EXTRACT_TASK_KINDS.matchExisting, "queued", null],
        [CHRONICLE_EXTRACT_TASK_KINDS.planProposals, "queued", null],
      ].map(([taskKind, status, outputJson], index) => ({
        taskId: `task-${index + 1}`,
        runId: "run-resume-observation",
        taskKind,
        status,
        inputJson: {},
        outputJson,
        priority: 9 - index,
        attemptCount: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorMessage: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: null,
        completedAt:
          status === "completed" ? "2026-08-10T00:00:00.000Z" : null,
        version: 1,
      })),
      taskCounts: { queued: 3, running: 0, completed: 6, failed: 0, cancelled: 0 },
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-resume-observation",
      projectId: "project-a",
      artifacts: durableArtifacts,
      stageReceipts: durableReceipts,
      proposalSet: null,
      proposals: [],
    });

    const resumed = await runChronicleExtractionCoordinator(
      {
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-one"],
        authority: authority(),
        runId: "run-resume-observation",
        resume: true,
        specDigest: `sha256:${"0".repeat(64)}`,
      },
      {
        useAi: true,
        buildSnapshot: async () => {
          throw new Error("resume must not rebuild a live snapshot");
        },
        createId: (() => {
          let n = 0;
          return () => `resumed-${++n}`;
        })(),
        synthesizeWithAi: async ({
          clusterRef,
          observations,
          createId,
          onStageReceipt,
          onTerminalOutput,
          stageExecution,
        }) => {
          if (!stageExecution) throw new Error("missing resumed synthesis stage");
          const hypotheses = [
            {
              hypothesisId: (createId ?? (() => "resumed-hypothesis"))(),
              clusterRef,
              observationRefs: observations.map((observation) => observation.localId),
              titleSuggestion: "砲撃",
              summary: "砲撃で崩れ落ちた",
              actuality: "actual",
              significance: "major",
            } satisfies EventHypothesis,
          ];
          const eventOutput = {
            clusterRef,
            resolution: "single-event",
            events: [
              {
                observationRefs: observations.map((observation) => observation.localId),
                titleSuggestion: "砲撃",
                summary: "砲撃で崩れ落ちた",
                actuality: "actual",
                significance: "major",
              },
            ],
          } as const;
          await onStageReceipt?.(
            await buildChronicleStageTerminalReceiptV1({
              stageExecution,
              contextSetVersion: "chronicle-context-set/1",
              contextSetDigest: TEST_STAGE_DIGEST,
              componentContractDigest: TEST_STAGE_DIGEST,
              finalRequestDigest: TEST_STAGE_DIGEST,
              modelExecutionBinding: createStageModelExecutionBindingV1({
                resolutionStatus: "unresolved",
              }),
              responseDigest: TEST_STAGE_DIGEST,
              rawObservationsDigest: TEST_STAGE_DIGEST,
              parsedOutputDigest: TEST_STAGE_DIGEST,
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
            rawObservationsDigest: TEST_STAGE_DIGEST,
            parsedOutputDigest: TEST_STAGE_DIGEST,
          });
          return hypotheses;
        },
      },
    );

    expect(resumed.runId).toBe("run-resume-observation");
    expect(createRunMock).not.toHaveBeenCalled();
    expect(claimMock.mock.calls.map(([payload]) => payload.taskKinds?.[0])).toEqual([
      CHRONICLE_EXTRACT_TASK_KINDS.synthesize,
      CHRONICLE_EXTRACT_TASK_KINDS.matchExisting,
      CHRONICLE_EXTRACT_TASK_KINDS.planProposals,
    ]);
    const synthesisFinish = finishMock.mock.calls
      .map(([payload]) => payload as import("./nativeApi").FinishTaskPayload)
      .find((payload) => payload.taskId === "task-7");
    expect(synthesisFinish?.chronicleStageBundle?.closure.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageExecution: expect.objectContaining({ taskId: "task-3" }),
        }),
        expect.objectContaining({
          stageExecution: expect.objectContaining({ taskId: "task-7" }),
        }),
      ]),
    );
  });

  it("fails Native-detected restart hydration corruption before it claims a task", async () => {
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-corrupt-hydration",
        projectId: "project-a",
        surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-1", sceneIds: ["scene-one"] },
        specJson: { domain: "chronicle", version: 1 },
        specDigest: `sha256:${"0".repeat(64)}`,
        snapshotDigest: TEST_STAGE_DIGEST,
        catalogDigest: null,
        registryDigest: null,
        status: "running",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        version: 1,
      },
      tasks: [
        CHRONICLE_EXTRACT_TASK_KINDS.snapshot,
        CHRONICLE_EXTRACT_TASK_KINDS.windowPlan,
        CHRONICLE_EXTRACT_TASK_KINDS.observe,
        CHRONICLE_EXTRACT_TASK_KINDS.resolveEvidence,
        CHRONICLE_EXTRACT_TASK_KINDS.mergeObservations,
        CHRONICLE_EXTRACT_TASK_KINDS.cluster,
        CHRONICLE_EXTRACT_TASK_KINDS.synthesize,
        CHRONICLE_EXTRACT_TASK_KINDS.matchExisting,
        CHRONICLE_EXTRACT_TASK_KINDS.planProposals,
      ].map((taskKind, index) => ({
        taskId: `corrupt-task-${index}`,
        runId: "run-corrupt-hydration",
        taskKind,
        status: index === 0 ? "completed" : "queued",
        inputJson: {},
        outputJson:
          index === 0 ? { snapshotDigest: TEST_STAGE_DIGEST } : null,
        priority: 9 - index,
        attemptCount: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorMessage: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        version: 1,
      })),
      taskCounts: { queued: 8, running: 0, completed: 1, failed: 0, cancelled: 0 },
    });
    getRunReviewBundleMock.mockRejectedValue(
      new Error(
        "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT: Native canonical payloadDigest mismatch",
      ),
    );

    await expect(
      runChronicleExtractionCoordinator({
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-one"],
        authority: authority(),
        runId: "run-corrupt-hydration",
        resume: true,
        specDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT");
    expect(createRunMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("calls fail_task when a claimed task throws", async () => {
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-fail",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "失敗",
          orderIndex: 0,
          proseMirrorJson: prose("兵士たちは敗走した。"),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-one",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
      omissions: [],
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    await expect(
      runChronicleExtractionCoordinator(
        {
          projectId: "project-a",
          folderId: "folder-1",
          language: "ja",
          sceneIds: ["scene-one"],
          authority: authority(),
          runId: "run-fail",
        },
        {
          useAi: true,
          buildSnapshot: async () => ({
            ok: true as const,
            snapshot: built.snapshot,
            scopeAuthorityDocuments: [],
            flush: {
              status: "already-clean" as const,
              blockedDocuments: [],
            },
          }),
          observeWithAi: async () => {
            throw new Error("model unavailable");
          },
        },
      ),
    ).rejects.toThrow("model unavailable");

    expect(failMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-fail",
        projectId: "project-a",
        leaseOwner: expect.any(String),
        errorMessage: "model unavailable",
        requeue: false,
      }),
    );
  });

  it("fails closed when an invalid/unrepaired synthesis cluster has no accepted typed terminal", async () => {
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-unrepaired-synthesis",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "失敗した統合",
          orderIndex: 0,
          proseMirrorJson: prose("教会の尖塔が砲撃で崩れ落ちた。"),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-one",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
      omissions: [],
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    await expect(
      runChronicleExtractionCoordinator(
        {
          projectId: "project-a",
          folderId: "folder-1",
          language: "ja",
          sceneIds: ["scene-one"],
          authority: authority(),
          runId: "run-unrepaired-synthesis",
        },
        {
          useAi: true,
          buildSnapshot: async () => ({
            ok: true as const,
            snapshot: built.snapshot,
            scopeAuthorityDocuments: [],
            flush: { status: "already-clean" as const, blockedDocuments: [] },
          }),
          observeWithAi: async ({ windows }) => [
            {
              localId: "obs-unrepaired",
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
                predicate: "砲撃で崩れ落ちた",
                actuality: "actual",
                participants: [],
                temporalExpressions: [],
                durationKind: "instant",
              },
            },
          ],
          // Represents a root invalid response followed by an invalid/no repair
          // child: it returns no accepted terminal output at all.
          synthesizeWithAi: async () => [],
        },
      ),
    ).rejects.toThrow(
      "NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED",
    );
    expect(failMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-unrepaired-synthesis",
        errorMessage: expect.stringContaining(
          "NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED",
        ),
      }),
    );
  });

  it("fails closed when only part of a multi-cluster synthesis batch has typed terminals", async () => {
    const textOne = "教会の尖塔が砲撃で崩れ落ちた。";
    const textTwo = "兵士たちは避難した。";
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-mixed-synthesis",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "混在統合",
          orderIndex: 0,
          proseMirrorJson: prose(`${textOne}${textTwo}`),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-one",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
      omissions: [],
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    let synthesisCalls = 0;
    await expect(
      runChronicleExtractionCoordinator(
        {
          projectId: "project-a",
          folderId: "folder-1",
          language: "ja",
          sceneIds: ["scene-one"],
          authority: authority(),
          runId: "run-mixed-synthesis",
        },
        {
          useAi: true,
          buildSnapshot: async () => ({
            ok: true as const,
            snapshot: built.snapshot,
            scopeAuthorityDocuments: [],
            flush: { status: "already-clean" as const, blockedDocuments: [] },
          }),
          observeWithAi: async ({ windows }) => [
            {
              localId: "obs-mixed-one",
              evidence: [
                { sourceRef: windows[0]?.sourceRef ?? "S0001", quote: textOne },
              ],
              assertion: {
                attribution: "narrator",
                narrativeFrame: "story-world",
              },
              payload: {
                predicate: "砲撃で崩れ落ちた",
                actuality: "actual",
                participants: [],
                temporalExpressions: [],
                durationKind: "instant",
              },
            },
            {
              localId: "obs-mixed-two",
              evidence: [
                { sourceRef: windows[0]?.sourceRef ?? "S0001", quote: textTwo },
              ],
              assertion: {
                attribution: "narrator",
                narrativeFrame: "story-world",
              },
              payload: {
                predicate: "兵士たちは避難した",
                actuality: "actual",
                participants: [],
                temporalExpressions: [],
                durationKind: "instant",
              },
            },
          ],
          synthesizeWithAi: async ({
            clusterRef,
            observations,
            createId,
            onTerminalOutput,
            stageExecution,
          }) => {
            synthesisCalls += 1;
            const nextId = createId ?? (() => "hypothesis-mixed");
            const hypotheses = [
              {
                hypothesisId: nextId(),
                clusterRef,
                observationRefs: observations.map(
                  (observation) => observation.localId,
                ),
                titleSuggestion: "統合",
                summary: "統合結果",
                actuality: "actual",
                significance: "major",
              } satisfies EventHypothesis,
            ];
            if (synthesisCalls === 1 && stageExecution) {
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
                      titleSuggestion: "統合",
                      summary: "統合結果",
                      actuality: "actual",
                      significance: "major",
                    },
                  ],
                },
                hypotheses,
                rawObservationsDigest: TEST_STAGE_DIGEST,
                parsedOutputDigest: TEST_STAGE_DIGEST,
              });
            }
            return hypotheses;
          },
        },
      ),
    ).rejects.toThrow(
      "NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED",
    );
    expect(synthesisCalls).toBe(2);
  });

  it("saves ProposalSet before finishing the planProposals task", async () => {
    const callOrder: string[] = [];
    finishMock.mockImplementation(async () => {
      callOrder.push("finish");
      return { taskId: "task", attemptId: "attempt", status: "completed" };
    });
    saveProposalSetMock.mockImplementation(async () => {
      callOrder.push("saveProposalSet");
      return {
        proposalSetId: "proposal-set-order",
        proposals: [
          {
            proposalId: "proposal-1",
            proposalKey: "key",
            revisionId: "rev-1",
            status: "unreviewed",
          },
        ],
      };
    });

    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-order",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "順序",
          orderIndex: 0,
          proseMirrorJson: prose("兵士たちは敗走した。"),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-one",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
      omissions: [],
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    await runChronicleExtractionCoordinator(
      {
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-one"],
        authority: authority(),
        runId: "run-order",
      },
      {
        useAi: false,
        buildSnapshot: async () => ({
          ok: true as const,
          snapshot: built.snapshot,
          scopeAuthorityDocuments: [],
          flush: {
            status: "already-clean" as const,
            blockedDocuments: [],
          },
        }),
      },
    );

    const saveIndex = callOrder.indexOf("saveProposalSet");
    const lastFinishIndex = callOrder.lastIndexOf("finish");
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(lastFinishIndex).toBeGreaterThan(saveIndex);
  });
});
