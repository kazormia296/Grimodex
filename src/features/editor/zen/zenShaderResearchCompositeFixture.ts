import type { ZenPostProcessRuntime } from "./zenPostProcessing";
import type { ZenGlassLayout } from "./useZenShaderLayouts";

export const ZEN_SHADER_RESEARCH_COMPOSITE_FIXTURE_ID = "desktop-reference-v1";
export const ZEN_SHADER_RESEARCH_UI_SURFACE_CAPACITY = 16;
export const ZEN_SHADER_RESEARCH_REFERENCE_UI_SURFACES = [
  {
    rect: [0, 1 / 3, 0.2, 5 / 6],
    feather: [0, 0, 0, 0],
    cornerRadius: 18,
    refracts: true,
  },
  {
    rect: [0, 14 / 15, 1, 1],
    feather: [0, 0, 0, 0],
    cornerRadius: 18,
    refracts: true,
  },
  {
    rect: [0.3, 5 / 6, 0.7, 0.9],
    feather: [0, 0, 0, 0],
    cornerRadius: 0,
    refracts: false,
  },
  {
    rect: [0.58, 0.1, 0.7, 5 / 6],
    feather: [0, 0, 0, 0],
    cornerRadius: 0,
    refracts: false,
  },
] satisfies readonly ZenGlassLayout[];
export const ZEN_SHADER_RESEARCH_COMPOSITE_RUNTIME = {
  rect: [0.4, 1 / 3, 0.6, 11 / 15],
  feather: [0.048, 0.08, 0.048, 0.08],
  glassRect: [0.3, 0.1, 0.7, 0.9],
  glassCornerRadius: 0,
  textColor: [0.9, 0.9, 0.9],
  uiTextColor: [0.75, 0.75, 0.75],
  backdropColor: [0.04, 0.05, 0.07],
} satisfies Omit<ZenPostProcessRuntime, "uiSurfaces">;
