// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const project = {
  currentProjectId: "p1" as string | null,
  projects: [] as { id: string }[],
  refreshProjects: vi.fn(async () => {}),
};
const workspace = {
  activeWorkspaceId: "w1" as string | null,
  activeWorkspacePath: "/w1" as string | null,
  workspaceSwitchInProgress: false,
};
const warn = vi.hoisted(() => vi.fn());

vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: { getState: () => project },
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: { getState: () => workspace },
}));
vi.mock("@/lib/debugLog", () => ({ debugLog: { warn } }));

import { refreshProjectListOnceIfCurrentMissing } from "./refreshMissingProject";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let sequence = 0;

// 起こした組は module に残るので、試験ごとに新しい組を使う。
beforeEach(() => {
  sequence += 1;
  project.currentProjectId = `p${sequence}`;
  project.projects = [];
  project.refreshProjects.mockReset();
  project.refreshProjects.mockImplementation(async () => {});
  workspace.activeWorkspaceId = "w1";
  workspace.activeWorkspacePath = "/w1";
  workspace.workspaceSwitchInProgress = false;
  warn.mockReset();
});

describe("refreshProjectListOnceIfCurrentMissing", () => {
  it("refreshes once per workspace and Project, after the caller returns", async () => {
    refreshProjectListOnceIfCurrentMissing();
    refreshProjectListOnceIfCurrentMissing();
    expect(project.refreshProjects).not.toHaveBeenCalled();
    await flush();
    refreshProjectListOnceIfCurrentMissing();
    await flush();
    expect(project.refreshProjects).toHaveBeenCalledTimes(1);

    workspace.activeWorkspaceId = "w2";
    refreshProjectListOnceIfCurrentMissing();
    await flush();
    expect(project.refreshProjects).toHaveBeenCalledTimes(2);
  });

  it("records a Project that is still missing, and does not retry", async () => {
    refreshProjectListOnceIfCurrentMissing();
    await flush();
    refreshProjectListOnceIfCurrentMissing();
    await flush();
    expect(project.refreshProjects).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not record a Project that the refresh brought in", async () => {
    project.refreshProjects.mockImplementation(async () => {
      project.projects = [{ id: project.currentProjectId as string }];
    });
    refreshProjectListOnceIfCurrentMissing();
    await flush();
    expect(project.refreshProjects).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["a workspace switch", () => (workspace.workspaceSwitchInProgress = true)],
    ["no current Project", () => (project.currentProjectId = null)],
    [
      "no workspace",
      () => {
        workspace.activeWorkspaceId = null;
        workspace.activeWorkspacePath = null;
      },
    ],
    [
      "a listed Project",
      () => (project.projects = [{ id: project.currentProjectId as string }]),
    ],
  ])("does nothing with %s", async (_label, arrange) => {
    arrange();
    refreshProjectListOnceIfCurrentMissing();
    await flush();
    expect(project.refreshProjects).not.toHaveBeenCalled();
  });

  it("does nothing when a switch starts before the deferred refresh", async () => {
    refreshProjectListOnceIfCurrentMissing();
    workspace.workspaceSwitchInProgress = true;
    await flush();
    expect(project.refreshProjects).not.toHaveBeenCalled();
  });
});
