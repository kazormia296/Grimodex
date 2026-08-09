import type { ZenShaderConfig } from "./zenShaderConfig";
import {
  buildZenPostProcessUniforms,
  type ZenPostProcessRuntime,
} from "./zenPostProcessing";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";

export const ZEN_MULTIPASS_MAX_TARGET_SIGMA = 6;
export const ZEN_MULTIPASS_MAX_GAUSSIAN_PAIRS = 16;
// This is below twice the legacy 7.5-fetch full-resolution-equivalent cost.
// The planner applies it to a continuous upper envelope rather than the
// discrete shader pair count, so crossing a pair or resize boundary cannot
// force the target resolution to jump.
export const ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL = 14;

const ZEN_MULTIPASS_MIN_CSS_SCALE = 0.25;
const ZEN_MULTIPASS_DOWNSAMPLE_FETCHES_PER_TARGET_PIXEL = 9;
const ZEN_MULTIPASS_COST_SEARCH_ITERATIONS = 48;
const ZEN_MULTIPASS_VARIANCE_EPSILON = 1e-6;
// A 3x3 tent sampled at +/- half a target pixel contributes 3/24 per-axis
// variance. Linear reconstruction contributes another 4/24.
const ZEN_MULTIPASS_RESAMPLING_VARIANCE = 7 / 24;

export interface ZenMultipassBlurFetchCost {
  gaussianPairCount: number;
  gaussianFetchesPerTargetPixel: number;
  downsampleFetchesPerTargetPixel: number;
  totalFetchesPerTargetPixel: number;
  estimatedTextureFetches: number;
  estimatedTextureFetchesPerCssPixel: number;
}

export interface ZenMultipassBlurFetchCostInput {
  kernelSigmaInTargetPixels: number;
  requiresDownsample: boolean;
  targetWidth: number;
  targetHeight: number;
  cssWidth: number;
  cssHeight: number;
}

export interface ZenMultipassBlurCostEnvelope {
  gaussianPairCountUpperBound: number;
  textureFetchesPerTargetPixelUpperBound: number;
  estimatedTextureFetchesPerCssPixelUpperBound: number;
}

export interface ZenMultipassBlurCostEnvelopeInput {
  blurCssPx: number;
  blurCssScale: number;
  cssWidth: number;
  cssHeight: number;
}

export type ZenMultipassBlurBudgetMode = "bounded" | "best-effort-variance";

