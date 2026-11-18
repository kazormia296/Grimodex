import { describe, expect, it } from "vitest";
import {
  parseAnthropicLiveCaps,
  type AnthropicEffortLevel,
  type AnthropicLiveCaps,
} from "./anthropicLiveCaps";
import { resolveModelCapabilities } from "./modelLimits";
import liveModels from "./__fixtures__/anthropic-models-2023-06-01.json";

/**
 * 段 1（観測）。Anthropic `GET /v1/models` の実応答（2026-11-18 取得、15 モデル）と、
 * 今の製品の能力解決 `resolveModelCapabilities(id, { provider: "anthropic" })` を並べ、
 * 差を「既知の差」として固定する。製品の挙動は変えない。
 *
 * fixture は `anthropic-version: 2023-06-01` の応答。`2026-10-21` の版でも data が
 * 同一（15 件、JSON の深い比較で一致）だったことは、統合者が取得時に確かめた
 * （元の 2 応答は残っていないので、ここからは再確認できない）。fixture は 1 つにしている。
 * 2023-06-01 の版でも `capabilities` は返る。
 * 応答に key は含まれない。
 *
 * 差の分類：
 * - product-decision：製品が意図して live と違う値を持つ（live に上書きさせない）。
 * - table-stale：表の誤り・古さ・欠落の仮説（製品の判断でない差の既定の分類。意図の確認は別）。段 2 で live を採ると直る。
 * - not-modeled：製品の型（ModelCapabilities）にその概念が無い。
 */

type DiffCategory = "product-decision" | "table-stale" | "not-modeled";
type ThinkingMode = "adaptive" | "budget" | "none";

interface Diff {
  field:
    | "contextWindow"
    | "maxOutput"
    | "thinkingMode"
    | "effort"
    | "maxEffort"
    | "xhigh"
    | "canDisableThinking";
  live: unknown;
  product: unknown;
  category: DiffCategory;
}

function productThinkingMode(id: string): ThinkingMode {
  const caps = resolveModelCapabilities(id, { provider: "anthropic" });
  if (caps.supportsAdaptiveThinking) return "adaptive";
  if (caps.supportsThinking) return "budget";
  return "none";
}

/** live が許す方式のうち、製品が優先する順（adaptive → budget → none）で見た方式。 */
function liveThinkingMode(live: AnthropicLiveCaps): ThinkingMode | undefined {
  const types = live.thinking?.types;
  if (types === undefined) return undefined;
  if (types.includes("adaptive")) return "adaptive";
  if (types.includes("enabled")) return "budget";
  return "none";
}

/**
 * 差の分類。ここに書いた field×model だけが「製品の判断」。それ以外の差は
 * 表の誤り・古さ（table-stale）。canDisable と xhigh は製品に概念が無い／持たない。
 */
function classify(field: Diff["field"], id: string): DiffCategory {
  if (field === "xhigh") return "product-decision"; // 製品の EffortLevel に xhigh が無い
  if (field === "canDisableThinking") return "not-modeled";
  if (field === "thinkingMode" && id === "claude-haiku-4-5-20251001") {
    return "product-decision"; // 費用と遅延が変わるので thinking は送らない（表のコメント）
  }
  return "table-stale";
}

function compare(live: AnthropicLiveCaps): Diff[] {
  const product = resolveModelCapabilities(live.id, { provider: "anthropic" });
  const diffs: Diff[] = [];
  const push = (field: Diff["field"], l: unknown, p: unknown) =>
    diffs.push({
      field,
      live: l,
      product: p,
      category: classify(field, live.id),
    });

  if (
    live.contextWindow !== undefined &&
    live.contextWindow !== product.contextWindow
  ) {
    push("contextWindow", live.contextWindow, product.contextWindow);
  }
  if (
    live.maxOutput !== undefined &&
    live.maxOutput !== product.maxOutputTokens
  ) {
    push("maxOutput", live.maxOutput, product.maxOutputTokens);
  }
  const liveMode = liveThinkingMode(live);
  const productMode = productThinkingMode(live.id);
  if (liveMode !== undefined && liveMode !== productMode) {
    push("thinkingMode", liveMode, productMode);
  }
  const levels: AnthropicEffortLevel[] | undefined =
    live.thinking?.effortLevels;
  if (levels !== undefined) {
    const liveEffort = levels.length > 0;
    if (liveEffort !== product.supportsEffort) {
      push("effort", liveEffort, product.supportsEffort);
    }
    const liveMax = levels.includes("max");
    if (liveMax !== product.supportsMaxEffort) {
      push("maxEffort", liveMax, product.supportsMaxEffort);
    }
    // 製品に xhigh を表す field は無い（EffortLevel は low／medium／high／max）。
    if (levels.includes("xhigh")) push("xhigh", true, false);
  }
  // 製品は Anthropic の thinking を「送らない」ことで OFF にする。明示 disabled の可否は持たない。
  if (live.thinking?.canDisable === false) {
    push("canDisableThinking", false, undefined);
  }
  return diffs;
}

