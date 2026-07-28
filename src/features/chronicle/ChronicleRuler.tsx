import { useTranslation } from "react-i18next";
import type { Ref } from "react";
import type { RulerTicks } from "./chronicleTicks";

export interface ChronicleRulerProps {
  gutterX: number;
  unitLabel: string;
  ticks: RulerTicks;
  /** Pan preview writes translateX here without a React render. */
  contentRef?: Ref<HTMLDivElement>;
}

/**
 * タイムライン上部の時間ルーラー（適応的目盛り）。左ガターに「作中時間」と
 * 刻み幅、右トラックに major（粗ラベル）/ minor（細目盛り＋ラベル）を重ねる。
 * x 座標は chronicleTicks が view から純粋に算出済み。
 */
export function ChronicleRuler({
  gutterX,
  unitLabel,
  ticks,
  contentRef,
}: ChronicleRulerProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="chronicle-ruler"
      className="flex h-[54px] flex-none border-b border-border bg-card"
    >
      <div
        data-testid="chronicle-ruler-gutter"
        className="flex flex-none flex-col justify-center gap-[3px] border-r border-border px-3.5"
        style={{ width: gutterX }}
      >
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("chronicle.storyTime", "作中時間")}
        </span>
        <span
          className="text-[11px] font-semibold"
          style={{ color: "var(--primary)" }}
        >
          {unitLabel}
        </span>
      </div>
      <div
        data-testid="chronicle-ruler-track"
        className="relative flex-1 overflow-hidden"
      >
        <div
          ref={contentRef}
          className="absolute inset-0 will-change-transform"
          style={{ transformOrigin: "0 0" }}
        >
          {ticks.major.map((tk, i) => (
            <div
              key={`maj-${i}`}
              className="absolute whitespace-nowrap text-xs font-semibold text-foreground/70"
              style={{ left: tk.x < 0 ? tk.x : Math.max(tk.x, 4), top: 8 }}
            >
              {tk.label}
            </div>
          ))}
          {ticks.minor.map((tk, i) => (
            <div key={`min-${i}`}>
              <div
                className="absolute bg-border"
                style={{ left: tk.x, top: 34, width: 1, height: 8 }}
              />
              <div
                className="absolute whitespace-nowrap text-[11px] text-muted-foreground"
                style={{
                  left: tk.x + 5,
                  top: 30,
                  fontFeatureSettings: "'tnum'",
                }}
              >
                {tk.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
