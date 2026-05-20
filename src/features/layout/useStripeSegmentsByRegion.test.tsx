// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

import { useLayoutStore, type PanelId } from "./layoutStore";
import {
  DEFAULT_STRIPE_SIZES,
  DEFAULT_STRIPE_VISIBILITY,
  type StripeRegion,
} from "./toolWindowDefaults";
import { useStripeSegmentsByRegion } from "./useStripeSegmentsByRegion";

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

interface GroupSpec {
  id: string;
  /** rect: [left, top, width, height] */
  rect: [number, number, number, number];
  /** panel ids in tab order */
  panelIds: string[];
  activePanelId?: string;
}

interface MockApiOpts {
  /** editor group rect: [left, top, width, height]。default [200, 0, 600, 600] */
  editorRect?: [number, number, number, number];
  groups: GroupSpec[];
}

/**
 * Dockview API mock. group の rect は detectGroupRegion で region 検出に使われる:
 * - left:  panel.right <= editor.left
 * - right: panel.left  >= editor.right
 * - bottom: panel.top  >= editor.bottom かつ水平方向に重なる
 */
function makeApi({ editorRect = [200, 0, 600, 600], groups }: MockApiOpts) {
  const makeRect = (left: number, top: number, w: number, h: number) =>
    ({
      left,
      top,
      width: w,
      height: h,
      right: left + w,
      bottom: top + h,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  const editorGroup = {
    id: "g-editor",
    element: { getBoundingClientRect: () => makeRect(...editorRect) },
    panels: [{ id: "editor" }],
    activePanel: { id: "editor" },
  };

  const synthGroups = groups.map((g) => {
    const groupRect = makeRect(...g.rect);
    const group = {
      id: g.id,
      element: { getBoundingClientRect: () => groupRect },
      panels: g.panelIds.map((id) => ({ id })),
      activePanel: g.activePanelId
        ? { id: g.activePanelId }
        : g.panelIds[0]
          ? { id: g.panelIds[0] }
          : null,
    };
    // Replace activePanel ref so panel===activePanel check works
    if (group.activePanel) {
      const activeRef = group.panels.find(
        (p) => p.id === group.activePanel?.id,
      );
      if (activeRef) group.activePanel = activeRef as never;
    }
    return group;
  });

  const allGroups = [editorGroup, ...synthGroups];
  const panelToGroup = new Map<string, (typeof allGroups)[number]>();
  for (const g of allGroups) {
    for (const p of g.panels) panelToGroup.set(p.id, g);
  }

  return {
    groups: synthGroups,
    getPanel: vi.fn().mockImplementation((id: string) => {
      const group = panelToGroup.get(id);
      if (!group) return undefined;
      return { id, group };
    }),
    onDidAddPanel: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidRemovePanel: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidActivePanelChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidLayoutChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  };
}

describe("useStripeSegmentsByRegion", () => {
  beforeEach(() => {
    resetStore();
    // ResizeObserver mock (happy-dom doesn't have it)
    (
      globalThis as unknown as { ResizeObserver: typeof ResizeObserver }
    ).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  });

  it("returns empty arrays when there are no panels", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({ groups: [] }) as never,
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current).toEqual({ left: [], right: [], bottom: [] });
  });

  it("returns 1 segment per band (上下に積まれた group → 別 band)", () => {
    // editor: 200..800 → left region 必要条件: right <= 200
    // top group at y=0..300, bottom group at y=300..600 (上下積み → 2 band)
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [
          { id: "lt", rect: [0, 0, 200, 300], panelIds: ["scenes"] },
          { id: "lb", rect: [0, 300, 200, 300], panelIds: ["codex"] },
        ],
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "codex"]),
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.left).toHaveLength(2);
    expect(result.current.left[0].groupIds).toEqual(["lt"]);
    expect(result.current.left[1].groupIds).toEqual(["lb"]);
    expect(result.current.left[0].panels.map((p) => p.id)).toEqual(["scenes"]);
    expect(result.current.left[1].panels.map((p) => p.id)).toEqual(["codex"]);
  });

  it("merges side-by-side groups into 1 band (左右に並ぶ group → 同 band, divider 無し)", () => {
    // 縦 stripe で左右に並ぶ 2 group (同じ Y レンジ) → 1 band 1 segment
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [
          { id: "g-l", rect: [0, 0, 100, 600], panelIds: ["scenes"] },
          { id: "g-r", rect: [100, 0, 100, 600], panelIds: ["codex"] },
        ],
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "codex"]),
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    // 左右並びは縦 stripe で表現できない → 1 segment にまとめる
    expect(result.current.left).toHaveLength(1);
    expect(result.current.left[0].groupIds).toEqual(["g-l", "g-r"]);
    expect(result.current.left[0].panels.map((p) => p.id)).toEqual([
      "scenes",
      "codex",
    ]);
  });

  it("mixed: 上段は左右並び (1 band) + 下段単独 (1 band) → 2 segment", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [
          { id: "top-l", rect: [0, 0, 100, 300], panelIds: ["scenes"] },
          { id: "top-r", rect: [100, 0, 100, 300], panelIds: ["codex"] },
          { id: "bottom", rect: [0, 300, 200, 300], panelIds: ["snippets"] },
        ],
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "codex", "snippets"]),
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.left).toHaveLength(2);
    expect(result.current.left[0].groupIds).toEqual(["top-l", "top-r"]);
    expect(result.current.left[1].groupIds).toEqual(["bottom"]);
  });

  it("orders bands by spatial position (vertical: top→bottom)", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [
          // 順番をわざと逆にして渡す
          { id: "later", rect: [0, 300, 200, 300], panelIds: ["codex"] },
          { id: "earlier", rect: [0, 0, 200, 300], panelIds: ["scenes"] },
        ],
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "codex"]),
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.left.map((s) => s.groupIds)).toEqual([
      ["earlier"],
      ["later"],
    ]);
  });

  it("sizeRatio reflects group height for vertical region", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [
          { id: "lt", rect: [0, 0, 200, 200], panelIds: ["scenes"] },
          { id: "lb", rect: [0, 200, 200, 400], panelIds: ["codex"] },
        ],
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "codex"]),
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.left[0].sizeRatio).toBe(200);
    expect(result.current.left[1].sizeRatio).toBe(400);
  });

  it("sizeRatio reflects group width for horizontal (bottom) region", () => {
    // editor: 200..800 → bottom region: top >= 600 かつ horizontal overlap
    useLayoutStore.setState({
      dockviewApi: makeApi({
        editorRect: [200, 0, 600, 400],
        groups: [
          { id: "bl", rect: [200, 400, 300, 200], panelIds: ["timeline"] },
          { id: "br", rect: [500, 400, 300, 200], panelIds: ["snippets"] },
        ],
      }) as never,
      stripePanelIds: new Set<PanelId>(["timeline", "snippets"]),
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.bottom).toHaveLength(2);
    expect(result.current.bottom[0].sizeRatio).toBe(300);
    expect(result.current.bottom[1].sizeRatio).toBe(300);
  });

  it("places multiple panels of the same group in tab order", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [
          {
            id: "lt",
            rect: [0, 0, 200, 600],
            panelIds: ["scenes", "codex"], // scenes が先タブ
            activePanelId: "scenes",
          },
        ],
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "codex"]),
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.left[0].panels.map((p) => p.id)).toEqual([
      "scenes",
      "codex",
    ]);
    expect(result.current.left[0].panels[0].active).toBe(true);
    expect(result.current.left[0].panels[1].active).toBe(false);
    expect(result.current.left[0].panels[1].visible).toBe(true);
  });

  it("snaps closed panel to segment matching groupRef", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [
          { id: "lt", rect: [0, 0, 200, 300], panelIds: ["scenes"] },
          { id: "lb", rect: [0, 300, 200, 300], panelIds: [] },
        ],
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "codex"]),
      // codex は閉じていて groupRef=lb
      toolWindows: {
        codex: {
          slot: "LB",
          region: "left",
          groupRef: "lb",
          indexInRegion: 1,
          viewMode: "docked-pinned",
        },
      },
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    const lbSegment = result.current.left.find((s) =>
      s.groupIds.includes("lb"),
    );
    expect(lbSegment?.panels.map((p) => p.id)).toEqual(["codex"]);
    expect(lbSegment?.panels[0].visible).toBe(false);
  });

  it("snaps closed panel to segment by indexInRegion when groupRef invalid", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [
          { id: "lt", rect: [0, 0, 200, 300], panelIds: [] },
          { id: "lb", rect: [0, 300, 200, 300], panelIds: [] },
        ],
      }) as never,
      stripePanelIds: new Set<PanelId>(["scenes", "codex"]),
      toolWindows: {
        scenes: {
          slot: "LT",
          region: "left",
          groupRef: "g-vanished",
          indexInRegion: 0,
          viewMode: "docked-pinned",
        },
        codex: {
          slot: "LB",
          region: "left",
          groupRef: "g-also-vanished",
          indexInRegion: 1,
          viewMode: "docked-pinned",
        },
      },
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.left[0].panels.map((p) => p.id)).toEqual(["scenes"]);
    expect(result.current.left[1].panels.map((p) => p.id)).toEqual(["codex"]);
  });

  it("clamps indexInRegion beyond range to last segment", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [{ id: "lt", rect: [0, 0, 200, 600], panelIds: [] }],
      }) as never,
      stripePanelIds: new Set<PanelId>(["codex"]),
      toolWindows: {
        codex: {
          slot: "LB",
          region: "left",
          indexInRegion: 5, // out of range
          viewMode: "docked-pinned",
        },
      },
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.left).toHaveLength(1);
    expect(result.current.left[0].panels.map((p) => p.id)).toEqual(["codex"]);
  });

  it("creates a ghost segment when region has no Dockview group but has closed panels", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({ groups: [] }) as never,
      stripePanelIds: new Set<PanelId>(["scenes"]),
      toolWindows: {
        scenes: {
          slot: "LT",
          region: "left",
          viewMode: "docked-pinned",
        },
      },
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.left).toHaveLength(1);
    expect(result.current.left[0].groupIds).toEqual([]);
    expect(result.current.left[0].key).toBe("ghost-left");
    expect(result.current.left[0].panels.map((p) => p.id)).toEqual(["scenes"]);
  });

  it("excludes panels not in stripePanelIds even if they're in Dockview", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [{ id: "lt", rect: [0, 0, 200, 600], panelIds: ["scenes"] }],
      }) as never,
      stripePanelIds: new Set<PanelId>(), // scenes は stripe 登録なし
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    // segment は存在するが panel は空
    expect(result.current.left).toHaveLength(1);
    expect(result.current.left[0].panels).toEqual([]);
  });

  it("returns empty when no api and no closed panels", () => {
    useLayoutStore.setState({
      dockviewApi: null,
      stripePanelIds: new Set<PanelId>(),
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current).toEqual({ left: [], right: [], bottom: [] });
  });

  it("creates ghost segments per region for closed panels when no api", () => {
    useLayoutStore.setState({
      dockviewApi: null,
      stripePanelIds: new Set<PanelId>(["scenes", "chat"]),
      toolWindows: {
        scenes: { slot: "LT", region: "left", viewMode: "docked-pinned" },
        chat: { slot: "RT", region: "right", viewMode: "docked-pinned" },
      },
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    expect(result.current.left).toHaveLength(1);
    expect(result.current.right).toHaveLength(1);
    expect(result.current.bottom).toEqual([]);
    expect(result.current.left[0].panels.map((p) => p.id)).toEqual(["scenes"]);
    expect(result.current.right[0].panels.map((p) => p.id)).toEqual(["chat"]);
  });

  it("undocked panel is excluded from segment.panels (overlay layer)", () => {
    useLayoutStore.setState({
      dockviewApi: makeApi({
        groups: [{ id: "rt", rect: [800, 0, 200, 600], panelIds: [] }],
      }) as never,
      stripePanelIds: new Set<PanelId>(["chat"]),
      undockedPanels: new Set<PanelId>(["chat"]),
      toolWindows: {
        chat: {
          slot: "RT",
          region: "right",
          indexInRegion: 0,
          viewMode: "undocked",
        },
      },
    });
    const { result } = renderHook(() => useStripeSegmentsByRegion());
    // undocked closed panel は snap される (visible=false, active=true)
    const rt = result.current.right[0];
    expect(rt.panels.map((p) => p.id)).toEqual(["chat"]);
    expect(rt.panels[0].active).toBe(true);
    expect(rt.panels[0].visible).toBe(false);
  });

  const allRegions: StripeRegion[] = ["left", "right", "bottom"];
  it.each(allRegions)(
    "returns 3 stripe regions even when only one is populated (%s)",
    (region) => {
      useLayoutStore.setState({
        dockviewApi: makeApi({ groups: [] }) as never,
        stripePanelIds: new Set<PanelId>(["scenes"]),
        toolWindows: {
          scenes: { slot: "LT", region, viewMode: "docked-pinned" },
        },
      });
      const { result } = renderHook(() => useStripeSegmentsByRegion());
      const others = allRegions.filter((r) => r !== region);
      for (const r of others) {
        expect(result.current[r]).toEqual([]);
      }
      expect(result.current[region].length).toBeGreaterThan(0);
    },
  );
});
