import { describe, it, expect } from "vitest";
import { META_STRUCTURE_PROMPT_VERSION } from "./metaStructurePayloadBuilder";
import { getPromptCatalog } from "@/prompts/index";

describe("meta_structure prompt contract", () => {
  it("version は v1.1 以降", () => {
    expect(META_STRUCTURE_PROMPT_VERSION).toBe("meta_structure_v1.1");
  });
  for (const lang of ["ja", "en"] as const) {
    it(`${lang}: plot_structure に tension 0-1 必須を明記`, () => {
      const sys = getPromptCatalog(lang).postEffect.metaStructureSystem;
      expect(sys).toMatch(/tension/);
      expect(sys).toMatch(/0\.0.*1\.0|0-1|0–1/);
      expect(sys).toMatch(/MUST|must|必ず/);
    });
  }
});
