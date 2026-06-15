import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  getProjectUsageSummary,
  type ProjectUsageSummary,
} from "@/features/ai-usage/usageQuery";
import { surfaceLabel } from "@/features/ai-usage/usageLabels";
import { formatCost } from "@/features/chat/modelPricing";

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatCostMaybeEstimated(usd: number, estimated: boolean): string {
  if (usd <= 0) return "—";
  return `${estimated ? "≈" : ""}${formatCost(usd)}`;
}

/**
 * prompt cache の「読込率」= read / (read + write)。1 に近いほどキャッシュが効いて
 * いる (= 同じ prefix を読めている)。低い = 毎ターン書き直し。ただし provider 切替
 * 由来か TTL(5分)切れ由来かはこの集計では区別できない (時系列を見る必要がある)。
 */
function cacheReadRatio(read: number, write: number): string {
  const total = read + write;
  if (total <= 0) return "—";
  return `${Math.round((read / total) * 100)}%`;
}

export function UsageCategory() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<ProjectUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // 集計の読み取りは書き込み側 (recordAiUsage) と同一の projectId 源 (tree store)
  // を使う。別アクセサ (getCurrentProjectId) と取り違えると台帳は埋まるのに UI が
  // 空という silent failure になるため、write/read を 1 つの源に揃える。
  const projectId = useTreeStore((s) => s.projectId);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getProjectUsageSummary(projectId)
      .then((s) => {
        if (alive) setSummary(s);
      })
      .catch(() => {
        if (alive) setSummary(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        <p className="mb-4 text-xs text-muted-foreground">
          {t("settings.usage.summaryIntro")}{" "}
          {t("settings.usage.costDisclaimer")}
        </p>

        {loading && (
          <div className="text-sm text-muted-foreground">
            {t("common.loading")}
          </div>
        )}

        {!loading && summary && summary.totalCount === 0 && (
          <div className="text-sm text-muted-foreground">
            {t("settings.usage.noRecords")}
          </div>
        )}

        {!loading && summary && summary.totalCount > 0 && (
          <>
            <SettingSection title={t("settings.usage.total")}>
              <SettingRow label={t("settings.usage.generationCount")}>
                <span className="text-sm tabular-nums text-foreground">
                  {summary.totalCount.toLocaleString()}
                </span>
              </SettingRow>
              <SettingRow label={t("settings.usage.inputTokens")}>
                <span className="text-sm tabular-nums text-foreground">
                  {formatTokens(summary.totalTokensIn)}
                </span>
              </SettingRow>
              <SettingRow label={t("settings.usage.outputTokens")}>
                <span className="text-sm tabular-nums text-foreground">
                  {formatTokens(summary.totalTokensOut)}
                </span>
              </SettingRow>
              <SettingRow
                label={t("settings.usage.estimatedCost")}
                description={
                  summary.anyCostEstimated
                    ? t("settings.usage.costEstimatedNote")
                    : undefined
                }
              >
                <span className="text-sm tabular-nums text-foreground">
                  {formatCostMaybeEstimated(
                    summary.totalCostUsd,
                    summary.anyCostEstimated,
                  )}
                </span>
              </SettingRow>
              {summary.unmeteredCount > 0 && (
                <SettingRow
                  label={t("settings.usage.unmeteredCount")}
                  description={t("settings.usage.unmeteredDesc")}
                >
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {summary.unmeteredCount.toLocaleString()}
                  </span>
                </SettingRow>
              )}
            </SettingSection>

            {summary.totalCacheReadTokens + summary.totalCacheWriteTokens >
              0 && (
              <SettingSection title={t("settings.usage.promptCache")}>
                <SettingRow
                  label={t("settings.usage.cacheReadRatio")}
                  description={t("settings.usage.cacheReadRatioDesc")}
                >
                  <span className="text-sm tabular-nums text-foreground">
                    {cacheReadRatio(
                      summary.totalCacheReadTokens,
                      summary.totalCacheWriteTokens,
                    )}
                  </span>
                </SettingRow>
                <SettingRow
                  label={t("settings.usage.cacheReadTokens")}
                  description={t("settings.usage.cacheReadTokensDesc")}
                >
                  <span className="text-sm tabular-nums text-foreground">
                    {formatTokens(summary.totalCacheReadTokens)}
                  </span>
                </SettingRow>
                <SettingRow
                  label={t("settings.usage.cacheWriteTokens")}
                  description={t("settings.usage.cacheWriteTokensDesc")}
                >
                  <span className="text-sm tabular-nums text-foreground">
                    {formatTokens(summary.totalCacheWriteTokens)}
                  </span>
                </SettingRow>
              </SettingSection>
            )}

            <SettingSection title={t("settings.usage.bySurface")}>
              {summary.bySurface.map((s) => (
                <SettingRow
                  key={s.surface}
                  label={t(
                    `settings.usage.surface.${s.surface}`,
                    surfaceLabel(s.surface),
                  )}
                  description={t("settings.usage.surfaceRowDesc", {
                    count: s.count.toLocaleString(),
                    tokensIn: formatTokens(s.tokensIn),
                    tokensOut: formatTokens(s.tokensOut),
                  })}
                >
                  <span className="text-sm tabular-nums text-foreground">
                    {formatCostMaybeEstimated(s.costUsd, s.costEstimated)}
                  </span>
                </SettingRow>
              ))}
            </SettingSection>
          </>
        )}
      </div>
    </div>
  );
}
