import { describe, expect, it } from "vitest";
import {
  ZEN_SHADER_RESEARCH_SOLID_FRAGMENT,
  buildZenShaderResearchResolutionSchedule,
  parseZenShaderResearchResolution,
  resolveZenShaderResearchWorkloadPlan,
} from "./zenShaderResearchBaseline";

describe("Zen shader research baseline workloads", () => {
  it.each([
    [
      "clear-only",
      undefined,
      {
        workload: "clear-only",
        pipeline: "raw",
        renderPipeline: "direct",
        sceneOperation: "clear-only",
        sceneFragmentKind: "solid",
        compositeFragmentKind: "none",
        expectedTopology: {
          clearCallsPerFrame: 1,
          sceneDrawCallsPerFrame: 0,
          compositeDrawCallsPerFrame: 0,
          totalDrawCallsPerFrame: 0,
          sceneTargetBytesPerPixel: 0,
        },
      },
    ],
    [
      "solid-fullscreen",
      undefined,
      {
        workload: "solid-fullscreen",
        pipeline: "raw",
        renderPipeline: "direct",
        sceneOperation: "fullscreen",
        sceneFragmentKind: "solid",
        compositeFragmentKind: "none",
        expectedTopology: {
          clearCallsPerFrame: 1,
          sceneDrawCallsPerFrame: 1,
          compositeDrawCallsPerFrame: 0,
          totalDrawCallsPerFrame: 1,
          sceneTargetBytesPerPixel: 0,
        },
      },
    ],
    [
      "texture-copy",
      undefined,
      {
        workload: "texture-copy",
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
      },
    ],
    [
      "paper",
      "raw",
      {
        workload: "paper",
        pipeline: "raw",
        renderPipeline: "direct",
        sceneOperation: "fullscreen",
        sceneFragmentKind: "paper",
        compositeFragmentKind: "none",
        expectedTopology: {
          clearCallsPerFrame: 1,
          sceneDrawCallsPerFrame: 1,
          compositeDrawCallsPerFrame: 0,
          totalDrawCallsPerFrame: 1,
          sceneTargetBytesPerPixel: 0,
        },
      },
    ],
    [
      "paper",
      "scene",
      {
        workload: "paper",
        pipeline: "scene",
        renderPipeline: "multipass",
        sceneOperation: "fullscreen",
        sceneFragmentKind: "paper",
        compositeFragmentKind: "copy",
        expectedTopology: {
          clearCallsPerFrame: 1,
          sceneDrawCallsPerFrame: 1,
          compositeDrawCallsPerFrame: 1,
          totalDrawCallsPerFrame: 2,
          sceneTargetBytesPerPixel: 4,
        },
      },
    ],
  ] as const)(
    "resolves the %s workload to an explicit render and draw topology",
    (workload, pipeline, expected) => {
      expect(resolveZenShaderResearchWorkloadPlan(workload, pipeline)).toEqual(
        expected,
      );
    },
  );

  it("rejects ambiguous or incompatible workload and pipeline pairs", () => {
    expect(() => resolveZenShaderResearchWorkloadPlan("paper")).toThrow(
      /paper|pipeline|required/i,
    );
    expect(() =>
      resolveZenShaderResearchWorkloadPlan("clear-only", "scene"),
    ).toThrow(/clear-only|raw|pipeline/i);
    expect(() =>
      resolveZenShaderResearchWorkloadPlan("texture-copy", "raw"),
    ).toThrow(/texture-copy|scene|pipeline/i);
  });

  it("uses a deterministic opaque fragment without texture or time work", () => {
    expect(ZEN_SHADER_RESEARCH_SOLID_FRAGMENT).toContain("#version 300 es");
    expect(ZEN_SHADER_RESEARCH_SOLID_FRAGMENT).toContain(
      "fragColor = vec4(0.25, 0.5, 0.75, 1.0);",
    );
    expect(ZEN_SHADER_RESEARCH_SOLID_FRAGMENT).not.toMatch(
      /uniform|sampler|texture\s*\(|u_time|sin\s*\(|cos\s*\(/,
    );
  });
});

describe("Zen shader research resolution sweep", () => {
  it("parses one exact render size and records its pixel count", () => {
    expect(parseZenShaderResearchResolution(" 1920x1080 ")).toEqual({
      id: "1920x1080",
      width: 1_920,
      height: 1_080,
      pixelCount: 1_920 * 1_080,
    });
    expect(parseZenShaderResearchResolution("2560X1440")).toEqual({
      id: "2560x1440",
      width: 2_560,
      height: 1_440,
      pixelCount: 2_560 * 1_440,
    });
  });

  it.each([
    "",
    "1920",
    "1920*1080",
    "0x1080",
    "1920x0",
    "1920.5x1080",
    "1920x1080px",
    "9007199254740991x2",
  ])("rejects an invalid or unsafe resolution: %s", (value) => {
    expect(() => parseZenShaderResearchResolution(value)).toThrow(
      /resolution|width|height|pixel|safe|positive/i,
    );
  });

  it("uses forward rotations followed by their reverse for a balanced cycle", () => {
    const resolutions = [
      parseZenShaderResearchResolution("1280x720"),
      parseZenShaderResearchResolution("1920x1080"),
      parseZenShaderResearchResolution("2560x1440"),
      parseZenShaderResearchResolution("3840x2160"),
    ];
    const original = resolutions.map(({ id }) => id);

    const schedule = buildZenShaderResearchResolutionSchedule(resolutions, 8);
    const ids = schedule.map((run) => run.map(({ id }) => id));

    expect(ids).toEqual([
      ["1280x720", "1920x1080", "2560x1440", "3840x2160"],
      ["1920x1080", "2560x1440", "3840x2160", "1280x720"],
      ["2560x1440", "3840x2160", "1280x720", "1920x1080"],
      ["3840x2160", "1280x720", "1920x1080", "2560x1440"],
      ["3840x2160", "2560x1440", "1920x1080", "1280x720"],
      ["1280x720", "3840x2160", "2560x1440", "1920x1080"],
      ["1920x1080", "1280x720", "3840x2160", "2560x1440"],
      ["2560x1440", "1920x1080", "1280x720", "3840x2160"],
    ]);
    expect(resolutions.map(({ id }) => id)).toEqual(original);

    for (let ordinal = 0; ordinal < resolutions.length; ordinal += 1) {
      const counts = new Map<string, number>();
      for (const run of schedule) {
        const id = run[ordinal]?.id;
        expect(id).toBeDefined();
        counts.set(id!, (counts.get(id!) ?? 0) + 1);
      }
      expect([...counts.values()]).toEqual([2, 2, 2, 2]);
    }
  });

  it("repeats the balanced cycle deterministically for additional runs", () => {
    const resolutions = [
      parseZenShaderResearchResolution("1280x720"),
      parseZenShaderResearchResolution("1920x1080"),
    ];
    const schedule = buildZenShaderResearchResolutionSchedule(resolutions, 5);

    expect(schedule).toHaveLength(5);
    expect(schedule[4]).toEqual(schedule[0]);
    expect(() => buildZenShaderResearchResolutionSchedule([], 1)).toThrow(
      /resolution|empty/i,
    );
    expect(() =>
      buildZenShaderResearchResolutionSchedule(resolutions, 0),
    ).toThrow(/run|positive/i);
  });
});
