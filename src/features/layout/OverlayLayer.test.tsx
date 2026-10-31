// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reducedMotion = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/animation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/animation")>();
  return { ...actual, useReducedMotion: () => reducedMotion.value };
});

vi.mock("./panelComponents", () => ({
  PANEL_COMPONENT_MAP: new Proxy(
    {},
    {
      get:
        (_target, prop) =>
        ({ isActive }: { isActive?: boolean }) => (
          <div data-stub-panel={String(prop)} data-active={String(isActive)} />
        ),
    },
  ),
}));

import { OverlayLayer } from "./OverlayLayer";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";

function setOverlayPanel(panel: "snippets" | "attribution" | null) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  layout.overlays = { left: { panel }, right: { panel: null } };
  useLayoutStore.setState({
    layout,
    openOverlay: null,
    maximizedPanelId: null,
  });
}

afterEach(cleanup);

describe("OverlayLayer", () => {
  beforeEach(() => {
    reducedMotion.value = false;
    setOverlayPanel("snippets");
  });

  it("renders nothing when the overlay is empty", () => {
    setOverlayPanel(null);
    const { container } = render(<OverlayLayer side="left" />);
    expect(container.querySelector("[data-overlay-layer]")).toBeNull();
  });

  it("stays unmounted until first opened, then keeps the panel mounted when closed", () => {
    const { container } = render(<OverlayLayer side="left" />);
    const layer = container.querySelector<HTMLElement>(
      '[data-overlay-layer="left"]',
    );
    expect(layer).toHaveAttribute("data-state", "closed");
    expect(layer).toHaveAttribute("aria-hidden", "true");
    expect(layer?.style.visibility).toBe("hidden");
    expect(container.querySelector("[data-stub-panel]")).toBeNull();

    act(() => useLayoutStore.getState().toggleOverlay("left"));
    expect(layer).toHaveAttribute("data-state", "open");
    expect(layer?.style.visibility).toBe("visible");
    expect(
      container.querySelector("[data-stub-panel='snippets']"),
    ).toHaveAttribute("data-active", "true");

    act(() => useLayoutStore.getState().toggleOverlay("left"));
    expect(layer?.style.visibility).toBe("hidden");
    // 閉じても unmount しない。isActive だけが false になる。
    expect(
      container.querySelector("[data-stub-panel='snippets']"),
    ).toHaveAttribute("data-active", "false");
  });

  it("slides over OVERLAY_DURATIONS.slide (300ms) and delays hiding on close", () => {
    const { container } = render(<OverlayLayer side="left" />);
    const layer = container.querySelector<HTMLElement>("[data-overlay-layer]")!;
    const panel = container.querySelector<HTMLElement>("[data-overlay-panel]")!;
    expect(panel.style.transition).toContain("300ms");
    expect(layer.style.transition).toContain("300ms");
    act(() => useLayoutStore.getState().toggleOverlay("left"));
    expect(panel.style.transform).toBe("translateX(0)");
    expect(layer.style.transition).toContain("0ms linear 0ms");
  });

  it("switches instantly with no transition under Reduced Motion", () => {
    reducedMotion.value = true;
    const { container } = render(<OverlayLayer side="left" />);
    const layer = container.querySelector<HTMLElement>("[data-overlay-layer]")!;
    const panel = container.querySelector<HTMLElement>("[data-overlay-panel]")!;
    expect(panel.style.transition).toBe("none");
    expect(layer.style.transition).toBe("none");
    act(() => useLayoutStore.getState().toggleOverlay("left"));
    expect(panel.style.transform).toBe("translateX(0)");
    expect(layer.style.visibility).toBe("visible");
  });

  it("drops the mounted panel when the overlay panel changes", () => {
    const { container } = render(<OverlayLayer side="left" />);
    act(() => useLayoutStore.getState().toggleOverlay("left"));
    expect(
      container.querySelector("[data-stub-panel='snippets']"),
    ).not.toBeNull();
    act(() => {
      const layout = structuredClone(useLayoutStore.getState().layout);
      layout.overlays = {
        left: { panel: "attribution" },
        right: { panel: null },
      };
      useLayoutStore.setState({ layout, openOverlay: null });
    });
    expect(container.querySelector("[data-stub-panel]")).toBeNull();
  });

  it("does not wrap the panel in PanelChromeMenu (no maximize / collapse header menu)", () => {
    const { container } = render(<OverlayLayer side="left" />);
    act(() => useLayoutStore.getState().toggleOverlay("left"));
    expect(container.querySelector("[data-animated-slot-panel]")).toBeNull();
  });
});
