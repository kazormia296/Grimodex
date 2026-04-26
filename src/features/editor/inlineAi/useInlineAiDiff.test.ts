// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";

// generateInlineAi をスタブ化して「挿入は手動で模擬する」テスト構造にする。
// useInlineAiDiff は chunk を受けたら editor に挿入するが、テスト側では
// accept()/reject() の純粋な doc 変形だけを検証したいため、
// 挿入はストアの startGeneration → setGeneratedRange を直接叩く。
vi.mock("./inlineAiApi", () => ({
  generateInlineAi: vi.fn(),
}));

import { useInlineAiDiff } from "./useInlineAiDiff";
import { useInlineAiStore } from "./inlineAiStore";

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
}

function getText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
}

function findAuthorshipAt(
  editor: Editor,
  pos: number,
): { source: string; model?: string } | null {
  const $pos = editor.state.doc.resolve(pos);
  const marks = $pos.marks();
  const mark = marks.find((m) => m.type.name === "authorship");
  if (!mark) return null;
  return {
    source: mark.attrs.source as string,
    model: mark.attrs.model as string | undefined,
  };
}

describe("useInlineAiDiff", () => {
  beforeEach(() => {
    useInlineAiStore.getState().reset();
  });

  it("accept(insert): leaves generated text intact and adds authorship mark", () => {
    const editor = makeEditor("<p>hello world</p>");
    const { result } = renderHook(() => useInlineAiDiff(editor));

    // 模擬: 挿入モードの chunk が届いた直後の状態を再現する。
    // "hello world" → PM [1,12). insertPos=6 の直後に "BRAVE" を挿入し、
    // 結果は "hello BRAVEworld"（6文字目の前に空白があるのでPM pos 7 の後に挿入）
    // ここでは PM pos 7 に "BRAVE" を直挿入して再現する。
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText("BRAVE", 7);
        return true;
      })
      .run();

    const ac = new AbortController();
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 7,
      abortController: ac,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 7, to: 12 });
    useInlineAiStore.getState().finishGeneration("claude-sonnet-4-6");

    act(() => result.current.accept());

    expect(getText(editor)).toBe("hello BRAVEworld");
    // 挿入範囲 "BRAVE" に authorship が付いている
    const mark = findAuthorshipAt(editor, 8);
    expect(mark?.source).toBe("ai");
    expect(mark?.model).toBe("claude-sonnet-4-6");
    // 範囲外（"hello "）には authorship が付いていない
    expect(findAuthorshipAt(editor, 2)).toBeNull();
    // ストアは idle に戻る
    expect(useInlineAiStore.getState().status).toBe("idle");
  });

  it("accept(replace): deletes original and marks only the new text", () => {
    // doc: "<p>hello world</p>" → PM [1,12), "hello"=[1,6), " world"=[6,12)
    // 模擬: "hello" が選択された状態で末尾（pos 6）に "BRAVE" が append 済み
    const editor = makeEditor("<p>hello world</p>");
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText("BRAVE", 6);
        return true;
      })
      .run();
    // doc は "helloBRAVE world"

    const { result } = renderHook(() => useInlineAiDiff(editor));
    const ac = new AbortController();
    useInlineAiStore.getState().startGeneration({
      commandId: "rewrite",
      mode: "replace",
      originalRange: { from: 1, to: 6 },
      originalText: "hello",
      insertPos: null,
      abortController: ac,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 6, to: 11 });
    useInlineAiStore.getState().finishGeneration("claude-sonnet-4-6");

    act(() => result.current.accept());

    // "hello" が削除され、"BRAVE" だけが残る
    expect(getText(editor)).toBe("BRAVE world");
    // 残った "BRAVE"（PM [1,6)）に authorship が付与されている
    const mark = findAuthorshipAt(editor, 2);
    expect(mark?.source).toBe("ai");
    expect(mark?.model).toBe("claude-sonnet-4-6");
    // 後続テキスト " world" には authorship が付いていない
    expect(findAuthorshipAt(editor, 7)).toBeNull();
    expect(useInlineAiStore.getState().status).toBe("idle");
  });

  it("reject(replace): removes generated text and keeps original intact", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText("BRAVE", 6);
        return true;
      })
      .run();

    const { result } = renderHook(() => useInlineAiDiff(editor));
    const ac = new AbortController();
    useInlineAiStore.getState().startGeneration({
      commandId: "rewrite",
      mode: "replace",
      originalRange: { from: 1, to: 6 },
      originalText: "hello",
      insertPos: null,
      abortController: ac,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 6, to: 11 });
    useInlineAiStore.getState().finishGeneration("claude-sonnet-4-6");

    act(() => result.current.reject());

    expect(getText(editor)).toBe("hello world");
    expect(findAuthorshipAt(editor, 2)).toBeNull();
    expect(useInlineAiStore.getState().status).toBe("idle");
  });
});
