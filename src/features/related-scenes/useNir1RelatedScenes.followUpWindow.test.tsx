// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";

// K6/4 の批准 12（DR-WF-3）：`graph-ready` を契機にした取り直しの世代（子）にだけ
// 契機の印を付けて fetch に渡す。ほかの契機（最初の query、debounce、index-ready、
// IR の timeout の再試行、Raw の取り直し）には付けない。

const h = vi.hoisted(() => ({
  tree: { activeSceneId: "s2", nodes: [] as unknown[] },
  fetch: vi.fn(),
  graphReady: undefined as ((projectId: string) => void) | undefined,
  indexReady: undefined as ((projectId: string) => void) | undefined,
  listenGraph: vi.fn(),
  listenIndex: vi.fn(),
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
  listenRelatedScenesIndexReady: h.listenIndex,
  listenRelatedScenesGraphReady: h.listenGraph,
}));
vi.mock("./nir1EvidenceNavigation", () => ({
  observeNir1RelatedScenesQuery: vi.fn(),
}));
import { useNir1RelatedScenes } from "./useNir1RelatedScenes";

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
    invalidate: () =>
      [...observers].forEach((observer) => observer("invalidated")),
  };
}

function result(
  overrides: Partial<Nir1RelatedScenesFetchResult> = {},
  timeout = false,
): Nir1RelatedScenesFetchResult {
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
    session: session().session,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 12 },
    ...overrides,
  };
}
const late = (overrides: Partial<Nir1RelatedScenesFetchResult> = {}) =>
  result({ graphOutcome: "graph-late", ...overrides });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.tree.activeSceneId = "s2";
  h.tree.nodes = [];
  h.graphReady = undefined;
  h.indexReady = undefined;
  h.listenGraph.mockImplementation(
    async (receive: (projectId: string) => void) => {
      h.graphReady = receive;
      return () => {};
    },
  );
  h.listenIndex.mockImplementation(
    async (receive: (projectId: string) => void) => {
      h.indexReady = receive;
      return () => {};
    },
  );
  h.fetch.mockReset();
  h.fetch.mockResolvedValue(result());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const ready = (projectId: string) =>
  act(async () => {
    h.graphReady?.(projectId);
  });
const triggerOf = (call: number) =>
  (h.fetch.mock.calls[call]?.[1] as { refreshTrigger?: string } | undefined)
    ?.refreshTrigger;

describe("Related Scenes の取り直しの契機の印（K6/4 の批准 12）", () => {
  it("graph-ready を契機にした子にだけ印を付け、子の結果で 1 回だけ置き換わる", async () => {
    const parent = late();
    const child = result({ graphOutcome: "graph-ready" });
    h.fetch.mockResolvedValueOnce(parent).mockResolvedValueOnce(child);
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(triggerOf(0)).toBeUndefined();
    expect(view.result.current.fetch).toBe(parent);
    await ready("p");
    await advance(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(triggerOf(1)).toBe("graph-ready");
    expect(view.result.current.fetch).toBe(child);
    await advance(2000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("fetch の間に来た graph-ready による子にも印を付ける", async () => {
    let finish!: (value: Nir1RelatedScenesFetchResult) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise<Nir1RelatedScenesFetchResult>((resolve) => {
          finish = resolve;
        }),
    );
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await act(async () => {
      finish(late());
    });
    await advance(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(triggerOf(0)).toBeUndefined();
    expect(triggerOf(1)).toBe("graph-ready");
  });

  it("graph-ready の連鎖（子がさらに graph-ready で取り直す）にも印を付ける", async () => {
    h.fetch
      .mockResolvedValueOnce(late())
      .mockResolvedValueOnce(late())
      .mockResolvedValueOnce(result({ graphOutcome: "graph-ready" }));
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await advance(0);
    expect(triggerOf(1)).toBe("graph-ready");
    await ready("p");
    // 連鎖は debounce を保つ（DR-RSJ-6）が、契機は graph-ready（DR-WF-3）。
    await advance(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(triggerOf(2)).toBe("graph-ready");
  });

  it("IR の timeout の再試行には印を付けない（子の再試行も）", async () => {
    h.fetch
      .mockResolvedValueOnce(late({}))
      .mockResolvedValueOnce(result({ graphOutcome: "graph-late" }, true))
      .mockResolvedValueOnce(result());
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await advance(0);
    expect(triggerOf(1)).toBe("graph-ready");
    // 子の IR が timeout：同じ effect の中の再試行は別の契機。
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(triggerOf(2)).toBeUndefined();
  });

  it("index-ready と、通知と同時の tree の変化には印を付けない", async () => {
    h.fetch.mockResolvedValue(late());
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await act(async () => {
      h.indexReady?.("p");
    });
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(triggerOf(1)).toBeUndefined();
    await act(async () => {
      h.graphReady?.("p");
      h.tree.nodes = [];
      view.rerender();
    });
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(triggerOf(2)).toBeUndefined();
  });

  it("子の結果の invalidation による Raw の取り直しには印を付けない", async () => {
    const owned = session();
    h.fetch
      .mockResolvedValueOnce(late())
      .mockResolvedValueOnce(result({ session: owned.session }))
      .mockResolvedValueOnce(result({ session: null }));
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await advance(0);
    expect(triggerOf(1)).toBe("graph-ready");
    await act(async () => {
      owned.invalidate();
    });
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.fetch.mock.calls[2][1]).toMatchObject({ rawOnly: true });
    expect(triggerOf(2)).toBeUndefined();
  });
});
