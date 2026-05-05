export type MapMode = "free" | "theme";
export type NodeRefType =
  | "scene"
  | "codex"
  | "snippet"
  | "note"
  | "sticky"
  | "ai_branch";
export type SceneDisplayVariant = "compact" | "auto";
export type ColorByAxis = "none" | "status" | "stickyColor";
export type VisualTheme = "default" | "corkboard" | "constellation";
export type StickyColor =
  | "yellow"
  | "orange"
  | "pink"
  | "green"
  | "blue"
  | "purple"
  | "gray"
  | "white";

export interface MapNodePositionRecord {
  id: string;
  boardId: string;
  nodeRefType: NodeRefType;
  treeNodeId: string | null;
  codexEntryId: string | null;
  snippetId: string | null;
  stickyId: string | null;
  aiBranchId: string | null;
  x: number;
  y: number;
  pinned: number;
  zIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface MapBoardRecord {
  id: string;
  projectId: string;
  title: string;
  sortOrder: number;
  mode: MapMode;
  viewportX: number;
  viewportY: number;
  viewportZoom: number;
  showConfig: string;
  colorBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShowFlags {
  scenes: boolean;
  codex: boolean;
  snippets: boolean;
  notes: boolean;
  stickies: boolean;
  aiBranch: boolean;
  derivedEdges: boolean;
  userEdges: boolean;
  frames: boolean;
}

export interface MapPersistentState {
  activeBoardId: string | null;
  gridSnap: boolean;
  minimapVisible: boolean;
  visualTheme: VisualTheme;
  colorBy: ColorByAxis;
}

// Auto-mode default: compact
export function resolveSceneVariant(variant: SceneDisplayVariant): "compact" {
  void variant;
  return "compact";
}
