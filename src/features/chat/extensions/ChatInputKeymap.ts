import { Extension } from "@tiptap/core";

interface ChatInputKeymapOptions {
  onSubmit: (markdown: string) => Promise<boolean>;
  onStop: () => void;
  onEditLast?: () => void;
}

/**
 * チャット入力用キーマップ拡張。
 * Enter → 送信、Shift+Enter → 改行、Escape → 停止
 */
export const ChatInputKeymap = Extension.create<ChatInputKeymapOptions>({
  name: "chatInputKeymap",

  addOptions() {
    return {
      onSubmit: async () => false,
      onStop: () => {},
      onEditLast: undefined as (() => void) | undefined,
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const text = editor.getText().trim();
        if (!text) return false;

        // tiptap-markdown の storage から Markdown を取得
        const markdownStorage = editor.storage as unknown as Record<
          string,
          { getMarkdown?: () => string } | undefined
        >;
        const markdown: string =
          markdownStorage.markdown?.getMarkdown?.() ?? text;
        void this.options
          .onSubmit(markdown)
          .then((accepted) => {
            if (accepted && !editor.isDestroyed) {
              editor.commands.clearContent();
            }
          })
          .catch(() => {
            // The composer owns user-visible error reporting. A rejected
            // preflight must still retain the draft without an unhandled task.
          });
        return true;
      },
      ArrowUp: ({ editor }) => {
        // Only intercept when editor is empty — restores last user message
        if (!editor.isEmpty) return false;
        this.options.onEditLast?.();
        return true;
      },
      "Shift-Enter": ({ editor }) => {
        editor.commands.setHardBreak();
        return true;
      },
      Escape: () => {
        this.options.onStop();
        return false; // デフォルト動作もブロックしない
      },
    };
  },
});
