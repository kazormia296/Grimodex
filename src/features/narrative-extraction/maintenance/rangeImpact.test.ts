import { describe, expect, it } from "vitest";
import {
  computeReanchorCandidate,
  computeReanchorCandidateResult,
  rangesOverlap,
  type Utf16Range,
} from "./rangeImpact";

describe("rangesOverlap", () => {
  it("returns true for overlapping ranges", () => {
    expect(rangesOverlap({ from: 0, to: 10 }, { from: 5, to: 15 })).toBe(true);
  });

  it("returns false for touching (adjacent) ranges", () => {
    expect(rangesOverlap({ from: 0, to: 10 }, { from: 10, to: 20 })).toBe(
      false,
    );
  });

  it("returns false for disjoint ranges", () => {
    expect(rangesOverlap({ from: 0, to: 10 }, { from: 20, to: 30 })).toBe(
      false,
    );
  });

  it("rejects malformed UTF-16 ranges", () => {
    expect(() =>
      rangesOverlap({ from: -1, to: 10 }, { from: 0, to: 4 }),
    ).toThrow(RangeError);
  });
});

describe("computeReanchorCandidate", () => {
  const oldRange: Utf16Range = { from: 10, to: 16 };
  const quote = "quick.";

  it("prefers the position-map method when it maps the old range to a matching quote", () => {
    const documentText = "The lazy fox jumped quick. Then it ran.";
    const newRange: Utf16Range = { from: 20, to: 26 };
    expect(documentText.slice(newRange.from, newRange.to)).toBe(quote);

    const candidate = computeReanchorCandidate({
      quote,
      oldRange,
      documentText,
      positionMap: {
        mapRange: (range) => (range === oldRange ? newRange : null),
      },
    });

    expect(candidate).toEqual({
      method: "position-map",
      range: newRange,
      confidence: "high",
    });
  });

  it("does not fall back to a fuzzy match when the position map produces a mismatched quote", () => {
    // Quote is far outside the default nearby-search radius of `oldRange`,
    // so a correct implementation must skip straight to document-exact
    // rather than guessing at the (non-matching) position-map result.
    const documentText = `${"H".repeat(10)}${"x".repeat(300)}${quote}tail`;

    const candidate = computeReanchorCandidate({
      quote,
      oldRange,
      documentText,
      positionMap: {
        mapRange: () => ({ from: 0, to: 6 }), // "HHHHHH" !== "quick."
      },
    });

    expect(candidate?.method).toBe("document-exact");
    expect(candidate?.confidence).toBe("low");
  });

  it("returns null (ambiguous) when the quote occurs multiple times and no position map resolves it", () => {
    const documentText = "quick. Somewhere later, quick. appears again.";

    const candidate = computeReanchorCandidate({
      quote,
      oldRange,
      documentText,
    });

    expect(candidate).toBeNull();
    expect(
      computeReanchorCandidateResult({ quote, oldRange, documentText }).status,
    ).toBe("ambiguous");
  });

  it("returns null (not-found) when the quote does not appear anywhere", () => {
    const documentText = "Nothing relevant is in here at all.";

    const candidate = computeReanchorCandidate({
      quote,
      oldRange,
      documentText,
    });

    expect(candidate).toBeNull();
    expect(
      computeReanchorCandidateResult({ quote, oldRange, documentText }).status,
    ).toBe("not-found");
  });

  it("falls back to nearby-exact when there is a unique match within the search radius", () => {
    const documentText = `${"x".repeat(500)}quick.${"y".repeat(500)}`;
    const candidate = computeReanchorCandidate({
      quote,
      oldRange: { from: 495, to: 501 },
      documentText,
      nearbyRadius: 50,
    });

    expect(candidate?.method).toBe("nearby-exact");
    expect(candidate?.confidence).toBe("medium");
  });

  it("uses UTF-16 code units for astral characters", () => {
    const emojiQuote = "🧝";
    const candidate = computeReanchorCandidate({
      quote: emojiQuote,
      oldRange: { from: 0, to: 2 },
      documentText: `ab${emojiQuote}cd`,
    });

    expect(candidate?.range).toEqual({ from: 2, to: 4 });
  });

  it("rejects empty quotes and inconsistent old ranges", () => {
    expect(() =>
      computeReanchorCandidate({
        quote: "",
        oldRange: { from: 0, to: 0 },
        documentText: "text",
      }),
    ).toThrow("quote must not be empty");
    expect(() =>
      computeReanchorCandidate({
        quote,
        oldRange: { from: 0, to: 5 },
        documentText: quote,
      }),
    ).toThrow("oldRange length must equal the UTF-16 quote length");
  });

  it("rejects an invalid range returned by a position map", () => {
    expect(() =>
      computeReanchorCandidate({
        quote,
        oldRange,
        documentText: quote,
        positionMap: { mapRange: () => ({ from: 0, to: 99 }) },
      }),
    ).toThrow("mapped range exceeds the UTF-16 document length");
  });
});
