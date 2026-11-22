import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDynamicModelCapsForTests,
  activateDynamicProviderScope,
  getDynamicModelMeta,
  invalidateDynamicEffectiveContext,
  isDynamicCapsStale,
  registerDynamicModelCaps,
} from "./dynamicModelCaps";
import type { AiModel } from "../types";
import { resolveModelCapabilities } from "./modelLimits";
import { resolveOutputBudgetPlan } from "@/features/ai-context/outputBudget";

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const key of Object.keys(store)) delete store[key];
  },
};

vi.stubGlobal("localStorage", localStorageMock);

const STORAGE_KEY = "grimodex.modelCaps.v4";
const LEGACY_STORAGE_KEY = "grimodex.openrouterModelCaps.v1";

type RuntimeAiModel = AiModel & {
  effectiveContextLength?: number;
  effectiveContextSource?: string;
  capabilities?: string[];
};

function makeModel(
  overrides: Partial<RuntimeAiModel> & { id: string },
): RuntimeAiModel {
  return {
    name: overrides.id,
    contextLength: 100_000,
    maxCompletionTokens: 8_192,
    supportedParameters: ["tools", "reasoning"],
    pricingPrompt: "0.000003",
    pricingCompletion: "0.000015",
    ...overrides,
  };
}

beforeEach(() => {
  __resetDynamicModelCapsForTests();
  localStorageMock.clear();
});

