import { create } from "zustand";
import type { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { computeAttributedSegments } from "@/features/snippets/snippetDiff";
import type { AttributedSegment } from "@/lib/clipboardAttribution";
import { incrementSnippetUsageCount } from "@/features/snippets/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import * as chatApi from "@/features/chat/chatApi";

export interface InsertRange {
  from: number;
  to: number;
  chatMessageId: string;
}

interface EditorState {
  editor: Editor | null;
  lastInsertRange: InsertRange | null;
  ghostPreview: { text: string; pos: number } | null;

  setEditor: (editor: Editor | null) => void;
  showGhostPreview: (text: string) => void;
  clearGhostPreview: () => void;
  insertFromChat: (
    text: string,
    chatMessageId: string,
    model?: string,
  ) => boolean;
  insertFromSnippet: (
    snippetId: string,
    content: string,
    source: "ai" | "human",
    originalContent: string | null,
    dropPos?: number,
    sourceChatMessageId?: string | null,
  ) => boolean;
  insertFromPaste: (segments: AttributedSegment[]) => boolean;
  clearInsertRange: () => void;
}

export const useEditorStore = create<EditorState>()((set, get) => {
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    editor: null,
    lastInsertRange: null,
    ghostPreview: null,

    setEditor: (editor: Editor | null) =>
      // Idempotent: skip notify when the same instance is re-registered.
      set((s) => (s.editor === editor ? s : { editor })),

    showGhostPreview: (text: string) => {
      const { editor } = get();
      if (!editor) return;
      const pos = editor.state.selection.from;
      set({ ghostPreview: { text, pos } });
    },

    clearGhostPreview: () => {
      set({ ghostPreview: null });
    },

    insertFromChat: (text: string, chatMessageId: string, model?: string) => {
      const { editor } = get();
      if (!editor) return false;

      const { from } = editor.state.selection;
      const docEnd = editor.state.doc.content.size - 1;
      const insertPos = from > 0 ? from : Math.max(docEnd, 0);

      const authAttrs = {
        source: "ai",
        chatMessageId,
        timestamp: new Date().toISOString(),
        model: model ?? null,
        originalLength: text.length,
      };

      // GFMテーブル構文を検出（ヘッダー行と区切り行が必要）
      const hasTable = /^\|.+\|$/m.test(text) && /^\|[\s\-:|]+\|$/m.test(text);

      let insertEnd: number;

      if (hasTable) {
        // テーブル: Markdown文字列をinsertContentAtに渡す
        // tiptap-markdownがMarkdown→HTMLに変換し、テーブルノードとして挿入される
        const docSizeBefore = editor.state.doc.content.size;

        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.setMeta("programmaticInsert", true);
            return true;
          })
          .insertContentAt(insertPos, text)
          .run();

        // 実際の挿入サイズをdocサイズ差分から計算してauthorshipを付与
        const docSizeAfter = editor.state.doc.content.size;
        const insertedSize = docSizeAfter - docSizeBefore;
        insertEnd = Math.min(insertPos + insertedSize, docSizeAfter - 1);

        if (insertedSize > 0) {
          editor
            .chain()
            .command(({ tr }) => {
              const markType = editor.schema.marks["authorship"];
              if (markType) {
                const mark = markType.create(authAttrs);
                tr.addMark(insertPos, insertEnd, mark);
              }
              return true;
            })
            .run();
        }
      } else {
        // プレーンテキスト: 既存パス（authorshipマーク付きテキストノード）
        const content = [
          {
            type: "text",
            text,
            marks: [{ type: "authorship", attrs: authAttrs }],
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

        insertEnd = insertPos + text.length;
      }

      set({
        lastInsertRange: { from: insertPos, to: insertEnd, chatMessageId },
      });

      // Tier 2 anchor: mark chat message as inserted into editor.
      // sqlite-proxy has no transactions — insert first, then metadata; on
      // metadata failure the editor content remains (user-visible) but anchor
      // signal may be missing until retry.
      void chatApi
        .updateMessageMetadata(chatMessageId, { insertedToEditor: true })
        .catch((err: unknown) => {
          console.error("insertFromChat: metadata update failed", err);
        });

      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        set({ lastInsertRange: null });
        highlightTimer = null;
      }, 3000);

      return true;
    },

    insertFromSnippet: (
      snippetId: string,
      content: string,
      source: "ai" | "human",
      originalContent: string | null,
      dropPos?: number,
      sourceChatMessageId?: string | null,
    ) => {
      const { editor } = get();
      if (!editor) return false;

      const docEnd = editor.state.doc.content.size - 1;
      const insertPos =
        dropPos != null
          ? Math.min(dropPos, Math.max(docEnd, 0))
          : (() => {
              const { from } = editor.state.selection;
              return from > 0 ? from : Math.max(docEnd, 0);
            })();

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
              chatMessageId:
                seg.source === "ai" ? (sourceChatMessageId ?? null) : null,
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

      incrementSnippetUsageCount(getCurrentProjectId(), snippetId).catch(
        () => {},
      );

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

      const now = new Date().toISOString();

      // Split each segment on "\n" and build paragraph-aware content.
      // "\n" in a segment marks a paragraph boundary (from block-element
      // separators inserted by extractMixedSegments, or newlines in plain text).
      type TextNode = {
        type: "text";
        text: string;
        marks: { type: string; attrs: object }[];
      };
      const paragraphs: TextNode[][] = [[]];

      for (const seg of segments) {
        const parts = seg.text.split("\n");
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) paragraphs.push([]);
          const part = parts[i];
          if (part) {
            paragraphs[paragraphs.length - 1].push({
              type: "text",
              text: part,
              marks: [
                {
                  type: "authorship",
                  attrs: {
                    source: seg.source,
                    timestamp: now,
                    originalLength: part.length,
                    // Chat メッセージコピー由来のときだけ非 null (data-model /
                    // data-message-id 経由)。他 producer では undefined → mark default。
                    model: seg.model ?? null,
                    chatMessageId: seg.chatMessageId ?? null,
                  },
                },
              ],
            });
          }
        }
      }

      // Use ProseMirror Fragment/Slice directly to avoid TipTap's insertContentAt
      // bug: when cursor is at parentOffset===0 with marked content, TipTap adjusts
      // from = from - 1, which corrupts document structure by replacing before the
      // paragraph opening token.
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setMeta("programmaticInsert", true);
          return true;
        })
        .command(({ tr, editor: ed }) => {
          const { schema } = ed;

          const makeTextNode = (n: TextNode) => {
            const markType = schema.marks["authorship"];
            const mark = markType
              ? markType.create(n.marks[0].attrs)
              : undefined;
            return mark ? schema.text(n.text, [mark]) : schema.text(n.text);
          };

          if (paragraphs.length === 1) {
            if (paragraphs[0].length > 0) {
              const inline = Fragment.fromArray(
                paragraphs[0].map(makeTextNode),
              );
              // openStart=0, openEnd=0: inline content, no paragraph boundaries
              tr.replace(from, to, new Slice(inline, 0, 0));
            } else if (from !== to) {
              tr.delete(from, to);
            }
          } else {
            const paragraphNodes = paragraphs.map((para) =>
              para.length === 0
                ? schema.nodes.paragraph.create({})
                : schema.nodes.paragraph.create(
                    {},
                    Fragment.fromArray(para.map(makeTextNode)),
                  ),
            );
            // openStart=1, openEnd=1: standard paste — open at paragraph depth so
            // the first pasted paragraph merges into the host paragraph at cursor,
            // and the last pasted paragraph merges into the remainder.
            tr.replace(
              from,
              to,
              new Slice(Fragment.fromArray(paragraphNodes), 1, 1),
            );
          }

          return true;
        })
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
  };
});
