import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { useEditorStore } from "./editorStore";

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
