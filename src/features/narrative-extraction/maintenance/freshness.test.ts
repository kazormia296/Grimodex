import { describe, expect, it } from "vitest";
import { classifyRangeImpact } from "./freshness";
import type { Utf16Range } from "./rangeImpact";

const evidenceRange: Utf16Range = { from: 100, to: 120 };
const contextRange: Utf16Range = { from: 50, to: 170 };

describe("classifyRangeImpact", () => {
  it("returns fresh when no changed range touches the context", () => {
    const changedRanges: Utf16Range[] = [{ from: 500, to: 520 }];

    expect(
      classifyRangeImpact({ evidenceRange, contextRange, changedRanges }),
    ).toBe("fresh");
  });

  it("returns content-stale when a changed range overlaps the evidence itself", () => {
    const changedRanges: Utf16Range[] = [{ from: 110, to: 115 }];

    expect(
      classifyRangeImpact({ evidenceRange, contextRange, changedRanges }),
    ).toBe("content-stale");
  });

  it("returns context-stale when a changed range overlaps context but not evidence", () => {
    const changedRanges: Utf16Range[] = [{ from: 60, to: 70 }];

    expect(
      classifyRangeImpact({ evidenceRange, contextRange, changedRanges }),
    ).toBe("context-stale");
  });

  it("returns reanchorable when evidence shifted without any overlap", () => {
    const changedRanges: Utf16Range[] = [{ from: 0, to: 10 }];

    expect(
      classifyRangeImpact({
        evidenceRange,
        contextRange,
        changedRanges,
        shiftedWithoutOverlap: true,
      }),
    ).toBe("reanchorable");
  });

  it("prefers content-stale over reanchorable when evidence itself overlaps a change", () => {
    const changedRanges: Utf16Range[] = [{ from: 105, to: 110 }];

    expect(
      classifyRangeImpact({
        evidenceRange,
        contextRange,
        changedRanges,
        shiftedWithoutOverlap: true,
      }),
    ).toBe("content-stale");
  });

  it("treats touching (non-overlapping) ranges as not overlapping", () => {
    const changedRanges: Utf16Range[] = [{ from: 120, to: 130 }];

    expect(
      classifyRangeImpact({ evidenceRange, contextRange, changedRanges }),
    ).toBe("context-stale");
  });
});
