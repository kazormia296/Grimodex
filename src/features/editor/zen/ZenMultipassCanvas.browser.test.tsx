import { createRef, StrictMode, type RefObject } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PaperShaderElement,
  ShaderMountUniforms,
} from "@paper-design/shaders";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";
import {
  _setZenMultipassFaultInjectionForTests,
  ZenMultipassCanvas,
} from "./ZenMultipassCanvas";
import { ZenShaderSurface } from "./ZenShaderSurface";
import type { ZenPostProcessRuntime } from "./zenPostProcessing";
import type { ZenGpuTimerBackend } from "./zenGpuTimerSampler";
import type { ZenShaderLayouts } from "./useZenShaderLayouts";
import {
  buildZenMultipassCompositeFragment,
  buildZenMultipassCompositeUniforms,
} from "./zenMultipassPipeline";

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

afterEach(() => {
  _setZenMultipassFaultInjectionForTests(null);
});

class ManualAnimationFrames {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  request = (callback: FrameRequestCallback) => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  };

  cancel = (handle: number) => {
    this.callbacks.delete(handle);
  };

  step(timestamp: number) {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(timestamp));
  }
}

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

const STATIC_UNIFORM_SCENE = `#version 300 es
precision highp float;
uniform vec3 u_sceneTint;
out vec4 fragColor;
void main() {
  fragColor = vec4(u_sceneTint, 1.0);
}`;

