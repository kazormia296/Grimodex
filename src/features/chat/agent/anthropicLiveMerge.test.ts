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
