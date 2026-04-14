import i18next from "@/lib/i18n";
import type { InlineAiCommand } from "./inlineAiTypes";

interface InlineAiCommandDef {
  id: string;
  mode: "insert" | "replace";
  needsSelection: boolean;
  needsArg?: boolean;
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

export function filterCommands(query: string): InlineAiCommand[] {
  const commands = getInlineAiCommands();
  const q = query.toLowerCase().trim();
  if (!q) return commands;
  return commands.filter(
    (cmd) =>
      cmd.id.startsWith(q) ||
      cmd.label.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q),
  );
}
