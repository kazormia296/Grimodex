import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDynamicModelCapsForTests,
  getDynamicModelMeta,
  registerAnthropicModelCaps,
} from "./dynamicModelCaps";
import { parseAnthropicLiveCaps } from "./anthropicLiveCaps";
import { buildThinkingParams, resolveModelCapabilities } from "./modelLimits";
import type { AiModel } from "../types";
import liveModels from "./__fixtures__/anthropic-models-2023-06-01.json";
import wireModels from "./__fixtures__/anthropic-ai-model-wire.json";
import { debugLog } from "@/lib/debugLog";

/**
 * 段 2：Anthropic の live（`max_input_tokens`／`max_tokens`）は、能力表に無い id にだけ使う。
 * 既知の id は live を登録した後も今の値と一致し、thinking／effort は live で変えない。
 */

const store: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
});

const ANTHROPIC = { provider: "anthropic" } as const;

/** 製品が Rust 経由で受け取る形（`parse_anthropic_model` の写し）。 */
const FIXTURE_AI_MODELS: AiModel[] = (liveModels as unknown[]).map((raw) => {
  const live = parseAnthropicLiveCaps(raw);
  if (!live) throw new Error("fixture の model object が不正");
  return {
    id: live.id,
    name: live.displayName ?? live.id,
    contextLength: live.contextWindow,
    maxCompletionTokens: live.maxOutput,
  };
});

/** capabilities も含む形（段 2 の B 案：Rust が `anthropicCapabilities` として運ぶ）。 */
const FIXTURE_AI_MODELS_WITH_CAPS: AiModel[] = FIXTURE_AI_MODELS.map(
  (model, index) => ({
    ...model,
    anthropicCapabilities: (
      liveModels as Array<{ capabilities: Record<string, unknown> }>
    )[index].capabilities,
  }),
);

/** 表に載っている 14 件（claude-fable-5-2 は表に無い）。 */
const TABLE_IDS = FIXTURE_AI_MODELS.map((m) => m.id).filter(
  (id) => id !== "claude-fable-5-2",
);

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  __resetDynamicModelCapsForTests();
});

