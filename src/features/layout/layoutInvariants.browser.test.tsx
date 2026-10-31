/**
 * 実 Chromium で動かす layout の幾何 invariant テスト。happy-dom は flex/grid の
 * 寸法を計算しないため、過去 3 回再発した以下の系統のバグは単体テストでは捕まら
 * ない:
 *
 *   1. Splitter のヒット領域が 0×0 px に潰れる (SplitterHandle の % 解決失敗)
 *   2. Bottom region の content + stripe が grid cell からはみ出る
 *   3. 先頭 collapsed cluster と open バンドの flex 配分域が non-aligned で、
 *      icon の y が対応する slot 境界とズレる
 *
 * 実ブラウザで `getBoundingClientRect()` を測って assert することで、これらを
 * CI で永続的にガードする。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LayoutShell } from "./LayoutShell";
import { BOTTOM_CORNER_TOGGLE_CLEARANCE_PX } from "./BottomCornerToggle";
import {
  HORIZONTAL_STRIPE_ICON_INSET_PX,
  HORIZONTAL_STRIPE_ICON_SIZE,
  HORIZONTAL_STRIPE_SIZE,
  STRIPE_GAP_PX,
  STRIPE_ICON_SIZE,
  STRIPE_SIZE,
} from "./layoutConstants";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import type { OverlayId, ToolWindowPanelId } from "./layoutTypes";
import type { PanelId } from "./panelIds";
import { LayoutStoryPanelStub } from "./stories/LayoutStoryPanelStub";

vi.mock("./panelComponents", () => ({
  PANEL_COMPONENT_MAP: new Proxy(
    {},
    {
      get: (_t, prop) => () => (
        <LayoutStoryPanelStub panelId={String(prop) as PanelId} />
      ),
    },
  ),
}));

vi.mock("./EditorArea", () => ({
  EditorArea: () => (
    <div
      data-editor-area
      className="flex h-full w-full items-center justify-center bg-muted/10 text-sm"
    >
      editor
    </div>
  ),
}));

const SHELL_SIZE = { width: 1200, height: 800 };

function setLeftSlots(
  slots: Array<{ id: string; panels: string[]; activePanel: string | null }>,
) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  layout.regions.left.slots = slots.map((s) => ({
    id: s.id,
    sizeRatio: 1,
    panels: s.panels as never[],
    activePanel: s.activePanel as never,
  }));
  useLayoutStore.setState({
    layout,
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    hiddenStripePanels: new Set(),
    initialized: true,
  });
}

function setLeftAndBottom(opts: {
  leftSlots: Array<{
    id: string;
    panels: string[];
    activePanel: string | null;
  }>;
  bottomSlots: Array<{
    id: string;
    panels: string[];
    activePanel: string | null;
  }>;
  bottomCornersLeft?: boolean;
}) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  layout.regions.left.slots = opts.leftSlots.map((s) => ({
    id: s.id,
    sizeRatio: 1,
    panels: s.panels as never[],
    activePanel: s.activePanel as never,
  }));
  layout.regions.bottom.slots = opts.bottomSlots.map((s) => ({
    id: s.id,
    sizeRatio: 1,
    panels: s.panels as never[],
    activePanel: s.activePanel as never,
  }));
  if (opts.bottomCornersLeft !== undefined) {
    layout.bottomCorners = { left: opts.bottomCornersLeft, right: false };
  }
  useLayoutStore.setState({
    layout,
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    hiddenStripePanels: new Set(),
    initialized: true,
  });
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return !(
    a.right <= b.left + 0.5 ||
    a.left >= b.right - 0.5 ||
    a.bottom <= b.top + 0.5 ||
    a.top >= b.bottom - 0.5
  );
}

function renderShell() {
  // card 用の CSS chain (gx-panel, --gx-* variables) は app-shell 配下で有効。
  // LayoutShell の root motion.div は h-full/w-full なので、外側 div に
  // explicit な width/height を与えて viewport の代替にする。
  // 直接 document.body に portal せず testing-library の container を使うと、
  // container 自身の height が auto (block) で h-full の解決連鎖が崩れる。
  // host を `position: fixed; inset: 0; width/height: explicit` にして
  // viewport 直結のコンテナにしてしまうのが一番素直。
  return render(
    <div
      className="app-shell"
      data-shell-host
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: SHELL_SIZE.width,
        height: SHELL_SIZE.height,
      }}
    >
      <LayoutShell />
    </div>,
  );
}

describe("layout geometry invariants (real Chromium)", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
      hiddenStripePanels: new Set(),
      initialized: true,
    });
  });

  it("centers the fixed editor icon and paints the same rim on every stripe", async () => {
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const centerStripe = container.querySelector<HTMLElement>(
      "[data-center-stripe]",
    );
    const editorIcon = container.querySelector<HTMLElement>(
      '[data-stripe-icon="editor"]',
    );
    expect(centerStripe).not.toBeNull();
    expect(editorIcon).not.toBeNull();

    const stripeRect = centerStripe!.getBoundingClientRect();
    const iconRect = editorIcon!.getBoundingClientRect();
    expect(stripeRect.height).toBe(HORIZONTAL_STRIPE_SIZE);
    expect(iconRect.height).toBe(HORIZONTAL_STRIPE_ICON_SIZE);
    expect(iconRect.top - stripeRect.top).toBe(HORIZONTAL_STRIPE_ICON_INSET_PX);
    expect(stripeRect.bottom - iconRect.bottom).toBe(
      HORIZONTAL_STRIPE_ICON_INSET_PX,
    );
    expect(getComputedStyle(centerStripe!).gridTemplateRows).toBe(
      `${HORIZONTAL_STRIPE_SIZE}px`,
    );

    const stripes = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-ambient-glass-surface="stripe"].gx-panel',
      ),
    ];
    expect(stripes).toHaveLength(4);
    for (const stripe of stripes) {
      const rect = stripe.getBoundingClientRect();
      const horizontal = rect.width > rect.height;
      const expectedSize = horizontal ? HORIZONTAL_STRIPE_SIZE : STRIPE_SIZE;
      expect(getComputedStyle(stripe).borderTopWidth).toBe("0px");
      expect(getComputedStyle(stripe, "::after").borderTopWidth).toBe("1px");
      expect(horizontal ? rect.height : rect.width).toBe(expectedSize);
      expect(getComputedStyle(stripe, "::after").borderRadius).toBe(
        `${expectedSize / 2}px`,
      );
    }
  });

  it("centers both bottom corner toggles on the stripe arc intersections", async () => {
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const leftStripe = container.querySelector<HTMLElement>(
      '[data-stripe-region="left"]',
    );
    const rightStripe = container.querySelector<HTMLElement>(
      '[data-stripe-region="right"]',
    );
    const leftToggle = container.querySelector<HTMLElement>(
      '[data-bottom-corner-toggle="left"]',
    );
    const rightToggle = container.querySelector<HTMLElement>(
      '[data-bottom-corner-toggle="right"]',
    );
    expect(leftStripe).not.toBeNull();
    expect(rightStripe).not.toBeNull();
    expect(leftToggle).not.toBeNull();
    expect(rightToggle).not.toBeNull();

    const leftStripeRect = leftStripe!.getBoundingClientRect();
    const rightStripeRect = rightStripe!.getBoundingClientRect();
    const expectedCenterY = leftStripeRect.bottom - STRIPE_SIZE / 2;
    for (const [toggle, stripe] of [
      [leftToggle!, leftStripeRect],
      [rightToggle!, rightStripeRect],
    ] as const) {
      const toggleRect = toggle.getBoundingClientRect();
      const svgRect = toggle.querySelector("svg")!.getBoundingClientRect();
      expect(toggleRect.width).toBe(STRIPE_ICON_SIZE);
      expect(toggleRect.height).toBe(STRIPE_ICON_SIZE);
      expect(svgRect.width).toBe(16);
      expect(svgRect.height).toBe(16);
      expect(toggleRect.left + toggleRect.width / 2).toBe(
        stripe.left + stripe.width / 2,
      );
      expect(toggleRect.top + toggleRect.height / 2).toBe(expectedCenterY);
    }
  });

  it("slot splitter has a hoverable hit area (regression: SplitterHandle %寸法 collapse)", async () => {
    setLeftSlots([
      { id: "l0", panels: ["scenes"], activePanel: "scenes" },
      { id: "l1", panels: ["codex-quick"], activePanel: "codex-quick" },
    ]);
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const splitterHandle = container.querySelector<HTMLElement>(
      "[data-splitter-handle]",
    );
    expect(splitterHandle).not.toBeNull();
    const rect = splitterHandle!.getBoundingClientRect();
    // ヒット領域は最低でも 4×4 px は要る (10px gap が設計値)。
    expect(rect.width).toBeGreaterThan(4);
    expect(rect.height).toBeGreaterThan(4);
  });

  it("region resize splitter (bottom) has a hoverable hit area", async () => {
    setLeftAndBottom({
      leftSlots: [{ id: "l0", panels: ["scenes"], activePanel: "scenes" }],
      bottomSlots: [
        { id: "b0", panels: ["timeline"], activePanel: "timeline" },
      ],
      bottomCornersLeft: false,
    });
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const splitterHandles = container.querySelectorAll<HTMLElement>(
      "[data-splitter-handle]",
    );
    // bottom region splitter が含まれるはず。すべてのハンドルが non-zero size。
    expect(splitterHandles.length).toBeGreaterThan(0);
    for (const handle of splitterHandles) {
      const r = handle.getBoundingClientRect();
      expect(r.width).toBeGreaterThan(4);
      expect(r.height).toBeGreaterThan(4);
    }
  });

  it("bottom region content + stripe stays within the bottom grid cell (no overflow)", async () => {
    setLeftAndBottom({
      leftSlots: [{ id: "l0", panels: ["scenes"], activePanel: "scenes" }],
      bottomSlots: [
        { id: "b0", panels: ["timeline"], activePanel: "timeline" },
      ],
      bottomCornersLeft: false,
    });
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const shell = container.querySelector<HTMLElement>("[data-layout-shell]");
    expect(shell).not.toBeNull();
    const shellRect = shell!.getBoundingClientRect();

    // BottomRegionDock のドック (stripe + content) が shell の bottom を
    // 超えていなければ OK。0af038eb での h-full 撤去回帰の永続ガード。
    const bottomDock = container.querySelector<HTMLElement>(
      '[data-region-dock="bottom"]',
    );
    expect(bottomDock).not.toBeNull();
    const dockRect = bottomDock!.getBoundingClientRect();
    expect(dockRect.bottom).toBeLessThanOrEqual(shellRect.bottom + 0.5);
    // 折り返し検出: stripe が dock 内に居る (dock.bottom より上)。
    const bottomStripe = container.querySelector<HTMLElement>(
      '[data-stripe-region="bottom"]',
    );
    expect(bottomStripe).not.toBeNull();
    const stripeRect = bottomStripe!.getBoundingClientRect();
    expect(stripeRect.bottom).toBeLessThanOrEqual(shellRect.bottom + 0.5);
  });

  it("side stripe bands align with content slots when there is no leading collapsed cluster", async () => {
    // すべて open: 先頭 cluster 無し → padding/shift も無し → 純粋な flex 整列。
    setLeftSlots([
      { id: "l0", panels: ["scenes"], activePanel: "scenes" },
      { id: "l1", panels: ["codex-quick"], activePanel: "codex-quick" },
    ]);
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const slot1 = container.querySelector<HTMLElement>('[data-drop-slot="l1"]');
    const stripeRoot = container.querySelector<HTMLElement>(
      '[data-stripe-region="left"]',
    );
    expect(slot1).not.toBeNull();
    expect(stripeRoot).not.toBeNull();

    // slot 境界 (slot1 の top = slot0.bottom + splitter) と stripe band 1 の
    // top が揃う = stripe 配分域と content 配分域が同じ高さで分割されている。
    const slot1Top = slot1!.getBoundingClientRect().top;
    const stripeBands = stripeRoot!.querySelectorAll<HTMLElement>(
      "[data-drop-segment]",
    );
    expect(stripeBands.length).toBeGreaterThanOrEqual(2);
    const band1Top = stripeBands[1].getBoundingClientRect().top;
    // 2 px tolerance: subpixel rounding。
    expect(Math.abs(band1Top - slot1Top)).toBeLessThan(2);
  });

  it("subsequent bands align with their slots even with a leading collapsed cluster", async () => {
    // 先頭 slot を閉、後続 2 つを開: 先頭 cluster overlay + shift wrapper が
    // band 1 に乗る構成。band 2 (2 つめの open) は shift 無しで slot と整列するはず。
    setLeftSlots([
      { id: "l0", panels: ["scenes"], activePanel: null }, // collapsed
      { id: "l1", panels: ["codex-quick"], activePanel: "codex-quick" }, // open
      {
        id: "l2",
        panels: ["command-center-results"],
        activePanel: "command-center-results",
      }, // open
    ]);
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const slot2 = container.querySelector<HTMLElement>('[data-drop-slot="l2"]');
    const stripeRoot = container.querySelector<HTMLElement>(
      '[data-stripe-region="left"]',
    );
    expect(slot2).not.toBeNull();
    expect(stripeRoot).not.toBeNull();

    // open バンド (l1, l2) を順に拾う。l0 は collapsed cluster の中。
    const openBands = stripeRoot!.querySelectorAll<HTMLElement>(
      '[data-drop-segment]:not([data-drop-segment="l0"])',
    );
    expect(openBands.length).toBeGreaterThanOrEqual(2);
    // band for l2 が slot l2 の top と揃う。
    const band2 = Array.from(openBands).find(
      (el) => el.getAttribute("data-drop-segment") === "l2",
    );
    expect(band2).toBeDefined();
    const band2Top = band2!.getBoundingClientRect().top;
    const slot2Top = slot2!.getBoundingClientRect().top;
    expect(Math.abs(band2Top - slot2Top)).toBeLessThan(2);
  });

  it("bottom stripe icons do not overlap the left corner toggle when bottom owns the corner and the first group is open", async () => {
    setLeftAndBottom({
      leftSlots: [{ id: "l0", panels: ["scenes"], activePanel: "scenes" }],
      bottomSlots: [
        { id: "b0", panels: ["timeline"], activePanel: "timeline" },
        { id: "b1", panels: ["chat"], activePanel: null },
      ],
      bottomCornersLeft: true,
    });
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const toggle = container.querySelector<HTMLElement>(
      '[data-bottom-corner-toggle="left"]',
    );
    const firstIcon = container.querySelector<HTMLElement>(
      '[data-stripe-region="bottom"] [data-stripe-icon="timeline"]',
    );
    expect(toggle).not.toBeNull();
    expect(firstIcon).not.toBeNull();
    expect(
      rectsOverlap(
        toggle!.getBoundingClientRect(),
        firstIcon!.getBoundingClientRect(),
      ),
    ).toBe(false);
    expect(firstIcon!.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      toggle!.getBoundingClientRect().right - 0.5,
    );
  });

  it("bottom stripe collapsed and adjacent open icons do not overlap when bottom owns the corner", async () => {
    setLeftAndBottom({
      leftSlots: [{ id: "l0", panels: ["scenes"], activePanel: "scenes" }],
      bottomSlots: [
        { id: "b0", panels: ["timeline"], activePanel: null },
        { id: "b1", panels: ["chat"], activePanel: "chat" },
      ],
      bottomCornersLeft: true,
    });
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const collapsedIcon = container.querySelector<HTMLElement>(
      '[data-stripe-region="bottom"] [data-stripe-icon="timeline"]',
    );
    const openIcon = container.querySelector<HTMLElement>(
      '[data-stripe-region="bottom"] [data-stripe-icon="chat"]',
    );
    expect(collapsedIcon).not.toBeNull();
    expect(openIcon).not.toBeNull();
    expect(
      rectsOverlap(
        collapsedIcon!.getBoundingClientRect(),
        openIcon!.getBoundingClientRect(),
      ),
    ).toBe(false);
    expect(openIcon!.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      collapsedIcon!.getBoundingClientRect().right - 0.5,
    );
  });

  it("bottom stripe leading icon clears the left corner toggle by at least clearance px", async () => {
    setLeftAndBottom({
      leftSlots: [{ id: "l0", panels: ["scenes"], activePanel: "scenes" }],
      bottomSlots: [
        { id: "b0", panels: ["timeline"], activePanel: "timeline" },
      ],
      bottomCornersLeft: true,
    });
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const toggle = container.querySelector<HTMLElement>(
      '[data-bottom-corner-toggle="left"]',
    );
    const bottomStripe = container.querySelector<HTMLElement>(
      '[data-stripe-region="bottom"]',
    );
    const firstIcon = container.querySelector<HTMLElement>(
      '[data-stripe-region="bottom"] [data-stripe-icon="timeline"]',
    );
    expect(toggle).not.toBeNull();
    expect(bottomStripe).not.toBeNull();
    expect(firstIcon).not.toBeNull();

    const stripeLeft = bottomStripe!.getBoundingClientRect().left;
    expect(
      firstIcon!.getBoundingClientRect().left - stripeLeft,
    ).toBeGreaterThanOrEqual(BOTTOM_CORNER_TOGGLE_CLEARANCE_PX - 0.5);
    expect(
      rectsOverlap(
        toggle!.getBoundingClientRect(),
        firstIcon!.getBoundingClientRect(),
      ),
    ).toBe(false);
  });

  it("bands align with content slots when side owns the bottom corner", async () => {
    // bottomCorners.left = false → side が bottom 角を取り、lstripe と
    // lcontent が共に bottom 行まで伸びる。efcf7d4b で stripe-root の padding を
    // 撤去した方針の永続ガード: 配分域が content と一致してバンドが整列する。
    setLeftAndBottom({
      leftSlots: [
        { id: "l0", panels: ["scenes"], activePanel: "scenes" },
        { id: "l1", panels: ["codex-quick"], activePanel: "codex-quick" },
      ],
      bottomSlots: [
        { id: "b0", panels: ["timeline"], activePanel: "timeline" },
      ],
      bottomCornersLeft: false,
    });
    const { container } = renderShell();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const slot1 = container.querySelector<HTMLElement>('[data-drop-slot="l1"]');
    const band1 = container.querySelector<HTMLElement>(
      '[data-stripe-region="left"] [data-drop-segment="l1"]',
    );
    expect(slot1).not.toBeNull();
    expect(band1).not.toBeNull();
    const slot1Top = slot1!.getBoundingClientRect().top;
    const band1Top = band1!.getBoundingClientRect().top;
    expect(Math.abs(band1Top - slot1Top)).toBeLessThan(2);
  });
});

/**
 * overlay のつまみ（center stripe の行の両端）がある状態でも、同じ幾何の invariant が
 * 成り立つこと。つまみは grid の列を動かさない（center 領域・side stripe・bottom は
 * つまみの有無で同じ矩形）。center stripe の bands だけが、その側の region の状態に
 * 応じて editor 列より内側から始まる（開=揃う、閉=36px 内側、パネル無し=36+ギャップ内側）。
 */
