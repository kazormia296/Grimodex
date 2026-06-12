import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useAiSettingsStore,
  selectProviderReadiness,
  isRagCapableProvider,
} from "./store";
import type { AiSettings, AiModel } from "./types";
import { DEFAULT_AI_SETTINGS } from "./types";

vi.mock("./api", () => ({
  getAiSettings: vi.fn(),
  saveAiSettings: vi.fn(),
  saveApiKey: vi.fn(),
  hasApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  testAiConnection: vi.fn(),
  listAiModels: vi.fn(),
}));

vi.mock("./cliApi", () => ({
  detectCliBinary: vi.fn(),
  listCliModels: vi.fn(),
}));

import * as api from "./api";
import * as cliApi from "./cliApi";

const mockGetAiSettings = vi.mocked(api.getAiSettings);
const mockSaveAiSettings = vi.mocked(api.saveAiSettings);
const mockSaveApiKey = vi.mocked(api.saveApiKey);
const mockHasApiKey = vi.mocked(api.hasApiKey);
const mockDeleteApiKey = vi.mocked(api.deleteApiKey);
const mockTestAiConnection = vi.mocked(api.testAiConnection);
const mockListAiModels = vi.mocked(api.listAiModels);

const mockDetectCliBinary = vi.mocked(cliApi.detectCliBinary);
const mockListCliModels = vi.mocked(cliApi.listCliModels);

