import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import {
  buildInlineJsonArtifact,
  resetNarrativeArtifactIndexForTests,
} from "./artifactRepository";
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

import {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_SURFACE_PATH,
  CHRONICLE_EXTRACT_TASK_KINDS,
  CHRONICLE_EXTRACT_RUN_SPEC_KIND,
  runChronicleExtractionCoordinator,
} from "./extractionCoordinator";
import { loadInlineJsonArtifact } from "./artifactRepository";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import type { ExistingChronicleEventCatalogRecord } from "@/features/chronicle/extraction/existingEventMatcher";
import { clusterEventObservations } from "@/features/chronicle/extraction/eventClustering";
import {
  buildChronicleStageTerminalReceiptV1,
  createStageModelExecutionBindingV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";

const TEST_STAGE_DIGEST = `sha256:${"a".repeat(64)}` as const;
const TEST_WORKSPACE_BINDING = {
  authorityId: "workspace:a",
  generation: 1,
  authorityInstanceId: "1",
} as const;

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function authority(): MutationAuthority {
  return {
    projectId: "project-a",
    currentProjectId: () => "project-a",
    workspacePath: "/workspace/a",
    workspaceOpenRevision: 1,
  };
}

const TEST_COORDINATOR_CONTRACT_DIGEST = `sha256:${"0".repeat(64)}` as const;

const TEST_CHRONICLE_TASK_CHAIN = [
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

async function sealedResumeSpec(
  executionMode: "ai" | "deterministic-fallback",
  existingEvents: readonly unknown[] = [],
  coordinatorContractDigest: string = TEST_COORDINATOR_CONTRACT_DIGEST,
): Promise<{
  readonly specJson: Readonly<Record<string, unknown>>;
  readonly specDigest: string;
  readonly catalogDigest: string;
}> {
  const catalogDigest = await digestStableJson({
    kind: "chronicle.existing-events-catalog@1",
    events: existingEvents,
  });
  const specJson = {
    kind: CHRONICLE_EXTRACT_RUN_SPEC_KIND,
    domain: "chronicle",
    version: 2,
    taskChain: [...TEST_CHRONICLE_TASK_CHAIN],
    executionMode,
    existingEventsCatalogDigest: catalogDigest,
    coordinatorContractDigest,
  };
  return {
    specJson,
    specDigest: await digestStableJson(specJson),
    catalogDigest,
  };
}

function resumableProjection(
  runId: string,
  sealed: Awaited<ReturnType<typeof sealedResumeSpec>>,
) {
  return {
    run: {
      runId,
      projectId: "project-a",
      surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
      scopeJson: { folderId: "folder-1", sceneIds: ["scene-one"] },
      specJson: sealed.specJson,
      specDigest: sealed.specDigest,
      snapshotDigest: TEST_STAGE_DIGEST,
      catalogDigest: sealed.catalogDigest,
      registryDigest: null,
      status: "running" as const,
      coverageJson: {},
      outcomeSummaryJson: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      startedAt: "2026-08-10T00:00:00.000Z",
      completedAt: null,
      version: 1,
    },
    tasks: [],
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
  };
}

const CATALOG_EVENT: ExistingChronicleEventCatalogRecord = {
  ref: "event:catalog-a",
  sourceKey: "project:scene:scene-one",
  title: "既存の砲撃",
  note: null,
  version: 1,
  linkedDocumentSourceKeys: ["project:scene:scene-one"],
  participantEntityRefs: [],
  startTime: null,
  endTime: null,
  digest: `sha256:${"c".repeat(64)}`,
  applicationProvenanceKeys: [],
};

describe("runChronicleExtractionCoordinator (fake path)", () => {
  beforeEach(() => {
    setCurrentWorkspaceIdentity({ path: "/workspace/a", openRevision: 1 });
    resetNarrativeArtifactIndexForTests();
    resetNarrativeExtractionRunIndexForTests();
    vi.clearAllMocks();
    captureWorkspaceBindingMock.mockResolvedValue(TEST_WORKSPACE_BINDING);

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
    finishMock.mockImplementation(
      async (payload: {
        taskId: string;
        attemptId: string;
        chroniclePlanProposalSet?: {
          proposalSet: {
            proposalSetId?: string;
            proposals: readonly { proposalKey: string }[];
          };
        };
      }) => ({
        taskId: payload.taskId,
        attemptId: payload.attemptId,
        status: "completed",
        ...(payload.chroniclePlanProposalSet
          ? {
              proposalSet: {
                proposalSetId:
                  payload.chroniclePlanProposalSet.proposalSet.proposalSetId,
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
      }),
    );
    failMock.mockResolvedValue({
      taskId: "task",
      attemptId: "attempt",
      status: "failed",
    });
    buildProposalSetPayloadMock.mockImplementation(
      async (input: {
        runId: string;
        projectId: string;
        proposalSetId?: string;
        summaryJson?: Readonly<Record<string, unknown>>;
        proposals: readonly {
          proposalKey: string;
          payload: Readonly<Record<string, unknown>>;
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
      envelopeByProposalKey: new Map([
        ["test-proposal-key", { schemaVersion: 2 }],
      ]),
      stageReceiptRefs: [
        {
          stageExecutionId: "stage:test-synthesis",
          stageExecutionReceiptDigest: `sha256:${"a".repeat(64)}`,
        },
      ],
      omissions: [],
      createdAt: "2026-08-10T00:00:00.000Z",
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
    expect(result.savedProposalSetId).toBe(
      "chronicle-plan-proposals:run-1:task-9",
    );
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
      TEST_WORKSPACE_BINDING,
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
      TEST_WORKSPACE_BINDING,
    );
    const finishPayloads = finishMock.mock.calls.map(
      ([payload]) => payload as Record<string, unknown>,
    );
    expect(finishPayloads[0]?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
          payloadJson: expect.objectContaining({
            existingEventsCatalog: {
              kind: "chronicle.existing-events-catalog@1",
              events: [],
            },
          }),
        }),
      ]),
    );
    expect(finishPayloads[0]?.historicalScopeAuthorityBasis).toBeDefined();
    expect(
      finishPayloads
        .slice(1)
        .every((payload) => !("historicalScopeAuthorityBasis" in payload)),
    ).toBe(true);
    expect(buildProposalSetPayloadMock).toHaveBeenCalled();
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
    }>("run-ai-observe", CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations, {
      scope: {
        projectId: "project-a",
        workspacePath: "/workspace/a",
        workspaceOpenRevision: 1,
      },
    });
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
    expect(buildProposalSetPayloadMock).toHaveBeenCalledWith(
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
          observeWithAi: async ({
            windows,
            stageExecution,
            onStageReceipt,
          }) => {
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
    const resumeSpec = await sealedResumeSpec("ai");
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
    finishMock.mockImplementation(
      async (payload: {
        taskId: string;
        attemptId: string;
        chroniclePlanProposalSet?: {
          proposalSet: {
            proposalSetId?: string;
            proposals: readonly { proposalKey: string }[];
          };
        };
      }) => ({
        taskId: payload.taskId,
        attemptId: payload.attemptId,
        status: "completed",
        ...(payload.chroniclePlanProposalSet
          ? {
              proposalSet: {
                proposalSetId:
                  payload.chroniclePlanProposalSet.proposalSet.proposalSetId,
                proposals:
                  payload.chroniclePlanProposalSet.proposalSet.proposals.map(
                    (proposal, index) => ({
                      proposalId: `resumed-proposal-${index + 1}`,
                      proposalKey: proposal.proposalKey,
                      revisionId: `resumed-revision-${index + 1}`,
                      status: "unreviewed" as const,
                    }),
                  ),
              },
            }
          : {}),
      }),
    );
    failMock.mockResolvedValue({ status: "failed" });
    buildProposalSetPayloadMock.mockImplementation(
      async (input: {
        runId: string;
        projectId: string;
        proposalSetId?: string;
        proposals: readonly {
          proposalKey: string;
          payload: Readonly<Record<string, unknown>>;
        }[];
      }) => ({
        runId: input.runId,
        projectId: input.projectId,
        proposalSetId: input.proposalSetId,
        setKind: "chronicle.extract.review@1",
        proposals: input.proposals.map((proposal) => ({
          proposalKey: proposal.proposalKey,
          kind: "chronicle.create-event@1",
          payloadJson: proposal.payload,
        })),
      }),
    );
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
        specJson: resumeSpec.specJson,
        specDigest: resumeSpec.specDigest,
        snapshotDigest: built.snapshot.digest,
        catalogDigest: resumeSpec.catalogDigest,
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
        [
          CHRONICLE_EXTRACT_TASK_KINDS.snapshot,
          "completed",
          outputFor("task-1"),
        ],
        [
          CHRONICLE_EXTRACT_TASK_KINDS.windowPlan,
          "completed",
          outputFor("task-2"),
        ],
        [
          CHRONICLE_EXTRACT_TASK_KINDS.observe,
          "completed",
          outputFor("task-3"),
        ],
        [
          CHRONICLE_EXTRACT_TASK_KINDS.resolveEvidence,
          "completed",
          outputFor("task-4"),
        ],
        [
          CHRONICLE_EXTRACT_TASK_KINDS.mergeObservations,
          "completed",
          outputFor("task-5"),
        ],
        [
          CHRONICLE_EXTRACT_TASK_KINDS.cluster,
          "completed",
          outputFor("task-6"),
        ],
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
        completedAt: status === "completed" ? "2026-08-10T00:00:00.000Z" : null,
        version: 1,
      })),
      taskCounts: {
        queued: 3,
        running: 0,
        completed: 6,
        failed: 0,
        cancelled: 0,
      },
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
        specDigest: TEST_COORDINATOR_CONTRACT_DIGEST,
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
          if (!stageExecution)
            throw new Error("missing resumed synthesis stage");
          const hypotheses = [
            {
              hypothesisId: (createId ?? (() => "resumed-hypothesis"))(),
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

    expect(resumed.runId).toBe("run-resume-observation");
    expect(createRunMock).not.toHaveBeenCalled();
    expect(
      claimMock.mock.calls.map(([payload]) => payload.taskKinds?.[0]),
    ).toEqual([
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

  it("hydrates a completed terminal Run with its current human revision, not the immutable plan payload or parent decision", async () => {
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-completed-current-revision",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "Completed revision hydration",
          orderIndex: 0,
          proseMirrorJson: prose("砲撃が終わった。"),
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

    const runId = "run-completed-current-revision";
    const planTaskId = "task-plan-completed";
    const proposalSetId = `chronicle-plan-proposals:${runId}:${planTaskId}`;
    const sealed = await sealedResumeSpec("deterministic-fallback");
    const terminalProposal = {
      eventId: "event-terminal",
      title: "Immutable terminal plan payload",
      note: null,
      actuality: "actual",
      significance: "scene-level",
      evidenceAnchorIds: ["anchor-terminal"],
      evidenceDocumentRefs: ["D000001"],
      disclosure: { secret: false, revealDocumentRef: "D000001" },
      unresolvedMetadata: {
        participantSurfaces: [],
        locationSurface: null,
        temporalExpressions: [],
      },
    } satisfies CreateChronicleEventProposalPayloadV1;
    const revisedPayload = {
      ...terminalProposal,
      title: "Current human revision payload",
      note: "revision two",
    } satisfies CreateChronicleEventProposalPayloadV1;
    const taskRows = CHRONICLE_EXTRACT_TASK_KINDS;
    getRunMock.mockResolvedValue({
      run: {
        runId,
        projectId: "project-a",
        surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-1", sceneIds: ["scene-one"] },
        specJson: sealed.specJson,
        specDigest: sealed.specDigest,
        snapshotDigest: built.snapshot.digest,
        catalogDigest: sealed.catalogDigest,
        registryDigest: null,
        status: "completed",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: "2026-08-10T00:00:00.000Z",
        completedAt: "2026-08-10T00:01:00.000Z",
        version: 1,
      },
      tasks: Object.values(taskRows).map((taskKind, index) => ({
        taskId:
          taskKind === CHRONICLE_EXTRACT_TASK_KINDS.planProposals
            ? planTaskId
            : `completed-task-${index + 1}`,
        runId,
        taskKind,
        status: "completed",
        inputJson: {},
        outputJson:
          taskKind === CHRONICLE_EXTRACT_TASK_KINDS.snapshot
            ? { snapshotDigest: built.snapshot.digest }
            : taskKind === CHRONICLE_EXTRACT_TASK_KINDS.observe
              ? { observationCount: 0 }
              : taskKind === CHRONICLE_EXTRACT_TASK_KINDS.planProposals
                ? { proposalSetId, proposalCount: 1 }
                : {},
        priority: 9 - index,
        attemptCount: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorMessage: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: "2026-08-10T00:00:00.000Z",
        completedAt: "2026-08-10T00:01:00.000Z",
        version: 1,
      })),
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 9,
        failed: 0,
        cancelled: 0,
      },
    });
    const artifact = (
      artifactId: string,
      taskId: string,
      artifactKind: string,
      payloadJson: Record<string, unknown>,
    ) => ({
      artifactId,
      runId,
      taskId,
      attemptId: `attempt-${taskId}`,
      artifactKind,
      payloadStorage: "inline-json" as const,
      payloadJson,
      payloadRef: null,
      payloadDigest: TEST_STAGE_DIGEST,
      createdAt: "2026-08-10T00:01:00.000Z",
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId,
      projectId: "project-a",
      artifacts: [
        artifact(
          "artifact-snapshot",
          "completed-task-1",
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
          {
            snapshot: built.snapshot,
            sourceViews: [],
            scopeAuthorityDocuments: [
              {
                documentRef: built.snapshot.documents[0]?.ref,
                sourceKey: "project:scene:one",
                rawStoryKey: null,
              },
            ],
          },
        ),
        artifact(
          "artifact-window-plan",
          "completed-task-2",
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.windowPlan,
          { windows: [] },
        ),
        artifact(
          "artifact-observations",
          "completed-task-3",
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.observations,
          { observations: [] },
        ),
        artifact(
          "artifact-evidence",
          "completed-task-4",
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
          { anchors: [] },
        ),
        artifact(
          "artifact-merged",
          "completed-task-5",
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.mergedObservations,
          { observations: [] },
        ),
        artifact(
          "artifact-clusters",
          "completed-task-6",
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.clusters,
          { clusters: [] },
        ),
        artifact(
          "artifact-hypotheses",
          "completed-task-7",
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.hypotheses,
          { hypotheses: [] },
        ),
        artifact(
          "artifact-matches",
          "completed-task-8",
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.matches,
          { matches: [] },
        ),
        artifact(
          "artifact-proposals",
          planTaskId,
          CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
          {
            proposalSetId,
            proposals: [terminalProposal],
            planned: [
              {
                proposal: terminalProposal,
                match: { status: "none" },
                hypothesisId: "hyp-terminal",
              },
            ],
            alreadySatisfied: [],
          },
        ),
      ],
      stageReceipts: [],
      proposalSet: {
        proposalSetId,
        runId,
        projectId: "project-a",
        setKind: "chronicle.extract.review@1",
        status: "draft",
        summaryJson: {},
        createdAt: "2026-08-10T00:01:00.000Z",
        updatedAt: "2026-08-10T00:01:00.000Z",
        version: 1,
      },
      proposals: [
        {
          proposalId: "proposal-current-revision",
          proposalSetId,
          proposalKey: "event-terminal:0",
          kind: "chronicle.create-event@1",
          status: "unreviewed",
          payloadJson: revisedPayload,
          currentRevisionId: "revision-2-current",
          createdAt: "2026-08-10T00:01:00.000Z",
          updatedAt: "2026-08-10T00:01:00.000Z",
          latestDecision: {
            decisionId: "decision-revision-1",
            proposalId: "proposal-current-revision",
            revisionId: "revision-1-terminal",
            decision: "approved",
            decisionJson: { probableDuplicateChoice: "create-as-new" },
            createdAt: "2026-08-10T00:00:30.000Z",
            createdBy: "human-reviewer",
          },
        },
      ],
      omissions: [],
      createdAt: "2026-08-10T00:00:00.000Z",
    });

    const resumed = await runChronicleExtractionCoordinator(
      {
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-one"],
        authority: authority(),
        runId,
        resume: true,
        specDigest: TEST_COORDINATOR_CONTRACT_DIGEST,
      },
      {
        useAi: false,
        buildSnapshot: async () => {
          throw new Error("completed resume must not snapshot live workspace");
        },
      },
    );

    expect(createRunMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(resumed.savedProposalSetId).toBe(proposalSetId);
    expect(resumed.proposals[0]?.title).toBe("Immutable terminal plan payload");
    expect(resumed.savedProposals).toEqual([
      expect.objectContaining({
        proposalId: "proposal-current-revision",
        revisionId: "revision-2-current",
        payload: revisedPayload,
      }),
    ]);
    expect(resumed.savedProposals[0]?.probableDuplicateChoice).toBeUndefined();
  });

  it("fails Native-detected restart hydration corruption before it claims a task", async () => {
    const resumeSpec = await sealedResumeSpec("deterministic-fallback");
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-corrupt-hydration",
        projectId: "project-a",
        surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-1", sceneIds: ["scene-one"] },
        specJson: resumeSpec.specJson,
        specDigest: resumeSpec.specDigest,
        snapshotDigest: TEST_STAGE_DIGEST,
        catalogDigest: resumeSpec.catalogDigest,
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
        outputJson: index === 0 ? { snapshotDigest: TEST_STAGE_DIGEST } : null,
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
      taskCounts: {
        queued: 8,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
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
        specDigest: TEST_COORDINATOR_CONTRACT_DIGEST,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT");
    expect(createRunMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("does not cache a Snapshot draft when FinishTask rolls back, and same-process resume rejects the missing durable artifact", async () => {
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-finish-rollback",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "Rollback",
          orderIndex: 0,
          proseMirrorJson: prose("教会の尖塔が崩れ落ちた。"),
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

    finishMock.mockRejectedValueOnce(new Error("FinishTask rolled back"));
    await expect(
      runChronicleExtractionCoordinator(
        {
          projectId: "project-a",
          folderId: "folder-1",
          language: "ja",
          sceneIds: ["scene-one"],
          authority: authority(),
          runId: "run-finish-rollback",
        },
        {
          useAi: false,
          buildSnapshot: async () => ({
            ok: true as const,
            snapshot: built.snapshot,
            scopeAuthorityDocuments: [
              {
                documentRef: "D000001",
                sourceKey: "project:scene:one" as const,
                rawStoryKey: null,
              },
            ],
            flush: { status: "already-clean" as const, blockedDocuments: [] },
          }),
        },
      ),
    ).rejects.toThrow("FinishTask rolled back");

    await expect(
      loadInlineJsonArtifact(
        "run-finish-rollback",
        CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
        {
          scope: {
            projectId: "project-a",
            workspacePath: "/workspace/a",
            workspaceOpenRevision: 1,
          },
        },
      ),
    ).resolves.toBeNull();

    const resumeSpec = await sealedResumeSpec("deterministic-fallback");
    getRunMock.mockResolvedValue({
      ...resumableProjection("run-finish-rollback", resumeSpec),
      tasks: TEST_CHRONICLE_TASK_CHAIN.map((taskKind, index) => ({
        taskId: `rollback-task-${index + 1}`,
        runId: "run-finish-rollback",
        taskKind,
        status: index === 0 ? ("completed" as const) : ("queued" as const),
        inputJson: {},
        outputJson: index === 0 ? { snapshotDigest: TEST_STAGE_DIGEST } : null,
        priority: TEST_CHRONICLE_TASK_CHAIN.length - index,
        attemptCount: index === 0 ? 1 : 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorMessage: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: index === 0 ? "2026-08-10T00:00:00.000Z" : null,
        completedAt: index === 0 ? "2026-08-10T00:00:01.000Z" : null,
        version: 1,
      })),
      taskCounts: {
        queued: 8,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-finish-rollback",
      projectId: "project-a",
      artifacts: [],
      stageReceipts: [],
      proposalSet: null,
      proposals: [],
    });

    await expect(
      runChronicleExtractionCoordinator(
        {
          projectId: "project-a",
          folderId: "folder-1",
          language: "ja",
          sceneIds: ["scene-one"],
          authority: authority(),
          runId: "run-finish-rollback",
          resume: true,
          specDigest: TEST_COORDINATOR_CONTRACT_DIGEST,
          existingEvents: [],
        },
        { useAi: false },
      ),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_SNAPSHOT_MISSING");
  });

  it("rejects an AI/fallback, catalog, or canonical-spec change before it claims a resumed Run", async () => {
    const catalogDrift: ExistingChronicleEventCatalogRecord = {
      ...CATALOG_EVENT,
      ref: "event:catalog-b",
      title: "別の既存イベント",
      digest: `sha256:${"d".repeat(64)}`,
    };
    const originalAiSpec = await sealedResumeSpec("ai");
    const cases = [
      {
        label: "fallback-to-AI",
        durable: await sealedResumeSpec("deterministic-fallback"),
        inputEvents: [] as readonly ExistingChronicleEventCatalogRecord[],
        useAi: true,
      },
      {
        label: "AI-to-fallback",
        durable: await sealedResumeSpec("ai"),
        inputEvents: [] as readonly ExistingChronicleEventCatalogRecord[],
        useAi: false,
      },
      {
        label: "catalog-drift",
        durable: await sealedResumeSpec("ai", [CATALOG_EVENT]),
        inputEvents: [
          catalogDrift,
        ] as readonly ExistingChronicleEventCatalogRecord[],
        useAi: true,
      },
      {
        label: "specJson-tamper-with-unchanged-digest",
        durable: {
          ...originalAiSpec,
          specJson: {
            ...originalAiSpec.specJson,
            kind: "chronicle.extract.run-spec@1",
          },
        },
        inputEvents: [] as readonly ExistingChronicleEventCatalogRecord[],
        useAi: true,
      },
    ] as const;

    for (const testCase of cases) {
      claimMock.mockClear();
      getRunMock.mockResolvedValue(
        resumableProjection(`run-spec-${testCase.label}`, testCase.durable),
      );

      await expect(
        runChronicleExtractionCoordinator(
          {
            projectId: "project-a",
            folderId: "folder-1",
            language: "ja",
            sceneIds: ["scene-one"],
            authority: authority(),
            runId: `run-spec-${testCase.label}`,
            resume: true,
            specDigest: TEST_COORDINATOR_CONTRACT_DIGEST,
            existingEvents: testCase.inputEvents,
          },
          { useAi: testCase.useAi },
        ),
      ).rejects.toThrow("NEX_CHRONICLE_RESUME_SPEC_MISMATCH");
      expect(claimMock).not.toHaveBeenCalled();
    }
  });

  it("rejects a source.snapshot catalog that no longer matches the sealed Run catalog", async () => {
    const runId = "run-corrupt-snapshot-catalog";
    const resumeSpec = await sealedResumeSpec("deterministic-fallback", []);
    getRunMock.mockResolvedValue({
      ...resumableProjection(runId, resumeSpec),
      tasks: TEST_CHRONICLE_TASK_CHAIN.map((taskKind, index) => ({
        taskId: `catalog-task-${index + 1}`,
        runId,
        taskKind,
        status: index === 0 ? ("completed" as const) : ("queued" as const),
        inputJson: {},
        outputJson: index === 0 ? { snapshotDigest: TEST_STAGE_DIGEST } : null,
        priority: TEST_CHRONICLE_TASK_CHAIN.length - index,
        attemptCount: index === 0 ? 1 : 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorMessage: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: index === 0 ? "2026-08-10T00:00:00.000Z" : null,
        completedAt: index === 0 ? "2026-08-10T00:00:01.000Z" : null,
        version: 1,
      })),
      taskCounts: {
        queued: 8,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId,
      projectId: "project-a",
      artifacts: [
        {
          artifactId: "artifact-corrupt-snapshot-catalog",
          runId,
          taskId: "catalog-task-1",
          attemptId: "catalog-attempt-1",
          artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
          payloadStorage: "inline-json",
          payloadJson: {
            snapshot: {
              digest: TEST_STAGE_DIGEST,
              documents: [],
            },
            sourceViews: [],
            scopeAuthorityDocuments: [],
            existingEventsCatalog: {
              kind: "chronicle.existing-events-catalog@1",
              events: [CATALOG_EVENT],
            },
          },
          payloadRef: null,
          payloadDigest: TEST_STAGE_DIGEST,
          createdAt: "2026-08-10T00:00:01.000Z",
        },
      ],
      stageReceipts: [],
      proposalSet: null,
      proposals: [],
    });

    await expect(
      runChronicleExtractionCoordinator(
        {
          projectId: "project-a",
          folderId: "folder-1",
          language: "ja",
          sceneIds: ["scene-one"],
          authority: authority(),
          runId,
          resume: true,
          specDigest: TEST_COORDINATOR_CONTRACT_DIGEST,
          existingEvents: [],
        },
        { useAi: false },
      ),
    ).rejects.toThrow("NEX_CHRONICLE_RESUME_CATALOG_MISMATCH");
    expect(createRunMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("captures mutation authority before the first asynchronous Run-spec digest", async () => {
    const mutableAuthority = authority();
    const originalCurrentProjectId = mutableAuthority.currentProjectId;
    const extraction = runChronicleExtractionCoordinator(
      {
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-one"],
        authority: mutableAuthority,
        runId: "run-authority-capture",
      },
      {
        useAi: false,
        buildSnapshot: async (input) => {
          expect(input.authority).toEqual({
            projectId: "project-a",
            currentProjectId: originalCurrentProjectId,
            workspacePath: "/workspace/a",
            workspaceOpenRevision: 1,
          });
          throw new Error("stop after authority capture");
        },
      },
    );
    // `buildSealedChronicleRunSpec` has yielded to WebCrypto by now. A caller
    // mutating their owned object must not change the eventual snapshot scope.
    mutableAuthority.projectId = "project-b";
    mutableAuthority.workspacePath = "/other-workspace";
    mutableAuthority.workspaceOpenRevision = 99;
    mutableAuthority.currentProjectId = () => "project-b";

    await expect(extraction).rejects.toThrow("stop after authority capture");
  });

  it("does not create a Run in Workspace B when the Snapshot digest resumes after an A-to-B switch", async () => {
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-authority-race",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "Authority race",
          orderIndex: 0,
          proseMirrorJson: prose("宿舎が砲撃で崩れ落ちた。"),
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
    if (!built.ok) throw new Error("snapshot fixture failed");

    const digestStarted = deferred<void>();
    const releaseDigest = deferred<void>();
    let activeNativeBinding: import("./nativeApi").NarrativeExtractionWorkspaceBinding =
      TEST_WORKSPACE_BINDING;
    const workspaceB = { runs: 0, tasks: 0, artifacts: 0 };
    createRunMock.mockImplementation(
      async (
        payload: { tasks?: readonly unknown[] },
        binding: import("./nativeApi").NarrativeExtractionWorkspaceBinding,
      ) => {
        if (
          binding.authorityInstanceId !==
          activeNativeBinding.authorityInstanceId
        ) {
          throw new Error(
            "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED: stale binding",
          );
        }
        workspaceB.runs += 1;
        workspaceB.tasks += payload.tasks?.length ?? 0;
        return { runId: "must-not-exist-in-b", status: "running", taskIds: [] };
      },
    );
    finishMock.mockImplementation(
      async (payload: { artifacts?: readonly unknown[] }) => {
        workspaceB.artifacts += Array.isArray(payload.artifacts)
          ? payload.artifacts.length
          : 0;
        return { status: "completed" };
      },
    );

    const extraction = runChronicleExtractionCoordinator(
      {
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-one"],
        authority: authority(),
        runId: "run-authority-race",
      },
      {
        useAi: false,
        buildSnapshot: async () => ({
          ok: true as const,
          snapshot: built.snapshot,
          scopeAuthorityDocuments: [],
          flush: { status: "already-clean" as const, blockedDocuments: [] },
        }),
        digestSnapshotPayload: async (payload) => {
          digestStarted.resolve();
          await releaseDigest.promise;
          return digestStableJson(payload);
        },
      },
    );

    await digestStarted.promise;
    setCurrentWorkspaceIdentity({ path: "/workspace/b", openRevision: 2 });
    activeNativeBinding = {
      authorityId: "workspace:b",
      generation: 1,
      authorityInstanceId: "2",
    };
    releaseDigest.resolve();

    await expect(extraction).rejects.toThrow(
      "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED",
    );
    expect(workspaceB).toEqual({ runs: 0, tasks: 0, artifacts: 0 });
    expect(claimMock).not.toHaveBeenCalled();
    expect(finishMock).not.toHaveBeenCalled();
  });

  it("rejects a same-path replacement that completes while Native binding capture is pending", async () => {
    const captureStarted = deferred<void>();
    const binding =
      deferred<import("./nativeApi").NarrativeExtractionWorkspaceBinding>();
    captureWorkspaceBindingMock.mockImplementation(async () => {
      captureStarted.resolve();
      return binding.promise;
    });
    const buildSnapshot = vi.fn();

    const extraction = runChronicleExtractionCoordinator(
      {
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-one"],
        authority: authority(),
      },
      { buildSnapshot },
    );
    await captureStarted.promise;
    setCurrentWorkspaceIdentity({ path: "/workspace/a", openRevision: 2 });
    binding.resolve({
      authorityId: "workspace:a",
      generation: 2,
      authorityInstanceId: "2",
    });

    await expect(extraction).rejects.toThrow(
      "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED",
    );
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it("rejects a resumed Task finish when Workspace replacement occurs after claim", async () => {
    const runId = "run-resume-authority-race";
    const built = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-resume-authority-race",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "project-a" },
      documents: [
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "Resume authority race",
          orderIndex: 0,
          proseMirrorJson: prose("宿舎が砲撃で崩れ落ちた。"),
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
    if (!built.ok) throw new Error("snapshot fixture failed");
    const resumeSpec = await sealedResumeSpec("deterministic-fallback");
    const snapshotPayload = {
      snapshot: built.snapshot,
      sourceViews: [],
      existingEventsCatalog: {
        kind: "chronicle.existing-events-catalog@1" as const,
        events: [],
      },
      scopeAuthorityDocuments: [
        {
          documentRef: built.snapshot.documents[0]!.ref,
          sourceKey: "project:scene:one" as const,
          rawStoryKey: null,
        },
      ],
    };
    const snapshotDraft = buildInlineJsonArtifact(
      CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
      snapshotPayload,
      "artifact-resume-authority-race",
    );
    const taskKinds = [...TEST_CHRONICLE_TASK_CHAIN];
    getRunMock.mockResolvedValue({
      run: {
        runId,
        projectId: "project-a",
        surfacePathId: CHRONICLE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-1", sceneIds: ["scene-one"] },
        specJson: resumeSpec.specJson,
        specDigest: resumeSpec.specDigest,
        snapshotDigest: built.snapshot.digest,
        catalogDigest: resumeSpec.catalogDigest,
        registryDigest: null,
        status: "running",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: "2026-08-10T00:00:00.000Z",
        completedAt: null,
        version: 1,
      },
      tasks: taskKinds.map((taskKind, index) => ({
        taskId: `resume-authority-task-${index + 1}`,
        runId,
        taskKind,
        status: index === 0 ? "completed" : "queued",
        inputJson: { stage: index + 1 },
        outputJson:
          index === 0
            ? {
                snapshotDigest: built.snapshot.digest,
                documentCount: built.snapshot.documents.length,
                corpusPayloadDigest: TEST_STAGE_DIGEST,
                scopeAuthorityCompositeDigest: null,
              }
            : null,
        priority: taskKinds.length - index,
        attemptCount: index === 0 ? 1 : 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorMessage: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: index === 0 ? "2026-08-10T00:00:00.000Z" : null,
        completedAt: index === 0 ? "2026-08-10T00:00:00.000Z" : null,
        version: 1,
      })),
      taskCounts: {
        queued: 8,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId,
      projectId: "project-a",
      artifacts: [
        {
          artifactId: snapshotDraft.artifactId,
          runId,
          taskId: "resume-authority-task-1",
          attemptId: "resume-authority-attempt-1",
          artifactKind: snapshotDraft.artifactKind,
          payloadStorage: "inline-json",
          payloadJson: snapshotDraft.payloadJson,
          payloadRef: null,
          payloadDigest: null,
          createdAt: "2026-08-10T00:00:00.000Z",
        },
      ],
      stageReceipts: [],
      proposalSet: null,
      proposals: [],
    });
    claimMock.mockResolvedValue({
      claimed: true,
      task: {
        taskId: "resume-authority-task-2",
        runId,
        taskKind: CHRONICLE_EXTRACT_TASK_KINDS.windowPlan,
        status: "running",
        inputJson: { stage: 2 },
        attemptId: "resume-authority-attempt-2",
        attemptNumber: 1,
        leaseOwner: "test",
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    let activeBinding: import("./nativeApi").NarrativeExtractionWorkspaceBinding =
      TEST_WORKSPACE_BINDING;
    const workspaceB = { taskFinishes: 0, taskFailures: 0, artifacts: 0 };
    finishMock.mockImplementation(
      async (
        payload: { artifacts?: readonly unknown[] },
        binding: import("./nativeApi").NarrativeExtractionWorkspaceBinding,
      ) => {
        // Claim was committed in A. Replacement happens while the completed
        // output is crossing the finish boundary.
        setCurrentWorkspaceIdentity({ path: "/workspace/b", openRevision: 2 });
        activeBinding = {
          authorityId: "workspace:b",
          generation: 1,
          authorityInstanceId: "2",
        };
        if (binding.authorityInstanceId !== activeBinding.authorityInstanceId) {
          throw new Error(
            "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED: stale finish binding",
          );
        }
        workspaceB.taskFinishes += 1;
        workspaceB.artifacts += payload.artifacts?.length ?? 0;
        return { status: "completed" };
      },
    );
    failMock.mockImplementation(
      async (
        _payload: unknown,
        binding: import("./nativeApi").NarrativeExtractionWorkspaceBinding,
      ) => {
        if (binding.authorityInstanceId !== activeBinding.authorityInstanceId) {
          throw new Error(
            "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED: stale fail binding",
          );
        }
        workspaceB.taskFailures += 1;
        return { status: "failed" };
      },
    );

    await expect(
      runChronicleExtractionCoordinator(
        {
          projectId: "project-a",
          folderId: "folder-1",
          language: "ja",
          sceneIds: ["scene-one"],
          authority: authority(),
          runId,
          resume: true,
          specDigest: TEST_COORDINATOR_CONTRACT_DIGEST,
          existingEvents: [],
        },
        { useAi: false },
      ),
    ).rejects.toThrow("NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED");
    expect(claimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        taskKinds: [CHRONICLE_EXTRACT_TASK_KINDS.windowPlan],
      }),
      TEST_WORKSPACE_BINDING,
    );
    expect(workspaceB).toEqual({
      taskFinishes: 0,
      taskFailures: 0,
      artifacts: 0,
    });
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
      TEST_WORKSPACE_BINDING,
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
    ).rejects.toThrow("NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED");
    expect(failMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-unrepaired-synthesis",
        errorMessage: expect.stringContaining(
          "NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED",
        ),
      }),
      TEST_WORKSPACE_BINDING,
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
    ).rejects.toThrow("NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED");
    expect(synthesisCalls).toBe(2);
  });

  it("terminalizes ProposalSet through the plan FinishTask transaction", async () => {
    const callOrder: string[] = [];
    finishMock.mockImplementation(
      async (payload: {
        taskId: string;
        attemptId: string;
        chroniclePlanProposalSet?: {
          proposalSet: {
            proposalSetId?: string;
            proposals: readonly { proposalKey: string }[];
          };
        };
      }) => {
        callOrder.push(
          payload.chroniclePlanProposalSet ? "typedFinish" : "finish",
        );
        return {
          taskId: payload.taskId,
          attemptId: payload.attemptId,
          status: "completed",
          ...(payload.chroniclePlanProposalSet
            ? {
                proposalSet: {
                  proposalSetId:
                    payload.chroniclePlanProposalSet.proposalSet.proposalSetId,
                  proposals:
                    payload.chroniclePlanProposalSet.proposalSet.proposals.map(
                      (proposal, index) => ({
                        proposalId: `proposal-${index}`,
                        proposalKey: proposal.proposalKey,
                        revisionId: `revision-${index}`,
                        status: "unreviewed" as const,
                      }),
                    ),
                },
              }
            : {}),
        };
      },
    );
    buildProposalSetPayloadMock.mockImplementation(
      async (input: {
        runId: string;
        projectId: string;
        proposalSetId?: string;
        proposals: readonly {
          proposalKey: string;
          payload: Readonly<Record<string, unknown>>;
        }[];
      }) => {
        callOrder.push("build");
        return {
          runId: input.runId,
          projectId: input.projectId,
          proposalSetId: input.proposalSetId,
          setKind: "chronicle.extract.review@1",
          proposals: input.proposals.map((proposal) => ({
            proposalKey: proposal.proposalKey,
            kind: "chronicle.create-event@1",
            payloadJson: proposal.payload,
          })),
        };
      },
    );

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

    const buildIndex = callOrder.indexOf("build");
    const typedFinishIndex = callOrder.indexOf("typedFinish");
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(typedFinishIndex).toBeGreaterThan(buildIndex);
    const terminalPayload = finishMock.mock.calls
      .map(([payload]) => payload as import("./nativeApi").FinishTaskPayload)
      .find((payload) => payload.chroniclePlanProposalSet);
    expect(
      terminalPayload?.chroniclePlanProposalSet?.proposalSet.proposalSetId,
    ).toBe("chronicle-plan-proposals:run-order:task-9");
  });
});
