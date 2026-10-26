// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";

const h = vi.hoisted(() => ({
  tree: { activeSceneId: "s2", nodes: [] },
  fetch: vi.fn(),
  graphReady: undefined as ((projectId: string) => void) | undefined,
  unlistenGraph: vi.fn(),
  listenGraph: vi.fn(),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (select: (state: typeof h.tree) => unknown) => select(h.tree),
}));
vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: (select: (state: unknown) => unknown) =>
    select({ resolutionMode: "reading" }),
}));
vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: (select: (state: unknown) => unknown) =>
    select({ currentProjectId: "p" }),
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (select: (state: unknown) => unknown) =>
    select({ activeWorkspacePath: "/workspace", workspaceOpenRevision: 1 }),
}));
vi.mock("./fetchRelatedScenes", () => ({ fetchRelatedPastScenes: h.fetch }));
vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesIndexReady: vi.fn(async () => () => {}),
  listenRelatedScenesGraphReady: h.listenGraph,
}));
vi.mock("./nir1EvidenceNavigation", () => ({
  observeNir1RelatedScenesQuery: vi.fn(),
}));
import { useNir1RelatedScenes } from "./useNir1RelatedScenes";

function result(timeout: boolean): Nir1RelatedScenesFetchResult {
  return {
    status: "completed",
    rawStatus: "completed",
    origin: null,
    queryBinding: "query",
    initialSnapshot: null,
    completion: null,
    rawScenes: [],
    result: {
      kind: "raw",
      scenes: [],
      ir: timeout
        ? { status: "unavailable", reason: "timeout" }
        : { status: "empty" },
    },
    session: null,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 12 },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.tree.activeSceneId = "s2";
  h.graphReady = undefined;
  h.listenGraph.mockImplementation(
    async (receive: (projectId: string) => void) => {
      h.graphReady = receive;
      return h.unlistenGraph;
    },
  );
  // A failed test must not leave a queued `mockImplementationOnce` behind.
  h.fetch.mockReset();
  h.fetch.mockResolvedValue(result(false));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

type Observer = (reason: string) => void;
function session() {
  const observers = new Set<Observer>();
  const value = {
    release: vi.fn(),
    subscribeInvalidation: vi.fn((observer: Observer) => {
      observers.add(observer);
      return () => observers.delete(observer);
    }),
  };
  return {
    session: value as unknown as Nir1RelatedScenesSession,
    release: value.release,
    invalidate: () =>
      [...observers].forEach((observer) => observer("invalidated")),
    observers,
  };
}
function late(owned: ReturnType<typeof session>): Nir1RelatedScenesFetchResult {
  return {
    ...result(false),
    graphOutcome: "graph-late",
    session: owned.session,
  };
}
function pending() {
  let finish!: (value: Nir1RelatedScenesFetchResult) => void;
  h.fetch.mockImplementationOnce(
    () =>
      new Promise<Nir1RelatedScenesFetchResult>((resolve) => {
        finish = resolve;
      }),
  );
  return (value: Nir1RelatedScenesFetchResult) =>
    act(async () => {
      finish(value);
    });
}
const ready = (projectId: string) =>
  act(async () => {
    h.graphReady?.(projectId);
  });

describe("Related Scenes graph-ready refresh keeps the shown list (RS-JOIN, DR-RSJ-6)", () => {
  it("keeps the shown result and its session while the refresh runs, and starts it at once", async () => {
    const parent = session();
    const child = session();
    const parentValue = late(parent);
    h.fetch.mockResolvedValueOnce(parentValue);
    const finishChild = pending();
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(view.result.current.fetch).toBe(parentValue);
    await ready("p");
    await advance(0);
    // No 400 ms debounce, and no "loading" in between: the list stays.
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(view.result.current.fetch).toBe(parentValue);
    expect(view.result.current.loading).toBe(true);
    expect(parent.release).not.toHaveBeenCalled();
    // The kept result is still watched for its own invalidation.
    expect(parent.observers.size).toBe(1);
    const childValue = {
      ...result(false),
      graphOutcome: "graph-ready" as const,
      session: child.session,
    };
    await finishChild(childValue);
    expect(view.result.current.fetch).toBe(childValue);
    expect(parent.release).toHaveBeenCalledTimes(1);
    expect(parent.observers.size).toBe(0);
    expect(child.release).not.toHaveBeenCalled();
    view.unmount();
    expect(child.release).toHaveBeenCalledTimes(1);
  });

  it("withdraws the kept result when its session is invalidated during the refresh", async () => {
    const parent = session();
    h.fetch.mockResolvedValueOnce(late(parent));
    const finishChild = pending();
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await advance(0);
    expect(view.result.current.fetch).not.toBeNull();
    await act(async () => {
      parent.invalidate();
    });
    expect(view.result.current.fetch).toBeNull();
    expect(parent.release).toHaveBeenCalledTimes(1);
    const childValue = result(false);
    await finishChild(childValue);
    expect(view.result.current.fetch).toBe(childValue);
    expect(parent.release).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "cancelled"] as const)(
    "drops the kept result when the refresh ends %s",
    async (status) => {
      const parent = session();
      h.fetch.mockResolvedValueOnce(late(parent));
      const finishChild = pending();
      const view = renderHook(() => useNir1RelatedScenes(true));
      await advance(0);
      await advance(400);
      await ready("p");
      await advance(0);
      await finishChild({ ...result(false), status });
      expect(view.result.current.fetch).toBeNull();
      expect(parent.release).toHaveBeenCalledTimes(1);
    },
  );

  it("drops the kept result when the refresh rejects", async () => {
    const parent = session();
    h.fetch.mockResolvedValueOnce(late(parent));
    let fail!: (error: Error) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise<Nir1RelatedScenesFetchResult>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await advance(0);
    expect(view.result.current.fetch).not.toBeNull();
    await act(async () => {
      fail(new Error("transport"));
    });
    expect(view.result.current.fetch).toBeNull();
    expect(parent.release).toHaveBeenCalledTimes(1);
    expect(parent.observers.size).toBe(0);
  });

  it("keeps the child's list without a Graph and refreshes again only on a new notice, debounced (P2-A)", async () => {
    const first = session();
    const second = session();
    const third = session();
    h.fetch
      .mockResolvedValueOnce(late(first))
      .mockResolvedValueOnce(late(second))
      .mockResolvedValueOnce(late(third));
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await advance(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    // The child came back graph-late: its list stays, nothing else is asked.
    expect(view.result.current.fetch?.session).toBe(second.session);
    await advance(2000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    // A notice for the refreshed generation: kept, but the debounce stays.
    await ready("p");
    await advance(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(view.result.current.fetch?.session).toBe(second.session);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(view.result.current.fetch?.session).toBe(third.session);
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  it("does not keep the list when the tree changes with the notice", async () => {
    const parent = session();
    h.fetch.mockResolvedValueOnce(late(parent));
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await act(async () => {
      h.graphReady?.("p");
      h.tree.nodes = [];
      view.rerender();
    });
    // A changed query is a normal start: "loading", and the debounce.
    expect(view.result.current.fetch).toBeNull();
    expect(parent.release).toHaveBeenCalledTimes(1);
    await advance(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("releases the kept result on unmount during the refresh", async () => {
    const parent = session();
    const child = session();
    h.fetch.mockResolvedValueOnce(late(parent));
    const finishChild = pending();
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await advance(0);
    view.unmount();
    expect(parent.release).toHaveBeenCalledTimes(1);
    await finishChild({ ...result(false), session: child.session });
    expect(child.release).toHaveBeenCalledTimes(1);
  });
});
