// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebEditorAiCategory } from "./WebEditorAiCategory";

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(async () => undefined),
  saveSettings: vi.fn(async () => undefined),
  saveApiKey: vi.fn(async () => undefined),
  deleteApiKey: vi.fn(async () => undefined),
  testConnection: vi.fn(async () => undefined),
  loadModels: vi.fn(async () => undefined),
}));

vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: () => ({
    settings: {
      provider: "ollama",
      model: "",
      ollamaEndpoint: "http://localhost:11434",
      modelApiVariant: null,
    },
    hasApiKey: false,
    isTestingConnection: false,
    connectionTestResult: null,
    models: [],
    isLoadingModels: false,
    ...mocks,
  }),
}));

vi.mock("@/features/chat/ModelPicker", () => ({
  ModelPicker: () => <div>model picker</div>,
}));

vi.mock("@/features/settings/categories/AiProjectSettings", () => ({
  AiProjectSettings: () => <div>AI policy controls</div>,
}));

vi.mock("@/features/settings/components/SettingSection", () => ({
  SettingSection: ({
    title,
    children,
  }: React.PropsWithChildren<{ title: string }>) => (
    <section aria-label={title}>{children}</section>
  ),
}));

vi.mock("@/features/settings/components/SettingRow", () => ({
  SettingRow: ({
    label,
    children,
  }: React.PropsWithChildren<{ label: string }>) => (
    <div aria-label={label}>{children}</div>
  ),
}));

describe("WebEditorAiCategory", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps project AI policy controls reachable", () => {
    render(<WebEditorAiCategory />);
    expect(screen.getByText("AI policy controls")).toBeTruthy();
  });

  it("explains the browser-to-Ollama origin and local-network requirements", () => {
    render(<WebEditorAiCategory />);
    expect(screen.getByText(/OLLAMA_ORIGINS/)).toBeTruthy();
    expect(
      screen.getAllByText(/ローカルネットワーク|local network/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Ollama/i })).toHaveAttribute(
      "href",
      "https://docs.ollama.com/faq#how-can-i-allow-additional-web-origins-to-access-ollama",
    );
  });
});
