export const ZEN_SHADER_RESOLUTION_MODES = [
  "native",
  "balanced",
  "performance",
] as const;

export type ZenShaderResolutionMode =
  (typeof ZEN_SHADER_RESOLUTION_MODES)[number];

const ZEN_SHADER_SCENE_SCALES = {
  native: 1,
  balanced: 3 / 4,
  performance: 2 / 3,
} as const satisfies Record<ZenShaderResolutionMode, number>;

export function resolveZenShaderSceneScale(mode: ZenShaderResolutionMode) {
  return ZEN_SHADER_SCENE_SCALES[mode];
}
