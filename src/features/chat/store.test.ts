import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useAiSettingsStore,
  refreshDynamicCapsForProvider,
  invalidateOllamaEffectiveContexts,
  selectProviderReadiness,
  isRagCapableProvider,
} from "./store";
import type { AiSettings, AiModel } from "./types";
import { DEFAULT_AI_SETTINGS } from "./types";
import {
  __resetDynamicModelCapsForTests,
  getDynamicModelMeta,
  registerDynamicModelCaps,
} from "./agent/dynamicModelCaps";

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

vi.mock("./codexAppApi", () => ({
  listCodexAppModels: vi.fn(),
}));

import * as api from "./api";
import * as cliApi from "./cliApi";
import * as codexAppApi from "./codexAppApi";

const mockGetAiSettings = vi.mocked(api.getAiSettings);
const mockSaveAiSettings = vi.mocked(api.saveAiSettings);
const mockSaveApiKey = vi.mocked(api.saveApiKey);
const mockHasApiKey = vi.mocked(api.hasApiKey);
const mockDeleteApiKey = vi.mocked(api.deleteApiKey);
const mockTestAiConnection = vi.mocked(api.testAiConnection);
const mockListAiModels = vi.mocked(api.listAiModels);

const mockDetectCliBinary = vi.mocked(cliApi.detectCliBinary);
const mockListCliModels = vi.mocked(cliApi.listCliModels);
const mockListCodexAppModels = vi.mocked(codexAppApi.listCodexAppModels);

