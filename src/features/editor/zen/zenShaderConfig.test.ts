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
    expect(ZEN_SHADER_DEFAULTS.shader).toBe("mesh-gradient");
  });

  it("uses complete 0-100 percent domains for intensity, speed and paper opacity", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.opacity": "300",
      "editor.zenBackground.speedPercent": "300",
      "editor.zenBackground.paperOpacity": "-5",
    });

    expect(config.opacity).toBe(100);
    expect(config.speed).toBe(100);
    expect(config.paperOpacity).toBe(0);
  });

  it("migrates the old fractional speed setting to a percentage", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.speed": "0.08",
    });

    expect(config.speed).toBe(8);
  });

  it("normalizes malformed persisted values into safe shader ranges", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.shader": "unknown",
      "editor.zenBackground.paletteMode": "invalid",
      "editor.zenBackground.scale": "NaN",
      "editor.zenBackground.rotation": "721",
      "editor.zenBackground.offsetX": "-9",
      "editor.zenBackground.offsetY": "9",
      "editor.zenBackground.shaderProps": "not-json",
      "editor.zenBackground.dither.levels": "1",
      "editor.zenBackground.halftone.size": "100",
    });

    expect(config.shader).toBe("mesh-gradient");
    expect(config.paletteMode).toBe("theme");
    expect(config.scale).toBe(ZEN_SHADER_DEFAULTS.scale);
    expect(config.rotation).toBe(360);
    expect(config.offsetX).toBe(-1);
    expect(config.offsetY).toBe(1);
    expect(config.shaderProps).toEqual({});
    expect(config.dither.levels).toBe(2);
    expect(config.halftone.size).toBe(24);
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
