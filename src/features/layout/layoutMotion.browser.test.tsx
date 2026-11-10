/**
 * 実 Chromium で、LayoutShell の中でのレイアウトの動き（案 A の引き出し、
 * stripe の出現、下の角）を gate する。
 *
 * - 閉じる: 列（行）は即時に確定し、閉じるカードは直前の矩形のまま重なって
 *   滑り込む。下のリージョンでは stripe が押し出されない（即時に最終位置）。
 * - panel の移動で閉じたリージョンは中身を残さない（同じ panel を二重に mount
 *   しない）。
 * - 下の角を取った側は clip で広がり、終わったら clip を残さない。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import type { PanelId } from "./panelIds";
import { LayoutStoryPanelStub } from "./stories/LayoutStoryPanelStub";

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: vi.fn(async () => ({})),
  // ブラウザモードはネイティブ ESM リンクのため、import graph 内で使われる
  // named export が factory に無いと SyntaxError になる。
  // (PanelChromeMenu→panelWindow が isTauri、codex multiwindow が emit を使う)
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  isTauri: () => false,
}));

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
  EditorArea: () => <div data-editor-area />,
}));

import { LayoutShell } from "./LayoutShell";
import { preloadLayoutMorph } from "./useLayoutPresetCrossfade";
import { useLayoutStore } from "./layoutStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  buildDefaultLayoutState,
  validateLayoutState,
} from "./layoutStateUtils";
import type { LayoutState, ToolWindowPanelId } from "./layoutTypes";

const SHELL_SIZE = { width: 1200, height: 800 };

function setLayout(mutate: (layout: LayoutState) => void) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  mutate(layout);
  const verdict = validateLayoutState(layout, { viewport: SHELL_SIZE });
  if (!verdict.valid) throw new Error(`invalid test layout: ${verdict.reason}`);
  useLayoutStore.setState({
    layout,
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    hiddenStripePanels: new Set(),
    initialized: true,
    maximizedPanelId: null,
  });
}

/** 既定の配置のまま、`panel` の slot だけを開く。 */
function activate(layout: LayoutState, panel: ToolWindowPanelId) {
  for (const region of ["left", "right", "bottom"] as const) {
    for (const slot of layout.regions[region].slots) {
      if (slot.panels.includes(panel)) slot.activePanel = panel;
    }
  }
}

/** `region` の panel をすべて `to` の先頭の slot へ移し、region を空にする。 */
function emptyRegion(
  layout: LayoutState,
  region: "left" | "right" | "bottom",
  to: "left" | "right" | "bottom",
) {
  const moved = layout.regions[region].slots.flatMap((slot) => slot.panels);
  layout.regions[region].slots = [];
  layout.regions[to].slots[0].panels.push(...moved);
}

function shellView(zenMode = false) {
  return (
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
      <LayoutShell zenMode={zenMode} />
    </div>
  );
}

function renderShell() {
  return render(shellView());
}

async function settleFrames() {
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
  );
}

function translateOf(el: Element): { x: number; y: number } {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return { x: 0, y: 0 };
  const m = new DOMMatrixReadOnly(t);
  return { x: m.m41, y: m.m42 };
}

beforeEach(async () => {
  await page.viewport(SHELL_SIZE.width, SHELL_SIZE.height);
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, "display.reduceMotion": "false" },
  }));
});

