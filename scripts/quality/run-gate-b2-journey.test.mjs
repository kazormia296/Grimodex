import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  JOURNEY_DEFINITIONS,
  certificationCommandForJourney,
  parseJourneyArgs,
  runJourney,
  sha256Text,
  validateRunnerEnvironment,
} from "./run-gate-b2-journey.mjs";

function validEnvironment(journeyId = "prepared-plan-toctou") {
  const definition = JOURNEY_DEFINITIONS[journeyId];
  return {
    GATE_B2_CANDIDATE_COMMIT_SHA: "a".repeat(40),
    GATE_B2_CANDIDATE_TREE_SHA: "b".repeat(40),
    GATE_B2_SUITE_ID: journeyId,
    GATE_B2_OUTPUT_PATH: "/tmp/gate-b2/journey-evidence.json",
    GATE_B2_RUNNER_ARTIFACT_PATH: "/tmp/gate-b2/runner-artifact.json",
    GATE_B2_COMMAND_DIGEST: sha256Text(
      JSON.stringify(certificationCommandForJourney(journeyId)),
    ),
    GATE_B2_ENVIRONMENT_DIGEST: `sha256:${"d".repeat(64)}`,
    GATE_B2_RUNNER_ID: definition.runnerId,
    GATE_B2_RUNNER_VERSION: "1",
    GATE_B2_FREEZE_ID: "freeze-1",
    GATE_B2_CERTIFICATION_RUN_ID: "certification-1",
    GATE_B2_ATTEMPT: "1",
  };
}

test("every required Journey has a fixed assertion-bearing command set", () => {
  assert.equal(Object.keys(JOURNEY_DEFINITIONS).length, 7);
  for (const [journeyId, definition] of Object.entries(JOURNEY_DEFINITIONS)) {
    assert.ok(definition.runnerId.startsWith("gate-b2-"));
    assert.ok(definition.assertionIds.length > 0);
    assert.ok(definition.commands.length > 0);
    for (const scenario of definition.commands) {
      assert.ok(scenario.assertionIds.length > 0);
      assert.ok(scenario.command.length > 1);
      assert.ok(scenario.command.every((part) => typeof part === "string"));
      for (const assertionId of scenario.assertionIds) {
        assert.ok(definition.assertionIds.includes(assertionId), `${journeyId}:${assertionId}`);
      }
    }
  }
});

test("runner environment is candidate, freeze, and command bound", () => {
  const binding = validateRunnerEnvironment(validEnvironment(), "prepared-plan-toctou");
  assert.equal(binding.candidateCommitSha, "a".repeat(40));
  assert.equal(binding.freezeId, "freeze-1");
  assert.equal(binding.attempt, 1);

  assert.throws(
    () => validateRunnerEnvironment(validEnvironment(), "unknown-journey"),
    /unknown Gate B2 Journey/,
  );
  assert.throws(
    () =>
      validateRunnerEnvironment(
        { ...validEnvironment(), GATE_B2_RUNNER_ID: "manual" },
        "prepared-plan-toctou",
      ),
    /RUNNER_ID/,
  );
  assert.throws(
    () =>
      validateRunnerEnvironment(
        { ...validEnvironment(), GATE_B2_OUTPUT_PATH: "relative.json" },
        "prepared-plan-toctou",
      ),
    /absolute/,
  );
});

test("runner accepts exactly one known Journey argument", () => {
  assert.equal(
    parseJourneyArgs(["--journey-id", "semantic-gate-exclusion"]),
    "semantic-gate-exclusion",
  );
  assert.throws(
    () => parseJourneyArgs([]),
    /--journey-id is required/,
  );
  assert.throws(
    () => parseJourneyArgs(["--journey-id", "prepared-plan-toctou", "--extra"]),
    /Unknown argument/,
  );
});

test("runner refuses stale output before executing a scenario", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-journey-runner-"));
  try {
    const env = validEnvironment();
    env.GATE_B2_OUTPUT_PATH = path.join(temp, "journey-evidence.json");
    env.GATE_B2_RUNNER_ARTIFACT_PATH = path.join(temp, "runner-artifact.json");
    await writeFile(env.GATE_B2_OUTPUT_PATH, "stale\n", "utf8");
    await assert.rejects(
      () => runJourney({ journeyId: "prepared-plan-toctou", env, cwd: temp }),
      /refusing to overwrite existing Journey evidence/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
