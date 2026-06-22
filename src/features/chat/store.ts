import { create } from "zustand";
import * as api from "./api";
import * as cliApi from "./cliApi";
import { resolveModelApiVariant } from "./aiNovelist";
import type {
  AiProvider,
  AiSettings,
  AiModel,
  ConnectionTestResult,
} from "./types";
import { DEFAULT_AI_SETTINGS } from "./types";

/** API キー不要で接続テストできるプロバイダ。
 * Rust 側 resolve_api_key (commands/ai.rs) のキー省略可否と一致させること。 */
const KEYLESS_TEST_PROVIDERS = new Set<AiProvider>([
  "ollama",
  "openai-compatible",
  "cli",
]);
import {
  registerDynamicModelCaps,
  isDynamicCapsStale,
} from "./agent/dynamicModelCaps";

export interface AiSettingsState {
  settings: AiSettings | null;
  hasApiKey: boolean;
  /** CLI バイナリの検出結果。null = 未検出/CLI プロバイダ非選択。 */
  cliBinaryAvailable: boolean | null;
  isTestingConnection: boolean;
  connectionTestResult: ConnectionTestResult | null;
  models: AiModel[];
  isLoadingModels: boolean;
  /** OpenRouter 動的 capability レジストリの更新カウンタ。購読するとキャップ変更で再レンダリングされる。 */
  modelCapsRevision: number;

  loadSettings: () => Promise<void>;
  saveSettings: (settings: AiSettings) => Promise<void>;
  saveApiKey: (key: string) => Promise<void>;
  deleteApiKey: () => Promise<void>;
  testConnection: () => Promise<void>;
  loadModels: () => Promise<void>;
}

// in-flight ガード（多重発火防止）
let capsRefreshInFlight = false;

async function maybeRefreshDynamicCaps(): Promise<void> {
  if (capsRefreshInFlight) return;
  if (!isDynamicCapsStale()) return;
  capsRefreshInFlight = true;
  try {
    const { settings } = useAiSettingsStore.getState();
    if (settings?.provider !== "openrouter") return;
    const models = await api.listAiModels("openrouter");
    registerDynamicModelCaps(models);
    useAiSettingsStore.setState((s) => ({
      models,
      modelCapsRevision: s.modelCapsRevision + 1,
    }));
  } catch {
    // network error — silent fail, use stale/hardcoded caps
  } finally {
    capsRefreshInFlight = false;
  }
}

export const useAiSettingsStore = create<AiSettingsState>()((set, get) => ({
  settings: null,
  hasApiKey: false,
  cliBinaryAvailable: null,
  isTestingConnection: false,
  connectionTestResult: null,
  models: [],
  isLoadingModels: false,
  modelCapsRevision: 0,

  loadSettings: async () => {
    const settings = await api.getAiSettings();
    const keyPresent = await api.hasApiKey(settings.provider);
    let cliBinaryAvailable: boolean | null = null;
    if (settings.provider === "cli") {
      const path = await cliApi.detectCliBinary(settings.cli?.kind ?? "claude");
      cliBinaryAvailable = path !== null;
    }
    set({ settings, hasApiKey: keyPresent, cliBinaryAvailable });
    void maybeRefreshDynamicCaps();
  },

  saveSettings: async (settings: AiSettings) => {
    await api.saveAiSettings(settings);
    const prev = get().settings;
    let cliBinaryAvailable: boolean | null = get().cliBinaryAvailable;
    if (settings.provider === "cli") {
      const providerChanged = prev?.provider !== "cli";
      const kindChanged = prev?.cli?.kind !== settings.cli?.kind;
      if (providerChanged || kindChanged) {
        const path = await cliApi.detectCliBinary(
          settings.cli?.kind ?? "claude",
        );
        cliBinaryAvailable = path !== null;
      }
    } else {
      cliBinaryAvailable = null;
    }
    set({ settings, cliBinaryAvailable });
  },

  saveApiKey: async (key: string) => {
    const { settings } = get();
    if (!settings) return;
    await api.saveApiKey(settings.provider, key);
    set({ hasApiKey: true });
  },

  deleteApiKey: async () => {
    const { settings } = get();
    if (!settings) return;
    await api.deleteApiKey(settings.provider);
    set({ hasApiKey: false });
  },

  testConnection: async () => {
    const { settings, hasApiKey, models } = get();
    if (!settings || !settings.model) return;
    if (!hasApiKey && !KEYLESS_TEST_PROVIDERS.has(settings.provider)) return;

    set({ isTestingConnection: true, connectionTestResult: null });
    try {
      const apiVariant = resolveModelApiVariant(
        settings.provider,
        settings.model,
        models,
        settings.modelApiVariant,
      );
      const message = await api.testAiConnection(
        settings.provider,
        settings.model,
        apiVariant,
      );
      set({
        isTestingConnection: false,
        connectionTestResult: { success: true, message },
      });
    } catch (e) {
      set({
        isTestingConnection: false,
        connectionTestResult: {
          success: false,
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  },

  loadModels: async () => {
    const { settings } = get();
    if (!settings) return;

    set({ isLoadingModels: true });
    try {
      if (settings.provider === "cli") {
        const models = await cliApi.listCliModels(
          settings.cli?.kind ?? "claude",
          settings.cli?.binaryPath,
        );
        set({ models, isLoadingModels: false });
        return;
      }
      // それ以外は Rust 側 fetch_models に委譲
      // (Anthropic / AiNovelist は静的リストを返す、OpenAI 互換は API を叩く)
      const models = await api.listAiModels(settings.provider);
      if (settings.provider === "openrouter") {
        registerDynamicModelCaps(models);
        set({
          models,
          isLoadingModels: false,
          modelCapsRevision: get().modelCapsRevision + 1,
        });
      } else {
        set({ models, isLoadingModels: false });
      }
    } catch {
      set({ models: [], isLoadingModels: false });
    }
  },
}));

// Re-export default settings for use in components
export { DEFAULT_AI_SETTINGS };

export type ProviderReadiness =
  | "pending"
  | "ready"
  | "no-provider"
  | "no-model";

/** AI プロバイダが実際に呼び出せる状態かを返す derived selector。
 * policy 判定とは独立しており、`useAiCapability` 内で組み合わせて使う。 */
export function selectProviderReadiness(s: AiSettingsState): ProviderReadiness {
  const { settings, hasApiKey, cliBinaryAvailable } = s;
  if (!settings) return "pending";
  // CLI は cli.model が空でも CLI 側デフォルトに委譲できるため model 不要
  if (!settings.model && settings.provider !== "cli") return "no-model";
  switch (settings.provider) {
    case "openrouter":
    case "openai":
    case "anthropic":
    case "ai-novelist":
      return hasApiKey ? "ready" : "no-provider";
    case "openai-compatible":
      return settings.openaiCompatible.baseUrl ? "ready" : "no-provider";
    case "ollama":
      return settings.ollamaEndpoint ? "ready" : "no-provider";
    case "cli":
      if (cliBinaryAvailable === null) return "pending";
      return cliBinaryAvailable ? "ready" : "no-provider";
    default:
      return "no-provider";
  }
}

/** Web 検索 (RAG) に対応するプロバイダか。Phase 1 は OpenRouter (web plugin /
 * server tool) と Anthropic (native web_search) のみ。他はサーバサイド検索を
 * 持たない/未検証のため 🌐 トグルを非活性にする (ollama / openai-compatible /
 * ai-novelist / cli、および直叩き OpenAI は defer)。 */
export function isRagCapableProvider(
  provider: AiSettings["provider"] | null | undefined,
): boolean {
  return provider === "openrouter" || provider === "anthropic";
}
