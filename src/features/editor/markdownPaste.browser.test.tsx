/**
 * 実 Chromium で「ペーストイベント → Markdown 変換 / Ctrl+Shift+V 除去」の
 * 統合フローを検証する。EditorPane と同一の editorProps 配線
 * (pasteExternalText / notePlainPasteKeyDown を delegate) を最小エディタで再現する。
 *
 * happy-dom では実 paste イベントの clipboardData や keydown→paste の順序を
 * 忠実に再現できないため browser test で gate する。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEditor, EditorContent } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { createAttributionPlugin } from "@/features/attribution/AttributionPlugin";
import { createAiEditedPlugin } from "@/features/attribution/AiEditedPlugin";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useEditorStore } from "@/features/editor/editorStore";
import {
  pasteExternalText,
  notePlainPasteKeyDown,
  consumePlainPaste,
} from "./markdownPaste";

function PasteEditor() {
  const editor = useEditor({
    extensions: getEditorExtensions(),
    content: "<p></p>",
    editorProps: {
      handlePaste(_view, event) {
        const html = event.clipboardData?.getData("text/html");
        if (
          html &&
          (html.includes("data-grimodex-source") ||
            html.includes("data-pm-slice"))
        ) {
          return false; // 内部コピーはこのテストでは扱わない
        }
        const wantPlain = consumePlainPaste();
        const plain = event.clipboardData?.getData("text/plain") ?? "";
        if (!plain) return false;
        const ed = useEditorStore.getState().editor;
        if (!ed) return false;
        pasteExternalText(
          ed,
          plain,
          (text) =>
            useEditorStore
              .getState()
              .insertFromPaste([{ text, source: "unknown" }]),
          wantPlain,
        );
        return true;
      },
      handleKeyDown(_view, event) {
        notePlainPasteKeyDown(event);
        return false;
      },
    },
    onCreate({ editor }) {
      editor.registerPlugin(createAttributionPlugin());
      editor.registerPlugin(createAiEditedPlugin());
      useEditorStore.getState().setEditor(editor);
    },
  });
  return <EditorContent editor={editor} />;
}

async function mount() {
  useAttributionStore.setState({ showAttribution: true, filterSource: null });
  // render container にスコープ (browser モードの context 共有で前ファイルの
  // 残存 .ProseMirror を誤掴みしないように)。
  const { container } = render(<PasteEditor />);
  const pm = (await waitFor(() => {
    const el = container.querySelector(".ProseMirror");
    if (!el) throw new Error("no editor");
    return el as HTMLElement;
  })) as HTMLElement;
  const editor = await waitFor(() => {
    const e = useEditorStore.getState().editor;
    if (!e) throw new Error("no editor in store");
    return e;
  });
  (pm as HTMLElement).focus();
  editor.commands.focus();
  return { pm, editor };
}

afterEach(() => {
  useEditorStore.getState().setEditor(null);
  document.body.innerHTML = "";
});

describe("markdown paste 統合 (browser)", () => {
  it("通常ペースト: Markdown 記法が見出し/太字に変換される", async () => {
    const { pm, editor } = await mount();
    await userEvent.paste("# 見出し\n\n**太字**の段落");

    await waitFor(() => {
      expect(pm.querySelector("h1")).toBeTruthy();
    });
    expect(pm.querySelector("h1")?.textContent).toContain("見出し");
    expect(pm.querySelector("strong")?.textContent).toContain("太字");

    // 変換テキストは unknown 帰属 (human にならない)
    let allUnknown = true;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === "authorship");
      if (!mark || mark.attrs.source !== "unknown") allUnknown = false;
    });
    expect(allUnknown).toBe(true);
  });

  it("Ctrl+Shift+V: Markdown 記法が除去されプレーン挿入される (見出しにならない)", async () => {
    const { pm } = await mount();
    // Mod+Shift+V を keydown で arm → その直後に paste
    await userEvent.keyboard("{Control>}{Shift>}V{/Shift}{/Control}");
    await userEvent.paste("# 見出し");

    await waitFor(() => {
      expect(pm.textContent).toContain("見出し");
    });
    // 書式設定なし: 見出しノードは作られず、'#' も残らない
    expect(pm.querySelector("h1")).toBeNull();
    expect(pm.textContent).not.toContain("#");
  });
});
