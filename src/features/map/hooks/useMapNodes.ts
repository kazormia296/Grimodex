import { useEffect } from "react";
import type { Node } from "@xyflow/react";
import { useChatStore } from "@/features/chat/chatStore";
import { createCodexMatcher } from "@/features/codex/codexMatcher";
import { updateFrame, deleteFrame } from "../mapApi";
import { layoutFor, layoutForAsync } from "../layouts";
import { WorkerForceLayoutEngine } from "../layouts/forceEngine";
import type { MapNodePositionRecord, ShowFlags } from "../types";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";
import type { MapAiNode, MapFrame } from "@/db/schema";

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
  aiNodes: MapAiNode[];
  frames: MapFrame[];
  show: ShowFlags;
  mode: string;
  variant: "compact" | "card" | "image";
  colorBy: "none" | "status";
  corkboardFeel: boolean;
  modeTransitionActive: boolean;
  setFrames: React.Dispatch<React.SetStateAction<MapFrame[]>>;
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
  aiNodes,
  frames,
  show,
  mode,
  variant,
  colorBy,
  corkboardFeel,
  modeTransitionActive,
  setFrames,
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
      const hiddenTreeNodeIds = new Set(
        positions
          .filter((p) => p.hidden === 1 && p.treeNodeId)
          .map((p) => p.treeNodeId!),
      );
      const hiddenCodexIds = new Set(
        positions
          .filter((p) => p.hidden === 1 && p.codexEntryId)
          .map((p) => p.codexEntryId!),
      );
      const visiblePositions = positions.filter((p) => p.hidden !== 1);

      const scenes = treeNodes.filter(
        (n) => n.nodeType === "scene" && !hiddenTreeNodeIds.has(n.id),
      );
      const notes = treeNodes.filter(
        (n) => n.nodeType === "note" && !hiddenTreeNodeIds.has(n.id),
      );
      const visibleCodex = codexEntries.filter(
        (e) => !hiddenCodexIds.has(e.id),
      );

      let computedPositions;
      if (mode === "theme") {
        setForceLayoutRunning(true);
        setForceAlpha(1);
        const engine = new WorkerForceLayoutEngine();
        const themeMatcher = createCodexMatcher(visibleCodex);
        const scenesWithTags = scenes.map((s) => {
          const text = [s.title, s.synopsis].filter(Boolean).join(" ");
          const tags = [...new Set(themeMatcher(text).map((m) => m.entryId))];
          return { ...s, tags };
        });
        computedPositions = await layoutForAsync(
          "theme",
          {
            scenes: scenesWithTags,
            codexEntries: visibleCodex,
            positions: visiblePositions,
          },
          engine,
          (alpha) => {
            if (!cancelled) setForceAlpha(alpha);
          },
        );
        if (cancelled) return;
        setForceLayoutRunning(false);
      } else {
        computedPositions = layoutFor(mode as Parameters<typeof layoutFor>[0], {
          scenes,
          codexEntries: visibleCodex,
          positions: visiblePositions,
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

      const zIndexMap = new Map<string, number>();
      for (const p of visiblePositions) {
        if (p.treeNodeId && p.nodeRefType === "scene")
          zIndexMap.set(`scene:${p.treeNodeId}`, p.zIndex ?? 0);
        else if (p.treeNodeId && p.nodeRefType === "note")
          zIndexMap.set(`note:${p.treeNodeId}`, p.zIndex ?? 0);
        else if (p.codexEntryId)
          zIndexMap.set(`codex:${p.codexEntryId}`, p.zIndex ?? 0);
        else if (p.aiNodeId) zIndexMap.set(`ai:${p.aiNodeId}`, p.zIndex ?? 0);
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
                variant,
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

      const notePosMap = new Map<string, { x: number; y: number }>();
      for (const p of visiblePositions) {
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

      const aiPosMap = new Map<string, { x: number; y: number }>();
      for (const p of visiblePositions) {
        if (p.aiNodeId) {
          aiPosMap.set(`ai:${p.aiNodeId}`, { x: p.x, y: p.y });
        }
      }
      const aiRfNodes: Node[] = show.ai
        ? aiNodes.map((an, idx) => {
            const key = `ai:${an.id}`;
            return {
              id: key,
              type: "ai",
              position: aiPosMap.get(key) ?? {
                x: 400 + (idx % 4) * 260,
                y: 800 + Math.floor(idx / 4) * 140,
              },
              className: transitionClass,
              draggable: true,
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                prompt: an.prompt,
                response: an.response,
                sessionId: an.sessionId,
                onOpenChat: () => {
                  if (an.sessionId) {
                    useChatStore.getState().selectSession(an.sessionId);
                  }
                },
              },
            };
          })
        : [];

      const nextNodes = [
        ...frameNodes,
        ...sceneNodes,
        ...codexNodes,
        ...noteNodes,
        ...aiRfNodes,
      ];
      setNodes((prev) => {
        const prevMap = new Map(prev.map((n) => [n.id, n]));
        const groupDragging = groupDraggingRef.current;
        const persisting = persistingRef.current;
        const merged = nextNodes.map((n) => {
          const p = prevMap.get(n.id);
          if (!p) return n;
          // Always preserve React Flow's per-node runtime state: `measured`
          // (from ResizeObserver), `selected`, `dragging`. Dropping these on
          // every rebuild would make React Flow think sizes changed and
          // re-emit `dim` events for every node — which feeds back through
          // `persistFrameResize` → setFrames → rebuild, causing an infinite
          // loop and visible full-canvas flicker.
          const base = {
            ...n,
            selected: p.selected,
            measured: p.measured,
            dragging: p.dragging,
          };
          if (p.dragging || groupDragging.has(n.id)) {
            return { ...base, position: p.position };
          }
          // Drop-to-persist window: nodes/frames state has the new coords
          // (applyNodeChanges is synchronous) but positions/frames state is
          // still mid-IPC. Preserve the live position to prevent snap-back.
          if (persisting.has(n.id)) {
            return { ...base, position: p.position };
          }
          return base;
        });
        // Preserve any prev nodes still flagged as group-dragging that are
        // missing from nextNodes (e.g., upstream store churn briefly drops
        // them during a frame drag). They will be reconciled naturally on
        // the next rebuild once the drag completes.
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
    aiNodes,
    show,
    mode,
    variant,
    colorBy,
    corkboardFeel,
    frames,
    modeTransitionActive,
    setFrames,
    setNodes,
    setForceLayoutRunning,
    setForceAlpha,
    updateNodeTitle,
    updateSynopsis,
    setActiveScene,
  ]);
}
