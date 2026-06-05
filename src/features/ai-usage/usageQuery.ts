import { db } from "@/db/client";
import { aiUsage } from "@/db/schema";
import { eq } from "drizzle-orm";
import { estimateTotalCost } from "@/features/chat/modelPricing";

export interface SurfaceUsage {
  surface: string;
  count: number;
  tokensIn: number;
  tokensOut: number;
  /** prompt cache 読込トークン合計 (cache hit)。 */
  cacheReadTokens: number;
  /** prompt cache 書込トークン合計 (cache write)。 */
  cacheWriteTokens: number;
  /** 解決済みコスト (プロバイダ実値、無ければトークンからの推定)。 */
  costUsd: number;
  /** この行群に推定コスト (プロバイダ cost が無い行) が含まれるか。 */
  costEstimated: boolean;
}

export interface ProjectUsageSummary {
  totalCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  /** prompt cache 読込トークン合計 (cache hit)。→ 多いほどキャッシュが効いている。 */
  totalCacheReadTokens: number;
  /** prompt cache 書込トークン合計 (cache write、コスト側)。 */
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  /** 集計に推定コストが混ざっているか (UI で「概算」と注記するため)。 */
  anyCostEstimated: boolean;
  /** トークン数 / cost が一切取れなかった行 (streaming で usage 未到達等)。 */
  unmeteredCount: number;
  bySurface: SurfaceUsage[];
}

/**
 * ai_usage 台帳をプロジェクト単位で集計する (N4)。
 *
 * コストは行ごとに「プロバイダ報告値 (cost_usd) があればそれを、無ければ
 * model + トークン数から modelPricing で推定」して合算する。推定が混ざった場合
 * anyCostEstimated を立て、UI 側で「概算」と明示する。
 */
export async function getProjectUsageSummary(
  projectId: string,
): Promise<ProjectUsageSummary> {
  if (!projectId) {
    return {
      totalCount: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUsd: 0,
      anyCostEstimated: false,
      unmeteredCount: 0,
      bySurface: [],
    };
  }

  const rows = await db
    .select({
      surface: aiUsage.surface,
      model: aiUsage.model,
      tokensIn: aiUsage.tokensIn,
      tokensOut: aiUsage.tokensOut,
      cacheReadTokens: aiUsage.cacheReadTokens,
      cacheWriteTokens: aiUsage.cacheWriteTokens,
      costUsd: aiUsage.costUsd,
    })
    .from(aiUsage)
    .where(eq(aiUsage.projectId, projectId));

  const bySurfaceMap = new Map<string, SurfaceUsage>();
  let totalCount = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCostUsd = 0;
  let anyCostEstimated = false;
  let unmeteredCount = 0;

  for (const r of rows) {
    const tin = r.tokensIn ?? 0;
    const tout = r.tokensOut ?? 0;
    const cread = r.cacheReadTokens ?? 0;
    const cwrite = r.cacheWriteTokens ?? 0;
    if (r.tokensIn == null && r.tokensOut == null && r.costUsd == null) {
      unmeteredCount++;
    }

    // cost: プロバイダ実値を優先、無ければトークン+model から推定。
    let cost = r.costUsd ?? null;
    let estimated = false;
    if (cost == null) {
      const est = estimateTotalCost(r.model, tin, tout);
      if (est != null) {
        cost = est;
        estimated = true;
      }
    }
    const costVal = cost ?? 0;
    if (estimated) anyCostEstimated = true;

    totalCount++;
    totalTokensIn += tin;
    totalTokensOut += tout;
    totalCacheReadTokens += cread;
    totalCacheWriteTokens += cwrite;
    totalCostUsd += costVal;

    const cur = bySurfaceMap.get(r.surface) ?? {
      surface: r.surface,
      count: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      costEstimated: false,
    };
    cur.count++;
    cur.tokensIn += tin;
    cur.tokensOut += tout;
    cur.cacheReadTokens += cread;
    cur.cacheWriteTokens += cwrite;
    cur.costUsd += costVal;
    if (estimated) cur.costEstimated = true;
    bySurfaceMap.set(r.surface, cur);
  }

  const bySurface = [...bySurfaceMap.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.tokensOut - a.tokensOut,
  );

  return {
    totalCount,
    totalTokensIn,
    totalTokensOut,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalCostUsd,
    anyCostEstimated,
    unmeteredCount,
    bySurface,
  };
}
