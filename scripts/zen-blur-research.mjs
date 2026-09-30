#!/usr/bin/env node

/* global console */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const VALID_BACKENDS = new Set([
  "gaussian-current",
  "dual-kawase-canonical",
  "dual-kawase-planned",
]);
const VALID_PRECISIONS = new Set(["auto", "rgba8"]);
const VALID_TIMING_MODES = new Set(["frame", "blur", "pass-breakdown"]);
const MAX_DITHER_STRENGTH = 1 / 255;

const DEFAULT_OPTIONS = Object.freeze({
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
  timing: "frame",
  primeRuns: 1,
});

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function outputValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error("--output requires a file path");
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

function numberInRange(value, label, minimum, maximum = Infinity) {
  const parsed = finiteNumber(value, label);
  if (parsed < minimum || parsed > maximum) {
    const maximumDescription = Number.isFinite(maximum)
      ? ` and at most ${maximum}`
      : "";
    throw new Error(
      `${label} must be at least ${minimum}${maximumDescription}`,
    );
  }
  return parsed;
}

function positiveNumber(value, label) {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function integerInRange(value, label, minimum, maximum = Infinity) {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const maximumDescription = Number.isFinite(maximum)
      ? ` and at most ${maximum}`
      : "";
    throw new Error(
      `${label} must be a safe integer of at least ${minimum}${maximumDescription}`,
    );
  }
  return parsed;
}

