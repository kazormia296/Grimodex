import type { AiUsageSurface } from "./recordAiUsage";

/**
 * AI usage サーフェスの表示ラベル (集計 UI 用)。
 * recordAiUsage.ts の AiUsageSurface と 1:1 で対応させること。
 */
export const SURFACE_LABELS: Record<AiUsageSurface, string> = {
  chat: "チャット",
  agent: "エージェント",
  map_branch: "Map AI Branch",
  tree_scaffold: "Tree 生成",
  beat: "Beat 生成",
  beat_role: "Beat 役割推論",
  foreshadow: "伏線",
  inline_ai: "インライン AI",
  synopsis: "あらすじ生成",
  session_title: "セッションタイトル",
  summarization: "要約",
  context_creator: "Context Creator",
};

/** 未知サーフェスはキーをそのまま返す (前方互換)。 */
export function surfaceLabel(surface: string): string {
  return (SURFACE_LABELS as Record<string, string>)[surface] ?? surface;
}
