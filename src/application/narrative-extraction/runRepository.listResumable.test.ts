import { beforeEach, describe, expect, it, vi } from "vitest";

const listNativeMock = vi.hoisted(() => vi.fn());
const getRunNativeMock = vi.hoisted(() => vi.fn());

vi.mock("./nativeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nativeApi")>();
  return {
    ...actual,
    narrativeExtractionListResumableRuns: listNativeMock,
    narrativeExtractionGetRun: getRunNativeMock,
  };
});

import {
  listResumableRuns,
  resetNarrativeExtractionRunIndexForTests,
} from "./runRepository";

describe("listResumableRuns Native wiring", () => {
  beforeEach(() => {
    resetNarrativeExtractionRunIndexForTests();
    listNativeMock.mockReset();
    getRunNativeMock.mockReset();
  });

  it("invokes Native list_resumable_runs and hydrates projections", async () => {
    listNativeMock.mockResolvedValue([
      {
        runId: "run-1",
        projectId: "project-1",
        surfacePathId: "chronicle.extract",
        status: "completed",
        snapshotDigest: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: "2026-01-01T00:01:00.000Z",
      },
    ]);
    getRunNativeMock.mockResolvedValue({
      run: {
        runId: "run-1",
        projectId: "project-1",
        surfacePathId: "chronicle.extract",
        scopeJson: {},
        specJson: {},
        specDigest: "spec",
        snapshotDigest: null,
        catalogDigest: null,
        registryDigest: null,
        status: "completed",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: "2026-01-01T00:01:00.000Z",
        version: 1,
      },
      tasks: [],
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
    });

    const listed = await listResumableRuns({
      projectId: "project-1",
      surfacePathId: "chronicle.extract",
      limit: 5,
    });

    expect(listNativeMock).toHaveBeenCalledWith({
      projectId: "project-1",
      surfacePathId: "chronicle.extract",
      limit: 5,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.run.runId).toBe("run-1");
  });
});
