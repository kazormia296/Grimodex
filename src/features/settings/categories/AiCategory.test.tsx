// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RuntimeCapabilitiesProvider } from "@/runtime/runtimeCapabilitiesContext";
import { AiCategory } from "./AiCategory";

const OLLAMA_ENDPOINT = "http://localhost:11434";
const GEMMA_CONTEXT_KEY = JSON.stringify([OLLAMA_ENDPOINT, "gemma4"]);
const LEGACY_GEMMA_LATEST_CONTEXT_KEY = JSON.stringify([
  OLLAMA_ENDPOINT,
  "gemma4:latest",
]);

const aiStoreFixture = vi.hoisted(() => ({
  settings: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    thinkingEnabled: false,
    ollamaEndpoint: "http://localhost:11434",
    ollamaContextLengths: {} as Record<string, number>,
    openaiCompatible: { baseUrl: "" },
    openaiCompatibleEndpoints: [] as unknown[],
    activeOpenaiCompatibleEndpointId: null,
  },
  models: [] as Array<Record<string, unknown>>,
  saveSettings: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: () => ({
    settings: aiStoreFixture.settings,
    hasApiKey: true,
    isTestingConnection: false,
    connectionTestResult: null,
    models: aiStoreFixture.models,
    isLoadingModels: false,
    loadSettings: vi.fn(),
    saveSettings: aiStoreFixture.saveSettings,
    saveApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    testConnection: vi.fn(),
    loadModels: vi.fn(),
  }),
  isRagCapableProvider: (p: string) => p === "openrouter" || p === "anthropic",
}));

vi.mock("@/features/chat/types", () => {
  const normalizeOllamaModelId = (model: string) =>
    model
      .trim()
      .toLowerCase()
      .replace(/:latest$/u, "");
  const serialize = (endpoint: string, model: string) =>
    JSON.stringify([endpoint.trim().replace(/\/+$/u, ""), model]);
  return {
    AI_PROVIDERS: ["anthropic", "openai", "ollama"],
    groupModelsByDeveloper: () => [],
    getOpenaiCompatibleEndpoints: () => [],
    getOpenrouterProviderPins: () => [],
    DEFAULT_OPENAI_COMPATIBLE_SETTINGS: { baseUrl: "" },
    normalizeOllamaModelId,
    ollamaContextLengthSettingKey: (endpoint: string, model: string) =>
      serialize(endpoint, normalizeOllamaModelId(model)),
    ollamaContextLengthSettingKeys: (endpoint: string, model: string) => {
      const normalized = normalizeOllamaModelId(model);
      const trimmed = model.trim();
      return [
        ...new Set([
          normalized,
          trimmed,
          `${normalized}:latest`,
          /:latest$/iu.test(trimmed)
            ? trimmed.replace(/:latest$/iu, "")
            : `${trimmed}:latest`,
        ]),
      ].map((candidate) => serialize(endpoint, candidate));
    },
  };
});

vi.mock("@/features/chat/agent/modelLimits", () => ({
  getModelCapabilities: () => ({
    contextWindow: 200000,
    supportsThinking: false,
  }),
  resolveModelCapabilities: () => ({
    contextWindow: 200000,
    supportsThinking: false,
  }),
  registerAinoveristCaps: () => {},
}));

// AiCategory は AiProjectSettings（プロジェクト固有の AI 設定）を内包する。
// project 未取得時は AiProjectSettings が null を返すので、ここでは provider/
// モデル/Beat/WebSearch 等のグローバル設定のレンダリングだけを検証する。
vi.mock("../hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    project: null,
    isLoading: false,
    updateField: vi.fn(),
  }),
}));

vi.mock("@/features/settings/settingsStore", () => {
  const cache: Record<string, string> = {
    "ai.modelWhitelist": "[]",
    "ai.webSearch.domainMode": "off",
    "ai.webSearch.domains": "[]",
    "ai.webSearch.maxContentTokens": "",
    "ai.contextBudget.l1": "2",
    "ai.contextBudget.l2": "10",
    "ai.contextBudget.l3": "40",
    "ai.contextBudget.l4": "20",
    "ai.contextBudget.l5": "20",
    "ai.contextBudget.reserve": "5",
    "beat.injectIntoContext": "true",
    "beat.inferRoles": "true",
    "beat.roleInferenceConfidenceThreshold": "0.7",
  };
  const store = {
    get: (key: string) => cache[key] ?? "",
    getNumber: (key: string, def: number) =>
      parseFloat(cache[key] ?? String(def)),
    getBoolean: (key: string, def: boolean) =>
      cache[key] === "true" ? true : cache[key] === "false" ? false : def,
    set: vi.fn(),
  };
  // selector 購読（useSettingsStore((s) => ...)）と whole-store の両方に対応する。
  return {
    useSettingsStore: (selector?: (s: typeof store) => unknown) =>
      selector ? selector(store) : store,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  aiStoreFixture.settings = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    thinkingEnabled: false,
    ollamaEndpoint: "http://localhost:11434",
    ollamaContextLengths: {},
    openaiCompatible: { baseUrl: "" },
    openaiCompatibleEndpoints: [],
    activeOpenaiCompatibleEndpointId: null,
  };
  aiStoreFixture.models = [];
});

function renderDesktopAiCategory() {
  return render(
    <RuntimeCapabilitiesProvider target="electron">
      <AiCategory />
    </RuntimeCapabilitiesProvider>,
  );
}

