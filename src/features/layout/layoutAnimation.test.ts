import { describe, expect, it } from "vitest";
import { REGION_CLIP_PATH, REGION_TRANSFORM_ORIGIN } from "./layoutAnimation";

describe("layoutAnimation", () => {
  it("defines clip paths and transform origins for each region chrome", () => {
    expect(REGION_CLIP_PATH.left.open).toContain("inset(");
    expect(REGION_CLIP_PATH.left.closed).toContain("inset(");
    expect(REGION_TRANSFORM_ORIGIN.bottom).toBe("bottom center");
  });
});
