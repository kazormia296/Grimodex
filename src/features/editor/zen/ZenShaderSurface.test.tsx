// @vitest-environment happy-dom
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperShaderElement } from "@paper-design/shaders";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import { ZenShaderSurface } from "./ZenShaderSurface";
import type { ZenShaderLayouts } from "./useZenShaderLayouts";

const shaderLifecycle = vi.hoisted(() => ({
  mounted: [] as string[],
  unmounted: [] as string[],
  mountedCapacities: [] as number[],
  unmountedCapacities: [] as number[],
  mountedUniformLengths: [] as number[],
  props: [] as Array<{ maxPixelCount: number; speed: number }>,
  antiAliasing: [] as Array<{ minPixelRatio: number; antialias: boolean }>,
  animation: [] as Array<{ playing: boolean; speed: number }>,
  drawCount: 1,
  staticFrameReady: true,
}));
const shaderLayouts = vi.hoisted(() => ({
  current: null as unknown as ZenShaderLayouts,
}));

vi.mock("./useZenShaderLayouts", () => ({
  useZenShaderLayouts: () => shaderLayouts.current,
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
    ShaderMount: forwardRef<
      PaperShaderElement,
      {
        "data-paper-shader": string;
        maxPixelCount: number;
        speed: number;
        minPixelRatio: number;
        webGlContextAttributes?: WebGLContextAttributes;
        fragmentShader: string;
        uniforms: Record<string, unknown>;
      }
    >(function MockShaderMount(
      {
        "data-paper-shader": shader,
        maxPixelCount,
        speed,
        minPixelRatio,
        webGlContextAttributes,
        fragmentShader,
        uniforms,
      },
      forwardedRef,
    ) {
      const elementRef = useRef<HTMLDivElement>(null);
      const mountedShader = useRef(shader).current;
      const mountedCapacity = useRef(
        Number(/u_zenUiSurfaceRects\[(\d+)\]/.exec(fragmentShader)?.[1] ?? 0),
      ).current;
      const mountedUniformLength = useRef(
        uniforms["u_zenUiSurfaceRects[0]"] instanceof Float32Array
          ? uniforms["u_zenUiSurfaceRects[0]"].length
          : 0,
      ).current;
      shaderLifecycle.props.push({ maxPixelCount, speed });
      shaderLifecycle.antiAliasing.push({
        minPixelRatio,
        antialias: webGlContextAttributes?.antialias ?? false,
      });
      useImperativeHandle(forwardedRef, () => {
        const element = elementRef.current as unknown as PaperShaderElement;
        element.paperShaderMount = {
          getPerformanceStats: () => ({
            drawCount: shaderLifecycle.drawCount,
            gpuTimeMs: null,
            isStaticFrameReady: shaderLifecycle.staticFrameReady,
          }),
        } as NonNullable<PaperShaderElement["paperShaderMount"]>;
        return element;
      }, []);

      useEffect(() => {
        shaderLifecycle.mounted.push(mountedShader);
        shaderLifecycle.mountedCapacities.push(mountedCapacity);
        shaderLifecycle.mountedUniformLengths.push(mountedUniformLength);
        return () => {
          shaderLifecycle.unmounted.push(mountedShader);
          shaderLifecycle.unmountedCapacities.push(mountedCapacity);
        };
      }, [mountedCapacity, mountedShader, mountedUniformLength]);

      return <div ref={elementRef} data-paper-shader={shader} />;
    }),
  };
});

vi.mock("./zenThemePalette", () => ({
  useZenThemePalette: () => ({
    background: "#101318",
    colors: ["#8fb4d6", "#d6b5a5", "#786fa6", "#d8c47c"],
  }),
}));

function layoutsWithUiSurfaceCount(count: number): ZenShaderLayouts {
  return {
    surfaceSize: { width: 1_000, height: 600 },
    contrast: { rect: [0, 0, 0, 0], feather: [0, 0, 0, 0] },
    glass: {
      rect: [0, 0, 0, 0],
      feather: [0, 0, 0, 0],
      cornerRadius: 0,
    },
    uiSurfaces: Array.from({ length: count }, (_, index) => ({
      rect: [index / count, 0, (index + 1) / count, 0.1],
      feather: [0, 0, 0, 0],
      cornerRadius: 0,
    })),
  };
}

