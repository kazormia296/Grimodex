import { beforeEach, describe, expect, it, vi } from "vitest";

import bundled from "@/../electron/resources/model-capabilities.json";
import { SNAPSHOT_PROVIDERS } from "@/../electron/shared/modelCapabilityRegistry";
import type { AiModel } from "../types";
import liveModels from "./__fixtures__/anthropic-models-2023-06-01.json";
import { parseAnthropicLiveCaps } from "./anthropicLiveCaps";
import {
  __resetDynamicModelCapsForTests,
  registerAnthropicModelCaps,
  registerDynamicModelCaps,
} from "./dynamicModelCaps";
import {
  __capabilityTableIdsForTests,
  buildThinkingParams,
  getModelCapabilities,
  isListedInCapabilityTable,
  resolveModelCapabilities,
  type ModelCapabilities,
} from "./modelLimits";
import {
  __resetRegistryModelCapsForTests,
  getRegistryModelCaps,
  REGISTRY_CAPS_PROVIDERS,
  setRegistryModelCaps,
} from "./registryModelCaps";

/**
 * PR-C3：共有 registry（main が取得・同梱した能力の写し）は、能力表に無い id にだけ使う（Q1）。
 * 使うのは context・最大出力・tool の 3 つだけで、thinking・effort の送信は変えない。
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

type Models = Parameters<typeof setRegistryModelCaps>[0]["models"];

/** 表の値と必ず違う値。表の id に漏れれば、前後の比較が崩れる。 */
const DIFFERENT = {
  contextWindow: 123_456,
  maxOutputTokens: 7_890,
  toolCall: false,
  reasoning: true,
};

const TABLE_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;

/** thinking・effort・reasoning の送り方を決める field（registry は触れない）。 */
const THINKING_FIELDS = [
  "supportsThinking",
  "supportsAdaptiveThinking",
  "supportsEffort",
  "supportsMaxEffort",
  "adaptiveEffortSteps",
  "supportsReasoning",
  "canDisableReasoning",
  "reasoningEffortValues",
  "supportsStructuredJson",
  "defaultVisibleOutputTokens",
  "defaultReasoningReservationTokens",
] as const satisfies readonly (keyof ModelCapabilities)[];

function pickThinking(caps: ModelCapabilities): Record<string, unknown> {
  return Object.fromEntries(THINKING_FIELDS.map((key) => [key, caps[key]]));
}

function setRegistry(models: Models): void {
  expect(setRegistryModelCaps({ models })).toBe(true);
}

/** `claude-opus-4-6` → `claude-opus-4.6`（OpenRouter・OpenAI のドット表記）。 */
function dotted(id: string): string {
  return id.replace(/(\d)-(\d{1,2})(?!\d)/u, "$1.$2");
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  __resetDynamicModelCapsForTests();
  __resetRegistryModelCapsForTests();
});

