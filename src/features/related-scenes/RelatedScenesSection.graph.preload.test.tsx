// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";

const h = vi.hoisted(() => ({
  enabled: { value: false },
  graphLoaded: { value: 0 },
  seedPanelLoaded: { value: 0 },
  fetch: vi.fn(),
}));
vi.mock("./fetchRelatedScenes", () => ({ fetchRelatedPastScenes: h.fetch }));
vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesIndexReady: vi.fn(async () => () => {}),
  listenRelatedScenesGraphReady: vi.fn(async () => () => {}),
  qualifyNir1Evidence: vi.fn(),
}));
vi.mock("./nir1GraphAvailability", () => ({
  NIR1_GRAPH_UI_ENABLED: false,
  isNir1GraphUiEnabled: () => h.enabled.value,
}));
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => null),
}));
// Pass-through mocks that only count how often each lazy chunk is requested.
vi.mock("./Nir1GraphRelatedScenes", async (importOriginal) => {
  h.graphLoaded.value += 1;
  return importOriginal();
});
vi.mock("./Nir1GraphSeedPanel", async (importOriginal) => {
  h.seedPanelLoaded.value += 1;
  return importOriginal();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.graphLoaded.value = 0;
  h.seedPanelLoaded.value = 0;
  h.fetch.mockReturnValue(new Promise(() => {}));
  useTreeStore.setState({ activeSceneId: "current", nodes: [] } as never);
});
afterEach(() => {
  cleanup();
});

// The mock factories run once per file, so each case resets the module cache
// and loads the section afresh: the counts do not depend on the run order.
async function mountSection() {
  vi.resetModules();
  h.graphLoaded.value = 0;
  h.seedPanelLoaded.value = 0;
  const { RelatedScenesSection } = await import("./RelatedScenesSection");
  render(<RelatedScenesSection />);
}

describe("RelatedScenesSection preloads the Graph chunks (DR-PUBG-37-1)", () => {
  it("does not request the Graph chunks at mount while the constant is false", async () => {
    h.enabled.value = false;
    await mountSection();
    await act(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.graphLoaded.value).toBe(0);
    expect(h.seedPanelLoaded.value).toBe(0);
  });

  it("requests the Graph and seed panel chunks at mount while the constant is true", async () => {
    h.enabled.value = true;
    await mountSection();
    await vi.waitFor(() => {
      expect(h.graphLoaded.value).toBe(1);
      expect(h.seedPanelLoaded.value).toBe(1);
    });
  });
});
