/**
 * 背景（ambient）を有効にしたときの overlay の見た目（実 Chromium）。
 * つまみは grid の上段の角に載り（背景の有無で位置が変わらず、背景も grid の外に出ない）、
 * overlay のパネルは glass root の外で backdrop-filter と幕で描く。happy-dom は CSS の cascade を計算しないためここで測る。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { LayoutShell } from "./LayoutShell";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import type { PanelId } from "./panelIds";
import { LayoutStoryPanelStub } from "./stories/LayoutStoryPanelStub";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { useSettingsStore } from "@/features/settings/settingsStore";

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
  EditorArea: () => <div data-editor-area className="h-full w-full" />,
}));

function setup() {
  const layout = buildDefaultLayoutState({ allInactive: true });
  for (const region of ["left", "right", "bottom"] as const) {
    for (const slot of layout.regions[region].slots) {
      slot.panels = slot.panels.filter((p) => p !== "snippets");
      if (slot.activePanel === "snippets") slot.activePanel = null;
    }
  }
  layout.overlays = { left: { panel: "snippets" }, right: { panel: null } };
  useLayoutStore.setState({
    layout,
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    hiddenStripePanels: new Set(),
    initialized: true,
    maximizedPanelId: null,
    openOverlay: "left",
  });
  useSettingsStore.setState({
    cache: {
      ...DEFAULT_SETTINGS,
      "editor.zenBackground.glass.enabled": "true",
    },
  });
}

function renderHost(ambient: boolean) {
  return render(
    <div
      className="app-shell"
      style={{ position: "fixed", top: 0, left: 0, width: 1200, height: 800 }}
    >
      <main id="main-content" style={{ height: "100%" }}>
        <div
          data-editor-ambient
          data-background-enabled={ambient ? "true" : "false"}
          data-background-renderer="initializing"
        />
        <LayoutShell />
      </main>
    </div>,
  );
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const isTransparent = (color: string) =>
  color === "rgba(0, 0, 0, 0)" || color === "transparent";

describe("overlay with ambient background (real Chromium)", () => {
  beforeEach(setup);

  it.each([false, true])(
    "keeps the knob in the grid's top corner without painting a band (background %s)",
    async (ambient) => {
      const { container } = renderHost(ambient);
      await frame();
      const grid = container.querySelector<HTMLElement>("[data-layout-shell]")!;
      const cell = container.querySelector<HTMLElement>(
        '[data-overlay-knob-cell="left"]',
      )!;
      const knob = container.querySelector<HTMLElement>(
        '[data-overlay-knob="left"]',
      )!;
      const stripe = container.querySelector<HTMLElement>(
        "[data-center-stripe]",
      )!;
      // つまみのセルは grid の直下の子（上段の角）。
      expect(cell.parentElement!.parentElement).toBe(grid);
      expect(cell.parentElement!.style.gridArea).toBe("lknob");
      const cellRect = cell.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      expect(cellRect.left).toBe(gridRect.left + 14);
      expect(cellRect.top).toBe(stripe.getBoundingClientRect().top);
      // 背景の有無に関わらず、grid の canvas 色の帯をつまみの外に作らない。
      expect(isTransparent(getComputedStyle(cell).backgroundColor)).toBe(true);
      // つまみ自体の面は透けすぎない（琥珀色の面）。
      expect(isTransparent(getComputedStyle(knob).backgroundColor)).toBe(false);
      expect(isTransparent(getComputedStyle(grid).backgroundColor)).toBe(
        ambient,
      );
    },
  );

  it("keeps the overlay out of the WebGL Glass pass and blurs above the grid instead", async () => {
    const { container } = renderHost(true);
    await frame();
    const layer = container.querySelector<HTMLElement>(
      '[data-overlay-layer="left"]',
    )!;
    // The WebGL pass collects surfaces under a glass root and paints them into
    // the backmost canvas, i.e. beneath the grid panels.
    expect(layer.closest("[data-workspace-glass-root]")).toBeNull();
    expect(
      layer.querySelector(
        '[data-workspace-glass-root][data-workspace-fluid-glass="true"] [data-ambient-glass-surface]',
      ),
    ).toBeNull();
    expect(layer.getAttribute("data-overlay-glass")).toBe("true");
    const panel = container.querySelector<HTMLElement>(
      '[data-overlay-panel="left"]',
    )!;
    const style = getComputedStyle(panel);
    expect(style.backdropFilter).toContain("blur");
    // A veil, not a fully clear surface: grid text must not read through.
    expect(isTransparent(style.backgroundColor)).toBe(false);
  });

  it("drops the overlay blur on the fallback renderer", async () => {
    const { container } = renderHost(true);
    container
      .querySelector("[data-editor-ambient]")!
      .setAttribute("data-background-renderer", "fallback");
    await frame();
    const panel = container.querySelector<HTMLElement>(
      '[data-overlay-panel="left"]',
    )!;
    const style = getComputedStyle(panel);
    expect(style.backdropFilter).toBe("none");
    expect(isTransparent(style.backgroundColor)).toBe(false);
  });
});
