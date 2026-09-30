export type ZenBlurBackend =
  | "gaussian-current"
  | "dual-kawase-canonical"
  | "dual-kawase-planned";

export type ZenDualKawaseTextureFormat = "rgba8" | "rgba16f";

export interface ZenDualKawasePlanInput {
  backend: ZenBlurBackend;
  sceneWidth: number;
  sceneHeight: number;
  baseWidth?: number;
  baseHeight?: number;
  passes: number;
  offset: number;
  textureFormat: ZenDualKawaseTextureFormat;
}

export interface ZenDualKawaseLevel {
  width: number;
  height: number;
}

export interface ZenDualKawasePlan {
  backend: "dual-kawase-canonical" | "dual-kawase-planned";
  sceneWidth: number;
  sceneHeight: number;
  baseWidth: number;
  baseHeight: number;
  passes: number;
  offset: number;
  textureFormat: ZenDualKawaseTextureFormat;
  requiresPrefilter: boolean;
  levels: ZenDualKawaseLevel[];
  downsamplePassCount: number;
  upsamplePassCount: number;
  drawCallCount: number;
  estimatedTextureFetches: number;
  intermediateBytes: number;
}

const MIN_PASSES = 1;
const MAX_PASSES = 4;
const MIN_OFFSET = 0.5;
const MAX_OFFSET = 4;
const PREFILTER_FETCHES_PER_PIXEL = 9;
const DOWNSAMPLE_FETCHES_PER_PIXEL = 5;
const UPSAMPLE_FETCHES_PER_PIXEL = 8;