describe("provider-scoped dynamic capability registry", () => {
  it("registers bare ids and isolates the same id across providers", () => {
    registerDynamicModelCaps("ollama", [
      makeModel({
        id: "shared:latest",
        contextLength: 131_072,
        supportedParameters: undefined,
        capabilities: ["completion", "tools"],
      }),
    ]);
    registerDynamicModelCaps("openrouter", [
      makeModel({
        id: "shared:latest",
        contextLength: 32_768,
        supportedParameters: ["reasoning"],
      }),
    ]);

    expect(getDynamicModelMeta("ollama", "shared:latest")).toMatchObject({
      ctx: 131_072,
      tools: true,
      reasoning: false,
    });
    expect(getDynamicModelMeta("openrouter", "shared:latest")).toMatchObject({
      ctx: 32_768,
      tools: false,
      reasoning: true,
    });
  });

  it("stores model maximum separately from effective runner context", () => {
    registerDynamicModelCaps("ollama", [
      makeModel({
        id: "gemma4:latest",
        contextLength: 131_072,
        effectiveContextLength: 4_096,
        effectiveContextSource: "runner",
      }),
    ]);

    expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
      ctx: 131_072,
      effectiveCtx: 4_096,
      effectiveSource: "runner",
    });
  });

  it("isolates Ollama metadata and freshness by endpoint", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "shared:latest",
          contextLength: 32_768,
          supportedParameters: [],
        }),
      ],
      { ollamaEndpoint: "http://127.0.0.1:11434/" },
    );

    expect(
      getDynamicModelMeta("ollama", "shared:latest", "http://127.0.0.1:11434"),
    ).toMatchObject({ ctx: 32_768, tools: false });
    expect(
      getDynamicModelMeta("ollama", "shared:latest", "http://127.0.0.1:21434"),
    ).toBeNull();
    expect(
      isDynamicCapsStale(
        "ollama",
        24 * 60 * 60 * 1_000,
        "http://127.0.0.1:21434",
      ),
    ).toBe(true);

    expect(
      activateDynamicProviderScope("ollama", "http://127.0.0.1:21434"),
    ).toBe(true);
    expect(getDynamicModelMeta("ollama", "shared:latest")).toBeNull();

    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "shared:latest",
          contextLength: 131_072,
          supportedParameters: ["tools"],
        }),
      ],
      { ollamaEndpoint: "http://127.0.0.1:21434" },
    );
    expect(
      getDynamicModelMeta("ollama", "shared:latest", "http://127.0.0.1:21434/"),
    ).toMatchObject({ ctx: 131_072, tools: true });
  });

  it("normalizes Ollama thinking capability to renderer reasoning", () => {
    registerDynamicModelCaps("ollama", [
      makeModel({
        id: "thinking-local",
        supportedParameters: undefined,
        capabilities: ["completion", "tools", "thinking"],
      }),
    ]);

    expect(getDynamicModelMeta("ollama", "thinking-local")).toMatchObject({
      tools: true,
      reasoning: true,
    });
  });

  it("treats an explicit empty capability list as no tools or reasoning", () => {
    registerDynamicModelCaps("ollama", [
      makeModel({
        id: "completion-only",
        supportedParameters: [],
        capabilities: undefined,
      }),
    ]);

    expect(getDynamicModelMeta("ollama", "completion-only")).toMatchObject({
      tools: false,
      reasoning: false,
    });
  });

  it("stores context, output, and OpenRouter pricing metadata", () => {
    registerDynamicModelCaps("openrouter", [
      makeModel({
        id: "anthropic/claude-sonnet-4-6",
        contextLength: 1_000_000,
        maxCompletionTokens: 64_000,
      }),
    ]);

    expect(
      getDynamicModelMeta("openrouter", "anthropic/claude-sonnet-4-6"),
    ).toMatchObject({
      ctx: 1_000_000,
      tools: true,
      reasoning: true,
      inPerM: 3,
      outPerM: 15,
    });
  });

  it("retains an empty row so a refreshed model clears stale metadata", () => {
    registerDynamicModelCaps("ollama", [
      makeModel({
        id: "no-meta",
        contextLength: 131_072,
        effectiveContextLength: 32_768,
        effectiveContextSource: "runner",
      }),
    ]);
    registerDynamicModelCaps("ollama", [{ id: "no-meta", name: "No Meta" }]);
    expect(getDynamicModelMeta("ollama", "no-meta")).toEqual({
      ctx: undefined,
      out: undefined,
      effectiveCtx: undefined,
      effectiveSource: undefined,
      tools: undefined,
      reasoning: undefined,
      inPerM: undefined,
      outPerM: undefined,
    });
  });

  it("omits metadata-free rows for non-Ollama providers", () => {
    registerDynamicModelCaps("openrouter", [
      { id: "provider/no-meta", name: "No Meta" },
    ]);
    expect(getDynamicModelMeta("openrouter", "provider/no-meta")).toBeNull();
  });

  it("replaces the whole provider catalog and removes stale runner rows", () => {
    registerDynamicModelCaps("ollama", [
      makeModel({
        id: "old-runner",
        effectiveContextLength: 4_096,
        effectiveContextSource: "runner",
      }),
    ]);

    registerDynamicModelCaps("ollama", [
      makeModel({ id: "current-model", effectiveContextLength: undefined }),
    ]);

    expect(getDynamicModelMeta("ollama", "old-runner")).toBeNull();
    expect(getDynamicModelMeta("ollama", "current-model")?.ctx).toBe(100_000);
  });

  it("patches only the selected model after an Agent preflight probe", () => {
    registerDynamicModelCaps("ollama", [
      makeModel({ id: "selected", effectiveContextLength: 4_096 }),
      makeModel({ id: "unrelated", contextLength: 65_536 }),
    ]);

    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "selected",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
        }),
      ],
      { selectedModelId: "selected" },
    );

    expect(getDynamicModelMeta("ollama", "selected")).toMatchObject({
      ctx: 131_072,
      effectiveCtx: 65_536,
    });
    expect(getDynamicModelMeta("ollama", "unrelated")?.ctx).toBe(65_536);
  });

  it("resolves Ollama bare and :latest aliases within the same provider", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "gemma4:latest",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
        }),
      ],
      { selectedModelId: "gemma4" },
    );

    expect(getDynamicModelMeta("ollama", "gemma4")).toMatchObject({
      ctx: 131_072,
      effectiveCtx: 65_536,
    });
    invalidateDynamicEffectiveContext("ollama", "gemma4");
    expect(
      getDynamicModelMeta("ollama", "gemma4:latest")?.effectiveCtx,
    ).toBeUndefined();
  });

  it("invalidates runtime effective context without discarding static metadata", () => {
    registerDynamicModelCaps("ollama", [
      makeModel({
        id: "gemma4:latest",
        contextLength: 131_072,
        effectiveContextLength: 16_384,
        effectiveContextSource: "runner",
        capabilities: ["completion", "tools"],
        supportedParameters: undefined,
      }),
    ]);

    invalidateDynamicEffectiveContext("ollama", "gemma4:latest");

    expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
      ctx: 131_072,
      effectiveCtx: undefined,
      effectiveSource: undefined,
      tools: true,
    });

    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
      ctx: 131_072,
      effectiveCtx: undefined,
      effectiveSource: undefined,
      tools: true,
    });
  });

  it("keeps a newer selected effective observation when an older full response arrives", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "gemma4:latest",
          effectiveContextLength: 65_536,
        }),
      ],
      { selectedModelId: "gemma4:latest", observationGeneration: 2 },
    );
    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "gemma4:latest",
          effectiveContextLength: 4_096,
        }),
      ],
      { observationGeneration: 1 },
    );

    expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
      ctx: 100_000,
      effectiveCtx: 65_536,
      tools: true,
    });
  });

  it("keeps durable metadata but suppresses an older success after a newer full failure", () => {
    invalidateDynamicEffectiveContext("ollama", undefined, {
      notNewerThanGeneration: 2,
    });
    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "gemma4:latest",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
        }),
      ],
      { selectedModelId: "gemma4:latest", observationGeneration: 1 },
    );

    expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
      ctx: 131_072,
      tools: true,
      effectiveCtx: undefined,
    });
  });

  it("retains older durable metadata after a newer selected failure without restoring effective context", () => {
    invalidateDynamicEffectiveContext("ollama", "gemma4:latest", {
      notNewerThanGeneration: 2,
    });
    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "gemma4:latest",
          contextLength: 131_072,
          effectiveContextLength: 65_536,
        }),
      ],
      { observationGeneration: 1 },
    );

    expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
      ctx: 131_072,
      tools: true,
      effectiveCtx: undefined,
    });
  });

  it("does not resurrect a selected model that a newer successful lookup found absent", () => {
    registerDynamicModelCaps("ollama", [], {
      selectedModelId: "deleted:latest",
      observationGeneration: 2,
    });
    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "deleted:latest",
          effectiveContextLength: 65_536,
        }),
      ],
      { observationGeneration: 1 },
    );

    expect(getDynamicModelMeta("ollama", "deleted:latest")).toBeNull();
  });

  it("strips the legacy openrouter/ prefix only in the OpenRouter scope", () => {
    registerDynamicModelCaps("openrouter", [
      makeModel({ id: "anthropic/claude-opus-4-6" }),
    ]);
    registerDynamicModelCaps("ollama", [
      makeModel({ id: "anthropic/claude-opus-4-6" }),
    ]);

    expect(
      getDynamicModelMeta("openrouter", "openrouter/anthropic/claude-opus-4-6"),
    ).not.toBeNull();
    expect(
      getDynamicModelMeta("ollama", "openrouter/anthropic/claude-opus-4-6"),
    ).toBeNull();
  });
});

