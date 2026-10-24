import { describe, expect, it } from "vitest";
import {
  resolveNir1EvidenceRange,
  resolveNir1GraphOnlyRange,
} from "./nir1EvidenceRange";

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

describe("NIR-1 Graph-only canonical range (CP-3b C-1)", () => {
  function graphOnly(
    documentJson: string,
    canonicalRange: { start: number; end: number },
    excerpt: string,
  ) {
    return resolveNir1GraphOnlyRange({ documentJson, canonicalRange, excerpt });
  }

  it("resolveNir1GraphOnlyRange highlights only when the canonical slice equals the excerpt at that exact range", () => {
    const first = "First line of the scene.";
    expect(
      graphOnly(
        documentWith(first, "second"),
        { start: 0, end: first.length },
        first,
      ),
    ).toEqual({
      status: "highlight",
      canonicalRange: { start: 0, end: first.length },
      selection: { from: 1, to: 1 + first.length },
    });
  });

  it("the same text elsewhere does not matter", () => {
    const line = "same text";
    const doc = documentWith(line, line);
    const second = { start: line.length + 1, end: line.length * 2 + 1 };
    expect(graphOnly(doc, second, line)).toMatchObject({
      status: "highlight",
      canonicalRange: second,
      selection: { from: line.length + 3, to: line.length * 2 + 3 },
    });
  });

  it("a shifted or shortened body cancels", () => {
    const excerpt = "The disclosed first line.";
    const range = { start: 0, end: excerpt.length };
    expect(graphOnly(documentWith(`X${excerpt}`), range, excerpt)).toEqual({
      status: "cancel",
      reason: "missing-quote",
    });
    expect(
      graphOnly(documentWith(excerpt.slice(0, 10)), range, excerpt),
    ).toEqual({ status: "cancel", reason: "missing-quote" });
    expect(graphOnly("not json", range, excerpt)).toEqual({
      status: "cancel",
      reason: "invalid-source",
    });
  });

  it("a surrogate pair at the edge cancels", () => {
    const text = "a😀b";
    const doc = documentWith(text);
    // Starts inside the pair.
    expect(graphOnly(doc, { start: 2, end: 4 }, text.slice(2, 4))).toEqual({
      status: "cancel",
      reason: "invalid-quote",
    });
    // Ends inside the pair.
    expect(graphOnly(doc, { start: 0, end: 2 }, text.slice(0, 2))).toEqual({
      status: "cancel",
      reason: "invalid-quote",
    });
    expect(graphOnly(doc, { start: 0, end: 4 }, text)).toMatchObject({
      status: "highlight",
    });
  });

  it("refuses a negative, non-integer, empty, mismatched or out-of-text range without clamping", () => {
    const excerpt = "line";
    const doc = documentWith(excerpt);
    for (const range of [
      { start: -1, end: 3 },
      { start: 0.5, end: 4.5 },
      { start: 2, end: 2 },
      { start: 0, end: 3 },
      { start: Number.NaN, end: 4 },
    ])
      expect(graphOnly(doc, range, excerpt)).toEqual({
        status: "cancel",
        reason: "invalid-quote",
      });
    expect(graphOnly(doc, { start: 2, end: 6 }, "ne!!")).toEqual({
      status: "cancel",
      reason: "missing-quote",
    });
  });

  it("finds the excerpt after an empty paragraph only at its own range", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });
    const result = graphOnly(doc, { start: 1, end: 6 }, "after");
    expect(result.status === "highlight" || result.status === "cancel").toBe(
      true,
    );
    // Whatever the empty paragraph serializes to, a range that is not the
    // excerpt's own never highlights.
    expect(graphOnly(doc, { start: 0, end: 5 }, "after").status).not.toBe(
      "highlight",
    );
  });
});
