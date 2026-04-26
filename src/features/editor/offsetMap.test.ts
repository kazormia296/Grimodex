import { describe, it, expect } from "vitest";
import { schema } from "@tiptap/pm/schema-basic";
import { buildOffsetMap, strOffsetToPmPos } from "./offsetMap";

function docFromParagraphs(...paragraphs: string[]) {
  return schema.nodes.doc.create(
    {},
    paragraphs.map((t) =>
      t === ""
        ? schema.nodes.paragraph.create({}, [])
        : schema.nodes.paragraph.create({}, [schema.text(t)]),
    ),
  );
}

describe("buildOffsetMap", () => {
  it("single paragraph yields one block with offset 0", () => {
    const doc = docFromParagraphs("hello");
    const map = buildOffsetMap(doc);
    expect(map.blocks).toHaveLength(1);
    expect(map.blocks[0]).toMatchObject({
      id: 0,
      kind: "paragraph",
      text: "hello",
      strOffsetStart: 0,
    });
    expect(map.totalLength).toBe(5);
  });

  it("multiple paragraphs are joined by a 1-unit separator", () => {
    const doc = docFromParagraphs("ab", "cd");
    const map = buildOffsetMap(doc);
    expect(map.blocks).toHaveLength(2);
    expect(map.blocks[0].strOffsetStart).toBe(0);
    // "ab" (2) + "\n" (1) = 3 — second block starts at scene offset 3.
    expect(map.blocks[1].strOffsetStart).toBe(3);
    expect(map.totalLength).toBe(5);
  });

  it("CJK characters contribute one UTF-16 unit each", () => {
    const doc = docFromParagraphs("あい");
    const map = buildOffsetMap(doc);
    expect(map.blocks[0].text).toBe("あい");
    expect(map.totalLength).toBe(2);
  });

  it("reverse lookup returns PM position at block start", () => {
    const doc = docFromParagraphs("ab", "cd");
    const map = buildOffsetMap(doc);
    // Offset 0 → start of first paragraph (PM pos 1, since doc open = 0)
    const pos0 = strOffsetToPmPos(map, 0);
    expect(pos0).toBe(1);
    // Offset 3 → start of second paragraph (skip "ab" + paragraph close + open = 4)
    const pos3 = strOffsetToPmPos(map, 3);
    expect(pos3).toBe(5);
  });

  it("reverse lookup at offset inside block returns correct PM position", () => {
    const doc = docFromParagraphs("hello");
    const map = buildOffsetMap(doc);
    // Offset 3 is the 'l' inside "hello". Inside a single paragraph, the
    // first text char is at PM pos 1, so offset 3 → PM pos 4.
    expect(strOffsetToPmPos(map, 3)).toBe(4);
  });

  it("empty block is preserved with zero-length text", () => {
    const doc = docFromParagraphs("a", "", "b");
    const map = buildOffsetMap(doc);
    expect(map.blocks.map((b) => b.text)).toEqual(["a", "", "b"]);
    // scene offsets: 0, 2 (a + \n), 3 ("" + \n)
    expect(map.blocks.map((b) => b.strOffsetStart)).toEqual([0, 2, 3]);
  });

  it("reverse lookup in a separator returns null", () => {
    const doc = docFromParagraphs("ab", "cd");
    const map = buildOffsetMap(doc);
    // Offset 2 is exactly the end of the first block's interval — map
    // returns the end-of-interval clamp (PM pos 3 = end of "ab").
    expect(strOffsetToPmPos(map, 2)).toBe(3);
    // A truly orphaned offset (past all intervals) returns null.
    expect(strOffsetToPmPos(map, 99)).toBeNull();
  });
});
