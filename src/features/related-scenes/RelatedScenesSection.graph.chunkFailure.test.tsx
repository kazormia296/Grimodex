// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { useDebugLogStore } from "@/lib/debugLog";
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
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => null),
}));
// The chunk fetch fails (DR-CB3-35 hand-over (1), D10).
vi.mock("./Nir1GraphRelatedScenes", () => {
  throw new Error("chunk failed: Graph only title");
});
import { RelatedScenesSection } from "./RelatedScenesSection";

const fetchResult = (): Nir1RelatedScenesFetchResult => ({
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
  graphOutcome: "graph-unavailable:restart-required",
  session: null,
  timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
});

beforeEach(() => {
  vi.useFakeTimers();
  useDebugLogStore.getState().clear();
  useTreeStore.setState({ activeSceneId: "current", nodes: [] } as never);
  h.fetch.mockResolvedValue(fetchResult());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RelatedScenesSection when the Graph chunk fails", () => {
  it("a failed Graph chunk falls back to the R/R+IR rows", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    render(<RelatedScenesSection />);
    for (const ms of [0, 400, 0, 0, 0]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }
    await vi.waitFor(() =>
      expect(
        useDebugLogStore
          .getState()
          .entries.some((entry) => entry.message === "graph view unavailable"),
      ).toBe(true),
    );
    expect(
      screen
        .getAllByTestId("related-scene-row")
        .map((row) => row.getAttribute("data-related-scene-id")),
    ).toEqual(["a"]);
    expect(screen.queryByTestId("nir1-graph-restart-required")).toBeNull();
    expect(JSON.stringify(useDebugLogStore.getState().entries)).not.toContain(
      "Graph only title",
    );
    consoleError.mockRestore();
  });
});
