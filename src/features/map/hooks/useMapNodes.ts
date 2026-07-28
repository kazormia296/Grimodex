import { useEffect, useRef, useMemo } from "react";
import type { Node } from "@xyflow/react";
import { useChatStore } from "@/features/chat/chatStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { requestOpenInCodex } from "@/features/codex/multiwindow/codexSelectionRouting";
import {
  updateFrame,
  deleteFrame,
  createFrame,
  updateSticky,
  deleteAiBranch,
  getAiBranchSnapshot,
  restoreAiBranchSnapshot,
  extractPreviewText,
} from "../mapApi";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import i18next from "@/lib/i18n";
import { layoutFor, layoutForAsync, applyPinnedOverrides } from "../layouts";
import { WorkerForceLayoutEngine } from "../layouts/forceEngine";
import { layoutFingerprint } from "../layouts/layoutFingerprint";
import type { LayoutUserEdge } from "../layouts/types";
import type { MapNodePositionRecord, ShowFlags } from "../types";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";
import type { MapAiBranch, MapFrame, MapSticky } from "@/db/schema";
import type { Snippet } from "@/features/snippets/api";
import { projectMapPositions } from "./mapPositionProjection";

// Deterministic rotation from node id for corkboard feel (±0.5deg)
export function corkRotation(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return ((hash % 100) / 100) * 1.0 - 0.5;
}

// Deterministic rotation for sticky notes (±2.5deg) — skeuomorphic Post-It feel
export function stickyRotation(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return ((Math.abs(hash) % 1000) / 1000) * 5 - 2.5;
}

export function countStickiesByBranch(
  stickies: readonly MapSticky[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sticky of stickies) {
    if (!sticky.aiBranchId) continue;
    counts.set(sticky.aiBranchId, (counts.get(sticky.aiBranchId) ?? 0) + 1);
  }
  return counts;
}

function shallowRecordEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
  ignoreFunctions = false,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (
      ignoreFunctions &&
      typeof av === "function" &&
      typeof bv === "function"
    ) {
      continue;
    }
    if (!Object.is(av, bv)) return false;
  }
  return true;
}

/**
 * React Flow は node object identity が変わると node component を再評価する。
 * builder が作る callback は再構築ごとに新参照になるため、表示データと座標が同じ
 * node は callback の参照差だけを理由に差し替えない。
 */
export function mapNodePresentationEqual(previous: Node, next: Node): boolean {
  return (
    previous.type === next.type &&
    previous.className === next.className &&
    previous.zIndex === next.zIndex &&
    previous.selected === next.selected &&
    previous.dragging === next.dragging &&
    previous.measured === next.measured &&
    previous.position.x === next.position.x &&
    previous.position.y === next.position.y &&
    shallowRecordEqual(
      previous.style as Record<string, unknown> | undefined,
      next.style as Record<string, unknown> | undefined,
    ) &&
    shallowRecordEqual(
      previous.data as Record<string, unknown>,
      next.data as Record<string, unknown>,
      true,
    )
  );
}

interface UseMapNodesInput {
  boardId: string | null;
  positions: MapNodePositionRecord[];
  positionsStructureRevision: number;
  positionsLayoutRevision: number;
  userEdges: LayoutUserEdge[];
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
  setPositions: React.Dispatch<React.SetStateAction<MapNodePositionRecord[]>>;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  /** @deprecated Navigation is coordinated by openEditorDocument. */
  setActiveScene?: (id: string) => void;
  setForceLayoutRunning: (v: boolean) => void;
  setForceAlpha: (v: number) => void;
  updateNodeTitle: (id: string, title: string) => Promise<void>;
  updateSynopsis: (id: string, synopsis: string) => Promise<void>;
  groupDraggingRef: React.MutableRefObject<Set<string>>;
  persistingRef: React.MutableRefObject<Set<string>>;
  deletingStickyIds?: Set<string>;
  onStickyExitComplete?: (id: string) => void;
  onBranchFrom?: (sourceNodeId: string, dir: "left" | "right") => void;
  /** 採用: branch 由来 Sticky を通常 Sticky 化する (stickyId)。 */
  onAdopt?: (stickyId: string) => void;
  /** 不採用: branch 由来 Sticky をゴミ箱へ送る (stickyId)。 */
  onReject?: (stickyId: string) => void;
}

