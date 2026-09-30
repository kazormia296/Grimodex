import { createRef, type RefObject } from "react";
import { cleanup, render } from "@testing-library/react";
import type { PaperShaderElement, ShaderMount } from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ZenMultipassPerformanceStats,
  type ZenResearchRenderPipeline,
} from "./ZenBlurResearchCanvas";
import { ZenShaderResearchSurface } from "./ZenShaderResearchSurface";
import { DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS } from "./zenBlurResearchConfig";

interface AbbaResearchPerformanceStats extends ZenMultipassPerformanceStats {
  contextId: string;
  resourceEpoch: number;
  residentIntermediateTextureBytes: number;
}

type AbbaResearchMount = {
  setResearchRenderPipeline(pipeline: ZenResearchRenderPipeline): void;
  getPerformanceStats(): AbbaResearchPerformanceStats;
  resetPerformanceStats(): void;
} & ShaderMount;

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as AbbaResearchMount | undefined;
  if (!mount) throw new Error("Zen shader ABBA research mount is unavailable");
  return mount;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10_000,
) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error(message);
    await nextAnimationFrame();
  }
}

async function drawVariant(
  mount: AbbaResearchMount,
  pipeline: ZenResearchRenderPipeline,
) {
  mount.resetPerformanceStats();
  mount.setResearchRenderPipeline(pipeline);
  mount.setFrame(1_000);
  await waitUntil(() => {
    const stats = mount.getPerformanceStats();
    return stats.drawCount === 1 && stats.isStaticFrameReady;
  }, `Zen shader ABBA ${pipeline} frame did not render`);
  return mount.getPerformanceStats();
}

afterEach(cleanup);

describe("Zen shader ABBA same-context pipeline switching", () => {
  it("switches multipass -> direct -> multipass without replacing its context or resources", async () => {
    const ref = createRef<PaperShaderElement>();
    const view = render(
      <ZenShaderResearchSurface
        ref={ref}
        shader="dot-grid"
        pipeline="full"
        dither={true}
        ditherStrength={0.45}
        halftone={true}
        halftoneStrength={0.3}
        contrast={false}
        glass={false}
        blur={22}
        frame={1_000}
        width={64}
        height={64}
        researchOptions={DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS}
      />,
    );

    await waitUntil(
      () => currentMount(ref).getPerformanceStats().isStaticFrameReady,
      "Zen shader ABBA research surface did not become ready",
    );
    const mount = currentMount(ref);
    const canvas = view.container.querySelector("canvas");
    const context = canvas?.getContext("webgl2");
    if (!canvas || !context) {
      throw new Error("Zen shader ABBA WebGL2 context is unavailable");
    }

    const firstFull = await drawVariant(mount, "multipass");
    const direct = await drawVariant(mount, "direct");
    const secondFull = await drawVariant(mount, "multipass");
    const residentSceneBytes = 64 * 64 * 4;

    expect(firstFull).toMatchObject({
      drawCount: 1,
      drawCallCount: 2,
      renderPipeline: "multipass",
      sceneTargetBytes: residentSceneBytes,
    });
    expect(direct).toMatchObject({
      drawCount: 1,
      drawCallCount: 1,
      renderPipeline: "direct",
      sceneTargetBytes: 0,
    });
    expect(secondFull).toMatchObject({
      drawCount: 1,
      drawCallCount: 2,
      renderPipeline: "multipass",
      sceneTargetBytes: residentSceneBytes,
    });

    expect(firstFull.contextId).toEqual(expect.any(String));
    expect(firstFull.contextId).not.toBe("");
    expect(firstFull.resourceEpoch).toBeGreaterThan(0);
    expect(firstFull.residentIntermediateTextureBytes).toBeGreaterThanOrEqual(
      residentSceneBytes,
    );
    for (const stats of [direct, secondFull]) {
      expect(stats.contextId).toBe(firstFull.contextId);
      expect(stats.resourceEpoch).toBe(firstFull.resourceEpoch);
      expect(stats.residentIntermediateTextureBytes).toBe(
        firstFull.residentIntermediateTextureBytes,
      );
    }

    expect(currentMount(ref)).toBe(mount);
    expect(canvas.getContext("webgl2")).toBe(context);
    expect(context.getError()).toBe(context.NO_ERROR);
  });
});
