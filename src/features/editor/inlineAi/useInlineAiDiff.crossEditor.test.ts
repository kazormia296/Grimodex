// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useInlineAiDiff } from "./useInlineAiDiff";
import { useInlineAiStore } from "./inlineAiStore";
import { inlineAiDiffKey } from "./InlineAIDiffPlugin";

// リニアモード (1シーン1エディタが同時マウント) / 分割ビュー (2ペイン) は
// グローバル単一 useInlineAiStore を複数エディタで共有する。useInlineAiDiff は
// 各エディタへ diff プラグインを登録し、startGeneration に activeEditor を渡す。
// この統合テストは「生成を所有しないエディタ」に副作用が漏れないことを実機の
// Editor + 実プラグインで保証する (本丸の owner ゲートの回帰ガード)。

const createdEditors: Editor[] = [];
const hookUnmounts: Array<() => void> = [];

function makeEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
  createdEditors.push(editor);
  return editor;
}

function renderDiff(editor: Editor) {
  const r = renderHook(() => useInlineAiDiff(editor));
  hookUnmounts.push(r.unmount);
  return r;
}

function getText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
}

function startOwnerSession(activeEditor: Editor | null, insertPos: number) {
  useInlineAiStore.getState().startGeneration({
    commandId: "continue",
    mode: "insert",
    originalRange: null,
    originalText: "",
    insertPos,
    abortController: new AbortController(),
    ...(activeEditor ? { activeEditor } : {}),
  });
}

describe("useInlineAiDiff: 複数エディタ共有時の owner ゲート", () => {
  beforeEach(() => {
    useInlineAiStore.getState().reset();
  });
  afterEach(() => {
    hookUnmounts.splice(0).forEach((u) => u());
    createdEditors.splice(0).forEach((e) => {
      if (!e.isDestroyed) e.destroy();
    });
  });

  it("owner の生成中でも非 owner エディタへのタイプは握りつぶされず着地する", () => {
    const ownerEditor = makeEditor("<p>owner</p>");
    const otherEditor = makeEditor("<p>other</p>");
    renderDiff(ownerEditor);
    renderDiff(otherEditor);

    startOwnerSession(ownerEditor, 6);

    otherEditor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText("X", 1);
        return true;
      })
      .run();

    expect(getText(otherEditor)).toBe("Xother");
  });

  it("自分の生成中は生の入力を握りつぶす (ストリーミング保護は維持)", () => {
    const ownerEditor = makeEditor("<p>owner</p>");
    renderDiff(ownerEditor);
    startOwnerSession(ownerEditor, 6);

    ownerEditor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText("Z", 1);
        return true;
      })
      .run();

    expect(getText(ownerEditor)).toBe("owner");
  });

  it("diff 装飾は非 owner エディタに漏れない", () => {
    const ownerEditor = makeEditor("<p>owner</p>");
    const otherEditor = makeEditor("<p>otherblock</p>");
    renderDiff(ownerEditor);
    renderDiff(otherEditor);

    startOwnerSession(ownerEditor, 1);
    useInlineAiStore.getState().setGeneratedRange({ from: 1, to: 4 });
    useInlineAiStore.getState().finishGeneration("claude-sonnet-4-6");

    // 非 owner 側で強制再評価しても装飾は出ない
    const tr = otherEditor.state.tr.setMeta("inlineAiDiffUpdate", true);
    otherEditor.view.dispatch(tr);

    const decoSet = inlineAiDiffKey.getState(otherEditor.state);
    expect((decoSet?.find() ?? []).length).toBe(0);
  });

  it("activeEditor 未指定 (旧 single-editor 経路) は従来通りガードする", () => {
    const ed = makeEditor("<p>solo</p>");
    renderDiff(ed);
    startOwnerSession(null, 1);

    ed.chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText("Q", 1);
        return true;
      })
      .run();

    expect(getText(ed)).toBe("solo");
  });
});
