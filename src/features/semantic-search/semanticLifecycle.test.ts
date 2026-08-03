import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  semanticCancelBackground: vi.fn(),
}));
vi.mock("@/features/layout/multiwindow/panelWindow", () => ({
  isPanelWindow: () => false,
}));

import { flushQuiescenceProviderStage } from "@/lib/quiescenceProviders";
import { IpcInvokeError } from "@/lib/tauri";
import { semanticCancelBackground } from "./api";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import { resetIpcQueueForTests } from "@/lib/ipcQueue";
import {
  cancelSemanticBackgroundForLifecycle,
  shouldOwnSemanticLifecycle,
  subscribeSemanticRetryAfterLifecycle,
} from "./semanticLifecycle";

const mockSemanticCancelBackground = vi.mocked(semanticCancelBackground);

describe("semantic lifecycle provider", () => {
  beforeEach(() => {
    _resetQuiescenceLeasesForTests();
    resetIpcQueueForTests();
    vi.clearAllMocks();
    mockSemanticCancelBackground.mockResolvedValue(1);
  });

  it("cooperatively cancels native derived indexing during scoped quiescence", async () => {
    await flushQuiescenceProviderStage("scoped-mutations");

    expect(mockSemanticCancelBackground).toHaveBeenCalledOnce();
  });

  it("keeps process-global semantic lifecycle ownership in the main renderer", () => {
    expect(shouldOwnSemanticLifecycle(false)).toBe(true);
    expect(shouldOwnSemanticLifecycle(true)).toBe(false);
  });

  it.each(["IPC_BACKEND_UNAVAILABLE", "IPC_UNIMPLEMENTED"] as const)(
    "treats optional native version skew (%s) as a no-op",
    async (code) => {
      mockSemanticCancelBackground.mockRejectedValueOnce(
        new IpcInvokeError("semantic_cancel_background", {
          code,
          message: code,
          retryable: false,
          outcome: "failed",
        }),
      );

      await expect(
        cancelSemanticBackgroundForLifecycle(),
      ).resolves.toBeUndefined();
    },
  );

  it("propagates real cancellation-command failures to strict quiescence", async () => {
    mockSemanticCancelBackground.mockRejectedValueOnce(new Error("boom"));

    await expect(cancelSemanticBackgroundForLifecycle()).rejects.toThrow(
      "boom",
    );
  });

  it("notifies auto-index retry only after the final lifecycle lease releases", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSemanticRetryAfterLifecycle(listener);
    const workspaceLease = acquireQuiescenceLease("workspace-open");
    const projectLease = acquireQuiescenceLease("project-load");

    expect(listener).not.toHaveBeenCalled();
    projectLease.release();
    expect(listener).not.toHaveBeenCalled();
    workspaceLease.release();
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
  });

  it("does not restart derived indexing after a successful renderer teardown", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSemanticRetryAfterLifecycle(listener);
    const closeLease = acquireQuiescenceLease("window-close");

    closeLease.release({ disposition: "renderer-teardown" });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps teardown terminal when another lifecycle lease releases last", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSemanticRetryAfterLifecycle(listener);
    const workspaceLease = acquireQuiescenceLease("workspace-open");
    const closeLease = acquireQuiescenceLease("window-close");

    closeLease.release({ disposition: "renderer-teardown" });
    workspaceLease.release();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("still retries derived indexing when a close attempt is cancelled", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSemanticRetryAfterLifecycle(listener);
    const closeLease = acquireQuiescenceLease("window-close");

    closeLease.release();

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
