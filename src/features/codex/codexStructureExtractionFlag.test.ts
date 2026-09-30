import { describe, expect, it } from "vitest";
import { isCodexStructureExtractionReviewEnabled } from "./codexStructureExtractionFlag";

describe("isCodexStructureExtractionReviewEnabled", () => {
  it("defaults to DEV when named flag is unset", () => {
    expect(isCodexStructureExtractionReviewEnabled({ DEV: true })).toBe(true);
    expect(isCodexStructureExtractionReviewEnabled({ DEV: false })).toBe(false);
  });

  it("honors VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW over DEV", () => {
    expect(
      isCodexStructureExtractionReviewEnabled({
        DEV: false,
        VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW: "true",
      }),
    ).toBe(true);
    expect(
      isCodexStructureExtractionReviewEnabled({
        DEV: true,
        VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW: "false",
      }),
    ).toBe(false);
  });
});
