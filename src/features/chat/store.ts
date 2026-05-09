import { create } from "zustand";
import * as api from "./api";
import type { AiSettings, AiModel, ConnectionTestResult } from "./types";
import { DEFAULT_AI_SETTINGS } from "./types";
import { getOpenaiCompatPreset } from "./openaiCompatPresets";

interface AiSettingsState {
  settings: AiSettings | null;
  hasApiKey: boolean;
  isTestingConnection: boolean;
  connectionTestResult: ConnectionTestResult | null;
  models: AiModel[];
  isLoadingModels: boolean;

  loadSettings: () => Promise<void>;
  saveSettings: (settings: AiSettings) => Promise<void>;
  saveApiKey: (key: string) => Promise<void>;
  deleteApiKey: () => Promise<void>;
  testConnection: () => Promise<void>;
  loadModels: () => Promise<void>;
}

export const useAiSettingsStore = create<AiSettingsState>()((set, get) => ({
  settings: null,
  hasApiKey: false,
  isTestingConnection: false,
  connectionTestResult: null,
  models: [],
  isLoadingModels: false,

  loadSettings: async () => {
    const settings = await api.getAiSettings();
    const key = await api.getApiKey(settings.provider);
    set({
      settings,
      hasApiKey: key !== null,
    });
  },

  saveSettings: async (settings: AiSettings) => {
    await api.saveAiSettings(settings);
    set({ settings });
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
    const { settings, hasApiKey } = get();
    if (!settings || !hasApiKey || !settings.model) return;

    set({ isTestingConnection: true, connectionTestResult: null });
    try {
      const message = await api.testAiConnection(
        settings.provider,
        settings.model,
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
      // OpenAI 互換プロバイダで、プリセット側にハードコードモデルがある場合は
      // そちらを優先する (AI のべりすと等、API の /models を叩かない方が早い・確実)。
      if (settings.provider === "openai-compatible") {
        const preset = getOpenaiCompatPreset(settings.openaiCompatible?.preset);
        if (preset.models.length > 0) {
          set({ models: [...preset.models], isLoadingModels: false });
          return;
        }
      }
      // CLI プロバイダはモデル一覧を持たない (CLI 側 settings で個別管理)
      if (settings.provider === "cli") {
        set({ models: [], isLoadingModels: false });
        return;
      }
      const models = await api.listAiModels(settings.provider);
      set({ models, isLoadingModels: false });
    } catch {
      set({ models: [], isLoadingModels: false });
    }
  },
}));

// Re-export default settings for use in components
export { DEFAULT_AI_SETTINGS };
