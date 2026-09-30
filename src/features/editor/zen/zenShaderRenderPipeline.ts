import type { ZenShaderConfig } from "./zenShaderConfig";

export type ZenShaderRenderPipeline = "direct" | "multipass";

export function resolveZenShaderRenderPipeline(
  config: ZenShaderConfig,
): ZenShaderRenderPipeline {
  return config.resolutionMode === "native" &&
    !config.glass.enabled &&
    config.contrastGuard.mode === "none" &&
    config.opacity === 100
    ? "direct"
    : "multipass";
}
