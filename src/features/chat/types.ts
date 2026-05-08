export const AI_PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
  "openai-compatible",
  "cli",
] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

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

/** OpenAI 互換プロバイダのプリセット ID */
export type OpenaiCompatPresetId = "custom" | "ainoverist";

/** OpenAI 互換プロバイダの設定。プリセット選択 + プリセット別のユーザー入力を保持する。 */
export interface OpenaiCompatibleSettings {
  preset: OpenaiCompatPresetId;
  /** custom プリセット時にユーザーが入力する OpenAI 互換エンドポイント */
  baseUrl: string;
  /** custom プリセット時に手動指定するモデルのコンテキスト窓 (tokens) */
  customMaxContext?: number;
  /** custom プリセット時に手動指定するモデルの最大出力 (tokens) */
  customMaxOutput?: number;
  /**
   * プリセット側 `extraSamplingKeys` で許可されているサンプリングパラメータ。
   * AI のべりすとの top_a / tailfree / typical_p / min_p / rep_pen /
   * badwords / stoptokens / logit_bias など。リクエストボディに素通しされる。
   */
  sampling?: Record<string, unknown>;
  /**
   * AI Codex 自動抽出 / Synopsis / セッションタイトル自動生成タスクで
   * このプロバイダを使うかどうか。プリセットの defaultDisableStructuredTasks=true
   * の場合、デフォルト false（オプトイン式）。
   */
  enableStructuredTasks?: boolean;
}

export const DEFAULT_OPENAI_COMPATIBLE_SETTINGS: OpenaiCompatibleSettings = {
  preset: "custom",
  baseUrl: "",
};

export interface AiSettings {
  provider: AiProvider;
  model: string;
  ollamaEndpoint: string;
  thinkingEnabled: boolean;
  openaiCompatible: OpenaiCompatibleSettings;
  /** CLI プロバイダ選択時のみ意味を持つ */
  cli?: CliSettings;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "openrouter",
  model: "",
  ollamaEndpoint: "http://localhost:11434",
  thinkingEnabled: true,
  openaiCompatible: DEFAULT_OPENAI_COMPATIBLE_SETTINGS,
};

export interface AiModel {
  id: string;
  name: string;
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
