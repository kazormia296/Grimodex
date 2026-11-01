// CP-4 S1g-B: SP/1（nir1-graph-case-seed-pin-proposal/1）の seed の pin の
// addendum の validator の試験。Graph の runtime を動かさず、repo の file と
// その変異（in-memory の複製）だけを読む。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { NIR1_GRAPH_FREEZE_PATH } from "./contract.mjs";
import { loadObservationPrepContext } from "./observation-prep.mjs";
import {
  SEED_PIN_ADDENDUM_PATH,
  SEED_PIN_ADDENDUM_V1,
  SP1,
  SP_ACCEPTANCE_IDS,
  seedPinAddendumErrors,
} from "./seed-pin-addendum.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const flip = (hex) => `${hex[0] === "0" ? "1" : "0"}${hex.slice(1)}`;

async function load() {
  const ctx = await loadObservationPrepContext({ repoRoot });
  const addendum = JSON.parse(
    await readFile(path.join(repoRoot, SEED_PIN_ADDENDUM_PATH), "utf8"),
  );
  return { ctx, addendum };
}

const row = (addendum, key) =>
  addendum.seedPins.find(
    (entry) => `${entry.caseId}/${entry.variantId}` === key,
  );
const has = (errors, pattern) => errors.some((error) => pattern.test(error));

test("the committed seed pin addendum validates", async () => {
  const { ctx, addendum } = await load();
  assert.deepEqual(seedPinAddendumErrors(addendum, ctx), []);
  assert.equal(addendum.contract.sha256, SP1.sha256);
  assert.equal(addendum.seedPins.length, 13);
});

test("rows copy the fixture's query Scene and planned seed (SP-N1, G-01 entitySeed)", async () => {
  const { ctx, addendum } = await load();
  assert.equal(row(addendum, "G-01/v1").seedEntityId, "g01-orin");
  assert.equal(row(addendum, "G-01/v1").querySceneId, "g01-query");
  assert.equal(row(addendum, "G-01/v1").seedSource, "entitySeed.id");
  const seed = clone(addendum);
  row(seed, "G-04/base").seedEntityId = "g04-lio";
  assert.ok(has(seedPinAddendumErrors(seed, ctx), /G-04\/base.*seed/u));
  const scene = clone(addendum);
  row(scene, "G-02/base").querySceneId = "g02-review";
  assert.ok(has(seedPinAddendumErrors(scene, ctx), /G-02\/base.*query Scene/u));
  const source = clone(addendum);
  row(source, "G-01/v1").seedSource = "manualSeed.entityId";
  assert.ok(seedPinAddendumErrors(source, ctx).length > 0);
});

test("every variant of G-01..G-08 once, unavailable variants included (SP-N11, SP-N14, SP-N2)", async () => {
  const { ctx, addendum } = await load();
  for (const key of [
    "G-03/frontier-exceeded",
    "G-08/graph-index-unusable",
    "G-01/v1",
  ]) {
    const missing = clone(addendum);
    missing.seedPins = missing.seedPins.filter(
      (entry) => `${entry.caseId}/${entry.variantId}` !== key,
    );
    assert.ok(has(seedPinAddendumErrors(missing, ctx), /seedPins/u), key);
  }
  const twice = clone(addendum);
  twice.seedPins.push(clone(row(addendum, "G-05/base")));
  assert.ok(has(seedPinAddendumErrors(twice, ctx), /seedPins/u));
  const excluded = clone(addendum);
  excluded.contract.decision2 = "exclude-g01";
  assert.ok(has(seedPinAddendumErrors(excluded, ctx), /decision2|SP-N14/u));
});

