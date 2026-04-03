import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * EmphasisDotsMark — 傍点（圏点）マーク
 * Renders text with emphasis dots (sesame marks) above characters.
 * Keyboard shortcut: Ctrl+. (Cmd+.)
 * Markdown: 《圏点:text》
 */
export const EmphasisDotsMark = Mark.create({
  name: "emphasisDots",

  parseHTML() {
    return [{ tag: "span.emphasis-dots" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ class: "emphasis-dots" }, HTMLAttributes),
      0,
    ];
  },

  addKeyboardShortcuts() {
    return {
      "Mod-.": () => this.editor.commands.toggleMark(this.name),
    };
  },
});
