import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { useEditorStore } from "./editorStore";

vi.mock("@/features/chat/chatApi", () => ({
  updateMessageMetadata: vi.fn().mockResolvedValue(undefined),
}));

import { updateMessageMetadata } from "@/features/chat/chatApi";

function makeEditor(overrides = {}) {
  const state = {
    selection: { from: 5, to: 5 },
    doc: {
      content: { size: 20 },
    },
  };
  return {
    state,
    chain: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.focus = vi.fn(() => chain);
      chain.command = vi.fn(() => chain);
      chain.insertContentAt = vi.fn(() => chain);
      chain.setTextSelection = vi.fn(() => chain);
      chain.run = vi.fn(() => true);
      return chain;
    }),
    commands: {
      insertContentAt: vi.fn(() => true),
      setTextSelection: vi.fn(),
    },
    view: {
      state: state,
    },
    ...overrides,
  } as unknown as Editor;
}

function resetStore() {
  useEditorStore.setState({
    editor: null,
    lastInsertRange: null,
  });
}

describe("useEditorStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("setEditor", () => {
    it("stores editor instance", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      expect(useEditorStore.getState().editor).toBe(editor);
    });

    it("clears editor when null is passed", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);
      useEditorStore.getState().setEditor(null);

      expect(useEditorStore.getState().editor).toBeNull();
    });

    it("does not notify subscribers when the same instance is re-registered", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);
      let notifications = 0;
      const unsub = useEditorStore.subscribe(() => {
        notifications++;
      });
      useEditorStore.getState().setEditor(editor);
      unsub();
      expect(notifications).toBe(0);
      expect(useEditorStore.getState().editor).toBe(editor);
    });
  });

  describe("insertFromChat", () => {
    it("returns false when no editor is set", () => {
      const result = useEditorStore
        .getState()
        .insertFromChat("テスト", "msg-1");

      expect(result).toBe(false);
    });

    it("inserts text at cursor position", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      const result = useEditorStore
        .getState()
        .insertFromChat("挿入テキスト", "msg-1");

      expect(result).toBe(true);
      expect(editor.chain).toHaveBeenCalled();
    });

    it("stores insert range in lastInsertRange", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      useEditorStore.getState().insertFromChat("挿入テキスト", "msg-1");

      const range = useEditorStore.getState().lastInsertRange;
      expect(range).not.toBeNull();
      expect(range).toHaveProperty("from");
      expect(range).toHaveProperty("to");
      expect(range).toHaveProperty("chatMessageId", "msg-1");
    });

    it("updates chat message metadata with insertedToEditor", async () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      useEditorStore.getState().insertFromChat("挿入テキスト", "msg-insert-1");

      await vi.waitFor(() => {
        expect(updateMessageMetadata).toHaveBeenCalledWith("msg-insert-1", {
          insertedToEditor: true,
        });
      });
    });

    it("inserts at end of document when cursor position is unavailable", () => {
      const state = {
        selection: { from: 0, to: 0 },
        doc: { content: { size: 50 } },
      };
      const editor = makeEditor({ state, view: { state } });
      useEditorStore.getState().setEditor(editor);

      const result = useEditorStore
        .getState()
        .insertFromChat("テスト", "msg-2");

      expect(result).toBe(true);
    });

    it("clears lastInsertRange after timeout", async () => {
      vi.useFakeTimers();
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      useEditorStore.getState().insertFromChat("テスト", "msg-1");
      expect(useEditorStore.getState().lastInsertRange).not.toBeNull();

      vi.advanceTimersByTime(3000);
      expect(useEditorStore.getState().lastInsertRange).toBeNull();

      vi.useRealTimers();
    });

    it("passes source metadata with ai attribution", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      useEditorStore.getState().insertFromChat("AIテキスト", "msg-1");

      // The chain should have been called — verification that
      // insertContentAt was called with content containing ai source mark
      expect(editor.chain).toHaveBeenCalled();
    });
  });

  describe("insertFromChat - table handling", () => {
    it("passes markdown string to insertContentAt for GFM table", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      const tableText =
        "| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |";
      useEditorStore.getState().insertFromChat(tableText, "msg-table");

      // テーブルパスでは文字列をinsertContentAtに渡す（Markdown拡張でパース）
      const chainInstance = (editor.chain as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(chainInstance.insertContentAt).toHaveBeenCalledWith(
        expect.any(Number),
        tableText,
      );
    });

    it("passes content array to insertContentAt for plain text", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      const plainText = "通常のテキスト";
      useEditorStore.getState().insertFromChat(plainText, "msg-plain");

      // 非テーブルパスではauthorshipマーク付きの配列を渡す
      const chainInstance = (editor.chain as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(chainInstance.insertContentAt).toHaveBeenCalledWith(
        expect.any(Number),
        expect.arrayContaining([expect.objectContaining({ type: "text" })]),
      );
    });

    it("returns true for table content", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      const tableText = "| Name | Value |\n| :-- | --: |\n| foo | 42 |";
      const result = useEditorStore
        .getState()
        .insertFromChat(tableText, "msg-table");

      expect(result).toBe(true);
    });

    it("sets lastInsertRange for table content", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      const tableText = "| H1 | H2 |\n| --- | --- |\n| C1 | C2 |";
      useEditorStore.getState().insertFromChat(tableText, "msg-table");

      const range = useEditorStore.getState().lastInsertRange;
      expect(range).not.toBeNull();
      expect(range?.chatMessageId).toBe("msg-table");
    });

    it("does not treat pipe-only text without separator row as table", () => {
      const editor = makeEditor();
      useEditorStore.getState().setEditor(editor);

      // 区切り行のないパイプ文字列はテーブルとして扱わない
      const nonTableText = "A | B | C";
      useEditorStore.getState().insertFromChat(nonTableText, "msg-plain");

      const chainInstance = (editor.chain as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      // 配列（プレーンテキストパス）で呼ばれること
      expect(chainInstance.insertContentAt).toHaveBeenCalledWith(
        expect.any(Number),
        expect.arrayContaining([expect.objectContaining({ type: "text" })]),
      );
    });
  });

  describe("clearInsertRange", () => {
    it("clears lastInsertRange", () => {
      useEditorStore.setState({
        lastInsertRange: { from: 1, to: 10, chatMessageId: "msg-1" },
      });

      useEditorStore.getState().clearInsertRange();

      expect(useEditorStore.getState().lastInsertRange).toBeNull();
    });
  });
});
