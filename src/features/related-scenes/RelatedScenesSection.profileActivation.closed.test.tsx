// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { useDebugLogStore } from "@/lib/debugLog";
import { useProjectStore } from "@/features/project/projectStore";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

// The Graph UI on (mocked) and the real `PROFILE_ACTIVATION_UI_ENABLED`
// (false): `profile-not-restricted` must not request the Graph chunk at all
// (DA-2 ST3 R3-4 (B), DR-DA2-33). The pass-through mock counts the requests.
const h = vi.hoisted(() => ({ fetch: vi.fn(), graphRequests: 0 }));
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
vi.mock("./Nir1GraphRelatedScenes", async (importOriginal) => {
  h.graphRequests += 1;
  return importOriginal();
});
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => "seed"),
}));
import { PROFILE_ACTIVATION_UI_ENABLED } from "@/features/profile-egress/profileActivationAvailability";
import { RelatedScenesSection } from "./RelatedScenesSection";

function rawFetch(
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
          sceneTitle: "Raw a",
          chunkText: "Raw a text",
          score: 0.9,
        },
      ],
      ir: { status: "empty" },
    },
    graphOutcome,
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

describe("RelatedScenesSection with the Graph UI on and the activation UI closed", () => {
  it("never requests the Graph chunk for profile-not-restricted, and does for restart-required", async () => {
    expect(PROFILE_ACTIVATION_UI_ENABLED).toBe(false);
    h.fetch.mockResolvedValue(
      rawFetch("graph-unavailable:profile-not-restricted"),
    );
    render(<RelatedScenesSection />);
    await settle();
    await vi.waitFor(() => expect(screen.getByText("Raw a")).toBeTruthy());
    await settle();
    expect(h.graphRequests).toBe(0);
    expect(screen.queryByTestId("profile-activation-guidance")).toBeNull();
    cleanup();

    // The control: the same count sees the Graph chunk's request.
    h.fetch.mockResolvedValue(rawFetch("graph-unavailable:restart-required"));
    render(<RelatedScenesSection />);
    await settle();
    await vi.waitFor(() =>
      expect(screen.getByTestId("nir1-graph-restart-required")).toBeTruthy(),
    );
    expect(h.graphRequests).toBe(1);
  });
});
