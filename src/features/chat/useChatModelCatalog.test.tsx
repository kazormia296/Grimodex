// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetChatModelCatalogCacheForTests,
  useChatModelCatalog,
} from "./useChatModelCatalog";
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
    __resetChatModelCatalogCacheForTests();
    localStorage.clear();
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

  describe("非 active の Anthropic の一覧の登録", () => {
    const LIVE_MODEL: AiModel = {
      id: "claude-fable-5-9",
      name: "Claude Fable 5.9",
      contextLength: 400_000,
      maxCompletionTokens: 60_000,
    };

    function mockAnthropicList(models: AiModel[]) {
      mockHasApiKey.mockImplementation(
        async (provider) => provider === "anthropic",
      );
      // ollama は未起動（失敗）にして、別 provider の revision 加算を混ぜない。
      mockListAiModels.mockImplementation(async (provider) => {
        if (provider === "anthropic") return models;
        if (provider === "ollama") throw new Error("ollama is not running");
        return [];
      });
    }

    it("live の limit を持つ一覧は登録し、modelCapsRevision を加算する", async () => {
      mockAnthropicList([LIVE_MODEL]);

      const { result } = renderHook(() => useChatModelCatalog(true));
      await waitFor(() => {
        expect(
          result.current.sections.some((s) => s.provider === "anthropic"),
        ).toBe(true);
      });

      expect(
        getDynamicModelMeta("anthropic", "claude-fable-5-9"),
      ).toMatchObject({ ctx: 400_000, out: 60_000 });
      expect(useAiSettingsStore.getState().modelCapsRevision).toBe(1);
    });

    it("limit も capabilities も無い固定の予備の一覧は登録せず、revision も動かさない", async () => {
      mockAnthropicList([
        { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
        { id: "claude-fable-5-9", name: "Claude Fable 5.9" },
      ]);

      const { result } = renderHook(() => useChatModelCatalog(true));
      await waitFor(() => {
        expect(
          result.current.sections.some((s) => s.provider === "anthropic"),
        ).toBe(true);
      });

      expect(getDynamicModelMeta("anthropic", "claude-fable-5-9")).toBeNull();
      expect(getDynamicModelMeta("anthropic", "claude-opus-4-1")).toBeNull();
      expect(useAiSettingsStore.getState().modelCapsRevision).toBe(0);
    });

    it("同じ一覧を module cache から返す 2 回目は、再登録も revision の加算もしない", async () => {
      mockAnthropicList([LIVE_MODEL]);

      const first = renderHook(() => useChatModelCatalog(true));
      await waitFor(() => expect(first.result.current.loading).toBe(false));
      expect(useAiSettingsStore.getState().modelCapsRevision).toBe(1);
      first.unmount();

      const second = renderHook(() => useChatModelCatalog(true));
      await waitFor(() => expect(second.result.current.loading).toBe(false));
      expect(
        mockListAiModels.mock.calls.filter(([p]) => p === "anthropic"),
      ).toHaveLength(1);
      expect(useAiSettingsStore.getState().modelCapsRevision).toBe(1);
    });
  });
});
