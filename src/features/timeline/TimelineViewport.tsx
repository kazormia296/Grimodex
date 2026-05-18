import { useRef, useState, useEffect, useCallback, forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useTimelineStore } from "./timelineStore";
import { computeAxisLabels } from "./timelineLabels";
import { ZOOM_STEP, STEP_BASE } from "./timelineZoom";
import { TimelineContextMenu } from "./TimelineContextMenu";
import { recordMark } from "@/lib/perfLog";

const DOT_R = 6;
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

interface DragState {
  nodeId: string;
  startX: number;
  currentX: number;
  currentY: number;
  originIndex: number;
}

interface ContextMenuState {
  node: TreeNodeData;
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
    const zoom = useTimelineStore((s) => s.zoom);
    const setZoom = useTimelineStore((s) => s.setZoom);
    const scrollOffset = useTimelineStore((s) => s.scrollOffset);
    const setScrollOffset = useTimelineStore((s) => s.setScrollOffset);
    const svgRef = useRef<SVGSVGElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isRestoringRef = useRef(false);
    const [drag, setDrag] = useState<DragState | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(
      null,
    );
    // Track when the scroll container element mounts/unmounts so the wheel
    // listener effect re-runs even if scenes load after the first render.
    const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);

    const STEP = STEP_BASE * zoom;

    // showUnscheduledZone: ドロップゾーンを表示するか
    // story-time モード中は常に表示（全シーンが軸上でも Unscheduled に戻せるよう）
    const showUnscheduledZone = unscheduledStartIndex !== undefined;
    const svgHeight = showUnscheduledZone
      ? SVG_HEIGHT_BASE + 60
      : SVG_HEIGHT_BASE;

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

    // Ctrl+wheel zoom — must use native listener with passive:false to call preventDefault.
    // Depends on containerEl (not just []) so the listener re-attaches when scenes
    // load after the first render and the container div appears for the first time.
    useEffect(() => {
      if (!containerEl) return;
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey) return;
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
          className="flex-1 overflow-x-auto overflow-y-hidden"
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
