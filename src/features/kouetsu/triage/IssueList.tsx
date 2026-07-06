import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CircleDot, EyeOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { DisablesView } from "@/features/lint/LintDisablesView";
import { useKouetsuStore } from "../kouetsuStore";
import { useResolvedKouetsuScope } from "../useResolvedKouetsuScope";
import { CAT_LABEL_KEY } from "./catalog";
import { canFixNow } from "./issueActions";
import { groupByCat, type UnifiedIssue } from "./issueModel";
import { IssueRow } from "./IssueRow";

/**
 * リストツールバー + 統合トリアージリスト本体（デザイン 1b / 2a）。
 * - pills「開いている N / 除外 N」= ステータスフィルタ（件数は表示実数）。
 * - 観点フィルタ chip（ダッシュボードタイル由来）。
 * - dashboardOn 中は観点グループ（sticky 見出し）、通常は重要度フラット。
 * - 除外ビューには校正の無効化（DisablesView）を併設する（lint の「除外」相当）。
 */
export function IssueList({
  open,
  dismissed,
  onSelect,
  onQuickFix,
  onRestore,
}: {
  open: UnifiedIssue[];
  dismissed: UnifiedIssue[];
  onSelect: (issue: UnifiedIssue) => void;
  onQuickFix: (issue: UnifiedIssue) => void;
  onRestore: (issue: UnifiedIssue) => void;
}) {
  const { t } = useTranslation();
  const scope = useResolvedKouetsuScope();
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const setStatusFilter = useKouetsuStore((s) => s.setStatusFilter);
  const catFilter = useKouetsuStore((s) => s.catFilter);
  const setCatFilter = useKouetsuStore((s) => s.setCatFilter);
  const dashboardOn = useKouetsuStore((s) => s.dashboardOn);
  const selectedIssueId = useKouetsuStore((s) => s.selectedIssueId);
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  const dismissedView = statusFilter === "dismissed";
  const base = dismissedView ? dismissed : open;
  const displayed = useMemo(
    () => (catFilter ? base.filter((i) => i.cat === catFilter) : base),
    [base, catFilter],
  );

  const sceneTitleOf = useMemo(() => {
    const map = new Map(nodes.map((n) => [n.id, n.title] as const));
    return (sceneId: string | null) =>
      sceneId ? (map.get(sceneId) ?? null) : null;
  }, [nodes]);

  const sortLabel = dismissedView
    ? t("kouetsu.triage.sort.dismissed")
    : dashboardOn
      ? t("kouetsu.triage.sort.grouped")
      : t("kouetsu.triage.sort.severity");

  const renderRow = (issue: UnifiedIssue) => (
    <IssueRow
      key={issue.id}
      issue={issue}
      selected={selectedIssueId === issue.id}
      sceneTag={scope.type !== "scene" ? sceneTitleOf(issue.sceneId) : null}
      fixNow={canFixNow(issue, activeSceneId || null)}
      dismissedView={dismissedView}
      onSelect={() => onSelect(issue)}
      onQuickFix={() => onQuickFix(issue)}
      onRestore={() => onRestore(issue)}
    />
  );

  return (
    <>
      {/* ── ツールバー ── */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/20 px-2.5 py-1">
        <div className="flex gap-0.5">
          <button
            type="button"
            aria-pressed={!dismissedView}
            onClick={() => setStatusFilter("open")}
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] tabular-nums",
              !dismissedView
                ? "bg-[var(--kouetsu-accent-weak)] font-semibold text-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            <CircleDot size={10} className="shrink-0" />
            {t("kouetsu.filter.open")} {open.length}
          </button>
          <button
            type="button"
            aria-pressed={dismissedView}
            onClick={() => setStatusFilter("dismissed")}
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] tabular-nums",
              dismissedView
                ? "bg-[var(--kouetsu-accent-weak)] font-semibold text-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            <EyeOff size={10} className="shrink-0" />
            {t("kouetsu.filter.dismissed")} {dismissed.length}
          </button>
        </div>
        {catFilter && (
          <button
            type="button"
            onClick={() => setCatFilter(null)}
            className="flex items-center gap-1 rounded-full border border-[var(--kouetsu-accent)]/30 bg-[var(--kouetsu-accent-weak)] px-2 py-px text-[10px] font-semibold text-[var(--kouetsu-accent)]"
          >
            {t("kouetsu.triage.catFilter", {
              label: t(CAT_LABEL_KEY[catFilter]),
            })}
            <X size={9} />
          </button>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {sortLabel}
        </span>
      </div>

      {/* ── リスト本体 ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {displayed.length === 0 ? (
          <p className="px-3 py-5 text-center text-[11px] text-muted-foreground">
            {dismissedView
              ? t("kouetsu.triage.emptyDismissed")
              : t("kouetsu.triage.emptyOpen")}
          </p>
        ) : dashboardOn && !dismissedView ? (
          groupByCat(displayed).map(({ cat, items }) => (
            <div key={cat}>
              <div className="sticky top-0 z-[5] flex items-center gap-1.5 border-b border-border bg-muted/60 px-2.5 py-0.5 backdrop-blur-sm">
                <span className="text-[10px] font-bold text-foreground">
                  {t(CAT_LABEL_KEY[cat])}
                </span>
                <span className="rounded-full bg-muted px-1.5 py-px text-[9px] font-semibold text-muted-foreground tabular-nums">
                  {items.length}
                </span>
              </div>
              {items.map(renderRow)}
            </div>
          ))
        ) : (
          displayed.map(renderRow)
        )}
        {/* lint の「除外」相当（無効化 directive）は annotation と別機構のため、
            除外ビューの下に既存 DisablesView をそのまま併設する。 */}
        {dismissedView && (!catFilter || catFilter === "linter") && (
          <div className="border-t border-border">
            <div className="bg-muted/40 px-2.5 py-1 text-[10px] font-bold text-muted-foreground">
              {t("kouetsu.triage.lintDisables")}
            </div>
            <DisablesView />
          </div>
        )}
      </div>
    </>
  );
}
