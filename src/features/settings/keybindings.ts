export interface KeyCombo {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  key: string;
}

export interface CommandDef {
  id: string;
  label: string;
  defaultBinding: string;
}

export const COMMANDS: CommandDef[] = [
  {
    id: "focusScenes",
    label: "Scenes パネルにフォーカス",
    defaultBinding: "Ctrl+Alt+S",
  },
  {
    id: "focusChat",
    label: "Chat パネルにフォーカス",
    defaultBinding: "Ctrl+Alt+C",
  },
  {
    id: "focusCodex",
    label: "Codex パネルにフォーカス",
    defaultBinding: "Ctrl+Alt+X",
  },
  {
    id: "focusSnippets",
    label: "Snippets パネルにフォーカス",
    defaultBinding: "Ctrl+Alt+N",
  },
  {
    id: "focusAttribution",
    label: "Attribution パネルにフォーカス",
    defaultBinding: "Ctrl+Alt+A",
  },
  {
    id: "focusChatHistory",
    label: "Chat History パネルにフォーカス",
    defaultBinding: "Ctrl+Alt+H",
  },
  {
    id: "openSettings",
    label: "Settings を開く",
    defaultBinding: "Ctrl+Alt+,",
  },
  { id: "splitVertical", label: "エディタを縦分割", defaultBinding: "Ctrl+\\" },
  {
    id: "splitHorizontal",
    label: "エディタを横分割",
    defaultBinding: "Ctrl+Shift+\\",
  },
  { id: "find", label: "検索", defaultBinding: "Ctrl+F" },
  { id: "findReplace", label: "検索と置換", defaultBinding: "Ctrl+H" },
  {
    id: "inlineAiPalette",
    label: "インライン AI パレット",
    defaultBinding: "Ctrl+Shift+Space",
  },
];

export const DEFAULT_KEYBINDINGS: Record<string, string> = Object.fromEntries(
  COMMANDS.map((c) => [c.id, c.defaultBinding]),
);

export function parseKeybinding(str: string): KeyCombo {
  const parts = str.split("+");
  const key = parts[parts.length - 1];
  return {
    ctrl: parts.includes("Ctrl"),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
    meta: parts.includes("Meta"),
    key,
  };
}

export function keybindingToString(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");
  if (combo.meta) parts.push("Meta");
  parts.push(combo.key);
  return parts.join("+");
}

export function keyEventToString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  return parts.join("+");
}

export interface ConflictInfo {
  commandId: string;
  binding: string;
}

export function detectConflicts(
  bindings: Record<string, string>,
  excludeId: string,
): ConflictInfo[] {
  const target = bindings[excludeId];
  if (!target) return [];
  return Object.entries(bindings)
    .filter(([id, b]) => id !== excludeId && b === target)
    .map(([id, b]) => ({ commandId: id, binding: b }));
}
