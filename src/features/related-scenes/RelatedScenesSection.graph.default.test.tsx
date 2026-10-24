// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

const h = vi.hoisted(() => ({
  graphModuleLoaded: { value: false },
  fetch: vi.fn(),
}));
vi.mock("./fetchRelatedScenes", () => ({ fetchRelatedPastScenes: h.fetch }));
vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesIndexReady: vi.fn(async () => () => {}),
  listenRelatedScenesGraphReady: vi.fn(async () => () => {}),
  qualifyNir1Evidence: vi.fn(),
}));
// No mock of the availability module: this is the product default. The Graph
// view is a lazy chunk (DR-CP3B-7). This pass-through mock only records
// whether the module was ever requested; with the default it must not be.
vi.mock("./Nir1GraphRelatedScenes", async (importOriginal) => {
  h.graphModuleLoaded.value = true;
  return importOriginal();
});
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => {
    throw new Error("the default reads no pin");
  }),
}));
import { selectNir1GraphSeed } from "./nir1GraphSeed";
import { RelatedScenesSection } from "./RelatedScenesSection";

function graphFetch(
  graphOutcome: Nir1RelatedScenesFetchResult["graphOutcome"],
): Nir1RelatedScenesFetchResult {
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
      scenes: [
        {
          sceneId: "a",
          sceneTitle: "Raw A",
          chunkText: "Raw A text",
          score: 0.9,
        },
      ],
      ir: { status: "empty" },
    },
    graphOutcome,
    graph:
      graphOutcome === "graph-ready"
        ? {
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
          }
        : undefined,
    session: null,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.graphModuleLoaded.value = false;
  useTreeStore.setState({ activeSceneId: "current", nodes: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RelatedScenesSection with the product default", () => {
  it("with the real default the Graph module is never requested and rows are unchanged", async () => {
    for (const outcome of [
      "graph-ready",
      "graph-unavailable:restart-required",
    ] as const) {
      h.fetch.mockResolvedValue(graphFetch(outcome));
      const view = render(<RelatedScenesSection />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const rows = screen.getAllByTestId("related-scene-row");
      expect(
        rows.map((row) => row.getAttribute("data-related-scene-id")),
      ).toEqual(["a"]);
      expect(screen.queryByText("Graph only title")).toBeNull();
      expect(screen.queryByTestId("nir1-graph-restart-required")).toBeNull();
      expect(screen.queryByTestId("nir1-graph-path")).toBeNull();
      view.unmount();
    }
    expect(h.graphModuleLoaded.value).toBe(false);
    expect(selectNir1GraphSeed).not.toHaveBeenCalled();
    for (const call of h.fetch.mock.calls)
      expect(call[1]).not.toHaveProperty("graphSeedEntityId");
  });
});
