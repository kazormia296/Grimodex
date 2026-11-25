import { describe, expect, it } from "vitest";
import { isCodexStructureExtractionReviewEnabled } from "./codexStructureExtractionFlag";

describe("isCodexStructureExtractionReviewEnabled", () => {
  it("is open by default, in a product build and in DEV alike", () => {
    expect(isCodexStructureExtractionReviewEnabled({ DEV: true })).toBe(true);
    expect(isCodexStructureExtractionReviewEnabled({ DEV: false })).toBe(true);
    expect(isCodexStructureExtractionReviewEnabled({})).toBe(true);
  });

  it("honors VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW over the default", () => {
    for (const closed of ["false", "0", false]) {
      for (const dev of [true, false]) {
        expect(
          isCodexStructureExtractionReviewEnabled({
            DEV: dev,
            VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW: closed,
          }),
        ).toBe(false);
      }
    }
    for (const open of ["true", "1", true]) {
      expect(
        isCodexStructureExtractionReviewEnabled({
          DEV: false,
          VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW: open,
        }),
      ).toBe(true);
    }
  });
});
