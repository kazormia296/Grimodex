import assert from "node:assert/strict";
import test from "node:test";

import {
  getGateB2GithubAttemptConfig,
  readGateB2GithubAttemptContext,
  verifyGateB2GithubAttemptAdmission,
} from "./gate-b2-github-attempt.mjs";

const candidateCommitSha = "a".repeat(40);
const config = getGateB2GithubAttemptConfig();

function run(overrides = {}) {
  return {
    id: 9001,
    workflow_id: 777,
    path: config.workflowPath,
    event: config.event,
    head_sha: candidateCommitSha,
    display_title: `Gate B2 candidate ${candidateCommitSha}`,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

test("GitHub execution context is candidate- and workflow-bound", () => {
  const accepted = readGateB2GithubAttemptContext({
    candidateCommitSha,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: config.repository,
      GITHUB_EVENT_NAME: config.event,
      GATE_B2_CANDIDATE_SHA: candidateCommitSha,
      GITHUB_RUN_ID: "9001",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW_REF: `${config.repository}/${config.workflowPath}@refs/heads/candidate`,
    },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.attemptAuthority.runId, "9001");

  const wrongWorkflow = readGateB2GithubAttemptContext({
    candidateCommitSha,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: config.repository,
      GITHUB_EVENT_NAME: config.event,
      GATE_B2_CANDIDATE_SHA: candidateCommitSha,
      GITHUB_RUN_ID: "9001",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/ci.yml@refs/heads/candidate`,
    },
  });
  assert.equal(wrongWorkflow.ok, false);
  assert.match(wrongWorkflow.message, /workflow_ref/i);
});

test("admission rejects duplicate dispatches and reruns for the same candidate", async () => {
  const accepted = await verifyGateB2GithubAttemptAdmission({
    candidateCommitSha,
    currentRunId: "9001",
    currentRunAttempt: 1,
    listWorkflowRuns: async () => [
      run({ status: "in_progress", conclusion: null }),
    ],
  });
  assert.equal(accepted.ok, true);

  const duplicate = await verifyGateB2GithubAttemptAdmission({
    candidateCommitSha,
    currentRunId: "9002",
    currentRunAttempt: 1,
    listWorkflowRuns: async () => [
      run({ id: 9001, conclusion: "failure" }),
      run({ id: 9002, status: "in_progress", conclusion: null }),
    ],
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /exactly one/i);

  const rerun = await verifyGateB2GithubAttemptAdmission({
    candidateCommitSha,
    currentRunId: "9001",
    currentRunAttempt: 2,
    listWorkflowRuns: async () => [run({ run_attempt: 2 })],
  });
  assert.equal(rerun.ok, false);
  assert.match(rerun.message, /reruns|new candidate/i);

  const completedFailure = await verifyGateB2GithubAttemptAdmission({
    candidateCommitSha,
    currentRunId: "9001",
    currentRunAttempt: 1,
    listWorkflowRuns: async () => [run({ conclusion: "failure" })],
  });
  assert.equal(completedFailure.ok, false);
  assert.match(completedFailure.message, /completed failure/i);

  const missing = await verifyGateB2GithubAttemptAdmission({
    candidateCommitSha,
    currentRunId: "9001",
    currentRunAttempt: 1,
    listWorkflowRuns: async () => [],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /exactly one/i);

  const differentRun = await verifyGateB2GithubAttemptAdmission({
    candidateCommitSha,
    currentRunId: "9002",
    currentRunAttempt: 1,
    listWorkflowRuns: async () => [
      run({ status: "in_progress", conclusion: null }),
    ],
  });
  assert.equal(differentRun.ok, false);
  assert.match(differentRun.message, /belongs to run 9001/i);
});
