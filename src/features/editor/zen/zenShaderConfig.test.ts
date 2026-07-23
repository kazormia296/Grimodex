import { describe, expect, it } from "vitest";
import {
  ZEN_SHADER_DEFAULTS,
  ZEN_SHADER_IDS,
  buildZenShaderProps,
  parseZenShaderConfig,
  type ZenResolvedPalette,
} from "./zenShaderConfig";

const palette: ZenResolvedPalette = {
  background: "#101318",
  colors: ["#8fb4d6", "#d6b5a5", "#786fa6", "#d8c47c"],
};

describe("editor background shader settings", () => {
  it("offers every Paper shader background", () => {
    expect(ZEN_SHADER_IDS).toEqual([
      "color-panels",
      "dithering",
      "dot-grid",
      "dot-orbit",
      "fluted-glass",
      "gem-smoke",
      "god-rays",
      "grain-gradient",
      "halftone-cmyk",
      "halftone-dots",
      "heatmap",
      "image-dithering",
      "liquid-metal",
      "mesh-gradient",
      "metaballs",
      "neuro-noise",
      "paper-texture",
      "perlin-noise",
      "pulsing-border",
      "simplex-noise",
      "smoke-ring",
      "spiral",
      "static-mesh-gradient",
      "static-radial-gradient",
      "swirl",
      "voronoi",
      "warp",
      "water",
      "waves",
    ]);
    expect(ZEN_SHADER_DEFAULTS.enabled).toBe(true);
    expect(ZEN_SHADER_DEFAULTS.shader).toBe("mesh-gradient");
    expect(ZEN_SHADER_DEFAULTS).not.toHaveProperty("paperOpacity");
    expect(ZEN_SHADER_DEFAULTS).not.toHaveProperty("paperEdgeFade");
    expect(ZEN_SHADER_DEFAULTS.contrastGuard).toEqual({
      mode: "auto",
      strength: 1,
      toolMix: 0.3,
    });
    expect(ZEN_SHADER_DEFAULTS.glass).toEqual({
      enabled: true,
      blur: 14,
      refraction: 7,
      saturation: 1.16,
      shine: 1,
    });
  });

  it("uses complete 0-100 percent domains for intensity and speed", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.opacity": "300",
      "editor.zenBackground.speedPercent": "300",
      "editor.zenBackground.paperOpacity": "-5",
      "editor.zenBackground.paperEdgeFade": "30",
      "editor.zenBackground.contrastGuard.mode": "invalid",
      "editor.zenBackground.contrastGuard.strength": "3",
      "editor.zenBackground.contrastGuard.toolMix": "0.44",
    });

    expect(config.opacity).toBe(100);
    expect(config.speed).toBe(100);
    expect(config).not.toHaveProperty("paperOpacity");
    expect(config).not.toHaveProperty("paperEdgeFade");
    expect(config.contrastGuard).toEqual({
      mode: "auto",
      strength: 1,
      toolMix: 0.44,
    });
  });

  it("migrates the old fractional speed setting to a percentage", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.speed": "0.08",
    });

    expect(config.speed).toBe(8);
  });

  it("normalizes malformed persisted values into safe shader ranges", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.enabled": "false",
      "editor.zenBackground.shader": "unknown",
      "editor.zenBackground.paletteMode": "invalid",
      "editor.zenBackground.scale": "NaN",
      "editor.zenBackground.rotation": "721",
      "editor.zenBackground.offsetX": "-9",
      "editor.zenBackground.offsetY": "9",
      "editor.zenBackground.shaderProps": "not-json",
      "editor.zenBackground.dither.levels": "1",
      "editor.zenBackground.halftone.size": "100",
      "editor.zenBackground.contrastGuard.toolMix": "9",
      "editor.zenBackground.glass.enabled": "invalid",
      "editor.zenBackground.glass.blur": "100",
      "editor.zenBackground.glass.refraction": "-5",
      "editor.zenBackground.glass.saturation": "3",
      "editor.zenBackground.glass.shine": "-1",
    });

    expect(config.enabled).toBe(false);
    expect(config.shader).toBe("mesh-gradient");
    expect(config.paletteMode).toBe("theme");
    expect(config.scale).toBe(ZEN_SHADER_DEFAULTS.scale);
    expect(config.rotation).toBe(360);
    expect(config.offsetX).toBe(-1);
    expect(config.offsetY).toBe(1);
    expect(config.shaderProps).toEqual({});
    expect(config.dither.levels).toBe(2);
    expect(config.halftone.size).toBe(24);
    expect(config.contrastGuard.toolMix).toBe(0.5);
    expect(config.glass).toEqual({
      enabled: true,
      blur: 40,
      refraction: 0,
      saturation: 2,
      shine: 0,
    });
  });

  it("keeps the tool contrast mix in its bounded adjustable range", () => {
    expect(parseZenShaderConfig({}).contrastGuard.toolMix).toBe(0.3);
    expect(
      parseZenShaderConfig({
        "editor.zenBackground.contrastGuard.toolMix": "-1",
      }).contrastGuard.toolMix,
    ).toBe(0);
    expect(
      parseZenShaderConfig({
        "editor.zenBackground.contrastGuard.toolMix": "0.47",
      }).contrastGuard.toolMix,
    ).toBe(0.47);
    expect(
      parseZenShaderConfig({
        "editor.zenBackground.contrastGuard.toolMix": "invalid",
      }).contrastGuard.toolMix,
    ).toBe(0.3);
  });

  it("maps common and selected shader props to the official Paper prop names", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.shader": "dot-grid",
      "editor.zenBackground.speedPercent": "37",
      "editor.zenBackground.scale": "1.4",
      "editor.zenBackground.shaderProps": JSON.stringify({
        "dot-grid": {
          size: 42,
          gapX: 80,
          shape: "triangle",
          sizeRange: 0.25,
        },
      }),
    });

    expect(buildZenShaderProps(config, palette)).toMatchObject({
      speed: 0.37,
      fit: "cover",
      scale: 1.4,
      colorBack: palette.background,
      colorFill: palette.colors[0],
      size: 42,
      gapX: 80,
      shape: "triangle",
      sizeRange: 0.25,
    });
  });

  it("uses custom colors only in custom palette mode", () => {
    const custom = parseZenShaderConfig({
      "editor.zenBackground.paletteMode": "custom",
      "editor.zenBackground.color1": "#112233",
      "editor.zenBackground.color2": "#445566",
      "editor.zenBackground.color3": "not-a-color",
      "editor.zenBackground.color4": "#abcdef",
      "editor.zenBackground.colorBack": "#010203",
    });

    expect(buildZenShaderProps(custom, palette)).toMatchObject({
      colors: ["#112233", "#445566", "#786fa6", "#abcdef"],
    });
  });
});