const LIVE = (liveModels as unknown[]).map((m) => {
  const parsed = parseAnthropicLiveCaps(m);
  if (!parsed) throw new Error("fixture の model object が不正");
  return parsed;
});

/** 既知の差（live の値と今の表の値）。ここに無い差が出たら試験が落ちる。 */
const EXPECTED_DIFFS: Record<string, Diff[]> = {
  "claude-fable-5-2": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
    {
      field: "canDisableThinking",
      live: false,
      product: undefined,
      category: "not-modeled",
    },
  ],
  "claude-haiku-5-5": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
  ],
  "claude-sonnet-5-5": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
    {
      field: "canDisableThinking",
      live: false,
      product: undefined,
      category: "not-modeled",
    },
  ],
  "claude-opus-5-5": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
    {
      field: "canDisableThinking",
      live: false,
      product: undefined,
      category: "not-modeled",
    },
  ],
  "claude-fable-5-1": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
    {
      field: "canDisableThinking",
      live: false,
      product: undefined,
      category: "not-modeled",
    },
  ],
  "claude-opus-5": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
  ],
  "claude-sonnet-5": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
  ],
  "claude-fable-5": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
    {
      field: "canDisableThinking",
      live: false,
      product: undefined,
      category: "not-modeled",
    },
  ],
  "claude-opus-4-8": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
  ],
  "claude-opus-4-7": [
    {
      field: "xhigh",
      live: true,
      product: false,
      category: "product-decision",
    },
  ],
  "claude-sonnet-4-6": [
    {
      field: "maxOutput",
      live: 128_000,
      product: 64_000,
      category: "table-stale",
    },
    { field: "maxEffort", live: true, product: false, category: "table-stale" },
  ],
  "claude-opus-4-6": [],
  "claude-opus-4-5-20251101": [
    {
      field: "maxOutput",
      live: 64_000,
      product: undefined,
      category: "table-stale",
    },
    { field: "effort", live: true, product: false, category: "table-stale" },
  ],
  "claude-haiku-4-5-20251001": [
    {
      field: "thinkingMode",
      live: "budget",
      product: "none",
      category: "product-decision",
    },
  ],
  "claude-sonnet-4-5-20250929": [
    {
      field: "maxOutput",
      live: 64_000,
      product: undefined,
      category: "table-stale",
    },
  ],
};

