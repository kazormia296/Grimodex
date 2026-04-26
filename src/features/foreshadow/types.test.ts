import { describe, it, expect } from "vitest";
import { safeParseAiEvaluation } from "./types";

describe("safeParseAiEvaluation", () => {
  it("returns null for null input", () => {
    expect(safeParseAiEvaluation(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(safeParseAiEvaluation("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(safeParseAiEvaluation("not json")).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    expect(safeParseAiEvaluation('{"careful": {}}')).toBeNull();
  });

  it("returns null for plain string (Phase 1 legacy data)", () => {
    expect(safeParseAiEvaluation("このsetupは伏線として機能します")).toBeNull();
  });

  it("parses a valid AiEvaluation object", () => {
    const evaluation = {
      careful: { strength: "subtle", reasoning: "精読者なら気づく" },
      casual: { strength: "moderate", reasoning: "普通の読者も気づく" },
      skim: { strength: "overt", reasoning: "流し読みでも分かる" },
    };
    const result = safeParseAiEvaluation(JSON.stringify(evaluation));
    expect(result).toEqual(evaluation);
  });

  it("returns null when any persona is missing", () => {
    const partial = {
      careful: { strength: "subtle", reasoning: "ok" },
      casual: { strength: "moderate", reasoning: "ok" },
      // skim is missing
    };
    expect(safeParseAiEvaluation(JSON.stringify(partial))).toBeNull();
  });

  it("returns null when strength is invalid", () => {
    const invalid = {
      careful: { strength: "unknown", reasoning: "ok" },
      casual: { strength: "moderate", reasoning: "ok" },
      skim: { strength: "overt", reasoning: "ok" },
    };
    expect(safeParseAiEvaluation(JSON.stringify(invalid))).toBeNull();
  });
});
