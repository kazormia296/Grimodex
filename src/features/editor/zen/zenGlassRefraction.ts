const REFRACTABLE_VARYINGS = [
  "v_objectUV",
  "v_responsiveUV",
  "v_patternUV",
  "v_imageUV",
] as const;

const FLOAT_PRECISION_PATTERN =
  /precision\s+(?:lowp|mediump|highp)\s+float\s*;/;

export const ZEN_GLASS_REFRACTION_FRAGMENT = String.raw`
uniform float u_zenGlassRefraction;
uniform vec4 u_zenGlassRect;
uniform float u_zenGlassCornerRadius;
uniform float u_zenUiSurfaceCount;
uniform vec4 u_zenUiSurfaceRects[32];
uniform vec4 u_zenUiSurfaceParams[32];

float zenUiSurfaceMaskCache = 0.0;

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

vec2 zenSafeNormalize(vec2 value) {
  float lengthSquared = dot(value, value);
  return lengthSquared > 0.00001
    ? value * inversesqrt(lengthSquared)
    : vec2(0.0);
}

float zenGlassEdgeDistortion(float insideDistancePx, float depthPx) {
  float edgeProximity =
    1.0 - clamp(insideDistancePx / max(depthPx, 1.0), 0.0, 1.0);
  return 1.0 - sqrt(max(1.0 - edgeProximity * edgeProximity, 0.0));
}

vec2 zenGlassRegionOffsetPixels(
  vec4 glassRect,
  float glassCornerRadius,
  out float surfaceMask
) {
  surfaceMask = 0.0;
  if (
    glassRect.z <= glassRect.x ||
    glassRect.w <= glassRect.y
  ) {
    return vec2(0.0);
  }

  vec2 resolution = max(u_resolution, vec2(1.0));
  float pixelRatio = max(u_pixelRatio, 1.0);
  vec2 glassMinPx = glassRect.xy * resolution;
  vec2 glassMaxPx = glassRect.zw * resolution;
  if (
    any(lessThan(gl_FragCoord.xy, glassMinPx)) ||
    any(greaterThan(gl_FragCoord.xy, glassMaxPx))
  ) {
    return vec2(0.0);
  }
  vec2 glassSizePx = glassMaxPx - glassMinPx;
  vec2 glassCenterPx = (glassMinPx + glassMaxPx) * 0.5;
  float cornerRadiusPx = min(
    max(0.0, glassCornerRadius * pixelRatio),
    min(glassSizePx.x, glassSizePx.y) * 0.5
  );
  float signedDistance = zenRoundedRectSignedDistance(
    gl_FragCoord.xy - glassCenterPx,
    glassSizePx * 0.5,
    cornerRadiusPx
  );
  float antialias = max(fwidth(signedDistance), 0.75);
  surfaceMask =
    1.0 - smoothstep(-antialias, antialias, signedDistance);
  if (
    signedDistance > 0.0 ||
    u_zenGlassRefraction <= 0.00001
  ) {
    return vec2(0.0);
  }

  float refractionDepthPx = min(
    48.0 * pixelRatio,
    max(glassSizePx.x, glassSizePx.y) * 0.25
  );
  if (-signedDistance >= refractionDepthPx) return vec2(0.0);
  float distortion = zenGlassEdgeDistortion(
    -signedDistance,
    refractionDepthPx
  );
  if (distortion <= 0.00001) return vec2(0.0);

  // Shift the sample toward this surface's centre. This keeps the apparent
  // bend inside each independent Glass card.
  return -zenSafeNormalize(gl_FragCoord.xy - glassCenterPx) *
    distortion *
    u_zenGlassRefraction *
    pixelRatio;
}

vec2 zenGlassOffsetPixels() {
  zenUiSurfaceMaskCache = 0.0;
  if (
    u_zenGlassRefraction <= 0.00001 &&
    u_zenContrastGuardEnabled < 0.5
  ) {
    return vec2(0.0);
  }

  float editorMask;
  vec2 strongestOffset = zenGlassRegionOffsetPixels(
    u_zenGlassRect,
    u_zenGlassCornerRadius,
    editorMask
  );
  float strongestLength = dot(strongestOffset, strongestOffset);
  for (int index = 0; index < 32; index += 1) {
    if (float(index) >= u_zenUiSurfaceCount) break;
    float candidateMask;
    vec2 candidate = zenGlassRegionOffsetPixels(
      u_zenUiSurfaceRects[index],
      u_zenUiSurfaceParams[index].x,
      candidateMask
    );
    zenUiSurfaceMaskCache = max(zenUiSurfaceMaskCache, candidateMask);
    float candidateLength = dot(candidate, candidate);
    if (candidateLength > strongestLength) {
      strongestOffset = candidate;
      strongestLength = candidateLength;
    }
  }
  return strongestOffset;
}
`;

interface RefractablePaperFragment {
  fragment: string;
  coordinateSetup: string;
}

/**
 * Paper shaders derive their color from vertex-provided UVs and, in a few
 * cases, gl_FragCoord. Keep the vertex interface intact, but redirect shader
 * reads to mutable copies so the final main can evaluate the procedural
 * background at an optically displaced coordinate without a framebuffer
 * readback or a second DOM canvas.
 */
export function makePaperFragmentRefractable(
  source: string,
): RefractablePaperFragment {
  const declarations: Array<{
    placeholder: string;
    declaration: string;
    precision: string;
    name: (typeof REFRACTABLE_VARYINGS)[number];
  }> = [];
  const varyingPattern = new RegExp(
    String.raw`\bin\s+((?:(?:lowp|mediump|highp)\s+)?)vec2\s+(${REFRACTABLE_VARYINGS.join("|")})\s*;`,
    "g",
  );

  let fragment = source.replace(
    varyingPattern,
    (declaration, precision: string, name: string) => {
      const placeholder = `__ZEN_REFRACTABLE_VARYING_${declarations.length}__`;
      declarations.push({
        placeholder,
        declaration,
        precision,
        name: name as (typeof REFRACTABLE_VARYINGS)[number],
      });
      return placeholder;
    },
  );

  for (const { name } of declarations) {
    fragment = fragment.replace(
      new RegExp(String.raw`\b${name}\b`, "g"),
      `zenPaper_${name}`,
    );
  }
  fragment = fragment.replace(/\bgl_FragCoord\b/g, "zenPaperFragCoord");

  for (const { placeholder, declaration, precision, name } of declarations) {
    fragment = fragment.replace(
      placeholder,
      `${declaration}\n${precision}vec2 zenPaper_${name};`,
    );
  }

  if (FLOAT_PRECISION_PATTERN.test(fragment)) {
    fragment = fragment.replace(
      FLOAT_PRECISION_PATTERN,
      (precision) => `${precision}\nvec4 zenPaperFragCoord;`,
    );
  } else {
    fragment = fragment.replace(
      /^(#version[^\n]*\n)?/,
      (version = "") =>
        `${version}precision mediump float;\nvec4 zenPaperFragCoord;\n`,
    );
  }

  const setup = [
    "vec2 zenGlassOffset = zenGlassOffsetPixels();",
    "zenPaperFragCoord = gl_FragCoord + vec4(zenGlassOffset, 0.0, 0.0);",
    ...declarations.map(
      ({ name }) =>
        `zenPaper_${name} = ${name} + dFdx(${name}) * zenGlassOffset.x + dFdy(${name}) * zenGlassOffset.y;`,
    ),
  ].join("\n  ");

  return { fragment, coordinateSetup: setup };
}
