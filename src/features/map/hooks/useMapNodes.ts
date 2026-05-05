import { useEffect } from "react";
import type { Node } from "@xyflow/react";
import { useChatStore } from "@/features/chat/chatStore";
import {
  updateFrame,
  deleteFrame,
  updateSticky,
  deleteAiBranch,
  extractPreviewText,
} from "../mapApi";
import { layoutFor, layoutForAsync } from "../layouts";
import { WorkerForceLayoutEngine } from "../layouts/forceEngine";
import type { MapNodePositionRecord, ShowFlags } from "../types";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";
import type { MapAiBranch, MapFrame, MapSticky } from "@/db/schema";
import type { Snippet } from "@/features/snippets/api";
import type { StickyColor } from "../types";

/** Threshold: above this many stickies in view → fall back to static HTML */
export const STICKY_TIPTAP_THRESHOLD = 50;

// Deterministic rotation from node id for corkboard feel (±0.5deg)
export function corkRotation(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return ((hash % 100) / 100) * 1.0 - 0.5;
}

interface UseMapNodesInput {
  boardId: string | null;
  positions: MapNodePositionRecord[];
  treeNodes: TreeNodeData[];
  codexEntries: CodexEntry[];
  snippets: Snippet[];
  stickies: MapSticky[];
  aiBranches: MapAiBranch[];
  frames: MapFrame[];
  show: ShowFlags;
  mode: string;
  colorBy: "none" | "status" | "stickyColor";
  visualTheme: string;
  modeTransitionActive: boolean;
  setFrames: React.Dispatch<React.SetStateAction<MapFrame[]>>;
  setStickies: React.Dispatch<React.SetStateAction<MapSticky[]>>;
  setAiBranches: React.Dispatch<React.SetStateAction<MapAiBranch[]>>;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setForceLayoutRunning: (v: boolean) => void;
  setForceAlpha: (v: number) => void;
  updateNodeTitle: (id: string, title: string) => Promise<void>;
  updateSynopsis: (id: string, synopsis: string) => Promise<void>;
  setActiveScene: (id: string) => void;
  groupDraggingRef: React.MutableRefObject<Set<string>>;
  persistingRef: React.MutableRefObject<Set<string>>;
}

