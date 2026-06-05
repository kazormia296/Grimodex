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

            {summary.totalCacheReadTokens + summary.totalCacheWriteTokens >
              0 && (
              <SettingSection title="プロンプトキャッシュ">
                <SettingRow
                  label="読込率"
                  description="読込 / (読込+書込)。高いほどキャッシュが効いている。低い場合は provider 切替か TTL(5分)切れ — この集計では区別できません"
                >
                  <span className="text-sm tabular-nums text-foreground">
                    {cacheReadRatio(
                      summary.totalCacheReadTokens,
                      summary.totalCacheWriteTokens,
                    )}
                  </span>
                </SettingRow>
                <SettingRow
                  label="読込トークン"
                  description="キャッシュから読めた入力 (節約側)"
                >
                  <span className="text-sm tabular-nums text-foreground">
                    {formatTokens(summary.totalCacheReadTokens)}
                  </span>
                </SettingRow>
                <SettingRow
                  label="書込トークン"
                  description="キャッシュへ書いた入力 (初回/期限切れ。コスト側で節約ではない)"
                >
                  <span className="text-sm tabular-nums text-foreground">
                    {formatTokens(summary.totalCacheWriteTokens)}
                  </span>
                </SettingRow>
              </SettingSection>
            )}

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
