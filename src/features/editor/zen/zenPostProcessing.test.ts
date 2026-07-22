import { describe, expect, it } from "vitest";
import {
  buildZenPostProcessUniforms,
  buildZenPostProcessedFragment,
} from "./zenPostProcessing";
import { parseZenShaderConfig } from "./zenShaderConfig";

const PAPER_FRAGMENT = `#version 300 es
precision mediump float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.2, 0.4, 0.8, 1.0);
}`;

describe("Zen shader post-processing", () => {
  it("keeps Paper's GLSL version header and wraps its output in one final main", () => {
    const combined = buildZenPostProcessedFragment(PAPER_FRAGMENT);

    expect(combined.startsWith("#version 300 es")).toBe(true);
    expect(combined).toContain("void paperShaderMain()");
    expect(combined).toContain("uniform float u_zenDitherStrength");
    expect(combined).toContain("uniform float u_zenHalftoneStrength");
    expect(combined).toContain("applyZenDither");
    expect(combined).toContain("applyZenColorHalftone");
    expect(combined.match(/void main\s*\(\s*\)/g)).toHaveLength(1);
    expect(combined.indexOf("paperShaderMain();")).toBeLessThan(
      combined.indexOf("applyZenDither"),
    );
  });

  it("rejects an incompatible fragment instead of silently rendering blank", () => {
    expect(() =>
      buildZenPostProcessedFragment("#version 300 es\nout vec4 fragColor;"),
    ).toThrow(/main/i);
  });

  it("converts enabled filter controls to shader uniforms and zeros disabled effects", () => {
    const enabled = parseZenShaderConfig({
      "editor.zenBackground.dither.enabled": "true",
      "editor.zenBackground.dither.strength": "0.45",
      "editor.zenBackground.dither.size": "3",
      "editor.zenBackground.dither.levels": "5",
      "editor.zenBackground.halftone.enabled": "true",
      "editor.zenBackground.halftone.strength": "0.3",
      "editor.zenBackground.halftone.size": "11",
      "editor.zenBackground.halftone.angle": "17",
      "editor.zenBackground.halftone.softness": "0.2",
    });

    expect(buildZenPostProcessUniforms(enabled)).toEqual({
      u_zenDitherStrength: 0.45,
      u_zenDitherSize: 3,
      u_zenDitherLevels: 5,
      u_zenHalftoneStrength: 0.3,
      u_zenHalftoneSize: 11,
      u_zenHalftoneAngle: 17,
      u_zenHalftoneSoftness: 0.2,
    });

    const disabled = parseZenShaderConfig({});
    expect(buildZenPostProcessUniforms(disabled)).toMatchObject({
      u_zenDitherStrength: 0,
      u_zenHalftoneStrength: 0,
    });
  });
});
