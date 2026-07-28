import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  dayToX,
  panByPx,
  viewStartFromThumb,
  xToDay,
  zoomAt,
  type View,
} from "./chronicleAxis";
import {
  realEventId,
  laneTargetKey,
  laneKeyOf,
  type ChronicleLayout,
} from "./chronicleLayout";
import { buildCausalBezier } from "./chronicleCausalBezier";
import { laneAtY } from "./chronicleLanePack";
import { useLaneReorderTween } from "./chronicleLaneAnim";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { announce } from "@/lib/a11y/announcer";
import { measurePerfSync, recordAnimationFrameInterval } from "@/lib/perfLog";
import { snapDayToTicks } from "./chronicleSnap";
import { ChronicleRuler } from "./ChronicleRuler";
import { ChronicleLaneGutter } from "./ChronicleLaneGutter";
import { EventMarker, type MarkerEvent } from "./EventMarker";
import {
  buildChronicleHorizontalRenderWindow,
  buildChronicleVerticalRenderWindow,
  chronicleEdgeIntersectsHorizontalRenderWindow,
  chronicleEdgeIntersectsRenderWindow,
  chronicleMarkerIntersectsHorizontalRenderWindow,
  chronicleMarkerIntersectsRenderWindow,
} from "./chronicleRenderWindow";
import {
  connectedCausalChain,
  directCauses,
  directEffects,
} from "./causalTraversal";

const SNAP_PX = 12;
const DRAG_THRESHOLD = 3;
// Y のデッドゾーン: これ未満の縦移動はレーン変更せず横スライドのみ（Grid のシーン同様）。
const LANE_DEADZONE = 28;
// キーボード代替のパン/スクロール量（wheel/中ボタンパンの WCAG 2.1.1 等価操作）。
const KBD_PAN_PX = 80;
const KBD_VSCROLL_PX = 60;
const KBD_PAGE_RATIO = 0.9;
/** Trackpad/wheel bursts commit one view update after the interaction settles. */
const WHEEL_VIEW_COMMIT_MS = 80;
/**
 * Small chronicles keep their insertion/removal fades. Larger chronicles use
 * 2D projection windows and plain wrappers so offscreen data and Motion
 * bookkeeping cannot enter pointer-frame work.
 */
const CHRONICLE_WINDOWING_THRESHOLD = 250;

function ChronicleMarkerPresence({
  windowed,
  children,
}: {
  windowed: boolean;
  children: ReactNode;
}) {
  // A scroll-window change is projection, not deletion. Keeping it outside
  // AnimatePresence prevents hundreds of exit nodes from surviving a jump.
  return windowed ? (
    <>{children}</>
  ) : (
    <AnimatePresence initial={false}>{children}</AnimatePresence>
  );
}

function ChronicleMarkerWrapper({
  windowed,
  reducedMotion,
  style,
  children,
}: {
  windowed: boolean;
  reducedMotion: boolean;
  style: CSSProperties;
  children: ReactNode;
}) {
  // Projection-window changes are frequent during vertical pan. A plain div
  // avoids running Framer Motion bookkeeping for every unchanged visible
  // marker; real insertion/deletion retains the existing fade in the
  // unwindowed fallback.
  if (windowed) {
    return (
      <div data-chronicle-windowed-marker-wrapper style={style}>
        {children}
      </div>
    );
  }
  return (
    <motion.div
      style={style}
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{
        opacity: 0,
        transition: reducedMotion
          ? { duration: 0 }
          : { duration: DURATIONS.fast, ease: EASINGS.easeOut },
      }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              duration: DURATIONS.normal,
              ease: EASINGS.easeOut,
            }
      }
    >
      {children}
    </motion.div>
  );
}

export interface ChronicleViewportProps {
  /** Keepalive-hidden panels remain mounted, so interaction work must stop. */
  isActive?: boolean;
  view: View;
  onViewChange: (v: View) => void;
  onMeasureTrack: (w: number) => void;
  /** フィット時の同期幅読み用にトラック実要素を親へ公開する ref。 */
  trackElRef?: React.MutableRefObject<HTMLDivElement | null>;
  layout: ChronicleLayout;
  eventsById: Map<string, MarkerEvent>;
  /** プライマリ選択（アンカー＝因果エッジ作成ハンドルを出す対象）。 */
  selectedEventId: string | null;
  /** 複数選択集合（リング強調の対象。未指定時は selectedEventId のみ）。 */
  selectedIds?: Set<string>;
  activeLaneKey: string | null;
  conflictIds: Set<string>;
  /** Timeline で選択中のシーンに紐づく出来事（淡いリング強調）。 */
  relatedIds: Set<string>;
  showEdges: boolean;
  labelsOn: boolean;
  /** 出来事選択。mods.toggle=Ctrl/⌘ トグル, mods.range=Shift 範囲。 */
  onSelectEvent: (
    id: string,
    mods?: { toggle: boolean; range: boolean },
  ) => void;
  /** レーンガター用（任意 Codex 候補・割当/追加・ロック）。 */
  laneOptions?: { id: string; name: string; type: string }[];
  locked?: boolean;
  /** 未割当レーンを群ごと Codex へ割当（groupId=null は基底未割当）。 */
  onAssignGroup?: (groupId: string | null, codexId: string) => void;
  onAddLane?: () => void;
  /** 空の未割当（追加）レーンを隠す（× で）。 */
  onHideGroup?: (groupId: string) => void;
  /** codex レーンの並べ替え（commit=false=ドラッグ中の表示更新 / true=確定＝永続）。 */
  onReorderLanes?: (newOrder: string[], commit: boolean) => void;
  // ── グラフ操作（任意・ロック時は呼ばれない） ──
  /** 選択中の位置（縦ガイド表示。空白クリックで設定）。 */
  selectedDay?: number | null;
  /**
   * 暦軸モードか。false の並び順モードでもマーカーの横 drop は実日付への
   * 変換に使うが、空白位置の日付作成・期間伸縮・一括時間移動は抑止する。
   */
  hasCalendarAxis?: boolean;
  /** マーカー再配置（newStartDay=null は時間変更なし。newCodexId でレーン再割当）。 */
  onMoveEvent?: (
    id: string,
    newStartDay: number | null,
    newCodexId: string | null,
  ) => void;
  /** 期間端の伸縮（edge=start/end の日を更新）。 */
  onResizeEvent?: (id: string, edge: "start" | "end", newDay: number) => void;
  /** D&D 因果エッジ作成（cause→effect）。 */
  onCreateEdge?: (causeId: string, effectId: string) => void;
  /** 空白の位置に新規作成（day=null は時間なし）。 */
  onCreateAt?: (day: number | null, codexId: string | null) => void;
  /** 位置選択（縦ガイド）。 */
  onSelectPosition?: (day: number | null, codexId: string | null) => void;
  /** 出来事削除（コンテキストメニュー）。 */
  onDeleteEvent?: (id: string) => void;
  /** コンテキストメニュー「編集」: 単独選択＋詳細パネルを開く（未指定時は単独選択のみ）。 */
  onEditEvent?: (id: string) => void;
  /** コンテキストメニュー「該当シーンを開く」。 */
  onOpenScene?: (eventId: string) => void;
  /** 「該当シーンを開く」を出せるイベント id 集合（scene-event＋リンク済み実イベント）。 */
  openableSceneEventIds?: Set<string>;
  /** 複数選択の一括移動（primaryId の吸着先 newStartDay 差分を全選択へ。レーンは保持）。 */
  onMoveSelected?: (primaryId: string, newStartDay: number) => void;
  /** 選択中をまとめて時間方向に nudge（キーボード ←/→）。日数の符号付き差分。 */
  onNudgeSelected?: (deltaDays: number) => void;
  /**
   * プライマリ選択の期間端をキーボードで伸縮（Shift+←/→=終了端, Ctrl+Shift+←/→=開始端）。
   * ドラッグの期間端グリップ（onResizeEvent）のキーボード代替。日数の符号付き差分。
   */
  onResizeSelectedBy?: (edge: "start" | "end", deltaDays: number) => void;
  /** 選択中をまとめて削除（キーボード Delete/Backspace）。 */
  onDeleteSelected?: () => void;
  /** 選択解除（キーボード Escape）。 */
  onClearSelection?: () => void;
  /** 因果ホバー強調用の関係一覧（cause→effect）。 */
  relations?: { causeId: string; effectId: string }[];
  /** コンテキスト「原因を選択」（1 世代上・複数可）。 */
  onSelectCauses?: (eventId: string) => void;
  /** コンテキスト「結果を選択」（1 世代下・複数可）。 */
  onSelectEffects?: (eventId: string) => void;
  /**
   * ドラッグ/期間端伸縮中に表示する日時バブルの文言を、現在のルーラー解像度に
   * 応じた精度で返す（暦軸なし＝空文字で非表示）。panel が calendar/level から生成する。
   */
  formatDayLabel?: (day: number) => string;
}

