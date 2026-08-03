// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useEditorStore } from "./editorStore";
import type { AttributedSegment } from "@/lib/clipboardAttribution";

// editorStore.test.ts は node 環境 + mock editor で chain().command() の
// コールバックを実行しないため mark attrs を観測できない。ここでは実 Editor を
// 使い、chat 由来コピー (model/chatMessageId 付き segment) の paste で
// authorship mark にそれらが焼かれることを gate する。

function makeRealEditor() {
  return new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content: "<p>x</p>",
  });
}

function firstAiAuthorship(editor: Editor): Record<string, unknown> | null {
  let attrs: Record<string, unknown> | null = null;
  editor.state.doc.descendants((node) => {
    if (node.isText) {
      const m = node.marks.find((x) => x.type.name === "authorship");
      if (m && m.attrs.source === "ai") {
        attrs = m.attrs as Record<string, unknown>;
      }
    }
  });
  return attrs;
}

describe("insertFromPaste — authorship mark の model/chatMessageId", () => {
  beforeEach(() => {
    useEditorStore.setState({ editor: null, lastInsertRange: null });
  });

  it("chat 由来 segment の model / chatMessageId を mark に焼く", () => {
    const editor = makeRealEditor();
    useEditorStore.getState().setEditor(editor);
    const segs: AttributedSegment[] = [
      { text: "AI本文", source: "ai", model: "claude-x", chatMessageId: "m1" },
    ];
    useEditorStore.getState().insertFromPaste(segs);

    const attrs = firstAiAuthorship(editor);
    expect(attrs).not.toBeNull();
    expect(attrs!.model).toBe("claude-x");
    expect(attrs!.chatMessageId).toBe("m1");
    editor.destroy();
  });

  it("非 chat segment では model / chatMessageId は null のまま", () => {
    const editor = makeRealEditor();
    useEditorStore.getState().setEditor(editor);
    useEditorStore.getState().insertFromPaste([{ text: "T", source: "ai" }]);

    const attrs = firstAiAuthorship(editor);
    expect(attrs).not.toBeNull();
    expect(attrs!.model ?? null).toBeNull();
    expect(attrs!.chatMessageId ?? null).toBeNull();
    editor.destroy();
  });

  it("貼り付けの帰属保護を維持しつつ paste metadata を付ける", () => {
    const editor = makeRealEditor();
    const transactions: Array<{
      programmaticInsert: unknown;
      paste: unknown;
      uiEvent: unknown;
    }> = [];
    editor.on("transaction", ({ transaction }) => {
      if (!transaction.docChanged) return;
      transactions.push({
        programmaticInsert: transaction.getMeta("programmaticInsert"),
        paste: transaction.getMeta("paste"),
        uiEvent: transaction.getMeta("uiEvent"),
      });
    });
    useEditorStore.getState().setEditor(editor);
    useEditorStore
      .getState()
      .insertFromPaste([{ text: "貼り付け本文", source: "unknown" }]);

    expect(transactions).toContainEqual({
      programmaticInsert: true,
      paste: true,
      uiEvent: "paste",
    });
    editor.destroy();
  });
});
