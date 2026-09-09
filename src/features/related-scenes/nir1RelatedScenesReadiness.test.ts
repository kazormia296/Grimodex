import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  listen: vi.fn(),
  listenReady: vi.fn(),
  release: vi.fn(),
  unlisten: vi.fn(),
  unlistenReady: vi.fn(),
  notifyReady: undefined as ((projectId: string) => void) | undefined,
}));
vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesInvalidations: h.listen,
  listenRelatedScenesIndexReady: h.listenReady,
  releaseRelatedScenes: h.release,
}));
import { createNir1RelatedScenesSession } from "./nir1RelatedScenesSession";

beforeEach(() => {
  vi.clearAllMocks();
  h.notifyReady = undefined;
  h.listen.mockResolvedValue(h.unlisten);
  h.listenReady.mockImplementation(
    async (callback: (projectId: string) => void) => {
      h.notifyReady = callback;
      return h.unlistenReady;
    },
  );
  h.release.mockResolvedValue({ status: "released" });
});

describe("NIR1 Raw availability and future Index readiness", () => {
  it("waits for both event registrations before the query can begin", async () => {
    let resolveReady: ((unlisten: () => void) => void) | undefined;
    h.listenReady.mockReturnValueOnce(
      new Promise<() => void>((resolve) => {
        resolveReady = resolve;
      }),
    );
    const session = createNir1RelatedScenesSession("p1");
    let connected = false;
    const pending = session.connect().then((value) => {
      connected = value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(connected).toBe(false);
    resolveReady!(h.unlistenReady);
    await pending;
    expect(connected).toBe(true);
    session.release();
    expect(h.unlisten).toHaveBeenCalledOnce();
    expect(h.unlistenReady).toHaveBeenCalledOnce();
  });

  it("remembers matching readiness received while begin is in flight and replays it after Raw unavailable publication", async () => {
    const session = createNir1RelatedScenesSession("p1");
    await session.connect();
    h.notifyReady!("other-project");
    expect(session.readinessRevision).toBe(0);
    h.notifyReady!("p1");
    expect(session.bind("raw-unavailable-query", null)).toBe(true);
    session.completeFetch();
    const ready = vi.fn();
    session.subscribeIndexReady(ready);
    expect(ready).toHaveBeenCalledExactlyOnceWith(1);
    expect(session.isActive()).toBe(true);
    expect(session.retain()).toBeNull();
    session.release();
  });

  it("keeps readiness listening while Raw-only results are visible", async () => {
    const session = createNir1RelatedScenesSession("p1");
    await session.connect();
    session.bind("raw-unavailable-query", null);
    session.completeFetch();
    const ready = vi.fn();
    session.subscribeIndexReady(ready);
    expect(ready).not.toHaveBeenCalled();
    h.notifyReady!("p1");
    expect(ready).toHaveBeenCalledExactlyOnceWith(1);
    h.notifyReady!("other-project");
    expect(ready).toHaveBeenCalledOnce();
    expect(h.unlistenReady).not.toHaveBeenCalled();
    session.release();
    h.notifyReady!("p1");
    expect(ready).toHaveBeenCalledOnce();
  });

  it("releases a timed-out operation but preserves readiness for a new generation", async () => {
    const session = createNir1RelatedScenesSession("p1");
    await session.connect();
    session.bind("timed-out-query", "ticket");
    session.completeFetch();
    session.releaseOperation();
    session.releaseOperation();
    expect(h.release).toHaveBeenCalledExactlyOnceWith("ticket");
    expect(session.retain()).toBeNull();
    expect(session.isActive()).toBe(true);
    const ready = vi.fn();
    session.subscribeIndexReady(ready);
    h.notifyReady!("p1");
    expect(ready).toHaveBeenCalledExactlyOnceWith(1);
    session.release();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("cleans up a partially registered listener when readiness registration fails", async () => {
    h.listenReady.mockRejectedValueOnce(new Error("unavailable"));
    const session = createNir1RelatedScenesSession("p1");
    expect(await session.connect()).toBe(false);
    expect(session.stopReason).toBe("listener-unavailable");
    expect(h.unlisten).toHaveBeenCalledOnce();
    session.release();
  });
});
