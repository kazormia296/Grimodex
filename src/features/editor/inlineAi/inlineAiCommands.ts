import i18next from "@/lib/i18n";
import { isAiFeatureBlockedByPolicy } from "@/features/ai-policy/policyGuard";
import type { InlineAiCommand } from "./inlineAiTypes";

interface InlineAiCommandDef {
  id: string;
  mode: "insert" | "replace";
  needsSelection: boolean;
  needsArg?: boolean;
  kind?: "ai" | "insert-node";
}

const COMMAND_DEFS: InlineAiCommandDef[] = [
  { id: "continue", mode: "insert", needsSelection: false },
  { id: "rewrite", mode: "replace", needsSelection: true },
  { id: "describe", mode: "insert", needsSelection: false, needsArg: true },
  { id: "dialogue", mode: "insert", needsSelection: false, needsArg: true },
  { id: "shorten", mode: "replace", needsSelection: true },
  { id: "expand", mode: "replace", needsSelection: true },
  { id: "tone", mode: "replace", needsSelection: true, needsArg: true },
  { id: "translate", mode: "replace", needsSelection: true, needsArg: true },
  { id: "custom", mode: "insert", needsSelection: false, needsArg: true },
  // Beat system (Phase A): structural insertion, no AI generation here.
  {
    id: "sceneBeat",
    mode: "insert",
    needsSelection: false,
    kind: "insert-node",
  },
];

export function getInlineAiCommands(): InlineAiCommand[] {
  return COMMAND_DEFS.map((def) => ({
    ...def,
    label: i18next.t(`inlineAi.commands.${def.id}.label`),
    description: i18next.t(`inlineAi.commands.${def.id}.desc`),
    ...(def.needsArg && {
      argPlaceholder: i18next.t(`inlineAi.commands.${def.id}.placeholder`),
    }),
  }));
}

/** @deprecated Use getInlineAiCommands() for localized commands */
export const INLINE_AI_COMMANDS = COMMAND_DEFS;

/** AI 生成コマンドか。sceneBeat(insert-node)は構造挿入なので AI ではない。 */
export function isAiGenerationCommand(cmd: InlineAiCommand): boolean {
  return cmd.kind !== "insert-node";
}

/**
 * 現在のポリシーで表示してよいインライン AI コマンド一覧。
 * bodyWrite=OFF のとき AI 生成コマンド(continue/rewrite 等)を slash/palette の
 * 一覧から除外する。sceneBeat(構造挿入)は残す。presentation 層の filter であり、
 * 実 enforcement は useInlineAiDiff.generate の policy ガードが担う。
 */
export function getVisibleInlineAiCommands(): InlineAiCommand[] {
  const all = getInlineAiCommands();
  if (!isAiFeatureBlockedByPolicy("bodyWrite")) return all;
  return all.filter((cmd) => !isAiGenerationCommand(cmd));
}

export function filterCommands(query: string): InlineAiCommand[] {
  const commands = getVisibleInlineAiCommands();
  const q = query.toLowerCase().trim();
  if (!q) return commands;
  return commands.filter(
    (cmd) =>
      cmd.id.startsWith(q) ||
      cmd.label.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q),
  );
}
