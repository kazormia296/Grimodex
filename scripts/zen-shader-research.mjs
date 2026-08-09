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

const DEFAULT_OPTIONS = Object.freeze({
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
  if (value === "all") return value;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error("shader must be 'all' or a Paper shader id");
  }
  return value;
}

export function parseZenShaderResearchArguments(argv) {
  const options = { ...DEFAULT_OPTIONS, outputPath: null };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--output":
        options.outputPath = requiredValue(argv, index, argument);
        index += 1;
        break;
      case "--shader":
        options.shader = shaderValue(requiredValue(argv, index, argument));
        index += 1;
        break;
      case "--pipeline":
        options.pipeline = enumValue(
          requiredValue(argv, index, argument),
          "pipeline",
          VALID_PIPELINES,
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
        shader: options.shader,
        pipeline: options.pipeline,
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
