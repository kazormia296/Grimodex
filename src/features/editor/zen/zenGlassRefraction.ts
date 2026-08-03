const REFRACTABLE_VARYINGS = [
  "v_objectUV",
  "v_responsiveUV",
  "v_patternUV",
  "v_imageUV",
] as const;

const FLOAT_PRECISION_PATTERN =
  /precision\s+(?:lowp|mediump|highp)\s+float\s*;/;

const ZEN_GLASS_REFRACTION_TEMPLATE = String.raw`
uniform float u_zenGlassRefraction;
uniform vec4 u_zenGlassRect;
uniform float u_zenGlassCornerRadius;
uniform float u_zenUiSurfaceCount;
uniform vec4 u_zenUiSurfaceRects[__ZEN_UI_SURFACE_CAPACITY__];
uniform vec4 u_zenUiSurfaceParams[__ZEN_UI_SURFACE_CAPACITY__];

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

vec2 zenRoundedRectOutwardNormal(
  vec2 point,
  vec2 halfSize,
  float cornerRadius
) {
  vec2 distanceFromStraightEdges =
    abs(point) - max(halfSize - vec2(cornerRadius), vec2(0.0));
  vec2 cornerVector = max(distanceFromStraightEdges, vec2(0.0));
  vec2 pointSign = mix(
    vec2(-1.0),
    vec2(1.0),
    step(vec2(0.0), point)
  );
  // Scale before normalizing so mediump precision cannot turn a small but
  // valid corner vector into a zero normal on large surfaces.
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

float zenGlassEdgeDistortion(float insideDistanceRatio, float depthRatio) {
  float edgeProximity =
    1.0 - clamp(insideDistanceRatio / max(depthRatio, 0.0001), 0.0, 1.0);
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
  // ShaderMount lowers u_pixelRatio below 1 when the pixel budget caps the
  // framebuffer. Preserve that effective CSS-to-framebuffer scale so rounded
  // Glass geometry stays aligned with the DOM surface.
  float pixelRatio = max(u_pixelRatio, 0.0001);
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
  vec2 glassHalfSizePx = glassSizePx * 0.5;
  // Evaluate the SDF in a unit-sized space. ShojiWM uses the same scaling
  // principle because mediump length() can lose corner precision (or
  // overflow its squared intermediate) on a large live-background surface.
  float sdfScale = max(max(glassSizePx.x, glassSizePx.y), 1.0);
  float surfaceSizePx = max(min(glassSizePx.x, glassSizePx.y), 1.0);
  float cornerRadiusPx = min(
    max(0.0, glassCornerRadius * pixelRatio),
    min(glassSizePx.x, glassSizePx.y) * 0.5
  );
  vec2 glassCoord = (gl_FragCoord.xy - glassCenterPx) / sdfScale;
  float normalizedCornerRadius = cornerRadiusPx / sdfScale;
  vec2 normalizedHalfSize = glassHalfSizePx / sdfScale;
  float normalizedSignedDistance = zenRoundedRectSignedDistance(
    glassCoord,
    normalizedHalfSize,
    normalizedCornerRadius
  );
  float signedDistancePx = normalizedSignedDistance * sdfScale;
  vec2 outwardNormal = zenRoundedRectOutwardNormal(
    glassCoord,
    normalizedHalfSize,
    normalizedCornerRadius
  );
  // This SDF is measured in framebuffer pixels, so the L1 norm of its
  // analytic unit normal is the exact one-pixel footprint approximation that
  // fwidth would produce without relying on derivatives in divergent flow.
  float antialias =
    max(abs(outwardNormal.x) + abs(outwardNormal.y), 0.75);
  surfaceMask =
    1.0 - smoothstep(-antialias, antialias, signedDistancePx);
  if (
    signedDistancePx > 0.0 ||
    u_zenGlassRefraction <= 0.00001
  ) {
    return vec2(0.0);
  }

  // Keep the displacement continuous through the antialiased boundary. The
  // old hard outside/inside split made the first covered pixel jump from zero
  // to the full edge distortion, which showed up as a coloured spike at
  // rounded corners.
  float insideDistancePx = max(-signedDistancePx, 0.0);
  float insideDistanceRatio = max(
    -normalizedSignedDistance * sdfScale / surfaceSizePx,
    0.0
  );
  vec2 cornerDistance =
    abs(glassCoord) -
    max(
      glassHalfSizePx / sdfScale - vec2(normalizedCornerRadius),
      vec2(0.0)
    );
  bool fullyRounded =
    cornerRadiusPx >= glassHalfSizePx.x - 0.00001 &&
    cornerRadiusPx >= glassHalfSizePx.y - 0.00001;
  // Do not switch corner handling on the x/y axes. That boolean split made
  // the refraction visibly stop at a right angle where the rounded arc meets
  // a straight edge. Blend the local corner limit in over the arc instead.
  float cornerWeight = 0.0;
  if (cornerRadiusPx > 0.00001) {
    if (fullyRounded) {
      cornerWeight = 1.0;
    } else {
      float cornerTransition = min(cornerDistance.x, cornerDistance.y);
      float cornerFeather = max(
        1.0 / sdfScale,
        normalizedCornerRadius * 0.25
      );
      cornerWeight = smoothstep(0.0, cornerFeather, cornerTransition);
    }
  }
  float boundaryFeatherPx = max(
    0.75,
    min(1.5 * pixelRatio, antialias)
  );
  float boundaryFade = smoothstep(
    0.0,
    boundaryFeatherPx,
    insideDistancePx
  );
  // Express the existing pixel depth as a surface-relative value, as in
  // ShojiWM. Keeping the conversion here avoids large-coordinate precision
  // loss without changing the configured look of the Glass control.
  float refractionDepthPx = min(
    48.0 * pixelRatio,
    max(glassSizePx.x, glassSizePx.y) * 0.25
  );
  float refractionDepthRatio = refractionDepthPx / surfaceSizePx;
  if (insideDistanceRatio >= refractionDepthRatio) return vec2(0.0);
  float distortion = zenGlassEdgeDistortion(
    insideDistanceRatio,
    refractionDepthRatio
  );
  if (distortion <= 0.00001) return vec2(0.0);

  // Shift along the inward normal of the rounded SDF. A vector toward the
  // rectangle centre becomes diagonal on straight edges and can pull a
  // neighbouring colour into the corner as a visible spike.
  vec2 inwardNormal = -outwardNormal;
  // Keep the configured pixel amount for large surfaces. The rounded-corner
  // band below supplies the size-relative ceiling that prevents a small
  // circular control from sampling through its opposite side.
  float maxDisplacementPx = max(u_zenGlassRefraction * pixelRatio, 0.0);
  float displacementPx = distortion * maxDisplacementPx * boundaryFade;
  // A small rounded surface can be smaller than the configured refraction
  // distance. In that case a corner sample can cross its local arc and pull
  // colour from the opposite side, creating a wedge. Blend the local radial
  // half-band continuously through the corner instead of switching it on at
  // a geometric quadrant.
  float cornerLimitedDisplacement = min(
    displacementPx,
    max(0.75, length(cornerDistance) * sdfScale * 0.5)
  );
  displacementPx = mix(
    displacementPx,
    cornerLimitedDisplacement,
    cornerWeight
  );
  return inwardNormal * displacementPx;
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
  for (int index = 0; index < __ZEN_UI_SURFACE_CAPACITY__; index += 1) {
    if (float(index) >= u_zenUiSurfaceCount) break;
    float candidateMask;
    vec2 candidate = zenGlassRegionOffsetPixels(
      u_zenUiSurfaceRects[index],
      u_zenUiSurfaceParams[index].x,
      candidateMask
    );
    float visibleCandidateMask =
      u_zenUiSurfaceParams[index].y < 0.5
        ? candidateMask * editorMask
        : candidateMask;
    zenUiSurfaceMaskCache = max(
      zenUiSurfaceMaskCache,
      visibleCandidateMask
    );
    if (u_zenUiSurfaceParams[index].y < 0.5) continue;
    float candidateLength = dot(candidate, candidate);
    if (candidateLength > strongestLength) {
      strongestOffset = candidate;
      strongestLength = candidateLength;
    }
  }
  return strongestOffset;
}
`;

export function zenUiSurfaceVariantCapacity(surfaceCount: number) {
  return [1, 4, 8, 16, 32].find((capacity) => surfaceCount <= capacity) ?? 32;
}

export function buildZenGlassRefractionFragment(surfaceCapacity = 32) {
  const capacity = zenUiSurfaceVariantCapacity(surfaceCapacity);
  return ZEN_GLASS_REFRACTION_TEMPLATE.replaceAll(
    "__ZEN_UI_SURFACE_CAPACITY__",
    String(capacity),
  );
}

export const ZEN_GLASS_REFRACTION_FRAGMENT = buildZenGlassRefractionFragment();

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
