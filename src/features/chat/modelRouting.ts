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
 * Phase 2 で全ロール経路を配線し、ロール UI（AiCategory）と旧キー
 * (ai.inlineModel / ai.sessionTitleModel) の吸収シム(migrateModelRoleKeys)、
 * structured/review の構造化 JSON ゲートを追加した。空ロール時は wire 差分ゼロ。
 *
 * 全配線状況（呼び出し側で resolveModelForPath を model 引数へ渡す）:
 *   - conversation: chat_stream_non_agent
 *   - agent: chat_agent_main, agent_research_subagent, context_creator
 *       … send_agent_message が model:Option<String> を受理（filter(非空).unwrap_or）
 *   - inline: inline_ai_stream
 *   - cheap: session_title, beat_role, summarization
 *       … summarization は chatStore の injected callback 経由で model を注入
 *   - structured: synopsis, foreshadow_*(3), map_branch, tree_scaffold, codex_judgment
 *   - review: post_effect_*(6)
 *       … start_post_effect_run(_multi) に model_override を渡し、各 process_*_scene が
 *         read_ai_settings 後に override（既存 model=input_hash/記録用とは独立軸）
 */
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getModelCapabilities } from "./agent/modelLimits";
import { overrideApiVariantForProvider } from "./aiNovelist";
import type { AiProvider } from "./types";

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
 * 機能別モデルのプロバイダ横断マップのキー。
 * 値は JSON `Record<ModelRole, { provider?: string; endpointId?: string }>`。
 */
export const ROLE_PROVIDERS_KEY = "aiModel.roleProviders";

/** ロールごとの別プロバイダ/別エンドポイント割り当て（空 = アクティブ provider 据え置き）。 */
export interface RoleProviderOverride {
  /** 送信先プロバイダ。空/未設定なら active provider を使う（後方互換）。 */
  provider?: string;
  /** openai-compatible で別エンドポイントへ向ける場合の endpoint id。 */
  endpointId?: string;
}

/**
 * ロール解決の結果。`provider` 未設定 = アクティブ provider で `model` を送る
 * （従来挙動・wire 差分ゼロ）。`provider` 設定時は別プロバイダ送信 override
 * （composer の cross-provider override と同型: variant は overrideApiVariantForProvider
 * 由来、openai-compatible の経路は endpointId + Rust 側 endpoint 既定で解決）。
 */
export interface RolePathModel {
  model: string;
  provider?: AiProvider;
  endpointId?: string;
  variant?: string;
}

/**
 * roleProviders マップを安全にパースする（不正 JSON / 不正な形は空マップ）。
 *
 * トップレベルが object でない（配列・null・プリミティブ）場合は空。各エントリの
 * `provider` / `endpointId` は文字列のみ採用する。破損 / 旧スキーマ JSON（provider が
 * 数値・配列・null 等）をそのまま通すと resolve 時の `.trim()` で TypeError、または
 * 不正 provider 文字列のキャスト送信を招くため、ここで型を絞って弾く。
 */
