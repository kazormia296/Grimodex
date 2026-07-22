// @vitest-environment happy-dom
import { useEffect, useRef } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import { ZenShaderSurface } from "./ZenShaderSurface";

const shaderLifecycle = vi.hoisted(() => ({
  mounted: [] as string[],
  unmounted: [] as string[],
}));

vi.mock("@paper-design/shaders-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@paper-design/shaders-react")>();

  return {
    ...actual,
    ShaderMount: ({
      "data-paper-shader": shader,
    }: {
      "data-paper-shader": string;
    }) => {
      const mountedShader = useRef(shader).current;

      useEffect(() => {
        shaderLifecycle.mounted.push(mountedShader);
        return () => {
          shaderLifecycle.unmounted.push(mountedShader);
        };
      }, [mountedShader]);

      return <div data-paper-shader={shader} />;
    },
  };
});

vi.mock("./zenThemePalette", () => ({
  useZenThemePalette: () => ({
    background: "#101318",
    colors: ["#8fb4d6", "#d6b5a5", "#786fa6", "#d8c47c"],
  }),
}));

describe("ZenShaderSurface", () => {
  beforeEach(() => {
    shaderLifecycle.mounted.length = 0;
    shaderLifecycle.unmounted.length = 0;
  });

  it("replaces the Paper mount when the shader type changes", () => {
    const { rerender } = render(
      <ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />,
    );

    rerender(
      <ZenShaderSurface
        config={{ ...ZEN_SHADER_DEFAULTS, shader: "warp" }}
        playing
      />,
    );

    expect(shaderLifecycle.mounted).toEqual(["mesh-gradient", "warp"]);
    expect(shaderLifecycle.unmounted).toEqual(["mesh-gradient"]);
  });
});