describe("parseAnthropicLiveCaps", () => {
  it("fixture は 15 モデルで、全件が parse できる", () => {
    expect(LIVE).toHaveLength(15);
    expect(LIVE.map((m) => m.id)).toEqual(Object.keys(EXPECTED_DIFFS));
  });

  it("claude-fable-5-2: 1M/128K、adaptive のみ（disabled 不可）、effort は xhigh まで", () => {
    const m = LIVE.find((x) => x.id === "claude-fable-5-2");
    expect(m).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      imageInput: true,
      pdfInput: true,
      structuredOutputs: true,
      lifecycle: "active",
      retiresAt: undefined,
      thinking: {
        supported: true,
        types: ["adaptive"],
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        canDisable: false,
      },
    });
  });

  it("claude-sonnet-4-6: enabled／adaptive／disabled を全部返し、effort は xhigh なし", () => {
    const m = LIVE.find((x) => x.id === "claude-sonnet-4-6");
    expect(m?.thinking).toEqual({
      supported: true,
      types: ["enabled", "adaptive", "disabled"],
      effortLevels: ["low", "medium", "high", "max"],
      canDisable: true,
    });
  });

  it("effort.supported:false は『非対応』（空配列）、thinking の types は budget 方式", () => {
    const m = LIVE.find((x) => x.id === "claude-haiku-4-5-20251001");
    expect(m?.thinking).toEqual({
      supported: true,
      types: ["enabled", "disabled"],
      effortLevels: [],
      canDisable: true,
    });
  });

  it("claude-sonnet-4-5 は lifecycle が deprecated で、retires_at は 2026-11-30（15 件で唯一）", () => {
    const sonnet45 = LIVE.find((x) => x.id === "claude-sonnet-4-5-20250929");
    expect(sonnet45).toMatchObject({
      lifecycle: "deprecated",
      retiresAt: "2026-11-30T17:00:00Z",
    });
    // 残る 14 件は active で、retires_at を持たない（null は undefined に落ちる）
    const others = LIVE.filter((x) => x.id !== "claude-sonnet-4-5-20250929");
    expect(others).toHaveLength(14);
    for (const m of others) {
      expect(m.lifecycle).toBe("active");
      expect(m.retiresAt).toBeUndefined();
    }
  });

  it("deprecated_at／retires_at の生の値（parser は deprecated_at を読まないので fixture で固定する）", () => {
    // 段 1 の docs が「retires_at は全 15 件 null」と誤記した件の回帰固定。
    const raw = liveModels as unknown as Array<{
      id: string;
      lifecycle: string;
      deprecated_at: string | null;
      retires_at: string | null;
    }>;
    const withDeprecatedAt = raw.filter((m) => m.deprecated_at !== null);
    const withRetiresAt = raw.filter((m) => m.retires_at !== null);
    expect(withDeprecatedAt.map((m) => m.id)).toEqual([
      "claude-sonnet-4-5-20250929",
    ]);
    expect(withRetiresAt.map((m) => m.id)).toEqual([
      "claude-sonnet-4-5-20250929",
    ]);
    expect(withDeprecatedAt[0]).toMatchObject({
      lifecycle: "deprecated",
      deprecated_at: "2026-09-30T18:30:00Z",
      retires_at: "2026-11-30T17:00:00Z",
    });
    // 他の 14 件は lifecycle が active で、両方 null
    expect(raw.filter((m) => m.lifecycle === "active")).toHaveLength(14);
  });

  it("応答が返さない field は undefined（『非対応』の false／空配列と区別する）", () => {
    expect(parseAnthropicLiveCaps({ id: "x" })).toEqual({
      id: "x",
      displayName: undefined,
      contextWindow: undefined,
      maxOutput: undefined,
      thinking: undefined,
      imageInput: undefined,
      pdfInput: undefined,
      structuredOutputs: undefined,
      lifecycle: undefined,
      retiresAt: undefined,
    });
    // thinking だけ返し、effort も types も返さない
    const onlySupported = parseAnthropicLiveCaps({
      id: "y",
      capabilities: { thinking: { supported: true } },
    });
    expect(onlySupported?.thinking).toEqual({
      supported: true,
      types: undefined,
      effortLevels: undefined,
      canDisable: undefined,
    });
    // effort.supported が無い（形が違う）ときは「返さない」
    expect(
      parseAnthropicLiveCaps({ id: "z", capabilities: { effort: {} } })
        ?.thinking?.effortLevels,
    ).toBeUndefined();
  });

  it("型の合わない値は undefined、id の無い object は undefined", () => {
    expect(parseAnthropicLiveCaps(null)).toBeUndefined();
    expect(parseAnthropicLiveCaps([])).toBeUndefined();
    expect(parseAnthropicLiveCaps({ display_name: "x" })).toBeUndefined();
    const m = parseAnthropicLiveCaps({
      id: "w",
      max_input_tokens: "1000",
      max_tokens: -1,
      capabilities: { image_input: { supported: "yes" } },
    });
    expect(m?.contextWindow).toBeUndefined();
    expect(m?.maxOutput).toBeUndefined();
    expect(m?.imageInput).toBeUndefined();
  });
});

/**
 * 合成入力の試験：fixture の 15 件が当たらない形での「今の挙動」を固定する。
 * 方針（冒頭のコメント：応答が返さない field は undefined、`supported:false` だけが false）と
 * 合わない箇所は、直さずに現状を固定して差を明示する（docs/plans/model-capability-stage1-observation.md §8）。
 * パーサの挙動を変える（方針に寄せる）ときは、ここを意図的に書き換える。
 */
