import { describe, expect, it, vi } from "vitest";

import {
  NARRATIVE_MAINTENANCE_FOREGROUND_RELEASE_DELAY_MS,
  scheduleNarrativeMaintenanceForegroundRelease,
} from "./narrativeMaintenance.js";

describe("C2-5B foreground barrier release", () => {
  it("waits until after the successful tree patch response boundary", async () => {
    const release = vi.fn().mockResolvedValue('{"status":"completed"}');
    const backend = {
      releaseNarrativeMaintenanceForegroundBarrier: release,
    };
    let scheduled: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void) => {
      scheduled = callback;
    });

    scheduleNarrativeMaintenanceForegroundRelease(
      backend,
      "project-1",
      "run-1",
      schedule,
    );

    expect(schedule).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    scheduled?.();
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("project-1", "run-1");
  });

  it("keeps the exact Run observable as running through the response grace window", async () => {
    vi.useFakeTimers();
    try {
      let runStatus: "running" | "completed" = "running";
      const release = vi.fn(() => {
        runStatus = "completed";
        return Promise.resolve('{"status":"completed"}');
      });
      const patchResponse = Promise.resolve('{"ok":true}');

      scheduleNarrativeMaintenanceForegroundRelease(
        { releaseNarrativeMaintenanceForegroundBarrier: release },
        "project-1",
        "run-1",
      );
      await patchResponse;
      expect(runStatus).toBe("running");
      expect(release).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(
        NARRATIVE_MAINTENANCE_FOREGROUND_RELEASE_DELAY_MS - 1,
      );
      expect(runStatus).toBe("running");
      expect(release).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith("project-1", "run-1");
      expect(runStatus).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule failed or malformed patch identities", () => {
    const release = vi.fn();
    const schedule = vi.fn();
    const backend = {
      releaseNarrativeMaintenanceForegroundBarrier: release,
    };

    scheduleNarrativeMaintenanceForegroundRelease(
      backend,
      "",
      "run-1",
      schedule,
    );
    scheduleNarrativeMaintenanceForegroundRelease(
      backend,
      "project-1",
      "",
      schedule,
    );

    expect(schedule).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("retains native retry ownership when an asynchronous release fails", async () => {
    const release = vi.fn().mockRejectedValue(new Error("sqlite busy"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const backend = {
      releaseNarrativeMaintenanceForegroundBarrier: release,
    };
    let scheduled: (() => void) | undefined;

    scheduleNarrativeMaintenanceForegroundRelease(
      backend,
      "project-1",
      "run-1",
      (callback) => {
        scheduled = callback;
      },
    );
    scheduled?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("project-1", "run-1");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("foreground barrier release"),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("does not let a duplicate A timer release same-marker Run B", async () => {
    let phase: "a" | "b" = "a";
    const release = vi.fn(async (_projectId: string, expectedRunId: string) => {
      if (expectedRunId === "run-a" && phase === "a") {
        phase = "b";
        return '{"status":"completed","runId":"run-a"}';
      }
      return '{"status":"not-held"}';
    });
    const callbacks: Array<() => void> = [];
    const schedule = (callback: () => void) => callbacks.push(callback);

    scheduleNarrativeMaintenanceForegroundRelease(
      { releaseNarrativeMaintenanceForegroundBarrier: release },
      "project-1",
      "run-a",
      schedule,
    );
    scheduleNarrativeMaintenanceForegroundRelease(
      { releaseNarrativeMaintenanceForegroundBarrier: release },
      "project-1",
      "run-a",
      schedule,
    );
    expect(callbacks).toHaveLength(2);

    callbacks[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(phase).toBe("b");

    callbacks[1]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(phase).toBe("b");
    expect(release).toHaveBeenNthCalledWith(1, "project-1", "run-a");
    expect(release).toHaveBeenNthCalledWith(2, "project-1", "run-a");
  });
});
