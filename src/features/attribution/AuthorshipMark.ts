import { Mark, mergeAttributes } from "@tiptap/core";

export type AuthorshipSource = "human" | "ai" | "ai-edited" | "snippet";

export interface AuthorshipAttributes {
  source: AuthorshipSource;
  timestamp: string | null;
  model: string | null;
  chatMessageId: string | null;
}

export const AuthorshipMark = Mark.create({
  name: "authorship",

  addAttributes() {
    return {
      source: {
        default: "human",
      },
      timestamp: {
        default: null,
      },
      model: {
        default: null,
      },
      chatMessageId: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-authorship]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(
        { "data-authorship": HTMLAttributes.source },
        HTMLAttributes,
      ),
      0,
    ];
  },
});
