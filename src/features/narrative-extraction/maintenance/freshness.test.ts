import { describe, expect, it } from "vitest";
import { classifyRangeImpact } from "./freshness";
import type { Utf16Range } from "./rangeImpact";

const evidenceRange: Utf16Range = { from: 100, to: 120 };
const contextRange: Utf16Range = { from: 50, to: 170 };

describe("classifyRangeImpact", () => {
  it("returns fresh when no changed range touches the context", () => {
    const changedOldRanges: Utf16Range[] = [{ from: 500, to: 520 }];

    expect(
      classifyRangeImpact({ evidenceRange, contextRange, changedOldRanges }),
    ).toBe("fresh");
  });

  it("returns content-stale when a changed range overlaps the evidence itself", () => {
    const changedOldRanges: Utf16Range[] = [{ from: 110, to: 115 }];

    expect(
      classifyRangeImpact({ evidenceRange, contextRange, changedOldRanges }),
    ).toBe("content-stale");
  });

  it("returns context-stale when a changed range overlaps context but not evidence", () => {
    const changedOldRanges: Utf16Range[] = [{ from: 60, to: 70 }];

    expect(
      classifyRangeImpact({ evidenceRange, contextRange, changedOldRanges }),
    ).toBe("context-stale");
  });

  it("returns reanchorable when evidence shifted without any overlap", () => {
    const changedOldRanges: Utf16Range[] = [{ from: 0, to: 10 }];

    expect(
      classifyRangeImpact({
        evidenceRange,
        contextRange,
        changedOldRanges,
        shiftedWithoutOverlap: true,
      }),
    ).toBe("reanchorable");
  });

  it("prefers content-stale over reanchorable when evidence itself overlaps a change", () => {
    const changedOldRanges: Utf16Range[] = [{ from: 105, to: 110 }];

    expect(
      classifyRangeImpact({
        evidenceRange,
        contextRange,
        changedOldRanges,
        shiftedWithoutOverlap: true,
      }),
    ).toBe("content-stale");
  });

  it("prefers context-stale when context changed even if the quote can move exactly", () => {
    expect(
      classifyRangeImpact({
        evidenceRange,
        contextRange,
        changedOldRanges: [{ from: 60, to: 70 }],
        shiftedWithoutOverlap: true,
      }),
    ).toBe("context-stale");
  });

  it("treats touching (non-overlapping) ranges as not overlapping", () => {
    const changedOldRanges: Utf16Range[] = [{ from: 120, to: 130 }];

    expect(
      classifyRangeImpact({ evidenceRange, contextRange, changedOldRanges }),
    ).toBe("context-stale");
  });

  it("treats a whole-document impact as content-stale", () => {
    expect(
      classifyRangeImpact({
        evidenceRange,
        contextRange,
        changedOldRanges: [],
        wholeDocumentChanged: true,
      }),
    ).toBe("content-stale");
  });

  it("rejects malformed ranges and contexts that do not contain the evidence", () => {
    expect(() =>
      classifyRangeImpact({
        evidenceRange: { from: 120, to: 100 },
        contextRange,
        changedOldRanges: [],
      }),
    ).toThrow(RangeError);
    expect(() =>
      classifyRangeImpact({
        evidenceRange,
        contextRange: { from: 110, to: 170 },
        changedOldRanges: [],
      }),
    ).toThrow("contextRange must contain evidenceRange");
  });
});
