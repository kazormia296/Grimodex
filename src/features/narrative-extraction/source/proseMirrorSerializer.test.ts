import { describe, expect, it } from "vitest";
import {
  serializeProseMirrorDocument,
  type PersistedProseMirrorSchema,
} from "./proseMirrorSerializer";

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

function serializeSuccessfully(
  input: string,
  schemaKind?: PersistedProseMirrorSchema,
) {
  const result = serializeProseMirrorDocument(input, schemaKind);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(`expected serialization to succeed: ${result.diagnostics}`);
  }
  return result.canonical;
}

function expectFailClosed(
  input: string,
  schemaKind?: PersistedProseMirrorSchema,
): void {
  const result = serializeProseMirrorDocument(input, schemaKind);
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
        paragraph(text("same text", [{ type: "bold" }, { type: "italic" }])),
      ),
    );

    expect(marked).toEqual(plain);
  });

  it("normalizes omitted schema defaults before deriving semantic structure", () => {
    const omitted = serializeSuccessfully(
      documentWith({ type: "heading", content: [text("Title")] }),
    );
    const explicit = serializeSuccessfully(
      documentWith({
        type: "heading",
        attrs: { level: 1 },
        content: [text("Title")],
      }),
    );

    expect(omitted).toEqual(explicit);
    expect(omitted.blocks).toEqual([
      expect.objectContaining({ attrs: { level: 1 } }),
    ]);
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
      expectFailClosed(documentWith(paragraph(text(isolatedSurrogate))));
    },
  );

  it("records deterministic nested block spans and synthetic boundaries", () => {
    const canonical = serializeSuccessfully(
      documentWith(
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [paragraph(text("one"))],
            },
          ],
        },
        paragraph(text("tail")),
      ),
    );

    expect(canonical.text).toBe("one\ntail");
    expect(canonical.blocks).toEqual([
      {
        id: "B000001",
        nodeType: "bulletList",
        range: { from: 0, to: 3 },
        depth: 0,
      },
      {
        id: "B000002",
        nodeType: "listItem",
        range: { from: 0, to: 3 },
        depth: 1,
      },
      {
        id: "B000003",
        nodeType: "paragraph",
        range: { from: 0, to: 3 },
        depth: 2,
      },
      {
        id: "B000004",
        nodeType: "paragraph",
        range: { from: 4, to: 8 },
        depth: 0,
      },
    ]);
    expect(canonical.projection.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "synthetic-boundary",
          canonical: { from: 3, to: 4 },
          boundary: { leftPmPos: 6, rightPmPos: 10 },
          reason: "block-boundary",
        }),
      ]),
    );
  });

  it("represents a file-backed inline image without silently dropping it", () => {
    const canonical = serializeSuccessfully(
      documentWith(
        paragraph(
          text("before"),
          { type: "image", attrs: { src: "asset.png" } },
          text("after"),
        ),
      ),
      "file-backed",
    );

    expect(canonical.text).toBe("before\uFFFCafter");
    expect(canonical.projection.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "atomic", nodeType: "image" }),
      ]),
    );
  });

  it("rejects a container that violates its required content cardinality", () => {
    expectFailClosed(
      documentWith({ type: "generatedProseBlock", content: [] }),
    );
  });

  it("rejects an empty top-level doc instead of sealing corrupt empty prose", () => {
    expectFailClosed(documentWith());
  });

  it("rejects a root-level inline image in the file-backed schema", () => {
    expectFailClosed(
      documentWith({ type: "image", attrs: { src: "asset.png" } }),
      "file-backed",
    );
  });

  it("rejects nodes that belong only to the other persisted Scene schema", () => {
    expectFailClosed(
      documentWith({
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [paragraph(text("task"))],
          },
        ],
      }),
      "database",
    );
    expectFailClosed(
      documentWith({ type: "sceneBeat", content: [text("beat")] }),
      "file-backed",
    );
  });

  it("rejects structural nodes outside their real ProseMirror parent group", () => {
    expectFailClosed(
      documentWith({
        type: "blockquote",
        content: [
          {
            type: "listItem",
            content: [paragraph(text("not a direct block child"))],
          },
        ],
      }),
    );
  });

  it("returns a recursively frozen canonical artifact", () => {
    const canonical = serializeSuccessfully(
      documentWith(paragraph(text("sealed"))),
    );

    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.blocks)).toBe(true);
    expect(Object.isFrozen(canonical.projection.segments)).toBe(true);
  });
});