function enumValue(value, label, allowed) {
  if (!allowed.has(value)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

function validateOptions(options) {
  return {
    ...options,
    backend: enumValue(options.backend, "backend", VALID_BACKENDS),
    blur: positiveNumber(options.blur, "blur"),
    width: integerInRange(options.width, "width", 1),
    height: integerInRange(options.height, "height", 1),
    warmup: integerInRange(options.warmup, "warmup", 0),
    frames: integerInRange(options.frames, "frames", 1),
    runs: integerInRange(options.runs, "runs", 1),
    passes: integerInRange(options.passes, "passes", 1, 4),
    offset: numberInRange(options.offset, "offset", 0.5, 4),
    precision: enumValue(options.precision, "precision", VALID_PRECISIONS),
    noise: numberInRange(options.noise, "noise", 0, 0.02),
    dither: numberInRange(options.dither, "dither", 0, MAX_DITHER_STRENGTH),
    seed: integerInRange(options.seed, "seed", 0, 0xffff_ffff),
    headed: options.headed,
    timing: enumValue(options.timing, "timing", VALID_TIMING_MODES),
    primeRuns: integerInRange(options.primeRuns, "prime-runs", 0),
  };
}

export function parseZenBlurResearchArguments(argv) {
  const options = { ...DEFAULT_OPTIONS, outputPath: null };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--output":
        options.outputPath = outputValue(argv, index);
        index += 1;
        break;
      case "--backend":
        options.backend = enumValue(
          requiredValue(argv, index, argument),
          "backend",
          VALID_BACKENDS,
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
        options.width = integerInRange(
          requiredValue(argv, index, argument),
          "width",
          1,
        );
        index += 1;
        break;
      case "--height":
        options.height = integerInRange(
          requiredValue(argv, index, argument),
          "height",
          1,
        );
        index += 1;
        break;
      case "--warmup":
        options.warmup = integerInRange(
          requiredValue(argv, index, argument),
          "warmup",
          0,
        );
        index += 1;
        break;
      case "--frames":
        options.frames = integerInRange(
          requiredValue(argv, index, argument),
          "frames",
          1,
        );
        index += 1;
        break;
      case "--runs":
        options.runs = integerInRange(
          requiredValue(argv, index, argument),
          "runs",
          1,
        );
        index += 1;
        break;
      case "--passes":
        options.passes = integerInRange(
          requiredValue(argv, index, argument),
          "passes",
          1,
          4,
        );
        index += 1;
        break;
      case "--offset":
        options.offset = numberInRange(
          requiredValue(argv, index, argument),
          "offset",
          0.5,
          4,
        );
        index += 1;
        break;
      case "--precision":
        options.precision = enumValue(
          requiredValue(argv, index, argument),
          "precision",
          VALID_PRECISIONS,
        );
        index += 1;
        break;
      case "--noise":
        options.noise = numberInRange(
          requiredValue(argv, index, argument),
          "noise",
          0,
          0.02,
        );
        index += 1;
        break;
      case "--dither":
        options.dither = numberInRange(
          requiredValue(argv, index, argument),
          "dither",
          0,
          MAX_DITHER_STRENGTH,
        );
        index += 1;
        break;
      case "--seed":
        options.seed = integerInRange(
          requiredValue(argv, index, argument),
          "seed",
          0,
          0xffff_ffff,
        );
        index += 1;
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--timing":
        options.timing = enumValue(
          requiredValue(argv, index, argument),
          "timing",
          VALID_TIMING_MODES,
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
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (options.outputPath === null) {
    throw new Error("--output is required");
  }

  return validateOptions(options);
}

export function buildZenBlurResearchInvocation(options, outputPath) {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new Error("outputPath must be a non-empty string");
  }
  if (typeof options.headed !== "boolean") {
    throw new Error("headed must be a boolean");
  }
  const validated = validateOptions(options);

  return {
    executable: "pnpm",
    args: [
      "exec",
      "vitest",
      "--config",
      "vitest.zen-blur-research.config.ts",
      "--run",
    ],
    environment: {
      GRIMODEX_ZEN_BLUR_RESEARCH_OUTPUT: outputPath,
      GRIMODEX_ZEN_BLUR_RESEARCH_SCENARIO: JSON.stringify({
        blur: validated.blur,
        width: validated.width,
        height: validated.height,
        warmup: validated.warmup,
        frames: validated.frames,
        runs: validated.runs,
        headed: validated.headed,
        timing: validated.timing,
        primeRuns: validated.primeRuns,
      }),
      VITE_ZEN_BLUR_BACKEND: validated.backend,
      VITE_ZEN_DUAL_KAWASE_PASSES: String(validated.passes),
      VITE_ZEN_DUAL_KAWASE_OFFSET: String(validated.offset),
      VITE_ZEN_BLUR_PRECISION: validated.precision,
      VITE_ZEN_GLASS_NOISE_MODE:
        validated.noise === 0 ? "none" : "procedural-white",
      VITE_ZEN_GLASS_NOISE_STRENGTH: String(validated.noise),
      VITE_ZEN_GLASS_NOISE_SEED: String(validated.seed),
      VITE_ZEN_RGBA8_DITHER_STRENGTH: String(validated.dither),
      VITE_ZEN_RGBA8_DITHER_SEED: String(validated.seed),
    },
  };
}

function existingPathEntry(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function promoteZenBlurResearchArtifact(stagedPath, outputPath) {
  const resolvedStagedPath = path.resolve(stagedPath);
  const resolvedOutputPath = path.resolve(outputPath);
  if (resolvedStagedPath === resolvedOutputPath) {
    throw new Error("staged artifact and output path must differ");
  }

  let stagedContents;
  try {
    stagedContents = readFileSync(resolvedStagedPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`staged artifact is missing: ${resolvedStagedPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    JSON.parse(stagedContents);
  } catch (error) {
    throw new Error(
      `staged artifact is not valid JSON: ${resolvedStagedPath}`,
      {
        cause: error,
      },
    );
  }

  mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  const existingOutput = existingPathEntry(resolvedOutputPath);
  if (existingOutput !== null && !existingOutput.isFile()) {
    throw new Error(`existing output is not a file: ${resolvedOutputPath}`);
  }

  const backupPath = `${resolvedOutputPath}.${randomUUID()}.backup`;
  let previousOutputMoved = false;
  let stagedArtifactMoved = false;
  try {
    if (existingOutput !== null) {
      renameSync(resolvedOutputPath, backupPath);
      previousOutputMoved = true;
    }
    renameSync(resolvedStagedPath, resolvedOutputPath);
    stagedArtifactMoved = true;
    JSON.parse(readFileSync(resolvedOutputPath, "utf8"));
    if (previousOutputMoved) rmSync(backupPath, { force: true });
  } catch (promotionError) {
    const restorationErrors = [];
    if (stagedArtifactMoved) {
      try {
        renameSync(resolvedOutputPath, resolvedStagedPath);
      } catch {
        try {
          rmSync(resolvedOutputPath, { force: true });
        } catch (error) {
          restorationErrors.push(error);
        }
      }
    }
    if (previousOutputMoved) {
      try {
        renameSync(backupPath, resolvedOutputPath);
      } catch (error) {
        restorationErrors.push(error);
      }
    }
    if (restorationErrors.length > 0) {
      throw new AggregateError(
        [promotionError, ...restorationErrors],
        `artifact promotion failed and the previous output could not be restored: ${resolvedOutputPath}`,
        { cause: promotionError },
      );
    }
    throw promotionError;
  }
}

function runZenBlurResearch(argv = process.argv) {
  let options;
  try {
    options = parseZenBlurResearchArguments(argv);
  } catch (error) {
    console.error(
      `[zen-blur-research] ${error instanceof Error ? error.message : String(error)}`,
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
      `.${path.basename(outputPath)}.zen-blur-stage-${randomUUID()}`,
    );
    mkdirSync(stagingDirectory);
    const stagedOutputPath = path.join(stagingDirectory, "artifact.json");
    const invocation = buildZenBlurResearchInvocation(
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
          GRIMODEX_ZEN_BLUR_RESEARCH_WRITE_TOKEN: randomUUID(),
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
      `[zen-blur-research] ${error instanceof Error ? error.message : String(error)}`,
    );
    exitCode = 2;
  }

  if (stagingDirectory !== undefined) {
    try {
      rmSync(stagingDirectory, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `[zen-blur-research] could not remove staged output ${stagingDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      );
      exitCode = 2;
    }
  }

  if (outputPromoted && exitCode === 0) {
    console.log(`[zen-blur-research] wrote ${outputPath}`);
  }
  return exitCode;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) process.exitCode = runZenBlurResearch();
