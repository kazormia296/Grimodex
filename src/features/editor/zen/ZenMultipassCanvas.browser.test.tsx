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

const BLUR_STEP_SCENE = `#version 300 es
precision mediump float;
uniform vec2 u_resolution;
out vec4 fragColor;
void main() {
  float value = step(u_resolution.x * 0.5, gl_FragCoord.x);
  fragColor = vec4(vec3(value), 1.0);
}`;

const BLUR_PROBE_WIDTH = 512;
const BLUR_PROBE_HEIGHT = 64;

const PASSING_DARK_SCENE = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(vec3(0.1), 1.0);
}`;

const CONTRAST_BOUNDARY_SCENE = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  float value = gl_FragCoord.x < 32.0 ? 118.0 / 255.0 : 119.0 / 255.0;
  fragColor = vec4(vec3(value), 1.0);
}`;

const BRIGHT_CONTRAST_BOUNDARY_SCENE = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  float value = gl_FragCoord.x < 32.0 ? 116.0 / 255.0 : 117.0 / 255.0;
  fragColor = vec4(vec3(value), 1.0);
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

const BRIGHT_RUNTIME: ZenPostProcessRuntime = {
  ...RUNTIME,
  textColor: [0, 0, 0],
  uiTextColor: [0, 0, 0],
  backdropColor: [1, 1, 1],
} as const;

const FULL_GLASS_RUNTIME: ZenPostProcessRuntime = {
  ...RUNTIME,
  glassRect: [0, 0, 1, 1],
} as const;

function compositeUniforms(
  strength: number,
  enabled = true,
  runtime: ZenPostProcessRuntime = RUNTIME,
) {
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
    runtime,
    new ZenUiSurfaceUniformBuffer(1),
  );
}

function blurCompositeUniforms(blur: number) {
  return buildZenMultipassCompositeUniforms(
    {
      ...ZEN_SHADER_DEFAULTS,
      opacity: 100,
      glass: {
        ...ZEN_SHADER_DEFAULTS.glass,
        enabled: true,
        blur,
        saturation: 1,
        refraction: 0,
        shine: 0,
      },
      contrastGuard: {
        mode: "none",
        strength: 0,
        toolMix: 0,
      },
    },
    FULL_GLASS_RUNTIME,
    new ZenUiSurfaceUniformBuffer(1),
  );
}

function BlurProbe({
  name,
  blur,
  renderScale,
}: {
  name: string;
  blur: number;
  renderScale: number;
}) {
  return (
    <ZenMultipassCanvas
      data-paper-shader={`blur-strength-${name}`}
      sceneFragment={BLUR_STEP_SCENE}
      sceneUniforms={SIZING_UNIFORMS}
      compositeFragment={buildZenMultipassCompositeFragment(1)}
      compositeUniforms={blurCompositeUniforms(blur)}
      minPixelRatio={1}
      maxPixelCount={
        BLUR_PROBE_WIDTH * BLUR_PROBE_HEIGHT * renderScale * renderScale
      }
      speed={0}
      style={{
        position: "relative",
        width: BLUR_PROBE_WIDTH,
        height: BLUR_PROBE_HEIGHT,
      }}
      webGlContextAttributes={WEBGL_ATTRIBUTES}
    />
  );
}

function readCenterRed(canvas: HTMLCanvasElement) {
  return readCenterPixel(canvas)[0] ?? 0;
}

function readPixel(canvas: HTMLCanvasElement, x: number, y: number) {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("WebGL2 context is unavailable");
  // Read the default framebuffer: draw counters alone cannot prove that the
  // user-visible multipass output changed.
  const pixel = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return pixel;
}

function readCenterPixel(canvas: HTMLCanvasElement) {
  return readPixel(
    canvas,
    Math.floor(canvas.width / 2),
    Math.floor(canvas.height / 2),
  );
}

