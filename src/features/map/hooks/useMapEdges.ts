import { useMemo } from "react";
import type { Edge } from "@xyflow/react";
import { createCodexMatcher } from "@/features/codex/codexMatcher";
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
    style: string;
    color: string;
    direction: string;
  }[];
  positions: MapNodePositionRecord[];
  show: ShowFlags;
  onUserEdgeLabelSave?: (edgeId: string, label: string | null) => void;
}

function posToRfId(pos: MapNodePositionRecord | undefined): string | null {
  if (!pos) return null;
  if (pos.nodeRefType === "scene" && pos.treeNodeId)
    return `scene:${pos.treeNodeId}`;
  if (pos.nodeRefType === "note" && pos.treeNodeId)
    return `note:${pos.treeNodeId}`;
  if (pos.nodeRefType === "codex" && pos.codexEntryId)
    return `codex:${pos.codexEntryId}`;
  if (pos.nodeRefType === "ai_branch" && pos.aiBranchId)
    return `ai_branch:${pos.aiBranchId}`;
  return null;
}

export function useMapEdges({
  codexEntries,
  treeNodes,
  snippetEntries,
  phasesByEntry,
  userEdges,
  positions,
  show,
  onUserEdgeLabelSave,
}: UseMapEdgesInput): Edge[] {
  return useMemo(() => {
    const derived: Edge[] = [];

    const totalVisible = codexEntries.length + treeNodes.length;
    if (show.derivedEdges && totalVisible > 200) {
      console.warn(
        `[Map] Derived edges auto-disabled: ${totalVisible} visible nodes exceed threshold of 200`,
      );
    }

    if (show.derivedEdges && totalVisible <= 200) {
      // Codex parent-child edges
      for (const e of codexEntries.filter((e) => e.parentId != null)) {
        derived.push({
          id: `derived:${e.id}->${e.parentId}`,
          source: `codex:${e.parentId}`,
          target: `codex:${e.id}`,
          style: { stroke: "#999", strokeDasharray: "4 2" },
          animated: false,
          zIndex: 0,
        });
      }

      // Phase anchor edges: codex → scene
      const visibleSceneIds = new Set(
        treeNodes.filter((n) => n.nodeType === "scene").map((n) => n.id),
      );
      const visibleCodexIds = new Set(codexEntries.map((e) => e.id));
      for (const [entryId, phases] of Object.entries(phasesByEntry)) {
        if (!visibleCodexIds.has(entryId)) continue;
        for (const phase of phases) {
          if (!phase.anchorNodeId) continue;
          if (!visibleSceneIds.has(phase.anchorNodeId)) continue;
          derived.push({
            id: `phase-anchor:${phase.id}`,
            source: `codex:${entryId}`,
            target: `scene:${phase.anchorNodeId}`,
            style: { stroke: "#D97706", strokeDasharray: "3 3", opacity: 0.7 },
            animated: false,
            zIndex: 0,
            data: { label: phase.label },
          });
        }
      }

      if (codexEntries.length > 0) {
        const matcher = createCodexMatcher(codexEntries);

        // Scene mention edges
        for (const scene of treeNodes.filter((n) => n.nodeType === "scene")) {
          const text = [scene.title, scene.synopsis].filter(Boolean).join(" ");
          if (!text) continue;
          const seen = new Set<string>();
          for (const m of matcher(text)) {
            if (seen.has(m.entryId)) continue;
            seen.add(m.entryId);
            if (!visibleCodexIds.has(m.entryId)) continue;
            derived.push({
              id: `mention:${scene.id}->${m.entryId}`,
              source: `scene:${scene.id}`,
              target: `codex:${m.entryId}`,
              style: {
                stroke: "#0891B2",
                strokeDasharray: "2 4",
                opacity: 0.6,
              },
              animated: false,
              zIndex: 0,
            });
          }
        }

        // Snippet origin edges
        for (const snippet of snippetEntries.filter((s) => s.sceneId)) {
          const seenEdge = new Set<string>();
          for (const m of matcher(snippet.content)) {
            const key = `${snippet.sceneId}->${m.entryId}`;
            if (seenEdge.has(key)) continue;
            seenEdge.add(key);
            if (!visibleCodexIds.has(m.entryId)) continue;
            derived.push({
              id: `snippet-origin:${key}`,
              source: `scene:${snippet.sceneId!}`,
              target: `codex:${m.entryId}`,
              style: {
                stroke: "#059669",
                strokeDasharray: "1 4",
                opacity: 0.5,
              },
              animated: false,
              zIndex: 0,
            });
          }
        }
      }
    }

    const user: Edge[] = show.userEdges
      ? userEdges
          .map((ue) => {
            const fromPos = positions.find((p) => p.id === ue.fromPositionId);
            const toPos = positions.find((p) => p.id === ue.toPositionId);
            const sourceId = posToRfId(fromPos);
            const targetId = posToRfId(toPos);
            if (!sourceId || !targetId) return null;
            return {
              id: `user:${ue.id}`,
              source: sourceId,
              target: targetId,
              type: "user",
              zIndex: 1,
              data: {
                label: ue.forwardLabel,
                style: ue.style,
                color: ue.color,
                direction: ue.direction,
                onLabelSave: onUserEdgeLabelSave
                  ? (label: string | null) => onUserEdgeLabelSave(ue.id, label)
                  : undefined,
              },
            } as Edge;
          })
          .filter((e): e is Edge => e !== null)
      : [];

    return [...derived, ...user];
  }, [
    codexEntries,
    treeNodes,
    snippetEntries,
    phasesByEntry,
    userEdges,
    positions,
    show.derivedEdges,
    show.userEdges,
    onUserEdgeLabelSave,
  ]);
}
