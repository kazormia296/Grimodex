import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const ACCEPTANCE_PATH = "evals/nir1-retrieval/acceptance-policy-v2.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateRecoveryAcceptance(policy, digests, workloadDigests) {
  assert.equal(policy.schemaVersion, "nir1-recovery-acceptance/2");
  assert.equal(policy.approvalRef, "docs/plans/nir1-recovery-acceptance-v2.md");
  assert.deepEqual(policy.originalContract, digests, "fixed contract changed");
  assert.deepEqual(policy.workload, {
    path: "evals/nir1-retrieval/recovery-workload.json",
    sha256: workloadDigests.baseSha256,
    probePath: "evals/nir1-retrieval/recovery-workload-v2.json",
    probeSha256: workloadDigests.probeSha256,
    currentRevisionCount: 100,
  });
  assert.deepEqual(policy.recovery, {
    invalidation: "immediate-required",
    responsiveness: {
      workspaceOpen: "required",
      editing: "required",
      search: "required",
      rawFallback: "required",
    },
    automaticRebuild: {
      execution: "background-allowed",
      hardCompletionLimitMs: null,
      improvementTargetP95Ms: 2000,
      improvementTargetIsGate: false,
    },
    sampling: {
      strategy: "risk-based-focused",
      mandatoryTrialsPerMutationClass: null,
      mandatoryTotalTrials: null,
    },
    restore: {
      correctness: "required",
      progress: "required",
      failureRecovery: "required",
      oldEvidenceReuse: "forbidden",
    },
  });
  assert.deepEqual(policy.priorEvidence, {
    retainOriginalCriteria: true,
    retroactiveRelabel: false,
    retainFailuresAndTimeouts: true,
  });
  assert.deepEqual(
    Object.keys(policy).sort(),
    [
      "approvalRef",
      "originalContract",
      "priorEvidence",
      "recovery",
      "schemaVersion",
      "workload",
    ].sort(),
  );
}

/** Preserve the frozen manifest and measured receipts; replace recovery gates only. */
export async function loadRecoveryAcceptance(root, manifest, digests) {
  const bytes = await readFile(`${root}/${ACCEPTANCE_PATH}`);
  const policy = JSON.parse(bytes);
  const base = await readFile(
    `${root}/evals/nir1-retrieval/recovery-workload.json`,
  );
  const probe = await readFile(
    `${root}/evals/nir1-retrieval/recovery-workload-v2.json`,
  );
  validateRecoveryAcceptance(policy, digests, {
    baseSha256: hash(base),
    probeSha256: hash(probe),
  });
  assert.equal(JSON.parse(base).currentRevisionCount, 100);
  const {
    independentRestoredTrialsPerMutationClass: historicalTrialCount,
    automaticP95LimitMs: historicalLimit,
    ...unchangedRecovery
  } = manifest.performance.recovery;
  assert.equal(historicalTrialCount, 100);
  assert.equal(historicalLimit, 2000);
  return {
    policyPath: ACCEPTANCE_PATH,
    policySha256: hash(bytes),
    policy,
    effectiveRecovery: { ...unchangedRecovery, ...policy.recovery },
  };
}
