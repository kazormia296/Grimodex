import { describe, it, expect } from "vitest";
import { buildFocusDimDecorations } from "./FocusModePlugin";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "@tiptap/pm/schema-basic";
import { DecorationSet } from "@tiptap/pm/view";

function makeDoc(paragraphCount: number): ProseMirrorNode {
  const paragraphs = Array.from({ length: paragraphCount }, (_, i) =>
    schema.nodes.paragraph.create(
      {},
      i === 0 ? [] : [schema.text(`Paragraph ${i + 1}`)],
    ),
  );
  return schema.nodes.doc.create({}, paragraphs);
}

describe("buildFocusDimDecorations", () => {
  it("returns empty set when focusMode is false", () => {
    const doc = makeDoc(3);
    const result = buildFocusDimDecorations(doc, 1, false);
    expect(result).toBe(DecorationSet.empty);
  });

  it("returns empty set for single-paragraph doc", () => {
    const doc = makeDoc(1);
    const result = buildFocusDimDecorations(doc, 1, true);
    expect(result).toBe(DecorationSet.empty);
  });

  it("dims blocks other than the one containing cursor", () => {
    const doc = makeDoc(3);
    // cursor in paragraph 2 (index 1): find its start position
    let para2Start = -1;
    doc.forEach((_node, offset, i) => {
      if (i === 1 && para2Start === -1) {
        para2Start = offset + 1; // inside paragraph 2
      }
    });
    const result = buildFocusDimDecorations(doc, para2Start, true);
    const decos = result.find();
    expect(decos).toHaveLength(2); // paragraphs 1 and 3 dimmed
    expect(
      decos.every(
        (d) => (d.spec as { class?: string }).class === "focus-dimmed",
      ),
    ).toBe(true);
  });

  it("cursor in first paragraph dims only subsequent paragraphs", () => {
    const doc = makeDoc(3);
    // cursor inside first paragraph (pos 1)
    const result = buildFocusDimDecorations(doc, 1, true);
    const decos = result.find();
    expect(decos).toHaveLength(2); // paragraphs 2 and 3 dimmed
  });

  it("cursor in last paragraph dims only preceding paragraphs", () => {
    const doc = makeDoc(3);
    let lastParaStart = -1;
    doc.forEach((_node, offset, i) => {
      if (i === 2) lastParaStart = offset + 1;
    });
    const result = buildFocusDimDecorations(doc, lastParaStart, true);
    const decos = result.find();
    expect(decos).toHaveLength(2); // paragraphs 1 and 2 dimmed
  });
});
