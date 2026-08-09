import { forwardRef, useMemo } from "react";
import type { PaperShaderElement } from "@paper-design/shaders";
import {
  resolvePaperShaderMount,
  type PaperShaderId,
} from "./paperShaderCatalog";
import {
  ZenBlurResearchCanvas,
  type ZenResearchRenderPipeline,
  type ZenResearchSceneOperation,
} from "./ZenBlurResearchCanvas";
import type { ZenBlurResearchOptions } from "./zenBlurResearchConfig";
import {
  buildZenShaderResearchConfig,
  ZEN_SHADER_RESEARCH_PALETTE,
} from "./zenShaderResearchConfig";
import {
  ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT,
  buildZenShaderResearchSceneFragment,
  resolveZenShaderResearchRenderPipeline,
  type ZenShaderResearchPipeline,
} from "./zenShaderResearchPipeline";
import { usePreparedZenShaderUniforms } from "./zenShaderImageUniforms";
import { buildZenShaderProps } from "./zenShaderConfig";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import {
  buildZenMultipassCompositeFragment,
  buildZenMultipassCompositeUniforms,
  buildZenMultipassSceneUniforms,
} from "./zenMultipassPipeline";
import type { ZenPostProcessRuntime } from "./zenPostProcessing";
import {
  ZEN_SHADER_RESEARCH_COMPOSITE_RUNTIME,
  ZEN_SHADER_RESEARCH_REFERENCE_UI_SURFACES,
  ZEN_SHADER_RESEARCH_UI_SURFACE_CAPACITY,
} from "./zenShaderResearchCompositeFixture";

const RESEARCH_WEBGL_CONTEXT_ATTRIBUTES = {
  alpha: true,
  antialias: false,
  powerPreference: "default",
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
} satisfies WebGLContextAttributes;

export interface ZenShaderResearchSurfaceProps {
  shader: PaperShaderId;
  pipeline: ZenShaderResearchPipeline;
  dither: boolean;
  ditherStrength: number;
  halftone: boolean;
  halftoneStrength: number;
  contrast: boolean;
  glass: boolean;
  blur: number;
  frame: number;
  width: number;
  height: number;
  pixelBudget?: number;
  sceneOperation?: ZenResearchSceneOperation;
  researchOptions: ZenBlurResearchOptions;
}

export const ZenShaderResearchSurface = forwardRef<
  PaperShaderElement,
  ZenShaderResearchSurfaceProps
>(function ZenShaderResearchSurface(
  {
    shader,
    pipeline,
    dither,
    ditherStrength,
    halftone,
    halftoneStrength,
    contrast,
    glass,
    blur,
    frame,
    width,
    height,
    pixelBudget,
    sceneOperation,
    researchOptions,
  },
  forwardedRef,
) {
  const config = useMemo(
    () =>
      buildZenShaderResearchConfig(shader, {
        dither,
        ditherStrength,
        halftone,
        halftoneStrength,
        contrast,
        glass,
        blur,
        frame,
      }),
    [
      blur,
      contrast,
      dither,
      ditherStrength,
      frame,
      glass,
      halftone,
      halftoneStrength,
      shader,
    ],
  );
  const resolved = useMemo(
    () =>
      resolvePaperShaderMount(
        shader,
        buildZenShaderProps(config, ZEN_SHADER_RESEARCH_PALETTE),
      ),
    [config, shader],
  );
  const sceneFragment = useMemo(
    () =>
      buildZenShaderResearchSceneFragment(resolved.fragmentShader, {
        dither,
        halftone,
      }),
    [dither, halftone, resolved.fragmentShader],
  );
  const sceneUniforms = useMemo(
    () => ({
      ...resolved.uniforms,
      ...buildZenMultipassSceneUniforms(config),
    }),
    [config, resolved.uniforms],
  );
  const preparedSceneUniforms = usePreparedZenShaderUniforms(sceneUniforms);
  const surfaceBuffer = useMemo(
    () =>
      new ZenUiSurfaceUniformBuffer(ZEN_SHADER_RESEARCH_UI_SURFACE_CAPACITY),
    [],
  );
  const compositeRuntime = useMemo<ZenPostProcessRuntime>(
    () => ({
      ...ZEN_SHADER_RESEARCH_COMPOSITE_RUNTIME,
      uiSurfaces: glass ? ZEN_SHADER_RESEARCH_REFERENCE_UI_SURFACES : [],
    }),
    [glass],
  );
  const compositeFragment = useMemo(
    () =>
      pipeline === "full"
        ? buildZenMultipassCompositeFragment(
            ZEN_SHADER_RESEARCH_UI_SURFACE_CAPACITY,
          )
        : ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT,
    [pipeline],
  );
  const compositeUniforms = useMemo(
    () =>
      buildZenMultipassCompositeUniforms(
        config,
        compositeRuntime,
        surfaceBuffer,
      ),
    [compositeRuntime, config, surfaceBuffer],
  );
  const renderPipeline: ZenResearchRenderPipeline =
    resolveZenShaderResearchRenderPipeline(pipeline);
  if (!preparedSceneUniforms) return null;

  return (
    <ZenBlurResearchCanvas
      ref={forwardedRef}
      data-paper-shader={`zen-shader-research:${shader}`}
      sceneFragment={sceneFragment}
      sceneUniforms={preparedSceneUniforms}
      compositeFragment={compositeFragment}
      compositeUniforms={compositeUniforms}
      mipmaps={resolved.mipmaps}
      minPixelRatio={1}
      maxPixelCount={pixelBudget ?? width * height}
      webGlContextAttributes={RESEARCH_WEBGL_CONTEXT_ATTRIBUTES}
      researchOptions={researchOptions}
      renderPipeline={renderPipeline}
      sceneOperation={sceneOperation}
      speed={0}
      style={{ position: "relative", width, height }}
      data-zen-glass-compositor={
        pipeline === "full" && glass ? "true" : undefined
      }
    />
  );
});
