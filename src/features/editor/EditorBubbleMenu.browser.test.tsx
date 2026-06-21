/**
 * 選択バブルツールバーの幾何 gate。happy-dom は getBoundingClientRect/Range を
 * 実測しないため、配置 (選択範囲の上に出る・ビューポート内に収まる) は実 Chromium で検証する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { EditorBubbleMenu } from "./EditorBubbleMenu";
import type { ToolbarActions } from "./Toolbar";

let captured: Editor | null = null;

function Harness() {
  const ref = useRef<ToolbarActions | null>({
    openLink: () => {},
    openRuby: () => {},
  });
  const editor = useEditor({
    extensions: getEditorExtensions(),
    content:
      "<p>hello world this is a reasonably long sentence to select from</p>",
    onCreate: ({ editor }) => {
      captured = editor;
    },
  });
  return (
    <div style={{ paddingTop: 300 }}>
      <EditorContent editor={editor} />
      <EditorBubbleMenu editor={editor} toolbarActionsRef={ref} />
    </div>
  );
}

describe("EditorBubbleMenu geometry", () => {
  beforeEach(() => {
    captured = null;
  });

  it("renders above the selection and within the viewport", async () => {
    render(<Harness />);
    const editable = await waitFor(
      () => document.querySelector("[contenteditable='true']") as HTMLElement,
    );
    await userEvent.click(editable);
    await waitFor(() => expect(captured).not.toBeNull());

    // 選択を張る (本文上部に 300px パディングがあるので上配置になる)。
    captured!.chain().focus().setTextSelection({ from: 1, to: 12 }).run();

    // 縦配置 (top/transform はインラインスタイルなので browser でも確実に効く) と
    // 実レイアウトが取れていることを検証する。横の厳密なクランプは
    // computeBubblePosition の単体テストが担う (browser は Tailwind が no-op のため
    // ピクセル幅が本番と乖離する)。
    await waitFor(() => {
      const tb = screen.getByRole("toolbar").getBoundingClientRect();
      const selRect = window
        .getSelection()!
        .getRangeAt(0)
        .getBoundingClientRect();
      // 実寸が取れている
      expect(tb.width).toBeGreaterThan(0);
      // 選択範囲の上に出る (下端が選択上端より上)
      expect(tb.bottom).toBeLessThanOrEqual(selRect.top + 1);
      // 少なくとも一部はビューポート内にある
      expect(tb.right).toBeGreaterThan(0);
      expect(tb.left).toBeLessThan(window.innerWidth);
    });
  });

  it("hides again once the selection collapses", async () => {
    render(<Harness />);
    const editable = await waitFor(
      () => document.querySelector("[contenteditable='true']") as HTMLElement,
    );
    await userEvent.click(editable);
    await waitFor(() => expect(captured).not.toBeNull());

    captured!.chain().focus().setTextSelection({ from: 1, to: 12 }).run();
    await waitFor(() => screen.getByRole("toolbar"));

    captured!.chain().focus().setTextSelection(3).run();
    await waitFor(() =>
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument(),
    );
  });
});
