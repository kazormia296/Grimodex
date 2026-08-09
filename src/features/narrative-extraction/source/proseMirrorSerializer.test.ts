import { describe, expect, it } from "vitest";
import { serializeProseMirrorDocument } from "./proseMirrorSerializer";

interface ProseMirrorJsonNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{
    type: string;
    attrs?: Record<string, unknown>;
  }>;
  content?: ProseMirrorJsonNode[];
}

function documentWith(...content: ProseMirrorJsonNode[]): string {
  return JSON.stringify({ type: "doc", content });
}

function paragraph(...content: ProseMirrorJsonNode[]): ProseMirrorJsonNode {
  return { type: "paragraph", content };
}

function text(
  value: string,
  marks?: ProseMirrorJsonNode["marks"],
): ProseMirrorJsonNode {
  return {
    type: "text",
    text: value,
    ...(marks ? { marks } : {}),
  };
}

function serializeSuccessfully(input: string) {
  const result = serializeProseMirrorDocument(input);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(`expected serialization to succeed: ${result.diagnostics}`);
  }
  return result.canonical;
}

function expectFailClosed(input: string): void {
  const result = serializeProseMirrorDocument(input);
  expect(result).toMatchObject({ ok: false });
  if (result.ok) {
    throw new Error("expected serialization to fail closed");
  }
  expect(result.diagnostics.length).toBeGreaterThan(0);
}

describe("serializeProseMirrorDocument", () => {
  it("preserves UTF-16 text without trimming, NFC normalization, or whitespace collapse", () => {
    const source = "  e\u0301  A\tB  ";

    const canonical = serializeSuccessfully(
      documentWith(paragraph(text(source))),
    );

    expect(canonical.text).toBe(source);
    expect(canonical.text).not.toBe(source.normalize("NFC"));
  });

  it("normalizes CRLF and lone CR to LF and makes no other text change", () => {
    const canonical = serializeSuccessfully(
      documentWith(paragraph(text("A\r\nB\rC\nD"))),
    );

    expect(canonical.text).toBe("A\nB\nC\nD");
  });

  it("joins blocks with one LF, preserves empty blocks, and omits a trailing LF", () => {
    const canonical = serializeSuccessfully(
      documentWith(
        paragraph(text("first")),
        paragraph(),
        paragraph(text("last")),
      ),
    );

    expect(canonical.text).toBe("first\n\nlast");
    expect(canonical.text.endsWith("\n")).toBe(false);
  });

  it("serializes a hardBreak as LF without adding surrounding spaces", () => {
    const canonical = serializeSuccessfully(
      documentWith(
        paragraph(text("before"), { type: "hardBreak" }, text("after")),
      ),
    );

    expect(canonical.text).toBe("before\nafter");
  });

  it("serializes only a ruby atom's base text", () => {
    const canonical = serializeSuccessfully(
      documentWith(
        paragraph(
          text("前"),
          {
            type: "ruby",
            attrs: { base: "漢字", annotation: "かんじ" },
          },
          text("後"),
        ),
      ),
    );

    expect(canonical.text).toBe("前漢字後");
    expect(canonical.text).not.toContain("かんじ");
  });

  it("ignores marks when deriving canonical text and its projection map", () => {
    const plain = serializeSuccessfully(
      documentWith(paragraph(text("same text"))),
    );
    const marked = serializeSuccessfully(
      documentWith(
        paragraph(
          text("same text", [
            { type: "bold" },
            { type: "italic" },
          ]),
        ),
      ),
    );

    expect(marked).toEqual(plain);
  });

  it("counts astral characters in UTF-16 code units without rewriting them", () => {
    const canonical = serializeSuccessfully(
      documentWith(paragraph(text("A\u{1F600}B"))),
    );

    expect(canonical.text).toBe("A\u{1F600}B");
    expect(canonical.text.length).toBe(4);
  });

  it("fails closed for malformed JSON instead of producing an empty document", () => {
    expectFailClosed('{"type":"doc","content":[');
  });

  it("fails closed when JSON is valid but contains an unknown leaf node", () => {
    expectFailClosed(
      documentWith(
        paragraph(text("before"), {
          type: "futureUnsupportedAtom",
          attrs: { value: "must not be dropped" },
        }),
      ),
    );
  });

  it.each(["\uD800", "\uDC00"])(
    "fails closed for an isolated UTF-16 surrogate (%s)",
    (isolatedSurrogate) => {
      expectFailClosed(
        documentWith(paragraph(text(isolatedSurrogate))),
      );
    },
  );
});