function isValidDimension(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

function isValidTextureFormat(
  value: string,
): value is ZenDualKawaseTextureFormat {
  return value === "rgba8" || value === "rgba16f";
}

function buildPyramidLevels(
  baseWidth: number,
  baseHeight: number,
  passes: number,
) {
  const levels: ZenDualKawaseLevel[] = [
    { width: baseWidth, height: baseHeight },
  ];

  for (let index = 0; index < passes; index += 1) {
    const previous = levels[index];
    levels.push({
      width: Math.max(1, Math.round(previous.width / 2)),
      height: Math.max(1, Math.round(previous.height / 2)),
    });
  }

  return levels;
}

function pixelCount(level: ZenDualKawaseLevel) {
  return level.width * level.height;
}

function estimateTextureFetches(
  levels: readonly ZenDualKawaseLevel[],
  requiresPrefilter: boolean,
) {
  const prefilterFetches = requiresPrefilter
    ? pixelCount(levels[0]) * PREFILTER_FETCHES_PER_PIXEL
    : 0;
  const downsampleFetches = levels
    .slice(1)
    .reduce(
      (total, level) =>
        total + pixelCount(level) * DOWNSAMPLE_FETCHES_PER_PIXEL,
      0,
    );
  const upsampleFetches = levels
    .slice(0, -1)
    .reduce(
      (total, level) => total + pixelCount(level) * UPSAMPLE_FETCHES_PER_PIXEL,
      0,
    );
  return prefilterFetches + downsampleFetches + upsampleFetches;
}

function estimateIntermediateBytes(
  levels: readonly ZenDualKawaseLevel[],
  textureFormat: ZenDualKawaseTextureFormat,
) {
  const bytesPerPixel = textureFormat === "rgba8" ? 4 : 8;
  return (
    levels.reduce((total, level) => total + pixelCount(level), 0) *
    bytesPerPixel
  );
}

export function resolveZenDualKawasePlan({
  backend,
  sceneWidth,
  sceneHeight,
  baseWidth,
  baseHeight,
  passes,
  offset,
  textureFormat,
}: ZenDualKawasePlanInput): ZenDualKawasePlan | null {
  if (
    (backend !== "dual-kawase-canonical" &&
      backend !== "dual-kawase-planned") ||
    !isValidDimension(sceneWidth) ||
    !isValidDimension(sceneHeight) ||
    !Number.isInteger(passes) ||
    passes < MIN_PASSES ||
    passes > MAX_PASSES ||
    !Number.isFinite(offset) ||
    offset < MIN_OFFSET ||
    offset > MAX_OFFSET ||
    !isValidTextureFormat(textureFormat)
  ) {
    return null;
  }

  const requiresPrefilter = backend === "dual-kawase-planned";
  const resolvedBaseWidth = requiresPrefilter ? baseWidth : sceneWidth;
  const resolvedBaseHeight = requiresPrefilter ? baseHeight : sceneHeight;
  if (
    !isValidDimension(resolvedBaseWidth) ||
    !isValidDimension(resolvedBaseHeight) ||
    resolvedBaseWidth > sceneWidth ||
    resolvedBaseHeight > sceneHeight
  ) {
    return null;
  }

  const levels = buildPyramidLevels(
    resolvedBaseWidth,
    resolvedBaseHeight,
    passes,
  );
  const downsamplePassCount = passes;
  const upsamplePassCount = passes;

  return {
    backend,
    sceneWidth,
    sceneHeight,
    baseWidth: resolvedBaseWidth,
    baseHeight: resolvedBaseHeight,
    passes,
    offset,
    textureFormat,
    requiresPrefilter,
    levels,
    downsamplePassCount,
    upsamplePassCount,
    drawCallCount:
      downsamplePassCount + upsamplePassCount + (requiresPrefilter ? 1 : 0),
    estimatedTextureFetches: estimateTextureFetches(levels, requiresPrefilter),
    intermediateBytes: estimateIntermediateBytes(levels, textureFormat),
  };
}

const ZEN_DUAL_KAWASE_QUANTIZATION_DITHER_GLSL = `
uniform float u_quantizationDitherStrength;
uniform float u_quantizationDitherSeed;

float zenQuantizationWhiteNoise(vec2 pixel, float seed) {
  vec2 seededPixel = pixel + vec2(seed * 17.0, seed * 131.0);
  return fract(
    sin(dot(seededPixel, vec2(12.9898, 78.233))) * 43758.5453
  );
}

vec4 zenApplyQuantizationDither(vec4 color) {
  if (u_quantizationDitherStrength <= 0.0) return color;
  float noise =
    zenQuantizationWhiteNoise(gl_FragCoord.xy, u_quantizationDitherSeed) - 0.5;
  color.rgb += vec3(noise * u_quantizationDitherStrength);
  return color;
}
`;

export const ZEN_DUAL_KAWASE_DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sourceTexture;
uniform vec2 u_sourceTexelSize;
uniform float u_offset;
${ZEN_DUAL_KAWASE_QUANTIZATION_DITHER_GLSL}
void main() {
  vec2 sampleOffset = u_sourceTexelSize * u_offset;
  vec4 color = texture(u_sourceTexture, v_uv) * 4.0;
  color += texture(u_sourceTexture, v_uv + sampleOffset * vec2(-1.0, -1.0));
  color += texture(u_sourceTexture, v_uv + sampleOffset * vec2(1.0, -1.0));
  color += texture(u_sourceTexture, v_uv + sampleOffset * vec2(-1.0, 1.0));
  color += texture(u_sourceTexture, v_uv + sampleOffset * vec2(1.0, 1.0));
  fragColor = zenApplyQuantizationDither(color / 8.0);
}`;

export const ZEN_DUAL_KAWASE_UPSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sourceTexture;
uniform vec2 u_sourceTexelSize;
uniform float u_offset;
${ZEN_DUAL_KAWASE_QUANTIZATION_DITHER_GLSL}
void main() {
  vec2 sampleOffset = u_sourceTexelSize * u_offset;
  vec4 color =
    texture(u_sourceTexture, v_uv + sampleOffset * vec2(-2.0, 0.0));
  color += texture(
    u_sourceTexture,
    v_uv + sampleOffset * vec2(-1.0, 1.0)
  ) * 2.0;
  color += texture(u_sourceTexture, v_uv + sampleOffset * vec2(0.0, 2.0));
  color += texture(
    u_sourceTexture,
    v_uv + sampleOffset * vec2(1.0, 1.0)
  ) * 2.0;
  color += texture(u_sourceTexture, v_uv + sampleOffset * vec2(2.0, 0.0));
  color += texture(
    u_sourceTexture,
    v_uv + sampleOffset * vec2(1.0, -1.0)
  ) * 2.0;
  color += texture(u_sourceTexture, v_uv + sampleOffset * vec2(0.0, -2.0));
  color += texture(
    u_sourceTexture,
    v_uv + sampleOffset * vec2(-1.0, -1.0)
  ) * 2.0;
  fragColor = zenApplyQuantizationDither(color / 12.0);
}`;
