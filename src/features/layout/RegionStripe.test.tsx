// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { RegionStripe } from "./RegionStripe";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import type { RegionSegment } from "./useRegionSegments";

// l0: open (multi-panel), l1: collapsed, l2: open
const segments: RegionSegment[] = [
  {
    key: "l0",
    slotId: "l0",
    sizeRatio: 0.3,
    open: true,
    panels: [
      { id: "scenes", active: true },
      { id: "codex-quick", active: false },
    ],
  },
  {
    key: "l1",
    slotId: "l1",
    sizeRatio: 0.7,
    open: false,
    panels: [{ id: "timeline", active: false }],
  },
  {
    key: "l2",
    slotId: "l2",
    sizeRatio: 0.5,
    open: true,
    panels: [{ id: "chat", active: true }],
  },
];

describe("RegionStripe", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
    });
  });

  it("distributes flex-grow among open segments and gives collapsed ones zero", () => {
    // Regression: collapsed slots carry stale sizeRatio; using it for the
    // stripe makes a collapsed slot dominate. Only open slots get proportion.
    const { container } = render(
      <RegionStripe region="left" orientation="vertical" segments={segments} />,
    );
    const groups = [
      ...container.querySelectorAll<HTMLElement>("[data-drop-segment]"),
    ];
    expect(groups).toHaveLength(3);

    const grow = groups.map((el) => Number(el.style.flexGrow));
    expect(grow[1]).toBe(0); // collapsed slot: no proportional space
    // open slots fill the whole stripe (match content): normalized among
    // open slots only (0.3 + 0.5) so the pair sums to 1.
    expect(grow[0]).toBeCloseTo(0.3 / 0.8, 5);
    expect(grow[2]).toBeCloseTo(0.5 / 0.8, 5);
    expect(grow[0] + grow[2]).toBeCloseTo(1, 5);

    // collapsed group keeps natural size so its icons stay visible
    expect(groups[1].style.flexBasis).toBe("auto");

    // collapsed slots live in a zero-size cluster (flex-grow 0) so they do
    // not consume flow space — open bands stay aligned with the content.
    const cluster = container.querySelector<HTMLElement>(
      "[data-stripe-collapsed-cluster]",
    );
    expect(cluster).not.toBeNull();
    expect(Number(cluster!.style.flexGrow)).toBe(0);
  });

  it("dims collapsed-slot icons more than open-slot icons", () => {
    const { container } = render(
      <RegionStripe region="left" orientation="vertical" segments={segments} />,
    );
    const cls = (panel: string) =>
      container.querySelector(`[data-stripe-icon="${panel}"]`)?.className ?? "";

    expect(cls("scenes")).toContain("bg-accent"); // open + active
    expect(cls("codex-quick")).toContain("text-muted-foreground/60"); // open + inactive
    expect(cls("timeline")).toContain("text-muted-foreground/35"); // collapsed
  });

  it("renders an empty stripe instead of returning null", () => {
    // center stripe は tool segment が無くても常設帯として描画する。
    const { container } = render(
      <RegionStripe region="center" orientation="horizontal" segments={[]} />,
    );
    expect(container.querySelector("[data-stripe-root]")).not.toBeNull();
  });

  it("exposes a full-cover drop zone on an empty stripe while dragging", async () => {
    useLayoutStore.setState({ draggingPanel: "codex" });
    const { container } = render(
      <RegionStripe region="center" orientation="horizontal" segments={[]} />,
    );

    const endZone = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-drop-edge="end"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(endZone.dataset.dropSurface).toBe("stripe-end");
    expect(endZone.dataset.insertIndex).toBe("0");
    // 空ストライプでは start エッジゾーンを出さない（end が全面を覆う）。
    expect(container.querySelector('[data-drop-edge="start"]')).toBeNull();
  });
});