const STATIC_UNIFORM_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sceneTexture;
uniform vec3 u_compositeTint;
void main() {
  fragColor = vec4(
    texture(u_sceneTexture, v_uv).rgb * u_compositeTint,
    1.0
  );
}`;

const IMAGE_SCENE = `#version 300 es
precision highp float;
in vec2 v_imageUV;
out vec4 fragColor;
uniform sampler2D u_image;
void main() {
  fragColor = texture(u_image, clamp(v_imageUV, vec2(0.0), vec2(1.0)));
}`;

const IMAGE_SPLIT_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_sceneTexture;
uniform sampler2D u_image;
void main() {
  vec3 sceneColor = texture(u_sceneTexture, v_uv).rgb;
  vec3 imageColor = texture(u_image, v_uv).rgb;
  fragColor = vec4(v_uv.x < 0.5 ? sceneColor : imageColor, 1.0);
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

const SURFACE_PROBE_WIDTH = 256;
const SURFACE_PROBE_HEIGHT = 128;
const SURFACE_PROBE_RECT = [0.25, 0.2, 0.5, 0.8] as const;

function surfaceCompositeUniforms({
  refracts,
  refraction,
  contrast,
  editorMask,
}: {
  refracts: boolean;
  refraction: number;
  contrast: boolean;
  editorMask: boolean;
}) {
  const runtime: ZenPostProcessRuntime = {
    ...RUNTIME,
    rect: [0, 0, 0, 0],
    glassRect: editorMask ? [0, 0, 1, 1] : [0, 0, 0, 0],
    uiSurfaces: [
      {
        rect: [...SURFACE_PROBE_RECT],
        feather: [0, 0, 0, 0],
        cornerRadius: 16,
        refracts,
      },
    ],
  };
  return buildZenMultipassCompositeUniforms(
    {
      ...ZEN_SHADER_DEFAULTS,
      opacity: 100,
      glass: {
        ...ZEN_SHADER_DEFAULTS.glass,
        enabled: true,
        blur: 0,
        saturation: 1,
        refraction,
        shine: 0,
      },
      contrastGuard: {
        mode: contrast ? "auto" : "none",
        strength: 1,
        toolMix: 1,
      },
    },
    runtime,
    new ZenUiSurfaceUniformBuffer(1),
  );
}

function SurfaceCompositeProbe({
  name,
  refracts,
  refraction,
  contrast = false,
  editorMask = false,
}: {
  name: string;
  refracts: boolean;
  refraction: number;
  contrast?: boolean;
  editorMask?: boolean;
}) {
  return (
    <ZenMultipassCanvas
      data-paper-shader={`surface-${name}`}
      sceneFragment={BLUR_GRATING_SCENE}
      sceneUniforms={{
        ...SIZING_UNIFORMS,
        u_probeDirection: [1, 0],
        u_probeFrequency: (2 * Math.PI) / 32,
      }}
      compositeFragment={buildZenMultipassCompositeFragment(1)}
      compositeUniforms={surfaceCompositeUniforms({
        refracts,
        refraction,
        contrast,
        editorMask,
      })}
      minPixelRatio={1}
      maxPixelCount={SURFACE_PROBE_WIDTH * SURFACE_PROBE_HEIGHT}
      speed={0}
      style={{
        position: "relative",
        width: SURFACE_PROBE_WIDTH,
        height: SURFACE_PROBE_HEIGHT,
      }}
      webGlContextAttributes={WEBGL_ATTRIBUTES}
    />
  );
}

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
  speed = 0,
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
  speed?: number;
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
      speed={speed}
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
  blurTargetAFormat: "rgba16f" | "rgba8";
  blurTargetBFormat: "rgba16f" | "rgba8";
  blurTargetWidth: number;
  blurTargetHeight: number;
  gaussianPairCount: number;
}

interface MultipassPerformanceStats extends BlurPerformanceStats {
  drawCallCount: number;
  gpuPassTimesMs: {
    scene: number;
    downsample: number;
    gaussianHorizontal: number;
    gaussianVertical: number;
    composite: number;
  } | null;
  gpuTimingStatus: string;
  gpuTimingSampleCount: number;
  gpuTimingSampleDrawCount: number | null;
  gpuTimeMs: number | null;
  sceneTargetWidth: number;
  sceneTargetHeight: number;
}

function blurPerformanceStats(ref: RefObject<PaperShaderElement | null>) {
  const stats = ref.current?.paperShaderMount?.getPerformanceStats();
  if (!stats)
    throw new Error("Zen multipass performance stats are unavailable");
  return stats as unknown as BlurPerformanceStats;
}

function multipassPerformanceStats(ref: RefObject<PaperShaderElement | null>) {
  const stats = ref.current?.paperShaderMount?.getPerformanceStats();
  if (!stats)
    throw new Error("Zen multipass performance stats are unavailable");
  return stats as unknown as MultipassPerformanceStats;
}

class ImmediateGpuTimerBackend implements ZenGpuTimerBackend<number> {
  private nextQuery = 0;
  disjointCheckCount = 0;

  createQuery() {
    this.nextQuery += 1;
    return this.nextQuery;
  }

  beginQuery() {}

  endQuery() {}

  isResultAvailable() {
    return true;
  }

  getResult(query: number) {
    return query * 1_000_000;
  }

  isDisjoint() {
    this.disjointCheckCount += 1;
    return false;
  }

  deleteQuery() {}

  isContextLost() {
    return false;
  }
}

async function loadVerticalStepImage() {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("image failed")), {
      once: true,
    });
  });
  image.src = `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
      <rect width="32" height="64" fill="black" />
      <rect x="32" width="32" height="64" fill="white" />
    </svg>
  `)}`;
  await loaded;
  return image;
}

