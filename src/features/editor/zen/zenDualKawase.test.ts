import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ZEN_DUAL_KAWASE_DOWNSAMPLE_FRAGMENT,
  ZEN_DUAL_KAWASE_UPSAMPLE_FRAGMENT,
  resolveZenDualKawasePlan,
  type ZenBlurBackend,
} from "./zenDualKawase";

const SCENE_WIDTH = 1920;
const SCENE_HEIGHT = 1080;
const PLANNED_BASE_WIDTH = 524;
const PLANNED_BASE_HEIGHT = 295;

type TextureFormat = "rgba8" | "rgba16f";

interface PyramidLevel {
  width: number;
  height: number;
}

interface CostPlan {
  requiresPrefilter: boolean;
  levels: readonly PyramidLevel[];
}

function pixelCount(level: PyramidLevel) {
  return level.width * level.height;
}

function expectedTextureFetches(plan: CostPlan) {
  const prefilterFetches = plan.requiresPrefilter
    ? pixelCount(plan.levels[0]) * 9
    : 0;
  const downsampleFetches = plan.levels
    .slice(1)
    .reduce((total, level) => total + pixelCount(level) * 5, 0);
  const upsampleFetches = plan.levels
    .slice(0, -1)
    .reduce((total, level) => total + pixelCount(level) * 8, 0);
  return prefilterFetches + downsampleFetches + upsampleFetches;
}

function expectedIntermediateBytes(
  levels: readonly PyramidLevel[],
  textureFormat: TextureFormat,
) {
  const bytesPerPixel = textureFormat === "rgba8" ? 4 : 8;
  return (
    levels.reduce((total, level) => total + pixelCount(level), 0) *
    bytesPerPixel
  );
}

function expectHalfResolutionPyramid(levels: readonly PyramidLevel[]) {
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1];
    const current = levels[index];
    expect(current.width).toBeGreaterThan(0);
    expect(current.height).toBeGreaterThan(0);
    expect([
      Math.floor(previous.width / 2),
      Math.ceil(previous.width / 2),
    ]).toContain(current.width);
    expect([
      Math.floor(previous.height / 2),
      Math.ceil(previous.height / 2),
    ]).toContain(current.height);
  }
}

function stripGlslComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function textureFetchCount(source: string) {
  return stripGlslComments(source).match(/\btexture\s*\(/g)?.length ?? 0;
}

describe("Zen Dual Kawase research backend", () => {
  it("keeps the internal backend choices explicit without changing the default", () => {
    expectTypeOf<ZenBlurBackend>().toEqualTypeOf<
      "gaussian-current" | "dual-kawase-canonical" | "dual-kawase-planned"
    >();
  });

  it("builds the canonical pyramid from the full scene", () => {
    const plan = resolveZenDualKawasePlan({
      backend: "dual-kawase-canonical",
      sceneWidth: SCENE_WIDTH,
      sceneHeight: SCENE_HEIGHT,
      passes: 3,
      offset: 1.5,
      textureFormat: "rgba8",
    });

    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      backend: "dual-kawase-canonical",
      passes: 3,
      offset: 1.5,
      textureFormat: "rgba8",
      requiresPrefilter: false,
      downsamplePassCount: 3,
      upsamplePassCount: 3,
      drawCallCount: 6,
    });
    expect(plan?.levels).toEqual([
      { width: 1920, height: 1080 },
      { width: 960, height: 540 },
      { width: 480, height: 270 },
      { width: 240, height: 135 },
    ]);
    expect(plan?.estimatedTextureFetches).toBe(expectedTextureFetches(plan!));
    expect(
      (plan?.estimatedTextureFetches ?? 0) / (SCENE_WIDTH * SCENE_HEIGHT),
    ).toBeCloseTo(12.14, 2);
  });

  it("keeps the #489 prefilter and runs the planned pyramid inside its base", () => {
    const plan = resolveZenDualKawasePlan({
      backend: "dual-kawase-planned",
      sceneWidth: SCENE_WIDTH,
      sceneHeight: SCENE_HEIGHT,
      baseWidth: PLANNED_BASE_WIDTH,
      baseHeight: PLANNED_BASE_HEIGHT,
      passes: 3,
      offset: 1.5,
      textureFormat: "rgba8",
    });

    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      backend: "dual-kawase-planned",
      passes: 3,
      offset: 1.5,
      textureFormat: "rgba8",
      requiresPrefilter: true,
      downsamplePassCount: 3,
      upsamplePassCount: 3,
      drawCallCount: 7,
    });
    expect(plan?.levels).toHaveLength(4);
    expect(plan?.levels[0]).toEqual({
      width: PLANNED_BASE_WIDTH,
      height: PLANNED_BASE_HEIGHT,
    });
    expectHalfResolutionPyramid(plan!.levels);
    expect(plan?.estimatedTextureFetches).toBe(expectedTextureFetches(plan!));
    expect(
      (plan?.estimatedTextureFetches ?? 0) / (SCENE_WIDTH * SCENE_HEIGHT),
    ).toBeCloseTo(1.58, 2);
  });

  it("reports the resident pyramid size for RGBA8 and RGBA16F", () => {
    for (const textureFormat of ["rgba8", "rgba16f"] as const) {
      const plan = resolveZenDualKawasePlan({
        backend: "dual-kawase-planned",
        sceneWidth: SCENE_WIDTH,
        sceneHeight: SCENE_HEIGHT,
        baseWidth: PLANNED_BASE_WIDTH,
        baseHeight: PLANNED_BASE_HEIGHT,
        passes: 3,
        offset: 1.5,
        textureFormat,
      });

      expect(plan).not.toBeNull();
      expect(plan?.intermediateBytes).toBe(
        expectedIntermediateBytes(plan!.levels, textureFormat),
      );
    }

    const rgba8 = resolveZenDualKawasePlan({
      backend: "dual-kawase-canonical",
      sceneWidth: SCENE_WIDTH,
      sceneHeight: SCENE_HEIGHT,
      passes: 3,
      offset: 1.5,
      textureFormat: "rgba8",
    });
    const rgba16f = resolveZenDualKawasePlan({
      backend: "dual-kawase-canonical",
      sceneWidth: SCENE_WIDTH,
      sceneHeight: SCENE_HEIGHT,
      passes: 3,
      offset: 1.5,
      textureFormat: "rgba16f",
    });

    expect(rgba16f?.intermediateBytes).toBe(
      (rgba8?.intermediateBytes ?? 0) * 2,
    );
    expect(rgba16f?.estimatedTextureFetches).toBe(
      rgba8?.estimatedTextureFetches,
    );
  });

  it("accepts only one to four passes and finite offsets from 0.5 to 4", () => {
    for (const passes of [1, 2, 3, 4]) {
      const plan = resolveZenDualKawasePlan({
        backend: "dual-kawase-canonical",
        sceneWidth: SCENE_WIDTH,
        sceneHeight: SCENE_HEIGHT,
        passes,
        offset: 0.5,
        textureFormat: "rgba8",
      });

      expect(plan?.levels).toHaveLength(passes + 1);
      expect(plan?.downsamplePassCount).toBe(passes);
      expect(plan?.upsamplePassCount).toBe(passes);
      expect(plan?.drawCallCount).toBe(passes * 2);
    }

    for (const offset of [0.5, 0.75, 4]) {
      expect(
        resolveZenDualKawasePlan({
          backend: "dual-kawase-canonical",
          sceneWidth: SCENE_WIDTH,
          sceneHeight: SCENE_HEIGHT,
          passes: 1,
          offset,
          textureFormat: "rgba8",
        }),
      ).toMatchObject({ offset });
    }
  });

  it("returns null for unsupported backends and malformed planner inputs", () => {
    const validInput = {
      backend: "dual-kawase-planned" as const,
      sceneWidth: SCENE_WIDTH,
      sceneHeight: SCENE_HEIGHT,
      baseWidth: PLANNED_BASE_WIDTH,
      baseHeight: PLANNED_BASE_HEIGHT,
      passes: 3,
      offset: 1.5,
      textureFormat: "rgba8" as const,
    };

    expect(
      resolveZenDualKawasePlan({
        ...validInput,
        backend: "gaussian-current",
      }),
    ).toBeNull();

    for (const invalidInput of [
      { ...validInput, passes: 0 },
      { ...validInput, passes: 5 },
      { ...validInput, passes: 1.5 },
      { ...validInput, passes: Number.NaN },
      { ...validInput, offset: 0.49 },
      { ...validInput, offset: 4.01 },
      { ...validInput, offset: Number.POSITIVE_INFINITY },
      { ...validInput, sceneWidth: 0 },
      { ...validInput, sceneHeight: Number.NaN },
      { ...validInput, baseWidth: 0 },
      { ...validInput, baseHeight: Number.POSITIVE_INFINITY },
    ]) {
      expect(resolveZenDualKawasePlan(invalidInput)).toBeNull();
    }
  });
});

describe("Zen Dual Kawase shader kernels", () => {
  it("uses five bounded downsample fetches with normalized weights", () => {
    const shader = stripGlslComments(ZEN_DUAL_KAWASE_DOWNSAMPLE_FRAGMENT);

    expect(textureFetchCount(shader)).toBe(5);
    expect(shader).toMatch(/uniform\s+vec2\s+u_sourceTexelSize\s*;/);
    expect(shader).toMatch(/uniform\s+float\s+u_offset\s*;/);
    expect(shader).toMatch(
      /u_sourceTexelSize\s*\*\s*u_offset|u_offset\s*\*\s*u_sourceTexelSize/,
    );
    expect(shader).toMatch(/\*\s*4(?:\.0+)?\b/);
    expect(shader).toMatch(/\/\s*8(?:\.0+)?\b/);
    expect(shader).not.toMatch(/\b(?:for|while)\s*\(/);
  });

  it("uses eight bounded upsample fetches with normalized weights", () => {
    const shader = stripGlslComments(ZEN_DUAL_KAWASE_UPSAMPLE_FRAGMENT);

    expect(textureFetchCount(shader)).toBe(8);
    expect(shader).toMatch(/uniform\s+vec2\s+u_sourceTexelSize\s*;/);
    expect(shader).toMatch(/uniform\s+float\s+u_offset\s*;/);
    expect(shader).toMatch(
      /u_sourceTexelSize\s*\*\s*u_offset|u_offset\s*\*\s*u_sourceTexelSize/,
    );
    expect(shader.match(/\*\s*2(?:\.0+)?\b/g)).toHaveLength(4);
    expect(shader).toMatch(/\/\s*12(?:\.0+)?\b/);
    expect(shader).not.toMatch(/\b(?:for|while)\s*\(/);
  });
});
