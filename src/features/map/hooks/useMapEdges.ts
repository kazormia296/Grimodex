import { useMemo } from "react";
import type { Edge } from "@xyflow/react";
import { buildMapEdgesFromData } from "../boardToReactFlow";
import type { ShowFlags, MapNodePositionRecord } from "../types";

interface UseMapEdgesInput {
  codexEntries: {
    id: string;
    name: string;
    type: string;
    parentId?: string | null;
    tagsCache?: string | null;
  }[];
  treeNodes: {
    id: string;
    nodeType: string;
    title: string;
    synopsis?: string | null;
  }[];
  snippetEntries: { sceneId?: string | null; content: string }[];
  phasesByEntry: Record<
    string,
    { id: string; label?: string | null; anchorNodeId?: string | null }[]
  >;
  userEdges: {
    id: string;
    fromPositionId: string;
    toPositionId: string;
    forwardLabel?: string | null;
    backwardLabel?: string | null;
    style: string;
    color: string;
    direction: string;
  }[];
  codexRelations?: {
    id: string;
    fromCodexId: string;
    toCodexId: string;
    label?: string | null;
    relationType: string;
  }[];
  positions: MapNodePositionRecord[];
  show: ShowFlags;
  onUserEdgeLabelSave?: (
    edgeId: string,
    field: "forwardLabel" | "backwardLabel",
    label: string | null,
  ) => void;
}

export function useMapEdges({
  codexEntries,
  treeNodes,
  snippetEntries,
  phasesByEntry,
  userEdges,
  codexRelations,
  positions,
  show,
  onUserEdgeLabelSave,
}: UseMapEdgesInput): Edge[] {
  return useMemo(() => {
    const edges = buildMapEdgesFromData({
      codexEntries,
      treeNodes,
      snippetEntries,
      phasesByEntry,
      userEdges,
      positions,
      show,
      codexRelations,
    });

    if (!onUserEdgeLabelSave) return edges;

    return edges.map((edge) => {
      if (edge.type !== "user" || !edge.id.startsWith("user:")) return edge;
      const edgeId = edge.id.slice("user:".length);
      return {
        ...edge,
        data: {
          ...edge.data,
          onLabelSave: (
            field: "forwardLabel" | "backwardLabel",
            label: string | null,
          ) => onUserEdgeLabelSave(edgeId, field, label),
        },
      };
    });
  }, [
    codexEntries,
    treeNodes,
    snippetEntries,
    phasesByEntry,
    userEdges,
    codexRelations,
    positions,
    show,
    onUserEdgeLabelSave,
  ]);
}
