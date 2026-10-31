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
import {
  HORIZONTAL_STRIPE_ICON_SIZE,
  HORIZONTAL_STRIPE_SIZE,
  STRIPE_GAP_PX,
  STRIPE_SIZE,
} from "./layoutConstants";

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

  it("puts the knob cell at the ends of the center stripe cell and sizes the surface", () => {
    act(() => setOverlayLayout({ left: "snippets", right: "attribution" }));
    const { container } = render(<LayoutShell />);
    const stripeCell = container.querySelector<HTMLElement>(
      "[data-center-stripe]",
    )!.parentElement!.parentElement!;
    expect(stripeCell.style.gridArea).toContain("cstripe");
    for (const side of ["left", "right"] as const) {
      const cell = container.querySelector<HTMLElement>(
        `[data-overlay-knob-cell="${side}"]`,
      )!;
      // cstripe セルの直下の箱（幅 36 とギャップ）にあり、grid の領域は増やさない。
      const box = cell.parentElement!;
      expect(box.parentElement).toBe(stripeCell);
      expect(box.style.width).toBe(`${STRIPE_SIZE}px`);
      expect(box.style[side === "left" ? "marginRight" : "marginLeft"]).toBe(
        `${STRIPE_GAP_PX}px`,
      );
      const surface = cell.querySelector<HTMLElement>(
        "[data-overlay-knob-surface]",
      )!;
      expect(surface.style.width).toBe(`${HORIZONTAL_STRIPE_SIZE}px`);
      expect(surface.style.height).toBe(`${HORIZONTAL_STRIPE_SIZE}px`);
      expect(surface.getAttribute("data-ambient-glass-surface")).toBe("stripe");
      const knob = cell.querySelector<HTMLElement>("[data-overlay-knob]")!;
      expect(knob.style.width).toBe(`${HORIZONTAL_STRIPE_ICON_SIZE}px`);
      expect(knob.className).toContain("rounded-full");
      expect(knob.className).not.toContain("overlay-accent");
    }
    // 左右の box の間に CenterStripe がある。
    expect(stripeCell.children).toHaveLength(3);
    // つまみ専用の grid 領域は無い。
    const areas = container.querySelector<HTMLElement>("[data-layout-shell]")!
      .style.gridTemplateAreas;
    expect(areas).not.toMatch(/knob/);
  });

  it("puts the knob box only on the side that has an overlay panel", () => {
    const { container } = render(<LayoutShell />);
    const stripeCell = container.querySelector<HTMLElement>(
      "[data-center-stripe]",
    )!.parentElement!.parentElement!;
    expect(stripeCell.children).toHaveLength(2);
    expect(stripeCell.firstElementChild).toBe(
      container.querySelector<HTMLElement>('[data-overlay-knob-cell="left"]')!
        .parentElement,
    );
  });

  it("shows no knob when both overlays are empty", () => {
    act(() => setOverlayLayout({}));
    const { container } = render(<LayoutShell />);
    expect(container.querySelector("[data-overlay-knob]")).toBeNull();
    expect(container.querySelector("[data-overlay-knob-cell]")).toBeNull();
    const stripeCell = container.querySelector<HTMLElement>(
      "[data-center-stripe]",
    )!.parentElement!.parentElement!;
    expect(stripeCell.children).toHaveLength(1);
  });

  it("shows both knobs when both overlays have a panel", () => {
    act(() => setOverlayLayout({ left: "snippets", right: "attribution" }));
    const { container } = render(<LayoutShell />);
    expect(container.querySelectorAll("[data-overlay-knob]")).toHaveLength(2);
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
