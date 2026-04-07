import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import Typography from "@tiptap/extension-typography";
import Paragraph from "@tiptap/extension-paragraph";
import { defaultMarkdownSerializer } from "prosemirror-markdown";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { RubyNode } from "@/features/editor/RubyNode";
import { EmphasisDotsMark } from "@/features/editor/EmphasisDotsMark";
import { SceneBreakNode } from "@/features/editor/SceneBreakNode";
import { FindReplaceExtension } from "@/features/editor/FindReplaceExtension";
import { SlashCommandExtension } from "@/features/editor/inlineAi/SlashCommandExtension";
import type { Extensions } from "@tiptap/core";

// Extends Paragraph to preserve empty paragraphs during markdown roundtrip.
// tiptap-markdown serializes empty paragraphs as blank lines, which markdown-it
// then discards on parse. This override emits <p></p> (raw HTML) instead,
// which is preserved when Markdown is configured with html: true.
const ParagraphWithEmptyLineSupport = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          state: InstanceType<
            typeof import("prosemirror-markdown").MarkdownSerializerState
          >,
          node: import("prosemirror-model").Node,
          parent: import("prosemirror-model").Node,
          index: number,
        ) {
          if (node.childCount === 0) {
            state.write("<p></p>");
            state.closeBlock(node);
          } else {
            defaultMarkdownSerializer.nodes.paragraph(
              state,
              node,
              parent,
              index,
            );
          }
        },
        parse: {},
      },
    };
  },
});

/**
 * Centralizes all TipTap extensions.
 * Each feature registers its extensions here to avoid merge conflicts
 * when multiple features add extensions in parallel.
 */
export function getEditorExtensions(): Extensions {
  return [
    StarterKit.configure({ paragraph: false }),
    ParagraphWithEmptyLineSupport,
    Markdown.configure({ html: true }),
    // Official extensions
    Underline,
    Link.configure({
      openOnClick: false,
      HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
    }),
    Placeholder.configure({ placeholder: "ここに書き始める…" }),
    CharacterCount,
    Typography,
    // Custom marks/nodes
    AuthorshipMark,
    EmphasisDotsMark,
    RubyNode,
    SceneBreakNode,
    FindReplaceExtension,
    SlashCommandExtension,
  ];
}

export function getReadonlyEditorExtensions(): Extensions {
  return getEditorExtensions().filter((ext) => ext.name !== "placeholder");
}
