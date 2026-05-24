// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RegionStripe } from "./RegionStripe";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import { PANEL_GAP_PX } from "./layoutConstants";
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

  it("sizes the open-slot divider band to the content Splitter thickness", () => {
    // Regression: the stripe divider used a 5px band (my-0.5 + 1px line)
    // while the content Splitter is PANEL_GAP_PX wide — the mismatch drifted
    // the stripe split position away from the Splitter position.
    const { container } = render(
      <RegionStripe region="left" orientation="vertical" segments={segments} />,
    );
    const divider = container.querySelector<HTMLElement>(
      "[data-stripe-divider]",
    );
    const band = divider?.parentElement as HTMLElement;
    expect(band.style.height).toBe(`${PANEL_GAP_PX}px`);
  });

  it.each([
    { region: "left" as const, orientation: "vertical" as const },
    { region: "right" as const, orientation: "vertical" as const },
    { region: "bottom" as const, orientation: "horizontal" as const },
  ])(
    "keeps leading collapsed icons visible when a later slot opens ($region)",
    ({ region, orientation }) => {
      // Alignment: leading collapsed slots render as a 0-size absolute
      // overlay so subsequent open bands distribute from the stripe's
      // origin (matching the content side's first slot). Icons sit on
      // a z-elevated layer above the open band so they remain visible.
      const leadingCollapsed: RegionSegment[] = [
        {
          key: "s0",
          slotId: "s0",
          sizeRatio: 0.5,
          open: false,
          panels: [{ id: "chat", active: false }],
        },
        {
          key: "s1",
          slotId: "s1",
          sizeRatio: 0.5,
          open: false,
          panels: [{ id: "chat-history", active: false }],
        },
        {
          key: "s2",
          slotId: "s2",
          sizeRatio: 0.5,
          open: true,
          panels: [
            { id: "codex", active: true },
            { id: "snippets", active: false },
          ],
        },
      ];
      const { container } = render(
        <RegionStripe
          region={region}
          orientation={orientation}
          segments={leadingCollapsed}
        />,
      );

      expect(
        container.querySelector('[data-stripe-icon="chat"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-stripe-icon="chat-history"]'),
      ).not.toBeNull();

      const leadingCluster = container.querySelector<HTMLElement>(
        "[data-stripe-collapsed-cluster]",
      );
      expect(leadingCluster).not.toBeNull();
      // 0-size overlay: inner absolute layer holds the icons.
      expect(leadingCluster?.querySelector(".absolute")).not.toBeNull();

      const icons = [
        ...container.querySelectorAll<HTMLElement>("[data-stripe-icon]"),
      ].map((el) => el.dataset.stripeIcon);
      expect(icons.indexOf("chat")).toBeLessThan(icons.indexOf("codex"));
      expect(icons.indexOf("chat-history")).toBeLessThan(
        icons.indexOf("codex"),
      );
    },
  );

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

  it("opens stripe band context menu on right click", async () => {
    const user = userEvent.setup();
    const { getByTestId } = render(
      <RegionStripe region="left" orientation="vertical" segments={segments} />,
    );
    const band = document.querySelector("[data-drop-segment='l0']");
    expect(band).not.toBeNull();
    await user.pointer({ keys: "[MouseRight>]", target: band! });
    expect(getByTestId("stripe-band-ctx-collapse")).toBeTruthy();
  });

  it("renders an empty stripe instead of returning null", () => {
    // center stripe は tool segment が無くても常設帯として描画する。
    const { container } = render(
      <RegionStripe region="center" orientation="horizontal" segments={[]} />,
    );
    expect(container.querySelector("[data-stripe-root]")).not.toBeNull();
  });

  it("reserves padding at the trailing end for the corner toggle", () => {
    // Regression: side stripe が bottom 角を取るとき、stripe 末尾の
    // CollapsedCluster (anchor="end" → bottom: 0) のアイコンと
    // BottomCornerToggle (absolute bottom-left/right) が重なっていた。
    // reserveEndPx を渡すと stripe root に padding が入り、trailing
    // collapsed cluster がトグルぶん押し上げられる。
    const trailingCollapsed: RegionSegment[] = [
      {
        key: "l0",
        slotId: "l0",
        sizeRatio: 1,
        open: true,
        panels: [{ id: "scenes", active: true }],
      },
      {
        key: "l1",
        slotId: "l1",
        sizeRatio: 1,
        open: false,
        panels: [{ id: "timeline", active: false }],
      },
    ];
    const { container } = render(
      <RegionStripe
        region="left"
        orientation="vertical"
        segments={trailingCollapsed}
        reserveEndPx={28}
      />,
    );
    const stripeRoot =
      container.querySelector<HTMLElement>("[data-stripe-root]");
    expect(stripeRoot).not.toBeNull();
    expect(stripeRoot!.style.paddingBottom).toBe("28px");
    expect(stripeRoot!.style.paddingTop).toBe("");
  });

  it("applies reserveStartPx/reserveEndPx on the inline axis when horizontal", () => {
    // horizontal stripe (bottom region) では reserve は左右端に効く。
    const { container } = render(
      <RegionStripe
        region="bottom"
        orientation="horizontal"
        segments={segments}
        reserveStartPx={28}
        reserveEndPx={28}
      />,
    );
    const stripeRoot =
      container.querySelector<HTMLElement>("[data-stripe-root]");
    expect(stripeRoot!.style.paddingLeft).toBe("28px");
    expect(stripeRoot!.style.paddingRight).toBe("28px");
    expect(stripeRoot!.style.paddingTop).toBe("");
    expect(stripeRoot!.style.paddingBottom).toBe("");
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
