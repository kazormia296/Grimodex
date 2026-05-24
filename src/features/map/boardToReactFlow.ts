import type { Edge, Node } from "@xyflow/react";
import { layoutFor } from "./layouts";
import type { LayoutUserEdge } from "./layouts/types";
import { posToNodeKey } from "./layouts/posToNodeKey";
import { createCodexMatcher } from "@/features/codex/codexMatcher";
import type { MapAiBranch, MapFrame, MapSticky } from "@/db/schema";
import type { CodexEntry } from "@/features/codex/api";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { ColorByAxis, MapNodePositionRecord, ShowFlags } from "./types";
import { corkRotation, stickyRotation } from "./hooks/useMapNodes";

export interface BoardPhase {
  id: string;
  label?: string | null;
  anchorNodeId?: string | null;
}

export interface BoardUserEdge {
  id: string;
  fromPositionId: string;
  toPositionId: string;
  forwardLabel?: string | null;
  backwardLabel?: string | null;
  style: string;
  color: string;
  direction: string;
}

export interface BoardCodexEntry {
  id: string;
  name: string;
  type: string;
  parentId?: string | null;
  summary?: string | null;
  tagsCache?: string | null;
}

export interface BoardTreeNode {
  id: string;
  nodeType: string;
  title: string;
  synopsis?: string | null;
  status?: string | null;
}

export interface BoardSnippetEntry {
  id?: string;
  title?: string | null;
  content: string;
  sceneId?: string | null;
}

export interface BoardToReactFlowInput {
  positions: MapNodePositionRecord[];
  userEdges: BoardUserEdge[];
  treeNodes: BoardTreeNode[];
  codexEntries: BoardCodexEntry[];
  snippets: BoardSnippetEntry[];
  stickies: MapSticky[];
  aiBranches: MapAiBranch[];
  frames: MapFrame[];
  phasesByEntry: Record<string, BoardPhase[]>;
  show: ShowFlags;
  colorBy?: ColorByAxis;
  visualTheme?: string;
}

/** Build React Flow edges from board DB data (no runtime callbacks). */
export function buildMapEdgesFromData(input: {
  codexEntries: BoardCodexEntry[];
  treeNodes: BoardTreeNode[];
  snippetEntries: Pick<BoardSnippetEntry, "sceneId" | "content">[];
  phasesByEntry: Record<string, BoardPhase[]>;
  userEdges: BoardUserEdge[];
  positions: MapNodePositionRecord[];
  show: ShowFlags;
}): Edge[] {
  const {
    codexEntries,
    treeNodes,
    snippetEntries,
    phasesByEntry,
    userEdges,
    positions,
    show,
  } = input;

  const derived: Edge[] = [];
  const totalVisible = codexEntries.length + treeNodes.length;

  if (show.derivedEdges && totalVisible <= 200) {
    for (const e of codexEntries.filter((entry) => entry.parentId != null)) {
      derived.push({
        id: `derived:${e.id}->${e.parentId}`,
        source: `codex:${e.parentId}`,
        target: `codex:${e.id}`,
        style: { stroke: "#999", strokeDasharray: "4 2" },
        animated: false,
        zIndex: 0,
      });
    }

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

      const seenEdge = new Set<string>();
      for (const snippet of snippetEntries.filter((s) => s.sceneId)) {
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
          const sourceId = posToNodeKey(fromPos);
          const targetId = posToNodeKey(toPos);
          if (!sourceId || !targetId) return null;
          return {
            id: `user:${ue.id}`,
            source: sourceId,
            target: targetId,
            type: "user",
            zIndex: 1,
            data: {
              forwardLabel: ue.forwardLabel,
              backwardLabel: ue.backwardLabel,
              style: ue.style,
              color: ue.color,
              direction: ue.direction,
            },
          } as Edge;
        })
        .filter((e): e is Edge => e !== null)
    : [];

  return [...derived, ...user];
}