export interface ZenMultipassBlurPlan extends ZenMultipassBlurFetchCost {
  blurCssScale: number;
  targetWidth: number;
  targetHeight: number;
  sigmaInTargetPixels: number;
  kernelSigmaInTargetPixels: number;
  resamplingVarianceInTargetPixels: number;
  usesExplicitPrefilter: boolean;
  requiresDownsample: boolean;
  gaussianPairCountUpperBound: number;
  textureFetchesPerTargetPixelUpperBound: number;
  estimatedTextureFetchesPerCssPixelUpperBound: number;
  fetchBudgetMode: ZenMultipassBlurBudgetMode;
  fetchBudgetExceeded: boolean;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function resolveZenGaussianRadius(sigmaInTargetPixels: number) {
  if (!Number.isFinite(sigmaInTargetPixels) || sigmaInTargetPixels <= 0) {
    return 0;
  }
  return Math.min(
    Math.ceil(sigmaInTargetPixels * 3),
    ZEN_MULTIPASS_MAX_GAUSSIAN_PAIRS * 2,
  );
}

function resolveZenGaussianPairCount(sigmaInTargetPixels: number) {
  return Math.ceil(resolveZenGaussianRadius(sigmaInTargetPixels) / 2);
}

export function estimateZenMultipassBlurFetchCost({
  kernelSigmaInTargetPixels,
  requiresDownsample,
  targetWidth,
  targetHeight,
  cssWidth,
  cssHeight,
}: ZenMultipassBlurFetchCostInput) {
  const gaussianPairCount = resolveZenGaussianPairCount(
    kernelSigmaInTargetPixels,
  );
  // Each Gaussian pass reads its center and both sides of every bilinear pair.
  const gaussianFetchesPerTargetPixel = 2 * (1 + gaussianPairCount * 2);
  const downsampleFetchesPerTargetPixel = requiresDownsample
    ? ZEN_MULTIPASS_DOWNSAMPLE_FETCHES_PER_TARGET_PIXEL
    : 0;
  const totalFetchesPerTargetPixel =
    gaussianFetchesPerTargetPixel + downsampleFetchesPerTargetPixel;
  const targetPixelCount = targetWidth * targetHeight;
  const cssPixelCount = cssWidth * cssHeight;
  const estimatedTextureFetches = targetPixelCount * totalFetchesPerTargetPixel;

  return {
    gaussianPairCount,
    gaussianFetchesPerTargetPixel,
    downsampleFetchesPerTargetPixel,
    totalFetchesPerTargetPixel,
    estimatedTextureFetches,
    estimatedTextureFetchesPerCssPixel:
      cssPixelCount > 0 ? estimatedTextureFetches / cssPixelCount : 0,
  } satisfies ZenMultipassBlurFetchCost;
}

export function estimateZenMultipassBlurCostEnvelope({
  blurCssPx,
  blurCssScale,
  cssWidth,
  cssHeight,
}: ZenMultipassBlurCostEnvelopeInput) {
  const sigmaInTargetPixels = blurCssPx * blurCssScale;
  // pairCount = ceil(1.5 * kernelSigma). Since kernelSigma never exceeds the
  // requested target sigma, 1 + 1.5 * targetSigma continuously bounds the
  // discrete pair count. The cap meets that line continuously at sigma 10.
  const gaussianPairCountUpperBound = Math.min(
    ZEN_MULTIPASS_MAX_GAUSSIAN_PAIRS,
    1 + 1.5 * sigmaInTargetPixels,
  );
  // Reserve the nine-tap prefilter independently of renderScale. A plan that
  // lands exactly on the scene resolution therefore uses the same envelope
  // as one infinitesimally below it, avoiding a planner discontinuity when the
  // real pass switches on.
  const textureFetchesPerTargetPixelUpperBound =
    ZEN_MULTIPASS_DOWNSAMPLE_FETCHES_PER_TARGET_PIXEL +
    2 * (1 + gaussianPairCountUpperBound * 2);
  // round(cssSize * scale) is no greater than cssSize * scale + 0.5. Using
  // that continuous upper bound keeps the budget conservative without making
  // target-size rounding part of the scale-selection rule.
  const targetWidthUpperBound = Math.max(1, cssWidth * blurCssScale + 0.5);
  const targetHeightUpperBound = Math.max(1, cssHeight * blurCssScale + 0.5);
  const cssPixelCount = cssWidth * cssHeight;
  const estimatedTextureFetchesPerCssPixelUpperBound =
    cssPixelCount > 0
      ? (targetWidthUpperBound *
          targetHeightUpperBound *
          textureFetchesPerTargetPixelUpperBound) /
        cssPixelCount
      : 0;

  return {
    gaussianPairCountUpperBound,
    textureFetchesPerTargetPixelUpperBound,
    estimatedTextureFetchesPerCssPixelUpperBound,
  } satisfies ZenMultipassBlurCostEnvelope;
}

function buildZenMultipassBlurPlanAtScale(
  blurCssPx: number,
  cssWidth: number,
  cssHeight: number,
  blurCssScale: number,
  fetchBudgetMode: ZenMultipassBlurBudgetMode,
  usesExplicitPrefilter: boolean,
) {
  const requiresDownsample = usesExplicitPrefilter;
  const sigmaInTargetPixels = blurCssPx * blurCssScale;
  const resamplingVarianceInTargetPixels = requiresDownsample
    ? ZEN_MULTIPASS_RESAMPLING_VARIANCE
    : 0;
  const kernelVariance =
    sigmaInTargetPixels * sigmaInTargetPixels -
    resamplingVarianceInTargetPixels;
  if (kernelVariance <= 0) return null;

  const targetWidth = Math.max(1, Math.round(cssWidth * blurCssScale));
  const targetHeight = Math.max(1, Math.round(cssHeight * blurCssScale));
  const kernelSigmaInTargetPixels = Math.sqrt(kernelVariance);
  const fetchCost = estimateZenMultipassBlurFetchCost({
    kernelSigmaInTargetPixels,
    requiresDownsample,
    targetWidth,
    targetHeight,
    cssWidth,
    cssHeight,
  });

  return {
    blurCssScale,
    targetWidth,
    targetHeight,
    sigmaInTargetPixels,
    kernelSigmaInTargetPixels,
    resamplingVarianceInTargetPixels,
    usesExplicitPrefilter,
    requiresDownsample,
    ...fetchCost,
    ...estimateZenMultipassBlurCostEnvelope({
      blurCssPx,
      blurCssScale,
      cssWidth,
      cssHeight,
    }),
    fetchBudgetMode,
    fetchBudgetExceeded:
      fetchCost.estimatedTextureFetchesPerCssPixel >
      ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL,
  } satisfies ZenMultipassBlurPlan;
}

function resolveZenMultipassBudgetScale(
  blurCssPx: number,
  cssWidth: number,
  cssHeight: number,
  minCssScale: number,
  preferredCssScale: number,
) {
  const preferredEnvelope = estimateZenMultipassBlurCostEnvelope({
    blurCssPx,
    blurCssScale: preferredCssScale,
    cssWidth,
    cssHeight,
  });
  if (
    preferredEnvelope.estimatedTextureFetchesPerCssPixelUpperBound <=
    ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL
  ) {
    return {
      blurCssScale: preferredCssScale,
      fetchBudgetMode: "bounded",
    } satisfies {
      blurCssScale: number;
      fetchBudgetMode: ZenMultipassBlurBudgetMode;
    };
  }

  const zeroScaleEnvelope = estimateZenMultipassBlurCostEnvelope({
    blurCssPx,
    blurCssScale: 0,
    cssWidth,
    cssHeight,
  });
  if (
    zeroScaleEnvelope.estimatedTextureFetchesPerCssPixelUpperBound >
    ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL
  ) {
    return {
      blurCssScale: minCssScale,
      fetchBudgetMode: "best-effort-variance",
    } satisfies {
      blurCssScale: number;
      fetchBudgetMode: ZenMultipassBlurBudgetMode;
    };
  }

  // The envelope is continuous and monotonic in scale, unlike the actual
  // rounded target size and integer Gaussian pair count. Searching it cannot
  // move those implementation steps into a target-resolution cliff. Use the
  // same [0, 1] bracket for every renderScale so floating-point convergence is
  // also independent of which side of a renderScale boundary requested it.
  let affordableScale = 0;
  let expensiveScale = 1;
  for (
    let iteration = 0;
    iteration < ZEN_MULTIPASS_COST_SEARCH_ITERATIONS;
    iteration += 1
  ) {
    const candidateScale = (affordableScale + expensiveScale) * 0.5;
    const candidateEnvelope = estimateZenMultipassBlurCostEnvelope({
      blurCssPx,
      blurCssScale: candidateScale,
      cssWidth,
      cssHeight,
    });
    if (
      candidateEnvelope.estimatedTextureFetchesPerCssPixelUpperBound <=
      ZEN_MULTIPASS_FETCH_BUDGET_PER_CSS_PIXEL
    ) {
      affordableScale = candidateScale;
    } else {
      expensiveScale = candidateScale;
    }
  }

  if (affordableScale < minCssScale) {
    return {
      blurCssScale: minCssScale,
      fetchBudgetMode: "best-effort-variance",
    } satisfies {
      blurCssScale: number;
      fetchBudgetMode: ZenMultipassBlurBudgetMode;
    };
  }

  return {
    blurCssScale: Math.min(preferredCssScale, affordableScale),
    fetchBudgetMode: "bounded",
  } satisfies {
    blurCssScale: number;
    fetchBudgetMode: ZenMultipassBlurBudgetMode;
  };
}

export function resolveZenMultipassBlurPlan(
  blurCssPx: number,
  renderScale: number,
  cssWidth: number,
  cssHeight: number,
) {
  if (
    !Number.isFinite(blurCssPx) ||
    !Number.isFinite(renderScale) ||
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    blurCssPx <= 0 ||
    renderScale <= 0 ||
    cssWidth <= 0 ||
    cssHeight <= 0
  ) {
    return null;
  }

  const maxAvailableCssScale = Math.min(1, renderScale);
  const minCssScale = Math.min(
    ZEN_MULTIPASS_MIN_CSS_SCALE,
    maxAvailableCssScale,
  );
  const preferredCssScale = clamp(
    ZEN_MULTIPASS_MAX_TARGET_SIGMA / blurCssPx,
    minCssScale,
    maxAvailableCssScale,
  );
  const budgetScale = resolveZenMultipassBudgetScale(
    blurCssPx,
    cssWidth,
    cssHeight,
    minCssScale,
    preferredCssScale,
  );
  const budgetedPlan = buildZenMultipassBlurPlanAtScale(
    blurCssPx,
    cssWidth,
    cssHeight,
    budgetScale.blurCssScale,
    budgetScale.fetchBudgetMode,
    true,
  );
  if (budgetedPlan) return budgetedPlan;

  // Below this scale the fixed prefilter contributes more variance than the
  // requested blur. Approach the variance boundary from above when the scene
  // has enough resolution; otherwise follow renderScale exactly. Both choices
  // meet continuously where resampling first becomes feasible. They are
  // explicitly best-effort because the quality floor can exceed the fetch
  // budget (for example 0.5 CSS px at renderScale 2).
  const varianceFloorScale =
    Math.sqrt(ZEN_MULTIPASS_RESAMPLING_VARIANCE) / blurCssPx;
  const usesExplicitPrefilter = varianceFloorScale < renderScale;
  const bestEffortScale = usesExplicitPrefilter
    ? varianceFloorScale +
      Math.min(
        varianceFloorScale * ZEN_MULTIPASS_VARIANCE_EPSILON,
        (renderScale - varianceFloorScale) * 0.5,
      )
    : renderScale;
  return buildZenMultipassBlurPlanAtScale(
    blurCssPx,
    cssWidth,
    cssHeight,
    bestEffortScale,
    "best-effort-variance",
    usesExplicitPrefilter,
  );
}

export interface ZenGaussianKernel {
  centerWeight: number;
  pairOffsets: Float32Array;
  pairWeights: Float32Array;
  pairCount: number;
  radius: number;
}

export function buildZenGaussianKernel(sigmaInTargetPixels: number) {
  const pairOffsets = new Float32Array(ZEN_MULTIPASS_MAX_GAUSSIAN_PAIRS);
  const pairWeights = new Float32Array(ZEN_MULTIPASS_MAX_GAUSSIAN_PAIRS);
  if (!Number.isFinite(sigmaInTargetPixels) || sigmaInTargetPixels <= 0) {
    return {
      centerWeight: 1,
      pairOffsets,
      pairWeights,
      pairCount: 0,
      radius: 0,
    } satisfies ZenGaussianKernel;
  }

  const radius = resolveZenGaussianRadius(sigmaInTargetPixels);
  const unnormalizedWeights = Array.from({ length: radius + 1 }, (_, index) =>
    Math.exp(
      -(index * index) / (2 * sigmaInTargetPixels * sigmaInTargetPixels),
    ),
  );
  const normalization =
    unnormalizedWeights[0] +
    2 * unnormalizedWeights.slice(1).reduce((sum, weight) => sum + weight, 0);
  const centerWeight = unnormalizedWeights[0] / normalization;
  const pairCount = Math.ceil(radius / 2);

  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const firstOffset = pairIndex * 2 + 1;
    const secondOffset = firstOffset + 1;
    const firstWeight = unnormalizedWeights[firstOffset] / normalization;
    const secondWeight =
      (unnormalizedWeights[secondOffset] ?? 0) / normalization;
    const pairWeight = firstWeight + secondWeight;
    pairOffsets[pairIndex] =
      pairWeight > 0
        ? (firstOffset * firstWeight + secondOffset * secondWeight) / pairWeight
        : firstOffset;
    pairWeights[pairIndex] = pairWeight;
  }

