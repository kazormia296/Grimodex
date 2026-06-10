import {
  AINOVERIST_MODEL_CAPS,
  AINOVERIST_V1_DEFAULT_CAPS,
  AINOVERIST_V1_MODEL_CAPS,
  isAinoveristV1Model,
} from "../aiNovelist";
import { getDynamicModelMeta, type DynamicModelMeta } from "./dynamicModelCaps";

/** モデルの能力情報 */
export type EffortLevel = "low" | "medium" | "high" | "max";
export type ThinkingDisplay = "summarized" | "omitted";

export interface ModelCapabilities {
  contextWindow: number;
  /**
   * モデル固有のハード出力上限（明確な制約があるモデルにのみ設定）。
   * undefined の場合は contextBuilder 側のデフォルト応答予約ロジックに従う。
   * AI のべりすと等、API がモデル別に出力上限を持つプロバイダで使用。
   */
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsThinking: boolean; // budget_tokens 方式 (4.5 系)
  supportsAdaptiveThinking: boolean; // adaptive 方式 (4.6 系)
  supportsEffort: boolean;
  supportsMaxEffort: boolean; // Opus 4.6 限定
  supportsReasoning: boolean; // Ollama/OpenRouter 推論モデル用
  /**
   * reasoning を OFF にできるか。absent ⇒ 無効化可（既存 qwen3/deepseek-r1 互換）。
   * false の場合は常時推論（o-series / pre-5.1 gpt-5 等）。UI トグルを ON 固定にし、
   * disabling パラメータ（reasoning:{effort:"none"} 等）を一切送らない。
   */
  canDisableReasoning?: boolean;
  /**
   * 許可する reasoning effort 値。absent ⇒ low/medium/high 全許可。
   * gpt-5-pro のような high 固定モデルは ["high"] にし、低 effort を 400 回避のため clamp する。
   */
  reasoningEffortValues?: Array<"low" | "medium" | "high">;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 8_000,
  supportsTools: true,
  supportsThinking: false,
  supportsAdaptiveThinking: false,
  supportsEffort: false,
  supportsMaxEffort: false,
  supportsReasoning: false,
};

