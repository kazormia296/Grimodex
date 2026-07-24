import type { ZenShaderConfig } from "./zenShaderConfig";
import {
  contrastTargetRatio,
  type ZenContrastGuardLayout,
  type ZenContrastGuardRect,
} from "./zenContrastGuard";
import {
  makePaperFragmentRefractable,
  ZEN_GLASS_REFRACTION_FRAGMENT,
} from "./zenGlassRefraction";
import type { ZenGlassLayout } from "./useZenShaderLayouts";

export const ZEN_UI_SURFACE_MAX = 32;

export interface ZenPostProcessRuntime extends ZenContrastGuardLayout {
  glassRect: ZenContrastGuardRect;
  glassCornerRadius: number;
  uiSurfaces?: readonly ZenGlassLayout[];
  textColor: [number, number, number];
  uiTextColor?: [number, number, number];
  backdropColor: [number, number, number];
}

const DEFAULT_RUNTIME: ZenPostProcessRuntime = {
  rect: [0, 0, 0, 0],
  feather: [0, 0, 0, 0],
  glassRect: [0, 0, 0, 0],
  glassCornerRadius: 0,
  textColor: [0.85, 0.85, 0.85],
  backdropColor: [0.063, 0.075, 0.094],
};

const POST_PROCESS_FRAGMENT = String.raw`
/*__ZEN_RESOLUTION_UNIFORM__*/
/*__ZEN_PIXEL_RATIO_UNIFORM__*/
uniform float u_zenDitherStrength;
uniform float u_zenDitherSize;
uniform float u_zenDitherLevels;
uniform float u_zenHalftoneStrength;
uniform float u_zenHalftoneSize;
uniform float u_zenHalftoneAngle;
uniform float u_zenHalftoneSoftness;
uniform float u_zenContrastGuardEnabled;
uniform float u_zenContrastTarget;
uniform vec4 u_zenContrastRect;
uniform vec4 u_zenContrastFeather;
uniform vec3 u_zenContrastTextColor;
uniform vec3 u_zenUiContrastTextColor;
uniform float u_zenUiContrastMix;
uniform vec3 u_zenContrastBackdropColor;
uniform float u_zenContrastSurfaceOpacity;

${ZEN_GLASS_REFRACTION_FRAGMENT}

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

// Keep tool surfaces on their theme's side of the luminance range. A muted
// mid-tone ink must not invert a light surface while chasing its target ratio.
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
  float left = zenFadeFromStart(
    uv.x,
    u_zenContrastRect.x,
    u_zenContrastFeather.x
  );
  float bottom = zenFadeFromStart(
    uv.y,
    u_zenContrastRect.y,
    u_zenContrastFeather.y
  );
  float right = zenFadeToEnd(
    uv.x,
    u_zenContrastRect.z,
    u_zenContrastFeather.z
  );
  float top = zenFadeToEnd(
    uv.y,
    u_zenContrastRect.w,
    u_zenContrastFeather.w
  );
  return left * bottom * right * top;
}

float zenUiSurfaceMask() {
  return zenUiSurfaceMaskCache;
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
  // A forced UI direction is also a polarity constraint: readable dark-on-dark
  // contrast must not preserve a black patch inside a light-theme surface.
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

vec3 applyZenContrastGuard(vec3 shaderColor) {
  if (u_zenContrastGuardEnabled < 0.5) return shaderColor;
  float paperMask = zenContrastColumnMask();
  float uiMask = zenUiSurfaceMask();
  if (paperMask <= 0.0 && uiMask <= 0.0) return shaderColor;

  float surfaceOpacity = clamp(u_zenContrastSurfaceOpacity, 0.0, 1.0);
  vec3 visibleColor = mix(
    u_zenContrastBackdropColor,
    clamp(shaderColor, 0.0, 1.0),
    surfaceOpacity
  );
  vec3 guardedShaderColor = shaderColor;
  if (paperMask > 0.0) {
    vec3 paperGuardedVisibleColor = zenGuardVisibleColor(
      visibleColor,
      u_zenContrastTextColor,
      0.0
    );
    vec3 paperGuardedShaderColor = shaderColor;
    if (surfaceOpacity > 0.00001) {
      paperGuardedShaderColor =
        (paperGuardedVisibleColor -
          u_zenContrastBackdropColor * (1.0 - surfaceOpacity)) /
        surfaceOpacity;
    }
    guardedShaderColor = mix(
      guardedShaderColor,
      clamp(paperGuardedShaderColor, 0.0, 1.0),
      paperMask
    );
  }
  if (uiMask > 0.0) {
    vec3 uiGuardedVisibleColor = zenGuardVisibleColor(
      visibleColor,
      u_zenUiContrastTextColor,
      zenSurfaceCorrectionDirection(u_zenContrastBackdropColor)
    );
    vec3 uiGuardedShaderColor = shaderColor;
    if (surfaceOpacity > 0.00001) {
      uiGuardedShaderColor =
        (uiGuardedVisibleColor -
          u_zenContrastBackdropColor * (1.0 - surfaceOpacity)) /
        surfaceOpacity;
    }
    guardedShaderColor = mix(
      guardedShaderColor,
      clamp(uiGuardedShaderColor, 0.0, 1.0),
      uiMask * clamp(u_zenUiContrastMix, 0.0, 1.0)
    );
  }
  return guardedShaderColor;
}

void main() {
  /*__ZEN_GLASS_COORDINATE_SETUP__*/
  paperShaderMain();
  vec4 paperColor = fragColor;
  paperColor.rgb = applyZenDither(paperColor.rgb);
  paperColor.rgb = applyZenColorHalftone(paperColor.rgb);
  paperColor.rgb = applyZenContrastGuard(paperColor.rgb);
  fragColor = paperColor;
}
`;

