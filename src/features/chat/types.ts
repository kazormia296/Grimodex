export const AI_PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiSettings {
  provider: AiProvider;
  model: string;
  ollamaEndpoint: string;
  thinkingEnabled: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "openrouter",
  model: "",
  ollamaEndpoint: "http://localhost:11434",
  thinkingEnabled: true,
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
