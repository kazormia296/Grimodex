// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAiCapability } from "./useAiCapability";

vi.mock("@/features/settings/hooks/useProjectSettings", () => ({
  useProjectSettings: vi.fn(),
}));

vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: vi.fn(),
  selectProviderReadiness: vi.fn(),
}));

import { useProjectSettings } from "@/features/settings/hooks/useProjectSettings";
import {
  useAiSettingsStore,
  selectProviderReadiness,
} from "@/features/chat/store";

const mockUseProjectSettings = vi.mocked(useProjectSettings);
const mockUseAiSettingsStore = vi.mocked(useAiSettingsStore);
const mockSelectProviderReadiness = vi.mocked(selectProviderReadiness);

function setupMocks(
  readiness: "pending" | "ready" | "no-provider" | "no-model",
  projectLoaded: boolean,
  policyToggles = { chat: true, bodyWrite: true, analysis: true },
) {
  // useAiSettingsStore(selector) は selector を呼び出して結果を返す
  mockUseAiSettingsStore.mockImplementation((selector) => {
    if (selector === mockSelectProviderReadiness) return readiness;
    return readiness;
  });
  mockSelectProviderReadiness.mockReturnValue(readiness);

  if (!projectLoaded) {
    mockUseProjectSettings.mockReturnValue({
      project: null,
      isLoading: true,
      updateField: vi.fn(),
    });
  } else {
    mockUseProjectSettings.mockReturnValue({
      project: {
        id: "default-project",
        title: "Test",
        language: "ja",
        phaseResolutionMode: "auto",
        createdAt: "",
        updatedAt: "",
        genre: null,
        pov: null,
        tense: null,
        styleGuide: null,
        aiInstructions: null,
        outline: null,
        aiPolicy: JSON.stringify({
          preset: "custom",
          toggles: policyToggles,
        }),
      },
      isLoading: false,
      updateField: vi.fn(),
    });
  }
}

describe("useAiCapability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns pending when project is not loaded", () => {
    setupMocks("ready", false);
    const { result } = renderHook(() => useAiCapability("chat"));
    expect(result.current).toEqual({ state: "pending" });
  });

  it("returns pending when provider readiness is pending", () => {
    setupMocks("pending", true);
    const { result } = renderHook(() => useAiCapability("chat"));
    expect(result.current).toEqual({ state: "pending" });
  });

  it("returns enabled when policy allows and provider is ready", () => {
    setupMocks("ready", true);
    const { result } = renderHook(() => useAiCapability("bodyWrite"));
    expect(result.current).toEqual({ state: "enabled" });
  });

  it("returns policy disabled when toggle is off", () => {
    setupMocks("ready", true, { chat: true, bodyWrite: false, analysis: true });
    const { result } = renderHook(() => useAiCapability("bodyWrite"));
    expect(result.current).toEqual({
      state: "disabled",
      reason: "policy",
    });
  });

  it("returns no-model when model is missing", () => {
    setupMocks("no-model", true);
    const { result } = renderHook(() => useAiCapability("chat"));
    expect(result.current).toEqual({
      state: "disabled",
      reason: "no-model",
    });
  });

  it("returns no-provider when provider not configured", () => {
    setupMocks("no-provider", true);
    const { result } = renderHook(() => useAiCapability("analysis"));
    expect(result.current).toEqual({
      state: "disabled",
      reason: "no-provider",
    });
  });

  it("policy beats no-model and no-provider (priority check)", () => {
    setupMocks("no-provider", true, {
      chat: false,
      bodyWrite: false,
      analysis: false,
    });
    const { result } = renderHook(() => useAiCapability("chat"));
    expect(result.current).toEqual({
      state: "disabled",
      reason: "policy",
    });
  });

  it("no-model beats no-provider (priority check)", () => {
    setupMocks("no-model", true, {
      chat: true,
      bodyWrite: true,
      analysis: true,
    });
    const { result } = renderHook(() => useAiCapability("chat"));
    expect(result.current).toEqual({
      state: "disabled",
      reason: "no-model",
    });
  });
});
