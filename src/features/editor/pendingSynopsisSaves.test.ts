import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectQuiescenceProviderRecovery,
  flushQuiescenceProviderStage,
} from "@/lib/quiescenceProviders";
import {
  _resetPendingSynopsisSavesForTests,
  cancelPendingSynopsisSave,
  flushPendingSynopsisSaves,
  schedulePendingSynopsisSave,
} from "./pendingSynopsisSaves";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetPendingSynopsisSavesForTests();
});

afterEach(() => {
  _resetPendingSynopsisSavesForTests();
  vi.useRealTimers();
});

describe("pending synopsis saves", () => {
  it("debounces for one second and coalesces to the latest value", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const owner = Symbol("editor");

    schedulePendingSynopsisSave({
      key: "tree-synopsis\u0000scene-1",
      owner,
      value: "Old value",
      persist,
    });
    schedulePendingSynopsisSave({
      key: "tree-synopsis\u0000scene-1",
      owner,
      value: "Latest value",
      persist,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("Latest value");
  });

  it("forces a pending debounce immediately and waits for the real write", async () => {
    const write = deferred<void>();
    const persist = vi.fn().mockReturnValue(write.promise);

    schedulePendingSynopsisSave({
      key: "tree-synopsis\u0000scene-1",
      owner: Symbol("editor"),
      value: "Latest value",
      persist,
    });

    let settled = false;
    const flush = flushQuiescenceProviderStage("scoped-mutations").then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    write.resolve();
    await flush;
    expect(settled).toBe(true);
  });

  it("serializes one node and drains only its latest queued value", async () => {
    const firstWrite = deferred<void>();
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const persist = vi
      .fn<(value: string) => Promise<void>>()
      .mockImplementationOnce(async () => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        await firstWrite.promise;
        activeWrites -= 1;
      })
      .mockImplementationOnce(async () => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        activeWrites -= 1;
      });
    const owner = Symbol("editor");
    const key = "tree-synopsis\u0000scene-1";

    schedulePendingSynopsisSave({
      key,
      owner,
      value: "First value",
      persist,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(persist).toHaveBeenCalledTimes(1);

    schedulePendingSynopsisSave({
      key,
      owner,
      value: "Intermediate value",
      persist,
    });
    schedulePendingSynopsisSave({
      key,
      owner,
      value: "Latest value",
      persist,
    });
    const flush = flushPendingSynopsisSaves();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await flush;

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls.map(([value]) => value)).toEqual([
      "First value",
      "Latest value",
    ]);
    expect(maximumActiveWrites).toBe(1);
  });

  it("propagates persistence errors through strict quiescence", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("synopsis disk full"));
    schedulePendingSynopsisSave({
      key: "tree-synopsis\u0000scene-1",
      owner: Symbol("editor"),
      value: "Unsaved value",
      persist,
    });

    await expect(
      flushQuiescenceProviderStage("scoped-mutations"),
    ).rejects.toThrow("synopsis disk full");

    expect(collectQuiescenceProviderRecovery()).toContainEqual({
      kind: "inline-synopsis",
      documentKey: "tree-synopsis\u0000scene-1",
      value: "Unsaved value",
    });
  });

  it("does not persist an owner-cancelled pending edit", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const owner = Symbol("editor");
    const key = "tree-synopsis\u0000scene-1";
    schedulePendingSynopsisSave({
      key,
      owner,
      value: "Cancelled value",
      persist,
    });

    cancelPendingSynopsisSave(key, owner);
    await flushPendingSynopsisSaves();
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
  });
});
