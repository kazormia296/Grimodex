import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceState } from "./workspaceState";

vi.mock("@/lib/tauri", () => ({
  listen: vi.fn(),
}));
vi.mock("@/features/ime/workspaceScope", () => ({
  setCurrentImeWorkspaceIdentity: vi.fn(),
}));
vi.mock("@/application/project/workspaceProjectCommands", () => ({
  invalidateWorkspaceProjectLoads: vi.fn(),
}));
vi.mock("@/features/timelapse/recorder", () => ({
  invalidateWorkspaceBindingForLifecycle: vi.fn(),
  pauseWorkspaceBindingForLifecycle: vi.fn(),
  resumeWorkspaceBindingAfterExplicitOpen: vi.fn(() => true),
  resumeWorkspaceBindingAfterLifecycleUnchanged: vi.fn(() => true),
}));

import {
  applyWorkspaceLifecycleProjectionForTest,
  applyWorkspaceLifecycleUnchangedProof,
  noteExplicitWorkspaceHydration,
  resetWorkspaceLifecycleProjectionForTest,
} from "./workspaceLifecycleProjection";
import {
  resumeWorkspaceBindingAfterExplicitOpen,
  resumeWorkspaceBindingAfterLifecycleUnchanged,
} from "@/features/timelapse/recorder";

type TestState = WorkspaceState & Record<string, unknown>;

function makeState(overrides: Partial<TestState> = {}): TestState {
  return {
    view: "editor",
    activeWorkspacePath: "W1",
    activeWorkspaceId: "w1",
    activeWorkspaceName: "W1",
    workspaceOpenRevision: 1,
    workspaceSwitchInProgress: false,
    workspaceHydrated: true,
    workspaceLifecycleRevision: 1,
    workspaceLifecycleStatus: "ready",
    workspaceLifecycleActivation: "ready",
    workspaceLifecycleBindingToken: "old-token",
    recoveryShell: null,
    ...overrides,
  } as TestState;
}

function lifecycle(
  revision: number,
  status: "ready" | "transition",
  bindingToken: string,
) {
  return {
    schemaVersion: 1,
    revision,
    status,
    bindingToken,
    activation: status === "ready" ? "ready" : "none",
  };
}