describe("Anthropic の live の登録（段 2）", () => {
  it("fixture は 15 件で、表に載っているのは 14 件", () => {
    expect(FIXTURE_AI_MODELS).toHaveLength(15);
    expect(TABLE_IDS).toHaveLength(14);
  });

  it("既知の 14 件は、live を登録した後も今の値と完全に一致する", () => {
    const before = new Map(
      TABLE_IDS.map((id) => [id, resolveModelCapabilities(id, ANTHROPIC)]),
    );
    expect(registerAnthropicModelCaps(FIXTURE_AI_MODELS)).toBe(true);
    for (const id of TABLE_IDS) {
      expect(resolveModelCapabilities(id, ANTHROPIC), id).toEqual(
        before.get(id),
      );
    }
  });

  it("表に無い claude-fable-5-2 は context・最大出力・thinking・effort の値が変わらず、由来だけ dynamic になる", () => {
    const before = resolveModelCapabilities("claude-fable-5-2", ANTHROPIC);
    expect(before.contextWindowSource).toBe("hardcoded");
    registerAnthropicModelCaps(FIXTURE_AI_MODELS);
    const after = resolveModelCapabilities("claude-fable-5-2", ANTHROPIC);
    expect(after).toEqual({ ...before, contextWindowSource: "dynamic" });
    expect(after).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      supportsAdaptiveThinking: true,
      supportsEffort: true,
    });
  });

  it("一覧取得の後も gen5 に adaptive＋effort が送られる", () => {
    registerAnthropicModelCaps(FIXTURE_AI_MODELS);
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
      "claude-fable-5-2",
    ]) {
      expect(
        buildThinkingParams(id, "high", "summarized", true, ANTHROPIC),
        id,
      ).toEqual({
        thinking: { type: "adaptive", effort: "high", display: "summarized" },
      });
      expect(resolveModelCapabilities(id, ANTHROPIC)).toMatchObject({
        supportsAdaptiveThinking: true,
        supportsThinking: false,
        supportsEffort: true,
      });
    }
  });

  it("haiku-4-5 には thinking を送らない（製品の判断。live は budget を許す）", () => {
    registerAnthropicModelCaps(FIXTURE_AI_MODELS);
    for (const id of ["claude-haiku-4-5-20251001", "claude-haiku-4-5"]) {
      expect(
        buildThinkingParams(id, "high", "summarized", true, ANTHROPIC),
      ).toEqual({});
      expect(resolveModelCapabilities(id, ANTHROPIC)).toMatchObject({
        supportsThinking: false,
        supportsAdaptiveThinking: false,
      });
    }
  });

  it("表にある id は、live が違う値でも表を返す（製品の判断を上書きさせない）", () => {
    registerAnthropicModelCaps([
      {
        id: "claude-sonnet-4-6",
        name: "x",
        contextLength: 123_456,
        maxCompletionTokens: 7_777,
      },
    ]);
    expect(
      resolveModelCapabilities("claude-sonnet-4-6", ANTHROPIC),
    ).toMatchObject({
      contextWindow: 1_000_000,
      contextWindowSource: "hardcoded",
    });
  });

  it("日付サフィックス付きの既知 id は表のまま、別バージョンへの前方一致は表に無い扱い", () => {
    registerAnthropicModelCaps([
      {
        id: "claude-opus-4-5-20990101",
        name: "x",
        contextLength: 9_999,
        maxCompletionTokens: 99,
      },
      {
        id: "claude-fable-5-3",
        name: "x",
        contextLength: 2_000_000,
        maxCompletionTokens: 150_000,
      },
    ]);
    expect(
      resolveModelCapabilities("claude-opus-4-5-20990101", ANTHROPIC),
    ).toMatchObject({
      contextWindow: 200_000,
      contextWindowSource: "hardcoded",
    });
    expect(
      resolveModelCapabilities("claude-fable-5-3", ANTHROPIC),
    ).toMatchObject({
      contextWindow: 2_000_000,
      maxOutputTokens: 150_000,
      contextWindowSource: "dynamic",
    });
  });

  it("表に無い id では live の context と最大出力が使われる（gen5 以降の近似）", () => {
    registerAnthropicModelCaps([
      {
        id: "claude-fable-5-9",
        name: "x",
        contextLength: 2_000_000,
        maxCompletionTokens: 200_000,
      },
    ]);
    const caps = resolveModelCapabilities("claude-fable-5-9", ANTHROPIC);
    expect(caps).toMatchObject({
      contextWindow: 2_000_000,
      modelContextWindow: 2_000_000,
      contextWindowIsEffective: true,
      contextWindowSource: "dynamic",
      maxOutputTokens: 200_000,
      // thinking／effort は今の解決（同 family の最新の既知）のまま。
      supportsAdaptiveThinking: true,
      supportsEffort: true,
    });
  });

  it("表に無い旧世代の Claude は live の context と最大出力を使うが、thinking は送らない（保守的）", () => {
    const before = resolveModelCapabilities("claude-opus-4-9", ANTHROPIC);
    expect(before).toMatchObject({
      contextWindow: 200_000,
      contextWindowSource: "default",
    });
    registerAnthropicModelCaps([
      {
        id: "claude-opus-4-9",
        name: "x",
        contextLength: 500_000,
        maxCompletionTokens: 64_000,
      },
    ]);
    const caps = resolveModelCapabilities("claude-opus-4-9", ANTHROPIC);
    expect(caps).toMatchObject({
      contextWindow: 500_000,
      contextWindowIsEffective: true,
      contextWindowSource: "dynamic",
      maxOutputTokens: 64_000,
      supportsThinking: false,
      supportsAdaptiveThinking: false,
      supportsEffort: false,
    });
    expect(
      buildThinkingParams(
        "claude-opus-4-9",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({});
  });

  it("live を登録しても、他の provider の解決は変わらない", () => {
    registerAnthropicModelCaps([
      {
        id: "claude-fable-5-9",
        name: "x",
        contextLength: 2_000_000,
        maxCompletionTokens: 200_000,
      },
    ]);
    expect(getDynamicModelMeta("openrouter", "claude-fable-5-9")).toBeNull();
    expect(
      resolveModelCapabilities("claude-fable-5-9", { provider: "openrouter" })
        .contextWindow,
    ).not.toBe(2_000_000);
  });

  it("limit を持たない一覧（固定の予備）は登録せず、前の live を残す", () => {
    registerAnthropicModelCaps([
      {
        id: "claude-fable-5-9",
        name: "x",
        contextLength: 2_000_000,
        maxCompletionTokens: 200_000,
      },
    ]);
    expect(
      registerAnthropicModelCaps([{ id: "claude-fable-5-9", name: "x" }]),
    ).toBe(false);
    expect(
      resolveModelCapabilities("claude-fable-5-9", ANTHROPIC).contextWindow,
    ).toBe(2_000_000);
  });
});

