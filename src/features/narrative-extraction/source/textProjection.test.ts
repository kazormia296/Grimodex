import { describe, expect, it } from "vitest";
import { serializeProseMirrorDocument } from "./proseMirrorSerializer";
import { projectCanonicalRange } from "./textProjection";

interface ProseMirrorJsonNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorJsonNode[];
}

function documentWith(...content: ProseMirrorJsonNode[]): string {
  return JSON.stringify({ type: "doc", content });
}

function paragraph(...content: ProseMirrorJsonNode[]): ProseMirrorJsonNode {
  return { type: "paragraph", content };
}

function text(value: string): ProseMirrorJsonNode {
  return { type: "text", text: value };
}

function serializeSuccessfully(input: string) {
  const result = serializeProseMirrorDocument(input);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(`expected serialization to succeed: ${result.diagnostics}`);
  }
  return result.canonical;
}

describe("projectCanonicalRange", () => {
  it("projects an ordinary text range exactly in UTF-16 coordinates", () => {
    const canonical = serializeSuccessfully(
      documentWith(paragraph(text("A\u{1F600}B"))),
    );

    expect(
      projectCanonicalRange(canonical.projectionMap, { start: 1, end: 3 }),
    ).toEqual({
      status: "exact",
      fragments: [
        {
          canonicalStart: 1,
          canonicalEnd: 3,
          from: 2,
          to: 4,
          kind: "linear",
        },
      ],
    });
  });

  it("returns unmapped for a synthetic block separator by itself", () => {
    const canonical = serializeSuccessfully(
      documentWith(paragraph(text("ab")), paragraph(text("cd"))),
    );
    expect(canonical.text).toBe("ab\ncd");

    expect(
      projectCanonicalRange(canonical.projectionMap, { start: 2, end: 3 }),
    ).toEqual({
      status: "unmapped",
      fragments: [],
    });
  });

  it("projects a paragraph-spanning range as fragments plus an enclosing PM range", () => {
    const canonical = serializeSuccessfully(
      documentWith(paragraph(text("ab")), paragraph(text("cd"))),
    );

    expect(
      projectCanonicalRange(canonical.projectionMap, { start: 1, end: 4 }),
    ).toEqual({
      status: "fragmented",
      fragments: [
        {
          canonicalStart: 1,
          canonicalEnd: 2,
          from: 2,
          to: 3,
          kind: "linear",
        },
        {
          canonicalStart: 3,
          canonicalEnd: 4,
          from: 5,
          to: 6,
          kind: "linear",
        },
      ],
      enclosingRange: { from: 2, to: 6 },
    });
  });

  it("marks a CRLF-normalized LF fragment as transformed", () => {
    const canonical = serializeSuccessfully(
      documentWith(paragraph(text("A\r\nB"))),
    );
    expect(canonical.text).toBe("A\nB");

    expect(
      projectCanonicalRange(canonical.projectionMap, { start: 1, end: 2 }),
    ).toEqual({
      status: "exact",
      fragments: [
        {
          canonicalStart: 1,
          canonicalEnd: 2,
          from: 2,
          to: 4,
          kind: "transformed",
        },
      ],
    });
  });

  it("projects a ruby base to its single atomic ProseMirror node", () => {
    const canonical = serializeSuccessfully(
      documentWith(
        paragraph(
          text("A"),
          {
            type: "ruby",
            attrs: { base: "漢字", annotation: "かんじ" },
          },
          text("B"),
        ),
      ),
    );
    expect(canonical.text).toBe("A漢字B");

    expect(
      projectCanonicalRange(canonical.projectionMap, { start: 1, end: 3 }),
    ).toEqual({
      status: "exact",
      fragments: [
        {
          canonicalStart: 1,
          canonicalEnd: 3,
          from: 2,
          to: 3,
          kind: "atomic",
        },
      ],
    });
  });
});
