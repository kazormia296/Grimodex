import i18next from "@/lib/i18n";
import type { AiUsageSurface } from "./recordAiUsage";

/**
 * AI usage サーフェスの既知キー一覧 (集計 UI 用)。
 * recordAiUsage.ts の AiUsageSurface と 1:1 で対応させること。
 * 表示ラベルは settings.usage.surface.<surface> から i18n 解決する。
 *
 * `satisfies Record<AiUsageSurface, true>` で網羅性をコンパイル時に強制する。
 * AiUsageSurface に union メンバを足してここに鍵を足し忘れると TS エラーになる
 * (membership だけでなく exhaustiveness を保証する)。
 * 表示順は他コードが依存しうるためオブジェクトリテラルの記述順から導出する。
 */
const SURFACE_KEYS = {
  chat: true,
  agent: true,
  map_branch: true,
  tree_scaffold: true,
  beat: true,
  beat_role: true,
  foreshadow: true,
  inline_ai: true,
  synopsis: true,
  session_title: true,
  summarization: true,
  context_creator: true,
  codex_judgment: true,
  codex_yomi: true,
  plot_thread_extract: true,
  chronicle_extract: true,
  narrative_observation_extract: true,
  narrative_event_synthesize: true,
  narrative_entity_resolve: true,
  narrative_relation_synthesize: true,
  narrative_state_synthesize: true,
  narrative_phase_synthesize: true,
  narrative_detail_compose: true,
  narrative_structured_repair: true,
} satisfies Record<AiUsageSurface, true>;

export const KNOWN_SURFACES = Object.keys(SURFACE_KEYS) as AiUsageSurface[];

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
