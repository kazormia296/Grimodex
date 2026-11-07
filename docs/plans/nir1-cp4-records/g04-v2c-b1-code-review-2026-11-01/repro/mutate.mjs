// Mutation probe for the post-observation freeze checks. Runs only against the
// scratch copy (mut-root); the worktree is read for pristine bytes only.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const W = process.argv[2]; // worktree (read-only source of HEAD bytes)
const M = process.argv[3]; // scratch copy
const B = process.argv[4]; // dir with base-* files
const sha = (b) => createHash("sha256").update(b).digest("hex");
const P = {
  manifest: "evals/nir1-graph/manifest.v1.json",
  readme: "evals/nir1-graph/README.md",
  schema: "evals/nir1-graph/schema.v1.json",
  freeze2: "evals/nir1-graph/freeze.v2.json",
  freeze1: "evals/nir1-graph/freeze.v1.json",
  g05: "evals/nir1-graph/g05-current-revision-freshness.v1.json",
  g04v1: "evals/nir1-graph/g04-scope-exact-unknown.v1.json",
  g04v2: "evals/nir1-graph/g04-scope-exact-unknown.v2.json",
  contract: "scripts/quality/nir1-graph/contract.mjs",
};
const restore = () => {
  for (const p of Object.values(P)) copyFileSync(path.join(W, p), path.join(M, p));
};
const rd = (p) => readFileSync(path.join(M, p));
const rj = (p) => JSON.parse(rd(p));
const wj = (p, v) => writeFileSync(path.join(M, p), JSON.stringify(v, null, 2) + "\n");
const wr = (p, s) => writeFileSync(path.join(M, p), s);
let n = 0;
async function run(name, mutate, expectFail = true) {
  restore();
  await mutate();
  const mod = await import(`${M}/${P.contract}?v=${n++}`);
  const r = await mod.validateNir1GraphCases({ repoRoot: M });
  const errs = r.errors ?? [];
  const ok = expectFail ? errs.length > 0 : errs.length === 0;
  console.log(`${ok ? "AS-EXPECTED" : "UNEXPECTED "} [${expectFail ? "expect fail" : "expect pass"}] ${name}: ${errs.length} errors`);
  for (const e of errs.slice(0, 3)) console.log("    -", e.slice(0, 220));
}
// Re-bind the freeze's own hashes to the mutated files, so that only the
// post-observation checks can notice the change.
function rebindFreeze(f) {
  const man = rj(P.manifest);
  f.manifestSha256 = sha(rd(P.manifest));
  f.schemaSha256 = sha(rd(P.schema));
  f.readmeSha256 = sha(rd(P.readme));
  for (const c of f.cases) c.sha256 = sha(readFileSync(path.join(M, c.path)));
  const last = f.independentExpectationReview.rounds.at(-1);
  for (const row of last.filesAtReview) {
    const c = f.cases.find((x) => x.path === row.path);
    if (c) row.sha256 = c.sha256;
  }
  return f;
}

await run("baseline HEAD copy", () => {}, false);

await run("G-05 bytes changed, freeze re-bound to the new G-05 hash", () => {
  wr(P.g05, rd(P.g05).toString().replace(/\n$/, "\n\n"));
  const f = rebindFreeze(rj(P.freeze2));
  wj(P.freeze2, f);
  // keep the freeze bytes what the harness would read; harness is not run here
});

await run("G-05 declared revised in freeze only (manifest unchanged)", () => {
  const f = rj(P.freeze2);
  f.postObservationRevisions.push({ ...f.postObservationRevisions[0], caseId: "G-05" });
  wj(P.freeze2, f);
});

await run("supersedes removed", () => {
  const f = rj(P.freeze2);
  delete f.supersedes;
  wj(P.freeze2, f);
});

await run("superseded freeze.v1.json bytes changed", () => {
  wr(P.freeze1, rd(P.freeze1).toString() + " ");
});

await run("postObservationRevisions[0].from.sha256 wrong", () => {
  const f = rj(P.freeze2);
  f.postObservationRevisions[0].from.sha256 = "0".repeat(64);
  wj(P.freeze2, f);
});

await run("G-04 v1 file changed (earlier version must stay)", () => {
  wr(P.g04v1, rd(P.g04v1).toString() + " ");
});

await run("graphOutputUsed true", () => {
  const f = rj(P.freeze2);
  f.postObservationRevisions[0].graphOutputUsed = true;
  wj(P.freeze2, f);
});

await run("manifest postObservationRevisions removed", () => {
  const m = rj(P.manifest);
  delete m.postObservationRevisions;
  wj(P.manifest, m);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
});

await run("manifest G-05 slotClass changed (outside scope)", () => {
  const m = rj(P.manifest);
  m.cases[4].predeclaredImprovement = true;
  wj(P.manifest, m);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
});