type RegionState = "open" | "closed" | "none";
type SideStates = Record<OverlayId, RegionState>;

interface KnobCase {
  name: string;
  overlays: Partial<Record<OverlayId, string>>;
  states: SideStates;
}

const KNOB_CASES: KnobCase[] = [
  {
    name: "left, region open",
    overlays: { left: "snippets" },
    states: { left: "open", right: "open" },
  },
  {
    name: "left, region closed",
    overlays: { left: "snippets" },
    states: { left: "closed", right: "open" },
  },
  {
    name: "left, no panels",
    overlays: { left: "snippets" },
    states: { left: "none", right: "open" },
  },
  {
    name: "right, region open",
    overlays: { right: "attribution" },
    states: { left: "open", right: "open" },
  },
  {
    name: "right, region closed",
    overlays: { right: "attribution" },
    states: { left: "open", right: "closed" },
  },
  {
    name: "right, no panels",
    overlays: { right: "attribution" },
    states: { left: "open", right: "none" },
  },
  {
    name: "both, regions open",
    overlays: { left: "snippets", right: "attribution" },
    states: { left: "open", right: "open" },
  },
  {
    name: "both, regions closed",
    overlays: { left: "snippets", right: "attribution" },
    states: { left: "closed", right: "closed" },
  },
  {
    name: "both, no panels",
    overlays: { left: "snippets", right: "attribution" },
    states: { left: "none", right: "none" },
  },
  {
    name: "both, left open and right closed",
    overlays: { left: "snippets", right: "attribution" },
    states: { left: "open", right: "closed" },
  },
  {
    name: "both, left no panels and right open",
    overlays: { left: "snippets", right: "attribution" },
    states: { left: "none", right: "open" },
  },
  {
    name: "left overlay while the right region (no overlay) is closed",
    overlays: { left: "snippets" },
    states: { left: "closed", right: "closed" },
  },
];

