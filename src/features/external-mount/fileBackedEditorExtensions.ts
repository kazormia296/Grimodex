import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import { FindReplaceExtension } from "@/features/editor/FindReplaceExtension";
import { ParagraphWithEmptyLineSupport } from "@/features/editor/extensions";
import type { Extensions } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import i18next from "@/lib/i18n";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  handleExternalPaste,
  notePlainPasteKeyDown,
} from "@/features/editor/markdownPaste";

/** Strip unsupported marks/nodes from pasted rich content. */
export function sanitizePastedMarkdown(markdown: string): string {
  return markdown
    .replace(/｜[^《]+《[^》]+》/g, (m) =>
      m.replace(/｜([^《]+)《[^》]+》/, "$1"),
    )
    .replace(/《《([^》]+)》》/g, "$1");
}

const PasteSanitizerExtension = Extension.create({
  name: "fileBackedPasteSanitizer",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handlePaste(_view, event) {
            // ruby 記法を除去してから Markdown を変換する共有ハンドラに委譲
            // (file-backed は authorship 非対応のため帰属は付かない)。
            return handleExternalPaste(editor, event, {
              sanitize: sanitizePastedMarkdown,
            });
          },
          handleKeyDown(_view, event) {
            notePlainPasteKeyDown(event);
            return false;
          },
        },
      }),
    ];
  },
});

/**
 * `breaks: true` matches Obsidian's default ("Strict line breaks" OFF) and
 * GFM — single newline within a paragraph becomes a hard break (visible).
 * Setting `editor.markdownStrictLineBreaks = true` opts into CommonMark spec
 * behaviour (soft break = space). Round-trip safety: the doc-level join in
 * exportEngine preserves paragraph boundaries via blank lines, and the
 * `hardBreak` case there emits `\n` so a re-parse reproduces the same
 * hardBreak node.
 *
 * Read fresh on each call — toggling the setting takes effect on the next
 * parse / next file open without app restart (already-open editors keep
 * the breaks mode they were constructed with).
 */
export function isStrictLineBreaks(): boolean {
  try {
    return useSettingsStore
      .getState()
      .getBoolean("editor.markdownStrictLineBreaks", false);
  } catch {
    // Defensive: if the store is not yet hydrated (early boot), default to
    // Obsidian-compatible behaviour.
    return false;
  }
}

function buildFileBackedExtensions(strict: boolean): Extensions {
  return [
    // bulletList/orderedList/listItem は StarterKit デフォルトのまま有効化する。
    // disable すると tiptap-markdown が `- ` をパースしても受け皿の node 型が無く、
    // リストマーカーが落ちる → disk の生 Markdown と pmJsonToMarkdown 経由の
    // 再生成結果が乖離して rename 検出 (mountManager.hashForNode) が外れる。
    //
    // paragraph: false + ParagraphWithEmptyLineSupport で empty paragraph node を
    // `<p></p>` として serialize し、blank-line marker のラウンドトリップを成立
    // させる (markdownBridge.normalizeImportedMarkdown が連続空行を `<p></p>` に
    // 展開して import するので、serialize 側もそれに合わせないと書き戻しで消える)。
    StarterKit.configure({
      paragraph: false,
      link: {
        openOnClick: true,
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      },
    }),
    ParagraphWithEmptyLineSupport,
    Markdown.configure({ html: true, breaks: !strict }),
    Placeholder.configure({
      placeholder: () => i18next.t("editor.placeholder"),
    }),
    CharacterCount,
    FindReplaceExtension,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: true, allowBase64: true }),
    PasteSanitizerExtension,
  ];
}

/** Restricted TipTap extensions for external MD-backed scenes. */
export function getFileBackedEditorExtensions(): Extensions {
  return buildFileBackedExtensions(isStrictLineBreaks());
}