describe("provider-scoped persistence", () => {
  it("persists v2 provider namespaces", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        makeModel({
          id: "gemma4:latest",
          contextLength: 131_072,
          effectiveContextLength: 16_384,
          effectiveContextSource: "runner",
        }),
      ],
      { ollamaEndpoint: "http://localhost:11434" },
    );

    const parsed = JSON.parse(store[STORAGE_KEY]!) as {
      version: number;
      providers: Record<
        string,
        {
          models: Record<
            string,
            {
              ctx?: number;
              effectiveCtx?: number;
              effectiveSource?: string;
              metadataGeneration?: number;
              observationGeneration?: number;
            }
          >;
          scope?: string;
        }
      >;
    };
    expect(parsed.version).toBe(4);
    expect(parsed.providers.ollama.models["gemma4:latest"]?.ctx).toBe(131_072);
    expect(parsed.providers.ollama.scope).toBe("http://localhost:11434");
    expect(
      parsed.providers.ollama.models["gemma4:latest"]?.effectiveCtx,
    ).toBeUndefined();
    expect(
      parsed.providers.ollama.models["gemma4:latest"]?.effectiveSource,
    ).toBeUndefined();
    expect(
      parsed.providers.ollama.models["gemma4:latest"]?.metadataGeneration,
    ).toBeUndefined();
    expect(
      parsed.providers.ollama.models["gemma4:latest"]?.observationGeneration,
    ).toBeUndefined();
  });

  it("hydrates provider namespaces from v4 storage", () => {
    store[STORAGE_KEY] = JSON.stringify({
      version: 4,
      providers: {
        ollama: {
          fetchedAt: Date.now(),
          models: {
            "gemma4:latest": {
              ctx: 131_072,
              effectiveCtx: 16_384,
              effectiveSource: "model-parameter",
              tools: 1,
              reasoning: 0,
            },
          },
        },
      },
    });

    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("ollama", "gemma4:latest")).toMatchObject({
      ctx: 131_072,
      effectiveCtx: undefined,
      effectiveSource: undefined,
      tools: true,
    });
  });

  it("migrates the v1 OpenRouter cache without exposing it to Ollama", () => {
    store[LEGACY_STORAGE_KEY] = JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      models: {
        "openai/gpt-4o": {
          tools: 1,
          reasoning: 0,
          ctx: 128_000,
          out: 16_384,
        },
      },
    });

    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("openrouter", "openai/gpt-4o")?.ctx).toBe(
      128_000,
    );
    expect(getDynamicModelMeta("ollama", "openai/gpt-4o")).toBeNull();
    expect(JSON.parse(store[STORAGE_KEY]!).version).toBe(4);
  });

  it("merges legacy OpenRouter metadata into a v4 cache that only has Ollama", () => {
    store[STORAGE_KEY] = JSON.stringify({
      version: 4,
      providers: {
        ollama: {
          fetchedAt: Date.now(),
          models: { "gemma4:latest": { ctx: 131_072 } },
        },
      },
    });
    store[LEGACY_STORAGE_KEY] = JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      models: { "openai/gpt-4o": { ctx: 128_000, tools: 1 } },
    });

    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("ollama", "gemma4:latest")?.ctx).toBe(131_072);
    expect(getDynamicModelMeta("openrouter", "openai/gpt-4o")?.ctx).toBe(
      128_000,
    );
  });

  it("ignores corrupt and version-mismatched storage", () => {
    store[STORAGE_KEY] = "{{broken}";
    store[LEGACY_STORAGE_KEY] = JSON.stringify({
      version: 999,
      fetchedAt: Date.now(),
      models: { x: { ctx: 8_000 } },
    });
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("openrouter", "x")).toBeNull();
  });
});

