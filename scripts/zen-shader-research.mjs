#!/usr/bin/env node

/* global console */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promoteZenBlurResearchArtifact } from "./zen-blur-research.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const VALID_PIPELINES = new Set(["raw", "scene", "full"]);
const VALID_TOGGLES = new Set(["on", "off"]);
const VALID_TIMING_MODES = new Set(["both", "pass-breakdown", "frame"]);
const VALID_EXPERIMENTS = new Set(["pipeline", "cadence", "baselines", "abba"]);
const VALID_WORKLOADS = new Set([
  "all",
  "paper",
  "clear-only",
  "solid-fullscreen",
  "texture-copy",
]);
const VALID_CADENCE_MODES = new Set([
  "all",
  "native-raf",
  "timer-60",
  "raf-skip-60",
  "stopped-retained",
]);
const VALID_SEQUENCE_STARTS = new Set(["abba", "baab"]);
const EXPERIMENT_ONLY_OPTIONS = Object.freeze([
  "workload",
  "resolution",
  "cadence",
  "duration-ms",
  "cycles",
  "sequence-start",
]);
const ALLOWED_EXPERIMENT_OPTIONS = Object.freeze({
  pipeline: new Set(),
  cadence: new Set(["cadence", "duration-ms"]),
  baselines: new Set(["workload", "resolution"]),
  abba: new Set(["cycles", "sequence-start"]),
});
const DEFAULT_BASELINE_RESOLUTIONS = Object.freeze([
  Object.freeze({ width: 960, height: 540 }),
  Object.freeze({ width: 1_280, height: 720 }),
  Object.freeze({ width: 1_920, height: 1_080 }),
]);

