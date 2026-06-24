import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
  forwardRef,
} from "react";
import { useTranslation } from "react-i18next";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useTimelineStore } from "./timelineStore";
import { useCardLayout } from "@/features/layout/cardLayout";
import { computeAxisLabels } from "./timelineLabels";
import { ZOOM_STEP, STEP_BASE } from "./timelineZoom";
import { TimelineContextMenu } from "./TimelineContextMenu";
import { PlotMarkerContextMenu } from "./PlotMarkerContextMenu";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import {
  buildPlotLaneModel,
  LANE_HEIGHT,
} from "@/features/plot-threads/plotThreadLaneModel";
import { resolveMarkerDrop } from "@/features/plot-threads/plotThreadDnd";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { contrastTextColor } from "@/lib/resolveCodexColors";
import type { PlotPhaseType } from "@/db/schema";
import { recordMark } from "@/lib/perfLog";

const DOT_R = 6;
/** プロットスレッドの太いバンド（線）の高さ。段階テキストを内側に表示する。 */
const BAND_HEIGHT = 20;
const CHIP_FONT = 10;
/** 1シーンあたりの px（STEP）がこれ未満なら、段階チップを円に縮退させる。 */
const CHIP_MIN_STEP = 72;
/** subway 風ランプコネクタの水平方向の伸び（px）。 */
const CONNECTOR_RAMP = 34;
const LABEL_Y = 16;
const LANE_Y = 60;
const AXIS_Y = LANE_Y;
const PHASE_PIN_Y = LANE_Y + 44;
const UNSCHEDULED_Y = LANE_Y + 90;
const SVG_HEIGHT_BASE = 130;
export const PAD_LEFT = 48;
export const PAD_RIGHT = 32;

const STATUS_FILL: Record<string, string> = {
  outline: "var(--color-muted-foreground, #888)",
  draft: "#eab308",
  complete: "#22c55e",
  revision: "#c084fc",
  final: "#60a5fa",
};

export interface PhasePinData {
  nodeId: string;
  label: string;
  entryName: string;
}

/** 軸から何px離れたらY軸ロックを解除するか */
const AXIS_LOCK_THRESHOLD = 28;
/** マーカーをこの px 以上動かしたら「クリック」でなく「ドラッグ」とみなす */
const MARKER_DRAG_THRESHOLD = 4;

interface DragState {
  nodeId: string;
  startX: number;
  currentX: number;
  currentY: number;
  originIndex: number;
}

/** プロットマーカーのドラッグ（移動 / 分岐・合流作成）。scene の DragState とは別系統。 */
interface MarkerDragState {
  linkId: string;
  threadId: string;
  /** ドラッグ開始時のマーカーのシーン（branch/merge エッジ追従の判定に使う）。 */
  nodeId: string;
  color: string | null;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  moved: boolean;
}

interface ContextMenuState {
  node: TreeNodeData;
  x: number;
  y: number;
}

interface MarkerMenuState {
  linkId: string;
  phaseType: PlotPhaseType;
  /** マーカーのシーン/スレッド。アンカーする分岐/合流エッジの削除に使う。 */
  nodeId: string;
  threadId: string;
  x: number;
  y: number;
}

interface Props {
  scenes: TreeNodeData[];
  /** Normalized [0,1] x-positions for proportional spacing (null = uniform) */
  weights?: number[] | null;
  phasePins?: PhasePinData[];
  /** Index where scenes shift to the Unscheduled lane (story-time mode) */
  unscheduledStartIndex?: number;
  /** Called when user drags a node to a new story-time position */
  onDropStoryTime?: (
    nodeId: string,
    prevKey: string | null,
    nextKey: string | null,
    toUnscheduled: boolean,
  ) => void;
  onSelectScene: (id: string) => void;
  /** threads モードでマーカーをクリックしたとき（インスペクタ選択用）。 */
  onSelectMarker?: (linkId: string) => void;
  /** threads モードでレーン見出しをクリックしたとき（スレッド編集用）。 */
  onSelectThread?: (threadId: string) => void;
}

