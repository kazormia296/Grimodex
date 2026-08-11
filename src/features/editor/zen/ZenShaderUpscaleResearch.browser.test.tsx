import { createRef, type RefObject } from "react";
import { cleanup, render } from "@testing-library/react";
import type {
  PaperShaderElement,
  ShaderMount,
  ShaderMountUniforms,
} from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ZenMultipassPerformanceStats,
  ZenResearchRenderPipeline,
} from "./ZenBlurResearchCanvas";
import { ZenBlurResearchCanvas } from "./ZenBlurResearchCanvas";
import { ZenShaderResearchSurface } from "./ZenShaderResearchSurface";
import { DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS } from "./zenBlurResearchConfig";
import {
  buildZenShaderResearchUpscaleFragment,
  type ZenShaderResearchUpscaler,
} from "./zenShaderUpscaleResearch";
import { ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT } from "./zenShaderResearchPipeline";

type UpscaleResearchMount = {
  getPerformanceStats(): ZenMultipassPerformanceStats;
  resetPerformanceStats(): void;
  setResearchRenderPipeline(pipeline: ZenResearchRenderPipeline): void;
} & ShaderMount;

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as
    | UpscaleResearchMount
    | undefined;
  if (!mount)
    throw new Error("Zen shader upscale research mount is unavailable");
  return mount;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitUntil(predicate: () => boolean, message: string) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > 10_000) throw new Error(message);
    await nextAnimationFrame();
  }
}

async function drawOnce(
  mount: UpscaleResearchMount,
  pipeline: ZenResearchRenderPipeline,
) {
  mount.resetPerformanceStats();
  mount.setResearchRenderPipeline(pipeline);
  mount.setFrame(1_000);
  await waitUntil(() => {
    const stats = mount.getPerformanceStats();
    return stats.drawCount === 1 && stats.isStaticFrameReady;
  }, `${pipeline} upscale research frame did not render`);
  return mount.getPerformanceStats();
}

const SYNTHETIC_SCENE_UNIFORMS: ShaderMountUniforms = {
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

const SYNTHETIC_COMPOSITE_UNIFORMS: ShaderMountUniforms = {
  u_zenGlassEnabled: 0,
  u_zenGlassBlur: 0,
};

const CONSTANT_COLOR_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.2, 0.4, 0.6, 0.5);
}`;

const ORIENTED_PATTERN_FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float checker = mod(
    floor(gl_FragCoord.x * 0.5) + floor(gl_FragCoord.y * 0.5),
    2.0
  );
  float diagonal = 1.0 - step(0.09, abs(uv.y - uv.x));
  float rightEdge = step(u_resolution.x - 1.0, gl_FragCoord.x);
  fragColor = vec4(checker, diagonal, rightEdge, 1.0);
}`;

interface SyntheticPixels {
  width: number;
  height: number;
  pixels: Uint8Array;
}

async function renderSyntheticPixels({
  sceneFragment,
  sceneScale,
  upscaler,
  compositeFragment = buildZenShaderResearchUpscaleFragment(upscaler),
  width = 24,
  height = 16,
}: {
  sceneFragment: string;
  sceneScale: number;
  upscaler: ZenShaderResearchUpscaler;
  compositeFragment?: string;
  width?: number;
  height?: number;
}): Promise<SyntheticPixels> {
  const ref = createRef<PaperShaderElement>();
  const view = render(
    <ZenBlurResearchCanvas
      ref={ref}
      data-paper-shader="upscale-pixel-contract"
      sceneFragment={sceneFragment}
      sceneUniforms={SYNTHETIC_SCENE_UNIFORMS}
      compositeFragment={compositeFragment}
      compositeUniforms={SYNTHETIC_COMPOSITE_UNIFORMS}
      minPixelRatio={1}
      maxPixelCount={width * height}
      webGlContextAttributes={{
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      }}
      blurTargetPrecision="rgba8"
      researchOptions={DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS}
      renderPipeline="multipass"
      sceneScale={sceneScale}
      upscaler={upscaler}
      speed={0}
      style={{ position: "relative", width, height }}
    />,
  );

  await waitUntil(
    () => currentMount(ref).getPerformanceStats().isStaticFrameReady,
    `${upscaler} synthetic pixel surface did not become ready`,
  );
  await drawOnce(currentMount(ref), "multipass");
  const canvas = view.container.querySelector("canvas");
  const gl = canvas?.getContext("webgl2");
  if (!canvas || !gl) throw new Error("WebGL2 pixel surface is unavailable");
  expect(canvas.width).toBe(width);
  expect(canvas.height).toBe(height);
  gl.finish();
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  expect(gl.getError()).toBe(gl.NO_ERROR);
  view.unmount();
  return { width, height, pixels };
}

