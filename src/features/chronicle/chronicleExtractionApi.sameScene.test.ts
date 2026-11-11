import { beforeEach, describe, expect, it, vi } from "vitest";

const listResumableRunsMock = vi.hoisted(() => vi.fn());
const getBundleMock = vi.hoisted(() => vi.fn());

vi.mock("@/application/narrative-extraction/runRepository", () => ({
  getRun: vi.fn(),
  listChronicleTaskResumeCandidates: vi.fn(),
  listResumableRuns: listResumableRunsMock,
}));

vi.mock(
  "@/application/narrative-extraction/nativeApi",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/application/narrative-extraction/nativeApi")
    >()),
    narrativeExtractionGetRunReviewBundle: getBundleMock,
  }),
);

import {
  SAME_SCENE_NOTICE_RUN_LIMIT,
  hasApprovedUnappliedProposalForScene,
} from "./chronicleExtractionApi";
import { useChronicleExtractionStore } from "./chronicleExtractionStore";

function runProjection(runId: string, scopeJson: Record<string, unknown>) {
  return { run: { runId, scopeJson }, tasks: [], taskCounts: {} };
}

function bundle(
  runId: string,
  proposals: Array<{ status: string; application?: unknown }>,
) {
  return {
    runId,
    projectId: "project-a",
    artifacts: [],
    stageReceipts: [],
    proposalSet: null,
    proposals,
  };
}

describe("hasApprovedUnappliedProposalForScene", () => {
  beforeEach(() => {
    listResumableRunsMock.mockReset();
    getBundleMock.mockReset();
  });

  it("asks Native for the newest review-resumable Chronicle Runs only", async () => {
    listResumableRunsMock.mockResolvedValue([]);
    await expect(
      hasApprovedUnappliedProposalForScene({
        projectId: "project-a",
        sceneId: "scene-a",
      }),
    ).resolves.toBe(false);
    expect(listResumableRunsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-a",
        limit: SAME_SCENE_NOTICE_RUN_LIMIT,
      }),
    );
    expect(getBundleMock).not.toHaveBeenCalled();
  });

  it("reads bundles only for Runs that requested the Scene, and stops at the first match", async () => {
    listResumableRunsMock.mockResolvedValue([
      runProjection("run-other", { folderId: "f", sceneIds: ["scene-b"] }),
      runProjection("run-hit", { folderId: "f", sceneIds: ["scene-a"] }),
      runProjection("run-later", { folderId: "f", sceneIds: ["scene-a"] }),
    ]);
    getBundleMock.mockResolvedValue(
      bundle("run-hit", [
        { status: "rejected" },
        { status: "approved", application: null },
      ]),
    );
    await expect(
      hasApprovedUnappliedProposalForScene({
        projectId: "project-a",
        sceneId: "scene-a",
      }),
    ).resolves.toBe(true);
    expect(getBundleMock).toHaveBeenCalledTimes(1);
    expect(getBundleMock).toHaveBeenCalledWith({
      runId: "run-hit",
      projectId: "project-a",
    });
  });

  it("does not count approved-but-applied or non-approved proposals", async () => {
    primeOneRun();
    getBundleMock.mockResolvedValue(
      bundle("run-1", [
        { status: "approved", application: { commitId: "c" } },
        { status: "held" },
        { status: "unreviewed" },
        { status: "deferred" },
      ]),
    );
    await expect(
      hasApprovedUnappliedProposalForScene({
        projectId: "project-a",
        sceneId: "scene-a",
      }),
    ).resolves.toBe(false);
  });

  function primeOneRun() {
    listResumableRunsMock.mockResolvedValue([
      runProjection("run-1", { folderId: "f", sceneIds: ["scene-a"] }),
    ]);
  }

  it("rejects a bundle that belongs to another Run, and propagates read failures", async () => {
    primeOneRun();
    getBundleMock.mockResolvedValue(bundle("run-other", []));
    await expect(
      hasApprovedUnappliedProposalForScene({
        projectId: "project-a",
        sceneId: "scene-a",
      }),
    ).rejects.toThrow(/does not match/u);

    getBundleMock.mockRejectedValue(new Error("native down"));
    await expect(
      hasApprovedUnappliedProposalForScene({
        projectId: "project-a",
        sceneId: "scene-a",
      }),
    ).rejects.toThrow("native down");
  });

  it("never touches the review projection", async () => {
    primeOneRun();
    getBundleMock.mockResolvedValue(
      bundle("run-1", [{ status: "approved", application: null }]),
    );
    const before = useChronicleExtractionStore.getState().projection;
    await hasApprovedUnappliedProposalForScene({
      projectId: "project-a",
      sceneId: "scene-a",
    });
    expect(useChronicleExtractionStore.getState().projection).toBe(before);
  });
});
