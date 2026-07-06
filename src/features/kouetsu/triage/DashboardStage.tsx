import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLintProjectStore } from "@/features/lint/lintProjectStore";
import { useKouetsuStore } from "../kouetsuStore";
import { useResolvedKouetsuScope } from "../useResolvedKouetsuScope";
import {
  CAT_ICON,
  CAT_LABEL_KEY,
  SEV_LABEL_KEY,
  SEV_TEXT_CLASS,
  catLastRunIso,
  relativeTimeLabel,
} from "./catalog";
import {
  CAT_ORDER,
  deriveSevCounts,
  type IssueCat,
  type UnifiedIssue,
} from "./issueModel";
import { runCategoryCheck } from "./issueActions";
import { useIsCatRunning } from "./useCatRunning";
import type { EffectLastRunMap } from "./useEffectLastRuns";

/**
 * 観点ダッシュボード（デザイン 1c / 2a）: 8 観点タイルのグリッド
 * （列数はパネル幅に応じて auto-fill で可変）。
 * タイル = 件数（最悪重大度の色）+ 内訳 + 最終実行。クリックで観点フィルタ、
 * 実行ボタンで観点単発チェック（結果反映は useUnifiedIssues の自動 refresh）。
 */
export function DashboardStage({
  open,
  lastRuns,
}: {
  open: UnifiedIssue[];
  lastRuns: EffectLastRunMap;
}) {
  const { t } = useTranslation();
  const byCat = useMemo(() => {
    const map = new Map<IssueCat, UnifiedIssue[]>();
    for (const issue of open) {
      const list = map.get(issue.cat);
      if (list) list.push(issue);
      else map.set(issue.cat, [issue]);
    }
    return map;
  }, [open]);

  return (
    <div
      data-testid="triage-dashboard"
      aria-label={t("kouetsu.triage.dashboardToggle")}
      // max-h + 内部スクロール: auto-fill で 1 列に落ちるとタイルが縦に
      // 伸びる（~460px）。ダッシュボードがリスト本体（flex-1）やフッターを
      // 押し潰さないよう、はみ出す分は自前でスクロールさせる。
      className="max-h-64 shrink-0 overflow-y-auto border-b border-border bg-muted/20 px-2.5 py-2"
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-1.5">
        {CAT_ORDER.map((cat) => (
          <Tile
            key={cat}
            cat={cat}
            issues={byCat.get(cat) ?? []}
            lastRuns={lastRuns}
          />
        ))}
      </div>
    </div>
  );
}

function Tile({
  cat,
  issues,
  lastRuns,
}: {
  cat: IssueCat;
  issues: UnifiedIssue[];
  lastRuns: EffectLastRunMap;
}) {
  const { t } = useTranslation();
  const scope = useResolvedKouetsuScope();
  const catFilter = useKouetsuStore((s) => s.catFilter);
  const setCatFilter = useKouetsuStore((s) => s.setCatFilter);
  const running = useIsCatRunning(cat);
  const projectScanDone = useLintProjectStore((s) => s.phase === "done");
  const CatIcon = CAT_ICON[cat];

  const n = issues.length;
  const counts = deriveSevCounts(issues);
  const worst = issues[0]?.sev ?? null; // issues は重要度ソート済み
  const active = catFilter === cat;

  const lastIso = catLastRunIso(cat, lastRuns);
  const corner =
    cat === "linter"
      ? t("kouetsu.triage.auto")
      : cat === "impact"
        ? t("kouetsu.triage.manual")
        : lastIso
          ? (relativeTimeLabel(lastIso, new Date()) ?? "")
          : "";
  // 0 件を緑 OK と見せてよいのは「実際に検査済み」のときだけ（嘘バッジ禁止の
  // 不変条件）。linter は scene スコープなら live lint 済みで常に検査済み、
  // folder/project では全章スキャン完了までは「未実行」。impact / AI 観点は
  // 最終実行記録（post_effect_runs）が無ければ「未実行」。
  const unrun =
    cat === "linter" ? scope.type !== "scene" && !projectScanDone : !lastIso;

  const breakdown = (["high", "mid", "low"] as const)
    .filter((sev) => counts[sev] > 0)
    .map((sev) => `${t(SEV_LABEL_KEY[sev])}${counts[sev]}`)
    .join(" · ");

  // 実行ボタン: linter は folder/project の全章スキャンのみ、impact は手動運用
  //（Codex 変更画面から）なので出さない。
  const runnable =
    cat !== "impact" && !(cat === "linter" && scope.type === "scene");

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (n > 0) setCatFilter(active ? null : cat);
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && n > 0) {
          e.preventDefault();
          setCatFilter(active ? null : cat);
        }
      }}
      className={cn(
        "rounded-lg border bg-background px-2 py-1.5 text-left",
        n > 0 ? "cursor-pointer" : "cursor-default",
        active
          ? "border-[var(--kouetsu-accent)] shadow-sm"
          : "border-border hover:border-[var(--kouetsu-accent)]/40",
      )}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="flex min-w-0 items-center gap-1">
          <CatIcon
            size={11}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="truncate text-[10.5px] font-semibold">
            {t(CAT_LABEL_KEY[cat])}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="text-[9px] text-muted-foreground">{corner}</span>
          {runnable && (
            <button
              type="button"
              disabled={running}
              title={
                unrun ? t("kouetsu.triage.run") : t("kouetsu.triage.rerun")
              }
              aria-label={`${t(CAT_LABEL_KEY[cat])}: ${unrun ? t("kouetsu.triage.run") : t("kouetsu.triage.rerun")}`}
              onClick={(e) => {
                e.stopPropagation();
                void runCategoryCheck(cat, scope);
              }}
              className="rounded p-0.5 text-[var(--kouetsu-accent)] hover:bg-[var(--kouetsu-accent-weak)] disabled:opacity-60"
            >
              {running ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <Sparkles size={10} />
              )}
            </button>
          )}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        {n > 0 ? (
          <>
            <span
              className={cn(
                "text-lg font-bold leading-tight tabular-nums",
                worst ? SEV_TEXT_CLASS[worst] : "",
              )}
            >
              {n}
            </span>
            <span className="truncate text-[9px] text-muted-foreground">
              {breakdown}
            </span>
          </>
        ) : unrun ? (
          <>
            <span className="text-sm font-bold leading-tight text-muted-foreground/50">
              —
            </span>
            <span className="text-[9px] text-muted-foreground/70">
              {t("kouetsu.triage.neverRun")}
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1 py-0.5">
            <CheckCircle2 size={13} className="text-[var(--kouetsu-ok)]" />
            <span className="text-[9px] font-medium text-[var(--kouetsu-ok)]">
              {cat === "impact"
                ? t("kouetsu.triage.noImpact")
                : t("kouetsu.triage.ok")}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
