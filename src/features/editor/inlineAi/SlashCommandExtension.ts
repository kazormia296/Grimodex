import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { filterCommands, getInlineAiCommands } from "./inlineAiCommands";
import type { InlineAiCommand } from "./inlineAiTypes";
import {
  useSlashCommandStore,
  type SlashCommandRect,
} from "./slashCommandStore";

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

function toRect(
  clientRect: (() => DOMRect | null) | null | undefined,
): SlashCommandRect | null {
  if (!clientRect) return null;
  const rect = clientRect();
  if (!rect) return null;
  return { top: rect.top, left: rect.left, bottom: rect.bottom };
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
          // editor.inlineAiCommand トグル。"/" 入力のたびに評価されるので
          // 実行時参照ならエディタ再生成なしで設定変更が効く。
          if (
            !useSettingsStore
              .getState()
              .getBoolean("editor.inlineAiCommand", true)
          ) {
            return false;
          }
          const $from = state.doc.resolve(range.from);
          const textBefore = $from.parent.textBetween(
            0,
            $from.parentOffset,
            undefined,
            "￼",
          );
          return textBefore.trim() === "" || $from.parentOffset === 0;
        },
        items({ query }: { query: string }) {
          return filterCommands(query);
        },
        command({ editor, range, props }) {
          // 入力した "/" およびクエリ文字を削除
          editor.chain().focus().deleteRange(range).run();
          // 選択結果を EditorPane 側へ通知（既存の CustomEvent 経路を踏襲）。
          // needsArg のコマンドは EditorPane 側で引数入力 UI を開く。
          const event = new CustomEvent("inlineai:slash-command", {
            detail: { command: props as InlineAiCommand },
            bubbles: true,
          });
          editor.view.dom.dispatchEvent(event);
        },
        render: () => {
          const store = useSlashCommandStore;
          return {
            onStart(props) {
              store.getState().open({
                items: props.items as InlineAiCommand[],
                query: props.query ?? "",
                rect: toRect(props.clientRect),
                commandFn: props.command as (c: InlineAiCommand) => void,
              });
            },
            onUpdate(props) {
              store.getState().update({
                items: props.items as InlineAiCommand[],
                query: props.query ?? "",
                rect: toRect(props.clientRect),
              });
            },
            onKeyDown({ event }) {
              return store.getState().keyHandler?.(event) ?? false;
            },
            onExit() {
              store.getState().close();
            },
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

export { getInlineAiCommands };
