// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { getDocText, RubyNode } from "./RubyNode";

function createTestEditor(content = "") {
  return new Editor({
    extensions: [StarterKit, RubyNode],
    content,
  });
}

describe("RubyNode", () => {
  it("registers as an inline node extension", () => {
    const editor = createTestEditor();
    const nodeType = editor.schema.nodes["ruby"];
    expect(nodeType).toBeDefined();
    expect(nodeType.isInline).toBe(true);
    editor.destroy();
  });

  it("has base and annotation attributes", () => {
    const editor = createTestEditor();
    const nodeType = editor.schema.nodes["ruby"];
    expect(nodeType.spec.attrs).toHaveProperty("base");
    expect(nodeType.spec.attrs).toHaveProperty("annotation");
    editor.destroy();
  });

  it("parses <ruby> HTML correctly", () => {
    const editor = createTestEditor(
      '<p>テスト<ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>です</p>',
    );

    let foundRuby = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "ruby") {
        foundRuby = true;
        expect(node.attrs.base).toBe("漢字");
        expect(node.attrs.annotation).toBe("かんじ");
      }
    });
    expect(foundRuby).toBe(true);
    editor.destroy();
  });

  it("renders as <ruby> HTML element", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "ruby",
        attrs: { base: "太郎", annotation: "たろう" },
      })
      .run();

    const html = editor.getHTML();
    expect(html).toContain("<ruby");
    expect(html).toContain("太郎");
    expect(html).toContain("<rt>たろう</rt>");
    editor.destroy();
  });

  it("can insert ruby node via command", () => {
    const editor = createTestEditor("<p>テスト文章</p>");
    editor
      .chain()
      .focus()
      .insertContent({
        type: "ruby",
        attrs: { base: "世界", annotation: "せかい" },
      })
      .run();

    let rubyCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "ruby") rubyCount++;
    });
    expect(rubyCount).toBe(1);
    editor.destroy();
  });

  it("inserts ruby via setRuby command", () => {
    const editor = createTestEditor("<p>テスト</p>");
    editor.chain().focus().setRuby("東京", "とうきょう").run();

    let found = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "ruby") {
        found = true;
        expect(node.attrs.base).toBe("東京");
        expect(node.attrs.annotation).toBe("とうきょう");
      }
    });
    expect(found).toBe(true);
    editor.destroy();
  });

  it("getDocText separates blocks with newline so codex boundary check works", () => {
    // Reproduces the bug: <p>a</p><p>hoge</p> used to flatten to "ahoge",
    // which fails the latin-latin char-class boundary in the codex matcher.
    const editor = createTestEditor("<p>a</p><p>hoge</p><p>あああああ</p>");
    expect(getDocText(editor.state.doc)).toBe("a\nhoge\nあああああ");
    editor.destroy();
  });

  it("getDocText emits no leading newline for the first block", () => {
    const editor = createTestEditor("<p>太郎</p>");
    expect(getDocText(editor.state.doc)).toBe("太郎");
    editor.destroy();
  });

  it("getDocText preserves ruby base across block boundaries", () => {
    const editor = createTestEditor(
      '<p><ruby data-base="太郎" data-annotation="たろう">太郎<rp>(</rp><rt>たろう</rt><rp>)</rp></ruby></p><p>走った</p>',
    );
    expect(getDocText(editor.state.doc)).toBe("太郎\n走った");
    editor.destroy();
  });

  it("coexists with other inline content", () => {
    const editor = createTestEditor("<p>前文</p>");
    editor
      .chain()
      .focus()
      .insertContent([
        { type: "text", text: "彼の名前は" },
        {
          type: "ruby",
          attrs: { base: "太郎", annotation: "たろう" },
        },
        { type: "text", text: "です" },
      ])
      .run();

    // Verify ruby node exists alongside text
    let hasRuby = false;
    let fullText = "";
    editor.state.doc.descendants((node) => {
      if (node.isText) fullText += node.text;
      if (node.type.name === "ruby") {
        hasRuby = true;
        expect(node.attrs.base).toBe("太郎");
      }
    });
    expect(hasRuby).toBe(true);
    expect(fullText).toContain("彼の名前は");
    editor.destroy();
  });
});
