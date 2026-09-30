import { describe, expect, it } from "vitest";
import {
  ZEN_SHADER_DEFAULTS,
  ZEN_SHADER_IDS,
  buildZenShaderProps,
  parseZenShaderConfig,
  resolveZenShaderAnimationSpeed,
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
    expect(ZEN_SHADER_DEFAULTS.shader).toBe("liquid-metal");
    expect(ZEN_SHADER_DEFAULTS.opacity).toBe(100);
    expect(ZEN_SHADER_DEFAULTS.speed).toBe(3);
    expect(ZEN_SHADER_DEFAULTS.speedMode).toBe("fast");
    expect(ZEN_SHADER_DEFAULTS.resolutionMode).toBe("balanced");
    expect(ZEN_SHADER_DEFAULTS.scale).toBe(1.7);
    expect(ZEN_SHADER_DEFAULTS.rotation).toBe(170);
    expect(ZEN_SHADER_DEFAULTS.offsetX).toBe(0.25);
    expect(ZEN_SHADER_DEFAULTS.offsetY).toBe(0.05);
    expect(ZEN_SHADER_DEFAULTS.customColors).toEqual([
      "#111827",
      "#111827",
      "#111827",
      "#111827",
    ]);
    expect(ZEN_SHADER_DEFAULTS.customColorBack).toBe("#111827");
    expect(ZEN_SHADER_DEFAULTS.shaderProps).toMatchObject({
      "liquid-metal": {
        shiftRed: 0.79,
        repetition: 2,
        contour: 0.6,
        softness: 0,
        shape: "circle",
        shiftBlue: 0.52,
      },
    });
    expect(ZEN_SHADER_DEFAULTS).not.toHaveProperty("paperOpacity");
    expect(ZEN_SHADER_DEFAULTS).not.toHaveProperty("paperEdgeFade");
    expect(ZEN_SHADER_DEFAULTS.contrastGuard).toEqual({
      mode: "auto",
      strength: 0.1,
      toolMix: 0.75,
    });
    expect(ZEN_SHADER_DEFAULTS.glass).toEqual({
      enabled: true,
      blur: 22,
      refraction: 24,
      saturation: 1,
      shine: 1,
    });
  });

  it("uses complete 0-100 percent domains for intensity and speed", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.opacity": "300",
      "editor.zenBackground.speedPercent": "300",
      "editor.zenBackground.speedMode": "slow",
      "editor.zenBackground.resolutionMode": "performance",
      "editor.zenBackground.paperOpacity": "-5",
      "editor.zenBackground.paperEdgeFade": "30",
      "editor.zenBackground.contrastGuard.mode": "invalid",
      "editor.zenBackground.contrastGuard.strength": "3",
      "editor.zenBackground.contrastGuard.toolMix": "0.68",
    });

    expect(config.opacity).toBe(100);
    expect(config.speed).toBe(100);
    expect(config.speedMode).toBe("slow");
    expect(config.resolutionMode).toBe("performance");
    expect(config).not.toHaveProperty("paperOpacity");
    expect(config).not.toHaveProperty("paperEdgeFade");
    expect(config.contrastGuard).toEqual({
      mode: "auto",
      strength: 1,
      toolMix: 0.68,
    });
  });

  it("migrates the old fractional speed setting to a percentage", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.speed": "0.08",
    });

    expect(config.speed).toBe(8);
  });

  it("keeps zero paused and exposes a ten-times slower speed range", () => {
    expect(resolveZenShaderAnimationSpeed(0, "fast")).toBe(0);
    expect(resolveZenShaderAnimationSpeed(0, "slow")).toBe(0);
    expect(resolveZenShaderAnimationSpeed(2, "fast")).toBeCloseTo(0.118);
    expect(resolveZenShaderAnimationSpeed(2, "slow")).toBeCloseTo(0.0118);
    expect(resolveZenShaderAnimationSpeed(100, "fast")).toBe(1);
    expect(resolveZenShaderAnimationSpeed(100, "slow")).toBeCloseTo(0.1);
  });

  it("falls back to Fast for an invalid persisted speed mode", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.speedPercent": "37",
      "editor.zenBackground.speedMode": "turbo",
    });

    expect(config.speed).toBe(37);
    expect(config.speedMode).toBe("fast");
  });

  it("normalizes malformed persisted values into safe shader ranges", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.enabled": "false",
      "editor.zenBackground.shader": "unknown",
      "editor.zenBackground.paletteMode": "invalid",
      "editor.zenBackground.resolutionMode": "ultra",
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
    expect(config.shader).toBe("liquid-metal");
    expect(config.paletteMode).toBe("theme");
    expect(config.speedMode).toBe("fast");
    expect(config.resolutionMode).toBe("balanced");
    expect(config.scale).toBe(ZEN_SHADER_DEFAULTS.scale);
    expect(config.rotation).toBe(360);
    expect(config.offsetX).toBe(-1);
    expect(config.offsetY).toBe(1);
    expect(config.shaderProps).toEqual({});
    expect(config.dither.levels).toBe(2);
    expect(config.halftone.size).toBe(24);
    expect(config.contrastGuard.toolMix).toBe(0.75);
    expect(config.glass).toEqual({
      enabled: true,
      blur: 40,
      refraction: 0,
      saturation: 2,
      shine: 0,
    });
  });

  it("keeps the tool contrast mix in its bounded adjustable range", () => {
    expect(parseZenShaderConfig({}).contrastGuard.toolMix).toBe(0.75);
    expect(
      parseZenShaderConfig({
        "editor.zenBackground.contrastGuard.toolMix": "-1",
      }).contrastGuard.toolMix,
    ).toBe(0);
    expect(
      parseZenShaderConfig({
        "editor.zenBackground.contrastGuard.toolMix": "0.7",
      }).contrastGuard.toolMix,
    ).toBe(0.7);
    expect(
      parseZenShaderConfig({
        "editor.zenBackground.contrastGuard.toolMix": "invalid",
      }).contrastGuard.toolMix,
    ).toBe(0.75);
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
      speed: resolveZenShaderAnimationSpeed(37),
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

  it("leaves the live render resolution policy to ZenShaderSurface", () => {
    const props = buildZenShaderProps(ZEN_SHADER_DEFAULTS, palette);

    expect(props).not.toHaveProperty("minPixelRatio");
    expect(props).not.toHaveProperty("maxPixelCount");
  });

  it("uses custom colors only in custom palette mode", () => {
    const custom = parseZenShaderConfig({
      "editor.zenBackground.shader": "mesh-gradient",
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
