import i18next from "@/lib/i18n";

export const AI_PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
  "openai-compatible",
  "sakana",
  "ai-novelist",
  "cli",
] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * Agent ループでツール呼び出しをどのプロトコルで授受するか。
 * - `auto`: HTTP OpenAI 互換プロバイダで、model 名に `hermes` を含む場合のみ Hermes 扱い。
 *   それ以外は native（OpenAI structured `tool_calls`）。
 * - `native`: 常に OpenAI structured `tool_calls`。
 * - `hermes`: 本文 `<tool_call>`/`<tool_response>` テキストプロトコル（Hermes/ChatML 系）。
 * Anthropic / CLI など非 OpenAI 互換プロバイダでは常に native（resolve 側で無効化）。
 */
export type ToolProtocolMode = "auto" | "native" | "hermes";

/** CLI エージェント種別 (Claude Code / Codex CLI / OpenCode) */
export type CliKind = "claude" | "codex" | "opencode";

/** CLI プロバイダ用設定 */
export interface CliSettings {
  /** 使用する CLI 種別 */
  kind: CliKind;
  /**
   * 実行可能ファイルのパス。空なら CLI 名を PATH 解決する。
   * 通常は detect_cli_binary で取得した絶対パスを保存する。
   */
  binaryPath?: string;
  /** CLI に渡すモデル名。空なら CLI のデフォルトモデル */
  model?: string;
}

/** カスタム OpenAI 互換プロバイダの設定。 */
export interface OpenaiCompatibleSettings {
  /** ユーザーが入力する OpenAI 互換エンドポイント */
  baseUrl: string;
  /** 手動指定するモデルのコンテキスト窓 (tokens) */
  customMaxContext?: number;
  /** 手動指定するモデルの最大出力 (tokens) */
  customMaxOutput?: number;
  /** AI Codex 自動抽出 / Synopsis / セッションタイトル自動生成を許可するか */
  enableStructuredTasks?: boolean;
}

export const DEFAULT_OPENAI_COMPATIBLE_SETTINGS: OpenaiCompatibleSettings = {
  baseUrl: "",
};

/** AI のべりすと専用の設定。 */
export interface AiNovelistSettings {
  /** KoboldAI 系独自サンプリングパラメータ (top_a / tailfree 等) */
  sampling?: Record<string, unknown>;
  /** AI Codex 自動抽出 / Synopsis / セッションタイトル自動生成を許可するか */
  enableStructuredTasks?: boolean;
  /** 日本語以外で生成する場合に true */
  multilingualMode?: boolean;
}

export const DEFAULT_AI_NOVELIST_SETTINGS: AiNovelistSettings = {};

export interface AiSettings {
  provider: AiProvider;
  model: string;
  ollamaEndpoint: string;
  thinkingEnabled: boolean;
  openaiCompatible: OpenaiCompatibleSettings;
  aiNovelist?: AiNovelistSettings;
  /** CLI プロバイダ選択時のみ意味を持つ */
  cli?: CliSettings;
  /**
   * OpenRouter で同一 provider に routing を固定する slug。
   * 例: "anthropic" / "amazon-bedrock" / "google-vertex"。
   * 未設定 (undefined / null / 空文字) なら OpenRouter のデフォルト routing。
   * 設定すると Anthropic prompt cache が安定して効くようになる。
   */
  openrouterProviderPin?: string | null;
  /**
   * 選択中モデルの API 経路。バックエンド fallback 用 (Rust `resolve_api_variant`)。
   * - "legacy" | "v1": AI のべりすとのレガシー / OpenAI 互換 API 切替。
   * - "responses": OpenAI 直 / OpenAI 互換 gateway で `/v1/responses`
   *   (Responses API) を使う。未設定なら `/chat/completions`。
   */
  modelApiVariant?: "legacy" | "v1" | "responses" | null;
  /**
   * reasoning モデルの effort 上書き（low/medium/high）。
   * undefined / null ⇒ タスク既定（getEffortForTask）に従う。chat/agent でのみ適用。
   */
  reasoningEffortOverride?: "low" | "medium" | "high" | null;
  /**
   * Agent ツール呼び出しプロトコル。未設定 ⇒ "auto"。
   * Hermes/ChatML 系モデルが本文に出す `<tool_call>` を実ツール呼び出しとして扱うため。
   */
  toolProtocolMode?: ToolProtocolMode;
}

/**
 * OpenRouter provider pin の候補一覧（UI 用）。
 * 言語切り替えに追従させるため関数化（import 時固定の const は避ける）。
 */
export function getOpenrouterProviderPins(): Array<{
  slug: string;
  label: string;
}> {
  return [
    {
      slug: "anthropic",
      label: `Anthropic (${i18next.t("settings.ai.providerPinDirect")})`,
    },
    { slug: "amazon-bedrock", label: "Amazon Bedrock" },
    { slug: "google-vertex", label: "Google Vertex" },
  ];
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "openrouter",
  model: "",
  ollamaEndpoint: "http://localhost:11434",
  thinkingEnabled: true,
  openaiCompatible: DEFAULT_OPENAI_COMPATIBLE_SETTINGS,
  toolProtocolMode: "auto",
};

export interface AiModel {
  id: string;
  name: string;
  /** AI のべりすと: "legacy" | "v1" */
  apiVariant?: "legacy" | "v1";
  // OpenRouter /models から取得したメタデータ（他プロバイダでは未設定）
  contextLength?: number;
  maxCompletionTokens?: number;
  supportedParameters?: string[];
  pricingPrompt?: string;
  pricingCompletion?: string;
}

/**
 * モデルIDからデベロッパー名を抽出する。
 * OpenRouter の "anthropic/claude-..." → "anthropic"
 * スラッシュがない場合は空文字 (単一プロバイダー扱い)
 */
export function modelDeveloper(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(0, slash) : "";
}

/**
 * モデル一覧をデベロッパーでグループ化し、
 * デベロッパー名昇順・モデル名昇順でソートして返す。
 * 戻り値: [developerLabel, models[]] のタプル配列
 */
export function groupModelsByDeveloper(
  models: AiModel[],
): [string, AiModel[]][] {
  const map = new Map<string, AiModel[]>();
  for (const m of models) {
    const dev = modelDeveloper(m.id);
    if (!map.has(dev)) map.set(dev, []);
    map.get(dev)!.push(m);
  }
  // 各グループ内をモデル名でソート
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }
  // デベロッパー名でソート（空文字は末尾）
  return [...map.entries()].sort(([a], [b]) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
}
