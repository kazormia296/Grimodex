#!/usr/bin/env node
/**
 * Gate B2 certification bootstrap.
 *
 * The checkout that invokes this file is not allowed to make certification
 * decisions. It only verifies a clean caller, creates a detached worktree at
 * the frozen candidate, and executes that candidate's runner in a new Node
 * process.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  FREEZE_RELATIVE,
  assertFreezeActive,
  assertWorkingTreeClean,
  bindExecutionRoot,
  loadFreezeDocument,
  prepareWorktreeDependencies,
} from "./certify-gate-b2-bindings.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const EXECUTION_FLAGS = new Set([
  "--run-light",
  "--run-heavy",
  "--run-journeys",
  "--run-informational",
  "--run-release-adjacent",
]);

function optionValue(argv, option) {
  const index = argv.indexOf(option);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function withAbsoluteOutputPaths(argv, candidateSha) {
  const result = [...argv];
  const makeAbsolute = (option) => {
    const index = result.indexOf(option);
    if (index >= 0 && !path.isAbsolute(result[index + 1])) {
      result[index + 1] = path.join(repoRoot, result[index + 1]);
    }
  };
  for (const option of [
    "--artifact-dir",
    "--report",
    "--ci-evidence",
    "--journey-evidence-dir",
  ]) {
    makeAbsolute(option);
  }
  if (!result.includes("--artifact-dir")) {
    result.push(
      "--artifact-dir",
      path.join(repoRoot, ".artifacts/gate-b2", candidateSha),
    );
  }
  return result;
}

function runCandidateRunner(executionRoot, argv, freezePath) {
  return new Promise((resolve, reject) => {
    const runnerPath = path.join(
      executionRoot,
      "scripts/quality/certify-gate-b2.mjs",
    );
    const child = spawn(process.execPath, [runnerPath, ...argv], {
      cwd: executionRoot,
      env: {
        ...process.env,
        GATE_B2_BOUND_EXECUTION: "1",
        GATE_B2_FREEZE_PATH: freezePath,
      },
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`candidate runner terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const needsExecution = argv.some((arg) => EXECUTION_FLAGS.has(arg));
  if (!needsExecution) {
    const runnerPath = path.join(
      repoRoot,
      "scripts/quality/certify-gate-b2.mjs",
    );
    process.exitCode = await runCandidateRunner(repoRoot, argv, "");
    return;
  }

  await assertWorkingTreeClean(repoRoot);
  const freezePath = path.join(repoRoot, FREEZE_RELATIVE);
  const freeze = await loadFreezeDocument(repoRoot, freezePath);
  assertFreezeActive(freeze);
  const requestedCandidate = optionValue(argv, "--candidate");
  if (!requestedCandidate) {
    throw new Error(
      "--candidate <frozen-sha> is required when running light/heavy/journeys",
    );
  }
  if (requestedCandidate !== freeze.candidate.commitSha) {
    throw new Error(
      `--candidate must be the frozen commit SHA ${freeze.candidate.commitSha}`,
    );
  }

  const bound = await bindExecutionRoot({
    repoRoot,
    candidateSha: requestedCandidate,
    freeze,
    requireTreeShaMatch: true,
    createWorktree: true,
  });
  try {
    await prepareWorktreeDependencies({
      repoRoot,
      executionRoot: bound.executionRoot,
    });
    process.exitCode = await runCandidateRunner(
      bound.executionRoot,
      withAbsoluteOutputPaths(argv, requestedCandidate),
      freezePath,
    );
  } finally {
    await bound.cleanup();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
