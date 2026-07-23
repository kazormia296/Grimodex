import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Normalize a model identifier to `provider/model` format (Agent Trace convention).
 * If already in that format, returns as-is.
 */
export function normalizeModelId(provider: string, model: string): string {
  if (model.includes("/")) return model;
  return `${provider}/${model}`;
}

export type AuthorshipSource = "human" | "ai" | "unknown";

export interface AuthorshipAttributes {
  source: AuthorshipSource;
  timestamp: string | null;
  model: string | null;
  chatMessageId: string | null;
  traceId: string | null;
  toolName: string | null;
  toolVersion: string | null;
  manualOverride: boolean;
  originalLength: number | null;
}

export const AuthorshipMark = Mark.create({
  name: "authorship",
  // Keep native IME preedit text in the same DOM span as the text before the
  // caret. Chromium can otherwise expand insertCompositionText's target range
  // back across an inclusive:false mark boundary and replace the paragraph.
  // AiEditedPlugin removes inherited ai/unknown attribution after composition.
  inclusive: true,

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
      traceId: {
        default: null,
      },
      toolName: {
        default: null,
      },
      toolVersion: {
        default: null,
      },
      manualOverride: {
        default: false,
      },
      originalLength: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-authorship]",
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
