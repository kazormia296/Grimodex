import type { ChronicleLaneMarker } from "./chronicleLaneModel";
import { precisionStyle } from "./chronicleTimeScale";

const POINT_R = 6;
const INTERVAL_H = 10;

/**
 * 年表上の出来事マーカー1個。point=円 / interval=角丸矩形 / オフページ=中空(塗り無し)。
 * precision で不透明度と破線を切替（chronicleTimeScale.precisionStyle）。
 * 座標は親(ChronicleViewport)が scaled から渡す。
 */
export function EventMarker({
  marker,
  x,
  xEnd,
  y,
  selected,
  onSelect,
}: {
  marker: ChronicleLaneMarker;
  x: number;
  xEnd: number | null;
  y: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { opacity, dashed } = precisionStyle(marker.precision);
  const stroke = "currentColor";
  const fill = marker.isOffpage ? "none" : "currentColor";
  const common = {
    "data-event-id": marker.eventId,
    opacity,
    onClick: onSelect,
    stroke,
    strokeWidth: 1.5,
    strokeDasharray: dashed ? "3 2" : undefined,
    className: `cursor-pointer ${selected ? "chronicle-marker--selected text-primary" : "text-foreground/70"}`,
  } as const;

  if (marker.isInterval && xEnd != null && xEnd > x) {
    return (
      <rect
        {...common}
        x={x}
        y={y - INTERVAL_H / 2}
        width={xEnd - x}
        height={INTERVAL_H}
        rx={3}
        fill={fill}
      />
    );
  }
  return <circle {...common} cx={x} cy={y} r={POINT_R} fill={fill} />;
}
