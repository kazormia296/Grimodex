import i18next from "@/lib/i18n";

export interface ChatCommand {
  id: string;
  label: string;
  description: string;
  needsArg?: boolean;
  argPlaceholder?: string;
}

interface ChatCommandDef {
  id: string;
  needsArg?: boolean;
}

const COMMAND_DEFS: ChatCommandDef[] = [
  { id: "continue" },
  { id: "describe", needsArg: true },
  { id: "dialogue", needsArg: true },
  { id: "summarize" },
  { id: "brainstorm" },
  { id: "rewrite" },
  { id: "translate", needsArg: true },
];

export function getChatCommands(): ChatCommand[] {
  return COMMAND_DEFS.map((def) => ({
    id: def.id,
    label: `/${def.id}`,
    description: i18next.t(`chatCommands.${def.id}.description`),
    needsArg: def.needsArg,
    ...(def.needsArg && {
      argPlaceholder: i18next.t(`chatCommands.${def.id}.argPlaceholder`),
    }),
  }));
}

/** @deprecated Use getChatCommands() for localized commands */
export const CHAT_COMMANDS = COMMAND_DEFS;

/** Filter commands by query string (case-insensitive) */
export function filterChatCommands(query: string): ChatCommand[] {
  const commands = getChatCommands();
  if (!query) return commands;
  const q = query.toLowerCase();
  return commands.filter(
    (c) => c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q),
  );
}
