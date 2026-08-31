import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LayoutState } from "@/features/layout/layoutTypes";
import type { LayoutStoreState } from "@/features/layout/layoutStore";

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn() },
}));
const { workspaceIdentity } = vi.hoisted(() => ({
  workspaceIdentity: vi.fn(() => ({ path: "/workspace/novel.gdx", openRevision: 1 })),
}));
vi.mock("@/runtime/workspaceIdentity", () => ({
  getCurrentWorkspaceIdentity: workspaceIdentity,
}));
vi.mock("./snapshots", () => ({ recordLayoutSnapshot: vi.fn() }));
vi.mock("./recorder", () => ({ getRecorderChainHead: vi.fn(() => 42) }));

import { useLayoutStore } from "@/features/layout/layoutStore";
import { recordLayoutSnapshot } from "./snapshots";
import { seedWorkspaceSnapshot } from "./seedSession";

const getState = vi.mocked(useLayoutStore.getState);
const rec = vi.mocked(recordLayoutSnapshot);

const SAMPLE: LayoutState = {
  regions: {
    left: { size: 280, slots: [] },
    right: { size: 0, slots: [] },
    bottom: { size: 0, slots: [] },
  },
  center: { editorOpen: true, segments: [] },
};

function mockLayout(over: Partial<LayoutStoreState>): void {
  getState.mockReturnValue({
    layout: SAMPLE,
    activePresetId: null,
    hiddenStripePanels: new Set(),
    ...over,
  } as unknown as LayoutStoreState);
}

beforeEach(() => {
  getState.mockReset();
  rec.mockReset();
});

describe("seedWorkspaceSnapshot", () => {
  it("records a layout/workspace snapshot anchored at the recorder chain head", async () => {
    mockLayout({
      activePresetId: "builtin:writing",
      hiddenStripePanels: new Set(["chat"]) as Set<never>,
    });
    await seedWorkspaceSnapshot("proj-1");
    expect(rec).toHaveBeenCalledTimes(1);
    const arg = rec.mock.calls[0][0];
    expect(arg.projectId).toBe("proj-1");
    expect(arg.expectedWorkspacePath).toBe("/workspace/novel.gdx");
    expect(arg.expectedAnchorSequence).toBe(42);
    const payload = arg.payload as unknown as Record<string, unknown>;
    expect(payload.layout).toEqual(SAMPLE);
    expect(payload.activePresetId).toBe("builtin:writing");
    expect(payload.hiddenStripePanels).toEqual(["chat"]);
  });

  it("omits empty optional fields", async () => {
    mockLayout({ activePresetId: null, hiddenStripePanels: new Set() });
    await seedWorkspaceSnapshot("p");
    const payload = rec.mock.calls[0][0].payload as unknown as Record<string, unknown>;
    expect("activePresetId" in payload).toBe(false);
    expect("hiddenStripePanels" in payload).toBe(false);
  });
});