const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // Anthropic — Fable 5 (adaptive thinking + max effort)
  "claude-fable-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsReasoning: false,
  },
  // Anthropic — Opus 4.8 (adaptive thinking + max effort)
  "claude-opus-4-8": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsReasoning: false,
  },
  // Anthropic — Opus 4.7 (adaptive thinking + max effort)
  "claude-opus-4-7": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsReasoning: false,
  },
  // Anthropic — Opus 4.6 (adaptive thinking + max effort)
  "claude-opus-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsReasoning: false,
  },
  // Anthropic — Sonnet 4.6 (adaptive thinking, 1M context)
  "claude-sonnet-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  // Anthropic — Haiku 4.5 (no thinking, effort 非対応)
  "claude-haiku-4-5-20251001": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  // Anthropic — Opus 4.5 (budget_tokens thinking, effort 非対応)
  "claude-opus-4-5": {
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: true,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  // Anthropic — Sonnet 4.5 (budget_tokens thinking, effort 非対応)
  "claude-sonnet-4-5-20250929": {
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: true,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  // OpenAI
  "gpt-4o": {
    contextWindow: 128_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  "gpt-4o-mini": {
    contextWindow: 128_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  "gpt-4-turbo": {
    contextWindow: 128_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  "gpt-4": {
    contextWindow: 8_192,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  // Ollama / OpenRouter 推論モデル
  qwen3: {
    contextWindow: 32_768,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
  },
  "deepseek-r1": {
    contextWindow: 64_000,
    supportsTools: false,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
  },
  // OpenAI reasoning モデル（OpenRouter / OpenAI 直叩き両対応）。
  // 注: バージョンのドットはダッシュで保持（normalizeModelVersion が "5.1"→"5-1" に正規化）。
  // o-series は常時推論（reasoning OFF 不可）。
  o3: {
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
    canDisableReasoning: false,
  },
  "o3-mini": {
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
    canDisableReasoning: false,
  },
  "o4-mini": {
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
    canDisableReasoning: false,
  },
  // gpt-5 / gpt-5-mini は 5.1 より前 ⇒ reasoning_effort:"none" 非対応 ⇒ 常時推論扱い。
  "gpt-5": {
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
    canDisableReasoning: false,
  },
  "gpt-5-mini": {
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
    canDisableReasoning: false,
  },
  // gpt-5.1 以降は reasoning_effort:"none" 対応 ⇒ toggleable（canDisableReasoning absent）。
  "gpt-5-1": {
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
  },
  "gpt-5-2": {
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
  },
  "gpt-5-4": {
    contextWindow: 1_050_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
  },
  "gpt-5-4-mini": {
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
  },
  "gpt-5-4-nano": {
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
  },
  "gpt-5-5": {
    contextWindow: 1_050_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
  },
  // gpt-5-pro は high 固定。low/medium を送ると 400 になるため effort を high に clamp。
  "gpt-5-pro": {
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: true,
    canDisableReasoning: false,
    reasoningEffortValues: ["high"],
  },
  // gpt-5-chat は非 reasoning（明示ガード。startsWith で gpt-5 に巻き込まれないよう最長一致必須）。
  "gpt-5-chat": {
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
};

/** OpenRouter プレフィックス付きモデルの能力マッピング */
const OPENROUTER_PREFIXED: Record<string, string> = {
  "openai/gpt-4o": "gpt-4o",
  "openai/gpt-4o-mini": "gpt-4o-mini",
  "anthropic/claude-fable-5": "claude-fable-5",
  "anthropic/claude-opus-4-8": "claude-opus-4-8",
  "anthropic/claude-opus-4-7": "claude-opus-4-7",
  "anthropic/claude-opus-4-6": "claude-opus-4-6",
  "anthropic/claude-sonnet-4-6": "claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "anthropic/claude-opus-4-5": "claude-opus-4-5",
  "anthropic/claude-sonnet-4-5-20250929": "claude-sonnet-4-5-20250929",
  "qwen/qwen3": "qwen3",
  "deepseek/deepseek-r1": "deepseek-r1",
  // OpenAI reasoning（ダッシュ保持。ドット入力は normalizeModelVersion 経由で解決）。
  "openai/o3": "o3",
  "openai/o3-mini": "o3-mini",
  "openai/o4-mini": "o4-mini",
  "openai/gpt-5": "gpt-5",
  "openai/gpt-5-mini": "gpt-5-mini",
  "openai/gpt-5-1": "gpt-5-1",
  "openai/gpt-5-2": "gpt-5-2",
  "openai/gpt-5-4": "gpt-5-4",
  "openai/gpt-5-4-mini": "gpt-5-4-mini",
  "openai/gpt-5-4-nano": "gpt-5-4-nano",
  "openai/gpt-5-5": "gpt-5-5",
  "openai/gpt-5-pro": "gpt-5-pro",
  "openai/gpt-5-chat": "gpt-5-chat",
};

/**
 * OpenRouter はバージョン番号にドットを使う ("4.6") が、
 * Anthropic / 内部表記はダッシュ ("4-6")。統一するため正規化する。
 */
function normalizeModelVersion(model: string): string {
  return model.replace(/(\d+)\.(\d+)/g, "$1-$2");
}

/**
 * ハードコード表のみでモデル能力を解決する内部関数。
 * 完全一致 → バージョン正規化後に再試行 → プレフィックス前方一致（日付サフィックス対応）
 */
function resolveHardcoded(model: string): ModelCapabilities {
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model];

  const resolved = OPENROUTER_PREFIXED[model];
  if (resolved && MODEL_CAPABILITIES[resolved])
    return MODEL_CAPABILITIES[resolved];

  // ドット→ダッシュ正規化後に再試行 ("anthropic/claude-sonnet-4.6" → "anthropic/claude-sonnet-4-6")
  const normalized = normalizeModelVersion(model);
  if (normalized !== model) {
    const caps = resolveHardcoded(normalized);
    if (caps !== DEFAULT_CAPABILITIES) return caps;
  }

  // 日付サフィックス付きモデルへの対応 (例: "anthropic/claude-sonnet-4-6-20250514")。
  // 最長一致: "gpt-5-chat" を "gpt-5" より先に、"o3-mini" を "o3" より先に判定する。
  const prefixedByLen = Object.entries(OPENROUTER_PREFIXED).sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [prefixed, canonical] of prefixedByLen) {
    if (model.startsWith(prefixed) && MODEL_CAPABILITIES[canonical])
      return MODEL_CAPABILITIES[canonical];
  }
  const keysByLen = Object.keys(MODEL_CAPABILITIES).sort(
    (a, b) => b.length - a.length,
  );
  for (const key of keysByLen) {
    if (model.startsWith(key)) return MODEL_CAPABILITIES[key];
  }

  return DEFAULT_CAPABILITIES;
}

/**
 * 動的メタデータとハードコード能力をマージする。
 * supportsThinking/supportsAdaptiveThinking/supportsEffort/supportsMaxEffort は
 * 常に false（OpenRouter は unified reasoning param に一本化）。
 * canDisableReasoning/reasoningEffortValues はハードコード側が
 * supportsReasoning===true のときのみ継承する（o-series ロック・gpt-5-pro clamp 維持）。
 */
function mergeDynamicCaps(
  dyn: DynamicModelMeta,
  hardcoded: ModelCapabilities,
): ModelCapabilities {
  const supportsReasoning = dyn.reasoning;
  const inheritNuance = supportsReasoning && hardcoded.supportsReasoning;
  return {
    contextWindow: dyn.ctx ?? hardcoded.contextWindow,
    maxOutputTokens: dyn.out ?? hardcoded.maxOutputTokens,
    supportsTools: dyn.tools,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsReasoning,
    canDisableReasoning: inheritNuance
      ? hardcoded.canDisableReasoning
      : undefined,
    reasoningEffortValues: inheritNuance
      ? hardcoded.reasoningEffortValues
      : undefined,
  };
}

/**
 * モデルの能力情報を取得する。
 * 動的レジストリ（OpenRouter /models から登録）→ ハードコード表 の順で解決する。
 * 未知のモデルはデフォルト値を返す。
 */
export function getModelCapabilities(model: string): ModelCapabilities {
  const dyn = getDynamicModelMeta(model);
  if (dyn) return mergeDynamicCaps(dyn, resolveHardcoded(model));
  return resolveHardcoded(model);
}

/**
 * AiSettings を考慮してモデルの能力を解決する。
 * 第二引数を Optional にしているのは、AiSettings が不明な呼び出し場所
 * (synopsis 生成など UI コンテキスト外) からも使えるようにするため。
 */
export function resolveModelCapabilities(
  model: string,
  settings?: {
    provider?: string;
    openaiCompatible?: unknown;
    aiNovelist?: unknown;
  } | null,
  apiVariant?: string | null,
): ModelCapabilities {
  const base = getModelCapabilities(model);
  if (!settings) return base;

  // CLI プロバイダ: モデル能力は CLI 側に委譲。コンテキスト窓は 200k と仮定。
  if (settings.provider === "cli") {
    return {
      ...base,
      contextWindow: 200_000,
      supportsTools: false,
      supportsThinking: false,
      supportsAdaptiveThinking: false,
      supportsEffort: false,
    };
  }

  // AI のべりすと: v1 / legacy で能力が異なる
  if (settings.provider === "ai-novelist") {
    if (isAinoveristV1Model(model, apiVariant)) {
      const v1 = AINOVERIST_V1_MODEL_CAPS[model] ?? AINOVERIST_V1_DEFAULT_CAPS;
      return {
        ...base,
        contextWindow: v1.contextWindow,
        maxOutputTokens: v1.maxOutputTokens,
        supportsTools: true,
        supportsThinking: false,
        supportsAdaptiveThinking: false,
        supportsEffort: false,
        supportsMaxEffort: false,
        supportsReasoning: true,
      };
    }
    const aino = AINOVERIST_MODEL_CAPS[model];
    if (aino) {
      return {
        ...base,
        contextWindow: aino.contextWindow,
        maxOutputTokens: aino.maxOutputTokens,
        supportsTools: false,
        supportsThinking: false,
        supportsAdaptiveThinking: false,
        supportsEffort: false,
        supportsMaxEffort: false,
        supportsReasoning: false,
      };
    }
    return {
      ...base,
      supportsTools: false,
      supportsThinking: false,
      supportsAdaptiveThinking: false,
      supportsEffort: false,
      supportsReasoning: false,
    };
  }

  // OpenRouter: 動的レジストリが空のときの offline fallback。
  // ハードコード表の Claude thinking/adaptive 能力を unified reasoning param に変換する
  // （`base` が動的レジストリから来ている場合はすでに変換済みなので no-op）。
  if (settings.provider === "openrouter") {
    if (base.supportsThinking || base.supportsAdaptiveThinking) {
      return {
        ...base,
        supportsThinking: false,
        supportsAdaptiveThinking: false,
        supportsEffort: false,
        supportsMaxEffort: false,
        supportsReasoning: true,
      };
    }
    return base;
  }

  if (settings.provider !== "openai-compatible") return base;

  // カスタム OpenAI 互換: ユーザー入力の customMax* を反映
  const oc = settings.openaiCompatible as
    | { customMaxContext?: number; customMaxOutput?: number }
    | undefined;
  return {
    ...base,
    contextWindow: oc?.customMaxContext ?? base.contextWindow,
    maxOutputTokens: oc?.customMaxOutput ?? base.maxOutputTokens,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: false,
    // bare な o3/gpt-5/qwen3 系 id を指すカスタム endpoint に reasoning が漏れるのを防ぐ。
    supportsReasoning: false,
  };
}

/** ツール結果のトークン予算 = コンテキスト上限の30%（最低2,000） */
export function getToolTokenBudget(model: string): number {
  const { contextWindow } = getModelCapabilities(model);
  return Math.max(2_000, Math.floor(contextWindow * 0.3));
}

/** Tool Use 対応モデルの判定 */
export function modelSupportsTools(model: string): boolean {
  return getModelCapabilities(model).supportsTools;
}

/** タスク種別 */
export type TaskType =
  | "chat"
  | "agent"
  | "synopsis"
  | "session_title"
  | "slash_command"
  | "codex_extract";

/** タスク種別ごとの effort レベル（設計書仕様） */
export function getEffortForTask(task: TaskType): EffortLevel {
  switch (task) {
    case "synopsis":
    case "session_title":
    case "codex_extract":
      return "low";
    case "chat":
    case "slash_command":
      return "medium";
    case "agent":
      return "high";
  }
}

export interface ThinkingParams {
  thinking?: {
    type: "adaptive" | "enabled";
    effort?: EffortLevel;
    display?: ThinkingDisplay;
    budget_tokens?: number;
  };
  effort?: EffortLevel;
  reasoningEnabled?: boolean;
  reasoningEffort?: EffortLevel;
}

/**
 * reasoning effort を許可値に丸める。
 * - max は high 相当に正規化（OpenAI/OpenRouter の reasoning_effort に max は無い）。
 * - allowed が指定され範囲外なら、許可リスト内の最高値を返す（例: gpt-5-pro ["high"] → 常に high）。
 */
export function clampReasoningEffort(
  requested: EffortLevel,
  allowed?: Array<"low" | "medium" | "high">,
): EffortLevel {
  const normalized: "low" | "medium" | "high" =
    requested === "max" ? "high" : requested;
  if (!allowed || allowed.length === 0) return normalized;
  if (allowed.includes(normalized)) return normalized;
  for (const lvl of ["high", "medium", "low"] as const) {
    if (allowed.includes(lvl)) return lvl;
  }
  return normalized;
}

/** モデルとタスクに応じた thinking/effort パラメータを構築する（設計書 L627-647 準拠） */
export function buildThinkingParams(
  model: string,
  taskEffort: EffortLevel,
  display: ThinkingDisplay = "summarized",
  enabled = true,
  settings?: {
    provider?: string;
    openaiCompatible?: unknown;
    aiNovelist?: unknown;
  } | null,
  apiVariant?: string | null,
  effortOverride?: "low" | "medium" | "high",
): ThinkingParams {
  const caps = settings
    ? resolveModelCapabilities(model, settings, apiVariant)
    : getModelCapabilities(model);

  // 常時推論モデル（o-series / pre-5.1 gpt-5 等）は OFF でも推論する。
  const alwaysOn = caps.supportsReasoning && caps.canDisableReasoning === false;
  const effectiveEnabled = enabled || alwaysOn;
  // effort 上書きは reasoning 分岐でのみ適用（Anthropic には漏らさない）。
  const requestedReasoningEffort = effortOverride ?? taskEffort;
  const reasoningEffort = clampReasoningEffort(
    requestedReasoningEffort,
    caps.reasoningEffortValues,
  );

  if (caps.supportsAdaptiveThinking) {
    // Opus 4.6, Sonnet 4.6: adaptive thinking + effort
    return enabled
      ? { thinking: { type: "adaptive", effort: taskEffort, display } }
      : {};
  }

  if (caps.supportsThinking) {
    // Opus 4.5, Sonnet 4.5 等: budget_tokens。effort は supportsEffort のモデルにのみ付ける。
    if (!enabled) return {};
    const budgetTokens = Math.floor(caps.contextWindow * 0.8 * 0.05);
    return {
      thinking: { type: "enabled", budget_tokens: budgetTokens, display },
      ...(caps.supportsEffort ? { effort: taskEffort } : {}),
    };
  }

  if (caps.supportsReasoning) {
    // Ollama/OpenRouter/OpenAI 推論モデル: reasoningEnabled/reasoningEffort
    if (effectiveEnabled) return { reasoningEnabled: true, reasoningEffort };
    // toggleable OFF → 明示的に無効化（OpenRouter effort:"none" / OpenAI gpt-5.1+ none に到達）。
    // always-on は effectiveEnabled=true なのでここに来ない（disabling を送らない）。
    return { reasoningEnabled: false };
  }

  if (caps.supportsEffort) {
    return enabled ? { effort: taskEffort } : {};
  }

  return {};
}

/** コンテキスト窓サイズを人間が読みやすい形式に変換 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000) return `${tokens / 1_000}k`;
  return String(tokens);
}
