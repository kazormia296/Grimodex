// Approved read-only diagnostic policy. Negatives mutate only NEW DB copies;
// never rewrite or reseal the positive fixture or its model requests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [binary, fixtureDirectory, outputDirectory] = process.argv.slice(2);
assert.ok(
  outputDirectory,
  "usage: node scripts/nir1-diagnostic-disclosure-probe.mjs <binary> <existing-adapter-fixture-directory> <new-output-directory>",
);
mkdirSync(outputDirectory); // Existing result directory must never be overwritten.
const fixture = JSON.parse(
  readFileSync(path.join(fixtureDirectory, "fixture.json"), "utf8"),
);
const original = path.join(fixtureDirectory, "cold-workspace/grimodex.db");
const sha = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const before = sha(original);
assert.equal(before, fixture.databaseDigest);
const policy = "nir1.scene-body-reader-history/1";
const results = [];
const legacy = spawnSync(
  path.resolve(binary),
  [original, fixture.projectId, fixture.revisionIds[0], fixture.s2],
  { encoding: "utf8" },
);
assert.equal(legacy.status, 0, legacy.stderr);
assert.equal(JSON.parse(legacy.stdout).admission, "not-evaluated");
writeFileSync(
  path.join(outputDirectory, "legacy-no-policy.json"),
  legacy.stdout,
);
const unknown = spawnSync(
  path.resolve(binary),
  [
    "--policy",
    "unknown-policy",
    original,
    fixture.projectId,
    fixture.revisionIds[0],
    fixture.s2,
  ],
  { encoding: "utf8" },
);
assert.notEqual(unknown.status, 0, "unknown policy must not be applied");
writeFileSync(
  path.join(outputDirectory, "unknown-policy.stderr.log"),
  unknown.stderr,
);
function run(name, db, project, revision, s2, expected) {
  const hash = sha(db);
  const args = ["--policy", policy, db, project, revision, s2];
  const child = spawnSync(path.resolve(binary), args, { encoding: "utf8" });
  writeFileSync(
    path.join(outputDirectory, `${name}.stdout.json`),
    child.stdout,
  );
  writeFileSync(path.join(outputDirectory, `${name}.stderr.log`), child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(sha(db), hash, "diagnostic may not mutate its input DB");
  const report = JSON.parse(child.stdout);
  assert.equal(report.diagnosticOnly, true);
  assert.equal(report.policyRef, policy);
  if (expected === "admitted") {
    assert.equal(report.admission, "admitted");
    for (const field of [
      "materialAdmission",
      "candidateAdmission",
      "staticContractAdmission",
      "candidateBindingAdmission",
    ])
      assert.equal(report[field].status, "admitted", field);
  } else {
    assert.notEqual(report.admission, "admitted");
    assert.equal(report[expected.field].reason, expected.reason);
  }
  results.push({
    name,
    args,
    databaseDigest: hash,
    admission: report.admission,
    expected,
  });
  return report;
}
for (const [index, revision] of fixture.revisionIds.entries()) {
  run(
    `positive-${index + 1}`,
    original,
    fixture.projectId,
    revision,
    fixture.s2,
    "admitted",
  );
}
const revision = fixture.revisionIds[0];
run("wrong-project", original, "other-project", revision, fixture.s2, {
  field: "materialAdmission",
  reason: "membership-unavailable",
});
run("missing-s2", original, fixture.projectId, revision, "missing-scene", {
  field: "materialAdmission",
  reason: "query-scene-missing",
});
run("same-scene", original, fixture.projectId, revision, fixture.s1, {
  field: "materialAdmission",
  reason: "distinct-s2-required",
});

function copyNegative(name) {
  const db = path.join(outputDirectory, `${name}.db`);
  cpSync(original, db, { errorOnExist: true, force: false });
  const prepared = spawnSync(
    "python",
    [
      "-c",
      `
import json, sqlite3, sys
c=sqlite3.connect(sys.argv[1]); case=sys.argv[2]; f=json.loads(sys.argv[3])
if case=='future-material':
 c.execute('UPDATE tree_nodes SET sort_order=? WHERE id=?', ('A0',f['s2']))
elif case=='story-axis':
 c.execute('UPDATE tree_nodes SET story_time_order=? WHERE id=?', ('a0',f['s1']))
 c.execute('UPDATE tree_nodes SET story_time_order=? WHERE id=?', ('a1',f['s2']))
elif case=='unapproved':
 c.execute('DELETE FROM narrative_proposal_decisions')
elif case=='wrong-decision-revision':
 c.execute('UPDATE narrative_proposal_decisions SET revision_id=? WHERE revision_id=?', (f['revisionIds'][1],f['revisionIds'][0]))
else:
 raise RuntimeError('unknown negative')
c.commit(); c.close()
`,
      db,
      name,
      JSON.stringify(fixture),
    ],
    { encoding: "utf8" },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  return db;
}
const negatives = [
  ["future-material", "materialAdmission", "source-not-before-query"],
  ["story-axis", "materialAdmission", "story-axis-unsupported"],
  ["unapproved", "candidateBindingAdmission", "revision-not-approved"],
  [
    "wrong-decision-revision",
    "candidateBindingAdmission",
    "revision-not-approved",
  ],
];
for (const [name, field, reason] of negatives) {
  run(name, copyNegative(name), fixture.projectId, revision, fixture.s2, {
    field,
    reason,
  });
}
assert.equal(sha(original), before);
const result = {
  diagnosticOnly: true,
  policyRef: policy,
  fixtureBytesUnchanged: true,
  negativeMethod: "new copies only; no request or Envelope resealing",
  searchEligibility: "not-evaluated",
  results,
};
writeFileSync(
  path.join(outputDirectory, "summary.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
