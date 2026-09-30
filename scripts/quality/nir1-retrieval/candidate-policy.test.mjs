import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadContract, sha256 } from "./contract.mjs";
import {
  loadCandidatePolicy,
  validateCandidatePolicy,
  CANDIDATE_PATH,
} from "./candidate-policy.mjs";
import {
  applyRecoveryProbe,
  loadRecoveryWorkload,
} from "./recovery-workload.mjs";
import { validateRecoveryAcceptance } from "./acceptance-policy.mjs";

const root = path.resolve(import.meta.dirname, "../../..");

test("candidate ranking is bound to the original Gold and reviewed policy", async () => {
  const contract = await loadContract(root, { requireFreeze: true });
  const loaded = await loadCandidatePolicy(root, contract.digests);
  const candidate = JSON.parse(await readFile(`${root}/${CANDIDATE_PATH}`));
  for (const mutate of [
    (c) => {
      c.policySha256 = "0".repeat(64);
    },
    (c) => {
      c.originalContract.corpusSha256 = "0".repeat(64);
    },
    (c) => {
      c.fixedRawBudgetUnchanged = false;
    },
  ]) {
    const changed = structuredClone(candidate);
    mutate(changed);
    assert.throws(() =>
      validateCandidatePolicy(
        changed,
        loaded.policy,
        contract.digests,
        loaded.policySha256,
      ),
    );
  }
  const changedPolicy = structuredClone(loaded.policy);
  changedPolicy.irCosineFloors.ja = 0.812;
  assert.throws(() =>
    validateCandidatePolicy(
      candidate,
      changedPolicy,
      contract.digests,
      loaded.policySha256,
    ),
  );
});

test("positive recovery probe preserves the frozen workload and historical recovery contract", async () => {
  const basePath = `${root}/evals/nir1-retrieval/recovery-workload.json`;
  const bytes = await readFile(basePath);
  const base = JSON.parse(bytes);
  const overlayPath = `${root}/evals/nir1-retrieval/recovery-workload-v2.json`;
  const overlay = JSON.parse(await readFile(overlayPath));
  const { workload } = await loadRecoveryWorkload(overlayPath);
  assert.deepEqual(workload.scenes, base.scenes);
  assert.deepEqual(workload.recoveryContract, base.recoveryContract);
  const { currentBody, ...query } = workload.query;
  const { currentBody: oldBody, ...oldQuery } = base.query;
  assert.deepEqual(query, oldQuery);
  assert.notEqual(currentBody, oldBody);
  assert.equal(workload.currentRevisionCount, 100);
  assert.throws(() =>
    applyRecoveryProbe(
      base,
      { ...overlay, currentRevisionCount: 99 },
      sha256(bytes),
    ),
  );
  assert.throws(() => applyRecoveryProbe(base, overlay, "0".repeat(64)));
  assert.throws(() =>
    applyRecoveryProbe(
      base,
      { ...overlay, currentBody: oldBody },
      sha256(bytes),
    ),
  );
});

test("active recovery acceptance preserves history and replaces only recovery timing gates", async () => {
  const contract = await loadContract(root, { requireFreeze: true });
  const { policy, effectiveRecovery } = contract.activeAcceptance;
  const historical = contract.manifest.performance.recovery;
  assert.equal(historical.independentRestoredTrialsPerMutationClass, 100);
  assert.equal(historical.automaticP95LimitMs, 2000);
  assert.ok(
    !("independentRestoredTrialsPerMutationClass" in effectiveRecovery),
  );
  assert.ok(!("automaticP95LimitMs" in effectiveRecovery));
  assert.equal(effectiveRecovery.sampling.mandatoryTotalTrials, null);
  assert.equal(
    effectiveRecovery.sampling.mandatoryTrialsPerMutationClass,
    null,
  );
  assert.equal(effectiveRecovery.automaticRebuild.hardCompletionLimitMs, null);
  assert.equal(effectiveRecovery.automaticRebuild.improvementTargetP95Ms, 2000);
  assert.equal(
    effectiveRecovery.automaticRebuild.improvementTargetIsGate,
    false,
  );
  assert.deepEqual(effectiveRecovery.workloads, historical.workloads);
  assert.deepEqual(effectiveRecovery.terminals, historical.terminals);
  assert.equal(effectiveRecovery.denominator, historical.denominator);
  assert.deepEqual(policy.originalContract, contract.digests);
  const original = JSON.parse(
    await readFile(`${root}/evals/nir1-retrieval/manifest.json`),
  );
  assert.deepEqual(
    contract.manifest,
    original,
    "loading must not rewrite historical budgets or criteria",
  );
});

test("recovery acceptance rejects weakened safety, responsiveness, restore and evidence boundaries", async () => {
  const { activeAcceptance, digests } = await loadContract(root, {
    requireFreeze: true,
  });
  const policy = activeAcceptance.policy;
  const workloadDigests = {
    baseSha256: policy.workload.sha256,
    probeSha256: policy.workload.probeSha256,
  };
  for (const mutate of [
    (p) => {
      p.recovery.invalidation = "eventual";
    },
    (p) => {
      p.recovery.responsiveness.rawFallback = "optional";
    },
    (p) => {
      p.recovery.responsiveness.editing = "optional";
    },
    (p) => {
      p.recovery.responsiveness.workspaceOpen = "optional";
    },
    (p) => {
      p.recovery.responsiveness.search = "optional";
    },
    (p) => {
      p.recovery.restore.failureRecovery = "optional";
    },
    (p) => {
      p.recovery.restore.correctness = "optional";
    },
    (p) => {
      p.recovery.restore.progress = "optional";
    },
    (p) => {
      p.recovery.restore.oldEvidenceReuse = "allowed";
    },
    (p) => {
      p.priorEvidence.retroactiveRelabel = true;
    },
    (p) => {
      p.priorEvidence.retainFailuresAndTimeouts = false;
    },
    (p) => {
      p.workload.currentRevisionCount = 10;
    },
    (p) => {
      p.originalContract.corpusSha256 = "0".repeat(64);
    },
    (p) => {
      p.workload.sha256 = "0".repeat(64);
    },
    (p) => {
      p.recovery.automaticRebuild.improvementTargetIsGate = true;
    },
    (p) => {
      p.recovery.sampling.mandatoryTotalTrials = 400;
    },
  ]) {
    const changed = structuredClone(policy);
    mutate(changed);
    assert.throws(() =>
      validateRecoveryAcceptance(changed, digests, workloadDigests),
    );
  }
});
