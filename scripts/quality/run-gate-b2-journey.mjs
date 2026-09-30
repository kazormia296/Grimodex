#!/usr/bin/env node
/**
 * Candidate-bound Gate B2 Journey runner.
 *
 * The certifier starts this file from the frozen execution worktree.  Journey
 * evidence is written only after the fixed scenario commands have completed;
 * callers cannot provide a replacement evidence path or command through the
 * runner environment.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const RUNNER_VERSION = "1";

function sha256Buffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function sha256Text(text) {
  return sha256Buffer(Buffer.from(text, "utf8"));
}

function rustTest(testTarget, filter) {
  return [
    "cargo",
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "-p",
    "grimodex-db",
    "--test",
    testTarget,
    filter,
  ];
}

function vitestTest(...args) {
  return ["pnpm", "exec", "vitest", "--config", "vitest.config.ts", "--run", ...args];
}

export const JOURNEY_DEFINITIONS = Object.freeze({
  "prepared-plan-toctou": {
    runnerId: "gate-b2-prepared-plan-toctou-journey",
    assertionIds: [
      "source-changed-after-prepare",
      "apply-rejected-or-revalidated",
    ],
    commands: [
      {
        assertionIds: ["source-changed-after-prepare"],
        command: rustTest(
          "narrative_prepared_commit",
          "actual_scene_writer_invalidates_prepared_commit_on_scene_body_change",
        ),
      },
      {
        assertionIds: ["apply-rejected-or-revalidated"],
        command: rustTest(
          "narrative_prepared_commit",
          "stale_source_invalidates_prepared_commit_without_domain_mutation",
        ),
      },
    ],
  },
  "runtime-terminalization": {
    runnerId: "gate-b2-runtime-terminalization-journey",
    assertionIds: ["runtime-terminal-state", "no-partial-apply"],
    commands: [
      {
        assertionIds: ["runtime-terminal-state"],
        command: rustTest(
          "narrative_runtime_authority",
          "disabled_runtime_still_allows_in_flight_work_to_terminalize_and_release_leases",
        ),
      },
      {
        assertionIds: ["no-partial-apply"],
        command: rustTest(
          "narrative_extraction",
          "apply_commit_rolls_back_all_on_failure",
        ),
      },
    ],
  },
  "browser-electron-writer-parity": {
    runnerId: "gate-b2-browser-electron-writer-parity-journey",
    assertionIds: ["parity-write-result", "parity-event-shape"],
    commands: [
      {
        assertionIds: ["parity-write-result", "parity-event-shape"],
        command: vitestTest(
          "src/features/narrative-extraction/reconciler/gateB2Negatives.test.ts",
          "-t",
          "keeps browser and Electron writer trace schemas in parity",
        ),
      },
    ],
  },
  "locked-field-enforcement": {
    runnerId: "gate-b2-locked-field-journey",
    assertionIds: [
      "locked-write-rejected",
      "target-value-unchanged",
      "no-change-event",
      "no-undo-journal",
    ],
    commands: [
      {
        assertionIds: [
          "locked-write-rejected",
          "target-value-unchanged",
          "no-change-event",
          "no-undo-journal",
        ],
        command: rustTest(
          "narrative_prepared_commit",
          "locked_field_invalidates_ai_apply_without_partial_mutation",
        ),
      },
    ],
  },
  "dirty-only-propagation": {
    runnerId: "gate-b2-dirty-only-propagation-journey",
    assertionIds: ["dirty-only-propagated", "clean-fields-untouched"],
    commands: [
      {
        assertionIds: ["dirty-only-propagated"],
        command: rustTest(
          "narrative_prepared_commit",
          "apply_records_source_contract_and_freshness_only_dependency",
        ),
      },
      {
        assertionIds: ["clean-fields-untouched"],
        command: rustTest(
          "narrative_prepared_commit",
          "stale_source_invalidates_prepared_commit_without_domain_mutation",
        ),
      },
    ],
  },
  "immutable-retraction-history": {
    runnerId: "gate-b2-immutable-retraction-history-journey",
    assertionIds: ["retraction-appended", "prior-history-immutable"],
    commands: [
      {
        assertionIds: ["retraction-appended", "prior-history-immutable"],
        command: rustTest(
          "narrative_prepared_commit",
          "semantic_retraction_appends_compensation_and_preserves_prior_history",
        ),
      },
    ],
  },
  "semantic-gate-exclusion": {
    runnerId: "gate-b2-semantic-gate-exclusion-journey",
    assertionIds: [
      "semantic-oddity-applied",
      "structural-invalidity-rejected",
      "decision-authority-still-required",
    ],
    commands: [
      {
        assertionIds: [
          "semantic-oddity-applied",
          "structural-invalidity-rejected",
          "decision-authority-still-required",
        ],
        command: vitestTest(
          "src/features/codex/extraction/relationSynthesis.test.ts",
          "src/features/foreshadow/extraction/foreshadowGates.test.ts",
        ),
      },
    ],
  },
});

export function certificationCommandForJourney(journeyId) {
  if (!JOURNEY_DEFINITIONS[journeyId]) {
    throw new Error(`unknown Gate B2 Journey: ${journeyId}`);
  }
  return ["pnpm", `test:gate-b2:${journeyId}`];
}

function requiredEnvironment(name, env) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required for candidate-bound Journey execution`);
  }
  return value;
}

export function validateRunnerEnvironment(env = process.env, journeyId) {
  const definition = JOURNEY_DEFINITIONS[journeyId];
  if (!definition) throw new Error(`unknown Gate B2 Journey: ${journeyId}`);

  const candidateCommitSha = requiredEnvironment(
    "GATE_B2_CANDIDATE_COMMIT_SHA",
    env,
  );
  const candidateTreeSha = requiredEnvironment(
    "GATE_B2_CANDIDATE_TREE_SHA",
    env,
  );
  if (!COMMIT_RE.test(candidateCommitSha) || !COMMIT_RE.test(candidateTreeSha)) {
    throw new Error("GATE_B2 candidate commit/tree must be lowercase 40-character SHA-1 values");
  }
  if (requiredEnvironment("GATE_B2_SUITE_ID", env) !== journeyId) {
    throw new Error("GATE_B2_SUITE_ID does not match the runner Journey");
  }
  if (requiredEnvironment("GATE_B2_RUNNER_ID", env) !== definition.runnerId) {
    throw new Error("GATE_B2_RUNNER_ID does not match the Journey contract");
  }
  if (requiredEnvironment("GATE_B2_RUNNER_VERSION", env) !== RUNNER_VERSION) {
    throw new Error("GATE_B2_RUNNER_VERSION does not match the Journey runner");
  }
  const outputPath = requiredEnvironment("GATE_B2_OUTPUT_PATH", env);
  const artifactPath = requiredEnvironment("GATE_B2_RUNNER_ARTIFACT_PATH", env);
  if (!path.isAbsolute(outputPath) || !path.isAbsolute(artifactPath)) {
    throw new Error("Journey output and artifact paths must be absolute");
  }
  const commandDigest = requiredEnvironment("GATE_B2_COMMAND_DIGEST", env);
  if (!SHA256_RE.test(commandDigest)) {
    throw new Error("GATE_B2_COMMAND_DIGEST must be sha256:...");
  }
  if (commandDigest !== sha256Text(JSON.stringify(certificationCommandForJourney(journeyId)))) {
    throw new Error("GATE_B2_COMMAND_DIGEST does not match the fixed Journey command");
  }
  const environmentDigest = requiredEnvironment(
    "GATE_B2_ENVIRONMENT_DIGEST",
    env,
  );
  if (!SHA256_RE.test(environmentDigest)) {
    throw new Error("GATE_B2_ENVIRONMENT_DIGEST must be sha256:...");
  }
  requiredEnvironment("GATE_B2_FREEZE_ID", env);
  requiredEnvironment("GATE_B2_CERTIFICATION_RUN_ID", env);
  const attempt = Number.parseInt(requiredEnvironment("GATE_B2_ATTEMPT", env), 10);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("GATE_B2_ATTEMPT must be a positive integer");
  }
  return {
    definition,
    candidateCommitSha,
    candidateTreeSha,
    outputPath,
    artifactPath,
    commandDigest,
    environmentDigest,
    freezeId: env.GATE_B2_FREEZE_ID,
    certificationRunId: env.GATE_B2_CERTIFICATION_RUN_ID,
    attempt,
  };
}

export function parseJourneyArgs(argv) {
  let journeyId = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--journey-id") {
      if (journeyId || !argv[index + 1] || argv[index + 1].startsWith("--")) {
        throw new Error("--journey-id requires exactly one value");
      }
      journeyId = argv[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!journeyId) throw new Error("--journey-id is required");
  if (!JOURNEY_DEFINITIONS[journeyId]) {
    throw new Error(`unknown Gate B2 Journey: ${journeyId}`);
  }
  return journeyId;
}

function runCommand(command, args, cwd, env) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat([
        ...stderr,
        Buffer.from(String(error.message), "utf8"),
      ]);
      resolve({
        status: "failed",
        command: [command, ...args],
        exitCode: null,
        error: error.message,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        stdoutDigest: sha256Buffer(stdoutBuffer),
        stderrDigest: sha256Buffer(stderrBuffer),
      });
    });
    child.on("exit", (exitCode, signal) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      resolve({
        status: exitCode === 0 ? "passed" : "failed",
        command: [command, ...args],
        exitCode,
        ...(signal ? { signal } : {}),
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        stdoutDigest: sha256Buffer(stdoutBuffer),
        stderrDigest: sha256Buffer(stderrBuffer),
      });
    });
  });
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function assertionResults(definition, commandResults) {
  return definition.assertionIds.map((id) => {
    const covering = commandResults.filter((result) =>
      result.assertionIds.includes(id),
    );
    const passed = covering.length > 0 && covering.every((result) => result.status === "passed");
    return {
      id,
      passed,
      message: passed
        ? "fixed scenario command completed successfully"
        : "fixed scenario command failed",
    };
  });
}

export async function runJourney({ journeyId, env = process.env, cwd = process.cwd() }) {
  const binding = validateRunnerEnvironment(env, journeyId);
  if (await pathExists(binding.outputPath)) {
    throw new Error(`refusing to overwrite existing Journey evidence: ${binding.outputPath}`);
  }
  if (await pathExists(binding.artifactPath)) {
    throw new Error(`refusing to overwrite existing Journey artifact: ${binding.artifactPath}`);
  }

  await mkdir(path.dirname(binding.outputPath), { recursive: true });
  await mkdir(path.dirname(binding.artifactPath), { recursive: true });

  const commandResults = [];
  for (const scenario of binding.definition.commands) {
    const captured = await runCommand(
      scenario.command[0],
      scenario.command.slice(1),
      cwd,
      env,
    );
    commandResults.push({
      assertionIds: scenario.assertionIds,
      ...captured,
    });
    if (captured.status !== "passed") break;
  }

  const assertions = assertionResults(binding.definition, commandResults);
  const passed = assertions.every((assertion) => assertion.passed);
  const firstFailure = commandResults.find((result) => result.status !== "passed");
  const artifact = {
    schemaVersion: 1,
    journeyId,
    candidateCommitSha: binding.candidateCommitSha,
    candidateTreeSha: binding.candidateTreeSha,
    runnerId: binding.definition.runnerId,
    runnerVersion: RUNNER_VERSION,
    commandDigest: binding.commandDigest,
    environmentDigest: binding.environmentDigest,
    freezeId: binding.freezeId,
    certificationRunId: binding.certificationRunId,
    attempt: binding.attempt,
    commands: commandResults,
    assertions,
    result: passed ? "passed" : "failed",
    startedAt: commandResults[0]?.startedAt ?? new Date().toISOString(),
    completedAt:
      commandResults.at(-1)?.completedAt ?? new Date().toISOString(),
    message: passed
      ? "all fixed Gate B2 Journey scenarios passed"
      : firstFailure?.error ?? "one or more fixed Journey scenarios failed",
  };
  const artifactJson = `${JSON.stringify(artifact, null, 2)}\n`;
  const artifactBuffer = Buffer.from(artifactJson, "utf8");
  const runnerArtifactDigest = sha256Buffer(artifactBuffer);
  await writeFile(binding.artifactPath, artifactBuffer, { flag: "wx" });

  const evidence = {
    schemaVersion: 2,
    journeyId,
    candidateCommitSha: binding.candidateCommitSha,
    candidateTreeSha: binding.candidateTreeSha,
    freezeId: binding.freezeId,
    certificationRunId: binding.certificationRunId,
    runnerId: binding.definition.runnerId,
    runnerVersion: RUNNER_VERSION,
    environmentDigest: binding.environmentDigest,
    commandDigest: binding.commandDigest,
    runnerArtifactDigest,
    assertions,
    result: passed ? "passed" : "failed",
    startedAt: artifact.startedAt,
    completedAt: artifact.completedAt,
    artifactDigests: [runnerArtifactDigest],
    message: artifact.message,
  };
  await writeFile(binding.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
  });

  return { evidence, artifact, runnerArtifactDigest };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const journeyId = parseJourneyArgs(argv);
  const { evidence } = await runJourney({ journeyId, env });
  process.stdout.write(
    `${JSON.stringify({ journeyId, result: evidence.result, outputPath: env.GATE_B2_OUTPUT_PATH })}\n`,
  );
  return evidence.result === "passed" ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
