import type { ZenShaderResearchPipeline } from "./zenShaderResearchPipeline";

export type ZenShaderResearchWorkload =
  | "paper"
  | "clear-only"
  | "solid-fullscreen"
  | "texture-copy";

export type ZenShaderResearchSceneOperation = "clear-only" | "fullscreen";

export interface ZenShaderResearchExpectedTopology {
  clearCallsPerFrame: number;
  sceneDrawCallsPerFrame: number;
  compositeDrawCallsPerFrame: number;
  totalDrawCallsPerFrame: number;
  sceneTargetBytesPerPixel: number;
}

export interface ZenShaderResearchWorkloadPlan {
  workload: ZenShaderResearchWorkload;
  pipeline: Extract<ZenShaderResearchPipeline, "raw" | "scene">;
  renderPipeline: "direct" | "multipass";
  sceneOperation: ZenShaderResearchSceneOperation;
  sceneFragmentKind: "paper" | "solid";
  compositeFragmentKind: "none" | "copy";
  expectedTopology: ZenShaderResearchExpectedTopology;
}

export interface ZenShaderResearchResolution {
  id: string;
  width: number;
  height: number;
  pixelCount: number;
}

export const ZEN_SHADER_RESEARCH_SOLID_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.25, 0.5, 0.75, 1.0);
}`;

function directPlan(
  workload: Extract<
    ZenShaderResearchWorkload,
    "clear-only" | "solid-fullscreen"
  >,
): ZenShaderResearchWorkloadPlan {
  const drawsScene = workload === "solid-fullscreen";
  return {
    workload,
    pipeline: "raw",
    renderPipeline: "direct",
    sceneOperation: drawsScene ? "fullscreen" : "clear-only",
    sceneFragmentKind: "solid",
    compositeFragmentKind: "none",
    expectedTopology: {
      clearCallsPerFrame: 1,
      sceneDrawCallsPerFrame: drawsScene ? 1 : 0,
      compositeDrawCallsPerFrame: 0,
      totalDrawCallsPerFrame: drawsScene ? 1 : 0,
      sceneTargetBytesPerPixel: 0,
    },
  };
}

function paperPlan(
  pipeline: Extract<ZenShaderResearchPipeline, "raw" | "scene">,
): ZenShaderResearchWorkloadPlan {
  const multipass = pipeline === "scene";
  return {
    workload: "paper",
    pipeline,
    renderPipeline: multipass ? "multipass" : "direct",
    sceneOperation: "fullscreen",
    sceneFragmentKind: "paper",
    compositeFragmentKind: multipass ? "copy" : "none",
    expectedTopology: {
      clearCallsPerFrame: 1,
      sceneDrawCallsPerFrame: 1,
      compositeDrawCallsPerFrame: multipass ? 1 : 0,
      totalDrawCallsPerFrame: multipass ? 2 : 1,
      sceneTargetBytesPerPixel: multipass ? 4 : 0,
    },
  };
}

function assertCompatiblePipeline(
  workload: ZenShaderResearchWorkload,
  requested: ZenShaderResearchPipeline | undefined,
  required: Extract<ZenShaderResearchPipeline, "raw" | "scene">,
) {
  if (requested !== undefined && requested !== required) {
    throw new TypeError(
      `${workload} workload requires the ${required} pipeline`,
    );
  }
}

export function resolveZenShaderResearchWorkloadPlan(
  workload: ZenShaderResearchWorkload,
  pipeline?: ZenShaderResearchPipeline,
): ZenShaderResearchWorkloadPlan {
  switch (workload) {
    case "clear-only":
    case "solid-fullscreen":
      assertCompatiblePipeline(workload, pipeline, "raw");
      return directPlan(workload);
    case "texture-copy":
      assertCompatiblePipeline(workload, pipeline, "scene");
      return {
        workload,
        pipeline: "scene",
        renderPipeline: "multipass",
        sceneOperation: "clear-only",
        sceneFragmentKind: "solid",
        compositeFragmentKind: "copy",
        expectedTopology: {
          clearCallsPerFrame: 1,
          sceneDrawCallsPerFrame: 0,
          compositeDrawCallsPerFrame: 1,
          totalDrawCallsPerFrame: 1,
          sceneTargetBytesPerPixel: 4,
        },
      };
    case "paper":
      if (pipeline !== "raw" && pipeline !== "scene") {
        throw new TypeError(
          "Paper workload requires an explicit raw or scene pipeline",
        );
      }
      return paperPlan(pipeline);
  }
}

export function parseZenShaderResearchResolution(
  value: string,
): ZenShaderResearchResolution {
  const match = /^([1-9]\d*)[xX]([1-9]\d*)$/.exec(value.trim());
  if (!match) {
    throw new TypeError(
      "resolution must use positive integer WIDTHxHEIGHT dimensions",
    );
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new TypeError("resolution width and height must be safe integers");
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 1) {
    throw new TypeError(
      "resolution pixel count must be a positive safe integer",
    );
  }

  return {
    id: `${width}x${height}`,
    width,
    height,
    pixelCount,
  };
}

function rotateResolutions(
  resolutions: readonly ZenShaderResearchResolution[],
  offset: number,
) {
  return [...resolutions.slice(offset), ...resolutions.slice(0, offset)];
}

export function buildZenShaderResearchResolutionSchedule(
  resolutions: readonly ZenShaderResearchResolution[],
  runCount: number,
): ZenShaderResearchResolution[][] {
  if (resolutions.length === 0) {
    throw new TypeError("resolution schedule cannot be empty");
  }
  if (!Number.isSafeInteger(runCount) || runCount < 1) {
    throw new TypeError("run count must be a positive safe integer");
  }

  const forwardCycleLength = resolutions.length;
  const balancedCycleLength = forwardCycleLength * 2;
  return Array.from({ length: runCount }, (_, runOrdinal) => {
    const cycleOrdinal = runOrdinal % balancedCycleLength;
    const rotation = cycleOrdinal % forwardCycleLength;
    const order = rotateResolutions(resolutions, rotation);
    return cycleOrdinal < forwardCycleLength ? order : order.reverse();
  });
}