async function loadSolidImage(fill: string) {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("image failed")), {
      once: true,
    });
  });
  image.src = `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">
      <rect width="8" height="8" fill="${fill}" />
    </svg>
  `)}`;
  await loaded;
  return image;
}

const NO_MIPMAPS: readonly string[] = [];

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
      { name: "five-point-nine", blur: 5.9, renderScale: 1 },
      { name: "six", blur: 6, renderScale: 1 },
      { name: "six-point-one", blur: 6.1, renderScale: 1 },
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
    const blur5Point9 = effectiveHorizontalBlurSigma(
      canvasFor("five-point-nine"),
    );
    const blur6 = effectiveHorizontalBlurSigma(canvasFor("six"));
    const blur6Point1 = effectiveHorizontalBlurSigma(
      canvasFor("six-point-one"),
    );
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
    expect(blur5Point9).toBeGreaterThanOrEqual(5);
    expect(blur6Point1).toBeLessThanOrEqual(7);
    const lowerCostBoundaryIncrement = blur6 - blur5Point9;
    const upperCostBoundaryIncrement = blur6Point1 - blur6;
    expect(lowerCostBoundaryIncrement).toBeGreaterThan(0);
    expect(lowerCostBoundaryIncrement).toBeLessThan(0.4);
    expect(upperCostBoundaryIncrement).toBeGreaterThan(0);
    expect(upperCostBoundaryIncrement).toBeLessThan(0.4);
    expect(
      Math.abs(lowerCostBoundaryIncrement - upperCostBoundaryIncrement),
    ).toBeLessThan(0.25);
    const firstIncrement = blur22Full - blur21;
    const secondIncrement = blur23 - blur22Full;
    expect(firstIncrement).toBeGreaterThan(0.2);
    expect(firstIncrement).toBeLessThan(1.8);
    expect(secondIncrement).toBeGreaterThan(0.2);
    expect(secondIncrement).toBeLessThan(1.8);
    expect(Math.abs(firstIncrement - secondIncrement)).toBeLessThan(0.8);
  }, 30_000);

  it("keeps the blur cost root continuous across adjacent render-scale pixels", async () => {
    const lowerRef = createRef<PaperShaderElement>();
    const upperRef = createRef<PaperShaderElement>();
    const probes = [
      {
        name: "cost-root-388",
        renderScale: 388 / 512,
        expectedWidth: 388,
        mountRef: lowerRef,
      },
      {
        name: "cost-root-389",
        renderScale: 389 / 512,
        expectedWidth: 389,
        mountRef: upperRef,
      },
    ] as const;
    const { container } = render(
      <div>
        {probes.map((probe) => (
          <DirectBlurProbe
            key={probe.name}
            name={probe.name}
            sceneFragment={BLUR_STEP_SCENE}
            blur={2}
            renderScale={probe.renderScale}
            width={512}
            height={128}
            mountRef={probe.mountRef}
          />
        ))}
      </div>,
    );
    const canvasFor = (name: string) =>
      canvasFrom(
        container.querySelector<HTMLElement>(
          `[data-paper-shader="direct-blur-${name}"]`,
        ) ?? container,
      );

    await waitFor(() => {
      expect(blurPerformanceStats(lowerRef).drawCount).toBeGreaterThan(0);
      expect(blurPerformanceStats(upperRef).drawCount).toBeGreaterThan(0);
    });

    for (const probe of probes) {
      const canvas = canvasFor(probe.name);
      const stats = blurPerformanceStats(probe.mountRef);
      expect(canvas.width).toBe(probe.expectedWidth);
      expect(canvas.height).toBe(97);
      expect(stats).toMatchObject({
        blurTargetWidth: probe.expectedWidth,
        blurTargetHeight: 97,
        gaussianPairCount: 3,
      });
    }

    const lowerSigma = effectiveHorizontalBlurSigma(canvasFor("cost-root-388"));
    const upperSigma = effectiveHorizontalBlurSigma(canvasFor("cost-root-389"));
    expect(lowerSigma).toBeGreaterThanOrEqual(1.5);
    expect(lowerSigma).toBeLessThanOrEqual(2.5);
    expect(upperSigma).toBeGreaterThanOrEqual(1.5);
    expect(upperSigma).toBeLessThanOrEqual(2.5);
    expect(Math.abs(lowerSigma - upperSigma)).toBeLessThanOrEqual(0.25);
  });

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

  it("retries failed real-size RGBA16F blur targets as RGBA8", async () => {
    const ref = createRef<PaperShaderElement>();
    const allocationAttempts: Array<"rgba16f" | "rgba8"> = [];
    let rgba16fAttemptCount = 0;
    _setZenMultipassFaultInjectionForTests({
      initialBlurTargetPrecision: "rgba16f",
      shouldFailBlurTargetAllocation: ({ precision }) => {
        allocationAttempts.push(precision);
        if (precision !== "rgba16f") return false;
        rgba16fAttemptCount += 1;
        return rgba16fAttemptCount === 2;
      },
    });
    const { container } = render(
      <DirectBlurProbe
        name="allocation-rgba8-fallback"
        sceneFragment={BLUR_POINT_SCENE}
        blur={40}
        mountRef={ref}
      />,
    );
    const host = container.querySelector<HTMLElement>(
      '[data-paper-shader="direct-blur-allocation-rgba8-fallback"]',
    );
    if (!host)
      throw new Error("Blur allocation fallback probe was not mounted");
    const contextLost = vi.fn();
    host.addEventListener("webglcontextlost", contextLost);

    await waitFor(() =>
      expect(blurPerformanceStats(ref).drawCount).toBeGreaterThan(0),
    );

    expect(blurPerformanceStats(ref)).toMatchObject({
      blurFormat: "rgba8",
      blurTargetAFormat: "rgba8",
      blurTargetBFormat: "rgba8",
      blurTargetWidth: 64,
      blurTargetHeight: 64,
    });
    expect(allocationAttempts).toEqual([
      "rgba16f",
      "rgba16f",
      "rgba8",
      "rgba8",
    ]);
    expect(contextLost).not.toHaveBeenCalled();
  });

  it("reports context loss when RGBA16F and RGBA8 blur targets both fail", async () => {
    const ref = createRef<PaperShaderElement>();
    const allocationAttempts: Array<"rgba16f" | "rgba8"> = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    _setZenMultipassFaultInjectionForTests({
      initialBlurTargetPrecision: "rgba16f",
      shouldFailBlurTargetAllocation: ({ precision }) => {
        allocationAttempts.push(precision);
        return true;
      },
    });

    try {
      const { container } = render(
        <DirectBlurProbe
          name="allocation-total-failure"
          sceneFragment={BLUR_POINT_SCENE}
          blur={40}
          mountRef={ref}
        />,
      );
      const host = container.querySelector<HTMLElement>(
        '[data-paper-shader="direct-blur-allocation-total-failure"]',
      );
      if (!host)
        throw new Error("Blur allocation failure probe was not mounted");
      const contextLostEvents: Event[] = [];
      host.addEventListener("webglcontextlost", (event) => {
        contextLostEvents.push(event);
      });

      await waitFor(() => expect(contextLostEvents).toHaveLength(1));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      expect(contextLostEvents).toHaveLength(1);
      expect(contextLostEvents[0]).toMatchObject({
        bubbles: true,
        cancelable: true,
      });
      expect(allocationAttempts).toEqual(["rgba16f", "rgba8"]);
      expect(blurPerformanceStats(ref)).toMatchObject({
        drawCount: 0,
        blurFormat: "rgba8",
        blurTargetWidth: 0,
        blurTargetHeight: 0,
        gaussianPairCount: 0,
      });
      expect(consoleError).toHaveBeenCalledTimes(1);
      const [label, error] = consoleError.mock.calls[0] ?? [];
      expect(label).toBe("[zen-shader] multipass renderer failed");
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "RGBA16F and RGBA8 allocations failed",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("transitions the shader surface to CSS fallback after a fatal initialization failure", async () => {
    const onRendererStatusChange = vi.fn();
    const rollback = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    _setZenMultipassFaultInjectionForTests({
      failInitializationAfterSetup: true,
      onInitializationRollback: rollback,
    });

    try {
      const { container } = render(
        <div style={{ position: "relative", width: 240, height: 160 }}>
          <ZenShaderSurface
            config={ZEN_SHADER_DEFAULTS}
            playing={false}
            webGlSupported
            webGlContextAttributes={WEBGL_ATTRIBUTES}
            onRendererStatusChange={onRendererStatusChange}
          />
        </div>,
      );

      await waitFor(() =>
        expect(onRendererStatusChange).toHaveBeenLastCalledWith(
          "fallback-context-lost",
        ),
      );

      const surface = container.querySelector<HTMLElement>(
        "[data-zen-shader-surface]",
      );
      expect(surface).toHaveAttribute(
        "data-zen-shader-renderer",
        "fallback-context-lost",
      );
      expect(surface?.style.background).toContain("linear-gradient");
      expect(container.querySelector("[data-paper-shader]")).toBeNull();
      expect(container.querySelector("[data-zen-glass-compositor]")).toBeNull();
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports one fatal failure when an asynchronous resize cannot reallocate the scene target", async () => {
    const ref = createRef<PaperShaderElement>();
    let failSceneAllocation = false;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    _setZenMultipassFaultInjectionForTests({
      shouldFailSceneTargetAllocation: () => failSceneAllocation,
    });

    try {
      const { container } = render(
        <ZenMultipassCanvas
          ref={ref}
          data-paper-shader="async-resize-failure"
          sceneFragment={STATIC_SCENE}
          sceneUniforms={SIZING_UNIFORMS}
          compositeFragment={buildZenMultipassCompositeFragment(1)}
          compositeUniforms={compositeUniforms(0, false)}
          minPixelRatio={1}
          maxPixelCount={128 * 128}
          speed={0}
          style={{ position: "relative", width: 64, height: 64 }}
          webGlContextAttributes={WEBGL_ATTRIBUTES}
        />,
      );
      const host = container.querySelector<HTMLElement>(
        '[data-paper-shader="async-resize-failure"]',
      );
      if (!host) throw new Error("Async resize failure probe was not mounted");
      const contextLostEvents: Event[] = [];
      host.addEventListener("webglcontextlost", (event) => {
        contextLostEvents.push(event);
      });
      await waitFor(() =>
        expect(blurPerformanceStats(ref).drawCount).toBeGreaterThan(0),
      );

      failSceneAllocation = true;
      host.style.width = "96px";
      host.style.height = "96px";
      window.dispatchEvent(new Event("resize"));

      await waitFor(() => expect(contextLostEvents).toHaveLength(1));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      expect(contextLostEvents).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const error = consoleError.mock.calls[0]?.[1];
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Unable to allocate Zen multipass scene target",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

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

  it("refracts a partial rounded UI surface without changing its padded AABB exterior", async () => {
    const { container } = render(
      <div>
        <SurfaceCompositeProbe name="rounded-flat" refracts refraction={0} />
        <SurfaceCompositeProbe name="rounded-bent" refracts refraction={24} />
      </div>,
    );
    const flat = canvasFrom(
      container.querySelector<HTMLElement>(
        '[data-paper-shader="surface-rounded-flat"]',
      ) ?? container,
    );
    const bent = canvasFrom(
      container.querySelector<HTMLElement>(
        '[data-paper-shader="surface-rounded-bent"]',
      ) ?? container,
    );

    await waitFor(() => {
      expect(readPixel(flat, 160, 64)[3]).toBe(255);
      expect(readPixel(bent, 160, 64)[3]).toBe(255);
    });

    expect(
      Math.abs(
        (readPixel(bent, 72, 64)[0] ?? 0) - (readPixel(flat, 72, 64)[0] ?? 0),
      ),
    ).toBeGreaterThan(10);
    for (const x of [61, 160]) {
      expect(
        Math.abs(
          (readPixel(bent, x, 64)[0] ?? 0) - (readPixel(flat, x, 64)[0] ?? 0),
        ),
      ).toBeLessThanOrEqual(1);
    }
  });

  it("keeps contrast-only UI surfaces unrefracted while preserving their mask", async () => {
    const { container } = render(
      <div>
        <SurfaceCompositeProbe
          name="contrast-only-flat"
          refracts={false}
          refraction={0}
        />
        <SurfaceCompositeProbe
          name="contrast-only-bent"
          refracts={false}
          refraction={24}
        />
        <SurfaceCompositeProbe
          name="contrast-off"
          refracts={false}
          refraction={0}
          editorMask
        />
        <SurfaceCompositeProbe
          name="contrast-on"
          refracts={false}
          refraction={0}
          contrast
          editorMask
        />
      </div>,
    );
    const findCanvas = (name: string) =>
      canvasFrom(
        container.querySelector<HTMLElement>(
          `[data-paper-shader="surface-${name}"]`,
        ) ?? container,
      );
    const flat = findCanvas("contrast-only-flat");
    const bent = findCanvas("contrast-only-bent");
    const contrastOff = findCanvas("contrast-off");
    const contrastOn = findCanvas("contrast-on");

    await waitFor(() => {
      for (const canvas of [flat, bent, contrastOff, contrastOn]) {
        expect(readPixel(canvas, 160, 64)[3]).toBe(255);
      }
    });

    for (const x of [72, 120]) {
      expect(
        Math.abs(
          (readPixel(bent, x, 64)[0] ?? 0) - (readPixel(flat, x, 64)[0] ?? 0),
        ),
      ).toBeLessThanOrEqual(1);
    }
    expect(
      Math.abs(
        (readPixel(contrastOn, 96, 64)[0] ?? 0) -
          (readPixel(contrastOff, 96, 64)[0] ?? 0),
      ),
    ).toBeGreaterThan(20);
    expect(
      Math.abs(
        (readPixel(contrastOn, 160, 64)[0] ?? 0) -
          (readPixel(contrastOff, 160, 64)[0] ?? 0),
      ),
    ).toBeLessThanOrEqual(1);
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

  it("rolls back constructor resources and reports one failure when Strict Mode replays initialization", async () => {
    const rollback = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const disconnectObserver = vi.spyOn(ResizeObserver.prototype, "disconnect");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    _setZenMultipassFaultInjectionForTests({
      failInitializationAfterSetup: true,
      onInitializationRollback: rollback,
    });

    try {
      const { container } = render(
        <StrictMode>
          <ZenMultipassCanvas
            data-paper-shader="strict-mode-constructor-failure"
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
      const host = container.querySelector<PaperShaderElement>(
        '[data-paper-shader="strict-mode-constructor-failure"]',
      );
      if (!host)
        throw new Error(
          "Strict Mode constructor failure probe was not mounted",
        );
      const contextLostEvents: Event[] = [];
      host.addEventListener("webglcontextlost", (event) => {
        contextLostEvents.push(event);
      });

      await waitFor(() => expect(contextLostEvents).toHaveLength(1));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      expect(rollback).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(contextLostEvents).toHaveLength(1);
      expect(host.paperShaderMount).toBeUndefined();
      expect(cancelFrame.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(disconnectObserver.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(
        removeWindowListener.mock.calls.filter(([type]) => type === "resize"),
      ).toHaveLength(2);
    } finally {
      removeWindowListener.mockRestore();
      disconnectObserver.mockRestore();
      cancelFrame.mockRestore();
      consoleError.mockRestore();
    }
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

  it("caps renderer-owned animation draws at 60fps without slowing shader time", () => {
    const frames = new ManualAnimationFrames();
    _setZenMultipassFaultInjectionForTests({
      animationFrameDriver: frames,
    });
    const ref = createRef<PaperShaderElement>();
    const { container } = render(
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="capped-animation-probe"
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
    const mount = ref.current?.paperShaderMount;
    if (!mount) throw new Error("Zen multipass mount was not initialized");

    frames.step(0);
    expect(mount.getPerformanceStats().drawCount).toBeGreaterThan(0);
    mount.resetPerformanceStats();

    for (let timestamp = 5; timestamp <= 1_000; timestamp += 5) {
      frames.step(timestamp);
    }

    expect(mount.getPerformanceStats().drawCount).toBeGreaterThanOrEqual(58);
    expect(mount.getPerformanceStats().drawCount).toBeLessThanOrEqual(60);
    expect(mount.getCurrentFrame()).toBeCloseTo(1_000, 5);
    expect(readCenterRed(canvas)).toBeGreaterThan(235);
  });

  it("draws an external invalidation before the animation interval elapses", () => {
    const frames = new ManualAnimationFrames();
    _setZenMultipassFaultInjectionForTests({
      animationFrameDriver: frames,
    });
    const ref = createRef<PaperShaderElement>();
    const view = render(
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="animation-invalidation-probe"
        sceneFragment={STATIC_SCENE}
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
    const mount = ref.current?.paperShaderMount;
    if (!mount) throw new Error("Zen multipass mount was not initialized");

    frames.step(0);
    mount.resetPerformanceStats();
    frames.step(5);
    expect(mount.getPerformanceStats().drawCount).toBe(0);

    view.rerender(
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="animation-invalidation-probe"
        sceneFragment={STATIC_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(1, false)}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={1}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );
    frames.step(10);

    expect(mount.getPerformanceStats().drawCount).toBe(1);
  });

  it("uploads static uniforms only when their owning props change", () => {
    const frames = new ManualAnimationFrames();
    const applied: Array<"scene" | "composite"> = [];
    _setZenMultipassFaultInjectionForTests({
      animationFrameDriver: frames,
      onStaticUniformsApplied: (pass) => applied.push(pass),
    });
    const sceneA = { ...SIZING_UNIFORMS, u_sceneTint: [0.8, 0.6, 0.4] };
    const sceneB = { ...SIZING_UNIFORMS, u_sceneTint: [0.4, 0.6, 0.8] };
    const compositeA = {
      u_compositeTint: [1, 1, 1],
      u_zenGlassEnabled: 0,
      u_zenGlassBlur: 0,
    };
    const compositeB = {
      u_compositeTint: [0.9, 1, 1],
      u_zenGlassEnabled: 0,
      u_zenGlassBlur: 0,
    };
    const ref = createRef<PaperShaderElement>();
    const probe = (
      sceneUniforms: ShaderMountUniforms,
      compositeUniforms: ShaderMountUniforms,
    ) => (
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="static-uniform-probe"
        sceneFragment={STATIC_UNIFORM_SCENE}
        sceneUniforms={sceneUniforms}
        compositeFragment={STATIC_UNIFORM_COMPOSITE}
        compositeUniforms={compositeUniforms}
        mipmaps={NO_MIPMAPS}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={1}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />
    );
    const view = render(probe(sceneA, compositeA));

    frames.step(0);
    expect(applied).toEqual(["scene", "composite"]);
    applied.length = 0;

    frames.step(20);
    expect(ref.current?.paperShaderMount?.getPerformanceStats().drawCount).toBe(
      2,
    );
    expect(applied).toEqual([]);

    view.rerender(probe(sceneB, compositeA));
    frames.step(25);
    expect(applied).toEqual(["scene"]);
    applied.length = 0;

    view.rerender(probe(sceneB, compositeB));
    frames.step(30);
    expect(applied).toEqual(["composite"]);
  });

  it("keeps image texture bindings stable after blur target allocation", async () => {
    const frames = new ManualAnimationFrames();
    _setZenMultipassFaultInjectionForTests({ animationFrameDriver: frames });
    const image = await loadVerticalStepImage();
    const ref = createRef<PaperShaderElement>();
    const { container } = render(
      <DirectBlurProbe
        name="image-binding"
        sceneFragment={IMAGE_SCENE}
        sceneUniforms={{ ...SIZING_UNIFORMS, u_image: image }}
        blur={22}
        speed={1}
        mountRef={ref}
      />,
    );
    const canvas = canvasFrom(container);

    frames.step(0);
    const first = readPixel(canvas, 160, 128)[0] ?? 0;
    expect(first).toBeGreaterThan(128);

    frames.step(20);
    const second = readPixel(canvas, 160, 128)[0] ?? 0;
    expect(Math.abs(second - first)).toBeLessThanOrEqual(1);
  });

  it("keeps same-named image uniforms isolated between programs", async () => {
    const frames = new ManualAnimationFrames();
    _setZenMultipassFaultInjectionForTests({ animationFrameDriver: frames });
    const [sceneImage, compositeImage] = await Promise.all([
      loadSolidImage("red"),
      loadSolidImage("blue"),
    ]);
    const { container } = render(
      <ZenMultipassCanvas
        data-paper-shader="program-image-isolation"
        sceneFragment={IMAGE_SCENE}
        sceneUniforms={{ ...SIZING_UNIFORMS, u_image: sceneImage }}
        compositeFragment={IMAGE_SPLIT_COMPOSITE}
        compositeUniforms={{
          u_image: compositeImage,
          u_zenGlassEnabled: 0,
          u_zenGlassBlur: 0,
        }}
        mipmaps={NO_MIPMAPS}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={1}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );
    const canvas = canvasFrom(container);

    frames.step(0);
    expect(readPixel(canvas, 16, 32)).toEqual(new Uint8Array([255, 0, 0, 255]));
    expect(readPixel(canvas, 48, 32)).toEqual(new Uint8Array([0, 0, 255, 255]));

    frames.step(20);
    expect(readPixel(canvas, 16, 32)).toEqual(new Uint8Array([255, 0, 0, 255]));
    expect(readPixel(canvas, 48, 32)).toEqual(new Uint8Array([0, 0, 255, 255]));
  });

  it("does not clear the fully overwritten composite framebuffer", () => {
    const frames = new ManualAnimationFrames();
    _setZenMultipassFaultInjectionForTests({ animationFrameDriver: frames });
    const clear = vi.spyOn(WebGL2RenderingContext.prototype, "clear");
    try {
      render(
        <ZenMultipassCanvas
          data-paper-shader="composite-clear-probe"
          sceneFragment={STATIC_SCENE}
          sceneUniforms={SIZING_UNIFORMS}
          compositeFragment={STATIC_UNIFORM_COMPOSITE}
          compositeUniforms={{
            u_compositeTint: [1, 1, 1],
            u_zenGlassEnabled: 0,
            u_zenGlassBlur: 0,
          }}
          minPixelRatio={1}
          maxPixelCount={64 * 64}
          speed={0}
          style={{ position: "relative", width: 64, height: 64 }}
          webGlContextAttributes={WEBGL_ATTRIBUTES}
        />,
      );
      frames.step(0);

      // Scene may conservatively clear its FBO; Composite overwrites every
      // default-framebuffer pixel and must not issue a second clear.
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      clear.mockRestore();
    }
  });

  it("publishes one coherent GPU timing sample with actual draw calls", async () => {
    const backend = new ImmediateGpuTimerBackend();
    _setZenMultipassFaultInjectionForTests({
      createGpuTimerBackend: () => backend,
    });
    const ref = createRef<PaperShaderElement>();
    const { container } = render(
      <DirectBlurProbe
        name="gpu-timing"
        sceneFragment={BLUR_POINT_SCENE}
        blur={22}
        mountRef={ref}
      />,
    );
    const canvas = canvasFrom(container);

    await waitFor(() => expect(readCenterRed(canvas)).toBeGreaterThan(0));
    await waitFor(() =>
      expect(multipassPerformanceStats(ref).gpuTimingStatus).toBe("ready"),
    );

    expect(multipassPerformanceStats(ref)).toMatchObject({
      drawCallCount: 5,
      gpuTimeMs: 15,
      gpuPassTimesMs: {
        scene: 1,
        downsample: 2,
        gaussianHorizontal: 3,
        gaussianVertical: 4,
        composite: 5,
      },
      gpuTimingSampleCount: 1,
      gpuTimingSampleDrawCount: 1,
      sceneTargetWidth: 256,
      sceneTargetHeight: 256,
    });
  });

  it("polls the GPU timer only once when a sampled frame begins", () => {
    const frames = new ManualAnimationFrames();
    const backend = new ImmediateGpuTimerBackend();
    _setZenMultipassFaultInjectionForTests({
      animationFrameDriver: frames,
      createGpuTimerBackend: () => backend,
    });
    render(
      <ZenMultipassCanvas
        data-paper-shader="gpu-timing-poll"
        sceneFragment={STATIC_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={STATIC_UNIFORM_COMPOSITE}
        compositeUniforms={{
          u_compositeTint: [1, 1, 1],
          u_zenGlassEnabled: 0,
          u_zenGlassBlur: 0,
        }}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );

    frames.step(0);

    expect(backend.disjointCheckCount).toBe(1);
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

  it("keeps the legacy WebGL correction polarity at a float32 tie", async () => {
    const boundaryColor = [3 / 255, 137 / 255, 1 / 255] as const;
    const ref = createRef<PaperShaderElement>();
    const { container } = render(
      <ZenMultipassCanvas
        ref={ref}
        data-paper-shader="contrast-polarity-tie"
        sceneFragment={STATIC_SCENE}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms(0.6, true, {
          ...RUNTIME,
          textColor: boundaryColor,
        })}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
        webGlContextAttributes={WEBGL_ATTRIBUTES}
      />,
    );
    const canvas = canvasFrom(container);

    await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
    await waitFor(() =>
      expect(
        ref.current?.paperShaderMount?.getPerformanceStats().isStaticFrameReady,
      ).toBe(true),
    );
    await waitFor(() => {
      const pixel = readCenterPixel(canvas);
      expect(pixel[3]).toBe(255);
      expect(
        Math.max(pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0),
      ).toBeLessThanOrEqual(1);
    });
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
