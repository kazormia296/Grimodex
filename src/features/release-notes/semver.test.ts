import { describe, it, expect } from "vitest";
import { compareSemver, isNewer } from "./semver";

describe("compareSemver", () => {
  it("compares patch segments", () => {
    expect(compareSemver("0.10.3", "0.10.4")).toBe(-1);
    expect(compareSemver("0.10.4", "0.10.3")).toBe(1);
  });

  it("compares minor and major", () => {
    expect(compareSemver("0.9.0", "0.10.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
  });

  it("returns 0 for equal versions", () => {
    expect(compareSemver("0.10.4", "0.10.4")).toBe(0);
  });
});

describe("isNewer", () => {
  it("returns false when lastSeen is null or undefined", () => {
    expect(isNewer("0.10.4", null)).toBe(false);
    expect(isNewer("0.10.4", undefined)).toBe(false);
    expect(isNewer("0.10.4", "")).toBe(false);
  });

  it("returns true when current is newer", () => {
    expect(isNewer("0.10.4", "0.10.3")).toBe(true);
  });

  it("returns false when current is same or older", () => {
    expect(isNewer("0.10.4", "0.10.4")).toBe(false);
    expect(isNewer("0.10.3", "0.10.4")).toBe(false);
  });
});
