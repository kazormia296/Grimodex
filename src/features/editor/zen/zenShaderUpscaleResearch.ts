export type ZenShaderResearchUpscaler =
  | "linear"
  | "catmull-rom"
  | "easu"
  | "easu-rcas";

export type ZenShaderUpscaleResearchSequence = "ABBA" | "BAAB";
export type ZenShaderUpscaleResearchVariant = "native" | "candidate";
export type ZenShaderUpscaleResearchCandidateSet = "matrix" | "linear-focused";

export interface ZenShaderUpscaleResearchCandidate {
  id: string;
  sceneScale: number;
  upscaler: ZenShaderResearchUpscaler;
}

export interface ZenShaderUpscaleResearchRun {
  runIndex: number;
  sequence: ZenShaderUpscaleResearchSequence;
  variants: ZenShaderUpscaleResearchVariant[];
}

export const ZEN_SHADER_UPSCALE_RESEARCH_SCALES = [
  1,
  5 / 6,
  3 / 4,
  2 / 3,
] as const;

export const ZEN_SHADER_UPSCALE_RESEARCH_UPSCALERS = [
  "linear",
  "catmull-rom",
  "easu",
  "easu-rcas",
] as const satisfies readonly ZenShaderResearchUpscaler[];

export const ZEN_SHADER_UPSCALE_RESEARCH_SHADER_IDS = [
  "liquid-metal",
  "halftone-cmyk",
  "halftone-dots",
  "smoke-ring",
  "gem-smoke",
  "color-panels",
] as const satisfies readonly PaperShaderId[];

const UPSCALE_SEQUENCE_VARIANTS: Record<
  ZenShaderUpscaleResearchSequence,
  readonly ZenShaderUpscaleResearchVariant[]
> = {
  ABBA: ["native", "candidate", "candidate", "native"],
  BAAB: ["candidate", "native", "native", "candidate"],
};

export function buildZenShaderUpscaleResearchMatrix(): ZenShaderUpscaleResearchCandidate[] {
  return ZEN_SHADER_UPSCALE_RESEARCH_SCALES.flatMap((sceneScale) =>
    ZEN_SHADER_UPSCALE_RESEARCH_UPSCALERS.map((upscaler) => ({
      id: `${Math.round(sceneScale * 10_000)}-${upscaler}`,
      sceneScale,
      upscaler,
    })),
  );
}

export function buildZenShaderUpscaleResearchCandidates(
  candidateSet: ZenShaderUpscaleResearchCandidateSet,
): ZenShaderUpscaleResearchCandidate[] {
  const matrix = buildZenShaderUpscaleResearchMatrix();
  if (candidateSet === "matrix") return matrix;
  if (candidateSet === "linear-focused") {
    return matrix.filter(
      ({ sceneScale, upscaler }) => sceneScale < 1 && upscaler === "linear",
    );
  }
  throw new TypeError(
    `Unknown Zen shader upscale candidate set: ${candidateSet}`,
  );
}

export function resolveZenShaderUpscaleDimensions(
  width: number,
  height: number,
  sceneScale: number,
) {
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new TypeError("Zen shader upscale width must be a positive integer");
  }
  if (!Number.isSafeInteger(height) || height < 1) {
    throw new TypeError("Zen shader upscale height must be a positive integer");
  }
  if (!Number.isFinite(sceneScale) || sceneScale <= 0 || sceneScale > 1) {
    throw new TypeError("Zen shader upscale scene scale must be in (0, 1]");
  }
  return {
    width: Math.max(1, Math.min(width, Math.round(width * sceneScale))),
    height: Math.max(1, Math.min(height, Math.round(height * sceneScale))),
  };
}

