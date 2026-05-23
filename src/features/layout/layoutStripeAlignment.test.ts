import { describe, it, expect } from "vitest";
import { stripeTrackInsetStyle } from "./layoutStripeAlignment";

describe("stripeTrackInsetStyle", () => {
  it("returns undefined when no inset is requested", () => {
    expect(
      stripeTrackInsetStyle({ orientation: "vertical", insetEndPx: 0 }),
    ).toBeUndefined();
  });

  it("maps vertical stripe reserve to top/bottom padding", () => {
    expect(
      stripeTrackInsetStyle({
        orientation: "vertical",
        insetEndPx: 28,
      }),
    ).toEqual({ paddingBottom: 28 });
  });

  it("maps horizontal stripe reserve to left/right padding", () => {
    expect(
      stripeTrackInsetStyle({
        orientation: "horizontal",
        insetStartPx: 12,
        insetEndPx: 28,
      }),
    ).toEqual({ paddingLeft: 12, paddingRight: 28 });
  });
});