function buildOverlayLayout(
  overlays: Partial<Record<OverlayId, string>>,
  states: SideStates,
  withBottom: boolean,
  // false なら overlay のパネルを slot から外すだけで overlay には置かない
  // （つまみの有無だけを比べるための基準）。
  placeOverlays = true,
) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  const moved = new Set(Object.values(overlays));
  const strip = (
    slots: typeof layout.regions.left.slots,
    state: RegionState,
  ) => {
    if (state === "none") return [];
    return slots.map((slot) => ({
      ...slot,
      panels: slot.panels.filter((p) => !moved.has(p)),
      activePanel:
        state === "closed" ||
        (slot.activePanel !== null && moved.has(slot.activePanel))
          ? null
          : slot.activePanel,
    }));
  };
  layout.regions.left.slots = strip(
    [
      { id: "l0", sizeRatio: 1, panels: ["scenes"], activePanel: "scenes" },
      {
        id: "l1",
        sizeRatio: 1,
        panels: ["codex-quick"],
        activePanel: "codex-quick",
      },
    ],
    states.left,
  );
  layout.regions.right.slots = strip(
    [{ id: "r0", sizeRatio: 1, panels: ["chat"], activePanel: "chat" }],
    states.right,
  );
  layout.regions.bottom.slots = withBottom
    ? strip(
        [
          {
            id: "b0",
            sizeRatio: 1,
            panels: ["timeline"],
            activePanel: "timeline",
          },
        ],
        "open",
      )
    : [];
  layout.bottomCorners = { left: false, right: false };
  layout.overlays = placeOverlays
    ? {
        left: { panel: (overlays.left ?? null) as ToolWindowPanelId | null },
        right: { panel: (overlays.right ?? null) as ToolWindowPanelId | null },
      }
    : { left: { panel: null }, right: { panel: null } };
  return layout;
}

