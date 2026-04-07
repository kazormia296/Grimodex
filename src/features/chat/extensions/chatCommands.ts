export interface ChatCommand {
  id: string;
  label: string;
  description: string;
  needsArg?: boolean;
  argPlaceholder?: string;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    id: "continue",
    label: "/continue",
    description: "現在のシーンの続きを生成",
  },
  {
    id: "describe",
    label: "/describe",
    description: "対象の描写を生成",
    needsArg: true,
    argPlaceholder: "対象",
  },
  {
    id: "dialogue",
    label: "/dialogue",
    description: "キャラクターの台詞を生成",
    needsArg: true,
    argPlaceholder: "キャラ名",
  },
  {
    id: "summarize",
    label: "/summarize",
    description: "現在のシーンの要約を生成",
  },
  {
    id: "brainstorm",
    label: "/brainstorm",
    description: "プロットのブレインストーミング",
  },
  {
    id: "rewrite",
    label: "/rewrite",
    description: "選択中テキストの書き直し",
  },
  {
    id: "translate",
    label: "/translate",
    description: "選択テキストを翻訳",
    needsArg: true,
    argPlaceholder: "言語",
  },
];

/** クエリ文字列でコマンドをフィルタリング（大文字小文字無視）*/
export function filterChatCommands(query: string): ChatCommand[] {
  if (!query) return CHAT_COMMANDS;
  const q = query.toLowerCase();
  return CHAT_COMMANDS.filter(
    (c) => c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q),
  );
}
