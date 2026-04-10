import { Extension } from "@tiptap/core";

interface ChatInputKeymapOptions {
  onSubmit: (markdown: string) => void;
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
      onSubmit: () => {},
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
        this.options.onSubmit(markdown);
        editor.commands.clearContent();
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
