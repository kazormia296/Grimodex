// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { useDebugLogStore } from "@/lib/debugLog";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

// 起点の panel の chunk が失敗しても、Raw の行は残る（DR-SEEDSUG-1）。
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
vi.mock("./Nir1GraphSeedPanel", () => {
  throw new Error("chunk failed: seed panel");
});
import { RelatedScenesSection } from "./RelatedScenesSection";

const rawFetch = (): Nir1RelatedScenesFetchResult => ({
  status: "completed",
  rawStatus: "completed",
  origin: {
    workspacePath: "/w",
    openRevision: 1,
    projectId: "p",
    querySceneId: "current",
    queryGeneration: 1,
  },
  queryBinding: "qb",
  initialSnapshot: null,
  completion: null,
  rawScenes: [],
  result: {
    kind: "raw",
    scenes: [
      {
        sceneId: "a",
        sceneTitle: "Raw a",
        chunkText: "Raw a text",
        score: 0.9,
      },
    ],
    ir: { status: "empty" },
  },
  session: null,
  timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
});

beforeEach(() => {
  vi.useFakeTimers();
  useDebugLogStore.getState().clear();
  useTreeStore.setState({ activeSceneId: "current", nodes: [] } as never);
  h.fetch.mockResolvedValue(rawFetch());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RelatedScenesSection when the seed panel chunk fails", () => {
  it("keeps the Raw rows and logs a fixed message only", async () => {
    // React reports the error the boundary caught through console.error.
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
          .entries.some(
            (entry) => entry.message === "graph seed panel unavailable",
          ),
      ).toBe(true),
    );
    expect(
      screen
        .getAllByTestId("related-scene-row")
        .map((row) => row.getAttribute("data-related-scene-id")),
    ).toEqual(["a"]);
    expect(screen.queryByTestId("nir1-graph-seed-candidates")).toBeNull();
    expect(JSON.stringify(useDebugLogStore.getState().entries)).not.toContain(
      "chunk failed",
    );
    consoleError.mockRestore();
  });
});
