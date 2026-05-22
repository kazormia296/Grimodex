import { describe, it, expect, vi, beforeEach } from "vitest";
import { enqueueIpc, resetIpcQueueForTests } from "./ipcQueue";

describe("enqueueIpc", () => {
  beforeEach(() => {
    resetIpcQueueForTests();
  });

  it("limits concurrent execution", async () => {
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 8 }, (_, i) =>
      enqueueIpc(
        `cmd-${i}`,
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return i;
        },
        1_000,
      ),
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("starts timeout when execution begins, not while queued", async () => {
    vi.useFakeTimers();

    const blockers = Array.from({ length: 4 }, () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { gate, release };
    });

    for (const blocker of blockers) {
      void enqueueIpc("block", () => blocker.gate.then(() => "blocked"), 100);
    }

    const queued = enqueueIpc("queued", () => Promise.resolve("ok"), 100);

    await vi.advanceTimersByTimeAsync(99);
    blockers.forEach((b) => b.release());
    await expect(queued).resolves.toBe("ok");

    vi.useRealTimers();
  });
});
