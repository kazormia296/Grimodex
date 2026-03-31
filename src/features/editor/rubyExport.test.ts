import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { RubyNode } from "./RubyNode";
import { rubyToHtml, rubyToPlainText, extractRubyEntries } from "./rubyExport";

function createTestEditor() {
  return new Editor({
    extensions: [StarterKit, RubyNode],
    content: "",
  });
}

function makeRubyNode(editor: Editor, base: string, annotation: string) {
  const nodeType = editor.schema.nodes["ruby"];
  return nodeType.create({ base, annotation });
}

describe("rubyExport", () => {
  describe("rubyToHtml", () => {
    it("produces standard <ruby> HTML", () => {
      const editor = createTestEditor();
      const node = makeRubyNode(editor, "漢字", "かんじ");
      const html = rubyToHtml(node);
      expect(html).toBe("<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>");
      editor.destroy();
    });
  });

  describe("rubyToPlainText", () => {
    it("produces base(annotation) format", () => {
      const editor = createTestEditor();
      const node = makeRubyNode(editor, "太郎", "たろう");
      const text = rubyToPlainText(node);
      expect(text).toBe("太郎(たろう)");
      editor.destroy();
    });
  });

  describe("extractRubyEntries", () => {
    it("extracts all ruby annotations from a document", () => {
      const editor = createTestEditor();
      editor
        .chain()
        .focus()
        .insertContent([
          { type: "text", text: "名前は" },
          {
            type: "ruby",
            attrs: { base: "太郎", annotation: "たろう" },
          },
          { type: "text", text: "、苗字は" },
          {
            type: "ruby",
            attrs: { base: "山田", annotation: "やまだ" },
          },
        ])
        .run();

      const entries = extractRubyEntries(editor.state.doc);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ base: "太郎", annotation: "たろう" });
      expect(entries[1]).toEqual({ base: "山田", annotation: "やまだ" });
      editor.destroy();
    });

    it("returns empty array when no ruby nodes exist", () => {
      const editor = createTestEditor();
      editor.chain().focus().insertContent("普通のテキスト").run();
      const entries = extractRubyEntries(editor.state.doc);
      expect(entries).toHaveLength(0);
      editor.destroy();
    });
  });
});
