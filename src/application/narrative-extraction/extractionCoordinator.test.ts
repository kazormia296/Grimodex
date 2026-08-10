import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import { resetNarrativeArtifactIndexForTests } from "./artifactRepository";
import { resetNarrativeExtractionRunIndexForTests } from "./runRepository";

const claimMock = vi.hoisted(() => vi.fn());
const finishMock = vi.hoisted(() => vi.fn());
const createRunMock = vi.hoisted(() => vi.fn());
const saveProposalSetMock = vi.hoisted(() => vi.fn());

vi.mock("./nativeApi", () => ({
  narrativeExtractionClaimTask: claimMock,
  narrativeExtractionFinishTask: finishMock,
  narrativeExtractionCreateRun: createRunMock,
  narrativeExtractionSaveProposalSet: saveProposalSetMock,
}));

vi.mock("./runRepository", async () => {
  const actual = await vi.importActual<typeof import("./runRepository")>(
    "./runRepository",
  );
  return {
    ...actual,
    createRun: createRunMock,
  };
});

vi.mock("./proposalRepository", () => ({
  saveChronicleProposalSet: saveProposalSetMock,
}));

import {
  CHRONICLE_EXTRACT_SURFACE_PATH,
  runChronicleExtractionCoordinator,
} from "./extractionCoordinator";

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
});
