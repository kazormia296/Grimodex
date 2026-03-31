import { create } from "zustand";
import type { Editor } from "@tiptap/core";

export interface InsertRange {
  from: number;
  to: number;
  chatMessageId: string;
}

interface EditorState {
  editor: Editor | null;
  lastInsertRange: InsertRange | null;

  setEditor: (editor: Editor | null) => void;
  insertFromChat: (text: string, chatMessageId: string) => boolean;
  insertFromSnippet: (text: string, snippetId: number) => boolean;
  clearInsertRange: () => void;
}

let highlightTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditorStore = create<EditorState>()((set, get) => ({
  editor: null,
  lastInsertRange: null,

  setEditor: (editor: Editor | null) => set({ editor }),

  insertFromChat: (text: string, chatMessageId: string) => {
    const { editor } = get();
    if (!editor) return false;

    // Determine insertion position: cursor or end of document
    const { from } = editor.state.selection;
    const docEnd = editor.state.doc.content.size - 1;
    const insertPos = from > 0 ? from : Math.max(docEnd, 0);

    // Build content with ai source metadata (for Phase 4 attribution)
    const content = [
      {
        type: "text",
        text,
        marks: [
          {
            type: "authorship",
            attrs: {
              source: "ai",
              chatMessageId,
              timestamp: new Date().toISOString(),
            },
          },
        ],
      },
    ];

    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        return true;
      })
      .insertContentAt(insertPos, content)
      .run();

    // Calculate the range of inserted text
    const to = insertPos + text.length;
    set({ lastInsertRange: { from: insertPos, to, chatMessageId } });

    // Clear highlight after 3 seconds
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      set({ lastInsertRange: null });
      highlightTimer = null;
    }, 3000);

    return true;
  },

  insertFromSnippet: (text: string, snippetId: number) => {
    const { editor } = get();
    if (!editor) return false;

    const { from } = editor.state.selection;
    const docEnd = editor.state.doc.content.size - 1;
    const insertPos = from > 0 ? from : Math.max(docEnd, 0);

    const content = [
      {
        type: "text",
        text,
        marks: [
          {
            type: "authorship",
            attrs: {
              source: "snippet",
              snippetId: String(snippetId),
              timestamp: new Date().toISOString(),
            },
          },
        ],
      },
    ];

    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        return true;
      })
      .insertContentAt(insertPos, content)
      .run();

    const to = insertPos + text.length;
    set({
      lastInsertRange: {
        from: insertPos,
        to,
        chatMessageId: `snippet-${snippetId}`,
      },
    });

    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      set({ lastInsertRange: null });
      highlightTimer = null;
    }, 3000);

    return true;
  },

  clearInsertRange: () => {
    if (highlightTimer) {
      clearTimeout(highlightTimer);
      highlightTimer = null;
    }
    set({ lastInsertRange: null });
  },
}));