export function buildZenShaderUpscaleResearchSchedule(
  runCount: number,
  firstSequence: ZenShaderUpscaleResearchSequence = "ABBA",
): ZenShaderUpscaleResearchRun[] {
  if (!Number.isSafeInteger(runCount) || runCount < 1 || runCount % 2 !== 0) {
    throw new TypeError(
      "Zen shader upscale ABBA runCount must be a positive even integer",
    );
  }
  if (firstSequence !== "ABBA" && firstSequence !== "BAAB") {
    throw new TypeError("Zen shader upscale sequence must be ABBA or BAAB");
  }
  return Array.from({ length: runCount }, (_, runIndex) => {
    const sequence =
      runIndex % 2 === 0
        ? firstSequence
        : firstSequence === "ABBA"
          ? "BAAB"
          : "ABBA";
    return {
      runIndex,
      sequence,
      variants: [...UPSCALE_SEQUENCE_VARIANTS[sequence]],
    };
  });
}

const UPSCALE_FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sceneTexture;
uniform vec2 u_resolution;
uniform vec2 u_upscaleSourceSize;
ivec2 clampSourceCoord(ivec2 coord) {
  return clamp(coord, ivec2(0), ivec2(u_upscaleSourceSize) - ivec2(1));
}
vec4 loadSource(ivec2 coord) {
  return texelFetch(u_sceneTexture, clampSourceCoord(coord), 0);
}`;

const LINEAR_UPSCALE_FRAGMENT = `${UPSCALE_FRAGMENT_HEADER}
void main() {
  fragColor = texture(u_sceneTexture, v_uv);
}`;

const CATMULL_ROM_UPSCALE_FRAGMENT = `${UPSCALE_FRAGMENT_HEADER}
float catmullRomWeight(float value) {
  float distance = abs(value);
  if (distance <= 1.0) {
    return 1.5 * distance * distance * distance
      - 2.5 * distance * distance + 1.0;
  }
  if (distance < 2.0) {
    return -0.5 * distance * distance * distance
      + 2.5 * distance * distance - 4.0 * distance + 2.0;
  }
  return 0.0;
}
void main() {
  vec2 sourcePosition = v_uv * u_upscaleSourceSize - vec2(0.5);
  ivec2 base = ivec2(floor(sourcePosition));
  vec2 fraction = fract(sourcePosition);
  vec4 color = vec4(0.0);
  float weightSum = 0.0;
  for (int y = -1; y <= 2; y += 1) {
    float weightY = catmullRomWeight(float(y) - fraction.y);
    for (int x = -1; x <= 2; x += 1) {
      float weight = catmullRomWeight(float(x) - fraction.x) * weightY;
      color += loadSource(base + ivec2(x, y)) * weight;
      weightSum += weight;
    }
  }
  fragColor = color / max(abs(weightSum), 1e-6);
}`;

// The EASU and RCAS kernels below are a direct GLSL ES adaptation of AMD's
// FidelityFX FSR 1 reference:
// https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/master/ffx-fsr/ffx_fsr1.h
//
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
const EASU_UPSCALE_FRAGMENT = `${UPSCALE_FRAGMENT_HEADER}
float easuLuma(vec3 color) {
  return color.g + 0.5 * (color.r + color.b);
}
void easuSet(
  inout vec2 direction,
  inout float edgeLength,
  float weight,
  float lumaA,
  float lumaB,
  float lumaC,
  float lumaD,
  float lumaE
) {
  float dc = lumaD - lumaC;
  float cb = lumaC - lumaB;
  float lengthX = max(abs(dc), abs(cb));
  float directionX = lumaD - lumaB;
  direction.x += directionX * weight;
  lengthX = clamp(abs(directionX) / max(lengthX, 1e-6), 0.0, 1.0);
  edgeLength += lengthX * lengthX * weight;

  float ec = lumaE - lumaC;
  float ca = lumaC - lumaA;
  float lengthY = max(abs(ec), abs(ca));
  float directionY = lumaE - lumaA;
  direction.y += directionY * weight;
  lengthY = clamp(abs(directionY) / max(lengthY, 1e-6), 0.0, 1.0);
  edgeLength += lengthY * lengthY * weight;
}
void easuTap(
  inout vec3 accumulatedColor,
  inout float accumulatedWeight,
  vec2 offset,
  vec2 direction,
  vec2 anisotropicLength,
  float lobe,
  float clipPoint,
  vec3 color
) {
  vec2 rotated = vec2(
    offset.x * direction.x + offset.y * direction.y,
    offset.x * -direction.y + offset.y * direction.x
  ) * anisotropicLength;
  float distanceSquared = min(dot(rotated, rotated), clipPoint);
  float windowWeight = lobe * distanceSquared - 1.0;
  float baseWeight = 0.4 * distanceSquared - 1.0;
  windowWeight *= windowWeight;
  baseWeight *= baseWeight;
  baseWeight = (25.0 / 16.0) * baseWeight - (9.0 / 16.0);
  float weight = baseWeight * windowWeight;
  accumulatedColor += color * weight;
  accumulatedWeight += weight;
}
vec3 easu() {
  vec2 sourcePosition = gl_FragCoord.xy *
    (u_upscaleSourceSize / u_resolution) - vec2(0.5);
  ivec2 base = ivec2(floor(sourcePosition));
  vec2 fraction = fract(sourcePosition);

  vec3 b = loadSource(base + ivec2( 0, -1)).rgb;
  vec3 c = loadSource(base + ivec2( 1, -1)).rgb;
  vec3 e = loadSource(base + ivec2(-1,  0)).rgb;
  vec3 f = loadSource(base + ivec2( 0,  0)).rgb;
  vec3 g = loadSource(base + ivec2( 1,  0)).rgb;
  vec3 h = loadSource(base + ivec2( 2,  0)).rgb;
  vec3 i = loadSource(base + ivec2(-1,  1)).rgb;
  vec3 j = loadSource(base + ivec2( 0,  1)).rgb;
  vec3 k = loadSource(base + ivec2( 1,  1)).rgb;
  vec3 l = loadSource(base + ivec2( 2,  1)).rgb;
  vec3 n = loadSource(base + ivec2( 0,  2)).rgb;
  vec3 o = loadSource(base + ivec2( 1,  2)).rgb;

  float bL = easuLuma(b);
  float cL = easuLuma(c);
  float eL = easuLuma(e);
  float fL = easuLuma(f);
  float gL = easuLuma(g);
  float hL = easuLuma(h);
  float iL = easuLuma(i);
  float jL = easuLuma(j);
  float kL = easuLuma(k);
  float lL = easuLuma(l);
  float nL = easuLuma(n);
  float oL = easuLuma(o);

  vec2 direction = vec2(0.0);
  float edgeLength = 0.0;
  easuSet(direction, edgeLength, (1.0 - fraction.x) * (1.0 - fraction.y), bL, eL, fL, gL, jL);
  easuSet(direction, edgeLength, fraction.x * (1.0 - fraction.y), cL, fL, gL, hL, kL);
  easuSet(direction, edgeLength, (1.0 - fraction.x) * fraction.y, fL, iL, jL, kL, nL);
  easuSet(direction, edgeLength, fraction.x * fraction.y, gL, jL, kL, lL, oL);

  float directionLengthSquared = dot(direction, direction);
  if (directionLengthSquared < (1.0 / 32768.0)) {
    direction = vec2(1.0, 0.0);
  } else {
    direction *= inversesqrt(directionLengthSquared);
  }
  edgeLength = 0.5 * edgeLength;
  edgeLength *= edgeLength;
  float stretch = 1.0 / max(abs(direction.x), abs(direction.y));
  vec2 anisotropicLength = vec2(
    mix(1.0, stretch, edgeLength),
    mix(1.0, 0.5, edgeLength)
  );
  float lobe = mix(0.5, 0.21, edgeLength);
  float clipPoint = 1.0 / lobe;
  vec3 minimumColor = min(min(f, g), min(j, k));
  vec3 maximumColor = max(max(f, g), max(j, k));
  vec3 accumulatedColor = vec3(0.0);
  float accumulatedWeight = 0.0;
  easuTap(accumulatedColor, accumulatedWeight, vec2( 0.0, -1.0) - fraction, direction, anisotropicLength, lobe, clipPoint, b);
  easuTap(accumulatedColor, accumulatedWeight, vec2( 1.0, -1.0) - fraction, direction, anisotropicLength, lobe, clipPoint, c);
  easuTap(accumulatedColor, accumulatedWeight, vec2(-1.0,  1.0) - fraction, direction, anisotropicLength, lobe, clipPoint, i);
  easuTap(accumulatedColor, accumulatedWeight, vec2( 0.0,  1.0) - fraction, direction, anisotropicLength, lobe, clipPoint, j);
  easuTap(accumulatedColor, accumulatedWeight, vec2( 0.0,  0.0) - fraction, direction, anisotropicLength, lobe, clipPoint, f);
  easuTap(accumulatedColor, accumulatedWeight, vec2(-1.0,  0.0) - fraction, direction, anisotropicLength, lobe, clipPoint, e);
  easuTap(accumulatedColor, accumulatedWeight, vec2( 1.0,  1.0) - fraction, direction, anisotropicLength, lobe, clipPoint, k);
  easuTap(accumulatedColor, accumulatedWeight, vec2( 2.0,  1.0) - fraction, direction, anisotropicLength, lobe, clipPoint, l);
  easuTap(accumulatedColor, accumulatedWeight, vec2( 2.0,  0.0) - fraction, direction, anisotropicLength, lobe, clipPoint, h);
  easuTap(accumulatedColor, accumulatedWeight, vec2( 1.0,  0.0) - fraction, direction, anisotropicLength, lobe, clipPoint, g);
  easuTap(accumulatedColor, accumulatedWeight, vec2( 1.0,  2.0) - fraction, direction, anisotropicLength, lobe, clipPoint, o);
  easuTap(accumulatedColor, accumulatedWeight, vec2( 0.0,  2.0) - fraction, direction, anisotropicLength, lobe, clipPoint, n);
  return clamp(accumulatedColor / max(accumulatedWeight, 1e-6), minimumColor, maximumColor);
}
void main() {
  fragColor = vec4(easu(), texture(u_sceneTexture, v_uv).a);
}`;

export const ZEN_SHADER_RESEARCH_RCAS_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sourceTexture;
uniform vec2 u_sourceSize;
ivec2 clampCoord(ivec2 coord) {
  return clamp(coord, ivec2(0), ivec2(u_sourceSize) - ivec2(1));
}
vec4 loadColor(ivec2 coord) {
  return texelFetch(u_sourceTexture, clampCoord(coord), 0);
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec3 b = loadColor(pixel + ivec2( 0, -1)).rgb;
  vec3 d = loadColor(pixel + ivec2(-1,  0)).rgb;
  vec4 center = loadColor(pixel);
  vec3 e = center.rgb;
  vec3 f = loadColor(pixel + ivec2( 1,  0)).rgb;
  vec3 h = loadColor(pixel + ivec2( 0,  1)).rgb;
  vec3 minimumRing = min(min(b, d), min(f, h));
  vec3 maximumRing = max(max(b, d), max(f, h));
  vec3 hitMinimum = min(minimumRing, e) / max(4.0 * maximumRing, vec3(1e-6));
  vec3 hitMaximum = (vec3(1.0) - max(maximumRing, e)) /
    min(4.0 * minimumRing - vec3(4.0), vec3(-1e-6));
  vec3 lobes = max(-hitMinimum, hitMaximum);
  float lobe = max(-0.1875, min(max(lobes.r, max(lobes.g, lobes.b)), 0.0));
  lobe *= exp2(-0.2);
  vec3 sharpened = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  fragColor = vec4(sharpened, center.a);
}`;

export function buildZenShaderResearchUpscaleFragment(
  upscaler: ZenShaderResearchUpscaler,
) {
  switch (upscaler) {
    case "linear":
      return LINEAR_UPSCALE_FRAGMENT;
    case "catmull-rom":
      return CATMULL_ROM_UPSCALE_FRAGMENT;
    case "easu":
    case "easu-rcas":
      return EASU_UPSCALE_FRAGMENT;
  }
}
import type { PaperShaderId } from "./paperShaderCatalog";
