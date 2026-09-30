import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sha256 } from "./contract.mjs";

export const POLICY_PATH =
  "policies/narrative/nir1-related-scenes-ranking.json";
export const CANDIDATE_PATH = "evals/nir1-retrieval/ranking-candidate-v2.json";

export function validateCandidatePolicy(
  candidate,
  policy,
  digests,
  policySha256,
) {
  assert.equal(candidate.schemaVersion, "nir1-ranking-candidate/2");
  assert.deepEqual(
    candidate.originalContract,
    digests,
    "candidate changed fixed Gold contract",
  );
  assert.equal(candidate.policyPath, POLICY_PATH);
  assert.equal(
    candidate.policySha256,
    policySha256,
    "candidate policy hash changed",
  );
  assert.deepEqual(
    policy,
    {
      schemaVersion: "nir1-related-scenes-ranking/2",
      statementRepresentation: "ordered-json/1",
      irCosineFloors: { ja: 0.813, en: 0.66 },
      irMaxScenes: 8,
      fusion: {
        id: "raw-stable-one-supplement/1",
        maxScenes: 8,
        maxAdditionalScenes: 1,
      },
    },
    "unconfirmed ranking policy change",
  );
  assert.equal(candidate.fixedRawBudgetUnchanged, true);
  assert.equal(candidate.approvalRef, "docs/plans/nir1-a5-candidate-2.md");
}

export async function loadCandidatePolicy(root, digests) {
  const candidateBytes = await readFile(`${root}/${CANDIDATE_PATH}`);
  const candidate = JSON.parse(candidateBytes);
  const policyBytes = await readFile(`${root}/${POLICY_PATH}`);
  const policy = JSON.parse(policyBytes);
  validateCandidatePolicy(candidate, policy, digests, sha256(policyBytes));
  return {
    candidatePath: CANDIDATE_PATH,
    candidateSha256: sha256(candidateBytes),
    policyPath: POLICY_PATH,
    policySha256: sha256(policyBytes),
    policy,
    originalContract: digests,
    approvalRef: candidate.approvalRef,
  };
}
