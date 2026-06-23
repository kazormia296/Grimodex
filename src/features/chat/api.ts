import { invoke } from "@/lib/tauri";
import type { AiSettings, AiModel, AiProvider } from "./types";

export async function getAiSettings(): Promise<AiSettings> {
  return invoke<AiSettings>("get_ai_settings");
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await invoke("save_ai_settings", { settings });
}

/**
 * API キーを保存する。`endpointId` は OpenAI 互換プロバイダの per-endpoint キーで
 * のみ意味を持つ（その他のプロバイダでは無視され単一キーに保存される）。
 */
export async function saveApiKey(
  provider: AiProvider,
  key: string,
  endpointId?: string | null,
): Promise<void> {
  await invoke("save_api_key", {
    provider,
    key,
    endpointId: endpointId ?? null,
  });
}

/**
 * キーの有無だけを問い合わせる。プレーンテキストのキーは renderer に渡さない
 * (実送信のキー解決は Rust 側が担う) ため、フロントは真偽値のみ必要とする。
 * `endpointId` は OpenAI 互換の per-endpoint キー判定でのみ意味を持つ。
 */
export async function hasApiKey(
  provider: AiProvider,
  endpointId?: string | null,
): Promise<boolean> {
  return invoke<boolean>("has_api_key", {
    provider,
    endpointId: endpointId ?? null,
  });
}

export async function deleteApiKey(
  provider: AiProvider,
  endpointId?: string | null,
): Promise<void> {
  await invoke("delete_api_key", {
    provider,
    endpointId: endpointId ?? null,
  });
}

export async function testAiConnection(
  provider: AiProvider,
  model: string,
  apiVariant?: string | null,
  endpointId?: string | null,
): Promise<string> {
  return invoke<string>("test_ai_connection", {
    provider,
    model,
    apiVariant: apiVariant ?? null,
    endpointId: endpointId ?? null,
  });
}

export async function listAiModels(
  provider: AiProvider,
  endpointId?: string | null,
): Promise<AiModel[]> {
  return invoke<AiModel[]>("list_ai_models", {
    provider,
    endpointId: endpointId ?? null,
  });
}
