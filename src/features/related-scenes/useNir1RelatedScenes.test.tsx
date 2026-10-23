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

describe("Related Scenes timeout recovery", () => {
  it("retains completed Raw while a fresh, separately identified request recovers", async () => {
    const fallback = result(true);
    h.fetch.mockResolvedValueOnce(fallback);
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(view.result.current.fetch).toBe(fallback);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await advance(399);
    expect(view.result.current.fetch).toBe(fallback);
    await advance(1);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls[1][1].queryGeneration).not.toBe(
      h.fetch.mock.calls[0][1].queryGeneration,
    );
    expect(h.fetch.mock.calls[0][1].isCurrent()).toBe(false);
    await advance(2000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("stops after two retries and retains the final timeout fallback", async () => {
    const fallback = result(true);
    h.fetch.mockResolvedValue(fallback);
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(5000);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(view.result.current.fetch).toBe(fallback);
    expect(view.result.current.loading).toBe(false);
  });

  it("cancels a scheduled retry when the scene changes", async () => {
    h.fetch.mockResolvedValueOnce(result(true));
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    h.tree.activeSceneId = "s3";
    view.rerender();
    await advance(0);
    await advance(1000);
    expect(h.fetch.mock.calls.map(([scene]) => scene)).toEqual(["s2", "s3"]);
  });

  it("cancels a scheduled retry when the panel closes", async () => {
    h.fetch.mockResolvedValue(result(true));
    const view = renderHook(({ enabled }) => useNir1RelatedScenes(enabled), {
      initialProps: { enabled: true },
    });
    await advance(0);
    await advance(400);
    view.rerender({ enabled: false });
    await advance(2000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("releases the previous session before retry and the last session on unmount", async () => {
    const releaseFirst = vi.fn();
    const releaseLast = vi.fn();
    const session = (release: () => void) =>
      ({
        release,
        subscribeInvalidation: () => () => {},
      }) as unknown as Nir1RelatedScenesSession;
    h.fetch
      .mockResolvedValueOnce({
        ...result(true),
        session: session(releaseFirst),
      })
      .mockResolvedValueOnce({
        ...result(false),
        session: session(releaseLast),
      });
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(800);
    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(releaseLast).not.toHaveBeenCalled();
    view.unmount();
    expect(releaseLast).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "invalidated", "index-unavailable"] as const)(
    "does not retry %s without a new context or readiness event",
    async (reason) => {
      const value = result(true);
      h.fetch.mockResolvedValue({
        ...value,
        result: {
          kind: "raw",
          scenes: [],
          ir: { status: "unavailable", reason },
        },
      });
      renderHook(() => useNir1RelatedScenes(true));
      await advance(0);
      await advance(5000);
      expect(h.fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("Related Scenes graph-ready refresh (CP-3a)", () => {
  const withOutcome = (
    graphOutcome: Nir1RelatedScenesFetchResult["graphOutcome"],
  ): Nir1RelatedScenesFetchResult => ({ ...result(false), graphOutcome });
  const ready = (projectId: string) =>
    act(async () => {
      h.graphReady?.(projectId);
    });

  it.each([
    "graph-late",
    "graph-unavailable:warming",
    "graph-unavailable:stale",
    "graph-unavailable:busy",
  ] as const)(
    "refreshes the displayed query once on graph-ready after %s",
    async (outcome) => {
      h.fetch.mockResolvedValue(withOutcome(outcome));
      renderHook(() => useNir1RelatedScenes(true));
      await advance(0);
      await advance(400);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      await ready("p");
      await advance(400);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.fetch.mock.calls[1][1].queryGeneration).not.toBe(
        h.fetch.mock.calls[0][1].queryGeneration,
      );
    },
  );

  it("ignores a second graph-ready for the same generation", async () => {
    h.fetch.mockResolvedValueOnce(withOutcome("graph-late"));
    h.fetch.mockResolvedValue(result(false));
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await ready("p");
    await advance(400);
    await ready("p");
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("each new generation that awaits the Graph may refresh once", async () => {
    h.fetch.mockResolvedValue(withOutcome("graph-late"));
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready("p");
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await ready("p");
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["another project", "graph-late", "other"],
    ["graph-ready", "graph-ready", "p"],
    ["graph-unavailable:failed", "graph-unavailable:failed", "p"],
    ["graph-unavailable:not-activated", "graph-unavailable:not-activated", "p"],
    ["an unseeded fetch (no outcome)", undefined, "p"],
  ] as const)("does not refresh for %s", async (_name, outcome, project) => {
    h.fetch.mockResolvedValue(withOutcome(outcome));
    renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    await ready(project);
    await advance(1000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores graph-ready after the scene changed and unsubscribes on unmount", async () => {
    h.fetch.mockResolvedValue(withOutcome("graph-late"));
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    h.tree.activeSceneId = "s3";
    view.rerender();
    await advance(0);
    // The s3 query has not published yet: nothing awaits the Graph.
    await ready("p");
    await advance(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(h.unlistenGraph).toHaveBeenCalled();
  });

  it("keeps working when graph-ready registration fails", async () => {
    h.listenGraph.mockRejectedValue(new Error("no event bridge"));
    h.fetch.mockResolvedValue(withOutcome("graph-late"));
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(view.result.current.fetch).not.toBeNull();
  });
});