export function parseRoleProviders(
  raw: string,
): Partial<Record<ModelRole, RoleProviderOverride>> {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Partial<Record<ModelRole, RoleProviderOverride>> = {};
  for (const [role, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const entry: RoleProviderOverride = {};
    if (typeof v.provider === "string") entry.provider = v.provider;
    if (typeof v.endpointId === "string") entry.endpointId = v.endpointId;
    // provider も endpointId も無いエントリは無意味（resolve でも無視される）。
    if (entry.provider === undefined && entry.endpointId === undefined)
      continue;
    out[role as ModelRole] = entry;
  }
  return out;
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
  plot_thread_propose: "structured",
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
  // getter は未設定キーに対し空文字を返す契約だが、undefined を返す実装
  // （ストア未初期化のテスト等）でも壊れないよう防御的に空文字へ丸める。
  const raw = (getSetting(roleSettingKey(role)) ?? "").trim();
  return raw === "" ? undefined : raw;
}

/**
 * ロールが要求する能力をモデルが満たすか。満たさなければ override は無視される。
 *   - agent: tool 対応必須。
 *   - structured / review: 構造化 JSON 出力の信頼性（supportsStructuredJson）。
 *     absent ⇒ 対応扱い（既定 true）なので、明示的に false の curated モデル
 *     （deepseek-r1 等）だけがゲートで弾かれる。
 *   - conversation / inline / cheap: 制約なし。
 */
export function isModelCapableForRole(model: string, role: ModelRole): boolean {
  const caps = getModelCapabilities(model);
  if (role === "agent") return caps.supportsTools;
  if (role === "structured" || role === "review")
    return caps.supportsStructuredJson !== false;
  return true;
}

/**
 * 経路 ID に対して使うべきモデルと送信先（プロバイダ/エンドポイント/経路）を解決する。
 *
 * - 返り値 undefined = 「ロール未設定 or 能力不適合」= 既定チャットモデルへフォールバック。
 * - `provider` 未設定 = アクティブ provider で `model` を送る（従来挙動・wire 差分ゼロ）。
 * - `provider` 設定時 = 別プロバイダ送信 override。`variant` は overrideApiVariantForProvider
 *   由来（sakana→"responses" / 他→null=バックエンド既定解決）。openai-compatible の
 *   経路は endpointId + Rust 側 endpoint 既定で解決されるため variant は持たせない。
 *
 * 呼び出し側はこの値の model/provider/endpointId/variant を Tauri command の
 * 対応 override 引数へ渡す（composer の cross-provider override と同じ要領）。
 */
export function resolveRolePathConfig(
  pathId: string,
  getSetting: SettingGetter = defaultGetter,
): RolePathModel | undefined {
  const role = PATH_TO_ROLE[pathId];
  if (!role) return undefined;
  const candidate = resolveRoleModel(role, getSetting);
  if (!candidate) return undefined;
  if (!isModelCapableForRole(candidate, role)) return undefined;

  const override = parseRoleProviders(getSetting(ROLE_PROVIDERS_KEY) ?? "")[
    role
  ];
  const provider = override?.provider?.trim();
  if (!provider) return { model: candidate };

  const endpointId = override?.endpointId?.trim() || undefined;
  const variant = overrideApiVariantForProvider(provider) ?? undefined;
  return {
    model: candidate,
    provider: provider as AiProvider,
    endpointId,
    variant,
  };
}

/**
 * 経路 ID に対して使うべきモデル ID のみを解決する（後方互換ヘルパ）。
 * provider/endpoint 横断を扱わない既存呼び出し向け。横断対応の送信経路は
 * resolveRolePathConfig を直接使う。
 */
export function resolveModelForPath(
  pathId: string,
  getSetting: SettingGetter = defaultGetter,
): string | undefined {
  return resolveRolePathConfig(pathId, getSetting)?.model;
}

/** Tauri invoke の override 引数にそのまま流せる正規化形（未設定は null）。 */
export interface RoleSendOverride {
  /** model override（null = Rust が settings.model に解決）。 */
  model: string | null;
  /** provider override（null = active provider 据え置き）。 */
  provider: string | null;
  /** API 経路 override（null = backend 既定解決）。 */
  apiVariant: string | null;
  /** openai-compatible エンドポイント override（null = active）。 */
  endpointId: string | null;
}

/**
 * 経路 ID を Tauri command の override 引数 4 つ
 * （model / provider / apiVariant / endpointId）へ一発で展開する。
 * 横断割り当てがなければ provider/apiVariant/endpointId は null（= 従来挙動）。
 * provider/endpoint override を受ける送信コマンドの呼び出し側はこれを使う。
 */
export function resolveRoleSendOverride(
  pathId: string,
  getSetting: SettingGetter = defaultGetter,
): RoleSendOverride {
  const cfg = resolveRolePathConfig(pathId, getSetting);
  return {
    model: cfg?.model ?? null,
    provider: cfg?.provider ?? null,
    apiVariant: cfg?.variant ?? null,
    endpointId: cfg?.endpointId ?? null,
  };
}
