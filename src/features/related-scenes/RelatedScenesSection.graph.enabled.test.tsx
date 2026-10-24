// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { useDebugLogStore } from "@/lib/debugLog";
import { useProjectStore } from "@/features/project/projectStore";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./fetchRelatedScenes", () => ({ fetchRelatedPastScenes: h.fetch }));
vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesIndexReady: vi.fn(async () => () => {}),
  listenRelatedScenesGraphReady: vi.fn(async () => () => {}),
  qualifyNir1Evidence: vi.fn(),
}));
vi.mock("./nir1GraphAvailability", () => ({
  NIR1_GRAPH_UI_ENABLED: false,
  isNir1GraphUiEnabled: () => true,
}));
// The real `PROFILE_ACTIVATION_UI_ENABLED` (false): the guidance module must
// never be requested (DA-2 ST3, DR-DA2-33).
const guidanceRequests = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/features/profile-egress/ProfileActivationGuidance", () => {
  guidanceRequests.count += 1;
  return { default: () => <p data-testid="profile-activation-guidance" /> };
});
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => "seed"),
}));
vi.mock("./nir1GraphFusion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nir1GraphFusion")>();
  return {
    fuseNir1RelatedScenesGraph: vi.fn(actual.fuseNir1RelatedScenesGraph),
  };
});
import { fuseNir1RelatedScenesGraph } from "./nir1GraphFusion";
import { RelatedScenesSection } from "./RelatedScenesSection";

function graphFetch(rawIds: string[]): Nir1RelatedScenesFetchResult {
  return {
    status: "completed",
    rawStatus: "completed",
    origin: null,
    queryBinding: "qb",
    initialSnapshot: null,
    completion: null,
    rawScenes: [],
    result: {
      kind: "raw",
      scenes: rawIds.map((id) => ({
        sceneId: id,
        sceneTitle: `Raw ${id}`,
        chunkText: `Raw ${id} text`,
        score: 0.9,
      })),
      ir: { status: "empty" },
    },
    graphOutcome: "graph-ready",
    graph: {
      queryBinding: "qb",
      pathAttachments: [],
      graphOnly: {
        sceneId: "g",
        sceneTitle: "Graph only title",
        excerpt: "Graph only excerpt",
        canonicalRange: { start: 0, end: 18 },
        navigationIdentity: "nav",
        path: {
          hop: 1,
          pinEntityId: "p",
          edges: [
            {
              relationType: "knows",
              directionality: "directed",
              from: { entityId: "s", label: "S" },
              to: { entityId: "p", label: "P" },
              evidence: [],
            },
          ],
        },
      },
    },
    session: null,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
  };
}

async function settle() {
  for (const ms of [0, 400, 0, 0]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useProjectStore.setState({ currentProjectId: "p" });
  useDebugLogStore.getState().clear();
  useTreeStore.setState({ activeSceneId: "current", nodes: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RelatedScenesSection with the Graph UI on (mocked availability)", () => {
  it("passes the seed and shows the Graph-only row from the lazy view, even when R and IR are empty", async () => {
    h.fetch.mockResolvedValue(graphFetch([]));
    render(<RelatedScenesSection />);
    await settle();
    await vi.waitFor(() =>
      expect(screen.getByText("Graph only title")).toBeTruthy(),
    );
    expect(h.fetch.mock.calls[0][1].graphSeedEntityId).toBe("seed");
    expect(
      screen
        .getAllByTestId("related-scene-row")
        .map((row) => row.getAttribute("data-related-scene-id")),
    ).toEqual(["g"]);
    expect(screen.queryByText("関連するシーンが見つかりません")).toBeNull();
  });

  it("shows no profile-not-restricted guidance while the activation UI constant is off (DA-2 ST3)", async () => {
    h.fetch.mockResolvedValue({
      ...graphFetch(["a"]),
      graphOutcome: "graph-unavailable:profile-not-restricted",
      graph: undefined,
    });
    render(<RelatedScenesSection />);
    await settle();
    await vi.waitFor(() => expect(screen.getByText("Raw a")).toBeTruthy());
    expect(screen.queryByTestId("profile-activation-guidance")).toBeNull();
    expect(guidanceRequests.count).toBe(0);
  });

  it("keeps the Graph-only row while the active Scene moves to it before the fetch resets (F3)", async () => {
    h.fetch.mockResolvedValue({
      ...graphFetch(["a"]),
      origin: {
        workspacePath: "/w",
        openRevision: 1,
        projectId: "p",
        querySceneId: "current",
        queryGeneration: 1,
      },
    });
    render(<RelatedScenesSection />);
    await settle();
    await vi.waitFor(() =>
      expect(screen.getByText("Graph only title")).toBeTruthy(),
    );
    const fuse = vi.mocked(fuseNir1RelatedScenesGraph);
    expect(fuse).toHaveBeenCalled();
    fuse.mockClear();
    // An accepted Graph-only click: the active Scene becomes the target while
    // the shown fetch still belongs to the query of "current".
    // Every render of that window fuses with the query's own Scene (the memo
    // is not even recomputed), so the row is never judged "the query Scene".
    act(() => useTreeStore.setState({ activeSceneId: "g" }));
    for (const [input] of fuse.mock.calls)
      expect(input.querySceneId).toBe("current");
    for (const result of fuse.mock.results)
      expect(
        (
          result.value as ReturnType<typeof fuseNir1RelatedScenesGraph>
        ).rows.map((row) => row.sceneId),
      ).toEqual(["a", "g"]);
    expect(
      useDebugLogStore
        .getState()
        .entries.filter((entry) => entry.tag === "related-scenes"),
    ).toEqual([]);
  });
});
