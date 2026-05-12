// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { resolveAnnotationRange } from "./resolveAnnotationRange";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
});

function makeDoc(...paragraphs: string[]) {
  return schema.node(
    "doc",
    null,
    paragraphs.map((t) =>
      schema.node("paragraph", null, t ? [schema.text(t)] : []),
    ),
  );
}

describe("resolveAnnotationRange", () => {
  it("returns null when textSnapshot is null and no PM-position fallback fits", () => {
    const doc = makeDoc("abcdef");
    expect(
      resolveAnnotationRange(doc, {
        rangeStart: 0,
        rangeEnd: 0,
        textSnapshot: null,
      }),
    ).toBeNull();
  });

  it("trusts existing PM positions when text at [from, to] equals textSnapshot", () => {
    // <p>abcdef</p>: PM positions — 0=before<p>, 1=a, 2=b, 3=c, 4=d, 5=e, 6=f, 7=after<p>
    const doc = makeDoc("abcdef");
    const r = resolveAnnotationRange(doc, {
      rangeStart: 2,
      rangeEnd: 5,
      textSnapshot: "bcd",
    });
    expect(r).toEqual({ from: 2, to: 5 });
  });

  it("resolves Japanese text via textSnapshot search even when stored range is byte-offset garbage", () => {
    const doc = makeDoc("こんにちは世界");
    // Bogus byte-offset-style range: 「は」 at byte 12 in plain text, but PM
    // position for 「は」 is 5 (=1 + 4 chars before).
    const r = resolveAnnotationRange(doc, {
      rangeStart: 12,
      rangeEnd: 15,
      textSnapshot: "は",
    });
    expect(r).toEqual({ from: 5, to: 6 });
  });

  it("picks the occurrence closest to the rangeStart hint when there are duplicates", () => {
    // <p>foo bar foo bar foo</p>: text spans 19 chars.
    const doc = makeDoc("foo bar foo bar foo");
    // Hint near the second "foo" (index 8 in flat string).
    const r = resolveAnnotationRange(doc, {
      rangeStart: 8,
      rangeEnd: 11,
      textSnapshot: "foo",
    });
    // PM pos = 1 + 8 = 9.
    expect(r).toEqual({ from: 9, to: 12 });
  });

  it("returns null when textSnapshot is not present in the doc", () => {
    const doc = makeDoc("hello world");
    expect(
      resolveAnnotationRange(doc, {
        rangeStart: 0,
        rangeEnd: 5,
        textSnapshot: "missing",
      }),
    ).toBeNull();
  });

  it("translates flat index across paragraph boundaries to correct PM positions", () => {
    // <p>abc</p><p>def</p>
    // PM positions: 0=<p>, 1=a, 2=b, 3=c, 4=</p>, 5=<p>, 6=d, 7=e, 8=f, 9=</p>
    const doc = makeDoc("abc", "def");
    const r = resolveAnnotationRange(doc, {
      rangeStart: 100,
      rangeEnd: 103,
      textSnapshot: "def",
    });
    expect(r).toEqual({ from: 6, to: 9 });
  });

  it("returns null when both textSnapshot is empty and existing range mismatches", () => {
    const doc = makeDoc("abc");
    expect(
      resolveAnnotationRange(doc, {
        rangeStart: 0,
        rangeEnd: 3,
        textSnapshot: "",
      }),
    ).toBeNull();
  });

  it("falls back to search when stored PM range is out of bounds", () => {
    const doc = makeDoc("hello");
    // 999 > docSize: fall back to textSnapshot search.
    const r = resolveAnnotationRange(doc, {
      rangeStart: 999,
      rangeEnd: 1004,
      textSnapshot: "ello",
    });
    expect(r).toEqual({ from: 2, to: 6 });
  });
});
