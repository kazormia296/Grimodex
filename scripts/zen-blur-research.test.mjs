import assert from "node:assert/strict";
import test from "node:test";

import {
  buildZenBlurResearchInvocation,
  parseZenBlurResearchArguments,
} from "./zen-blur-research.mjs";

const argv = (...arguments_) => [
  "node",
  "scripts/zen-blur-research.mjs",
  ...arguments_,
];

test("parseZenBlurResearchArguments applies deterministic benchmark defaults", () => {
  assert.deepEqual(
    parseZenBlurResearchArguments(argv("--output", "artifacts/zen-blur.json")),
    {
      outputPath: "artifacts/zen-blur.json",
      backend: "gaussian-current",
      blur: 22,
      width: 1_920,
      height: 1_080,
      warmup: 120,
      frames: 600,
      runs: 5,
      passes: 3,
      offset: 3,
      precision: "auto",
      noise: 0,
      dither: 0,
      seed: 0,
      headed: false,
    },
  );
});

test("parseZenBlurResearchArguments accepts every candidate option", () => {
  assert.deepEqual(
    parseZenBlurResearchArguments(
      argv(
        "--output",
        "results/planned.json",
        "--backend",
        "dual-kawase-planned",
        "--blur",
        "40.5",
        "--width",
        "3840",
        "--height",
        "2160",
        "--warmup",
        "240",
        "--frames",
        "900",
        "--runs",
        "7",
        "--passes",
        "4",
        "--offset",
        "2.5",
        "--precision",
        "rgba8",
        "--noise",
        "0.01",
        "--dither",
        "0.002",
        "--seed",
        "42",
        "--headed",
      ),
    ),
    {
      outputPath: "results/planned.json",
      backend: "dual-kawase-planned",
      blur: 40.5,
      width: 3_840,
      height: 2_160,
      warmup: 240,
      frames: 900,
      runs: 7,
      passes: 4,
      offset: 2.5,
      precision: "rgba8",
      noise: 0.01,
      dither: 0.002,
      seed: 42,
      headed: true,
    },
  );
});

test("parseZenBlurResearchArguments accepts documented enum and numeric boundaries", () => {
  for (const backend of [
    "gaussian-current",
    "dual-kawase-canonical",
    "dual-kawase-planned",
  ]) {
    assert.equal(
      parseZenBlurResearchArguments(
        argv("--output", "result.json", "--backend", backend),
      ).backend,
      backend,
    );
  }

  const minimum = parseZenBlurResearchArguments(
    argv(
      "--output",
      "minimum.json",
      "--blur",
      "0.001",
      "--width",
      "1",
      "--height",
      "1",
      "--warmup",
      "0",
      "--frames",
      "1",
      "--runs",
      "1",
      "--passes",
      "1",
      "--offset",
      "0.5",
      "--noise",
      "0",
      "--dither",
      "0",
      "--seed",
      "0",
    ),
  );
  assert.deepEqual(
    {
      blur: minimum.blur,
      width: minimum.width,
      height: minimum.height,
      warmup: minimum.warmup,
      frames: minimum.frames,
      runs: minimum.runs,
      passes: minimum.passes,
      offset: minimum.offset,
      noise: minimum.noise,
      dither: minimum.dither,
      seed: minimum.seed,
    },
    {
      blur: 0.001,
      width: 1,
      height: 1,
      warmup: 0,
      frames: 1,
      runs: 1,
      passes: 1,
      offset: 0.5,
      noise: 0,
      dither: 0,
      seed: 0,
    },
  );

  const maximum = parseZenBlurResearchArguments(
    argv(
      "--output",
      "maximum.json",
      "--passes",
      "4",
      "--offset",
      "4",
      "--noise",
      "0.02",
      "--dither",
      String(1 / 255),
    ),
  );
  assert.equal(maximum.passes, 4);
  assert.equal(maximum.offset, 4);
  assert.equal(maximum.noise, 0.02);
  assert.equal(maximum.dither, 1 / 255);

  for (const precision of ["auto", "rgba8"]) {
    assert.equal(
      parseZenBlurResearchArguments(
        argv("--output", "result.json", "--precision", precision),
      ).precision,
      precision,
    );
  }
});

