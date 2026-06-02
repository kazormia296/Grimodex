import { describe, expect, it } from "vitest";
import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { findCommentMarkRange } from "./jumpToComment";

// 最小スキーマ + comment mark。findCommentMarkRange はライブ doc を descendants で
// 走査するため、実 ProseMirror doc を組んで PM 位置のロジックを検証する。
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
  marks: {
    comment: {
      attrs: { text: { default: "" }, createdAt: { default: null } },
    },
  },
});

function commentText(
  value: string,
  attrs: { text: string; createdAt?: string | null },
) {
  return schema.text(value, [schema.mark("comment", attrs)]);
}

function makeDoc(...paragraphs: ProseMirrorNode[][]): ProseMirrorNode {
  return schema.node(
    "doc",
    null,
    paragraphs.map((inlines) => schema.node("paragraph", null, inlines)),
  );
}

describe("findCommentMarkRange", () => {
  it("returns the PM range of a single marked text node", () => {
    const d = makeDoc([
      schema.text("前"),
      commentText("対象", { text: "メモ" }),
      schema.text("後"),
    ]);
    // doc 内: "前" 1-2, "対象" 2-4, "後" 4-5
    expect(
      findCommentMarkRange(d, { text: "メモ", createdAt: null, ordinal: 0 }),
    ).toEqual({ from: 2, to: 4 });
  });

  it("merges contiguous same-attr text nodes into one range", () => {
    const d = makeDoc([
      commentText("ab", { text: "n" }),
      commentText("cd", { text: "n" }),
    ]);
    expect(
      findCommentMarkRange(d, { text: "n", createdAt: null, ordinal: 0 }),
    ).toEqual({ from: 1, to: 5 });
  });

  it("uses ordinal to pick the Nth duplicate", () => {
    const d = makeDoc(
      [commentText("一", { text: "dup" })],
      [commentText("二", { text: "dup" })],
    );
    expect(
      findCommentMarkRange(d, { text: "dup", createdAt: null, ordinal: 0 }),
    ).toEqual({ from: 1, to: 2 });
    expect(
      findCommentMarkRange(d, { text: "dup", createdAt: null, ordinal: 1 }),
    ).toEqual({ from: 4, to: 5 });
  });

  it("distinguishes by createdAt", () => {
    const d = makeDoc([
      commentText("x", { text: "m", createdAt: "2026-01-01" }),
    ]);
    expect(
      findCommentMarkRange(d, {
        text: "m",
        createdAt: "2026-01-01",
        ordinal: 0,
      }),
    ).toEqual({ from: 1, to: 2 });
    expect(
      findCommentMarkRange(d, { text: "m", createdAt: null, ordinal: 0 }),
    ).toBeNull();
  });

  it("returns null when no comment matches", () => {
    const d = makeDoc([schema.text("plain")]);
    expect(
      findCommentMarkRange(d, { text: "x", createdAt: null, ordinal: 0 }),
    ).toBeNull();
  });

  it("returns null when ordinal exceeds matches", () => {
    const d = makeDoc([commentText("x", { text: "m" })]);
    expect(
      findCommentMarkRange(d, { text: "m", createdAt: null, ordinal: 1 }),
    ).toBeNull();
  });
});
