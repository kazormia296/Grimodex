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

  it("offsets the first open slot's icons via an absolute shift so the band's flex outer stays at grow_share", () => {
    // 先頭 slot が collapsed + 後続 slot が open のとき、cluster は 0 サイズ
    // overlay として stripe-root の start に積まれる。open slot の内部アイコン
    // (z-30) が overlay icon を覆い隠さないよう、最初の open slot のアイコン
    // を absolute で下方向へ逃がす。バンド outer に padding を入れると
    // flex-shrink:0 と相俟って outer が膨らみ、後続バンドが下方向へずれる。
    const leadingCollapsed: RegionSegment[] = [
      {
        key: "l0",
        slotId: "l0",
        sizeRatio: 0.3,
        open: false,
        panels: [{ id: "scenes", active: false }],
      },
      {
        key: "l1",
        slotId: "l1",
        sizeRatio: 0.7,
        open: true,
        panels: [{ id: "chat", active: true }],
      },
    ];
    const { container } = render(
      <RegionStripe
        region="left"
        orientation="vertical"
        segments={leadingCollapsed}
      />,
    );
    const groups = [
      ...container.querySelectorAll<HTMLElement>("[data-drop-segment]"),
    ];
    const openGroup = groups[1];
    // バンドの outer には padding を入れない（flex 寸法の純度を保つ）。
    expect(openGroup.style.paddingTop).toBe("");
    expect(openGroup.style.paddingLeft).toBe("");
    // アイコンは absolute シフト wrapper の中に置かれる。
    const shift = openGroup.querySelector<HTMLElement>(
      "[data-stripe-leading-shift]",
    );
    expect(shift).not.toBeNull();
    expect(parseFloat(shift!.style.top)).toBeGreaterThanOrEqual(28);
  });

  it("does not wrap icons when there is no leading collapsed cluster", () => {
    // 先頭 slot が open のときは shift wrapper 不要 (overlay と重ならない)。
    const { container } = render(
      <RegionStripe region="left" orientation="vertical" segments={segments} />,
    );
    const groups = [
      ...container.querySelectorAll<HTMLElement>("[data-drop-segment]"),
    ];
    expect(groups[0].style.paddingTop).toBe("");
    expect(groups[0].querySelector("[data-stripe-leading-shift]")).toBeNull();
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

  it("offsets the trailing CollapsedCluster icons instead of padding stripe-root", () => {
    // Regression: side stripe が bottom 角を取るとき、reserveEndPx を stripe
    // root の paddingBottom に入れると flex 配分域の高さが content (padding 無し)
    // とズレ、バンド/slot が下方向にズレる (#2)。reserveEndPx は trailing
    // CollapsedCluster の anchor 内 offset (bottom) として吸収し、stripe-root
    // 自身には padding を入れない。
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
    // stripe-root に padding を入れない (= flex 配分域 = content と同じ高さ)。
    expect(stripeRoot!.style.paddingBottom).toBe("");
    expect(stripeRoot!.style.paddingTop).toBe("");
    // trailing cluster の絶対配置子に bottom: 28 が乗っている。
    const cluster = container.querySelector<HTMLElement>(
      "[data-stripe-collapsed-cluster]",
    );
    expect(cluster).not.toBeNull();
    const overlay = cluster!.querySelector<HTMLElement>(".absolute");
    expect(overlay).not.toBeNull();
    expect(overlay!.style.bottom).toBe("28px");
  });

  it("offsets leading/trailing cluster overlays on the inline axis when horizontal", () => {
    // horizontal stripe (bottom region) では reserve は左右端 (leading=left,
    // trailing=right) の cluster overlay 内 offset に効く。stripe-root 自体には
    // padding は入らない。
    const segs: RegionSegment[] = [
      {
        key: "b0",
        slotId: "b0",
        sizeRatio: 1,
        open: false,
        panels: [{ id: "scenes", active: false }],
      },
      {
        key: "b1",
        slotId: "b1",
        sizeRatio: 1,
        open: true,
        panels: [{ id: "chat", active: true }],
      },
      {
        key: "b2",
        slotId: "b2",
        sizeRatio: 1,
        open: false,
        panels: [{ id: "timeline", active: false }],
      },
    ];
    const { container } = render(
      <RegionStripe
        region="bottom"
        orientation="horizontal"
        segments={segs}
        reserveStartPx={28}
        reserveEndPx={28}
      />,
    );
    const stripeRoot =
      container.querySelector<HTMLElement>("[data-stripe-root]");
    expect(stripeRoot!.style.paddingLeft).toBe("");
    expect(stripeRoot!.style.paddingRight).toBe("");
    const clusters = [
      ...container.querySelectorAll<HTMLElement>(
        "[data-stripe-collapsed-cluster]",
      ),
    ];
    expect(clusters.length).toBe(2);
    const leadingOverlay = clusters[0].querySelector<HTMLElement>(".absolute");
    const trailingOverlay = clusters[1].querySelector<HTMLElement>(".absolute");
    expect(leadingOverlay!.style.left).toBe("28px");
    expect(trailingOverlay!.style.right).toBe("28px");
  });

  it("offsets the first open band when reserveStartPx clears a corner toggle", () => {
    const leadingOpen: RegionSegment[] = [
      {
        key: "b0",
        slotId: "b0",
        sizeRatio: 1,
        open: true,
        panels: [{ id: "timeline", active: true }],
      },
    ];
    const { container } = render(
      <RegionStripe
        region="bottom"
        orientation="horizontal"
        segments={leadingOpen}
        reserveStartPx={28}
      />,
    );
    const openGroup = container.querySelector<HTMLElement>(
      "[data-drop-segment='b0']",
    );
    expect(openGroup).not.toBeNull();
    const shift = openGroup!.querySelector<HTMLElement>(
      "[data-stripe-leading-shift]",
    );
    expect(shift).not.toBeNull();
    expect(parseFloat(shift!.style.left)).toBe(28);
  });

  it("includes reserveStartPx in the first open band shift after a leading collapsed cluster", () => {
    const leadingCollapsed: RegionSegment[] = [
      {
        key: "b0",
        slotId: "b0",
        sizeRatio: 1,
        open: false,
        panels: [{ id: "scenes", active: false }],
      },
      {
        key: "b1",
        slotId: "b1",
        sizeRatio: 1,
        open: true,
        panels: [{ id: "chat", active: true }],
      },
    ];
    const { container } = render(
      <RegionStripe
        region="bottom"
        orientation="horizontal"
        segments={leadingCollapsed}
        reserveStartPx={28}
      />,
    );
    const openGroup = container.querySelector<HTMLElement>(
      "[data-drop-segment='b1']",
    );
    expect(openGroup).not.toBeNull();
    const shift = openGroup!.querySelector<HTMLElement>(
      "[data-stripe-leading-shift]",
    );
    expect(shift).not.toBeNull();
    // 1 collapsed icon span (28 + 4) + corner clearance (28).
    expect(parseFloat(shift!.style.left)).toBe(60);
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
