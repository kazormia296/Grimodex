/**
 * 実 Chromium で「ai スパンの中間文字を削除 → 実 Ctrl+Z で復元」したとき、
 * 復元された文字の authorship が ai のまま保持されることを検証する (Issue 1)。
 *
 * 単体テスト (AiEditedPlugin.test.ts) は editor.commands.undo() で同じ経路を
 * 通すが、本スイートはユーザー報告どおりの実キー操作 (Backspace / Ctrl+Z) を
 * 実 contentEditable に対して行い、history キーマップ込みの全経路を gate する。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { createAiEditedPlugin } from "./AiEditedPlugin";

function Ed({ onReady }: { onReady: (e: Editor) => void }) {
  const editor = useEditor({
    extensions: getEditorExtensions(),
    content: "<p></p>",
    onCreate({ editor }) {
      editor.registerPlugin(createAiEditedPlugin());
      onReady(editor);
    },
  });
  return <EditorContent editor={editor} />;
}

function aiSources(editor: Editor): { text: string; source: string }[] {
  const out: { text: string; source: string }[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "authorship");
    out.push({
      text: node.text ?? "",
      source: mark ? (mark.attrs.source as string) : "(none)",
    });
  });
  return out;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("undo authorship (browser): mid-span delete → Ctrl+Z keeps ai", () => {
  it("ai スパン中間を Backspace 削除 → Ctrl+Z 復元で全文 ai のまま", async () => {
    let ed: Editor | null = null;
    const { container } = render(<Ed onReady={(e) => (ed = e)} />);
    const pm = (await waitFor(() => {
      const el = container.querySelector(".ProseMirror");
      if (!el) throw new Error("no editor");
      return el as HTMLElement;
    })) as HTMLElement;
    const editor = await waitFor(() => {
      if (!ed) throw new Error("no editor instance");
      return ed as Editor;
    });

    // ai テキストを履歴に載せず seed
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        tr.setMeta("addToHistory", false);
        return true;
      })
      .insertContent([
        {
          type: "text",
          text: "ABCDE",
          marks: [
            {
              type: "authorship",
              attrs: {
                source: "ai",
                chatMessageId: "m",
                timestamp: new Date().toISOString(),
                originalLength: 5,
              },
            },
          ],
        },
      ])
      .run();

    await waitFor(() => expect(pm.textContent).toContain("ABCDE"));

    // 中間 "C" (pos 3-4) を選択 → 実 Backspace
    pm.focus();
    editor.commands.setTextSelection({ from: 3, to: 4 });
    await userEvent.keyboard("{Backspace}");
    await waitFor(() => expect(editor.state.doc.textContent).toBe("ABDE"));

    // 実 Ctrl+Z で復元
    pm.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    await waitFor(() => expect(editor.state.doc.textContent).toBe("ABCDE"));

    // 復元後、全テキストが ai のまま (human 化していない)
    const runs = aiSources(editor);
    expect(runs.every((r) => r.source === "ai")).toBe(true);
  });
});