await run("manifest precondition id changed (outside scope)", () => {
  const m = rj(P.manifest);
  m.preconditions.definitions[5].scope = "variant";
  wj(P.manifest, m);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
});

await run("manifest cb4-inputs notEvaluated changed (outside scope)", () => {
  const m = rj(P.manifest);
  m.preconditions.definitions[5].notEvaluated.pop();
  wj(P.manifest, m);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
});

await run("manifest closedSet changed (outside scope)", () => {
  const m = rj(P.manifest);
  m.preconditions.closedSet += " x";
  wj(P.manifest, m);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
});

await run("manifest ir-supplement-admission.check changed (outside scope)", () => {
  const m = rj(P.manifest);
  m.preconditions.definitions[3].check += " x";
  wj(P.manifest, m);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
});

await run("manifest observationPolicy changed", () => {
  const m = rj(P.manifest);
  m.observationPolicy += " x";
  wj(P.manifest, m);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
});

await run("manifest coverageGaps: an EXISTING gap deleted (inside /coverageGaps)", () => {
  const m = rj(P.manifest);
  m.coverageGaps.splice(0, 1);
  wj(P.manifest, m);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
}, false);

await run("manifest holdVersusBlocked rewritten (inside scope)", () => {
  const m = rj(P.manifest);
  m.preconditions.holdVersusBlocked = "Blocked means anything.";
  wj(P.manifest, m);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
}, false);

await run("schema: another property changed (outside pointer)", () => {
  const s = rj(P.schema);
  s.properties.caseId.pattern = "^G-0[1-8]$";
  wj(P.schema, s);
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
});

await run("README: unscoped section (fixture の読み方) changed", () => {
  wr(P.readme, rd(P.readme).toString().replace("## fixture の読み方\n", "## fixture の読み方\n\nx\n"));
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
});

await run("README: scoped section line '観測の後に足さず' removed (inside scope)", () => {
  wr(P.readme, rd(P.readme).toString().replace("- 前提条件は、観測の後に足さず、外さず、読み替えない。前提条件が成り立たなくても期待値は変えない。\n", ""));
  wj(P.freeze2, rebindFreeze(rj(P.freeze2)));
}, false);

await run("freeze filesAtReview manifest sha set to junk (not checked vs superseded)", () => {
  const f = rj(P.freeze2);
  f.independentExpectationReview.rounds.at(-1).filesAtReview[0].sha256 = "1".repeat(64);
  wj(P.freeze2, f);
}, false);

await run("approvedSha256OutsideScope recomputed after an outside-scope schema change", async () => {
  const s = rj(P.schema);
  s.properties.caseId.pattern = "^G-0[1-8]$";
  wj(P.schema, s);
  const f = rebindFreeze(rj(P.freeze2));
  const mod = await import(`${W}/${P.contract}`);
  const ch = f.independentExpectationReview.changesAfterApproval.find((c) => c.path === P.schema);
  ch.approvedSha256OutsideScope = sha(mod.contentOutsideScope(rd(P.schema), ch.scope));
  wj(P.freeze2, f);
}, false);

await run("freeze graphRuntimeObservedBeforeFreeze false but manifest true", () => {
  const f = rj(P.freeze2);
  f.graphRuntimeObservedBeforeFreeze = false;
  wj(P.freeze2, f);
});

// v1 strictness: point the validator back at freeze.v1.json with the base
// manifest/README/schema; the new validator must still accept v1 and reject
// post-observation material there.
async function v1Mode(extra) {
  copyFileSync(path.join(B, "base-manifest.v1.json"), path.join(M, P.manifest));
  copyFileSync(path.join(B, "base-README.md"), path.join(M, P.readme));
  copyFileSync(path.join(B, "base-schema.v1.json"), path.join(M, P.schema));
  wr(P.contract, rd(P.contract).toString().replace(
    'NIR1_GRAPH_FREEZE_PATH = "evals/nir1-graph/freeze.v2.json"',
    'NIR1_GRAPH_FREEZE_PATH = "evals/nir1-graph/freeze.v1.json"'));
  await extra?.();
}
await run("v1 mode: base manifest + freeze.v1 under the new validator", () => v1Mode(), false);
await run("v1 mode: manifest adds postObservationRevisions", () => v1Mode(() => {
  const m = rj(P.manifest);
  m.postObservationRevisions = [{ caseId: "G-04" }];
  wj(P.manifest, m);
}));
await run("v1 mode: manifest graphRuntimeObservedBeforeFreeze true", () => v1Mode(() => {
  const m = rj(P.manifest);
  m.graphRuntimeObservedBeforeFreeze = true;
  wj(P.manifest, m);
}));
await run("v1 mode: README section changed outside v1's declared scope", () => v1Mode(() => {
  wr(P.readme, rd(P.readme).toString().replace("## fixture の読み方\n", "## fixture の読み方\n\nx\n"));
}));
restore();
console.log("restored");
