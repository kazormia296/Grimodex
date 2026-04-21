import { useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { useTimelineStore } from "./timelineStore";

const DOT_R = 6;
const LANE_Y = 60;
const LABEL_Y = LANE_Y + 24;
const AXIS_Y = LANE_Y;
const PHASE_PIN_Y = LANE_Y + 44;
const SVG_HEIGHT = 130;
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

interface PhasePinData {
  nodeId: string;
  label: string;
  entryName: string;
}

interface Props {
  scenes: TreeNodeData[];
  phasePins?: PhasePinData[];
  onSelectScene: (id: string) => void;
}

export function TimelineViewport({
  scenes,
  phasePins = [],
  onSelectScene,
}: Props) {
  const { t } = useTranslation();
  const selectedNodeIds = useTimelineStore((s) => s.selectedNodeIds);
  const display = useTimelineStore((s) => s.display);
  const svgRef = useRef<SVGSVGElement>(null);

  const svgWidth = PAD_LEFT + scenes.length * STEP + PAD_RIGHT;

  const xOf = useCallback((i: number) => PAD_LEFT + i * STEP, []);

  const pinsByNode = new Map<string, PhasePinData[]>();
  for (const pin of phasePins) {
    const list = pinsByNode.get(pin.nodeId) ?? [];
    list.push(pin);
    pinsByNode.set(pin.nodeId, list);
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
        width={svgWidth}
        height={SVG_HEIGHT}
        className="block select-none"
        aria-label={t("timeline.viewport", "タイムライン ビューポート")}
      >
        {/* Axis line */}
        <line
          x1={PAD_LEFT - DOT_R}
          y1={AXIS_Y}
          x2={xOf(scenes.length - 1) + DOT_R}
          y2={AXIS_Y}
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeWidth={1}
        />

        {scenes.map((scene, i) => {
          const cx = xOf(i);
          const fill =
            STATUS_FILL[scene.status ?? "outline"] ?? STATUS_FILL.outline;
          const isSelected = selectedNodeIds.includes(scene.id);
          const pins = pinsByNode.get(scene.id) ?? [];

          return (
            <g key={scene.id} data-node-id={scene.id}>
              {/* Vertical stem */}
              {(display.showTitles || display.showChapterNumbers) && (
                <line
                  x1={cx}
                  y1={LANE_Y + DOT_R}
                  x2={cx}
                  y2={LABEL_Y - 4}
                  stroke="currentColor"
                  strokeOpacity={0.15}
                  strokeWidth={1}
                />
              )}

              {/* Scene dot */}
              <circle
                cx={cx}
                cy={LANE_Y}
                r={DOT_R}
                fill={fill}
                stroke={isSelected ? "white" : "transparent"}
                strokeWidth={2}
                className="cursor-pointer"
                onClick={() => onSelectScene(scene.id)}
              >
                <title>{scene.title}</title>
              </circle>

              {/* Title label */}
              {display.showTitles && (
                <text
                  x={cx}
                  y={LABEL_Y + 12}
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
              {display.showPhasePins && pins.length > 0 && (
                <g>
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
                    {pins.length === 1 && (
                      <title>{`${pins[0].entryName}: ${pins[0].label}`}</title>
                    )}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
