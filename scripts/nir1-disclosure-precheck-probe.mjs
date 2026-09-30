// Fixed precheck fixtures only. No admission claim and no database writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
const [binary, oldDb, project, revision, sourceScene, seedDirectory] =
  process.argv.slice(2);
assert.ok(
  seedDirectory,
  "usage: node scripts/nir1-disclosure-precheck-probe.mjs <binary> <old-db> <project> <revision> <source-scene> <new-seed-directory>",
);
const seed = JSON.parse(
  readFileSync(path.join(seedDirectory, "seed.json"), "utf8"),
);
const newDb = path.join(seedDirectory, "cold-seed-workspace/grimodex.db");
const sha = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const before = [sha(oldDb), sha(newDb)];
const results = [];
function run(name, args) {
  const child = spawnSync(path.resolve(binary), args, { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.diagnosticOnly, true);
  assert.equal(report.admission, "not-evaluated");
  results.push({ name, report });
  return report;
}
const missing = run("old-missing-s2", [oldDb, project, revision, "missing-s2"]);
assert.equal(missing.status, "query-scene-missing");
assert.equal(missing.membershipStatus, "complete");
assert.equal(
  missing.queryAxis.resolution.fallbackReason,
  "current-scene-missing",
);
assert.equal(missing.materials.length, 9);
for (const material of missing.materials) {
  assert.equal(material.disclosurePolicyRef, null);
  assert.equal(
    material.authority.mapping.sourceKey,
    material.material.sourceKey,
  );
  assert.match(
    material.authority.source.revisionToken,
    /^sha256:[a-f0-9]{64}$/,
  );
}
const same = run("old-same-scene", [oldDb, project, revision, sourceScene]);
assert.equal(same.status, "distinct-s2-required");
const readingFallback = {
  axisUsed: "reading",
  fallbackReason: "auto-incomplete-story-coverage",
};
assert.deepEqual(same.queryAxis.resolution, readingFallback);
for (const report of [missing, same])
  assert.deepEqual(report.candidateScope.unresolvedAxes, [
    "audience",
    "readingOrder",
  ]);
const query = run("new-s2-axis", [
  "--axis-only",
  newDb,
  seed.projectId,
  seed.s2,
]);
assert.deepEqual(query.resolution, readingFallback);
assert.deepEqual(
  query.authority.mappings.map((m) => m.sceneRef),
  [`scene:${seed.s1}`, `scene:${seed.s2}`],
);
assert.deepEqual([sha(oldDb), sha(newDb)], before);
console.log(
  JSON.stringify(
    {
      diagnosticOnly: true,
      databaseBytesUnchanged: true,
      admission: "not-evaluated",
      results,
    },
    null,
    2,
  ),
);
