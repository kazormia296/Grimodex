import { describe, it, expect } from "vitest";
import { nextSearchResultIndex } from "./searchResultSelection";

describe("nextSearchResultIndex", () => {
  it("returns null when there are no results", () => {
    expect(nextSearchResultIndex(0, "down", 0)).toBeNull();
    expect(nextSearchResultIndex(0, "up", 0)).toBeNull();
  });

  it("clamps ArrowDown at the last result", () => {
    expect(nextSearchResultIndex(0, "down", 3)).toBe(1);
    expect(nextSearchResultIndex(2, "down", 3)).toBe(2);
  });

  it("clamps ArrowUp at zero", () => {
    expect(nextSearchResultIndex(2, "up", 3)).toBe(1);
    expect(nextSearchResultIndex(0, "up", 3)).toBe(0);
  });
});
