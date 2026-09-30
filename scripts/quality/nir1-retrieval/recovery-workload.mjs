import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./contract.mjs";

/** A separately frozen probe overlay cannot alter the 100-revision workload. */
export function applyRecoveryProbe(base, overlay, baseSha256) {
  assert.equal(overlay.schemaVersion, "nir1-recovery-positive-probe/2");
  assert.equal(overlay.baseWorkload, "recovery-workload.json");
  assert.equal(overlay.baseWorkloadSha256, baseSha256, "recovery base changed");
  assert.equal(overlay.rankingPolicyVersion, "nir1-related-scenes-ranking/2");
  assert.equal(overlay.approvalRef, "docs/plans/nir1-a5-candidate-2.md");
  assert.equal(
    overlay.currentBody,
    "洪水で石橋が崩壊し、薪小屋への通行が不可能になった。この出来事の根拠を確認したい。",
  );
  assert.deepEqual(
    Object.keys(overlay).sort(),
    [
      "schemaVersion",
      "baseWorkload",
      "baseWorkloadSha256",
      "rankingPolicyVersion",
      "approvalRef",
      "currentBody",
    ].sort(),
  );
  return {
    ...base,
    query: { ...base.query, currentBody: overlay.currentBody },
    recoveryProbeVersion: overlay.schemaVersion,
  };
}

export async function loadRecoveryWorkload(workloadPath) {
  const workloadBytes = await readFile(workloadPath);
  const freezePath = workloadPath.replace(/\.json$/, ".freeze.json");
  const freeze = JSON.parse(await readFile(freezePath));
  assert.equal(
    sha256(workloadBytes),
    freeze.workloadSha256,
    "recovery workload changed",
  );
  const input = JSON.parse(workloadBytes);
  if (input.schemaVersion === "nir1-recovery-normal-setup/1") {
    return { workload: input, freezePath };
  }
  const basePath = path.join(
    path.dirname(workloadPath),
    "recovery-workload.json",
  );
  const base = await loadRecoveryWorkload(basePath);
  return {
    workload: applyRecoveryProbe(
      base.workload,
      input,
      sha256(await readFile(basePath)),
    ),
    freezePath,
  };
}
