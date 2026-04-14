import i18next from "@/lib/i18n";
import type { InlineAiCommand } from "./inlineAiTypes";

export const INLINE_AI_COMMANDS: InlineAiCommand[] = [
  {
    id: "continue",
    label: "続きを書く",
    description: "カーソル位置から続きを生成",
    mode: "insert",
    needsSelection: false,
  },
  {
    id: "rewrite",
    label: "書き直す",
    description: "選択テキストを書き直す",
    mode: "replace",
    needsSelection: true,
  },
  {
    id: "describe",
    label: "描写する",
    description: "場所・人物・物の描写を生成",
    mode: "insert",
    needsSelection: false,
    needsArg: true,
    argPlaceholder: "例: 酒場、エララ…",
  },
  {
    id: "dialogue",
    label: "台詞を書く",
    description: "キャラクターの台詞を生成",
    mode: "insert",
    needsSelection: false,
    needsArg: true,
    argPlaceholder: "キャラクター名",
  },
  {
    id: "shorten",
    label: "短くする",
    description: "選択テキストを簡潔にする",
    mode: "replace",
    needsSelection: true,
  },
  {
    id: "expand",
    label: "膨らませる",
    description: "選択テキストに詳細を追加",
    mode: "replace",
    needsSelection: true,
  },
  {
    id: "tone",
    label: "トーンを変える",
    description: "選択テキストのトーンを変更",
    mode: "replace",
    needsSelection: true,
    needsArg: true,
    argPlaceholder: "例: 暗く、ユーモラスに…",
  },
  {
    id: "translate",
    label: "翻訳する",
    description: "選択テキストを翻訳",
    mode: "replace",
    needsSelection: true,
    needsArg: true,
    argPlaceholder: "例: English、日本語…",
  },
  {
    id: "custom",
    label: "カスタム",
    description: "自由な指示を入力",
    mode: "insert",
    needsSelection: false,
    needsArg: true,
    argPlaceholder: "指示を入力…",
  },
];

export function filterCommands(query: string): InlineAiCommand[] {
  const q = query.toLowerCase().trim();
  if (!q) return INLINE_AI_COMMANDS;
  return INLINE_AI_COMMANDS.filter(
    (cmd) =>
      cmd.id.startsWith(q) ||
      i18next
        .t(`inlineAi.commands.${cmd.id}.label`)
        .toLowerCase()
        .includes(q) ||
      i18next.t(`inlineAi.commands.${cmd.id}.desc`).toLowerCase().includes(q),
  );
}
