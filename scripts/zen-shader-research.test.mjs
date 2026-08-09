import assert from "node:assert/strict";
import test from "node:test";

import {
  buildZenShaderResearchInvocation,
  parseZenShaderResearchArguments,
} from "./zen-shader-research.mjs";

const argv = (...arguments_) => [
  "node",
  "scripts/zen-shader-research.mjs",
  ...arguments_,
];

test("parseZenShaderResearchArguments applies deterministic Full HD ranking defaults", () => {
  assert.deepEqual(
    parseZenShaderResearchArguments(
      argv("--output", "artifacts/zen-shaders.json"),
    ),
    {
      outputPath: "artifacts/zen-shaders.json",
      shader: "all",
      pipeline: "full",
      dither: false,
      ditherStrength: 0.45,
      halftone: false,
      halftoneStrength: 0.3,
      contrast: false,
      glass: false,
      blur: 22,
      width: 1_920,
      height: 1_080,
      warmup: 30,
      frames: 60,
      runs: 3,
      primeRuns: 1,
      frame: 1_000,
      orderSeed: 492,
      timing: "both",
      headed: false,
    },
  );
});

test("parseZenShaderResearchArguments accepts a single shader and every ablation", () => {
  assert.deepEqual(
    parseZenShaderResearchArguments(
      argv(
        "--output",
        "results/spiral-scene.json",
        "--shader",
        "spiral",
        "--pipeline",
        "full",
        "--dither",
        "on",
        "--dither-strength",
        "0.6",
        "--halftone",
        "on",
        "--halftone-strength",
        "0.4",
        "--contrast",
        "on",
        "--glass",
        "on",
        "--blur",
        "40",
        "--width",
        "2560",
        "--height",
        "1440",
        "--warmup",
        "90",
        "--frames",
        "240",
        "--runs",
        "5",
        "--prime-runs",
        "2",
        "--frame",
        "2500.5",
        "--order-seed",
        "17",
        "--timing",
        "pass-breakdown",
        "--headed",
      ),
    ),
    {
      outputPath: "results/spiral-scene.json",
      shader: "spiral",
      pipeline: "full",
      dither: true,
      ditherStrength: 0.6,
      halftone: true,
      halftoneStrength: 0.4,
      contrast: true,
      glass: true,
      blur: 40,
      width: 2_560,
      height: 1_440,
      warmup: 90,
      frames: 240,
      runs: 5,
      primeRuns: 2,
      frame: 2_500.5,
      orderSeed: 17,
      timing: "pass-breakdown",
      headed: true,
    },
  );
});

test("parseZenShaderResearchArguments rejects invalid paths and values", () => {
  assert.throws(() => parseZenShaderResearchArguments(argv()), /output/i);

  for (const [option, value, expected] of [
    ["--pipeline", "copy", /pipeline/i],
    ["--dither", "maybe", /dither/i],
    ["--dither-strength", "1.1", /dither-strength/i],
    ["--halftone", "1", /halftone/i],
    ["--halftone-strength", "-0.1", /halftone-strength/i],
    ["--contrast", "auto", /contrast/i],
    ["--glass", "yes", /glass/i],
    ["--blur", "0", /blur/i],
    ["--width", "0", /width/i],
    ["--height", "1.5", /height/i],
    ["--warmup", "-1", /warmup/i],
    ["--frames", "0", /frames/i],
    ["--runs", "0", /runs/i],
    ["--prime-runs", "-1", /prime-runs/i],
    ["--frame", "NaN", /frame/i],
    ["--order-seed", "-1", /order-seed/i],
    ["--timing", "blur", /timing/i],
  ]) {
    assert.throws(
      () =>
        parseZenShaderResearchArguments(
          argv("--output", "result.json", option, value),
        ),
      expected,
    );
  }

  assert.throws(
    () =>
      parseZenShaderResearchArguments(
        argv("--output", "result.json", "--pipeline", "raw", "--glass", "on"),
      ),
    /glass|full|pipeline/i,
  );
});

test("buildZenShaderResearchInvocation isolates the dedicated real-GPU runner", () => {
  const options = parseZenShaderResearchArguments(
    argv(
      "--output",
      "ignored.json",
      "--shader",
      "spiral",
      "--pipeline",
      "raw",
      "--dither",
      "on",
      "--timing",
      "frame",
    ),
  );

  assert.deepEqual(
    buildZenShaderResearchInvocation(options, "C:/results/spiral.json"),
    {
      executable: "pnpm",
      args: [
        "exec",
        "vitest",
        "--config",
        "vitest.zen-shader-research.config.ts",
        "--run",
      ],
      environment: {
        GRIMODEX_ZEN_SHADER_RESEARCH_OUTPUT: "C:/results/spiral.json",
        GRIMODEX_ZEN_SHADER_RESEARCH_SCENARIO: JSON.stringify({
          shader: "spiral",
          pipeline: "raw",
          dither: true,
          ditherStrength: 0.45,
          halftone: false,
          halftoneStrength: 0.3,
          contrast: false,
          glass: false,
          blur: 22,
          width: 1_920,
          height: 1_080,
          warmup: 30,
          frames: 60,
          runs: 3,
          primeRuns: 1,
          frame: 1_000,
          orderSeed: 492,
          timing: "frame",
          headed: false,
        }),
      },
    },
  );
});
