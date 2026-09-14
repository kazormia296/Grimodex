import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  acquireIpcDerivedAdmissionBarrier,
  cancelDerivedIpcCallersForLifecycle,
  enqueueIpc,
  resetIpcQueueForTests,
} from "./ipcQueue";
import { flushQuiescenceProviderStage } from "./quiescenceProviders";

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

  it("keeps a timed-out task's slot until its actual run settles", async () => {
    vi.useFakeTimers();

    const blockers = Array.from({ length: 4 }, () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { gate, release };
    });
    const timedOut = blockers.map((blocker, index) =>
      enqueueIpc(
        `block-${index}`,
        () => blocker.gate.then(() => index),
        100,
      ).catch((error: unknown) => error),
    );
    const fifthRun = vi.fn(async () => "fifth");
    const fifth = enqueueIpc("fifth", fifthRun, 100);

    await vi.advanceTimersByTimeAsync(100);
    const timeoutResults = await Promise.all(timedOut);
    expect(
      timeoutResults.every(
        (result) =>
          result instanceof Error && result.message.includes("IPC timeout"),
      ),
    ).toBe(true);
    expect(fifthRun).not.toHaveBeenCalled();

    blockers[0]!.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fifthRun).toHaveBeenCalledOnce();
    await expect(fifth).resolves.toBe("fifth");

    blockers.slice(1).forEach((blocker) => blocker.release());
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("does not let an unabortable timed-out read block strict quiescence", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const actual = new Promise<string>((resolve) => {
      release = () => resolve("late result");
    });

    const caller = enqueueIpc("read-only", () => actual, 100, "read").catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(caller).resolves.toMatchObject({
      message: "IPC timeout after 100ms: read-only",
    });

    await expect(
      flushQuiescenceProviderStage("ipc-actual-tasks"),
    ).resolves.toBeUndefined();

    release();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("ignores an expected D2a denial while draining strict quiescence", async () => {
    const caller = enqueueIpc(
      "foreshadow_get_scene_context",
      async () => {
        throw new Error("D2A_EGRESS_DENIED: plaintext-publication");
      },
      null,
    );

    await expect(
      flushQuiescenceProviderStage("ipc-actual-tasks"),
    ).resolves.toBeUndefined();
    await expect(caller).rejects.toThrow("D2A_EGRESS_DENIED");
  });

  it("reserves a slot for mutations when three timed-out reads never settle", async () => {
    vi.useFakeTimers();
    const readGates = Array.from({ length: 4 }, () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { gate, release };
    });

    const readCallers = readGates.map((gate, index) =>
      enqueueIpc(`read-${index}`, () => gate.gate, 100, "read").catch(
        (error: unknown) => error,
      ),
    );
    const mutationRun = vi.fn(async () => "saved");
    const mutation = enqueueIpc("save", mutationRun, null, "mutation");

    await vi.advanceTimersByTimeAsync(0);
    expect(mutationRun).toHaveBeenCalledOnce();
    await expect(mutation).resolves.toBe("saved");

    await vi.advanceTimersByTimeAsync(100);
    expect(
      (await Promise.all(readCallers.slice(0, 3))).every(
        (result) => result instanceof Error,
      ),
    ).toBe(true);
    expect(readCallers[3]).not.toBeUndefined();

    readGates.forEach((gate) => gate.release());
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("bounds derived index work and keeps a slot available for manuscript mutations", async () => {
    const derivedGates = Array.from({ length: 2 }, () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { gate, release };
    });
    const firstDerivedRun = vi.fn(() => derivedGates[0]!.gate);
    const secondDerivedRun = vi.fn(() => derivedGates[1]!.gate);
    const firstDerived = enqueueIpc(
      "semantic_reindex_all",
      firstDerivedRun,
      null,
      "derived",
    );
    const secondDerived = enqueueIpc(
      "semantic_index_scene",
      secondDerivedRun,
      null,
      "derived",
    );
    const mutationRun = vi.fn(async () => "saved");
    const mutation = enqueueIpc("save_scene", mutationRun, null, "mutation");

    await Promise.resolve();
    expect(firstDerivedRun).toHaveBeenCalledOnce();
    expect(secondDerivedRun).not.toHaveBeenCalled();
    await expect(mutation).resolves.toBe("saved");

    // Derived indexes are rebuildable and must not hold document quiescence.
    await expect(
      flushQuiescenceProviderStage("ipc-actual-tasks"),
    ).resolves.toBeUndefined();

    derivedGates[0]!.release();
    await firstDerived;
    await vi.waitFor(() => expect(secondDerivedRun).toHaveBeenCalledOnce());
    derivedGates[1]!.release();
    await secondDerived;
  });

  it("cancels derived callers without releasing their actual native slot early", async () => {
    let releaseDerived!: () => void;
    const actualDerived = new Promise<void>((resolve) => {
      releaseDerived = resolve;
    });
    const firstRun = vi.fn(() => actualDerived);
    const secondRun = vi.fn(async () => "second");
    const firstCaller = enqueueIpc(
      "semantic_reindex_all",
      firstRun,
      null,
      "derived",
    ).catch((error: unknown) => error);
    const secondCaller = enqueueIpc(
      "semantic_index_scene",
      secondRun,
      null,
      "derived",
    ).catch((error: unknown) => error);

    cancelDerivedIpcCallersForLifecycle();

    await expect(firstCaller).resolves.toMatchObject({
      message: expect.stringContaining("IPC_DERIVED_CANCELLED"),
    });
    await expect(secondCaller).resolves.toMatchObject({
      message: expect.stringContaining("IPC_DERIVED_CANCELLED"),
    });
    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).not.toHaveBeenCalled();

    // The single derived lane remains owned by the real native task.
    const lateRun = vi.fn(async () => "late");
    const late = enqueueIpc("codex_reindex_all", lateRun, null, "derived");
    expect(lateRun).not.toHaveBeenCalled();
    releaseDerived();
    await vi.waitFor(() => expect(lateRun).toHaveBeenCalledOnce());
    await expect(late).resolves.toBe("late");
  });

  it("rejects new derived work while a lifecycle admission barrier is active", async () => {
    const releaseBarrier = acquireIpcDerivedAdmissionBarrier();
    const run = vi.fn(async () => "not-started");

    await expect(
      enqueueIpc("semantic_index_scene", run, null, "derived"),
    ).rejects.toThrow("IPC_DERIVED_CANCELLED");
    expect(run).not.toHaveBeenCalled();

    releaseBarrier();
    await expect(
      enqueueIpc("semantic_index_scene", run, null, "derived"),
    ).resolves.toBe("not-started");
    expect(run).toHaveBeenCalledOnce();
  });

  it("cancels old-scope read callers and removes queued reads before lifecycle mutation", async () => {
    const readGates = Array.from({ length: 3 }, () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { gate, release };
    });
    const activeCallers = readGates.map((gate, index) =>
      enqueueIpc(`active-read-${index}`, () => gate.gate, 10_000, "read").catch(
        (error: unknown) => error,
      ),
    );
    const queuedReadRun = vi.fn(async () => "wrong-workspace");
    const queuedCaller = enqueueIpc(
      "queued-read",
      queuedReadRun,
      10_000,
      "read",
    ).catch((error: unknown) => error);

    await expect(
      flushQuiescenceProviderStage("ipc-actual-tasks"),
    ).resolves.toBeUndefined();
    expect(queuedReadRun).not.toHaveBeenCalled();
    await expect(queuedCaller).resolves.toMatchObject({
      message: expect.stringContaining("cancelled before lifecycle transition"),
    });
    expect(
      (await Promise.all(activeCallers)).every(
        (result) =>
          result instanceof Error &&
          result.message.includes("cancelled before lifecycle transition"),
      ),
    ).toBe(true);

    const lifecycleRun = vi.fn(async () => "opened");
    await expect(
      enqueueIpc("open-workspace", lifecycleRun, null, "mutation"),
    ).resolves.toBe("opened");
    expect(lifecycleRun).toHaveBeenCalledOnce();

    readGates.forEach((gate) => gate.release());
    await Promise.resolve();
    await Promise.resolve();
  });
});
