// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ChatInputKeymap } from "./ChatInputKeymap";

function createEditor(
  onSubmit: (markdown: string) => void,
  onStop: () => void,
) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, ChatInputKeymap.configure({ onSubmit, onStop })],
    content: "",
  });
}

describe("ChatInputKeymap", () => {
  it("Enter で onSubmit が呼ばれコンテンツがクリアされる", () => {
    const onSubmit = vi.fn();
    const editor = createEditor(onSubmit, vi.fn());
    editor.commands.setContent("<p>テストメッセージ</p>");

    editor.commands.keyboardShortcut("Enter");

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.stringContaining("テストメッセージ"),
    );
    expect(editor.getText()).toBe("");

    editor.destroy();
  });

  it("空コンテンツのとき Enter で onSubmit は呼ばれない", () => {
    const onSubmit = vi.fn();
    const editor = createEditor(onSubmit, vi.fn());
    editor.commands.setContent("");

    editor.commands.keyboardShortcut("Enter");

    expect(onSubmit).not.toHaveBeenCalled();

    editor.destroy();
  });

  it("Shift+Enter で改行が挿入される（onSubmit は呼ばれない）", () => {
    const onSubmit = vi.fn();
    const editor = createEditor(onSubmit, vi.fn());
    editor.commands.setContent("<p>1行目</p>");
    // カーソルを末尾に
    editor.commands.focus("end");

    editor.commands.keyboardShortcut("Shift-Enter");

    expect(onSubmit).not.toHaveBeenCalled();

    editor.destroy();
  });
});
