import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  listen: vi.fn(),
  release: vi.fn(),
  unlisten: vi.fn(),
  listenReady: vi.fn(),
  unlistenReady: vi.fn(),
  invalidate: undefined as ((queryBinding: string) => void) | undefined,
}));

vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesInvalidations: h.listen,
  listenRelatedScenesIndexReady: h.listenReady,
  releaseRelatedScenes: h.release,
}));

import { createNir1RelatedScenesSession } from "./nir1RelatedScenesSession";

const sessions: ReturnType<typeof createNir1RelatedScenesSession>[] = [];
function session(signal?: AbortSignal) {
  const result = createNir1RelatedScenesSession("p1", signal);
  sessions.push(result);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.invalidate = undefined;
  h.listen.mockImplementation(
    async (callback: (queryBinding: string) => void) => {
      h.invalidate = callback;
      return h.unlisten;
    },
  );
  h.release.mockResolvedValue({ status: "released" });
  h.listenReady.mockResolvedValue(h.unlistenReady);
});

afterEach(() => {
  for (const value of sessions.splice(0)) value.invalidate();
});

describe("NIR1 query invalidation and operation lifetime", () => {
  it("resolves ready only after the invalidation subscription is registered", async () => {
    let resolveListener: ((unlisten: () => void) => void) | undefined;
    h.listen.mockReturnValueOnce(
      new Promise<() => void>((resolve) => {
        resolveListener = resolve;
      }),
    );
    const value = session();
    let ready = false;
    const connecting = value.connect().then((result) => {
      ready = result;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    resolveListener!(h.unlisten);
    await connecting;
    expect(ready).toBe(true);
    expect(value.isActive()).toBe(true);
  });

  it("does not register a subscription for an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const value = session(controller.signal);
    expect(await value.connect()).toBe(false);
    expect(h.listen).not.toHaveBeenCalled();
    expect(value.stopReason).toBe("cancelled");
  });

  it("unsubscribes a late registration after cancellation", async () => {
    let resolveListener: ((unlisten: () => void) => void) | undefined;
    h.listen.mockReturnValueOnce(
      new Promise<() => void>((resolve) => {
        resolveListener = resolve;
      }),
    );
    const controller = new AbortController();
    const value = session(controller.signal);
    const connecting = value.connect();
    controller.abort();
    resolveListener!(h.unlisten);
    expect(await connecting).toBe(false);
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("keeps a matching invalidation received before begin returns", async () => {
    const value = session();
    await value.connect();
    h.invalidate!("query-a");
    expect(value.bind("query-a", "ticket-a")).toBe(false);
    expect(value.stopReason).toBe("invalidated");
    expect(h.release).toHaveBeenCalledWith("ticket-a");
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("ignores unrelated operations before and after its binding is known", async () => {
    const value = session();
    await value.connect();
    h.invalidate!("other-query");
    expect(value.bind("my-query", "my-ticket")).toBe(true);
    h.invalidate!("other-query");
    expect(value.isActive()).toBe(true);
    expect(value.stopReason).toBeNull();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("counts duplicate pre-binding notifications once without overflow", async () => {
    const value = session();
    await value.connect();
    for (let i = 0; i < 100; i++) h.invalidate!("other-query");
    expect(value.bind("my-query", "my-ticket")).toBe(true);
    expect(value.stopReason).toBeNull();
  });

  it("records overflow and cancels instead of silently evicting unknown bindings", async () => {
    const value = session();
    await value.connect();
    for (let i = 0; i < 65; i++) h.invalidate!(`query-${i}`);
    expect(value.isActive()).toBe(false);
    expect(value.stopReason).toBe("invalidation-overflow");
    expect(value.bind("query-0", "late-ticket")).toBe(false);
    expect(h.release).toHaveBeenCalledWith("late-ticket");
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("keeps an operation while a navigation lease outlives the displayed list", async () => {
    const value = session();
    await value.connect();
    value.bind("query-a", "ticket-a");
    value.completeFetch();
    const lease = value.retain();
    expect(lease).not.toBeNull();
    value.release();
    value.release();
    expect(lease!.isActive()).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.unlisten).not.toHaveBeenCalled();
    lease!.release();
    lease!.release();
    expect(lease!.isActive()).toBe(false);
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("matching canonical invalidation overrides all retained navigation leases", async () => {
    const value = session();
    await value.connect();
    value.bind("query-a", "ticket-a");
    value.completeFetch();
    const lease = value.retain()!;
    const invalidated = vi.fn();
    value.subscribeInvalidation(invalidated);
    value.release();
    h.invalidate!("query-a");
    expect(lease.isActive()).toBe(false);
    expect(invalidated).toHaveBeenCalledExactlyOnceWith("invalidated");
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
    expect(value.retain()).toBeNull();
    lease.release();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("cancels a pending fetch and releases its ticket on abort", async () => {
    const controller = new AbortController();
    const value = session(controller.signal);
    await value.connect();
    value.bind("query-a", "ticket-a");
    controller.abort();
    expect(value.stopReason).toBe("cancelled");
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
  });

  it("detaches fetch cancellation after completion so an owned target transition can retain its lease", async () => {
    const controller = new AbortController();
    const value = session(controller.signal);
    await value.connect();
    value.bind("query-a", "ticket-a");
    value.completeFetch();
    const lease = value.retain()!;
    controller.abort();
    value.release();
    expect(lease.isActive()).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
    lease.release();
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket-a");
  });

  it("releases a ticket returned after the request was already cancelled", async () => {
    const controller = new AbortController();
    const value = session(controller.signal);
    await value.connect();
    controller.abort();
    expect(value.bind("query-a", "late-ticket")).toBe(false);
    expect(h.release).toHaveBeenCalledExactlyOnceWith("late-ticket");
  });

  it("replays an already observed invalidation to a late observer", async () => {
    const value = session();
    await value.connect();
    value.bind("query-a", "ticket-a");
    h.invalidate!("query-a");
    const invalidated = vi.fn();
    value.subscribeInvalidation(invalidated);
    expect(invalidated).toHaveBeenCalledExactlyOnceWith("invalidated");
  });

  it("does not treat a failed subscription as a ready query", async () => {
    h.listen.mockRejectedValueOnce(new Error("private transport detail"));
    const value = session();
    expect(await value.connect()).toBe(false);
    expect(value.stopReason).toBe("listener-unavailable");
    expect(h.release).not.toHaveBeenCalled();
  });

  it("cannot create a navigation lease before a ticket-backed fetch completes", async () => {
    const value = session();
    await value.connect();
    expect(value.retain()).toBeNull();
    value.bind("query-a", "ticket-a");
    expect(value.retain()).toBeNull();
    value.completeFetch();
    expect(value.retain()).not.toBeNull();
  });
});