describe("ZenShaderSurface", () => {
  beforeEach(() => {
    shaderLayouts.current = layoutsWithUiSurfaceCount(0);
    shaderLifecycle.mounted.length = 0;
    shaderLifecycle.unmounted.length = 0;
    shaderLifecycle.mountedCapacities.length = 0;
    shaderLifecycle.unmountedCapacities.length = 0;
    shaderLifecycle.mountedUniformLengths.length = 0;
    shaderLifecycle.props.length = 0;
    shaderLifecycle.antiAliasing.length = 0;
    shaderLifecycle.animation.length = 0;
    shaderLifecycle.drawCount = 1;
    shaderLifecycle.staticFrameReady = true;
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

    expect(shaderLifecycle.mounted).toEqual([
      ZEN_SHADER_DEFAULTS.shader,
      "warp",
    ]);
    expect(shaderLifecycle.unmounted).toEqual([ZEN_SHADER_DEFAULTS.shader]);
  });

  it("grows the Paper mount when the UI surface capacity exceeds its high-water mark", () => {
    shaderLayouts.current = layoutsWithUiSurfaceCount(16);
    const view = render(
      <ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />,
    );

    shaderLayouts.current = layoutsWithUiSurfaceCount(17);
    view.rerender(<ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />);

    expect(shaderLifecycle.mountedCapacities).toEqual([16, 32]);
    expect(shaderLifecycle.mountedUniformLengths).toEqual([64, 128]);
    expect(shaderLifecycle.unmountedCapacities).toEqual([16]);
  });

  it("keeps the Paper mount when the UI surface count drops from nine to eight", () => {
    shaderLayouts.current = layoutsWithUiSurfaceCount(9);
    const view = render(
      <ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />,
    );
    const mountedShader = view.container.querySelector("[data-paper-shader]");

    shaderLayouts.current = layoutsWithUiSurfaceCount(8);
    view.rerender(<ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />);

    expect(shaderLifecycle.mountedCapacities).toEqual([16]);
    expect(shaderLifecycle.mountedUniformLengths).toEqual([64]);
    expect(shaderLifecycle.unmountedCapacities).toEqual([]);
    expect(view.container.querySelector("[data-paper-shader]")).toBe(
      mountedShader,
    );
  });

  it("exposes the effective GPU refraction for live diagnostics", () => {
    const { container, rerender } = render(
      <ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />,
    );

    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute(
      "data-glass-refraction",
      String(ZEN_SHADER_DEFAULTS.glass.refraction),
    );
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

  it("uses one native pixel per CSS pixel up to Full HD", async () => {
    const { rerender } = render(
      <ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />,
    );

    expect(shaderLifecycle.props.at(-1)).toEqual({
      maxPixelCount: 2_073_600,
      speed: 0,
    });
    await waitFor(() =>
      expect(shaderLifecycle.animation.at(-1)).toMatchObject({
        playing: true,
        speed: ZEN_SHADER_DEFAULTS.speed / 100,
      }),
    );

    rerender(
      <ZenShaderSurface
        config={{ ...ZEN_SHADER_DEFAULTS, shader: "dot-grid" }}
        playing
      />,
    );

    expect(shaderLifecycle.props.at(-1)).toEqual({
      maxPixelCount: 2_073_600,
      speed: 0,
    });
    expect(shaderLifecycle.animation.at(-1)).toMatchObject({
      playing: false,
    });
  });

  it("uses the shader's analytic antialiasing without WebGL MSAA", () => {
    render(<ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing />);

    expect(shaderLifecycle.antiAliasing.at(-1)).toEqual({
      minPixelRatio: 1,
      antialias: false,
    });
    expect(shaderLifecycle.props.at(-1)).toEqual({
      maxPixelCount: 2_073_600,
      speed: 0,
    });
  });

  it("keeps previews at the smaller pixel budget", () => {
    render(<ZenShaderSurface config={ZEN_SHADER_DEFAULTS} playing preview />);

    expect(shaderLifecycle.props.at(-1)).toEqual({
      maxPixelCount: 300_000,
      speed: 0,
    });
  });

  it("uses the static fallback without mounting Paper or shared Glass when WebGL2 is unavailable", async () => {
    shaderLayouts.current = layoutsWithUiSurfaceCount(1);
    const onRendererStatusChange = vi.fn();
    const { container } = render(
      <ZenShaderSurface
        config={ZEN_SHADER_DEFAULTS}
        playing
        webGlSupported={false}
        onRendererStatusChange={onRendererStatusChange}
      />,
    );

    await waitFor(() =>
      expect(onRendererStatusChange).toHaveBeenLastCalledWith(
        "fallback-unsupported",
      ),
    );
    expect(container.querySelector("[data-paper-shader]")).toBeNull();
    expect(container.querySelector("[data-zen-glass-compositor]")).toBeNull();
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-zen-shader-renderer", "fallback-unsupported");
  });

  it("enables shared Glass only after the first frame settles and removes it after context loss", async () => {
    shaderLayouts.current = layoutsWithUiSurfaceCount(1);
    shaderLifecycle.staticFrameReady = false;
    const onRendererStatusChange = vi.fn();
    const { container } = render(
      <ZenShaderSurface
        config={ZEN_SHADER_DEFAULTS}
        playing
        onRendererStatusChange={onRendererStatusChange}
      />,
    );

    expect(container.querySelector("[data-zen-glass-compositor]")).toBeNull();
    expect(onRendererStatusChange).toHaveBeenLastCalledWith("initializing");

    shaderLifecycle.staticFrameReady = true;
    await waitFor(() => {
      expect(container.querySelector("[data-zen-glass-compositor]")).not.toBe(
        null,
      );
      expect(onRendererStatusChange).toHaveBeenLastCalledWith("webgl");
    });

    container
      .querySelector("[data-paper-shader]")
      ?.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    await waitFor(() => {
      expect(container.querySelector("[data-zen-glass-compositor]")).toBeNull();
      expect(onRendererStatusChange).toHaveBeenLastCalledWith(
        "fallback-context-lost",
      );
    });
  });
});
