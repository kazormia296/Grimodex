import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
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
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { FindReplaceExtension } from "@/features/editor/FindReplaceExtension";
import { InlineAtomNavigationExtension } from "@/features/editor/InlineAtomNavigationExtension";
import { SlashCommandExtension } from "@/features/editor/inlineAi/SlashCommandExtension";
import { createLintDecorationPlugin } from "@/features/editor/LintDecorationPlugin";
import { createLintDisableGutterPlugin } from "@/features/editor/LintDisableGutterPlugin";
import { LintDisableMark } from "@/features/editor/LintDisableMark";
import { LintDisableBlockAttrs } from "@/features/editor/LintDisableBlockAttrs";
import { CommentMark } from "@/features/editor/CommentMark";
import { createCommentDecorationPlugin } from "@/features/editor/CommentDecorationPlugin";
import { ForeshadowSetupMark } from "@/features/foreshadow/marks/ForeshadowSetupMark";
import { ForeshadowPayoffMark } from "@/features/foreshadow/marks/ForeshadowPayoffMark";
import { ForeshadowPasteRule } from "@/features/foreshadow/marks/foreshadowPasteRule";
import { AnnotationMark } from "@/features/post-effect/AnnotationMark";
import { createAnnotationPlugin } from "@/features/post-effect/AnnotationPlugin";
export { COMMENT_REBUILD_META } from "@/features/editor/CommentDecorationPlugin";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import {
  createCodexMentionExtension,
  type CodexMentionPopupState,
} from "@/features/codex/CodexMentionExtension";
import i18next from "@/lib/i18n";
import type { Extensions } from "@tiptap/core";

export interface EditorExtensionOptions {
  /** When set, registers the Codex @mention extension and routes suggestion state here. */
  setMentionPopup?: (state: CodexMentionPopupState | null) => void;
}

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

const LintDisableGutterExtension = Extension.create({
  name: "lintDisableGutter",
  addProseMirrorPlugins() {
    return [createLintDisableGutterPlugin()];
  },
});

const CommentDecorationExtension = Extension.create({
  name: "commentDecoration",
  addProseMirrorPlugins() {
    return [createCommentDecorationPlugin()];
  },
});

const AnnotationDecorationExtension = Extension.create({
  name: "annotationDecoration",
  addProseMirrorPlugins() {
    return [createAnnotationPlugin()];
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
      // Ctrl+Shift+M — add inline comment to selection
      "Mod-Shift-m": () => {
        const { from, to } = this.editor.state.selection;
        if (from === to) return false;
        useCursorSettingsStore.getState().setCommentPickerOpen(true);
        return true;
      },
      // Ctrl+Shift+F — open foreshadow mark picker for selection
      "Mod-Shift-f": () => {
        const { from, to } = this.editor.state.selection;
        if (from === to) return false;
        useCursorSettingsStore.getState().setForeshadowPickerOpen(true);
        return true;
      },
    };
  },
});

/**
 * Centralizes all TipTap extensions.
 * Each feature registers its extensions here to avoid merge conflicts
 * when multiple features add extensions in parallel.
 */
export function getEditorExtensions(
  options: EditorExtensionOptions = {},
): Extensions {
  const extensions: Extensions = [
    StarterKit.configure({
      paragraph: false,
      link: {
        openOnClick: false,
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      },
    }),
    ParagraphWithEmptyLineSupport,
    Markdown.configure({ html: true }),
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
    SceneBeatNode,
    GeneratedProseBlockNode,
    FindReplaceExtension,
    InlineAtomNavigationExtension,
    SlashCommandExtension,
    LintDecorationExtension,
    LintDisableMark,
    LintDisableBlockAttrs,
    LintDisableGutterExtension,
    CommentMark,
    CommentDecorationExtension,
    ForeshadowSetupMark,
    ForeshadowPayoffMark,
    ForeshadowPasteRule,
    AnnotationMark,
    AnnotationDecorationExtension,
  ];

  if (options.setMentionPopup) {
    extensions.push(createCodexMentionExtension(options.setMentionPopup));
  }

  return extensions;
}

export function getReadonlyEditorExtensions(
  options: EditorExtensionOptions = {},
): Extensions {
  return getEditorExtensions(options).filter(
    (ext) => ext.name !== "placeholder",
  );
}

/** Minimal TipTap preset for Sticky note editor. */
export function getStickyEditorExtensions(): Extensions {
  return [
    StarterKit,
    Markdown.configure({ html: false }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({ placeholder: "思いついたことを書く…" }),
    AuthorshipMark,
  ];
}