describe("storage version 4", () => {
  const row = { ctx: 1_000_000, out: 128_000 };

  it("v2 の cache は Anthropic 以外だけを引き継ぎ、v2 の key は消す", () => {
    store["grimodex.modelCaps.v2"] = JSON.stringify({
      version: 2,
      providers: {
        anthropic: { fetchedAt: Date.now(), models: { "claude-x-5": row } },
        openrouter: { fetchedAt: Date.now(), models: { "a/b": row } },
      },
    });
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("anthropic", "claude-x-5")).toBeNull();
    expect(getDynamicModelMeta("openrouter", "a/b")).toMatchObject(row);
    expect(isDynamicCapsStale("anthropic")).toBe(true);
    expect(isDynamicCapsStale("openrouter")).toBe(false);
    expect(store["grimodex.modelCaps.v2"]).toBeUndefined();
    // 引き継いだ分は今の版で書き直され、再読込でも残る（Anthropic の行は書かない）。
    const rewritten = JSON.parse(store[STORAGE_KEY] ?? "{}");
    expect(Object.keys(rewritten.providers ?? {})).toEqual(["openrouter"]);
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("openrouter", "a/b")).toMatchObject(row);
  });

  it("v4 の key に古い version の payload があっても復元しない", () => {
    store[STORAGE_KEY] = JSON.stringify({
      version: 2,
      providers: {
        anthropic: { fetchedAt: Date.now(), models: { "claude-x-5": row } },
      },
    });
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("anthropic", "claude-x-5")).toBeNull();
  });

  it("知らない provider 名の namespace は復元しない（provider の取り違えを防ぐ）", () => {
    store[STORAGE_KEY] = JSON.stringify({
      version: 4,
      providers: {
        "not-a-provider": {
          fetchedAt: Date.now(),
          models: { "claude-x-5": row },
        },
        anthropic: { fetchedAt: Date.now(), models: { "claude-y-5": row } },
      },
    });
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("anthropic", "claude-y-5")?.ctx).toBe(1_000_000);
    expect(
      getDynamicModelMeta("not-a-provider" as never, "claude-x-5"),
    ).toBeNull();
    // 登録した anthropic の行は別の provider に漏れない。
    expect(getDynamicModelMeta("openrouter", "claude-y-5")).toBeNull();
  });

  it("anthropic の登録は v4 に provider 名つきで保存され、再読込で復元される", () => {
    registerDynamicModelCaps("anthropic", [
      {
        id: "claude-x-5",
        name: "x",
        contextLength: 1_000_000,
        maxCompletionTokens: 128_000,
      },
    ]);
    expect(JSON.parse(store[STORAGE_KEY]!).providers.anthropic.models).toEqual({
      "claude-x-5": row,
    });
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("anthropic", "claude-x-5")).toMatchObject(row);
    expect(getDynamicModelMeta("ollama", "claude-x-5")).toBeNull();
  });
});

