import { createRef, StrictMode, type RefObject } from "react";
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

const BLUR_POINT_SCENE = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
out vec4 fragColor;
void main() {
  vec2 point = gl_FragCoord.xy - u_resolution * 0.5;
  // Eight CSS pixels keeps the RGBA8 fallback above its intermediate
  // quantization floor while remaining small relative to 22/40px sigma.
  float value = 1.0 - step(8.0 * u_pixelRatio, length(point));
  fragColor = vec4(vec3(value), 1.0);
}`;

const BLUR_GRATING_SCENE = `#version 300 es
precision highp float;
uniform float u_pixelRatio;
uniform vec2 u_probeDirection;
uniform float u_probeFrequency;
out vec4 fragColor;
void main() {
  vec2 cssPosition = gl_FragCoord.xy / max(u_pixelRatio, 0.0001);
  float value = 0.5 + 0.45 * cos(
    dot(cssPosition, u_probeDirection) * u_probeFrequency
  );
  fragColor = vec4(vec3(value), 1.0);
}`;

const BLUR_PROBE_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_blurredTexture;
uniform float u_probeGain;
void main() {
  fragColor = vec4(texture(u_blurredTexture, v_uv).rgb * u_probeGain, 1.0);
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
      minPixelRatio={Math.max(1, renderScale)}
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

type BlurTargetPrecision = "auto" | "rgba8";

function DirectBlurProbe({
  name,
  sceneFragment,
  sceneUniforms = SIZING_UNIFORMS,
  blur,
  gain = 1,
  renderScale = 1,
  blurTargetPrecision = "auto",
  width = 256,
  height = 256,
  mountRef,
}: {
  name: string;
  sceneFragment: string;
  sceneUniforms?: ShaderMountUniforms;
  blur: number;
  gain?: number;
  renderScale?: number;
  blurTargetPrecision?: BlurTargetPrecision;
  width?: number;
  height?: number;
  mountRef?: RefObject<PaperShaderElement | null>;
}) {
  return (
    <ZenMultipassCanvas
      ref={mountRef}
      data-paper-shader={`direct-blur-${name}`}
      sceneFragment={sceneFragment}
      sceneUniforms={sceneUniforms}
      compositeFragment={BLUR_PROBE_COMPOSITE}
      compositeUniforms={{
        u_probeGain: gain,
        u_zenGlassBlur: blur,
        u_zenGlassEnabled: 1,
        u_zenGlassRect: [0, 0, 1, 1],
        u_zenUiSurfaceCount: 0,
      }}
      blurTargetPrecision={blurTargetPrecision}
      minPixelRatio={Math.max(1, renderScale)}
      maxPixelCount={width * height * renderScale * renderScale}
      speed={0}
      style={{ position: "relative", width, height }}
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

function angularRedSamples(canvas: HTMLCanvasElement, radiusCss: number) {
  const cssWidth = canvas.getBoundingClientRect().width;
  const renderScale = canvas.width / cssWidth;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  return Array.from({ length: 16 }, (_, index) => {
    const angle = (index * Math.PI * 2) / 16;
    const x = Math.max(
      0,
      Math.min(
        canvas.width - 1,
        Math.round(centerX + Math.cos(angle) * radiusCss * renderScale - 0.5),
      ),
    );
    const y = Math.max(
      0,
      Math.min(
        canvas.height - 1,
        Math.round(centerY + Math.sin(angle) * radiusCss * renderScale - 0.5),
      ),
    );
    return readPixel(canvas, x, y)[0] ?? 0;
  });
}

function angularAnisotropy(canvas: HTMLCanvasElement, radiusCss: number) {
  const samples = angularRedSamples(canvas, radiusCss);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return mean <= 0
    ? Number.POSITIVE_INFINITY
    : (Math.max(...samples) - Math.min(...samples)) / mean;
}

function meanAngularRed(canvas: HTMLCanvasElement, radiusCss: number) {
  const samples = angularRedSamples(canvas, radiusCss);
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

function centralRedAmplitude(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("WebGL2 context is unavailable");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(
    0,
    0,
    canvas.width,
    canvas.height,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  const marginX = Math.floor(canvas.width * 0.25);
  const marginY = Math.floor(canvas.height * 0.25);
  let minimum = 255;
  let maximum = 0;
  for (let y = marginY; y < canvas.height - marginY; y += 1) {
    for (let x = marginX; x < canvas.width - marginX; x += 1) {
      const red = pixels[(y * canvas.width + x) * 4] ?? 0;
      minimum = Math.min(minimum, red);
      maximum = Math.max(maximum, red);
    }
  }
  return (maximum - minimum) / 2;
}

interface BlurPerformanceStats {
  drawCount: number;
  blurFormat: "rgba16f" | "rgba8";
  blurTargetWidth: number;
  blurTargetHeight: number;
  gaussianPairCount: number;
}

function blurPerformanceStats(ref: RefObject<PaperShaderElement | null>) {
  const stats = ref.current?.paperShaderMount?.getPerformanceStats();
  if (!stats)
    throw new Error("Zen multipass performance stats are unavailable");
  return stats as unknown as BlurPerformanceStats;
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
      { name: "twenty-one", blur: 21, renderScale: 1 },
      { name: "twenty-two-full", blur: 22, renderScale: 1 },
      { name: "twenty-two-half", blur: 22, renderScale: 0.5 },
      { name: "twenty-two-double", blur: 22, renderScale: 2 },
      { name: "twenty-three", blur: 23, renderScale: 1 },
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
    const blur21 = effectiveHorizontalBlurSigma(canvasFor("twenty-one"));
    const blur22Full = effectiveHorizontalBlurSigma(
      canvasFor("twenty-two-full"),
    );
    const blur22Half = effectiveHorizontalBlurSigma(
      canvasFor("twenty-two-half"),
    );
    const blur22Double = effectiveHorizontalBlurSigma(
      canvasFor("twenty-two-double"),
    );
    const blur23 = effectiveHorizontalBlurSigma(canvasFor("twenty-three"));
    const blur40 = effectiveHorizontalBlurSigma(canvasFor("forty"));

    expect(blur22Full).toBeGreaterThanOrEqual(19.8);
    expect(blur22Full).toBeLessThanOrEqual(24.2);
    expect(blur22Half).toBeGreaterThanOrEqual(19.8);
    expect(blur22Half).toBeLessThanOrEqual(24.2);
    expect(Math.abs(blur22Half - blur22Full)).toBeLessThanOrEqual(2);
    expect(blur22Double).toBeGreaterThanOrEqual(19.8);
    expect(blur22Double).toBeLessThanOrEqual(24.2);
    expect(Math.abs(blur22Double - blur22Full)).toBeLessThanOrEqual(2);
    expect(blur40).toBeGreaterThanOrEqual(36);
    expect(blur40).toBeLessThanOrEqual(44);
    expect(blur0).toBeLessThanOrEqual(1.5);
    expect(blur1).toBeGreaterThan(blur0);
    expect(blur1).toBeLessThan(4);
    const firstIncrement = blur22Full - blur21;
    const secondIncrement = blur23 - blur22Full;
    expect(firstIncrement).toBeGreaterThan(0.2);
    expect(firstIncrement).toBeLessThan(1.8);
    expect(secondIncrement).toBeGreaterThan(0.2);
    expect(secondIncrement).toBeLessThan(1.8);
    expect(Math.abs(firstIncrement - secondIncrement)).toBeLessThan(0.8);
  }, 30_000);

  it("keeps the point-spread function radial without terraces or side peaks", async () => {
    const blur22HalfRef = createRef<PaperShaderElement>();
    const blur22FullRef = createRef<PaperShaderElement>();
    const blur22DoubleRef = createRef<PaperShaderElement>();
    const blur40Ref = createRef<PaperShaderElement>();
    const fallbackRef = createRef<PaperShaderElement>();
    const { container } = render(
      <div>
        <DirectBlurProbe
          name="point-22-half"
          sceneFragment={BLUR_POINT_SCENE}
          blur={22}
          gain={8}
          renderScale={0.5}
          mountRef={blur22HalfRef}
        />
        <DirectBlurProbe
          name="point-22-full"
          sceneFragment={BLUR_POINT_SCENE}
          blur={22}
          gain={8}
          mountRef={blur22FullRef}
        />
        <DirectBlurProbe
          name="point-22-double"
          sceneFragment={BLUR_POINT_SCENE}
          blur={22}
          gain={8}
          renderScale={2}
          mountRef={blur22DoubleRef}
        />
        <DirectBlurProbe
          name="point-40-auto"
          sceneFragment={BLUR_POINT_SCENE}
          blur={40}
          gain={8}
          mountRef={blur40Ref}
        />
        <DirectBlurProbe
          name="point-40-rgba8"
          sceneFragment={BLUR_POINT_SCENE}
          blur={40}
          gain={8}
          blurTargetPrecision="rgba8"
          mountRef={fallbackRef}
        />
      </div>,
    );
    const canvasFor = (name: string) =>
      canvasFrom(
        container.querySelector<HTMLElement>(
          `[data-paper-shader="direct-blur-${name}"]`,
        ) ?? container,
      );

    await waitFor(
      () => {
        expect(blurPerformanceStats(blur22HalfRef).drawCount).toBeGreaterThan(
          0,
        );
        expect(blurPerformanceStats(blur22FullRef).drawCount).toBeGreaterThan(
          0,
        );
        expect(blurPerformanceStats(blur22DoubleRef).drawCount).toBeGreaterThan(
          0,
        );
        expect(blurPerformanceStats(blur40Ref).drawCount).toBeGreaterThan(0);
        expect(blurPerformanceStats(fallbackRef).drawCount).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    const blur22Canvases = [
      canvasFor("point-22-half"),
      canvasFor("point-22-full"),
      canvasFor("point-22-double"),
    ];
    const blur40Canvas = canvasFor("point-40-auto");
    const fallbackCanvas = canvasFor("point-40-rgba8");
    const blur22Anisotropies = blur22Canvases.map((canvas) =>
      angularAnisotropy(canvas, 22),
    );
    for (const anisotropy of blur22Anisotropies) {
      expect(anisotropy).toBeLessThan(0.2);
    }
    expect(
      Math.max(...blur22Anisotropies) - Math.min(...blur22Anisotropies),
    ).toBeLessThan(0.1);
    expect(angularAnisotropy(blur40Canvas, 40)).toBeLessThan(0.18);
    expect(angularAnisotropy(fallbackCanvas, 40)).toBeLessThan(0.25);

    for (const [canvas, blur] of [
      ...blur22Canvases.map((canvas) => [canvas, 22] as const),
      [blur40Canvas, 40],
      [fallbackCanvas, 40],
    ] as const) {
      const radialProfile = [0.5, 0.75, 1, 1.25, 1.5].map((radius) =>
        meanAngularRed(canvas, blur * radius),
      );
      expect(radialProfile[0]).toBeGreaterThan(radialProfile.at(-1) ?? 0);
      for (let index = 1; index < radialProfile.length; index += 1) {
        expect(radialProfile[index]).toBeLessThanOrEqual(
          radialProfile[index - 1] + 2,
        );
      }
    }

    const blur22Stats = blurPerformanceStats(blur22FullRef);
    const blur40Stats = blurPerformanceStats(blur40Ref);
    const fallbackStats = blurPerformanceStats(fallbackRef);
    expect(["rgba16f", "rgba8"]).toContain(blur22Stats.blurFormat);
    expect(blur22Stats).toMatchObject({
      blurTargetWidth: 70,
      blurTargetHeight: 70,
    });
    expect(blur22Stats.gaussianPairCount).toBeGreaterThan(0);
    expect(blur22Stats.gaussianPairCount).toBeLessThanOrEqual(16);
    expect(blur40Stats).toMatchObject({
      blurTargetWidth: 64,
      blurTargetHeight: 64,
    });
    expect(blur40Stats.gaussianPairCount).toBe(15);
    expect(fallbackStats.blurFormat).toBe("rgba8");
    expect(fallbackStats.blurTargetWidth).toBe(64);
    expect(fallbackStats.blurTargetHeight).toBe(64);
  }, 30_000);

  it("attenuates sinusoidal gratings equally at 0, 45 and 90 degrees", async () => {
    const frequency = (Math.PI * 2) / 96;
    const scales = [
      { name: "half", value: 0.5 },
      { name: "full", value: 1 },
      { name: "double", value: 2 },
    ] as const;
    const directions = [
      { name: "0", value: [1, 0] },
      { name: "45", value: [Math.SQRT1_2, Math.SQRT1_2] },
      { name: "90", value: [0, 1] },
    ] as const;
    const { container } = render(
      <div>
        {scales.flatMap((scale) =>
          directions.map((direction) => (
            <DirectBlurProbe
              key={`${scale.name}-${direction.name}`}
              name={`grating-${scale.name}-${direction.name}`}
              sceneFragment={BLUR_GRATING_SCENE}
              sceneUniforms={{
                ...SIZING_UNIFORMS,
                u_probeDirection: Array.from(direction.value),
                u_probeFrequency: frequency,
              }}
              blur={22}
              renderScale={scale.value}
            />
          )),
        )}
      </div>,
    );
    const canvases = scales.map((scale) => ({
      scale,
      directions: directions.map((direction) =>
        canvasFrom(
          container.querySelector<HTMLElement>(
            `[data-paper-shader="direct-blur-grating-${scale.name}-${direction.name}"]`,
          ) ?? container,
        ),
      ),
    }));

    await waitFor(
      () => {
        for (const probe of canvases) {
          for (const canvas of probe.directions) {
            expect(canvas.width).toBe(256 * probe.scale.value);
            expect(readCenterRed(canvas)).toBeGreaterThan(0);
          }
        }
      },
      { timeout: 5_000 },
    );

    const meanAmplitudes = canvases.map((probe) => {
      const amplitudes = probe.directions.map(centralRedAmplitude);
      const mean =
        amplitudes.reduce((sum, amplitude) => sum + amplitude, 0) /
        amplitudes.length;
      expect(Math.min(...amplitudes)).toBeGreaterThan(3);
      expect(
        (Math.max(...amplitudes) - Math.min(...amplitudes)) / mean,
      ).toBeLessThan(0.2);
      return mean;
    });
    const crossScaleMean =
      meanAmplitudes.reduce((sum, amplitude) => sum + amplitude, 0) /
      meanAmplitudes.length;
    expect(
      (Math.max(...meanAmplitudes) - Math.min(...meanAmplitudes)) /
        crossScaleMean,
    ).toBeLessThan(0.25);
  }, 30_000);

  it("invalidates blur when a reused UI surface buffer starts refracting", async () => {
    const ref = createRef<PaperShaderElement>();
    const surfaceBuffer = new ZenUiSurfaceUniformBuffer(1);
    const uiSurface = {
      rect: [0, 0, 1, 1] as [number, number, number, number],
      feather: [0, 0, 0, 0] as [number, number, number, number],
      cornerRadius: 0,
    };
    const compositeFor = (refracts: boolean) => {
      const packed = surfaceBuffer.update([{ ...uiSurface, refracts }]);
      return {
        u_probeGain: 1,
        u_zenGlassBlur: 22,
        u_zenGlassEnabled: 1,
        u_zenGlassRect: [0, 0, 0, 0],
        u_zenUiSurfaceCount: packed.count,
        "u_zenUiSurfaceRects[0]": packed.rects,
        "u_zenUiSurfaceParams[0]": packed.params,
      } satisfies ShaderMountUniforms;
    };
    const probe = (compositeUniforms: ShaderMountUniforms) => (
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="reused-surface-buffer-probe"
        sceneFragment={BLUR_POINT_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={BLUR_PROBE_COMPOSITE}
        compositeUniforms={compositeUniforms}
        minPixelRatio={1}
        maxPixelCount={256 * 256}
        speed={0}
        style={{ position: "relative", width: 256, height: 256 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />
    );

    const { container, rerender } = render(probe(compositeFor(false)));
    const canvas = canvasFrom(container);
    await waitFor(() =>
      expect(
        ref.current?.paperShaderMount?.getPerformanceStats(),
      ).toMatchObject({
        blurTargetWidth: 0,
        gaussianPairCount: 0,
      }),
    );
    const unblurredCenter = readCenterRed(canvas);
    const previousDrawCount = blurPerformanceStats(ref).drawCount;

    // `update` mutates the same Float32Arrays that the previous props hold.
    // Blur invalidation must therefore compare against renderer-owned state.
    rerender(probe(compositeFor(true)));
    await waitFor(() => {
      const stats = blurPerformanceStats(ref);
      expect(stats.drawCount).toBeGreaterThan(previousDrawCount);
      expect(stats.blurTargetWidth).toBeGreaterThan(0);
      expect(stats.gaussianPairCount).toBeGreaterThan(0);
    });
    expect(readCenterRed(canvas)).toBeLessThan(unblurredCenter - 20);
  });

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
