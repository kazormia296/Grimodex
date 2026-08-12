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
const saveProposalSetMock = vi.hoisted(() => vi.fn());
const buildSnapshotSourceBasisMock = vi.hoisted(() => vi.fn());

vi.mock("./nativeApi", () => ({
  narrativeExtractionClaimTask: claimMock,
  narrativeExtractionFinishTask: finishMock,
  narrativeExtractionFailTask: failMock,
  narrativeExtractionCreateRun: createRunMock,
  narrativeExtractionCancelRun: cancelRunMock,
  narrativeExtractionSaveProposalSet: saveProposalSetMock,
}));

vi.mock("./runRepository", async () => {
  const actual =
    await vi.importActual<typeof import("./runRepository")>("./runRepository");
  return {
    ...actual,
    createRun: createRunMock,
    cancelRun: cancelRunMock,
  };
});

vi.mock("./proposalRepository", () => ({
  saveChronicleProposalSet: saveProposalSetMock,
  buildSnapshotSourceBasis: buildSnapshotSourceBasisMock,
}));

import {
  CHRONICLE_EXTRACT_ARTIFACT_KINDS,
  CHRONICLE_EXTRACT_SURFACE_PATH,
  runChronicleExtractionCoordinator,
} from "./extractionCoordinator";
import { loadInlineJsonArtifact } from "./artifactRepository";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import { clusterEventObservations } from "@/features/chronicle/extraction/eventClustering";

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
        synthesizeWithAi: async ({ clusterRef, observations, createId }) => {
          synthesizeObservationIds.push(
            observations.map((observation) => observation.localId),
          );
          const nextId = createId ?? (() => "hypothesis-test-id");
          return [
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
