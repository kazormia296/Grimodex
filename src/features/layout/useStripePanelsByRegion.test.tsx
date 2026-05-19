// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

import { useLayoutStore, type PanelId } from "./layoutStore";
import {
  DEFAULT_STRIPE_SIZES,
  DEFAULT_STRIPE_VISIBILITY,
} from "./toolWindowDefaults";
import { useStripePanelsByRegion } from "./useStripePanelsByRegion";

function resetStore() {
  useLayoutStore.setState({
    dockviewApi: null,
    toolWindows: {},
    undockedPanels: new Set(),
    stripePanelIds: new Set(),
    stripeSizes: { ...DEFAULT_STRIPE_SIZES },
    stripeVisibility: { ...DEFAULT_STRIPE_VISIBILITY },
  });
}

/**
 * Dockview API mock.
 * `panelGroups` で「どの panel が同じ group か」を指定する (group key で集約)。
 * `activeIdInGroup` で各 group の active tab を指定する。
 */
function makeApi(opts: {
  panelGroups?: Record<string, string>; // panel id → group key
  activeIdInGroup?: Record<string, string>; // group key → active panel id
}) {
  const { panelGroups = {}, activeIdInGroup = {} } = opts;
  const groups = new Map<string, { activePanel: { id: string } | null }>();

  // groups を一括で初期化
  for (const groupKey of Object.values(panelGroups)) {
    if (!groups.has(groupKey)) {
      const activeId = activeIdInGroup[groupKey];
      groups.set(groupKey, {
        activePanel: activeId ? { id: activeId } : null,
      });
    }
  }

  return {
    getPanel: vi.fn().mockImplementation((id: string) => {
      const groupKey = panelGroups[id];
      if (!groupKey) return undefined;
      const group = groups.get(groupKey);
      const panel = { id, group };
      // group.activePanel が { id: <id> } 形式なので、参照同一性じゃなく id 比較が必要
      // useStripePanelsByRegion 側で `panel.group?.activePanel === panel` を使うから
      // ここでは activePanel を実 panel object に置き換える
      if (group?.activePanel?.id === id) {
        group.activePanel = panel;
      }
      return panel;
    }),
    onDidAddPanel: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidRemovePanel: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidActivePanelChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidLayoutChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  };
}

describe("useStripePanelsByRegion", () => {
  beforeEach(() => {
    resetStore();
  });

  it("returns empty arrays when no panels are registered to stripe", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({}) as never,
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    expect(result.current).toEqual({ left: [], right: [], bottom: [] });
  });

  it("visible=true active=true when panel is the active tab in its group", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        panelGroups: { scenes: "g-left" },
        activeIdInGroup: { "g-left": "scenes" },
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes"]),
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    expect(result.current.left).toEqual([
      { id: "scenes", visible: true, active: true },
    ]);
  });

  it("visible=true active=false when panel is a background tab in its group", () => {
    // scenes と codex が同じ group、codex が active tab、scenes は裏 tab
    useLayoutStore.setState({
      dockviewApi: makeApi({
        panelGroups: { scenes: "g-left", codex: "g-left" },
        activeIdInGroup: { "g-left": "codex" },
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "codex"]),
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    // scenes は裏 tab → visible=true active=false
    expect(result.current.left).toContainEqual({
      id: "scenes",
      visible: true,
      active: false,
    });
    expect(result.current.left).toContainEqual({
      id: "codex",
      visible: true,
      active: true,
    });
  });

  it("visible=false active=false when panel is closed (stays in stripe)", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({}) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "command-center-results"]),
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    expect(result.current.left).toEqual([
      { id: "scenes", visible: false, active: false },
      { id: "command-center-results", visible: false, active: false },
    ]);
  });

  it("groups by slot region (default LB → left for command-center-results)", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({}) as never,
      stripePanelIds: new Set<PanelId>(["command-center-results"]),
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    expect(result.current.left).toContainEqual({
      id: "command-center-results",
      visible: false,
      active: false,
    });
    expect(result.current.right).toEqual([]);
  });

  it("respects user override slot", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({}) as never,
      stripePanelIds: new Set<PanelId>(["snippets"]),
      toolWindows: { snippets: { slot: "LT", viewMode: "docked-pinned" } },
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    expect(result.current.left).toEqual([
      { id: "snippets", visible: false, active: false },
    ]);
    expect(result.current.bottom).toEqual([]);
  });

  it("treats undocked panels as visible=false active=true (overlay layer)", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({}) as never,
      stripePanelIds: new Set<PanelId>(["chat"]),
      undockedPanels: new Set<PanelId>(["chat"]),
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    expect(result.current.right).toEqual([
      { id: "chat", visible: false, active: true },
    ]);
  });

  // Phase 2: slot field
  it("includes slot field in each StripePanel (default slot)", () => {
    // scenes デフォルト LT
    useLayoutStore.setState({
      dockviewApi: makeApi({}) as never,
      stripePanelIds: new Set<PanelId>(["scenes"]),
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    expect(result.current.left[0]).toMatchObject({ id: "scenes", slot: "LT" });
  });

  it("includes slot field reflecting toolWindows override", () => {
    // snippets デフォルト BR → LT にオーバーライド
    useLayoutStore.setState({
      dockviewApi: makeApi({}) as never,
      stripePanelIds: new Set<PanelId>(["snippets"]),
      toolWindows: { snippets: { slot: "LT", viewMode: "docked-pinned" } },
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    expect(result.current.left[0]).toMatchObject({
      id: "snippets",
      slot: "LT",
    });
  });

  it("skips editor id even if accidentally in stripePanelIds", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        panelGroups: { editor: "g-center", scenes: "g-left" },
        activeIdInGroup: { "g-center": "editor", "g-left": "scenes" },
      }) as never,
      stripePanelIds: new Set<PanelId>(["editor", "scenes"]),
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    const allIds = [
      ...result.current.left,
      ...result.current.right,
      ...result.current.bottom,
    ].map((p) => p.id);
    expect(allIds).not.toContain("editor");
    expect(allIds).toContain("scenes");
  });

  it("does NOT include panels that are visible but not registered to stripe", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        panelGroups: { scenes: "g-left" },
        activeIdInGroup: { "g-left": "scenes" },
      }) as never,
      stripePanelIds: new Set<PanelId>(),
    });
    const { result } = renderHook(() => useStripePanelsByRegion());
    expect(result.current).toEqual({ left: [], right: [], bottom: [] });
  });
});