describe("registry の保持（setRegistryModelCaps／getRegistryModelCaps）", () => {
  it("対応する provider の key だけを持ち、使う 3 field に絞る（reasoning は持たない）", () => {
    setRegistry({
      "openai/gpt-x": { contextWindow: 10, reasoning: true },
      "ollama-cloud/foo": { contextWindow: 20 },
      "google/gemini": { contextWindow: 30 },
      "openai/reasoning-only": { reasoning: true },
      "no-slash": { contextWindow: 40 },
    });
    expect(getRegistryModelCaps("openai", "gpt-x")).toEqual({
      contextWindow: 10,
    });
    expect(getRegistryModelCaps("openai", "reasoning-only")).toBeNull();
    // 対応表に無い provider は引けない。
    expect(getRegistryModelCaps("ollama", "foo")).toBeNull();
    expect(getRegistryModelCaps("openai-compatible", "gpt-x")).toBeNull();
  });

  it("契約の範囲外の値（0・負・小数・文字列）は捨てる", () => {
    setRegistry({
      "openai/a": {
        contextWindow: 0,
        maxOutputTokens: -1,
      },
      "openai/b": {
        contextWindow: 1.5,
        maxOutputTokens: 4096,
      },
      "openai/c": {
        contextWindow: "1000" as unknown as number,
        toolCall: "yes" as unknown as boolean,
      },
    });
    expect(getRegistryModelCaps("openai", "a")).toBeNull();
    expect(getRegistryModelCaps("openai", "b")).toEqual({
      maxOutputTokens: 4096,
    });
    expect(getRegistryModelCaps("openai", "c")).toBeNull();
  });

  it("provider と id の完全一致だけで引く（前方一致・ドットの正規化・大文字小文字はしない）", () => {
    setRegistry({ "openai/gpt-5.6": { contextWindow: 400_000 } });
    expect(getRegistryModelCaps("openai", "gpt-5.6")).toEqual({
      contextWindow: 400_000,
    });
    expect(getRegistryModelCaps("openai", "gpt-5-6")).toBeNull();
    expect(getRegistryModelCaps("openai", "gpt-5.6-mini")).toBeNull();
    expect(getRegistryModelCaps("openai", "gpt-5")).toBeNull();
    expect(getRegistryModelCaps("openai", "GPT-5.6")).toBeNull();
    // 別の provider の同名 id には当たらない。
    expect(getRegistryModelCaps("anthropic", "gpt-5.6")).toBeNull();
    expect(getRegistryModelCaps("openrouter", "gpt-5.6")).toBeNull();
  });

  it("OpenRouter だけ、旧い `openrouter/` prefix を外して引く（完全一致を先に見る）", () => {
    setRegistry({
      "openrouter/vendor/new": { contextWindow: 11 },
      "openrouter/openrouter/auto": { contextWindow: 22 },
      "openrouter/auto": { contextWindow: 33 },
    });
    expect(getRegistryModelCaps("openrouter", "openrouter/vendor/new")).toEqual(
      { contextWindow: 11 },
    );
    expect(getRegistryModelCaps("openrouter", "openrouter/auto")).toEqual({
      contextWindow: 22,
    });
    expect(getRegistryModelCaps("openrouter", "auto")).toEqual({
      contextWindow: 33,
    });
    expect(getRegistryModelCaps("openai", "openrouter/vendor/new")).toBeNull();
  });

  it("registry の provider は、写しの対応表（SNAPSHOT_PROVIDERS）と同じ", () => {
    expect([...REGISTRY_CAPS_PROVIDERS].sort()).toEqual(
      [...SNAPSHOT_PROVIDERS].sort(),
    );
  });
});

