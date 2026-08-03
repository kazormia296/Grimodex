// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ChatInputKeymap } from "./ChatInputKeymap";

function createEditor(
  onSubmit: (markdown: string) => Promise<boolean>,
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
  it("Enter で送信が受理された後だけコンテンツがクリアされる", async () => {
    const onSubmit = vi.fn(async () => true);
    const editor = createEditor(onSubmit, vi.fn());
    editor.commands.setContent("<p>テストメッセージ</p>");

    editor.commands.keyboardShortcut("Enter");

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.stringContaining("テストメッセージ"),
    );
    await vi.waitFor(() => expect(editor.getText()).toBe(""));

    editor.destroy();
  });

  it("空コンテンツのとき Enter で onSubmit は呼ばれない", () => {
    const onSubmit = vi.fn(async () => true);
    const editor = createEditor(onSubmit, vi.fn());
    editor.commands.setContent("");

    editor.commands.keyboardShortcut("Enter");

    expect(onSubmit).not.toHaveBeenCalled();

    editor.destroy();
  });

  it("Shift+Enter で改行が挿入される（onSubmit は呼ばれない）", () => {
    const onSubmit = vi.fn(async () => true);
    const editor = createEditor(onSubmit, vi.fn());
    editor.commands.setContent("<p>1行目</p>");
    // カーソルを末尾に
    editor.commands.focus("end");

    editor.commands.keyboardShortcut("Shift-Enter");

    expect(onSubmit).not.toHaveBeenCalled();

    editor.destroy();
  });

  it("送信 preflight が拒否されたら下書きを保持する", async () => {
    const onSubmit = vi.fn(async () => false);
    const editor = createEditor(onSubmit, vi.fn());
    editor.commands.setContent("<p>保存に失敗した下書き</p>");

    editor.commands.keyboardShortcut("Enter");

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(editor.getText()).toBe("保存に失敗した下書き");
    editor.destroy();
  });

  it("送信 preflight が reject しても下書きを保持する", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("save failed");
    });
    const editor = createEditor(onSubmit, vi.fn());
    editor.commands.setContent("<p>再送する下書き</p>");

    editor.commands.keyboardShortcut("Enter");

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(editor.getText()).toBe("再送する下書き");
    editor.destroy();
  });
});