describe("parseAnthropicLiveCaps の合成入力（今の挙動の固定）", () => {
  const thinkingOf = (capabilities: unknown) =>
    parseAnthropicLiveCaps({ id: "s", capabilities })?.thinking;

  it("types があって disabled の key が無い → canDisable は false（方針どおりなら undefined）", () => {
    // 15 件の fixture は disabled を必ず明示するので、この形は当たらない。
    expect(
      thinkingOf({
        thinking: { supported: true, types: { enabled: { supported: true } } },
      }),
    ).toEqual({
      supported: true,
      types: ["enabled"],
      effortLevels: undefined,
      canDisable: false,
    });
  });

  it("disabled が形違い（supported が boolean でない／object でない）でも canDisable は false", () => {
    expect(
      thinkingOf({
        thinking: { types: { disabled: { supported: "yes" } } },
      })?.canDisable,
    ).toBe(false);
    expect(
      thinkingOf({ thinking: { types: { disabled: true } } })?.canDisable,
    ).toBe(false);
  });

  it("types が object でない（配列・文字列）なら『返さない』として types も canDisable も undefined", () => {
    for (const types of [[], "adaptive", null]) {
      expect(thinkingOf({ thinking: { supported: true, types } })).toEqual({
        supported: true,
        types: undefined,
        effortLevels: undefined,
        canDisable: undefined,
      });
    }
  });

  it("types が空 object → types は空配列、canDisable は false", () => {
    expect(thinkingOf({ thinking: { supported: true, types: {} } })).toEqual({
      supported: true,
      types: [],
      effortLevels: undefined,
      canDisable: false,
    });
  });

  it("thinking／effort がすべて supported:false → types／effortLevels は空配列、supported は false、canDisable は false", () => {
    expect(
      thinkingOf({
        thinking: {
          supported: false,
          types: {
            enabled: { supported: false },
            adaptive: { supported: false },
            disabled: { supported: false },
            between_tools: { supported: false },
          },
        },
        effort: {
          supported: false,
          low: { supported: false },
          medium: { supported: false },
          high: { supported: false },
          xhigh: { supported: false },
          max: { supported: false },
        },
      }),
    ).toEqual({
      supported: false,
      types: [],
      effortLevels: [],
      canDisable: false,
    });
  });

  it("effort.supported:true でも段階が 1 つも true でない（key が無い／全部 false）→ 空配列で、『非対応』の空配列と区別できない", () => {
    expect(thinkingOf({ effort: { supported: true } })?.effortLevels).toEqual(
      [],
    );
    expect(
      thinkingOf({
        effort: {
          supported: true,
          low: { supported: false },
          max: { supported: false },
        },
      })?.effortLevels,
    ).toEqual([]);
    // 『非対応』と同じ形（effortLevels の空配列）になる
    expect(thinkingOf({ effort: { supported: false } })?.effortLevels).toEqual(
      [],
    );
  });

  it("thinking の object が無く effort だけ返る → thinking.supported は undefined、types／canDisable も undefined", () => {
    expect(
      thinkingOf({ effort: { supported: true, high: { supported: true } } }),
    ).toEqual({
      supported: undefined,
      types: undefined,
      effortLevels: ["high"],
      canDisable: undefined,
    });
  });
});

describe("live と今の表の差（段 1 の観測。製品の挙動は変えない）", () => {
  it.each(LIVE.map((m) => [m.id, m] as const))(
    "%s の差が既知の表と一致する",
    (id, live) => {
      expect(compare(live)).toEqual(EXPECTED_DIFFS[id]);
    },
  );

  it("分類ごとの件数: product-decision 11、table-stale 5、not-modeled 5", () => {
    const all = LIVE.flatMap((m) => compare(m));
    const count = (c: DiffCategory) =>
      all.filter((d) => d.category === c).length;
    expect(count("product-decision")).toBe(11);
    expect(count("table-stale")).toBe(5);
    expect(count("not-modeled")).toBe(5);
  });

  it("live と一致している field：context は 15 件中 15 件（表と同値）", () => {
    // sonnet-4-6 の context も 1M で一致する。差が出るのは出力上限（128K 対 64K）。
    for (const live of LIVE) {
      const caps = resolveModelCapabilities(live.id, { provider: "anthropic" });
      expect(caps.contextWindow).toBe(live.contextWindow);
    }
  });

  it("claude-fable-5-2 は表に無く、同 family の最新（fable-5-1）の近似で解決される", () => {
    // 近似が live と一致する（段 2 の『表に無いモデルだけ挙動が変わる』の前提）
    const caps = resolveModelCapabilities("claude-fable-5-2", {
      provider: "anthropic",
    });
    const known = resolveModelCapabilities("claude-fable-5-1", {
      provider: "anthropic",
    });
    expect(caps).toEqual(known);
  });
});
