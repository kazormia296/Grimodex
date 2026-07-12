import { useCallback, useMemo, useEffect, useRef, useState } from "react";
import { generateKeyBetween } from "fractional-indexing";
import { useTreeStore } from "@/features/tree/treeStore";
import { computeTimelineSceneOrder } from "./timelineSceneOrder";
import { computeFolderGroups } from "./timelineLabels";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTranslation } from "react-i18next";
import {
  useTimelineStore,
  INSPECTOR_WIDTH_MIN,
  INSPECTOR_WIDTH_MAX,
} from "./timelineStore";
import { Splitter } from "@/features/layout/Splitter";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useProjectStore } from "@/features/project/projectStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { TimelineHeader } from "./TimelineHeader";
import { TimelineViewport } from "./TimelineViewport";
import { TimelineInspector } from "./TimelineInspector";
import { PlotMarkerInspector } from "@/features/plot-threads/PlotMarkerInspector";
import { PlotMarkerDeleteConfirmDialog } from "@/features/plot-threads/PlotMarkerDeleteConfirmDialog";
import { PlotStructureAnalysis } from "@/features/plot-threads/PlotStructureAnalysis";
import type { PhasePinData } from "./TimelineViewport";
import { recordMark } from "@/lib/perfLog";
import { useTimelineKeyboardController } from "./useTimelineKeyboardController";

/** ビューポート↔インスペクタ間の縦 Splitter 帯の固定幅(px)。 */
const INSPECTOR_SPLITTER_PX = 8;

export function TimelinePanel() {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
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
  const showStructureAnalysis = useTimelineStore(
    (s) => s.display.showStructureAnalysis,
  );
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
  // Delete キーでのスレッド削除確認（インスペクタ/右クリックと同じ確認 DLG を共有）。
  // 中身（マーカー/分岐）があるスレッドのみ確認を挟み、空スレッドは即削除。開いた時点の
  // 件数スナップショットを持つ（モーダル中は store 変化に追従不要）。
  const [pendingThreadDelete, setPendingThreadDelete] = useState<{
    id: string;
    name: string;
    markerCount: number;
    edgeCount: number;
  } | null>(null);
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

  // Build sorted scene list and optional position weights per axis mode.
  // 並び替えロジックは computeTimelineSceneOrder に集約（構造分析パネルと軸を共有）。
  const { scenes, weights } = useMemo(
    () => computeTimelineSceneOrder(nodes, axisMode, spacingMode),
    [axisMode, spacingMode, nodes],
  );

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
      openEditorDocument(
        {
          target: { kind: "scene", documentId: id },
          mode: "preview",
          revealEditor: false,
          focusEditor: false,
          syncSceneContext: true,
        },
        defaultEditorNavigationPorts,
      );
      // プロット選択を解除し、開いているインスペクタをシーン用に切り替える。
      setSelectedPlotLinkId(null);
      setSelectedPlotThreadId(null);
    },
    [selectNode, setSelectedPlotLinkId, setSelectedPlotThreadId],
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

  useTimelineKeyboardController({
    containerRef,
    viewportRef,
    nodes,
    scenes,
    showThreads,
    scheduledCount,
    weights,
    zoom,
    setZoom,
    clearSelection,
    setAxisMode,
    deleteNode,
    selectNode,
    setPendingEditNodeId,
    rangeSelectTo,
    toggleInspector,
    setPendingThreadDelete,
  });

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
      {showStructureAnalysis && <PlotStructureAnalysis />}
      {pendingThreadDelete && (
        <PlotMarkerDeleteConfirmDialog
          title={t("plotThread.deleteThreadConfirmTitle", "スレッドの削除")}
          description={t(
            "plotThread.deleteThreadConfirmBody",
            "「{{name}}」を削除すると、マーカー {{markers}} 個と分岐 / 合流 {{edges}} 件も削除されます。続行しますか？",
            {
              name:
                pendingThreadDelete.name || t("plotThread.unnamed", "（無名）"),
              markers: pendingThreadDelete.markerCount,
              edges: pendingThreadDelete.edgeCount,
            },
          )}
          onCancel={() => setPendingThreadDelete(null)}
          onConfirm={() => {
            const id = pendingThreadDelete.id;
            // 選択を全クリア（残ったシーン選択が DLG クローズ後の Delete で
            // 誤って消えるのを防ぐ）。インスペクタ経路と同じく削除は undo 可。
            clearSelection();
            void usePlotThreadStore.getState().deleteThread(id);
            setPendingThreadDelete(null);
          }}
        />
      )}
    </div>
  );
  recordMark(
    "timelinePanel.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}
