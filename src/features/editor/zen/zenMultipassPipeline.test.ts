import { describe, expect, it } from "vitest";
import type { ZenShaderConfig } from "./zenShaderConfig";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import {
  ZEN_MULTIPASS_DOWNSAMPLE_FRAGMENT,
  ZEN_MULTIPASS_GAUSSIAN_FRAGMENT,
  ZEN_MULTIPASS_MAX_GAUSSIAN_PAIRS,
  ZEN_MULTIPASS_MAX_TARGET_SIGMA,
  buildZenGaussianKernel,
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
  it("plans blur targets in CSS pixels instead of scene pixels", () => {
    expect(resolveZenMultipassBlurPlan(0, 1, 1920, 1080)).toBeNull();
    expect(resolveZenMultipassBlurPlan(-1, 1, 1920, 1080)).toBeNull();
    expect(resolveZenMultipassBlurPlan(Number.NaN, 1, 1920, 1080)).toBeNull();
    expect(resolveZenMultipassBlurPlan(22, 0, 1920, 1080)).toBeNull();
    expect(resolveZenMultipassBlurPlan(22, 1, 0, 1080)).toBeNull();

    const blur1 = resolveZenMultipassBlurPlan(1, 1, 1920, 1080);
    const blur22 = resolveZenMultipassBlurPlan(22, 1, 1920, 1080);
    const blur40 = resolveZenMultipassBlurPlan(40, 1, 1920, 1080);
    const blur40Half = resolveZenMultipassBlurPlan(40, 0.5, 1920, 1080);

    expect(ZEN_MULTIPASS_MAX_TARGET_SIGMA).toBe(6);
    expect(blur1).toMatchObject({
      blurCssScale: 1,
      targetWidth: 1920,
      targetHeight: 1080,
      sigmaInTargetPixels: 1,
      kernelSigmaInTargetPixels: 1,
    });
    expect(blur22).toMatchObject({
      targetWidth: 524,
      targetHeight: 295,
      sigmaInTargetPixels: 6,
    });
    expect(blur22?.blurCssScale).toBeCloseTo(6 / 22, 10);
    expect(blur40).toMatchObject({
      blurCssScale: 0.25,
      targetWidth: 480,
      targetHeight: 270,
      sigmaInTargetPixels: 10,
    });
    expect(blur40Half).toMatchObject({
      blurCssScale: 0.25,
      targetWidth: 480,
      targetHeight: 270,
      sigmaInTargetPixels: 10,
    });
    expect(blur40?.kernelSigmaInTargetPixels).toBeGreaterThan(0);
    expect(blur40?.kernelSigmaInTargetPixels).toBeLessThan(10);
  });

  it("changes target scale continuously across the former LOD boundary", () => {
    const plans = [21, 22, 23].map((blur) => {
      const plan = resolveZenMultipassBlurPlan(blur, 1, 1920, 1080);
      expect(plan).not.toBeNull();
      return plan!;
    });

    expect(plans.map((plan) => plan.sigmaInTargetPixels)).toEqual([6, 6, 6]);
    expect(plans[0].blurCssScale).toBeGreaterThan(plans[1].blurCssScale);
    expect(plans[1].blurCssScale).toBeGreaterThan(plans[2].blurCssScale);
    expect(plans[0].blurCssScale - plans[1].blurCssScale).toBeLessThan(0.02);
    expect(plans[1].blurCssScale - plans[2].blurCssScale).toBeLessThan(0.02);
    expect(
      Math.abs(
        plans[0].kernelSigmaInTargetPixels - plans[2].kernelSigmaInTargetPixels,
      ),
    ).toBeLessThan(0.1);
  });

  it("builds a normalized bilinear-paired Gaussian within the fixed budget", () => {
    const medium = buildZenGaussianKernel(6);
    const large = buildZenGaussianKernel(10);
    const capped = buildZenGaussianKernel(100);

    expect(ZEN_MULTIPASS_MAX_GAUSSIAN_PAIRS).toBe(16);
    expect(medium.radius).toBe(18);
    expect(medium.pairCount).toBe(9);
    expect(large.radius).toBe(30);
    expect(large.pairCount).toBe(15);
    expect(capped.radius).toBe(32);
    expect(capped.pairCount).toBe(16);

    for (const kernel of [medium, large, capped]) {
      expect(kernel.pairOffsets).toHaveLength(16);
      expect(kernel.pairWeights).toHaveLength(16);
      expect(
        kernel.centerWeight +
          2 *
            Array.from(kernel.pairWeights)
              .slice(0, kernel.pairCount)
              .reduce((sum, weight) => sum + weight, 0),
      ).toBeCloseTo(1, 6);
      for (let index = 0; index < kernel.pairCount; index += 1) {
        expect(kernel.pairWeights[index]).toBeGreaterThan(0);
        expect(kernel.pairOffsets[index]).toBeGreaterThan(index * 2 + 1);
        expect(kernel.pairOffsets[index]).toBeLessThanOrEqual(index * 2 + 2);
      }
    }
  });

  it("uses explicit downsampling and a compile-time-bounded Gaussian loop", () => {
    expect(ZEN_MULTIPASS_DOWNSAMPLE_FRAGMENT).toContain(
      "uniform vec2 u_sourceTexelSize",
    );
    expect(ZEN_MULTIPASS_DOWNSAMPLE_FRAGMENT).toContain(
      "uniform vec2 u_sourceToTargetScale",
    );
    expect(ZEN_MULTIPASS_DOWNSAMPLE_FRAGMENT).not.toContain("textureLod");
    expect(ZEN_MULTIPASS_GAUSSIAN_FRAGMENT).toContain(
      "uniform float u_centerWeight",
    );
    expect(ZEN_MULTIPASS_GAUSSIAN_FRAGMENT).toContain(
      "uniform float u_pairOffsets[16]",
    );
    expect(ZEN_MULTIPASS_GAUSSIAN_FRAGMENT).toContain(
      "uniform float u_pairWeights[16]",
    );
    expect(ZEN_MULTIPASS_GAUSSIAN_FRAGMENT).toContain(
      "uniform int u_pairCount",
    );
    expect(ZEN_MULTIPASS_GAUSSIAN_FRAGMENT).toMatch(
      /for\s*\(int\s+index\s*=\s*0;\s*index\s*<\s*16;/,
    );
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
