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
// Both constants overridden (DA-2 ST3, DR-DA2-33): the guidance is the
// profile-egress chunk's own component, with its IPC wrapper mocked.
vi.mock("@/features/profile-egress/profileActivationAvailability", () => ({
  PROFILE_ACTIVATION_UI_ENABLED: true,
}));
const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: vi.fn(),
  onProfileEgressStatus: vi.fn(() => () => undefined),
  requestProfileActivation: request,
}));
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => "seed"),
}));
vi.mock("./nir1GraphFusion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nir1GraphFusion")>();
  return {
    fuseNir1RelatedScenesGraph: vi.fn(actual.fuseNir1RelatedScenesGraph),
  };
});
import { RelatedScenesSection } from "./RelatedScenesSection";
import { PROFILE_EGRESS_TRANSLATIONS } from "@/features/profile-egress/profileEgressTranslations";

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

describe("RelatedScenesSection with the Graph and the activation UI on (mocked availability)", () => {
  it("shows the profile-not-restricted guidance with the request in the Graph view's status slot, above the base rows", async () => {
    request.mockResolvedValue({ status: "not-activated" });
    h.fetch.mockResolvedValue({
      ...graphFetch(["a"]),
      graphOutcome: "graph-unavailable:profile-not-restricted",
      graph: undefined,
    });
    render(<RelatedScenesSection />);
    await settle();
    const guidance = await vi.waitFor(() =>
      screen.getByTestId("profile-activation-guidance"),
    );
    expect(guidance).toHaveTextContent(
      PROFILE_EGRESS_TRANSLATIONS.ja.guidance.graphNeedsRestriction,
    );
    expect(screen.getByText("Raw a")).toBeTruthy();
    expect(screen.queryByText("Graph only title")).toBeNull();
    expect(
      guidance.compareDocumentPosition(screen.getByText("Raw a")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("profile-activation-request"));
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("shows no guidance for any other Graph outcome", async () => {
    h.fetch.mockResolvedValue({
      ...graphFetch(["a"]),
      graphOutcome: "graph-unavailable:not-activated",
      graph: undefined,
    });
    render(<RelatedScenesSection />);
    await settle();
    await vi.waitFor(() => expect(screen.getByText("Raw a")).toBeTruthy());
    expect(screen.queryByTestId("profile-activation-guidance")).toBeNull();
  });
});
