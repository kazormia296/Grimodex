// @vitest-environment happy-dom
import { forwardRef } from "react";
import { render } from "@testing-library/react";
import type { PaperShaderElement } from "@paper-design/shaders";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS } from "./zenBlurResearchConfig";
import { ZenShaderResearchSurface } from "./ZenShaderResearchSurface";

const canvasProps = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("./ZenBlurResearchCanvas", () => ({
  ZenBlurResearchCanvas: forwardRef<
    PaperShaderElement,
    Record<string, unknown>
  >(function MockZenBlurResearchCanvas(props, _ref) {
    canvasProps.current = props;
    return <div data-testid="research-canvas" />;
  }),
}));

vi.mock("./zenShaderImageUniforms", () => ({
  usePreparedZenShaderUniforms: (uniforms: unknown) => uniforms,
}));

const BASE_PROPS = {
  shader: "spiral" as const,
  pipeline: "raw" as const,
  dither: false,
  ditherStrength: 0.45,
  halftone: false,
  halftoneStrength: 0.3,
  contrast: false,
  glass: false,
  blur: 22,
  frame: 1_000,
  width: 1_920,
  height: 1_080,
  researchOptions: DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
};

describe("ZenShaderResearchSurface", () => {
  beforeEach(() => {
    canvasProps.current = null;
  });

  it("mounts a pure Paper fragment on the direct raw path", () => {
    render(<ZenShaderResearchSurface {...BASE_PROPS} />);

    expect(canvasProps.current).toMatchObject({
      renderPipeline: "direct",
      minPixelRatio: 1,
      maxPixelCount: 1_920 * 1_080,
      speed: 0,
    });
    const props = canvasProps.current as {
      sceneFragment: string;
      compositeFragment: string;
    };
    expect(props.sceneFragment).not.toContain("Scene pass:");
    expect(props.sceneFragment).not.toContain("applyZenDither");
    expect(props.compositeFragment).toContain(
      "fragColor = texture(u_sceneTexture, v_uv);",
    );
  });

  it("mounts the canonical Composite only for the full pipeline", () => {
    render(
      <ZenShaderResearchSurface
        {...BASE_PROPS}
        pipeline="full"
        dither
        contrast
      />,
    );

    expect(canvasProps.current).toMatchObject({
      renderPipeline: "multipass",
    });
    const props = canvasProps.current as {
      sceneFragment: string;
      compositeFragment: string;
      sceneUniforms: Record<string, unknown>;
      compositeUniforms: Record<string, unknown>;
    };
    expect(props.sceneFragment).toContain(
      "sceneColor.rgb = applyZenDither(sceneColor.rgb);",
    );
    expect(props.compositeFragment).toContain("applyZenFinalContrast");
    expect(props.compositeFragment).toContain("u_zenUiSurfaceRects[16]");
    expect(props.sceneUniforms.u_zenDitherStrength).toBe(0.45);
    expect(props.compositeUniforms.u_zenContrastGuardEnabled).toBe(1);
    expect(props.compositeUniforms.u_zenUiSurfaceCount).toBe(0);
  });

  it("activates the deterministic four-surface fixture only with Glass", () => {
    render(<ZenShaderResearchSurface {...BASE_PROPS} pipeline="full" glass />);

    const props = canvasProps.current as {
      compositeUniforms: Record<string, unknown>;
    };
    expect(props.compositeUniforms.u_zenUiSurfaceCount).toBe(4);
    expect(props.compositeUniforms.u_zenGlassEnabled).toBe(1);
  });
});
