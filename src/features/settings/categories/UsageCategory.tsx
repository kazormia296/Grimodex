import { useEffect, useState } from "react";
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

export function UsageCategory() {
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
          このプロジェクトの AI 生成によるトークン使用量とおおよそのコストです。
          コストは料金表 (modelPricing)
          からの概算で、課金額そのものではありません。
        </p>

        {loading && (
          <div className="text-sm text-muted-foreground">読み込み中…</div>
        )}

        {!loading && summary && summary.totalCount === 0 && (
          <div className="text-sm text-muted-foreground">
            まだ AI 生成の記録がありません。
          </div>
        )}

        {!loading && summary && summary.totalCount > 0 && (
          <>
            <SettingSection title="合計">
              <SettingRow label="生成回数">
                <span className="text-sm tabular-nums text-foreground">
                  {summary.totalCount.toLocaleString()}
                </span>
              </SettingRow>
              <SettingRow label="入力トークン">
                <span className="text-sm tabular-nums text-foreground">
                  {formatTokens(summary.totalTokensIn)}
                </span>
              </SettingRow>
              <SettingRow label="出力トークン">
                <span className="text-sm tabular-nums text-foreground">
                  {formatTokens(summary.totalTokensOut)}
                </span>
              </SettingRow>
              <SettingRow
                label="推定コスト"
                description={
                  summary.anyCostEstimated
                    ? "一部はトークン数からの概算 (≈) を含みます"
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
                  label="トークン未取得"
                  description="ストリーミングで usage が届かなかった生成 (回数のみ計上)"
                >
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {summary.unmeteredCount.toLocaleString()}
                  </span>
                </SettingRow>
              )}
            </SettingSection>

            <SettingSection title="サーフェス別">
              {summary.bySurface.map((s) => (
                <SettingRow
                  key={s.surface}
                  label={surfaceLabel(s.surface)}
                  description={`${s.count.toLocaleString()} 回 · 入力 ${formatTokens(
                    s.tokensIn,
                  )} / 出力 ${formatTokens(s.tokensOut)}`}
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
