import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { useTimelineStore } from "./timelineStore";

const DOT_R = 6;
const LANE_Y = 60;
const AXIS_Y = LANE_Y;
const PHASE_PIN_Y = LANE_Y + 44;
const UNSCHEDULED_Y = LANE_Y + 90;
const SVG_HEIGHT_BASE = 130;
const STEP = 96;
const PAD_LEFT = 48;
const PAD_RIGHT = 32;

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

interface DragState {
  nodeId: string;
  startX: number;
  currentX: number;
  originIndex: number;
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

export function TimelineViewport({
  scenes,
  weights = null,
  phasePins = [],
  unscheduledStartIndex,
  onDropStoryTime,
  onSelectScene,
}: Props) {
  const { t } = useTranslation();
  const selectedNodeIds = useTimelineStore((s) => s.selectedNodeIds);
  const display = useTimelineStore((s) => s.display);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const hasUnscheduled =
    unscheduledStartIndex !== undefined &&
    unscheduledStartIndex < scenes.length;
  const svgHeight = hasUnscheduled ? SVG_HEIGHT_BASE + 60 : SVG_HEIGHT_BASE;

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
    const svgX =
      e.clientX - (svgRef.current?.getBoundingClientRect().left ?? 0);
    setDrag({ nodeId, startX: svgX, currentX: svgX, originIndex });
  }

  function handleSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!drag) return;
    const svgX =
      e.clientX - (svgRef.current?.getBoundingClientRect().left ?? 0);
    setDrag((d) => (d ? { ...d, currentX: svgX } : null));
  }

  function handleSvgMouseUp(e: React.MouseEvent<SVGSVGElement>) {
    if (!drag || !onDropStoryTime) {
      setDrag(null);
      return;
    }
    const svgX =
      e.clientX - (svgRef.current?.getBoundingClientRect().left ?? 0);
    const toUnscheduled =
      hasUnscheduled &&
      e.clientY - (svgRef.current?.getBoundingClientRect().top ?? 0) >
        UNSCHEDULED_Y - 20;

    if (toUnscheduled) {
      onDropStoryTime(drag.nodeId, null, null, true);
    } else {
      // Find insertion position among scheduled scenes (excluding dragged node)
      const scheduledScenes = scenes
        .slice(0, scheduledCount)
        .filter((_, i) => scenes[i].id !== drag.nodeId);
      let insertIdx = scheduledScenes.length;
      for (let i = 0; i < scheduledScenes.length; i++) {
        if (xOf(i) > svgX) {
          insertIdx = i;
          break;
        }
      }
      const prevKey =
        insertIdx > 0
          ? (scheduledScenes[insertIdx - 1].storyTimeOrder ?? null)
          : null;
      const nextKey =
        insertIdx < scheduledScenes.length
          ? (scheduledScenes[insertIdx].storyTimeOrder ?? null)
          : null;
      onDropStoryTime(drag.nodeId, prevKey, nextKey, false);
    }
    setDrag(null);
  }

  if (scenes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("timeline.noScenes", "シーンがありません")}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-x-auto overflow-y-hidden">
      <svg
        ref={svgRef}
        width={totalWidth}
        height={svgHeight}
        className={`block select-none${canDrag ? " cursor-default" : ""}`}
        aria-label={t("timeline.viewport", "タイムライン ビューポート")}
        onMouseMove={handleSvgMouseMove}
        onMouseUp={handleSvgMouseUp}
        onMouseLeave={() => setDrag(null)}
      >
        {/* Main axis line (scheduled portion only) */}
        <line
          x1={PAD_LEFT - DOT_R}
          y1={AXIS_Y}
          x2={scheduledCount > 0 ? xOf(scheduledCount - 1) + DOT_R : PAD_LEFT}
          y2={AXIS_Y}
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeWidth={1}
        />

        {/* Unscheduled separator */}
        {hasUnscheduled && (
          <>
            <line
              x1={PAD_LEFT - DOT_R}
              y1={UNSCHEDULED_Y - 16}
              x2={totalWidth - PAD_RIGHT}
              y2={UNSCHEDULED_Y - 16}
              stroke="currentColor"
              strokeOpacity={0.12}
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            <text
              x={PAD_LEFT - DOT_R}
              y={UNSCHEDULED_Y - 4}
              fontSize={9}
              fill="currentColor"
              fillOpacity={0.4}
            >
              {t("timeline.unscheduled", "Unscheduled")}
            </text>
          </>
        )}

        {scenes.map((scene, i) => {
          const cx = xOf(i);
          const cy = yOf(i);
          const fill =
            STATUS_FILL[scene.status ?? "outline"] ?? STATUS_FILL.outline;
          const isSelected = selectedNodeIds.includes(scene.id);
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

              {/* Drag ghost line */}
              {drag?.nodeId === scene.id && (
                <line
                  x1={cx}
                  y1={cy}
                  x2={drag.currentX}
                  y2={cy}
                  stroke="currentColor"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  pointerEvents="none"
                />
              )}

              {/* Scene dot */}
              <circle
                cx={drag?.nodeId === scene.id ? drag.currentX : cx}
                cy={cy}
                r={DOT_R}
                fill={fill}
                stroke={isSelected ? "white" : "transparent"}
                strokeWidth={2}
                className={canDrag ? "cursor-grab" : "cursor-pointer"}
                onClick={() => onSelectScene(scene.id)}
                onMouseDown={(e) => handleDotMouseDown(e, scene.id, i)}
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
              {display.showPhasePins && pins.length > 0 && !isUnscheduled && (
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
                    {pins.map((p) => `${p.entryName}: ${p.label}`).join("\n")}
                  </title>
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
