// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "../extensions";
import {
  flattenParagraph,
  flatRangeToPm,
  pmPosToFlatOffset,
  resolveParagraphAtSelection,
} from "./paragraphFlat";

function makeEditor() {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
  });
}

describe("paragraphFlat", () => {
  it("paragraph 内 text を flatten する", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "猫犬鳥" }],
        },
      ],
    });
    const para = editor.state.doc.child(0);
    const flat = flattenParagraph(para, 1);
    expect(flat.text).toBe("猫犬鳥");
    expect(flat.flatPmPos).toHaveLength(3);
    editor.destroy();
  });

  it("mention atom は flat に寄与しない", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A" },
            { type: "mention", attrs: { id: "1", label: "ナナ" } },
            { type: "text", text: "B" },
          ],
        },
      ],
    });
    const flat = flattenParagraph(editor.state.doc.child(0), 1);
    expect(flat.text).toBe("AB");
    expect(flat.flatPmPos).toHaveLength(2);
    editor.destroy();
  });

  it("ruby base は同一 PM を指す", () => {
    const editor = makeEditor();
    editor
      .chain()
      .focus()
      .setContent({ type: "doc", content: [{ type: "paragraph" }] })
      .run();
    editor.commands.setRuby("漢字", "かんじ");
    const flat = flattenParagraph(editor.state.doc.child(0), 1);
    const start = flat.text.indexOf("漢");
    expect(flat.flatIsRuby[start]).toBe(true);
    expect(flat.flatPmPos[start]).toBe(flat.flatPmPos[start + 1]);
    editor.destroy();
  });

  it("flatRangeToPm と pmPosToFlatOffset が往復する", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "abcdef" }] },
      ],
    });
    const flat = flattenParagraph(editor.state.doc.child(0), 1);
    const { from, to } = flatRangeToPm(flat, 1, 4);
    expect(editor.state.doc.textBetween(from, to)).toBe("bcd");
    expect(pmPosToFlatOffset(flat, from)).toBe(1);
    editor.destroy();
  });

  it("resolveParagraphAtSelection は paragraph のみ返す", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "本文" }] },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "見出し" }],
        },
      ],
    });
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state);
    expect(resolved?.node.type.name).toBe("paragraph");
    expect(resolved?.flat.text).toBe("本文");
    editor.destroy();
  });
});
