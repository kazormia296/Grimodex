import { createRef, type RefObject } from "react";
import { cleanup, render } from "@testing-library/react";
import type {
  PaperShaderElement,
  ShaderMount,
  ShaderMountUniforms,
} from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import {
  ZenBlurResearchCanvas,
  type ZenMultipassPerformanceStats,
} from "./ZenBlurResearchCanvas";
import { ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT } from "./zenShaderResearchPipeline";

const SCENE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
  fragColor = vec4(uv, 0.25, 1.0);
}`;

const SCENE_UNIFORMS: ShaderMountUniforms = {
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

const COMPOSITE_UNIFORMS: ShaderMountUniforms = {
  u_zenGlassEnabled: 0,
  u_zenGlassBlur: 0,
};

type ResearchMount = ShaderMount & {
  getPerformanceStats(): ZenMultipassPerformanceStats;
};

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as ResearchMount | undefined;
  if (!mount) throw new Error("Research mount is unavailable");
  return mount;
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitUntil(predicate: () => boolean) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > 5_000) {
      throw new Error("Timed out waiting for research canvas");
    }
    await nextFrame();
  }
}

async function singleFrameStats(ref: RefObject<PaperShaderElement | null>) {
  await waitUntil(
    () => currentMount(ref).getPerformanceStats().isStaticFrameReady,
  );
  const mount = currentMount(ref);
  mount.resetPerformanceStats();
  mount.setFrame(1_000);
  await waitUntil(() => mount.getPerformanceStats().drawCount === 1);
  return mount.getPerformanceStats();
}

afterEach(cleanup);

describe("Zen blur research canvas render pipelines", () => {
  it("draws raw directly without Scene target storage or sampling", async () => {
    const ref = createRef<PaperShaderElement>();
    render(
      <ZenBlurResearchCanvas
        ref={ref}
        data-paper-shader="direct-research"
        sceneFragment={SCENE_FRAGMENT}
        sceneUniforms={SCENE_UNIFORMS}
        compositeFragment={ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT}
        compositeUniforms={COMPOSITE_UNIFORMS}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        renderPipeline="direct"
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
      />,
    );

    const stats = await singleFrameStats(ref);
    expect(stats).toMatchObject({
      drawCount: 1,
      drawCallCount: 1,
      renderPipeline: "direct",
      renderWidth: 64,
      renderHeight: 64,
      sceneTargetWidth: 0,
      sceneTargetHeight: 0,
      sceneTargetBytes: 0,
      totalIntermediateTextureBytes: 0,
    });
  });

  it("keeps the Scene FBO plus passthrough Composite as two draws", async () => {
    const ref = createRef<PaperShaderElement>();
    render(
      <ZenBlurResearchCanvas
        ref={ref}
        data-paper-shader="scene-research"
        sceneFragment={SCENE_FRAGMENT}
        sceneUniforms={SCENE_UNIFORMS}
        compositeFragment={ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT}
        compositeUniforms={COMPOSITE_UNIFORMS}
        minPixelRatio={1}
        maxPixelCount={64 * 64}
        renderPipeline="multipass"
        speed={0}
        style={{ position: "relative", width: 64, height: 64 }}
      />,
    );

    const stats = await singleFrameStats(ref);
    expect(stats).toMatchObject({
      drawCount: 1,
      drawCallCount: 2,
      renderPipeline: "multipass",
      renderWidth: 64,
      renderHeight: 64,
      sceneTargetWidth: 64,
      sceneTargetHeight: 64,
      sceneTargetBytes: 64 * 64 * 4,
      totalIntermediateTextureBytes: 64 * 64 * 4,
    });
  });
});
