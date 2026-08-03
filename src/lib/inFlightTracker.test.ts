import { describe, expect, it } from "vitest";
import { createInFlightTracker } from "./inFlightTracker";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createInFlightTracker", () => {
  it("tracks a rejecting canonical promise and clears it after settlement", async () => {
    const tracker = createInFlightTracker();
    const load = deferred();
    const failure = new Error("load failed");

    tracker.track("project-a", load.promise);
    expect(tracker.peek("project-a")).toBe(load.promise);

    load.reject(failure);
    await expect(load.promise).rejects.toBe(failure);
    expect(tracker.peek("project-a")).toBeNull();
  });

  it("does not let an old scope promise reappear after clear", async () => {
    const tracker = createInFlightTracker();
    const oldLoad = deferred();

    tracker.track("same-project-id", oldLoad.promise);
    tracker.clear();
    expect(tracker.peek("same-project-id")).toBeNull();

    oldLoad.resolve();
    await oldLoad.promise;
    expect(tracker.peek("same-project-id")).toBeNull();
  });
});
