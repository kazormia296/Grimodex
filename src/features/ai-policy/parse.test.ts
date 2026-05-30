import { describe, it, expect } from "vitest";
import { parseAiPolicy, serializeAiPolicy, isBodyWriteDisabled } from "./parse";
import { DEFAULT_AI_POLICY } from "./types";
import type { AiPolicy } from "./types";

const VALID: AiPolicy = {
  preset: "assist-off",
  toggles: { chat: true, bodyWrite: false, analysis: true },
};

describe("parseAiPolicy", () => {
  it("round-trips a valid policy", () => {
    const raw = serializeAiPolicy(VALID);
    expect(parseAiPolicy(raw)).toEqual(VALID);
  });

  it("null → DEFAULT_AI_POLICY", () => {
    expect(parseAiPolicy(null)).toEqual(DEFAULT_AI_POLICY);
  });

  it("empty string → DEFAULT_AI_POLICY", () => {
    expect(parseAiPolicy("")).toEqual(DEFAULT_AI_POLICY);
  });

  it("non-JSON → DEFAULT_AI_POLICY", () => {
    expect(parseAiPolicy("not-json")).toEqual(DEFAULT_AI_POLICY);
  });

  it("missing toggles → DEFAULT_AI_POLICY", () => {
    expect(parseAiPolicy('{"preset":"full"}')).toEqual(DEFAULT_AI_POLICY);
  });

  it("invalid preset value → DEFAULT_AI_POLICY", () => {
    expect(
      parseAiPolicy(
        '{"preset":"unknown","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}',
      ),
    ).toEqual(DEFAULT_AI_POLICY);
  });

  it("non-boolean toggle values are coerced", () => {
    const raw =
      '{"preset":"full","toggles":{"chat":1,"bodyWrite":0,"analysis":""}}';
    const result = parseAiPolicy(raw);
    expect(result.toggles.chat).toBe(true);
    expect(result.toggles.bodyWrite).toBe(false);
    expect(result.toggles.analysis).toBe(false);
  });
});

describe("isBodyWriteDisabled", () => {
  const raw = (toggles: Partial<AiPolicy["toggles"]>, preset = "custom") =>
    JSON.stringify({
      preset,
      toggles: { chat: true, bodyWrite: true, analysis: true, ...toggles },
    });

  it("assist-off (bodyWrite:false) → true", () => {
    expect(isBodyWriteDisabled(raw({ bodyWrite: false }, "assist-off"))).toBe(
      true,
    );
  });

  it("full (bodyWrite:true) → false", () => {
    expect(isBodyWriteDisabled(raw({ bodyWrite: true }, "full"))).toBe(false);
  });

  it("off preset (bodyWrite:false) → true", () => {
    expect(
      isBodyWriteDisabled(
        JSON.stringify({
          preset: "off",
          toggles: { chat: false, bodyWrite: false, analysis: false },
        }),
      ),
    ).toBe(true);
  });

  it("null → false (defaults to full / bodyWrite enabled)", () => {
    expect(isBodyWriteDisabled(null)).toBe(false);
  });

  it("undefined → false", () => {
    expect(isBodyWriteDisabled(undefined)).toBe(false);
  });

  it("garbage → false (fail-open to DEFAULT_AI_POLICY)", () => {
    expect(isBodyWriteDisabled("not-json")).toBe(false);
  });
});

describe("serializeAiPolicy", () => {
  it("produces parseable JSON", () => {
    const raw = serializeAiPolicy(DEFAULT_AI_POLICY);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("round-trips all presets", () => {
    const presets = [
      "full",
      "assist-off",
      "review-only",
      "off",
      "custom",
    ] as const;
    for (const preset of presets) {
      const policy: AiPolicy = {
        preset,
        toggles: { chat: true, bodyWrite: false, analysis: true },
      };
      expect(parseAiPolicy(serializeAiPolicy(policy))).toEqual(policy);
    }
  });
});
