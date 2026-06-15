import i18next from "@/lib/i18n";
import type { AiUsageSurface } from "./recordAiUsage";

/**
 * AI usage サーフェスの既知キー一覧 (集計 UI 用)。
 * recordAiUsage.ts の AiUsageSurface と 1:1 で対応させること。
 * 表示ラベルは settings.usage.surface.<surface> から i18n 解決する。
 */
const KNOWN_SURFACES: AiUsageSurface[] = [
  "chat",
  "agent",
  "map_branch",
  "tree_scaffold",
  "beat",
  "beat_role",
  "foreshadow",
  "inline_ai",
  "synopsis",
  "session_title",
  "summarization",
  "context_creator",
];

const KNOWN_SURFACE_SET = new Set<string>(KNOWN_SURFACES);

/**
 * サーフェスの表示ラベルを返す。既知サーフェスは i18n 解決し、
 * 未知サーフェスはキーをそのまま返す (前方互換)。
 */
export function surfaceLabel(surface: string): string {
  if (KNOWN_SURFACE_SET.has(surface)) {
    return i18next.t(`settings.usage.surface.${surface}`);
  }
  return surface;
}
