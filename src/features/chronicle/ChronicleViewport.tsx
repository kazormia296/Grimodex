import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { laneAtY } from "./chronicleLanePack";
import { useLaneReorderTween } from "./chronicleLaneAnim";
import { useReducedMotion } from "@/lib/animation";
import { snapDayToTicks } from "./chronicleSnap";
import { ChronicleRuler } from "./ChronicleRuler";
import { ChronicleLaneGutter } from "./ChronicleLaneGutter";
import { EventMarker, type MarkerEvent } from "./EventMarker";

const SNAP_PX = 12;
const DRAG_THRESHOLD = 3;
// Y のデッドゾーン: これ未満の縦移動はレーン変更せず横スライドのみ（Grid のシーン同様）。
const LANE_DEADZONE = 28;

export interface ChronicleViewportProps {
  view: View;
  onViewChange: (v: View) => void;
  onMeasureTrack: (w: number) => void;
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
  /** 暦軸モードか（false=並び順モードでは時間ドラッグ/位置作成を抑止）。 */
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
  /** 複数選択の一括移動（primaryId の吸着先 newStartDay 差分を全選択へ。レーンは保持）。 */
  onMoveSelected?: (primaryId: string, newStartDay: number) => void;
  /** 選択中をまとめて時間方向に nudge（キーボード ←/→）。日数の符号付き差分。 */
  onNudgeSelected?: (deltaDays: number) => void;
  /** 選択中をまとめて削除（キーボード Delete/Backspace）。 */
  onDeleteSelected?: () => void;
  /** 選択解除（キーボード Escape）。 */
  onClearSelection?: () => void;
}

/**
 * 作中年表ビューポート（DOM ベースの pan/zoom 水平タイムライン）。
 * ルーラー＋（左ガター＋トラック）＋スクロールバーを積む。トラックの
 * ホイール=ズーム / ドラッグ=パン / ResizeObserver=幅計測 を司り、座標は
 * 親が buildChronicleLayout（純関数）で算出した layout から描く。
 */
