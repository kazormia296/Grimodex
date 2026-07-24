import { describe, expect, it } from "vitest";
import {
  buildZenPostProcessUniforms,
  buildZenPostProcessedFragment,
} from "./zenPostProcessing";
import { parseZenShaderConfig } from "./zenShaderConfig";

const PAPER_FRAGMENT = `#version 300 es
precision mediump float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.2, 0.4, 0.8, 1.0);
}`;

const REFRACTABLE_PAPER_FRAGMENT = `#version 300 es
precision mediump float;
uniform vec2 u_resolution;
in vec2 v_objectUV;
out vec4 fragColor;
void main() {
  vec2 screenUv = gl_FragCoord.xy / u_resolution;
  fragColor = vec4(v_objectUV + screenUv, 0.0, 1.0);
}`;

describe("Zen shader post-processing", () => {
  it("keeps Paper's GLSL version header and wraps its output in one final main", () => {
    const combined = buildZenPostProcessedFragment(PAPER_FRAGMENT);

    expect(combined.startsWith("#version 300 es")).toBe(true);
    expect(combined).toContain("void paperShaderMain()");
    expect(combined).toContain("uniform float u_zenDitherStrength");
    expect(combined).toContain("uniform float u_zenHalftoneStrength");
    expect(combined).toContain("uniform float u_zenContrastGuardEnabled");
    expect(combined).toContain("uniform float u_zenContrastTarget");
    expect(combined).toContain("uniform float u_zenGlassRefraction");
    expect(combined).toContain("uniform vec4 u_zenGlassRect");
    expect(combined).toContain("uniform float u_zenGlassCornerRadius");
    expect(combined).toContain("uniform float u_zenUiSurfaceCount");
    expect(combined).toContain("uniform vec4 u_zenUiSurfaceRects[32]");
    expect(combined).toContain("uniform vec4 u_zenUiSurfaceParams[32]");
    expect(combined).toContain("uniform vec3 u_zenUiContrastTextColor");
    expect(combined).toContain("uniform float u_zenUiContrastMix");
    expect(combined).toContain("applyZenDither");
    expect(combined).toContain("applyZenColorHalftone");
    expect(combined).toContain("applyZenContrastGuard");
    expect(combined).toContain(
      "if (u_zenDitherStrength <= 0.00001) return color;",
    );
    expect(combined).toContain(
      "if (u_zenHalftoneStrength <= 0.00001) return color;",
    );
    expect(combined).toContain("zenGlassOffsetPixels");
    expect(combined).toContain("zenRoundedRectSignedDistance");
    expect(combined).toContain("max(u_pixelRatio, 0.0001)");
    expect(combined).toContain("any(lessThan(gl_FragCoord.xy, glassMinPx))");
    expect(combined).toContain("any(greaterThan(gl_FragCoord.xy, glassMaxPx))");
    expect(combined).toContain(
      "if (-signedDistance >= refractionDepthPx) return vec2(0.0);",
    );
    expect(combined).toContain("smoothstep(edge - feather, edge, value)");
    expect(combined).toContain("smoothstep(edge, edge + feather, value)");
    expect(combined.match(/void main\s*\(\s*\)/g)).toHaveLength(1);
    const finalMain = combined.slice(combined.lastIndexOf("void main()"));
    expect(finalMain.indexOf("paperShaderMain();")).toBeLessThan(
      finalMain.indexOf("applyZenDither"),
    );
    expect(finalMain.indexOf("applyZenDither")).toBeLessThan(
      finalMain.indexOf("applyZenColorHalftone"),
    );
    expect(finalMain.indexOf("applyZenColorHalftone")).toBeLessThan(
      finalMain.indexOf("applyZenContrastGuard"),
    );
  });

  it("re-evaluates Paper at displaced coordinates while keeping its vertex interface intact", () => {
    const combined = buildZenPostProcessedFragment(REFRACTABLE_PAPER_FRAGMENT);

    expect(combined).toContain("in vec2 v_objectUV;");
    expect(combined).toContain("vec2 zenPaper_v_objectUV;");
    expect(combined).toContain("vec4 zenPaperFragCoord;");
    expect(combined).toContain(
      "zenPaperFragCoord = gl_FragCoord + vec4(zenGlassOffset, 0.0, 0.0);",
    );
    expect(combined).toContain(
      "zenPaper_v_objectUV = v_objectUV + dFdx(v_objectUV) * zenGlassOffset.x + dFdy(v_objectUV) * zenGlassOffset.y;",
    );
    expect(combined).toContain(
      "vec2 screenUv = zenPaperFragCoord.xy / u_resolution;",
    );
    expect(combined).toContain(
      "fragColor = vec4(zenPaper_v_objectUV + screenUv, 0.0, 1.0);",
    );

    const finalMain = combined.slice(combined.lastIndexOf("void main()"));
    expect(finalMain.indexOf("zenGlassOffsetPixels()")).toBeLessThan(
      finalMain.indexOf("paperShaderMain();"),
    );
  });

  it("reuses Paper's resolution uniform without redeclaring it", () => {
    const combined = buildZenPostProcessedFragment(
      PAPER_FRAGMENT.replace(
        "out vec4 fragColor;",
        "uniform mediump vec2 u_resolution;\nout vec4 fragColor;",
      ),
    );

    expect(
      combined.match(/uniform\s+(?:mediump\s+)?vec2\s+u_resolution/g),
    ).toHaveLength(1);
  });

  it("rejects an incompatible fragment instead of silently rendering blank", () => {
    expect(() =>
      buildZenPostProcessedFragment("#version 300 es\nout vec4 fragColor;"),
    ).toThrow(/main/i);
  });

  it("converts enabled filter controls to shader uniforms and zeros disabled effects", () => {
    const enabled = parseZenShaderConfig({
      "editor.zenBackground.dither.enabled": "true",
      "editor.zenBackground.dither.strength": "0.45",
      "editor.zenBackground.dither.size": "3",
      "editor.zenBackground.dither.levels": "5",
      "editor.zenBackground.halftone.enabled": "true",
      "editor.zenBackground.halftone.strength": "0.3",
      "editor.zenBackground.halftone.size": "11",
      "editor.zenBackground.halftone.angle": "17",
      "editor.zenBackground.halftone.softness": "0.2",
      "editor.zenBackground.contrastGuard.mode": "auto",
      "editor.zenBackground.contrastGuard.strength": "1",
      "editor.zenBackground.contrastGuard.toolMix": "0.68",
    });

    const uniforms = buildZenPostProcessUniforms(enabled, {
      rect: [0.2, 0.1, 0.8, 0.9],
      feather: [0.03, 0.04, 0.03, 0.04],
      glassRect: [0.1, 0.05, 0.9, 0.95],
      glassCornerRadius: 18,
      uiSurfaces: [
        {
          rect: [0, 0.2, 0.15, 0.8],
          feather: [0, 0, 0, 0],
          cornerRadius: 12,
        },
        {
          rect: [0.85, 0.2, 1, 0.8],
          feather: [0, 0, 0, 0],
          cornerRadius: 12,
        },
      ],
      textColor: [0.9, 0.92, 0.95],
      uiTextColor: [0.8, 0.82, 0.85],
      backdropColor: [0.04, 0.05, 0.07],
    });
    expect(uniforms).toMatchObject({
      u_zenDitherStrength: 0.45,
      u_zenDitherSize: 3,
      u_zenDitherLevels: 5,
      u_zenHalftoneStrength: 0.3,
      u_zenHalftoneSize: 11,
      u_zenHalftoneAngle: 17,
      u_zenHalftoneSoftness: 0.2,
      u_zenContrastGuardEnabled: 1,
      u_zenContrastTarget: 7,
      u_zenContrastRect: [0.2, 0.1, 0.8, 0.9],
      u_zenContrastFeather: [0.03, 0.04, 0.03, 0.04],
      u_zenContrastTextColor: [0.9, 0.92, 0.95],
      u_zenContrastBackdropColor: [0.04, 0.05, 0.07],
      u_zenContrastSurfaceOpacity: 0.1,
      u_zenGlassRefraction: 7,
      u_zenGlassRect: [0.1, 0.05, 0.9, 0.95],
      u_zenGlassCornerRadius: 18,
      u_zenUiSurfaceCount: 2,
      u_zenUiContrastTextColor: [0.8, 0.82, 0.85],
      u_zenUiContrastMix: 0.68,
    });
    expect(uniforms["u_zenUiSurfaceRects[0]"]).toHaveLength(32);
    expect(uniforms["u_zenUiSurfaceRects[0]"].slice(0, 2)).toEqual([
      [0, 0.2, 0.15, 0.8],
      [0.85, 0.2, 1, 0.8],
    ]);
    expect(uniforms["u_zenUiSurfaceParams[0]"].slice(0, 2)).toEqual([
      [12, 0, 0, 0],
      [12, 0, 0, 0],
    ]);

    const disabled = parseZenShaderConfig({
      "editor.zenBackground.contrastGuard.mode": "none",
      "editor.zenBackground.glass.enabled": "false",
    });
    expect(buildZenPostProcessUniforms(disabled)).toMatchObject({
      u_zenDitherStrength: 0,
      u_zenHalftoneStrength: 0,
      u_zenContrastGuardEnabled: 0,
      u_zenContrastTarget: 7,
      u_zenGlassRefraction: 0,
    });
  });
});
