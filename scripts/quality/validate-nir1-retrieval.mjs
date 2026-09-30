import path from "node:path";
import { loadContract } from "./nir1-retrieval/contract.mjs";
import { loadCandidatePolicy } from "./nir1-retrieval/candidate-policy.mjs";
import { loadRecoveryWorkload } from "./nir1-retrieval/recovery-workload.mjs";

const root = path.resolve(import.meta.dirname, "../..");
try {
  const result = await loadContract(root, {
    requireFreeze: process.argv.includes("--require-freeze"),
  });
  const candidate = await loadCandidatePolicy(root, result.digests);
  await loadRecoveryWorkload(
    `${root}/evals/nir1-retrieval/recovery-workload-v2.json`,
  );
  console.log(
    JSON.stringify({
      status: "valid",
      queries: result.queries.length,
      rankingPolicy: candidate.policy.schemaVersion,
      rankingPolicySha256: candidate.policySha256,
      acceptancePolicy: result.activeAcceptance.policy.schemaVersion,
      acceptancePolicySha256: result.activeAcceptance.policySha256,
      ...result.digests,
    }),
  );
} catch (error) {
  console.error(`[artifact] ${error.message}`);
  process.exitCode = 1;
}