describe("workspace lifecycle projection explicit Open ordering", () => {
  let state: TestState;
  const get = () => state;
  const set = (patch: Partial<WorkspaceState>) => {
    state = { ...state, ...patch };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceLifecycleProjectionForTest();
    state = makeState();
  });

  it("adopts a Ready event delivered after explicit hydration", () => {
    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(2, "transition", "old-token"),
    );
    state = makeState({
      workspaceLifecycleRevision: 2,
      workspaceLifecycleStatus: "transition",
      workspaceLifecycleActivation: "none",
      workspaceLifecycleBindingToken: "old-token",
      activeWorkspacePath: "W2",
      activeWorkspaceId: "w2",
      activeWorkspaceName: "W2",
      workspaceOpenRevision: 2,
      workspaceHydrated: true,
    });
    noteExplicitWorkspaceHydration({
      workspacePath: "W2",
      workspaceId: "w2",
      workspaceName: "W2",
      openRevision: 2,
      lifecycleRevision: 3,
      lifecycleBindingToken: "new-token",
    });

    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(3, "ready", "new-token"),
    );

    expect(state).toMatchObject({
      view: "editor",
      activeWorkspacePath: "W2",
      activeWorkspaceId: "w2",
      workspaceOpenRevision: 2,
      workspaceHydrated: true,
      workspaceLifecycleStatus: "ready",
      workspaceLifecycleBindingToken: "new-token",
    });
    expect(resumeWorkspaceBindingAfterExplicitOpen).toHaveBeenCalledOnce();
  });

  it("records a Ready event delivered before explicit hydration", () => {
    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(2, "transition", "old-token"),
    );
    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(3, "ready", "new-token"),
    );
    expect(state).toMatchObject({
      view: "launcher",
      workspaceHydrated: false,
      workspaceLifecycleBindingToken: "new-token",
    });

    state = makeState({
      workspaceLifecycleRevision: 3,
      workspaceLifecycleStatus: "ready",
      workspaceLifecycleActivation: "ready",
      workspaceLifecycleBindingToken: "new-token",
      activeWorkspacePath: "W2",
      activeWorkspaceId: "w2",
      activeWorkspaceName: "W2",
      workspaceOpenRevision: 2,
      workspaceHydrated: true,
    });
    noteExplicitWorkspaceHydration({
      workspacePath: "W2",
      workspaceId: "w2",
      workspaceName: "W2",
      openRevision: 2,
      lifecycleRevision: 3,
      lifecycleBindingToken: "new-token",
    });

    // A later snapshot for the adopted binding must remain editor-ready.
    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(4, "ready", "new-token"),
    );
    expect(state).toMatchObject({
      view: "editor",
      activeWorkspacePath: "W2",
      workspaceHydrated: true,
      workspaceLifecycleBindingToken: "new-token",
    });
  });

  it("resumes an exact explicit Open after a delayed Transition clears hydration", () => {
    // The Open operation has already hydrated W2 and recorded its exact Native
    // proof, but an older Transition snapshot arrives before the matching
    // Ready event.  The Transition must not turn the proven Open into a
    // launcher state or leave the timelapse pause outstanding.
    state = makeState({
      workspaceLifecycleRevision: 1,
      workspaceLifecycleStatus: "ready",
      workspaceLifecycleActivation: "ready",
      workspaceLifecycleBindingToken: "old-token",
      activeWorkspacePath: "W2",
      activeWorkspaceId: "w2",
      activeWorkspaceName: "W2",
      workspaceOpenRevision: 2,
      workspaceHydrated: true,
    });
    noteExplicitWorkspaceHydration({
      workspacePath: "W2",
      workspaceId: "w2",
      workspaceName: "W2",
      openRevision: 2,
      lifecycleRevision: 3,
      lifecycleBindingToken: "new-token",
    });

    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(2, "transition", "old-token"),
    );
    expect(state.workspaceHydrated).toBe(false);

    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(3, "ready", "new-token"),
    );

    expect(state).toMatchObject({
      view: "editor",
      activeWorkspacePath: "W2",
      workspaceOpenRevision: 2,
      workspaceHydrated: true,
      workspaceLifecycleStatus: "ready",
      workspaceLifecycleBindingToken: "new-token",
    });
    expect(resumeWorkspaceBindingAfterExplicitOpen).toHaveBeenCalledOnce();
  });

  it("applies an Unchanged proof after Transition when the Ready event is lost", () => {
    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(2, "transition", "old-token"),
    );
    expect(state.workspaceHydrated).toBe(false);

    expect(
      applyWorkspaceLifecycleUnchangedProof(
        get,
        set,
        lifecycle(3, "ready", "old-token"),
      ),
    ).toBe(true);
    expect(state).toMatchObject({
      view: "editor",
      workspaceHydrated: true,
      workspaceLifecycleRevision: 3,
      workspaceLifecycleStatus: "ready",
      workspaceLifecycleBindingToken: "old-token",
    });
    expect(resumeWorkspaceBindingAfterLifecycleUnchanged).toHaveBeenCalledOnce();
  });

  it("ignores a delayed older Transition after an Unchanged proof", () => {
    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(1, "ready", "old-token"),
    );
    expect(
      applyWorkspaceLifecycleUnchangedProof(
        get,
        set,
        lifecycle(3, "ready", "old-token"),
      ),
    ).toBe(true);
    applyWorkspaceLifecycleProjectionForTest(
      get,
      set,
      lifecycle(2, "transition", "old-token"),
    );
    expect(state).toMatchObject({
      view: "editor",
      workspaceHydrated: true,
      workspaceLifecycleRevision: 3,
      workspaceLifecycleStatus: "ready",
      workspaceLifecycleBindingToken: "old-token",
    });
    expect(resumeWorkspaceBindingAfterLifecycleUnchanged).toHaveBeenCalledOnce();
  });
});
