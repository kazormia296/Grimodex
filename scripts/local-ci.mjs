#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const registryPath = path.join(repoRoot, "scripts/local-ci-registry.json");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function validateEnvironment(value, label) {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    requireString(key, `${label} key`);
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
  }
}

function validateWorkingDirectory(value, label) {
  if (value === undefined) return;
  requireString(value, label);
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must stay inside the repository`);
  }
}

export function validateLocalCiRegistry(registry) {
  if (!isPlainObject(registry) || registry.version !== 1) {
    throw new Error("local CI registry version must be 1");
  }
  requireString(registry.defaultBase, "local CI defaultBase");
  if (!isPlainObject(registry.profiles)) {
    throw new Error("local CI profiles must be an object");
  }
  if (!isPlainObject(registry.stages)) {
    throw new Error("local CI stages must be an object");
  }
  if (!isPlainObject(registry.hostedJobs)) {
    throw new Error("local CI hostedJobs must be an object");
  }

  for (const [stageId, stage] of Object.entries(registry.stages)) {
    requireString(stageId, "local CI stage id");
    if (!isPlainObject(stage)) {
      throw new Error(`local CI stage ${stageId} must be an object`);
    }
    requireString(stage.label, `local CI stage ${stageId} label`);
    validateEnvironment(stage.env, `local CI stage ${stageId} env`);
    if (!Array.isArray(stage.commands) || stage.commands.length === 0) {
      throw new Error(`local CI stage ${stageId} must define commands`);
    }
    for (const [index, command] of stage.commands.entries()) {
      const label = `local CI stage ${stageId} command ${index}`;
      if (!isPlainObject(command))
        throw new Error(`${label} must be an object`);
      requireString(command.label, `${label} label`);
      requireString(command.command, `${label} command`);
      requireStringArray(command.args, `${label} args`);
      validateWorkingDirectory(command.cwd, `${label} cwd`);
      validateEnvironment(command.env, `${label} env`);
      if (
        command.comparison !== undefined &&
        typeof command.comparison !== "boolean"
      ) {
        throw new Error(`${label} comparison must be boolean`);
      }
    }
  }

  for (const [profileId, stageIds] of Object.entries(registry.profiles)) {
    requireString(profileId, "local CI profile id");
    requireStringArray(stageIds, `local CI profile ${profileId}`);
    assertUnique(stageIds, `local CI profile ${profileId}`);
    for (const stageId of stageIds) {
      if (!Object.hasOwn(registry.stages, stageId)) {
        throw new Error(
          `local CI profile ${profileId} references unknown stage ${stageId}`,
        );
      }
    }
  }
  for (const requiredProfile of ["quick", "full"]) {
    if (!Object.hasOwn(registry.profiles, requiredProfile)) {
      throw new Error(`local CI profile ${requiredProfile} is required`);
    }
  }

  for (const [jobId, coverage] of Object.entries(registry.hostedJobs)) {
    requireString(jobId, "hosted CI job id");
    if (!isPlainObject(coverage)) {
      throw new Error(`hosted CI job ${jobId} coverage must be an object`);
    }
    const hasLocalStage = typeof coverage.localStage === "string";
    const isReleaseOnly = coverage.releaseOnly === true;
    if (hasLocalStage === isReleaseOnly) {
      throw new Error(
        `hosted CI job ${jobId} must define exactly one localStage or releaseOnly`,
      );
    }
    if (hasLocalStage) {
      if (!Object.hasOwn(registry.stages, coverage.localStage)) {
        throw new Error(
          `hosted CI job ${jobId} references unknown stage ${coverage.localStage}`,
        );
      }
      if (!registry.profiles.full.includes(coverage.localStage)) {
        throw new Error(
          `hosted CI job ${jobId} stage must be in the full profile`,
        );
      }
    } else {
      requireString(
        coverage.reason,
        `hosted CI job ${jobId} releaseOnly reason`,
      );
    }
  }

  return registry;
}

function resolveCommand(command, stage, comparison) {
  const args = [...command.args];
  if (command.comparison) {
    args.push(
      "--base",
      comparison.base,
      "--head",
      comparison.head,
      "--run",
      "--report",
      ".artifacts/local-ci/impact.json",
    );
  }
  return {
    label: command.label,
    command: command.command,
    args,
    cwd: command.cwd ?? ".",
    env: { ...(stage.env ?? {}), ...(command.env ?? {}) },
  };
}

export function buildLocalCiPlan(
  registry,
  { profile, base, head = "HEAD", from = null },
) {
  validateLocalCiRegistry(registry);
  if (!Object.hasOwn(registry.profiles, profile)) {
    throw new Error(`Unknown local CI profile: ${profile}`);
  }
  const comparison = {
    base: base ?? registry.defaultBase,
    head,
  };
  let stageIds = [...registry.profiles[profile]];
  if (from !== null) {
    const fromIndex = stageIds.indexOf(from);
    if (fromIndex === -1) {
      throw new Error(`Stage ${from} is not part of the ${profile} profile`);
    }
    stageIds = stageIds.slice(fromIndex);
  }
  const stages = stageIds.map((stageId) => {
    const stage = registry.stages[stageId];
    return {
      id: stageId,
      label: stage.label,
      commands: stage.commands.map((command) =>
        resolveCommand(command, stage, comparison),
      ),
    };
  });
  const releaseOnlyJobs =
    profile === "full"
      ? Object.entries(registry.hostedJobs)
          .filter(([, coverage]) => coverage.releaseOnly)
          .map(([id, coverage]) => ({ id, reason: coverage.reason }))
      : [];
  return { comparison, profile, releaseOnlyJobs, stages };
}

function readOptionValue(argv, option, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseLocalCiArgs(argv) {
  const result = {
    base: null,
    dryRun: false,
    from: null,
    head: null,
    list: false,
    profile: null,
    report: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--list") result.list = true;
    else if (argument === "--base") {
      result.base = readOptionValue(argv, argument, index);
      index += 1;
    } else if (argument === "--head") {
      result.head = readOptionValue(argv, argument, index);
      index += 1;
    } else if (argument === "--from") {
      result.from = readOptionValue(argv, argument, index);
      index += 1;
    } else if (argument === "--report") {
      result.report = readOptionValue(argv, argument, index);
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else if (result.profile === null) result.profile = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return result;
}

function executeCommand(entry, { root = repoRoot } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const executable =
      process.platform === "win32" && entry.command === "pnpm"
        ? "pnpm.cmd"
        : entry.command;
    const child = spawn(executable, entry.args, {
      cwd: path.resolve(root, entry.cwd),
      env: { ...process.env, ...entry.env },
      shell: false,
      stdio: "inherit",
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({
        durationMs: Math.round(performance.now() - started),
        ...result,
      });
    };
    child.once("error", (error) =>
      finish({ error: error.message, exitCode: null, signal: null }),
    );
    child.once("exit", (exitCode, signal) =>
      finish({ exitCode, signal: signal ?? null }),
    );
  });
}

function notRunCommand(command, reason) {
  return {
    ...command,
    durationMs: 0,
    exitCode: null,
    reason,
    signal: null,
    status: "not-run",
  };
}

export async function runLocalCiPlan(
  plan,
  {
    dryRun = false,
    executeCommand: execute = (entry) => executeCommand(entry),
    notify = () => {},
  } = {},
) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const stages = [];
  let failedStage = null;

  for (const stage of plan.stages) {
    if (failedStage) {
      stages.push({
        id: stage.id,
        label: stage.label,
        status: "not-run",
        durationMs: 0,
        commands: stage.commands.map((command) =>
          notRunCommand(command, `Fail-fast after ${failedStage}.`),
        ),
      });
      continue;
    }
    notify({ stage, type: "stage-start" });
    if (dryRun) {
      for (const command of stage.commands) {
        notify({ command, stage, type: "command-start" });
      }
      stages.push({
        id: stage.id,
        label: stage.label,
        status: "planned",
        durationMs: 0,
        commands: stage.commands.map((command) => ({
          ...command,
          durationMs: 0,
          exitCode: null,
          signal: null,
          status: "planned",
        })),
      });
      continue;
    }

    const stageStarted = performance.now();
    const commands = [];
    let failedCommand = null;
    for (const command of stage.commands) {
      if (failedCommand) {
        commands.push(
          notRunCommand(command, `Fail-fast after ${failedCommand}.`),
        );
        continue;
      }
      notify({ command, stage, type: "command-start" });
      let execution;
      try {
        execution = await execute(command);
      } catch (error) {
        execution = {
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
          exitCode: null,
          signal: null,
        };
      }
      const status = execution.exitCode === 0 ? "passed" : "failed";
      commands.push({ ...command, ...execution, status });
      notify({ command, execution, stage, status, type: "command-end" });
      if (status === "failed") failedCommand = command.label;
    }
    const status = failedCommand ? "failed" : "passed";
    stages.push({
      id: stage.id,
      label: stage.label,
      status,
      durationMs: Math.round(performance.now() - stageStarted),
      commands,
    });
    notify({ stage, status, type: "stage-end" });
    if (status === "failed") failedStage = stage.id;
  }

  return {
    version: 1,
    profile: plan.profile,
    comparison: plan.comparison,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    status: dryRun ? "planned" : failedStage ? "failed" : "passed",
    releaseOnlyJobs: plan.releaseOnlyJobs,
    stages,
  };
}

export async function prepareLocalCiArtifacts(plan, { root = repoRoot } = {}) {
  const directories = new Set([path.join(root, ".artifacts", "local-ci")]);
  for (const stage of plan.stages) {
    for (const command of stage.commands) {
      for (let index = 0; index < command.args.length - 1; index += 1) {
        if (!["--output", "--report"].includes(command.args[index])) continue;
        directories.add(
          path.dirname(
            path.resolve(root, command.cwd, command.args[index + 1]),
          ),
        );
      }
    }
  }
  await Promise.all(
    [...directories].map((directory) => mkdir(directory, { recursive: true })),
  );
}

function quoteArgument(value) {
  return /^[A-Za-z0-9_./:@=,+-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatCommand(command) {
  return [command.command, ...command.args].map(quoteArgument).join(" ");
}

function printRegistry(registry) {
  process.stdout.write("Local CI profiles:\n");
  for (const [profile, stageIds] of Object.entries(registry.profiles)) {
    process.stdout.write(`- ${profile}: ${stageIds.join(", ")}\n`);
  }
  const releaseOnly = Object.entries(registry.hostedJobs).filter(
    ([, coverage]) => coverage.releaseOnly,
  );
  if (releaseOnly.length > 0) {
    process.stdout.write("Release-only hosted coverage:\n");
    for (const [jobId, coverage] of releaseOnly) {
      process.stdout.write(`- ${jobId}: ${coverage.reason}\n`);
    }
  }
}

async function writeReport(reportPath, result) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const args = parseLocalCiArgs(process.argv.slice(2));
  const registry = validateLocalCiRegistry(
    JSON.parse(await readFile(registryPath, "utf8")),
  );
  if (args.list) {
    printRegistry(registry);
    return;
  }
  if (args.profile === null) {
    throw new Error("Usage: local-ci.mjs <quick|full> [options]");
  }
  const plan = buildLocalCiPlan(registry, {
    profile: args.profile,
    base: args.base ?? registry.defaultBase,
    head: args.head ?? "HEAD",
    from: args.from,
  });
  process.stdout.write(
    `[local-ci] profile=${plan.profile} base=${plan.comparison.base} head=${plan.comparison.head}\n`,
  );
  for (const job of plan.releaseOnlyJobs) {
    process.stdout.write(`[local-ci] release-only ${job.id}: ${job.reason}\n`);
  }
  if (!args.dryRun) await prepareLocalCiArtifacts(plan);
  const result = await runLocalCiPlan(plan, {
    dryRun: args.dryRun,
    notify(event) {
      if (event.type === "stage-start") {
        process.stdout.write(
          `\n[local-ci] ${event.stage.id}: ${event.stage.label}\n`,
        );
      } else if (event.type === "command-start") {
        process.stdout.write(`[local-ci] $ ${formatCommand(event.command)}\n`);
      } else if (event.type === "command-end") {
        process.stdout.write(
          `[local-ci] ${event.status.toUpperCase()} ${event.command.label}\n`,
        );
      }
    },
  });
  if (!args.dryRun) {
    const reportPath = path.resolve(
      repoRoot,
      args.report ?? `.artifacts/local-ci/${plan.profile}.json`,
    );
    await writeReport(reportPath, result);
    process.stdout.write(`[local-ci] report=${reportPath}\n`);
  }
  process.stdout.write(`[local-ci] status=${result.status}\n`);
  if (result.status === "failed") process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `[local-ci] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