describe("表に載っている id には registry が一切触れない（Q1）", () => {
  it("表の全 key（別名・ドット表記・日付付き・:variant を含む）で、違う値を入れても前後が同じ", () => {
    const ids = __capabilityTableIdsForTests();
    expect(ids.length).toBeGreaterThan(50);
    const variants = (id: string) => [
      id,
      dotted(id),
      `${id}-20991231`,
      `${id}:free`,
    ];
    const keys: Array<[string, string]> = [];
    for (const provider of TABLE_PROVIDERS) {
      for (const id of ids) {
        for (const variant of variants(id)) keys.push([provider, variant]);
      }
    }
    const before = keys.map(([provider, id]) =>
      resolveModelCapabilities(id, { provider }),
    );
    // 表の判定が全て「載っている」であること（registry の層の入口に当たる id だけを試す）。
    for (const [, id] of keys) expect(isListedInCapabilityTable(id)).toBe(true);

    const models: Record<string, typeof DIFFERENT> = {};
    for (const [provider, id] of keys) models[`${provider}/${id}`] = DIFFERENT;
    setRegistry(models);
    // 写しを引けている（この試験が空振りでない）ことを確かめる。
    expect(getRegistryModelCaps("openai", "gpt-4o")).toMatchObject({
      contextWindow: 123_456,
    });
    keys.forEach(([provider, id], index) => {
      expect(
        resolveModelCapabilities(id, { provider }),
        `${provider}/${id}`,
      ).toEqual(before[index]);
    });
  });

  it("表に載っている id の、表に無い field を registry で埋めることもしない", () => {
    // `gpt-4o` の表の定義は maxOutputTokens を持たない。registry が持っていても足さない。
    const before = resolveModelCapabilities("gpt-4o", { provider: "openai" });
    expect(before.maxOutputTokens).toBeUndefined();
    setRegistry({ "openai/gpt-4o": { maxOutputTokens: 16_384 } });
    const after = resolveModelCapabilities("gpt-4o", { provider: "openai" });
    expect(after.maxOutputTokens).toBeUndefined();
    expect(after).toEqual(before);
  });

  it("既知の Anthropic 14 件は、registry（違う値）を入れても、live の登録の前後でも今の値のまま", () => {
    const aiModels: AiModel[] = (liveModels as unknown[]).map((raw) => {
      const live = parseAnthropicLiveCaps(raw);
      if (!live) throw new Error("fixture の model object が不正");
      return {
        id: live.id,
        name: live.displayName ?? live.id,
        contextLength: live.contextWindow,
        maxCompletionTokens: live.maxOutput,
      };
    });
    const tableIds = aiModels
      .map((m) => m.id)
      .filter((id) => id !== "claude-fable-5-2");
    expect(tableIds).toHaveLength(14);

    const anthropic = { provider: "anthropic" };
    const before = tableIds.map((id) =>
      resolveModelCapabilities(id, anthropic),
    );
    setRegistry(
      Object.fromEntries(aiModels.map((m) => [`anthropic/${m.id}`, DIFFERENT])),
    );
    tableIds.forEach((id, index) => {
      expect(resolveModelCapabilities(id, anthropic), id).toEqual(
        before[index],
      );
    });
    expect(registerAnthropicModelCaps(aiModels)).toBe(true);
    tableIds.forEach((id, index) => {
      expect(resolveModelCapabilities(id, anthropic), id).toEqual(
        before[index],
      );
    });
  });

  it("同梱の写しの全 key：載っている id は今の値のまま、載っていない id だけ context・出力・tool が写しの値になる", () => {
    const models = bundled.models as Models;
    const targets = Object.keys(models)
      .map((key) => {
        const slash = key.indexOf("/");
        return {
          key,
          provider: key.slice(0, slash) as (typeof TABLE_PROVIDERS)[number],
          id: key.slice(slash + 1),
        };
      })
      .filter(({ provider }) =>
        (TABLE_PROVIDERS as readonly string[]).includes(provider),
      );
    const before = targets.map(({ provider, id }) =>
      resolveModelCapabilities(id, { provider }),
    );
    setRegistry(models);

    let listed = 0;
    let unlisted = 0;
    targets.forEach(({ key, provider, id }, index) => {
      const entry = models[key];
      const prev = before[index];
      const next = resolveModelCapabilities(id, { provider });
      if (isListedInCapabilityTable(id)) {
        listed += 1;
        expect(next, key).toEqual(prev);
        return;
      }
      unlisted += 1;
      expect(next.contextWindow, key).toBe(
        entry.contextWindow ?? prev.contextWindow,
      );
      expect(next.maxOutputTokens, key).toBe(
        entry.maxOutputTokens ?? prev.maxOutputTokens,
      );
      expect(next.supportsTools, key).toBe(
        provider === "anthropic"
          ? prev.supportsTools
          : (entry.toolCall ?? prev.supportsTools),
      );
      // reasoning の真偽値で、thinking・effort の送り方が変わらない。
      expect(pickThinking(next), key).toEqual(pickThinking(prev));
    });
    expect(listed).toBeGreaterThan(20);
    expect(unlisted).toBeGreaterThan(100);
  });
});

