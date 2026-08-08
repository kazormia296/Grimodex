import { createRef, StrictMode } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  PaperShaderElement,
  ShaderMountUniforms,
} from "@paper-design/shaders";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import { ZenMultipassCanvas } from "./ZenMultipassCanvas";
import type { ZenPostProcessRuntime } from "./zenPostProcessing";
import {
  buildZenMultipassCompositeFragment,
  buildZenMultipassCompositeUniforms,
} from "./zenMultipassPipeline";

const SIZING_UNIFORMS: ShaderMountUniforms = {
  u_fit: 2,
  u_scale: 1,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
  u_imageAspectRatio: 1,
};

const ANIMATED_SCENE = `#version 300 es
precision highp float;
uniform float u_time;
out vec4 fragColor;
void main() {
  float value = 0.5 + 0.45 * sin(u_time * 8.0);
  fragColor = vec4(vec3(value), 1.0);
}`;

const STATIC_SCENE = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(vec3(0.5), 1.0);
}`;

const PASSING_DARK_SCENE = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(vec3(0.1), 1.0);
}`;

const RUNTIME: ZenPostProcessRuntime = {
  rect: [0, 0, 1, 1],
  feather: [0, 0, 0, 0],
  glassRect: [0, 0, 0, 0],
  glassCornerRadius: 0,
  uiSurfaces: [],
  textColor: [1, 1, 1],
  uiTextColor: [1, 1, 1],
  backdropColor: [0, 0, 0],
} as const;

function compositeUniforms(strength: number, enabled = true) {
  return buildZenMultipassCompositeUniforms(
    {
      ...ZEN_SHADER_DEFAULTS,
      opacity: 100,
      glass: {
        ...ZEN_SHADER_DEFAULTS.glass,
        enabled: false,
        blur: 0,
        refraction: 0,
      },
      contrastGuard: {
        mode: enabled ? "auto" : "none",
        strength,
        toolMix: 0,
      },
    },
    RUNTIME,
    new ZenUiSurfaceUniformBuffer(1),
  );
}

function readCenterRed(canvas: HTMLCanvasElement) {
  return readCenterPixel(canvas)[0] ?? 0;
}

function readCenterPixel(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("WebGL2 context is unavailable");
  // Read the default framebuffer: draw counters alone cannot prove that the
  // user-visible multipass output changed.
  const pixel = new Uint8Array(4);
  gl.readPixels(
    Math.floor(canvas.width / 2),
    Math.floor(canvas.height / 2),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixel,
  );
  return pixel;
}

function srgbLuminance(pixel: Uint8Array) {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (
    linear(pixel[0] ?? 0) * 0.2126 +
    linear(pixel[1] ?? 0) * 0.7152 +
    linear(pixel[2] ?? 0) * 0.0722
  );
}

function canvasFrom(container: HTMLElement) {
  const canvas = container.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Zen multipass canvas was not mounted");
  }
  return canvas;
}

const WEBGL_ATTRIBUTES = {
  alpha: false,
  antialias: false,
  preserveDrawingBuffer: true,
} satisfies WebGLContextAttributes;

describe("ZenMultipassCanvas live updates", () => {
  it("allocates fresh render targets when Strict Mode replays initialization", async () => {
    const ref = createRef<PaperShaderElement>();
    const { container } = render(
      <StrictMode>
        <ZenMultipassCanvas
          ref={ref}
          data-paper-shader="strict-mode-probe"
          sceneFragment={STATIC_SCENE}
          sceneUniforms={SIZING_UNIFORMS}
          compositeFragment={buildZenMultipassCompositeFragment(1)}
          compositeUniforms={compositeUniforms(0, false)}
          minPixelRatio={1}
          maxPixelCount={64 * 64}
          speed={0}
          style={{ position: "relative", width: 64, height: 64 }}
          webGlContextAttributes={WEBGL_ATTRIBUTES}
        />
      </StrictMode>,
    );
    const canvas = canvasFrom(container);

    await waitFor(() =>
      expect(
        ref.current?.paperShaderMount?.getPerformanceStats().drawCount,
      ).toBeGreaterThan(0),
    );
    expect(readCenterRed(canvas)).toBeGreaterThan(0);
  });

  it("advances the Paper scene while speed is positive", async () => {
    const ref = createRef<PaperShaderElement>();
    const { container } = render(
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="animated-probe"
        sceneFragment={ANIMATED_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(0, false)}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={1}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );
    const canvas = canvasFrom(container);

    await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
    await waitFor(() =>
      expect(
        ref.current?.paperShaderMount?.getPerformanceStats().drawCount,
      ).toBeGreaterThan(0),
    );
    const first = readCenterRed(canvas);

    await waitFor(
      () => expect(Math.abs(readCenterRed(canvas) - first)).toBeGreaterThan(8),
      { timeout: 1_000 },
    );
  });

  it("redraws the final pass when contrast strength changes", async () => {
    const view = render(
      <ZenMultipassCanvas
        data-paper-shader="contrast-probe"
        sceneFragment={STATIC_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(0)}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );
    const canvas = canvasFrom(view.container);

    await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
    await waitFor(() => expect(readCenterRed(canvas)).toBeGreaterThan(0));
    const wcagAa = readCenterRed(canvas);

    view.rerender(
      <ZenMultipassCanvas
        data-paper-shader="contrast-probe"
        sceneFragment={STATIC_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(1)}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );

    await waitFor(() => expect(readCenterRed(canvas)).toBeLessThan(wcagAa - 8));
  });

  it("leaves a pixel that already meets the contrast target unchanged", async () => {
    const view = render(
      <ZenMultipassCanvas
        data-paper-shader="passing-contrast-probe"
        sceneFragment={PASSING_DARK_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(0, false)}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );
    const canvas = canvasFrom(view.container);

    await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
    await waitFor(() => expect(readCenterRed(canvas)).toBeGreaterThan(0));
    const unguarded = readCenterPixel(canvas);

    view.rerender(
      <ZenMultipassCanvas
        data-paper-shader="passing-contrast-probe"
        sceneFragment={PASSING_DARK_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(0)}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );

    await waitFor(() => {
      const guarded = readCenterPixel(canvas);
      expect(
        Math.max(
          Math.abs((guarded[0] ?? 0) - (unguarded[0] ?? 0)),
          Math.abs((guarded[1] ?? 0) - (unguarded[1] ?? 0)),
          Math.abs((guarded[2] ?? 0) - (unguarded[2] ?? 0)),
        ),
      ).toBeLessThanOrEqual(1);
    });
  });

  it("raises failing pixels to the configured contrast target", async () => {
    const view = render(
      <ZenMultipassCanvas
        data-paper-shader="failing-contrast-probe"
        sceneFragment={STATIC_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(0, false)}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );
    const canvas = canvasFrom(view.container);

    await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
    await waitFor(() => expect(readCenterRed(canvas)).toBeGreaterThan(0));
    const unguarded = readCenterPixel(canvas);

    view.rerender(
      <ZenMultipassCanvas
        data-paper-shader="failing-contrast-probe"
        sceneFragment={STATIC_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(0)}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );

    await waitFor(() => {
      const guarded = readCenterPixel(canvas);
      const unguardedLuminance = srgbLuminance(unguarded);
      const guardedLuminance = srgbLuminance(guarded);
      expect(unguardedLuminance).toBeGreaterThan(0.15);
      expect(guardedLuminance).toBeLessThan(unguardedLuminance);
      expect(1.05 / (guardedLuminance + 0.05)).toBeGreaterThanOrEqual(
        4.5 - 0.15,
      );
    });
  });
});