/**
 * 作中年表ビューポート（DOM ベースの pan/zoom 水平タイムライン）。
 * ルーラー＋（左ガター＋トラック）＋スクロールバーを積む。トラックの
 * ホイール=ズーム / ドラッグ=パン / ResizeObserver=幅計測 を司り、座標は
 * 親が buildChronicleLayout（純関数）で算出した layout から描く。
 */
export function ChronicleViewport({
  isActive = true,
  view,
  onViewChange,
  onMeasureTrack,
  trackElRef: externalTrackElRef,
  layout,
  eventsById,
  selectedEventId,
  selectedIds,
  activeLaneKey,
  conflictIds,
  relatedIds,
  showEdges,
  labelsOn,
  onSelectEvent,
  laneOptions,
  locked,
  onAssignGroup,
  onAddLane,
  onHideGroup,
  onReorderLanes,
  selectedDay,
  hasCalendarAxis = true,
  onMoveEvent,
  onResizeEvent,
  onCreateEdge,
  onCreateAt,
  onSelectPosition,
  onDeleteEvent,
  onEditEvent,
  onOpenScene,
  openableSceneEventIds,
  onMoveSelected,
  onNudgeSelected,
  onResizeSelectedBy,
  onDeleteSelected,
  onClearSelection,
  relations,
  onSelectCauses,
  onSelectEffects,
  formatDayLabel,
}: ChronicleViewportProps) {
  const { t } = useTranslation();
  const trackElRef = useRef<HTMLDivElement | null>(null);
  const rulerContentRef = useRef<HTMLDivElement | null>(null);
  const projectionLayerRef = useRef<HTMLDivElement | null>(null);
  const edgeWorldLayerRef = useRef<SVGSVGElement | null>(null);
  const markerWorldLayerRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const viewPreviewFrameRef = useRef<number | null>(null);
  const viewPreviewDirtyRef = useRef(false);
  const continuousPreviewRef = useRef(false);
  const pendingPreviewViewRef = useRef<View | null>(null);
  const previewActiveRef = useRef(false);
  const wheelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // 縦スクロール領域（中ボタンドラッグの縦パン用に scrollTop を直接いじる）。
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const [verticalViewport, setVerticalViewport] = useState(() => {
    // Do not materialize every marker for the first commit merely because the
    // panel ref has not been measured yet. useLayoutEffect replaces this
    // conservative first-row window with the exact scroll-area height
    // before paint.
    const screenHeight =
      typeof window === "undefined"
        ? 1
        : Math.min(
            Math.max(
              document.documentElement?.clientHeight || window.innerHeight || 1,
              1,
            ),
            64,
          );
    return { scrollTop: 0, height: screenHeight };
  });
  useLayoutEffect(() => {
    const element = scrollAreaRef.current;
    if (!element) return;

    const measure = () => {
      const height = element.clientHeight;
      // A hidden keepalive panel reports zero. Preserve the bounded initial
      // window until the panel has real geometry instead of falling back to
      // the legacy "render everything" null window.
      if (!Number.isFinite(height) || height <= 0) return;
      // Half-viewport buckets keep a full viewport of overscan while avoiding
      // a React marker rebuild for every pixel of native vertical scrolling.
      const quantum = Math.max(height / 2, 1);
      const scrollTop = Math.floor(element.scrollTop / quantum) * quantum;
      setVerticalViewport((current) =>
        current.height === height && current.scrollTop === scrollTop
          ? current
          : { height, scrollTop },
      );
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [isActive, layout.contentHeight]);
  // 因果ホバー強調: ホバー中の出来事に連なるチェーン以外を dim する。
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  // キーボード（矢印ナビ）で選択した出来事。ホバーと同じ因果チェーン強調を
  // キーボード操作でも発動させる（マウスクリック選択では発動しない＝従来挙動維持）。
  // selectedEventId と一致する間だけ有効＝一覧クリック等の別経路選択で自然に失効する。
  const [kbdSelectedId, setKbdSelectedId] = useState<string | null>(null);
  const chainSourceId =
    hoveredEventId ??
    (kbdSelectedId != null && kbdSelectedId === selectedEventId
      ? kbdSelectedId
      : null);
  const causalChain = useMemo(() => {
    if (!chainSourceId || !relations || relations.length === 0) return null;
    const chain = connectedCausalChain(chainSourceId, relations);
    // 因果が無い（自分だけ）ときは dim しない。
    return chain.size > 1 ? chain : null;
  }, [chainSourceId, relations]);
  // ネイティブ wheel / pointer ハンドラから最新値を読むための ref。
  const viewRef = useRef(view);
  const renderedViewRef = useRef(view);
  renderedViewRef.current = view;
  // An unrelated render during an active native preview must not discard the
  // accumulated wheel/thumb position. The committed prop resumes authority once
  // the interaction ends.
  if (!previewActiveRef.current) viewRef.current = view;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const draggedRef = useRef(false);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const onMeasureRef = useRef(onMeasureTrack);
  onMeasureRef.current = onMeasureTrack;
  const cleanupRef = useRef<(() => void) | null>(null);
  // 進行中のドラッグの document リスナ撤去関数（アンマウント時の取りこぼし防止）。
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const cancelViewPreviewFrame = useCallback(() => {
    if (viewPreviewFrameRef.current !== null) {
      cancelAnimationFrame(viewPreviewFrameRef.current);
      viewPreviewFrameRef.current = null;
    }
    viewPreviewDirtyRef.current = false;
  }, []);
  const applyViewPreviewPresentation = useCallback(() => {
    const base = renderedViewRef.current;
    const next = pendingPreviewViewRef.current ?? base;
    const scale = next.pxPerDay / Math.max(base.pxPerDay, 1e-9);
    const shift = (base.viewStartDay - next.viewStartDay) * next.pxPerDay;
    const baseWorldOffset = layoutRef.current.worldOffsetX;
    const worldOffset = baseWorldOffset * scale + shift;
    const scaled = Math.abs(scale - 1) > 1e-9;
    const worldTransform = scaled
      ? `translateX(${worldOffset}px) scaleX(${scale})`
      : `translateX(${worldOffset}px)`;
    if (edgeWorldLayerRef.current) {
      edgeWorldLayerRef.current.style.transform = worldTransform;
    }
    if (markerWorldLayerRef.current) {
      markerWorldLayerRef.current.style.transform = worldTransform;
    }
    const viewportTransform =
      Math.abs(shift) > 1e-9 || scaled
        ? `translateX(${shift}px)${scaled ? ` scaleX(${scale})` : ""}`
        : "";
    if (projectionLayerRef.current) {
      projectionLayerRef.current.style.transform = viewportTransform;
    }
    if (rulerContentRef.current) {
      rulerContentRef.current.style.transform = viewportTransform;
    }
  }, []);
  const flushViewPreview = useCallback(() => {
    cancelViewPreviewFrame();
    measurePerfSync(
      "chronicle.viewportFrame.work",
      applyViewPreviewPresentation,
    );
  }, [applyViewPreviewPresentation, cancelViewPreviewFrame]);
  const scheduleViewPreviewFrame = useCallback(() => {
    if (viewPreviewFrameRef.current !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      if (viewPreviewDirtyRef.current) flushViewPreview();
      return;
    }
    viewPreviewFrameRef.current = requestAnimationFrame((frameTimestamp) => {
      viewPreviewFrameRef.current = null;
      recordAnimationFrameInterval(
        "chronicle.viewportFrame.interval",
        frameTimestamp,
      );
      if (viewPreviewDirtyRef.current) flushViewPreview();
      // Pointer events may arrive more slowly than display refresh (remote input,
      // coalescing, loaded renderer). Keep the gesture clock on consecutive
      // presented frames rather than treating input-delivery gaps as missed paint.
      if (continuousPreviewRef.current) scheduleViewPreviewFrame();
    });
  }, [flushViewPreview]);
  const startContinuousPreview = useCallback(() => {
    continuousPreviewRef.current = true;
    scheduleViewPreviewFrame();
  }, [scheduleViewPreviewFrame]);
  const stopContinuousPreview = useCallback(() => {
    continuousPreviewRef.current = false;
  }, []);
  const previewView = useCallback(
    (next: View) => {
      previewActiveRef.current = true;
      viewRef.current = next;
      pendingPreviewViewRef.current = next;
      viewPreviewDirtyRef.current = true;
      scheduleViewPreviewFrame();
    },
    [scheduleViewPreviewFrame],
  );
  const resetViewPreview = useCallback(() => {
    previewActiveRef.current = false;
    pendingPreviewViewRef.current = renderedViewRef.current;
    viewRef.current = renderedViewRef.current;
    flushViewPreview();
  }, [flushViewPreview]);
  const commitPreviewView = useCallback(() => {
    const next = pendingPreviewViewRef.current;
    if (!next) return;
    flushViewPreview();
    // Keep the preview authoritative until the parent renders the committed prop.
    // This prevents an unrelated hover/selection render from snapping a deferred
    // store update back to the old View in the interim.
    onViewChangeRef.current(next);
  }, [flushViewPreview]);
  const settleWheelPreview = useCallback(() => {
    if (wheelCommitTimerRef.current === null) return false;
    clearTimeout(wheelCommitTimerRef.current);
    wheelCommitTimerRef.current = null;
    // A pointer/keyboard gesture is an explicit boundary for the wheel burst.
    // Commit here so the old timer can never fire in the middle of that gesture.
    commitPreviewView();
    return true;
  }, [commitPreviewView]);
  useLayoutEffect(() => {
    resetViewPreview();
  }, [resetViewPreview, layout.worldOffsetX, view.pxPerDay, view.viewStartDay]);
  useLayoutEffect(() => {
    if (!previewActiveRef.current) return;
    // Native vertical scroll updates the marker projection window with React.
    // That commit reapplies declarative style props, so restore the concurrent
    // horizontal DOM preview before paint instead of snapping it back for a
    // frame (or leaving it cleared after the final pointer sample).
    applyViewPreviewPresentation();
  });

  // ドラッグ中の縦ガイド（content px）とコンテキストメニュー。
  const [ghostX, setGhostX] = useState<number | null>(null);
  // ドラッグ中のマーカー追従プレビュー（見た目を動かす）。dx/dy は px オフセット。
  // ids=追従させる全 eventId（単独ドラッグ=1件、複数選択の一括ドラッグ=選択全件）。
  const [dragPreview, setDragPreview] = useState<{
    ids: string[];
    dx: number;
    dy: number;
  } | null>(null);
  // 因果エッジ接続ハンドルのドラッグガイド（content px）。
  const [edgeDrag, setEdgeDrag] = useState<{
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  } | null>(null);
  // ドラッグ/期間端伸縮中に挿入先の日時を示すバブル（client px。body へ portal）。
  const [dragBubble, setDragBubble] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    eventId: string | null;
  } | null>(null);
  const setMiddlePanning = useCallback((active: boolean) => {
    // This cursor is interaction-local DOM state. Keeping it out of React avoids
    // rebuilding 1,000 marker elements on middle-button down/up.
    if (trackElRef.current) {
      trackElRef.current.style.cursor = active ? "grabbing" : "";
    }
  }, []);
  const cancelTransientInteraction = useCallback(() => {
    stopContinuousPreview();
    cancelViewPreviewFrame();
    draggedRef.current = false;
    setGhostX(null);
    setDragPreview(null);
    setEdgeDrag(null);
    setDragBubble(null);
    setMiddlePanning(false);
    if (thumbRef.current) {
      thumbRef.current.style.left = `${layoutRef.current.scroll.thumbLeft}px`;
    }
    resetViewPreview();
  }, [
    cancelViewPreviewFrame,
    resetViewPreview,
    setMiddlePanning,
    stopContinuousPreview,
  ]);
  useEffect(() => {
    if (isActive) return;
    const hasTransientInteraction =
      dragCleanupRef.current !== null ||
      previewActiveRef.current ||
      continuousPreviewRef.current ||
      viewPreviewFrameRef.current !== null ||
      wheelCommitTimerRef.current !== null;
    if (!hasTransientInteraction) return;
    if (wheelCommitTimerRef.current !== null) {
      clearTimeout(wheelCommitTimerRef.current);
      wheelCommitTimerRef.current = null;
    }
    if (dragCleanupRef.current) {
      dragCleanupRef.current();
    } else {
      cancelTransientInteraction();
    }
  }, [cancelTransientInteraction, isActive]);

  // document リスナから最新の callback/flag を読むための ref。
  const cbRef = useRef({
    locked: false,
    hasCalendarAxis: true,
    selectedIds: undefined as Set<string> | undefined,
    onMoveEvent,
    onResizeEvent,
    onCreateEdge,
    onCreateAt,
    onSelectPosition,
    onMoveSelected,
    formatDayLabel,
  });
  cbRef.current = {
    locked: !!locked,
    hasCalendarAxis,
    selectedIds,
    onMoveEvent,
    onResizeEvent,
    onCreateEdge,
    onCreateAt,
    onSelectPosition,
    onMoveSelected,
    formatDayLabel,
  };

  // ── 座標ヘルパ（track rect 基準） ──
  // always=true（位置選択クリック）は距離に関わらず見えている目盛りへ必ず吸着する。
  const snappedDayAt = (
    clientX: number,
    rect: DOMRect,
    always = false,
  ): number => {
    const raw = xToDay(viewRef.current, clientX - rect.left);
    const maxDist = always
      ? Infinity
      : SNAP_PX / Math.max(viewRef.current.pxPerDay, 1e-9);
    const tickDays = layoutRef.current.ticks.minor.map((tk) =>
      xToDay(viewRef.current, tk.x),
    );
    return snapDayToTicks(raw, tickDays, maxDist);
  };
  const laneCodexAt = (clientY: number, rect: DOMRect): string | null => {
    const lane = laneAtY(layoutRef.current.pack.lanes, clientY - rect.top);
    return lane ? laneTargetKey(lane) : null;
  };

  // document ドラッグの登録/撤去（move + up を1組で）。
  const bindDrag = (
    move: (ev: MouseEvent) => void,
    up: (ev: MouseEvent) => void,
    releaseButton = 0,
    onCancel?: () => void,
  ) => {
    // 直前のドラッグの取りこぼし（mouseup 欠落）でリスナが漏れると以後の操作が
    // 壊れる（draggedRef が張り付く/勝手にパン）。新規ドラッグ前に必ず撤去する。
    dragCleanupRef.current?.();
    let active = true;
    const removeListeners = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", cancel);
    };
    const onUp = (ev: MouseEvent) => {
      const expectedRelease =
        ev.button === releaseButton ||
        // happy-dom/legacy callers may omit `button` on mouseup. Accept that
        // shape only when no button remains pressed; a real left-button release
        // while middle is still held reports `buttons & 4` and must not end pan.
        (releaseButton === 1 && ev.button === 0 && ev.buttons === 0);
      if (!active || !expectedRelease) return;
      active = false;
      removeListeners();
      if (dragCleanupRef.current === cancel) dragCleanupRef.current = null;
      up(ev);
    };
    const cancel = () => {
      if (!active) return;
      active = false;
      removeListeners();
      if (dragCleanupRef.current === cancel) dragCleanupRef.current = null;
      cancelTransientInteraction();
      onCancel?.();
    };
    dragCleanupRef.current = cancel;
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("blur", cancel);
  };

  const preparePointerGesture = () => {
    dragCleanupRef.current?.();
    settleWheelPreview();
  };

  // wheel（passive:false で preventDefault）と ResizeObserver を track へ装着。
  const setTrackEl = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        cleanupRef.current?.();
        cleanupRef.current = null;
        trackElRef.current = null;
        if (externalTrackElRef) externalTrackElRef.current = null;
        return;
      }
      trackElRef.current = el;
      if (externalTrackElRef) externalTrackElRef.current = el;
      const onWheel = (e: WheelEvent) => {
        if (!isActive) return;
        // Trackpad inertia can end with a synthetic 0,0 sample. It must not be
        // interpreted as zoom-out, nor should it extend the debounce window.
        if (e.deltaX === 0 && e.deltaY === 0) return;
        e.preventDefault();
        // Mixing wheel projection with an active pointer drag makes the fixed
        // drag origin stale and can commit the timer mid-gesture. The pointer
        // interaction owns the viewport until it ends.
        if (dragCleanupRef.current !== null) return;
        let next: View;
        // Shift+ホイール=横スクロール（トラックパッドの deltaX も拾う）。
        if (e.shiftKey) {
          const delta =
            Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          next = panByPx({ view: viewRef.current, dx: -delta });
        } else {
          const rect = el.getBoundingClientRect();
          const pivotPx = e.clientX - rect.left;
          const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
          next = zoomAt({ view: viewRef.current, pivotPx, factor });
        }
        previewView(next);
        if (wheelCommitTimerRef.current !== null)
          clearTimeout(wheelCommitTimerRef.current);
        wheelCommitTimerRef.current = setTimeout(() => {
          wheelCommitTimerRef.current = null;
          commitPreviewView();
        }, WHEEL_VIEW_COMMIT_MS);
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      const ro =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => {
              const w = el.clientWidth;
              if (w > 0) onMeasureRef.current(w);
            })
          : null;
      ro?.observe(el);
      if (el.clientWidth > 0) onMeasureRef.current(el.clientWidth);
      cleanupRef.current = () => {
        el.removeEventListener("wheel", onWheel);
        ro?.disconnect();
        if (wheelCommitTimerRef.current !== null) {
          clearTimeout(wheelCommitTimerRef.current);
          wheelCommitTimerRef.current = null;
        }
      };
    },
    [commitPreviewView, externalTrackElRef, isActive, previewView],
  );
  useEffect(
    () => () => {
      cleanupRef.current?.();
      dragCleanupRef.current?.();
      if (viewPreviewFrameRef.current !== null) {
        cancelAnimationFrame(viewPreviewFrameRef.current);
      }
      if (wheelCommitTimerRef.current !== null)
        clearTimeout(wheelCommitTimerRef.current);
    },
    [],
  );

  // トラック pointerdown を一元処理: 期間端伸縮 / マーカードラッグ（移動 or
  // 別マーカーへ落として因果エッジ）/ 空白パン＋位置選択。3px 超でクリック抑止。
  const onTrackPointerDown = (e: React.MouseEvent) => {
    if (!isActive) return;
    // ── 中ボタンドラッグ = ハンドツール（対象に関わらずパン。Timeline と同挙動） ──
    // 横は view（panByPx）、縦はスクロール領域の scrollTop を直接移動。
    // OS の autoscroll は preventDefault で抑止する。
    if (e.button === 1) {
      e.preventDefault();
      const trackEl = trackElRef.current;
      if (!trackEl) return;
      preparePointerGesture();
      const startX = e.clientX;
      const startY = e.clientY;
      const startView = viewRef.current;
      const scrollEl = scrollAreaRef.current;
      const startScrollTop = scrollEl?.scrollTop ?? 0;
      let pendingView = startView;
      startContinuousPreview();
      setMiddlePanning(true);
      bindDrag(
        (ev) => {
          const dx = ev.clientX - startX;
          pendingView = panByPx({ view: startView, dx });
          previewView(pendingView);
          if (scrollEl)
            scrollEl.scrollTop = startScrollTop - (ev.clientY - startY);
        },
        () => {
          stopContinuousPreview();
          pendingPreviewViewRef.current = pendingView;
          commitPreviewView();
          setMiddlePanning(false);
        },
        1,
        () => {
          if (scrollEl) scrollEl.scrollTop = startScrollTop;
        },
      );
      return;
    }
    if (e.button !== 0) return;
    // ドラッグ中に本文/ラベルのテキストが選択されるのを防ぐ（select-none だけでは
    // ドラッグ起点の選択を抑止できない）。クリック選択は onClick が別途担う。
    e.preventDefault();
    const el = trackElRef.current;
    if (!el) return;
    preparePointerGesture();
    const rect = el.getBoundingClientRect();
    const targetEl = e.target as HTMLElement;
    const resizeEl = targetEl.closest("[data-resize]");
    const edgeHandleEl = targetEl.closest("[data-edge-handle]");
    const markerEl = targetEl.closest("[data-event-id]");
    const eventId = markerEl?.getAttribute("data-event-id") ?? null;
    const cb = cbRef.current;
    const startX = e.clientX;
    const startY = e.clientY;
    draggedRef.current = false;
    if (menu) setMenu(null);

    // ── 因果エッジ接続ハンドルからの D&D（別マーカーへ落とすと cause→effect） ──
    if (edgeHandleEl && eventId && !cb.locked && cb.onCreateEdge) {
      const center = layoutRef.current.pack.centers.get(eventId);
      // ガイドはハンドル(末尾の●)位置＝末尾 outX から引く（描画エッジと整合）。
      const fromX =
        (center?.outX ?? center?.cx) != null
          ? (center?.outX ?? center!.cx) + layoutRef.current.worldOffsetX
          : e.clientX - rect.left;
      const fromY = center?.cy ?? e.clientY - rect.top;
      bindDrag(
        (ev) => {
          draggedRef.current = true;
          setEdgeDrag({
            fromX,
            fromY,
            toX: ev.clientX - rect.left,
            toY: ev.clientY - rect.top,
          });
        },
        (ev) => {
          setEdgeDrag(null);
          const overEl = document.elementFromPoint(
            ev.clientX,
            ev.clientY,
          ) as HTMLElement | null;
          const overId =
            overEl?.closest("[data-event-id]")?.getAttribute("data-event-id") ??
            null;
          if (overId && overId !== eventId) cb.onCreateEdge!(eventId, overId);
          setTimeout(() => {
            draggedRef.current = false;
          }, 0);
        },
      );
      return;
    }

    // ── 期間端の伸縮 ──
    if (
      resizeEl &&
      eventId &&
      !cb.locked &&
      cb.onResizeEvent &&
      cb.hasCalendarAxis
    ) {
      const edge = resizeEl.getAttribute("data-resize") as "start" | "end";
      bindDrag(
        (ev) => {
          if (Math.abs(ev.clientX - startX) > DRAG_THRESHOLD)
            draggedRef.current = true;
          // 吸着先の日にゴースト線とバブルを合わせる（マーカー移動と同じ精度表示）。
          const snappedDay = snappedDayAt(ev.clientX, rect);
          setGhostX(dayToX(viewRef.current, snappedDay));
          const text = cb.formatDayLabel?.(snappedDay) ?? "";
          setDragBubble(
            text
              ? {
                  x: rect.left + dayToX(viewRef.current, snappedDay),
                  y: ev.clientY,
                  text,
                }
              : null,
          );
        },
        (ev) => {
          setGhostX(null);
          setDragBubble(null);
          if (draggedRef.current)
            cb.onResizeEvent!(eventId, edge, snappedDayAt(ev.clientX, rect));
          setTimeout(() => {
            draggedRef.current = false;
          }, 0);
        },
      );
      return;
    }

    // ── マーカー: 本体ドラッグ＝移動（ロック時は選択のみ。因果エッジは末尾●ハンドル） ──
    if (markerEl && eventId) {
      // pointerdown は preventDefault 済みでフォーカスが乗らないため、トラックへ明示フォーカス。
      // これでキーボード操作（←/→ nudge・Delete・Esc）が選択直後から効く。
      el.focus({ preventScroll: true });
      if (!cb.locked && cb.onMoveEvent) {
        const startLaneCodex = laneCodexAt(startY, rect);
        // 挿入位置はカーソルではなくイベントの先端（開始＝centers.cx）を基準にする。
        // バー中ほどを掴むとカーソルへ開始が飛びドラッグ中とドロップ後がズレる問題への対策。
        // grabOffsetX=掴んだ点と先端の距離。マーカー追従(dx)と整合し、先端が吸着先になる。
        const worldAnchorX = layoutRef.current.pack.centers.get(eventId)?.cx;
        const startAnchorX =
          worldAnchorX == null
            ? undefined
            : worldAnchorX + layoutRef.current.worldOffsetX;
        const grabOffsetX =
          startAnchorX != null ? startX - rect.left - startAnchorX : 0;
        // 掴んだマーカーが複数選択の一部なら選択全件を一括移動（=先端の差分を全件へ）。
        // それ以外は単独移動（従来どおりレーン再割当も可）。一括は時間方向の平行移動なので
        // 暦軸モード限定（並び順モードは時間移動できず prevew が空振りになるため単独扱い）。
        const sel = cb.selectedIds;
        const bulk =
          !!sel && sel.has(eventId) && sel.size > 1 && cb.hasCalendarAxis;
        const dragIds = bulk ? [...sel] : [eventId];
        bindDrag(
          (ev) => {
            if (
              Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
              Math.abs(ev.clientY - startY) > DRAG_THRESHOLD
            ) {
              draggedRef.current = true;
              // Y はデッドゾーン分を差し引いて追従（一定までは横スライドのみ）。
              // 一括移動はレーン保持なので縦追従しない（時間方向のみ）。
              const rawDy = ev.clientY - startY;
              const dy = bulk
                ? 0
                : Math.sign(rawDy) *
                  Math.max(0, Math.abs(rawDy) - LANE_DEADZONE);
              // マーカーをポインタへ追従（見た目を動かす）。ゴースト縦線は吸着先を示す。
              setDragPreview({ ids: dragIds, dx: ev.clientX - startX, dy });
              if (cb.hasCalendarAxis) {
                const snappedDay = snappedDayAt(ev.clientX - grabOffsetX, rect);
                setGhostX(dayToX(viewRef.current, snappedDay));
                // 挿入先の日時を現在のルーラー解像度でバブル表示。
                const text = cb.formatDayLabel?.(snappedDay) ?? "";
                setDragBubble(
                  text
                    ? {
                        x: rect.left + dayToX(viewRef.current, snappedDay),
                        y: ev.clientY,
                        text,
                      }
                    : null,
                );
              } else {
                setGhostX(ev.clientX - rect.left);
              }
            }
          },
          (ev) => {
            setGhostX(null);
            setDragBubble(null);
            setDragPreview(null);
            // 本体ドラッグは常に移動（別マーカーへ落としても因果エッジは作らない。
            // 因果エッジは選択時の末尾●ハンドル D&D のみ）。
            if (draggedRef.current && cb.onMoveEvent) {
              const dx = Math.abs(ev.clientX - startX);
              const dy = Math.abs(ev.clientY - startY);
              // 縦操作中の手ぶれを日時変更と誤認しない。斜め gesture は
              // 横成分が支配的な時だけ時間方向の移動として扱う
              // （横優勢なら lane + time の同時移動可）。
              const movedHorizontally = dx > DRAG_THRESHOLD && dx > dy;
              const newDay = movedHorizontally
                ? snappedDayAt(ev.clientX - grabOffsetX, rect)
                : null;
              if (bulk) {
                // 一括は時間方向だけを動かす。最終 drop が縦移動だけなら完全 no-op。
                if (newDay != null && cb.onMoveSelected) {
                  cb.onMoveSelected(eventId, newDay);
                }
              } else {
                // Y デッドゾーン未満ならレーン変更しない（横スライド扱い）。
                const newCodex =
                  Math.abs(ev.clientY - startY) < LANE_DEADZONE
                    ? startLaneCodex
                    : laneCodexAt(ev.clientY, rect);
                cb.onMoveEvent(eventId, newDay, newCodex);
              }
            }
            setTimeout(() => {
              draggedRef.current = false;
            }, 0);
          },
        );
      }
      // ロック時/ハンドラ無しでもパンはさせない（クリックで選択させる）。
      return;
    }

    // ── 空白: パン（横=view / 縦=scrollTop）＋（非ドラッグ時）位置選択 ──
    // 中ボタンのハンドツールと同じく縦横両方向へパンできる（横は panByPx、縦は
    // スクロール領域の scrollTop を直接移動）。以前は横だけで縦に動かせなかった。
    const startView = viewRef.current;
    const scrollEl = scrollAreaRef.current;
    const startScrollTop = scrollEl?.scrollTop ?? 0;
    let pendingView = startView;
    startContinuousPreview();
    bindDrag(
      (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        // 縦だけのドラッグもドラッグ扱い（=クリック位置選択を抑止）にするため dy も見る。
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)
          draggedRef.current = true;
        pendingView = panByPx({ view: startView, dx });
        previewView(pendingView);
        if (scrollEl) scrollEl.scrollTop = startScrollTop - dy;
      },
      (ev) => {
        stopContinuousPreview();
        if (draggedRef.current) {
          pendingPreviewViewRef.current = pendingView;
          commitPreviewView();
        } else {
          // preview は閾値判定より先に軽量 DOM transform へ反映される。
          // クリック相当の微小移動では view 更新が発生しないため、ここで明示的に戻す。
          resetViewPreview();
        }
        if (!draggedRef.current && cb.onSelectPosition) {
          // 位置選択の縦ラインは表示中ルーラー解像度のグリッドへ必ず吸着。
          const day = cb.hasCalendarAxis
            ? snappedDayAt(ev.clientX, rect, true)
            : null;
          cb.onSelectPosition(day, laneCodexAt(ev.clientY, rect));
        }
        setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      },
      0,
      () => {
        if (scrollEl) scrollEl.scrollTop = startScrollTop;
      },
    );
  };

  // 空白ダブルクリック=その位置に新規作成。
  const onTrackDoubleClick = (e: React.MouseEvent) => {
    // 出来事上のダブルクリック: インスペクタ（サイドペイン）を開いて編集する。
    // onEditEvent が showInspector を ON にするので、サイドペインが畳まれていても開く。
    // ロック中でも閲覧/編集のため開けるよう、新規作成(onCreateAt)の判定より前に処理する。
    const eventEl = (e.target as HTMLElement).closest("[data-event-id]");
    if (eventEl) {
      const rawId = eventEl.getAttribute("data-event-id");
      // レーンは複製マーカー(`id::codex`)を含むため実 id へ正規化。
      if (rawId && onEditEvent) onEditEvent(realEventId(rawId));
      return;
    }
    const cb = cbRef.current;
    const el = trackElRef.current;
    if (cb.locked || !cb.onCreateAt || !el) return;
    const rect = el.getBoundingClientRect();
    const day = cb.hasCalendarAxis ? snappedDayAt(e.clientX, rect) : null;
    cb.onCreateAt(day, laneCodexAt(e.clientY, rect));
  };

  // 矢印キーで選択を空間移動（←/→=同レーン内で時間前後 / ↑/↓=隣レーンの時間最近傍）。
  // レーンは複製マーカー(`id::codex`)を含むため realEventId で実 id に正規化して選択する。
  const navigateSelection = (dir: "left" | "right" | "up" | "down") => {
    const cur = selectedEventId;
    if (!cur) return;
    const lanes = layout.pack.lanes;
    const centers = layout.pack.centers;
    const cxOf = (id: string) => centers.get(id)?.cx ?? 0;
    let curLaneIdx = -1;
    let curMarkerId = "";
    for (let i = 0; i < lanes.length; i++) {
      const m = lanes[i].markers.find((mk) => realEventId(mk.eventId) === cur);
      if (m) {
        curLaneIdx = i;
        curMarkerId = m.eventId;
        break;
      }
    }
    if (curLaneIdx < 0) return;
    let target: string | null = null;
    if (dir === "left" || dir === "right") {
      const sorted = lanes[curLaneIdx].markers
        .map((mk) => mk.eventId)
        .sort((a, b) => cxOf(a) - cxOf(b) || a.localeCompare(b));
      const idx = sorted.indexOf(curMarkerId);
      const nIdx = dir === "left" ? idx - 1 : idx + 1;
      if (nIdx >= 0 && nIdx < sorted.length) target = sorted[nIdx];
    } else {
      const curCx = cxOf(curMarkerId);
      const step = dir === "up" ? -1 : 1;
      for (let i = curLaneIdx + step; i >= 0 && i < lanes.length; i += step) {
        const ms = lanes[i].markers;
        if (ms.length === 0) continue;
        let best: string | null = null;
        let bestD = Infinity;
        for (const mk of ms) {
          const d = Math.abs(cxOf(mk.eventId) - curCx);
          if (d < bestD) {
            bestD = d;
            best = mk.eventId;
          }
        }
        target = best;
        break;
      }
    }
    if (target) {
      const realTarget = realEventId(target);
      if (realTarget !== cur) {
        onSelectEvent(realTarget);
        setKbdSelectedId(realTarget);
        // SR へ選択先を短文で通知（連打時も最新だけ読まれる polite live region）。
        const title = eventsById.get(realTarget)?.title;
        announce(
          title && title.trim()
            ? title
            : t("chronicle.untitled", "無題のイベント"),
        );
      }
    }
  };

  // ビュー操作のキーボード代替（選択不要。wheel ズーム / Shift+wheel 横 / 中ボタン縦の等価）:
  // +/- =ズーム（中央 pivot） / Ctrl(⌘)+←→=横パン / Ctrl(⌘)+↑↓=縦スクロール /
  // PageUp/Down=縦ページ送り / Home/End=データ両端へ。処理したら true。
  const handleViewKey = (e: React.KeyboardEvent): boolean => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      // "+" は多くの配列で Shift が要るため shift は不問にする。
      if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") {
        const w = trackElRef.current?.clientWidth ?? 0;
        const factor = e.key === "-" || e.key === "_" ? 1 / 1.2 : 1.2;
        onViewChange(zoomAt({ view, pivotPx: w / 2, factor }));
        return true;
      }
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const dx = e.key === "ArrowLeft" ? KBD_PAN_PX : -KBD_PAN_PX;
        onViewChange(panByPx({ view, dx }));
        return true;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const sc = scrollAreaRef.current;
        if (sc)
          sc.scrollTop +=
            e.key === "ArrowDown" ? KBD_VSCROLL_PX : -KBD_VSCROLL_PX;
        return true;
      }
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      const sc = scrollAreaRef.current;
      if (sc) {
        const step = Math.max(sc.clientHeight * 0.9, 40);
        sc.scrollTop += e.key === "PageDown" ? step : -step;
      }
      return true;
    }
    if (e.key === "Home" || e.key === "End") {
      const geom = layout.scroll;
      onViewChange({
        pxPerDay: view.pxPerDay,
        viewStartDay:
          e.key === "Home" ? geom.fullStart : geom.fullStart + geom.denom,
      });
      return true;
    }
    return false;
  };

  // キーボード操作（トラックフォーカス時）: 矢印=選択移動 / Alt+矢印=時間ナッジ(Alt+Shift=粗) /
  // Shift+←→=期間終了端の伸縮（Ctrl+Shift=開始端） / +/- =ズーム / Ctrl+矢印・PageUp/Down・
  // Home/End=パン・スクロール / Delete=削除 / Esc=選択解除。
  // 検索欄・インスペクタ入力は別 DOM なのでここへは来ない。
  const onTrackKeyDown = (e: React.KeyboardEvent) => {
    // ビュー操作（ズーム/パン/スクロール）は選択が無くても効く。
    if (handleViewKey(e)) {
      e.preventDefault();
      return;
    }
    const hasSel = (selectedIds && selectedIds.size > 0) || !!selectedEventId;
    if (!hasSel) return;
    if (e.key === "Escape") {
      onClearSelection?.();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onDeleteSelected?.();
      return;
    }
    const dir =
      e.key === "ArrowLeft"
        ? "left"
        : e.key === "ArrowRight"
          ? "right"
          : e.key === "ArrowUp"
            ? "up"
            : e.key === "ArrowDown"
              ? "down"
              : null;
    if (!dir) return;
    e.preventDefault();
    // 現在のズームグリッド由来の移動量（ナッジ/期間端伸縮で共用）。
    const spanDays = (ticks: { x: number }[], fallback: number) =>
      ticks.length >= 2 && view.pxPerDay > 0
        ? Math.abs(ticks[1].x - ticks[0].x) / view.pxPerDay
        : fallback;
    const minorStep = spanDays(layout.ticks.minor, 1);
    if (e.altKey) {
      // Alt+矢印=ナッジ移動（時間方向のみ）。移動量は現在のズームグリッド由来:
      // Alt=細グリッド1目盛り / Alt+Shift=粗グリッド(major)1目盛り。↑/↓ は対象外。
      if (locked || !hasCalendarAxis || !onNudgeSelected) return;
      if (dir === "left" || dir === "right") {
        const step = e.shiftKey
          ? spanDays(layout.ticks.major, minorStep * 4)
          : minorStep;
        onNudgeSelected(dir === "left" ? -step : step);
      }
      return;
    }
    if (e.shiftKey && (dir === "left" || dir === "right")) {
      // Shift+←/→=プライマリ選択の期間「終了端」を伸縮 / Ctrl(⌘)+Shift=「開始端」。
      // ドラッグの期間端グリップと同じくロック中・並び順モードでは無効
      // （その場合は従来どおり下の選択ナビゲーションへフォールバック）。
      if (!locked && hasCalendarAxis && onResizeSelectedBy) {
        const edge = e.ctrlKey || e.metaKey ? "start" : "end";
        onResizeSelectedBy(edge, dir === "left" ? -minorStep : minorStep);
        return;
      }
    }
    // 修飾なし=選択ナビゲーション。
    navigateSelection(dir);
  };

  // 右クリック=コンテキストメニュー（マーカー上なら編集/削除、空白なら作成）。
  const onTrackContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const markerEl = (e.target as HTMLElement).closest("[data-event-id]");
    setMenu({
      x: e.clientX,
      y: e.clientY,
      eventId: markerEl?.getAttribute("data-event-id") ?? null,
    });
  };

  // スクロールバーつまみドラッグ＝横スクロール。
  const onThumbPointerDown = (e: React.MouseEvent) => {
    if (!isActive) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    preparePointerGesture();
    const geom = layoutRef.current.scroll;
    const startX = e.clientX;
    const startLeft = geom.thumbLeft;
    const startView = viewRef.current;
    let pendingView = startView;
    let moved = false;
    startContinuousPreview();
    const move = (ev: MouseEvent) => {
      const nextLeft = startLeft + (ev.clientX - startX);
      const clampedLeft = Math.max(
        0,
        Math.min(nextLeft, geom.trackW - geom.thumbW),
      );
      const vs = viewStartFromThumb(geom, clampedLeft);
      pendingView = {
        pxPerDay: startView.pxPerDay,
        viewStartDay: vs,
      };
      moved = moved || Math.abs(ev.clientX - startX) > 0;
      if (thumbRef.current) thumbRef.current.style.left = `${clampedLeft}px`;
      previewView(pendingView);
    };
    bindDrag(move, () => {
      stopContinuousPreview();
      if (moved) {
        pendingPreviewViewRef.current = pendingView;
        commitPreviewView();
      } else {
        resetViewPreview();
      }
    });
  };

  const onThumbKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const supported =
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "PageUp" ||
      e.key === "PageDown" ||
      e.key === "Home" ||
      e.key === "End";
    if (!supported) return;
    e.preventDefault();
    e.stopPropagation();
    preparePointerGesture();

    const geom = layoutRef.current.scroll;
    const current = viewRef.current;
    const min = geom.fullStart;
    const max = geom.fullStart + geom.denom;
    const arrowDays = KBD_PAN_PX / Math.max(current.pxPerDay, 1e-9);
    const pageDays =
      (geom.trackW * KBD_PAGE_RATIO) / Math.max(current.pxPerDay, 1e-9);
    let viewStartDay = current.viewStartDay;
    switch (e.key) {
      case "ArrowLeft":
        viewStartDay -= arrowDays;
        break;
      case "ArrowRight":
        viewStartDay += arrowDays;
        break;
      case "PageUp":
        viewStartDay -= pageDays;
        break;
      case "PageDown":
        viewStartDay += pageDays;
        break;
      case "Home":
        viewStartDay = min;
        break;
      case "End":
        viewStartDay = max;
        break;
    }
    const next = {
      pxPerDay: current.pxPerDay,
      viewStartDay: Math.max(min, Math.min(max, viewStartDay)),
    };
    previewView(next);
    commitPreviewView();
  };

  // マーカーへ渡す callback は安定参照にする（EventMarker は memo 化済み。
  // per-marker の inline closure を作ると全マーカーが毎回再レンダーされる）。
  const handleSelect = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (draggedRef.current) return;
      // マウス選択ではキーボード由来の因果チェーン強調を解除（従来のホバー駆動へ戻す）。
      setKbdSelectedId(null);
      // Ctrl/⌘=トグル, Shift=範囲, 修飾なし=単一。
      onSelectEvent(id, {
        toggle: e.ctrlKey || e.metaKey,
        range: e.shiftKey,
      });
    },
    [onSelectEvent],
  );

  const handleMarkerHover = useCallback((id: string, hovering: boolean) => {
    setHoveredEventId(hovering ? id : null);
  }, []);
  // 因果関係が無ければホバー強調は駆動しない（従来の per-marker 分岐と同じ）。
  const markerHover =
    relations && relations.length > 0 ? handleMarkerHover : undefined;

  const {
    spacing,
    pack,
    ticks,
    edges,
    scroll,
    contentHeight,
    minorGridX,
    majorGridX,
    markerById,
  } = layout;
  const scrollValueMin = scroll.fullStart;
  const scrollValueMax = scroll.fullStart + scroll.denom;
  const scrollValueNow = Math.max(
    scrollValueMin,
    Math.min(scrollValueMax, view.viewStartDay),
  );
  const formattedScrollValue = formatDayLabel?.(scrollValueNow).trim();
  const scrollValueText =
    formattedScrollValue ||
    t("chronicle.scrollbarValue", "表示開始: 作中日 {{day}}", {
      day: Number(scrollValueNow.toFixed(2)),
    });

  // 並べ替えの入れ替えアニメ（Timeline Thread と同方式の手動 FLIP）。
  const reducedMotion = useReducedMotion();
  const laneOffsets = useLaneReorderTween(
    pack.lanes.map((l) => ({ key: laneKeyOf(l), top: l.top })),
    reducedMotion,
  );

  // ドラッグ中は、動いたマーカーに繋がる因果エッジをその場で引き直す（静的 layout.edges
  // はドロップ後にしか更新されないため）。動いた端点の center を追従オフセット(dx,dy)で
  // ずらして bezier を再計算し、無関係なエッジは元のまま流用する（毎フレーム軽量）。
  const liveEdges = useMemo(() => {
    if (!dragPreview || !relations || relations.length === 0) return edges;
    const moved = new Set(dragPreview.ids);
    const affected = relations.filter(
      (r) => moved.has(r.causeId) || moved.has(r.effectId),
    );
    if (affected.length === 0) return edges;
    const shifted = new Map(pack.centers);
    for (const id of moved) {
      const c = pack.centers.get(id);
      if (c)
        shifted.set(id, {
          cx: c.cx + dragPreview.dx,
          cy: c.cy + dragPreview.dy,
          outX: c.outX + dragPreview.dx,
        });
    }
    const conflictPairs = new Set(
      edges.filter((e) => e.conflict).map((e) => `${e.causeId}|${e.effectId}`),
    );
    const recomputed = buildCausalBezier({
      relations: affected,
      centers: shifted,
      conflictPairs,
    });
    const affectedKeys = new Set(
      affected.map((r) => `${r.causeId}|${r.effectId}`),
    );
    const kept = edges.filter(
      (e) => !affectedKeys.has(`${e.causeId}|${e.effectId}`),
    );
    return [...kept, ...recomputed];
  }, [edges, dragPreview, pack.centers, relations]);
  const windowingEnabled =
    isActive && eventsById.size > CHRONICLE_WINDOWING_THRESHOLD;
  const verticalRenderWindow = useMemo(
    () =>
      windowingEnabled
        ? buildChronicleVerticalRenderWindow({
            scrollTop: verticalViewport.scrollTop,
            viewportHeight: verticalViewport.height,
            contentHeight,
          })
        : null,
    [contentHeight, verticalViewport, windowingEnabled],
  );
  const horizontalRenderWindow = useMemo(
    () =>
      windowingEnabled
        ? buildChronicleHorizontalRenderWindow({
            worldOffsetX: layout.worldOffsetX,
            viewportWidth: scroll.trackW,
          })
        : null,
    [layout.worldOffsetX, scroll.trackW, windowingEnabled],
  );
  const retainedMarkerIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedEventId) ids.add(selectedEventId);
    for (const id of selectedIds ?? []) ids.add(id);
    for (const id of dragPreview?.ids ?? []) ids.add(id);
    if (hoveredEventId) ids.add(hoveredEventId);
    if (kbdSelectedId) ids.add(kbdSelectedId);
    return ids;
  }, [
    dragPreview?.ids,
    hoveredEventId,
    kbdSelectedId,
    selectedEventId,
    selectedIds,
  ]);
  const visibleMarkers = useMemo(() => {
    if (!isActive) return [];
    const result: {
      lane: (typeof pack.lanes)[number];
      marker: (typeof pack.lanes)[number]["markers"][number];
      render: NonNullable<ReturnType<typeof markerById.get>>;
    }[] = [];
    for (const lane of pack.lanes) {
      for (const marker of lane.markers) {
        const render = markerById.get(marker.eventId);
        if (!render) continue;
        const retained = retainedMarkerIds.has(realEventId(marker.eventId));
        const laneOffsetY = laneOffsets.get(laneKeyOf(lane)) ?? 0;
        if (
          verticalRenderWindow &&
          !retained &&
          !chronicleMarkerIntersectsRenderWindow({
            markerTop: render.top,
            markerHeight: spacing.tokenH,
            markerOffsetY: laneOffsetY,
            window: verticalRenderWindow,
          })
        ) {
          continue;
        }
        if (
          horizontalRenderWindow &&
          !retained &&
          !chronicleMarkerIntersectsHorizontalRenderWindow({
            markerLeft: render.left,
            markerWidth: render.isInterval
              ? Math.max(render.barWidth ?? 52, 52)
              : spacing.maxTok,
            window: horizontalRenderWindow,
          })
        ) {
          continue;
        }
        result.push({ lane, marker, render });
      }
    }
    return result;
  }, [
    isActive,
    horizontalRenderWindow,
    markerById,
    laneOffsets,
    pack.lanes,
    retainedMarkerIds,
    spacing.maxTok,
    spacing.tokenH,
    verticalRenderWindow,
  ]);
  const visibleLiveEdges = useMemo(() => {
    if (!isActive) return [];
    if (!verticalRenderWindow && !horizontalRenderWindow) return liveEdges;
    return liveEdges.filter((edge) => {
      if (
        retainedMarkerIds.has(edge.causeId) ||
        retainedMarkerIds.has(edge.effectId)
      ) {
        return true;
      }
      const cause = pack.centers.get(edge.causeId);
      const effect = pack.centers.get(edge.effectId);
      if (!cause || !effect) return true;
      return (
        (!verticalRenderWindow ||
          chronicleEdgeIntersectsRenderWindow({
            causeY: cause.cy,
            effectY: effect.cy,
            window: verticalRenderWindow,
          })) &&
        (!horizontalRenderWindow ||
          chronicleEdgeIntersectsHorizontalRenderWindow({
            causeX: cause.cx,
            effectX: effect.cx,
            window: horizontalRenderWindow,
          }))
      );
    });
  }, [
    horizontalRenderWindow,
    isActive,
    liveEdges,
    pack.centers,
    retainedMarkerIds,
    verticalRenderWindow,
  ]);

  return (
    <div
      data-testid="chronicle-viewport"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ChronicleRuler
        gutterX={spacing.gutterX}
        unitLabel={ticks.unitLabel}
        ticks={ticks}
        contentRef={rulerContentRef}
      />

      <div
        ref={scrollAreaRef}
        data-testid="chronicle-scroll-area"
        className="flex min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <ChronicleLaneGutter
          lanes={pack.lanes}
          gutterX={spacing.gutterX}
          minHeight={contentHeight}
          activeLaneKey={activeLaneKey}
          laneOptions={laneOptions}
          locked={locked}
          onAssignGroup={onAssignGroup}
          onAddLane={onAddLane}
          onHideGroup={onHideGroup}
          onReorderLanes={onReorderLanes}
          laneOffsets={laneOffsets}
        />

        <div
          id="chronicle-track"
          data-chronicle-total-event-count={eventsById.size}
          data-chronicle-rendered-marker-count={visibleMarkers.length}
          data-chronicle-total-edge-count={liveEdges.length}
          data-chronicle-rendered-edge-count={
            showEdges ? visibleLiveEdges.length : 0
          }
          data-chronicle-render-window-top={verticalRenderWindow?.top}
          data-chronicle-render-window-bottom={verticalRenderWindow?.bottom}
          ref={setTrackEl}
          onMouseDown={onTrackPointerDown}
          onDoubleClick={onTrackDoubleClick}
          onContextMenu={onTrackContextMenu}
          onKeyDown={onTrackKeyDown}
          tabIndex={0}
          className="relative flex-1 select-none overflow-x-clip outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          // minHeight=コンテンツ高、flex stretch で残り高さまで伸ばしレーン外も操作可能に。
          // 本体ドラッグ追従中（dragPreview）/ 中ボタンパン中はトラック全体を grabbing に。
          style={{
            minHeight: contentHeight,
            cursor: dragPreview ? "grabbing" : undefined,
          }}
          role="application"
          aria-label={t("chronicle.viewportLabel", "作中年表")}
        >
          {/* viewport projection: pan preview はこの軽量 layer と ruler/world の
              transform だけを rAF で更新し、event/lane layout は再構築しない。 */}
          <div
            ref={projectionLayerRef}
            data-testid="chronicle-viewport-projection"
            className="pointer-events-none absolute inset-0 will-change-transform"
            style={{ transformOrigin: "0 0" }}
          >
            {selectedDay != null && hasCalendarAxis && (
              <div
                data-testid="chronicle-position-guide"
                className="absolute top-0 z-[4]"
                style={{
                  left: dayToX(view, selectedDay),
                  width: 0,
                  height: contentHeight,
                  borderLeft: "1.5px solid var(--primary)",
                  opacity: 0.7,
                }}
              />
            )}

            {/* グリッド線 */}
            {minorGridX.map((x, i) => (
              <div
                key={`gmin-${i}`}
                className="absolute top-0 z-[2]"
                style={{
                  left: x,
                  width: 1,
                  height: contentHeight,
                  background:
                    "color-mix(in oklch, var(--border) 45%, transparent)",
                }}
              />
            ))}
            {majorGridX.map((x, i) => (
              <div
                key={`gmaj-${i}`}
                className="absolute top-0 z-[2] bg-border"
                style={{ left: x, width: 1, height: contentHeight }}
              />
            ))}
          </div>

          {/* ドラッグ中ガイド（viewport px） */}
          {ghostX != null && (
            <div
              className="pointer-events-none absolute top-0 z-[8]"
              style={{
                left: ghostX,
                width: 0,
                height: contentHeight,
                borderLeft: "1.5px dashed var(--primary)",
              }}
            />
          )}

          {pack.laneSepTops.map((top, i) => {
            if (top <= 0) return null;
            // 区切り線は対応レーン（同 index）の入れ替えオフセットで追従。
            const sepLane = pack.lanes[i];
            const off = sepLane
              ? (laneOffsets.get(laneKeyOf(sepLane)) ?? 0)
              : 0;
            return (
              <div
                key={`sep-${i}`}
                className="absolute left-0 z-[2] bg-border/60"
                style={{
                  top,
                  width: "100%",
                  height: 1,
                  transform: off ? `translateY(${off}px)` : undefined,
                }}
              />
            );
          })}

          {/* 因果エッジ（ドラッグ中は liveEdges で動いた端点に追従） */}
          {showEdges && visibleLiveEdges.length > 0 && (
            <svg
              ref={edgeWorldLayerRef}
              data-chronicle-world-layer
              className="pointer-events-none absolute left-0 top-0 z-[3]"
              style={{
                width: "100%",
                height: contentHeight,
                overflow: "visible",
                transform: `translateX(${layout.worldOffsetX}px)`,
                transformOrigin: "0 0",
                willChange: "transform",
              }}
            >
              {visibleLiveEdges.map((e) => (
                <g key={`${e.causeId}|${e.effectId}`}>
                  <path
                    d={e.d}
                    fill="none"
                    className={
                      e.conflict
                        ? "stroke-red-500"
                        : "stroke-muted-foreground/60"
                    }
                    strokeWidth={e.conflict ? 2 : 1.4}
                    data-causal-edge={`${e.causeId}|${e.effectId}`}
                  />
                  <polygon
                    points={e.arrowPoints}
                    className={
                      e.conflict ? "fill-red-500" : "fill-muted-foreground/60"
                    }
                  />
                </g>
              ))}
            </svg>
          )}

          {/* 因果エッジ接続ドラッグのガイド線 */}
          {edgeDrag && (
            <svg
              className="pointer-events-none absolute left-0 top-0 z-[10]"
              style={{
                width: "100%",
                height: contentHeight,
                overflow: "visible",
              }}
            >
              <line
                x1={edgeDrag.fromX}
                y1={edgeDrag.fromY}
                x2={edgeDrag.toX}
                y2={edgeDrag.toY}
                className="stroke-primary"
                strokeWidth={1.6}
                strokeDasharray="4 3"
              />
            </svg>
          )}

          {/* マーカー（参加レーンの複製は合成 id。本物の eventId に解決して扱う）。
              挿入/削除は AnimatePresence の opacity フェードで見せる。追従(dragOffset)や
              レーン入れ替え(offsetY)の transform は EventMarker 側の inline のままなので、
              ラッパーの opacity は座標系(containing block)や静止時 z-index に干渉しない。 */}
          <div
            ref={markerWorldLayerRef}
            data-chronicle-world-layer
            className="absolute inset-0 z-[5]"
            style={{
              transform: `translateX(${layout.worldOffsetX}px)`,
              transformOrigin: "0 0",
              willChange: isActive ? "transform" : undefined,
            }}
          >
            <ChronicleMarkerPresence windowed={windowingEnabled}>
              {visibleMarkers.map(({ lane, marker: m, render }) => {
                const laneOffsetY = laneOffsets.get(laneKeyOf(lane)) ?? 0;
                const realId = realEventId(m.eventId);
                const ev = eventsById.get(realId);
                if (!ev) return null;
                const isSelected = selectedIds
                  ? selectedIds.has(realId)
                  : selectedEventId === realId;
                const isDragging = !!dragPreview?.ids.includes(realId);
                // フェード中は wrapper の opacity<1 が stacking context を作り、子の
                // z-index が wrapper 内に閉じてしまう。wrapper 自身に実効 z（ドラッグ30/
                // 選択9/通常5）を持たせ、エッジ(z3)やグリッド(z2)より前面を保つ。position:
                // relative でも wrapper は (0,0) の 0 高ブロックなので絶対配置の子は動かない。
                return (
                  <ChronicleMarkerWrapper
                    key={m.eventId}
                    windowed={windowingEnabled}
                    reducedMotion={reducedMotion}
                    style={{
                      position: "relative",
                      zIndex: isDragging ? 30 : isSelected ? 9 : 5,
                    }}
                  >
                    <EventMarker
                      event={ev}
                      left={render.left}
                      top={render.top}
                      offsetY={laneOffsetY}
                      tokenH={spacing.tokenH}
                      maxTok={spacing.maxTok}
                      isInterval={render.isInterval}
                      barWidth={render.barWidth}
                      selected={isSelected}
                      conflict={conflictIds.has(realId)}
                      related={relatedIds.has(realId)}
                      labelsOn={labelsOn}
                      resizable={!locked && render.isInterval}
                      cursor={locked ? "default" : "grab"}
                      dimmed={causalChain ? !causalChain.has(realId) : false}
                      onHover={markerHover}
                      edgeHandle={
                        // 因果エッジハンドルは単一選択時のプライマリのみ。
                        // scene-event は関係を持てないので出さない（壊れた affordance 防止）。
                        selectedEventId === realId &&
                        !ev.isScene &&
                        (!selectedIds || selectedIds.size <= 1) &&
                        !locked &&
                        !!onCreateEdge
                      }
                      dragOffset={
                        isDragging && dragPreview
                          ? { dx: dragPreview.dx, dy: dragPreview.dy }
                          : null
                      }
                      onSelect={handleSelect}
                    />
                  </ChronicleMarkerWrapper>
                );
              })}
            </ChronicleMarkerPresence>
          </div>
        </div>
      </div>

      {/* スクロールバー */}
      <div
        data-testid="chronicle-scrollbar"
        className="flex h-4 flex-none border-t border-border/60"
      >
        <div
          className="flex-none border-r border-border"
          style={{ width: spacing.gutterX }}
        />
        <div className="relative flex-1">
          <div
            ref={thumbRef}
            data-testid="chronicle-scroll-thumb"
            onMouseDown={onThumbPointerDown}
            onKeyDown={onThumbKeyDown}
            tabIndex={0}
            className="absolute cursor-grab rounded-full bg-muted-foreground/40"
            style={{
              top: 3,
              left: scroll.thumbLeft,
              width: scroll.thumbW,
              height: 10,
            }}
            role="scrollbar"
            aria-controls="chronicle-track"
            aria-orientation="horizontal"
            aria-label={t(
              "chronicle.scrollbarLabel",
              "作中年表の水平スクロール",
            )}
            aria-valuemin={scrollValueMin}
            aria-valuemax={scrollValueMax}
            aria-valuenow={scrollValueNow}
            aria-valuetext={scrollValueText}
          />
        </div>
      </div>

      {/* ドラッグ/期間端伸縮中の日時バブル（吸着先を現在のルーラー精度で表示）。
          overflow でクリップされないよう body へ portal し fixed 配置。 */}
      {dragBubble &&
        dragBubble.text &&
        createPortal(
          <div
            data-testid="chronicle-drag-date-bubble"
            className="pointer-events-none fixed z-[70] whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground shadow-md"
            style={{
              left: dragBubble.x,
              top: dragBubble.y - 14,
              transform: "translate(-50%, -100%)",
            }}
          >
            {dragBubble.text}
          </div>,
          document.body,
        )}

      {menu &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[60]"
              onMouseDown={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(null);
              }}
            />
            <div
              data-testid="chronicle-context-menu"
              className="fixed z-[61] min-w-[170px] rounded-md border border-border bg-popover py-1 text-xs shadow-md"
              style={{ left: menu.x, top: menu.y }}
            >
              {menu.eventId ? (
                <>
                  <button
                    type="button"
                    className="flex w-full items-center px-3 py-1.5 hover:bg-accent"
                    onClick={() => {
                      // 「編集」は単独選択＋詳細パネルを開く（onEditEvent）。
                      // 未配線時は従来どおり単独選択のみへフォールバック。
                      if (onEditEvent) onEditEvent(menu.eventId!);
                      else
                        onSelectEvent(menu.eventId!, {
                          toggle: false,
                          range: false,
                        });
                      setMenu(null);
                    }}
                  >
                    {t("chronicle.ctxEdit", "編集")}
                  </button>
                  {onOpenScene && openableSceneEventIds?.has(menu.eventId) && (
                    <button
                      type="button"
                      className="flex w-full items-center px-3 py-1.5 hover:bg-accent"
                      onClick={() => {
                        onOpenScene(menu.eventId!);
                        setMenu(null);
                      }}
                    >
                      {t("chronicle.ctxOpenScene", "該当シーンを開く")}
                    </button>
                  )}
                  {onSelectCauses &&
                    directCauses(menu.eventId, relations ?? []).length > 0 && (
                      <button
                        type="button"
                        className="flex w-full items-center px-3 py-1.5 hover:bg-accent"
                        onClick={() => {
                          onSelectCauses(menu.eventId!);
                          setMenu(null);
                        }}
                      >
                        {t("chronicle.ctxSelectCauses", "原因を選択")}
                      </button>
                    )}
                  {onSelectEffects &&
                    directEffects(menu.eventId, relations ?? []).length > 0 && (
                      <button
                        type="button"
                        className="flex w-full items-center px-3 py-1.5 hover:bg-accent"
                        onClick={() => {
                          onSelectEffects(menu.eventId!);
                          setMenu(null);
                        }}
                      >
                        {t("chronicle.ctxSelectEffects", "結果を選択")}
                      </button>
                    )}
                  {!locked && onDeleteEvent && (
                    <button
                      type="button"
                      className="flex w-full items-center px-3 py-1.5 text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        onDeleteEvent(menu.eventId!);
                        setMenu(null);
                      }}
                    >
                      {t("chronicle.delete", "削除")}
                    </button>
                  )}
                </>
              ) : (
                !locked &&
                onCreateAt && (
                  <button
                    type="button"
                    className="flex w-full items-center px-3 py-1.5 hover:bg-accent"
                    onClick={() => {
                      const el = trackElRef.current;
                      if (el) {
                        const rect = el.getBoundingClientRect();
                        onCreateAt(
                          hasCalendarAxis ? snappedDayAt(menu.x, rect) : null,
                          laneCodexAt(menu.y, rect),
                        );
                      }
                      setMenu(null);
                    }}
                  >
                    {t("chronicle.ctxCreateHere", "ここにイベントを作成")}
                  </button>
                )
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