describe("isDynamicCapsStale", () => {
  it("tracks freshness independently per provider", () => {
    store[STORAGE_KEY] = JSON.stringify({
      version: 4,
      providers: {
        openrouter: {
          fetchedAt: Date.now() - 1_000,
          models: {},
        },
      },
    });
    __resetDynamicModelCapsForTests();

    expect(isDynamicCapsStale("openrouter")).toBe(false);
    expect(isDynamicCapsStale("ollama")).toBe(true);
  });

  it("marks one provider stale after its TTL", () => {
    store[STORAGE_KEY] = JSON.stringify({
      version: 4,
      providers: {
        ollama: {
          fetchedAt: Date.now() - 25 * 60 * 60 * 1_000,
          models: {},
        },
      },
    });
    __resetDynamicModelCapsForTests();

    expect(isDynamicCapsStale("ollama", 24 * 60 * 60 * 1_000)).toBe(true);
  });
});

describe("保存された cache の ctx／out の型検証", () => {
  // 正の安全な整数でない値（負・0・小数・文字列・null・巨大・NaN 由来の null）
  const BROKEN: unknown[] = [-5, 0, 1.5, "200000", null, 1e20, true, {}, []];

  function seed(provider: string, id: string, meta: Record<string, unknown>) {
    store[STORAGE_KEY] = JSON.stringify({
      version: 4,
      providers: {
        [provider]: {
          fetchedAt: Date.now() - 1_000,
          models: { [id]: meta },
        },
      },
    });
    __resetDynamicModelCapsForTests();
  }

  it.each(BROKEN.map((value) => [JSON.stringify(value), value] as const))(
    "壊れた値 %s は捨てて（undefined）、正しい field は残す",
    (_label, value) => {
      seed("openrouter", "vendor/model", { ctx: value, out: value, tools: 1 });
      expect(getDynamicModelMeta("openrouter", "vendor/model")).toMatchObject({
        ctx: undefined,
        out: undefined,
        tools: true,
      });
    },
  );

  it("壊れた ctx だけ捨て、正しい out は残す（その field だけを捨てる）", () => {
    seed("anthropic", "claude-fable-9-9", { ctx: -1, out: 64_000 });
    expect(getDynamicModelMeta("anthropic", "claude-fable-9-9")).toMatchObject({
      ctx: undefined,
      out: 64_000,
    });
  });

  it("正しい整数はそのまま通す", () => {
    seed("openrouter", "vendor/model", { ctx: 128_000, out: 8_192 });
    expect(getDynamicModelMeta("openrouter", "vendor/model")).toMatchObject({
      ctx: 128_000,
      out: 8_192,
    });
  });

  it.each([
    ["openrouter", "vendor/model"],
    ["anthropic", "claude-fable-9-9"],
  ] as const)(
    "%s の壊れた cache でも、能力の解決と出力予約が RangeError を出さない",
    (provider, id) => {
      seed(provider, id, { ctx: -5, out: 1.5 });
      const caps = resolveModelCapabilities(id, { provider });
      expect(() =>
        resolveOutputBudgetPlan({
          provider,
          model: id,
          contextWindow: caps.contextWindow,
          modelMaxOutputTokens: caps.maxOutputTokens,
          defaultVisibleOutputTokens: caps.defaultVisibleOutputTokens,
          defaultReasoningReservationTokens:
            caps.defaultReasoningReservationTokens,
        }),
      ).not.toThrow();
    },
  );
});
