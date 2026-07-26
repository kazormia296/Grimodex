import { describe, expect, it, vi } from "vitest";
import { deactivateImeAtShutdown, registerImeShutdown } from "./imeShutdown.js";

describe("deactivateImeAtShutdown", () => {
  it("waits on the synchronous native shutdown primitive", () => {
    const imeExportDeactivateOnExit = vi.fn();

    deactivateImeAtShutdown({ imeExportDeactivateOnExit });

    expect(imeExportDeactivateOnExit).toHaveBeenCalledTimes(1);
  });

  it("does not prevent shutdown when the backend is unavailable or errors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    deactivateImeAtShutdown(null);
    deactivateImeAtShutdown({
      imeExportDeactivateOnExit: () => {
        throw new Error("fsync failed");
      },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("registers cleanup at will-quit after renderer windows are closed", () => {
    const imeExportDeactivateOnExit = vi.fn();
    const on = vi.fn((event: "will-quit", listener: () => void): unknown => {
      expect(event).toBe("will-quit");
      listener();
      return undefined;
    });

    registerImeShutdown({ on }, () => ({ imeExportDeactivateOnExit }));

    expect(on).toHaveBeenCalledTimes(1);
    expect(imeExportDeactivateOnExit).toHaveBeenCalledTimes(1);
  });
});
