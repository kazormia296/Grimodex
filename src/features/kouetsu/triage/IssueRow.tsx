import { useTranslation } from "react-i18next";
import { MoveRight, RotateCcw, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CAT_LABEL_KEY,
  SEV_CHIP_CLASS,
  SEV_MARK_CLASS,
  SEV_RAIL_CLASS,
  issueMetaLabel,
} from "./catalog";
import type { UnifiedIssue } from "./issueModel";

/**
 * 統合トリアージリストの 1 行（デザイン 1b / 2a）。左レール = 重大度、
 * チップ = 観点（重大度色）、メタ（rule_id / Codex 参照等）、タイトル、
 * 抜粋（該当箇所を <mark>）。open 行はクリックでトリアージカードを開き、
 * Fix 可能なら行内クイック Fix。dismissed 行は「再表示」のみ。
 */
export function IssueRow({
  issue,
  selected,
  sceneTag,
  fixNow,
  dismissedView,
  onSelect,
  onQuickFix,
  onRestore,
}: {
  issue: UnifiedIssue;
  selected: boolean;
  /** scope≠scene のときのシーン名タグ（null で非表示）。 */
  sceneTag: string | null;
  /** 行内クイック Fix を出すか（対象シーンがアクティブな fixable 行）。 */
  fixNow: boolean;
  dismissedView: boolean;
  onSelect: () => void;
  onQuickFix: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  const metaLabel = issueMetaLabel(issue.meta);

  return (
    <div
      role={dismissedView ? undefined : "button"}
      tabIndex={dismissedView ? undefined : 0}
      aria-pressed={dismissedView ? undefined : selected}
      onClick={dismissedView ? undefined : onSelect}
      onKeyDown={
        dismissedView
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
      }
      className={cn(
        "flex gap-2 border-b border-l-[3px] border-b-border px-2.5 py-2 pl-2 text-left",
        SEV_RAIL_CLASS[issue.sev],
        !dismissedView && "cursor-pointer hover:bg-accent/40",
        selected && "bg-[var(--kouetsu-accent-weak)]/50",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-px text-[9.5px] font-semibold",
              SEV_CHIP_CLASS[issue.sev],
            )}
          >
            {t(CAT_LABEL_KEY[issue.cat])}
          </span>
          {metaLabel && (
            <span
              className={cn(
                "truncate text-[9.5px] text-muted-foreground",
                issue.meta?.kind === "rule" && "font-mono",
              )}
            >
              {metaLabel}
            </span>
          )}
          {sceneTag && (
            <span className="ml-auto shrink-0 truncate rounded bg-muted px-1.5 py-px text-[9px] text-muted-foreground">
              {sceneTag}
            </span>
          )}
        </div>
        <span className="text-xs font-medium leading-relaxed">
          {issue.title}
        </span>
        {issue.suggest ? (
          <span className="flex items-center gap-1.5 truncate text-[10.5px]">
            <span className="text-[var(--kouetsu-chip-high-fg)] line-through">
              {issue.suggest.found}
            </span>
            <MoveRight size={10} className="shrink-0 text-muted-foreground" />
            <span className="font-semibold text-[var(--kouetsu-ok)]">
              {issue.suggest.suggestion}
            </span>
          </span>
        ) : (
          issue.excerpt && (
            <span className="truncate text-[10.5px] text-muted-foreground">
              {issue.excerpt.pre}
              <mark
                className={cn("px-0.5 text-inherit", SEV_MARK_CLASS[issue.sev])}
              >
                {issue.excerpt.mark}
              </mark>
              {issue.excerpt.post}
            </span>
          )
        )}
        {!dismissedView && fixNow && (
          <div className="mt-0.5">
            <button
              type="button"
              title={t("kouetsu.triage.card.fixTitle")}
              onClick={(e) => {
                e.stopPropagation();
                onQuickFix();
              }}
              className="flex items-center gap-1 rounded border border-[var(--kouetsu-accent)]/30 bg-background px-1.5 py-px text-[10px] font-semibold text-[var(--kouetsu-accent)] hover:bg-[var(--kouetsu-accent-weak)]"
            >
              <Wrench size={9} />
              Fix
            </button>
          </div>
        )}
      </div>
      {dismissedView && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
          className="flex shrink-0 items-center gap-1 self-center rounded border border-border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground hover:bg-accent"
        >
          <RotateCcw size={9} />
          {t("kouetsu.triage.restore")}
        </button>
      )}
    </div>
  );
}
