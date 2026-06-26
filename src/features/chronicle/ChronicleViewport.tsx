import { useTranslation } from "react-i18next";
import type { ChronicleLaneModel } from "./chronicleLaneModel";
import type { ScaledPoint } from "./chronicleTimeScale";
import { EventMarker } from "./EventMarker";

export interface ChronicleViewportProps {
  model: ChronicleLaneModel;
  /** eventId → 射影済み x/xEnd（chronicleTimeScale.scaleEvents の結果 Map）。 */
  scaled: Map<string, ScaledPoint>;
  /** SVG 幅(px)。 */
  width: number;
  /** 左ラベルガター幅(px)。scaleEvents の padX と一致させること。 */
  gutterX: number;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string) => void;
}

/**
 * 人物レーン×作中時間軸の SVG 年表（presentational）。
 * 座標数学は親が chronicleTimeScale/chronicleLaneModel で算出して渡す。
 * このコンポーネントは描画のみ（200行規約・モノリス複製禁止）。
 */
export function ChronicleViewport({
  model,
  scaled,
  width,
  gutterX,
  selectedEventId,
  onSelectEvent,
}: ChronicleViewportProps) {
  const { t } = useTranslation();
  const hasUnassigned = model.unassigned.length > 0;
  const unassignedY = model.contentHeight + model.laneHeight / 2;
  const height = model.contentHeight + (hasUnassigned ? model.laneHeight : 0);

  const renderMarkers = (
    markers: ChronicleLaneModel["lanes"][number]["markers"],
    y: number,
  ) =>
    markers.map((m) => {
      const s = scaled.get(m.eventId);
      if (!s) return null;
      return (
        <EventMarker
          key={m.eventId}
          marker={m}
          x={s.x}
          xEnd={s.xEnd}
          y={y}
          selected={selectedEventId === m.eventId}
          onSelect={() => onSelectEvent(m.eventId)}
        />
      );
    });

  return (
    <svg
      width={width}
      height={Math.max(height, model.laneHeight)}
      role="img"
      aria-label={t("chronicle.viewportLabel", "作中年表")}
      className="text-foreground"
    >
      {model.lanes.map((lane) => (
        <g key={lane.codexId} data-lane-id={lane.codexId}>
          <line
            x1={gutterX}
            y1={lane.y}
            x2={width}
            y2={lane.y}
            className="stroke-border"
            strokeWidth={1}
            opacity={0.4}
          />
          <text
            x={6}
            y={lane.y}
            dominantBaseline="middle"
            className="fill-muted-foreground text-xs"
          >
            {lane.name}
          </text>
          {renderMarkers(lane.markers, lane.y)}
        </g>
      ))}

      {hasUnassigned && (
        <g data-lane-id="__unassigned">
          <line
            x1={gutterX}
            y1={unassignedY}
            x2={width}
            y2={unassignedY}
            className="stroke-border"
            strokeWidth={1}
            strokeDasharray="2 3"
            opacity={0.4}
          />
          <text
            x={6}
            y={unassignedY}
            dominantBaseline="middle"
            className="fill-muted-foreground text-xs italic"
          >
            {t("chronicle.unassigned", "未割当")}
          </text>
          {renderMarkers(model.unassigned, unassignedY)}
        </g>
      )}
    </svg>
  );
}