test("parseZenBlurResearchArguments rejects missing output and unknown arguments", () => {
  assert.throws(
    () => parseZenBlurResearchArguments(argv()),
    /--output.*required/i,
  );
  assert.throws(
    () => parseZenBlurResearchArguments(argv("--output")),
    /--output.*file path/i,
  );
  assert.throws(
    () =>
      parseZenBlurResearchArguments(
        argv("--output", "result.json", "--surprise"),
      ),
    /unknown argument.*--surprise/i,
  );
  assert.throws(
    () =>
      parseZenBlurResearchArguments(
        argv("--output", "result.json", "--headed", "false"),
      ),
    /unknown argument.*false/i,
  );
});

test("parseZenBlurResearchArguments rejects invalid candidate values", () => {
  const invalid = [
    ["--backend", "xray", /backend/i],
    ["--blur", "0", /blur/i],
    ["--blur", "NaN", /blur/i],
    ["--width", "0", /width/i],
    ["--width", "1.5", /width/i],
    ["--height", "-1", /height/i],
    ["--warmup", "-1", /warmup/i],
    ["--warmup", "1.5", /warmup/i],
    ["--frames", "0", /frames/i],
    ["--frames", "1.5", /frames/i],
    ["--runs", "0", /runs/i],
    ["--passes", "0", /passes/i],
    ["--passes", "5", /passes/i],
    ["--passes", "1.5", /passes/i],
    ["--offset", "0.49", /offset/i],
    ["--offset", "4.01", /offset/i],
    ["--precision", "rgba16f", /precision/i],
    ["--noise", "-0.001", /noise/i],
    ["--noise", "0.021", /noise/i],
    ["--dither", "-0.001", /dither/i],
    ["--dither", String(1 / 255 + 0.000_001), /dither/i],
    ["--seed", "-1", /seed/i],
    ["--seed", "1.5", /seed/i],
  ];

  for (const [option, value, expected] of invalid) {
    assert.throws(
      () =>
        parseZenBlurResearchArguments(
          argv("--output", "result.json", option, value),
        ),
      expected,
      `${option} ${value} must be rejected`,
    );
  }
});

test("buildZenBlurResearchInvocation isolates scenario and candidate inputs", () => {
  const options = parseZenBlurResearchArguments(
    argv(
      "--output",
      "ignored-by-builder.json",
      "--backend",
      "dual-kawase-canonical",
      "--blur",
      "40",
      "--width",
      "2560",
      "--height",
      "1440",
      "--warmup",
      "12",
      "--frames",
      "60",
      "--runs",
      "6",
      "--passes",
      "2",
      "--offset",
      "1.5",
      "--precision",
      "rgba8",
      "--noise",
      "0.01",
      "--dither",
      "0.002",
      "--seed",
      "17",
      "--headed",
    ),
  );

  assert.deepEqual(
    buildZenBlurResearchInvocation(options, "C:/results/zen-blur.json"),
    {
      executable: "pnpm",
      args: [
        "exec",
        "vitest",
        "--config",
        "vitest.zen-blur-research.config.ts",
        "--run",
      ],
      environment: {
        GRIMODEX_ZEN_BLUR_RESEARCH_OUTPUT: "C:/results/zen-blur.json",
        GRIMODEX_ZEN_BLUR_RESEARCH_SCENARIO: JSON.stringify({
          blur: 40,
          width: 2_560,
          height: 1_440,
          warmup: 12,
          frames: 60,
          runs: 6,
          headed: true,
        }),
        VITE_ZEN_BLUR_BACKEND: "dual-kawase-canonical",
        VITE_ZEN_DUAL_KAWASE_PASSES: "2",
        VITE_ZEN_DUAL_KAWASE_OFFSET: "1.5",
        VITE_ZEN_BLUR_PRECISION: "rgba8",
        VITE_ZEN_GLASS_NOISE_MODE: "procedural-white",
        VITE_ZEN_GLASS_NOISE_STRENGTH: "0.01",
        VITE_ZEN_GLASS_NOISE_SEED: "17",
        VITE_ZEN_RGBA8_DITHER_STRENGTH: "0.002",
        VITE_ZEN_RGBA8_DITHER_SEED: "17",
      },
    },
  );
});

test("buildZenBlurResearchInvocation disables display noise exactly at zero", () => {
  const options = parseZenBlurResearchArguments(
    argv("--output", "result.json"),
  );

  const invocation = buildZenBlurResearchInvocation(options, "result.json");
  assert.equal(invocation.environment.VITE_ZEN_GLASS_NOISE_MODE, "none");
  assert.equal(invocation.environment.VITE_ZEN_GLASS_NOISE_STRENGTH, "0");
  assert.equal(invocation.environment.VITE_ZEN_RGBA8_DITHER_STRENGTH, "0");
});
