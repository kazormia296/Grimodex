import { db } from "@/db/client";
import { aiUsage } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * 出所分析（provenance analytics）の概算コスト紐付けに使う ai_usage 行の最小形。
 *
 * `usageQuery.ts`（機能① 所有・編集禁止）とは別経路で、attribution feature が
 * 自前に持つ薄いリーダ。出所分析が必要とする列だけを project スコープで読む。
 * コスト推定（costUsd が null の行）は呼び出し側の純関数 rollup が
 * `estimateTotalCost` を使って行う（このファイルは I/O のみ）。
 */
export interface AiUsageCostRow {
  surface: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** プロバイダ報告コスト (USD)。OpenRouter のみ実値、他は null。 */
  costUsd: number | null;
}

/**
 * プロジェクトの ai_usage 行を概算コスト集計用に読み出す（Drizzle 経由）。
 * project_id でスコープし、列は分析に必要な最小集合に絞る。
 */
export async function loadProjectUsageCostRows(
  projectId: string,
): Promise<AiUsageCostRow[]> {
  if (!projectId) return [];
  return db
    .select({
      surface: aiUsage.surface,
      model: aiUsage.model,
      tokensIn: aiUsage.tokensIn,
      tokensOut: aiUsage.tokensOut,
      costUsd: aiUsage.costUsd,
    })
    .from(aiUsage)
    .where(eq(aiUsage.projectId, projectId));
}