const RESOLUTION_UNIFORM_PATTERN =
  /uniform\s+(?:(?:lowp|mediump|highp)\s+)?vec2\s+u_resolution\s*;/;
const PIXEL_RATIO_UNIFORM_PATTERN =
  /uniform\s+(?:(?:lowp|mediump|highp)\s+)?float\s+u_pixelRatio\s*;/;

/**
 * Paper image filters accept an image texture, not another live shader canvas.
 * Rename Paper's main and append our post pass so both filters operate on the
 * generated color in the same fragment invocation, without a readback/copy.
 */
export function buildZenPostProcessedFragment(fragment: string): string {
  const mainPattern = /void\s+main\s*\(\s*\)/;
  if (!mainPattern.test(fragment)) {
    throw new Error("Paper shader fragment has no compatible main function");
  }
  const refractable = makePaperFragmentRefractable(fragment);
  const renamed = refractable.fragment.replace(
    mainPattern,
    "void paperShaderMain()",
  );
  const resolutionUniform = RESOLUTION_UNIFORM_PATTERN.test(fragment)
    ? ""
    : "uniform vec2 u_resolution;";
  const pixelRatioUniform = PIXEL_RATIO_UNIFORM_PATTERN.test(fragment)
    ? ""
    : "uniform float u_pixelRatio;";
  const postProcess = POST_PROCESS_FRAGMENT.replace(
    "/*__ZEN_RESOLUTION_UNIFORM__*/",
    resolutionUniform,
  )
    .replace("/*__ZEN_PIXEL_RATIO_UNIFORM__*/", pixelRatioUniform)
    .replace("/*__ZEN_GLASS_COORDINATE_SETUP__*/", refractable.coordinateSetup);
  return `${renamed}\n// Paper is refracted before Dither, Halftone and the dynamic contrast guard.\n${postProcess}`;
}

export function buildZenPostProcessUniforms(
  config: ZenShaderConfig,
  runtime: ZenPostProcessRuntime = DEFAULT_RUNTIME,
) {
  const uiSurfaces = (runtime.uiSurfaces ?? []).slice(0, ZEN_UI_SURFACE_MAX);
  const uiSurfaceRects = Array.from(
    { length: ZEN_UI_SURFACE_MAX },
    (_, index) =>
      index < uiSurfaces.length ? [...uiSurfaces[index].rect] : [0, 0, 0, 0],
  );
  const uiSurfaceParams = Array.from(
    { length: ZEN_UI_SURFACE_MAX },
    (_, index) =>
      index < uiSurfaces.length
        ? [uiSurfaces[index].cornerRadius, 0, 0, 0]
        : [0, 0, 0, 0],
  );

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
    u_zenContrastGuardEnabled: config.contrastGuard.mode === "auto" ? 1 : 0,
    u_zenContrastTarget: contrastTargetRatio(config.contrastGuard.strength),
    u_zenContrastRect: runtime.rect,
    u_zenContrastFeather: runtime.feather,
    u_zenContrastTextColor: runtime.textColor,
    u_zenUiContrastTextColor: runtime.uiTextColor ?? runtime.textColor,
    u_zenUiContrastMix: config.contrastGuard.toolMix,
    u_zenContrastBackdropColor: runtime.backdropColor,
    u_zenContrastSurfaceOpacity: config.opacity / 100,
    u_zenGlassRefraction: config.glass.enabled ? config.glass.refraction : 0,
    u_zenGlassRect: runtime.glassRect,
    u_zenGlassCornerRadius: runtime.glassCornerRadius,
    u_zenUiSurfaceCount: uiSurfaces.length,
    "u_zenUiSurfaceRects[0]": uiSurfaceRects,
    "u_zenUiSurfaceParams[0]": uiSurfaceParams,
  };
}
