import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import Placeholder from "@tiptap/extension-placeholder";
import type { Extensions } from "@tiptap/core";
import { ChatInputKeymap } from "./ChatInputKeymap";
import type { MentionPopupState } from "./ChatMentionExtension";
import { createChatMentionExtension } from "./ChatMentionExtension";
import type { CommandPopupState } from "./ChatSlashCommandExtension";
import { createChatSlashCommandExtension } from "./ChatSlashCommandExtension";

export interface ChatInputExtensionOptions {
  placeholder: string;
  onSubmit: (markdown: string) => void;
  onStop: () => void;
  setMentionPopup?: (state: MentionPopupState | null) => void;
  setCommandPopup?: (state: CommandPopupState | null) => void;
}

/**
 * チャット入力エリア用の TipTap 拡張セット。
 * メインエディタのサブセット（見出し・コードブロック・水平線なし）。
 */
export function getChatInputExtensions(
  options: ChatInputExtensionOptions,
): Extensions {
  const extensions: Extensions = [
    StarterKit.configure({
      heading: false,
      codeBlock: false,
      horizontalRule: false,
    }),
    Markdown.configure({ html: false }),
    Placeholder.configure({ placeholder: options.placeholder }),
    ChatInputKeymap.configure({
      onSubmit: options.onSubmit,
      onStop: options.onStop,
    }),
  ];

  if (options.setMentionPopup) {
    extensions.push(createChatMentionExtension(options.setMentionPopup));
  }

  if (options.setCommandPopup) {
    extensions.push(createChatSlashCommandExtension(options.setCommandPopup));
  }

  return extensions;
}
