import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
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
import { InlineAtomNavigationExtension } from "@/features/editor/InlineAtomNavigationExtension";
import { SlashCommandExtension } from "@/features/editor/inlineAi/SlashCommandExtension";
import { createLintDecorationPlugin } from "@/features/editor/LintDecorationPlugin";
import i18next from "@/lib/i18n";
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
 * Toolbar keyboard shortcuts not covered by StarterKit defaults.
 *
 * StarterKit ships:  Mod-Shift-s (strike), Mod-Alt-1/2/3 (headings)
 * Toolbar shows:     Ctrl+Shift+X (strike), Ctrl+1/2/3 (headings)
 *
 * This extension adds the shortcuts that match what the toolbar labels
 * display, so both sets of keys work.
 */
const LintDecorationExtension = Extension.create({
  name: "lintDecoration",
  addProseMirrorPlugins() {
    return [createLintDecorationPlugin()];
  },
});

const ToolbarShortcutsExtension = Extension.create({
  name: "toolbarShortcuts",

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-x": () => this.editor.commands.toggleStrike(),
      "Mod-1": () => this.editor.commands.toggleHeading({ level: 1 }),
      "Mod-2": () => this.editor.commands.toggleHeading({ level: 2 }),
      "Mod-3": () => this.editor.commands.toggleHeading({ level: 3 }),
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
    Placeholder.configure({
      placeholder: () => i18next.t("editor.placeholder"),
    }),
    CharacterCount,
    Typography,
    // Table
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    ToolbarShortcutsExtension,
    // Custom marks/nodes
    AuthorshipMark,
    EmphasisDotsMark,
    RubyNode,
    SceneBreakNode,
    FindReplaceExtension,
    InlineAtomNavigationExtension,
    SlashCommandExtension,
    LintDecorationExtension,
  ];
}

export function getReadonlyEditorExtensions(): Extensions {
  return getEditorExtensions().filter((ext) => ext.name !== "placeholder");
}
