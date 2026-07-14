import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Author-defined semantic link from an exact prose span to a Codex entry.
 *
 * This is deliberately separate from CodexHighlightPlugin's automatic
 * string-match decorations: Marks are persisted with the ProseMirror JSON and
 * remain stable when an entry name or alias changes.
 */
export const CodexSemanticLinkMark = Mark.create({
  name: "codexSemanticLink",

  // Typing exactly at either edge must not silently grow the semantic range.
  inclusive: false,
  // Enter inside a linked span must not carry the active link into the new block.
  keepOnSplit: false,
  // Semantic metadata survives generic "clear formatting" actions.
  clearable: false,
  // A character can point at only one Codex entry, while remaining compatible
  // with formatting, comments, foreshadow marks, and ordinary URL links.
  excludes: "codexSemanticLink",

  addAttributes() {
    return {
      entryId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-codex-entry-id"),
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-codex-entry-label"),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-codex-semantic-link]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const { entryId, label, ...rest } = HTMLAttributes;
    return [
      "span",
      mergeAttributes(rest, {
        class: "codex-semantic-link",
        "data-codex-semantic-link": "",
        "data-codex-entry-id": entryId,
        "data-codex-entry-label": label,
      }),
      0,
    ];
  },
});
