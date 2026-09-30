import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelatedScenesReconciler } from "./relatedScenesReconciler.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("related-scenes bounded generation reconciliation", () => {
  it("does not poll without tickets and stops as soon as the final ticket is released", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn().mockResolvedValue({ activeOperations: 1 });
    const scheduler = createRelatedScenesReconciler({ reconcile });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).not.toHaveBeenCalled();
    scheduler.track("owner", "ticket");
    await vi.advanceTimersByTimeAsync(249);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    scheduler.release("owner", "ticket");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates commit wakes and never overlaps a pending Native reconciliation", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ activeOperations: number }>();
    const reconcile = vi.fn().mockReturnValue(pending.promise);
    const scheduler = createRelatedScenesReconciler({ reconcile });
    scheduler.track("owner", "ticket");
    scheduler.wake();
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    scheduler.release("owner", "ticket");
    pending.resolve({ activeOperations: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owner close removes only that owner's tickets and Native expiry stops all polling", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn().mockResolvedValue({ activeOperations: 0 });
    const scheduler = createRelatedScenesReconciler({ reconcile });
    scheduler.track("one", "a");
    scheduler.track("two", "b");
    scheduler.releaseOwner("one");
    await vi.advanceTimersByTimeAsync(250);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not discard a new operation created during a zero-count Native reply", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ activeOperations: number }>();
    const reconcile = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ activeOperations: 1 });
    const scheduler = createRelatedScenesReconciler({ reconcile });
    scheduler.track("owner", "old");
    await vi.advanceTimersByTimeAsync(250);
    scheduler.track("owner", "new");
    pending.resolve({ activeOperations: 0 });
    await vi.advanceTimersByTimeAsync(250);
    expect(reconcile).toHaveBeenCalledTimes(2);
    scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports Native failures and retries only while a bounded live ticket remains", async () => {
    vi.useFakeTimers();
    const reportFailure = vi.fn();
    const reconcile = vi.fn().mockRejectedValue(new Error("failure"));
    const scheduler = createRelatedScenesReconciler({ reconcile, reportFailure });
    scheduler.track("owner", "ticket");
    await vi.advanceTimersByTimeAsync(250);
    expect(reportFailure).toHaveBeenCalledOnce();
    scheduler.releaseOwner("owner");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    scheduler.track("owner", "new-ticket");
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