  return {
    centerWeight,
    pairOffsets,
    pairWeights,
    pairCount,
    radius,
  } satisfies ZenGaussianKernel;
}

const MAIN_PATTERN = /void\s+main\s*\(\s*\)/;

const ZEN_SCENE_EFFECTS = String.raw`
uniform float u_zenDitherStrength;
uniform float u_zenDitherSize;
uniform float u_zenDitherLevels;
uniform float u_zenHalftoneStrength;
uniform float u_zenHalftoneSize;
uniform float u_zenHalftoneAngle;
uniform float u_zenHalftoneSoftness;

float zenBayer4(vec2 pixel) {
  ivec2 p = ivec2(mod(floor(pixel), 4.0));
  int index = 0;
  if (p.y == 0) {
    index = p.x == 0 ? 0 : (p.x == 1 ? 8 : (p.x == 2 ? 2 : 10));
  } else if (p.y == 1) {
    index = p.x == 0 ? 12 : (p.x == 1 ? 4 : (p.x == 2 ? 14 : 6));
  } else if (p.y == 2) {
    index = p.x == 0 ? 3 : (p.x == 1 ? 11 : (p.x == 2 ? 1 : 9));
  } else {
    index = p.x == 0 ? 15 : (p.x == 1 ? 7 : (p.x == 2 ? 13 : 5));
  }
  return (float(index) + 0.5) / 16.0;
}

vec3 applyZenDither(vec3 color) {
  if (u_zenDitherStrength <= 0.00001) return color;
  float levels = max(2.0, u_zenDitherLevels);
  float threshold = zenBayer4(gl_FragCoord.xy / max(1.0, u_zenDitherSize)) - 0.5;
  vec3 quantized = floor(color * (levels - 1.0) + threshold + 0.5) / (levels - 1.0);
  return mix(color, clamp(quantized, 0.0, 1.0), u_zenDitherStrength);
}

mat2 zenRotation(float degrees) {
  float angle = radians(degrees);
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

float zenHalftoneInk(float amount, float angle) {
  float cellSize = max(3.0, u_zenHalftoneSize);
  vec2 cell = fract((zenRotation(angle) * gl_FragCoord.xy) / cellSize) - 0.5;
  float distanceToCenter = length(cell);
  float radius = 0.66 * sqrt(clamp(amount, 0.0, 1.0));
  float antialias = max(fwidth(distanceToCenter), 0.01);
  float softness = antialias + u_zenHalftoneSoftness * 0.12;
  float dot = 1.0 - smoothstep(radius - softness, radius + softness, distanceToCenter);
  return dot * smoothstep(0.0, 0.02, amount);
}

vec3 applyZenColorHalftone(vec3 color) {
  if (u_zenHalftoneStrength <= 0.00001) return color;
  float key = 1.0 - max(max(color.r, color.g), color.b);
  vec3 cmy = (vec3(1.0) - color - key) / max(1.0 - key, 0.001);
  float cyan = zenHalftoneInk(cmy.r, u_zenHalftoneAngle + 15.0);
  float magenta = zenHalftoneInk(cmy.g, u_zenHalftoneAngle + 75.0);
  float yellow = zenHalftoneInk(cmy.b, u_zenHalftoneAngle);
  float black = zenHalftoneInk(key, u_zenHalftoneAngle + 45.0);
  vec3 screened = vec3(
    (1.0 - cyan) * (1.0 - black),
    (1.0 - magenta) * (1.0 - black),
    (1.0 - yellow) * (1.0 - black)
  );
  return mix(color, screened, u_zenHalftoneStrength);
}

void main() {
  paperShaderMain();
  vec4 sceneColor = fragColor;
  sceneColor.rgb = applyZenDither(sceneColor.rgb);
  sceneColor.rgb = applyZenColorHalftone(sceneColor.rgb);
  fragColor = sceneColor;
}
`;

