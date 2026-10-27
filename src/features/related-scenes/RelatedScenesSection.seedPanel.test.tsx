// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { useProjectStore } from "@/features/project/projectStore";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

// 起点の候補から pin した後、Related Scenes がその seed で問い合わせ直す
// （DR-SEEDSUG-3）。Graph UI は既存の Graph 有効の試験と同じく mock で on。
const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  pins: [] as string[],
  upsert: vi.fn(),
}));
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
// The pins of "current" as the seed rule sees them: the first one decides.
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => h.pins[0] ?? null),
}));
vi.mock("./nir1GraphSeedCandidates", () => ({
  readNir1GraphSeedEntryName: vi.fn(async (_project: string, id: string) =>
    id === "e-act" ? "ボブ" : null,
  ),
  selectNir1GraphSeedCandidates: vi.fn(async () => [
    { entryId: "e-act", name: "ボブ", reason: "beat-actor" },
  ]),
}));
vi.mock("@/features/codex/sceneCodexPinsApi", () => ({
  upsertScenePin: h.upsert,
}));
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
  h.pins = [];
  h.upsert.mockImplementation(async (_sceneId: string, entryId: string) => {
    h.pins.push(entryId);
  });
  h.fetch.mockResolvedValue(rawFetch());
  useProjectStore.setState({ currentProjectId: "p" });
  useTreeStore.setState({ activeSceneId: "current", nodes: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RelatedScenesSection seed candidates (Graph UI on, mocked)", () => {
  it("begins without a seed, pins only on the author's click, then begins again with that seed", async () => {
    render(<RelatedScenesSection />);
    await settle();
    await vi.waitFor(() => expect(screen.getByText("Raw a")).toBeTruthy());
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][1]).not.toHaveProperty("graphSeedEntityId");
    const button = await vi.waitFor(() =>
      screen.getByRole("button", { name: "ボブ を起点にする" }),
    );
    await settle();
    expect(h.upsert).not.toHaveBeenCalled();

    fireEvent.click(button);
    await settle();

    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledWith("current", "e-act");
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
    expect(h.fetch.mock.calls[1][0]).toBe("current");
    expect(h.fetch.mock.calls[1][1].graphSeedEntityId).toBe("e-act");
    await vi.waitFor(() =>
      expect(screen.getByTestId("nir1-graph-seed").textContent).toBe(
        "起点:ボブ",
      ),
    );
    expect(screen.queryByTestId("nir1-graph-seed-candidates")).toBeNull();
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps the query and the candidates when the pin fails", async () => {
    h.upsert.mockRejectedValueOnce(new Error("write failed"));
    render(<RelatedScenesSection />);
    await settle();
    fireEvent.click(
      await vi.waitFor(() =>
        screen.getByRole("button", { name: "ボブ を起点にする" }),
      ),
    );
    await settle();

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByTestId("nir1-graph-seed-candidates")).toBeTruthy();
    expect(screen.getByText("Raw a")).toBeTruthy();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("reads no seed and shows no panel while the section is not active (keepalive)", async () => {
    render(<RelatedScenesSection enabled={false} />);
    await settle();
    expect(screen.queryByTestId("nir1-graph-seed-candidates")).toBeNull();
    expect(screen.queryByTestId("nir1-graph-seed")).toBeNull();
  });

  it("shows no panel and reads nothing for a query without an origin or of another scene", async () => {
    const { selectNir1GraphSeedCandidates } =
      await import("./nir1GraphSeedCandidates");
    for (const origin of [
      null,
      { ...rawFetch().origin!, querySceneId: "other" },
    ]) {
      vi.clearAllMocks();
      h.fetch.mockResolvedValue({ ...rawFetch(), origin });
      render(<RelatedScenesSection />);
      await settle();
      await vi.waitFor(() => expect(screen.getByText("Raw a")).toBeTruthy());
      await settle();
      expect(screen.queryByTestId("nir1-graph-seed-candidates")).toBeNull();
      expect(selectNir1GraphSeedCandidates).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
