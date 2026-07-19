import { DEFAULT_SCAN_AI_MODEL, type ScanEnv } from "../env";

export type ConfiguredAiProvider = "workers-ai" | "ai-gateway" | "openrouter";

export interface ConfiguredAiRoute {
  provider: ConfiguredAiProvider;
  model: string;
}

export function primaryScanAiRoute(env: ScanEnv): ConfiguredAiRoute {
  return {
    provider: env.SCAN_AI_PROVIDER ?? (env.AI ? "workers-ai" : "ai-gateway"),
    model: env.SCAN_AI_MODEL?.trim() || DEFAULT_SCAN_AI_MODEL,
  };
}

export function frontierScanAiRoute(env: ScanEnv): ConfiguredAiRoute {
  const primary = primaryScanAiRoute(env);
  return {
    provider: env.SCAN_FRONTIER_PROVIDER ?? primary.provider,
    model: env.SCAN_FRONTIER_MODEL?.trim() || primary.model,
  };
}

export function hostedEditorAiRoute(env: ScanEnv): ConfiguredAiRoute {
  const primary = primaryScanAiRoute(env);
  return {
    provider: env.SCAN_EDITOR_AI_PROVIDER ?? primary.provider,
    model: env.SCAN_EDITOR_AI_MODEL?.trim() || primary.model,
  };
}
