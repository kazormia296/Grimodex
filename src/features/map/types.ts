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
export type MapViewKind = "board" | "galaxy";

export interface GalaxyNodeFlags {
  scenes: boolean;
  codex: boolean;
  events: boolean;
  threads: boolean;
}

export interface GalaxyEdgeFlags {
  mention: boolean;
  relation: boolean;
  sequence: boolean;
  eventLink: boolean;
  participant: boolean;
  thread: boolean;
}

export interface GalaxyFilters {
  nodes: GalaxyNodeFlags;
  edges: GalaxyEdgeFlags;
  hideOrphans: boolean;
}

export interface GalaxyFiltersPatch {
  nodes?: Partial<GalaxyNodeFlags>;
  edges?: Partial<GalaxyEdgeFlags>;
  hideOrphans?: boolean;
}

export const DEFAULT_GALAXY_FILTERS: GalaxyFilters = {
  nodes: { scenes: true, codex: true, events: true, threads: true },
  edges: {
    mention: true,
    relation: true,
    sequence: true,
    eventLink: true,
    participant: true,
    thread: true,
  },
  hideOrphans: false,
};

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

export const DEFAULT_SHOW: ShowFlags = {
  scenes: true,
  codex: true,
  snippets: true,
  notes: true,
  stickies: true,
  aiBranch: true,
  derivedEdges: true,
  userEdges: true,
  frames: true,
};

export interface MapPersistentState {
  activeBoardId: string | null;
  gridSnap: boolean;
  minimapVisible: boolean;
  visualTheme: VisualTheme;
  viewKind: MapViewKind;
  galaxyFilters: GalaxyFilters;
}

// Auto-mode default: compact
export function resolveSceneVariant(variant: SceneDisplayVariant): "compact" {
  void variant;
  return "compact";
}
