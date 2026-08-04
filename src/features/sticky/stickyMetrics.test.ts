import { describe, expect, it } from "vitest";
import { getStickyMetrics } from "./stickyMetrics";

describe("sticky metrics", () => {
  it("scales the paper and its maximum body height with editor font size", () => {
    expect(getStickyMetrics(20)).toEqual({
      width: 250,
      minHeight: 65,
      maxHeight: 600,
      paddingInline: 15,
      paddingBlock: 15,
    });
  });

  it("keeps a usable minimum for compact editor fonts", () => {
    expect(getStickyMetrics(12)).toEqual({
      width: 160,
      minHeight: 52,
      maxHeight: 480,
      paddingInline: 9,
      paddingBlock: 9,
    });
  });
});
