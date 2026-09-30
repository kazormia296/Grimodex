import { buildZenMultipassSceneFragment } from "./zenMultipassPipeline";

export type ZenShaderResearchPipeline = "raw" | "scene" | "full";
export type ZenShaderResearchRenderPipeline = "direct" | "multipass";

export interface ZenShaderResearchSceneEffects {
  dither: boolean;
  halftone: boolean;
}

const DITHER_MAIN_CALL = "  sceneColor.rgb = applyZenDither(sceneColor.rgb);";
const HALFTONE_MAIN_CALL =
  "  sceneColor.rgb = applyZenColorHalftone(sceneColor.rgb);";

/**
 * Keeps A truly raw while compiling disabled Scene effects out of B/C/D.
 * Uncalled GLSL helpers may remain in the source, but they are absent from the
 * measured main path and can be removed by the driver compiler.
 */
export function buildZenShaderResearchSceneFragment(
  paperFragment: string,
  effects: Readonly<ZenShaderResearchSceneEffects>,
) {
  if (!effects.dither && !effects.halftone) return paperFragment;

  let fragment = buildZenMultipassSceneFragment(paperFragment);
  if (!effects.dither) fragment = fragment.replace(DITHER_MAIN_CALL, "");
  if (!effects.halftone) fragment = fragment.replace(HALFTONE_MAIN_CALL, "");
  return fragment;
}

export function resolveZenShaderResearchRenderPipeline(
  pipeline: ZenShaderResearchPipeline,
): ZenShaderResearchRenderPipeline {
  return pipeline === "raw" ? "direct" : "multipass";
}

export const ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sceneTexture;
void main() {
  fragColor = texture(u_sceneTexture, v_uv);
}`;