export function useMapNodes({
  boardId,
  positions,
  treeNodes,
  codexEntries,
  snippets,
  stickies,
  aiBranches,
  frames,
  show,
  mode,
  colorBy,
  visualTheme,
  modeTransitionActive,
  setFrames,
  setStickies,
  setAiBranches,
  setNodes,
  setForceLayoutRunning,
  setForceAlpha,
  updateNodeTitle,
  updateSynopsis,
  setActiveScene,
  groupDraggingRef,
  persistingRef,
}: UseMapNodesInput) {
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;

    async function buildNodes() {
      // ── Manual curation: only entities that have a position row ───────────
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
      const visibleCodex = codexEntries.filter((e) =>
        positionedCodexIds.has(e.id),
      );
      const visibleSnippets = snippets.filter((s) =>
        positionedSnippetIds.has(s.id),
      );

      let computedPositions;
      if (mode === "theme") {
        setForceLayoutRunning(true);
        setForceAlpha(1);
        const engine = new WorkerForceLayoutEngine();
        computedPositions = await layoutForAsync(
          "theme",
          {
            scenes,
            codexEntries: visibleCodex,
            positions,
          },
          engine,
          (alpha) => {
            if (!cancelled) setForceAlpha(alpha);
          },
        );
        if (cancelled) return;
        setForceLayoutRunning(false);
      } else {
        computedPositions = layoutFor(mode as "free", {
          scenes,
          codexEntries: visibleCodex,
          positions,
        });
      }
      if (cancelled) return;

      const frameNodes: Node[] =
        show.frames && mode === "free"
          ? frames.map((f) => ({
              id: `frame:${f.id}`,
              type: "frame",
              position: { x: f.x, y: f.y },
              style: { width: f.width, height: f.height },
              zIndex: -1,
              dragHandle: ".frame-drag-handle",
              data: {
                title: f.title,
                background: f.background,
                borderColor: f.borderColor,
                onTitleChange: async (title: string) => {
                  await updateFrame(f.id, { title });
                  setFrames((prev) =>
                    prev.map((fr) => (fr.id === f.id ? { ...fr, title } : fr)),
                  );
                },
                onDelete: async () => {
                  await deleteFrame(f.id);
                  setFrames((prev) => prev.filter((fr) => fr.id !== f.id));
                },
              },
            }))
          : [];

      const transitionClass = modeTransitionActive
        ? "with-mode-transition"
        : undefined;

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
        else if (p.stickyId)
          zIndexMap.set(`sticky:${p.stickyId}`, p.zIndex ?? 0);
        else if (p.aiBranchId)
          zIndexMap.set(`ai_branch:${p.aiBranchId}`, p.zIndex ?? 0);
      }

      const sceneNodes: Node[] = show.scenes
        ? scenes.map((n) => {
            const key = `scene:${n.id}`;
            const pos = computedPositions.get(key) ?? { x: 0, y: 0 };
            const rotation = corkboardFeel ? corkRotation(n.id) : 0;
            return {
              id: key,
              type: "scene",
              position: pos,
              className: transitionClass,
              draggable: true,
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                title: n.title,
                synopsis: n.synopsis ?? null,
                status: n.status ?? "outline",
                wordCount: undefined,
                variant: "compact" as const,
                colorBy,
                corkboardFeel,
                rotation,
                onTitleChange: async (title: string) => {
                  await updateNodeTitle(n.id, title);
                },
                onSynopsisChange: async (synopsis: string) => {
                  await updateSynopsis(n.id, synopsis);
                },
                onOpen: () => {
                  setActiveScene(n.id);
                },
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
              className: transitionClass,
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

      // Snippet positions from positions array
      const snippetPosMap = new Map<string, { x: number; y: number }>();
      for (const p of positions) {
        if (p.snippetId) {
          snippetPosMap.set(`snippet:${p.snippetId}`, { x: p.x, y: p.y });
        }
      }
      const snippetNodes: Node[] = show.snippets
        ? visibleSnippets.map((s, idx) => {
            const key = `snippet:${s.id}`;
            return {
              id: key,
              type: "snippet",
              position: snippetPosMap.get(key) ?? {
                x: 300 + (idx % 5) * 220,
                y: 400 + Math.floor(idx / 5) * 80,
              },
              className: transitionClass,
              draggable: true,
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                title: s.title || null,
                content: s.content,
              },
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
              className: transitionClass,
              draggable: true,
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                title: n.title,
                content: n.synopsis ?? "",
                onOpen: () => setActiveScene(n.id),
              },
            };
          })
        : [];

      // Sticky nodes: positions from positions array
      const stickyPosMap = new Map<string, { x: number; y: number }>();
      for (const p of positions) {
        if (p.stickyId) {
          stickyPosMap.set(`sticky:${p.stickyId}`, { x: p.x, y: p.y });
        }
      }
      // 50-sticky TipTap threshold guard (design spec §1b)
      const useTipTap = stickies.length <= STICKY_TIPTAP_THRESHOLD;
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
              className: transitionClass,
              draggable: true,
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                id: st.id,
                title: st.title ?? "",
                body: st.body,
                previewText: st.previewText ?? "",
                color: st.color,
                useTipTap,
                colorBy,
                onUpdate: async (updates: {
                  title?: string;
                  body?: string;
                  previewText?: string;
                  color?: StickyColor;
                }) => {
                  const preview =
                    updates.body !== undefined
                      ? extractPreviewText(updates.body)
                      : undefined;
                  await updateSticky(st.id, {
                    ...updates,
                    previewText: preview ?? updates.previewText,
                  });
                  setStickies((prev) =>
                    prev.map((s) =>
                      s.id === st.id
                        ? {
                            ...s,
                            ...updates,
                            previewText:
                              preview ?? updates.previewText ?? s.previewText,
                          }
                        : s,
                    ),
                  );
                },
              },
            };
          })
        : [];

      // AI Branch nodes
      const aiBranchPosMap = new Map<string, { x: number; y: number }>();
      for (const p of positions) {
        if (p.aiBranchId) {
          aiBranchPosMap.set(`ai_branch:${p.aiBranchId}`, {
            x: p.x,
            y: p.y,
          });
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
              className: transitionClass,
              draggable: true,
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                prompt: ab.prompt,
                sessionId: ab.sessionId,
                derivedStickyCount,
                onOpenChat: () => {
                  if (ab.sessionId) {
                    useChatStore.getState().selectSession(ab.sessionId);
                  }
                },
                onDelete: async () => {
                  await deleteAiBranch(ab.id);
                  setAiBranches((prev) => prev.filter((b) => b.id !== ab.id));
                  // Stickies persist as orphans (aiBranchId → null in DB via ON DELETE SET NULL)
                },
              },
            };
          })
        : [];

      const nextNodes = [
        ...frameNodes,
        ...sceneNodes,
        ...codexNodes,
        ...snippetNodes,
        ...noteNodes,
        ...stickyNodes,
        ...aiBranchNodes,
      ];
      setNodes((prev) => {
        const prevMap = new Map(prev.map((n) => [n.id, n]));
        const groupDragging = groupDraggingRef.current;
        const persisting = persistingRef.current;
        const merged = nextNodes.map((n) => {
          const p = prevMap.get(n.id);
          if (!p) return n;
          const base = {
            ...n,
            selected: p.selected,
            measured: p.measured,
            dragging: p.dragging,
          };
          if (p.dragging || groupDragging.has(n.id)) {
            return { ...base, position: p.position };
          }
          if (persisting.has(n.id)) {
            return { ...base, position: p.position };
          }
          return base;
        });
        if (groupDragging.size > 0) {
          const nextIds = new Set(nextNodes.map((n) => n.id));
          for (const id of groupDragging) {
            if (!nextIds.has(id)) {
              const p = prevMap.get(id);
              if (p) merged.push(p);
            }
          }
        }
        return merged;
      });
    }

    buildNodes();
    return () => {
      cancelled = true;
      setForceLayoutRunning(false);
    };
  }, [
    boardId,
    positions,
    treeNodes,
    codexEntries,
    snippets,
    stickies,
    aiBranches,
    show,
    mode,
    colorBy,
    visualTheme,
    frames,
    modeTransitionActive,
    setFrames,
    setStickies,
    setNodes,
    setForceLayoutRunning,
    setForceAlpha,
    updateNodeTitle,
    updateSynopsis,
    setActiveScene,
    groupDraggingRef,
    persistingRef,
  ]);
}
