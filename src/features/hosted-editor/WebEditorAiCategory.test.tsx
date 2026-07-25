// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebEditorAiCategory } from "./WebEditorAiCategory";

const mocks = vi.hoisted(() => ({
  settings: {
    provider: "ollama" as const,
    model: "",
    ollamaEndpoint: "http://localhost:11434",
    modelApiVariant: null,
  },
  loadSettings: vi.fn(async () => undefined),
  saveSettings: vi.fn(async () => undefined),
  saveApiKey: vi.fn(async () => undefined),
  deleteApiKey: vi.fn(async () => undefined),
  testConnection: vi.fn(async () => undefined),
  loadModels: vi.fn(async () => undefined),
}));

vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: () => ({
    ...mocks,
    settings: mocks.settings,
    hasApiKey: false,
    isTestingConnection: false,
    connectionTestResult: null,
    models: [],
    isLoadingModels: false,
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

  it("offers every HTTP provider and exposes custom endpoint setup", async () => {
    render(<WebEditorAiCategory />);

    for (const name of [
      /^OpenRouter$/,
      /^OpenAI$/,
      /^Anthropic$/,
      /Ollama/,
      /OpenAI.*(?:互換|compatible)/,
      /Sakana/,
      /AI のべりすと/,
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }

    fireEvent.click(
      screen.getByRole("button", {
        name: /OpenAI.*(?:互換|compatible)/,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: /エンドポイントを追加|Add endpoint/,
      }),
    ).toBeTruthy();
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

  it("does not probe loopback automatically and exposes an explicit connect action", async () => {
    render(<WebEditorAiCategory />);

    await waitFor(() => expect(mocks.loadSettings).toHaveBeenCalled());
    expect(mocks.loadModels).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: /ローカルAIへ接続|Connect to local AI/i,
      }),
    ).toBeTruthy();
  });
});