describe("表に載っていない id では registry の値を使う", () => {
  it("OpenAI の未知モデル：既定の 8K・出力の既定から、写しの context・出力・tool になる", () => {
    const before = resolveModelCapabilities("gpt-6-astra", {
      provider: "openai",
    });
    expect(before).toMatchObject({
      contextWindow: 8_000,
      contextWindowSource: "default",
      contextWindowIsEffective: false,
    });
    expect(before.maxOutputTokens).toBeUndefined();
    setRegistry({
      "openai/gpt-6-astra": {
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        toolCall: false,
        reasoning: true,
      },
    });
    const after = resolveModelCapabilities("gpt-6-astra", {
      provider: "openai",
    });
    expect(after).toMatchObject({
      contextWindow: 1_050_000,
      modelContextWindow: 1_050_000,
      contextWindowIsEffective: true,
      contextWindowSource: "registry",
      maxOutputTokens: 128_000,
      supportsTools: false,
    });
    // 他の field（thinking・reasoning・予約の既定）は変わらない。
    expect(pickThinking(after)).toEqual(pickThinking(before));
  });

  it("前方一致の近似（gpt-5.6 が gpt-5 に当たる）より registry が優先する", () => {
    const approx = getModelCapabilities("gpt-5.6");
    expect(approx.contextWindowSource).toBe("hardcoded");
    expect(isListedInCapabilityTable("gpt-5.6")).toBe(false);
    setRegistry({
      "openai/gpt-5.6": { contextWindow: 777_000, maxOutputTokens: 99_000 },
    });
    const after = resolveModelCapabilities("gpt-5.6", { provider: "openai" });
    expect(after).toMatchObject({
      contextWindow: 777_000,
      maxOutputTokens: 99_000,
      contextWindowSource: "registry",
    });
    // 近似の thinking・reasoning の扱いは今のまま。
    expect(pickThinking(after)).toEqual(
      pickThinking(resolveModelCapabilities("gpt-5.6", { provider: "openai" })),
    );
    expect(pickThinking(after)).toEqual(pickThinking(approx));
  });

  it("OpenRouter の未知モデルと、旧い openrouter/ prefix の id", () => {
    setRegistry({
      "openrouter/vendor/new-model": {
        contextWindow: 262_144,
        maxOutputTokens: 32_768,
      },
    });
    for (const id of ["vendor/new-model", "openrouter/vendor/new-model"]) {
      expect(
        resolveModelCapabilities(id, { provider: "openrouter" }),
        id,
      ).toMatchObject({
        contextWindow: 262_144,
        maxOutputTokens: 32_768,
        contextWindowSource: "registry",
      });
    }
  });

  it("表に無い旧世代の Claude：200K の推定から、写しの context・出力になる（thinking は送らないまま）", () => {
    const id = "claude-3-7-sonnet-20250219";
    const before = resolveModelCapabilities(id, { provider: "anthropic" });
    expect(before).toMatchObject({
      contextWindow: 200_000,
      contextWindowSource: "default",
    });
    setRegistry({
      "anthropic/claude-3-7-sonnet-20250219": {
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        toolCall: false,
        reasoning: true,
      },
    });
    const after = resolveModelCapabilities(id, { provider: "anthropic" });
    expect(after).toMatchObject({
      contextWindow: 200_000,
      contextWindowSource: "registry",
      maxOutputTokens: 64_000,
      // Claude の tool は製品の判断。写しの toolCall:false では止めない。
      supportsTools: true,
      supportsThinking: false,
      supportsAdaptiveThinking: false,
      supportsEffort: false,
    });
  });

  it("field が無いときは下の層（近似・既定）のまま。false は明示の非対応だけ", () => {
    const base = resolveModelCapabilities("gpt-6-astra", {
      provider: "openai",
    });
    // context だけ：出力・tool は下の層のまま。
    setRegistry({ "openai/gpt-6-astra": { contextWindow: 500_000 } });
    let after = resolveModelCapabilities("gpt-6-astra", { provider: "openai" });
    expect(after).toEqual({
      ...base,
      contextWindow: 500_000,
      modelContextWindow: 500_000,
      contextWindowIsEffective: true,
      contextWindowSource: "registry",
    });
    // 出力だけ：context は既定のまま（由来も default のまま）。
    setRegistry({ "openai/gpt-6-astra": { maxOutputTokens: 50_000 } });
    after = resolveModelCapabilities("gpt-6-astra", { provider: "openai" });
    expect(after).toEqual({ ...base, maxOutputTokens: 50_000 });
    expect(after.contextWindowSource).toBe("default");
    // toolCall だけ：true は既定と同じ、false は明示の非対応。
    setRegistry({ "openai/gpt-6-astra": { toolCall: true } });
    expect(
      resolveModelCapabilities("gpt-6-astra", { provider: "openai" }),
    ).toEqual(base);
    setRegistry({ "openai/gpt-6-astra": { toolCall: false } });
    expect(
      resolveModelCapabilities("gpt-6-astra", { provider: "openai" }),
    ).toEqual({ ...base, supportsTools: false });
    // reasoning だけの項目は、そもそも持たない。
    setRegistry({ "openai/gpt-6-astra": { reasoning: true } });
    expect(
      resolveModelCapabilities("gpt-6-astra", { provider: "openai" }),
    ).toEqual(base);
  });
});

