import assert from "node:assert/strict";
import test from "node:test";

import { buildGateB2FullCiEvidence } from "./write-gate-b2-full-ci-evidence.mjs";

const candidateCommitSha = "a".repeat(40);
const candidateTreeSha = "b".repeat(40);
const fullCiContract = {
  workflowId: 123,
  workflowPath: ".github/workflows/ci.yml",
  acceptedEvents: ["workflow_dispatch"],
  requiredJobs: ["Quality", "Frontend"],
};

test("full CI evidence is candidate-bound and contract-owned", () => {
  const validRun = {
    id: 9001,
    head_sha: candidateCommitSha,
    workflow_id: 123,
    path: ".github/workflows/ci.yml",
    run_attempt: 1,
    event: "workflow_dispatch",
    conclusion: "success",
  };
  const evidence = buildGateB2FullCiEvidence({
    candidateCommitSha,
    candidateTreeSha,
    run: validRun,
    fullCiContract,
  });
  assert.deepEqual(evidence, {
    commitSha: candidateCommitSha,
    treeSha: candidateTreeSha,
    workflowId: 123,
    runId: "9001",
    runAttempt: 1,
    conclusion: "success",
    requiredJobs: ["Quality", "Frontend"],
  });

  assert.throws(
    () =>
      buildGateB2FullCiEvidence({
        candidateCommitSha,
        candidateTreeSha,
        run: { ...validRun, head_sha: "c".repeat(40) },
        fullCiContract,
      }),
    /head_sha/i,
  );

  for (const [overrides, pattern] of [
    [{ conclusion: "failure" }, /conclusion/i],
    [{ workflow_id: 999 }, /workflow_id/i],
    [{ path: ".github\/workflows\/release.yml" }, /workflow path/i],
    [{ event: "pull_request" }, /event/i],
    [{ run_attempt: 0 }, /run_attempt/i],
  ]) {
    assert.throws(
      () =>
        buildGateB2FullCiEvidence({
          candidateCommitSha,
          candidateTreeSha,
          run: { ...validRun, ...overrides },
          fullCiContract,
        }),
      pattern,
    );
  }
});