describe("Anthropic の capabilities（段 2 の B 案）", () => {
  it("capabilities つきの一覧でも、既知の 14 件は今の値と完全に一致する", () => {
    const before = new Map(
      TABLE_IDS.map((id) => [id, resolveModelCapabilities(id, ANTHROPIC)]),
    );
    expect(registerAnthropicModelCaps(FIXTURE_AI_MODELS_WITH_CAPS)).toBe(true);
    for (const id of TABLE_IDS) {
      expect(resolveModelCapabilities(id, ANTHROPIC), id).toEqual(
        before.get(id),
      );
    }
  });

  it("gen5 は adaptive＋effort のまま（xhigh は出さない）、haiku-4-5 は thinking なしのまま", () => {
    registerAnthropicModelCaps(FIXTURE_AI_MODELS_WITH_CAPS);
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
      "claude-fable-5-2",
    ]) {
      expect(
        buildThinkingParams(id, "high", "summarized", true, ANTHROPIC),
        id,
      ).toEqual({
        thinking: { type: "adaptive", effort: "high", display: "summarized" },
      });
      expect(resolveModelCapabilities(id, ANTHROPIC)).toMatchObject({
        supportsAdaptiveThinking: true,
        supportsThinking: false,
        supportsEffort: true,
      });
    }
    for (const id of ["claude-haiku-4-5-20251001", "claude-haiku-4-5"]) {
      expect(
        buildThinkingParams(id, "high", "summarized", true, ANTHROPIC),
      ).toEqual({});
    }
  });

  it("表に無い fable-5-2 は、live（adaptive＋effort）でも今の値と同じで、由来だけ dynamic", () => {
    const before = resolveModelCapabilities("claude-fable-5-2", ANTHROPIC);
    registerAnthropicModelCaps(FIXTURE_AI_MODELS_WITH_CAPS);
    expect(resolveModelCapabilities("claude-fable-5-2", ANTHROPIC)).toEqual({
      ...before,
      contextWindowSource: "dynamic",
    });
  });

  function synthetic(
    id: string,
    capabilities?: Record<string, unknown>,
  ): AiModel {
    return {
      id,
      name: id,
      contextLength: 400_000,
      maxCompletionTokens: 60_000,
      ...(capabilities ? { anthropicCapabilities: capabilities } : {}),
    };
  }

  it("表に無い id で live が adaptive を含めば adaptive、effort は live の段階（xhigh は無視）", () => {
    registerAnthropicModelCaps([
      synthetic("claude-opus-4-9", {
        thinking: {
          supported: true,
          types: {
            adaptive: { supported: true },
            enabled: { supported: false },
          },
        },
        effort: {
          supported: true,
          low: { supported: true },
          high: { supported: true },
          xhigh: { supported: true },
        },
      }),
    ]);
    expect(
      resolveModelCapabilities("claude-opus-4-9", ANTHROPIC),
    ).toMatchObject({
      contextWindow: 400_000,
      contextWindowSource: "dynamic",
      supportsAdaptiveThinking: true,
      supportsThinking: false,
      supportsEffort: true,
      // max は live が持たない（xhigh は製品が持たない）
      supportsMaxEffort: false,
    });
    expect(
      buildThinkingParams(
        "claude-opus-4-9",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({
      thinking: { type: "adaptive", effort: "high", display: "summarized" },
    });
  });

  it("表に無い id で live が enabled だけなら、thinking も effort も送らない（budget_tokens を新しく送らない）", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-5-9", {
        thinking: {
          supported: true,
          types: { enabled: { supported: true } },
        },
        effort: { supported: false },
      }),
    ]);
    // 今の推定（gen5 の近似）は adaptive だが、live が enabled だけなら送らない。
    expect(
      resolveModelCapabilities("claude-fable-5-9", ANTHROPIC),
    ).toMatchObject({
      supportsAdaptiveThinking: false,
      supportsThinking: false,
      supportsEffort: false,
    });
    expect(
      buildThinkingParams(
        "claude-fable-5-9",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({});
  });

  it("thinking.supported が false なら送らない", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-5-9", {
        thinking: { supported: false },
        effort: { supported: false },
      }),
    ]);
    expect(
      buildThinkingParams(
        "claude-fable-5-9",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({});
  });

  it("live が adaptive を許しても effort 不可と明示するなら、adaptive は送らない（adaptive は effort を伴う）", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-5-9", {
        thinking: {
          supported: true,
          types: { adaptive: { supported: true } },
        },
        effort: { supported: false },
      }),
    ]);
    expect(
      buildThinkingParams(
        "claude-fable-5-9",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({});
  });

  it("enabled ＋ effort（opus-4-5 型）の表に無い id は budget_tokens も effort 単独も送らない", () => {
    registerAnthropicModelCaps([
      synthetic("claude-opus-4-9", {
        thinking: {
          supported: true,
          types: { enabled: { supported: true } },
        },
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
        },
      }),
    ]);
    expect(
      buildThinkingParams(
        "claude-opus-4-9",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({});
    expect(
      resolveModelCapabilities("claude-opus-4-9", ANTHROPIC),
    ).toMatchObject({ supportsEffort: false, supportsMaxEffort: false });
  });

  it("近い id で live が実機の opus-4-5 と同じ形（enabled ＋ effort 可）でも、effort を新しく送らない", () => {
    registerAnthropicModelCaps([
      synthetic("claude-opus-4-5-1", {
        thinking: {
          supported: true,
          types: { enabled: { supported: true } },
        },
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
        },
      }),
    ]);
    expect(
      buildThinkingParams(
        "claude-opus-4-5-1",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({});
    // 表の opus-4-5 そのものは不変（budget thinking、effort なし）。
    expect(
      buildThinkingParams(
        "claude-opus-4-5",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).not.toHaveProperty("effort");
  });

  it("方式を live が判定し effort の情報が無ければ、effort 単独も送らない", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-5-9", {
        thinking: {
          supported: true,
          types: { enabled: { supported: true } },
        },
      }),
    ]);
    expect(
      buildThinkingParams(
        "claude-fable-5-9",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({});
  });

  it("表のモデルに前方一致で近似される表に無い id も、live が enabled だけなら budget_tokens を送らない", () => {
    const before = buildThinkingParams(
      "claude-opus-4-5-1",
      "high",
      "summarized",
      true,
      ANTHROPIC,
    );
    expect(before.thinking?.type).toBe("enabled");
    registerAnthropicModelCaps([
      synthetic("claude-opus-4-5-1", {
        thinking: {
          supported: true,
          types: { enabled: { supported: true } },
        },
        effort: { supported: false },
      }),
    ]);
    expect(
      buildThinkingParams(
        "claude-opus-4-5-1",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({});
  });

  it("capabilities が無ければ A 案と同じ（今の推定のまま）", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-5-9"),
      synthetic("claude-opus-4-9"),
    ]);
    expect(
      resolveModelCapabilities("claude-fable-5-9", ANTHROPIC),
    ).toMatchObject({ supportsAdaptiveThinking: true, supportsEffort: true });
    expect(
      resolveModelCapabilities("claude-opus-4-9", ANTHROPIC),
    ).toMatchObject({
      supportsAdaptiveThinking: false,
      supportsThinking: false,
      supportsEffort: false,
    });
  });

  it("thinking の方式が分からない capabilities（types なし）も、今の推定のまま", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-5-9", { thinking: { supported: true } }),
    ]);
    expect(
      resolveModelCapabilities("claude-fable-5-9", ANTHROPIC),
    ).toMatchObject({ supportsAdaptiveThinking: true, supportsEffort: true });
  });

  it("thinking の値は保存され、復元後も使われる（v4）", () => {
    registerAnthropicModelCaps([
      synthetic("claude-opus-4-9", {
        thinking: {
          supported: true,
          types: { adaptive: { supported: true } },
        },
        effort: {
          supported: true,
          low: { supported: true },
          max: { supported: true },
        },
      }),
    ]);
    expect(Object.keys(store)).toEqual(["grimodex.modelCaps.v4"]);
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("anthropic", "claude-opus-4-9")).toMatchObject({
      anthropicThinking: {
        adaptive: true,
        enabled: false,
        effortSteps: ["low", "max"],
      },
    });
    expect(
      resolveModelCapabilities("claude-opus-4-9", ANTHROPIC),
    ).toMatchObject({
      supportsAdaptiveThinking: true,
      supportsMaxEffort: true,
    });
  });

  it("v3 の保存は復元せず捨てる", () => {
    store["grimodex.modelCaps.v3"] = JSON.stringify({
      version: 3,
      providers: {
        anthropic: {
          fetchedAt: Date.now(),
          models: { "claude-fable-5-9": { ctx: 1 } },
        },
      },
    });
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("anthropic", "claude-fable-5-9")).toBeNull();
    expect(store["grimodex.modelCaps.v3"]).toBeUndefined();
  });

  it("他の provider の meta には anthropicThinking が付かない", () => {
    registerAnthropicModelCaps(FIXTURE_AI_MODELS_WITH_CAPS);
    expect(getDynamicModelMeta("openrouter", "claude-opus-5-5")).toBeNull();
  });
});

