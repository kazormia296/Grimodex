import { describe, expect, it } from "vitest";
import type { ZenShaderConfig } from "./zenShaderConfig";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import {
  ZEN_MULTIPASS_DOWNSAMPLE_FRAGMENT,
  ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL,
  ZEN_MULTIPASS_GAUSSIAN_FRAGMENT,
  ZEN_MULTIPASS_MAX_GAUSSIAN_PAIRS,
  ZEN_MULTIPASS_MAX_TARGET_SIGMA,
  buildZenGaussianKernel,
  buildZenMultipassCompositeFragment,
  buildZenMultipassCompositeUniforms,
  buildZenMultipassSceneFragment,
  buildZenMultipassSceneUniforms,
  estimateZenMultipassBlurCostEnvelope,
  estimateZenMultipassBlurFetchCost,
  resolveZenMultipassBlurPlan,
  zenMultipassSurfaceCapacity,
} from "./zenMultipassPipeline";

const COST_PROBE_BLURS = [0.5, 1, 3, 5, 5.9, 6, 6.1, 7, 22, 40];
const CONTINUITY_EPSILON = 1e-6;

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
      targetWidth: 1605,
      targetHeight: 903,
      requiresDownsample: true,
      fetchBudgetMode: "bounded",
      fetchBudgetExceeded: false,
    });
    expect(blur1?.blurCssScale).toBeCloseTo(0.8359679, 6);
    expect(blur1?.sigmaInTargetPixels).toBeCloseTo(
      blur1?.blurCssScale ?? 0,
      10,
    );
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

  it("models downsample and paired-Gaussian texture fetches explicitly", () => {
    const fullResolutionSigmaSix = estimateZenMultipassBlurFetchCost({
      kernelSigmaInTargetPixels: 6,
      requiresDownsample: false,
      targetWidth: 1920,
      targetHeight: 1080,
      cssWidth: 1920,
      cssHeight: 1080,
    });
    const conservativeEnvelope = estimateZenMultipassBlurCostEnvelope({
      blurCssPx: 6,
      blurCssScale: 1,
      cssWidth: 1920,
      cssHeight: 1080,
    });
    const sameSizeWithDownsample = estimateZenMultipassBlurFetchCost({
      kernelSigmaInTargetPixels: 6,
      requiresDownsample: true,
      targetWidth: 1920,
      targetHeight: 1080,
      cssWidth: 1920,
      cssHeight: 1080,
    });

    expect(fullResolutionSigmaSix).toMatchObject({
      gaussianPairCount: 9,
      gaussianFetchesPerTargetPixel: 38,
      downsampleFetchesPerTargetPixel: 0,
      totalFetchesPerTargetPixel: 38,
      estimatedTextureFetches: 78_796_800,
      estimatedTextureFetchesPerCssPixel: 38,
    });
    expect(sameSizeWithDownsample).toMatchObject({
      gaussianPairCount: 9,
      gaussianFetchesPerTargetPixel: 38,
      downsampleFetchesPerTargetPixel: 9,
      totalFetchesPerTargetPixel: 47,
      estimatedTextureFetches: 97_459_200,
      estimatedTextureFetchesPerCssPixel: 47,
    });
    expect(conservativeEnvelope).toMatchObject({
      gaussianPairCountUpperBound: 10,
      textureFetchesPerTargetPixelUpperBound: 51,
    });
    expect(
      conservativeEnvelope.estimatedTextureFetchesPerCssPixelUpperBound,
    ).toBeGreaterThan(47);
  });

  it("keeps representative CSS blur costs within a conservative budget", () => {
    const blurValues = COST_PROBE_BLURS.filter((blur) => blur >= 1);
    const plans = blurValues.map((blur) => {
      const plan = resolveZenMultipassBlurPlan(blur, 1, 1920, 1080);
      expect(plan).not.toBeNull();
      return plan!;
    });

    expect(ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL).toBe(14);
    expect(plans[0]).toMatchObject({
      targetWidth: 1605,
      targetHeight: 903,
      requiresDownsample: true,
      fetchBudgetMode: "bounded",
      fetchBudgetExceeded: false,
    });
    for (const plan of plans) {
      expect(plan.fetchBudgetMode).toBe("bounded");
      expect(plan.estimatedTextureFetchesPerCssPixel).toBeLessThanOrEqual(
        ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL,
      );
      expect(
        plan.estimatedTextureFetchesPerCssPixelUpperBound,
      ).toBeLessThanOrEqual(ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL);
      expect(plan.estimatedTextureFetchesPerCssPixel).toBeLessThanOrEqual(
        plan.estimatedTextureFetchesPerCssPixelUpperBound,
      );
      expect(plan.estimatedTextureFetches).toBe(
        plan.targetWidth * plan.targetHeight * plan.totalFetchesPerTargetPixel,
      );
    }

    const branchPlans = [5.9, 6, 6.1].map(
      (blur) => plans[blurValues.indexOf(blur)],
    );
    const branchCosts = branchPlans.map(
      (plan) => plan.estimatedTextureFetchesPerCssPixel,
    );
    expect(Math.max(...branchCosts) - Math.min(...branchCosts)).toBeLessThan(
      0.25,
    );
    expect(branchPlans[0].blurCssScale).toBeGreaterThan(
      branchPlans[1].blurCssScale,
    );
    expect(branchPlans[1].blurCssScale).toBeGreaterThan(
      branchPlans[2].blurCssScale,
    );
    expect(
      Math.max(...branchPlans.map((plan) => plan.blurCssScale)) -
        Math.min(...branchPlans.map((plan) => plan.blurCssScale)),
    ).toBeLessThan(0.01);
  });

  it("changes scale continuously on both sides of blur 2", () => {
    const plans = [2 - CONTINUITY_EPSILON, 2, 2 + CONTINUITY_EPSILON].map(
      (blur) => {
        const plan = resolveZenMultipassBlurPlan(blur, 1, 1920, 1080);
        expect(plan).not.toBeNull();
        return plan!;
      },
    );

    expect(plans[0].blurCssScale).toBeGreaterThan(plans[1].blurCssScale);
    expect(plans[1].blurCssScale).toBeGreaterThan(plans[2].blurCssScale);
    expect(plans[0].blurCssScale - plans[2].blurCssScale).toBeLessThan(2e-6);
    expect(new Set(plans.map((plan) => plan.targetWidth))).toEqual(
      new Set([1462]),
    );
    expect(new Set(plans.map((plan) => plan.targetHeight))).toEqual(
      new Set([822]),
    );
    expect(new Set(plans.map((plan) => plan.estimatedTextureFetches))).toEqual(
      new Set([27_640_572]),
    );
    expect(
      Math.max(
        ...plans.map(
          (plan) => plan.estimatedTextureFetchesPerCssPixelUpperBound,
        ),
      ) -
        Math.min(
          ...plans.map(
            (plan) => plan.estimatedTextureFetchesPerCssPixelUpperBound,
          ),
        ),
    ).toBeLessThan(1e-10);
  });

  it("keeps every representative blur monotonic across render scales", () => {
    const renderScales = [0.5, 1, 2];
    const plansByRenderScale = renderScales.map((renderScale) => {
      const plans = COST_PROBE_BLURS.map((blur) => {
        const plan = resolveZenMultipassBlurPlan(blur, renderScale, 1920, 1080);
        expect(plan).not.toBeNull();
        if (plan!.fetchBudgetMode === "bounded") {
          expect(
            plan!.estimatedTextureFetchesPerCssPixelUpperBound,
          ).toBeLessThanOrEqual(ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL);
          expect(plan!.fetchBudgetExceeded).toBe(false);
        }
        return plan!;
      });
      return plans;
    });

    for (
      let blurIndex = 0;
      blurIndex < COST_PROBE_BLURS.length;
      blurIndex += 1
    ) {
      const plans = plansByRenderScale.map(
        (scalePlans) => scalePlans[blurIndex],
      );
      expect(plans[0].blurCssScale).toBeLessThanOrEqual(plans[1].blurCssScale);
      expect(plans[1].blurCssScale).toBeLessThanOrEqual(plans[2].blurCssScale);
      if (COST_PROBE_BLURS[blurIndex] >= 1) {
        expect(plans[1].blurCssScale).toBeCloseTo(plans[2].blurCssScale, 10);
      }
    }

    const blur22Plans = plansByRenderScale.map(
      (plans) => plans[COST_PROBE_BLURS.indexOf(22)],
    );
    for (const plan of blur22Plans) {
      expect(plan.blurCssScale).toBeCloseTo(6 / 22, 10);
      expect(plan.targetWidth).toBe(524);
      expect(plan.targetHeight).toBe(295);
      expect(plan.sigmaInTargetPixels).toBeCloseTo(6, 10);
      expect(plan.estimatedTextureFetchesPerCssPixel).toBeCloseTo(
        blur22Plans[0].estimatedTextureFetchesPerCssPixel,
        10,
      );
    }
  });

  it("keeps renderScale 1 +/- epsilon continuous for every cost probe", () => {
    const renderScales = [1 - CONTINUITY_EPSILON, 1, 1 + CONTINUITY_EPSILON];

    for (const blur of COST_PROBE_BLURS) {
      const plans = renderScales.map((renderScale) => {
        const plan = resolveZenMultipassBlurPlan(blur, renderScale, 1920, 1080);
        expect(plan).not.toBeNull();
        return plan!;
      });
      expect(plans[0].blurCssScale).toBeLessThanOrEqual(plans[1].blurCssScale);
      expect(plans[1].blurCssScale).toBeLessThanOrEqual(plans[2].blurCssScale);
      expect(plans[2].blurCssScale - plans[0].blurCssScale).toBeLessThan(3e-6);
      expect(new Set(plans.map((plan) => plan.targetWidth)).size).toBe(1);
      expect(new Set(plans.map((plan) => plan.targetHeight)).size).toBe(1);
    }
  });

  it("keeps the explicit prefilter stable across the blur 2 cost root", () => {
    const costRoot = resolveZenMultipassBlurPlan(
      2,
      2,
      1920,
      1080,
    )!.blurCssScale;
    const plans = [
      costRoot - CONTINUITY_EPSILON,
      costRoot,
      costRoot + CONTINUITY_EPSILON,
    ].map((renderScale) => {
      const plan = resolveZenMultipassBlurPlan(2, renderScale, 1920, 1080);
      expect(plan).not.toBeNull();
      return plan!;
    });

    for (const plan of plans) {
      expect(plan.usesExplicitPrefilter).toBe(true);
      expect(plan.requiresDownsample).toBe(true);
      expect(plan.resamplingVarianceInTargetPixels).toBeGreaterThan(0);
      expect(plan.fetchBudgetMode).toBe("bounded");
    }
    expect(plans[0].blurCssScale).toBeLessThan(plans[1].blurCssScale);
    expect(plans[1].blurCssScale).toBe(plans[2].blurCssScale);
    expect(
      plans[2].kernelSigmaInTargetPixels - plans[0].kernelSigmaInTargetPixels,
    ).toBeLessThan(3e-6);
    expect(new Set(plans.map((plan) => plan.targetWidth))).toEqual(
      new Set([1462]),
    );
    expect(
      new Set(plans.map((plan) => plan.estimatedTextureFetchesPerCssPixel))
        .size,
    ).toBe(1);
  });

  it("does not turn target-width quantization into a prefilter cliff", () => {
    const plans = [1919, 1920, 1922].map((cssWidth) => {
      const plan = resolveZenMultipassBlurPlan(2, 1, cssWidth, 1080);
      expect(plan).not.toBeNull();
      return plan!;
    });

    expect(plans.map((plan) => plan.targetWidth)).toEqual([1461, 1462, 1463]);
    for (const plan of plans) {
      expect(plan.usesExplicitPrefilter).toBe(true);
      expect(plan.requiresDownsample).toBe(true);
      expect(plan.gaussianPairCount).toBe(3);
    }
    expect(
      Math.max(...plans.map((plan) => plan.kernelSigmaInTargetPixels)) -
        Math.min(...plans.map((plan) => plan.kernelSigmaInTargetPixels)),
    ).toBeLessThan(1e-6);
    expect(
      Math.max(
        ...plans.map((plan) => plan.estimatedTextureFetchesPerCssPixel),
      ) -
        Math.min(
          ...plans.map((plan) => plan.estimatedTextureFetchesPerCssPixel),
        ),
    ).toBeLessThan(0.01);
  });

  it("reports the unavoidable subpixel variance floor as best effort", () => {
    const halfScale = resolveZenMultipassBlurPlan(0.5, 0.5, 1920, 1080)!;
    const fullScale = resolveZenMultipassBlurPlan(0.5, 1, 1920, 1080)!;
    const doubleScale = resolveZenMultipassBlurPlan(0.5, 2, 1920, 1080)!;

    expect(halfScale).toMatchObject({
      blurCssScale: 0.5,
      usesExplicitPrefilter: false,
      requiresDownsample: false,
      fetchBudgetMode: "best-effort-variance",
      fetchBudgetExceeded: false,
    });
    expect(fullScale).toMatchObject({
      blurCssScale: 1,
      usesExplicitPrefilter: false,
      requiresDownsample: false,
      fetchBudgetMode: "best-effort-variance",
      fetchBudgetExceeded: false,
    });
    expect(doubleScale.fetchBudgetMode).toBe("best-effort-variance");
    expect(doubleScale.fetchBudgetExceeded).toBe(true);
    expect(doubleScale.usesExplicitPrefilter).toBe(true);
    expect(doubleScale.requiresDownsample).toBe(true);
    expect(doubleScale.blurCssScale).toBeCloseTo(1.08012453, 6);
    expect(doubleScale.kernelSigmaInTargetPixels).toBeGreaterThan(0);
    expect(doubleScale.estimatedTextureFetchesPerCssPixel).toBeCloseTo(
      17.5084,
      3,
    );
    expect(
      doubleScale.estimatedTextureFetchesPerCssPixelUpperBound,
    ).toBeGreaterThan(ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL);
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
    expect(fragment).toContain("fragColor = vec4(sceneColor.rgb, 1.0)");
    expect(fragment).not.toContain("applyZenFinalContrast");
    expect(fragment).not.toContain("u_blurredTexture");
  });

  it("keeps research-only noise and quantization dither out of production shaders", () => {
    const productionShaders = [
      ZEN_MULTIPASS_DOWNSAMPLE_FRAGMENT,
      ZEN_MULTIPASS_GAUSSIAN_FRAGMENT,
      buildZenMultipassCompositeFragment(1),
    ].join("\n");

    expect(productionShaders).not.toContain("u_zenGlassNoise");
    expect(productionShaders).not.toContain("u_quantizationDither");
  });

  it("samples the blurred FBO only inside Glass before final correction", () => {
    const fragment = buildZenMultipassCompositeFragment(7);
    const main = fragment.slice(fragment.lastIndexOf("void main()"));
    const composedColorIndex = main.indexOf("vec3 composedColor = sceneColor;");
    const glassBranchIndex = main.indexOf("if (glassMask > 0.0) {");
    const blurredSampleIndex = main.indexOf(
      "texture(u_blurredTexture, refractedUv)",
    );
    const contrastIndex = main.indexOf(
      "composedColor = applyZenFinalContrast(composedColor, uiContrastMask)",
    );

    expect(fragment).toContain("u_zenUiSurfaceRects[8]");
    for (const anchor of [
      composedColorIndex,
      glassBranchIndex,
      blurredSampleIndex,
      contrastIndex,
    ]) {
      expect(anchor).toBeGreaterThanOrEqual(0);
    }
    expect(composedColorIndex).toBeLessThan(glassBranchIndex);
    expect(glassBranchIndex).toBeLessThan(blurredSampleIndex);
    expect(blurredSampleIndex).toBeLessThan(contrastIndex);
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

  it("runs only effective Paper and UI contrast branches with shared luminance", () => {
    const fragment = buildZenMultipassCompositeFragment(7);
    const contrast = fragment.slice(
      fragment.indexOf("vec3 applyZenFinalContrast("),
      fragment.indexOf("vec3 zenSaturate("),
    );
    const paperWeightIndex = contrast.indexOf("float paperWeight =");
    const uiWeightIndex = contrast.indexOf("float uiBlendWeight =");
    const linearColorIndex = contrast.indexOf(
      "vec3 linearColor = zenSrgbToLinear(",
    );
    const paperBranchIndex = contrast.indexOf("if (paperWeight > 0.0) {");
    const paperCallIndex = contrast.indexOf(
      "u_zenPaperContrastParams",
      paperBranchIndex,
    );
    const uiBranchIndex = contrast.indexOf("if (uiBlendWeight > 0.0) {");
    const uiCallIndex = contrast.indexOf(
      "u_zenUiContrastParams",
      uiBranchIndex,
    );

    expect(fragment).toContain("uniform vec4 u_zenPaperContrastParams;");
    expect(fragment).toContain("uniform vec4 u_zenUiContrastParams;");
    expect(contrast).toContain(
      "if (paperWeight <= 0.0 && uiBlendWeight <= 0.0)",
    );
    for (const anchor of [
      paperWeightIndex,
      uiWeightIndex,
      linearColorIndex,
      paperBranchIndex,
      paperCallIndex,
      uiBranchIndex,
      uiCallIndex,
    ]) {
      expect(anchor).toBeGreaterThanOrEqual(0);
    }
    expect(paperWeightIndex).toBeLessThan(linearColorIndex);
    expect(uiWeightIndex).toBeLessThan(linearColorIndex);
    expect(linearColorIndex).toBeLessThan(paperBranchIndex);
    expect(paperBranchIndex).toBeLessThan(paperCallIndex);
    expect(paperCallIndex).toBeLessThan(uiBranchIndex);
    expect(uiBranchIndex).toBeLessThan(uiCallIndex);
    expect(contrast.match(/zenSrgbToLinear\(/g)).toHaveLength(1);
  });

  it("rejects fragments outside the padded surface AABB before SDF work", () => {
    const fragment = buildZenMultipassCompositeFragment(7);
    const region = fragment.slice(
      fragment.indexOf("vec2 zenGlassRegion("),
      fragment.indexOf("void zenCollectSurfaceState("),
    );
    const rectMaxIndex = region.indexOf("vec2 rectMax = rect.zw * resolution;");
    const aabbIndex = region.indexOf("vec2 aabbPadding = vec2(2.0);");
    const aabbReturnIndex = region.indexOf("return vec2(0.0);", aabbIndex);
    const signedDistanceIndex = region.indexOf(
      "float signedDistance = zenRoundedRectSignedDistance(",
    );

    expect(region).toContain("sqrt(2)");
    expect(region).toContain(
      "lessThan(gl_FragCoord.xy, rectMin - aabbPadding)",
    );
    expect(region).toContain(
      "greaterThan(gl_FragCoord.xy, rectMax + aabbPadding)",
    );
    expect(rectMaxIndex).toBeGreaterThanOrEqual(0);
    expect(aabbIndex).toBeGreaterThanOrEqual(0);
    expect(aabbReturnIndex).toBeGreaterThanOrEqual(0);
    expect(signedDistanceIndex).toBeGreaterThanOrEqual(0);
    expect(aabbIndex).toBeGreaterThan(rectMaxIndex);
    expect(aabbReturnIndex).toBeGreaterThan(aabbIndex);
    expect(aabbReturnIndex).toBeLessThan(signedDistanceIndex);
    expect(aabbIndex).toBeLessThan(signedDistanceIndex);
  });

  it("returns exact interior surface state before rounded-rect SDF work", () => {
    const fragment = buildZenMultipassCompositeFragment(7);
    const region = fragment.slice(
      fragment.indexOf("vec2 zenGlassRegion("),
      fragment.indexOf("void zenCollectSurfaceState("),
    );
    const distanceIndex = region.indexOf(
      "vec2 distanceToAabbEdge = halfSize - abs(point);",
    );
    const requiredDepthIndex = region.indexOf(
      "float interiorRequiredDepth = 2.0;",
    );
    const glassDepthIndex = region.indexOf(
      "if (collectGlass) {",
      requiredDepthIndex,
    );
    const guardIndex = region.indexOf(
      "interiorDistance >= max(radius, interiorRequiredDepth)",
    );
    const fullMaskIndex = region.indexOf("surfaceMask = 1.0;", guardIndex);
    const zeroEdgeIndex = region.indexOf("edgeMask = 0.0;", guardIndex);
    const zeroOffsetIndex = region.indexOf("return vec2(0.0);", guardIndex);
    const signedDistanceIndex = region.indexOf(
      "float signedDistance = zenRoundedRectSignedDistance(",
    );
    const normalIndex = region.indexOf(
      "vec2 outwardNormal = zenRoundedRectOutwardNormal(",
    );

    expect(region).toContain("refractionDepth = min(");
    expect(region).toContain("interiorRequiredDepth = max(");
    for (const anchor of [
      distanceIndex,
      requiredDepthIndex,
      glassDepthIndex,
      guardIndex,
      fullMaskIndex,
      zeroEdgeIndex,
      zeroOffsetIndex,
      signedDistanceIndex,
      normalIndex,
    ]) {
      expect(anchor).toBeGreaterThanOrEqual(0);
    }
    expect(distanceIndex).toBeLessThan(requiredDepthIndex);
    expect(requiredDepthIndex).toBeLessThan(glassDepthIndex);
    expect(glassDepthIndex).toBeLessThan(guardIndex);
    expect(guardIndex).toBeLessThan(fullMaskIndex);
    expect(fullMaskIndex).toBeLessThan(signedDistanceIndex);
    expect(zeroEdgeIndex).toBeLessThan(signedDistanceIndex);
    expect(zeroOffsetIndex).toBeLessThan(signedDistanceIndex);
    expect(guardIndex).toBeLessThan(normalIndex);
  });

  it("selects mask-only surface collection before calling the region helper", () => {
    const fragment = buildZenMultipassCompositeFragment(7);
    const collector = fragment.slice(
      fragment.indexOf("void zenCollectSurfaceState("),
      fragment.indexOf("vec3 zenGuardVisibleColor("),
    );
    const editorCallIndex = collector.indexOf(
      "refractionOffset = zenGlassRegion(",
    );
    const loopIndex = collector.indexOf(
      "for (int index = 0; index < 8; index += 1)",
    );
    const candidateCallIndex = collector.indexOf(
      "vec2 candidateOffset = zenGlassRegion(",
      loopIndex,
    );
    const glassEnabledIndex = collector.indexOf("bool glassEnabled =");
    const refractsIndex = collector.indexOf("bool refracts =", loopIndex);
    const collectGlassIndex = collector.indexOf(
      "bool collectGlass =",
      loopIndex,
    );

    for (const anchor of [
      glassEnabledIndex,
      editorCallIndex,
      loopIndex,
      refractsIndex,
      collectGlassIndex,
      candidateCallIndex,
    ]) {
      expect(anchor).toBeGreaterThanOrEqual(0);
    }
    expect(glassEnabledIndex).toBeLessThan(editorCallIndex);
    expect(refractsIndex).toBeLessThan(candidateCallIndex);
    expect(collectGlassIndex).toBeLessThan(candidateCallIndex);
    expect(collector).toContain(
      "bool collectGlass = refracts && glassEnabled;",
    );
  });

  it("returns mask-only regions before edge and refraction calculations", () => {
    const fragment = buildZenMultipassCompositeFragment(7);
    const region = fragment.slice(
      fragment.indexOf("vec2 zenGlassRegion("),
      fragment.indexOf("void zenCollectSurfaceState("),
    );
    const surfaceMaskIndex = region.indexOf(
      "surfaceMask = 1.0 - smoothstep(-antialias, antialias, signedDistance);",
    );
    const maskOnlyReturnIndex = region.indexOf(
      "if (!collectGlass) return vec2(0.0);",
    );
    const edgeMaskIndex = region.indexOf("edgeMask = surfaceMask * (");
    const refractionIndex = region.indexOf("float insideDistance =");

    expect(region).toContain("bool collectGlass");
    for (const anchor of [
      surfaceMaskIndex,
      maskOnlyReturnIndex,
      edgeMaskIndex,
      refractionIndex,
    ]) {
      expect(anchor).toBeGreaterThanOrEqual(0);
    }
    expect(maskOnlyReturnIndex).toBeGreaterThan(surfaceMaskIndex);
    expect(maskOnlyReturnIndex).toBeLessThan(edgeMaskIndex);
    expect(maskOnlyReturnIndex).toBeLessThan(refractionIndex);
  });

  it("preserves visible masks while skipping disabled Glass work", () => {
    const fragment = buildZenMultipassCompositeFragment(7);
    const collector = fragment.slice(
      fragment.indexOf("void zenCollectSurfaceState("),
      fragment.indexOf("vec3 zenGuardVisibleColor("),
    );
    const skipIndex = collector.indexOf("if (!collectGlass) continue;");
    const glassUpdateIndex = collector.indexOf(
      "glassMask = max(glassMask, candidateMask);",
    );
    const contrastUpdateIndex = collector.indexOf(
      "uiContrastMask = max(uiContrastMask, visibleUiMask);",
    );

    expect(collector).toContain("glassEnabled,\n    editorMask,");
    expect(collector).toContain("collectGlass,\n      candidateMask,");
    expect(collector).toContain(
      "float visibleUiMask = refracts\n      ? candidateMask\n      : candidateMask * editorMask;",
    );
    for (const anchor of [contrastUpdateIndex, skipIndex, glassUpdateIndex]) {
      expect(anchor).toBeGreaterThanOrEqual(0);
    }
    expect(skipIndex).toBeGreaterThan(contrastUpdateIndex);
    expect(skipIndex).toBeLessThan(glassUpdateIndex);
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

  it("precomputes fixed Paper and UI contrast parameters on the CPU", () => {
    const uniforms = buildZenMultipassCompositeUniforms(
      config,
      {
        rect: [0, 0, 1, 1],
        feather: [0, 0, 0, 0],
        glassRect: [0, 0, 0, 0],
        glassCornerRadius: 0,
        textColor: [1, 1, 1],
        uiTextColor: [0, 0, 0],
        backdropColor: [1, 1, 1],
      },
      new ZenUiSurfaceUniformBuffer(1),
    );

    expect(uniforms.u_zenPaperContrastParams).toEqual([1, 0.125, 1, 0]);
    expect(uniforms.u_zenUiContrastParams).toEqual([0, 0, 0.25, 0]);
  });

  it("leaves black-white polarity ties to the WebGL shader", () => {
    const boundaryColor: [number, number, number] = [
      3 / 255,
      137 / 255,
      1 / 255,
    ];
    const uniforms = buildZenMultipassCompositeUniforms(
      config,
      {
        rect: [0, 0, 1, 1],
        feather: [0, 0, 0, 0],
        glassRect: [0, 0, 0, 0],
        glassCornerRadius: 0,
        textColor: boundaryColor,
        uiTextColor: [0, 0, 0],
        backdropColor: boundaryColor,
      },
      new ZenUiSurfaceUniformBuffer(1),
    );

    expect(uniforms.u_zenPaperContrastParams).toEqual([
      0.1791287362575531, 0, 1, 0,
    ]);
    expect(uniforms.u_zenUiContrastParams).toEqual([0, 0, 0.25, 0]);

    const fragment = buildZenMultipassCompositeFragment(1);
    expect(fragment).toContain("uniform vec3 u_zenContrastTextColor;");
    expect(fragment).toContain("uniform vec3 u_zenUiContrastTextColor;");
    expect(fragment).toContain("bool zenShouldDarken(");
    expect(fragment).toContain(
      "zenSurfaceCorrectionDirection(u_zenContrastBackdropColor)",
    );
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
