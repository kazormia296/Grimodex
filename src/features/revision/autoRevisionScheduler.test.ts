import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushQuiescenceProviderStage } from "@/lib/quiescenceProviders";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

const h = vi.hoisted(() => ({
  projectId: "project-1",
  scheduled: new Map<
    string,
    { key: string; kind: string; run: () => void | Promise<void> }
  >(),
  createRevision: vi.fn(async () => ({ id: "revision-1" })),
  pruneRevisions: vi.fn(async () => {}),
  recordAutoRevision: vi.fn(),
  shouldAutoRevision: vi.fn(() => true),
  recordCounter: vi.fn(),
  debugWarn: vi.fn(),
}));

vi.mock("@/lib/editorAnalysisScheduler", () => ({
  scheduleEditorAnalysisTask: (task: {
    key: string;
    kind: string;
    run: () => void | Promise<void>;
  }) => {
    h.scheduled.set(task.key, task);
  },
  cancelEditorAnalysisTask: (key: string) => h.scheduled.delete(key),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: h.projectId }),
  },
}));
vi.mock("./api", () => ({
  createRevision: h.createRevision,
  pruneRevisions: h.pruneRevisions,
}));
vi.mock("./revisionStore", () => ({
  useRevisionStore: {
    getState: () => ({
      recordAutoRevision: h.recordAutoRevision,
      shouldAutoRevision: h.shouldAutoRevision,
    }),
  },
}));
vi.mock("@/lib/perfLog", () => ({
  markStart: vi.fn(),
  markEnd: vi.fn(),
  recordCounter: h.recordCounter,
}));
vi.mock("@/lib/debugLog", () => ({
  debugLog: { warn: h.debugWarn },
  errorDetail: (error: unknown) => error,
}));

import {
  _resetAutoRevisionSchedulerForTests,
  scheduleAutoRevision,
} from "./autoRevisionScheduler";

const workspaceIdentity = {
  path: "/workspace/current",
  openRevision: 4,
};
const scopedRevisionKey = JSON.stringify([
  workspaceIdentity.path,
  workspaceIdentity.openRevision,
  "project-1",
  "scene-1",
]);

function request(
  contentVersion: number,
  contentJson = `json-${contentVersion}`,
) {
  return {
    workspaceIdentity,
    projectId: "project-1",
    sceneId: "scene-1",
    contentVersion,
    contentJson,
    intervalMs: 300_000,
    keepCount: 25,
  };
}

async function runScheduledRevision(): Promise<void> {
  const task = [...h.scheduled.values()].find(
    (candidate) => candidate.kind === "revision",
  );
  expect(task).toBeDefined();
  h.scheduled.delete(task?.key ?? "");
  await task?.run();
}

beforeEach(() => {
  _resetAutoRevisionSchedulerForTests();
  h.scheduled.clear();
  vi.clearAllMocks();
  h.projectId = "project-1";
  h.shouldAutoRevision.mockReturnValue(true);
  setCurrentWorkspaceIdentity(workspaceIdentity);
});

afterEach(() => {
  _resetAutoRevisionSchedulerForTests();
  h.scheduled.clear();
  setCurrentWorkspaceIdentity(null);
});

describe("autoRevisionScheduler", () => {
  it("schedules the first autosave when no revision interval exists", () => {
    expect(scheduleAutoRevision(request(7))).toBe(true);

    expect(h.shouldAutoRevision).toHaveBeenCalledWith(
      scopedRevisionKey,
      300_000,
    );
    expect(
      [...h.scheduled.values()].some((task) => task.kind === "revision"),
    ).toBe(true);
  });

  it("reuses the exact durable JSON and records the completed revision", async () => {
    scheduleAutoRevision(request(7, '{"persisted":true}'));

    await runScheduledRevision();

    expect(h.createRevision).toHaveBeenCalledWith({
      entityType: "scene",
      entityId: "scene-1",
      content: '{"persisted":true}',
      snapshotType: "auto",
    });
    expect(h.recordAutoRevision).toHaveBeenCalledWith(scopedRevisionKey);
    expect(h.pruneRevisions).toHaveBeenCalledWith("scene", "scene-1", 25);
  });

  it("latest-wins consecutive saves for the same scene", async () => {
    scheduleAutoRevision(request(7));
    scheduleAutoRevision(request(8));

    await runScheduledRevision();

    expect(h.createRevision).toHaveBeenCalledOnce();
    expect(h.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({ content: "json-8" }),
    );
  });

  it("does not write a task whose workspace authority is stale", async () => {
    scheduleAutoRevision(request(7));
    setCurrentWorkspaceIdentity({
      path: "/workspace/other",
      openRevision: 5,
    });

    await runScheduledRevision();

    expect(h.createRevision).not.toHaveBeenCalled();
  });

  it("does not write a task whose project authority is stale", async () => {
    scheduleAutoRevision(request(7));
    h.projectId = "project-2";

    await runScheduledRevision();

    expect(h.createRevision).not.toHaveBeenCalled();
  });

  it("flushes a pending revision during scoped quiescence", async () => {
    scheduleAutoRevision(request(7));

    await flushQuiescenceProviderStage("scoped-mutations");

    expect(h.createRevision).toHaveBeenCalledOnce();
    expect(h.scheduled.size).toBe(0);
  });

  it("does not fail scoped quiescence when a revision read is cancelled", async () => {
    const cancellation = new Error(
      "IPC_READ_CANCELLED: read cancelled before lifecycle transition completed: db_execute",
    );
    h.createRevision.mockRejectedValueOnce(cancellation);
    scheduleAutoRevision(request(7));

    await expect(
      flushQuiescenceProviderStage("scoped-mutations"),
    ).resolves.toBeUndefined();

    expect(h.recordAutoRevision).not.toHaveBeenCalled();
    expect(h.debugWarn).toHaveBeenCalledWith(
      "AutoSave",
      "revision failed (content saved)",
      cancellation,
    );
    expect(h.scheduled.size).toBe(0);
  });

  it("discards a pending revision without writing it", async () => {
    scheduleAutoRevision(request(7));

    _resetAutoRevisionSchedulerForTests();
    await flushQuiescenceProviderStage("scoped-mutations");

    expect(h.createRevision).not.toHaveBeenCalled();
    expect(h.scheduled.size).toBe(0);
  });
});
