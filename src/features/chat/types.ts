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
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "openrouter",
  model: "",
  ollamaEndpoint: "http://localhost:11434",
};

export interface AiModel {
  id: string;
  name: string;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
}
