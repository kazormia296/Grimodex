import { useCallback, useEffect, useMemo } from "react";
import { useKouetsuStore } from "./kouetsuStore";
import { useFullCheckStore } from "./fullCheckStore";
import { TriageHeader } from "./triage/TriageHeader";
import { SummaryStage } from "./triage/SummaryStage";
import { DashboardStage } from "./triage/DashboardStage";
import { PipelineStage } from "./triage/PipelineStage";
import { TriageCard } from "./triage/TriageCard";
import { IssueList } from "./triage/IssueList";
import { TriageFooter } from "./triage/TriageFooter";
import { useOnRunSettled, useUnifiedIssues } from "./triage/useUnifiedIssues";
import { useEffectLastRuns } from "./triage/useEffectLastRuns";
import {
  advanceFrom,
  CAT_ORDER,
  deriveSevCounts,
  groupByCat,
  type UnifiedIssue,
} from "./triage/issueModel";
import { catLastRunIso, relativeTimeLabel } from "./triage/catalog";
import {
  dismissIssue,
  fixIssue,
  jumpToIssue,
  resolveIssue,
  restoreIssue,
} from "./triage/issueActions";

/**
 * 指摘タブ = 統合トリアージ（デザイン 2a）。8 観点の指摘を 1 本の重要度順
 * リストに統合し、上部ステージを排他 4 モードで切り替える:
 *   triage（行選択時のカード） > pipeline（全体チェック中〜閉じるまで）
 *   > dashboard（観点タイル） > summary（既定の件数サマリー）。
 * 旧・8 セクション縦積み（InboxSection）はこのリワークで置換された。
 */
export function IssuesInbox() {
  const { open, dismissed, refresh } = useUnifiedIssues();
  const { lastRuns, refresh: refreshLastRuns } = useEffectLastRuns();

  const selectedIssueId = useKouetsuStore((s) => s.selectedIssueId);
  const setSelectedIssueId = useKouetsuStore((s) => s.setSelectedIssueId);
  const dashboardOn = useKouetsuStore((s) => s.dashboardOn);
  const catFilter = useKouetsuStore((s) => s.catFilter);
  const runState = useFullCheckStore((s) => s.runState);
  const pipelineVisible = useFullCheckStore((s) => s.pipelineVisible);
  const lastFinishedAt = useFullCheckStore((s) => s.lastFinishedAt);

  // run 終端（全体チェックの各観点・タイル単発とも）で最終実行時刻を追従。
  useOnRunSettled(refreshLastRuns);

  const selectedIssue = useMemo(
    () =>
      selectedIssueId
        ? (open.find((i) => i.id === selectedIssueId) ?? null)
        : null,
    [open, selectedIssueId],
  );

  // トリアージの「次へ」順序 = リストの表示順（観点フィルタ・グループ順を反映）。
  const displayOrder = useMemo(() => {
    const filtered = catFilter ? open.filter((i) => i.cat === catFilter) : open;
    const ordered = dashboardOn
      ? groupByCat(filtered).flatMap((g) => g.items)
      : filtered;
    return ordered.map((i) => i.id);
  }, [open, catFilter, dashboardOn]);

  const advance = useCallback(
    (issueId: string, removed: boolean) => {
      setSelectedIssueId(advanceFrom(displayOrder, issueId, removed));
    },
    [displayOrder, setSelectedIssueId],
  );

  const handleSelect = useCallback(
    (issue: UnifiedIssue) => {
      setSelectedIssueId(selectedIssueId === issue.id ? null : issue.id);
    },
    [selectedIssueId, setSelectedIssueId],
  );

  const handleResolve = useCallback(
    async (issue: UnifiedIssue) => {
      const ok = await resolveIssue(issue);
      if (ok) {
        advance(issue.id, true);
        refresh();
      }
    },
    [advance, refresh],
  );

  const handleDismiss = useCallback(
    async (issue: UnifiedIssue) => {
      const ok = await dismissIssue(issue);
      if (ok) {
        advance(issue.id, true);
        refresh();
      }
    },
    [advance, refresh],
  );

  const handleFix = useCallback(
    async (issue: UnifiedIssue, fromCard: boolean) => {
      const ok = await fixIssue(issue);
      if (ok) {
        if (fromCard) advance(issue.id, true);
        refresh();
      }
    },
    [advance, refresh],
  );

  const handleRestore = useCallback(
    async (issue: UnifiedIssue) => {
      const ok = await restoreIssue(issue);
      if (ok) refresh();
    },
    [refresh],
  );

  // ステージのモード導出（優先順: triage > pipeline > dashboard > summary）。
  const mode = selectedIssue
    ? "triage"
    : pipelineVisible && runState !== "idle"
      ? "pipeline"
      : dashboardOn
        ? "dashboard"
        : "summary";

  // サマリーの「最終チェック」: 全体チェック完了時刻を優先し、無ければ
  // 観点別最終実行の最新値（アプリ再起動後も post_effect_runs から復元される）。
  const lastCheckLabel = useMemo(() => {
    let iso = lastFinishedAt;
    if (!iso) {
      for (const cat of CAT_ORDER) {
        const catIso = catLastRunIso(cat, lastRuns);
        if (catIso && (!iso || catIso > iso)) iso = catIso;
      }
    }
    return iso ? relativeTimeLabel(iso, new Date()) : null;
  }, [lastFinishedAt, lastRuns]);

  // 選択中の指摘が解決等でリストから消えたら選択を解除する（別スコープの
  // stale id がカード探索に残り続けるのを防ぐ）。
  useEffect(() => {
    if (selectedIssueId && !open.some((i) => i.id === selectedIssueId)) {
      setSelectedIssueId(null);
    }
  }, [open, selectedIssueId, setSelectedIssueId]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TriageHeader />
      {mode === "triage" && selectedIssue && (
        <TriageCard
          issue={selectedIssue}
          onJump={() => jumpToIssue(selectedIssue)}
          onFix={() => void handleFix(selectedIssue, true)}
          onResolve={() => void handleResolve(selectedIssue)}
          onDismiss={() => void handleDismiss(selectedIssue)}
          onLater={() => advance(selectedIssue.id, false)}
          onClose={() => setSelectedIssueId(null)}
        />
      )}
      {mode === "pipeline" && <PipelineStage open={open} />}
      {mode === "dashboard" && (
        <DashboardStage open={open} lastRuns={lastRuns} />
      )}
      {mode === "summary" && (
        <SummaryStage
          counts={deriveSevCounts(open)}
          lastCheckLabel={lastCheckLabel}
        />
      )}
      <IssueList
        open={open}
        dismissed={dismissed}
        onSelect={handleSelect}
        onQuickFix={(issue) => void handleFix(issue, false)}
        onRestore={(issue) => void handleRestore(issue)}
      />
      <TriageFooter lastRuns={lastRuns} />
    </div>
  );
}
