import { describe, expect, it } from "vitest";
import type { ZenShaderConfig } from "./zenShaderConfig";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import {
  ZEN_MULTIPASS_BLUR_ITERATIONS,
  ZEN_MULTIPASS_BLUR_KERNEL_SIGMA,
  ZEN_MULTIPASS_MAX_SAMPLE_STEP,
  ZEN_MULTIPASS_BLUR_FRAGMENT,
  buildZenMultipassCompositeFragment,
  buildZenMultipassCompositeUniforms,
  buildZenMultipassSceneFragment,
  buildZenMultipassSceneUniforms,
  resolveZenMultipassBlurPlan,
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
  it("maps CSS blur radius to an anti-lattice mip and sample step", () => {
    expect(resolveZenMultipassBlurPlan(0, 1)).toBeNull();
    expect(resolveZenMultipassBlurPlan(-1, 1)).toBeNull();
    expect(resolveZenMultipassBlurPlan(Number.NaN, 1)).toBeNull();
    expect(resolveZenMultipassBlurPlan(Number.POSITIVE_INFINITY, 1)).toBeNull();
    expect(resolveZenMultipassBlurPlan(22, 0)).toBeNull();
    expect(resolveZenMultipassBlurPlan(22, -1)).toBeNull();
    expect(resolveZenMultipassBlurPlan(22, Number.NaN)).toBeNull();
    expect(
      resolveZenMultipassBlurPlan(22, Number.POSITIVE_INFINITY),
    ).toBeNull();

    const cases = [
      { blur: 1, renderScale: 1, lod: 0, targetScale: 1 },
      { blur: 22, renderScale: 1, lod: 3, targetScale: 1 / 8 },
      { blur: 22, renderScale: 0.5, lod: 2, targetScale: 1 / 4 },
      { blur: 40, renderScale: 1, lod: 4, targetScale: 1 / 16 },
    ] as const;

    for (const testCase of cases) {
      const plan = resolveZenMultipassBlurPlan(
        testCase.blur,
        testCase.renderScale,
      );
      expect(plan).not.toBeNull();
      expect(plan?.sourceLod).toBe(testCase.lod);
      expect(plan?.targetScale).toBe(testCase.targetScale);
      expect(plan?.sampleStep).toBeLessThanOrEqual(
        ZEN_MULTIPASS_MAX_SAMPLE_STEP + Number.EPSILON,
      );
      const reconstructedCssBlur =
        ((plan?.sampleStep ?? 0) *
          ZEN_MULTIPASS_BLUR_KERNEL_SIGMA *
          Math.sqrt(ZEN_MULTIPASS_BLUR_ITERATIONS)) /
        (testCase.targetScale * testCase.renderScale);
      expect(reconstructedCssBlur).toBeCloseTo(testCase.blur, 10);
    }
  });

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
    expect(ZEN_MULTIPASS_BLUR_FRAGMENT).toContain("textureLod");
    expect(ZEN_MULTIPASS_BLUR_FRAGMENT).toContain("u_sourceLod");
    expect(
      fragment.indexOf("texture(u_blurredTexture, refractedUv)"),
    ).toBeLessThan(fragment.indexOf("vec3 composedColor = mix("));
    expect(fragment.indexOf("vec3 composedColor = mix(")).toBeLessThan(
      fragment.indexOf(
        "composedColor = applyZenFinalContrast(composedColor, uiContrastMask)",
      ),
    );
    expect(fragment).toContain(
      "float paperMask = clamp(zenContrastColumnMask(), 0.0, 1.0)",
    );
    expect(fragment).toContain("float currentContrast =");
    expect(fragment).toContain("currentContrast >= u_zenContrastTarget &&");
    expect(fragment).toContain("return visibleColor;");
    expect(fragment).toContain(
      "vec3 applyZenFinalContrast(vec3 composedColor, float uiMask)",
    );
    expect(fragment).toContain("vec3 visibleColor = mix(");
    expect(fragment).toContain(
      "float paperWeight = paperMask * (1.0 - uiWeight)",
    );
    expect(fragment).not.toContain(
      "guardedVisible - u_zenContrastBackdropColor",
    );
    expect(fragment).toContain("maximumBackground * maximumBackground /");
    expect(fragment).toContain("safeDistanceToWhite * safeDistanceToWhite");
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
