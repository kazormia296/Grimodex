// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { extractPlacedBeatPreview } from "./placedBeatPreview";

// Minimal PM schema with a `sceneBeat` block that wraps inline text.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    sceneBeat: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
});

function makeDoc(blocks: { type: "paragraph" | "sceneBeat"; text: string }[]) {
  return schema.node(
    "doc",
    null,
    blocks.map((b) =>
      b.text
        ? schema.node(b.type, null, [schema.text(b.text)])
        : schema.node(b.type),
    ),
  ) as PMNode;
}

describe("extractPlacedBeatPreview", () => {
  it("placed beat なし → '[]'", () => {
    const doc = makeDoc([
      { type: "paragraph", text: "intro" },
      { type: "paragraph", text: "body" },
    ]);
    expect(extractPlacedBeatPreview(doc)).toBe("[]");
  });

  it("sceneBeat のテキストを doc 順に取り出す", () => {
    const doc = makeDoc([
      { type: "sceneBeat", text: "Beat 1" },
      { type: "paragraph", text: "narration" },
      { type: "sceneBeat", text: "Beat 2" },
    ]);
    expect(JSON.parse(extractPlacedBeatPreview(doc))).toEqual([
      "Beat 1",
      "Beat 2",
    ]);
  });

  it("空 sceneBeat はスキップする", () => {
    const doc = makeDoc([
      { type: "sceneBeat", text: "" },
      { type: "sceneBeat", text: "real" },
    ]);
    expect(JSON.parse(extractPlacedBeatPreview(doc))).toEqual(["real"]);
  });

  it("60 文字超は切り詰める / 改行は空白に正規化される", () => {
    const long = "あ".repeat(80);
    const doc = makeDoc([
      { type: "sceneBeat", text: `multi\nline\ttext` },
      { type: "sceneBeat", text: long },
    ]);
    const items = JSON.parse(extractPlacedBeatPreview(doc));
    expect(items[0]).toBe("multi line text");
    expect(items[1]).toHaveLength(60);
  });
});
