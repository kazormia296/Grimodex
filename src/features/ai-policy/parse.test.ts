import { describe, it, expect } from "vitest";
import {
  getAiPolicyClassification,
  parseAiPolicy,
  serializeAiPolicy,
  isBodyWriteDisabled,
} from "./parse";
import { DEFAULT_AI_POLICY } from "./types";
import type { AiPolicy } from "./types";

const VALID: AiPolicy = {
  preset: "assist-off",
  toggles: {
    chat: true,
    bodyWrite: false,
    analysis: true,
    structureWrite: true,
    knowledgeWrite: true,
  },
};

describe("parseAiPolicy", () => {
  it("round-trips a valid policy", () => {
    const raw = serializeAiPolicy(VALID);
    expect(parseAiPolicy(raw)).toEqual(VALID);
  });

  it("null is missing and uses the new-project defaults", () => {
    expect(getAiPolicyClassification(null).state).toBe("missing");
    expect(parseAiPolicy(null)).toEqual({
      preset: "custom",
      toggles: {
        chat: true,
        bodyWrite: true,
        analysis: true,
        structureWrite: false,
        knowledgeWrite: false,
      },
    });
  });

  it("empty string is invalid and denies the three write axes", () => {
    expect(getAiPolicyClassification("").state).toBe("invalid");
    expect(parseAiPolicy("")).toEqual({
      preset: "custom",
      toggles: {
        chat: true,
        bodyWrite: false,
        analysis: true,
        structureWrite: false,
        knowledgeWrite: false,
      },
    });
  });

  it("non-JSON is invalid and denies the three write axes", () => {
    expect(parseAiPolicy("not-json").toggles.bodyWrite).toBe(false);
  });

  it("missing toggles is invalid and denies the three write axes", () => {
    expect(getAiPolicyClassification('{"preset":"full"}').state).toBe(
      "invalid",
    );
    expect(parseAiPolicy('{"preset":"full"}').toggles).toMatchObject({
      bodyWrite: false,
      structureWrite: false,
      knowledgeWrite: false,
    });
  });

  it("invalid preset value is invalid and denies the three write axes", () => {
    const parsed = parseAiPolicy(
      '{"preset":"unknown","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}',
    );
    expect(parsed.preset).toBe("custom");
    expect(parsed.toggles).toMatchObject({
      bodyWrite: false,
      structureWrite: false,
      knowledgeWrite: false,
    });
  });

  it("invalid required toggle types preserve readable chat/analysis but deny writes", () => {
    const raw =
      '{"preset":"full","toggles":{"chat":1,"bodyWrite":0,"analysis":""}}';
    const result = parseAiPolicy(raw);
    expect(getAiPolicyClassification(raw).state).toBe("invalid");
    expect(result.preset).toBe("custom");
    expect(result.toggles.chat).toBe(true);
    expect(result.toggles.bodyWrite).toBe(false);
    expect(result.toggles.analysis).toBe(false);
    expect(result.toggles.structureWrite).toBe(false);
    expect(result.toggles.knowledgeWrite).toBe(false);
  });
});

describe("parseAiPolicy — structureWrite backward-compat (Codex Medium-5)", () => {
  it("derives structureWrite from stored preset when the key is missing (full → true)", () => {
    const raw =
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}';
    expect(parseAiPolicy(raw).toggles.structureWrite).toBe(true);
  });

  it("derives structureWrite from stored preset when the key is missing (off → false)", () => {
    const raw =
      '{"preset":"off","toggles":{"chat":false,"bodyWrite":false,"analysis":false}}';
    expect(parseAiPolicy(raw).toggles.structureWrite).toBe(false);
  });

  it("keeps structureWrite ON for legacy assist-off (structure ≠ body write)", () => {
    const raw =
      '{"preset":"assist-off","toggles":{"chat":true,"bodyWrite":false,"analysis":true}}';
    expect(parseAiPolicy(raw).toggles.structureWrite).toBe(true);
  });

  it("respects an explicit structureWrite value over the preset default", () => {
    const raw =
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":false}}';
    expect(parseAiPolicy(raw).toggles.structureWrite).toBe(false);
  });

  it("does NOT grant structureWrite for a legacy custom policy missing the key (no fail-open on upgrade) [H1]", () => {
    // 機能前に AI を手で絞った custom policy(どの named preset にも一致しないトグル組)。
    // structureWrite が存在しなかった当時に同意は無いので、欠損は false へ倒す。
    const raw =
      '{"preset":"custom","toggles":{"chat":true,"bodyWrite":true,"analysis":false}}';
    expect(parseAiPolicy(raw).toggles.structureWrite).toBe(false);
  });

  it("custom policy with explicit structureWrite:true is honored", () => {
    const raw =
      '{"preset":"custom","toggles":{"chat":true,"bodyWrite":false,"analysis":false,"structureWrite":true}}';
    expect(parseAiPolicy(raw).toggles.structureWrite).toBe(true);
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

  it("undefined is invalid and body write is disabled", () => {
    expect(getAiPolicyClassification(undefined).state).toBe("invalid");
    expect(isBodyWriteDisabled(undefined)).toBe(true);
  });

  it("garbage is invalid and body write is disabled", () => {
    expect(isBodyWriteDisabled("not-json")).toBe(true);
  });
});

describe("parseAiPolicy — knowledgeWrite", () => {
  it("derives knowledgeWrite from stored preset when the key is missing (full → true)", () => {
    const raw =
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true}}';
    expect(parseAiPolicy(raw).toggles.knowledgeWrite).toBe(true);
  });

  it("custom policy missing knowledgeWrite → false (fail-closed)", () => {
    const raw =
      '{"preset":"custom","toggles":{"chat":true,"bodyWrite":true,"analysis":false,"structureWrite":true}}';
    expect(parseAiPolicy(raw).toggles.knowledgeWrite).toBe(false);
  });
});

describe("parseAiPolicy — new-project default (security F-6 backstop)", () => {
  // src/db/schema.ts の aiPolicy .default() と src-tauri/.../migrate.rs の SQL DEFAULT
  // と一字一句一致させること。autonomous な直接書き込み 2 軸だけ既定 OFF。
  const NEW_PROJECT_DEFAULT =
    '{"preset":"custom","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":false,"knowledgeWrite":false}}';

  it("disables knowledgeWrite and structureWrite by default", () => {
    const t = parseAiPolicy(NEW_PROJECT_DEFAULT).toggles;
    expect(t.knowledgeWrite).toBe(false);
    expect(t.structureWrite).toBe(false);
  });

  it("keeps chat / analysis / bodyWrite on (core UX preserved)", () => {
    const t = parseAiPolicy(NEW_PROJECT_DEFAULT).toggles;
    expect(t.chat).toBe(true);
    expect(t.analysis).toBe(true);
    expect(t.bodyWrite).toBe(true);
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
        toggles: {
          chat: true,
          bodyWrite: false,
          analysis: true,
          structureWrite: true,
          knowledgeWrite: true,
        },
      };
      expect(parseAiPolicy(serializeAiPolicy(policy))).toEqual(policy);
    }
  });
});
