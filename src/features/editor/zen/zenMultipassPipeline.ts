import type { ZenShaderConfig } from "./zenShaderConfig";
import {
  buildZenPostProcessUniforms,
  type ZenPostProcessRuntime,
} from "./zenPostProcessing";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";

export const ZEN_MULTIPASS_BLUR_SCALE = 0.5;

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

export const ZEN_MULTIPASS_BLUR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sourceTexture;
uniform vec2 u_blurDirection;
void main() {
  vec4 color = texture(u_sourceTexture, v_uv) * 0.2270270270;
  color += texture(u_sourceTexture, v_uv + u_blurDirection * 1.3846153846) * 0.3162162162;
  color += texture(u_sourceTexture, v_uv - u_blurDirection * 1.3846153846) * 0.3162162162;
  color += texture(u_sourceTexture, v_uv + u_blurDirection * 3.2307692308) * 0.0702702703;
  color += texture(u_sourceTexture, v_uv - u_blurDirection * 3.2307692308) * 0.0702702703;
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
  float backgroundLuminance = zenRelativeLuminance(visibleColor);
  float currentContrast =
    (max(textLuminance, backgroundLuminance) + 0.05) /
    (min(textLuminance, backgroundLuminance) + 0.05);
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

  vec3 linearColor = zenSrgbToLinear(clamp(visibleColor, 0.0, 1.0));
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
    float scale = maximumBackground / max(backgroundLuminance, 0.00001);
    correctedLinear = linearColor * clamp(scale, 0.0, 1.0);
  } else {
    float minimumBackground = clamp(
      u_zenContrastTarget * (textLuminance + 0.05) - 0.05,
      0.0,
      1.0
    );
    float maximumChannel = max(max(linearColor.r, linearColor.g), linearColor.b);
    float hueScale = min(
      minimumBackground / max(backgroundLuminance, 0.00001),
      1.0 / max(maximumChannel, 0.00001)
    );
    vec3 huePreservingLift = clamp(linearColor * hueScale, 0.0, 1.0);
    float liftedLuminance = dot(
      huePreservingLift,
      vec3(0.2126, 0.7152, 0.0722)
    );
    float whiteMix =
      (minimumBackground - liftedLuminance) /
      max(1.0 - liftedLuminance, 0.00001);
    correctedLinear = mix(
      huePreservingLift,
      vec3(1.0),
      clamp(whiteMix, 0.0, 1.0)
    );
  }
  return clamp(zenLinearToSrgb(correctedLinear), 0.0, 1.0);
}

vec3 applyZenFinalContrast(vec3 composedColor, float uiMask) {
  if (u_zenContrastGuardEnabled < 0.5) return composedColor;
  float paperMask = zenContrastColumnMask();
  if (paperMask <= 0.0 && uiMask <= 0.0) return composedColor;

  float surfaceOpacity = clamp(u_zenContrastSurfaceOpacity, 0.0, 1.0);
  vec3 visibleColor = mix(
    u_zenContrastBackdropColor,
    clamp(composedColor, 0.0, 1.0),
    surfaceOpacity
  );
  vec3 guardedColor = composedColor;
  if (paperMask > 0.0) {
    vec3 guardedVisible = zenGuardVisibleColor(
      visibleColor,
      u_zenContrastTextColor,
      0.0
    );
    vec3 corrected = composedColor;
    if (surfaceOpacity > 0.00001) {
      corrected =
        (guardedVisible - u_zenContrastBackdropColor * (1.0 - surfaceOpacity)) /
        surfaceOpacity;
    }
    guardedColor = mix(guardedColor, clamp(corrected, 0.0, 1.0), paperMask);
  }
  if (uiMask > 0.0) {
    vec3 guardedVisible = zenGuardVisibleColor(
      visibleColor,
      u_zenUiContrastTextColor,
      zenSurfaceCorrectionDirection(u_zenContrastBackdropColor)
    );
    vec3 corrected = composedColor;
    if (surfaceOpacity > 0.00001) {
      corrected =
        (guardedVisible - u_zenContrastBackdropColor * (1.0 - surfaceOpacity)) /
        surfaceOpacity;
    }
    guardedColor = mix(
      guardedColor,
      clamp(corrected, 0.0, 1.0),
      uiMask * clamp(u_zenUiContrastMix, 0.0, 1.0)
    );
  }
  return guardedColor;
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
