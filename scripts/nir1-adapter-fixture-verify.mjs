// Cold, read-only checks of the diagnostic fixture; no disclosure admission.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [directory, rosterBinary, precheckBinary] = process.argv.slice(2);
assert.ok(
  precheckBinary,
  "usage: node scripts/nir1-adapter-fixture-verify.mjs <fixture-dir> <roster-binary> <precheck-binary>",
);
const read = (name) =>
  JSON.parse(readFileSync(path.join(directory, name), "utf8"));
const fixture = read("fixture.json");
const initial = read("initial.json");
const approved = read("approved.json");
const reopened = read("reopened.json");
const db = path.join(directory, "cold-workspace/grimodex.db");
const sha = () => createHash("sha256").update(readFileSync(db)).digest("hex");
const before = sha();
assert.equal(before, fixture.databaseDigest);
assert.equal(fixture.admission, "not-evaluated");
assert.equal(fixture.disclosurePolicyRef, null);
assert.equal(fixture.normalPlannerE2e, false);
assert.notEqual(fixture.s1, fixture.s2);
assert.deepEqual(reopened.stageReceipts, initial.stageReceipts);
assert.deepEqual(reopened.proposals, approved.proposals);
assert.equal(initial.stageReceipts.length, 3);
assert.deepEqual(
  initial.stageReceipts.map((r) => r.stageExecution.stageId).sort(),
  [
    "narrative_event_synthesize",
    "narrative_event_synthesize",
    "narrative_observation_extract",
  ],
);
const snapshot = initial.artifacts.find(
  (a) => a.artifactKind === "source.snapshot@1",
).payloadJson;
assert.equal(snapshot.snapshot.documents.length, 1);
assert.equal(snapshot.snapshot.documents[0].origin.nodeId, fixture.s1);
assert.ok(!JSON.stringify(snapshot).includes("NIR1_S2_MUST_NOT_ENTER_REQUEST"));
const windows = initial.artifacts.find(
  (a) => a.artifactKind === "source.window-plan@1",
).payloadJson.windows;
assert.equal(windows.length, 1);
const child = spawnSync(
  "python",
  [
    "-c",
    `
import json, sqlite3, sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
c.execute('BEGIN')
rows=c.execute('SELECT id, reconciliation_envelope_json FROM narrative_proposal_revisions').fetchall()
print(json.dumps({r[0]:json.loads(r[1]) for r in rows}))
`,
    db,
  ],
  { encoding: "utf8" },
);
assert.equal(child.status, 0, child.stderr);
const envelopes = JSON.parse(child.stdout);
assert.equal(
  Object.keys(envelopes).length,
  2,
  "initial roots only, no child or rewritten revision",
);
const results = [];
for (const revision of fixture.revisionIds) {
  const proposal = reopened.proposals.find(
    (p) => p.currentRevisionId === revision,
  );
  assert.ok(proposal);
  assert.equal(proposal.payloadJson.disclosure.secret, false);
  assert.equal(proposal.latestDecision.decision, "approved");
  const envelope = envelopes[revision];
  const scope = envelope.assertion.scope;
  assert.equal(scope.schemaVersion, 2);
  assert.deepEqual(scope.scene, { kind: "exact", ref: `scene:${fixture.s1}` });
  for (const axis of [
    "audience",
    "readingOrder",
    "storyTime",
    "knowledgeHolder",
    "narrativeLayer",
    "timeline",
    "viewpoint",
    "worldline",
  ])
    assert.deepEqual(scope[axis], { kind: "any" });
  const run = (binary, args, name) => {
    const output = spawnSync(path.resolve(binary), args, { encoding: "utf8" });
    assert.equal(output.status, 0, output.stderr);
    writeFileSync(path.join(directory, name), output.stdout);
    return JSON.parse(output.stdout);
  };
  const roster = run(
    rosterBinary,
    [db, fixture.projectId, revision],
    `roster-${revision}.json`,
  );
  assert.equal(roster.status, "complete");
  assert.equal(roster.completionScope, "source-material-membership-only");
  assert.equal(roster.materials.length, 9);
  assert.ok(
    roster.materials.every(
      (m) => m.sourceKey === `project:scene:${fixture.s1}`,
    ),
  );
  assert.equal(roster.replayedRequests.length, 2);
  for (const request of roster.replayedRequests)
    assert.deepEqual(request.reconstructed, request.persisted);
  const precheck = run(
    precheckBinary,
    [db, fixture.projectId, revision, fixture.s2],
    `precheck-${revision}.json`,
  );
  assert.equal(precheck.status, "disclosure-policy-required");
  assert.equal(precheck.admission, "not-evaluated");
  assert.deepEqual(precheck.candidateScope.unresolvedAxes, []);
  assert.deepEqual(precheck.queryAxis.resolution, {
    axisUsed: "reading",
    fallbackReason: "auto-incomplete-story-coverage",
  });
  assert.equal(precheck.materials.length, 9);
  for (const material of precheck.materials) {
    assert.equal(material.disclosurePolicyRef, null);
    assert.equal(material.authority.mapping.readingRank, 0);
  }
  results.push({
    revision,
    membership: roster.status,
    sourceMaterials: roster.materials.length,
    replayedRequests: roster.replayedRequests.length,
    candidateScope: scope,
    approval: "approved",
    admission: precheck.admission,
  });
}
assert.equal(sha(), before);
const result = {
  diagnosticOnly: true,
  databaseBytesUnchanged: true,
  s2ExcludedFromSnapshot: true,
  initialReceiptsUnchangedAfterApprovalAndReopen: true,
  disclosurePolicyRef: null,
  admission: "not-evaluated",
  results,
};
writeFileSync(
  path.join(directory, "verification.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
