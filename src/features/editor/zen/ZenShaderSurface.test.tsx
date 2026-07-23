// @vitest-environment happy-dom
import { useEffect, useRef } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import { ZenShaderSurface } from "./ZenShaderSurface";

const shaderLifecycle = vi.hoisted(() => ({
  mounted: [] as string[],
  unmounted: [] as string[],
  props: [] as Array<{ maxPixelCount: number; speed: number }>,
  animation: [] as Array<{ playing: boolean; speed: number }>,
}));

vi.mock("./zenShaderAnimation", () => ({
  useZenShaderAnimation: (
    _ref: unknown,
    options: { playing: boolean; speed: number },
  ) => {
    shaderLifecycle.animation.push(options);
  },
}));

vi.mock("@paper-design/shaders-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@paper-design/shaders-react")>();

  return {
    ...actual,
    ShaderMount: ({
      "data-paper-shader": shader,
      maxPixelCount,
      speed,
    }: {
      "data-paper-shader": string;
      maxPixelCount: number;
      speed: number;
    }) => {
      const mountedShader = useRef(shader).current;
      shaderLifecycle.props.push({ maxPixelCount, speed });

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
    shaderLifecycle.props.length = 0;
    shaderLifecycle.animation.length = 0;
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

  it("exposes the effective GPU refraction for live diagnostics", () => {
    const { container, rerender } = render(
      <ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />,
    );

    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-glass-refraction", "7");
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-glass-rect");

    rerender(
      <ZenShaderSurface
        config={{
          ...ZEN_SHADER_DEFAULTS,
          glass: { ...ZEN_SHADER_DEFAULTS.glass, enabled: false },
        }}
        playing
      />,
    );

    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-glass-refraction", "0");
  });

  it("uses the capped scheduler and bounded animated pixel budget", () => {
    const { rerender } = render(
      <ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />,
    );

    expect(shaderLifecycle.props.at(-1)).toEqual({
      maxPixelCount: 1_000_000,
      speed: 0,
    });
    expect(shaderLifecycle.animation.at(-1)).toMatchObject({
      playing: true,
      speed: 0.08,
    });

    rerender(
      <ZenShaderSurface
        config={{ ...ZEN_SHADER_DEFAULTS, shader: "dot-grid" }}
        playing
      />,
    );

    expect(shaderLifecycle.props.at(-1)).toEqual({
      maxPixelCount: 1_500_000,
      speed: 0,
    });
    expect(shaderLifecycle.animation.at(-1)).toMatchObject({
      playing: false,
    });
  });

  it("keeps previews at the smaller pixel budget", () => {
    render(<ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing preview />);

    expect(shaderLifecycle.props.at(-1)).toEqual({
      maxPixelCount: 300_000,
      speed: 0,
    });
  });
});
