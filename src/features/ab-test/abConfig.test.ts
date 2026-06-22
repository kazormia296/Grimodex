import { describe, it, expect } from "vitest";
import {
  createBaselineSlot,
  createVariantSlot,
  normalizeAbConfig,
  slotDiffersFromBaseline,
  isComparisonMeaningful,
  isSlotComplete,
  canRunComparison,
  resolveSlotApiVariant,
} from "./abConfig";

describe("createBaselineSlot", () => {
  it("is the empty default config with a stable id", () => {
    const s = createBaselineSlot();
    expect(s).toEqual({ id: "baseline", config: {}, baseline: true });
  });
});

describe("createVariantSlot", () => {
  it("seeds config and gets a non-baseline unique id", () => {
    const a = createVariantSlot({ model: "m" });
    const b = createVariantSlot();
    expect(a.baseline).toBe(false);
    expect(a.config).toEqual({ model: "m" });
    expect(b.config).toEqual({});
    expect(a.id).not.toBe("baseline");
    expect(a.id).not.toBe(b.id);
  });
});

describe("normalizeAbConfig", () => {
  it("trims and drops blank fields", () => {
    expect(
      normalizeAbConfig(
        { provider: "  openai ", model: "  gpt-x ", promptVariant: "  hi " },
        true,
      ),
    ).toEqual({ provider: "openai", model: "gpt-x", promptVariant: "hi" });
  });

  it("collapses blank-only to empty config", () => {
    expect(
      normalizeAbConfig(
        { provider: "  ", model: "", promptVariant: " " },
        true,
      ),
    ).toEqual({});
  });

  it("drops provider when allowProvider=false (inline)", () => {
    expect(
      normalizeAbConfig({ provider: "sakana", model: "fugu" }, false),
    ).toEqual({ model: "fugu" });
  });

  it("drops provider when model is empty (provider requires a model)", () => {
    expect(normalizeAbConfig({ provider: "sakana" }, true)).toEqual({});
    expect(
      normalizeAbConfig({ provider: "sakana", model: "  " }, true),
    ).toEqual({});
    // promptVariant survives even though provider is dropped.
    expect(
      normalizeAbConfig({ provider: "sakana", promptVariant: "x" }, true),
    ).toEqual({ promptVariant: "x" });
  });
});

describe("slotDiffersFromBaseline", () => {
  it("true when any field is set", () => {
    expect(slotDiffersFromBaseline({ model: "m" })).toBe(true);
    expect(slotDiffersFromBaseline({ provider: "sakana" })).toBe(true);
    expect(slotDiffersFromBaseline({ promptVariant: "x" })).toBe(true);
  });
  it("false for empty / blank-only", () => {
    expect(slotDiffersFromBaseline({})).toBe(false);
    expect(slotDiffersFromBaseline({ model: "  ", promptVariant: "" })).toBe(
      false,
    );
  });
});

describe("isComparisonMeaningful", () => {
  it("requires at least one non-baseline slot that differs", () => {
    const baseline = createBaselineSlot();
    expect(isComparisonMeaningful([baseline])).toBe(false);
    expect(isComparisonMeaningful([baseline, createVariantSlot({})])).toBe(
      false,
    );
    expect(
      isComparisonMeaningful([baseline, createVariantSlot({ model: "m" })]),
    ).toBe(true);
  });

  it("ignores the baseline even if (impossibly) it had a config", () => {
    const fakeBaseline = {
      id: "baseline",
      config: { model: "m" },
      baseline: true,
    };
    expect(isComparisonMeaningful([fakeBaseline])).toBe(false);
  });
});

describe("isSlotComplete", () => {
  it("requires a model when a provider override is set", () => {
    expect(isSlotComplete({ provider: "sakana" })).toBe(false);
    expect(isSlotComplete({ provider: "sakana", model: "fugu" })).toBe(true);
  });
  it("is complete without provider regardless of model", () => {
    expect(isSlotComplete({})).toBe(true);
    expect(isSlotComplete({ model: "m" })).toBe(true);
    expect(isSlotComplete({ promptVariant: "x" })).toBe(true);
  });
});

describe("canRunComparison", () => {
  const baseline = createBaselineSlot();
  it("false when no meaningful variant", () => {
    expect(canRunComparison([baseline, createVariantSlot({})])).toBe(false);
  });
  it("false when a variant has provider but no model", () => {
    expect(
      canRunComparison([baseline, createVariantSlot({ provider: "sakana" })]),
    ).toBe(false);
  });
  it("true when at least one complete, meaningful variant exists", () => {
    expect(
      canRunComparison([baseline, createVariantSlot({ model: "m" })]),
    ).toBe(true);
    expect(
      canRunComparison([
        baseline,
        createVariantSlot({ provider: "sakana", model: "fugu" }),
      ]),
    ).toBe(true);
  });
});

describe("resolveSlotApiVariant", () => {
  it("forces responses for sakana", () => {
    expect(resolveSlotApiVariant({ provider: "sakana" })).toBe("responses");
    expect(resolveSlotApiVariant({ provider: " sakana " })).toBe("responses");
  });
  it("leaves other providers to backend default (undefined)", () => {
    expect(resolveSlotApiVariant({ provider: "openai" })).toBeUndefined();
    expect(resolveSlotApiVariant({})).toBeUndefined();
  });
});
