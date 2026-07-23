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

float zenGlassEdgeProfile(float distancePx, float bandPx) {
  if (distancePx < 0.0) return 0.0;
  return 1.0 - smoothstep(0.0, max(1.0, bandPx), distancePx);
}

vec2 zenGlassOffsetPixels() {
  if (
    u_zenGlassRefraction <= 0.00001 ||
    u_zenGlassRect.z <= u_zenGlassRect.x ||
    u_zenGlassRect.w <= u_zenGlassRect.y
  ) {
    return vec2(0.0);
  }

  vec2 resolution = max(u_resolution, vec2(1.0));
  vec2 uv = gl_FragCoord.xy / resolution;
  float inside =
    step(u_zenGlassRect.x, uv.x) *
    step(u_zenGlassRect.y, uv.y) *
    step(uv.x, u_zenGlassRect.z) *
    step(uv.y, u_zenGlassRect.w);
  if (inside < 0.5) return vec2(0.0);

  float pixelRatio = max(u_pixelRatio, 1.0);
  float glassWidthPx = (u_zenGlassRect.z - u_zenGlassRect.x) * resolution.x;
  float glassHeightPx = (u_zenGlassRect.w - u_zenGlassRect.y) * resolution.y;
  float horizontalBandPx = min(48.0 * pixelRatio, glassWidthPx * 0.25);
  float verticalBandPx = min(48.0 * pixelRatio, glassHeightPx * 0.25);

  float left = zenGlassEdgeProfile(
    (uv.x - u_zenGlassRect.x) * resolution.x,
    horizontalBandPx
  );
  float bottom = zenGlassEdgeProfile(
    (uv.y - u_zenGlassRect.y) * resolution.y,
    verticalBandPx
  );
  float right = zenGlassEdgeProfile(
    (u_zenGlassRect.z - uv.x) * resolution.x,
    horizontalBandPx
  );
  float top = zenGlassEdgeProfile(
    (u_zenGlassRect.w - uv.y) * resolution.y,
    verticalBandPx
  );

  vec2 outward = vec2(right - left, top - bottom);
  float edgeAmount = min(length(outward), 1.0);
  if (edgeAmount <= 0.00001) return vec2(0.0);
  return normalize(outward) *
    edgeAmount *
    u_zenGlassRefraction *
    pixelRatio;
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
