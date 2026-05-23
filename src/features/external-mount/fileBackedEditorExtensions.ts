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
import type { Extensions } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import i18next from "@/lib/i18n";

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
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData("text/plain");
            if (!text) return false;
            const sanitized = sanitizePastedMarkdown(text);
            const { tr } = view.state;
            view.dispatch(tr.insertText(sanitized));
            return true;
          },
        },
      }),
    ];
  },
});

const FILE_BACKED_EXTENSIONS: Extensions = [
  StarterKit.configure({
    bulletList: false,
    orderedList: false,
    listItem: false,
    link: {
      openOnClick: true,
      HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
    },
  }),
  Markdown.configure({ html: true }),
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

/** Restricted TipTap extensions for external MD-backed scenes. */
export function getFileBackedEditorExtensions(): Extensions {
  return FILE_BACKED_EXTENSIONS;
}
