import { afterEach, describe, expect, it, vi } from "vitest";

import { MainReadError } from "./errors.js";
import { runNativeRead, withCallerTimeout } from "./nativeCall.js";

afterEach(() => vi.useRealTimers());

describe("withCallerTimeout", () => {
  it("returns the promise itself when there is no timeout", () => {
    const p = Promise.resolve(1);
    expect(withCallerTimeout(p, null, "x")).toBe(p);
  });

  it("settles with a value that comes in time and clears the timer", async () => {
    vi.useFakeTimers();
    await expect(
      withCallerTimeout(Promise.resolve(7), 1000, "x"),
    ).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes on a rejection that comes in time and clears the timer", async () => {
    vi.useFakeTimers();
    await expect(
      withCallerTimeout(Promise.reject(new Error("boom")), 1000, "x"),
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a timeout error that names the command", async () => {
    vi.useFakeTimers();
    const outcome = withCallerTimeout(
      new Promise(() => undefined),
      50,
      "fts_search",
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    const error = (await outcome) as MainReadError;
    expect(error).toBeInstanceOf(MainReadError);
    expect(error).toMatchObject({
      code: "timeout",
      command: "fts_search",
      beforeSend: false,
    });
  });
});

describe("runNativeRead", () => {
  it("turns a synchronous throw of the call into a rejection and still tracks it", async () => {
    const tracked: Promise<void>[] = [];
    await expect(
      runNativeRead(
        () => {
          throw new Error("sync");
        },
        {
          command: "x",
          timeoutMs: 100,
          hooks: { trackInFlight: (p) => tracked.push(p) },
        },
      ),
    ).rejects.toThrow("sync");
    await expect(tracked[0]).resolves.toBeUndefined();
  });

  it("does not call when assertLive throws first", async () => {
    const call = vi.fn(async () => 1);
    await expect(
      runNativeRead(call, {
        command: "x",
        timeoutMs: null,
        hooks: {
          assertLive: () => {
            throw new Error("closed");
          },
        },
      }),
    ).rejects.toThrow("closed");
    expect(call).not.toHaveBeenCalled();
  });
});