function pixelAt({ width, pixels }: SyntheticPixels, x: number, y: number) {
  const offset = (y * width + x) * 4;
  return pixels.slice(offset, offset + 4);
}

function channelValues(pixels: Uint8Array, channel: number) {
  const values: number[] = [];
  for (let offset = channel; offset < pixels.length; offset += 4) {
    values.push(pixels[offset] ?? 0);
  }
  return values;
}

afterEach(cleanup);

describe("Zen shader same-context spatial upscaling", () => {
  for (const upscaler of [
    "linear",
    "catmull-rom",
    "easu",
    "easu-rcas",
  ] as const satisfies readonly ZenShaderResearchUpscaler[]) {
    it(`renders a 75% Scene with ${upscaler} at the native canvas size`, async () => {
      const ref = createRef<PaperShaderElement>();
      const view = render(
        <ZenShaderResearchSurface
          ref={ref}
          shader="dot-grid"
          pipeline="scene"
          dither={false}
          ditherStrength={0.45}
          halftone={false}
          halftoneStrength={0.3}
          contrast={false}
          glass={false}
          blur={22}
          frame={1_000}
          width={80}
          height={48}
          sceneScale={3 / 4}
          upscaler={upscaler}
          researchOptions={DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS}
        />,
      );

      await waitUntil(
        () => currentMount(ref).getPerformanceStats().isStaticFrameReady,
        `${upscaler} research surface did not become ready`,
      );
      const mount = currentMount(ref);
      const canvas = view.container.querySelector("canvas");
      const context = canvas?.getContext("webgl2");
      if (!canvas || !context) throw new Error("WebGL2 context is unavailable");

      const candidate = await drawOnce(mount, "multipass");
      const native = await drawOnce(mount, "direct");
      const candidateAgain = await drawOnce(mount, "multipass");
      const sceneBytes = 60 * 36 * 4;
      const sharpenBytes = upscaler === "easu-rcas" ? 80 * 48 * 4 : 0;

      expect(candidate).toMatchObject({
        renderPipeline: "multipass",
        renderWidth: 80,
        renderHeight: 48,
        sceneScale: 3 / 4,
        upscaler,
        sceneTargetWidth: 60,
        sceneTargetHeight: 36,
        sceneTargetBytes: sceneBytes,
        upscaleTargetWidth: upscaler === "easu-rcas" ? 80 : 0,
        upscaleTargetHeight: upscaler === "easu-rcas" ? 48 : 0,
        upscaleTargetBytes: sharpenBytes,
        drawCallCount: upscaler === "easu-rcas" ? 3 : 2,
        sceneDrawCallCount: 1,
        upscaleDrawCallCount: 1,
        sharpenDrawCallCount: upscaler === "easu-rcas" ? 1 : 0,
        totalIntermediateTextureBytes: sceneBytes + sharpenBytes,
      });
      expect(native).toMatchObject({
        renderPipeline: "direct",
        renderWidth: 80,
        renderHeight: 48,
        sceneTargetBytes: 0,
        upscaleTargetBytes: 0,
        drawCallCount: 1,
        sceneDrawCallCount: 1,
        upscaleDrawCallCount: 0,
        sharpenDrawCallCount: 0,
        totalIntermediateTextureBytes: 0,
      });
      expect(candidateAgain).toMatchObject(candidate);
      expect(candidate.contextId).toEqual(expect.any(String));
      expect(native.contextId).toBe(candidate.contextId);
      expect(candidateAgain.contextId).toBe(candidate.contextId);
      expect(native.resourceEpoch).toBe(candidate.resourceEpoch);
      expect(candidateAgain.resourceEpoch).toBe(candidate.resourceEpoch);
      expect(native.residentIntermediateTextureBytes).toBe(
        candidate.residentIntermediateTextureBytes,
      );
      expect(canvas.getContext("webgl2")).toBe(context);
      expect(context.getError()).toBe(context.NO_ERROR);
    });
  }

  it("matches the passthrough Composite byte-for-byte at scale 1 with linear sampling", async () => {
    const passthrough = await renderSyntheticPixels({
      sceneFragment: ORIENTED_PATTERN_FRAGMENT,
      sceneScale: 1,
      upscaler: "linear",
      compositeFragment: ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT,
    });
    const linear = await renderSyntheticPixels({
      sceneFragment: ORIENTED_PATTERN_FRAGMENT,
      sceneScale: 1,
      upscaler: "linear",
    });

    expect(linear.pixels).toEqual(passthrough.pixels);
  });

  it("preserves constant RGBA8 color and alpha through every upscaler", async () => {
    for (const upscaler of [
      "linear",
      "catmull-rom",
      "easu",
      "easu-rcas",
    ] as const satisfies readonly ZenShaderResearchUpscaler[]) {
      const { pixels } = await renderSyntheticPixels({
        sceneFragment: CONSTANT_COLOR_FRAGMENT,
        sceneScale: 3 / 4,
        upscaler,
      });
      const expected = [51, 102, 153, 128];
      for (let offset = 0; offset < pixels.length; offset += 4) {
        for (let channel = 0; channel < 4; channel += 1) {
          expect(
            Math.abs((pixels[offset + channel] ?? 0) - expected[channel]!),
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("keeps checker detail, diagonal orientation, and a one-pixel edge valid", async () => {
    for (const upscaler of [
      "linear",
      "catmull-rom",
      "easu",
      "easu-rcas",
    ] as const satisfies readonly ZenShaderResearchUpscaler[]) {
      const image = await renderSyntheticPixels({
        sceneFragment: ORIENTED_PATTERN_FRAGMENT,
        sceneScale: 3 / 4,
        upscaler,
      });
      const red = channelValues(image.pixels, 0);
      const alpha = channelValues(image.pixels, 3);
      expect(Math.min(...red)).toBeLessThan(64);
      expect(Math.max(...red)).toBeGreaterThan(191);
      expect(alpha.every((value) => value === 255)).toBe(true);

      let diagonalScore = 0;
      let flippedScore = 0;
      for (let x = 0; x < image.width; x += 1) {
        const y = Math.round((x / (image.width - 1)) * (image.height - 1));
        diagonalScore += pixelAt(image, x, y)[1] ?? 0;
        flippedScore += pixelAt(image, x, image.height - 1 - y)[1] ?? 0;
      }
      expect(diagonalScore).toBeGreaterThan(flippedScore + 1_000);

      const middleY = Math.floor(image.height / 2);
      expect(pixelAt(image, image.width - 1, middleY)[2]).toBeGreaterThan(160);
      expect(pixelAt(image, 0, middleY)[2]).toBeLessThan(64);
    }
  });

  it("keeps EASU plus RCAS representative pixels in the expected orientation", async () => {
    const image = await renderSyntheticPixels({
      sceneFragment: ORIENTED_PATTERN_FRAGMENT,
      sceneScale: 3 / 4,
      upscaler: "easu-rcas",
    });

    expect(pixelAt(image, 0, 0)[1]).toBeGreaterThan(160);
    expect(pixelAt(image, 0, image.height - 1)[1]).toBeLessThan(96);
    expect(
      pixelAt(image, image.width - 1, image.height - 1)[1],
    ).toBeGreaterThan(160);
    expect(pixelAt(image, image.width - 1, 0)[1]).toBeLessThan(96);
    expect(
      pixelAt(image, image.width - 1, Math.floor(image.height / 2))[2],
    ).toBeGreaterThan(160);
  });
});
