// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatModelCatalog } from "./useChatModelCatalog";
import { useAiSettingsStore } from "./store";
import {
  __resetDynamicModelCapsForTests,
  getDynamicModelMeta,
  registerDynamicModelCaps,
} from "./agent/dynamicModelCaps";
import type { AiModel } from "./types";

vi.mock("./api", () => ({
  hasApiKey: vi.fn(),
  listAiModels: vi.fn(),
}));

import * as api from "./api";

const mockHasApiKey = vi.mocked(api.hasApiKey);
const mockListAiModels = vi.mocked(api.listAiModels);

describe("useChatModelCatalog dynamic capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDynamicModelCapsForTests();
    useAiSettingsStore.setState({
      settings: {
        provider: "openai",
        model: "shared:latest",
        ollamaEndpoint: "http://localhost:11434",
        ollamaContextLengths: {},
        thinkingEnabled: true,
        openaiCompatible: { baseUrl: "" },
      },
      models: [{ id: "shared:latest", name: "OpenAI shared" }],
      modelCapsRevision: 0,
    });
  });

  it("registers cross-provider Ollama metadata without colliding with the same bare id", async () => {
    registerDynamicModelCaps("openrouter", [
      {
        id: "shared:latest",
        name: "OpenRouter shared",
        contextLength: 200_000,
      },
    ]);
    const ollamaModels: AiModel[] = [
      {
        id: "shared:latest",
        name: "Ollama shared",
        contextLength: 131_072,
        effectiveContextLength: 32_768,
        effectiveContextSource: "runner",
        supportedParameters: ["tools"],
      },
    ];
    mockHasApiKey.mockResolvedValue(false);
    mockListAiModels.mockImplementation(async (provider) =>
      provider === "ollama" ? ollamaModels : [],
    );

    const { result } = renderHook(() => useChatModelCatalog(true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(
        result.current.sections.some(
          (section) => section.provider === "ollama",
        ),
      ).toBe(true);
    });

    expect(mockListAiModels).toHaveBeenCalledWith(
      "ollama",
      undefined,
      null,
      "http://localhost:11434",
    );
    expect(getDynamicModelMeta("openrouter", "shared:latest")?.ctx).toBe(
      200_000,
    );
    expect(getDynamicModelMeta("ollama", "shared:latest")).toMatchObject({
      ctx: 131_072,
      effectiveCtx: 32_768,
      effectiveSource: "runner",
      tools: true,
    });
    expect(useAiSettingsStore.getState().modelCapsRevision).toBe(1);
  });

  it("refetches and replaces the Ollama catalog when its endpoint changes", async () => {
    const endpointA = "http://127.0.0.1:31434";
    const endpointB = "http://127.0.0.1:41434";
    useAiSettingsStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, ollamaEndpoint: endpointA }
        : null,
    }));
    mockHasApiKey.mockResolvedValue(false);
    mockListAiModels.mockImplementation(async (provider) => {
      if (provider !== "ollama") return [];
      const endpoint = useAiSettingsStore.getState().settings?.ollamaEndpoint;
      return [
        {
          id: "shared:latest",
          name: endpoint === endpointA ? "Endpoint A" : "Endpoint B",
          contextLength: endpoint === endpointA ? 32_768 : 131_072,
          supportedParameters: endpoint === endpointA ? [] : ["tools"],
        },
      ];
    });

    const { result } = renderHook(() => useChatModelCatalog(true));
    await waitFor(() => {
      expect(
        result.current.sections.find((section) => section.provider === "ollama")
          ?.models[0]?.name,
      ).toBe("Endpoint A");
    });

    act(() => {
      useAiSettingsStore.setState((state) => ({
        settings: state.settings
          ? { ...state.settings, ollamaEndpoint: endpointB }
          : null,
      }));
    });

    await waitFor(() => {
      expect(
        result.current.sections.find((section) => section.provider === "ollama")
          ?.models[0]?.name,
      ).toBe("Endpoint B");
    });
    expect(
      mockListAiModels.mock.calls.filter(([provider]) => provider === "ollama"),
    ).toHaveLength(2);
    expect(
      getDynamicModelMeta("ollama", "shared:latest", endpointA),
    ).toBeNull();
    expect(
      getDynamicModelMeta("ollama", "shared:latest", endpointB),
    ).toMatchObject({ ctx: 131_072, tools: true });
  });
});
