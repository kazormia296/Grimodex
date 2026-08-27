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

const restoreMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const recorderMock = vi.hoisted(() => ({
  beginWorkspaceSwitch: vi.fn(),
  endWorkspaceSwitch: vi.fn(),
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
    restoreMock.mockResolvedValue(undefined);
  });

  it("drains an in-flight binding capture before replacing the Workspace and rejects captures during restore", async () => {
    const captureGate = deferred<string>();
    const authority = captureMutationAuthority("project-a", () => "project-a");
    const inFlightCapture = runAuthoritativeMutation(
      authority,
      () => captureGate.promise,
    );

    const restoreGate = deferred<void>();
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

    restoreGate.resolve();
    await restoring;
    expect(isRendererTeardownStarted()).toBe(true);
    expect(recorderMock.endWorkspaceSwitch).toHaveBeenCalledWith({
      restoreBinding: false,
    });
  });

  it("restores the renderer identity and admissions when replacement fails before commit", async () => {
    restoreMock.mockRejectedValue(new Error("restore rejected"));

    await expect(
      restoreBackupWithWorkspaceAuthority("backup.db"),
    ).rejects.toThrow("restore rejected");

    expect(getCurrentWorkspaceIdentity()).toEqual({
      path: "/workspace/a",
      openRevision: 3,
    });
    expect(isRendererTeardownStarted()).toBe(false);
    expect(recorderMock.endWorkspaceSwitch).toHaveBeenCalledWith({
      restoreBinding: true,
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
