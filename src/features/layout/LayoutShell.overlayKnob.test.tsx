// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelId } from "./panelIds";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

vi.mock("./panelComponents", () => ({
  PANEL_COMPONENT_MAP: new Proxy(
    {},
    {
      get: (_target, prop) => () => (
        <div data-stub-panel={String(prop) as PanelId} />
      ),
    },
  ),
}));

vi.mock("./EditorArea", () => ({
  EditorArea: () => <div data-editor-area />,
}));

import { LayoutShell } from "./LayoutShell";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";
import { HORIZONTAL_STRIPE_SIZE } from "./layoutConstants";

function setOverlayLayout(
  overlays: { left?: "snippets" | null; right?: "attribution" | null } = {
    left: "snippets",
  },
) {
  const layout = buildDefaultLayoutState({ editorOpen: true });
  const moved = new Set(Object.values(overlays).filter(Boolean));
  for (const region of ["left", "right", "bottom"] as const) {
    for (const slot of layout.regions[region].slots) {
      slot.panels = slot.panels.filter((p) => !moved.has(p as never));
      if (slot.activePanel !== null && moved.has(slot.activePanel as never)) {
        slot.activePanel = null;
      }
    }
  }
  layout.overlays = {
    left: { panel: overlays.left ?? null },
    right: { panel: overlays.right ?? null },
  };
  useLayoutStore.setState({
    layout,
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    hiddenStripePanels: new Set(),
    initialized: true,
    maximizedPanelId: null,
    openOverlay: null,
  });
}

describe("LayoutShell overlay knob", () => {
  beforeEach(() => {
    setOverlayLayout();
  });

  it("shows a knob only for the side that has an overlay panel", () => {
    const { container } = render(<LayoutShell />);
    expect(
      container.querySelector('[data-overlay-knob-cell="left"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-overlay-knob-cell="right"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-overlay-knob="left"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-overlay-knob="right"]')).toBeNull();
  });

  it("puts the knob cell in the top corner grid area and sizes the knob", () => {
    act(() => setOverlayLayout({ left: "snippets", right: "attribution" }));
    const { container } = render(<LayoutShell />);
    for (const [side, area] of [
      ["left", "lknob"],
      ["right", "rknob"],
    ] as const) {
      const cell = container.querySelector<HTMLElement>(
        `[data-overlay-knob-cell="${side}"]`,
      )!;
      expect(cell.parentElement?.style.gridArea).toContain(area);
      const knob = cell.querySelector<HTMLElement>("[data-overlay-knob]")!;
      expect(knob.style.width).toBe(`${HORIZONTAL_STRIPE_SIZE}px`);
      expect(knob.style.height).toBe(`${HORIZONTAL_STRIPE_SIZE}px`);
      expect(knob.className).toContain("rounded-full");
    }
    const grid = container.querySelector<HTMLElement>("[data-layout-shell]")!;
    const areas = grid.style.gridTemplateAreas;
    expect(areas).toContain('"lknob cstripe');
    expect(areas).toContain('cstripe rknob"');
  });

  it("gives only the knob side its corner when one overlay has a panel", () => {
    const { container } = render(<LayoutShell />);
    const areas = container.querySelector<HTMLElement>("[data-layout-shell]")!
      .style.gridTemplateAreas;
    expect(areas).toContain('"lknob cstripe');
    expect(areas).not.toContain("rknob");
    expect(areas).toContain('cstripe cstripe"');
  });

  it("gives the center stripe cell a gap from the knob corner on the knob side only", () => {
    const { container } = render(<LayoutShell />);
    const cell = container.querySelector<HTMLElement>(
      "[data-center-stripe]",
    )!.parentElement!;
    expect(cell.style.paddingLeft).not.toBe("");
    expect(cell.style.paddingRight).toBe("");
  });

  it("shows both knobs when both overlays have a panel", () => {
    act(() => setOverlayLayout({ left: "snippets", right: "attribution" }));
    const { container } = render(<LayoutShell />);
    expect(container.querySelectorAll("[data-overlay-knob]")).toHaveLength(2);
  });

  it("shows no knob when both overlays are empty", () => {
    act(() => setOverlayLayout({}));
    const { container } = render(<LayoutShell />);
    expect(container.querySelector("[data-overlay-knob]")).toBeNull();
    expect(container.querySelector("[data-overlay-knob-cell]")).toBeNull();
    expect(
      container.querySelector<HTMLElement>("[data-layout-shell]")!.style
        .gridTemplateAreas,
    ).not.toMatch(/knob/);
  });

  it("hides the knobs in Zen mode and in the editor-only projection", () => {
    const zen = render(<LayoutShell zenMode />);
    expect(zen.container.querySelector("[data-overlay-knob]")).toBeNull();
    zen.unmount();
    const phone = render(<LayoutShell editorOnly />);
    expect(phone.container.querySelector("[data-overlay-knob]")).toBeNull();
  });

  it("hides the knobs while a panel is zoomed and brings them back after", () => {
    const { container } = render(<LayoutShell />);
    expect(container.querySelector("[data-overlay-knob]")).not.toBeNull();
    act(() => useLayoutStore.setState({ maximizedPanelId: "editor" }));
    expect(container.querySelector("[data-overlay-knob]")).toBeNull();
    act(() => useLayoutStore.setState({ maximizedPanelId: null }));
    expect(container.querySelector("[data-overlay-knob]")).not.toBeNull();
  });

  it("keeps data-layout-shell on the grid, not on the outer wrapper", () => {
    const { container } = render(<LayoutShell />);
    const shell = container.querySelector<HTMLElement>("[data-layout-shell]");
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain("grid");
    expect(shell?.parentElement).toHaveAttribute("data-overlay-host");
  });

  it("toggles the overlay from the knob and reflects it in aria-expanded", () => {
    const { container } = render(<LayoutShell />);
    const knob = container.querySelector<HTMLElement>(
      '[data-overlay-knob="left"]',
    );
    expect(knob).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(knob!);
    expect(useLayoutStore.getState().openOverlay).toBe("left");
    expect(knob).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(knob!);
    expect(useLayoutStore.getState().openOverlay).toBeNull();
    expect(knob).toHaveAttribute("aria-expanded", "false");
  });

  it("Zen 中はつまみなしで、ショートカット相当の showOverlay だけで層が開く", () => {
    const { container } = render(<LayoutShell zenMode />);
    expect(container.querySelector("[data-overlay-knob]")).toBeNull();
    act(() => useLayoutStore.getState().showOverlay("left"));
    expect(
      container.querySelector('[data-overlay-layer="left"]'),
    ).toHaveAttribute("data-state", "open");
  });

  it("ロック中でもつまみで開閉できる", () => {
    useLayoutStore.setState({ layoutLocked: true });
    const { container } = render(<LayoutShell />);
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-overlay-knob="left"]')!,
    );
    expect(useLayoutStore.getState().openOverlay).toBe("left");
  });
});