const DEFAULT_OPTIONS = Object.freeze({
  experiment: "pipeline",
  shader: "all",
  pipeline: "full",
  workload: "all",
  resolutions: Object.freeze([]),
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
});

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function enumValue(value, label, allowed) {
  if (!allowed.has(value)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number`);
  }
  return parsed;
}

function positiveNumber(value, label) {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function numberInRange(value, label, minimum, maximum) {
  const parsed = finiteNumber(value, label);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function integerInRange(value, label, minimum, maximum = Infinity) {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const upper = Number.isFinite(maximum) ? ` and at most ${maximum}` : "";
    throw new Error(
      `${label} must be a safe integer of at least ${minimum}${upper}`,
    );
  }
  return parsed;
}

function toggleValue(value, label) {
  return enumValue(value, label, VALID_TOGGLES) === "on";
}

function shaderValue(value) {
  if (value === "all" || value === "representative") return value;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error("shader must be 'all' or a Paper shader id");
  }
  return value;
}

function resolutionValue(value) {
  const match = /^(\d+)[xX](\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error("resolution must use the form WIDTHxHEIGHT");
  }
  const width = integerInRange(match[1], "resolution width", 1);
  const height = integerInRange(match[2], "resolution height", 1);
  if (!Number.isSafeInteger(width * height)) {
    throw new Error("resolution pixel count must be a safe integer");
  }
  return { width, height };
}

function assertExperimentOptionOwnership(explicit, experiment) {
  const allowed = ALLOWED_EXPERIMENT_OPTIONS[experiment];
  const rejected = EXPERIMENT_ONLY_OPTIONS.filter(
    (option) => explicit.has(option) && !allowed.has(option),
  );
  if (rejected.length > 0) {
    throw new Error(
      `${experiment} research does not accept ${rejected.map((option) => `--${option}`).join(", ")}`,
    );
  }
}

export function parseZenShaderResearchArguments(argv) {
  const options = {
    ...DEFAULT_OPTIONS,
    resolutions: [],
    outputPath: null,
  };
  const explicit = new Set();

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--output":
        options.outputPath = requiredValue(argv, index, argument);
        index += 1;
        break;
      case "--shader":
        explicit.add("shader");
        options.shader = shaderValue(requiredValue(argv, index, argument));
        index += 1;
        break;
      case "--experiment":
        explicit.add("experiment");
        options.experiment = enumValue(
          requiredValue(argv, index, argument),
          "experiment",
          VALID_EXPERIMENTS,
        );
        index += 1;
        break;
      case "--pipeline":
        explicit.add("pipeline");
        options.pipeline = enumValue(
          requiredValue(argv, index, argument),
          "pipeline",
          VALID_PIPELINES,
        );
        index += 1;
        break;
      case "--workload":
        explicit.add("workload");
        options.workload = enumValue(
          requiredValue(argv, index, argument),
          "workload",
          VALID_WORKLOADS,
        );
        index += 1;
        break;
      case "--resolution": {
        explicit.add("resolution");
        const resolution = resolutionValue(
          requiredValue(argv, index, argument),
        );
        if (
          !options.resolutions.some(
            ({ width, height }) =>
              width === resolution.width && height === resolution.height,
          )
        ) {
          options.resolutions.push(resolution);
        }
        index += 1;
        break;
      }
      case "--cadence":
        explicit.add("cadence");
        options.cadence = enumValue(
          requiredValue(argv, index, argument),
          "cadence",
          VALID_CADENCE_MODES,
        );
        index += 1;
        break;
      case "--duration-ms":
        explicit.add("duration-ms");
        options.durationMs = integerInRange(
          requiredValue(argv, index, argument),
          "duration-ms",
          1,
          60_000,
        );
        index += 1;
        break;
      case "--cycles":
        explicit.add("cycles");
        options.cycles = integerInRange(
          requiredValue(argv, index, argument),
          "cycles",
          2,
        );
        index += 1;
        break;
      case "--sequence-start":
        explicit.add("sequence-start");
        options.sequenceStart = enumValue(
          requiredValue(argv, index, argument),
          "sequence-start",
          VALID_SEQUENCE_STARTS,
        );
        index += 1;
        break;
      case "--dither":
      case "--halftone":
      case "--contrast":
      case "--glass": {
        const key = argument.slice(2);
        options[key] = toggleValue(requiredValue(argv, index, argument), key);
        index += 1;
        break;
      }
      case "--dither-strength":
        options.ditherStrength = numberInRange(
          requiredValue(argv, index, argument),
          "dither-strength",
          0,
          1,
        );
        index += 1;
        break;
      case "--halftone-strength":
        options.halftoneStrength = numberInRange(
          requiredValue(argv, index, argument),
          "halftone-strength",
          0,
          1,
        );
        index += 1;
        break;
      case "--blur":
        options.blur = positiveNumber(
          requiredValue(argv, index, argument),
          "blur",
        );
        index += 1;
        break;
      case "--width":
      case "--height":
      case "--frames":
      case "--runs": {
        const key = argument.slice(2);
        explicit.add(key);
        options[key] = integerInRange(
          requiredValue(argv, index, argument),
          key,
          1,
        );
        index += 1;
        break;
      }
      case "--warmup":
        options.warmup = integerInRange(
          requiredValue(argv, index, argument),
          "warmup",
          0,
        );
        index += 1;
        break;
      case "--prime-runs":
        explicit.add("prime-runs");
        options.primeRuns = integerInRange(
          requiredValue(argv, index, argument),
          "prime-runs",
          0,
        );
        index += 1;
        break;
      case "--frame":
        options.frame = finiteNumber(
          requiredValue(argv, index, argument),
          "frame",
        );
        index += 1;
        break;
      case "--order-seed":
        options.orderSeed = integerInRange(
          requiredValue(argv, index, argument),
          "order-seed",
          0,
          0xffff_ffff,
        );
        index += 1;
        break;
      case "--timing":
        explicit.add("timing");
        options.timing = enumValue(
          requiredValue(argv, index, argument),
          "timing",
          VALID_TIMING_MODES,
        );
        index += 1;
        break;
      case "--headed":
        options.headed = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (options.outputPath === null) throw new Error("--output is required");
  if (options.pipeline !== "full" && (options.contrast || options.glass)) {
    throw new Error("contrast and glass require the full pipeline");
  }
  assertExperimentOptionOwnership(explicit, options.experiment);

  if (options.experiment === "cadence") {
    if (!options.headed) {
      throw new Error("cadence research requires --headed");
    }
    if (explicit.has("timing") && options.timing !== "frame") {
      throw new Error("cadence research only supports frame timing");
    }
    options.timing = "frame";
    if (!explicit.has("shader")) options.shader = "representative";
    if (!explicit.has("runs")) options.runs = 5;
  } else if (options.experiment === "baselines") {
    if (explicit.has("width") || explicit.has("height")) {
      throw new Error(
        "baseline research uses repeatable --resolution instead of --width/--height",
      );
    }
    if (explicit.has("pipeline")) {
      throw new Error("baseline workloads derive their pipeline automatically");
    }
    if (options.contrast || options.glass) {
      throw new Error("baseline research requires Contrast and Glass off");
    }
    if (explicit.has("timing") && options.timing !== "frame") {
      throw new Error("baseline research only supports frame timing");
    }
    options.timing = "frame";
    if (options.resolutions.length === 0) {
      options.resolutions = DEFAULT_BASELINE_RESOLUTIONS.map((resolution) => ({
        ...resolution,
      }));
    }
    const balancedRunCycle =
      options.resolutions.length === 1 ? 1 : options.resolutions.length * 2;
    if (!explicit.has("runs")) {
      options.runs = balancedRunCycle;
    } else if (options.runs % balancedRunCycle !== 0) {
      throw new Error(
        `baseline runs must be a multiple of the ${balancedRunCycle}-run balanced resolution cycle`,
      );
    }
    const maximumWidth = Math.max(
      ...options.resolutions.map(({ width }) => width),
    );
    const maximumHeight = Math.max(
      ...options.resolutions.map(({ height }) => height),
    );
    options.width = maximumWidth;
    options.height = maximumHeight;
    if (!explicit.has("shader")) options.shader = "representative";
    if (
      options.workload !== "all" &&
      options.workload !== "paper" &&
      explicit.has("shader")
    ) {
      throw new Error("non-paper baseline workloads do not accept --shader");
    }
    if (
      options.workload !== "all" &&
      options.workload !== "paper" &&
      (options.dither || options.halftone || options.contrast || options.glass)
    ) {
      throw new Error("non-paper baseline workloads do not accept effects");
    }
  } else if (options.experiment === "abba") {
    if (options.cycles % 2 !== 0) {
      throw new Error("cycles must be an even integer");
    }
    if (explicit.has("pipeline")) {
      throw new Error("ABBA research fixes raw/full variants automatically");
    }
    if (options.contrast || options.glass) {
      throw new Error("ABBA research requires Contrast and Glass off");
    }
    if (options.frames > 64) {
      throw new Error("ABBA frames must be at most 64 per block");
    }
    if (explicit.has("runs")) {
      throw new Error("ABBA research uses --cycles instead of --runs");
    }
    if (explicit.has("prime-runs") && options.primeRuns !== 0) {
      throw new Error(
        "ABBA research precompiles in-place and has no prime runs",
      );
    }
    if (explicit.has("timing") && options.timing !== "frame") {
      throw new Error("ABBA research only supports frame timing");
    }
    options.timing = "frame";
    options.runs = options.cycles;
    options.primeRuns = 0;
    if (!explicit.has("shader")) options.shader = "representative";
  }
  return options;
}

export function buildZenShaderResearchInvocation(options, outputPath) {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new Error("outputPath must be a non-empty string");
  }

  return {
    executable: "pnpm",
    args: [
      "exec",
      "vitest",
      "--config",
      "vitest.zen-shader-research.config.ts",
      "--run",
    ],
    environment: {
      GRIMODEX_ZEN_SHADER_RESEARCH_OUTPUT: outputPath,
      GRIMODEX_ZEN_SHADER_RESEARCH_SCENARIO: JSON.stringify({
        experiment: options.experiment,
        shader: options.shader,
        pipeline: options.pipeline,
        workload: options.workload,
        resolutions: options.resolutions,
        cadence: options.cadence,
        durationMs: options.durationMs,
        cycles: options.cycles,
        sequenceStart: options.sequenceStart,
        dither: options.dither,
        ditherStrength: options.ditherStrength,
        halftone: options.halftone,
        halftoneStrength: options.halftoneStrength,
        contrast: options.contrast,
        glass: options.glass,
        blur: options.blur,
        width: options.width,
        height: options.height,
        warmup: options.warmup,
        frames: options.frames,
        runs: options.runs,
        primeRuns: options.primeRuns,
        frame: options.frame,
        orderSeed: options.orderSeed,
        timing: options.timing,
        headed: options.headed,
      }),
    },
  };
}

function runZenShaderResearch(argv = process.argv) {
  let options;
  try {
    options = parseZenShaderResearchArguments(argv);
  } catch (error) {
    console.error(
      `[zen-shader-research] ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  let outputPath;
  let stagingDirectory;
  let exitCode = 0;
  let outputPromoted = false;
  try {
    outputPath = path.resolve(repositoryRoot, options.outputPath);
    const outputDirectory = path.dirname(outputPath);
    mkdirSync(outputDirectory, { recursive: true });
    stagingDirectory = path.join(
      outputDirectory,
      `.${path.basename(outputPath)}.zen-shader-stage-${randomUUID()}`,
    );
    mkdirSync(stagingDirectory);
    const stagedOutputPath = path.join(stagingDirectory, "artifact.json");
    const invocation = buildZenShaderResearchInvocation(
      options,
      stagedOutputPath,
    );
    const vitestCliPath = path.join(
      repositoryRoot,
      "node_modules",
      "vitest",
      "vitest.mjs",
    );
    const result = spawnSync(
      process.execPath,
      [vitestCliPath, ...invocation.args.slice(2)],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ...invocation.environment,
          GRIMODEX_ZEN_SHADER_RESEARCH_WRITE_TOKEN: randomUUID(),
        },
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
    } else {
      promoteZenBlurResearchArtifact(stagedOutputPath, outputPath);
      outputPromoted = true;
    }
  } catch (error) {
    console.error(
      `[zen-shader-research] ${error instanceof Error ? error.message : String(error)}`,
    );
    exitCode = 2;
  }

  if (stagingDirectory !== undefined) {
    try {
      rmSync(stagingDirectory, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `[zen-shader-research] could not remove staged output ${stagingDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      );
      exitCode = 2;
    }
  }

  if (outputPromoted && exitCode === 0) {
    console.log(`[zen-shader-research] wrote ${outputPath}`);
  }
  return exitCode;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) process.exitCode = runZenShaderResearch();
