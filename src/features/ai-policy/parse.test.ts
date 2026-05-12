import { describe, it, expect } from "vitest";
import { parseAiPolicy, serializeAiPolicy } from "./parse";
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