describe("provider の live は registry より優先する", () => {
  it("Anthropic の表に無い id：live の context・出力が registry に勝つ", () => {
    const id = "claude-fable-5-2";
    setRegistry({
      "anthropic/claude-fable-5-2": {
        contextWindow: 555_555,
        maxOutputTokens: 55_555,
      },
    });
    expect(
      resolveModelCapabilities(id, { provider: "anthropic" }),
    ).toMatchObject({
      contextWindow: 555_555,
      maxOutputTokens: 55_555,
      contextWindowSource: "registry",
    });
    expect(
      registerAnthropicModelCaps([
        {
          id,
          name: id,
          contextLength: 900_000,
          maxCompletionTokens: 100_000,
        },
      ]),
    ).toBe(true);
    expect(
      resolveModelCapabilities(id, { provider: "anthropic" }),
    ).toMatchObject({
      contextWindow: 900_000,
      modelContextWindow: 900_000,
      maxOutputTokens: 100_000,
      contextWindowSource: "dynamic",
    });
  });

  it("Anthropic：live が context だけなら、出力だけ registry から入る。live が出力だけなら逆", () => {
    const id = "claude-fable-5-2";
    setRegistry({
      "anthropic/claude-fable-5-2": {
        contextWindow: 555_555,
        maxOutputTokens: 55_555,
      },
    });
    registerAnthropicModelCaps([{ id, name: id, contextLength: 900_000 }]);
    expect(
      resolveModelCapabilities(id, { provider: "anthropic" }),
    ).toMatchObject({
      contextWindow: 900_000,
      maxOutputTokens: 55_555,
      contextWindowSource: "dynamic",
    });
    __resetDynamicModelCapsForTests();
    registerAnthropicModelCaps([{ id, name: id, maxCompletionTokens: 77_000 }]);
    expect(
      resolveModelCapabilities(id, { provider: "anthropic" }),
    ).toMatchObject({
      contextWindow: 555_555,
      maxOutputTokens: 77_000,
      contextWindowSource: "registry",
    });
  });

  it("OpenRouter：live の context・tool が registry に勝ち、live に無い field は registry が埋める", () => {
    const id = "vendor/new-model";
    setRegistry({
      "openrouter/vendor/new-model": {
        contextWindow: 500_000,
        maxOutputTokens: 32_000,
        toolCall: false,
      },
    });
    registerDynamicModelCaps("openrouter", [
      {
        id,
        name: id,
        contextLength: 64_000,
        supportedParameters: ["tools"],
      },
    ]);
    expect(
      resolveModelCapabilities(id, { provider: "openrouter" }),
    ).toMatchObject({
      contextWindow: 64_000,
      contextWindowSource: "dynamic",
      // live が出力を返さないので registry
      maxOutputTokens: 32_000,
      // live の tools が勝つ
      supportsTools: true,
    });
    // live が tool を返さない（parameter の一覧が無い）ときは registry の false。
    __resetDynamicModelCapsForTests();
    registerDynamicModelCaps("openrouter", [
      { id, name: id, contextLength: 64_000 },
    ]);
    expect(
      resolveModelCapabilities(id, { provider: "openrouter" }),
    ).toMatchObject({ contextWindow: 64_000, supportsTools: false });
  });
});

