import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";

import { countPlacedBeats, paragraphOrdinalAtPos } from "./beatDocQueries";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    sceneBeat: { group: "block", content: "inline*", atom: false },
    sceneBreak: { group: "block" },
    text: { group: "inline" },
  },
});

function p(text: string) {
  return schema.nodes.paragraph.create({}, text ? [schema.text(text)] : []);
}

describe("countPlacedBeats", () => {
  it("sceneBeat ノードを数える", () => {
    const doc = schema.nodes.doc.create({}, [
      p("段落1"),
      schema.nodes.sceneBeat.create({}, [schema.text("ビート")]),
      p("段落2"),
    ]);
    expect(countPlacedBeats(doc)).toBe(1);
    expect(countPlacedBeats(null)).toBe(0);
  });
});

describe("paragraphOrdinalAtPos", () => {
  it("先頭のビートは ¶1", () => {
    const beat = schema.nodes.sceneBeat.create({}, [schema.text("b")]);
    const doc = schema.nodes.doc.create({}, [beat, p("段落1")]);
    // beat はトップレベル offset 0
    expect(paragraphOrdinalAtPos(doc, 0)).toBe(1);
  });

  it("段落の後ろに置かれたビートは次の段落番号を指す", () => {
    const p1 = p("段落1");
    const p2 = p("段落2");
    const beat = schema.nodes.sceneBeat.create({}, [schema.text("b")]);
    const doc = schema.nodes.doc.create({}, [p1, beat, p2]);
    // beat の位置 = p1.nodeSize
    expect(paragraphOrdinalAtPos(doc, p1.nodeSize)).toBe(2);
  });

  it("scene-break など非 textblock は段落として数えない", () => {
    const p1 = p("段落1");
    const brk = schema.nodes.sceneBreak.create();
    const beat = schema.nodes.sceneBeat.create({}, [schema.text("b")]);
    const doc = schema.nodes.doc.create({}, [p1, brk, beat]);
    expect(paragraphOrdinalAtPos(doc, p1.nodeSize + brk.nodeSize)).toBe(2);
  });
});
