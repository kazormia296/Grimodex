import { beforeEach, describe, expect, it, vi } from "vitest";

const listNativeMock = vi.hoisted(() => vi.fn());
const listTaskResumeNativeMock = vi.hoisted(() => vi.fn());
const getRunNativeMock = vi.hoisted(() => vi.fn());

vi.mock("./nativeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nativeApi")>();
  return {
    ...actual,
    narrativeExtractionListResumableRuns: listNativeMock,
    narrativeExtractionListChronicleTaskResumeCandidates:
      listTaskResumeNativeMock,
    narrativeExtractionGetRun: getRunNativeMock,
  };
});

import {
  listChronicleTaskResumeCandidates,
  listResumableRuns,
  resetNarrativeExtractionRunIndexForTests,
} from "./runRepository";

const digest = (byte: string): string => `sha256:${byte.repeat(64)}`;

function resumeCandidate() {
  const catalogDigest = digest("b");
  const coordinatorContractDigest = digest("c");
  return {
    runId: "run-resume-1",
    projectId: "project-1",
    status: "running",
    scopeJson: { folderId: "folder-1", sceneIds: ["scene-1"] },
    specJson: {
      kind: "chronicle.extract.run-spec@2",
      domain: "chronicle",
      version: 2,
      taskChain: [
        "source.snapshot@1",
        "source.window-plan@1",
        "chronicle.observe-events@1",
        "evidence.resolve@1",
        "chronicle.merge-local-observations@1",
        "chronicle.cluster-event-observations@1",
        "chronicle.synthesize-event@1",
        "chronicle.match-existing-events@1",
        "chronicle.plan-proposals@1",
      ],
      executionMode: "ai",
      existingEventsCatalogDigest: catalogDigest,
      coordinatorContractDigest,
    },
    runSpecDigest: digest("a"),
    snapshotDigest: digest("d"),
    catalogDigest,
    executionMode: "ai",
    coordinatorContractDigest,
    completedTaskKinds: [
      "source.snapshot@1",
      "source.window-plan@1",
      "chronicle.observe-events@1",
      "evidence.resolve@1",
      "chronicle.merge-local-observations@1",
      "chronicle.cluster-event-observations@1",
    ],
    nextTask: {
      taskId: "task-synthesis",
      taskKind: "chronicle.synthesize-event@1",
      status: "queued",
      leaseExpiresAt: null,
    },
    availability: "ready",
    blockedCode: null,
    language: "ja",
    existingEventsCatalog: {
      kind: "chronicle.existing-events-catalog@1",
      events: [
        {
          ref: "event-1",
          sourceKey: "event-1",
          title: "Existing event",
          note: null,
          version: 1,
          linkedDocumentSourceKeys: ["project:scene:scene-1"],
          participantEntityRefs: [],
          startTime: null,
          endTime: null,
          digest: digest("e"),
          applicationProvenanceKeys: [],
        },
      ],
    },
    createdAt: "2026-08-26T00:00:00.000Z",
    startedAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("listResumableRuns Native wiring", () => {
  beforeEach(() => {
    resetNarrativeExtractionRunIndexForTests();
    listNativeMock.mockReset();
    listTaskResumeNativeMock.mockReset();
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

  it("discovers and validates durable Chronicle task-resume candidates without getRun fallback", async () => {
    const nativeCandidate = resumeCandidate();
    listTaskResumeNativeMock.mockResolvedValue([nativeCandidate]);

    const listed = await listChronicleTaskResumeCandidates({
      projectId: "project-1",
      limit: 5,
    });

    expect(listTaskResumeNativeMock).toHaveBeenCalledWith({
      projectId: "project-1",
      limit: 5,
    });
    expect(getRunNativeMock).not.toHaveBeenCalled();
    expect(listed).toEqual([nativeCandidate]);

    nativeCandidate.scopeJson.sceneIds[0] = "mutated-scene";
    nativeCandidate.existingEventsCatalog.events[0]!.title = "Mutated title";
    expect(listed[0]?.scopeJson.sceneIds).toEqual(["scene-1"]);
    expect(listed[0]?.existingEventsCatalog?.events).toEqual([
      expect.objectContaining({ ref: "event-1", title: "Existing event" }),
    ]);
  });

  it("propagates Native task-resume discovery errors instead of treating cold start as empty", async () => {
    const nativeFailure = new Error("database read failed");
    listTaskResumeNativeMock.mockRejectedValue(nativeFailure);

    await expect(
      listChronicleTaskResumeCandidates({ projectId: "project-1" }),
    ).rejects.toBe(nativeFailure);
    expect(getRunNativeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["non-array response", { value: resumeCandidate() }],
    [
      "foreign project",
      [{ ...resumeCandidate(), projectId: "project-foreign" }],
    ],
    ["malformed digest", [{ ...resumeCandidate(), runSpecDigest: "digest" }]],
    [
      "non-canonical task chain",
      [
        {
          ...resumeCandidate(),
          specJson: {
            ...resumeCandidate().specJson,
            taskChain: [
              ...resumeCandidate().specJson.taskChain.slice(0, -1),
              "chronicle.unknown-task@1",
            ],
          },
        },
      ],
    ],
    [
      "non-prefix completion",
      [
        {
          ...resumeCandidate(),
          completedTaskKinds: [
            "source.snapshot@1",
            "chronicle.observe-events@1",
          ],
        },
      ],
    ],
    [
      "lease-held queued task",
      [
        {
          ...resumeCandidate(),
          availability: "lease-held",
          nextTask: {
            ...resumeCandidate().nextTask,
            leaseExpiresAt: "2026-08-26T00:05:00.000Z",
          },
        },
      ],
    ],
    [
      "ready candidate without durable catalog",
      [{ ...resumeCandidate(), existingEventsCatalog: null }],
    ],
    [
      "malformed durable catalog event",
      [
        {
          ...resumeCandidate(),
          existingEventsCatalog: {
            kind: "chronicle.existing-events-catalog@1",
            events: [{ ref: "event-1" }],
          },
        },
      ],
    ],
    [
      "non-NEX blocked code",
      [
        {
          ...resumeCandidate(),
          availability: "blocked",
          blockedCode: "BLOCKED",
        },
      ],
    ],
    [
      "blocked running task without lease",
      [
        {
          ...resumeCandidate(),
          availability: "blocked",
          blockedCode: "NEX_CHRONICLE_RESUME_INPUT_BLOCKED",
          nextTask: {
            ...resumeCandidate().nextTask,
            status: "running",
          },
        },
      ],
    ],
    [
      "pending run with completed task prefix",
      [
        {
          ...resumeCandidate(),
          status: "pending",
          availability: "blocked",
          blockedCode: "NEX_CHRONICLE_RESUME_SNAPSHOT_INCOMPLETE",
          startedAt: null,
        },
      ],
    ],
    [
      "malformed lifecycle instant",
      [{ ...resumeCandidate(), createdAt: "now" }],
    ],
    [
      "impossible RFC3339 calendar date",
      [{ ...resumeCandidate(), createdAt: "2026-02-31T00:00:00.000Z" }],
    ],
    ["unknown response field", [{ ...resumeCandidate(), rendererOwned: true }]],
  ])("rejects %s", async (_label, response) => {
    listTaskResumeNativeMock.mockResolvedValue(response);

    await expect(
      listChronicleTaskResumeCandidates({ projectId: "project-1" }),
    ).rejects.toThrow("NEX_CHRONICLE_TASK_RESUME_CANDIDATE_INVALID");
    expect(getRunNativeMock).not.toHaveBeenCalled();
  });

  it.each([
    { projectId: "" },
    { projectId: " project-1" },
    { projectId: "project-1 " },
    { projectId: "project-1", limit: 0 },
    { projectId: "project-1", limit: 101 },
    { projectId: "project-1", limit: 1.5 },
  ])("rejects invalid task-resume query coordinates %#", async (params) => {
    await expect(listChronicleTaskResumeCandidates(params)).rejects.toThrow(
      "NEX_CHRONICLE_TASK_RESUME_QUERY_INVALID",
    );
    expect(listTaskResumeNativeMock).not.toHaveBeenCalled();
  });
});
