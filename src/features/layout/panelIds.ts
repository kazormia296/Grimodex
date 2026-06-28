/** All panel identifiers in the layout system */
export type PanelId =
  | "scenes"
  | "codex"
  | "chat-history"
  | "editor"
  | "chat"
  | "snippets"
  | "attribution"
  | "codex-quick"
  | "timeline"
  | "chronicle"
  | "map"
  | "kouetsu"
  | "foreshadow"
  | "grid"
  | "matrix"
  | "trash-bin"
  | "writing-stats"
  | "command-center-results";

/** MIME type used to transfer panel IDs during external drag operations */
export const PANEL_DRAG_TYPE = "application/grimodex-panel-id";
