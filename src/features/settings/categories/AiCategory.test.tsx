// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AiCategory } from "./AiCategory";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: () => ({
    settings: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      thinkingEnabled: false,
      ollamaEndpoint: "http://localhost:11434",
    },
    hasApiKey: true,
    isTestingConnection: false,
    connectionTestResult: null,
    models: [],
    isLoadingModels: false,
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    saveApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    testConnection: vi.fn(),
    loadModels: vi.fn(),
  }),
  isRagCapableProvider: (p: string) => p === "openrouter" || p === "anthropic",
}));

vi.mock("@/features/chat/types", () => ({
  AI_PROVIDERS: ["anthropic", "openai"],
  groupModelsByDeveloper: () => [],
}));

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
  return { useSettingsStore: () => store };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AiCategory — Beat セクション", () => {
  it("Beat AI integration セクションが描画される", () => {
    render(<AiCategory />);
    // The section title key is present.
    expect(screen.getByText("settings.ai.beat.title")).toBeTruthy();
  });

  it("injectIntoContext トグルが描画される", () => {
    render(<AiCategory />);
    expect(
      screen.getByText("settings.ai.beat.injectIntoContext.label"),
    ).toBeTruthy();
  });

  it("inferRoles トグルが描画される", () => {
    render(<AiCategory />);
    expect(screen.getByText("settings.ai.beat.inferRoles.label")).toBeTruthy();
  });

  it("confidenceThreshold スライダーが描画される", () => {
    render(<AiCategory />);
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
    render(<AiCategory />);
    expect(screen.getByText("settings.ai.webSearch.title")).toBeTruthy();
    expect(screen.getByText("settings.ai.webSearch.domainMode")).toBeTruthy();
  });

  it("第三者送信のプライバシー開示注記を常時表示する (F-1)", () => {
    render(<AiCategory />);
    expect(screen.getByText("settings.ai.webSearch.privacyNote")).toBeTruthy();
  });

  it("Anthropic では OpenRouter 専用の content cap / exa 警告を出さない", () => {
    render(<AiCategory />);
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
    render(<AiCategory />);
    expect(screen.queryByText("Tool call protocol")).toBeNull();
  });
});