export function useMapNodes({
  boardId,
  positions,
  positionsStructureRevision,
  positionsLayoutRevision,
  userEdges,
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
  setPositions,
  setNodes,
  setForceLayoutRunning,
  setForceAlpha,
  updateNodeTitle,
  updateSynopsis,
  groupDraggingRef,
  persistingRef,
  deletingStickyIds,
  onStickyExitComplete,
  onBranchFrom,
  onAdopt,
  onReject,
}: UseMapNodesInput) {
  // Read inside buildNodes via a ref so the (async, expensive) layout effect
  // does NOT list `modeTransitionActive` as a dependency. In theme mode a
  // rebuild runs the force layout, whose completion toggles this flag — having
  // it as a dep would re-trigger the rebuild forever (infinite re-layout).
  const modeTransitionActiveRef = useRef(modeTransitionActive);
  modeTransitionActiveRef.current = modeTransitionActive;

  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  // 表示が同一の node は object identity を再利用するため、node.data 内の
  // callback closure 自体も再利用される。外部 callback/setter は ref 経由で
  // 最新値へ委譲し、再描画を増やさず stale callback を防ぐ。
  const nodeCallbacksRef = useRef({
    setFrames,
    setStickies,
    setAiBranches,
    setPositions,
    updateNodeTitle,
    updateSynopsis,
    onStickyExitComplete,
    onBranchFrom,
    onAdopt,
    onReject,
  });
  nodeCallbacksRef.current = {
    setFrames,
    setStickies,
    setAiBranches,
    setPositions,
    updateNodeTitle,
    updateSynopsis,
    onStickyExitComplete,
    onBranchFrom,
    onAdopt,
    onReject,
  };

  // The board-data owner advances these revisions only for structural/layout
  // mutations. Coordinate-only drag persistence changes `positions` without
  // touching them, so render-time map/sort/join fingerprints disappear.
  const positionProjection = useMemo(
    () => projectMapPositions(positions),
    // `positions` is deliberately represented by the owner-controlled
    // revisions so coordinate-only row replacement does not execute the scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId, positionsStructureRevision, positionsLayoutRevision],
  );

  const layoutCacheRef = useRef<{
    boardId: string | null;
    fingerprint: string;
    computedPositions: Map<string, { x: number; y: number }>;
  }>({ boardId: null, fingerprint: "", computedPositions: new Map() });

  const themeLayoutFingerprint = useMemo(() => {
    if (!boardId) return "";
    const scenes = treeNodes.filter(
      (n) =>
        n.nodeType === "scene" &&
        positionProjection.positionedTreeNodeIds.has(n.id),
    );
    const visibleCodex = codexEntries.filter((e) =>
      positionProjection.positionedCodexIds.has(e.id),
    );
    return layoutFingerprint({
      boardId,
      scenes,
      codexEntries: visibleCodex,
      positions: positionProjection.source,
      userEdges,
      positionProjection,
    });
  }, [boardId, treeNodes, codexEntries, userEdges, positionProjection]);

  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;

    async function buildNodes() {
      const currentPositions = positionsRef.current;
      // A coordinate-only update normally cannot trigger this effect. If a
      // separate presentation dependency changes later, refresh the projection
      // once from the latest rows so the rebuild uses the persisted x/y.
      const currentPositionProjection =
        positionProjection.source === currentPositions
          ? positionProjection
          : projectMapPositions(currentPositions);
      // ── Manual curation: only entities that have a position row ───────────
      const scenes = treeNodes.filter(
        (n) =>
          n.nodeType === "scene" &&
          currentPositionProjection.positionedTreeNodeIds.has(n.id),
      );
      const notes = treeNodes.filter(
        (n) =>
          n.nodeType === "note" &&
          currentPositionProjection.positionedTreeNodeIds.has(n.id),
      );
      const visibleCodex = codexEntries.filter((e) =>
        currentPositionProjection.positionedCodexIds.has(e.id),
      );
      const visibleSnippets = snippets.filter((s) =>
        currentPositionProjection.positionedSnippetIds.has(s.id),
      );

      let computedPositions;
      if (mode === "theme") {
        const layoutInput = {
          scenes,
          codexEntries: visibleCodex,
          positions: currentPositions,
          userEdges,
          boardId: boardId ?? undefined,
        };
        const fingerprint = themeLayoutFingerprint;
        const cache = layoutCacheRef.current;
        const cacheHit =
          cache.boardId === boardId && cache.fingerprint === fingerprint;

        if (cacheHit) {
          computedPositions = new Map(cache.computedPositions);
        } else {
          setForceLayoutRunning(true);
          setForceAlpha(1);
          const engine = new WorkerForceLayoutEngine();
          computedPositions = await layoutForAsync(
            "theme",
            layoutInput,
            engine,
            (alpha) => {
              if (!cancelled) setForceAlpha(alpha);
            },
          );
          if (cancelled) return;
          setForceLayoutRunning(false);
          layoutCacheRef.current = {
            boardId,
            fingerprint,
            computedPositions: new Map(computedPositions),
          };
        }

        computedPositions = applyPinnedOverrides(computedPositions, {
          ...layoutInput,
          positions: currentPositions,
        });
      } else {
        layoutCacheRef.current = {
          boardId: null,
          fingerprint: "",
          computedPositions: new Map(),
        };
        computedPositions = layoutFor(mode as "free", {
          scenes,
          codexEntries: visibleCodex,
          positions: currentPositions,
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
                  nodeCallbacksRef.current.setFrames((prev) =>
                    prev.map((fr) => (fr.id === f.id ? { ...fr, title } : fr)),
                  );
                },
                onDelete: async () => {
                  const cap = { ...f };
                  await deleteFrame(f.id);
                  nodeCallbacksRef.current.setFrames((prev) =>
                    prev.filter((fr) => fr.id !== f.id),
                  );

                  if (!useGlobalHistoryStore.getState().isReplaying) {
                    useGlobalHistoryStore.getState().push({
                      kind: "map",
                      label: i18next.t("map.history.frameDelete"),
                      async undo() {
                        const recreated = await createFrame({
                          id: cap.id,
                          boardId: cap.boardId,
                          title: cap.title ?? undefined,
                          x: cap.x,
                          y: cap.y,
                          width: cap.width,
                          height: cap.height,
                          background: cap.background ?? undefined,
                          borderColor: cap.borderColor ?? undefined,
                        });
                        nodeCallbacksRef.current.setFrames((prev) => [
                          ...prev,
                          recreated,
                        ]);
                      },
                      async redo() {
                        await deleteFrame(cap.id);
                        nodeCallbacksRef.current.setFrames((prev) =>
                          prev.filter((fr) => fr.id !== cap.id),
                        );
                      },
                    });
                  }
                },
              },
            }))
          : [];

      const transitionClass = modeTransitionActiveRef.current
        ? "with-mode-transition"
        : undefined;

      const corkboardFeel = visualTheme === "corkboard";

      const zIndexMap = currentPositionProjection.zIndexByNodeKey;

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
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                treeNodeId: n.id,
                title: n.title,
                synopsis: n.synopsis ?? null,
                status: n.status ?? "outline",
                wordCount: undefined,
                variant: "compact" as const,
                colorBy,
                corkboardFeel,
                rotation,
                onTitleChange: async (title: string) => {
                  await nodeCallbacksRef.current.updateNodeTitle(n.id, title);
                },
                onSynopsisChange: async (synopsis: string) => {
                  await nodeCallbacksRef.current.updateSynopsis(n.id, synopsis);
                },
                onOpen: () => {
                  openEditorDocument(
                    {
                      target: { kind: "scene", documentId: n.id },
                      mode: "pinned",
                      revealEditor: true,
                      focusEditor: false,
                      syncSceneContext: true,
                    },
                    defaultEditorNavigationPorts,
                  );
                },
                onBranchFrom: (dir: "left" | "right") =>
                  nodeCallbacksRef.current.onBranchFrom?.(key, dir),
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
                icon: e.icon ?? null,
                colorBy,
                onOpen: () => {
                  void requestOpenInCodex(e.id);
                },
                onBranchFrom: (dir: "left" | "right") =>
                  nodeCallbacksRef.current.onBranchFrom?.(key, dir),
              },
            };
          })
        : [];

      // Snippet positions from positions array
      const snippetPosMap = currentPositionProjection.snippetPositions;
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
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                title: s.title || null,
                content: s.content,
                onBranchFrom: (dir: "left" | "right") =>
                  nodeCallbacksRef.current.onBranchFrom?.(key, dir),
              },
            };
          })
        : [];

      const notePosMap = currentPositionProjection.notePositions;
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
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                title: n.title,
                content: n.synopsis ?? "",
                onOpen: () => {
                  openEditorDocument(
                    {
                      target: { kind: "scene", documentId: n.id },
                      mode: "pinned",
                      revealEditor: true,
                      focusEditor: false,
                      syncSceneContext: true,
                    },
                    defaultEditorNavigationPorts,
                  );
                },
                onBranchFrom: (dir: "left" | "right") =>
                  nodeCallbacksRef.current.onBranchFrom?.(key, dir),
              },
            };
          })
        : [];

      // Sticky nodes: positions from positions array
      const stickyPosMap = currentPositionProjection.stickyPositions;
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
                isDeleting: deletingStickyIds?.has(st.id) ?? false,
                // aiDerived: AI 生成 provenance (採用後も保持 = onCopy が "ai" のまま)。
                // branchAttached: まだ branch に属するか (採用で外れる) = 採用/不採用 UI の表示条件。
                aiDerived: st.aiDerived === 1,
                branchAttached: st.aiBranchId !== null,
                onAdopt: () => nodeCallbacksRef.current.onAdopt?.(st.id),
                onReject: () => nodeCallbacksRef.current.onReject?.(st.id),
                onExitComplete: (id: string) =>
                  nodeCallbacksRef.current.onStickyExitComplete?.(id),
                onUpdate: async (updates: {
                  title?: string;
                  body?: string;
                  previewText?: string;
                  paletteId?: string;
                  colorSlot?: number;
                }) => {
                  const preview =
                    updates.body !== undefined
                      ? extractPreviewText(updates.body)
                      : undefined;
                  await updateSticky(st.id, {
                    ...updates,
                    previewText: preview ?? updates.previewText,
                  });
                  nodeCallbacksRef.current.setStickies((prev) =>
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
                onBranchFrom: (dir: "left" | "right") =>
                  nodeCallbacksRef.current.onBranchFrom?.(key, dir),
              },
            };
          })
        : [];

      // AI Branch nodes
      const stickyCountByBranchId = countStickiesByBranch(stickies);
      const aiBranchPosMap = currentPositionProjection.aiBranchPositions;
      const aiBranchNodes: Node[] = show.aiBranch
        ? aiBranches.map((ab, idx) => {
            const key = `ai_branch:${ab.id}`;
            return {
              id: key,
              type: "ai_branch",
              position: aiBranchPosMap.get(key) ?? {
                x: 400 + (idx % 4) * 260,
                y: 800 + Math.floor(idx / 4) * 140,
              },
              className: transitionClass,
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                prompt: ab.prompt,
                sessionId: ab.sessionId,
                derivedStickyCount: stickyCountByBranchId.get(ab.id) ?? 0,
                onOpenChat: () => {
                  if (ab.sessionId) {
                    useChatStore.getState().selectSession(ab.sessionId);
                  }
                },
                onDelete: async () => {
                  const snapshot = !useGlobalHistoryStore.getState().isReplaying
                    ? await getAiBranchSnapshot(ab.id)
                    : null;
                  await deleteAiBranch(ab.id);
                  nodeCallbacksRef.current.setAiBranches((prev) =>
                    prev.filter((b) => b.id !== ab.id),
                  );
                  if (snapshot) {
                    nodeCallbacksRef.current.setPositions((prev) =>
                      prev.filter((p) => p.id !== snapshot.branchPosition.id),
                    );
                  }
                  // Stickies persist as orphans (aiBranchId → null in DB via ON DELETE SET NULL)

                  if (snapshot) {
                    const cap = snapshot;
                    useGlobalHistoryStore.getState().push({
                      kind: "map",
                      label: i18next.t("map.history.aiBranchDelete"),
                      async undo() {
                        await restoreAiBranchSnapshot(cap);
                        nodeCallbacksRef.current.setAiBranches((prev) => [
                          ...prev,
                          cap.branch,
                        ]);
                        nodeCallbacksRef.current.setPositions((prev) => [
                          ...prev,
                          cap.branchPosition as MapNodePositionRecord,
                        ]);
                      },
                      async redo() {
                        await deleteAiBranch(cap.branch.id);
                        nodeCallbacksRef.current.setAiBranches((prev) =>
                          prev.filter((b) => b.id !== cap.branch.id),
                        );
                        nodeCallbacksRef.current.setPositions((prev) =>
                          prev.filter((p) => p.id !== cap.branchPosition.id),
                        );
                      },
                    });
                  }
                },
                onBranchFrom: (dir: "left" | "right") =>
                  nodeCallbacksRef.current.onBranchFrom?.(key, dir),
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
            const candidate = { ...base, position: p.position };
            return mapNodePresentationEqual(p, candidate) ? p : candidate;
          }
          if (persisting.has(n.id)) {
            const candidate = { ...base, position: p.position };
            return mapNodePresentationEqual(p, candidate) ? p : candidate;
          }
          return mapNodePresentationEqual(p, base) ? p : base;
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

    // Defense: any unhandled rejection inside buildNodes (e.g. force-layout
    // worker rejection from d3-force-link "node not found") would otherwise
    // leave forceLayoutRunning stuck at true — progress bar永続化＋
    // nodesDraggable false でドラッグ不可 になる。catch で必ず復帰させる。
    buildNodes().catch((err) => {
      console.error("[useMapNodes] buildNodes failed", err);
      if (!cancelled) setForceLayoutRunning(false);
    });
    return () => {
      cancelled = true;
      setForceLayoutRunning(false);
    };
  }, [
    boardId,
    treeNodes,
    codexEntries,
    snippets,
    stickies,
    aiBranches,
    positionProjection,
    show,
    mode,
    themeLayoutFingerprint,
    userEdges,
    colorBy,
    visualTheme,
    frames,
    setNodes,
    setForceLayoutRunning,
    setForceAlpha,
    groupDraggingRef,
    persistingRef,
    deletingStickyIds,
  ]);

  // Apply the mode-transition CSS class directly to already-built nodes when
  // `modeTransitionActive` toggles. This is intentionally separate from the
  // buildNodes effect above so a presentational flag change never re-runs the
  // force layout (see the ref comment near the top of this hook).
  const classTransitionMountRef = useRef(true);
  useEffect(() => {
    if (classTransitionMountRef.current) {
      classTransitionMountRef.current = false;
      return;
    }
    const cls = modeTransitionActive ? "with-mode-transition" : undefined;
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        if (n.className === cls) return n;
        changed = true;
        return { ...n, className: cls };
      });
      return changed ? next : prev;
    });
  }, [modeTransitionActive, setNodes]);
}