export const TimelineViewport = forwardRef<HTMLDivElement, Props>(
  function TimelineViewport(
    {
      scenes,
      weights = null,
      phasePins = [],
      unscheduledStartIndex,
      onDropStoryTime,
      onSelectScene,
      onSelectMarker,
      onSelectThread,
    }: Props,
    forwardedRef,
  ) {
    const __perfStart = performance.now();
    const { t } = useTranslation();
    const activeSceneId = useTreeStore((s) => s.activeSceneId);
    const selectedNodeIds = useTimelineStore((s) => s.selectedNodeIds);
    const toggleSelect = useTimelineStore((s) => s.toggleSelect);
    const rangeSelectTo = useTimelineStore((s) => s.rangeSelectTo);
    const display = useTimelineStore((s) => s.display);
    const axisMode = useTimelineStore((s) => s.axisMode);
    const showThreads = useTimelineStore((s) => s.showThreads);
    const selectedPlotLinkId = useTimelineStore((s) => s.selectedPlotLinkId);
    const threads = usePlotThreadStore((s) => s.threads);
    const links = usePlotThreadStore((s) => s.links);
    const branches = usePlotThreadStore((s) => s.branches);
    const zoom = useTimelineStore((s) => s.zoom);
    const setZoom = useTimelineStore((s) => s.setZoom);
    const scrollOffset = useTimelineStore((s) => s.scrollOffset);
    const setScrollOffset = useTimelineStore((s) => s.setScrollOffset);
    // カードレイアウトでは .gx-panel の 18px 角丸 + overflow-hidden が水平
    // スクロールバーの左右端を切る。card 時だけ下方向に少し逃がす（角丸を
    // クリアする。値は実機 QA で微調整可）。
    const cardLayout = useCardLayout();
    const svgRef = useRef<SVGSVGElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isRestoringRef = useRef(false);
    const [drag, setDrag] = useState<DragState | null>(null);
    const [markerDrag, setMarkerDrag] = useState<MarkerDragState | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(
      null,
    );
    const [markerMenu, setMarkerMenu] = useState<MarkerMenuState | null>(null);
    // Track when the scroll container element mounts/unmounts so the wheel
    // listener effect re-runs even if scenes load after the first render.
    const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);

    const STEP = STEP_BASE * zoom;

    // x はシーンの index（後段で xOf() により px 化）。毎 render の再計算を避ける。
    const sceneX = useMemo(() => {
      const m = new Map<string, number>();
      scenes.forEach((sc, i) => m.set(sc.id, i));
      return m;
    }, [scenes]);

    // showUnscheduledZone: story-time の未配置ドロップゾーンを表示するか。
    // オーバーレイ化でシーン行は常に表示するため viewMode に依存しない。
    const showUnscheduledZone = unscheduledStartIndex !== undefined;
    // シーン行（＋未配置ゾーン）の下端。スレッドのレーンはこの下に重ねる。
    const sceneAreaBottom = showUnscheduledZone
      ? SVG_HEIGHT_BASE + 60
      : SVG_HEIGHT_BASE;
    // レーンの開始 y。先頭レーンのヒット矩形(lane.y - LANE_HEIGHT/2)がシーン領域に
    // 食い込まないよう、ギャップは LANE_HEIGHT/2 以上とる。
    const threadsTop = sceneAreaBottom + LANE_HEIGHT / 2;

    // scheduled シーン数（story-time の未配置を除く）。未配置はプロット側で弾く。
    const scheduledCountForLanes = unscheduledStartIndex ?? scenes.length;

    // プロットスレッドのレーン描画モデル（showThreads のときのみ使用）。
    // laneTop をシーン行の下に下げてオーバーレイする。
    const laneModel = useMemo(
      () =>
        buildPlotLaneModel({
          threads,
          links,
          sceneX,
          laneTop: threadsTop,
          branches,
          scheduledCount: scheduledCountForLanes,
        }),
      [threads, links, sceneX, threadsTop, branches, scheduledCountForLanes],
    );

    // ラベル衝突の決定的押し下げ: 束ね（共有スロット）で lane.y が一致するレーンの
    // ラベルが重ならないよう、レーン順に既使用 Y を避けて配置する（線/マーカーは不動）。
    const plotLabelY = useMemo(() => {
      const used = new Set<number>();
      const map = new Map<string, number>();
      for (const lane of laneModel.lanes) {
        let y = lane.y - 10;
        while (used.has(y)) y += 12;
        used.add(y);
        map.set(lane.thread.id, y);
      }
      return map;
    }, [laneModel]);

    /** その列でのレーンのスロット Y（px）。slotByColumn は threadsTop 基準。 */
    const laneSlotY = (lane: (typeof laneModel.lanes)[number], x: number) =>
      threadsTop + (lane.slotByColumn.get(x) ?? 0) * LANE_HEIGHT;

    const svgHeight =
      showThreads && laneModel.lanes.length > 0
        ? Math.max(sceneAreaBottom, laneModel.contentHeight + 16)
        : sceneAreaBottom;

    // Compute x positions
    const scheduledCount = unscheduledStartIndex ?? scenes.length;
    const visibleForWidth = Math.max(scheduledCount, 1);
    const totalWidth =
      weights && weights.length > 0
        ? PAD_LEFT + visibleForWidth * STEP * 2 + PAD_RIGHT
        : PAD_LEFT + scenes.length * STEP + PAD_RIGHT;

    function xOf(i: number): number {
      if (i >= scheduledCount) {
        // Unscheduled: place below in a separate lane at same x step
        return PAD_LEFT + (i - scheduledCount) * STEP;
      }
      if (weights && weights.length > i) {
        return PAD_LEFT + weights[i] * (visibleForWidth * STEP * 2);
      }
      return PAD_LEFT + i * STEP;
    }

    function yOf(i: number): number {
      return i >= scheduledCount ? UNSCHEDULED_Y : LANE_Y;
    }

    /** svgX に最も近いシーンの index（threads モードのマーカー追加位置決め）。
     *  未配置シーン(i >= scheduledCount)は xOf が scheduled 列へ折り重なり、最寄り
     *  判定が誤シーンを返すため scheduled 範囲に限定する（story-time の誤紐づけ防止）。 */
    function nearestSceneIndex(svgX: number): number {
      // scheduled が 0（story-time で全シーン未配置）のときは「該当なし」を返す。
      // 0 を返すと未配置シーンに不可視マーカーを作ってしまう。
      let best = scheduledCount > 0 ? 0 : -1;
      let bestDist = Infinity;
      for (let i = 0; i < scheduledCount; i++) {
        const d = Math.abs(xOf(i) - svgX);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    }

    /** ドロップ x に最寄りの scheduled シーン id（無ければ undefined）。 */
    function nearestSceneId(svgX: number): string | undefined {
      const i = nearestSceneIndex(svgX);
      return i >= 0 ? scenes[i]?.id : undefined;
    }

    function handleLaneDoubleClick(
      e: React.MouseEvent<SVGRectElement>,
      threadId: string,
    ) {
      const rect = svgRef.current?.getBoundingClientRect();
      const svgX = e.clientX - (rect?.left ?? 0);
      const sceneId = nearestSceneId(svgX);
      if (sceneId) {
        void usePlotThreadStore
          .getState()
          .addMarker(threadId, sceneId, "develop");
      }
    }

    const pinsByNode = new Map<string, PhasePinData[]>();
    for (const pin of phasePins) {
      const list = pinsByNode.get(pin.nodeId) ?? [];
      list.push(pin);
      pinsByNode.set(pin.nodeId, list);
    }

    const canDrag = !!onDropStoryTime;

    function handleDotMouseDown(
      e: React.MouseEvent<SVGCircleElement>,
      nodeId: string,
      originIndex: number,
    ) {
      if (!canDrag) return;
      e.preventDefault();
      const rect = svgRef.current?.getBoundingClientRect();
      const svgX = e.clientX - (rect?.left ?? 0);
      const svgY = e.clientY - (rect?.top ?? 0);
      setDrag({
        nodeId,
        startX: svgX,
        currentX: svgX,
        currentY: svgY,
        originIndex,
      });
    }

    function handleDotContextMenu(
      e: React.MouseEvent<SVGCircleElement>,
      scene: TreeNodeData,
    ) {
      e.preventDefault();
      setContextMenu({ node: scene, x: e.clientX, y: e.clientY });
    }

    function commitDrop(clientX: number, clientY: number) {
      if (!drag || !onDropStoryTime) {
        setDrag(null);
        return;
      }
      const rect = svgRef.current?.getBoundingClientRect();
      const svgX = clientX - (rect?.left ?? 0);
      const toUnscheduled =
        showUnscheduledZone && clientY - (rect?.top ?? 0) > UNSCHEDULED_Y - 20;

      if (toUnscheduled) {
        onDropStoryTime(drag.nodeId, null, null, true);
      } else {
        // Preserve original scene index so xOf() returns the correct x position.
        // Filtering first then using the filtered index causes xOf() to compute
        // positions for wrong slots (off-by-one or more after the removed node).
        const scheduledWithOrigin = scenes
          .slice(0, scheduledCount)
          .map((scene, origIdx) => ({ scene, origIdx }))
          .filter(({ scene }) => scene.id !== drag.nodeId);

        let insertIdx = scheduledWithOrigin.length;
        for (let i = 0; i < scheduledWithOrigin.length; i++) {
          if (xOf(scheduledWithOrigin[i].origIdx) > svgX) {
            insertIdx = i;
            break;
          }
        }
        const prevKey =
          insertIdx > 0
            ? (scheduledWithOrigin[insertIdx - 1].scene.storyTimeOrder ?? null)
            : null;
        const nextKey =
          insertIdx < scheduledWithOrigin.length
            ? (scheduledWithOrigin[insertIdx].scene.storyTimeOrder ?? null)
            : null;
        onDropStoryTime(drag.nodeId, prevKey, nextKey, false);
      }
      setDrag(null);
    }

    // ドラッグ中はdocumentレベルでmousemove/mouseupを捕捉する。
    // SVGの外にマウスが出てもドラッグが継続し、mouseupで正しくドロップされる。
    useEffect(() => {
      if (!drag) return;

      function onMove(e: MouseEvent) {
        const rect = svgRef.current?.getBoundingClientRect();
        const svgX = e.clientX - (rect?.left ?? 0);
        const svgY = e.clientY - (rect?.top ?? 0);
        setDrag((d) => (d ? { ...d, currentX: svgX, currentY: svgY } : null));
      }

      function onUp(e: MouseEvent) {
        commitDrop(e.clientX, e.clientY);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      return () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      // commitDrop は drag / scenes / scheduledCount に依存するが、
      // drag が変わるたびに再登録されるため最新値を参照できる
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [drag]);

    // ─── プロットマーカーのドラッグ（移動 / 分岐・合流作成） ───
    function handleMarkerMouseDown(
      e: React.MouseEvent<SVGElement>,
      linkId: string,
      threadId: string,
      nodeId: string,
      color: string | null,
    ) {
      if (!showThreads) return;
      e.stopPropagation();
      const rect = svgRef.current?.getBoundingClientRect();
      const svgX = e.clientX - (rect?.left ?? 0);
      const svgY = e.clientY - (rect?.top ?? 0);
      setMarkerDrag({
        linkId,
        threadId,
        nodeId,
        color,
        startX: svgX,
        startY: svgY,
        currentX: svgX,
        currentY: svgY,
        moved: false,
      });
    }

    function commitMarkerDrop(d: MarkerDragState) {
      // 動いていなければクリック扱い＝選択。
      if (!d.moved) {
        onSelectMarker?.(d.linkId);
        return;
      }
      // ドロップ列のライブスロット順で方向を判定する（固定 sortOrder ではない）。
      // 各レーンの当該列スロット Y（無ければアンカー lane.y）を渡す。
      const dropCol = nearestSceneIndex(d.currentX);
      const dropNodeId = dropCol >= 0 ? scenes[dropCol]?.id : undefined;
      const action = resolveMarkerDrop({
        dropY: d.currentY,
        sourceThreadId: d.threadId,
        nodeId: dropNodeId,
        columnSlots: laneModel.lanes.map((l) => ({
          threadId: l.thread.id,
          y: l.slotByColumn.has(dropCol) ? laneSlotY(l, dropCol) : l.y,
        })),
      });
      if (action.type === "none") return;
      const store = usePlotThreadStore.getState();

      const newThread =
        action.type === "branch" ? action.toThreadId : d.threadId;
      const newScene =
        action.type === "move-scene" ? action.nodeId : action.atNodeId;
      const crossThread = newThread !== d.threadId;

      // このマーカーが既存 branch/merge の構造側アンカーか（branch=to 側 /
      // merge=from 側、at=ドラッグ開始シーン）。
      const anchored = store.branches.filter(
        (b) =>
          b.atNodeId === d.nodeId &&
          ((b.kind === "branch" && b.toThreadId === d.threadId) ||
            (b.kind === "merge" && b.fromThreadId === d.threadId)),
      );

      if (anchored.length > 0) {
        // 既存エッジを持つマーカー: マーカーと一緒にエッジを追従／別スレッドへ付け替え
        // （新規エッジは作らない）。
        void store.updateMarker(
          d.linkId,
          crossThread
            ? { threadId: newThread, nodeId: newScene }
            : { nodeId: newScene },
        );
        for (const e of anchored) {
          // 付け替え後の (from,to,at,kind) を求め、自己参照 or 既存エッジと重複に
          // なるなら rebind せず削除する（新規/手動経路と同じ dedup 不変条件を維持）。
          const resFrom =
            crossThread && e.kind === "merge" ? newThread : e.fromThreadId;
          const resTo =
            crossThread && e.kind === "branch" ? newThread : e.toThreadId;
          const isSelf = resFrom === resTo;
          const isDupOther = store.branches.some(
            (b) =>
              b.id !== e.id &&
              b.fromThreadId === resFrom &&
              b.toThreadId === resTo &&
              b.atNodeId === newScene &&
              b.kind === e.kind,
          );
          if (isSelf || isDupOther) {
            void store.deleteBranch(e.id);
            continue;
          }
          void store.updateBranch(
            e.id,
            crossThread
              ? e.kind === "branch"
                ? { toThreadId: newThread, atNodeId: newScene }
                : { fromThreadId: newThread, atNodeId: newScene }
              : { atNodeId: newScene },
          );
        }
        return;
      }

      // 既存エッジ無し: 従来挙動。
      if (action.type === "move-scene") {
        void store.updateMarker(d.linkId, { nodeId: action.nodeId });
        return;
      }
      // 別スレッドへドロップ → 新規 branch/merge（片側のみマーカー）。
      // 既存の同一エッジがあれば非アトミックを避けるため何もしない。
      const isDup = store.branches.some(
        (b) =>
          b.fromThreadId === action.fromThreadId &&
          b.toThreadId === action.toThreadId &&
          b.atNodeId === action.atNodeId &&
          b.kind === action.kind,
      );
      if (isDup) return;
      if (action.kind === "branch") {
        void store.updateMarker(d.linkId, {
          threadId: action.toThreadId,
          nodeId: action.atNodeId,
        });
      } else {
        void store.updateMarker(d.linkId, { nodeId: action.atNodeId });
      }
      void store.addBranch({
        projectId: getCurrentProjectId(),
        fromThreadId: action.fromThreadId,
        toThreadId: action.toThreadId,
        atNodeId: action.atNodeId,
        kind: action.kind,
      });
    }

    function handleMarkerContextMenu(
      e: React.MouseEvent<SVGElement>,
      linkId: string,
      phaseType: PlotPhaseType,
      nodeId: string,
      threadId: string,
    ) {
      e.preventDefault();
      e.stopPropagation();
      setMarkerMenu({
        linkId,
        phaseType,
        nodeId,
        threadId,
        x: e.clientX,
        y: e.clientY,
      });
    }

    useEffect(() => {
      if (!markerDrag) return;
      function onMove(e: MouseEvent) {
        const rect = svgRef.current?.getBoundingClientRect();
        const svgX = e.clientX - (rect?.left ?? 0);
        const svgY = e.clientY - (rect?.top ?? 0);
        setMarkerDrag((d) => {
          if (!d) return null;
          const moved =
            d.moved ||
            Math.abs(svgX - d.startX) > MARKER_DRAG_THRESHOLD ||
            Math.abs(svgY - d.startY) > MARKER_DRAG_THRESHOLD;
          return { ...d, currentX: svgX, currentY: svgY, moved };
        });
      }
      function onUp() {
        // 副作用は updater の外で実行する（StrictMode の二重 invoke で
        // addBranch/updateMarker が重複発火するのを防ぐ。scene drag の onUp と同型）。
        if (markerDrag) commitMarkerDrop(markerDrag);
        setMarkerDrag(null);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      return () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      // commitMarkerDrop は markerDrag/laneModel/scenes に依存するが、
      // markerDrag 変化のたびに再登録されるため最新クロージャを参照する。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [markerDrag]);

    // Restore scroll position when scrollOffset changes from the store (e.g. after settings load).
    // isRestoringRef prevents the scroll event from writing back the same value.
    useEffect(() => {
      const el = containerRef.current;
      if (!el || el.scrollLeft === scrollOffset) return;
      isRestoringRef.current = true;
      el.scrollLeft = scrollOffset;
      requestAnimationFrame(() => {
        isRestoringRef.current = false;
      });
    }, [scrollOffset]);

    // Persist scroll position on user-initiated scroll.
    const handleScroll = useCallback(() => {
      if (isRestoringRef.current) return;
      const el = containerRef.current;
      if (el) setScrollOffset(el.scrollLeft);
    }, [setScrollOffset]);

    // マウスホイール（縦回転）でズーム。横スクロールしたいときは Shift+ホイール、
    // またはトラックパッドの横スワイプ（横優位の入力）をブラウザ既定の横スクロール
    // に委ねる。passive:false でないと preventDefault できない。
    // Depends on containerEl (not just []) so the listener re-attaches when scenes
    // load after the first render and the container div appears for the first time.
    useEffect(() => {
      if (!containerEl) return;
      const onWheel = (e: WheelEvent) => {
        // 横優位の入力（Shift+ホイール / トラックパッド横スワイプ）は横スクロールへ。
        // `>=` にすることで deltaY=0（横スワイプ / 慣性スクロール終端の 0,0 イベント）
        // を確実にズーム対象外にする（誤ズームアウト防止）。
        if (e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        setZoom(useTimelineStore.getState().zoom * factor);
      };
      containerEl.addEventListener("wheel", onWheel, { passive: false });
      return () => containerEl.removeEventListener("wheel", onWheel);
    }, [containerEl, setZoom]);

    const setContainerRef = useCallback(
      (el: HTMLDivElement | null) => {
        (
          containerRef as React.MutableRefObject<HTMLDivElement | null>
        ).current = el;
        setContainerEl(el);
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef)
          (
            forwardedRef as React.MutableRefObject<HTMLDivElement | null>
          ).current = el;
      },
      [forwardedRef],
    );

    if (scenes.length === 0) {
      const __emptyResult = (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("timeline.noScenes", "シーンがありません")}
        </div>
      );
      recordMark(
        "timelineViewport.render",
        performance.now() - __perfStart,
        __perfStart,
      );
      return __emptyResult;
    }

    const __renderResult = (
      <>
        <div
          ref={setContainerRef}
          data-testid="timeline-scroll-container"
          className={`flex-1 overflow-x-auto overflow-y-auto${cardLayout ? " pb-2" : ""}`}
          onScroll={handleScroll}
        >
          <svg
            ref={svgRef}
            width={totalWidth}
            height={svgHeight}
            className={`block select-none${canDrag ? " cursor-default" : ""}`}
            aria-label={t("timeline.viewport", "タイムライン ビューポート")}
          >
            {/* Axis tick labels */}
            {computeAxisLabels(
              scenes.slice(0, scheduledCount),
              axisMode,
              zoom,
            ).map(({ index, label }) => (
              <text
                key={index}
                data-testid="axis-label"
                x={xOf(index)}
                y={LABEL_Y}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
                fillOpacity={0.45}
                className="pointer-events-none select-none"
              >
                {label}
              </text>
            ))}

            {/* Main axis line */}
            <line
              x1={PAD_LEFT - DOT_R}
              y1={AXIS_Y}
              x2={
                scheduledCount > 0
                  ? xOf(scheduledCount - 1) + DOT_R
                  : totalWidth - PAD_RIGHT
              }
              y2={AXIS_Y}
              stroke="currentColor"
              strokeOpacity={scheduledCount > 0 ? 0.2 : 0.1}
              strokeWidth={1}
              strokeDasharray={scheduledCount === 0 ? "4 4" : undefined}
            />

            {/* 軸が空のときのプレースホルダーヒント */}
            {showUnscheduledZone && scheduledCount === 0 && (
              <text
                x={totalWidth / 2}
                y={AXIS_Y - 12}
                textAnchor="middle"
                fontSize={10}
                fill="currentColor"
                fillOpacity={0.35}
                className="pointer-events-none"
              >
                {t(
                  "timeline.emptyAxisHint",
                  "↑ シーンをここにドラッグして story-time を設定",
                )}
              </text>
            )}

            {/* Unscheduled separator + drop zone (story-time モード中は常に表示) */}
            {showUnscheduledZone && (
              <>
                {/* ドラッグ中はゾーンをハイライト */}
                {drag && (
                  <rect
                    x={PAD_LEFT - DOT_R}
                    y={UNSCHEDULED_Y - 20}
                    width={totalWidth - PAD_LEFT - PAD_RIGHT + DOT_R}
                    height={40}
                    fill="currentColor"
                    fillOpacity={0.05}
                    rx={4}
                    pointerEvents="none"
                  />
                )}
                <line
                  x1={PAD_LEFT - DOT_R}
                  y1={UNSCHEDULED_Y - 16}
                  x2={totalWidth - PAD_RIGHT}
                  y2={UNSCHEDULED_Y - 16}
                  stroke="currentColor"
                  strokeOpacity={drag ? 0.35 : 0.12}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
                <text
                  x={PAD_LEFT - DOT_R}
                  y={UNSCHEDULED_Y - 4}
                  fontSize={9}
                  fill="currentColor"
                  fillOpacity={drag ? 0.7 : 0.4}
                >
                  {scheduledCount === 0
                    ? t(
                        "timeline.unscheduledAllHint",
                        "Unscheduled — 上にドラッグして軸に配置",
                      )
                    : t("timeline.unscheduled", "Unscheduled")}
                </text>
              </>
            )}

            {/* シーン行（常に表示。スレッドはこの上にオーバーレイ） */}
            {scenes.map((scene, i) => {
              const cx = xOf(i);
              const cy = yOf(i);
              const fill =
                STATUS_FILL[scene.status ?? "outline"] ?? STATUS_FILL.outline;
              const isSelected = selectedNodeIds.includes(scene.id);
              const isActive = scene.id === activeSceneId;
              const pins = pinsByNode.get(scene.id) ?? [];
              const isUnscheduled = i >= scheduledCount;

              return (
                <g
                  key={scene.id}
                  data-node-id={scene.id}
                  opacity={isUnscheduled ? 0.55 : 1}
                >
                  {/* Vertical stem */}
                  {(display.showTitles || display.showChapterNumbers) && (
                    <line
                      x1={cx}
                      y1={cy + DOT_R}
                      x2={cx}
                      y2={cy + 20}
                      stroke="currentColor"
                      strokeOpacity={0.15}
                      strokeWidth={1}
                    />
                  )}

                  {/* Drag ghost */}
                  {drag?.nodeId === scene.id &&
                    (() => {
                      const locked =
                        Math.abs(drag.currentY - LANE_Y) < AXIS_LOCK_THRESHOLD;
                      const ghostX = drag.currentX;
                      const ghostY = locked ? LANE_Y : drag.currentY;
                      return (
                        <line
                          x1={cx}
                          y1={cy}
                          x2={ghostX}
                          y2={ghostY}
                          stroke="currentColor"
                          strokeOpacity={0.35}
                          strokeWidth={1}
                          strokeDasharray="3 3"
                          pointerEvents="none"
                        />
                      );
                    })()}

                  {/* Active scene ring (現在地マーカー) */}
                  {isActive && (
                    <circle
                      cx={drag?.nodeId === scene.id ? drag.currentX : cx}
                      cy={
                        drag?.nodeId === scene.id
                          ? Math.abs(drag.currentY - LANE_Y) <
                            AXIS_LOCK_THRESHOLD
                            ? LANE_Y
                            : drag.currentY
                          : cy
                      }
                      r={DOT_R + 3}
                      fill="none"
                      stroke="var(--primary)"
                      strokeWidth={1.5}
                      pointerEvents="none"
                    />
                  )}

                  {/* Scene dot */}
                  <circle
                    cx={drag?.nodeId === scene.id ? drag.currentX : cx}
                    cy={
                      drag?.nodeId === scene.id
                        ? Math.abs(drag.currentY - LANE_Y) < AXIS_LOCK_THRESHOLD
                          ? LANE_Y
                          : drag.currentY
                        : cy
                    }
                    r={DOT_R}
                    fill={fill}
                    stroke={isSelected ? "white" : "transparent"}
                    strokeWidth={2}
                    className={canDrag ? "cursor-grab" : "cursor-pointer"}
                    onClick={(e) => {
                      if (e.shiftKey) {
                        rangeSelectTo(
                          scene.id,
                          scenes.map((sc) => sc.id),
                        );
                      } else if (e.ctrlKey || e.metaKey) {
                        toggleSelect(scene.id);
                      } else {
                        onSelectScene(scene.id);
                      }
                    }}
                    onMouseDown={(e) => handleDotMouseDown(e, scene.id, i)}
                    onContextMenu={(e) => handleDotContextMenu(e, scene)}
                  >
                    <title>{scene.title}</title>
                  </circle>

                  {/* Story-time label (scheduled scenes in story-time mode) */}
                  {display.showChapterNumbers &&
                    !isUnscheduled &&
                    scene.storyTimeLabel && (
                      <text
                        x={cx}
                        y={cy - DOT_R - 4}
                        textAnchor="middle"
                        fontSize={9}
                        fill="currentColor"
                        fillOpacity={0.5}
                        className="pointer-events-none"
                      >
                        {scene.storyTimeLabel}
                      </text>
                    )}

                  {/* Title label */}
                  {display.showTitles && (
                    <text
                      x={cx}
                      y={cy + 28}
                      textAnchor="middle"
                      fontSize={10}
                      fill="currentColor"
                      fillOpacity={0.7}
                      className="pointer-events-none"
                    >
                      {scene.title.length > 8
                        ? scene.title.slice(0, 7) + "…"
                        : scene.title}
                    </text>
                  )}

                  {/* Phase pins */}
                  {display.showPhasePins &&
                    pins.length > 0 &&
                    !isUnscheduled && (
                      <text
                        x={cx}
                        y={PHASE_PIN_Y}
                        textAnchor="middle"
                        fontSize={10}
                        fill="currentColor"
                        fillOpacity={0.55}
                      >
                        {pins.length === 1
                          ? `⏱ ${pins[0].entryName}`
                          : `⏱×${pins.length}`}
                        <title>
                          {pins
                            .map((p) => `${p.entryName}: ${p.label}`)
                            .join("\n")}
                        </title>
                      </text>
                    )}
                </g>
              );
            })}

            {/* シーン列の縦グリッド（threads モード）。マーカーがどのシーンに
                紐づくかを目で追えるよう、各シーンの x に淡い縦線を引く。
                マーカー/レーンより先に描いて背面に置く。x は xOf を共有するので
                マーカー位置と必ず一致する。未配置(story-time)は scheduled 列へ
                折り重なるため scheduled 範囲のみ引く。 */}
            {showThreads &&
              scenes
                .slice(0, scheduledCount)
                .map((_, i) => (
                  <line
                    key={`scene-grid-${i}`}
                    data-testid="scene-gridline"
                    x1={xOf(i)}
                    x2={xOf(i)}
                    y1={LANE_Y - LANE_HEIGHT / 2}
                    y2={svgHeight}
                    stroke="currentColor"
                    strokeOpacity={0.07}
                    strokeWidth={1}
                    pointerEvents="none"
                  />
                ))}

            {/* 収束ハイライト: 2 本以上のスレッドが通るシーン列を淡い縦バンドで強調 */}
            {showThreads &&
              laneModel.convergences.map((x) => (
                <rect
                  key={`conv-${x}`}
                  data-testid="thread-convergence"
                  x={xOf(x) - 5}
                  y={threadsTop - LANE_HEIGHT / 2}
                  width={10}
                  height={Math.max(
                    0,
                    svgHeight - (threadsTop - LANE_HEIGHT / 2),
                  )}
                  fill="currentColor"
                  fillOpacity={0.06}
                  pointerEvents="none"
                />
              ))}

            {/* プロットスレッドのレーン（threads モード） */}
            {showThreads &&
              laneModel.lanes.map((lane) => (
                <g key={lane.thread.id} data-plot-lane={lane.thread.id}>
                  {/* レーン行のヒット領域（ダブルクリックで最寄りシーンにマーカー追加） */}
                  <rect
                    data-testid={`plot-lane-hit-${lane.thread.id}`}
                    x={0}
                    y={lane.y - LANE_HEIGHT / 2}
                    width={totalWidth}
                    height={LANE_HEIGHT}
                    fill="transparent"
                    className="cursor-copy"
                    onDoubleClick={(e) =>
                      handleLaneDoubleClick(e, lane.thread.id)
                    }
                  >
                    <title>
                      {t(
                        "plotThread.laneHint",
                        "ダブルクリックでマーカーを追加",
                      )}
                    </title>
                  </rect>
                  {/* レーン背景線 */}
                  <line
                    x1={xOf(0)}
                    y1={lane.y}
                    x2={
                      scheduledCount > 0
                        ? xOf(scheduledCount - 1)
                        : totalWidth - PAD_RIGHT
                    }
                    y2={lane.y}
                    stroke="currentColor"
                    strokeOpacity={0.15}
                    strokeWidth={1}
                    pointerEvents="none"
                  />
                  {/* スレッドの太いバンド（reading-order のみ）。連続線セグメント単位で
                      描く。merge で終わり branch で始まるよう継ぎ目で切れる。
                      story-time/write では引かない（判断 e）。 */}
                  {axisMode === "reading" &&
                    lane.lineSegments.map((seg, i) => (
                      <line
                        key={`band-${i}`}
                        data-testid={`plot-thread-line-${lane.thread.id}-${i}`}
                        x1={xOf(seg.x1)}
                        x2={xOf(seg.x2)}
                        y1={seg.y1}
                        y2={seg.y2}
                        stroke={lane.thread.color ?? "var(--primary)"}
                        strokeWidth={BAND_HEIGHT}
                        strokeOpacity={0.45}
                        // butt 端（round だと水平 run↔斜めブリッジの継ぎ目ごとに
                        // 半径 BAND_HEIGHT/2 のキャップが重なり太い瘤になる＝束ね時の
                        // スロット変化で多発）。終端は明示ノブ(terminus)で締める。
                        strokeLinecap="butt"
                        pointerEvents="none"
                      />
                    ))}
                  {/* 終端キャップ（完結）。自走で終わるスレッドの線端に塗りノブ。
                      merge で畳まれた終端には付かない（コネクタで表現）。
                      Y はその列のスロット由来（束ね/スロット移動を追従）。 */}
                  {axisMode === "reading" && lane.terminusX !== null && (
                    <circle
                      data-testid={`plot-thread-terminus-${lane.thread.id}`}
                      cx={xOf(lane.terminusX)}
                      cy={laneSlotY(lane, lane.terminusX)}
                      r={BAND_HEIGHT / 2}
                      fill={lane.thread.color ?? "var(--primary)"}
                      pointerEvents="none"
                    />
                  )}
                  {/* レーン見出し（左固定・クリックでスレッド編集）。
                      束ねで lane.y が一致する場合は plotLabelY で押し下げる。 */}
                  <text
                    x={4}
                    y={plotLabelY.get(lane.thread.id) ?? lane.y - 10}
                    fontSize={11}
                    fill="currentColor"
                    fillOpacity={0.8}
                    className="cursor-pointer select-none"
                    data-testid={`plot-lane-label-${lane.thread.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectThread?.(lane.thread.id);
                    }}
                  >
                    {lane.thread.name || t("plotThread.unnamed", "（無名）")}
                  </text>
                  {/* マーカー。拡大時(STEP>=CHIP_MIN_STEP)は段階テキストのチップ、
                      縮小時は円に縮退する。mousedown=ドラッグ開始 / 動かなければ
                      click=選択、右クリック=メニュー。選択中はリング、ドラッグ中は薄く。 */}
                  {lane.markers.map((mk) => {
                    const label = t(
                      `plotThread.phaseType.${mk.phaseType}`,
                      mk.phaseType,
                    );
                    const chipW = Math.max(28, label.length * CHIP_FONT + 12);
                    const cx = xOf(mk.x);
                    const fill = lane.thread.color ?? "var(--primary)";
                    const selected = selectedPlotLinkId === mk.linkId;
                    const dragging =
                      markerDrag?.linkId === mk.linkId && markerDrag.moved;
                    const onDown = (e: React.MouseEvent<SVGElement>) =>
                      handleMarkerMouseDown(
                        e,
                        mk.linkId,
                        lane.thread.id,
                        mk.nodeId,
                        lane.thread.color,
                      );
                    const onCtx = (e: React.MouseEvent<SVGElement>) =>
                      handleMarkerContextMenu(
                        e,
                        mk.linkId,
                        mk.phaseType,
                        mk.nodeId,
                        lane.thread.id,
                      );
                    // 縮小時は円に縮退（段階テキストは title ツールチップで補う）。
                    if (STEP < CHIP_MIN_STEP) {
                      return (
                        <circle
                          key={mk.linkId}
                          data-testid={`plot-marker-${mk.linkId}`}
                          data-phase={mk.phaseType}
                          className="cursor-pointer"
                          opacity={dragging ? 0.3 : 1}
                          cx={cx}
                          cy={mk.y}
                          r={DOT_R}
                          fill={fill}
                          stroke={
                            selected ? "var(--foreground)" : "var(--background)"
                          }
                          strokeWidth={selected ? 2.5 : 1.5}
                          onMouseDown={onDown}
                          onContextMenu={onCtx}
                        >
                          <title>{`${lane.thread.name}: ${label}`}</title>
                        </circle>
                      );
                    }
                    return (
                      <g
                        key={mk.linkId}
                        data-testid={`plot-marker-${mk.linkId}`}
                        data-phase={mk.phaseType}
                        className="cursor-pointer"
                        opacity={dragging ? 0.3 : 1}
                        onMouseDown={onDown}
                        onContextMenu={onCtx}
                      >
                        <rect
                          x={cx - chipW / 2}
                          y={mk.y - BAND_HEIGHT / 2}
                          width={chipW}
                          height={BAND_HEIGHT}
                          rx={BAND_HEIGHT / 2}
                          fill={fill}
                          stroke={
                            selected ? "var(--foreground)" : "var(--background)"
                          }
                          strokeWidth={selected ? 2.5 : 1}
                        />
                        <text
                          x={cx}
                          y={mk.y}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={CHIP_FONT}
                          fill={contrastTextColor(fill)}
                          pointerEvents="none"
                          className="select-none"
                        >
                          {label}
                        </text>
                        <title>{`${lane.thread.name}: ${label}`}</title>
                      </g>
                    );
                  })}
                </g>
              ))}

            {/* マーカードラッグ中のゴースト（カーソル追従） */}
            {markerDrag?.moved && (
              <circle
                data-testid="plot-marker-ghost"
                cx={markerDrag.currentX}
                cy={markerDrag.currentY}
                r={DOT_R}
                fill={markerDrag.color ?? "var(--primary)"}
                fillOpacity={0.7}
                stroke="var(--background, white)"
                strokeWidth={1.5}
                pointerEvents="none"
              />
            )}

            {/* 分岐 / 合流コネクタ（reading-order のみ）。subway 風のランプで
                対象レーンへ斜めに流れ込む形にする（branch=親レーンから枝分かれ /
                merge=畳まれる線が対象レーンへ合流）。branch=実線 / merge=破線。 */}
            {showThreads &&
              axisMode === "reading" &&
              laneModel.connectors.map((c) => {
                const X = xOf(c.x);
                // branch: 親(from)レーンから子(to)レーンへ、分岐シーンの手前から斜めに。
                // merge : 畳まれる(from)線が対象(to)レーンへ、合流シーンの直後へ斜めに。
                const d =
                  c.kind === "branch"
                    ? `M ${X - CONNECTOR_RAMP} ${c.fromY} C ${X - CONNECTOR_RAMP * 0.4} ${c.fromY}, ${X - CONNECTOR_RAMP * 0.6} ${c.toY}, ${X} ${c.toY}`
                    : `M ${X} ${c.fromY} C ${X + CONNECTOR_RAMP * 0.6} ${c.fromY}, ${X + CONNECTOR_RAMP * 0.4} ${c.toY}, ${X + CONNECTOR_RAMP} ${c.toY}`;
                return (
                  <path
                    key={`conn-${c.id}`}
                    data-testid="plot-thread-connector"
                    data-kind={c.kind}
                    d={d}
                    fill="none"
                    stroke={c.color ?? "var(--primary)"}
                    strokeWidth={2}
                    strokeOpacity={0.85}
                    strokeLinecap="round"
                    strokeDasharray={c.kind === "merge" ? "4 3" : undefined}
                    pointerEvents="none"
                  />
                );
              })}
          </svg>
        </div>

        {contextMenu && (
          <TimelineContextMenu
            node={contextMenu.node}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            axisMode={axisMode}
          />
        )}
        {markerMenu && (
          <PlotMarkerContextMenu
            linkId={markerMenu.linkId}
            phaseType={markerMenu.phaseType}
            nodeId={markerMenu.nodeId}
            threadId={markerMenu.threadId}
            x={markerMenu.x}
            y={markerMenu.y}
            onClose={() => setMarkerMenu(null)}
          />
        )}
      </>
    );
    recordMark(
      "timelineViewport.render",
      performance.now() - __perfStart,
      __perfStart,
    );
    return __renderResult;
  },
);
