import {
  useRef,
  useState,
  useReducer,
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
  computeLaneDragTargets,
  LANE_HEIGHT,
  type PlotLaneModel,
} from "@/features/plot-threads/plotThreadLaneModel";
import {
  buildPlotSubwayModel,
  roundedPath,
} from "@/features/plot-threads/subwayModel";
import { resolveMarkerDrop } from "@/features/plot-threads/plotThreadDnd";
import { generateKeyBetween, cmpKeys } from "@/features/tree/fractionalIndex";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { contrastTextColor } from "@/lib/resolveCodexColors";
import type { PlotPhaseType } from "@/db/schema";
import { recordMark } from "@/lib/perfLog";
import {
  DURATIONS,
  CSS_DURATIONS,
  CSS_EASINGS,
  easeOutFn,
  useReducedMotion,
} from "@/lib/animation";

const DOT_R = 6;
/** プロットスレッドの太いバンド（線）の高さ。段階テキストを内側に表示する。 */
const BAND_HEIGHT = 20;
const CHIP_FONT = 10;
/** 1シーンあたりの px（STEP）がこれ未満なら、段階チップを円に縮退させる。 */
const CHIP_MIN_STEP = 72;
/** subway 風ランプコネクタの水平方向の伸び（px）。 */
const CONNECTOR_RAMP = 34;

// ───────── Subway レイアウト（AeonTimeline 風）の定数 ─────────
/** 路線（細い実線）の太さ。 */
const TRACK_WIDTH = 5;
/** 単一トラック駅（小さい塗りつぶし円）の半径。 */
const NODE_R_SINGLE = 5;
/** 複数トラック駅（大きい白抜きドーナツ）の半径とリング太さ。 */
const NODE_R_MULTI = 8;
const NODE_RING = 3;
/** 路線の角丸半径。 */
const SUBWAY_CORNER_R = 10;
/** 左に固定するトラックラベル列の幅（px）。subway 時はここまで content を右へ寄せる。
 *  fit-zoom（Ctrl+0）が subway の左ガターを正しく確保できるよう export する。 */
