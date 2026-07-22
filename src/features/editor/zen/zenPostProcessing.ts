import type { ZenShaderConfig } from "./zenShaderConfig";

const POST_PROCESS_FRAGMENT = String.raw`
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
  vec4 paperColor = fragColor;
  paperColor.rgb = applyZenDither(paperColor.rgb);
  paperColor.rgb = applyZenColorHalftone(paperColor.rgb);
  fragColor = paperColor;
}
`;

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
  const renamed = fragment.replace(mainPattern, "void paperShaderMain()");
  return `${renamed}\n// paperShaderMain(); runs before both Zen post effects.\n${POST_PROCESS_FRAGMENT}`;
}

export function buildZenPostProcessUniforms(config: ZenShaderConfig) {
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