export function buildZenMultipassSceneFragment(fragment: string) {
  if (!MAIN_PATTERN.test(fragment)) {
    throw new Error("Paper shader fragment has no compatible main function");
  }
  return `${fragment.replace(MAIN_PATTERN, "void paperShaderMain()")}\n// Scene pass: Paper, Dither and Halftone only.\n${ZEN_SCENE_EFFECTS}`;
}

export function buildZenMultipassSceneUniforms(config: ZenShaderConfig) {
  return {
    u_zenDitherStrength: config.dither.enabled ? config.dither.strength : 0,
    u_zenDitherSize: config.dither.size,
    u_zenDitherLevels: config.dither.levels,
    u_zenHalftoneStrength: config.halftone.enabled
      ? config.halftone.strength
      : 0,
    u_zenHalftoneSize: config.halftone.size,
    u_zenHalftoneAngle: config.halftone.angle,
    u_zenHalftoneSoftness: config.halftone.softness,
  };
}

export const ZEN_MULTIPASS_FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const ZEN_MULTIPASS_DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sourceTexture;
uniform vec2 u_sourceTexelSize;
uniform vec2 u_sourceToTargetScale;
void main() {
  // A separable 3x3 tent sampled at +/- half of the source footprint. The
  // symmetric nine taps preserve rotational balance during arbitrary resize.
  vec2 halfFootprint =
    u_sourceTexelSize * u_sourceToTargetScale * 0.5;
  vec4 color = texture(u_sourceTexture, v_uv) * 0.25;
  color += texture(u_sourceTexture, v_uv + vec2(halfFootprint.x, 0.0)) * 0.125;
  color += texture(u_sourceTexture, v_uv - vec2(halfFootprint.x, 0.0)) * 0.125;
  color += texture(u_sourceTexture, v_uv + vec2(0.0, halfFootprint.y)) * 0.125;
  color += texture(u_sourceTexture, v_uv - vec2(0.0, halfFootprint.y)) * 0.125;
  color += texture(u_sourceTexture, v_uv + halfFootprint) * 0.0625;
  color += texture(u_sourceTexture, v_uv - halfFootprint) * 0.0625;
  color += texture(
    u_sourceTexture,
    v_uv + vec2(halfFootprint.x, -halfFootprint.y)
  ) * 0.0625;
  color += texture(
    u_sourceTexture,
    v_uv + vec2(-halfFootprint.x, halfFootprint.y)
  ) * 0.0625;
  fragColor = color;
}`;

export const ZEN_MULTIPASS_GAUSSIAN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sourceTexture;
uniform vec2 u_blurDirection;
uniform float u_centerWeight;
uniform float u_pairOffsets[16];
uniform float u_pairWeights[16];
uniform int u_pairCount;
void main() {
  vec4 color = texture(u_sourceTexture, v_uv) * u_centerWeight;
  for (int index = 0; index < 16; index += 1) {
    if (index >= u_pairCount) break;
    vec2 offset = u_blurDirection * u_pairOffsets[index];
    float weight = u_pairWeights[index];
    color += texture(u_sourceTexture, v_uv + offset) * weight;
    color += texture(u_sourceTexture, v_uv - offset) * weight;
  }
  fragColor = color;
}`;

