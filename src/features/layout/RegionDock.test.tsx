// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { SideRegionStripeColumn } from "./RegionDock";
import { useLayoutStore } from "./layoutStore";

const leftSegments = [
  {
    key: "l0",
    slotId: "l0",
    sizeRatio: 1,
    open: true,
    panels: [{ id: "scenes" as const, active: true }],
  },
];

describe("SideRegionStripeColumn", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: useLayoutStore.getState().layout,
    });
    useLayoutStore.getState().showPanel("scenes");
  });

  it("renders stripe icons in a full-height side column", () => {
    const { container } = render(
      <SideRegionStripeColumn
        region="left"
        stripeOrientation="vertical"
        segments={leftSegments}
      />,
    );
    expect(
      container.querySelector('[data-region-stripe-column="left"]'),
    ).toBeTruthy();
    expect(container.querySelector("[data-stripe-root]")).toBeTruthy();
    expect(container.querySelector("[data-region-content]")).toBeNull();
  });

  it("forwards reserveEndPx to the inner stripe for the corner toggle", () => {
    // side stripe が bottom 角を取るとき、LayoutShell 側で
    // BOTTOM_CORNER_TOGGLE_CLEARANCE_PX を渡す。column コンポーネントが
    // 落とすと、trailing collapsed cluster と toggle が重なる回帰になる。
    // 末尾に collapsed slot を置いて trailing cluster の overlay offset で
    // reserveEndPx が反映されることを確認する (stripe-root には padding を
    // 入れない — そうすると content と flex 配分域がズレるため)。
    const segmentsWithTrailing = [
      ...leftSegments,
      {
        key: "l1",
        slotId: "l1",
        sizeRatio: 1,
        open: false,
        panels: [{ id: "codex-quick" as const, active: false }],
      },
    ];
    const { container } = render(
      <SideRegionStripeColumn
        region="left"
        stripeOrientation="vertical"
        segments={segmentsWithTrailing}
        reserveEndPx={28}
      />,
    );
    const stripeRoot =
      container.querySelector<HTMLElement>("[data-stripe-root]");
    expect(stripeRoot).not.toBeNull();
    expect(stripeRoot!.style.paddingBottom).toBe("");
    const cluster = container.querySelector<HTMLElement>(
      "[data-stripe-collapsed-cluster]",
    );
    const overlay = cluster?.querySelector<HTMLElement>(".absolute");
    expect(overlay).not.toBeNull();
    expect(overlay!.style.bottom).toBe("32px");
  });

  it("omits trailing padding when no reserve is requested", () => {
    const { container } = render(
      <SideRegionStripeColumn
        region="left"
        stripeOrientation="vertical"
        segments={leftSegments}
      />,
    );
    const stripeRoot =
      container.querySelector<HTMLElement>("[data-stripe-root]");
    expect(stripeRoot!.style.paddingBottom).toBe("");
  });
});