function effectiveHorizontalBlurSigma(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("WebGL2 context is unavailable");
  const scanline = new Uint8Array(canvas.width * 4);
  gl.readPixels(
    0,
    Math.floor(canvas.height / 2),
    canvas.width,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    scanline,
  );

  let weight = 0;
  let weightedPosition = 0;
  const positiveDifferences: Array<[position: number, weight: number]> = [];
  for (let x = 0; x < canvas.width - 1; x += 1) {
    const difference = (scanline[(x + 1) * 4] ?? 0) - (scanline[x * 4] ?? 0);
    if (difference <= 0) continue;
    const position = x + 0.5;
    positiveDifferences.push([position, difference]);
    weight += difference;
    weightedPosition += position * difference;
  }
  if (weight === 0) return 0;

  const mean = weightedPosition / weight;
  const variance = positiveDifferences.reduce(
    (sum, [position, difference]) => sum + (position - mean) ** 2 * difference,
    0,
  );
  const cssWidth = canvas.getBoundingClientRect().width;
  const renderScale = canvas.width / cssWidth;
  return Math.sqrt(variance / weight) / renderScale;
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
  it("matches CSS blur strength across render scales", async () => {
    const probes = [
      { name: "zero", blur: 0, renderScale: 1 },
      { name: "one", blur: 1, renderScale: 1 },
      { name: "twenty-two-full", blur: 22, renderScale: 1 },
      { name: "twenty-two-half", blur: 22, renderScale: 0.5 },
      { name: "forty", blur: 40, renderScale: 1 },
    ] as const;
    const { container } = render(
      <div>
        {probes.map((probe) => (
          <BlurProbe key={probe.name} {...probe} />
        ))}
      </div>,
    );
    const canvasFor = (name: string) =>
      canvasFrom(
        container.querySelector<HTMLElement>(
          `[data-paper-shader="blur-strength-${name}"]`,
        ) ?? container,
      );

    await waitFor(
      () => {
        for (const probe of probes) {
          const canvas = canvasFor(probe.name);
          expect(canvas.width).toBe(BLUR_PROBE_WIDTH * probe.renderScale);
          expect(
            readPixel(canvas, canvas.width - 2, canvas.height / 2)[0],
          ).toBe(255);
        }
      },
      { timeout: 5_000 },
    );

    const blur0 = effectiveHorizontalBlurSigma(canvasFor("zero"));
    const blur1 = effectiveHorizontalBlurSigma(canvasFor("one"));
    const blur22Full = effectiveHorizontalBlurSigma(
      canvasFor("twenty-two-full"),
    );
    const blur22Half = effectiveHorizontalBlurSigma(
      canvasFor("twenty-two-half"),
    );
    const blur40 = effectiveHorizontalBlurSigma(canvasFor("forty"));

    expect(blur22Full).toBeGreaterThanOrEqual(19.8);
    expect(blur22Full).toBeLessThanOrEqual(24.2);
    expect(blur22Half).toBeGreaterThanOrEqual(19.8);
    expect(blur22Half).toBeLessThanOrEqual(24.2);
    expect(Math.abs(blur22Half - blur22Full)).toBeLessThanOrEqual(2);
    expect(blur40).toBeGreaterThanOrEqual(36);
    expect(blur40).toBeLessThanOrEqual(44);
    expect(blur0).toBeLessThanOrEqual(1.5);
    expect(blur1).toBeGreaterThan(blur0);
    expect(blur1).toBeLessThan(4);
  }, 30_000);

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

  it("keeps the contrast correction continuous at the target boundary", async () => {
    const view = render(
      <ZenMultipassCanvas
        data-paper-shader="contrast-boundary-probe"
        sceneFragment={CONTRAST_BOUNDARY_SCENE}
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
    const boundaryY = Math.floor(canvas.height / 2);
    const unguardedPassing = readPixel(canvas, 16, boundaryY);
    const unguardedFailing = readPixel(canvas, 48, boundaryY);
    expect(unguardedPassing[0]).toBeGreaterThanOrEqual(117);
    expect(unguardedPassing[0]).toBeLessThanOrEqual(119);
    expect(unguardedFailing[0]).toBeGreaterThanOrEqual(118);
    expect(unguardedFailing[0]).toBeLessThanOrEqual(120);

    view.rerender(
      <ZenMultipassCanvas
        data-paper-shader="contrast-boundary-probe"
        sceneFragment={CONTRAST_BOUNDARY_SCENE}
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
      const guardedPassing = readPixel(canvas, 16, boundaryY);
      const guardedFailing = readPixel(canvas, 48, boundaryY);
      expect(Math.abs((guardedPassing[0] ?? 0) - 118)).toBeLessThanOrEqual(1);
      expect(
        Math.abs((guardedPassing[0] ?? 0) - (guardedFailing[0] ?? 0)),
      ).toBeLessThanOrEqual(3);
      expect(
        1.05 / (srgbLuminance(guardedFailing) + 0.05),
      ).toBeGreaterThanOrEqual(4.45);
    });
  });

  it("keeps bright-side contrast correction continuous at the target boundary", async () => {
    const view = render(
      <ZenMultipassCanvas
        data-paper-shader="bright-contrast-boundary-probe"
        sceneFragment={BRIGHT_CONTRAST_BOUNDARY_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(0, false, BRIGHT_RUNTIME)}
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
    const boundaryY = Math.floor(canvas.height / 2);
    const unguardedFailing = readPixel(canvas, 16, boundaryY);
    const unguardedPassing = readPixel(canvas, 48, boundaryY);
    expect(unguardedFailing[0]).toBeGreaterThanOrEqual(115);
    expect(unguardedFailing[0]).toBeLessThanOrEqual(117);
    expect(unguardedPassing[0]).toBeGreaterThanOrEqual(116);
    expect(unguardedPassing[0]).toBeLessThanOrEqual(118);

    view.rerender(
      <ZenMultipassCanvas
        data-paper-shader="bright-contrast-boundary-probe"
        sceneFragment={BRIGHT_CONTRAST_BOUNDARY_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(0, true, BRIGHT_RUNTIME)}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );

    await waitFor(() => {
      const guardedFailing = readPixel(canvas, 16, boundaryY);
      const guardedPassing = readPixel(canvas, 48, boundaryY);
      expect(Math.abs((guardedPassing[0] ?? 0) - 117)).toBeLessThanOrEqual(1);
      expect(
        Math.abs((guardedPassing[0] ?? 0) - (guardedFailing[0] ?? 0)),
      ).toBeLessThanOrEqual(3);
      expect(srgbLuminance(guardedFailing) + 0.05).toBeGreaterThanOrEqual(
        4.45 * 0.05,
      );
    });
  });
});
