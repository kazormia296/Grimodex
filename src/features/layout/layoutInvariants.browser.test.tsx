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
import { render } from "@testing-library/react";
import { LayoutShell } from "./LayoutShell";
import { BOTTOM_CORNER_TOGGLE_CLEARANCE_PX } from "./BottomCornerToggle";
import {
  HORIZONTAL_STRIPE_ICON_INSET_PX,
  HORIZONTAL_STRIPE_ICON_SIZE,
  HORIZONTAL_STRIPE_SIZE,
  STRIPE_ICON_SIZE,
  STRIPE_SIZE,
} from "./layoutConstants";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";
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
