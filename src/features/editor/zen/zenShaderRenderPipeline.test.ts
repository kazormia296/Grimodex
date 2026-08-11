import { describe, expect, it } from "vitest";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import { resolveZenShaderRenderPipeline } from "./zenShaderRenderPipeline";

describe("resolveZenShaderRenderPipeline", () => {
  const directConfig = {
    ...ZEN_SHADER_DEFAULTS,
    opacity: 100,
    glass: { ...ZEN_SHADER_DEFAULTS.glass, enabled: false },
    contrastGuard: {
      ...ZEN_SHADER_DEFAULTS.contrastGuard,
      mode: "none" as const,
    },
  };

  it("uses direct rendering only when the final Composite is an identity", () => {
    expect(resolveZenShaderRenderPipeline(directConfig)).toBe("direct");
  });

  it.each([
    {
      name: "Glass is enabled",
      config: {
        ...directConfig,
        glass: { ...directConfig.glass, enabled: true },
      },
    },
    {
      name: "Contrast Guard is enabled",
      config: {
        ...directConfig,
        contrastGuard: { ...directConfig.contrastGuard, mode: "auto" as const },
      },
    },
    {
      name: "opacity is below 100 percent",
      config: { ...directConfig, opacity: 99 },
    },
  ])("keeps the multipass path when $name", ({ config }) => {
    expect(resolveZenShaderRenderPipeline(config)).toBe("multipass");
  });
});