const ZEN_MULTIPASS_COMPOSITE_TEMPLATE = String.raw`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sceneTexture;
uniform sampler2D u_blurredTexture;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_zenGlassEnabled;
uniform float u_zenGlassBlur;
uniform float u_zenGlassRefraction;
uniform float u_zenGlassSaturation;
uniform float u_zenGlassShine;
uniform vec4 u_zenGlassRect;
uniform float u_zenGlassCornerRadius;
uniform float u_zenUiSurfaceCount;
uniform vec4 u_zenUiSurfaceRects[__ZEN_UI_SURFACE_CAPACITY__];
uniform vec4 u_zenUiSurfaceParams[__ZEN_UI_SURFACE_CAPACITY__];
uniform float u_zenContrastGuardEnabled;
uniform float u_zenContrastTarget;
uniform vec4 u_zenContrastRect;
uniform vec4 u_zenContrastFeather;
uniform vec3 u_zenContrastTextColor;
uniform vec3 u_zenUiContrastTextColor;
uniform float u_zenUiContrastMix;
uniform vec3 u_zenContrastBackdropColor;
uniform float u_zenContrastSurfaceOpacity;

float zenSrgbToLinearChannel(float value) {
  return value <= 0.04045
    ? value / 12.92
    : pow((value + 0.055) / 1.055, 2.4);
}

float zenLinearToSrgbChannel(float value) {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

vec3 zenSrgbToLinear(vec3 color) {
  return vec3(
    zenSrgbToLinearChannel(color.r),
    zenSrgbToLinearChannel(color.g),
    zenSrgbToLinearChannel(color.b)
  );
}

vec3 zenLinearToSrgb(vec3 color) {
  return vec3(
    zenLinearToSrgbChannel(color.r),
    zenLinearToSrgbChannel(color.g),
    zenLinearToSrgbChannel(color.b)
  );
}

float zenRelativeLuminance(vec3 color) {
  return dot(
    zenSrgbToLinear(clamp(color, 0.0, 1.0)),
    vec3(0.2126, 0.7152, 0.0722)
  );
}

float zenSurfaceCorrectionDirection(vec3 surfaceColor) {
  float surfaceLuminance = zenRelativeLuminance(surfaceColor);
  float contrastAgainstBlack = (surfaceLuminance + 0.05) / 0.05;
  float contrastAgainstWhite = 1.05 / (surfaceLuminance + 0.05);
  return contrastAgainstBlack >= contrastAgainstWhite ? 1.0 : -1.0;
}

float zenFadeFromStart(float value, float edge, float feather) {
  return feather <= 0.00001
    ? step(edge, value)
    : smoothstep(edge - feather, edge, value);
}

float zenFadeToEnd(float value, float edge, float feather) {
  return feather <= 0.00001
    ? 1.0 - step(edge, value)
    : 1.0 - smoothstep(edge, edge + feather, value);
}

float zenContrastColumnMask() {
  if (
    u_zenContrastRect.z <= u_zenContrastRect.x ||
    u_zenContrastRect.w <= u_zenContrastRect.y
  ) {
    return 0.0;
  }
  vec2 uv = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
  return
    zenFadeFromStart(uv.x, u_zenContrastRect.x, u_zenContrastFeather.x) *
    zenFadeFromStart(uv.y, u_zenContrastRect.y, u_zenContrastFeather.y) *
    zenFadeToEnd(uv.x, u_zenContrastRect.z, u_zenContrastFeather.z) *
    zenFadeToEnd(uv.y, u_zenContrastRect.w, u_zenContrastFeather.w);
}

float zenRoundedRectSignedDistance(
  vec2 point,
  vec2 halfSize,
  float cornerRadius
) {
  vec2 distanceFromStraightEdges =
    abs(point) - max(halfSize - vec2(cornerRadius), vec2(0.0));
  return
    length(max(distanceFromStraightEdges, vec2(0.0))) +
    min(max(distanceFromStraightEdges.x, distanceFromStraightEdges.y), 0.0) -
    cornerRadius;
}

vec2 zenRoundedRectOutwardNormal(
  vec2 point,
  vec2 halfSize,
  float cornerRadius
) {
  vec2 distanceFromStraightEdges =
    abs(point) - max(halfSize - vec2(cornerRadius), vec2(0.0));
  vec2 cornerVector = max(distanceFromStraightEdges, vec2(0.0));
  vec2 pointSign = mix(vec2(-1.0), vec2(1.0), step(vec2(0.0), point));
  float cornerScale = max(cornerVector.x, cornerVector.y);
  if (cornerScale > 0.0) {
    vec2 scaledCornerVector = cornerVector / cornerScale;
    return
      pointSign *
      scaledCornerVector *
      inversesqrt(dot(scaledCornerVector, scaledCornerVector));
  }
  return distanceFromStraightEdges.x > distanceFromStraightEdges.y
    ? vec2(pointSign.x, 0.0)
    : vec2(0.0, pointSign.y);
}

vec2 zenGlassRegion(
  vec4 rect,
  float cornerRadius,
  out float surfaceMask,
  out float edgeMask
) {
  surfaceMask = 0.0;
  edgeMask = 0.0;
  if (rect.z <= rect.x || rect.w <= rect.y) return vec2(0.0);

  vec2 resolution = max(u_resolution, vec2(1.0));
  vec2 rectMin = rect.xy * resolution;
  vec2 rectMax = rect.zw * resolution;
  vec2 size = rectMax - rectMin;
  vec2 center = (rectMin + rectMax) * 0.5;
  vec2 halfSize = size * 0.5;
  float radius = min(
    max(0.0, cornerRadius * max(u_pixelRatio, 0.0001)),
    min(halfSize.x, halfSize.y)
  );
  vec2 point = gl_FragCoord.xy - center;
  float signedDistance = zenRoundedRectSignedDistance(point, halfSize, radius);
  vec2 outwardNormal = zenRoundedRectOutwardNormal(point, halfSize, radius);
  float antialias = max(abs(outwardNormal.x) + abs(outwardNormal.y), 0.75);
  surfaceMask = 1.0 - smoothstep(-antialias, antialias, signedDistance);
  edgeMask = surfaceMask * (
    1.0 - smoothstep(0.0, max(1.0, 3.0 * u_pixelRatio), abs(signedDistance))
  );
  if (
    signedDistance > 0.0 ||
    u_zenGlassEnabled < 0.5 ||
    u_zenGlassRefraction <= 0.00001
  ) {
    return vec2(0.0);
  }

  float insideDistance = max(-signedDistance, 0.0);
  float refractionDepth = min(
    48.0 * max(u_pixelRatio, 0.0001),
    max(size.x, size.y) * 0.25
  );
  if (insideDistance >= refractionDepth) return vec2(0.0);
  float edgeProximity = 1.0 - clamp(
    insideDistance / max(refractionDepth, 0.0001),
    0.0,
    1.0
  );
  float distortion = 1.0 - sqrt(
    max(1.0 - edgeProximity * edgeProximity, 0.0)
  );
  float boundaryFade = smoothstep(
    0.0,
    max(0.75, 1.5 * u_pixelRatio),
    insideDistance
  );
  float displacement =
    distortion * u_zenGlassRefraction * u_pixelRatio * boundaryFade;
  displacement = min(displacement, max(0.75, insideDistance * 0.5));
  return -outwardNormal * displacement;
}

void zenCollectSurfaceState(
  out vec2 refractionOffset,
  out float glassMask,
  out float uiContrastMask,
  out float shineMask
) {
  float editorMask;
  float editorEdge;
  refractionOffset = zenGlassRegion(
    u_zenGlassRect,
    u_zenGlassCornerRadius,
    editorMask,
    editorEdge
  );
  float strongestLength = dot(refractionOffset, refractionOffset);
  glassMask = u_zenGlassEnabled >= 0.5 ? editorMask : 0.0;
  uiContrastMask = 0.0;
  shineMask = editorEdge;

  for (int index = 0; index < __ZEN_UI_SURFACE_CAPACITY__; index += 1) {
    if (float(index) >= u_zenUiSurfaceCount) break;
    float candidateMask;
    float candidateEdge;
    vec2 candidateOffset = zenGlassRegion(
      u_zenUiSurfaceRects[index],
      u_zenUiSurfaceParams[index].x,
      candidateMask,
      candidateEdge
    );
    bool refracts = u_zenUiSurfaceParams[index].y >= 0.5;
    float visibleUiMask = refracts
      ? candidateMask
      : candidateMask * editorMask;
    uiContrastMask = max(uiContrastMask, visibleUiMask);
    if (!refracts) continue;
    if (u_zenGlassEnabled >= 0.5) {
      glassMask = max(glassMask, candidateMask);
      shineMask = max(shineMask, candidateEdge);
    }
    float candidateLength = dot(candidateOffset, candidateOffset);
    if (candidateLength > strongestLength) {
      refractionOffset = candidateOffset;
      strongestLength = candidateLength;
    }
  }
}

vec3 zenGuardVisibleColor(
  vec3 visibleColor,
  vec3 textColor,
  float correctionDirection
) {
  float textLuminance = zenRelativeLuminance(textColor);
  vec3 linearColor = zenSrgbToLinear(clamp(visibleColor, 0.0, 1.0));
  float backgroundLuminance = dot(
    linearColor,
    vec3(0.2126, 0.7152, 0.0722)
  );
  float currentContrast =
    (max(textLuminance, backgroundLuminance) + 0.05) /
    (min(textLuminance, backgroundLuminance) + 0.05);
  // Contrast-only paths must leave pixels that already meet the target alone.
  // A forced UI direction remains a polarity constraint so a light surface
  // cannot retain an isolated dark patch when its text is also dark.
  bool followsCorrectionDirection = true;
  if (correctionDirection > 0.5) {
    followsCorrectionDirection = backgroundLuminance >= textLuminance;
  } else if (correctionDirection < -0.5) {
    followsCorrectionDirection = backgroundLuminance <= textLuminance;
  }
  if (
    currentContrast >= u_zenContrastTarget &&
    followsCorrectionDirection
  ) {
    return visibleColor;
  }

  vec3 correctedLinear;
  float contrastAgainstBlack = (textLuminance + 0.05) / 0.05;
  float contrastAgainstWhite = 1.05 / (textLuminance + 0.05);
  bool shouldDarken =
    correctionDirection < -0.5 ||
    (
      abs(correctionDirection) <= 0.5 &&
      contrastAgainstBlack >= contrastAgainstWhite
    );
  if (shouldDarken) {
    float maximumBackground = clamp(
      (textLuminance + 0.05) / u_zenContrastTarget - 0.05,
      0.0,
      1.0
    );
    // Connect the failing-side correction to the identity path at the safe
    // ceiling. This preserves motion without introducing a dark contour when
    // a live pixel crosses the contrast threshold.
    float mappedLuminance =
      maximumBackground <= 0.00001
        ? 0.0
        : maximumBackground * maximumBackground /
          max(backgroundLuminance, 0.00001);
    float scale = mappedLuminance / max(backgroundLuminance, 0.00001);
    correctedLinear = linearColor * clamp(scale, 0.0, 1.0);
  } else {
    float minimumBackground = clamp(
      u_zenContrastTarget * (textLuminance + 0.05) - 0.05,
      0.0,
      1.0
    );
    // Mirror the darkening curve around white so the correction is also
    // continuous at the minimum safe luminance. Recover the white mix from
    // the desired luminance to preserve the source hue.
    float distanceToWhite = max(1.0 - backgroundLuminance, 0.00001);
    float safeDistanceToWhite = 1.0 - minimumBackground;
    float mappedLuminance =
      1.0 - safeDistanceToWhite * safeDistanceToWhite / distanceToWhite;
    float whiteMix =
      (mappedLuminance - backgroundLuminance) / distanceToWhite;
    correctedLinear = mix(
      linearColor,
      vec3(1.0),
      clamp(whiteMix, 0.0, 1.0)
    );
  }
  return clamp(zenLinearToSrgb(correctedLinear), 0.0, 1.0);
}

vec3 applyZenFinalContrast(vec3 composedColor, float uiMask) {
  float surfaceOpacity = clamp(u_zenContrastSurfaceOpacity, 0.0, 1.0);
  vec3 visibleColor = mix(
    u_zenContrastBackdropColor,
    clamp(composedColor, 0.0, 1.0),
    surfaceOpacity
  );
  if (u_zenContrastGuardEnabled < 0.5) return visibleColor;

  float paperMask = clamp(zenContrastColumnMask(), 0.0, 1.0);
  float uiWeight = clamp(uiMask, 0.0, 1.0);
  if (paperMask <= 0.0 && uiWeight <= 0.0) return visibleColor;

  // Paper and UI candidates must both start from the same final Glass color.
  // UI owns overlap, avoiding a paper correction followed by a second UI pass.
  vec3 paperCorrected = zenGuardVisibleColor(
    visibleColor,
    u_zenContrastTextColor,
    0.0
  );
  vec3 uiCorrected = zenGuardVisibleColor(
    visibleColor,
    u_zenUiContrastTextColor,
    zenSurfaceCorrectionDirection(u_zenContrastBackdropColor)
  );
  float paperWeight = paperMask * (1.0 - uiWeight);
  vec3 guardedColor = mix(visibleColor, paperCorrected, paperWeight);
  return mix(
    guardedColor,
    uiCorrected,
    uiWeight * clamp(u_zenUiContrastMix, 0.0, 1.0)
  );
}

vec3 zenSaturate(vec3 color, float saturation) {
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(luminance), color, max(0.0, saturation));
}

void main() {
  vec2 refractionOffset;
  float glassMask;
  float uiContrastMask;
  float shineMask;
  zenCollectSurfaceState(
    refractionOffset,
    glassMask,
    uiContrastMask,
    shineMask
  );

  vec3 sceneColor = texture(u_sceneTexture, v_uv).rgb;
  vec2 refractedUv = clamp(
    v_uv + refractionOffset / max(u_resolution, vec2(1.0)),
    vec2(0.0),
    vec2(1.0)
  );
  vec3 blurredColor = texture(u_blurredTexture, refractedUv).rgb;
  vec3 glassColor = zenSaturate(blurredColor, u_zenGlassSaturation);
  glassColor = clamp((glassColor - 0.5) * 1.03 + 0.5, 0.0, 1.0);
  glassColor = mix(
    glassColor,
    vec3(1.0),
    shineMask * clamp(u_zenGlassShine, 0.0, 1.0) * 0.08
  );

  vec3 composedColor = mix(
    sceneColor,
    glassColor,
    clamp(glassMask, 0.0, 1.0)
  );
  composedColor = applyZenFinalContrast(composedColor, uiContrastMask);
  fragColor = vec4(composedColor, 1.0);
}
`;

export function zenMultipassSurfaceCapacity(surfaceCount: number) {
  return [1, 4, 8, 16, 32].find((capacity) => surfaceCount <= capacity) ?? 32;
}

export function buildZenMultipassCompositeFragment(surfaceCapacity = 32) {
  const capacity = zenMultipassSurfaceCapacity(surfaceCapacity);
  return ZEN_MULTIPASS_COMPOSITE_TEMPLATE.replaceAll(
    "__ZEN_UI_SURFACE_CAPACITY__",
    String(capacity),
  );
}

export function buildZenMultipassCompositeUniforms(
  config: ZenShaderConfig,
  runtime: ZenPostProcessRuntime,
  surfaceBuffer: ZenUiSurfaceUniformBuffer,
) {
  const configuredShine = (
    config.glass as typeof config.glass & { shine?: number }
  ).shine;
  return {
    ...buildZenPostProcessUniforms(config, runtime, surfaceBuffer),
    u_zenGlassEnabled: config.glass.enabled ? 1 : 0,
    u_zenGlassBlur: config.glass.enabled ? config.glass.blur : 0,
    u_zenGlassSaturation: config.glass.saturation,
    u_zenGlassShine: typeof configuredShine === "number" ? configuredShine : 0,
  };
}
