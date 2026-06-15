/**
 * REPRO (Bug B) — 実 Chromium で帰属カラー表示を検証する。
 *
 * シナリオ (ユーザー報告):
 *   外部アプリからコピー → 本文に貼り付け (Case 3, source:"unknown")
 *   → 途中を範囲選択して Backspace (純粋削除)
 *   → 「それ以降が human になる」= 帰属の unknown tint が消える
 *
 * happy-dom 単体テストでは doc-level の mark は保持されると確認済み。
 * このスイートは実 contentEditable の Backspace が生成する実トランザクション
 * 形状と、ProseMirror デコレーションの DOM 再描画を検証する。
 * 「末尾が human 化」= .attribution-unknown が末尾テキストを覆わなくなる、で検出。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEditor, EditorContent } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { createAiEditedPlugin } from "./AiEditedPlugin";
import { createAttributionPlugin } from "./AttributionPlugin";
import { useAttributionStore } from "./attributionStore";
import { useEditorStore } from "@/features/editor/editorStore";

function AttributedEditor() {
  const editor = useEditor({
    extensions: getEditorExtensions(),
    content: "<p></p>",
    onCreate({ editor }) {
      editor.registerPlugin(createAttributionPlugin());
      editor.registerPlugin(createAiEditedPlugin());
      useEditorStore.getState().setEditor(editor);
    },
  });
  return <EditorContent editor={editor} />;
}

async function mountEditor() {
  useAttributionStore.setState({ showAttribution: true, filterSource: null });
  // render container にスコープして、前テスト/前ファイルの残存 .ProseMirror を
  // 誤って掴まないようにする (browser モードは context を共有しうる)。
  const { container } = render(<AttributedEditor />);
  const pm = (await waitFor(() => {
    const el = container.querySelector(".ProseMirror");
    if (!el) throw new Error("no .ProseMirror yet");
    return el as HTMLElement;
  })) as HTMLElement;
  const editor = await waitFor(() => {
    const e = useEditorStore.getState().editor;
    if (!e) throw new Error("no editor in store yet");
    return e;
  });
  // contentEditable に native focus を当て、userEvent.keyboard が必ずこの
  // エディタへ届くようにする (activeElement の引き継ぎ汚染対策)。
  pm.focus();
  return { pm, editor };
}

function docSources(editor: NonNullable<ReturnType<typeof useEditor>>) {
  const out: { text: string; source: string }[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "authorship");
    out.push({
      text: node.text ?? "",
      source: mark ? mark.attrs.source : "(human)",
    });
  });
  return out;
}

afterEach(() => {
  useEditorStore.getState().setEditor(null);
  document.body.innerHTML = "";
});

describe("Bug B repro (browser): external paste(unknown) → real Backspace mid-delete", () => {
  it("途中を選択して Backspace 後、生き残ったテキスト全体が unknown tint で覆われる", async () => {
    const { pm, editor } = await mountEditor();
    const text = "これはとても長い外部からの貼り付け文章です";

    editor.commands.focus();
    useEditorStore.getState().insertFromPaste([{ text, source: "unknown" }]);

    // 貼付直後: unknown tint が描画される
    await waitFor(() =>
      expect(
        pm.querySelectorAll(".attribution-unknown").length,
      ).toBeGreaterThan(0),
    );

    // 中央 5〜9 文字を PM 選択 → 実 Backspace
    pm.focus();
    editor.commands.setTextSelection({ from: 1 + 5, to: 1 + 9 });
    await userEvent.keyboard("{Backspace}");

    await waitFor(() => {
      // 削除が反映されるまで待つ
      expect(editor.state.doc.textContent.length).toBe(text.length - 4);
    });

    const sources = docSources(editor);
    const humanRuns = sources.filter((r) => r.source !== "unknown");

    // DOM: unknown span が覆うテキスト == 本文全体 (末尾も含め欠けがない)
    const totalText = pm.textContent ?? "";
    const taggedText = Array.from(pm.querySelectorAll(".attribution-unknown"))
      .map((e) => e.textContent ?? "")
      .join("");

    // 診断ログ

    console.log("[bugB] doc sources after delete:", JSON.stringify(sources));

    console.log(
      "[bugB] totalText:",
      JSON.stringify(totalText),
      "taggedText:",
      JSON.stringify(taggedText),
    );

    expect(humanRuns).toEqual([]); // doc-level: human 化していない
    expect(taggedText).toBe(totalText); // DOM-level: 末尾まで unknown tint で覆われている
  });

  it("文末側を選択して Backspace でも、残りが unknown のまま", async () => {
    const { pm, editor } = await mountEditor();
    const text = "外部からの貼り付け文章をここに置く";

    editor.commands.focus();
    useEditorStore.getState().insertFromPaste([{ text, source: "unknown" }]);
    await waitFor(() =>
      expect(
        pm.querySelectorAll(".attribution-unknown").length,
      ).toBeGreaterThan(0),
    );

    // 後半を選択 → Backspace
    pm.focus();
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection({ from: end - 4, to: end });
    await userEvent.keyboard("{Backspace}");

    await waitFor(() =>
      expect(editor.state.doc.textContent.length).toBe(text.length - 4),
    );

    const totalText = pm.textContent ?? "";
    const taggedText = Array.from(pm.querySelectorAll(".attribution-unknown"))
      .map((e) => e.textContent ?? "")
      .join("");

    console.log("[bugB-2] sources:", JSON.stringify(docSources(editor)));
    expect(taggedText).toBe(totalText);
  });
});
