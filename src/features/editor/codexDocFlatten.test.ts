// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "./extensions";
import { getDocText } from "./RubyNode";
import { flattenDocForCodex } from "./codexDocFlatten";

function makeEditor() {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
  });
}

describe("flattenDocForCodex", () => {
  it("text は getDocText と完全一致する (契約パリティ)", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "アキラと" },
            { type: "mention", attrs: { id: "1", label: "トト" } },
            { type: "text", text: "が会った。" },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "二行目。" }] },
      ],
    });
    const { text } = flattenDocForCodex(editor.state.doc);
    expect(text).toBe(getDocText(editor.state.doc));
    editor.destroy();
  });

  it("mention atom は flat text に寄与しない", () => {
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
    const { text, flatPmPos } = flattenDocForCodex(editor.state.doc);
    // "ナナ" は含まれない
    expect(text).toBe("AB");
    expect(flatPmPos).toHaveLength(2);
    editor.destroy();
  });

  it("flatPmPos の各 PM 位置は対応する1文字を指す", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "猫犬鳥" }] },
      ],
    });
    const doc = editor.state.doc;
    const { text, flatPmPos } = flattenDocForCodex(doc);
    for (let i = 0; i < text.length; i++) {
      const pm = flatPmPos[i]!;
      // textBetween(pm, pm+1) は flat offset i の文字に一致する
      expect(doc.textBetween(pm, pm + 1)).toBe(text[i]);
    }
    editor.destroy();
  });

  it("block 境界は1つの \\n スロットを挟む (先頭以外)", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "あ" }] },
        { type: "paragraph", content: [{ type: "text", text: "い" }] },
      ],
    });
    const { text, flatIsRuby } = flattenDocForCodex(editor.state.doc);
    expect(text).toBe("あ\nい");
    // \n スロットは ruby ではない
    expect(flatIsRuby).toEqual([false, false, false]);
    editor.destroy();
  });

  it("ruby の base は flag され、各 base 文字は同じ PM 位置を指す", () => {
    const editor = makeEditor();
    editor
      .chain()
      .focus()
      .setContent({ type: "doc", content: [{ type: "paragraph" }] })
      .run();
    editor.commands.setRuby("漢字", "かんじ");
    const { text, flatPmPos, flatIsRuby } = flattenDocForCodex(
      editor.state.doc,
    );
    const start = text.indexOf("漢字");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(flatIsRuby[start]).toBe(true);
    expect(flatIsRuby[start + 1]).toBe(true);
    // 同一 atom → 同じ PM 位置
    expect(flatPmPos[start]).toBe(flatPmPos[start + 1]);
    editor.destroy();
  });
});
