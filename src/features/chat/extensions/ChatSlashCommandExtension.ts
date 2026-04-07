import { Extension } from "@tiptap/core";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionProps } from "@tiptap/suggestion";
import type { ChatCommand } from "./chatCommands";
import { filterChatCommands } from "./chatCommands";

export interface CommandPopupState {
  items: ChatCommand[];
  selectedIndex: number;
  clientRect: (() => DOMRect | null) | null | undefined;
  command: ((cmd: ChatCommand) => void) | null;
}

/**
 * / コマンド補完拡張。
 * 行頭または改行直後の "/" でコマンドリストを表示する。
 */
export function createChatSlashCommandExtension(
  setPopup: (state: CommandPopupState | null) => void,
) {
  return Extension.create({
    name: "chatSlashCommand",

    addProseMirrorPlugins() {
      return [
        Suggestion<ChatCommand>({
          editor: this.editor,
          char: "/",
          allow({ state, range }) {
            // 行頭または改行直後のみ許可
            const $from = state.doc.resolve(range.from);
            const textBefore = $from.parent.textContent.slice(
              0,
              $from.parentOffset - 1,
            );
            return textBefore.trim() === "";
          },
          items({ query }: { query: string }) {
            return filterChatCommands(query);
          },
          render() {
            return {
              onStart(props: SuggestionProps<ChatCommand>) {
                setPopup({
                  items: props.items,
                  selectedIndex: 0,
                  clientRect: props.clientRect,
                  command: (cmd: ChatCommand) => props.command(cmd),
                });
              },
              onUpdate(props: SuggestionProps<ChatCommand>) {
                setPopup({
                  items: props.items,
                  selectedIndex: 0,
                  clientRect: props.clientRect,
                  command: (cmd: ChatCommand) => props.command(cmd),
                });
              },
              onKeyDown({ event }: { event: KeyboardEvent }) {
                if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp" ||
                  event.key === "Enter"
                ) {
                  return true;
                }
                return false;
              },
              onExit() {
                setPopup(null);
              },
            };
          },
          command({ editor, range, props }) {
            // コマンドテキストを削除してカスタムイベントで通知
            editor.chain().focus().deleteRange(range).run();
            editor.view.dom.dispatchEvent(
              new CustomEvent("chat-command-select", {
                detail: { commandId: props.id },
                bubbles: true,
              }),
            );
          },
        }),
      ];
    },
  });
}