function resetStore() {
  useAiSettingsStore.setState({
    settings: null,
    hasApiKey: false,
    cliBinaryAvailable: null,
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
  thinkingEnabled: true,
  openaiCompatible: { baseUrl: "" },
};

describe("useAiSettingsStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe("loadSettings", () => {
    it("loads settings and checks for API key", async () => {
      mockGetAiSettings.mockResolvedValueOnce(defaultSettings);
      mockHasApiKey.mockResolvedValueOnce(true);

      await useAiSettingsStore.getState().loadSettings();

      const state = useAiSettingsStore.getState();
      expect(state.settings).toEqual(defaultSettings);
      expect(state.hasApiKey).toBe(true);
    });

    it("sets hasApiKey to false when no key exists", async () => {
      mockGetAiSettings.mockResolvedValueOnce(defaultSettings);
      mockHasApiKey.mockResolvedValueOnce(false);

      await useAiSettingsStore.getState().loadSettings();

      expect(useAiSettingsStore.getState().hasApiKey).toBe(false);
    });
  });

  describe("toolProtocolMode", () => {
    it("defaults to auto in DEFAULT_AI_SETTINGS", () => {
      expect(DEFAULT_AI_SETTINGS.toolProtocolMode).toBe("auto");
    });

    it("round-trips an explicit hermes selection through saveSettings", async () => {
      mockSaveAiSettings.mockResolvedValueOnce(undefined);
      const updated: AiSettings = {
        ...defaultSettings,
        toolProtocolMode: "hermes",
      };
      await useAiSettingsStore.getState().saveSettings(updated);
      expect(mockSaveAiSettings).toHaveBeenCalledWith(updated);
      expect(useAiSettingsStore.getState().settings?.toolProtocolMode).toBe(
        "hermes",
      );
    });
  });

  describe("saveSettings", () => {
    it("saves settings via API and updates store", async () => {
      mockSaveAiSettings.mockResolvedValueOnce(undefined);
      const newSettings: AiSettings = {
        provider: "openai",
        model: "gpt-4o",
        ollamaEndpoint: "http://localhost:11434",
        thinkingEnabled: true,
        openaiCompatible: { baseUrl: "" },
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

    it("does nothing for keyed providers without an API key", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, model: "gpt-4" },
        hasApiKey: false,
      });

      await useAiSettingsStore.getState().testConnection();

      expect(mockTestAiConnection).not.toHaveBeenCalled();
    });

    // 回帰: ollama は API キー不要。hasApiKey=false でサイレント return すると
    // ボタンを押しても何も表示されない (UI 側は keyless プロバイダでボタン有効)。
    it("runs for ollama without an API key", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "ollama", model: "llama3" },
        hasApiKey: false,
      });
      mockTestAiConnection.mockResolvedValueOnce("Connection OK");

      await useAiSettingsStore.getState().testConnection();

      expect(mockTestAiConnection).toHaveBeenCalledTimes(1);
      const state = useAiSettingsStore.getState();
      expect(state.isTestingConnection).toBe(false);
      expect(state.connectionTestResult).toEqual({
        success: true,
        message: "Connection OK",
      });
    });

    it("runs for openai-compatible without an API key", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "openai-compatible",
          model: "local-model",
          openaiCompatible: { baseUrl: "http://localhost:8080/v1" },
        },
        hasApiKey: false,
      });
      mockTestAiConnection.mockResolvedValueOnce("OK");

      await useAiSettingsStore.getState().testConnection();

      expect(mockTestAiConnection).toHaveBeenCalledTimes(1);
      expect(useAiSettingsStore.getState().connectionTestResult).toEqual({
        success: true,
        message: "OK",
      });
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

    it("fetches CLI models when provider is cli", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "cli",
          cli: { kind: "codex", binaryPath: "/usr/bin/codex" },
        },
      });
      const models: AiModel[] = [{ id: "gpt-5.5", name: "GPT-5.5" }];
      mockListCliModels.mockResolvedValueOnce(models);

      await useAiSettingsStore.getState().loadModels();

      expect(mockListCliModels).toHaveBeenCalledWith("codex", "/usr/bin/codex");
      expect(useAiSettingsStore.getState().models).toEqual(models);
    });

    it("does nothing without settings", async () => {
      await useAiSettingsStore.getState().loadModels();
      expect(mockListAiModels).not.toHaveBeenCalled();
    });
  });

  describe("loadSettings — CLI binary detection", () => {
    const cliSettings: AiSettings = {
      ...defaultSettings,
      provider: "cli",
      model: "claude",
      cli: { kind: "claude" },
    };

    it("detects CLI binary when provider is cli", async () => {
      mockGetAiSettings.mockResolvedValueOnce(cliSettings);
      mockHasApiKey.mockResolvedValueOnce(false);
      mockDetectCliBinary.mockResolvedValueOnce("/usr/local/bin/claude");

      await useAiSettingsStore.getState().loadSettings();

      expect(mockDetectCliBinary).toHaveBeenCalledWith("claude");
      expect(useAiSettingsStore.getState().cliBinaryAvailable).toBe(true);
    });

    it("sets cliBinaryAvailable=false when binary not found", async () => {
      mockGetAiSettings.mockResolvedValueOnce(cliSettings);
      mockHasApiKey.mockResolvedValueOnce(false);
      mockDetectCliBinary.mockResolvedValueOnce(null);

      await useAiSettingsStore.getState().loadSettings();

      expect(useAiSettingsStore.getState().cliBinaryAvailable).toBe(false);
    });

    it("does not call detectCliBinary for non-CLI providers", async () => {
      mockGetAiSettings.mockResolvedValueOnce(defaultSettings);
      mockHasApiKey.mockResolvedValueOnce(true);

      await useAiSettingsStore.getState().loadSettings();

      expect(mockDetectCliBinary).not.toHaveBeenCalled();
      expect(useAiSettingsStore.getState().cliBinaryAvailable).toBeNull();
    });
  });

  describe("saveSettings — provider switch and CLI re-detection", () => {
    const cliSettings: AiSettings = {
      ...defaultSettings,
      provider: "cli",
      model: "claude",
      cli: { kind: "claude" },
    };

    it("re-detects when switching to CLI provider", async () => {
      mockSaveAiSettings.mockResolvedValueOnce(undefined);
      mockDetectCliBinary.mockResolvedValueOnce("/usr/local/bin/claude");

      await useAiSettingsStore.getState().saveSettings(cliSettings);

      expect(mockDetectCliBinary).toHaveBeenCalledWith("claude");
      expect(useAiSettingsStore.getState().cliBinaryAvailable).toBe(true);
    });

    it("re-detects when CLI kind changes", async () => {
      useAiSettingsStore.setState({
        settings: cliSettings,
        cliBinaryAvailable: true,
      });
      const codexSettings: AiSettings = {
        ...cliSettings,
        cli: { kind: "codex" },
      };
      mockSaveAiSettings.mockResolvedValueOnce(undefined);
      mockDetectCliBinary.mockResolvedValueOnce(null);

      await useAiSettingsStore.getState().saveSettings(codexSettings);

      expect(mockDetectCliBinary).toHaveBeenCalledWith("codex");
      expect(useAiSettingsStore.getState().cliBinaryAvailable).toBe(false);
    });

    it("resets cliBinaryAvailable when switching away from CLI", async () => {
      useAiSettingsStore.setState({
        settings: cliSettings,
        cliBinaryAvailable: true,
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveSettings(defaultSettings);

      expect(mockDetectCliBinary).not.toHaveBeenCalled();
      expect(useAiSettingsStore.getState().cliBinaryAvailable).toBeNull();
    });
  });
});