describe("AiCategory — Beat セクション", () => {
  it("Beat AI integration セクションが描画される", () => {
    renderDesktopAiCategory();
    // The section title key is present.
    expect(screen.getByText("settings.ai.beat.title")).toBeTruthy();
  });

  it("injectIntoContext トグルが描画される", () => {
    renderDesktopAiCategory();
    expect(
      screen.getByText("settings.ai.beat.injectIntoContext.label"),
    ).toBeTruthy();
  });

  it("inferRoles トグルが描画される", () => {
    renderDesktopAiCategory();
    expect(screen.getByText("settings.ai.beat.inferRoles.label")).toBeTruthy();
  });

  it("confidenceThreshold スライダーが描画される", () => {
    renderDesktopAiCategory();
    expect(
      screen.getByText("settings.ai.beat.confidenceThreshold.label"),
    ).toBeTruthy();
    // Slider value: 0.7 * 100 = 70%
    expect(screen.getByText("70%")).toBeTruthy();
  });
});

describe("AiCategory — Web 検索 (RAG) セクション", () => {
  // モックの provider は anthropic（RAG 対応）。
  it("RAG 対応プロバイダでドメイン制御セクションが描画される", () => {
    renderDesktopAiCategory();
    expect(screen.getByText("settings.ai.webSearch.title")).toBeTruthy();
    expect(screen.getByText("settings.ai.webSearch.domainMode")).toBeTruthy();
  });

  it("第三者送信のプライバシー開示注記を常時表示する (F-1)", () => {
    renderDesktopAiCategory();
    expect(screen.getByText("settings.ai.webSearch.privacyNote")).toBeTruthy();
  });

  it("Anthropic では OpenRouter 専用の content cap / exa 警告を出さない", () => {
    renderDesktopAiCategory();
    // content cap 行（OpenRouter(exa) 専用）は非表示。
    expect(
      screen.queryByText("settings.ai.webSearch.maxContentTokens"),
    ).toBeNull();
    // exa コスト/未検証の警告も Anthropic では出さない（検証済み・追加課金なし）。
    expect(
      screen.queryByText("settings.ai.webSearch.unverifiedNote"),
    ).toBeNull();
  });
});

describe("AiCategory — Tool call protocol", () => {
  // モックの provider は anthropic（native 固定）。HTTP OpenAI 互換のみ表示する
  // ゲートにより、Anthropic ではセレクトを出さない。
  it("Anthropic では Tool call protocol セレクトを表示しない", () => {
    renderDesktopAiCategory();
    expect(screen.queryByText("Tool call protocol")).toBeNull();
  });
});

describe("AiCategory — Ollama context diagnostics", () => {
  it("モデル最大値と実効runner値を別に表示し、手動fallbackを保存する", () => {
    aiStoreFixture.settings = {
      ...aiStoreFixture.settings,
      provider: "ollama",
      model: "gemma4:latest",
      ollamaContextLengths: { [GEMMA_CONTEXT_KEY]: 65_536 },
    };
    aiStoreFixture.models = [
      {
        id: "gemma4:latest",
        name: "gemma4:latest",
        contextLength: 131_072,
        effectiveContextLength: 32_768,
        effectiveContextSource: "runner",
      },
    ];

    renderDesktopAiCategory();

    const input = screen.getByLabelText(
      "settings.ai.ollamaEffectiveContext",
    ) as HTMLInputElement;
    expect(input.value).toBe("65536");
    expect(
      screen.getByText("settings.ai.ollamaModelMaximumValue"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings.ai.ollamaEffectiveContextValue"),
    ).toBeTruthy();

    fireEvent.change(input, { target: { value: "98304" } });
    fireEvent.blur(input);
    expect(aiStoreFixture.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ollamaContextLengths: { [GEMMA_CONTEXT_KEY]: 98_304 },
      }),
    );
  });

  it("手動fallbackを取得済みモデル最大値でclampして保存・表示する", () => {
    aiStoreFixture.settings = {
      ...aiStoreFixture.settings,
      provider: "ollama",
      model: "gemma4:latest",
      ollamaContextLengths: {},
    };
    aiStoreFixture.models = [
      {
        id: "gemma4:latest",
        name: "gemma4:latest",
        contextLength: 131_072,
      },
    ];

    renderDesktopAiCategory();
    const input = screen.getByLabelText(
      "settings.ai.ollamaEffectiveContext",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "262144" } });
    expect(input.value).toBe("131072");
    fireEvent.blur(input);

    expect(aiStoreFixture.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ollamaContextLengths: { [GEMMA_CONTEXT_KEY]: 131_072 },
      }),
    );
  });

  it("bare選択を:latestモデルと照合し、legacy設定をclampしてcanonical keyへ移す", () => {
    aiStoreFixture.settings = {
      ...aiStoreFixture.settings,
      provider: "ollama",
      model: "gemma4",
      ollamaContextLengths: {
        [LEGACY_GEMMA_LATEST_CONTEXT_KEY]: 262_144,
      },
    };
    aiStoreFixture.models = [
      {
        id: "gemma4:latest",
        name: "gemma4:latest",
        contextLength: 131_072,
      },
    ];

    renderDesktopAiCategory();

    const input = screen.getByLabelText(
      "settings.ai.ollamaEffectiveContext",
    ) as HTMLInputElement;
    expect(input.value).toBe("131072");
    expect(input.max).toBe("131072");

    fireEvent.blur(input);

    expect(aiStoreFixture.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ollamaContextLengths: {
          [GEMMA_CONTEXT_KEY]: 131_072,
        },
      }),
    );
  });
});
