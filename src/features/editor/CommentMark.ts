import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * CommentMark — 選択範囲に紐づくインライン注釈（執筆者向けメモ）。
 *
 * - `text`: コメント本文
 * - `createdAt`: ISO 8601 作成日時
 *
 * 視覚表現は CommentDecorationPlugin が管理する（showComments トグルに連動）。
 * Markdown エクスポート時は mark が除去されテキストのみ出力される（TipTap デフォルト動作）。
 */
export const CommentMark = Mark.create({
  name: "comment",
  inclusive: false,

  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-comment-body") ?? "",
        renderHTML: (attrs) => ({ "data-comment-body": attrs.text ?? "" }),
      },
      createdAt: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-comment-created") ?? null,
        renderHTML: (attrs) =>
          attrs.createdAt ? { "data-comment-created": attrs.createdAt } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-comment": "" }, HTMLAttributes), 0];
  },
});
