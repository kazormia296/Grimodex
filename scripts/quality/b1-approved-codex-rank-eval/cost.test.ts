import { describe, expect, it } from "vitest";
import { assertWithinCap, estimateCost } from "./cost";
describe("B1 cost estimate", () => {
  it("uses the two published rates and blocks over-cap runs", () => {
    expect(estimateCost("claude-haiku-5-5", 1_000_000, 1_000_000)).toBe(0.6);
    expect(estimateCost("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBe(12);
    expect(() => assertWithinCap(3)).not.toThrow();
    expect(() => assertWithinCap(3.01)).toThrow();
  });
});