export function ChronicleViewport({
  view,
  onViewChange,
  onMeasureTrack,
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
  onMoveSelected,
  onNudgeSelected,
  onDeleteSelected,
  onClearSelection,
}: ChronicleViewportProps) {
  const { t } = useTranslation();
  const trackElRef = useRef<HTMLDivElement | null>(null);
  // ネイティブ wheel / pointer ハンドラから最新値を読むための ref。
  const viewRef = useRef(view);
  viewRef.current = view;
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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    eventId: string | null;
  } | null>(null);

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
  ) => {
    // 直前のドラッグの取りこぼし（mouseup 欠落）でリスナが漏れると以後の操作が
    // 壊れる（draggedRef が張り付く/勝手にパン）。新規ドラッグ前に必ず撤去する。
    dragCleanupRef.current?.();
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", onUp);
      dragCleanupRef.current = null;
      up(ev);
    };
    dragCleanupRef.current = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", onUp);
  };

  // wheel（passive:false で preventDefault）と ResizeObserver を track へ装着。
  const setTrackEl = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      cleanupRef.current?.();
      cleanupRef.current = null;
      trackElRef.current = null;
      return;
    }
    trackElRef.current = el;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Shift+ホイール=横スクロール（トラックパッドの deltaX も拾う）。
      if (e.shiftKey) {
        const delta =
          Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        onViewChangeRef.current(panByPx({ view: viewRef.current, dx: -delta }));
        return;
      }
      const rect = el.getBoundingClientRect();
      const pivotPx = e.clientX - rect.left;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      onViewChangeRef.current(
        zoomAt({ view: viewRef.current, pivotPx, factor }),
      );
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
    };
  }, []);
  useEffect(
    () => () => {
      cleanupRef.current?.();
      dragCleanupRef.current?.();
    },
    [],
  );

  // トラック pointerdown を一元処理: 期間端伸縮 / マーカードラッグ（移動 or
  // 別マーカーへ落として因果エッジ）/ 空白パン＋位置選択。3px 超でクリック抑止。
  const onTrackPointerDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // ドラッグ中に本文/ラベルのテキストが選択されるのを防ぐ（select-none だけでは
    // ドラッグ起点の選択を抑止できない）。クリック選択は onClick が別途担う。
    e.preventDefault();
    const el = trackElRef.current;
    if (!el) return;
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
      const fromX = center?.outX ?? center?.cx ?? e.clientX - rect.left;
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
          setGhostX(ev.clientX - rect.left);
        },
        (ev) => {
          setGhostX(null);
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
        const startAnchorX = layoutRef.current.pack.centers.get(eventId)?.cx;
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
              setGhostX(
                cb.hasCalendarAxis
                  ? dayToX(
                      viewRef.current,
                      snappedDayAt(ev.clientX - grabOffsetX, rect),
                    )
                  : ev.clientX - rect.left,
              );
            }
          },
          (ev) => {
            setGhostX(null);
            setDragPreview(null);
            // 本体ドラッグは常に移動（別マーカーへ落としても因果エッジは作らない。
            // 因果エッジは選択時の末尾●ハンドル D&D のみ）。
            if (draggedRef.current && cb.onMoveEvent) {
              const newDay = cb.hasCalendarAxis
                ? snappedDayAt(ev.clientX - grabOffsetX, rect)
                : null;
              if (bulk && newDay != null && cb.onMoveSelected) {
                // 一括: 先端の差分を選択全件へ適用（レーンは各自保持）。
                cb.onMoveSelected(eventId, newDay);
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

    // ── 空白: 横パン＋（非ドラッグ時）位置選択 ──
    const startView = viewRef.current;
    bindDrag(
      (ev) => {
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > DRAG_THRESHOLD) draggedRef.current = true;
        onViewChangeRef.current(panByPx({ view: startView, dx }));
      },
      (ev) => {
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
      if (realTarget !== cur) onSelectEvent(realTarget);
    }
  };

  // キーボード操作（トラックフォーカス時）: 矢印=選択移動 / Alt+矢印=時間ナッジ(Alt+Shift=1週間) /
  // Delete=削除 / Esc=選択解除。検索欄・インスペクタ入力は別 DOM なのでここへは来ない。
  const onTrackKeyDown = (e: React.KeyboardEvent) => {
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
    if (e.altKey) {
      // Alt+矢印=ナッジ移動（時間方向のみ）。移動量は現在のズームグリッド由来:
      // Alt=細グリッド1目盛り / Alt+Shift=粗グリッド(major)1目盛り。↑/↓ は対象外。
      if (locked || !hasCalendarAxis || !onNudgeSelected) return;
      if (dir === "left" || dir === "right") {
        const spanDays = (ticks: { x: number }[], fallback: number) =>
          ticks.length >= 2 && view.pxPerDay > 0
            ? Math.abs(ticks[1].x - ticks[0].x) / view.pxPerDay
            : fallback;
        const minorStep = spanDays(layout.ticks.minor, 1);
        const step = e.shiftKey
          ? spanDays(layout.ticks.major, minorStep * 4)
          : minorStep;
        onNudgeSelected(dir === "left" ? -step : step);
      }
      return;
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
    e.stopPropagation();
    const geom = layoutRef.current.scroll;
    const startX = e.clientX;
    const startLeft = geom.thumbLeft;
    const move = (ev: MouseEvent) => {
      const nextLeft = startLeft + (ev.clientX - startX);
      const vs = viewStartFromThumb(layoutRef.current.scroll, nextLeft);
      onViewChangeRef.current({
        pxPerDay: viewRef.current.pxPerDay,
        viewStartDay: vs,
      });
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const handleSelect = (id: string, e: React.MouseEvent) => {
    if (draggedRef.current) return;
    // Ctrl/⌘=トグル, Shift=範囲, 修飾なし=単一。
    onSelectEvent(id, {
      toggle: e.ctrlKey || e.metaKey,
      range: e.shiftKey,
    });
  };

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

  // 並べ替えの入れ替えアニメ（Timeline Thread と同方式の手動 FLIP）。
  const reducedMotion = useReducedMotion();
  const laneOffsets = useLaneReorderTween(
    pack.lanes.map((l) => ({ key: laneKeyOf(l), top: l.top })),
    reducedMotion,
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-card">
      <ChronicleRuler
        gutterX={spacing.gutterX}
        unitLabel={ticks.unitLabel}
        ticks={ticks}
      />

      <div className="flex min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <ChronicleLaneGutter
          lanes={pack.lanes}
          gutterX={spacing.gutterX}
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
          ref={setTrackEl}
          onMouseDown={onTrackPointerDown}
          onDoubleClick={onTrackDoubleClick}
          onContextMenu={onTrackContextMenu}
          onKeyDown={onTrackKeyDown}
          tabIndex={0}
          className="relative flex-1 select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          // minHeight=コンテンツ高、flex stretch で残り高さまで伸ばしレーン外も操作可能に。
          // 本体ドラッグ追従中（dragPreview）はトラック全体を grab hand（grabbing）に。
          style={{
            minHeight: contentHeight,
            cursor: dragPreview ? "grabbing" : undefined,
          }}
          role="application"
          aria-label={t("chronicle.viewportLabel", "作中年表")}
        >
          {/* 選択位置ガイド（accent 実線）＋ドラッグ中ガイド（破線） */}
          {selectedDay != null && hasCalendarAxis && (
            <div
              data-testid="chronicle-position-guide"
              className="pointer-events-none absolute top-0 z-[4]"
              style={{
                left: dayToX(view, selectedDay),
                width: 0,
                height: contentHeight,
                borderLeft: "1.5px solid var(--primary)",
                opacity: 0.7,
              }}
            />
          )}
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

          {/* 因果エッジ */}
          {showEdges && edges.length > 0 && (
            <svg
              className="pointer-events-none absolute left-0 top-0 z-[3]"
              style={{
                width: "100%",
                height: contentHeight,
                overflow: "visible",
              }}
            >
              {edges.map((e) => (
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

          {/* マーカー（参加レーンの複製は合成 id。本物の eventId に解決して扱う） */}
          {pack.lanes.flatMap((lane) => {
            const laneOffsetY = laneOffsets.get(laneKeyOf(lane)) ?? 0;
            return lane.markers.map((m) => {
              const realId = realEventId(m.eventId);
              const ev = eventsById.get(realId);
              const render = markerById.get(m.eventId);
              if (!ev || !render) return null;
              return (
                <EventMarker
                  key={m.eventId}
                  event={ev}
                  left={render.left}
                  top={render.top}
                  offsetY={laneOffsetY}
                  tokenH={spacing.tokenH}
                  maxTok={spacing.maxTok}
                  isInterval={render.isInterval}
                  barWidth={render.barWidth}
                  selected={
                    selectedIds
                      ? selectedIds.has(realId)
                      : selectedEventId === realId
                  }
                  conflict={conflictIds.has(realId)}
                  related={relatedIds.has(realId)}
                  labelsOn={labelsOn}
                  resizable={!locked && render.isInterval}
                  cursor={locked ? "default" : "grab"}
                  edgeHandle={
                    // 因果エッジハンドルは単一選択時のプライマリのみ。
                    selectedEventId === realId &&
                    (!selectedIds || selectedIds.size <= 1) &&
                    !locked &&
                    !!onCreateEdge
                  }
                  dragOffset={
                    dragPreview?.ids.includes(realId)
                      ? { dx: dragPreview.dx, dy: dragPreview.dy }
                      : null
                  }
                  onSelect={(e) => handleSelect(realId, e)}
                />
              );
            });
          })}
        </div>
      </div>

      {/* スクロールバー */}
      <div className="flex h-4 flex-none border-t border-border/60 bg-card">
        <div
          className="flex-none border-r border-border"
          style={{ width: spacing.gutterX }}
        />
        <div className="relative flex-1">
          <div
            onMouseDown={onThumbPointerDown}
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
            aria-valuenow={Math.round(scroll.thumbLeft)}
          />
        </div>
      </div>

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
