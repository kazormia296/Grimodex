// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { RegionResizeSplitter } from "./RegionResizeSplitter";
import { useLayoutStore } from "./layoutStore";

describe("RegionResizeSplitter", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layoutLocked: false,
      layout: useLayoutStore.getState().layout,
    });
  });

  it("inverts vertical drag delta for bottom region resize", () => {
    const nudge = vi.fn();
    useLayoutStore.setState({ nudgeRegionSize: nudge });

    const { container } = render(<RegionResizeSplitter region="bottom" />);
    const splitter = container.querySelector(
      '[role="separator"]',
    ) as HTMLElement;

    fireEvent.pointerDown(splitter, { clientY: 200, pointerId: 1 });
    fireEvent(
      window,
      new PointerEvent("pointermove", { clientY: 220, pointerId: 1 }),
    );
    fireEvent(
      window,
      new PointerEvent("pointerup", { clientY: 220, pointerId: 1 }),
    );

    expect(nudge).toHaveBeenCalled();
    const lastCall = nudge.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("bottom");
    expect(lastCall?.[1]).toBe(-20);
  });
});
