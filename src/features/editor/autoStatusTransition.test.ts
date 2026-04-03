import { describe, it, expect } from "vitest";
import { shouldAutoDraftTransition } from "./autoStatusTransition";

describe("shouldAutoDraftTransition", () => {
  it("returns true when scene was empty, now has content, and status is outline", () => {
    expect(shouldAutoDraftTransition(5, true, "outline")).toBe(true);
  });

  it("returns false when scene was not empty", () => {
    expect(shouldAutoDraftTransition(5, false, "outline")).toBe(false);
  });

  it("returns false when new charCount is still 0", () => {
    expect(shouldAutoDraftTransition(0, true, "outline")).toBe(false);
  });

  it("returns false when status is null (no status set)", () => {
    expect(shouldAutoDraftTransition(5, true, null)).toBe(false);
  });

  it("returns false when status is draft (already promoted)", () => {
    expect(shouldAutoDraftTransition(5, true, "draft")).toBe(false);
  });

  it("returns false when status is complete", () => {
    expect(shouldAutoDraftTransition(5, true, "complete")).toBe(false);
  });

  it("returns false when status is revision", () => {
    expect(shouldAutoDraftTransition(5, true, "revision")).toBe(false);
  });

  it("returns false when status is final", () => {
    expect(shouldAutoDraftTransition(5, true, "final")).toBe(false);
  });

  it("triggers with count=1 (single character typed into empty scene)", () => {
    expect(shouldAutoDraftTransition(1, true, "outline")).toBe(true);
  });
});
