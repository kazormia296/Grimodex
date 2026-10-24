// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";
import { notifyNir1GraphOnlyRevoked } from "./nir1GraphOnlyRevocation";

// R-1 (D8-b, DR-CP3B-9): a revoke in this window drops the shown Graph-only
// row of that Scene and queries once more.
const h = vi.hoisted(() => ({
  tree: { activeSceneId: "s2", nodes: [] },
  fetch: vi.fn(),
  enabled: true,
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
  listenRelatedScenesGraphReady: vi.fn(async () => () => {}),
}));
vi.mock("./nir1EvidenceNavigation", () => ({
  observeNir1RelatedScenesQuery: vi.fn(),
}));
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => "seed"),
}));
// Each listener the hook subscribes is wrapped, to see whether it still runs.
const listenerCalls = vi.hoisted(() => vi.fn());
vi.mock("./nir1GraphOnlyRevocation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./nir1GraphOnlyRevocation")>();
  return {
    ...actual,
    subscribeNir1GraphOnlyRevocation: (listener: (sceneId: string) => void) =>
      actual.subscribeNir1GraphOnlyRevocation((sceneId) => {
        listenerCalls(sceneId);
        listener(sceneId);
      }),
  };
});
vi.mock("./nir1GraphAvailability", () => ({
  NIR1_GRAPH_UI_ENABLED: false,
  isNir1GraphUiEnabled: () => h.enabled,
}));
import { useNir1RelatedScenes } from "./useNir1RelatedScenes";

function withGraphOnly(sceneId: string | null): Nir1RelatedScenesFetchResult {
  return {
    status: "completed",
    rawStatus: "completed",
    origin: null,
    queryBinding: "qb",
    initialSnapshot: null,
    completion: null,
    rawScenes: [],
    result: { kind: "raw", scenes: [], ir: { status: "empty" } },
    graphOutcome: "graph-ready",
    graph: {
      queryBinding: "qb",
      pathAttachments: [],
      graphOnly: sceneId
        ? {
            sceneId,
            sceneTitle: "t",
            excerpt: "e",
            canonicalRange: { start: 0, end: 1 },
            navigationIdentity: "nav",
            path: { hop: 1, pinEntityId: "p", edges: [] },
          }
        : null,
    },
    session: null,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.enabled = true;
  h.fetch.mockResolvedValue(withGraphOnly("g"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("Graph-only revocation notice", () => {
  it("a revocation notice for the shown Graph-only scene hides the row and refreshes once", async () => {
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(view.result.current.fetch?.graph?.graphOnly?.sceneId).toBe("g");
    h.fetch.mockResolvedValue(withGraphOnly(null));
    act(() => {
      notifyNir1GraphOnlyRevoked("g");
      notifyNir1GraphOnlyRevoked("g");
    });
    expect(view.result.current.fetch).toBeNull();
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(view.result.current.fetch?.graph?.graphOnly).toBeNull();
    act(() => notifyNir1GraphOnlyRevoked("g"));
    await advance(1000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("a notice for another scene does nothing", async () => {
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    const shown = view.result.current.fetch;
    act(() => notifyNir1GraphOnlyRevoked("other"));
    await advance(1000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(view.result.current.fetch).toBe(shown);
  });

  it("is not subscribed while the Graph UI is off", async () => {
    h.enabled = false;
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    const shown = view.result.current.fetch;
    act(() => notifyNir1GraphOnlyRevoked("g"));
    await advance(1000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(view.result.current.fetch).toBe(shown);
  });

  it("unsubscribes on unmount: a later notice reaches no listener of the hook", async () => {
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    act(() => notifyNir1GraphOnlyRevoked("other"));
    expect(listenerCalls).toHaveBeenCalledOnce();
    view.unmount();
    listenerCalls.mockClear();
    act(() => notifyNir1GraphOnlyRevoked("g"));
    await advance(1000);
    expect(listenerCalls).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("two notices of one generation with a render between refresh once", async () => {
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    h.fetch.mockResolvedValue(withGraphOnly(null));
    act(() => notifyNir1GraphOnlyRevoked("g"));
    view.rerender();
    act(() => notifyNir1GraphOnlyRevoked("g"));
    await advance(400);
    await advance(1000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(view.result.current.fetch?.graph?.graphOnly).toBeNull();
  });

  it("a notice that comes while the fetch is in flight refreshes once after that result publishes (F4)", async () => {
    let resolve!: (value: Nir1RelatedScenesFetchResult) => void;
    h.fetch.mockReturnValueOnce(
      new Promise<Nir1RelatedScenesFetchResult>((done) => (resolve = done)),
    );
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(view.result.current.fetch).toBeNull();
    h.fetch.mockResolvedValue(withGraphOnly(null));
    act(() => {
      notifyNir1GraphOnlyRevoked("g");
      notifyNir1GraphOnlyRevoked("g");
    });
    await act(async () => resolve(withGraphOnly("g")));
    // The revoked row is hidden at once and queried once more.
    expect(view.result.current.fetch).toBeNull();
    await advance(400);
    await advance(1000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(view.result.current.fetch?.graph?.graphOnly).toBeNull();
  });

  it("a notice in flight for another Scene leaves the published row and queries no more", async () => {
    let resolve!: (value: Nir1RelatedScenesFetchResult) => void;
    h.fetch.mockReturnValueOnce(
      new Promise<Nir1RelatedScenesFetchResult>((done) => (resolve = done)),
    );
    const view = renderHook(() => useNir1RelatedScenes(true));
    await advance(0);
    await advance(400);
    act(() => notifyNir1GraphOnlyRevoked("other"));
    await act(async () => resolve(withGraphOnly("g")));
    await advance(1000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(view.result.current.fetch?.graph?.graphOnly?.sceneId).toBe("g");
  });
});
