import { useTranslation } from "react-i18next";
import { ArrowRight, MoveRight, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  CAT_LABEL_KEY,
  SEV_CHIP_CLASS,
  SEV_LABEL_KEY,
  issueMetaLabel,
  relativeTimeLabel,
} from "./catalog";
import { canClose, canFixNow } from "./issueActions";
import type { UnifiedIssue } from "./issueModel";

/**
 * トリアージカード（デザイン 1f / 2a）: 行選択時にステージへ出る詳細カード。
 * タイトル + Codex/本文の対比 + 置換提案 + 引用と、判断アクション
 * （本文へ / Fix / 解決 / 無視 / あとで）を 1 枚に集約する。
 * 解決/無視/Fix/あとでの遷移（advanceFrom）は親（IssuesInbox）が握る。
 */
export function TriageCard({
  issue,
  onJump,
  onFix,
  onResolve,
  onDismiss,
  onLater,
  onClose,
}: {
  issue: UnifiedIssue;
  onJump: () => void;
  onFix: () => void;
  onResolve: () => void;
  onDismiss: () => void;
  onLater: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const metaLabel = issueMetaLabel(issue.meta);
  const agoLabel = issue.createdAt
    ? relativeTimeLabel(issue.createdAt, new Date())
    : null;
  const closable = canClose(issue);
  const fixNow = canFixNow(issue, activeSceneId || null);

  const compareLabels =
    issue.cat === "impact"
      ? {
          left: t("kouetsu.triage.compare.change"),
          right: t("kouetsu.triage.compare.body"),
        }
      : {
          left: t("kouetsu.triage.compare.codex"),
          right: t("kouetsu.triage.compare.body"),
        };

  return (
    <div className="shrink-0 border-b border-border bg-muted/20 p-2">
      <div className="overflow-hidden rounded-lg border border-[var(--kouetsu-accent)]/25 bg-background shadow-md">
        {/* ── ヘッダ: 観点チップ + メタ + 検出時期 + 閉じる ── */}
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-2.5 py-1.5">
          <span
            className={cn(
              "rounded px-1.5 py-px text-[10px] font-bold",
              SEV_CHIP_CLASS[issue.sev],
            )}
          >
            {t(CAT_LABEL_KEY[issue.cat])} · {t(SEV_LABEL_KEY[issue.sev])}
          </span>
          {metaLabel && (
            <span className="truncate text-[10px] text-muted-foreground">
              {metaLabel}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/70">
            {agoLabel ?? ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("kouetsu.progressToast.close")}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>

        {/* ── 本文 ── */}
        <div className="max-h-44 overflow-y-auto px-2.5 py-2">
          <p className="text-xs font-semibold leading-relaxed">{issue.title}</p>
          {issue.compare && (
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
                <div className="mb-0.5 text-[8.5px] font-bold tracking-wide text-muted-foreground">
                  {compareLabels.left}
                </div>
                <div className="text-[11px] leading-relaxed">
                  {issue.compare.left}
                </div>
              </div>
              <div className="rounded-md border border-[var(--kouetsu-chip-high-bg)] bg-[var(--kouetsu-mark-high)]/40 px-2 py-1.5">
                <div className="mb-0.5 text-[8.5px] font-bold tracking-wide text-[var(--kouetsu-chip-high-fg)]">
                  {compareLabels.right}
                </div>
                <div className="text-[11px] leading-relaxed">
                  {issue.compare.right}
                </div>
              </div>
            </div>
          )}
          {issue.suggest && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs">
              <span className="text-[var(--kouetsu-chip-high-fg)] line-through">
                {issue.suggest.found}
              </span>
              <MoveRight size={12} className="text-muted-foreground" />
              <span className="font-bold text-[var(--kouetsu-ok)]">
                {issue.suggest.suggestion}
              </span>
            </div>
          )}
          {issue.quote && (
            <blockquote className="mt-2 border-l-2 border-border py-0.5 pl-2 text-[11px] leading-relaxed text-muted-foreground">
              {issue.quote}
            </blockquote>
          )}
        </div>

        {/* ── アクション ── */}
        <div className="flex items-center gap-1 border-t border-border bg-muted/30 px-2.5 py-1.5">
          <button
            type="button"
            onClick={onJump}
            className="rounded-md bg-[var(--kouetsu-accent)] px-2 py-1 text-[10.5px] font-bold text-white hover:bg-[var(--kouetsu-accent-hover)]"
          >
            {t("kouetsu.triage.card.jump")}
          </button>
          {fixNow && (
            <button
              type="button"
              onClick={onFix}
              title={t("kouetsu.triage.card.fixTitle")}
              className="flex items-center gap-1 rounded-md border border-[var(--kouetsu-accent)]/30 bg-background px-2 py-1 text-[10.5px] font-bold text-[var(--kouetsu-accent)] hover:bg-[var(--kouetsu-accent-weak)]"
            >
              <Wrench size={10} />
              Fix
            </button>
          )}
          {closable && (
            <>
              <button
                type="button"
                onClick={onResolve}
                className="rounded-md border border-border bg-background px-2 py-1 text-[10.5px] font-semibold text-foreground hover:bg-accent"
              >
                {t("kouetsu.triage.card.resolve")}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-md border border-border bg-background px-2 py-1 text-[10.5px] font-semibold text-foreground hover:bg-accent"
              >
                {t("kouetsu.triage.card.dismiss")}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onLater}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] font-semibold text-muted-foreground hover:text-[var(--kouetsu-accent)]"
          >
            {t("kouetsu.triage.card.later")}
            <ArrowRight size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}
