import { invoke } from "@/lib/tauri";
import type { AiSettings, AiModel, AiProvider } from "./types";

export async function getAiSettings(): Promise<AiSettings> {
  return invoke<AiSettings>("get_ai_settings");
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await invoke("save_ai_settings", { settings });
}

export async function saveApiKey(
  provider: AiProvider,
  key: string,
): Promise<void> {
  await invoke("save_api_key", { provider, key });
}

export async function getApiKey(provider: AiProvider): Promise<string | null> {
  return invoke<string | null>("get_api_key", { provider });
}

export async function deleteApiKey(provider: AiProvider): Promise<void> {
  await invoke("delete_api_key", { provider });
}

export async function testAiConnection(
  provider: AiProvider,
  model: string,
  apiVariant?: string | null,
): Promise<string> {
  return invoke<string>("test_ai_connection", {
    provider,
    model,
    apiVariant: apiVariant ?? null,
  });
}

export async function listAiModels(provider: AiProvider): Promise<AiModel[]> {
  return invoke<AiModel[]>("list_ai_models", { provider });
}
