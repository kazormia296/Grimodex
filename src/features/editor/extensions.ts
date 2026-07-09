import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import Paragraph from "@tiptap/extension-paragraph";
import { defaultMarkdownSerializer } from "prosemirror-markdown";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { RubyNode } from "@/features/editor/RubyNode";
import { EmphasisDotsMark } from "@/features/editor/EmphasisDotsMark";
import { TcyMark } from "@/features/editor/TcyMark";
import { AozoraInputRules } from "@/features/editor/AozoraInputRules";
import { AutoPairBracketsExtension } from "@/features/editor/AutoPairBracketsExtension";
import { SceneBreakNode } from "@/features/editor/SceneBreakNode";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import { FindReplaceExtension } from "@/features/editor/FindReplaceExtension";
import { ParagraphMoveExtension } from "@/features/editor/ParagraphMoveExtension";
import { ParagraphReorderExtension } from "@/features/editor/reorder/ParagraphReorderExtension";
import { ReorderInteractionExtension } from "@/features/editor/reorder/ReorderInteractionExtension";
import { VerticalCaretNavExtension } from "@/features/editor/VerticalCaretNavExtension";
import { InlineAtomNavigationExtension } from "@/features/editor/InlineAtomNavigationExtension";
import { SlashCommandExtension } from "@/features/editor/inlineAi/SlashCommandExtension";
import { getTypographyExtensions } from "@/features/editor/TypographySettingsExtension";
import { createLintDecorationPlugin } from "@/features/editor/LintDecorationPlugin";
import { createLintDisableGutterPlugin } from "@/features/editor/LintDisableGutterPlugin";
import { LintDisableMark } from "@/features/editor/LintDisableMark";
import { LintDisableBlockAttrs } from "@/features/editor/LintDisableBlockAttrs";
import { CommentMark } from "@/features/editor/CommentMark";
import { createCommentDecorationPlugin } from "@/features/editor/CommentDecorationPlugin";
import { createGutterMarksPlugin } from "@/features/editor/GutterMarksPlugin";
import { ForeshadowSetupMark } from "@/features/foreshadow/marks/ForeshadowSetupMark";
import { ForeshadowPayoffMark } from "@/features/foreshadow/marks/ForeshadowPayoffMark";
import { ForeshadowPasteRule } from "@/features/foreshadow/marks/foreshadowPasteRule";
import { AnnotationMark } from "@/features/post-effect/AnnotationMark";
import { createAnnotationPlugin } from "@/features/post-effect/AnnotationPlugin";
export { COMMENT_REBUILD_META } from "@/features/editor/CommentDecorationPlugin";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import {
  createCodexMentionExtension,
  createCodexMentionNodeExtension,
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
//
// Exported so file-backed (external-mount/import) editors can share the same
// serializer — see fileBackedEditorExtensions.ts. Both code paths must agree,
// otherwise round-trip of `<p></p>` blank-paragraph markers is asymmetric and
// `hashForDiskContent` drifts.
export const ParagraphWithEmptyLineSupport = Paragraph.extend({
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
// exported for gutterLintOrder integration test (real TipTap plugin ordering).
export const LintDecorationExtension = Extension.create({
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

// exported for gutterLintOrder integration test (must carry the real priority).
export const GutterMarksExtension = Extension.create({
  name: "gutterMarks",
  // 既定より低い priority で「最後に適用される PM プラグイン」にする。
  // GutterMarksPlugin は review ガター記号のため LintDecorationPlugin の
  // decoration state (lintDecorationKey) を apply 時に読む。TipTap の
  // ExtensionManager.get plugins() は `sortExtensions([...extensions].reverse())`
  // で **登録順を反転** してから priority 降順で安定ソートするため、既定 priority
  // (100) のままだと後から登録した gutter の PM プラグインが lint より **先** に
  // 適用され、gutter.apply 時点で newState の lint field が未計算 (undefined) に
  // なる → hasLint が常に false になり lint 由来のガターが production で出ない。
  // priority を下げて gutter を最後に回すことで、lint を含む全 decoration
  // プラグインの適用後に gutter が走り、確実に最新の lint decoration を読める。
  priority: 90,
  addProseMirrorPlugins() {
    return [createGutterMarksPlugin()];
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
    // smartQuotes/smartDashes 設定で実行時ゲートされる Typography 構成
    ...getTypographyExtensions(),
    // Table
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    ToolbarShortcutsExtension,
    // 段落(最上位ブロック)を Alt+↑/↓ で上下移動
    ParagraphMoveExtension,
    ParagraphReorderExtension,
    // Alt=段落ハンドルドラッグ / Alt+Shift=文/文節 色帯+grab ドラッグ
    ReorderInteractionExtension,
    // 縦書き時の ←/→ 列移動 (Chromium hardBreak バグ) + WebKit の ↑/↓ 列内移動バグ対策
    VerticalCaretNavExtension,
    // Custom marks/nodes
    AuthorshipMark,
    EmphasisDotsMark,
    // 縦中横（明示マーク・第一級の特殊表現）。自動変換(TateChuYokoPlugin)とは別系統。
    TcyMark,
    RubyNode,
    // 青空文庫記法(｜親《ふりがな》/漢字《ふりがな》/《《傍点》》)の入力時変換。
    // ruby/emphasisDots スキーマに依存するため project DB シーンのみ (file-backed 非対応)。
    AozoraInputRules,
    // 約物ペア(「」『』（）等)の自動補完。テキスト操作のみでスキーマ非依存。
    AutoPairBracketsExtension,
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
    GutterMarksExtension,
  ];

  // mention の「ノード型」は常に登録する。popup 未配線のサーフェス
  // (LinearSceneBlock / timelapse schema 等) でノード型が欠けると、mention を
  // 含む doc の setContent が TipTap の silent fallback で空 doc に化けて
  // 本文消失する (スキーマ非対称)。`@` サジェスト UI (suggestion plugin) だけ
  // が setMentionPopup の有無で切り替わる。
  if (options.setMentionPopup) {
    extensions.push(createCodexMentionExtension(options.setMentionPopup));
  } else {
    extensions.push(createCodexMentionNodeExtension());
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
    Placeholder.configure({
      placeholder: () => i18next.t("editor.bodyPlaceholder"),
    }),
    AuthorshipMark,
  ];
}
