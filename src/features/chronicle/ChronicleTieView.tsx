import { useTranslation } from "react-i18next";
import type { TieViewModel } from "./tieView";

export interface ChronicleTieViewProps {
  model: TieViewModel;
  width: number;
  height: number;
}

/**
 * reading 順 scene トラック（上）↔ 作中時間順 event トラック（下）をタイ線で結ぶ複合ビュー
 * （presentational）。「読む順では前なのに作中では後」のズレが線の交差として現れる。
 */
export function ChronicleTieView({
  model,
  width,
  height,
}: ChronicleTieViewProps) {
  const { t } = useTranslation();
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={t("chronicle.tieView", "読む順×作中時間")}
      className="text-foreground"
    >
      <line
        x1={0}
        y1={model.topY}
        x2={width}
        y2={model.topY}
        className="stroke-border"
        opacity={0.4}
      />
      <line
        x1={0}
        y1={model.bottomY}
        x2={width}
        y2={model.bottomY}
        className="stroke-border"
        opacity={0.4}
      />
      <text
        x={4}
        y={model.topY - 8}
        className="fill-muted-foreground text-[10px]"
      >
        {t("chronicle.readingOrder", "読む順")}
      </text>
      <text
        x={4}
        y={model.bottomY + 16}
        className="fill-muted-foreground text-[10px]"
      >
        {t("chronicle.storyTime", "作中時間")}
      </text>

      {model.ties.map((tie) => (
        <line
          key={`${tie.sceneId}|${tie.eventId}`}
          x1={tie.x1}
          y1={model.topY}
          x2={tie.x2}
          y2={model.bottomY}
          data-tie={`${tie.sceneId}|${tie.eventId}`}
          className="stroke-primary/40"
          strokeWidth={1}
        />
      ))}

      {model.sceneDots.map((d) => (
        <circle
          key={d.id}
          cx={d.x}
          cy={model.topY}
          r={4}
          data-tie-scene={d.id}
          className="fill-foreground/70"
        >
          <title>{d.title}</title>
        </circle>
      ))}
      {model.eventDots.map((d) => (
        <circle
          key={d.id}
          cx={d.x}
          cy={model.bottomY}
          r={4}
          data-tie-event={d.id}
          className="fill-primary"
        >
          <title>{d.title}</title>
        </circle>
      ))}
    </svg>
  );
}
