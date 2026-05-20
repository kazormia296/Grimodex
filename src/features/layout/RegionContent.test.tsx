// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("./SlotView", () => ({
  SlotView: ({ panelId }: { panelId: string }) => (
    <div data-mock-slot-view={panelId} />
  ),
}));

import { RegionContent } from "./RegionContent";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import type { SlotState } from "./layoutTypes";

function setLeftSlots(slots: SlotState[]) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  layout.regions.left.slots = slots;
  useLayoutStore.setState({
    layout,
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
  });
}

function slotFlexGrows(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>("[data-drop-slot]")].map(
    (el) => Number(el.style.flexGrow),
  );
}

describe("RegionContent flex-grow", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
    });
  });

  it("fills the container when open-slot sizeRatios sum below 1", () => {
    // Regression: collapsed slots keep large ratios while open slots are not
    // renormalized, so open sizeRatios can sum well below 1. CSS flex-grow
    // leaves empty space when the per-line sum is < 1.
    setLeftSlots([
      {
        id: "l0",
        sizeRatio: 0.0439,
        panels: ["scenes"],
        activePanel: "scenes",
      },
      { id: "l1", sizeRatio: 0.1239, panels: ["codex"], activePanel: "codex" },
      { id: "lc1", sizeRatio: 0.5893, panels: ["grid"], activePanel: null },
      { id: "lc2", sizeRatio: 0.5411, panels: ["map"], activePanel: null },
    ]);

    const { container } = render(
      <RegionContent region="left" orientation="vertical" />,
    );

    const grow = slotFlexGrows(container);
    expect(grow).toHaveLength(2);
    expect(grow.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    // relative proportion between the open slots is preserved
    expect(grow[1] / grow[0]).toBeCloseTo(0.1239 / 0.0439, 3);
  });

  it("gives a lone open slot a full flex-grow of 1", () => {
    setLeftSlots([
      { id: "l0", sizeRatio: 0.04, panels: ["scenes"], activePanel: "scenes" },
      { id: "lc1", sizeRatio: 0.96, panels: ["grid"], activePanel: null },
    ]);

    const { container } = render(
      <RegionContent region="left" orientation="vertical" />,
    );

    const grow = slotFlexGrows(container);
    expect(grow).toHaveLength(1);
    expect(grow[0]).toBeCloseTo(1, 5);
  });
});
