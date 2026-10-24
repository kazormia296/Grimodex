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
});
