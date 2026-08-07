import { describe, expect, it } from "vitest";
import type { ZenShaderConfig } from "./zenShaderConfig";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import {
  buildZenMultipassCompositeFragment,
  buildZenMultipassCompositeUniforms,
  buildZenMultipassSceneFragment,
  buildZenMultipassSceneUniforms,
  zenMultipassSurfaceCapacity,
} from "./zenMultipassPipeline";

const config = {
  opacity: 72,
  dither: {
    enabled: true,
    strength: 0.35,
    size: 2,
    levels: 8,
  },
  halftone: {
    enabled: true,
    strength: 0.2,
    size: 7,
    angle: 35,
    softness: 0.15,
  },
  glass: {
    enabled: true,
    blur: 18,
    saturation: 1.25,
    refraction: 9,
    shine: 0.4,
  },
  contrastGuard: {
    mode: "auto",
    strength: 0.6,
    toolMix: 0.75,
  },
} as ZenShaderConfig;

// Runtime pixels are covered separately; this suite fixes the shader-stage contract.
describe("Zen multipass pipeline", () => {
  it("keeps Scene effects before Glass and contrast work", () => {
    const fragment = buildZenMultipassSceneFragment(`#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(0.25); }`);

    expect(fragment).toContain("void paperShaderMain()");
    expect(fragment).toContain("applyZenDither(sceneColor.rgb)");
    expect(fragment).toContain("applyZenColorHalftone(sceneColor.rgb)");
    expect(fragment).not.toContain("applyZenFinalContrast");
    expect(fragment).not.toContain("u_blurredTexture");
  });

  it("samples the blurred FBO before applying the shared final correction", () => {
    const fragment = buildZenMultipassCompositeFragment(7);

    expect(fragment).toContain("u_zenUiSurfaceRects[8]");
    expect(
      fragment.indexOf("texture(u_blurredTexture, refractedUv)"),
    ).toBeLessThan(fragment.indexOf("vec3 composedColor = mix("));
    expect(fragment.indexOf("vec3 composedColor = mix(")).toBeLessThan(
      fragment.indexOf(
        "composedColor = applyZenFinalContrast(composedColor, uiContrastMask)",
      ),
    );
    expect(fragment).toContain("float paperMask = zenContrastColumnMask()");
    expect(fragment).toContain(
      "vec3 applyZenFinalContrast(vec3 composedColor, float uiMask)",
    );
  });

  it("feeds one packed surface set to Glass and tool contrast", () => {
    const buffer = new ZenUiSurfaceUniformBuffer(4);
    const uniforms = buildZenMultipassCompositeUniforms(
      config,
      {
        rect: [0.2, 0.2, 0.8, 0.8],
        feather: [0.05, 0.05, 0.05, 0.05],
        glassRect: [0.1, 0.1, 0.9, 0.9],
        glassCornerRadius: 16,
        uiSurfaces: [
          {
            rect: [0.05, 0.05, 0.25, 0.2],
            feather: [0, 0, 0, 0],
            cornerRadius: 10,
            refracts: true,
          },
        ],
        textColor: [0.9, 0.9, 0.9],
        uiTextColor: [0.1, 0.1, 0.1],
        backdropColor: [0.03, 0.04, 0.05],
      },
      buffer,
    );

    expect(uniforms.u_zenGlassEnabled).toBe(1);
    expect(uniforms.u_zenGlassBlur).toBe(18);
    expect(uniforms.u_zenGlassSaturation).toBe(1.25);
    expect(uniforms.u_zenGlassShine).toBe(0.4);
    expect(uniforms.u_zenUiSurfaceCount).toBe(1);
    expect(uniforms["u_zenUiSurfaceRects[0]"]).toBeInstanceOf(Float32Array);
    expect(uniforms["u_zenUiSurfaceParams[0]"]).toBeInstanceOf(Float32Array);
  });

  it("uses bounded high-water shader variants", () => {
    expect(zenMultipassSurfaceCapacity(0)).toBe(1);
    expect(zenMultipassSurfaceCapacity(5)).toBe(8);
    expect(zenMultipassSurfaceCapacity(33)).toBe(32);
  });

  it("builds only Scene-stage effect uniforms", () => {
    expect(buildZenMultipassSceneUniforms(config)).toEqual({
      u_zenDitherStrength: 0.35,
      u_zenDitherSize: 2,
      u_zenDitherLevels: 8,
      u_zenHalftoneStrength: 0.2,
      u_zenHalftoneSize: 7,
      u_zenHalftoneAngle: 35,
      u_zenHalftoneSoftness: 0.15,
    });
  });
});
