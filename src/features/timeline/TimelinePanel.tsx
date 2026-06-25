import { useCallback, useMemo, useEffect, useRef } from "react";
import { generateKeyBetween } from "fractional-indexing";
import { useTreeStore } from "@/features/tree/treeStore";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { computeFolderGroups } from "./timelineLabels";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTranslation } from "react-i18next";
import {
  useTimelineStore,
  INSPECTOR_WIDTH_MIN,
  INSPECTOR_WIDTH_MAX,
} from "./timelineStore";
import { Splitter } from "@/features/layout/Splitter";
import { useTabStore } from "@/features/editor/tabStore";
import { useProjectStore } from "@/features/project/projectStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { computeFitZoom, ZOOM_STEP, STEP_BASE } from "./timelineZoom";
import { TimelineHeader } from "./TimelineHeader";
import {
  TimelineViewport,
  PAD_LEFT,
  PAD_RIGHT,
  SUBWAY_LABEL_GUTTER,
} from "./TimelineViewport";
import { TimelineInspector } from "./TimelineInspector";
import { PlotMarkerInspector } from "@/features/plot-threads/PlotMarkerInspector";
import type { PhasePinData } from "./TimelineViewport";
import { recordMark } from "@/lib/perfLog";

/** ビューポート↔インスペクタ間の縦 Splitter 帯の固定幅(px)。 */
const INSPECTOR_SPLITTER_PX = 8;

