import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDynamicModelCapsForTests,
  getDynamicModelMeta,
  isDynamicCapsStale,
  registerDynamicModelCaps,
} from "./dynamicModelCaps";
import type { AiModel } from "../types";

// localStorage をモック
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
};

vi.stubGlobal("localStorage", localStorageMock);

const STORAGE_KEY = "grimodex.openrouterModelCaps.v1";

function makeModel(overrides: Partial<AiModel> & { id: string }): AiModel {
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

describe("registerDynamicModelCaps + getDynamicModelMeta", () => {
  it("'/' を含む id のみ登録する", () => {
    registerDynamicModelCaps([
      makeModel({ id: "anthropic/claude-sonnet-4.6" }),
      makeModel({ id: "claude-sonnet-4-6" }), // bare id — 登録スキップ
    ]);
    expect(getDynamicModelMeta("anthropic/claude-sonnet-4.6")).not.toBeNull();
    expect(getDynamicModelMeta("claude-sonnet-4-6")).toBeNull();
  });

  it("contextLength / maxCompletionTokens を正しく格納する", () => {
    registerDynamicModelCaps([
      makeModel({
        id: "anthropic/claude-sonnet-4-6",
        contextLength: 1_000_000,
        maxCompletionTokens: 64_000,
      }),
    ]);
    const meta = getDynamicModelMeta("anthropic/claude-sonnet-4-6");
    expect(meta?.ctx).toBe(1_000_000);
    expect(meta?.out).toBe(64_000);
  });

  it("supported_parameters から tools/reasoning フラグを導出する", () => {
    registerDynamicModelCaps([
      makeModel({
        id: "anthropic/claude-sonnet-4-6",
        supportedParameters: ["tools", "reasoning"],
      }),
      makeModel({
        id: "anthropic/claude-haiku-4-5",
        supportedParameters: ["tools"],
      }),
    ]);
    const sonnet = getDynamicModelMeta("anthropic/claude-sonnet-4-6");
    expect(sonnet?.tools).toBe(true);
    expect(sonnet?.reasoning).toBe(true);
    const haiku = getDynamicModelMeta("anthropic/claude-haiku-4-5");
    expect(haiku?.reasoning).toBe(false);
  });

  it("pricing を USD/token → USD/1M に変換する", () => {
    registerDynamicModelCaps([
      makeModel({
        id: "anthropic/claude-sonnet-4-6",
        pricingPrompt: "0.000003",
        pricingCompletion: "0.000015",
      }),
    ]);
    const meta = getDynamicModelMeta("anthropic/claude-sonnet-4-6");
    expect(meta?.inPerM).toBeCloseTo(3.0);
    expect(meta?.outPerM).toBeCloseTo(15.0);
  });

  it("メタデータが全 undefined のモデルはスキップする", () => {
    registerDynamicModelCaps([
      { id: "anthropic/no-meta", name: "No Meta" }, // contextLength/maxCompletionTokens/supportedParameters 全 undefined
    ]);
    expect(getDynamicModelMeta("anthropic/no-meta")).toBeNull();
  });

  it("legacy 'openrouter/' prefix を strip して解決する", () => {
    registerDynamicModelCaps([makeModel({ id: "anthropic/claude-opus-4-6" })]);
    const meta = getDynamicModelMeta("openrouter/anthropic/claude-opus-4-6");
    expect(meta).not.toBeNull();
    expect(meta?.tools).toBe(true);
  });

  it("未登録 id は null を返す", () => {
    expect(getDynamicModelMeta("unknown/model-xyz")).toBeNull();
  });
});

describe("localStorage 永続化", () => {
  it("register 後に localStorage に書き込まれる", () => {
    registerDynamicModelCaps([makeModel({ id: "anthropic/claude-opus-4-8" })]);
    expect(store[STORAGE_KEY]).toBeDefined();
    const parsed = JSON.parse(store[STORAGE_KEY]);
    expect(parsed.version).toBe(1);
    expect(parsed.models["anthropic/claude-opus-4-8"]).toBeDefined();
  });

  it("fresh instance で localStorage から読み込む (lazy hydration)", () => {
    // 直接 localStorage に書き込む（別セッションをシミュレート）
    const data = {
      version: 1,
      fetchedAt: Date.now(),
      models: {
        "openai/gpt-4o": { tools: 1, reasoning: 0, ctx: 128_000, out: 16_384 },
      },
    };
    store[STORAGE_KEY] = JSON.stringify(data);
    // reset してから hydrate を発火させる
    __resetDynamicModelCapsForTests();
    const meta = getDynamicModelMeta("openai/gpt-4o");
    expect(meta?.ctx).toBe(128_000);
    expect(meta?.tools).toBe(true);
    expect(meta?.reasoning).toBe(false);
  });

  it("破損 JSON は黙って無視する", () => {
    store[STORAGE_KEY] = "{{broken}";
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("anthropic/claude-sonnet-4-6")).toBeNull();
  });

  it("version 不一致は黙って無視する", () => {
    const data = {
      version: 999,
      fetchedAt: Date.now(),
      models: { "anthropic/x": { tools: 1, reasoning: 1 } },
    };
    store[STORAGE_KEY] = JSON.stringify(data);
    __resetDynamicModelCapsForTests();
    expect(getDynamicModelMeta("anthropic/x")).toBeNull();
  });
});

describe("isDynamicCapsStale", () => {
  it("localStorage に何もなければ stale", () => {
    expect(isDynamicCapsStale()).toBe(true);
  });

  it("fetchedAt が TTL 以内なら fresh", () => {
    const data = { version: 1, fetchedAt: Date.now() - 1_000, models: {} };
    store[STORAGE_KEY] = JSON.stringify(data);
    expect(isDynamicCapsStale(24 * 60 * 60 * 1_000)).toBe(false);
  });

  it("fetchedAt が TTL 超過なら stale", () => {
    const data = {
      version: 1,
      fetchedAt: Date.now() - 25 * 60 * 60 * 1_000,
      models: {},
    };
    store[STORAGE_KEY] = JSON.stringify(data);
    expect(isDynamicCapsStale(24 * 60 * 60 * 1_000)).toBe(true);
  });
});

describe("__resetDynamicModelCapsForTests", () => {
  it("reset 後はレジストリが空になる（localStorage もクリアしてから確認）", () => {
    registerDynamicModelCaps([makeModel({ id: "anthropic/reset-test" })]);
    // in-memory reset + localStorage も手動クリアして hydration による再生を防ぐ
    __resetDynamicModelCapsForTests();
    localStorageMock.clear();
    expect(getDynamicModelMeta("anthropic/reset-test")).toBeNull();
  });
});
