import { describe, expect, it } from "vitest";
import {
  ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT,
  buildZenShaderResearchSceneFragment,
  resolveZenShaderResearchRenderPipeline,
} from "./zenShaderResearchPipeline";

const PAPER_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.25, 0.5, 0.75, 1.0);
}`;

describe("Zen shader research pipeline", () => {
  it("keeps the raw Paper fragment byte-for-byte when scene effects are disabled", () => {
    expect(
      buildZenShaderResearchSceneFragment(PAPER_FRAGMENT, {
        dither: false,
        halftone: false,
      }),
    ).toBe(PAPER_FRAGMENT);
  });

  it("compile-time removes each disabled scene effect from the measured main path", () => {
    const ditherOnly = buildZenShaderResearchSceneFragment(PAPER_FRAGMENT, {
      dither: true,
      halftone: false,
    });
    const halftoneOnly = buildZenShaderResearchSceneFragment(PAPER_FRAGMENT, {
      dither: false,
      halftone: true,
    });

    expect(ditherOnly).toContain(
      "sceneColor.rgb = applyZenDither(sceneColor.rgb);",
    );
    expect(ditherOnly).not.toContain(
      "sceneColor.rgb = applyZenColorHalftone(sceneColor.rgb);",
    );
    expect(halftoneOnly).not.toContain(
      "sceneColor.rgb = applyZenDither(sceneColor.rgb);",
    );
    expect(halftoneOnly).toContain(
      "sceneColor.rgb = applyZenColorHalftone(sceneColor.rgb);",
    );
  });

  it("maps raw to direct rendering and keeps scene/full on the FBO path", () => {
    expect(resolveZenShaderResearchRenderPipeline("raw")).toBe("direct");
    expect(resolveZenShaderResearchRenderPipeline("scene")).toBe("multipass");
    expect(resolveZenShaderResearchRenderPipeline("full")).toBe("multipass");
  });

  it("uses a true passthrough composite for the scene path", () => {
    expect(ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT).toContain(
      "uniform sampler2D u_sceneTexture;",
    );
    expect(ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT).toContain(
      "fragColor = texture(u_sceneTexture, v_uv);",
    );
    expect(ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT).not.toMatch(
      /Glass|Contrast|u_blurredTexture/i,
    );
  });
});
