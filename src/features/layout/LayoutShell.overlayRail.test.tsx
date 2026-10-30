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
import { OVERLAY_RAIL_SIZE } from "./layoutConstants";

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

describe("LayoutShell overlay rail", () => {
  beforeEach(() => {
    setOverlayLayout();
  });

  it("shows a rail only for the side that has an overlay panel", () => {
    const { container } = render(<LayoutShell />);
    expect(
      container.querySelector('[data-overlay-rail="left"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-overlay-rail="right"]')).toBeNull();
    expect(
      container.querySelector<HTMLElement>('[data-overlay-rail="left"]')?.style
        .width,
    ).toBe(`${OVERLAY_RAIL_SIZE}px`);
  });

  it("shows both rails when both overlays have a panel", () => {
    act(() => setOverlayLayout({ left: "snippets", right: "attribution" }));
    const { container } = render(<LayoutShell />);
    expect(container.querySelectorAll("[data-overlay-rail]")).toHaveLength(2);
  });

  it("shows no rail when both overlays are empty", () => {
    act(() => setOverlayLayout({}));
    const { container } = render(<LayoutShell />);
    expect(container.querySelector("[data-overlay-rail]")).toBeNull();
  });

  it("hides the rails in Zen mode and in the editor-only projection", () => {
    const zen = render(<LayoutShell zenMode />);
    expect(zen.container.querySelector("[data-overlay-rail]")).toBeNull();
    zen.unmount();
    const phone = render(<LayoutShell editorOnly />);
    expect(phone.container.querySelector("[data-overlay-rail]")).toBeNull();
  });

  it("hides the rails while a panel is zoomed and brings them back after", () => {
    const { container } = render(<LayoutShell />);
    expect(container.querySelector("[data-overlay-rail]")).not.toBeNull();
    act(() => useLayoutStore.setState({ maximizedPanelId: "editor" }));
    expect(container.querySelector("[data-overlay-rail]")).toBeNull();
    act(() => useLayoutStore.setState({ maximizedPanelId: null }));
    expect(container.querySelector("[data-overlay-rail]")).not.toBeNull();
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

  it("Zen 中は rail なしで、ショートカット相当の showOverlay だけで層が開く", () => {
    const { container } = render(<LayoutShell zenMode />);
    expect(container.querySelector("[data-overlay-rail]")).toBeNull();
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
