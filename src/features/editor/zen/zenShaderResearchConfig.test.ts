import { describe, expect, it } from "vitest";
import { PAPER_SHADER_IDS } from "./paperShaderCatalog";
import {
  assertZenShaderResearchRenderSize,
  buildZenShaderResearchConfig,
  resolveZenShaderResearchShaderIds,
} from "./zenShaderResearchConfig";

describe("Zen shader research configuration", () => {
  it("enumerates every catalog shader once in a seeded deterministic order", () => {
    const first = resolveZenShaderResearchShaderIds("all", 492);
    const repeated = resolveZenShaderResearchShaderIds("all", 492);
    const differentSeed = resolveZenShaderResearchShaderIds("all", 493);

    expect(first).toEqual(repeated);
    expect(first).not.toEqual(differentSeed);
    expect(first).toHaveLength(29);
    expect(new Set(first)).toEqual(new Set(PAPER_SHADER_IDS));
  });

  it("accepts one catalog id and rejects a misspelled shader before GPU setup", () => {
    expect(resolveZenShaderResearchShaderIds("spiral", 492)).toEqual([
      "spiral",
    ]);
    expect(() => resolveZenShaderResearchShaderIds("spirla", 492)).toThrow(
      /unknown|shader/i,
    );
  });

  it("resolves the fixed five-shader representative research set", () => {
    expect(resolveZenShaderResearchShaderIds("representative", 492)).toEqual([
      "halftone-cmyk",
      "halftone-dots",
      "smoke-ring",
      "gem-smoke",
      "color-panels",
    ]);
  });

  it("builds explicit non-zero Scene ablations at a fixed frame", () => {
    const config = buildZenShaderResearchConfig("spiral", {
      dither: true,
      ditherStrength: 0.45,
      halftone: true,
      halftoneStrength: 0.3,
      contrast: true,
      glass: false,
      blur: 22,
      frame: 1_000,
    });

    expect(config).toMatchObject({
      shader: "spiral",
      opacity: 100,
      speed: 0,
      dither: { enabled: true, strength: 0.45 },
      halftone: { enabled: true, strength: 0.3 },
      contrastGuard: { mode: "auto" },
      glass: { enabled: false, blur: 22 },
    });
  });

  it("rejects either render dimension when the GPU workload is not exact", () => {
    const expected = { width: 1_920, height: 1_080 };
    expect(() =>
      assertZenShaderResearchRenderSize(
        { renderWidth: 1_920, renderHeight: 1_080 },
        expected,
      ),
    ).not.toThrow();
    expect(() =>
      assertZenShaderResearchRenderSize(
        { renderWidth: 1_920, renderHeight: 1_079 },
        expected,
      ),
    ).toThrow(/1920x1079|1920x1080/i);
  });
});
