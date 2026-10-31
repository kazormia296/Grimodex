/**
 * 背景（ambient）を有効にしたときの overlay の見た目（実 Chromium）。
 * rail は grid と一緒に透明になり、overlay のパネルには grid のパネルと同じ
 * Fluid Glass の規則が効く。happy-dom は CSS の cascade を計算しないためここで測る。
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

  it("keeps the rail on the canvas color when the background is off", async () => {
    const { container } = renderHost(false);
    await frame();
    const rail = container.querySelector<HTMLElement>("[data-overlay-rail]")!;
    const grid = container.querySelector<HTMLElement>("[data-layout-shell]")!;
    expect(isTransparent(getComputedStyle(rail).backgroundColor)).toBe(false);
    expect(getComputedStyle(rail).backgroundColor).toBe(
      getComputedStyle(grid).backgroundColor,
    );
  });

  it("makes the rail transparent together with the grid when the background is on", async () => {
    const { container } = renderHost(true);
    await frame();
    const rail = container.querySelector<HTMLElement>("[data-overlay-rail]")!;
    const grid = container.querySelector<HTMLElement>("[data-layout-shell]")!;
    expect(isTransparent(getComputedStyle(grid).backgroundColor)).toBe(true);
    expect(isTransparent(getComputedStyle(rail).backgroundColor)).toBe(true);
  });

  it("applies the Fluid Glass rule to the overlay panel like a grid panel", async () => {
    const { container } = renderHost(true);
    await frame();
    const layer = container.querySelector<HTMLElement>(
      '[data-overlay-layer="left"]',
    )!;
    expect(layer.hasAttribute("data-workspace-glass-root")).toBe(true);
    expect(layer.getAttribute("data-workspace-fluid-glass")).toBe("true");
    const panel = container.querySelector<HTMLElement>(
      '[data-overlay-panel="left"]',
    )!;
    const style = getComputedStyle(panel);
    expect(style.backdropFilter).not.toBe("none");
    expect(isTransparent(style.backgroundColor)).toBe(true);
  });
});
