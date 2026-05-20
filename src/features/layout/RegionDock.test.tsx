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
        bottomRowInset={0}
      />,
    );
    expect(
      container.querySelector('[data-region-stripe-column="left"]'),
    ).toBeTruthy();
    expect(container.querySelector("[data-stripe-root]")).toBeTruthy();
    expect(container.querySelector("[data-region-content]")).toBeNull();
  });
});
