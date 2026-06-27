import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";
import { PanelHeader } from "@/features/layout/PanelHeader";
import { useTreeStore } from "@/features/tree/treeStore";
import { BreakdownBar } from "@/features/attribution/BreakdownBar";
import { ATTRIBUTION_COLOR_VARS } from "@/features/attribution/attributionColors";
import { formatCost } from "@/features/chat/modelPricing";
import { computeWritingStats, buildHeatmap } from "./deriveStats";
import {
  loadWritingStatsData,
  type WritingStatsData,
} from "./writingStatsQuery";
import { Heatmap } from "./Heatmap";
import { DailyGoalProgress } from "./DailyGoalProgress";
import { FinishLinePacemaker } from "./FinishLinePacemaker";

export function WritingStatsPanel({ isActive = true }: SlotPanelProps = {}) {
  const { t } = useTranslation();
  const projectId = useTreeStore((s) => s.projectId);
  const nodes = useTreeStore((s) => s.nodes);
  const charCounts = useTreeStore((s) => s.charCounts);

  const sceneIds = useMemo(
    () => nodes.filter((n) => n.nodeType === "scene").map((n) => n.id),
    [nodes],
  );
  const sceneIdsKey = sceneIds.join(",");

  // 完走ペースメーカーの分子＝現在の原稿総文字数。live な charCounts マップ
  // （シーンごとの net 文字数キャッシュ）をシーンぶん合計する。
  const currentChars = useMemo(
    () => sceneIds.reduce((sum, id) => sum + (charCounts[id] ?? 0), 0),
    [sceneIds, charCounts],
  );

  const [data, setData] = useState<WritingStatsData | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    // keepalive: hidden の間は集計クエリ（payload の JSON parse を含む）を bail。
    // 再アクティブ化で deps 経由に最新を読み直す。
    if (!isActive || !projectId) return;
    let cancelled = false;
    const at = Date.now();
    setLoading(true);
    loadWritingStatsData(projectId, sceneIds, at)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setNow(at);
      })
      .catch((err: unknown) => {
        console.warn("[writing-stats] load failed", err);
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // sceneIdsKey で scene 追加/削除に追従（sceneIds 参照は毎回変わるため除外）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, projectId, sceneIdsKey, reloadToken]);

  const stats = useMemo(
    () => (data ? computeWritingStats(data.events, now) : null),
    [data, now],
  );
  const heatmap = useMemo(
    () => (stats ? buildHeatmap(stats, now) : null),
    [stats, now],
  );

  const handleRefresh = useCallback(() => setReloadToken((n) => n + 1), []);

  const unit = stats?.hasCharData
    ? t("writingStats.charsUnit")
    : t("writingStats.eventsUnit");
  const fmt = (n: number) => `${n.toLocaleString()}${unit}`;

  return (
    <div className="flex h-full flex-col" data-testid="writing-stats-panel">
      <PanelHeader
        panelId="writing-stats"
        actions={
          <button
            type="button"
            onClick={handleRefresh}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-accent"
            title={t("writingStats.refresh")}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto p-3">
        {!stats || stats.totalEvents === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("writingStats.noData")}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {/* サマリ */}
            <div className="grid grid-cols-2 gap-2">
              <StatCard
                label={t("writingStats.streak")}
                value={t("writingStats.days", { count: stats.currentStreak })}
                accent
              />
              <StatCard
                label={t("writingStats.today")}
                value={fmt(
                  stats.hasCharData ? stats.todayChars : stats.todayEvents,
                )}
              />
              <StatCard
                label={t("writingStats.last7")}
                value={fmt(
                  stats.hasCharData ? stats.last7Chars : stats.last7Events,
                )}
              />
              <StatCard
                label={t("writingStats.last30")}
                value={fmt(
                  stats.hasCharData ? stats.last30Chars : stats.last30Events,
                )}
              />
              <StatCard
                label={t("writingStats.longestStreak")}
                value={t("writingStats.days", { count: stats.longestStreak })}
              />
              <StatCard
                label={t("writingStats.activeDays")}
                value={t("writingStats.days", { count: stats.activeDays })}
              />
            </div>

            {/* 本日の目標 */}
            <DailyGoalProgress
              todayChars={stats.todayChars}
              hasCharData={stats.hasCharData}
            />

            {/* 完走ペースメーカー（残量 ÷ 直近の暦日平均ペース → 完走予定日） */}
            <FinishLinePacemaker
              currentChars={currentChars}
              pace={stats.last30Chars / 30}
              hasCharData={stats.hasCharData}
              now={now}
            />

            {/* ヒートマップ */}
            {heatmap && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {t("writingStats.heatmap")}
                </p>
                <Heatmap heatmap={heatmap} />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {stats.hasCharData
                    ? t("writingStats.heatmapActivityNote")
                    : t("writingStats.heatmapEventsNote")}
                </p>
              </div>
            )}

            {/* 文字数の内訳（人間/AI/不明） */}
            {data && data.attribution.total > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {t("writingStats.breakdown")}
                </p>
                <BreakdownBar
                  human={data.attribution.human}
                  ai={data.attribution.ai}
                  unknown={data.attribution.unknown}
                  total={data.attribution.total}
                />
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                  <LegendRow
                    color={ATTRIBUTION_COLOR_VARS.human}
                    label={t("writingStats.human")}
                    value={data.attribution.human}
                    total={data.attribution.total}
                  />
                  <LegendRow
                    color={ATTRIBUTION_COLOR_VARS.ai}
                    label={t("writingStats.ai")}
                    value={data.attribution.ai}
                    total={data.attribution.total}
                  />
                  <LegendRow
                    color={ATTRIBUTION_COLOR_VARS.unknown}
                    label={t("writingStats.unknown")}
                    value={data.attribution.unknown}
                    total={data.attribution.total}
                  />
                </div>
              </div>
            )}

            {/* AI 使用量（要約） */}
            {data?.usage && data.usage.totalCount > 0 && (
              <div className="flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
                <span>{t("writingStats.aiUsage")}</span>
                <span className="tabular-nums">
                  {t("writingStats.generationCount", {
                    count: data.usage.totalCount,
                  })}
                  {data.usage.totalCostUsd > 0 &&
                    ` · ${data.usage.anyCostEstimated ? "≈" : ""}${formatCost(
                      data.usage.totalCostUsd,
                    )}`}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded border border-border bg-card px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-0.5 text-base font-semibold tabular-nums ${accent ? "text-primary" : "text-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}

function LegendRow({
  color,
  label,
  value,
  total,
}: {
  color: string;
  label: string;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block h-2 w-2 rounded-[2px]"
        style={{ backgroundColor: color }}
      />
      {label} {pct}%
    </span>
  );
}
