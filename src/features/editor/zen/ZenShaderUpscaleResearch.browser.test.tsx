import { createRef, type RefObject } from "react";
import { cleanup, render } from "@testing-library/react";
import type { PaperShaderElement, ShaderMount } from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ZenMultipassPerformanceStats,
  ZenResearchRenderPipeline,
} from "./ZenBlurResearchCanvas";
import { ZenShaderResearchSurface } from "./ZenShaderResearchSurface";
import { DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS } from "./zenBlurResearchConfig";
import type { ZenShaderResearchUpscaler } from "./zenShaderUpscaleResearch";

type UpscaleResearchMount = {
  getPerformanceStats(): ZenMultipassPerformanceStats;
  resetPerformanceStats(): void;
  setResearchRenderPipeline(pipeline: ZenResearchRenderPipeline): void;
} & ShaderMount;

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as
    | UpscaleResearchMount
    | undefined;
  if (!mount) throw new Error("Zen shader upscale research mount is unavailable");
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
});
