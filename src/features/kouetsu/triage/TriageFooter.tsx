import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { CAT_LABEL_KEY, catLastRunIso, relativeTimeLabel } from "./catalog";
import type { IssueCat } from "./issueModel";
import { useIsCatRunning } from "./useCatRunning";
import type { EffectLastRunMap } from "./useEffectLastRuns";

/**
 * フッター（デザイン 2a）: AI 観点ごとの鮮度（最終実行の相対時刻）を
 * ドット + ラベルで常設表示する。実行済み = 緑、未実行 = グレー、
 * 実行中 = アクセント色。校正（live lint）と影響レビュー（手動）は
 * 鮮度の概念が異なるため出さない。
 */
const FOOTER_CATS: readonly IssueCat[] = [
  "typo",
  "consistency",
  "review",
  "intent",
  "meta",
  "timeline",
];

export function TriageFooter({ lastRuns }: { lastRuns: EffectLastRunMap }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border bg-muted/20 px-3 py-1 text-[9.5px] text-muted-foreground">
      {FOOTER_CATS.map((cat) => (
        <FooterItem key={cat} cat={cat} lastRuns={lastRuns} />
      ))}
    </div>
  );
}

function FooterItem({
  cat,
  lastRuns,
}: {
  cat: IssueCat;
  lastRuns: EffectLastRunMap;
}) {
  const { t } = useTranslation();
  const running = useIsCatRunning(cat);
  const iso = catLastRunIso(cat, lastRuns);
  const timeLabel = running
    ? t("kouetsu.progressToast.running")
    : iso
      ? (relativeTimeLabel(iso, new Date()) ?? t("kouetsu.triage.neverRun"))
      : t("kouetsu.triage.neverRun");

  return (
    <span className="flex items-center gap-1">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          running
            ? "animate-pulse bg-[var(--kouetsu-accent)]"
            : iso
              ? "bg-[var(--kouetsu-ok)]"
              : "bg-muted-foreground/30",
        )}
      />
      {t(CAT_LABEL_KEY[cat])} {timeLabel}
    </span>
  );
}
