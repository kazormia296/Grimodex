// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { getEditorExtensions } from "@/features/editor/extensions";

/**
 * TcyMark（縦中横の明示マーク）の基本契約: toggle で付け外しでき、
 * span.tcy として serialize / parse される（export html-span や貼付の往復）。
 */
describe("TcyMark", () => {
  let editor: Editor;
  afterEach(() => editor?.destroy());

  it("toggles the tcy mark and renders span.tcy", () => {
    editor = new Editor({
      extensions: getEditorExtensions(),
      content: "<p>25</p>",
    });
    editor.commands.setTextSelection({ from: 1, to: 3 }); // select "25"
    editor.commands.toggleMark("tcy");
    expect(editor.isActive("tcy")).toBe(true);
    expect(editor.getHTML()).toContain('class="tcy"');

    editor.commands.toggleMark("tcy");
    expect(editor.isActive("tcy")).toBe(false);
    expect(editor.getHTML()).not.toContain('class="tcy"');
  });

  it("parses span.tcy back into a tcy mark", () => {
    editor = new Editor({
      extensions: getEditorExtensions(),
      content: '<p><span class="tcy">25</span></p>',
    });
    let found = false;
    editor.state.doc.descendants((n: ProseMirrorNode) => {
      if (n.isText && n.marks.some((m) => m.type.name === "tcy")) found = true;
    });
    expect(found).toBe(true);
  });
});
