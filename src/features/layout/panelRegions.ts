import type { PanelId } from "./layoutStore";

export type PanelRegion = "left" | "center-bottom" | "right";

/** Maps each toggleable panel to its layout region */
export const PANEL_REGION_MAP: Record<
  Exclude<PanelId, "editor">,
  PanelRegion
> = {
  scenes: "left",
  codex: "left",
  "codex-quick": "left",
  "command-center-results": "left",
  chat: "right",
  "chat-history": "right",
  snippets: "center-bottom",
  attribution: "center-bottom",
  timeline: "center-bottom",
  chronicle: "center-bottom",
  map: "center-bottom",
  kouetsu: "center-bottom",
  foreshadow: "center-bottom",
  grid: "center-bottom",
  matrix: "center-bottom",
  "writing-stats": "center-bottom",
  "trash-bin": "center-bottom",
};

/** Keyboard shortcut hints for each panel */
export const KEYBOARD_SHORTCUT_MAP: Partial<Record<PanelId, string>> = {
  scenes: "Ctrl+Alt+S",
  codex: "Ctrl+Alt+X",
  "chat-history": "Ctrl+Alt+H",
  chat: "Ctrl+Alt+C",
  snippets: "Ctrl+Alt+N",
  attribution: "Ctrl+Alt+A",
  "codex-quick": "Ctrl+Alt+Q",
  timeline: "Ctrl+Alt+L",
  chronicle: "Ctrl+Alt+K",
  map: "Ctrl+Alt+M",
  kouetsu: "Ctrl+Alt+T",
  foreshadow: "Ctrl+Alt+F",
  grid: "Ctrl+Alt+G",
  matrix: "Ctrl+Alt+R",
  "writing-stats": "Ctrl+Alt+W",
  "trash-bin": "Ctrl+Alt+B",
  "command-center-results": "Ctrl+Shift+F",
};

/** Panels shown in the dropdown, grouped by region */
export const TOGGLEABLE_PANELS: Exclude<PanelId, "editor">[] = [
  // Left
  "scenes",
  "codex",
  "codex-quick",
  "command-center-results",
  // Right
  "chat",
  "chat-history",
  // Center-bottom
  "snippets",
  "attribution",
  "timeline",
  "chronicle",
  "map",
  "kouetsu",
  "foreshadow",
  "grid",
  "matrix",
  "writing-stats",
  "trash-bin",
];
