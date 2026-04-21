export type MapMode = "free" | "time" | "theme" | "pov" | "place";
export type NodeRefType = "scene" | "codex" | "note" | "ai";
export type SceneDisplayVariant = "compact" | "card" | "image" | "auto";
export type ColorByAxis = "none" | "status";

export interface MapNodePositionRecord {
  id: string;
  boardId: string;
  nodeRefType: NodeRefType;
  treeNodeId: string | null;
  codexEntryId: string | null;
  aiNodeId: string | null;
  x: number;
  y: number;
  pinned: number;
  hidden: number;
  zIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface MapBoardRecord {
  id: string;
  projectId: string;
  title: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShowFlags {
  scenes: boolean;
  codex: boolean;
  notes: boolean;
  ai: boolean;
  derivedEdges: boolean;
  userEdges: boolean;
  frames: boolean;
}

export interface MapPersistentState {
  mode: MapMode;
  viewport: { x: number; y: number; zoom: number };
  show: ShowFlags;
  gridSnap: boolean;
  minimapVisible: boolean;
  sceneDisplayByMode: Record<MapMode, SceneDisplayVariant>;
  colorBy: ColorByAxis;
  corkboardFeel: boolean;
}

// Auto-mode defaults: Free → card, others → compact
export function resolveSceneVariant(
  variant: SceneDisplayVariant,
  mode: MapMode,
): "compact" | "card" | "image" {
  if (variant !== "auto") return variant;
  return mode === "free" ? "card" : "compact";
}