test("one pin on the query Scene, nothing else changes, writer is upsertScenePin (SP-N2〜N5)", async () => {
  const { ctx, addendum } = await load();
  const two = clone(addendum);
  two.step.pinsOnQuerySceneAfterStep = 2;
  assert.ok(has(seedPinAddendumErrors(two, ctx), /pinsOnQuerySceneAfterStep/u));
  const sql = clone(addendum);
  sql.step.writer = "sql-insert";
  assert.ok(has(seedPinAddendumErrors(sql, ctx), /writer/u));
  const others = clone(addendum);
  others.step.otherPinsUnchanged = false;
  assert.ok(has(seedPinAddendumErrors(others, ctx), /otherPinsUnchanged/u));
  const fixturePins = clone(addendum);
  fixturePins.step.fixturePinsUnchanged = false;
  assert.ok(seedPinAddendumErrors(fixturePins, ctx).length > 0);

  // A fixture that already pins its query Scene would make two pins (SP-N2/N3).
  const g05 = clone(ctx.fixtures["G-05"].json);
  g05.pins.unshift({
    sceneId: g05.query.sceneId,
    entryId: "g05-pia",
    source: "scene_codex_pins",
  });
  const pinned = {
    ...ctx,
    fixtures: {
      ...ctx.fixtures,
      "G-05": { ...ctx.fixtures["G-05"], json: g05 },
    },
  };
  assert.ok(
    has(seedPinAddendumErrors(addendum, pinned), /G-05.*already pins/u),
  );
});

test("placement: after the foreshadow/pin step, before maintenance and setupTimeline; G-01 before prepare and the B seal (SP-N6)", async () => {
  const { ctx, addendum } = await load();
  const late = clone(addendum);
  late.step.placement.graphCases.before = "the first Graph arm query";
  assert.ok(has(seedPinAddendumErrors(late, ctx), /placement/u));
  const inside = clone(addendum);
  inside.step.placement.graphCases.outsideSetupOrder = false;
  assert.ok(has(seedPinAddendumErrors(inside, ctx), /placement/u));
  const g01 = clone(addendum);
  g01.step.placement.g01.before = "the first Graph arm query";
  assert.ok(has(seedPinAddendumErrors(g01, ctx), /placement/u));
  const rowPlace = clone(addendum);
  row(rowPlace, "G-08/both-indexes-unusable").placement = "g01";
  assert.ok(seedPinAddendumErrors(rowPlace, ctx).length > 0);
});

test("digests of the current freeze (freeze.v2.json) and every fixture (SP-N8)", async () => {
  const { ctx, addendum } = await load();
  assert.equal(NIR1_GRAPH_FREEZE_PATH, "evals/nir1-graph/freeze.v2.json");
  const v1 = JSON.parse(
    await readFile(path.join(repoRoot, SEED_PIN_ADDENDUM_V1.path), "utf8"),
  );
  // The references v1 named (freeze.v1.json, G-04 v1) are not the current.
  const oldFreeze = clone(addendum);
  oldFreeze.references.graphCaseFreeze = clone(v1.references.graphCaseFreeze);
  assert.ok(has(seedPinAddendumErrors(oldFreeze, ctx), /graphCaseFreeze/u));
  const oldG04 = clone(addendum);
  oldG04.references.fixtures["G-04"] = clone(v1.references.fixtures["G-04"]);
  assert.ok(has(seedPinAddendumErrors(oldG04, ctx), /G-04/u));
  const freeze = clone(addendum);
  freeze.references.graphCaseFreeze.sha256 = flip(
    freeze.references.graphCaseFreeze.sha256,
  );
  assert.ok(has(seedPinAddendumErrors(freeze, ctx), /graphCaseFreeze/u));
  const fixture = clone(addendum);
  fixture.references.fixtures["G-06"].sha256 = flip(
    fixture.references.fixtures["G-06"].sha256,
  );
  assert.ok(has(seedPinAddendumErrors(fixture, ctx), /G-06/u));
  const missing = clone(addendum);
  delete missing.references.fixtures["G-01"];
  assert.ok(has(seedPinAddendumErrors(missing, ctx), /G-01/u));
});