export const SUBWAY_LABEL_GUTTER = 150;
/** イベント名ラベルをこの STEP 未満では出さない（重なり防止）。 */
const EVENT_LABEL_MIN_STEP = 64;
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
    const plotLayout = useTimelineStore((s) => s.plotLayout);
    const plotSubwaySort = useTimelineStore((s) => s.plotSubwaySort);
    const selectedPlotLinkId = useTimelineStore((s) => s.selectedPlotLinkId);
    const selectedPlotThreadId = useTimelineStore(
      (s) => s.selectedPlotThreadId,
    );
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
    // スレッドヘッダー(separated・手動順)の縦ドラッグ並べ替え。X は固定（Y のみ）。
    const [labelDrag, setLabelDrag] = useState<{
      threadId: string;
      startY: number;
      currentY: number;
      moved: boolean;
    } | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(
      null,
    );
    const [markerMenu, setMarkerMenu] = useState<MarkerMenuState | null>(null);
    // スレッドヘッダー hover で当該スレッド以外を dim する（separated）。
    const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
    // Track when the scroll container element mounts/unmounts so the wheel
    // listener effect re-runs even if scenes load after the first render.
    const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
    const reducedMotion = useReducedMotion();

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
    // laneTop をシーン行の下に下げてオーバーレイする。確定順のホーム Y を持つ基準モデル。
    const homeLaneModel = useMemo(
      () =>
        buildPlotLaneModel({
          threads,
          links,
          sceneX,
          laneTop: threadsTop,
          branches,
          scheduledCount: scheduledCountForLanes,
          subwaySort: plotSubwaySort,
        }),
      [
        threads,
        links,
        sceneX,
        threadsTop,
        branches,
        scheduledCountForLanes,
        plotSubwaySort,
      ],
    );

    // ── レーン Y アニメーション（ドラッグ並べ替え／subway順トグルで滑らかに再配置）──
    // homeLaneModel のホーム Y を「いま表示すべき Y(displayY)」へ差し替えて毎フレーム
    // 再計算する。Y を動かすだけで帯・マーカー・コネクタが homeY 経由で一括追従する。
    // subwaySort 中は並べ替え無効なのでドラッグ・プレビューも出さない（commit と整合）。
    const labelDragActive =
      labelDrag?.moved && !plotSubwaySort ? labelDrag : null;
    // 各スレッドの目標 Y（ホーム or ドラッグ退避）。純関数で算出（テスト可能）。
    const targetY = useMemo(() => {
      const order = homeLaneModel.lanes.map((l) => ({
        id: l.thread.id,
        homeY: l.y,
      }));
      if (labelDragActive) {
        return computeLaneDragTargets({
          order,
          draggedId: labelDragActive.threadId,
          currentY: labelDragActive.currentY,
          laneTop: threadsTop,
          laneHeight: LANE_HEIGHT,
        });
      }
      return new Map(order.map((o) => [o.id, o.homeY]));
    }, [homeLaneModel, labelDragActive, threadsTop]);

    // 現在表示中の Y（rAF が目標へイージングして書き換える mutable ref）。
    const animatedYRef = useRef<Map<string, number>>(new Map());
    // 各スレッドの進行中トゥイーン（固定時間の ease-out）。to が変わったら張り直す。
    const tweenRef = useRef<
      Map<string, { from: number; to: number; start: number }>
    >(new Map());
    const [, forceTick] = useReducer((x: number) => x + 1, 0);
    // ループは常に最新の target / dragged を ref から読む（再起動なしで追従）。
    const targetYRef = useRef(targetY);
    targetYRef.current = targetY;
    const draggedIdRef = useRef<string | null>(null);
    draggedIdRef.current = labelDragActive?.threadId ?? null;

    // 目標が変わったらイージングループを（再）起動。raf id はエフェクト closure ローカルに
    // 持ち、cleanup で必ず cancel する（共有 ref を残さない＝StrictMode の mount/unmount/
    // remount でループが二度と起動しなくなる事故を防ぐ）。
    const targetKey = useMemo(
      () => [...targetY].map(([id, y]) => `${id}:${Math.round(y)}`).join("|"),
      [targetY],
    );
    useEffect(() => {
      const a = animatedYRef.current;
      // 新規スレッドは目標位置で初期化（外から飛んでこない）。消えたスレッドは破棄。
      for (const [id, ty] of targetYRef.current) if (!a.has(id)) a.set(id, ty);
      for (const id of [...a.keys()])
        if (!targetYRef.current.has(id)) a.delete(id);
      if (reducedMotion) {
        for (const [id, ty] of targetYRef.current) a.set(id, ty);
        forceTick();
        return;
      }
      let raf = 0;
      // 固定時間 ease-out トゥイーン（時定数の指数減衰だと末尾が長く「もったり」する。
      // 明確な終端を持つ DURATIONS.fast の ease-out でキビキビ着地させる）。
      const durMs = DURATIONS.fast * 1000;
      const step = (now: number) => {
        const cur = animatedYRef.current;
        const tgt = targetYRef.current;
        const tweens = tweenRef.current;
        const draggedId = draggedIdRef.current;
        let moving = false;
        for (const [id, ty] of tgt) {
          if (id === draggedId) {
            cur.set(id, ty); // ドラッグ点は即時追従（ラグなし）
            tweens.delete(id);
            continue;
          }
          const c = cur.get(id) ?? ty;
          if (Math.abs(ty - c) < 0.5) {
            cur.set(id, ty);
            tweens.delete(id);
            continue;
          }
          // 目標が変わったらその時点の表示位置から張り直す。
          let tw = tweens.get(id);
          if (!tw || tw.to !== ty) {
            tw = { from: c, to: ty, start: now };
            tweens.set(id, tw);
          }
          const p = durMs <= 0 ? 1 : Math.min(1, (now - tw.start) / durMs);
          cur.set(id, tw.from + (tw.to - tw.from) * easeOutFn(p));
          if (p >= 1) tweens.delete(id);
          else moving = true;
        }
        forceTick();
        // ドラッグ中は掴んでいる間ループを維持。退避が落ち着いたら停止。
        raf = moving || draggedId ? requestAnimationFrame(step) : 0;
      };
      raf = requestAnimationFrame(step);
      return () => {
        if (raf) cancelAnimationFrame(raf);
      };
    }, [targetKey, reducedMotion]);

    // 表示モデル: animatedYRef がホームから乖離している（イージング中）か、ドラッグ中なら
    // ホーム Y を displayY で上書きして再計算する。乖離が無ければ homeLaneModel をそのまま
    // 使う（毎 render の再計算を避ける）。判定は実状態（乖離 / drag）に基づき、rAF id の
    // ような揮発フラグは見ない＝ループが止まっても順序が固まらない。
    let needsOverride = !!labelDragActive;
    if (!needsOverride) {
      for (const l of homeLaneModel.lanes) {
        const a = animatedYRef.current.get(l.thread.id);
        if (a !== undefined && Math.abs(a - l.y) > 0.5) {
          needsOverride = true;
          break;
        }
      }
    }
    let laneModel = homeLaneModel;
    if (needsOverride) {
      // ドラッグ点の表示 Y はレーン帯 [先頭行, 最終行] にクランプする。ドロップ先
      // (targetRow) も同じ範囲にクランプ済みなので、列の外までは追従させない
      // （contentHeight は件数ベースで cursorY に追従しないため、外へ出すと
      //   ドラッグ中レーン/ラベルが SVG 下端で見切れる）。
      const lastRowY =
        threadsTop + Math.max(0, homeLaneModel.lanes.length - 1) * LANE_HEIGHT;
      const laneYByThread = new Map<string, number>();
      for (const l of homeLaneModel.lanes) {
        const id = l.thread.id;
        const y =
          labelDragActive && id === labelDragActive.threadId
            ? Math.max(threadsTop, Math.min(lastRowY, labelDragActive.currentY)) // ドラッグ点は即時追従（帯内にクランプ）
            : (animatedYRef.current.get(id) ?? l.y);
        laneYByThread.set(id, y);
      }
      laneModel = buildPlotLaneModel({
        threads,
        links,
        sceneX,
        laneTop: threadsTop,
        branches,
        scheduledCount: scheduledCountForLanes,
        subwaySort: plotSubwaySort,
        laneYByThread,
      });
    }
    // マーカードラッグ中のライブ・プレビューは scheduledCount/nearestSceneIndex に依存する
    // ため、それらが初期化される後段（xOf 群の後）で laneModel を差し替える。

    // merge の流入先(to)になっているマーカーの集合。subway と同じ白丸ドーナツで描く。
    // キー = `toThreadId:atNodeId`。
    const mergeTargetKeys = useMemo(() => {
      const set = new Set<string>();
      for (const b of branches) {
        if (b.kind === "merge") set.add(`${b.toThreadId}:${b.atNodeId}`);
      }
      return set;
    }, [branches]);

    // ── hover-dim（ヘッダー hover で当該スレッド以外を淡くする）──
    const DIM_OPACITY = 0.28;
    const dimTransition = `opacity ${CSS_DURATIONS.normal} ${CSS_EASINGS.easeOut}`;
    /** スレッド単位の dim スタイル（hover 中の非対象を淡くしアニメーション）。 */
    const threadDimStyle = (threadId: string): React.CSSProperties => ({
      opacity:
        hoveredThreadId && hoveredThreadId !== threadId ? DIM_OPACITY : 1,
      transition: reducedMotion ? undefined : dimTransition,
    });
    const branchEnds = useMemo(() => {
      const m = new Map<string, { from: string; to: string }>();
      for (const b of branches)
        m.set(b.id, { from: b.fromThreadId, to: b.toThreadId });
      return m;
    }, [branches]);
    const threadColorById = useMemo(() => {
      const m = new Map<string, string | null>();
      for (const th of threads) m.set(th.id, th.color);
      return m;
    }, [threads]);
    // コネクタの dim 判定。hover 中のスレッドが出所(from)＝自分の色の線なら対象。
    // to 側でも色が一致すれば対象。別スレッド由来で色が異なる merge/branch は
    // 当該スレッドの hover では「自分の線ではない」ので対象に含めない（dim する）。
    const connectorDimStyle = (
      connId: string,
      connColor: string | null,
    ): React.CSSProperties => {
      if (!hoveredThreadId)
        return {
          opacity: 1,
          transition: reducedMotion ? undefined : dimTransition,
        };
      const ends = branchEnds.get(connId);
      const hoveredColor = threadColorById.get(hoveredThreadId) ?? null;
      const lit =
        !!ends &&
        (ends.from === hoveredThreadId ||
          (ends.to === hoveredThreadId && connColor === hoveredColor));
      return {
        opacity: lit ? 1 : DIM_OPACITY,
        transition: reducedMotion ? undefined : dimTransition,
      };
    };

    // ── マーカー追加のスケールイン検出（前回 render に無かった linkId だけ animate）──
    const knownLinkIdsRef = useRef<Set<string> | null>(null);
    const newMarkerIds = new Set<string>();
    if (knownLinkIdsRef.current !== null && !reducedMotion) {
      for (const l of links)
        if (!knownLinkIdsRef.current.has(l.id)) newMarkerIds.add(l.id);
    }
    useEffect(() => {
      knownLinkIdsRef.current = new Set(links.map((l) => l.id));
    }, [links]);

    // subway レイアウト（AeonTimeline 風）モデル。showThreads かつ subway のときのみ使う。
    const subwayActive = showThreads && plotLayout === "subway";
    // subway 本体の開始 Y。story-time の未配置ゾーン(UNSCHEDULED_Y)があるときは
    // それと衝突しないよう threadsTop（ゾーン下）に置き、無いときはヘッダー直下へ寄せる。
    const subwayTop = showUnscheduledZone ? threadsTop : LANE_Y + 52;
    const subwayModel = useMemo(
      () =>
        buildPlotSubwayModel({
          threads,
          links,
          sceneX,
          laneTop: subwayTop,
          scheduledCount: scheduledCountForLanes,
        }),
      [threads, links, sceneX, subwayTop, scheduledCountForLanes],
    );
    // スレッド表示中は左にカプセル型ラベル列（subway と同じガター）を確保し、シーン列を
    // その分右へ寄せる（separated でもラベルがマーカーに被らない）。
    const padLeft = showThreads ? SUBWAY_LABEL_GUTTER : PAD_LEFT;
    // nodeId → シーンタイトル（イベント名ラベル用）。
    const sceneTitleById = useMemo(() => {
      const m = new Map<string, string>();
      for (const sc of scenes) m.set(sc.id, sc.title);
      return m;
    }, [scenes]);

    /** その列でのレーンの実 Y（px）。yByColumn は threadsTop 基準の絶対 px。 */
    const laneSlotY = (lane: (typeof laneModel.lanes)[number], x: number) =>
      lane.yByColumn.get(x) ?? lane.y;

    const plotContentHeight = subwayActive
      ? subwayModel.contentHeight
      : laneModel.contentHeight;
    const plotHasLanes = subwayActive
      ? subwayModel.tracks.length > 0
      : laneModel.lanes.length > 0;
    const svgHeight =
      showThreads && plotHasLanes
        ? Math.max(sceneAreaBottom, plotContentHeight + 16)
        : sceneAreaBottom;

    // Compute x positions
    const scheduledCount = unscheduledStartIndex ?? scenes.length;
    const visibleForWidth = Math.max(scheduledCount, 1);
    const totalWidth =
      weights && weights.length > 0
        ? padLeft + visibleForWidth * STEP * 2 + PAD_RIGHT
        : padLeft + scenes.length * STEP + PAD_RIGHT;

    function xOf(i: number): number {
      if (i >= scheduledCount) {
        // Unscheduled: place below in a separate lane at same x step
        return padLeft + (i - scheduledCount) * STEP;
      }
      if (weights && weights.length > i) {
        return padLeft + weights[i] * (visibleForWidth * STEP * 2);
      }
      return padLeft + i * STEP;
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

    // マーカードラッグ中はドロップ先を解決し、その位置へマーカーを動かしたプレビュー
    // モデルへ差し替える（帯・コネクタが追従＝ライブ再計算）。nearestSceneIndex /
    // scheduledCount に依存するためここで適用する。ラベルドラッグ override 中
    // （laneModel !== homeLaneModel）は両者排他なので行わない。
    if (markerDrag?.moved && laneModel === homeLaneModel) {
      laneModel = buildMarkerDragModel(markerDrag) ?? laneModel;
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

    /**
     * マーカードラッグ中の「ライブ・プレビュー」レーンモデルを作る。ドロップ先を
     * resolveMarkerDrop で解決し、ドラッグ中マーカーをその位置へ移したリンク配列＋
     * 追従/新規エッジで buildPlotLaneModel を組み直す（commitMarkerDrop と同じ判定）。
     * 解決不能（none / 列外）なら null（呼び出し側は homeLaneModel にフォールバック）。
     */
    function buildMarkerDragModel(d: MarkerDragState): PlotLaneModel | null {
      const dropCol = nearestSceneIndex(d.currentX);
      const dropNodeId = dropCol >= 0 ? scenes[dropCol]?.id : undefined;
      if (!dropNodeId) return null;
      const action = resolveMarkerDrop({
        dropY: d.currentY,
        sourceThreadId: d.threadId,
        nodeId: dropNodeId,
        columnSlots: homeLaneModel.lanes.map((l) => ({
          threadId: l.thread.id,
          y: l.yByColumn.get(dropCol) ?? l.y,
        })),
      });
      if (action.type === "none") return null;
      const newThread =
        action.type === "branch" ? action.toThreadId : d.threadId;
      const newScene =
        action.type === "move-scene" ? action.nodeId : action.atNodeId;
      const crossThread = newThread !== d.threadId;
      // ドラッグ中マーカーを移動先へ。
      const previewLinks = links.map((l) =>
        l.id === d.linkId ? { ...l, threadId: newThread, nodeId: newScene } : l,
      );
      // 既存アンカー（to===自スレッド && at===開始シーン）は追従。自己参照は落とす。
      const anchored = branches.filter(
        (b) => b.atNodeId === d.nodeId && b.toThreadId === d.threadId,
      );
      let previewBranches = branches;
      if (anchored.length > 0) {
        previewBranches = branches
          .map((e) => {
            if (!(e.atNodeId === d.nodeId && e.toThreadId === d.threadId))
              return e;
            const resTo = crossThread ? newThread : e.toThreadId;
            if (e.fromThreadId === resTo) return null; // 自己参照
            return crossThread
              ? { ...e, toThreadId: newThread, atNodeId: newScene }
              : { ...e, atNodeId: newScene };
          })
          .filter((b): b is (typeof branches)[number] => b !== null);
      } else if (action.type === "branch" && crossThread) {
        // 別スレッドへ → 新規 branch/merge のコネクタをプレビュー表示（重複時は出さない）。
        const isDup = branches.some(
          (b) =>
            b.fromThreadId === action.fromThreadId &&
            b.toThreadId === action.toThreadId &&
            b.atNodeId === action.atNodeId &&
            b.kind === action.kind,
        );
        if (!isDup)
          previewBranches = [
            ...branches,
            {
              id: "__preview_branch__",
              projectId: "",
              fromThreadId: action.fromThreadId,
              toThreadId: action.toThreadId,
              atNodeId: action.atNodeId,
              kind: action.kind,
              createdAt: "",
              updatedAt: "",
            },
          ];
      }
      return buildPlotLaneModel({
        threads,
        links: previewLinks,
        sceneX,
        laneTop: threadsTop,
        branches: previewBranches,
        scheduledCount: scheduledCountForLanes,
        subwaySort: plotSubwaySort,
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
        // ドロップ判定はホーム位置（プレビュー override 後の laneModel ではなく）で行う。
        columnSlots: homeLaneModel.lanes.map((l) => ({
          threadId: l.thread.id,
          y: l.yByColumn.get(dropCol) ?? l.y,
        })),
      });
      if (action.type === "none") return;

      // 1 ドラッグ = 1 Undo。マーカー移動とそれに伴うエッジの追従/生成/削除を
      // ひとつの履歴エントリにまとめる（個別 push だと Ctrl+Z が部分的に戻す）。
      // ストア mutation は内部で push するので、ここでは await して取りこぼさない。
      void useGlobalHistoryStore.getState().runAsTransaction(
        {
          kind: "plot",
          label: t("plotThread.history.moveMarker", "マーカー移動"),
        },
        async () => {
          const store = usePlotThreadStore.getState();
          // mutation は同期的に発火（mock も実呼び出しも即座に呼ぶ＝従来の
          // fire-and-forget と同じ呼び出しタイミング）し、戻り Promise を集めて
          // 最後に待つ。await して初めてトランザクションが閉じ、各 mutation 内の
          // push がこのエントリにまとまる。
          const ops: Array<Promise<void>> = [];

          const newThread =
            action.type === "branch" ? action.toThreadId : d.threadId;
          const newScene =
            action.type === "move-scene" ? action.nodeId : action.atNodeId;
          const crossThread = newThread !== d.threadId;

          // このマーカーが既存 branch/merge のアンカーか。統一モデルでは branch も merge も
          // マーカーは移動先 = to 側に乗るので、アンカー = (to===自スレッド && at===開始シーン)。
          const anchored = store.branches.filter(
            (b) => b.atNodeId === d.nodeId && b.toThreadId === d.threadId,
          );

          if (anchored.length > 0) {
            // 既存エッジを持つマーカー: マーカーと一緒にエッジを追従／別スレッドへ
            // 付け替え（新規エッジは作らない）。
            ops.push(
              store.updateMarker(
                d.linkId,
                crossThread
                  ? { threadId: newThread, nodeId: newScene }
                  : { nodeId: newScene },
              ),
            );
            for (const e of anchored) {
              // マーカーは to 側アンカー。別スレッドへ移したら to を付け替え、同レーンなら
              // at_node のみ追従。自己参照 or 既存エッジと重複になるなら rebind せず削除する
              // （新規/手動経路と同じ dedup 不変条件）。
              const resTo = crossThread ? newThread : e.toThreadId;
              const isSelf = e.fromThreadId === resTo;
              const isDupOther = store.branches.some(
                (b) =>
                  b.id !== e.id &&
                  b.fromThreadId === e.fromThreadId &&
                  b.toThreadId === resTo &&
                  b.atNodeId === newScene &&
                  b.kind === e.kind,
              );
              if (isSelf || isDupOther) {
                ops.push(store.deleteBranch(e.id));
                continue;
              }
              ops.push(
                store.updateBranch(
                  e.id,
                  crossThread
                    ? { toThreadId: newThread, atNodeId: newScene }
                    : { atNodeId: newScene },
                ),
              );
            }
            await Promise.all(ops);
            return;
          }

          // 既存エッジ無し: 従来挙動。
          if (action.type === "move-scene") {
            await store.updateMarker(d.linkId, { nodeId: action.nodeId });
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
          // 統一モデル: branch も merge もマーカーは移動先 = to（ドロップ先レーン）へ移す。
          ops.push(
            store.updateMarker(d.linkId, {
              threadId: action.toThreadId,
              nodeId: action.atNodeId,
            }),
          );
          ops.push(
            store.addBranch({
              projectId: getCurrentProjectId(),
              fromThreadId: action.fromThreadId,
              toThreadId: action.toThreadId,
              atNodeId: action.atNodeId,
              kind: action.kind,
            }),
          );
          await Promise.all(ops);
        },
      );
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

    // スレッドヘッダーの縦ドラッグ並べ替え（手動順=subwaySort OFF のときのみ並べ替え）。
    function handleLabelMouseDown(
      e: React.MouseEvent<SVGElement>,
      threadId: string,
    ) {
      e.stopPropagation();
      const rect = svgRef.current?.getBoundingClientRect();
      const svgY = e.clientY - (rect?.top ?? 0);
      setLabelDrag({ threadId, startY: svgY, currentY: svgY, moved: false });
    }

    function commitLabelDrop(d: {
      threadId: string;
      moved: boolean;
      currentY: number;
    }) {
      // 動いていなければクリック扱い＝スレッド選択。
      if (!d.moved) {
        onSelectThread?.(d.threadId);
        return;
      }
      // subwaySort 中は自動配置なので並べ替えしない（クリック選択のみ）。
      if (plotSubwaySort) return;
      const ordered = [...threads].sort((a, b) => {
        const c = cmpKeys(a.sortOrder, b.sortOrder);
        return c !== 0 ? c : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const n = ordered.length;
      // ドロップ Y → 行 index（home 行 = threadsTop + row*LANE_HEIGHT）。
      const targetRow = Math.max(
        0,
        Math.min(n - 1, Math.round((d.currentY - threadsTop) / LANE_HEIGHT)),
      );
      const cur = ordered.findIndex((t) => t.id === d.threadId);
      if (cur === -1 || targetRow === cur) return; // 移動なし
      // 自分を除いた並びの targetRow 位置へ挿入（= その視覚行へ移動）。
      const without = ordered.filter((t) => t.id !== d.threadId);
      const idx = Math.max(0, Math.min(targetRow, without.length));
      const newKey = generateKeyBetween(
        without[idx - 1] ? without[idx - 1].sortOrder : null,
        without[idx] ? without[idx].sortOrder : null,
      );
      void usePlotThreadStore.getState().reorderThread(d.threadId, newKey);
    }

    useEffect(() => {
      if (!labelDrag) return;
      function onMove(e: MouseEvent) {
        const rect = svgRef.current?.getBoundingClientRect();
        const svgY = e.clientY - (rect?.top ?? 0);
        setLabelDrag((d) => {
          if (!d) return null;
          const moved =
            d.moved || Math.abs(svgY - d.startY) > MARKER_DRAG_THRESHOLD;
          return { ...d, currentY: svgY, moved };
        });
      }
      function onUp() {
        if (labelDrag) commitLabelDrop(labelDrag);
        setLabelDrag(null);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      return () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [labelDrag]);

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

    // 選択中のマーカー / スレッドをビューへスクロールして見せる（キーボードナビや
    // クリック選択で画面外に出ているとき）。横（シーン列）と縦（レーン）両方。
    useEffect(() => {
      if (!showThreads) return;
      const sel = selectedPlotLinkId
        ? `[data-testid="plot-marker-${selectedPlotLinkId}"]`
        : selectedPlotThreadId
          ? `[data-testid="plot-lane-label-${selectedPlotThreadId}"]`
          : null;
      if (!sel) return;
      const el = svgRef.current?.querySelector(sel) as
        | (Element & { scrollIntoView?: (opts?: unknown) => void })
        | null;
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }, [selectedPlotLinkId, selectedPlotThreadId, showThreads]);

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
              x1={padLeft - DOT_R}
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
                    x={padLeft - DOT_R}
                    y={UNSCHEDULED_Y - 20}
                    width={totalWidth - padLeft - PAD_RIGHT + DOT_R}
                    height={40}
                    fill="currentColor"
                    fillOpacity={0.05}
                    rx={4}
                    pointerEvents="none"
                  />
                )}
                <line
                  x1={padLeft - DOT_R}
                  y1={UNSCHEDULED_Y - 16}
                  x2={totalWidth - PAD_RIGHT}
                  y2={UNSCHEDULED_Y - 16}
                  stroke="currentColor"
                  strokeOpacity={drag ? 0.35 : 0.12}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
                <text
                  x={padLeft - DOT_R}
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

                  {/* Title label。subway では駅のイベント名ラベルと重複するので隠す
                      （上段のシーンドットは時間ルーラーとして残す）。 */}
                  {display.showTitles && !subwayActive && (
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

            {/* 収束ハイライト: 2 本以上のスレッドが通るシーン列を淡い縦バンドで強調
                （separated レイアウトのみ。subway は共有駅で表現するため不要） */}
            {showThreads &&
              !subwayActive &&
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

            {/* プロットスレッドのレーン（separated レイアウト） */}
            {showThreads &&
              !subwayActive &&
              laneModel.lanes.map((lane) => (
                <g
                  key={lane.thread.id}
                  data-plot-lane={lane.thread.id}
                  style={threadDimStyle(lane.thread.id)}
                >
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
                  {/* レーン背景線。選択中スレッドはスレッド色で濃く・太く強調する。 */}
                  <line
                    x1={xOf(0)}
                    y1={lane.y}
                    x2={
                      scheduledCount > 0
                        ? xOf(scheduledCount - 1)
                        : totalWidth - PAD_RIGHT
                    }
                    y2={lane.y}
                    stroke={
                      selectedPlotThreadId === lane.thread.id
                        ? (lane.thread.color ?? "var(--primary)")
                        : "currentColor"
                    }
                    strokeOpacity={
                      selectedPlotThreadId === lane.thread.id ? 0.5 : 0.15
                    }
                    strokeWidth={
                      selectedPlotThreadId === lane.thread.id ? 2 : 1
                    }
                    pointerEvents="none"
                    style={{
                      transition: reducedMotion
                        ? undefined
                        : `stroke-opacity ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}, stroke-width ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}`,
                    }}
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
                        // rampOutEnd の区間は右端を CONNECTOR_RAMP だけ手前で止め、
                        // ランプ（コネクタ）の始端へなめらかに渡す（帯がランプに重ならない）。
                        // 低ズームで列幅 < RAMP のとき逆向きに伸びないよう x1 で下限クランプ。
                        x2={
                          seg.rampOutEnd
                            ? Math.max(
                                xOf(seg.x1),
                                xOf(seg.x2) - CONNECTOR_RAMP,
                              )
                            : xOf(seg.x2)
                        }
                        y1={seg.y1}
                        y2={seg.y2}
                        stroke={lane.thread.color ?? "var(--primary)"}
                        // 線は subway の路線と同じ細さ（TRACK_WIDTH）。段階チップは別途
                        // BAND_HEIGHT のピルで線の上に載る。
                        strokeWidth={TRACK_WIDTH}
                        // 不透過（重なりによる濃淡差/混色を避ける）。butt 端で継ぎ目を揃える。
                        strokeLinecap="butt"
                        pointerEvents="none"
                      />
                    ))}
                  {/* 終端キャップ（完結）。自走で終わるスレッドの線端に小さな塗りノブ。
                      merge で畳まれた終端には付かない（コネクタで表現）。 */}
                  {axisMode === "reading" && lane.terminusX !== null && (
                    <circle
                      data-testid={`plot-thread-terminus-${lane.thread.id}`}
                      cx={xOf(lane.terminusX)}
                      cy={laneSlotY(lane, lane.terminusX)}
                      r={NODE_R_SINGLE}
                      fill={lane.thread.color ?? "var(--primary)"}
                      pointerEvents="none"
                    />
                  )}
                  {/* レーン見出しは下の固定ラベル列（subway と同じカプセル型）で描く。 */}
                </g>
              ))}

            {/* 分岐 / 合流コネクタ（reading-order のみ）。統一モデル: branch も merge も
                「from レーンから to レーンへ線が移る」遷移点として同じ形で描く。ランプは
                常にマーカー（at 列 X）の手前 (X-RAMP→X) から流れ込む。from 帯はランプ始端
                (X-RAMP) で止まり、to 帯はマーカー (X) から始まるので、帯↔ランプ↔帯が
                butt 端どうしの縦シームでなめらかに繋がる。線は通常の帯と同じ太さ・色・不透過。 */}
            {showThreads &&
              !subwayActive &&
              axisMode === "reading" &&
              laneModel.connectors.map((c) => {
                const X = xOf(c.x);
                // from レーン(X-RAMP) から to レーン(X=マーカー) へ手前から斜めに流れ込む。
                const d = `M ${X - CONNECTOR_RAMP} ${c.fromY} C ${X - CONNECTOR_RAMP * 0.4} ${c.fromY}, ${X - CONNECTOR_RAMP * 0.6} ${c.toY}, ${X} ${c.toY}`;
                return (
                  <path
                    key={`conn-${c.id}`}
                    data-testid="plot-thread-connector"
                    data-kind={c.kind}
                    d={d}
                    fill="none"
                    stroke={c.color ?? "var(--primary)"}
                    // 線(帯)と同じ subway 路線幅（TRACK_WIDTH）。
                    strokeWidth={TRACK_WIDTH}
                    // 不透過・butt 端: 帯の butt 端と縦シームで揃え、重なり混色を避ける。
                    strokeLinecap="butt"
                    strokeLinejoin="round"
                    pointerEvents="none"
                    style={connectorDimStyle(c.id, c.color)}
                  />
                );
              })}

            {/* スレッドマーカー（separated）。帯・コネクタより後＝最前面に描く
                （線がマーカーへ被らないよう描画順序を最後にする）。ドラッグ / 右クリック /
                選択リングはここで処理する。axisMode に依らず常に描く。 */}
            {showThreads &&
              !subwayActive &&
              laneModel.lanes.map((lane) => (
                <g
                  key={`markers-${lane.thread.id}`}
                  style={threadDimStyle(lane.thread.id)}
                >
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
                    // 選択中はスレッド色の発光で強調（filter で halo）。foreground(黒)は
                    // ライトテーマで重いため、各スレッド固有の色でやわらかく光らせる。
                    // 追加直後のマーカーは plot-marker-in でスケールイン。
                    const markerClass = newMarkerIds.has(mk.linkId)
                      ? "cursor-pointer plot-marker-in"
                      : "cursor-pointer";
                    const markerStyle: React.CSSProperties = {
                      filter: selected
                        ? `drop-shadow(0 0 5px ${fill})`
                        : "none",
                      transition: reducedMotion
                        ? undefined
                        : `filter ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}`,
                    };
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
                    // merge の流入先マーカーは subway と同じ白丸ドーナツ（白塗り＋色リング）
                    // で描く（ズームに依らず・チップにしない）。
                    if (mergeTargetKeys.has(`${lane.thread.id}:${mk.nodeId}`)) {
                      return (
                        <circle
                          key={mk.linkId}
                          data-testid={`plot-marker-${mk.linkId}`}
                          data-phase={mk.phaseType}
                          data-merge-target="true"
                          className={markerClass}
                          style={markerStyle}
                          opacity={dragging ? 0.3 : 1}
                          cx={cx}
                          cy={mk.y}
                          r={NODE_R_MULTI}
                          fill="var(--background, white)"
                          stroke={selected ? "var(--foreground)" : fill}
                          strokeWidth={selected ? 2.5 : NODE_RING}
                          onMouseDown={onDown}
                          onContextMenu={onCtx}
                        >
                          <title>{`${lane.thread.name}: ${label}`}</title>
                        </circle>
                      );
                    }
                    // 縮小時は円に縮退（段階テキストは title ツールチップで補う）。
                    if (STEP < CHIP_MIN_STEP) {
                      return (
                        <circle
                          key={mk.linkId}
                          data-testid={`plot-marker-${mk.linkId}`}
                          data-phase={mk.phaseType}
                          className={markerClass}
                          style={markerStyle}
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
                        className={markerClass}
                        style={markerStyle}
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

            {/* マーカードラッグ中のゴースト（カーソル追従・最前面） */}
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

            {/* スレッドヘッダー（separated・左固定のカプセル型ラベル列。subway と同じ見た目）。
                横スクロールしても残るよう scrollOffset ぶん平行移動。 */}
            {showThreads && !subwayActive && (
              <g
                transform={`translate(${scrollOffset},0)`}
                data-testid="separated-labels"
              >
                <rect
                  x={0}
                  y={threadsTop - LANE_HEIGHT / 2}
                  width={SUBWAY_LABEL_GUTTER - 12}
                  height={Math.max(
                    0,
                    svgHeight - (threadsTop - LANE_HEIGHT / 2),
                  )}
                  fill="var(--background)"
                  pointerEvents="none"
                />
                {(() => {
                  // lane.y は既にアニメーション後の displayY（override モデル）。
                  // ドラッグ中のスレッドだけ最後に描画＝最前面に重ねる。
                  const lanes = laneModel.lanes;
                  const draggedId = labelDragActive?.threadId ?? null;
                  const renderOrder = draggedId
                    ? [...lanes].sort(
                        (a, b) =>
                          Number(a.thread.id === draggedId) -
                          Number(b.thread.id === draggedId),
                      )
                    : lanes;
                  return renderOrder.map((lane) => {
                    const name =
                      lane.thread.name || t("plotThread.unnamed", "（無名）");
                    const color = lane.thread.color ?? "var(--primary)";
                    const isDragged = lane.thread.id === draggedId;
                    const cyL = lane.y;
                    const display =
                      name.length > 12 ? name.slice(0, 11) + "…" : name;
                    const selected = selectedPlotThreadId === lane.thread.id;
                    return (
                      <g
                        key={`label-${lane.thread.id}`}
                        className="cursor-pointer"
                        data-testid={`plot-lane-label-${lane.thread.id}`}
                        style={{
                          opacity: isDragged
                            ? 0.7
                            : hoveredThreadId &&
                                hoveredThreadId !== lane.thread.id
                              ? DIM_OPACITY
                              : 1,
                          transition: reducedMotion ? undefined : dimTransition,
                        }}
                        onMouseDown={(e) =>
                          handleLabelMouseDown(e, lane.thread.id)
                        }
                        onMouseEnter={() => setHoveredThreadId(lane.thread.id)}
                        onMouseLeave={() => setHoveredThreadId(null)}
                      >
                        <rect
                          x={6}
                          y={cyL - 13}
                          width={SUBWAY_LABEL_GUTTER - 24}
                          height={26}
                          rx={13}
                          fill="var(--card, var(--background))"
                          // 選択中はスレッド色の枠＋発光で強調（foreground 黒は重いため）。
                          stroke={selected ? color : "currentColor"}
                          strokeOpacity={selected ? 0.9 : 0.15}
                          strokeWidth={selected ? 2 : 1}
                          style={{
                            filter: selected
                              ? `drop-shadow(0 0 4px ${color})`
                              : "none",
                            transition: reducedMotion
                              ? undefined
                              : `filter ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}`,
                          }}
                        />
                        <circle cx={22} cy={cyL} r={7} fill={color} />
                        <text
                          x={36}
                          y={cyL}
                          dominantBaseline="central"
                          fontSize={11}
                          fill="currentColor"
                          fillOpacity={0.85}
                          className="select-none"
                        >
                          {display}
                        </text>
                      </g>
                    );
                  });
                })()}
              </g>
            )}

            {/* ───────── Subway レイアウト本体（AeonTimeline 風） ───────── */}
            {subwayActive && (
              <g data-testid="plot-subway">
                {/* 各トラックのホーム行の淡い背景線＋行ヒット領域（ダブルクリックで追加） */}
                {subwayModel.tracks.map((track) => (
                  <g key={`row-${track.threadId}`}>
                    <line
                      x1={xOf(0)}
                      x2={
                        scheduledCount > 0
                          ? xOf(scheduledCount - 1)
                          : totalWidth - PAD_RIGHT
                      }
                      y1={track.homeY}
                      y2={track.homeY}
                      stroke={track.color ?? "currentColor"}
                      strokeOpacity={0.12}
                      strokeWidth={1}
                      pointerEvents="none"
                    />
                    <rect
                      data-testid={`plot-lane-hit-${track.threadId}`}
                      x={padLeft - DOT_R}
                      y={track.homeY - LANE_HEIGHT / 2}
                      width={totalWidth}
                      height={LANE_HEIGHT}
                      fill="transparent"
                      className="cursor-copy"
                      onDoubleClick={(e) =>
                        handleLaneDoubleClick(e, track.threadId)
                      }
                    >
                      <title>
                        {t(
                          "plotThread.laneHint",
                          "ダブルクリックでマーカーを追加",
                        )}
                      </title>
                    </rect>
                  </g>
                ))}

                {/* 路線（細い実線・角丸）。点列を px 化し、進入/退出アンカーにだけ px スタブを
                    付与して斜入させる。スタブ幅は隣接列の実 px 間隔にクランプ（proportional/
                    write 軸で列が詰まっても前後列へはみ出さない）。anchor 判定はモデル契約由来で、
                    「ホーム行に乗った実駅」を誤って寄せない（駅と線の分離防止）。 */}
                {subwayModel.tracks.map((track) => {
                  if (track.points.length < 2) return null;
                  const baseStub = STEP * 0.42;
                  const pxPts = track.points.map((p) => {
                    let X = xOf(p.x);
                    if (p.anchor) {
                      // 進入(先頭)は左、退出(末尾)は右へ。隣接列との実距離の 0.45 にクランプ。
                      const isEntry = p === track.points[0];
                      if (isEntry) {
                        const gap = p.x > 0 ? xOf(p.x) - xOf(p.x - 1) : STEP;
                        X -= Math.min(baseStub, gap * 0.45);
                      } else {
                        const gap =
                          p.x + 1 < scheduledCount
                            ? xOf(p.x + 1) - xOf(p.x)
                            : STEP;
                        X += Math.min(baseStub, gap * 0.45);
                      }
                    }
                    return { x: X, y: p.y };
                  });
                  return (
                    <path
                      key={track.threadId}
                      data-testid={`subway-track-${track.threadId}`}
                      d={roundedPath(pxPts, SUBWAY_CORNER_R)}
                      fill="none"
                      stroke={track.color ?? "var(--primary)"}
                      strokeWidth={TRACK_WIDTH}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      pointerEvents="none"
                    />
                  );
                })}

                {/* イベント名ラベル（駅の上）。STEP が狭いと省く。無題はスケルトン帯。 */}
                {STEP >= EVENT_LABEL_MIN_STEP &&
                  subwayModel.nodes.map((node) => {
                    const cx = xOf(node.x);
                    const title = sceneTitleById.get(node.nodeId) ?? "";
                    const ly =
                      node.y - (node.multi ? NODE_R_MULTI : NODE_R_SINGLE) - 8;
                    if (!title) {
                      return (
                        <rect
                          key={`evlbl-${node.nodeId}`}
                          x={cx - 22}
                          y={ly - 7}
                          width={44}
                          height={7}
                          rx={3.5}
                          fill="currentColor"
                          fillOpacity={0.12}
                          pointerEvents="none"
                        />
                      );
                    }
                    const text =
                      title.length > 22 ? title.slice(0, 21) + "…" : title;
                    // 左寄せ（駅から右へ伸ばす）。中央寄せだと左端の駅でラベル列に
                    // 食い込み見切れるため。参照(AeonTimeline)も駅から右へ伸ばす。
                    return (
                      <text
                        key={`evlbl-${node.nodeId}`}
                        data-testid={`subway-event-label-${node.nodeId}`}
                        x={cx - NODE_R_MULTI}
                        y={ly}
                        textAnchor="start"
                        fontSize={10}
                        fill="currentColor"
                        fillOpacity={0.78}
                        pointerEvents="none"
                        className="select-none"
                      >
                        {text}
                      </text>
                    );
                  })}

                {/* 駅（ノード）。単一トラック=小さい塗り / 複数=大きい白抜きドーナツ。
                    クリック=そのイベント(シーン)を選択。 */}
                {subwayModel.nodes.map((node) => {
                  const cx = xOf(node.x);
                  const color = node.color ?? "var(--primary)";
                  // 選択リングは現在地シーン（activeSceneId）で点灯。クリックで
                  // そのシーンへナビゲートし、単一トラック駅はマーカーも選択して
                  // インスペクタで段階編集できるようにする（複数駅は曖昧なのでシーン選択のみ）。
                  const selected = node.nodeId === activeSceneId;
                  const r = node.multi ? NODE_R_MULTI : NODE_R_SINGLE;
                  const title = sceneTitleById.get(node.nodeId) ?? "";
                  return (
                    <circle
                      key={node.nodeId}
                      data-testid={`subway-node-${node.nodeId}`}
                      data-multi={node.multi}
                      cx={cx}
                      cy={node.y}
                      r={r}
                      fill={node.multi ? "var(--background, white)" : color}
                      stroke={selected ? "var(--foreground)" : color}
                      strokeWidth={
                        node.multi ? NODE_RING : selected ? 2.5 : 1.5
                      }
                      className="cursor-pointer"
                      onClick={() => {
                        onSelectScene(node.nodeId);
                        if (!node.multi && node.markers[0])
                          onSelectMarker?.(node.markers[0].linkId);
                      }}
                    >
                      <title>
                        {title || t("plotThread.eventUntitled", "（無題）")}
                      </title>
                    </circle>
                  );
                })}

                {/* 左に固定するトラックラベル列（横スクロールしても残る）。
                    scrollOffset ぶん平行移動し、背景で路線の左端をマスクする。 */}
                <g
                  transform={`translate(${scrollOffset},0)`}
                  data-testid="subway-labels"
                >
                  <rect
                    x={0}
                    y={subwayTop - LANE_HEIGHT / 2}
                    width={SUBWAY_LABEL_GUTTER - 12}
                    height={Math.max(
                      0,
                      svgHeight - (subwayTop - LANE_HEIGHT / 2),
                    )}
                    fill="var(--background)"
                    pointerEvents="none"
                  />
                  {subwayModel.tracks.map((track) => {
                    const name =
                      track.thread.name || t("plotThread.unnamed", "（無名）");
                    const color = track.color ?? "var(--primary)";
                    const cyL = track.homeY;
                    const display =
                      name.length > 12 ? name.slice(0, 11) + "…" : name;
                    return (
                      <g
                        key={`label-${track.threadId}`}
                        className="cursor-pointer"
                        data-testid={`plot-lane-label-${track.threadId}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectThread?.(track.threadId);
                        }}
                      >
                        <rect
                          x={6}
                          y={cyL - 13}
                          width={SUBWAY_LABEL_GUTTER - 24}
                          height={26}
                          rx={13}
                          fill="var(--card, var(--background))"
                          stroke="currentColor"
                          strokeOpacity={0.15}
                          strokeWidth={1}
                        />
                        <circle cx={22} cy={cyL} r={7} fill={color} />
                        <text
                          x={36}
                          y={cyL}
                          dominantBaseline="central"
                          fontSize={11}
                          fill="currentColor"
                          fillOpacity={0.85}
                          className="select-none"
                        >
                          {display}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </g>
            )}
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
