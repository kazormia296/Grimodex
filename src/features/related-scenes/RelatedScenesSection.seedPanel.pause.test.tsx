// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

// pin の後の一時停止と再開（DR-SEEDSUG-3・8）：pin の通知が重なっても、hook は
// 必ず再開し、begin は 1 回だけ増える。panel は通知を取り出すだけの mock。
const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  onPinned: null as null | ((sceneId: string) => void),
  arm: null as null | (() => void),
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
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => null),
}));
vi.mock("./Nir1GraphSeedPanel", () => ({
  default: ({ onPinned }: { onPinned: (sceneId: string) => void }) => {
    h.onPinned = onPinned;
    return null;
  },
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

// A later sibling: its passive effect runs after the section's, i.e. after the
// resume was queued and before it renders.
function LatePin({ armed }: { readonly armed: boolean }) {
  useEffect(() => {
    if (armed) h.onPinned?.("current");
  }, [armed]);
  return null;
}

function Harness() {
  const [armed, setArmed] = useState(false);
  h.arm = () => setArmed(true);
  return (
    <>
      <RelatedScenesSection />
      <LatePin armed={armed} />
    </>
  );
}

async function settle() {
  for (const ms of [0, 400, 0, 0, 0]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.onPinned = null;
  h.fetch.mockResolvedValue(rawFetch());
  useTreeStore.setState({ activeSceneId: "current", nodes: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RelatedScenesSection pause after a seed pin", () => {
  it("resumes once and begins once more for two pins in one act", async () => {
    render(<RelatedScenesSection />);
    await settle();
    await vi.waitFor(() => expect(h.onPinned).not.toBeNull());
    expect(h.fetch).toHaveBeenCalledTimes(1);

    act(() => {
      h.onPinned!("current");
      h.onPinned!("current");
    });
    await settle();
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("still resumes when a pin arrives after the resume was queued, before it rendered", async () => {
    render(<Harness />);
    await settle();
    await vi.waitFor(() => expect(h.onPinned).not.toBeNull());
    expect(h.fetch).toHaveBeenCalledTimes(1);

    act(() => {
      h.onPinned!("current");
      h.arm!();
    });
    await settle();
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});