describe("registry が届かない経路", () => {
  const UNLISTED = "gpt-6-astra";
  const REGISTRY_ENTRY = {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    toolCall: false,
  };

  it("OpenAI 互換・Ollama・CLI・AI のべりすとは、registry の値で変わらない", () => {
    const settingsList = [
      { provider: "openai-compatible" },
      { provider: "ollama" },
      { provider: "cli" },
      { provider: "ai-novelist" },
    ];
    const before = settingsList.map((settings) =>
      resolveModelCapabilities(UNLISTED, settings),
    );
    // 同名の bare id が openai の key で登録されていても、別 provider には当たらない。
    setRegistry({
      [`openai/${UNLISTED}`]: REGISTRY_ENTRY,
      [`openai-compatible/${UNLISTED}`]: REGISTRY_ENTRY,
      [`ollama/${UNLISTED}`]: REGISTRY_ENTRY,
      [`cli/${UNLISTED}`]: REGISTRY_ENTRY,
    });
    settingsList.forEach((settings, index) => {
      expect(
        resolveModelCapabilities(UNLISTED, settings),
        settings.provider,
      ).toEqual(before[index]);
    });
  });

  it("OpenAI 互換の customMax は registry より上（ユーザーの上書きが勝つ）", () => {
    setRegistry({ [`openai/${UNLISTED}`]: REGISTRY_ENTRY });
    expect(
      resolveModelCapabilities(UNLISTED, {
        provider: "openai-compatible",
        openaiCompatible: { customMaxContext: 32_000, customMaxOutput: 2_000 },
      }),
    ).toMatchObject({ contextWindow: 32_000, maxOutputTokens: 2_000 });
  });

  it("Sakana は provider 全体が製品の判断（1M／32K）で、registry の値は届かない", () => {
    const ids = ["fugu", "fugu-ultra", "fugu-ultra-20260615", "unknown-sakana"];
    const before = ids.map((id) =>
      resolveModelCapabilities(id, { provider: "sakana" }),
    );
    setRegistry(
      Object.fromEntries(ids.map((id) => [`sakana/${id}`, DIFFERENT])),
    );
    ids.forEach((id, index) => {
      const after = resolveModelCapabilities(id, { provider: "sakana" });
      expect(after, id).toEqual(before[index]);
      expect(after, id).toMatchObject({
        contextWindow: 1_000_000,
        maxOutputTokens: 32_000,
        supportsTools: true,
      });
    });
  });

  it("provider が分からない呼び出し（getModelCapabilities・設定なし）は表だけ", () => {
    const before = [
      getModelCapabilities(UNLISTED),
      resolveModelCapabilities(UNLISTED),
      resolveModelCapabilities(UNLISTED, {}),
      resolveModelCapabilities(UNLISTED, null),
    ];
    setRegistry({ [`openai/${UNLISTED}`]: REGISTRY_ENTRY });
    expect([
      getModelCapabilities(UNLISTED),
      resolveModelCapabilities(UNLISTED),
      resolveModelCapabilities(UNLISTED, {}),
      resolveModelCapabilities(UNLISTED, null),
    ]).toEqual(before);
  });

  it("写しが無い（読めなかった・Web 版）間は、今の挙動のまま", () => {
    const openai = resolveModelCapabilities(UNLISTED, { provider: "openai" });
    expect(openai).toMatchObject({
      contextWindow: 8_000,
      contextWindowSource: "default",
    });
    expect(getRegistryModelCaps("openai", UNLISTED)).toBeNull();
    // 写しを入れてから状態を戻すと、層が消える。
    setRegistry({ [`openai/${UNLISTED}`]: REGISTRY_ENTRY });
    expect(
      resolveModelCapabilities(UNLISTED, { provider: "openai" }),
    ).not.toEqual(openai);
    __resetRegistryModelCapsForTests();
    expect(resolveModelCapabilities(UNLISTED, { provider: "openai" })).toEqual(
      openai,
    );
  });
});

describe("thinking と effort の送信は registry で変わらない", () => {
  const CASES: Array<{ provider: string; id: string }> = [
    // Anthropic：表の id と表に無い id（adaptive／budget／送らない）
    { provider: "anthropic", id: "claude-opus-5-5" },
    { provider: "anthropic", id: "claude-opus-4-6" },
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "anthropic", id: "claude-fable-5-2" },
    { provider: "anthropic", id: "claude-3-7-sonnet-20250219" },
    // OpenAI：表の id、表に無い id（近似が reasoning を持つもの・持たないもの）
    { provider: "openai", id: "o3" },
    { provider: "openai", id: "gpt-5-pro" },
    { provider: "openai", id: "gpt-5.6" },
    { provider: "openai", id: "gpt-6-astra" },
    { provider: "openai", id: "gpt-4o" },
    // OpenRouter
    { provider: "openrouter", id: "anthropic/claude-opus-4.6" },
    { provider: "openrouter", id: "openai/gpt-5.6" },
    { provider: "openrouter", id: "vendor/new-model" },
  ];

  it("registry の reasoning が true／false のどちらでも、buildThinkingParams と thinking 系の flag が前後で一致する", () => {
    const efforts = ["low", "medium", "high", "max"] as const;
    const run = () =>
      CASES.map(({ provider, id }) => ({
        caps: pickThinking(resolveModelCapabilities(id, { provider })),
        thinking: efforts.map((effort) => [
          buildThinkingParams(id, effort, "summarized", true, { provider }),
          buildThinkingParams(id, effort, "omitted", false, { provider }),
        ]),
      }));
    const before = run();
    for (const reasoning of [true, false]) {
      setRegistry(
        Object.fromEntries(
          CASES.map(({ provider, id }) => [
            `${provider}/${id}`,
            { ...DIFFERENT, reasoning },
          ]),
        ),
      );
      expect(run()).toEqual(before);
    }
    // 空振りでない：registry の値は、表に無い id の context には届いている。
    expect(
      resolveModelCapabilities("vendor/new-model", { provider: "openrouter" })
        .contextWindow,
    ).toBe(123_456);
  });
});