test("same workspace for every arm, no direct seed, R5 from the DB (SP-N10, N12, N13)", async () => {
  const { ctx, addendum } = await load();
  const arms = clone(addendum);
  arms.step.allArmsSameWorkspace = false;
  assert.ok(has(seedPinAddendumErrors(arms, ctx), /allArmsSameWorkspace/u));
  const direct = clone(addendum);
  direct.r5.directFetchPreviewNeverJudged = false;
  assert.ok(has(seedPinAddendumErrors(direct, ctx), /directFetch/u));
  const receipt = clone(addendum);
  receipt.r5.pinsReadFrom = "setup-receipt";
  assert.ok(has(seedPinAddendumErrors(receipt, ctx), /pinsReadFrom/u));
});

test("SP-P1〜P5 and SP-N1〜N14 each have a check and a stage", async () => {
  const { ctx, addendum } = await load();
  assert.deepEqual(
    [...addendum.acceptance.map((entry) => entry.id)].sort(),
    [...SP_ACCEPTANCE_IDS].sort(),
  );
  const missing = clone(addendum);
  missing.acceptance = missing.acceptance.filter(
    (entry) => entry.id !== "SP-N7",
  );
  assert.ok(has(seedPinAddendumErrors(missing, ctx), /SP-N7/u));
  const noCheck = clone(addendum);
  noCheck.acceptance.find((entry) => entry.id === "SP-P4").check = "";
  assert.ok(has(seedPinAddendumErrors(noCheck, ctx), /SP-P4/u));
  const stage = clone(addendum);
  stage.acceptance.find((entry) => entry.id === "SP-N1").stages = ["vibes"];
  assert.ok(has(seedPinAddendumErrors(stage, ctx), /SP-N1/u));
});

test("contract, status, review and the seed id shape (SP-N9)", async () => {
  const { ctx, addendum } = await load();
  const sha = clone(addendum);
  sha.contract.sha256 = flip(sha.contract.sha256);
  assert.ok(has(seedPinAddendumErrors(sha, ctx), /contract/u));
  // The current version was written after a Graph runtime observation
  // (B2b-1 review P2-1): false is refused.
  const observed = clone(addendum);
  observed.graphRuntimeObservedBeforeAuthoring = false;
  assert.ok(has(seedPinAddendumErrors(observed, ctx), /graphRuntimeObserved/u));
  const reviewed = clone(addendum);
  reviewed.review = { reviewer: "x" };
  assert.ok(has(seedPinAddendumErrors(reviewed, ctx), /review/u));
  // A seed whose id the product reads as no seed (blank) is refused.
  const g03 = clone(ctx.fixtures["G-03"].json);
  g03.manualSeed.entityId = "   ";
  const blank = {
    ...ctx,
    fixtures: {
      ...ctx.fixtures,
      "G-03": { ...ctx.fixtures["G-03"], json: g03 },
    },
  };
  const blankAddendum = clone(addendum);
  for (const entry of blankAddendum.seedPins)
    if (entry.caseId === "G-03") entry.seedEntityId = "   ";
  assert.ok(has(seedPinAddendumErrors(blankAddendum, blank), /SP-N9|seed id/u));
});

test("S3v2-P2-1 / P3-1: synthetic detection for SP-N1〜N5, N9〜N13; runtime stage for SP-N11; honest static claims", async () => {
  const { ctx, addendum } = await load();
  assert.equal(
    typeof addendum.acceptanceStages["synthetic-detection"],
    "string",
  );
  for (const id of ["SP-N1", "SP-N5", "SP-N9", "SP-N13"]) {
    const missing = clone(addendum);
    const entry = missing.acceptance.find((row) => row.id === id);
    entry.stages = entry.stages.filter(
      (stage) => stage !== "synthetic-detection",
    );
    assert.ok(
      has(seedPinAddendumErrors(missing, ctx), new RegExp(id, "u")),
      id,
    );
  }
  const noStage = clone(addendum);
  delete noStage.acceptanceStages["synthetic-detection"];
  assert.ok(has(seedPinAddendumErrors(noStage, ctx), /acceptanceStages/u));
  const n11 = clone(addendum);
  n11.acceptance.find((row) => row.id === "SP-N11").stages = [
    "addendum-validator",
  ];
  assert.ok(has(seedPinAddendumErrors(n11, ctx), /SP-N11/u));
  // A declared flag is not detection: SP-N10 must not claim the validator.
  const claim = clone(addendum);
  claim.acceptance
    .find((row) => row.id === "SP-N10")
    .stages.push("addendum-validator");
  assert.ok(has(seedPinAddendumErrors(claim, ctx), /SP-N10/u));
});

