/**
 * AI モデルのロール解決層 — 各 AI 経路がどのモデルで動くかを 1 箇所で決める正本。
 *
 * 設計（docs/AIモデル経路別設定.md 参照）:
 *   - 粒度は「意味ロール」(6)。経路ごとの個別ピッカー(25)は UX 過剰として採らない。
 *     ロールは aiPrompt.custom.* の 6 バケット前例と同じ意味分類で揃える。
 *   - 空 = 既定フォールバック。ロールキーが未設定なら undefined を返し、呼び出し側は
 *     Tauri command の model 引数へ undefined/null を渡す → Rust が settings.model に
 *     フォールバックする（model.filter(非空).unwrap_or(settings.model)）。未設定時は
 *     wire payload に一切差分が出ない（byte-identical 後方互換）。
 *   - 能力ガード: ロールに必要な能力（agent=tool 対応必須）を満たさないモデルが
 *     指定された場合は override を無視して既定へフォールバックする（安全側）。
 *
 * Phase 1 ではロールキーは UI 未露出（常に空）。本層は「送信点を 1 つの解決規則へ
 * 通す」配線と、その byte-identical 性をテストで固める土台。ロール UI の露出と
 * 旧キー(ai.inlineModel / ai.sessionTitleModel)の吸収は Phase 2。
 *
 * Phase 1 配線状況（呼び出し側で resolveModelForPath を model 引数へ渡す）:
 *   - 配線済（Rust が model:Option を受理済 = FE のみ）:
 *       conversation(chat_stream_non_agent), inline(inline_ai_stream),
 *       cheap(session_title, beat_role), structured(synopsis,
 *       foreshadow_audit_chapter, foreshadow_propose_past_setups,
 *       foreshadow_evaluate_setup_strength, map_branch, tree_scaffold,
 *       codex_judgment)
 *   - Phase 2 で配線（Rust 変更が必要）:
 *       agent(chat_agent_main, agent_research_subagent, context_creator)
 *         … send_agent_message に model:Option<String> 追加が必要
 *       review(post_effect_*) … call_post_effect_api の settings.model べた書きを
 *         model_override で解決化する必要
 *       cheap(summarization) … chatStore 経由の injected callback 配線（非破壊で後追い）
 * いずれも PATH_TO_ROLE には登録済（ロール割当は確定）。未配線でも空ロール時は
 * 既定動作のままで、Phase 2 の配線追加が後方互換で乗る。
 */
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getModelCapabilities } from "./agent/modelLimits";

export type ModelRole =
  | "conversation"
  | "agent"
  | "inline"
  | "cheap"
  | "structured"
  | "review";

export const MODEL_ROLES: readonly ModelRole[] = [
  "conversation",
  "agent",
  "inline",
  "cheap",
  "structured",
  "review",
];

/** ロール設定キー（global スコープ。settings/types.ts に登録）。 */
export function roleSettingKey(role: ModelRole): string {
  return `aiModel.role.${role}`;
}

/**
 * AI 経路 ID（aiPathRegistry の AI_PATHS.id に対応）→ モデルロール。
 * ここに無い経路は「ロール対象外」。完全性は modelRouting.test.ts の
 * メタテストが aiPathRegistry と突き合わせて保証する。
 */
export const PATH_TO_ROLE: Readonly<Record<string, ModelRole>> = {
  // conversation — 本文チャット（非 agent ストリーミング）
  chat_stream_non_agent: "conversation",
  // agent — ツール対応必須
  chat_agent_main: "agent",
  agent_research_subagent: "agent",
  context_creator: "agent",
  // inline — 本文への直接生成
  inline_ai_stream: "inline",
  // cheap — 短い・高頻度・低品質要求（安価モデル誘導）
  session_title: "cheap",
  summarization: "cheap",
  beat_role: "cheap",
  // structured — JSON 構造化出力
  synopsis: "structured",
  foreshadow_audit_chapter: "structured",
  foreshadow_propose_past_setups: "structured",
  foreshadow_evaluate_setup_strength: "structured",
  map_branch: "structured",
  tree_scaffold: "structured",
  codex_judgment: "structured",
  // review — 校閲 post-effect（JSON 構造化）
  post_effect_intent_drift: "review",
  post_effect_review: "review",
  post_effect_consistency: "review",
  post_effect_timeline_consistency: "review",
  post_effect_pseudo_comment: "review",
  post_effect_impact_review: "review",
};

/**
 * 意図的にロール対象外とする経路。モデル軸が別・外部制御・ユーザー向け生成
 * サーフェスでない、のいずれか。
 *   - semantic_search / fts_search: ローカル ONNX / BM25（LLM 生成でない・別軸）
 *   - cli_chat_stream: 外部 CLI バイナリがモデルを決める
 *   - relation_injection: eval 専用経路（ユーザー導線でない）
 *   - agent_call_limit: トランスポートでなく予算ノブ（registry の同一 agent 経路）
 */
export const MODEL_ROUTING_EXCLUDED: readonly string[] = [
  "semantic_search",
  "fts_search",
  "cli_chat_stream",
  "relation_injection",
  "agent_call_limit",
];

type SettingGetter = (key: string) => string;

const defaultGetter: SettingGetter = (key) =>
  useSettingsStore.getState().get(key);

/** ロールに割り当てられたモデル（空 = 未設定 = undefined）。 */
export function resolveRoleModel(
  role: ModelRole,
  getSetting: SettingGetter = defaultGetter,
): string | undefined {
  const raw = getSetting(roleSettingKey(role)).trim();
  return raw === "" ? undefined : raw;
}

/**
 * ロールが要求する能力をモデルが満たすか。満たさなければ override は無視される。
 * Phase 1 では agent の tool 対応のみをゲートする（structured / review の JSON
 * 構造化ゲートは modelLimits に supportsStructuredJson を足してから = Phase 2）。
 */
export function isModelCapableForRole(model: string, role: ModelRole): boolean {
  if (role === "agent") return getModelCapabilities(model).supportsTools;
  return true;
}

/**
 * 経路 ID に対して使うべきモデルを解決する。
 * 返り値 undefined = 「ロール未設定 or 能力不適合」= 既定チャットモデルへフォールバック。
 * 呼び出し側はこの値を Tauri command の model 引数（undefined/null 許容）へ渡す。
 */
export function resolveModelForPath(
  pathId: string,
  getSetting: SettingGetter = defaultGetter,
): string | undefined {
  const role = PATH_TO_ROLE[pathId];
  if (!role) return undefined;
  const candidate = resolveRoleModel(role, getSetting);
  if (!candidate) return undefined;
  if (!isModelCapableForRole(candidate, role)) return undefined;
  return candidate;
}