export function TimelinePanel() {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const updateStoryTime = useTreeStore((s) => s.updateStoryTime);
  const axisMode = useTimelineStore((s) => s.axisMode);
  const spacingMode = useTimelineStore((s) => s.spacingMode);
  const selectNode = useTimelineStore((s) => s.selectNode);
  const selectedNodeIds = useTimelineStore((s) => s.selectedNodeIds);
  const inspectorOpen = useTimelineStore((s) => s.inspectorOpen);
  const toggleInspector = useTimelineStore((s) => s.toggleInspector);
  const inspectorWidth = useTimelineStore((s) => s.inspectorWidth);
  const setInspectorWidth = useTimelineStore((s) => s.setInspectorWidth);
  const showThreads = useTimelineStore((s) => s.showThreads);
  const selectedPlotLinkId = useTimelineStore((s) => s.selectedPlotLinkId);
  const selectedPlotThreadId = useTimelineStore((s) => s.selectedPlotThreadId);
  const setSelectedPlotThreadId = useTimelineStore(
    (s) => s.setSelectedPlotThreadId,
  );
  const setSelectedPlotLinkId = useTimelineStore(
    (s) => s.setSelectedPlotLinkId,
  );
  const zoom = useTimelineStore((s) => s.zoom);
  const setZoom = useTimelineStore((s) => s.setZoom);
  const clearSelection = useTimelineStore((s) => s.clearSelection);
  const setAxisMode = useTimelineStore((s) => s.setAxisMode);
  const setPendingEditNodeId = useTimelineStore((s) => s.setPendingEditNodeId);
  const rangeSelectTo = useTimelineStore((s) => s.rangeSelectTo);
  const deleteNode = useTreeStore((s) => s.deleteNode);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const phasesByEntry = usePhaseStore((s) => s.phasesByEntry);
  const entries = useCodexStore((s) => s.entries);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  // プロットスレッド/マーカーを project スコープでロード（切替で再取得）。
  useEffect(() => {
    if (currentProjectId) {
      void usePlotThreadStore.getState().load(currentProjectId);
    }
  }, [currentProjectId]);

  const sceneNodes = useMemo(
    () => nodes.filter((n) => n.nodeType === "scene"),
    [nodes],
  );

  // Build sorted scene list and optional position weights per axis mode
  const { scenes, weights } = useMemo(() => {
    if (axisMode === "reading") {
      const order = computeGlobalSceneOrder(nodes);
      const sorted = [...sceneNodes].sort(
        (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
      );
      return { scenes: sorted, weights: null };
    }

    if (axisMode === "story") {
      const scheduled = sceneNodes.filter((n) => n.storyTimeOrder !== null);
      const unscheduled = sceneNodes.filter((n) => n.storyTimeOrder === null);
      scheduled.sort((a, b) => cmpKeys(a.storyTimeOrder!, b.storyTimeOrder!));
      // reading-order fallback for unscheduled
      const readOrder = computeGlobalSceneOrder(nodes);
      unscheduled.sort(
        (a, b) => (readOrder.get(a.id) ?? 0) - (readOrder.get(b.id) ?? 0),
      );
      const sorted = [...scheduled, ...unscheduled];
      // For proportional spacing: use index within scheduled portion
      const ws =
        spacingMode === "proportional" && scheduled.length > 1
          ? scheduled.map((_, i) => i / (scheduled.length - 1))
          : null;
      return { scenes: sorted, weights: ws, scheduledCount: scheduled.length };
    }

    // write-order: sort by createdAt
    const sorted = [...sceneNodes].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const ws =
      spacingMode === "proportional" && sorted.length > 1
        ? (() => {
            const t0 = Date.parse(sorted[0].createdAt);
            const t1 = Date.parse(sorted[sorted.length - 1].createdAt);
            const span = t1 - t0 || 1;
            return sorted.map((n) => (Date.parse(n.createdAt) - t0) / span);
          })()
        : null;
    return { scenes: sorted, weights: ws };
  }, [axisMode, spacingMode, sceneNodes, nodes]);

  // X 軸下に描くフォルダ・グルーピング帯（部/章）。フォルダは reading 順で連続するため
  // reading モードのみ。各シーンの祖先フォルダ(root→直近)を辿って level 別レンジに束ねる。
  const nodeById = useMemo(() => {
    const m = new Map<string, (typeof nodes)[number]>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);
  const folderGroups = useMemo(() => {
    if (axisMode !== "reading") return [];
    const ancestorsOf = (sceneId: string) => {
      const path: { id: string; label: string }[] = [];
      const guard = new Set<string>();
      let pid = nodeById.get(sceneId)?.parentId ?? null;
      while (pid && !guard.has(pid)) {
        guard.add(pid);
        const f = nodeById.get(pid);
        if (!f || f.nodeType !== "folder") break;
        path.push({ id: f.id, label: f.title });
        pid = f.parentId;
      }
      return path.reverse(); // root(部) → 直近(章)
    };
    return computeFolderGroups(
      scenes.map((s) => s.id),
      ancestorsOf,
    );
  }, [axisMode, scenes, nodeById]);

  // Build phase pins from phaseStore + codexStore
  const phasePins = useMemo<PhasePinData[]>(() => {
    const entryMap = new Map(entries.map((e) => [e.id, e.name]));
    const pins: PhasePinData[] = [];
    for (const [entryId, phases] of Object.entries(phasesByEntry)) {
      const entryName = entryMap.get(entryId) ?? entryId;
      for (const phase of phases) {
        if (phase.anchorNodeId) {
          pins.push({
            nodeId: phase.anchorNodeId,
            label: phase.label,
            entryName,
          });
        }
      }
    }
    return pins;
  }, [phasesByEntry, entries]);

  const handleDropStoryTime = useCallback(
    (
      nodeId: string,
      prevKey: string | null,
      nextKey: string | null,
      toUnscheduled: boolean,
    ) => {
      if (toUnscheduled) {
        void updateStoryTime(nodeId, null);
        return;
      }
      const newKey = generateKeyBetween(prevKey, nextKey);
      void updateStoryTime(nodeId, newKey);
    },
    [updateStoryTime],
  );

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeIds[0]) ?? null,
    [nodes, selectedNodeIds],
  );

  const handleUpdateStoryTimeLabel = useCallback(
    (id: string, label: string) => {
      void updateStoryTime(
        id,
        nodes.find((n) => n.id === id)?.storyTimeOrder ?? null,
        label,
      );
    },
    [updateStoryTime, nodes],
  );

  const handleSelectScene = useCallback(
    (id: string) => {
      // 設計書（L415-419）どおり Scenes パネルと同じプレビュー/固定モデル：
      // シングルクリックは「選択 + プレビュータブで開く」のみ。インスペクタは
      // 自動オープンしない（⋮ で明示的に開く）。
      selectNode(id);
      useTabStore.getState().openPreview(id);
      setActiveScene(id);
      // プロット選択を解除し、開いているインスペクタをシーン用に切り替える。
      setSelectedPlotLinkId(null);
      setSelectedPlotThreadId(null);
    },
    [
      selectNode,
      setActiveScene,
      setSelectedPlotLinkId,
      setSelectedPlotThreadId,
    ],
  );

  const handleSelectMarker = useCallback(
    (linkId: string) => {
      setSelectedPlotLinkId(linkId);
      if (!useTimelineStore.getState().inspectorOpen) toggleInspector();
      // キーボード(↑↓)ナビ用にフォーカスをパネルへ戻す（インスペクタに吸われない）。
      containerRef.current?.focus();
    },
    [setSelectedPlotLinkId, toggleInspector],
  );

  const handleSelectThread = useCallback(
    (threadId: string) => {
      useTimelineStore.getState().setSelectedPlotThreadId(threadId);
      setSelectedPlotLinkId(null);
      if (!useTimelineStore.getState().inspectorOpen) toggleInspector();
      containerRef.current?.focus();
    },
    [setSelectedPlotLinkId, toggleInspector],
  );

  // For story-time: how many scenes have story_time_order set
  const scheduledCount = useMemo(
    () =>
      axisMode === "story"
        ? sceneNodes.filter((n) => n.storyTimeOrder !== null).length
        : null,
    [axisMode, sceneNodes],
  );

  useEffect(() => {
    function handlePlainKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.shiftKey && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (!containerRef.current?.contains(document.activeElement)) return;
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      )
        return;

      // プロットスレッド表示中の 2D マーカーナビ。↑/↓=スレッド(行)移動・列は維持して
      // 最寄りマーカーへ / ←/→=同スレッド内のマーカー(列)移動。plot 選択中のみ ←/→ を
      // 横取りする（未選択なら false を返しシーンナビに委ねる）。handled なら true。
      function plotNav(dir: "up" | "down" | "left" | "right"): boolean {
        const tl = useTimelineStore.getState();
        if (!tl.showThreads) return false;
        const ts = usePlotThreadStore.getState().threads;
        const ls = usePlotThreadStore.getState().links;
        if (ts.length === 0) return false;
        const horizontal = dir === "left" || dir === "right";
        const hasSel = !!(tl.selectedPlotLinkId || tl.selectedPlotThreadId);
        if (horizontal && !hasSel) return false; // ←/→ はシーンナビに任せる
        const ordered = [...ts].sort((a, b) => {
          const c = cmpKeys(a.sortOrder, b.sortOrder);
          return c !== 0 ? c : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        const colOf = (nodeId: string) =>
          scenes.findIndex((s) => s.id === nodeId);
        const markersOf = (tid: string) =>
          ls
            .filter((l) => l.threadId === tid && colOf(l.nodeId) >= 0)
            .sort((a, b) => colOf(a.nodeId) - colOf(b.nodeId));
        const select = (next: { threadId?: string; linkId?: string }) => {
          if (next.linkId) {
            const t = ls.find((l) => l.id === next.linkId)?.threadId ?? null;
            tl.setSelectedPlotThreadId(t);
            tl.setSelectedPlotLinkId(next.linkId);
          } else {
            tl.setSelectedPlotThreadId(next.threadId ?? null);
            tl.setSelectedPlotLinkId(null);
          }
          if (!tl.inspectorOpen) toggleInspector();
          // インスペクタ再描画でフォーカスが移っても次キーが効くようパネルへ戻す。
          containerRef.current?.focus();
        };
        const curLink = tl.selectedPlotLinkId
          ? ls.find((l) => l.id === tl.selectedPlotLinkId)
          : undefined;
        const curThreadId = curLink?.threadId ?? tl.selectedPlotThreadId;
        const curCol = curLink ? colOf(curLink.nodeId) : null;

        if (horizontal) {
          if (!curThreadId) return false;
          const ms = markersOf(curThreadId);
          if (ms.length === 0) return true;
          if (!curLink) {
            select({
              linkId: dir === "right" ? ms[0].id : ms[ms.length - 1].id,
            });
            return true;
          }
          const i = ms.findIndex((m) => m.id === curLink.id);
          const ni = Math.min(
            ms.length - 1,
            Math.max(0, i + (dir === "right" ? 1 : -1)),
          );
          select({ linkId: ms[ni].id });
          return true;
        }

        // up / down: スレッド(行)を移動。
        const ci = curThreadId
          ? ordered.findIndex((t) => t.id === curThreadId)
          : -1;
        const d = dir === "down" ? 1 : -1;
        const ni =
          ci === -1
            ? d === 1
              ? 0
              : ordered.length - 1
            : Math.min(ordered.length - 1, Math.max(0, ci + d));
        const nt = ordered[ni];
        if (!nt) return true;
        const ms = markersOf(nt.id);
        if (ms.length === 0) {
          select({ threadId: nt.id });
          return true;
        }
        if (curCol == null) {
          select({ linkId: ms[0].id });
          return true;
        }
        // 同じ列、無ければ最寄り列のマーカーを選ぶ。
        let best = ms[0];
        let bestD = Math.abs(colOf(best.nodeId) - curCol);
        for (const m of ms) {
          const dd = Math.abs(colOf(m.nodeId) - curCol);
          if (dd < bestD) {
            best = m;
            bestD = dd;
          }
        }
        select({ linkId: best.id });
        return true;
      }

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          clearSelection();
          useTimelineStore.getState().setSelectedPlotThreadId(null);
          useTimelineStore.getState().setSelectedPlotLinkId(null);
          break;
        case "1":
          e.preventDefault();
          setAxisMode("reading");
          break;
        case "2":
          e.preventDefault();
          setAxisMode("story");
          break;
        case "3":
          e.preventDefault();
          setAxisMode("write");
          break;
        case "Delete": {
          const ps = useTimelineStore.getState();
          // プロット(スレッド/マーカー)選択中はシーンに作用させない（最後に選択した
          // シーンを誤って消さない）。マーカー/スレッド削除はインスペクタ/右クリックで
          // 確認ダイアログ経由。
          if (ps.selectedPlotLinkId || ps.selectedPlotThreadId) break;
          const { selectedNodeIds: ids } = ps;
          if (ids.length > 0) {
            e.preventDefault();
            for (const id of [...ids]) void deleteNode(id);
          }
          break;
        }
        case "Enter": {
          const ps = useTimelineStore.getState();
          if (ps.selectedPlotLinkId || ps.selectedPlotThreadId) break;
          const { selectedNodeIds: ids } = ps;
          if (ids.length > 0) {
            e.preventDefault();
            useTabStore.getState().openPinned(ids[0]);
            setActiveScene(ids[0]);
          }
          break;
        }
        case "F2": {
          const {
            axisMode: curMode,
            selectedNodeIds: ids,
            inspectorOpen: isOpen,
            selectedPlotLinkId: pl,
            selectedPlotThreadId: pt,
          } = useTimelineStore.getState();
          if (pl || pt) break;
          if (curMode === "story" && ids.length > 0) {
            const targetId = ids[0];
            if (!nodes.some((n) => n.id === targetId)) break;
            e.preventDefault();
            setPendingEditNodeId(targetId);
            if (!isOpen) toggleInspector();
          }
          break;
        }
        case "ArrowRight": {
          if (plotNav("right")) {
            e.preventDefault();
            break;
          }
          const { selectedNodeIds: ids } = useTimelineStore.getState();
          e.preventDefault();
          if (ids.length === 0 && scenes.length > 0) {
            selectNode(scenes[0].id);
            break;
          }
          const refId = ids[ids.length - 1];
          const idx = scenes.findIndex((s) => s.id === refId);
          if (idx !== -1 && idx < scenes.length - 1) {
            const nextId = scenes[idx + 1].id;
            if (e.shiftKey) {
              rangeSelectTo(
                nextId,
                scenes.map((s) => s.id),
              );
            } else {
              selectNode(nextId);
            }
          }
          break;
        }
        case "ArrowLeft": {
          if (plotNav("left")) {
            e.preventDefault();
            break;
          }
          const { selectedNodeIds: ids } = useTimelineStore.getState();
          e.preventDefault();
          if (ids.length === 0 && scenes.length > 0) {
            selectNode(scenes[scenes.length - 1].id);
            break;
          }
          const refId = ids[0];
          const idx = scenes.findIndex((s) => s.id === refId);
          if (idx > 0) {
            const prevId = scenes[idx - 1].id;
            if (e.shiftKey) {
              rangeSelectTo(
                prevId,
                scenes.map((s) => s.id),
              );
            } else {
              selectNode(prevId);
            }
          }
          break;
        }
        case "ArrowUp": {
          if (plotNav("up")) e.preventDefault();
          break;
        }
        case "ArrowDown": {
          if (plotNav("down")) e.preventDefault();
          break;
        }
      }
    }
    document.addEventListener("keydown", handlePlainKeyDown);
    return () => document.removeEventListener("keydown", handlePlainKeyDown);
  }, [
    nodes,
    scenes,
    clearSelection,
    setAxisMode,
    deleteNode,
    selectNode,
    setActiveScene,
    setPendingEditNodeId,
    rangeSelectTo,
    toggleInspector,
  ]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      // Don't steal shortcuts while a text input or TipTap editor is focused
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      )
        return;
      switch (e.key) {
        case "Enter": {
          if (!containerRef.current?.contains(document.activeElement)) break;
          const { selectedNodeIds: ids } = useTimelineStore.getState();
          if (ids.length > 0) {
            e.preventDefault();
            useTabStore.getState().openInSecondaryGroup(ids[0]);
            setActiveScene(ids[0]);
          }
          break;
        }
        case "0":
          e.preventDefault();
          if (viewportRef.current) {
            // Proportional mode: SVG width = PAD_LEFT + visibleForWidth*STEP*2 + PAD_RIGHT
            // Uniform mode:      SVG width = PAD_LEFT + scenes.length*STEP + PAD_RIGHT
            const visibleForFit =
              scheduledCount !== null
                ? Math.max(scheduledCount, 1)
                : scenes.length;
            const baseCount =
              weights != null ? visibleForFit * 2 : scenes.length;
            // スレッド表示時は左ラベルガター分だけ content を右へ寄せる。fit がそのぶんを
            // 確保しないと過ズームで右端がはみ出す。
            const padLeftForFit = showThreads ? SUBWAY_LABEL_GUTTER : PAD_LEFT;
            setZoom(
              computeFitZoom(
                baseCount,
                viewportRef.current.clientWidth,
                STEP_BASE,
                padLeftForFit + PAD_RIGHT,
              ),
            );
          }
          break;
        case "+":
        case "=":
          e.preventDefault();
          setZoom(zoom * ZOOM_STEP);
          break;
        case "-":
          e.preventDefault();
          setZoom(zoom / ZOOM_STEP);
          break;
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    zoom,
    setZoom,
    scenes.length,
    weights,
    scheduledCount,
    setActiveScene,
    showThreads,
  ]);

  const __renderResult = (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-testid="timeline-panel"
      className="flex h-full flex-col overflow-hidden"
    >
      <TimelineHeader
        sceneCount={scenes.length}
        scheduledCount={scheduledCount}
        inspectorOpen={inspectorOpen}
        onToggleInspector={toggleInspector}
      />
      <div className="flex flex-1 overflow-hidden">
        <TimelineViewport
          ref={viewportRef}
          scenes={scenes}
          weights={weights}
          phasePins={phasePins}
          folderGroups={folderGroups}
          unscheduledStartIndex={
            axisMode === "story" && scheduledCount !== null
              ? scheduledCount
              : undefined
          }
          onDropStoryTime={
            axisMode === "story" ? handleDropStoryTime : undefined
          }
          onSelectScene={handleSelectScene}
          onSelectMarker={handleSelectMarker}
          onSelectThread={handleSelectThread}
        />
        {inspectorOpen && (
          // 固定幅の flex ボックスで Splitter を包む（CenterContent と同じ作法）。
          // SplitterHandle は w-full(=width:100%) なので、flex-row に直接置くと
          // flex-basis 100% を主張してビューポート(flex-1/basis 0%)を 0 幅へ潰し
          // タイムライン全体が空白になる。固定幅 box 内で cross-axis stretch させる。
          <div
            className="relative flex shrink-0"
            style={{ width: INSPECTOR_SPLITTER_PX }}
          >
            <Splitter
              orientation="horizontal"
              keyboardResize
              thickness={INSPECTOR_SPLITTER_PX}
              // deltaPx は先行ペイン(ビューポート)を増やす向きが正。インスペクタは
              // 後続ペインなので幅 = 現在幅 - dx（getState で増分を正しく累積）。
              onDrag={(dx) =>
                setInspectorWidth(
                  useTimelineStore.getState().inspectorWidth - dx,
                )
              }
              ariaLabel={t(
                "timeline.inspector.resize",
                "インスペクター幅を調整",
              )}
              ariaValueNow={inspectorWidth}
              ariaValueMin={INSPECTOR_WIDTH_MIN}
              ariaValueMax={INSPECTOR_WIDTH_MAX}
            />
          </div>
        )}
        {inspectorOpen &&
          // オーバーレイ統合: モードではなく「何を選択しているか」でインスペクタを
          // 切り替える。スレッド表示中にプロットのマーカー/スレッドを選択していれば
          // PlotMarkerInspector、それ以外（シーン選択 / 未選択 / スレッド非表示）は
          // TimelineInspector（スレッドを畳むとシーン用に戻る）。
          (showThreads && (selectedPlotLinkId || selectedPlotThreadId) ? (
            <PlotMarkerInspector
              width={inspectorWidth}
              onClose={toggleInspector}
            />
          ) : (
            // 選択が無くてもパネルを出す（中はプレースホルダー）。
            <TimelineInspector
              width={inspectorWidth}
              node={selectedNode}
              onClose={toggleInspector}
              onUpdateStoryTimeLabel={handleUpdateStoryTimeLabel}
            />
          ))}
      </div>
    </div>
  );
  recordMark(
    "timelinePanel.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}
