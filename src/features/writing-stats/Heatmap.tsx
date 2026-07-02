import { useTranslation } from "react-i18next";
import type { Heatmap as HeatmapData, HeatmapCell } from "./deriveStats";

/**
 * 0..4 の強度クラス。Tailwind JIT が拾えるよう完全な文字列を静的配列で持つ
 * （動的に組み立てると purge される）。MatrixCell の INTENSITY 段階色を踏襲。
 */
const LEVEL_CLASS = [
  "bg-muted",
  "bg-primary/20",
  "bg-primary/40",
  "bg-primary/65",
  "bg-primary/90",
] as const;

interface HeatmapProps {
  heatmap: HeatmapData;
}

/** GitHub 風コントリビューショングリッド（週=列、日曜始まりの 7 行）。 */
export function Heatmap({ heatmap }: HeatmapProps) {
  const { t, i18n } = useTranslation();
  const unit =
    heatmap.metric === "chars"
      ? t("writingStats.charsUnit")
      : t("writingStats.eventsUnit");

  const cellTitle = (cell: HeatmapCell): string => {
    if (!cell.inRange) return "";
    const value = heatmap.metric === "chars" ? cell.chars : cell.events;
    return `${cell.key} — ${value.toLocaleString()}${unit}`;
  };

  return (
    <div className="flex flex-col gap-1" data-testid="writing-stats-heatmap">
      <div className="flex gap-1 overflow-x-auto pb-1">
        {/* 曜日ラベル（月/水/金） */}
        <div className="flex shrink-0 flex-col gap-[2px] pr-1 pt-[14px]">
          {[0, 1, 2, 3, 4, 5, 6].map((dow) => (
            <span
              key={dow}
              className="h-[11px] text-[9px] leading-[11px] text-muted-foreground"
            >
              {dow === 1
                ? t("writingStats.weekdayMon")
                : dow === 3
                  ? t("writingStats.weekdayWed")
                  : dow === 5
                    ? t("writingStats.weekdayFri")
                    : ""}
            </span>
          ))}
        </div>

        {/* 週ごとの列 */}
        <div className="flex flex-col gap-[2px]">
          <MonthLabels heatmap={heatmap} locale={i18n.language} />
          <div className="flex gap-[2px]">
            {heatmap.weeks.map((col, w) => (
              <div key={w} className="flex flex-col gap-[2px]">
                {col.map((cell) => (
                  // title は視覚 tooltip 用に保持しつつ、SR には role="img" +
                  // aria-label で「日付 — 値」を提供する (WCAG 1.1.1)。
                  <div
                    key={cell.key}
                    title={cellTitle(cell)}
                    role={cell.inRange ? "img" : undefined}
                    aria-label={cell.inRange ? cellTitle(cell) : undefined}
                    aria-hidden={!cell.inRange}
                    className={`h-[11px] w-[11px] rounded-[2px] ${
                      cell.inRange ? LEVEL_CLASS[cell.level] : "bg-transparent"
                    }`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 凡例 */}
      <div className="flex items-center justify-end gap-1 text-[9px] text-muted-foreground">
        <span>{t("writingStats.less")}</span>
        {LEVEL_CLASS.map((cls, i) => (
          <span key={i} className={`h-[10px] w-[10px] rounded-[2px] ${cls}`} />
        ))}
        <span>{t("writingStats.more")}</span>
      </div>
    </div>
  );
}

/** 各列の先頭日が属する月をたどり、月が変わる最初の列にラベルを置く。 */
function MonthLabels({
  heatmap,
  locale,
}: {
  heatmap: HeatmapData;
  locale: string;
}) {
  let lastMonth = -1;
  return (
    <div className="flex gap-[2px]">
      {heatmap.weeks.map((col, w) => {
        const [y, m, d] = col[0].key.split("-").map(Number);
        const month = m - 1;
        let label = "";
        if (month !== lastMonth) {
          lastMonth = month;
          label = new Date(y, month, d).toLocaleDateString(locale, {
            month: "short",
          });
        }
        return (
          <span
            key={w}
            className="w-[11px] text-[9px] leading-[11px] text-muted-foreground"
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}
