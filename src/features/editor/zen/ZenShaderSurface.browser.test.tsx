import { render, waitFor } from "@testing-library/react";
import type { PaperShaderElement } from "@paper-design/shaders";
import { describe, expect, it, vi } from "vitest";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import { ZenShaderSurface } from "./ZenShaderSurface";
import type { ZenShaderLayouts } from "./useZenShaderLayouts";

const TEST_WEBGL_CONTEXT_ATTRIBUTES = {
  alpha: true,
  antialias: false,
  powerPreference: "default",
  premultipliedAlpha: true,
  // The integration test reads after React yields; preserve only here.
  preserveDrawingBuffer: true,
} satisfies WebGLContextAttributes;

const shaderLayouts = vi.hoisted(() => ({
  current: {
    surfaceSize: { width: 240, height: 160 },
    contrast: { rect: [0, 0, 1, 1], feather: [0, 0, 0, 0] },
    glass: {
      rect: [0, 0, 1, 1],
      feather: [0, 0, 0, 0],
      cornerRadius: 16,
    },
    uiSurfaces: [],
  } as ZenShaderLayouts,
}));

vi.mock("./useZenShaderLayouts", () => ({
  useZenShaderLayouts: () => shaderLayouts.current,
}));

vi.mock("./zenThemePalette", () => ({
  useZenThemePalette: () => ({
    background: "#101318",
    colors: ["#8fb4d6", "#d6b5a5", "#786fa6", "#d8c47c"],
    textColor: [0.9, 0.9, 0.9],
    uiTextColor: [0.75, 0.75, 0.75],
    backdropColor: [0.04, 0.05, 0.07],
  }),
}));

function shaderMount(container: HTMLElement) {
  return container.querySelector<PaperShaderElement>("[data-paper-shader]")
    ?.paperShaderMount;
}

function readFrame(container: HTMLElement) {
  const canvas = container.querySelector("canvas");
  expect(canvas).toBeInstanceOf(HTMLCanvasElement);
  const gl = canvas?.getContext("webgl2");
  expect(gl).not.toBeNull();
  gl?.finish();
  const pixels = new Uint8Array(
    (canvas?.width ?? 0) * (canvas?.height ?? 0) * 4,
  );
  gl?.readPixels(
    0,
    0,
    canvas?.width ?? 0,
    canvas?.height ?? 0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  expect(gl?.getError()).toBe(gl?.NO_ERROR);
  return pixels;
}

function averageRgbDelta(first: Uint8Array, second: Uint8Array) {
  expect(second).toHaveLength(first.length);
  let total = 0;
  let channels = 0;
  for (let index = 0; index < first.length; index += 4) {
    total += Math.abs(first[index]! - second[index]!);
    total += Math.abs(first[index + 1]! - second[index + 1]!);
    total += Math.abs(first[index + 2]! - second[index + 2]!);
    channels += 3;
  }
  return total / Math.max(channels, 1);
}

function drawCount(container: HTMLElement) {
  return shaderMount(container)?.getPerformanceStats().drawCount ?? 0;
}

function sleep(duration: number) {
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}

describe("ZenShaderSurface multipass integration", () => {
  it("keeps the default live shader visibly animated", async () => {
    const onRendererStatusChange = vi.fn();
    const animatedConfig = {
      ...ZEN_SHADER_DEFAULTS,
      speed: 100,
      opacity: 100,
      contrastGuard: {
        ...ZEN_SHADER_DEFAULTS.contrastGuard,
        mode: "none" as const,
      },
    };
    const view = render(
      <div style={{ position: "relative", width: 240, height: 160 }}>
        <ZenShaderSurface
          config={animatedConfig}
          playing
          webGlSupported
          webGlContextAttributes={TEST_WEBGL_CONTEXT_ATTRIBUTES}
          onRendererStatusChange={onRendererStatusChange}
        />
      </div>,
    );

    await waitFor(
      () => {
        expect(onRendererStatusChange).toHaveBeenLastCalledWith("webgl");
        expect(drawCount(view.container)).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    const visibleCanvas = view.container.querySelector("canvas");
    expect(visibleCanvas).toBeInstanceOf(HTMLCanvasElement);
    expect(getComputedStyle(visibleCanvas!).position).toBe("absolute");
    expect(getComputedStyle(visibleCanvas!).zIndex).toBe("0");
    expect(getComputedStyle(visibleCanvas!.parentElement!).isolation).toBe(
      "isolate",
    );

    const firstAnimatedDrawCount = drawCount(view.container);
    const firstAnimatedFrame = readFrame(view.container);
    await waitFor(() => {
      expect(drawCount(view.container)).toBeGreaterThan(
        firstAnimatedDrawCount + 4,
      );
    });
    const secondAnimatedFrame = readFrame(view.container);
    expect(
      averageRgbDelta(firstAnimatedFrame, secondAnimatedFrame),
    ).toBeGreaterThan(0.1);

    view.rerender(
      <div style={{ position: "relative", width: 240, height: 160 }}>
        <ZenShaderSurface
          config={animatedConfig}
          playing={false}
          webGlSupported
          webGlContextAttributes={TEST_WEBGL_CONTEXT_ATTRIBUTES}
          onRendererStatusChange={onRendererStatusChange}
        />
      </div>,
    );
    await sleep(80);
    const pausedDrawCount = drawCount(view.container);
    await sleep(80);
    expect(drawCount(view.container)).toBe(pausedDrawCount);
  });

  it("applies low-opacity contrast strength to final visible pixels", async () => {
    const onRendererStatusChange = vi.fn();
    const weakConfig = {
      ...ZEN_SHADER_DEFAULTS,
      speed: 0,
      opacity: 18,
      contrastGuard: {
        ...ZEN_SHADER_DEFAULTS.contrastGuard,
        mode: "auto" as const,
        strength: 0,
      },
    };
    const view = render(
      <div style={{ position: "relative", width: 240, height: 160 }}>
        <ZenShaderSurface
          config={weakConfig}
          playing={false}
          webGlSupported
          webGlContextAttributes={TEST_WEBGL_CONTEXT_ATTRIBUTES}
          onRendererStatusChange={onRendererStatusChange}
        />
      </div>,
    );

    await waitFor(
      () => {
        expect(onRendererStatusChange).toHaveBeenLastCalledWith("webgl");
        expect(drawCount(view.container)).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    const surface = view.container.querySelector<HTMLElement>(
      "[data-zen-shader-surface]",
    );
    expect(getComputedStyle(surface!).opacity).toBe("1");
    const weakContrastFrame = readFrame(view.container);
    const pausedDrawCount = drawCount(view.container);

    view.rerender(
      <div style={{ position: "relative", width: 240, height: 160 }}>
        <ZenShaderSurface
          config={{
            ...weakConfig,
            contrastGuard: {
              ...weakConfig.contrastGuard,
              strength: 1,
            },
          }}
          playing={false}
          webGlSupported
          webGlContextAttributes={TEST_WEBGL_CONTEXT_ATTRIBUTES}
          onRendererStatusChange={onRendererStatusChange}
        />
      </div>,
    );
    await waitFor(() => {
      expect(drawCount(view.container)).toBeGreaterThan(pausedDrawCount);
    });
    const strongContrastFrame = readFrame(view.container);
    expect(
      averageRgbDelta(weakContrastFrame, strongContrastFrame),
    ).toBeGreaterThan(0.1);
  });
});
