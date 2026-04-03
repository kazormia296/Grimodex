import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { filterCommands, INLINE_AI_COMMANDS } from "./inlineAiCommands";
import type { InlineAiCommand } from "./inlineAiTypes";

export type SlashCommandSuggestionOptions = Omit<
  SuggestionOptions<InlineAiCommand>,
  "editor"
>;

declare module "@tiptap/core" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    slashCommand: Record<string, never>;
  }
}

export const SlashCommandExtension = Extension.create<{
  suggestion: Partial<SlashCommandSuggestionOptions>;
}>({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        allow({ state, range }) {
          const $from = state.doc.resolve(range.from);
          const textBefore = $from.parent.textBetween(
            0,
            $from.parentOffset,
            undefined,
            "\uFFFC",
          );
          // Only trigger at line start (empty or first character)
          return textBefore.trim() === "" || $from.parentOffset === 0;
        },
        items({ query }: { query: string }) {
          return filterCommands(query);
        },
        command({ editor, range, props }) {
          // Delete the typed "/" text, then trigger callback
          editor.chain().focus().deleteRange(range).run();
          // Fire a custom event so EditorPane can open the palette with pre-selected command
          const event = new CustomEvent("inlineai:slash-command", {
            detail: { command: props as InlineAiCommand },
            bubbles: true,
          });
          editor.view.dom.dispatchEvent(event);
        },
        render() {
          return {
            onStart() {},
            onUpdate() {},
            onKeyDown() {
              return false;
            },
            onExit() {},
          };
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...(this.options.suggestion as Omit<
          SuggestionOptions<InlineAiCommand>,
          "editor"
        >),
      }),
    ];
  },
});

export { INLINE_AI_COMMANDS };
