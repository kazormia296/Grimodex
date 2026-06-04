import { db } from "@/db/client";
import { aiUsage } from "@/db/schema";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";

/**
 * AI 生成サーフェスの識別子。1 サーフェス = 1 種類の生成エントリ点。
 * 集計 UI のサーフェス別内訳キーになる。新サーフェスを足したら
 * src/features/ai-usage/usageLabels.ts のラベルも更新すること。
 */
export type AiUsageSurface =
  | "chat" // 通常チャット (streaming / CLI)
  | "agent" // エージェント (ツールループ / RAG)
  | "map_branch" // Map AI Branch カード生成
  | "tree_scaffold" // Tree AI Scaffold (案B)
  | "beat" // Beat 本文生成
  | "beat_role" // Beat mention 役割推論
  | "foreshadow" // 伏線 (提案 / 評価 / 監査)
  | "inline_ai" // インライン AI (差分挿入)
  | "synopsis" // あらすじ生成
  | "session_title" // チャットセッションタイトル自動生成
  | "summarization" // 進行的要約 (L5)
  | "context_creator"; // Context Creator (ピン提案エージェント)

export interface RecordAiUsageInput {
  surface: AiUsageSurface;
  model?: string | null;
  /** プロバイダ識別子 ("openrouter" | "anthropic" | "cli" | ...)。任意。 */
  provider?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** プロバイダ報告コスト (USD)。OpenRouter のみ実値、他は null。 */
  costUsd?: number | null;
  durationMs?: number | null;
  sceneNodeId?: string | null;
  /** generation_logs / メッセージ等への trace 連携キー。任意。 */
  traceId?: string | null;
  /** 生成された成果物 (branch id / message id 等) への参照。任意。 */
  refId?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * プロジェクト ID の明示指定。省略時は tree store の projectId を使う。
   * チャット等、自前の projectId を持つサーフェスは明示的に渡すこと。
   */
  projectId?: string | null;
}

/**
 * AI usage ledger (N4) への 1 生成 = 1 行の記録。全 AI 生成サーフェスから呼ぶ。
 *
 * - **fail-open**: 記録失敗で生成本体を巻き込まない (best-effort)。台帳は
 *   分析用途であり、書けなくても機能を止めない。
 * - tokens / cost が null でも行は記録する。streaming で usage が来ない構成
 *   (include_usage 未対応プロバイダ・中断ストリーム) でも「呼び出し回数」を
 *   数えられるようにするため。
 */
export async function recordAiUsage(input: RecordAiUsageInput): Promise<void> {
  const projectId = input.projectId ?? useTreeStore.getState().projectId;
  if (!projectId) return;
  // model / provider は未指定なら現在の AI 設定から補完する。one-shot 生成は
  // 直前にこのモデルで送られているため、record 時点の設定で十分正確。
  const settings = useAiSettingsStore.getState().settings;
  try {
    await db.insert(aiUsage).values({
      id: crypto.randomUUID(),
      projectId,
      surface: input.surface,
      sceneNodeId: input.sceneNodeId ?? null,
      model: input.model ?? settings?.model ?? null,
      provider: input.provider ?? settings?.provider ?? null,
      tokensIn: input.tokensIn ?? null,
      tokensOut: input.tokensOut ?? null,
      costUsd: input.costUsd ?? null,
      durationMs: input.durationMs ?? null,
      traceId: input.traceId ?? null,
      refId: input.refId ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // best-effort ledger: 記録失敗は生成をブロックしない。
    console.warn("[recordAiUsage] failed to record AI usage", err);
  }
}
