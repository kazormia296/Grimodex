import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshImeExportMock = vi.fn();
vi.mock("./api", () => ({
  refreshImeExport: (...args: unknown[]) => refreshImeExportMock(...args),
}));

import {
  IME_EXPORT_DEBOUNCE_MS,
  cancelScheduledImeExports,
  scheduleImeExportRefresh,
} from "./scheduler";

describe("IME export refresh scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshImeExportMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cancelScheduledImeExports();
    vi.useRealTimers();
  });

  it("debounces repeated mutations for the same project", async () => {
    scheduleImeExportRefresh("p1");
    scheduleImeExportRefresh("p1");
    await vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS - 1);
    expect(refreshImeExportMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refreshImeExportMock).toHaveBeenCalledTimes(1);
    expect(refreshImeExportMock).toHaveBeenCalledWith("p1");
  });

  it("keeps different projects independent", async () => {
    scheduleImeExportRefresh("p1");
    scheduleImeExportRefresh("p2");
    await vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS);
    expect(refreshImeExportMock).toHaveBeenCalledTimes(2);
    expect(refreshImeExportMock).toHaveBeenCalledWith("p1");
    expect(refreshImeExportMock).toHaveBeenCalledWith("p2");
  });

  it("contains native export failures instead of rejecting the mutation path", async () => {
    refreshImeExportMock.mockRejectedValueOnce(new Error("disk full"));
    scheduleImeExportRefresh("p1");
    await expect(
      vi.advanceTimersByTimeAsync(IME_EXPORT_DEBOUNCE_MS),
    ).resolves.toBeUndefined();
  });
});