describe("Anthropic の effort の段階の三つの状態と丸め（表に無い id だけ）", () => {
  const ADAPTIVE = {
    supported: true,
    types: { adaptive: { supported: true } },
  };

  function synthetic(id: string, effort?: Record<string, unknown>): AiModel {
    return {
      id,
      name: id,
      contextLength: 400_000,
      maxCompletionTokens: 60_000,
      anthropicCapabilities: {
        thinking: ADAPTIVE,
        ...(effort ? { effort } : {}),
      },
    };
  }

  function adaptiveEffort(
    id: string,
    requested: "low" | "medium" | "high" | "max",
  ) {
    const params = buildThinkingParams(
      id,
      requested,
      "summarized",
      true,
      ANTHROPIC,
    );
    return "thinking" in params && params.thinking?.type === "adaptive"
      ? params.thinking.effort
      : params;
  }

  it("(a) effort 非対応と明示 → adaptive を送らない", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-6-1", { supported: false }),
    ]);
    expect(
      buildThinkingParams(
        "claude-fable-6-1",
        "high",
        "summarized",
        true,
        ANTHROPIC,
      ),
    ).toEqual({});
  });

  it("(b) 対応だが段階の key の形が読めない → 今の推定に戻す（adaptive＋effort のまま、丸めない）", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-6-1", {
        supported: true,
        ultra: { supported: true },
      }),
    ]);
    expect(getDynamicModelMeta("anthropic", "claude-fable-6-1")).toMatchObject({
      anthropicThinking: { adaptive: true, effortSteps: undefined },
    });
    expect(
      resolveModelCapabilities("claude-fable-6-1", ANTHROPIC),
    ).toMatchObject({
      supportsAdaptiveThinking: true,
      supportsEffort: true,
    });
    expect(adaptiveEffort("claude-fable-6-1", "max")).toBe("max");
  });

  it("(c) 対応だが製品の段階が無い（xhigh だけ）→ thinking を送らず、一度だけ記録する", () => {
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
    try {
      const models = [
        synthetic("claude-fable-6-1", {
          supported: true,
          xhigh: { supported: true },
        }),
      ];
      registerAnthropicModelCaps(models);
      expect(
        buildThinkingParams(
          "claude-fable-6-1",
          "high",
          "summarized",
          true,
          ANTHROPIC,
        ),
      ).toEqual({});
      expect(
        getDynamicModelMeta("anthropic", "claude-fable-6-1"),
      ).toMatchObject({
        anthropicThinking: { adaptive: false, effortSteps: [] },
      });
      // 取り直しても、読み直しても記録は一度だけ。
      registerAnthropicModelCaps(models);
      registerAnthropicModelCaps([{ ...models[0], contextLength: 410_000 }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toContain("effort");
    } finally {
      warn.mockRestore();
    }
  });

  it("一部の段階だけ許すモデルでは、要求以下で最も高い許された段階へ丸める", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-6-1", {
        supported: true,
        low: { supported: true },
        high: { supported: true },
      }),
    ]);
    expect(adaptiveEffort("claude-fable-6-1", "low")).toBe("low");
    expect(adaptiveEffort("claude-fable-6-1", "medium")).toBe("low");
    expect(adaptiveEffort("claude-fable-6-1", "high")).toBe("high");
    // max を許さないモデルへ max を送らない
    expect(adaptiveEffort("claude-fable-6-1", "max")).toBe("high");
  });

  it("要求以下が無ければ、許された最も低い段階へ丸める", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-6-1", {
        supported: true,
        high: { supported: true },
        max: { supported: true },
      }),
    ]);
    expect(adaptiveEffort("claude-fable-6-1", "low")).toBe("high");
    expect(adaptiveEffort("claude-fable-6-1", "medium")).toBe("high");
    expect(adaptiveEffort("claude-fable-6-1", "max")).toBe("max");
  });

  it("丸めの情報は保存・復元の後も使われる", () => {
    registerAnthropicModelCaps([
      synthetic("claude-fable-6-1", {
        supported: true,
        medium: { supported: true },
      }),
    ]);
    __resetDynamicModelCapsForTests();
    expect(adaptiveEffort("claude-fable-6-1", "max")).toBe("medium");
    expect(adaptiveEffort("claude-fable-6-1", "low")).toBe("medium");
  });

  it("既知の 14 件は、live が一部の段階だけでも request を変えない（丸めは表に無い id だけ）", () => {
    const requests = (): unknown[] =>
      TABLE_IDS.flatMap((id) =>
        (["low", "medium", "high", "max"] as const).map((effort) =>
          buildThinkingParams(id, effort, "summarized", true, ANTHROPIC),
        ),
      );
    const before = requests();
    registerAnthropicModelCaps(
      FIXTURE_AI_MODELS_WITH_CAPS.map((model) => ({
        ...model,
        anthropicCapabilities: {
          thinking: ADAPTIVE,
          effort: { supported: true, medium: { supported: true } },
        },
      })),
    );
    expect(requests()).toEqual(before);
  });
});

