import { describe, expect, it } from "vitest";
import {
  parseZenBackgroundEnabled,
  parseZenGlassConfig,
  ZEN_GLASS_DEFAULTS,
} from "./zenBackgroundAppearanceConfig";

describe("Zen background appearance config", () => {
  it("keeps lightweight defaults aligned with the live background", () => {
    expect(parseZenBackgroundEnabled({})).toBe(true);
    expect(parseZenGlassConfig({})).toEqual({
      enabled: true,
      blur: 22,
      refraction: 24,
      saturation: 1,
      shine: 1,
    });
    expect(parseZenGlassConfig({})).toEqual(ZEN_GLASS_DEFAULTS);
  });

  it("sanitizes glass settings without loading the shader catalog", () => {
    expect(
      parseZenGlassConfig({
        "editor.zenBackground.glass.enabled": "false",
        "editor.zenBackground.glass.blur": "100",
        "editor.zenBackground.glass.refraction": "-5",
        "editor.zenBackground.glass.saturation": "3",
        "editor.zenBackground.glass.shine": "invalid",
      }),
    ).toEqual({
      enabled: false,
      blur: 40,
      refraction: 0,
      saturation: 2,
      shine: 1,
    });
  });
});