function setLayoutWithOverlays(
  overlays: Partial<Record<OverlayId, string>>,
  states: SideStates,
  withBottom: boolean,
  placeOverlays = true,
) {
  useLayoutStore.setState({
    layout: buildOverlayLayout(overlays, states, withBottom, placeOverlays),
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    hiddenStripePanels: new Set(),
    initialized: true,
    maximizedPanelId: null,
    openOverlay: null,
  });
}

const OUTER_PAD = 14;
const SIDES: OverlayId[] = ["left", "right"];
const nextFrames = async () => {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
};

/** grid の列・行を決める要素の矩形を DOM 順に並べる（つまみの有無で動かないはずのもの）。 */
const GRID_SELECTORS = [
  "[data-layout-shell]",
  "[data-editor-area]",
  // center stripe は両端につまみを置くので、つまみの有無で幅が変わる（動かさないのは grid の側）。
  `[data-stripe-region]:not([data-stripe-region="center"])`,
  "[data-region-dock]",
  "[data-splitter-handle]",
  "[data-drop-slot]",
  "[data-bottom-corner-toggle]",
].join(",");

function snapshotGrid(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(GRID_SELECTORS)].map(
    (el) => {
      const r = el.getBoundingClientRect();
      const id =
        el.getAttribute("data-stripe-region") ??
        el.getAttribute("data-region-dock") ??
        el.getAttribute("data-drop-slot") ??
        el.getAttribute("data-bottom-corner-toggle") ??
        (el.hasAttribute("data-editor-area") ? "editor" : "other");
      return {
        id,
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      };
    },
  );
}

