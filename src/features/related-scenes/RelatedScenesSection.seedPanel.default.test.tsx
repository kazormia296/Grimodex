// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { useProjectStore } from "@/features/project/projectStore";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

// No mock of the availability module: the product default (Graph UI closed).
// The seed panel chunk must never be requested, and nothing reads a seed or a
// candidate or writes a pin (DR-SEEDSUG-1).
const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  panelRequested: { value: false },
  upsert: vi.fn(),
}));
vi.mock("./fetchRelatedScenes", () => ({ fetchRelatedPastScenes: h.fetch }));
vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesIndexReady: vi.fn(async () => () => {}),
  listenRelatedScenesGraphReady: vi.fn(async () => () => {}),
  qualifyNir1Evidence: vi.fn(),
}));
vi.mock("./Nir1GraphSeedPanel", async (importOriginal) => {
  h.panelRequested.value = true;
  return importOriginal();
});
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => {
    throw new Error("the default reads no pin");
  }),
}));
vi.mock("./nir1GraphSeedCandidates", () => ({
  readNir1GraphSeedEntryName: vi.fn(async () => {
    throw new Error("the default reads no seed name");
  }),
  selectNir1GraphSeedCandidates: vi.fn(async () => {
    throw new Error("the default reads no candidate");
  }),
}));
vi.mock("@/features/codex/sceneCodexPinsApi", () => ({
  upsertScenePin: h.upsert,
}));
import { NIR1_GRAPH_UI_ENABLED } from "./nir1GraphAvailability";
import { selectNir1GraphSeed } from "./nir1GraphSeed";
import {
  readNir1GraphSeedEntryName,
  selectNir1GraphSeedCandidates,
} from "./nir1GraphSeedCandidates";
import { RelatedScenesSection } from "./RelatedScenesSection";

const rawFetch = (): Nir1RelatedScenesFetchResult => ({
  status: "completed",
  rawStatus: "completed",
  // A shown query of the active Scene: only the gate keeps the panel out.
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
  vi.clearAllMocks();
  h.fetch.mockResolvedValue(rawFetch());
  useProjectStore.setState({ currentProjectId: "p" });
  useTreeStore.setState({ activeSceneId: "current", nodes: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RelatedScenesSection seed panel with the product default (Graph UI closed)", () => {
  it("never requests the panel, reads no seed or candidate, writes no pin and draws no seed UI", async () => {
    expect(NIR1_GRAPH_UI_ENABLED).toBe(false);
    render(<RelatedScenesSection />);
    for (const ms of [0, 400, 0, 0, 0]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }
    await vi.waitFor(() => expect(screen.getByText("Raw a")).toBeTruthy());

    expect(h.panelRequested.value).toBe(false);
    expect(selectNir1GraphSeed).not.toHaveBeenCalled();
    expect(readNir1GraphSeedEntryName).not.toHaveBeenCalled();
    expect(selectNir1GraphSeedCandidates).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(screen.queryByTestId("nir1-graph-seed")).toBeNull();
    expect(screen.queryByTestId("nir1-graph-seed-candidates")).toBeNull();
    expect(document.body.textContent).not.toMatch(/起点|Starting point/);
    // The closed product keeps its DOM: no focus target on the section body.
    const body = screen.getByText("Raw a").closest(".py-1");
    expect(body).not.toBeNull();
    expect(body!.hasAttribute("tabindex")).toBe(false);
    expect(document.querySelector("[tabindex]")).toBeNull();
  });
});