test("S3v2-P3-4: the SP/1 digest is recomputed when its bytes are in the repository", async () => {
  const { ctx, addendum } = await load();
  // The committed v2 is a draft (frozen after S2 追補 and S4, B2b-2); a frozen
  // one needs the bytes (S3v3-P3-1, the next test). The absent-bytes tolerance
  // is a draft's.
  const draft = clone(addendum);
  draft.status = "draft-awaiting-independent-review";
  draft.review = null;
  assert.deepEqual(
    seedPinAddendumErrors(draft, { ...ctx, sp1Sha256: null }),
    [],
  );
  assert.deepEqual(
    seedPinAddendumErrors(addendum, { ...ctx, sp1Sha256: SP1.sha256 }),
    [],
  );
  assert.ok(
    has(
      seedPinAddendumErrors(addendum, { ...ctx, sp1Sha256: "0".repeat(64) }),
      /SP\/1 bytes/u,
    ),
  );
});

test("S3v3-P3-1: a frozen seed pin addendum needs the SP/1 bytes in the repository", async () => {
  const { ctx, addendum } = await load();
  const frozen = clone(addendum);
  frozen.status = "frozen-after-independent-review";
  frozen.review = {
    reviewer: "S3",
    reviewedAt: "2026-10-27",
    record: "scratchpad/s3/observation-prep-review.v3.json",
    recordSha256: "c".repeat(64),
  };
  assert.deepEqual(
    seedPinAddendumErrors(frozen, { ...ctx, sp1Sha256: SP1.sha256 }),
    [],
  );
  assert.ok(
    has(seedPinAddendumErrors(frozen, { ...ctx, sp1Sha256: null }), /SP\/1/u),
  );
});

test("DR-CP4-G4-7 B2b-1: the new version is v1 with the references only changed, and supersedes v1's unchanged bytes", async () => {
  const { ctx, addendum } = await load();
  assert.equal(
    SEED_PIN_ADDENDUM_PATH,
    "evals/nir1-graph/seed-pin-addendum.v2.json",
  );
  const v1Bytes = await readFile(
    path.join(repoRoot, SEED_PIN_ADDENDUM_V1.path),
  );
  assert.equal(
    createHash("sha256").update(v1Bytes).digest("hex"),
    SEED_PIN_ADDENDUM_V1.sha256,
  );
  const v1 = JSON.parse(v1Bytes);
  assert.equal(addendum.addendumId, "nir1-graph-seed-pin-addendum/2");
  assert.equal(addendum.status, "draft-awaiting-independent-review");
  assert.equal(addendum.review, null);
  // Written after a Graph runtime observation (literal; B2b-1 review P2-1),
  // as a copy of v1's rows.
  assert.equal(addendum.graphRuntimeObservedBeforeAuthoring, true);
  assert.deepEqual(addendum.seedPins, v1.seedPins);
  assert.deepEqual(
    {
      path: addendum.supersedes.path,
      sha256: addendum.supersedes.sha256,
      commit: addendum.supersedes.commit,
    },
    {
      path: SEED_PIN_ADDENDUM_V1.path,
      sha256: SEED_PIN_ADDENDUM_V1.sha256,
      commit: "cf1c83e3c4d491032511cb6f11fecb5699bc3ed5",
    },
  );
  // Every other field is v1's once the freeze name reads back.
  const back = clone(addendum);
  // The flag is v1 false, v2 true (B2b-1 review P2-1).
  for (const key of [
    "addendumId",
    "status",
    "review",
    "supersedes",
    "graphRuntimeObservedBeforeAuthoring",
  ])
    delete back[key];
  back.references.graphCaseFreeze = v1.references.graphCaseFreeze;
  back.references.fixtures["G-04"] = v1.references.fixtures["G-04"];
  back.purpose = back.purpose.replace("freeze.v2.json", "freeze.v1.json");
  const n8 = back.acceptance.find((row) => row.id === "SP-N8");
  n8.check = n8.check.replace("freeze.v2.json", "freeze.v1.json");
  const v1Back = clone(v1);
  for (const key of [
    "addendumId",
    "status",
    "review",
    "graphRuntimeObservedBeforeAuthoring",
  ])
    delete v1Back[key];
  assert.deepEqual(back, v1Back);

  // v1 itself is not the current version.
  assert.ok(has(seedPinAddendumErrors(v1, ctx), /graphCaseFreeze/u));
  for (const mutate of [
    (a) => delete a.supersedes,
    (a) => (a.supersedes.sha256 = flip(a.supersedes.sha256)),
    (a) => (a.supersedes.path = "evals/nir1-graph/seed-pin-addendum.v3.json"),
    (a) => (a.supersedes.commit = "cf1c83e3"),
  ]) {
    const mutated = clone(addendum);
    mutate(mutated);
    assert.ok(has(seedPinAddendumErrors(mutated, ctx), /supersedes/u));
  }
  for (const changed of ["1".repeat(64), null])
    assert.ok(
      has(
        seedPinAddendumErrors(addendum, {
          ...ctx,
          supersededSeedPinAddendum: changed && {
            ...ctx.supersededSeedPinAddendum,
            sha256: changed,
          },
        }),
        /supersedes/u,
      ),
    );
});

