import {
  AINOVERIST_MODEL_CAPS,
  AINOVERIST_V1_DEFAULT_CAPS,
  AINOVERIST_V1_MODEL_CAPS,
  isAinoveristV1Model,
} from "../aiNovelist";

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
  // Anthropic — Opus 4.6 (adaptive thinking + max effort)
  "claude-opus-4-6": {
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsReasoning: false,
  },
  // Anthropic — Sonnet 4.6 (adaptive thinking)
  "claude-sonnet-4-6": {
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  // Anthropic — Haiku 4.5 (no thinking)
  "claude-haiku-4-5-20251001": {
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsEffort: true,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  // Anthropic — Opus 4.5 (budget_tokens thinking)
  "claude-opus-4-5": {
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: true,
    supportsAdaptiveThinking: false,
    supportsEffort: true,
    supportsMaxEffort: false,
    supportsReasoning: false,
  },
  // Anthropic — Sonnet 4.5 (budget_tokens thinking)
  "claude-sonnet-4-5-20250929": {
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: true,
    supportsAdaptiveThinking: false,
    supportsEffort: true,
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
};

/** OpenRouter プレフィックス付きモデルの能力マッピング */
const OPENROUTER_PREFIXED: Record<string, string> = {
  "openai/gpt-4o": "gpt-4o",
  "openai/gpt-4o-mini": "gpt-4o-mini",
  "anthropic/claude-opus-4-6": "claude-opus-4-6",
  "anthropic/claude-sonnet-4-6": "claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "anthropic/claude-opus-4-5": "claude-opus-4-5",
  "anthropic/claude-sonnet-4-5-20250929": "claude-sonnet-4-5-20250929",
  "qwen/qwen3": "qwen3",
  "deepseek/deepseek-r1": "deepseek-r1",
};

/**
 * OpenRouter はバージョン番号にドットを使う ("4.6") が、
 * Anthropic / 内部表記はダッシュ ("4-6")。統一するため正規化する。
 */
function normalizeModelVersion(model: string): string {
  return model.replace(/(\d+)\.(\d+)/g, "$1-$2");
}

/**
 * モデルの能力情報を取得する。
 * 完全一致 → バージョン正規化後に再試行 → プレフィックス前方一致（日付サフィックス対応）
 * の順で解決し、未知のモデルはデフォルト値を返す。
 */
export function getModelCapabilities(model: string): ModelCapabilities {
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model];

  const resolved = OPENROUTER_PREFIXED[model];
  if (resolved && MODEL_CAPABILITIES[resolved])
    return MODEL_CAPABILITIES[resolved];

  // ドット→ダッシュ正規化後に再試行 ("anthropic/claude-sonnet-4.6" → "anthropic/claude-sonnet-4-6")
  const normalized = normalizeModelVersion(model);
  if (normalized !== model) {
    const caps = getModelCapabilities(normalized);
    if (caps !== DEFAULT_CAPABILITIES) return caps;
  }

  // 日付サフィックス付きモデルへの対応 (例: "anthropic/claude-sonnet-4-6-20250514")
  for (const [prefixed, canonical] of Object.entries(OPENROUTER_PREFIXED)) {
    if (model.startsWith(prefixed) && MODEL_CAPABILITIES[canonical])
      return MODEL_CAPABILITIES[canonical];
  }
  for (const key of Object.keys(MODEL_CAPABILITIES)) {
    if (model.startsWith(key)) return MODEL_CAPABILITIES[key];
  }

  return DEFAULT_CAPABILITIES;
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
): ThinkingParams {
  if (!enabled) return {};
  const caps = settings
    ? resolveModelCapabilities(model, settings, apiVariant)
    : getModelCapabilities(model);

  if (caps.supportsAdaptiveThinking) {
    // Opus 4.6, Sonnet 4.6: adaptive thinking + effort
    return {
      thinking: { type: "adaptive", effort: taskEffort, display },
    };
  }

  if (caps.supportsThinking) {
    // Opus 4.5, Sonnet 4.5 等: budget_tokens + effort
    const budgetTokens = Math.floor(caps.contextWindow * 0.8 * 0.05);
    return {
      thinking: { type: "enabled", budget_tokens: budgetTokens, display },
      effort: taskEffort,
    };
  }

  if (caps.supportsReasoning) {
    // Ollama/OpenRouter 推論モデル: reasoningEnabled/reasoningEffort
    return {
      reasoningEnabled: enabled,
      reasoningEffort: enabled ? taskEffort : undefined,
    };
  }

  if (caps.supportsEffort) {
    return { effort: taskEffort };
  }

  return {};
}

/** コンテキスト窓サイズを人間が読みやすい形式に変換 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000) return `${tokens / 1_000}k`;
  return String(tokens);
}
