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

describe("Zen shader settings", () => {
  it("offers a focused set of five Paper shader backgrounds", () => {
    expect(ZEN_SHADER_IDS).toEqual([
      "mesh-gradient",
      "grain-gradient",
      "neuro-noise",
      "warp",
      "static-mesh-gradient",
    ]);
    expect(ZEN_SHADER_DEFAULTS.shader).toBe("mesh-gradient");
    expect(ZEN_SHADER_DEFAULTS.paletteMode).toBe("theme");
  });

  it("normalizes malformed persisted values into safe shader ranges", () => {
    const config = parseZenShaderConfig({
      "editor.zenBackground.shader": "unknown",
      "editor.zenBackground.paletteMode": "invalid",
      "editor.zenBackground.opacity": "300",
      "editor.zenBackground.speed": "-2",
      "editor.zenBackground.scale": "NaN",
      "editor.zenBackground.rotation": "721",
      "editor.zenBackground.offsetX": "-9",
      "editor.zenBackground.offsetY": "9",
      "editor.zenBackground.grain.shape": "bad-shape",
      "editor.zenBackground.warp.shape": "bad-shape",
      "editor.zenBackground.warp.swirlIterations": "99",
      "editor.zenBackground.dither.levels": "1",
      "editor.zenBackground.dither.size": "99",
      "editor.zenBackground.halftone.angle": "-20",
      "editor.zenBackground.halftone.size": "100",
    });

    expect(config.shader).toBe("mesh-gradient");
    expect(config.paletteMode).toBe("theme");
    expect(config.opacity).toBe(40);
    expect(config.speed).toBe(0);
    expect(config.scale).toBe(ZEN_SHADER_DEFAULTS.scale);
    expect(config.rotation).toBe(360);
    expect(config.offsetX).toBe(-1);
    expect(config.offsetY).toBe(1);
    expect(config.grain.shape).toBe("corners");
    expect(config.warp.shape).toBe("edge");
    expect(config.warp.swirlIterations).toBe(20);
    expect(config.dither.levels).toBe(2);
    expect(config.dither.size).toBe(8);
    expect(config.halftone.angle).toBe(0);
    expect(config.halftone.size).toBe(24);
  });

  it("maps common and shader-specific Paper props without leaking other variants", () => {
    const base = parseZenShaderConfig({
      "editor.zenBackground.speed": "0.12",
      "editor.zenBackground.scale": "1.4",
      "editor.zenBackground.rotation": "20",
      "editor.zenBackground.offsetX": "0.2",
      "editor.zenBackground.offsetY": "-0.3",
      "editor.zenBackground.mesh.distortion": "0.65",
      "editor.zenBackground.mesh.swirl": "0.25",
    });

    expect(buildZenShaderProps(base, palette)).toMatchObject({
      speed: 0.12,
      scale: 1.4,
      rotation: 20,
      offsetX: 0.2,
      offsetY: -0.3,
      colors: palette.colors,
      distortion: 0.65,
      swirl: 0.25,
      fit: "cover",
      minPixelRatio: 1,
    });
    expect(buildZenShaderProps(base, palette)).not.toHaveProperty("shape");

    const grain = parseZenShaderConfig({
      "editor.zenBackground.shader": "grain-gradient",
      "editor.zenBackground.grain.shape": "ripple",
      "editor.zenBackground.grain.softness": "0.8",
      "editor.zenBackground.grain.intensity": "0.45",
      "editor.zenBackground.grain.noise": "0.15",
    });
    expect(buildZenShaderProps(grain, palette)).toMatchObject({
      colorBack: palette.background,
      shape: "ripple",
      softness: 0.8,
      intensity: 0.45,
      noise: 0.15,
    });

    const neuro = parseZenShaderConfig({
      "editor.zenBackground.shader": "neuro-noise",
      "editor.zenBackground.neuro.brightness": "0.22",
      "editor.zenBackground.neuro.contrast": "0.4",
    });
    expect(buildZenShaderProps(neuro, palette)).toMatchObject({
      colorBack: palette.background,
      colorMid: palette.colors[0],
      colorFront: palette.colors[1],
      brightness: 0.22,
      contrast: 0.4,
    });

    const warp = parseZenShaderConfig({
      "editor.zenBackground.shader": "warp",
      "editor.zenBackground.warp.shape": "stripes",
      "editor.zenBackground.warp.swirlIterations": "7",
    });
    expect(buildZenShaderProps(warp, palette)).toMatchObject({
      shape: "stripes",
      swirlIterations: 7,
    });

    const staticMesh = parseZenShaderConfig({
      "editor.zenBackground.shader": "static-mesh-gradient",
      "editor.zenBackground.staticMesh.positions": "40",
      "editor.zenBackground.staticMesh.waveX": "0.6",
    });
    const staticProps = buildZenShaderProps(staticMesh, palette);
    expect(staticProps).toMatchObject({ positions: 40, waveX: 0.6 });
    expect(staticProps).not.toHaveProperty("speed");
  });

  it("uses custom colors only when custom palette mode is selected", () => {
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