describe("selectProviderReadiness", () => {
  it("returns pending when settings is null", () => {
    useAiSettingsStore.setState({ settings: null });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "pending",
    );
  });

  it("returns no-model when model is empty", () => {
    useAiSettingsStore.setState({
      settings: { ...defaultSettings, provider: "openrouter", model: "" },
      hasApiKey: true,
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "no-model",
    );
  });

  it.each([
    ["openrouter" as const],
    ["openai" as const],
    ["anthropic" as const],
    ["ai-novelist" as const],
  ])("%s with key → ready", (provider) => {
    useAiSettingsStore.setState({
      settings: { ...defaultSettings, provider, model: "m" },
      hasApiKey: true,
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "ready",
    );
  });

  it.each([
    ["openrouter" as const],
    ["openai" as const],
    ["anthropic" as const],
    ["ai-novelist" as const],
  ])("%s without key → no-provider", (provider) => {
    useAiSettingsStore.setState({
      settings: { ...defaultSettings, provider, model: "m" },
      hasApiKey: false,
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "no-provider",
    );
  });

  it("openai-compatible with baseUrl → ready", () => {
    useAiSettingsStore.setState({
      settings: {
        ...defaultSettings,
        provider: "openai-compatible",
        model: "m",
        openaiCompatible: { baseUrl: "http://localhost" },
      },
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "ready",
    );
  });

  it("openai-compatible without baseUrl → no-provider", () => {
    useAiSettingsStore.setState({
      settings: {
        ...defaultSettings,
        provider: "openai-compatible",
        model: "m",
        openaiCompatible: { baseUrl: "" },
      },
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "no-provider",
    );
  });

  it("ollama with endpoint → ready", () => {
    useAiSettingsStore.setState({
      settings: {
        ...defaultSettings,
        provider: "ollama",
        model: "llama3",
        ollamaEndpoint: "http://localhost:11434",
      },
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "ready",
    );
  });

  it("ollama without endpoint → no-provider", () => {
    useAiSettingsStore.setState({
      settings: {
        ...defaultSettings,
        provider: "ollama",
        model: "llama3",
        ollamaEndpoint: "",
      },
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "no-provider",
    );
  });

  it("cli with cliBinaryAvailable=null → pending", () => {
    useAiSettingsStore.setState({
      settings: { ...defaultSettings, provider: "cli", model: "claude" },
      cliBinaryAvailable: null,
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "pending",
    );
  });

  it("cli with cliBinaryAvailable=true and empty model → ready", () => {
    useAiSettingsStore.setState({
      settings: {
        ...defaultSettings,
        provider: "cli",
        model: "",
        cli: { kind: "claude", binaryPath: "", model: "" },
      },
      cliBinaryAvailable: true,
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "ready",
    );
  });

  it("cli with cliBinaryAvailable=true → ready", () => {
    useAiSettingsStore.setState({
      settings: { ...defaultSettings, provider: "cli", model: "claude" },
      cliBinaryAvailable: true,
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "ready",
    );
  });

  it("cli with cliBinaryAvailable=false → no-provider", () => {
    useAiSettingsStore.setState({
      settings: { ...defaultSettings, provider: "cli", model: "claude" },
      cliBinaryAvailable: false,
    });
    expect(selectProviderReadiness(useAiSettingsStore.getState())).toBe(
      "no-provider",
    );
  });
});

describe("isRagCapableProvider", () => {
  it("is true only for openrouter and anthropic (Phase 1)", () => {
    expect(isRagCapableProvider("openrouter")).toBe(true);
    expect(isRagCapableProvider("anthropic")).toBe(true);
  });
  it("is false for ollama and other providers (toggle disabled)", () => {
    expect(isRagCapableProvider("ollama")).toBe(false);
    expect(isRagCapableProvider("openai")).toBe(false);
    expect(isRagCapableProvider("openai-compatible")).toBe(false);
    expect(isRagCapableProvider("ai-novelist")).toBe(false);
    expect(isRagCapableProvider("cli")).toBe(false);
    expect(isRagCapableProvider(null)).toBe(false);
    expect(isRagCapableProvider(undefined)).toBe(false);
  });
});