describe("Rust と TS の field 名の境界（AiModel の wire JSON）", () => {
  // Rust 側の `anthropic_models_wire_json_matches_the_fixture_the_renderer_reads`
  // （grimodex-ai の lib.rs）が、同じ 2 つの fixture を `parse_anthropic_model` と
  // serde で写して一致を固定する。どちらかの名前が変わると、どちらかの試験が落ちる。
  const WIRE = wireModels as unknown as Array<Record<string, unknown>>;

  it("型の field 名（コンパイル時）と wire の key 名が一致する", () => {
    const key: keyof AiModel = "anthropicCapabilities";
    const contextKey: keyof AiModel = "contextLength";
    const outKey: keyof AiModel = "maxCompletionTokens";
    expect(WIRE.length).toBe((liveModels as unknown[]).length);
    for (const entry of WIRE) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          "anthropicCapabilities",
          "contextLength",
          "id",
          "maxCompletionTokens",
          "name",
        ]
          .filter((k) => k in entry)
          .sort(),
      );
      expect(entry).toHaveProperty(key);
      expect(entry).toHaveProperty(contextKey);
      expect(entry).toHaveProperty(outKey);
    }
  });

  it("wire の anthropicCapabilities を parseAnthropicLiveCaps が、生の応答と同じに読む", () => {
    const raw = liveModels as unknown[];
    WIRE.forEach((entry, index) => {
      const fromWire = parseAnthropicLiveCaps({
        id: entry.id,
        max_input_tokens: entry.contextLength,
        max_tokens: entry.maxCompletionTokens,
        capabilities: entry.anthropicCapabilities,
      });
      const fromRaw = parseAnthropicLiveCaps(raw[index]);
      expect(fromWire?.thinking).toEqual(fromRaw?.thinking);
      expect(fromWire?.contextWindow).toBe(fromRaw?.contextWindow);
      expect(fromWire?.maxOutput).toBe(fromRaw?.maxOutput);
      expect(fromWire?.thinking).toBeDefined();
    });
  });

  it("wire のまま渡すと、registerAnthropicModelCaps が context／最大出力／thinking を登録する", () => {
    expect(registerAnthropicModelCaps(wireModels as unknown as AiModel[])).toBe(
      true,
    );
    expect(getDynamicModelMeta("anthropic", "claude-fable-5-2")).toMatchObject({
      ctx: 1_000_000,
      out: 128_000,
      anthropicThinking: { adaptive: true },
    });
  });
});
