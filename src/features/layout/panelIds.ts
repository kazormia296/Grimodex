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
  | "map"
  | "kouetsu"
  | "foreshadow"
  | "grid"
  | "matrix"
  | "trash-bin"
  | "timelapse"
  | "command-center-results";

/** MIME type used to transfer panel IDs during external drag operations */
export const PANEL_DRAG_TYPE = "application/grimodex-panel-id";
