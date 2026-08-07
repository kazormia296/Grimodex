import { render, waitFor } from "@testing-library/react";
import type { PaperShaderElement } from "@paper-design/shaders";
import { describe, expect, it, vi } from "vitest";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import { ZenShaderSurface } from "./ZenShaderSurface";
import type { ZenShaderLayouts } from "./useZenShaderLayouts";

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

function drawCount(container: HTMLElement) {
  return shaderMount(container)?.getPerformanceStats().drawCount ?? 0;
}

function sleep(duration: number) {
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}

describe("ZenShaderSurface multipass integration", () => {
  it("keeps the default live shader scheduled and redraws paused contrast changes", async () => {
    const onRendererStatusChange = vi.fn();
    const animatedConfig = {
      ...ZEN_SHADER_DEFAULTS,
      speed: 100,
      opacity: 100,
      contrastGuard: {
        ...ZEN_SHADER_DEFAULTS.contrastGuard,
        mode: "auto" as const,
        strength: 0,
      },
    };
    const view = render(
      <div style={{ position: "relative", width: 240, height: 160 }}>
        <ZenShaderSurface
          config={animatedConfig}
          playing
          webGlSupported
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

    const firstAnimatedDrawCount = drawCount(view.container);
    await waitFor(() => {
      expect(drawCount(view.container)).toBeGreaterThan(
        firstAnimatedDrawCount + 4,
      );
    });

    view.rerender(
      <div style={{ position: "relative", width: 240, height: 160 }}>
        <ZenShaderSurface
          config={animatedConfig}
          playing={false}
          webGlSupported
          onRendererStatusChange={onRendererStatusChange}
        />
      </div>,
    );
    await sleep(80);
    const pausedDrawCount = drawCount(view.container);
    await sleep(80);
    expect(drawCount(view.container)).toBe(pausedDrawCount);

    view.rerender(
      <div style={{ position: "relative", width: 240, height: 160 }}>
        <ZenShaderSurface
          config={{
            ...animatedConfig,
            contrastGuard: {
              ...animatedConfig.contrastGuard,
              strength: 1,
            },
          }}
          playing={false}
          webGlSupported
          onRendererStatusChange={onRendererStatusChange}
        />
      </div>,
    );
    await waitFor(() => {
      expect(drawCount(view.container)).toBeGreaterThan(pausedDrawCount);
    });
  });
});
