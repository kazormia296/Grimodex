import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshImeExportMock = vi.fn();
vi.mock("./api", () => ({
  refreshImeExport: (...args: unknown[]) => refreshImeExportMock(...args),
}));

import {
  IME_EXPORT_DEBOUNCE_MS,
  cancelScheduledImeExports,
  scheduleImeExportRefresh,
  setImeExportRefreshPaused,
} from "./scheduler";
import { setCurrentImeWorkspaceIdentity } from "./workspaceScope";

describe("IME export refresh scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setImeExportRefreshPaused(false);
    refreshImeExportMock.mockReset().mockResolvedValue(undefined);
    setCurrentImeWorkspaceIdentity({ path: "/workspaces/a", openRevision: 1 });
  });

  afterEach(() => {
    cancelScheduledImeExports();
    setImeExportRefreshPaused(false);
    vi.useRealTimers();
  });

  it("debounces repeated mutations for the same project", async () => {
    scheduleImeExportRefresh("p1");
    scheduleImeExportRefresh("p1");
    await vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS - 1);
    expect(refreshImeExportMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refreshImeExportMock).toHaveBeenCalledTimes(1);
    expect(refreshImeExportMock).toHaveBeenCalledWith("p1", {
      path: "/workspaces/a",
      openRevision: 1,
    });
  });

  it("keeps different projects independent", async () => {
    scheduleImeExportRefresh("p1");
    scheduleImeExportRefresh("p2");
    await vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS);
    expect(refreshImeExportMock).toHaveBeenCalledTimes(2);
    expect(refreshImeExportMock).toHaveBeenCalledWith("p1", {
      path: "/workspaces/a",
      openRevision: 1,
    });
    expect(refreshImeExportMock).toHaveBeenCalledWith("p2", {
      path: "/workspaces/a",
      openRevision: 1,
    });
  });

  it("contains native export failures instead of rejecting the mutation path", async () => {
    refreshImeExportMock.mockRejectedValueOnce(new Error("disk full"));
    scheduleImeExportRefresh("p1");
    await vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS);
    expect(refreshImeExportMock).toHaveBeenCalledWith("p1", {
      path: "/workspaces/a",
      openRevision: 1,
    });
  });

  it("cancels every pending workspace-scoped refresh before a workspace swap", async () => {
    scheduleImeExportRefresh("p1");
    scheduleImeExportRefresh("p2");

    cancelScheduledImeExports();
    await vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS);

    expect(refreshImeExportMock).not.toHaveBeenCalled();
  });

  it("blocks a late Codex write completion after workspace-switch cancellation", async () => {
    let finishWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      finishWrite = resolve;
    }).then(() => scheduleImeExportRefresh("p1"));

    scheduleImeExportRefresh("p1");
    cancelScheduledImeExports();
    setImeExportRefreshPaused(true);
    finishWrite();
    await write;
    await vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS);

    expect(refreshImeExportMock).not.toHaveBeenCalled();
  });

  it("does not dispatch a pending refresh if a workspace switch starts before its debounce", async () => {
    scheduleImeExportRefresh("p1");
    setImeExportRefreshPaused(true);

    await vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS);

    expect(refreshImeExportMock).not.toHaveBeenCalled();
  });

  it("cancels only the requested project when a project is deleted", async () => {
    scheduleImeExportRefresh("p1");
    scheduleImeExportRefresh("p2");

    cancelScheduledImeExports("p1");
    await vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS);

    expect(refreshImeExportMock).toHaveBeenCalledTimes(1);
    expect(refreshImeExportMock).toHaveBeenCalledWith("p2", {
      path: "/workspaces/a",
      openRevision: 1,
    });
  });
});
