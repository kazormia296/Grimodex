import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  panByPx,
  viewStartFromThumb,
  zoomAt,
  type View,
} from "./chronicleAxis";
import type { ChronicleLayout } from "./chronicleLayout";
import { ChronicleRuler } from "./ChronicleRuler";
import { ChronicleLaneGutter } from "./ChronicleLaneGutter";
import { EventMarker, type MarkerEvent } from "./EventMarker";

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

  // トラックドラッグ＝横パン。3px 超移動でクリック（選択）を抑止する。
  const onTrackPointerDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startView = viewRef.current;
    draggedRef.current = false;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 3) draggedRef.current = true;
      onViewChangeRef.current(panByPx({ view: startView, dx }));
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      dragCleanupRef.current = null;
      // クリックハンドラが走った後に false へ戻す。
      setTimeout(() => {
        draggedRef.current = false;
      }, 0);
    };
    dragCleanupRef.current = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
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
        />

        <div
          id="chronicle-track"
          ref={setTrackEl}
          onMouseDown={onTrackPointerDown}
          className="relative flex-1 cursor-grab select-none"
          style={{ height: contentHeight }}
          role="application"
          aria-label={t("chronicle.viewportLabel", "作中年表")}
        >
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
                        : "stroke-muted-foreground/50"
                    }
                    strokeWidth={e.conflict ? 2 : 1.4}
                    strokeDasharray={e.conflict ? undefined : "4 3"}
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
    </div>
  );
}
