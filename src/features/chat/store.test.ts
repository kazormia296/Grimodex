import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAiSettingsStore } from "./store";
import type { AiSettings, AiModel } from "./types";

vi.mock("./api", () => ({
  getAiSettings: vi.fn(),
  saveAiSettings: vi.fn(),
  saveApiKey: vi.fn(),
  getApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  testAiConnection: vi.fn(),
  listAiModels: vi.fn(),
}));

import * as api from "./api";

const mockGetAiSettings = vi.mocked(api.getAiSettings);
const mockSaveAiSettings = vi.mocked(api.saveAiSettings);
const mockSaveApiKey = vi.mocked(api.saveApiKey);
const mockGetApiKey = vi.mocked(api.getApiKey);
const mockDeleteApiKey = vi.mocked(api.deleteApiKey);
const mockTestAiConnection = vi.mocked(api.testAiConnection);
const mockListAiModels = vi.mocked(api.listAiModels);

function resetStore() {
  useAiSettingsStore.setState({
    settings: null,
    hasApiKey: false,
    isTestingConnection: false,
    connectionTestResult: null,
    models: [],
    isLoadingModels: false,
  });
}

const defaultSettings: AiSettings = {
  provider: "openrouter",
  model: "",
  ollamaEndpoint: "http://localhost:11434",
};

describe("useAiSettingsStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe("loadSettings", () => {
    it("loads settings and checks for API key", async () => {
      mockGetAiSettings.mockResolvedValueOnce(defaultSettings);
      mockGetApiKey.mockResolvedValueOnce("sk-test");

      await useAiSettingsStore.getState().loadSettings();

      const state = useAiSettingsStore.getState();
      expect(state.settings).toEqual(defaultSettings);
      expect(state.hasApiKey).toBe(true);
    });

    it("sets hasApiKey to false when no key exists", async () => {
      mockGetAiSettings.mockResolvedValueOnce(defaultSettings);
      mockGetApiKey.mockResolvedValueOnce(null);

      await useAiSettingsStore.getState().loadSettings();

      expect(useAiSettingsStore.getState().hasApiKey).toBe(false);
    });
  });

  describe("saveSettings", () => {
    it("saves settings via API and updates store", async () => {
      mockSaveAiSettings.mockResolvedValueOnce(undefined);
      const newSettings: AiSettings = {
        provider: "openai",
        model: "gpt-4o",
        ollamaEndpoint: "http://localhost:11434",
      };

      await useAiSettingsStore.getState().saveSettings(newSettings);

      expect(mockSaveAiSettings).toHaveBeenCalledWith(newSettings);
      expect(useAiSettingsStore.getState().settings).toEqual(newSettings);
    });
  });

  describe("saveApiKey", () => {
    it("saves key for current provider and sets hasApiKey", async () => {
      // Set up initial settings so provider is known
      useAiSettingsStore.setState({ settings: defaultSettings });
      mockSaveApiKey.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveApiKey("sk-or-new-key");

      expect(mockSaveApiKey).toHaveBeenCalledWith(
        "openrouter",
        "sk-or-new-key",
      );
      expect(useAiSettingsStore.getState().hasApiKey).toBe(true);
    });

    it("does nothing when settings are not loaded", async () => {
      await useAiSettingsStore.getState().saveApiKey("sk-test");
      expect(mockSaveApiKey).not.toHaveBeenCalled();
    });
  });

  describe("deleteApiKey", () => {
    it("deletes key for current provider and clears hasApiKey", async () => {
      useAiSettingsStore.setState({
        settings: defaultSettings,
        hasApiKey: true,
      });
      mockDeleteApiKey.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().deleteApiKey();

      expect(mockDeleteApiKey).toHaveBeenCalledWith("openrouter");
      expect(useAiSettingsStore.getState().hasApiKey).toBe(false);
    });
  });

  describe("testConnection", () => {
    it("sets testing state and success result", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, model: "gpt-4" },
        hasApiKey: true,
      });
      mockTestAiConnection.mockResolvedValueOnce("OK");

      await useAiSettingsStore.getState().testConnection();

      const state = useAiSettingsStore.getState();
      expect(state.isTestingConnection).toBe(false);
      expect(state.connectionTestResult).toEqual({
        success: true,
        message: "OK",
      });
    });

    it("sets failure result on error", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, model: "gpt-4" },
        hasApiKey: true,
      });
      mockTestAiConnection.mockRejectedValueOnce(new Error("Auth failed"));

      await useAiSettingsStore.getState().testConnection();

      const state = useAiSettingsStore.getState();
      expect(state.isTestingConnection).toBe(false);
      expect(state.connectionTestResult).toEqual({
        success: false,
        message: "Auth failed",
      });
    });

    it("does nothing without settings or API key", async () => {
      await useAiSettingsStore.getState().testConnection();
      expect(mockTestAiConnection).not.toHaveBeenCalled();
    });
  });

  describe("loadModels", () => {
    it("fetches models for current provider", async () => {
      useAiSettingsStore.setState({ settings: defaultSettings });
      const models: AiModel[] = [
        { id: "gpt-4", name: "GPT-4" },
        { id: "claude-3", name: "Claude 3" },
      ];
      mockListAiModels.mockResolvedValueOnce(models);

      await useAiSettingsStore.getState().loadModels();

      const state = useAiSettingsStore.getState();
      expect(state.models).toEqual(models);
      expect(state.isLoadingModels).toBe(false);
    });

    it("does nothing without settings", async () => {
      await useAiSettingsStore.getState().loadModels();
      expect(mockListAiModels).not.toHaveBeenCalled();
    });
  });
});
