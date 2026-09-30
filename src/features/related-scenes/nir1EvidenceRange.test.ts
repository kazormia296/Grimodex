import { describe, expect, it } from "vitest";
import { resolveNir1EvidenceRange } from "./nir1EvidenceRange";

function documentWith(...paragraphs: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  });
}

function resolve(documentJson: string, fullQuote: string) {
  return resolveNir1EvidenceRange({
    documentJson,
    fullQuote,
    normalizerVersion: "gdx-canonical-text/1",
  });
}

describe("NIR-1 canonical Evidence range", () => {
  it("uses the whole quote when the first 60 characters also occur earlier", () => {
    const prefix = "p".repeat(60);
    const first = `${prefix} wrong`;
    const quote = `${prefix} correct`;
    expect(resolve(documentWith(first, quote), quote)).toEqual({
      status: "highlight",
      canonicalRange: {
        start: first.length + 1,
        end: first.length + 1 + quote.length,
      },
      selection: {
        from: first.length + 3,
        to: first.length + 3 + quote.length,
      },
    });
  });

  it("does not pick the first occurrence of a duplicate full quote", () => {
    expect(resolve(documentWith("same", "same"), "same")).toEqual({
      status: "scene-only",
      reason: "ambiguous-quote",
    });
  });

  it("detects overlapping duplicate occurrences", () => {
    expect(resolve(documentWith("ababa"), "aba")).toEqual({
      status: "scene-only",
      reason: "ambiguous-quote",
    });
  });

  it("maps a unique multi-paragraph quote through canonical boundaries", () => {
    expect(resolve(documentWith("ab", "cd"), "b\nc")).toEqual({
      status: "highlight",
      canonicalRange: { start: 1, end: 4 },
      selection: { from: 2, to: 6 },
    });
  });

  it("uses UTF-16 positions for complete non-BMP characters", () => {
    expect(resolve(documentWith("A😀B"), "😀")).toEqual({
      status: "highlight",
      canonicalRange: { start: 1, end: 3 },
      selection: { from: 2, to: 4 },
    });
  });

  it("maps normalized LF to the whole original CRLF", () => {
    expect(resolve(documentWith("A\r\nB"), "\n")).toEqual({
      status: "highlight",
      canonicalRange: { start: 1, end: 2 },
      selection: { from: 2, to: 4 },
    });
  });

  it("keeps a synthetic separator-only quote at scene level", () => {
    expect(resolve(documentWith("ab", "cd"), "\n")).toEqual({
      status: "scene-only",
      reason: "unmapped-quote",
    });
  });

  it.each(["\ncd", "ab\n"])(
    "keeps a quote with an unmapped synthetic endpoint at scene level: %j",
    (quote) => {
      expect(resolve(documentWith("ab", "cd"), quote)).toEqual({
        status: "scene-only",
        reason: "unmapped-quote",
      });
    },
  );

  it("cancels when the complete quote is no longer in the source", () => {
    expect(resolve(documentWith("present"), "absent")).toEqual({
      status: "cancel",
      reason: "missing-quote",
    });
  });

  it.each(["", "\ud800"])("rejects an invalid quote %j", (quote) => {
    expect(resolve(documentWith("present"), quote)).toEqual({
      status: "cancel",
      reason: "invalid-quote",
    });
  });

  it.each(["{", JSON.stringify({ type: "unsupported" })])(
    "cancels invalid or unsupported persisted source",
    (documentJson) => {
      expect(resolve(documentJson, "source")).toEqual({
        status: "cancel",
        reason: "invalid-source",
      });
    },
  );

  it("does not invent a mapping for an unsupported normalizer", () => {
    expect(
      resolveNir1EvidenceRange({
        documentJson: documentWith("source"),
        fullQuote: "source",
        normalizerVersion: "future-normalizer/2",
      }),
    ).toEqual({ status: "scene-only", reason: "unsupported-normalizer" });
  });
});