function resetStore() {
  useAiSettingsStore.setState({
    settings: null,
    hasApiKey: false,
    cliBinaryAvailable: null,
    isTestingConnection: false,
    connectionTestResult: null,
    models: [],
    isLoadingModels: false,
    modelLoadError: null,
    modelCapsRevision: 0,
    chatModelOverride: null,
    chatProviderOverride: null,
    chatModelVariantOverride: null,
    chatEndpointIdOverride: null,
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
    __resetDynamicModelCapsForTests();
    vi.clearAllMocks();
    mockListAiModels.mockResolvedValue([]);
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

    it("refreshes stale Ollama metadata during startup", async () => {
      const ollamaSettings: AiSettings = {
        ...defaultSettings,
        provider: "ollama",
        model: "gemma4:latest",
      };
      const models: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "gemma4:latest",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
          effectiveContextSource: "runner",
          supportedParameters: ["tools", "reasoning"],
        },
      ];
      mockGetAiSettings.mockResolvedValueOnce(ollamaSettings);
      mockHasApiKey.mockResolvedValueOnce(false);
      mockListAiModels.mockResolvedValueOnce(models);

      await useAiSettingsStore.getState().loadSettings();

      await vi.waitFor(() => {
        expect(useAiSettingsStore.getState().models).toEqual(models);
      });
      expect(mockListAiModels).toHaveBeenCalledWith(
        "ollama",
        undefined,
        null,
        "http://localhost:11434",
      );
      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        ctx: 131_072,
        effectiveCtx: 65_536,
        tools: true,
        reasoning: true,
      });
    });

    it("does not let an older load overwrite settings saved while key lookup is pending", async () => {
      let resolveHasApiKey!: (value: boolean) => void;
      const loadedSettings: AiSettings = {
        ...defaultSettings,
        provider: "ollama",
        model: "old:latest",
        ollamaEndpoint: "http://127.0.0.1:11434",
      };
      const savedSettings: AiSettings = {
        ...defaultSettings,
        provider: "ollama",
        model: "new:latest",
        ollamaEndpoint: "http://127.0.0.1:21434",
      };
      mockGetAiSettings.mockResolvedValueOnce(loadedSettings);
      mockHasApiKey.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveHasApiKey = resolve;
          }),
      );
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      const staleLoad = useAiSettingsStore.getState().loadSettings();
      await vi.waitFor(() => expect(mockHasApiKey).toHaveBeenCalledOnce());
      await useAiSettingsStore.getState().saveSettings(savedSettings);
      resolveHasApiKey(false);
      await staleLoad;

      expect(useAiSettingsStore.getState().settings).toEqual(savedSettings);
      expect(mockListAiModels).not.toHaveBeenCalled();
    });

    it("waits for a pending save before loading the authoritative settings snapshot", async () => {
      let resolveSave!: () => void;
      const savedSettings: AiSettings = {
        ...defaultSettings,
        provider: "ollama",
        model: "new:latest",
        ollamaEndpoint: "http://127.0.0.1:21434",
      };
      mockSaveAiSettings.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          }),
      );
      mockGetAiSettings.mockResolvedValueOnce(savedSettings);
      mockHasApiKey.mockResolvedValueOnce(false);

      const save = useAiSettingsStore.getState().saveSettings(savedSettings);
      const load = useAiSettingsStore.getState().loadSettings();
      await Promise.resolve();
      expect(mockGetAiSettings).not.toHaveBeenCalled();

      resolveSave();
      await Promise.all([save, load]);

      expect(mockGetAiSettings).toHaveBeenCalledOnce();
      expect(useAiSettingsStore.getState().settings).toEqual(savedSettings);
    });
  });

  describe("refreshDynamicCapsForProvider", () => {
    it("shares one in-flight fetch for the same provider", async () => {
      let resolveModels!: (models: AiModel[]) => void;
      mockListAiModels.mockImplementationOnce(
        () => new Promise((resolve) => (resolveModels = resolve)),
      );
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });
      const models: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
        },
      ];

      const first = refreshDynamicCapsForProvider("ollama", { force: true });
      const second = refreshDynamicCapsForProvider("ollama", { force: true });
      expect(mockListAiModels).toHaveBeenCalledTimes(1);

      resolveModels(models);
      await expect(first).resolves.toEqual(models);
      await expect(second).resolves.toEqual(models);
      expect(useAiSettingsStore.getState()).toMatchObject({
        models,
        modelCapsRevision: 1,
      });
    });

    it("does not share a selected-model probe across Ollama endpoints", async () => {
      let resolveFirst!: (models: AiModel[]) => void;
      let resolveSecond!: (models: AiModel[]) => void;
      mockListAiModels
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveFirst = resolve)),
        )
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveSecond = resolve)),
        );
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
          ollamaEndpoint: "http://127.0.0.1:11434",
        },
      });

      const first = refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
        ollamaEndpoint: "http://127.0.0.1:11434",
      });
      useAiSettingsStore.setState((state) => ({
        settings: state.settings
          ? {
              ...state.settings,
              ollamaEndpoint: "http://127.0.0.1:21434",
            }
          : null,
      }));
      const second = refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
        ollamaEndpoint: "http://127.0.0.1:21434",
      });

      expect(mockListAiModels).toHaveBeenCalledTimes(2);
      const currentEndpointModel: AiModel = {
        id: "gemma4:latest",
        name: "Gemma 4",
        contextLength: 131_072,
        effectiveContextLength: 65_536,
        effectiveContextSource: "runner",
      };
      resolveSecond([currentEndpointModel]);
      await second;
      resolveFirst([
        {
          ...currentEndpointModel,
          effectiveContextLength: 4_096,
        },
      ]);
      await first;

      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        effectiveCtx: 65_536,
      });
    });

    it("starts a new probe after an Ollama endpoint A-B-A activation cycle", async () => {
      let resolveOldA!: (models: AiModel[]) => void;
      let resolveNewA!: (models: AiModel[]) => void;
      mockListAiModels
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((resolve) => {
              resolveOldA = resolve;
            }),
        )
        .mockResolvedValueOnce([])
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((resolve) => {
              resolveNewA = resolve;
            }),
        );
      const endpointA = "http://127.0.0.1:11434";
      const endpointB = "http://127.0.0.1:21434";
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
          ollamaEndpoint: endpointA,
        },
      });

      const oldA = refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
        ollamaEndpoint: endpointA,
      });
      useAiSettingsStore.setState((state) => ({
        settings: state.settings
          ? { ...state.settings, ollamaEndpoint: endpointB }
          : null,
      }));
      await refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
        ollamaEndpoint: endpointB,
      });
      useAiSettingsStore.setState((state) => ({
        settings: state.settings
          ? { ...state.settings, ollamaEndpoint: endpointA }
          : null,
      }));
      const newA = refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
        ollamaEndpoint: endpointA,
      });

      expect(mockListAiModels).toHaveBeenCalledTimes(3);
      resolveNewA([
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ]);
      await newA;
      resolveOldA([
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 4_096,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ]);
      await oldA;

      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        effectiveCtx: 65_536,
      });
    });

    it("does not let an older full failure clear a newer selected observation", async () => {
      let rejectFull!: (error: Error) => void;
      let resolveSelected!: (models: AiModel[]) => void;
      mockListAiModels
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((_, reject) => {
              rejectFull = reject;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((resolve) => {
              resolveSelected = resolve;
            }),
        );
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });

      const full = refreshDynamicCapsForProvider("ollama", { force: true });
      const selected = refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
      });
      resolveSelected([
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ]);
      await selected;
      rejectFull(new Error("older full failed"));
      await full;

      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        ctx: 131_072,
        effectiveCtx: 65_536,
        tools: true,
      });
      expect(useAiSettingsStore.getState().models[0]).toMatchObject({
        effectiveContextLength: 65_536,
      });
    });

    it("merges an older full success without replacing a newer selected effective value", async () => {
      let resolveFull!: (models: AiModel[]) => void;
      let resolveSelected!: (models: AiModel[]) => void;
      mockListAiModels
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((resolve) => {
              resolveFull = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((resolve) => {
              resolveSelected = resolve;
            }),
        );
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });

      const full = refreshDynamicCapsForProvider("ollama", { force: true });
      const selected = refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
      });
      resolveSelected([
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ]);
      await selected;
      resolveFull([
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 4_096,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ]);
      await full;

      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        effectiveCtx: 65_536,
      });
      expect(useAiSettingsStore.getState().models[0]).toMatchObject({
        effectiveContextLength: 65_536,
      });
    });

    it("does not let an older selected failure clear a newer full observation", async () => {
      let rejectSelected!: (error: Error) => void;
      let resolveFull!: (models: AiModel[]) => void;
      mockListAiModels
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((_, reject) => {
              rejectSelected = reject;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((resolve) => {
              resolveFull = resolve;
            }),
        );
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });

      const selected = refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
      });
      const full = refreshDynamicCapsForProvider("ollama", { force: true });
      resolveFull([
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ]);
      await full;
      rejectSelected(new Error("older selected failed"));
      await selected;

      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        ctx: 131_072,
        effectiveCtx: 65_536,
      });
      expect(useAiSettingsStore.getState().models[0]).toMatchObject({
        effectiveContextLength: 65_536,
      });
    });

    it("retains older durable metadata but not effective context after a newer selected failure", async () => {
      let resolveFull!: (models: AiModel[]) => void;
      let rejectSelected!: (error: Error) => void;
      mockListAiModels
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((resolve) => {
              resolveFull = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((_, reject) => {
              rejectSelected = reject;
            }),
        );
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });

      const full = refreshDynamicCapsForProvider("ollama", { force: true });
      const selected = refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
      });
      rejectSelected(new Error("newer selected failed"));
      await selected;
      resolveFull([
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ]);
      await full;

      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        ctx: 131_072,
        tools: true,
        effectiveCtx: undefined,
      });
      expect(useAiSettingsStore.getState().models[0]).toMatchObject({
        contextLength: 131_072,
        supportedParameters: ["tools"],
      });
      expect(
        useAiSettingsStore.getState().models[0]?.effectiveContextLength,
      ).toBeUndefined();
    });

    it("does not resurrect a model after a newer selected lookup returns no row", async () => {
      let resolveFull!: (models: AiModel[]) => void;
      let resolveSelected!: (models: AiModel[]) => void;
      mockListAiModels
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((resolve) => {
              resolveFull = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<AiModel[]>((resolve) => {
              resolveSelected = resolve;
            }),
        );
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "deleted:latest",
        },
      });

      const full = refreshDynamicCapsForProvider("ollama", { force: true });
      const selected = refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "deleted:latest",
      });
      resolveSelected([]);
      await selected;
      resolveFull([
        {
          id: "deleted:latest",
          name: "Deleted",
          contextLength: 32_768,
          effectiveContextLength: 32_768,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ]);
      await full;

      expect(getDynamicModelMeta("ollama", "deleted:latest")).toBeNull();
      expect(useAiSettingsStore.getState().models).toEqual([]);
    });

    it("force refreshes a fresh provider cache", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });
      registerDynamicModelCaps(
        "ollama",
        [
          {
            id: "gemma4:latest",
            name: "Gemma 4",
            contextLength: 32_768,
          },
        ],
        { ollamaEndpoint: defaultSettings.ollamaEndpoint },
      );
      const refreshed: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
        },
      ];
      mockListAiModels.mockResolvedValueOnce(refreshed);

      await expect(
        refreshDynamicCapsForProvider("ollama", {
          ollamaEndpoint: defaultSettings.ollamaEndpoint,
        }),
      ).resolves.toBeNull();
      expect(mockListAiModels).not.toHaveBeenCalled();

      await expect(
        refreshDynamicCapsForProvider("ollama", {
          force: true,
          ollamaEndpoint: defaultSettings.ollamaEndpoint,
        }),
      ).resolves.toEqual(refreshed);
      expect(mockListAiModels).toHaveBeenCalledOnce();
      expect(getDynamicModelMeta("ollama", "gemma4:latest")?.ctx).toBe(131_072);
    });

    it("probes and merges only the selected Ollama model", async () => {
      const existingModels: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 4_096,
          effectiveContextSource: "runner",
        },
        { id: "unrelated:latest", name: "Unrelated", contextLength: 65_536 },
      ];
      const selectedProbe: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ];
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
        models: existingModels,
      });
      mockListAiModels.mockResolvedValueOnce(selectedProbe);

      await refreshDynamicCapsForProvider("ollama", {
        force: true,
        selectedModelId: "gemma4:latest",
      });

      expect(mockListAiModels).toHaveBeenCalledWith(
        "ollama",
        undefined,
        "gemma4:latest",
        "http://localhost:11434",
      );
      expect(useAiSettingsStore.getState().models).toEqual([
        selectedProbe[0],
        existingModels[1],
      ]);
      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        ctx: 131_072,
        effectiveCtx: 65_536,
      });
    });

    it("retains durable metadata and clears effective context when selected enrichment is unavailable", async () => {
      const existing: AiModel = {
        id: "gemma4:latest",
        name: "Gemma 4",
        contextLength: 131_072,
        effectiveContextLength: 65_536,
        effectiveContextSource: "runner",
        supportedParameters: ["tools"],
      };
      registerDynamicModelCaps("ollama", [existing], {
        ollamaEndpoint: defaultSettings.ollamaEndpoint,
      });
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
        models: [existing],
      });
      mockListAiModels.mockResolvedValueOnce([
        { id: "gemma4:latest", name: "Gemma 4" },
      ]);

      await expect(
        refreshDynamicCapsForProvider("ollama", {
          force: true,
          selectedModelId: "gemma4:latest",
          requireOllamaCapabilities: true,
        }),
      ).resolves.toBeNull();

      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        ctx: 131_072,
        tools: true,
        effectiveCtx: undefined,
      });
      expect(useAiSettingsStore.getState().models[0]).toMatchObject({
        contextLength: 131_072,
        supportedParameters: ["tools"],
      });
      expect(
        useAiSettingsStore.getState().models[0]?.effectiveContextLength,
      ).toBeUndefined();
    });

    it("rejects a selected Ollama tag row with no context metadata", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
          ollamaContextLengths: {},
        },
        models: [],
      });
      mockListAiModels.mockResolvedValueOnce([
        { id: "gemma4:latest", name: "Gemma 4" },
      ]);

      await expect(
        refreshDynamicCapsForProvider("ollama", {
          force: true,
          selectedModelId: "gemma4:latest",
        }),
      ).resolves.toBeNull();

      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toBeNull();
      expect(useAiSettingsStore.getState().models).toEqual([]);
    });

    it("keeps identical bare model ids isolated by provider", async () => {
      mockListAiModels
        .mockResolvedValueOnce([
          {
            id: "shared:latest",
            name: "OpenRouter shared",
            contextLength: 200_000,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "shared:latest",
            name: "Ollama shared",
            contextLength: 131_072,
            effectiveContextLength: 16_384,
            effectiveContextSource: "runner",
          },
        ]);

      await refreshDynamicCapsForProvider("openrouter", { force: true });
      await refreshDynamicCapsForProvider("ollama", { force: true });

      expect(getDynamicModelMeta("openrouter", "shared:latest")).toMatchObject({
        ctx: 200_000,
      });
      expect(getDynamicModelMeta("ollama", "shared:latest")).toMatchObject({
        ctx: 131_072,
        effectiveCtx: 16_384,
      });
    });

    it("does not let a response for the previous provider replace active models", async () => {
      let resolveModels!: (models: AiModel[]) => void;
      mockListAiModels.mockImplementationOnce(
        () => new Promise((resolve) => (resolveModels = resolve)),
      );
      useAiSettingsStore.setState({
        settings: defaultSettings,
        models: [{ id: "current", name: "Current" }],
      });

      const pending = refreshDynamicCapsForProvider("openrouter", {
        force: true,
      });
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "local",
        },
        models: [{ id: "local", name: "Local" }],
      });
      resolveModels([
        {
          id: "stale",
          name: "Stale",
          contextLength: 64_000,
        },
      ]);

      await pending;
      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [{ id: "local", name: "Local" }],
        modelCapsRevision: 0,
      });
      expect(getDynamicModelMeta("openrouter", "stale")?.ctx).toBe(64_000);
    });

    it("returns null, preserves static metadata, and clears stale runner state on failure", async () => {
      registerDynamicModelCaps(
        "ollama",
        [
          {
            id: "gemma4:latest",
            name: "Gemma 4",
            contextLength: 131_072,
            effectiveContextLength: 32_768,
            effectiveContextSource: "model-parameter",
          },
        ],
        { ollamaEndpoint: defaultSettings.ollamaEndpoint },
      );
      const existingModels: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 32_768,
          effectiveContextSource: "model-parameter",
        },
      ];
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
        models: existingModels,
        modelCapsRevision: 7,
      });
      mockListAiModels.mockRejectedValueOnce(new Error("Ollama offline"));

      await expect(
        refreshDynamicCapsForProvider("ollama", { force: true }),
      ).resolves.toBeNull();

      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [
          {
            id: "gemma4:latest",
            name: "Gemma 4",
            contextLength: 131_072,
          },
        ],
        modelCapsRevision: 8,
      });
      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        ctx: 131_072,
        effectiveCtx: undefined,
        effectiveSource: undefined,
      });
    });

    it("does not mutate an active non-Ollama catalog with the same bare id", () => {
      const openRouterModel: AiModel = {
        id: "shared:latest",
        name: "OpenRouter shared",
        contextLength: 128_000,
      };
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "openrouter",
          model: "shared:latest",
        },
        models: [openRouterModel],
        modelCapsRevision: 3,
      });

      invalidateOllamaEffectiveContexts("shared:latest");

      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [openRouterModel],
        modelCapsRevision: 3,
      });
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

  describe("chatModelOverride (temporary chat model)", () => {
    it("setChatModelOverride sets and clears the override", () => {
      useAiSettingsStore.getState().setChatModelOverride("openai/gpt-4o");
      expect(useAiSettingsStore.getState().chatModelOverride).toBe(
        "openai/gpt-4o",
      );
      useAiSettingsStore.getState().setChatModelOverride(null);
      expect(useAiSettingsStore.getState().chatModelOverride).toBeNull();
    });

    it("does NOT change the persisted default model", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, model: "default-model" },
      });
      useAiSettingsStore.getState().setChatModelOverride("temp-model");
      // 一時モデルは settings.model を書き換えない(既定は維持)。
      expect(useAiSettingsStore.getState().settings?.model).toBe(
        "default-model",
      );
      expect(useAiSettingsStore.getState().chatModelOverride).toBe(
        "temp-model",
      );
    });

    it("is cleared when the provider changes (model namespace differs)", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "openai", model: "gpt-4o" },
        chatModelOverride: "gpt-4o-mini",
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveSettings({
        ...defaultSettings,
        provider: "anthropic",
        model: "",
      });

      expect(useAiSettingsStore.getState().chatModelOverride).toBeNull();
    });

    it("is preserved when provider is unchanged (e.g. toggling thinking)", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "openai", model: "gpt-4o" },
        chatModelOverride: "gpt-4o-mini",
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveSettings({
        ...defaultSettings,
        provider: "openai",
        model: "gpt-4o",
        thinkingEnabled: false,
      });

      expect(useAiSettingsStore.getState().chatModelOverride).toBe(
        "gpt-4o-mini",
      );
    });
  });

  describe("cross-provider chat model override", () => {
    it("setChatModelOverride with opts.provider sets provider + variant override", () => {
      useAiSettingsStore.getState().setChatModelOverride("fugu", {
        provider: "sakana",
        variant: "responses",
      });
      const st = useAiSettingsStore.getState();
      expect(st.chatModelOverride).toBe("fugu");
      expect(st.chatProviderOverride).toBe("sakana");
      expect(st.chatModelVariantOverride).toBe("responses");
    });

    it("same-provider override (no opts) clears any prior provider/variant override", () => {
      useAiSettingsStore.setState({
        chatModelOverride: "fugu",
        chatProviderOverride: "sakana",
        chatModelVariantOverride: "responses",
      });
      // 同一プロバイダ内の一時モデル選択 → 別プロバイダ override は解除される。
      useAiSettingsStore.getState().setChatModelOverride("openai/gpt-4o");
      const st = useAiSettingsStore.getState();
      expect(st.chatModelOverride).toBe("openai/gpt-4o");
      expect(st.chatProviderOverride).toBeNull();
      expect(st.chatModelVariantOverride).toBeNull();
    });

    it("setChatModelOverride(null) clears provider + variant override too", () => {
      useAiSettingsStore.setState({
        chatModelOverride: "fugu",
        chatProviderOverride: "sakana",
        chatModelVariantOverride: "responses",
      });
      useAiSettingsStore.getState().setChatModelOverride(null);
      const st = useAiSettingsStore.getState();
      expect(st.chatModelOverride).toBeNull();
      expect(st.chatProviderOverride).toBeNull();
      expect(st.chatModelVariantOverride).toBeNull();
    });

    it("is fully cleared on provider switch", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "openai", model: "gpt-4o" },
        chatModelOverride: "fugu",
        chatProviderOverride: "sakana",
        chatModelVariantOverride: "responses",
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveSettings({
        ...defaultSettings,
        provider: "anthropic",
        model: "",
      });

      const st = useAiSettingsStore.getState();
      expect(st.chatModelOverride).toBeNull();
      expect(st.chatProviderOverride).toBeNull();
      expect(st.chatModelVariantOverride).toBeNull();
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

    it("keeps the last successful serialized save when the next queued save fails", async () => {
      let resolveFirst!: () => void;
      const firstSettings: AiSettings = {
        ...defaultSettings,
        provider: "ollama",
        model: "first:latest",
      };
      const secondSettings: AiSettings = {
        ...defaultSettings,
        provider: "ollama",
        model: "second:latest",
      };
      mockSaveAiSettings
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockRejectedValueOnce(new Error("second save failed"));

      const first = useAiSettingsStore.getState().saveSettings(firstSettings);
      const second = useAiSettingsStore.getState().saveSettings(secondSettings);
      await vi.waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
      resolveFirst();

      await first;
      await expect(second).rejects.toThrow("second save failed");
      expect(useAiSettingsStore.getState().settings).toEqual(firstSettings);
    });

    it("invalidates Ollama models, capability scope, and loading on endpoint change", async () => {
      const endpointA = "http://127.0.0.1:11434";
      const endpointB = "http://127.0.0.1:21434";
      registerDynamicModelCaps(
        "ollama",
        [
          {
            id: "shared:latest",
            name: "Endpoint A",
            supportedParameters: [],
          },
        ],
        { ollamaEndpoint: endpointA },
      );
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "shared:latest",
          ollamaEndpoint: endpointA,
        },
        models: [{ id: "shared:latest", name: "Endpoint A" }],
        isLoadingModels: true,
        connectionTestResult: { success: true, message: "old endpoint" },
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveSettings({
        ...defaultSettings,
        provider: "ollama",
        model: "shared:latest",
        ollamaEndpoint: endpointB,
      });

      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [],
        isLoadingModels: false,
        modelLoadError: null,
        modelCapsRevision: 1,
        connectionTestResult: null,
      });
      expect(getDynamicModelMeta("ollama", "shared:latest")).toBeNull();
      expect(
        getDynamicModelMeta("ollama", "shared:latest", endpointB),
      ).toBeNull();
    });
  });

  describe("saveApiKey", () => {
    it("saves key for current provider and sets hasApiKey", async () => {
      // Set up initial settings so provider is known
      useAiSettingsStore.setState({ settings: defaultSettings });
      mockSaveApiKey.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveApiKey("sk-or-new-key");

      // openai-compatible 以外は endpoint id を持たない(undefined)。
      expect(mockSaveApiKey).toHaveBeenCalledWith(
        "openrouter",
        "sk-or-new-key",
        undefined,
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

      expect(mockDeleteApiKey).toHaveBeenCalledWith("openrouter", undefined);
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

    it("registers Ollama metadata when models are explicitly loaded", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });
      const models: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
          effectiveContextSource: "runner",
          supportedParameters: ["tools"],
        },
      ];
      mockListAiModels.mockResolvedValueOnce(models);

      await useAiSettingsStore.getState().loadModels();

      expect(useAiSettingsStore.getState()).toMatchObject({
        models,
        isLoadingModels: false,
        modelCapsRevision: 1,
      });
      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        ctx: 131_072,
        effectiveCtx: 65_536,
        effectiveSource: "runner",
        tools: true,
      });
    });

    it("reuses a non-empty fresh Ollama catalog on repeated menu loads", async () => {
      const models: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          supportedParameters: ["tools"],
        },
      ];
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });
      mockListAiModels.mockResolvedValueOnce(models);

      await useAiSettingsStore.getState().loadModels();
      await useAiSettingsStore.getState().loadModels();

      expect(mockListAiModels).toHaveBeenCalledTimes(1);
      expect(useAiSettingsStore.getState()).toMatchObject({
        models,
        isLoadingModels: false,
        modelLoadError: null,
      });
    });

    it("lets an explicit refresh replace a non-empty fresh Ollama catalog", async () => {
      const firstModels: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
        },
      ];
      const refreshedModels: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4 replaced",
          contextLength: 262_144,
        },
      ];
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });
      mockListAiModels
        .mockResolvedValueOnce(firstModels)
        .mockResolvedValueOnce(refreshedModels);

      await useAiSettingsStore.getState().loadModels();
      await useAiSettingsStore.getState().loadModels({ force: true });

      expect(mockListAiModels).toHaveBeenCalledTimes(2);
      expect(useAiSettingsStore.getState().models).toEqual(refreshedModels);
    });

    it("refreshes a non-empty Ollama catalog after its capability cache becomes stale", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const firstModels: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
        },
      ];
      const refreshedModels: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Gemma 4 refreshed",
          contextLength: 131_072,
        },
      ];
      try {
        useAiSettingsStore.setState({
          settings: {
            ...defaultSettings,
            provider: "ollama",
            model: "gemma4:latest",
          },
        });
        mockListAiModels
          .mockResolvedValueOnce(firstModels)
          .mockResolvedValueOnce(refreshedModels);

        await useAiSettingsStore.getState().loadModels();
        now.mockReturnValue(1_000 + 24 * 60 * 60 * 1_000 + 1);
        await useAiSettingsStore.getState().loadModels();

        expect(mockListAiModels).toHaveBeenCalledTimes(2);
        expect(useAiSettingsStore.getState().models).toEqual(refreshedModels);
      } finally {
        now.mockRestore();
      }
    });

    it("retries a fresh but empty Ollama catalog", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
      });
      mockListAiModels.mockResolvedValue([]);

      await useAiSettingsStore.getState().loadModels();
      await useAiSettingsStore.getState().loadModels();

      expect(mockListAiModels).toHaveBeenCalledTimes(2);
      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [],
        isLoadingModels: false,
        modelLoadError: null,
      });
    });

    it("continues to force-refresh a fresh OpenRouter catalog", async () => {
      const firstModels: AiModel[] = [
        { id: "openai/gpt-5", name: "GPT-5", contextLength: 400_000 },
      ];
      const refreshedModels: AiModel[] = [
        { id: "openai/gpt-5", name: "GPT-5 refreshed", contextLength: 400_000 },
      ];
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "openrouter",
          model: "openai/gpt-5",
        },
      });
      mockListAiModels
        .mockResolvedValueOnce(firstModels)
        .mockResolvedValueOnce(refreshedModels);

      await useAiSettingsStore.getState().loadModels();
      await useAiSettingsStore.getState().loadModels();

      expect(mockListAiModels).toHaveBeenCalledTimes(2);
      expect(useAiSettingsStore.getState().models).toEqual(refreshedModels);
    });

    it("keeps the last Ollama models when an explicit refresh fails", async () => {
      const existingModels: AiModel[] = [
        { id: "gemma4:latest", name: "Gemma 4" },
      ];
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
        },
        models: existingModels,
      });
      mockListAiModels.mockRejectedValueOnce(new Error("Ollama offline"));

      await useAiSettingsStore.getState().loadModels();

      expect(useAiSettingsStore.getState()).toMatchObject({
        models: existingModels,
        isLoadingModels: false,
        modelLoadError: "Failed to refresh ollama models",
      });
    });

    it("does not apply a full Ollama catalog response from a previous endpoint", async () => {
      let resolveOld!: (models: AiModel[]) => void;
      let resolveCurrent!: (models: AiModel[]) => void;
      mockListAiModels
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveOld = resolve)),
        )
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveCurrent = resolve)),
        );
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "ollama",
          model: "gemma4:latest",
          ollamaEndpoint: "http://127.0.0.1:11434",
        },
        models: [{ id: "current", name: "Current" }],
      });

      const oldRequest = useAiSettingsStore.getState().loadModels();
      useAiSettingsStore.setState((state) => ({
        settings: state.settings
          ? {
              ...state.settings,
              ollamaEndpoint: "http://127.0.0.1:21434",
            }
          : null,
      }));
      const currentRequest = useAiSettingsStore.getState().loadModels();

      resolveOld([
        {
          id: "gemma4:latest",
          name: "Old endpoint",
          contextLength: 131_072,
          effectiveContextLength: 4_096,
          effectiveContextSource: "runner",
        },
      ]);
      await oldRequest;
      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [{ id: "current", name: "Current" }],
        isLoadingModels: true,
      });

      const currentModels: AiModel[] = [
        {
          id: "gemma4:latest",
          name: "Current endpoint",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
          effectiveContextSource: "runner",
        },
      ];
      resolveCurrent(currentModels);
      await currentRequest;

      expect(useAiSettingsStore.getState()).toMatchObject({
        models: currentModels,
        isLoadingModels: false,
      });
      expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
        effectiveCtx: 65_536,
      });
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

    it("fetches models from the Codex App Server transport", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "cli",
          cli: {
            kind: "codex",
            binaryPath: "/usr/bin/codex",
            codexTransport: "app-server",
          },
        },
      });
      const models: AiModel[] = [{ id: "gpt-5.5", name: "GPT-5.5" }];
      mockListCodexAppModels.mockResolvedValueOnce(models);

      await useAiSettingsStore.getState().loadModels();

      expect(mockListCodexAppModels).toHaveBeenCalledOnce();
      expect(mockListCliModels).not.toHaveBeenCalled();
      expect(useAiSettingsStore.getState().models).toEqual(models);
    });

    it("does nothing without settings", async () => {
      await useAiSettingsStore.getState().loadModels();
      expect(mockListAiModels).not.toHaveBeenCalled();
    });

    it("discards a stale model response after the provider changes", async () => {
      let resolveOld!: (models: AiModel[]) => void;
      mockListAiModels.mockImplementationOnce(
        () => new Promise((resolve) => (resolveOld = resolve)),
      );
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "ai-novelist" },
        models: [{ id: "old", name: "Old" }],
      });

      const pending = useAiSettingsStore.getState().loadModels();
      mockSaveAiSettings.mockResolvedValueOnce(undefined);
      await useAiSettingsStore.getState().saveSettings({
        ...defaultSettings,
        provider: "openrouter",
      });

      expect(useAiSettingsStore.getState().models).toEqual([]);
      resolveOld([{ id: "ai-novelist-v1", name: "AI Novelist" }]);
      await pending;
      expect(useAiSettingsStore.getState().models).toEqual([]);
    });

    it("keeps the latest request loading when an identical older request resolves", async () => {
      let resolveFirst!: (models: AiModel[]) => void;
      let resolveLatest!: (models: AiModel[]) => void;
      mockListAiModels
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveFirst = resolve)),
        )
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveLatest = resolve)),
        );
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "openai" },
        models: [{ id: "current", name: "Current" }],
      });

      const first = useAiSettingsStore.getState().loadModels();
      const latest = useAiSettingsStore.getState().loadModels();
      resolveFirst([{ id: "stale", name: "Stale" }]);
      await first;

      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [{ id: "current", name: "Current" }],
        isLoadingModels: true,
      });

      resolveLatest([{ id: "latest", name: "Latest" }]);
      await latest;
      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [{ id: "latest", name: "Latest" }],
        isLoadingModels: false,
      });
    });

    it("discards an ABA response after settings return to their original values", async () => {
      let resolveFirst!: (models: AiModel[]) => void;
      let resolveLatest!: (models: AiModel[]) => void;
      mockListAiModels
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveFirst = resolve)),
        )
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveLatest = resolve)),
        );
      const settingsA: AiSettings = {
        ...defaultSettings,
        provider: "openai-compatible",
        activeOpenaiCompatibleEndpointId: "endpoint-a",
      };
      useAiSettingsStore.setState({
        settings: settingsA,
        models: [{ id: "current", name: "Current" }],
      });
      const first = useAiSettingsStore.getState().loadModels();

      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "openai-compatible",
          activeOpenaiCompatibleEndpointId: "endpoint-b",
        },
      });
      useAiSettingsStore.setState({ settings: settingsA });
      const latest = useAiSettingsStore.getState().loadModels();

      resolveFirst([{ id: "stale-a", name: "Stale A" }]);
      await first;
      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [{ id: "current", name: "Current" }],
        isLoadingModels: true,
      });

      resolveLatest([{ id: "latest-a", name: "Latest A" }]);
      await latest;
      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [{ id: "latest-a", name: "Latest A" }],
        isLoadingModels: false,
      });
    });

    it("clears loading when the latest parallel request fails", async () => {
      let resolveFirst!: (models: AiModel[]) => void;
      let rejectLatest!: (cause: Error) => void;
      mockListAiModels
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveFirst = resolve)),
        )
        .mockImplementationOnce(
          () => new Promise((_resolve, reject) => (rejectLatest = reject)),
        );
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "openai" },
        models: [{ id: "current", name: "Current" }],
      });

      const first = useAiSettingsStore.getState().loadModels();
      const latest = useAiSettingsStore.getState().loadModels();
      resolveFirst([{ id: "stale", name: "Stale" }]);
      await first;
      expect(useAiSettingsStore.getState().isLoadingModels).toBe(true);

      rejectLatest(new Error("latest failed"));
      await latest;
      expect(useAiSettingsStore.getState()).toMatchObject({
        models: [],
        isLoadingModels: false,
      });
    });

    it.each([
      [
        "kind",
        {
          kind: "claude",
          binaryPath: "/usr/bin/codex",
          codexTransport: "app-server",
        },
      ],
      [
        "transport",
        {
          kind: "codex",
          binaryPath: "/usr/bin/codex",
          codexTransport: "exec",
        },
      ],
      [
        "binary path",
        {
          kind: "codex",
          binaryPath: "/opt/codex",
          codexTransport: "app-server",
        },
      ],
    ] satisfies Array<[string, NonNullable<AiSettings["cli"]>]>)(
      "discards a stale Codex model response after CLI %s changes",
      async (_, cli) => {
        let resolveOld!: (models: AiModel[]) => void;
        mockListCodexAppModels.mockImplementationOnce(
          () => new Promise((resolve) => (resolveOld = resolve)),
        );
        useAiSettingsStore.setState({
          settings: {
            ...defaultSettings,
            provider: "cli",
            cli: {
              kind: "codex",
              binaryPath: "/usr/bin/codex",
              codexTransport: "app-server",
            },
          },
          models: [{ id: "current", name: "Current" }],
        });

        const pending = useAiSettingsStore.getState().loadModels();
        useAiSettingsStore.setState({
          settings: { ...defaultSettings, provider: "cli", cli },
        });
        resolveOld([{ id: "stale", name: "Stale" }]);
        await pending;

        expect(useAiSettingsStore.getState().models).toEqual([
          { id: "current", name: "Current" },
        ]);
      },
    );
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

    it("uses an explicit binary path without requiring it on PATH", async () => {
      mockGetAiSettings.mockResolvedValueOnce({
        ...cliSettings,
        cli: { kind: "codex", binaryPath: "/opt/codex/bin/codex" },
      });
      mockHasApiKey.mockResolvedValueOnce(false);

      await useAiSettingsStore.getState().loadSettings();

      expect(mockDetectCliBinary).not.toHaveBeenCalled();
      expect(useAiSettingsStore.getState().cliBinaryAvailable).toBe(true);
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

    it("marks an explicit binary path available when only the path changes", async () => {
      useAiSettingsStore.setState({
        settings: cliSettings,
        cliBinaryAvailable: false,
      });
      const settingsWithExplicitPath: AiSettings = {
        ...cliSettings,
        cli: { kind: "claude", binaryPath: "/opt/claude/bin/claude" },
      };
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      await useAiSettingsStore
        .getState()
        .saveSettings(settingsWithExplicitPath);

      expect(mockDetectCliBinary).not.toHaveBeenCalled();
      expect(useAiSettingsStore.getState().cliBinaryAvailable).toBe(true);
    });

    it("re-detects PATH availability when an explicit path is cleared", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...cliSettings,
          cli: { kind: "claude", binaryPath: "/opt/claude/bin/claude" },
        },
        cliBinaryAvailable: true,
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);
      mockDetectCliBinary.mockResolvedValueOnce(null);

      await useAiSettingsStore.getState().saveSettings(cliSettings);

      expect(mockDetectCliBinary).toHaveBeenCalledWith("claude");
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

  // 回帰: 接続テスト結果は provider/model/API経路(modelApiVariant)に紐づく。
  // いずれかを切替えても前の結果が残ると「別プロバイダ/別経路なのに成功と出ている」
  // 誤解を生む。
  describe("saveSettings — connectionTestResult invalidation", () => {
    it("clears connectionTestResult when provider changes", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "openai", model: "gpt-4o" },
        connectionTestResult: { success: true, message: "OpenAI OK" },
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveSettings({
        ...defaultSettings,
        provider: "anthropic",
        model: "gpt-4o",
      });

      expect(useAiSettingsStore.getState().connectionTestResult).toBeNull();
    });

    it("clears connectionTestResult when model changes", async () => {
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "openai", model: "gpt-4o" },
        connectionTestResult: { success: true, message: "gpt-4o OK" },
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveSettings({
        ...defaultSettings,
        provider: "openai",
        model: "gpt-4o-mini",
      });

      expect(useAiSettingsStore.getState().connectionTestResult).toBeNull();
    });

    it("clears connectionTestResult when modelApiVariant (Responses toggle) changes", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...defaultSettings,
          provider: "openai",
          model: "gpt-5",
          modelApiVariant: null,
        },
        connectionTestResult: { success: true, message: "chat/completions OK" },
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      await useAiSettingsStore.getState().saveSettings({
        ...defaultSettings,
        provider: "openai",
        model: "gpt-5",
        modelApiVariant: "responses",
      });

      expect(useAiSettingsStore.getState().connectionTestResult).toBeNull();
    });

    it("keeps connectionTestResult when neither provider nor model change", async () => {
      const result = { success: true as const, message: "still valid" };
      useAiSettingsStore.setState({
        settings: { ...defaultSettings, provider: "openai", model: "gpt-4o" },
        connectionTestResult: result,
      });
      mockSaveAiSettings.mockResolvedValueOnce(undefined);

      // thinking トグルだけ変える(provider/model は不変)。
      await useAiSettingsStore.getState().saveSettings({
        ...defaultSettings,
        provider: "openai",
        model: "gpt-4o",
        thinkingEnabled: false,
      });

      expect(useAiSettingsStore.getState().connectionTestResult).toEqual(
        result,
      );
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
    ["sakana" as const],
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
    ["sakana" as const],
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

  it("cli with an explicit binary path ignores a stale PATH miss", () => {
    useAiSettingsStore.setState({
      settings: {
        ...defaultSettings,
        provider: "cli",
        model: "gpt-5",
        cli: { kind: "codex", binaryPath: "/opt/codex/bin/codex" },
      },
      cliBinaryAvailable: false,
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
