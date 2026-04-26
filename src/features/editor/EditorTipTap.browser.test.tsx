/**
 * Vitest Browser Mode で TipTap の DOM API 依存動作を検証する。
 * jsdom/happy-dom ではスタブが必要だった getBoundingClientRect 等が実 Chromium で動く。
 */
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

function MinimalEditor({ content = "" }: { content?: string }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content,
  });
  return <EditorContent editor={editor} data-testid="editor" />;
}

describe("TipTap Browser Mode", () => {
  it("テキストを入力すると DOM に反映される", async () => {
    render(<MinimalEditor />);
    const editable = await waitFor(() =>
      document.querySelector("[contenteditable='true']"),
    );
    expect(editable).toBeTruthy();
    await userEvent.click(editable!);
    await userEvent.keyboard("こんにちは");
    expect(editable!.textContent).toContain("こんにちは");
  });

  it("初期コンテンツが描画される", async () => {
    render(<MinimalEditor content="<p>初期テキスト</p>" />);
    await waitFor(() => {
      expect(screen.getByText("初期テキスト")).toBeTruthy();
    });
  });

  it("getBoundingClientRect がゼロではない実 geometry を返す", async () => {
    render(<MinimalEditor content="<p>測定テスト</p>" />);
    const editable = await waitFor(
      () => document.querySelector("[contenteditable='true']") as HTMLElement,
    );
    document.body.style.width = "800px";
    const rect = editable.getBoundingClientRect();
    // 実ブラウザなら width が 0 にならない
    expect(rect.width).toBeGreaterThan(0);
  });

  it("Range.getClientRects が実レコードを返す", async () => {
    render(<MinimalEditor content="<p>Range テスト</p>" />);
    const editable = await waitFor(
      () => document.querySelector("[contenteditable='true']") as HTMLElement,
    );
    const range = document.createRange();
    const textNode = editable.querySelector("p")?.firstChild;
    if (textNode) {
      range.setStart(textNode, 0);
      range.setEnd(textNode, 1);
      const rects = range.getClientRects();
      // 実ブラウザでは少なくとも 1 件の DOMRect が返る
      expect(rects.length).toBeGreaterThan(0);
    }
  });
});
