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
import type { ChronicleLayout } from "./chronicleLayout";
import { laneAtY } from "./chronicleLanePack";
import { snapDayToTicks } from "./chronicleSnap";
import { ChronicleRuler } from "./ChronicleRuler";
import { ChronicleLaneGutter } from "./ChronicleLaneGutter";
import { EventMarker, type MarkerEvent } from "./EventMarker";

const SNAP_PX = 12;
const DRAG_THRESHOLD = 3;

/** レーンの表示キー（codexId or "__unassigned"）→ 割当用 codexId（null=未割当）。 */
function laneTargetCodexId(lane: {
  unassigned: boolean;
  codexId: string | null;
}): string | null {
  return lane.unassigned ? null : lane.codexId;
}

export interface ChronicleViewportProps {
  view: View;
  onViewChange: (v: View) => void;
  onMeasureTrack: (w: number) => void;
  layout: ChronicleLayout;
  eventsById: Map<string, MarkerEvent>;
  selectedEventId: string | null;
  activeLaneKey: string | null;
  conflictIds: Set<string>;
  /** Timeline で選択中のシーンに紐づく出来事（淡いリング強調）。 */
  relatedIds: Set<string>;
  showEdges: boolean;
  labelsOn: boolean;
  onSelectEvent: (id: string) => void;
  /** レーンガター用（任意 Codex 候補・割当/追加・ロック）。 */
  laneOptions?: { id: string; name: string; type: string }[];
  locked?: boolean;
  selectedUnassigned?: boolean;
  onAssignLane?: (codexId: string) => void;
  onAddLane?: (codexId: string) => void;
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
  activeLaneKey,
  conflictIds,
  relatedIds,
  showEdges,
  labelsOn,
  onSelectEvent,
  laneOptions,
  locked,
  selectedUnassigned,
  onAssignLane,
  onAddLane,
  selectedDay,
  hasCalendarAxis = true,
  onMoveEvent,
  onResizeEvent,
  onCreateEdge,
  onCreateAt,
  onSelectPosition,
  onDeleteEvent,
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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    eventId: string | null;
  } | null>(null);

  // document リスナから最新の callback/flag を読むための ref。
  const cbRef = useRef({
    locked: false,
    hasCalendarAxis: true,
    onMoveEvent,
    onResizeEvent,
    onCreateEdge,
    onCreateAt,
    onSelectPosition,
  });
  cbRef.current = {
    locked: !!locked,
    hasCalendarAxis,
    onMoveEvent,
    onResizeEvent,
    onCreateEdge,
    onCreateAt,
    onSelectPosition,
  };

  // ── 座標ヘルパ（track rect 基準） ──
  const snappedDayAt = (clientX: number, rect: DOMRect): number => {
    const raw = xToDay(viewRef.current, clientX - rect.left);
    const maxDist = SNAP_PX / Math.max(viewRef.current.pxPerDay, 1e-9);
    const tickDays = layoutRef.current.ticks.minor.map((tk) =>
      xToDay(viewRef.current, tk.x),
    );
    return snapDayToTicks(raw, tickDays, maxDist);
  };
  const laneCodexAt = (clientY: number, rect: DOMRect): string | null => {
    const lane = laneAtY(layoutRef.current.pack.lanes, clientY - rect.top);
    return lane ? laneTargetCodexId(lane) : null;
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
    const markerEl = targetEl.closest("[data-event-id]");
    const eventId = markerEl?.getAttribute("data-event-id") ?? null;
    const cb = cbRef.current;
    const startX = e.clientX;
    const startY = e.clientY;
    draggedRef.current = false;
    if (menu) setMenu(null);

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

    // ── マーカー: ドラッグで移動、別マーカーへ落とすと因果エッジ（ロック時は選択のみ） ──
    if (markerEl && eventId) {
      if (!cb.locked && (cb.onMoveEvent || cb.onCreateEdge)) {
        bindDrag(
          (ev) => {
            if (
              Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
              Math.abs(ev.clientY - startY) > DRAG_THRESHOLD
            ) {
              draggedRef.current = true;
              setGhostX(ev.clientX - rect.left);
            }
          },
          (ev) => {
            setGhostX(null);
            if (draggedRef.current) {
              const overEl = document.elementFromPoint(
                ev.clientX,
                ev.clientY,
              ) as HTMLElement | null;
              const overId =
                overEl
                  ?.closest("[data-event-id]")
                  ?.getAttribute("data-event-id") ?? null;
              if (overId && overId !== eventId && cb.onCreateEdge) {
                cb.onCreateEdge(eventId, overId);
              } else if (cb.onMoveEvent) {
                const newDay = cb.hasCalendarAxis
                  ? snappedDayAt(ev.clientX, rect)
                  : null;
                cb.onMoveEvent(eventId, newDay, laneCodexAt(ev.clientY, rect));
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
          const day = cb.hasCalendarAxis
            ? snappedDayAt(ev.clientX, rect)
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
    const cb = cbRef.current;
    const el = trackElRef.current;
    if (cb.locked || !cb.onCreateAt || !el) return;
    if ((e.target as HTMLElement).closest("[data-event-id]")) return;
    const rect = el.getBoundingClientRect();
    const day = cb.hasCalendarAxis ? snappedDayAt(e.clientX, rect) : null;
    cb.onCreateAt(day, laneCodexAt(e.clientY, rect));
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

  const handleSelect = (id: string) => {
    if (draggedRef.current) return;
    onSelectEvent(id);
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

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-card">
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
          selectedUnassigned={selectedUnassigned}
          onAssignLane={onAssignLane}
          onAddLane={onAddLane}
        />

        <div
          id="chronicle-track"
          ref={setTrackEl}
          onMouseDown={onTrackPointerDown}
          onDoubleClick={onTrackDoubleClick}
          onContextMenu={onTrackContextMenu}
          className="relative flex-1 cursor-grab select-none"
          style={{ height: contentHeight }}
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
          {pack.laneSepTops.map((top, i) =>
            top > 0 ? (
              <div
                key={`sep-${i}`}
                className="absolute left-0 z-[2] bg-border/60"
                style={{ top, width: "100%", height: 1 }}
              />
            ) : null,
          )}

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

          {/* マーカー */}
          {pack.lanes.flatMap((lane) =>
            lane.markers.map((m) => {
              const ev = eventsById.get(m.eventId);
              const render = markerById.get(m.eventId);
              if (!ev || !render) return null;
              return (
                <EventMarker
                  key={m.eventId}
                  event={ev}
                  left={render.left}
                  top={render.top}
                  tokenH={spacing.tokenH}
                  maxTok={spacing.maxTok}
                  isInterval={render.isInterval}
                  barWidth={render.barWidth}
                  selected={selectedEventId === m.eventId}
                  conflict={conflictIds.has(m.eventId)}
                  related={relatedIds.has(m.eventId)}
                  labelsOn={labelsOn}
                  resizable={!locked && render.isInterval}
                  onSelect={() => handleSelect(m.eventId)}
                />
              );
            }),
          )}
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
                      onSelectEvent(menu.eventId!);
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
                    {t("chronicle.ctxCreateHere", "ここに出来事を作成")}
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