/** Build React Flow nodes from board DB data (free mode, export-safe — no callbacks). */
export function buildMapNodesFromData(input: BoardToReactFlowInput): Node[] {
  const {
    positions,
    userEdges,
    treeNodes,
    codexEntries,
    snippets,
    stickies,
    aiBranches,
    frames,
    show,
    colorBy = "none",
    visualTheme = "default",
  } = input;

  const positionedTreeNodeIds = new Set(
    positions.filter((p) => p.treeNodeId).map((p) => p.treeNodeId!),
  );
  const positionedCodexIds = new Set(
    positions.filter((p) => p.codexEntryId).map((p) => p.codexEntryId!),
  );
  const positionedSnippetIds = new Set(
    positions.filter((p) => p.snippetId).map((p) => p.snippetId!),
  );

  const scenes = treeNodes.filter(
    (n) => n.nodeType === "scene" && positionedTreeNodeIds.has(n.id),
  );
  const notes = treeNodes.filter(
    (n) => n.nodeType === "note" && positionedTreeNodeIds.has(n.id),
  );
  const visibleCodex = codexEntries.filter((e) => positionedCodexIds.has(e.id));
  const visibleSnippets = snippets.filter(
    (s) => s.id != null && positionedSnippetIds.has(s.id),
  );

  const computedPositions = layoutFor("free", {
    scenes: scenes as TreeNodeData[],
    codexEntries: visibleCodex as CodexEntry[],
    positions,
    userEdges: userEdges as LayoutUserEdge[],
  });

  const corkboardFeel = visualTheme === "corkboard";

  const zIndexMap = new Map<string, number>();
  for (const p of positions) {
    if (p.treeNodeId && p.nodeRefType === "scene")
      zIndexMap.set(`scene:${p.treeNodeId}`, p.zIndex ?? 0);
    else if (p.treeNodeId && p.nodeRefType === "note")
      zIndexMap.set(`note:${p.treeNodeId}`, p.zIndex ?? 0);
    else if (p.codexEntryId)
      zIndexMap.set(`codex:${p.codexEntryId}`, p.zIndex ?? 0);
    else if (p.snippetId)
      zIndexMap.set(`snippet:${p.snippetId}`, p.zIndex ?? 0);
    else if (p.stickyId) zIndexMap.set(`sticky:${p.stickyId}`, p.zIndex ?? 0);
    else if (p.aiBranchId)
      zIndexMap.set(`ai_branch:${p.aiBranchId}`, p.zIndex ?? 0);
  }

  const frameNodes: Node[] = show.frames
    ? frames.map((f) => ({
        id: `frame:${f.id}`,
        type: "frame",
        position: { x: f.x, y: f.y },
        style: { width: f.width, height: f.height },
        zIndex: -1,
        data: {
          title: f.title,
          background: f.background,
          borderColor: f.borderColor,
        },
      }))
    : [];

  const sceneNodes: Node[] = show.scenes
    ? scenes.map((n) => {
        const key = `scene:${n.id}`;
        const pos = computedPositions.get(key) ?? { x: 0, y: 0 };
        return {
          id: key,
          type: "scene",
          position: pos,
          draggable: false,
          zIndex: zIndexMap.get(key) ?? 0,
          data: {
            title: n.title,
            synopsis: n.synopsis ?? null,
            status: n.status ?? "outline",
            variant: "compact" as const,
            colorBy,
            corkboardFeel,
            rotation: corkboardFeel ? corkRotation(n.id) : 0,
          },
        };
      })
    : [];

  const codexNodes: Node[] = show.codex
    ? visibleCodex.map((e) => {
        const key = `codex:${e.id}`;
        const pos = computedPositions.get(key) ?? { x: 0, y: 0 };
        return {
          id: key,
          type: "codex",
          position: pos,
          zIndex: zIndexMap.get(key) ?? 0,
          data: {
            name: e.name,
            type: e.type,
            summary: e.summary ?? "",
            color: "#534AB7",
            tagsCache: e.tagsCache ?? null,
            colorBy,
          },
        };
      })
    : [];

  const snippetPosMap = new Map<string, { x: number; y: number }>();
  for (const p of positions) {
    if (p.snippetId)
      snippetPosMap.set(`snippet:${p.snippetId}`, { x: p.x, y: p.y });
  }

  const snippetNodes: Node[] = show.snippets
    ? visibleSnippets.map((s, idx) => {
        const key = `snippet:${s.id!}`;
        return {
          id: key,
          type: "snippet",
          position: snippetPosMap.get(key) ?? {
            x: 300 + (idx % 5) * 220,
            y: 400 + Math.floor(idx / 5) * 80,
          },
          draggable: false,
          zIndex: zIndexMap.get(key) ?? 0,
          data: { title: s.title || null, content: s.content },
        };
      })
    : [];

  const notePosMap = new Map<string, { x: number; y: number }>();
  for (const p of positions) {
    if (p.treeNodeId && p.nodeRefType === "note") {
      notePosMap.set(`note:${p.treeNodeId}`, { x: p.x, y: p.y });
    }
  }

  const noteNodes: Node[] = show.notes
    ? notes.map((n, idx) => {
        const key = `note:${n.id}`;
        return {
          id: key,
          type: "note",
          position: notePosMap.get(key) ?? {
            x: 200 + (idx % 5) * 200,
            y: 600 + Math.floor(idx / 5) * 120,
          },
          draggable: false,
          zIndex: zIndexMap.get(key) ?? 0,
          data: { title: n.title, content: n.synopsis ?? "" },
        };
      })
    : [];

  const stickyPosMap = new Map<string, { x: number; y: number }>();
  for (const p of positions) {
    if (p.stickyId)
      stickyPosMap.set(`sticky:${p.stickyId}`, { x: p.x, y: p.y });
  }

  const stickyNodes: Node[] = show.stickies
    ? stickies.map((st, idx) => {
        const key = `sticky:${st.id}`;
        return {
          id: key,
          type: "sticky",
          position: stickyPosMap.get(key) ?? {
            x: 100 + (idx % 5) * 260,
            y: 200 + Math.floor(idx / 5) * 200,
          },
          draggable: false,
          zIndex: zIndexMap.get(key) ?? 0,
          data: {
            id: st.id,
            title: st.title ?? "",
            body: st.body,
            previewText: st.previewText ?? "",
            paletteId: st.paletteId,
            colorSlot: st.colorSlot,
            colorBy,
            rotation: stickyRotation(st.id),
          },
        };
      })
    : [];

  const aiBranchPosMap = new Map<string, { x: number; y: number }>();
  for (const p of positions) {
    if (p.aiBranchId) {
      aiBranchPosMap.set(`ai_branch:${p.aiBranchId}`, { x: p.x, y: p.y });
    }
  }

  const aiBranchNodes: Node[] = show.aiBranch
    ? aiBranches.map((ab, idx) => {
        const key = `ai_branch:${ab.id}`;
        const derivedStickyCount = stickies.filter(
          (s) => s.aiBranchId === ab.id,
        ).length;
        return {
          id: key,
          type: "ai_branch",
          position: aiBranchPosMap.get(key) ?? {
            x: 400 + (idx % 4) * 260,
            y: 800 + Math.floor(idx / 4) * 140,
          },
          draggable: false,
          zIndex: zIndexMap.get(key) ?? 0,
          data: {
            prompt: ab.prompt,
            sessionId: ab.sessionId,
            derivedStickyCount,
          },
        };
      })
    : [];

  return [
    ...frameNodes,
    ...sceneNodes,
    ...codexNodes,
    ...snippetNodes,
    ...noteNodes,
    ...stickyNodes,
    ...aiBranchNodes,
  ];
}

/** Convert board DB records to React Flow nodes/edges (headless export path). */
export function boardToReactFlow(input: BoardToReactFlowInput): {
  rfNodes: Node[];
  rfEdges: Edge[];
} {
  const rfNodes = buildMapNodesFromData(input);
  const rfEdges = buildMapEdgesFromData({
    codexEntries: input.codexEntries,
    treeNodes: input.treeNodes,
    snippetEntries: input.snippets,
    phasesByEntry: input.phasesByEntry,
    userEdges: input.userEdges,
    positions: input.positions,
    show: input.show,
  });
  return { rfNodes, rfEdges };
}
