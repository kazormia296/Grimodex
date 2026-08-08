import { describe, expect, it } from "vitest";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "prosemirror-schema-basic";
import { buildParagraphIndentDecorations } from "./ParagraphIndentPlugin";
import { shouldApplyAutomaticParagraphIndent } from "@/lib/paragraphIndentPolicy";

function makeDoc(...paragraphs: string[]): ProseMirrorNode {
  return schema.nodes.doc.create(
    {},
    paragraphs.map((text) =>
      schema.nodes.paragraph.create({}, text ? [schema.text(text)] : []),
    ),
  );
}

describe("automatic paragraph indent policy", () => {
  it("indents narrative text but excludes dialogue and author whitespace", () => {
    expect(shouldApplyAutomaticParagraphIndent("地の文")).toBe(true);
    expect(shouldApplyAutomaticParagraphIndent("「会話文」")).toBe(false);
    expect(shouldApplyAutomaticParagraphIndent("『入れ子の会話』")).toBe(false);
    expect(shouldApplyAutomaticParagraphIndent("　手動字下げ")).toBe(false);
    expect(shouldApplyAutomaticParagraphIndent("")).toBe(false);
  });
});

describe("buildParagraphIndentDecorations", () => {
  it("suppresses only top-level dialogue and explicitly indented paragraphs", () => {
    const doc = makeDoc("地の文", "「会話文」", "『内声』", "　手動字下げ");
    const decorations = buildParagraphIndentDecorations(doc).find();

    expect(decorations).toHaveLength(3);
    expect(
      decorations.every(
        (decoration) =>
          (decoration.spec as { paragraphIndentSuppressed?: boolean })
            .paragraphIndentSuppressed === true,
      ),
    ).toBe(true);
  });

  it("does not decorate paragraphs nested in blockquotes", () => {
    const quotedParagraph = schema.nodes.paragraph.create(
      {},
      schema.text("「引用」"),
    );
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.blockquote.create({}, [quotedParagraph]),
    ]);

    expect(buildParagraphIndentDecorations(doc).find()).toHaveLength(0);
  });
});
