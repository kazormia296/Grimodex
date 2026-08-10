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

  it("fails closed when a persisted projection map contains overlaps", () => {
    const canonical = serializeSuccessfully(
      documentWith(paragraph(text("abcd"))),
    );
    const first = canonical.projection.segments[0];
    expect(first).toBeDefined();
    if (!first) return;

    expect(
      projectCanonicalRange(
        {
          ...canonical.projection,
          segments: [first, { ...first }],
        },
        { start: 0, end: 2 },
      ),
    ).toEqual({ status: "unmapped", fragments: [] });
  });

  it("fails closed for unknown, incomplete, or PM-reversing segments", () => {
    const canonical = serializeSuccessfully(
      documentWith(
        paragraph(
          text("A"),
          { type: "ruby", attrs: { base: "B", annotation: "b" } },
          text("C"),
        ),
      ),
    );
    const baseMap = canonical.projection;
    const unknownKind = {
      ...baseMap,
      segments: [{ ...baseMap.segments[0], kind: "future-kind" }],
    } as never;
    const missingCanonical = {
      ...baseMap,
      segments: [{ kind: "linear", canonicalStart: 0, canonicalEnd: 1 }],
    } as never;
    const reversing = JSON.parse(JSON.stringify(baseMap)) as typeof baseMap;
    const second = reversing.segments[1];
    if (second && second.kind !== "synthetic-boundary") {
      Object.assign(second, {
        from: 0,
        to: 1,
        source: { kind: "prosemirror", fromPos: 0, toPos: 1 },
      });
    }

    for (const map of [unknownKind, missingCanonical, reversing]) {
      expect(() =>
        projectCanonicalRange(map, { start: 0, end: 1 }),
      ).not.toThrow();
      expect(projectCanonicalRange(map, { start: 0, end: 1 })).toEqual({
        status: "unmapped",
        fragments: [],
      });
    }
  });

  it("reuses validation for a deeply frozen projection map", () => {
    const canonical = serializeSuccessfully(
      documentWith(
        ...Array.from({ length: 64 }, (_, index) =>
          paragraph(text(String.fromCharCode(65 + (index % 26)))),
        ),
      ),
    );
    const lastIndex = canonical.projection.segments.length - 1;
    let lastSegmentReads = 0;
    const segments = new Proxy(canonical.projection.segments, {
      get(target, property, receiver) {
        if (property === String(lastIndex)) lastSegmentReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const map = Object.freeze({ ...canonical.projection, segments });

    expect(projectCanonicalRange(map, { start: 0, end: 1 }).status).toBe(
      "exact",
    );
    expect(lastSegmentReads).toBeGreaterThan(0);
    lastSegmentReads = 0;

    expect(projectCanonicalRange(map, { start: 0, end: 1 }).status).toBe(
      "exact",
    );
    expect(lastSegmentReads).toBe(0);
  });
});
