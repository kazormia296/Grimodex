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
}));

vi.mock("@/features/settings/settingsStore", () => {
  const cache: Record<string, string> = {
    "ai.modelWhitelist": "[]",
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
