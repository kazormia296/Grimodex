import { create } from "zustand";
import type { Editor } from "@tiptap/core";
import { computeAttributedSegments } from "@/features/snippets/snippetDiff";
import type { AttributedSegment } from "@/lib/clipboardAttribution";

export interface InsertRange {
  from: number;
  to: number;
  chatMessageId: string;
}

interface EditorState {
  editor: Editor | null;
  lastInsertRange: InsertRange | null;

  setEditor: (editor: Editor | null) => void;
  insertFromChat: (
    text: string,
    chatMessageId: string,
    model?: string,
  ) => boolean;
  insertFromSnippet: (
    snippetId: number,
    content: string,
    source: "ai" | "human",
    originalContent: string | null,
  ) => boolean;
  insertFromPaste: (segments: AttributedSegment[]) => boolean;
  clearInsertRange: () => void;
}

let highlightTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditorStore = create<EditorState>()((set, get) => ({
  editor: null,
  lastInsertRange: null,

  setEditor: (editor: Editor | null) => set({ editor }),

  insertFromChat: (text: string, chatMessageId: string, model?: string) => {
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
              model: model ?? null,
              toolName: "grimodex",
              toolVersion: "0.1.0",
              originalLength: text.length,
              traceId: crypto.randomUUID(),
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

  insertFromSnippet: (
    snippetId: number,
    content: string,
    source: "ai" | "human",
    originalContent: string | null,
  ) => {
    const { editor } = get();
    if (!editor) return false;

    const { from } = editor.state.selection;
    const docEnd = editor.state.doc.content.size - 1;
    const insertPos = from > 0 ? from : Math.max(docEnd, 0);

    // Determine whether to use diff-based partial attribution
    const needsDiff =
      source === "ai" &&
      originalContent != null &&
      content !== originalContent;

    const segments = needsDiff
      ? computeAttributedSegments(originalContent, content)
      : [{ text: content, source }];

    const now = new Date().toISOString();
    const contentNodes = segments.map((seg) => ({
      type: "text" as const,
      text: seg.text,
      marks: [
        {
          type: "authorship",
          attrs: {
            source: seg.source,
            timestamp: now,
            originalLength: seg.text.length,
            traceId: crypto.randomUUID(),
          },
        },
      ],
    }));

    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        return true;
      })
      .insertContentAt(insertPos, contentNodes)
      .run();

    const to = insertPos + content.length;
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

  insertFromPaste: (segments: AttributedSegment[]) => {
    const { editor } = get();
    if (!editor) return false;

    const { from, to } = editor.state.selection;
    const insertPos = from !== to ? { from, to } : from;

    const now = new Date().toISOString();
    const contentNodes = segments.map((seg) => ({
      type: "text" as const,
      text: seg.text,
      marks: [
        {
          type: "authorship",
          attrs: {
            source: seg.source,
            timestamp: now,
            originalLength: seg.text.length,
            traceId: crypto.randomUUID(),
          },
        },
      ],
    }));

    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        return true;
      })
      .insertContentAt(insertPos, contentNodes)
      .run();

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
