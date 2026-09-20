import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetQuiescenceLeasesForTests,
  isRendererTeardownStarted,
} from "@/application/lifecycle/quiescenceLease";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import {
  _resetMutationAuthorityForTests,
  captureMutationAuthority,
  runAuthoritativeMutation,
} from "@/features/concurrency/mutationAuthority";
import {
  getCurrentWorkspaceIdentity,
  setCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { useWorkspaceStore } from "@/features/workspace/store";
import type { WorkspaceRestoreOutcome } from "@/../electron/shared/workspaceRestoreOutcome";
import {
  applyWorkspaceLifecycleProjectionForTest,
  resetWorkspaceLifecycleProjectionForTest,
} from "@/features/workspace/workspaceLifecycleProjection";

const restoreMock = vi.hoisted(
  () => vi.fn<() => Promise<WorkspaceRestoreOutcome>>(),
);
const recorderMock = vi.hoisted(() => ({
  beginWorkspaceSwitch: vi.fn(),
  endWorkspaceSwitch: vi.fn(),
  resumeWorkspaceBindingAfterLifecycleUnchanged: vi.fn(() => true),
}));

vi.mock("./backupApi", () => ({
  restoreBackup: restoreMock,
}));
vi.mock("@/application/workspace/workspaceScheduleQuiescence", () => ({
  cancelWorkspaceScopedSchedules: vi.fn(),
}));
vi.mock("@/features/editor/editorSaveRegistry", () => ({
  clearRetainedEditorRecoveryDraftsForScopeChange: vi.fn(),
}));
vi.mock("@/features/timelapse/recorder", () => recorderMock);

import { restoreBackupWithWorkspaceAuthority } from "./backupRestoreAuthority";

function restoredOutcome(): WorkspaceRestoreOutcome {
  return {
    status: "restored",
    operationOutcome: "succeeded",
    contentEffect: "replaced",
    lifecycle: {
      schemaVersion: 1,
      revision: 4,
      status: "ready",
      bindingToken: "restore-token",
      activation: "ready",
    },
    activation: "ready",
  };
}

function unchangedOutcome(
  bindingToken = "ready-token",
): WorkspaceRestoreOutcome {
  return {
    status: "unchanged",
    operationOutcome: "failed",
    contentEffect: "none",
    lifecycle: {
      schemaVersion: 1,
      revision: 4,
      status: "ready",
      bindingToken,
      activation: "ready",
    },
  };
}

function notAdmittedOutcome(): WorkspaceRestoreOutcome {
  return {
    status: "not-admitted",
    operationOutcome: "unknown",
    contentEffect: "none",
    lifecycle: {
      schemaVersion: 1,
      revision: 3,
      status: "transition",
      bindingToken: "ready-token",
      activation: "none",
    },
    reasonCode: "lifecycle-not-admitted",
  };
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

describe("restoreBackupWithWorkspaceAuthority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMutationAuthorityForTests();
    _resetQuiescenceLeasesForTests();
    publishCurrentProjectId("project-a");
    setCurrentWorkspaceIdentity({ path: "/workspace/a", openRevision: 3 });
    useWorkspaceStore.setState({
      view: "editor",
      activeWorkspacePath: "/workspace/a",
      activeWorkspaceId: "workspace-a",
      activeWorkspaceName: "Workspace A",
      workspaceOpenRevision: 3,
      workspaceHydrated: true,
      workspaceLifecycleRevision: 3,
      workspaceLifecycleStatus: "ready",
      workspaceLifecycleActivation: "ready",
      workspaceLifecycleBindingToken: "ready-token",
    });
    resetWorkspaceLifecycleProjectionForTest();
    applyWorkspaceLifecycleProjectionForTest(
      useWorkspaceStore.getState,
      useWorkspaceStore.setState,
      {
        schemaVersion: 1,
        revision: 3,
        status: "ready",
        bindingToken: "ready-token",
        activation: "ready",
      },
    );
    restoreMock.mockResolvedValue(restoredOutcome());
  });

  it("drains an in-flight binding capture before replacing the Workspace and rejects captures during restore", async () => {
    const captureGate = deferred<string>();
    const authority = captureMutationAuthority("project-a", () => "project-a");
    const inFlightCapture = runAuthoritativeMutation(
      authority,
      () => captureGate.promise,
    );

    const restoreGate = deferred<WorkspaceRestoreOutcome>();
    restoreMock.mockImplementation(() => restoreGate.promise);
    const restoring = restoreBackupWithWorkspaceAuthority("backup.db");

    await Promise.resolve();
    expect(restoreMock).not.toHaveBeenCalled();

    captureGate.resolve("binding-a");
    await expect(inFlightCapture).resolves.toEqual({
      status: "current",
      value: "binding-a",
    });
    await vi.waitFor(() =>
      expect(restoreMock).toHaveBeenCalledWith("backup.db"),
    );
    expect(getCurrentWorkspaceIdentity()).toBeNull();

    const captureDuringRestore = vi.fn(async () => "binding-b");
    await expect(
      runAuthoritativeMutation(authority, captureDuringRestore),
    ).resolves.toEqual({ status: "stale" });
    expect(captureDuringRestore).not.toHaveBeenCalled();

    restoreGate.resolve(restoredOutcome());
    await restoring;
    expect(isRendererTeardownStarted()).toBe(true);
    expect(recorderMock.endWorkspaceSwitch).toHaveBeenCalledWith({
      restoreBinding: false,
    });
  });

  it("restores the renderer identity only for an exact unchanged proof", async () => {
    restoreMock.mockResolvedValue(unchangedOutcome());

    await expect(
      restoreBackupWithWorkspaceAuthority("backup.db"),
    ).rejects.toThrow("NEX_WORKSPACE_RESTORE_UNCHANGED");

    expect(getCurrentWorkspaceIdentity()).toEqual({
      path: "/workspace/a",
      openRevision: 3,
    });
    expect(isRendererTeardownStarted()).toBe(false);
    expect(recorderMock.endWorkspaceSwitch).toHaveBeenCalledWith({
      restoreBinding: true,
    });
  });

  it("does not resume the old binding when Native rejects Restore before admission", async () => {
    restoreMock.mockResolvedValue(notAdmittedOutcome());

    await expect(
      restoreBackupWithWorkspaceAuthority("backup.db"),
    ).rejects.toThrow("NEX_WORKSPACE_RESTORE_NOT_ADMITTED");

    expect(getCurrentWorkspaceIdentity()).toBeNull();
    expect(isRendererTeardownStarted()).toBe(false);
    expect(recorderMock.endWorkspaceSwitch).toHaveBeenCalledWith({
      restoreBinding: false,
    });
  });

  it("fails closed when unchanged proof has a stale binding token", async () => {
    restoreMock.mockResolvedValue(unchangedOutcome("stale-token"));

    await expect(
      restoreBackupWithWorkspaceAuthority("backup.db"),
    ).rejects.toThrow("RESTORE_FORENSIC_RECOVERY_REQUIRED");

    expect(getCurrentWorkspaceIdentity()).toBeNull();
    expect(recorderMock.endWorkspaceSwitch).toHaveBeenCalledWith({
      restoreBinding: false,
    });
  });

  it("fails closed for an unclassified Native restore error", async () => {
    restoreMock.mockRejectedValue(new Error("restore handoff is uncertain"));

    await expect(
      restoreBackupWithWorkspaceAuthority("backup.db"),
    ).rejects.toThrow("restore handoff is uncertain");

    expect(getCurrentWorkspaceIdentity()).toBeNull();
    expect(recorderMock.endWorkspaceSwitch).toHaveBeenCalledWith({
      restoreBinding: false,
    });
  });

  it("keeps renderer teardown sealed when marker finalization fails after Native publication", async () => {
    restoreMock.mockRejectedValue(
      new Error("RESTORE_SESSION_MARKER_FINALIZE_FAILED: marker rename failed"),
    );

    await expect(
      restoreBackupWithWorkspaceAuthority("backup.db"),
    ).rejects.toThrow("RESTORE_SESSION_MARKER_FINALIZE_FAILED");

    expect(getCurrentWorkspaceIdentity()).toBeNull();
    expect(isRendererTeardownStarted()).toBe(true);
    expect(recorderMock.endWorkspaceSwitch).toHaveBeenCalledWith({
      restoreBinding: false,
    });
  });

  it("keeps renderer teardown sealed when Native requires forensic recovery", async () => {
    restoreMock.mockRejectedValue(
      new Error(
        "RESTORE_FORENSIC_RECOVERY_REQUIRED: live authority is unpublished",
      ),
    );

    await expect(
      restoreBackupWithWorkspaceAuthority("backup.db"),
    ).rejects.toThrow("RESTORE_FORENSIC_RECOVERY_REQUIRED");

    expect(getCurrentWorkspaceIdentity()).toBeNull();
    expect(isRendererTeardownStarted()).toBe(true);
    expect(recorderMock.endWorkspaceSwitch).toHaveBeenCalledWith({
      restoreBinding: false,
    });
  });

  it("fails closed before lease acquisition when renderer Workspace identity is unpublished", async () => {
    setCurrentWorkspaceIdentity(null);

    await expect(
      restoreBackupWithWorkspaceAuthority("backup.db"),
    ).rejects.toThrow("NEX_WORKSPACE_RESTORE_AUTHORITY_UNAVAILABLE");
    expect(restoreMock).not.toHaveBeenCalled();
    expect(isRendererTeardownStarted()).toBe(false);
  });
});
