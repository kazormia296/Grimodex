// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildZenPostProcessedFragment } from "./zenPostProcessing";
import {
  PAPER_SHADER_DEFINITIONS,
  PAPER_SHADER_IDS,
  resolvePaperShaderMount,
} from "./paperShaderCatalog";

describe("Paper shader catalog", () => {
  it("exposes all 29 Paper shaders with adjustable property metadata", () => {
    expect(PAPER_SHADER_IDS).toHaveLength(29);
    expect(PAPER_SHADER_DEFINITIONS).toHaveLength(29);
    expect(
      PAPER_SHADER_DEFINITIONS.every((item) => item.controls.length > 0),
    ).toBe(true);
  });

  it.each(PAPER_SHADER_IDS)("resolves official %s mount props", (shader) => {
    const mount = resolvePaperShaderMount(shader, {
      width: "100%",
      height: "100%",
    });

    expect(mount.fragmentShader).toContain("void main");
    expect(Object.keys(mount.uniforms).length).toBeGreaterThan(0);
    expect(() =>
      buildZenPostProcessedFragment(mount.fragmentShader),
    ).not.toThrow();
  });
});
