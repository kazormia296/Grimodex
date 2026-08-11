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
      experiment: "pipeline",
      shader: "all",
      pipeline: "full",
      workload: "all",
      resolutions: [],
      cadence: "all",
      durationMs: 2_000,
      cycles: 6,
      sequenceStart: "abba",
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
      experiment: "pipeline",
      shader: "spiral",
      pipeline: "full",
      workload: "all",
      resolutions: [],
      cadence: "all",
      durationMs: 2_000,
      cycles: 6,
      sequenceStart: "abba",
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

test("parseZenShaderResearchArguments builds a headed cadence experiment", () => {
  assert.deepEqual(
    parseZenShaderResearchArguments(
      argv(
        "--output",
        "results/cadence.json",
        "--experiment",
        "cadence",
        "--shader",
        "mesh-gradient",
        "--cadence",
        "all",
        "--duration-ms",
        "2500",
        "--runs",
        "5",
        "--headed",
      ),
    ),
    {
      outputPath: "results/cadence.json",
      experiment: "cadence",
      shader: "mesh-gradient",
      pipeline: "full",
      workload: "all",
      resolutions: [],
      cadence: "all",
      durationMs: 2_500,
      cycles: 6,
      sequenceStart: "abba",
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
      runs: 5,
      primeRuns: 1,
      frame: 1_000,
      orderSeed: 492,
      timing: "frame",
      headed: true,
    },
  );
});

test("parseZenShaderResearchArguments builds a counterbalanced baseline resolution sweep", () => {
  const parsed = parseZenShaderResearchArguments(
    argv(
      "--output",
      "results/baselines.json",
      "--experiment",
      "baselines",
      "--shader",
      "representative",
      "--workload",
      "all",
      "--resolution",
      "960x540",
      "--resolution",
      "1920x1080",
      "--resolution",
      "960x540",
    ),
  );

  assert.equal(parsed.experiment, "baselines");
  assert.equal(parsed.shader, "representative");
  assert.equal(parsed.workload, "all");
  assert.equal(parsed.runs, 4);
  assert.deepEqual(parsed.resolutions, [
    { width: 960, height: 540 },
    { width: 1_920, height: 1_080 },
  ]);
});

test("parseZenShaderResearchArguments builds a fixed ABBA experiment", () => {
  const parsed = parseZenShaderResearchArguments(
    argv(
      "--output",
      "results/abba.json",
      "--experiment",
      "abba",
      "--shader",
      "representative",
      "--cycles",
      "8",
      "--sequence-start",
      "baab",
      "--frames",
      "48",
    ),
  );

  assert.equal(parsed.experiment, "abba");
  assert.equal(parsed.shader, "representative");
  assert.equal(parsed.cycles, 8);
  assert.equal(parsed.sequenceStart, "baab");
  assert.equal(parsed.frames, 48);
  assert.equal(parsed.timing, "frame");
});

test("parseZenShaderResearchArguments builds the fixed upscale matrix experiment", () => {
  const parsed = parseZenShaderResearchArguments(
    argv(
      "--output",
      "results/upscale.json",
      "--experiment",
      "upscale",
      "--shader",
      "representative",
      "--cycles",
      "4",
      "--sequence-start",
      "baab",
      "--frames",
      "48",
    ),
  );

  assert.equal(parsed.experiment, "upscale");
  assert.equal(parsed.shader, "representative");
  assert.equal(parsed.cycles, 4);
  assert.equal(parsed.sequenceStart, "baab");
  assert.equal(parsed.frames, 48);
  assert.equal(parsed.timing, "frame");
});

test("parseZenShaderResearchArguments rejects invalid paths and values", () => {
  assert.throws(() => parseZenShaderResearchArguments(argv()), /output/i);

  for (const [option, value, expected] of [
    ["--pipeline", "copy", /pipeline/i],
    ["--experiment", "unknown", /experiment/i],
    ["--workload", "clear", /workload/i],
    ["--resolution", "1920", /resolution/i],
    ["--cadence", "fast", /cadence/i],
    ["--duration-ms", "0", /duration/i],
    ["--cycles", "3", /cycles|even/i],
    ["--sequence-start", "abab", /sequence/i],
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

  assert.throws(
    () =>
      parseZenShaderResearchArguments(
        argv(
          "--output",
          "result.json",
          "--experiment",
          "cadence",
          "--shader",
          "spiral",
        ),
      ),
    /headed/i,
  );
  assert.throws(
    () =>
      parseZenShaderResearchArguments(
        argv(
          "--output",
          "result.json",
          "--experiment",
          "abba",
          "--frames",
          "65",
        ),
      ),
    /frames|64/i,
  );
  assert.throws(
    () =>
      parseZenShaderResearchArguments(
        argv(
          "--output",
          "result.json",
          "--experiment",
          "abba",
          "--contrast",
          "on",
        ),
      ),
    /contrast|abba/i,
  );

  for (const [experiment, experimentArguments, expected] of [
    ["pipeline", ["--duration-ms", "1000"], /duration|pipeline/i],
    ["cadence", ["--headed", "--cycles", "8"], /cycles|cadence/i],
    ["baselines", ["--cadence", "native-raf"], /cadence|baseline/i],
    ["abba", ["--resolution", "960x540"], /resolution|abba/i],
    ["upscale", ["--resolution", "960x540"], /resolution|upscale/i],
  ]) {
    assert.throws(
      () =>
        parseZenShaderResearchArguments(
          argv(
            "--output",
            "result.json",
            "--experiment",
            experiment,
            ...experimentArguments,
          ),
        ),
      expected,
    );
  }

  assert.throws(
    () =>
      parseZenShaderResearchArguments(
        argv(
          "--output",
          "result.json",
          "--experiment",
          "baselines",
          "--runs",
          "3",
        ),
      ),
    /runs|balanced|cycle|6/i,
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
          experiment: "pipeline",
          shader: "spiral",
          pipeline: "raw",
          workload: "all",
          resolutions: [],
          cadence: "all",
          durationMs: 2_000,
          cycles: 6,
          sequenceStart: "abba",
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
