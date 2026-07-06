import { useTranslation } from "react-i18next";
import { CheckCircle2 } from "lucide-react";
import { SEV_DOT_CLASS, SEV_LABEL_KEY } from "./catalog";
import type { SevCounts } from "./issueModel";

/**
 * 既定ステージ（デザイン 1b のサマリーストリップ）: 開いている件数 +
 * 重大度分布バー + 凡例。0 件時は「開いている指摘はありません」。
 * lastCheckLabel は相対時刻の文字列（未実行なら null で非表示）。
 */
export function SummaryStage({
  counts,
  lastCheckLabel,
}: {
  counts: SevCounts;
  lastCheckLabel: string | null;
}) {
  const { t } = useTranslation();
  const openCount = counts.high + counts.mid + counts.low;

  if (openCount === 0) {
    return (
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={16} className="text-[var(--kouetsu-ok)]" />
          <span className="text-xs font-medium text-[var(--kouetsu-ok)]">
            {t("kouetsu.triage.noOpen")}
          </span>
          {lastCheckLabel && (
            <span className="ml-auto text-[10px] text-muted-foreground">
              {t("kouetsu.triage.lastCheck", { time: lastCheckLabel })}
            </span>
          )}
        </div>
      </div>
    );
  }

  const total = openCount || 1;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  const sevs = [
    { sev: "high" as const, count: counts.high },
    { sev: "mid" as const, count: counts.mid },
    { sev: "low" as const, count: counts.low },
  ];

  return (
    <div className="shrink-0 border-b border-border px-3 pb-2 pt-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-bold tracking-tight tabular-nums">
          {openCount}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {t("kouetsu.triage.openSuffix")}
        </span>
        {lastCheckLabel && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {t("kouetsu.triage.lastCheck", { time: lastCheckLabel })}
          </span>
        )}
      </div>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
        {sevs.map(
          ({ sev, count }) =>
            count > 0 && (
              <div
                key={sev}
                className={SEV_DOT_CLASS[sev]}
                style={{ width: pct(count), transition: "width 0.4s ease" }}
              />
            ),
        )}
      </div>
      <div className="mt-1.5 flex gap-3 text-[10px] text-muted-foreground">
        {sevs.map(({ sev, count }) => (
          <span key={sev} className="flex items-center gap-1">
            <span
              className={`h-1.5 w-1.5 rounded-full ${SEV_DOT_CLASS[sev]}`}
            />
            {t(SEV_LABEL_KEY[sev])} {count}
          </span>
        ))}
      </div>
    </div>
  );
}
