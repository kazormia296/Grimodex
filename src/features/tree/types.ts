export type NodeType = "folder" | "scene" | "note";

export type SceneStatus =
  | "outline"
  | "draft"
  | "complete"
  | "revision"
  | "final";

export interface TreeNodeData {
  id: string;
  projectId: string;
  parentId: string | null;
  nodeType: NodeType;
  title: string;
  synopsis: string | null;
  intent: string | null;
  /** Fractional-indexing key (base62, lexical ordering). */
  sortOrder: string;
  status: string | null;
  storyTimeOrder: string | null;
  storyTimeLabel: string | null;
  povCharacterId: string | null;
  locationId: string | null;
  chronicleStartTime?: number | null;
  chronicleStartMinute?: number | null;
  chronicleStartGranularity?: string;
  chronicleEndTime?: number | null;
  chronicleEndMinute?: number | null;
  chronicleEndGranularity?: string;
  chroniclePrecision?: string;
  charCount: number;
  sourceUri?: string | null;
  sourceMtime?: string | null;
  archivedAt?: string | null;
  content?: string;
  contextMode?: string | null;
  aliases?: string | null;
  excludedAliases?: string | null;
  createdAt: string;
  updatedAt: string;
}
