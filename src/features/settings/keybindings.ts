import i18next from "i18next";

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

export function getCommands(): CommandDef[] {
  return [
    {
      id: "focusScenes",
      label: i18next.t("keys.focusScenes"),
      defaultBinding: "Ctrl+Alt+S",
    },
    {
      id: "focusChat",
      label: i18next.t("keys.focusChat"),
      defaultBinding: "Ctrl+Alt+C",
    },
    {
      id: "focusCodex",
      label: i18next.t("keys.focusCodex"),
      defaultBinding: "Ctrl+Alt+X",
    },
    {
      id: "focusSnippets",
      label: i18next.t("keys.focusSnippets"),
      defaultBinding: "Ctrl+Alt+N",
    },
    {
      id: "focusAttribution",
      label: i18next.t("keys.focusAttribution"),
      defaultBinding: "Ctrl+Alt+A",
    },
    {
      id: "focusChatHistory",
      label: i18next.t("keys.focusChatHistory"),
      defaultBinding: "Ctrl+Alt+H",
    },
    {
      id: "openSettings",
      label: i18next.t("keys.openSettings"),
      defaultBinding: "Ctrl+Alt+,",
    },
    {
      id: "splitVertical",
      label: i18next.t("keys.splitVertical"),
      defaultBinding: "Ctrl+\\",
    },
    {
      id: "splitHorizontal",
      label: i18next.t("keys.splitHorizontal"),
      defaultBinding: "Ctrl+Shift+\\",
    },
    {
      id: "nextTab",
      label: i18next.t("keys.nextTab"),
      defaultBinding: "Ctrl+Tab",
    },
    {
      id: "prevTab",
      label: i18next.t("keys.prevTab"),
      defaultBinding: "Ctrl+Shift+Tab",
    },
    { id: "find", label: i18next.t("keys.find"), defaultBinding: "Ctrl+F" },
    {
      id: "findReplace",
      label: i18next.t("keys.findReplace"),
      defaultBinding: "Ctrl+H",
    },
    {
      id: "inlineAiPalette",
      label: i18next.t("keys.inlineAiPalette"),
      defaultBinding: "Ctrl+Shift+Space",
    },
  ];
}

export const DEFAULT_KEYBINDINGS: Record<string, string> = Object.fromEntries(
  getCommands().map((c) => [c.id, c.defaultBinding]),
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
