import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";

import { countMarkRuns } from "./layerCounts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
  marks: {
    comment: { attrs: { text: { default: "" } } },
    foreshadowSetup: {},
    foreshadowPayoff: {},
  },
});

function text(t: string, ...markNames: string[]) {
  return schema.text(
    t,
    markNames.map((n) => schema.marks[n].create()),
  );
}

describe("countMarkRuns", () => {
  it("mark なしの doc は 0", () => {
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [text("平文")]),
    ]);
    expect(countMarkRuns(doc, ["comment"])).toBe(0);
  });

  it("離れた mark run を個別に数える", () => {
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [
        text("前", "comment"),
        text("あいだ"),
        text("後", "comment"),
      ]),
    ]);
    expect(countMarkRuns(doc, ["comment"])).toBe(2);
  });

  it("隣接 text ノードにまたがる同種 mark は 1 run", () => {
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [
        text("前半", "comment"),
        text("後半", "comment"),
      ]),
    ]);
    expect(countMarkRuns(doc, ["comment"])).toBe(1);
  });

  it("ブロック境界で run が切れる", () => {
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [text("段落1", "comment")]),
      schema.nodes.paragraph.create({}, [text("段落2", "comment")]),
    ]);
    expect(countMarkRuns(doc, ["comment"])).toBe(2);
  });

  it("複数 mark 名をひとつのチャネルとして数える", () => {
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [
        text("ふり", "foreshadowSetup"),
        text("あいだ"),
        text("回収", "foreshadowPayoff"),
      ]),
    ]);
    expect(countMarkRuns(doc, ["foreshadowSetup", "foreshadowPayoff"])).toBe(2);
  });
});