test("B2b-1 review P2-1, P3-1, P3-2: the flag true holds only for a copy of v1 (references and version fields changed), id /2, a commit holding v1's bytes", async () => {
  const { ctx, addendum } = await load();
  const copyError = /references only changed/u;
  const row = (a, key) =>
    a.seedPins.find((entry) => `${entry.caseId}/${entry.variantId}` === key);
  // A newly derived row, an added row or a changed rule is not a copy, even
  // with the flag true.
  for (const mutate of [
    (a) => (row(a, "G-04/base").seedEntityId = "g04-lio"),
    (a) => a.seedPins.push({ ...row(a, "G-04/base"), variantId: "v9" }),
    (a) => (a.step.workspace = `${a.step.workspace} 追記。`),
    (a) => (a.seedPinsRule = "起案者が選ぶ。"),
    (a) => (a.purpose = a.purpose.replace("freeze.v2.json", "freeze.v3.json")),
    (a) => (a.extra = true),
  ]) {
    const mutated = clone(addendum);
    mutate(mutated);
    assert.equal(mutated.graphRuntimeObservedBeforeAuthoring, true);
    assert.ok(has(seedPinAddendumErrors(mutated, ctx), copyError));
  }
  assert.ok(!has(seedPinAddendumErrors(addendum, ctx), copyError));
  // v1's bytes are needed to compare against.
  assert.ok(
    has(
      seedPinAddendumErrors(addendum, {
        ...ctx,
        supersededSeedPinAddendum: null,
      }),
      /supersedes/u,
    ),
  );
  // P3-1: the id is the second version's.
  for (const id of [
    "nir1-graph-seed-pin-addendum/1",
    "nir1-graph-seed-pin-addendum/9",
  ]) {
    const mutated = clone(addendum);
    mutated.addendumId = id;
    assert.ok(has(seedPinAddendumErrors(mutated, ctx), /addendumId/u));
  }
  // P3-2: the commit must hold v1's bytes (git when present).
  assert.ok(
    has(
      seedPinAddendumErrors(addendum, {
        ...ctx,
        sourcePinGit: { blobSha: () => null },
      }),
      /supersedes\.commit/u,
    ),
  );
  assert.deepEqual(
    seedPinAddendumErrors(addendum, {
      ...ctx,
      sourcePinGit: { blobSha: () => SEED_PIN_ADDENDUM_V1.sha256 },
    }),
    [],
  );
});