describe.each(KNOB_CASES)(
  "layout geometry invariants with overlay knobs ($name)",
  ({ overlays, states }) => {
    const hasKnob = (side: OverlayId) => Boolean(overlays[side]);

    async function renderWithKnobs(withBottom = false) {
      setLayoutWithOverlays(overlays, states, withBottom);
      const view = renderShell();
      await nextFrames();
      return view;
    }

    const rect = (container: HTMLElement, selector: string) => {
      const el = container.querySelector<HTMLElement>(selector);
      expect(el, selector).not.toBeNull();
      return el!.getBoundingClientRect();
    };

    it("does not move the grid: columns, editor, side stripes, bottom dock and splitters are identical with and without knobs", async () => {
      const { container } = await renderWithKnobs(true);
      expect(container.querySelectorAll("[data-overlay-knob]")).toHaveLength(
        Object.keys(overlays).length,
      );
      const withKnobs = snapshotGrid(container);
      expect(withKnobs.length).toBeGreaterThan(3);
      cleanup();
      setLayoutWithOverlays(overlays, states, true, false);
      const base = renderShell();
      await nextFrames();
      expect(base.container.querySelector("[data-overlay-knob]")).toBeNull();
      const without = snapshotGrid(base.container);
      expect(withKnobs.map((r) => r.id)).toEqual(without.map((r) => r.id));
      withKnobs.forEach((r, i) => {
        const o = without[i];
        expect(r.left, `${r.id} left`).toBeCloseTo(o.left, 2);
        expect(r.top, `${r.id} top`).toBeCloseTo(o.top, 2);
        expect(r.width, `${r.id} width`).toBeCloseTo(o.width, 2);
        expect(r.height, `${r.id} height`).toBeCloseTo(o.height, 2);
      });
    });

    it("puts each knob cell at the end of the top row (width 36) with a 35px round surface and a 27px round button inside", async () => {
      const { container } = await renderWithKnobs();
      const shell = rect(container, "[data-layout-shell]");
      const stripe = rect(container, "[data-center-stripe]");
      for (const side of SIDES) {
        const cell = container.querySelector<HTMLElement>(
          `[data-overlay-knob-cell="${side}"]`,
        );
        if (!hasKnob(side)) {
          expect(cell).toBeNull();
          expect(
            container.querySelector(`[data-overlay-knob="${side}"]`),
          ).toBeNull();
          continue;
        }
        expect(cell).not.toBeNull();
        const cellRect = cell!.getBoundingClientRect();
        expect(cellRect.width).toBe(STRIPE_SIZE);
        if (side === "left") {
          expect(cellRect.left).toBe(shell.left + OUTER_PAD);
        } else {
          expect(cellRect.right).toBe(shell.right - OUTER_PAD);
        }
        // 上段（center stripe の行）に高さも位置も揃う。
        expect(cellRect.top).toBe(stripe.top);
        expect(cellRect.height).toBe(HORIZONTAL_STRIPE_SIZE);

        const surface = cell!
          .querySelector<HTMLElement>("[data-overlay-knob-surface]")!
          .getBoundingClientRect();
        expect(surface.width).toBe(HORIZONTAL_STRIPE_SIZE);
        expect(surface.height).toBe(HORIZONTAL_STRIPE_SIZE);
        expect(surface.left).toBeGreaterThanOrEqual(cellRect.left - 0.5);
        expect(surface.right).toBeLessThanOrEqual(cellRect.right + 0.5);
        expect(surface.top).toBeGreaterThanOrEqual(cellRect.top - 0.5);
        expect(surface.bottom).toBeLessThanOrEqual(cellRect.bottom + 0.5);
        const surfaceEl = cell!.querySelector<HTMLElement>(
          "[data-overlay-knob-surface]",
        )!;
        expect(getComputedStyle(surfaceEl).borderRadius).not.toBe("0px");

        const knob = cell!.querySelector<HTMLElement>(
          `[data-overlay-knob="${side}"]`,
        )!;
        const knobRect = knob.getBoundingClientRect();
        expect(knobRect.width).toBe(HORIZONTAL_STRIPE_ICON_SIZE);
        expect(knobRect.height).toBe(HORIZONTAL_STRIPE_ICON_SIZE);
        // 面の中央にある。
        expect(knobRect.left + knobRect.width / 2).toBeCloseTo(
          surface.left + surface.width / 2,
          1,
        );
        expect(knobRect.top + knobRect.height / 2).toBeCloseTo(
          surface.top + surface.height / 2,
          1,
        );
        expect(knobRect.left).toBeGreaterThanOrEqual(surface.left - 0.5);
        expect(knobRect.right).toBeLessThanOrEqual(surface.right + 0.5);
        expect(knob.getAttribute("aria-expanded")).toBe("false");
        expect(knob.getAttribute("aria-controls")).toMatch(
          /^gx-overlay-layer-/,
        );
      }
    });

    it("starts the center stripe STRIPE_GAP_PX outside the knob cell, and at the grid edge on a side without a knob", async () => {
      const { container } = await renderWithKnobs();
      const shell = rect(container, "[data-layout-shell]");
      const stripe = rect(container, "[data-center-stripe]");
      const leftCell = container.querySelector<HTMLElement>(
        '[data-overlay-knob-cell="left"]',
      );
      const rightCell = container.querySelector<HTMLElement>(
        '[data-overlay-knob-cell="right"]',
      );
      if (leftCell) {
        expect(stripe.left).toBe(
          leftCell.getBoundingClientRect().right + STRIPE_GAP_PX,
        );
      } else {
        expect(stripe.left).toBe(shell.left + OUTER_PAD);
      }
      if (rightCell) {
        expect(stripe.right).toBe(
          rightCell.getBoundingClientRect().left - STRIPE_GAP_PX,
        );
      } else {
        expect(stripe.right).toBe(shell.right - OUTER_PAD);
      }
    });

    it("places the bands column against the editor column by region state: open = aligned, closed = 36px inside, no panels = knob + gap inside; no knob = aligned", async () => {
      const { container } = await renderWithKnobs();
      const bands = rect(container, "[data-center-stripe-column]");
      const editor = rect(container, "[data-editor-area]");
      const inset = (side: OverlayId) => {
        if (!hasKnob(side)) return 0;
        if (states[side] === "open") return 0;
        if (states[side] === "closed") return STRIPE_SIZE;
        return STRIPE_SIZE + STRIPE_GAP_PX;
      };
      // 既存の整列 invariant と同じ許容差（subpixel 丸め）。
      expect(Math.abs(bands.left - (editor.left + inset("left")))).toBeLessThan(
        2,
      );
      expect(
        Math.abs(bands.right - (editor.right - inset("right"))),
      ).toBeLessThan(2);
    });

    it("keeps the dock toggle inside the center stripe, in a 36px box at its end that never overlaps the bands column or the knob", async () => {
      const { container } = await renderWithKnobs();
      const stripe = rect(container, "[data-center-stripe]");
      const bands = rect(container, "[data-center-stripe-column]");
      for (const side of SIDES) {
        const toggle = container.querySelector<HTMLElement>(
          `[data-side-dock-toggle="${side}"]`,
        );
        if (states[side] === "none") {
          expect(toggle).toBeNull();
          continue;
        }
        expect(toggle).not.toBeNull();
        const toggleRect = toggle!.getBoundingClientRect();
        expect(toggleRect.left).toBeGreaterThanOrEqual(stripe.left - 0.5);
        expect(toggleRect.right).toBeLessThanOrEqual(stripe.right + 0.5);
        expect(toggleRect.top).toBeGreaterThanOrEqual(stripe.top - 0.5);
        expect(toggleRect.bottom).toBeLessThanOrEqual(stripe.bottom + 0.5);
        expect(rectsOverlap(toggleRect, bands)).toBe(false);
        if (side === "left") {
          expect(toggleRect.right).toBeLessThanOrEqual(bands.left + 0.5);
        } else {
          expect(toggleRect.left).toBeGreaterThanOrEqual(bands.right - 0.5);
        }
        if (hasKnob(side)) {
          const box = toggle!.parentElement!.getBoundingClientRect();
          expect(box.width).toBe(STRIPE_SIZE);
          if (side === "left") expect(box.left).toBe(stripe.left);
          else expect(box.right).toBe(stripe.right);
          expect(toggleRect.left).toBeGreaterThanOrEqual(box.left - 0.5);
          expect(toggleRect.right).toBeLessThanOrEqual(box.right + 0.5);
          const cell = rect(container, `[data-overlay-knob-cell="${side}"]`);
          expect(rectsOverlap(toggleRect, cell)).toBe(false);
        }
      }
    });

    it("keeps knobs, toggles and stripes from overlapping one another", async () => {
      const { container } = await renderWithKnobs(true);
      const stripes = [
        ...container.querySelectorAll<HTMLElement>("[data-stripe-region]"),
        ...container.querySelectorAll<HTMLElement>("[data-center-stripe]"),
      ].map((el) => el.getBoundingClientRect());
      expect(stripes.length).toBeGreaterThan(0);
      const knobCells = [
        ...container.querySelectorAll<HTMLElement>("[data-overlay-knob-cell]"),
      ];
      expect(knobCells).toHaveLength(Object.keys(overlays).length);
      for (const cell of knobCells) {
        const cellRect = cell.getBoundingClientRect();
        for (const stripe of stripes) {
          expect(rectsOverlap(cellRect, stripe)).toBe(false);
        }
      }
    });

    it("keeps the grid, the center stripe and the dock inside the viewport with no scroll", async () => {
      const { container } = await renderWithKnobs(true);
      const shell = rect(container, "[data-layout-shell]");
      expect(shell.left).toBe(0);
      expect(shell.right).toBe(SHELL_SIZE.width);
      expect(shell.top).toBe(0);
      expect(shell.bottom).toBe(SHELL_SIZE.height);
      const gridEl = container.querySelector<HTMLElement>(
        "[data-layout-shell]",
      )!;
      expect(gridEl.scrollWidth).toBeLessThanOrEqual(gridEl.clientWidth);
      expect(gridEl.scrollHeight).toBeLessThanOrEqual(gridEl.clientHeight);
      const inside = [
        "[data-center-stripe]",
        "[data-center-stripe-column]",
        "[data-editor-area]",
        '[data-region-dock="bottom"]',
        "[data-overlay-knob-cell]",
      ];
      for (const selector of inside) {
        for (const el of container.querySelectorAll<HTMLElement>(selector)) {
          const r = el.getBoundingClientRect();
          expect(r.left, selector).toBeGreaterThanOrEqual(shell.left - 0.5);
          expect(r.right, selector).toBeLessThanOrEqual(shell.right + 0.5);
          expect(r.top, selector).toBeGreaterThanOrEqual(shell.top - 0.5);
          expect(r.bottom, selector).toBeLessThanOrEqual(shell.bottom + 0.5);
        }
      }
    });

    it("paints the same stripe rim and centres the corner toggles", async () => {
      const { container } = await renderWithKnobs(true);
      const stripes = [
        ...container.querySelectorAll<HTMLElement>(
          '[data-ambient-glass-surface="stripe"].gx-panel:not([data-overlay-knob-surface])',
        ),
      ];
      // center + bottom + パネルのある側の side stripe。
      const sideStripes = SIDES.filter((s) => states[s] !== "none").length;
      expect(stripes).toHaveLength(2 + sideStripes);
      for (const stripe of stripes) {
        const r = stripe.getBoundingClientRect();
        const horizontal = r.width > r.height;
        const expectedSize = horizontal ? HORIZONTAL_STRIPE_SIZE : STRIPE_SIZE;
        expect(horizontal ? r.height : r.width).toBe(expectedSize);
      }
      for (const side of SIDES) {
        if (states[side] === "none") continue;
        const stripeRect = container
          .querySelector<HTMLElement>(`[data-stripe-region="${side}"]`)!
          .getBoundingClientRect();
        const toggle = container
          .querySelector<HTMLElement>(`[data-bottom-corner-toggle="${side}"]`)!
          .getBoundingClientRect();
        expect(toggle.left + toggle.width / 2).toBe(
          stripeRect.left + stripeRect.width / 2,
        );
      }
    });

    it("keeps splitters hoverable and the bottom dock inside the grid", async () => {
      const { container } = await renderWithKnobs(true);
      const handles = container.querySelectorAll<HTMLElement>(
        "[data-splitter-handle]",
      );
      for (const handle of handles) {
        const r = handle.getBoundingClientRect();
        expect(r.width).toBeGreaterThan(4);
        expect(r.height).toBeGreaterThan(4);
      }
      const shell = rect(container, "[data-layout-shell]");
      const dock = rect(container, '[data-region-dock="bottom"]');
      expect(dock.left).toBeGreaterThanOrEqual(shell.left - 0.5);
      expect(dock.right).toBeLessThanOrEqual(shell.right + 0.5);
      expect(dock.bottom).toBeLessThanOrEqual(shell.bottom + 0.5);
    });

    it("aligns side stripe bands with their content slots", async () => {
      if (states.left !== "open") return;
      const { container } = await renderWithKnobs();
      const slot1 = container.querySelector<HTMLElement>(
        '[data-drop-slot="l1"]',
      );
      const band1 = container.querySelector<HTMLElement>(
        '[data-stripe-region="left"] [data-drop-segment="l1"]',
      );
      expect(slot1).not.toBeNull();
      expect(band1).not.toBeNull();
      expect(
        Math.abs(
          band1!.getBoundingClientRect().top -
            slot1!.getBoundingClientRect().top,
        ),
      ).toBeLessThan(2);
    });
  },
);