describe("layout motion in the shell (real Chromium)", () => {
  it("closes the left region at once and slides the card in over the center", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    const { container } = renderShell();
    await settleFrames();
    const chromeBefore = container
      .querySelector('[data-animated-region="left"]')!
      .getBoundingClientRect();
    const centerBefore = container
      .querySelector('[data-zoom-cell="center"]')!
      .getBoundingClientRect();

    act(() => {
      useLayoutStore.getState().collapseLayoutRegion("left");
    });

    // 列は即時に 0 になり、center は即時に広がる。
    const centerAfter = container
      .querySelector('[data-zoom-cell="center"]')!
      .getBoundingClientRect();
    expect(centerAfter.left).toBeLessThan(centerBefore.left - 100);

    // 閉じるカードは直前の矩形のまま、中身ごと残っている。
    const exiting = container.querySelector<HTMLElement>(
      '[data-animated-region="left"][data-exiting="true"]',
    );
    expect(exiting).not.toBeNull();
    const rect = exiting!.getBoundingClientRect();
    expect(Math.abs(rect.left - chromeBefore.left)).toBeLessThan(1);
    expect(Math.abs(rect.width - chromeBefore.width)).toBeLessThan(1);
    expect(
      exiting!.querySelector('[data-story-panel="scenes"]'),
    ).not.toBeNull();

    // stripe 側（左）へ滑り込み、終わったら外れる。
    await waitFor(() => {
      expect(translateOf(exiting!.firstElementChild!).x).toBeLessThan(-1);
    });
    await waitFor(() => {
      expect(
        container.querySelector('[data-animated-region="left"]'),
      ).toBeNull();
    });
  });

  it("keeps the bottom stripe at its final position while the bottom card slides away", async () => {
    setLayout((layout) => activate(layout, "timeline"));
    const { container } = renderShell();
    await settleFrames();

    act(() => {
      useLayoutStore.getState().collapseLayoutRegion("bottom");
    });
    const stripe = container.querySelector('[data-stripe-region="bottom"]')!;
    const during = stripe.getBoundingClientRect();
    const exiting = container.querySelector<HTMLElement>(
      '[data-animated-region="bottom"][data-exiting="true"]',
    );
    expect(exiting).not.toBeNull();
    // 閉じるカードは stripe の上（stripe-gap を挟む）に重なる。
    expect(exiting!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      during.top + 0.5,
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-animated-region="bottom"]'),
      ).toBeNull();
    });
    const settled = stripe.getBoundingClientRect();
    expect(Math.abs(during.top - settled.top)).toBeLessThan(0.5);
    expect(Math.abs(during.height - settled.height)).toBeLessThan(0.5);
  });

  it("does not keep a panel in the closing region when it moved elsewhere", async () => {
    setLayout((layout) => {
      // 左は scenes だけにして、移すと左が空になるようにする。
      const others = layout.regions.left.slots
        .flatMap((slot) => slot.panels)
        .filter((panel) => panel !== "scenes");
      layout.regions.left.slots = [
        { id: "l0", sizeRatio: 1, panels: ["scenes"], activePanel: "scenes" },
      ];
      layout.regions.bottom.slots[0].panels.push(...others);
      activate(layout, "chat");
    });
    const { container } = renderShell();
    await settleFrames();

    act(() => {
      useLayoutStore.getState().movePanelToRegion("scenes", "right");
    });
    // 移動先にだけ mount され、閉じる左には残らない。
    expect(
      container.querySelectorAll('[data-story-panel="scenes"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-animated-region="left"][data-exiting]'),
    ).toBeNull();
  });

  it("slides the left card out from the stripe side when the region opens", async () => {
    setLayout(() => {});
    const { container } = renderShell();
    await settleFrames();

    act(() => {
      useLayoutStore.getState().expandLayoutRegion("left");
    });
    const chrome = container.querySelector<HTMLElement>(
      '[data-animated-region="left"]',
    )!;
    expect(chrome).not.toBeNull();
    expect(translateOf(chrome.firstElementChild!).x).toBeLessThan(0);
    await waitFor(() => {
      expect(getComputedStyle(chrome).clipPath).toBe("none");
      expect(getComputedStyle(chrome.firstElementChild!).transform).toBe(
        "none",
      );
    });
  });

  it("fades a newly appearing stripe in, but not the stripes of the first render", async () => {
    setLayout((layout) => {
      emptyRegion(layout, "right", "bottom");
      activate(layout, "scenes");
    });
    const { container } = renderShell();
    await settleFrames();
    const left = container.querySelector<HTMLElement>(
      '[data-region-stripe-column="left"]',
    )!;
    expect(getComputedStyle(left).opacity).toBe("1");

    act(() => {
      useLayoutStore.getState().movePanelToRegion("scenes", "right");
    });
    const right = container.querySelector<HTMLElement>(
      '[data-region-stripe-column="right"]',
    );
    expect(right).not.toBeNull();
    expect(parseFloat(getComputedStyle(right!).opacity)).toBeLessThan(1);
    await waitFor(() => {
      expect(getComputedStyle(right!).opacity).toBe("1");
      expect(getComputedStyle(right!).transform).toBe("none");
    });
  });

  it("reveals the side that took the bottom corner and leaves no clip-path", async () => {
    setLayout((layout) => {
      activate(layout, "scenes");
      activate(layout, "timeline");
    });
    const { container } = renderShell();
    await settleFrames();
    const ownedByBottom = useLayoutStore.getState().layout.bottomCorners?.left;

    act(() => {
      useLayoutStore.getState().toggleBottomCorner("left");
    });
    // side が角を取ると、stripe の列と content のセルの両方が下へ伸びる。
    const growers = (
      ownedByBottom
        ? ['[data-region-stripe-column="left"]', '[data-zoom-cell="left"]']
        : ['[data-zoom-cell="bottom"]']
    ).map((selector) => container.querySelector<HTMLElement>(selector)!);
    for (const grower of growers) {
      expect(grower.style.clipPath).toContain("inset(");
    }
    await waitFor(() => {
      for (const grower of growers) expect(grower.style.clipPath).toBe("");
    });

    // 逆向き（角を返す）も同じ。
    act(() => {
      useLayoutStore.getState().toggleBottomCorner("left");
    });
    const back = (
      ownedByBottom
        ? ['[data-zoom-cell="bottom"]']
        : ['[data-region-stripe-column="left"]', '[data-zoom-cell="left"]']
    ).map((selector) => container.querySelector<HTMLElement>(selector)!);
    for (const grower of back) {
      expect(grower.style.clipPath).toContain("inset(");
    }
  });

  it("closes a region from a maximized panel at its normal size", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    const { container } = renderShell();
    await settleFrames();
    const normal = container
      .querySelector('[data-animated-region="left"]')!
      .getBoundingClientRect();

    act(() => {
      useLayoutStore.getState().toggleMaximizePanel("scenes");
    });
    await settleFrames();
    act(() => {
      useLayoutStore.getState().togglePanel("scenes");
    });
    const exiting = container.querySelector<HTMLElement>(
      '[data-animated-region="left"][data-exiting="true"]',
    );
    expect(exiting).not.toBeNull();
    expect(
      Math.abs(exiting!.getBoundingClientRect().width - normal.width),
    ).toBeLessThan(1);
  });

  it("drops a keepalive panel from the closing region when it moves away", async () => {
    setLayout((layout) => activate(layout, "codex"));
    const { container } = renderShell();
    await settleFrames();
    // 同じ slot で codex-quick に切り替え、codex を裏の keepalive に残す。
    act(() => {
      useLayoutStore.getState().showPanel("codex-quick");
    });
    expect(
      container.querySelectorAll('[data-story-panel="codex"]'),
    ).toHaveLength(1);

    act(() => {
      useLayoutStore.getState().collapseLayoutRegion("left");
    });
    expect(
      container.querySelector('[data-animated-region="left"][data-exiting]'),
    ).not.toBeNull();
    act(() => {
      useLayoutStore.getState().movePanelToRegion("codex", "right");
      useLayoutStore.getState().showPanel("codex");
    });
    expect(
      container.querySelectorAll('[data-story-panel="codex"]'),
    ).toHaveLength(1);
  });

  it("does not slide open regions in when the shell mounts again", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    const first = renderShell();
    await settleFrames();
    first.unmount();

    const { container } = renderShell();
    const chrome = container.querySelector<HTMLElement>(
      '[data-animated-region="left"]',
    )!;
    expect(getComputedStyle(chrome).clipPath).toBe("none");
    expect(getComputedStyle(chrome.firstElementChild!).transform).toBe("none");
    expect(
      getComputedStyle(
        container.querySelector('[data-region-stripe-column="left"]')!,
      ).opacity,
    ).toBe("1");
  });

  it("slides the stripe's active pill between icons of the same slot", async () => {
    setLayout((layout) => activate(layout, "codex-quick"));
    const { container } = renderShell();
    await settleFrames();
    const before = container
      .querySelector(
        '[data-stripe-icon="codex-quick"] [data-stripe-active-pill]',
      )!
      .getBoundingClientRect();

    act(() => {
      useLayoutStore.getState().showPanel("codex");
    });
    const pill = container.querySelector<HTMLElement>(
      '[data-stripe-icon="codex"] [data-stripe-active-pill]',
    )!;
    expect(pill).not.toBeNull();
    expect(
      container.querySelector(
        '[data-stripe-icon="codex-quick"] [data-stripe-active-pill]',
      ),
    ).toBeNull();
    // 前のアイコンの位置から滑り始める。
    await waitFor(() => {
      const r = pill.getBoundingClientRect();
      expect(
        Math.abs(r.top - before.top) + Math.abs(r.left - before.left),
      ).toBeGreaterThan(0.5);
      expect(getComputedStyle(pill).transform).not.toBe("none");
    });
    await waitFor(() => {
      expect(getComputedStyle(pill).transform).toBe("none");
    });
  });

  it("keeps the icons it passes above the travelling pill", async () => {
    // 同じ slot に 3 つ以上のアイコンを並べ、先頭から 3 つ目へ移す。
    let panels: ToolWindowPanelId[] = [];
    setLayout((layout) => {
      emptyRegion(layout, "bottom", "left");
      panels = layout.regions.left.slots[0].panels.slice(0, 3);
      layout.regions.left.slots[0].activePanel = panels[0];
    });
    const { container } = renderShell();
    await settleFrames();
    for (let i = 0; i < 20; i++) await settleFrames();
    const passed = container.querySelector<HTMLElement>(
      `[data-stripe-icon="${panels[1]}"] svg`,
    )!;
    const glyph = passed.getBoundingClientRect();
    const cx = glyph.left + glyph.width / 2;
    const cy = glyph.top + glyph.height / 2;

    act(() => {
      useLayoutStore.getState().showPanel(panels[2]);
    });
    const pill = container.querySelector<HTMLElement>(
      `[data-stripe-icon="${panels[2]}"] [data-stripe-active-pill]`,
    )!;
    // 印が途中のアイコンの記号の上に来た時点で、描く順を調べる（印は
    // pointer-events: none なので、調べる間だけ戻す）。
    let hit: Element | null = null;
    await waitFor(() => {
      const r = pill.getBoundingClientRect();
      expect(
        r.top <= cy && cy <= r.bottom && r.left <= cx && cx <= r.right,
      ).toBe(true);
      pill.style.pointerEvents = "auto";
      hit = document.elementFromPoint(cx, cy);
      pill.style.pointerEvents = "";
    });
    expect(hit).not.toBe(pill);
    expect(
      container
        .querySelector(`[data-stripe-icon="${panels[1]}"]`)!
        .contains(hit),
    ).toBe(true);
  });

  it("folds a closing slot's outline toward the far side and widens the neighbour", async () => {
    setLayout((layout) => {
      activate(layout, "scenes");
      activate(layout, "codex");
    });
    const { container } = renderShell();
    await settleFrames();

    act(() => {
      useLayoutStore.getState().togglePanel("codex");
    });
    // 閉じた slot（下）の外形が重なり、広がった隣（上）が clip で広がる。
    const ghost = container.querySelector<HTMLElement>("[data-group-ghost]");
    expect(ghost).not.toBeNull();
    // 外形は flex の場所を取らない（Glass の面の規則に relative にされない）。
    expect(getComputedStyle(ghost!).position).toBe("absolute");
    const scenesSlot = container
      .querySelector('[data-story-panel="scenes"]')!
      .closest<HTMLElement>("[data-drop-slot]")!;
    expect(scenesSlot.style.clipPath).toContain("inset(");
    const during = scenesSlot.getBoundingClientRect().height;
    await waitFor(() => {
      expect(container.querySelector("[data-group-ghost]")).toBeNull();
      expect(scenesSlot.style.clipPath).toBe("");
    });
    // 外形がある間も、広がった隣は最終の寸法のまま。
    expect(
      Math.abs(scenesSlot.getBoundingClientRect().height - during),
    ).toBeLessThan(1);
  });

  it("reveals an opening slot from the boundary with the neighbour that shrank", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    const { container } = renderShell();
    await settleFrames();

    act(() => {
      useLayoutStore.getState().togglePanel("codex");
    });
    const codexSlot = container
      .querySelector('[data-story-panel="codex"]')!
      .closest<HTMLElement>("[data-drop-slot]")!;
    expect(codexSlot.style.clipPath).toContain("inset(");
    await waitFor(() => {
      expect(codexSlot.style.clipPath).toBe("");
    });
  });

  it("slides stripe icons from their previous place when the bands move", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    const { container } = renderShell();
    await settleFrames();

    act(() => {
      useLayoutStore.getState().togglePanel("codex");
    });
    const flipping = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-stripe-region="left"] [data-stripe-icon]',
      ),
    ).filter((el) =>
      el.getAnimations().some((a) => a.id === "stripe-icon-flip"),
    );
    expect(flipping.length).toBeGreaterThan(0);
    await waitFor(() => {
      for (const el of flipping) {
        expect(
          el.getAnimations().some((a) => a.id === "stripe-icon-flip"),
        ).toBe(false);
      }
    });
  });

  it("does not start a slide outside the icon's band (the band would clip it)", async () => {
    // 下の stripe で、右の slot（b1）の 2 つ目のアイコンを左の slot（b0）へ移す。
    // 旧位置は右の band の中なので、左の band の箱の外から滑り始めかねない
    // （前回のレビューの指摘。既定の配置では再現しない。再発の見張り）。
    let moved: ToolWindowPanelId | undefined;
    let targetSlot = "";
    setLayout((layout) => {
      const slots = layout.regions.bottom.slots;
      expect(slots.length).toBeGreaterThanOrEqual(2);
      moved = slots[1].panels[1];
      targetSlot = slots[0].id;
      // 右の slot を開き、左の slot は閉じたまま。
      slots[1].activePanel = slots[1].panels[0];
    });
    expect(moved).toBeDefined();
    const { container } = renderShell();
    for (let i = 0; i < 20; i++) await settleFrames();

    act(() => {
      useLayoutStore.getState().movePanelToSlot(moved!, "bottom", targetSlot);
    });
    // band はスクロール容器（overflow）なので、band の外から滑り始めると切れて
    // 見えず、スクロールバーも一瞬出る。滑り始めのアイコンは自分の band の中にいる。
    const icon = container.querySelector<HTMLElement>(
      `[data-stripe-icon="${moved}"]`,
    )!;
    const band = icon.closest<HTMLElement>("[data-drop-slot-id]")!;
    expect(band.dataset.dropSlotId).toBe(targetSlot);
    // 滑りは実際に起きている（そのうえで band の外から始まらない）。
    expect(icon.getAnimations().some((a) => a.id === "stripe-icon-flip")).toBe(
      true,
    );
    const r = icon.getBoundingClientRect();
    const b = band.getBoundingClientRect();
    expect(r.top).toBeGreaterThanOrEqual(b.top - 1);
    expect(r.bottom).toBeLessThanOrEqual(b.bottom + 1);
    expect(r.left).toBeGreaterThanOrEqual(b.left - 1);
    expect(r.right).toBeLessThanOrEqual(b.right + 1);
  });

  it("grows the drag ghost in and lands it on the stripe icon after the drop", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    renderShell();
    await settleFrames();

    act(() => {
      useLayoutStore
        .getState()
        .setDraggingPanel("chat", "pointer", { x: 14, y: 14 });
    });
    // ゴーストは最初の pointer ドラッグで読む lazy chunk。
    await act(async () => {
      await import("./LayoutPanelDragGhost");
    });
    await settleFrames();
    act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 400, clientY: 300 }),
      );
    });
    const ghost = document.querySelector<HTMLElement>(
      "[data-panel-drag-ghost]",
    )!;
    expect(ghost).not.toBeNull();
    expect(ghost.getAnimations().length).toBeGreaterThan(0);

    act(() => {
      useLayoutStore.getState().setDraggingPanel(null);
    });
    const landing = document.querySelector<HTMLElement>(
      '[data-panel-drag-ghost][data-landing="true"]',
    );
    expect(landing).not.toBeNull();
    await waitFor(() => {
      expect(document.querySelector("[data-panel-drag-ghost]")).toBeNull();
    });
  });

  it("shrinks the maximized card's outline back to its place on restore", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    const { container } = renderShell();
    await settleFrames();
    act(() => {
      useLayoutStore.getState().toggleMaximizePanel("scenes");
    });
    await settleFrames();
    const full = container
      .querySelector('[data-slot-panel="scenes"]')!
      .closest("[data-drop-slot]")!
      .getBoundingClientRect();

    await preloadLayoutMorph();
    act(() => {
      useLayoutStore.getState().clearMaximize();
    });
    const outline = container.querySelector<HTMLElement>(
      '[data-layout-morph-outline="panel:scenes"]',
    );
    expect(outline).not.toBeNull();
    expect(
      Math.abs(outline!.getBoundingClientRect().width - full.width),
    ).toBeLessThan(2);
    await waitFor(() => {
      expect(
        container.querySelector("[data-layout-morph-layer]")!.children,
      ).toHaveLength(0);
    });
  });

  it("widens the editor cell with a clip when entering Zen", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    const { container, rerender } = render(shellView(false));
    await settleFrames();
    rerender(shellView(true));
    const cell = container.querySelector<HTMLElement>(
      '[data-zoom-cell="center"]',
    )!;
    expect(cell.style.clipPath).toContain("inset(");
    await waitFor(() => expect(cell.style.clipPath).toBe(""));
  });

  it("does not slide stripe icons when only sizes change (splitter, window)", async () => {
    setLayout((layout) => {
      activate(layout, "scenes");
      activate(layout, "codex");
    });
    const { container } = renderShell();
    await settleFrames();
    const slot = useLayoutStore
      .getState()
      .layout.regions.left.slots.find((s) => s.activePanel === "scenes")!;
    const other = useLayoutStore
      .getState()
      .layout.regions.left.slots.find((s) => s.activePanel === "codex")!;
    act(() => {
      useLayoutStore
        .getState()
        .nudgeAdjacentSlotSizes("left", slot.id, other.id, 60, 700);
    });
    const flipping = Array.from(
      container.querySelectorAll<HTMLElement>("[data-stripe-icon]"),
    ).filter((el) =>
      el.getAnimations().some((a) => a.id === "stripe-icon-flip"),
    );
    expect(flipping).toHaveLength(0);
  });

  it("lands the drag ghost on the icon's settled place even while the icon slides", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    renderShell();
    await settleFrames();
    act(() => {
      useLayoutStore
        .getState()
        .setDraggingPanel("chat", "pointer", { x: 14, y: 14 });
    });
    await act(async () => {
      await import("./LayoutPanelDragGhost");
    });
    await settleFrames();
    act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 400, clientY: 300 }),
      );
    });
    // 左の stripe へ移してからドロップする（アイコンは着いて弾む）。
    act(() => {
      useLayoutStore.getState().movePanelToRegion("chat", "left");
      useLayoutStore.getState().setDraggingPanel(null);
    });
    const ghost = document.querySelector<HTMLElement>(
      '[data-panel-drag-ghost][data-landing="true"]',
    )!;
    expect(ghost).not.toBeNull();
    const icon = document.querySelector<HTMLElement>(
      '[data-stripe-icon="chat"]',
    )!;
    const effect = ghost.getAnimations()[0].effect as KeyframeEffect;
    const end = effect.getKeyframes().at(-1)!.transform as string;
    const m = new DOMMatrixReadOnly(end);
    const from = ghost.getBoundingClientRect();
    // 終点の大きさはアイコンのレイアウト上の大きさ（弾みの 0.6 倍ではない）。
    expect(from.width * m.a).toBeCloseTo(icon.offsetWidth, 0);
  });

  it("still slides stripe icons after a free-mode drag drop", async () => {
    setLayout((layout) => activate(layout, "scenes"));
    const { container } = renderShell();
    await settleFrames();
    act(() => {
      useLayoutStore
        .getState()
        .setDraggingPanel("chat", "pointer", { x: 14, y: 14 });
      useLayoutStore.setState({ stripeSwapMode: "free" });
    });
    act(() => {
      useLayoutStore.getState().movePanelToRegion("chat", "left");
      useLayoutStore.getState().setDraggingPanel(null);
    });
    const flipping = Array.from(
      container.querySelectorAll<HTMLElement>("[data-stripe-icon]"),
    ).filter((el) =>
      el.getAnimations().some((a) => a.id === "stripe-icon-flip"),
    );
    expect(flipping.length).toBeGreaterThan(0);
  });

  it("slides the pill on the first switch after a preset replacement", async () => {
    setLayout((layout) => activate(layout, "codex-quick"));
    const { container } = renderShell();
    await settleFrames();
    act(() => {
      useLayoutStore.setState((state) => ({
        layoutReplaceSeq: state.layoutReplaceSeq + 1,
      }));
    });
    await settleFrames();
    act(() => {
      useLayoutStore.getState().showPanel("codex");
    });
    const pill = container.querySelector<HTMLElement>(
      '[data-stripe-icon="codex"] [data-stripe-active-pill]',
    )!;
    await waitFor(() => {
      expect(getComputedStyle(pill).transform).not.toBe("none");
    });
  });
});
