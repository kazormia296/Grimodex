// seed-pin addendum と G-01 の setup addendum を「参照だけ v2 に直した」ときに
// validator がまだ何を言うかをメモリ上で確かめる（repo は書かない）。
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const op = await import(pathToFileURL(path.join(root, "scripts/quality/nir1-graph/observation-prep.mjs")));
const sp = await import(pathToFileURL(path.join(root, "scripts/quality/nir1-graph/seed-pin-addendum.mjs")));
const ctx = await op.loadObservationPrepContext({ repoRoot: root });
const clone = (v) => JSON.parse(JSON.stringify(v));
const freezeV2 = { path: "evals/nir1-graph/freeze.v2.json", sha256: createHash("sha256").update(readFileSync(path.join(root, "evals/nir1-graph/freeze.v2.json"))).digest("hex") };
const g04v2 = { path: "evals/nir1-graph/g04-scope-exact-unknown.v2.json", fixtureId: "nir1-g04-scope-exact-unknown/2", sha256: "96d44ec362f30352d6cb971c208f2ab71aed944d008cab9eb65ca2ab57c218e1" };

// seed-pin
const seed = clone(ctx.parsed.seedPinAddendum);
console.log("seed-pin v1 as is:", sp.seedPinAddendumErrors(seed, ctx));
seed.references.graphCaseFreeze = freezeV2;
seed.references.fixtures["G-04"] = g04v2;
console.log("seed-pin refs only -> v2:", sp.seedPinAddendumErrors(seed, ctx));
// G-04 の行は v2 の fixture から導き直しても同じか
const v1rows = ctx.parsed.seedPinAddendum.seedPins.filter((r) => r.caseId === "G-04");
console.log("seed-pin G-04 rows (v1 file):", JSON.stringify(v1rows));

// setup addendum (G-01)
const setup = clone(ctx.parsed.setupAddendum);
console.log("setup v1 as is:", op.setupAddendumErrors(setup, ctx));
setup.references.graphCaseFreeze = freezeV2;
console.log("setup refs only -> v2:", op.setupAddendumErrors(setup, ctx));
// setup addendum が G-04 や freeze.v1 を本文で名指す箇所
const text = JSON.stringify(ctx.parsed.setupAddendum);
for (const needle of ["freeze.v1", "g04", "G-04", "declaration-addendum.v1", "seed-pin-addendum.v1", "4 つの Scene", "5 run"])
  console.log(`setup addendum mentions ${needle}:`, text.split(needle).length - 1);
const stext = JSON.stringify(ctx.parsed.seedPinAddendum);
for (const needle of ["freeze.v1", "g04", "G-04", "4d002261", "6080530a"])
  console.log(`seed-pin addendum mentions ${needle}:`, stext.split(needle).length - 1);
