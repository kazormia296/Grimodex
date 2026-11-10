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

function shellView() {
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
      <LayoutShell />
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
    const grower = container.querySelector<HTMLElement>(
      ownedByBottom
        ? '[data-region-stripe-column="left"]'
        : '[data-zoom-cell="bottom"]',
    )!;
    expect(grower.style.clipPath).toContain("inset(");
    await waitFor(() => {
      expect(grower.style.clipPath).toBe("");
    });
  });
});
