import { createRef, type RefObject } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { PaperShaderElement, ShaderMount } from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import { type ZenMultipassPerformanceStats } from "./ZenBlurResearchCanvas";
import { ZenShaderResearchSurface } from "./ZenShaderResearchSurface";
import { DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS } from "./zenBlurResearchConfig";
import type { ZenShaderResearchPipeline } from "./zenShaderResearchPipeline";

type ResearchMount = ShaderMount & {
  getPerformanceStats(): ZenMultipassPerformanceStats;
  resetPerformanceStats(): void;
};

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as ResearchMount | undefined;
  if (!mount) throw new Error("Zen shader research mount is unavailable");
  return mount;
}

async function renderImageShader(pipeline: ZenShaderResearchPipeline) {
  const ref = createRef<PaperShaderElement>();
  const view = render(
    <ZenShaderResearchSurface
      ref={ref}
      shader="image-dithering"
      pipeline={pipeline}
      dither={false}
      ditherStrength={0.45}
      halftone={false}
      halftoneStrength={0.3}
      contrast={false}
      glass={false}
      blur={22}
      frame={1_000}
      width={96}
      height={64}
      researchOptions={DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS}
    />,
  );

  await waitFor(
    () => {
      expect(currentMount(ref).getPerformanceStats().isStaticFrameReady).toBe(
        true,
      );
    },
    { timeout: 10_000 },
  );
  const mount = currentMount(ref);
  mount.resetPerformanceStats();
  mount.setFrame(1_000);
  await waitFor(() => {
    expect(mount.getPerformanceStats().drawCount).toBe(1);
  });
  const canvas = view.container.querySelector("canvas");
  const gl = canvas?.getContext("webgl2");
  if (!canvas || !gl) throw new Error("Research WebGL canvas is unavailable");
  expect(gl.getError()).toBe(gl.NO_ERROR);
  return mount.getPerformanceStats();
}

afterEach(cleanup);

describe("Zen shader research image inputs", () => {
  it.each([
    ["raw", 1, 0],
    ["full", 2, 96 * 64 * 4],
  ] as const)(
    "uploads and renders image-dithering through %s",
    async (pipeline, drawCalls, sceneTargetBytes) => {
      const stats = await renderImageShader(pipeline);
      expect(stats).toMatchObject({
        drawCount: 1,
        drawCallCount: drawCalls,
        renderPipeline: pipeline === "raw" ? "direct" : "multipass",
        renderWidth: 96,
        renderHeight: 64,
        sceneTargetBytes,
        imageTextureCount: 1,
      });
    },
  );
});
