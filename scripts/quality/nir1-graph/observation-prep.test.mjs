// CP-4 S2: 観測前に固定する文書（K2/4 の addendum、観測前の記録、trace、K6/4 の
// 手順のファイル、作者の宣言）の validator の試験。どれも Graph の runtime を動かさ
// ず、repo の file と、その変異（in-memory の複製）だけを読む。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NIR1_GRAPH_FREEZE_PATH } from "./contract.mjs";
import {
  SEED_PIN_ADDENDUM_PATH,
  SEED_PIN_ADDENDUM_V1,
  SP1,
} from "./seed-pin-addendum.mjs";
import { execFileSync } from "node:child_process";
import {
  BLOCKED_TABLE_SOURCE,
  DECLARATION_ADDENDUM_V1,
  EVAL_CLOSURE_EXCLUSIONS,
  FORMAL_HARNESS_ENTRIES,
  HARNESS_CONSTANTS,
  HARNESS_MODULE_CONSTANTS,
  K24_SCOPE_EXTENSION,
  K24_TABLE,
  K64_FREEZE_SOURCE,
  OBSERVATION_PREP_FILES,
  PLACEHOLDER,
  S4_PROCEDURE_WORDS,
  SETUP_ADDENDUM_V1,
  SOURCE_PINS,
  assertObservationPrepFormal,
  harnessPinOf,
  isSharedClosureBoundary,
  parseHarnessConstant,
  parseHarnessModuleConstant,
  parseReadyProbeKinds,
  READY_PROBE_SOURCE,
  parseK64FreezeCommit,
  sourcePinGitErrors,
  formalReferenceErrors,
  formalReferenceRows,
  authorDeclarationErrors,
  declarationAddendumErrors,
  loadObservationPrepContext,
  observationPrepErrors,
  procedureDraftErrors,
  setupAddendumErrors,
  supersededReferences,
  traceErrors,
  validateNir1ObservationPrep,
} from "./observation-prep.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const flip = (hex) => `${hex[0] === "0" ? "1" : "0"}${hex.slice(1)}`;

async function json(relative) {
  return JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"));
}

async function context() {
  return loadObservationPrepContext({ repoRoot });
}

/**
 * S4b: the committed S2 is frozen (every S4 token filled, review set). The
 * draft's properties are checked on a draft copy: the 20 S4 tokens put back
 * in the fields S4b filled, review and formal.review null, the draft status
 * (the S2 bytes before S4b, but for the placeholder rows' field/fill text).
 */
const boundRow = (prep, file) =>
  prep.boundFiles.find((row) => row.path === file);
const S4_TOKEN_FIELDS = Object.freeze([
  ["k64-freeze-commit", (p, t) => (p.contracts.k64.freezeCommit = t)],
  ["da1-acceptance-record", (p, t) => (p.d10.g01.da1AcceptanceRecord = t)],
  ["g01-r-rir-mode", (p, t) => (p.d10.g01.rAndRirMode = t)],
  ...[
    ["trace-editing", 0, OBSERVATION_PREP_FILES.traceEditing],
    ["trace-browsing", 1, OBSERVATION_PREP_FILES.traceBrowsing],
  ].flatMap(([name, at, file]) =>
    ["commit", "sha256"].map((key) => [
      `${name}-${key}`,
      (p, t) => {
        p.traces[at][key] = t;
        boundRow(p, file)[key] = t;
      },
    ]),
  ),
  ["k64-procedure-v1-commit", (p, t) => (p.k64Procedure.formal.commit = t)],
  ["k64-procedure-v1-sha256", (p, t) => (p.k64Procedure.formal.sha256 = t)],
  ...[
    ["setup-addendum", OBSERVATION_PREP_FILES.setupAddendum],
    ["declaration-addendum", OBSERVATION_PREP_FILES.declarationAddendum],
    ["author-declaration", OBSERVATION_PREP_FILES.authorDeclaration],
    ["seed-pin-addendum", OBSERVATION_PREP_FILES.seedPinAddendum],
  ].flatMap(([name, file]) =>
    ["commit", "sha256"].map((key) => [
      `${name}-${key}`,
      (p, t) => (boundRow(p, file)[key] = t),
    ]),
  ),
  [
    "sp-synthetic-detection-record",
    (p, t) => (p.r5Gate.syntheticDetection.record = t),
  ],
  ["sp1-bytes-commit", (p, t) => (p.contracts.sp1.bytesCommit = t)],
  ["r5-check-record", (p, t) => (p.r5Gate.r5CheckRecord = t)],
]);

function draftOf(prep) {
  const draft = clone(prep);
  for (const [name, put] of S4_TOKEN_FIELDS) put(draft, `S4:${name}`);
  draft.placeholders = S4_TOKEN_FIELDS.map(([name]) => ({
    token: `S4:${name}`,
    field: "S4b",
    fill: "S4b",
  }));
  draft.review = null;
  draft.k64Procedure.formal.review = null;
  draft.status = "draft-awaiting-s3-review-and-s4-freeze";
  return draft;
}

async function draftPrep() {
  return draftOf(await json(OBSERVATION_PREP_FILES.prep));
}

/**
 * A repository root whose files are the repo's (symlinks) but for the S2
 * file, which is `prep`. No `.git`: the git checks are not reached.
 */
function rootWithPrep(prep) {
  const root = mkdtempSync(path.join(os.tmpdir(), "s2-draft-root-"));
  const target = OBSERVATION_PREP_FILES.prep.split("/");
  const link = (from, to, depth) => {
    for (const name of readdirSync(from)) {
      if (depth === 0 && name === ".git") continue;
      if (name !== target[depth])
        symlinkSync(path.join(from, name), path.join(to, name));
      else if (depth === target.length - 1)
        writeFileSync(
          path.join(to, name),
          `${JSON.stringify(prep, null, 2)}\n`,
        );
      else {
        mkdirSync(path.join(to, name));
        link(path.join(from, name), path.join(to, name), depth + 1);
      }
    }
  };
  link(repoRoot, root, 0);
  return root;
}

test("the committed observation-prep files validate (frozen again by S4b''')", async () => {
  const result = await validateNir1ObservationPrep({ repoRoot });
  assert.deepEqual(result.errors, []);
  assert.equal(result.status, "passed");
  assert.equal(result.formalReady, true);
  assert.deepEqual(result.placeholders, []);
  // S4 の最終関門の P2-1、DR-CP4-Q-2: the frozen S2's review states the facts
  // (the notification record at bf5b3799, K's attribution, the pair limit).
  // DR-CP4-S4-5／S4-6: and the earlier re-freezes. DR-CP4-S4-7: and the fourth
  // (the old S4b'', G-04 v2, the independent reviews, the retaken records and
  // the K6/4 :317 order deviation).
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  for (const word of [
    "docs/plans/nir1-cp4-records/user-notification-2026-10-30.md",
    "bf5b3799f9a8220d43f15e3479ad15e66b8c8928",
    "確認ではなく",
    "integrator が #757（DR-CP4-Q-1）",
    "#759（DR-CP4-Q-2）",
    "組の最少 24 を満たす",
    "DR-CP4-S4-5",
    "b7d7495034ee693e82b9a6e55bbcbfd433215012",
    "sp-p4-1",
    "parity-1",
    "user-confirmation-2026-10-31-refreeze.md",
    "DR-CP4-S4-6",
    "9f52e7da37b84603424d0b7e6ecee8e019d1c7c9",
    "sp-p4-s5r3-1",
    "trace-editing-s5r3-1",
    "user-confirmation-2026-10-31-trace-refreeze.md",
    "8913f127",
    "68180464",
    "DR-CP4-S4-7",
    "557e683ccd884955e220f21bd15119f115995d29",
    "user-confirmation-2026-11-01-g04-v2c-build.md",
    "integrator の読み",
    "独立期待値レビュー（8857f618",
    "規則文の意味の独立期待値レビュー（12a738ac",
    "B1 の独立コードレビュー（f2ebdd98）",
    "e42e99900f80a3e10f58702f6eaa884e3e478649",
    "K6/4 :317",
    "ユーザーの異議があれば止める",
    "S4b''' を S3 が見た記録は無い",
  ])
    assert.ok(prep.review.conditions.includes(word), word);
  assert.ok(!prep.review.conditions.includes("S4b の時点で repo に無い"));
  // S4b''': the SP-N record retaken on the G-04 v2 candidate (contracts
  // 20ccd115) and the R5 check retaken with G-04 v2's setup (56d4ec54).
  for (const word of [
    "20ccd115fd171377f06690cc31533a00b795b0a0",
    "179139b4",
    "aef7c0a1",
    "DR-CP4-S4-7",
  ])
    assert.ok(prep.r5Gate.syntheticDetection.record.includes(word), word);
  assert.ok(
    !prep.r5Gate.syntheticDetection.record.startsWith(
      "docs/plans/nir1-cp4-records/sp-synthetic-detection-record.md（commit 2d33e6a8",
    ),
  );
  for (const word of [
    "56d4ec54ae576665ce5561698fca59881926d2e8",
    "r5-check-r5-1102",
    "fa04baa444163b89d76beae467120366c5da55ca8e77a827eb597b06ad601f90",
    "8fb525ed-be32-4df4-8f92-1bffba4ca24d",
  ])
    assert.ok(prep.r5Gate.r5CheckRecord.includes(word), word);
  assert.ok(
    prep.r5Gate.r5CheckRecord.startsWith(
      "docs/plans/nir1-cp4-records/r5-check-r5-1102/",
    ),
  );
});

test("the draft copy of the committed S2 validates as a draft (S4 tokens, not formal)", async () => {
  assert.equal(S4_TOKEN_FIELDS.length, 20);
  const root = rootWithPrep(await draftPrep());
  try {
    const result = await validateNir1ObservationPrep({ repoRoot: root });
    assert.deepEqual(result.errors, []);
    assert.equal(result.status, "passed");
    assert.equal(result.formalReady, false);
    assert.equal(result.placeholders.length, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a draft with placeholders is never usable for a formal run", async () => {
  // S4b: the committed record is frozen; the draft copy is the S2 file of a
  // temporary root that otherwise has the repo's files.
  const root = rootWithPrep(await draftPrep());
  try {
    await assert.rejects(
      assertObservationPrepFormal({ repoRoot: root }),
      /\[precheck\].*(placeholder|draft)/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S4b''': the committed frozen record passes the formal gate at HEAD (git)", async (t) => {
  const ctx = await context();
  if (!ctx.sourcePinGit) {
    t.skip("shallow clone: the commits are checked by the formal gate");
    return;
  }
  assert.deepEqual(await assertObservationPrepFormal({ repoRoot }), {
    proceed: true,
  });
});

test("setup addendum: the K2/4 table row for G-01 and the fixture digests", async () => {
  const ctx = await context();
  const addendum = await json(OBSERVATION_PREP_FILES.setupAddendum);
  assert.deepEqual(setupAddendumErrors(addendum, ctx), []);

  const badFixture = clone(addendum);
  badFixture.references.g01Fixture.sha256 = flip(
    badFixture.references.g01Fixture.sha256,
  );
  assert.ok(
    setupAddendumErrors(badFixture, ctx).some((e) => /g01Fixture/u.test(e)),
  );

  const badFreeze = clone(addendum);
  badFreeze.references.graphCaseFreeze.sha256 = flip(
    badFreeze.references.graphCaseFreeze.sha256,
  );
  assert.ok(
    setupAddendumErrors(badFreeze, ctx).some((e) => /graphCaseFreeze/u.test(e)),
  );

  const badExcerpt = clone(addendum);
  badExcerpt.declarations[0].expectedExcerpt.end = 77;
  assert.ok(
    setupAddendumErrors(badExcerpt, ctx).some((e) => /excerpt/u.test(e)),
  );

  const badValue = clone(addendum);
  badValue.declarationValues.reveal = "secret";
  assert.ok(
    setupAddendumErrors(badValue, ctx).some((e) =>
      /declarationValues/u.test(e),
    ),
  );

  const extraScene = clone(addendum);
  extraScene.declarations.push({
    ...clone(addendum.declarations[0]),
    sceneId: "g01-weather",
  });
  assert.ok(setupAddendumErrors(extraScene, ctx).length > 0);

  const noNegative = clone(addendum);
  noNegative.diagnosticNegatives = noNegative.diagnosticNegatives.slice(1);
  assert.ok(
    setupAddendumErrors(noNegative, ctx).some((e) =>
      /diagnosticNegatives/u.test(e),
    ),
  );

  const counted = clone(addendum);
  counted.diagnosticNegatives[0].countsInCaseJudgement = true;
  assert.ok(setupAddendumErrors(counted, ctx).length > 0);

  const changedGold = clone(addendum);
  changedGold.unchanged.expectations.rPlusIrPlusGraph = ["g01-question"];
  assert.ok(
    setupAddendumErrors(changedGold, ctx).some((e) => /unchanged/u.test(e)),
  );

  const observed = clone(addendum);
  observed.graphRuntimeObservedBeforeAuthoring = false;
  assert.ok(
    setupAddendumErrors(observed, ctx).some((e) =>
      /graphRuntimeObserved/u.test(e),
    ),
  );

  const place = clone(addendum);
  place.declarationPlace.choice = "iii";
  assert.ok(
    setupAddendumErrors(place, ctx).some((e) => /declarationPlace/u.test(e)),
  );
});

test("declaration addendum: G-02/G-07/G-08 rows, declaration step outside setupOrder", async () => {
  const ctx = await context();
  const addendum = await json(OBSERVATION_PREP_FILES.declarationAddendum);
  assert.deepEqual(declarationAddendumErrors(addendum, ctx), []);
  assert.deepEqual(
    addendum.declarations.map((row) => `${row.caseId}/${row.variantId}`),
    K24_TABLE.filter((row) => row.caseId !== "G-01").map(
      (row) => `${row.caseId}/${row.variantId}`,
    ),
  );

  const noStep = clone(addendum);
  delete noStep.declarationStep;
  assert.ok(
    declarationAddendumErrors(noStep, ctx).some((e) =>
      /declarationStep/u.test(e),
    ),
  );

  const inside = clone(addendum);
  inside.declarationStep.outsideSetupOrder = false;
  assert.ok(
    declarationAddendumErrors(inside, ctx).some((e) =>
      /declarationStep/u.test(e),
    ),
  );

  const asTimeline = clone(addendum);
  asTimeline.declarationStep.setupTimelineStep = true;
  assert.ok(declarationAddendumErrors(asTimeline, ctx).length > 0);

  const badSha = clone(addendum);
  badSha.references.fixtures["G-07"].sha256 = flip(
    badSha.references.fixtures["G-07"].sha256,
  );
  assert.ok(
    declarationAddendumErrors(badSha, ctx).some((e) => /G-07/u.test(e)),
  );

  const missingRun = clone(addendum);
  missingRun.declarations = missingRun.declarations.filter(
    (row) => row.variantId !== "graph-recovered",
  );
  assert.ok(
    declarationAddendumErrors(missingRun, ctx).some((e) =>
      /graph-recovered/u.test(e),
    ),
  );

  const unusable = clone(addendum);
  unusable.declarations.push({
    ...clone(addendum.declarations.at(-1)),
    variantId: "graph-index-unusable",
  });
  assert.ok(declarationAddendumErrors(unusable, ctx).length > 0);

  const anchor = clone(addendum);
  anchor.declarationStep.after = "pins";
  assert.ok(declarationAddendumErrors(anchor, ctx).length > 0);

  const recovered = clone(addendum);
  recovered.graphRecovered.noDeclarationWriteBetweenMutationAndMeasurementPoint = false;
  assert.ok(declarationAddendumErrors(recovered, ctx).length > 0);

  const negatives = clone(addendum);
  negatives.diagnosticNegatives = negatives.diagnosticNegatives.filter(
    (row) => row.caseId !== "G-07",
  );
  assert.ok(
    declarationAddendumErrors(negatives, ctx).some((e) =>
      /diagnosticNegatives/u.test(e),
    ),
  );
});

test("DR-CP4-G4-7: K24_TABLE has the six rows, G-04 base the widened fifth Scene derived from fixture v2", async () => {
  assert.deepEqual(
    K24_TABLE.map((row) => [
      `${row.caseId}/${row.variantId}`,
      row.sceneId,
      row.scene,
      row.query,
      row.end,
      row.extension,
    ]),
    [
      ["G-01/v1", "g01-mira", 20, 100, 78, false],
      ["G-02/base", "g02-tamsin-first", 30, 100, 78, false],
      ["G-04/base", "g04-lio-landing", 20, 100, 211, true],
      ["G-07/base", "g07-pell-dock", 40, 100, 70, false],
      ["G-08/base-usable", "g08-cass-attic", 20, 100, 64, false],
      ["G-08/graph-recovered", "g08-cass-attic", 20, 100, 64, false],
    ],
  );
  assert.deepEqual(K24_SCOPE_EXTENSION.variants, ["G-04/base"]);
  assert.equal(
    K24_SCOPE_EXTENSION.userConfirmation.commit,
    "a70279156d1ea75332e2b22f9ec479a270869143",
  );
  // The G-04 row is the fixture's, not another row's values.
  const ctx = await context();
  const g04 = ctx.fixtures["G-04"];
  assert.equal(g04.path, "evals/nir1-graph/g04-scope-exact-unknown.v2.json");
  assert.equal(g04.json.fixtureId, "nir1-g04-scope-exact-unknown/2");
  const base = g04.json.variants.find((v) => v.id === "base");
  const row = K24_TABLE.find((r) => r.caseId === "G-04");
  const scene = g04.json.scenes.find((s) => s.id === row.sceneId);
  assert.equal(
    base.expectations.arms.rPlusIrPlusGraph.appendedSceneId,
    row.sceneId,
  );
  assert.equal(scene.readingOrder, row.scene);
  assert.equal(g04.json.query.readingOrder, row.query);
  assert.deepEqual(
    base.expectations.addedScene.sceneExcerpt.canonicalUtf16Range,
    {
      start: 0,
      end: row.end,
    },
  );
  assert.deepEqual(g04.json.foreshadows, []);
  assert.ok(!g04.json.qualifiedIr.some((ir) => ir.sceneId === row.sceneId));
});

test("DR-CP4-G4-7: the declaration addendum v2 references G-04 v2 and freeze.v2, and copies v1's other rows", async () => {
  const ctx = await context();
  const addendum = await json(OBSERVATION_PREP_FILES.declarationAddendum);
  assert.equal(
    OBSERVATION_PREP_FILES.declarationAddendum,
    "evals/nir1-graph/declaration-addendum.v2.json",
  );
  assert.equal(addendum.addendumId, "nir1-graph-declaration-addendum/2");
  // DR-CP4-S4-7 (2b): frozen on the B2a and B2b-1 independent code reviews
  // (contracts 33042487 and 294f708f), never called an expectation review.
  // DR-CP4-S4-7 の追記 2 (D): the K2/4 :418 record is the S4b''' pre-review
  // (contracts e42e9990), bound to review over the frozen bytes ec0f1b85.
  assert.equal(addendum.status, "frozen-after-independent-review");
  assert.equal(addendum.review.reviewedAt, "2026-11-02");
  assert.equal(
    addendum.review.recordSha256,
    "de0ccae2290bea5be4cab09ab763925f7e0fa32121b028480f3395cc05721176",
  );
  for (const word of [
    "g04-v2c-s4pre-review-2026-11-02/review-s4pre.md",
    "e42e99900f80a3e10f58702f6eaa884e3e478649",
    "K2/4 :418 の独立 reviewer の確認の記録",
    "330424871a8594a493d0cb0d8ee6028f89bdcf03",
    "294f708fc2e02ebbe10257533193de711a1f5bed",
  ])
    assert.ok(addendum.review.record.includes(word), word);
  for (const word of [
    "ec0f1b858efde5c45b0e50a5dd040d2d2c375cfafbcefc09aa956e345c99f7a5",
    ":418 の reviewer の確認の 3 点",
    "早すぎた",
    "c3207d69",
    "8d6e967e18b299e7c4e8dfb4f0653cab13d7fd2caf154ce0033532441f1c2a4f",
    "K2/4 :418 の独立 reviewer の記録はまだ無い",
    "独立期待値レビューでもない",
    "上に書いた凍結の前の sha256",
  ])
    assert.ok(addendum.review.conditions.includes(word), word);
  assert.deepEqual(Object.keys(addendum.references.fixtures), [
    "G-02",
    "G-04",
    "G-07",
    "G-08",
  ]);
  assert.deepEqual(addendum.references.fixtures["G-04"], {
    path: "evals/nir1-graph/g04-scope-exact-unknown.v2.json",
    fixtureId: "nir1-g04-scope-exact-unknown/2",
    sha256: "96d44ec362f30352d6cb971c208f2ab71aed944d008cab9eb65ca2ab57c218e1",
  });
  assert.equal(
    addendum.references.graphCaseFreeze.path,
    "evals/nir1-graph/freeze.v2.json",
  );
  assert.equal(addendum.references.graphCaseFreeze.sha256, ctx.freeze.sha256);
  assert.ok(
    !addendum.variantsWithoutDeclaration.variants.includes("G-04/base"),
  );
  assert.deepEqual(
    addendum.diagnosticNegatives.map((row) => row.id),
    ["K24-G02-N1", "K24-G04-N1", "K24-G07-N1", "K24-G08-N1"],
  );
  // v1 is kept byte for byte.
  assert.equal(
    sha256(await readFile(path.join(repoRoot, DECLARATION_ADDENDUM_V1.path))),
    DECLARATION_ADDENDUM_V1.sha256,
  );
  const v1 = await json(DECLARATION_ADDENDUM_V1.path);
  assert.deepEqual(
    addendum.declarations.filter((row) => row.caseId !== "G-04"),
    v1.declarations,
  );

  const errorsOf = (mutate) => {
    const copy = clone(addendum);
    mutate(copy);
    return declarationAddendumErrors(copy, ctx);
  };
  const refused = (mutate, pattern) =>
    assert.ok(
      errorsOf(mutate).some((e) => pattern.test(e)),
      String(pattern),
    );
  refused((a) => delete a.references.fixtures["G-04"], /G-04/u);
  refused(
    (a) =>
      (a.references.graphCaseFreeze.path = "evals/nir1-graph/freeze.v1.json"),
    /graphCaseFreeze/u,
  );
  refused(
    (a) => (a.declarations = a.declarations.filter((r) => r.caseId !== "G-04")),
    /G-04\/base/u,
  );
  refused(
    (a) =>
      (a.declarations.find((r) => r.caseId === "G-04").expectedExcerpt.end =
        210),
    /G-04\/base expected excerpt/u,
  );
  refused(
    (a) =>
      (a.declarations.find((r) => r.caseId === "G-04").readingOrder.scene = 30),
    /G-04\/base readingOrder/u,
  );
  refused(
    (a) => a.variantsWithoutDeclaration.variants.splice(2, 0, "G-04/base"),
    /variantsWithoutDeclaration/u,
  );
  refused(
    (a) =>
      (a.diagnosticNegatives = a.diagnosticNegatives.filter(
        (r) => r.id !== "K24-G04-N1",
      )),
    /diagnosticNegatives/u,
  );
  // Written after the observation: the flag, the rows and the v1 copy.
  refused(
    (a) => (a.graphRuntimeObservedBeforeAuthoring = false),
    /graphRuntimeObservedBeforeAuthoring must be true/u,
  );
  refused(
    (a) => (a.postObservationDeclarations.variants = []),
    /postObservationDeclarations/u,
  );
  refused((a) => delete a.supersedes, /supersedes/u);
  refused(
    (a) => (a.supersedes.sha256 = flip(a.supersedes.sha256)),
    /supersedes/u,
  );
  refused(
    (a) => (a.declarations.find((r) => r.caseId === "G-07").vetoNote = "x"),
    /v1 addendum's rows unchanged/u,
  );
  refused(
    (a) =>
      (a.diagnosticNegatives.find((r) => r.caseId === "G-02").expectation =
        "x"),
    /v1 addendum's unchanged/u,
  );
  // The widened K2/4 scope names the user's confirmation.
  refused(
    (a) => (a.contractScopeExtension.userConfirmation.commit = "a7027915"),
    /contractScopeExtension/u,
  );
  refused((a) => delete a.contractScopeExtension, /contractScopeExtension/u);
  // The v1 shape (no G-04 row) stays false and needs no v1 copy.
  const v1Errors = declarationAddendumErrors(v1, ctx);
  assert.ok(
    !v1Errors.some((e) => /graphRuntimeObservedBeforeAuthoring/u.test(e)),
  );
  assert.ok(
    v1Errors.some((e) => /declarations is missing G-04\/base/u.test(e)),
  );
});

test("veto: a secret foreshadow that refers to the declared Scene is refused", async () => {
  const ctx = await context();
  const addendum = await json(OBSERVATION_PREP_FILES.declarationAddendum);
  const g07 = clone(ctx.fixtures["G-07"].json);
  g07.foreshadows[0].payoffSceneId = "g07-pell-dock";
  const vetoed = {
    ...ctx,
    fixtures: {
      ...ctx.fixtures,
      "G-07": { ...ctx.fixtures["G-07"], json: g07 },
    },
  };
  assert.ok(
    declarationAddendumErrors(addendum, vetoed).some((e) => /veto/u.test(e)),
  );
  const g02 = clone(ctx.fixtures["G-02"].json);
  g02.scenes.find((scene) => scene.id === "g02-tamsin-first").pov = "g02-orla";
  const pov = {
    ...ctx,
    fixtures: {
      ...ctx.fixtures,
      "G-02": { ...ctx.fixtures["G-02"], json: g02 },
    },
  };
  assert.ok(
    declarationAddendumErrors(addendum, pov).some((e) => /veto/u.test(e)),
  );
});

for (const kind of ["editing", "browsing"]) {
  test(`trace ${kind}: Q, density, materials and product triggers`, async () => {
    const ctx = await context();
    const file =
      kind === "editing"
        ? OBSERVATION_PREP_FILES.traceEditing
        : OBSERVATION_PREP_FILES.traceBrowsing;
    const trace = await json(file);
    assert.deepEqual(traceErrors(trace, ctx), []);
    const counted = trace.operations.filter((op) => op.query?.counted);
    assert.ok(counted.length >= 200);
    assert.equal(counted.length, trace.plannedQ);

    // Q を 199 にする（台本を 1 回分削り、plannedQ も合わせる）。
    const short = clone(trace);
    const cycleLength = kind === "editing" ? 3 : 2;
    while (short.operations.filter((op) => op.query?.counted).length > 199) {
      short.cycles -= 1;
      short.plannedQ -= 1;
      short.operations = short.operations.slice(0, -cycleLength);
    }
    assert.equal(
      short.operations.filter((op) => op.query?.counted).length,
      199,
    );
    assert.ok(traceErrors(short, ctx).some((e) => /200/u.test(e)));

    // 承認の操作を入れる。
    const approval = clone(trace);
    approval.operations.splice(4, 0, {
      seq: 4,
      op: "approval",
      revisionId: "g02-r-tamsin",
    });
    assert.ok(traceErrors(approval, ctx).some((e) => /approval/u.test(e)));

    // 期待寄与の材料を外す。
    const noMaterial = clone(trace);
    noMaterial.operations.find(
      (op) => op.query?.counted,
    ).query.expectedMaterials = [];
    assert.ok(traceErrors(noMaterial, ctx).length > 0);

    // 寄与しない材料（逆向きの edge だけの Revision）を足す。
    const rook = clone(trace);
    rook.expectedMaterials.push({
      revisionId: "g02-r-rook",
      edgeIds: ["g02-trained-orla"],
    });
    assert.ok(traceErrors(rook, ctx).some((e) => /g02-r-rook/u.test(e)));

    // 製品の契機の値を変える。
    const debounce = clone(trace);
    debounce.productTriggers.fetchDebounceMs.value = 300;
    assert.ok(
      traceErrors(debounce, ctx).some((e) => /fetchDebounceMs/u.test(e)),
    );

    // fixture の sha を 1 文字変える。
    const sha = clone(trace);
    sha.project.fixtureSha256 = flip(sha.project.fixtureSha256);
    assert.ok(traceErrors(sha, ctx).some((e) => /fixtureSha256/u.test(e)));
  });
}

test("editing trace: every query after the first follows an edit and its autosave commit, nothing between commit and query", async () => {
  const ctx = await context();
  const trace = await json(OBSERVATION_PREP_FILES.traceEditing);

  const noCommit = clone(trace);
  const at = noCommit.operations.findIndex(
    (op) => op.op === "confirm-autosave-commit",
  );
  noCommit.operations.splice(at, 1);
  assert.ok(
    traceErrors(noCommit, ctx).some((e) => /density|template/u.test(e)),
  );

  const wait = clone(trace);
  const commit = wait.operations.findIndex(
    (op) => op.op === "confirm-autosave-commit",
  );
  wait.operations.splice(commit + 1, 0, {
    seq: commit + 1,
    op: "harness-wait",
    ms: 500,
  });
  assert.ok(
    traceErrors(wait, ctx).some((e) => /harness-wait|density/u.test(e)),
  );

  const direct = clone(trace);
  direct.operations.find((op) => op.op === "edit").via = "direct-write";
  assert.ok(
    traceErrors(direct, ctx).some((e) => /product-editor|template/u.test(e)),
  );
});

test("browsing trace: no edit, no save", async () => {
  const ctx = await context();
  const trace = await json(OBSERVATION_PREP_FILES.traceBrowsing);
  const edited = clone(trace);
  edited.operations.splice(2, 0, {
    seq: 2,
    op: "edit",
    via: "product-editor",
    sceneId: "g02-query",
    action: "append-suffix",
  });
  assert.ok(traceErrors(edited, ctx).some((e) => /edit/u.test(e)));
});

test("K6/4 procedure draft: contract values, wait bound, the F/X lists and no review", async () => {
  const procedure = await json(OBSERVATION_PREP_FILES.procedureDraft);
  assert.deepEqual(procedureDraftErrors(procedure), []);
  assert.equal(procedure.values.r1r4WaitMs <= 10_000, true);

  const over = clone(procedure);
  over.values.r1r4WaitMs = 10_001;
  assert.ok(procedureDraftErrors(over).some((e) => /r1r4WaitMs/u.test(e)));

  for (const [key, value] of [
    ["dMs", 21.68],
    ["wFMs", 99],
    ["tLateMs", 2000],
    ["tShowMs", 1999],
  ]) {
    const changed = clone(procedure);
    changed.values[key] = value;
    assert.ok(
      procedureDraftErrors(changed).some((e) => e.includes(key)),
      key,
    );
  }

  const order = clone(procedure);
  order.conditions.exclusions = [...order.conditions.exclusions].reverse();
  assert.ok(procedureDraftErrors(order).length > 0);

  const reviewed = clone(procedure);
  reviewed.review = { reviewer: "x", reviewedAt: "2026-10-27", record: "y" };
  assert.ok(procedureDraftErrors(reviewed).some((e) => /review/u.test(e)));

  const formal = clone(procedure);
  formal.version = "v1";
  formal.draft = false;
  assert.ok(procedureDraftErrors(formal).length > 0);

  const extra = clone(procedure);
  extra.values.rationale = "x";
  assert.ok(procedureDraftErrors(extra).length > 0);

  const sha = clone(procedure);
  sha.contract.sha256 = flip(sha.contract.sha256);
  assert.ok(procedureDraftErrors(sha).some((e) => /sha256/u.test(e)));
});

test("observation prep: D1, D10, sample plan, traces, procedure, diagnostics, placeholders", async () => {
  const ctx = await context();
  const prep = await draftPrep();
  assert.deepEqual(observationPrepErrors(prep, ctx), []);

  const graphMode = clone(prep);
  graphMode.d10.arms.graph = "unrestricted";
  assert.ok(observationPrepErrors(graphMode, ctx).some((e) => /d10/u.test(e)));

  const parity = clone(prep);
  parity.d10.parity.unrestrictedRunsPerVariant = 0;
  assert.ok(observationPrepErrors(parity, ctx).some((e) => /parity/u.test(e)));

  const parityVariants = clone(prep);
  parityVariants.d10.parity.variants.pop();
  assert.ok(
    observationPrepErrors(parityVariants, ctx).some((e) => /parity/u.test(e)),
  );

  const samples = clone(prep);
  samples.samplePlan.measuredPerArm = 29;
  assert.ok(
    observationPrepErrors(samples, ctx).some((e) => /samplePlan/u.test(e)),
  );

  const d1 = clone(prep);
  d1.d1.choice = "i";
  assert.ok(observationPrepErrors(d1, ctx).some((e) => /d1/u.test(e)));

  const traceSha = clone(prep);
  traceSha.traces[0].sha256 = "0".repeat(64);
  assert.ok(observationPrepErrors(traceSha, ctx).some((e) => /trace/u.test(e)));

  const badPlaceholder = clone(prep);
  badPlaceholder.traces[0].commit = "S4:Not Valid";
  assert.ok(observationPrepErrors(badPlaceholder, ctx).length > 0);

  const undocumented = clone(prep);
  undocumented.placeholders = undocumented.placeholders.slice(1);
  assert.ok(
    observationPrepErrors(undocumented, ctx).some((e) =>
      /placeholder/u.test(e),
    ),
  );

  const frozenWithPlaceholder = clone(prep);
  frozenWithPlaceholder.status = "frozen-before-observation";
  assert.ok(
    observationPrepErrors(frozenWithPlaceholder, ctx).some((e) =>
      /placeholder/u.test(e),
    ),
  );

  const negatives = clone(prep);
  negatives.diagnosticRuns = negatives.diagnosticRuns.filter(
    (row) => row.id !== "K62-iii",
  );
  assert.ok(
    observationPrepErrors(negatives, ctx).some((e) =>
      /diagnosticRuns/u.test(e),
    ),
  );

  const wait = clone(prep);
  wait.k64Procedure.values.r1r4WaitMs = 5_000;
  assert.ok(
    observationPrepErrors(wait, ctx).some((e) => /k64Procedure/u.test(e)),
  );
});

/** A frozen record as S4 would fill it, and a context that has the v1 file. */
async function frozenRecord(ctx, { record = "docs/plans/x.md" } = {}) {
  const prep = await draftPrep();
  const filled = clone(prep);
  const hex40 = "a".repeat(40);
  const shaOf = (relative) => ctx.fileSha256[relative];
  for (const entry of filled.boundFiles) {
    entry.commit = hex40;
    entry.sha256 = shaOf(entry.path);
  }
  for (const trace of filled.traces) {
    trace.commit = hex40;
    trace.sha256 = shaOf(trace.path);
  }
  const review = {
    reviewer: "independent",
    reviewedAt: "2026-10-28",
    record: "scratchpad/s3/observation-prep-review.v1.json",
  };
  const v1 = {
    ...clone(ctx.procedureDraft),
    version: "v1",
    draft: false,
    review,
  };
  filled.k64Procedure.formal.commit = hex40;
  filled.k64Procedure.formal.sha256 = "b".repeat(64);
  filled.k64Procedure.formal.review = review;
  // S4 の最終関門の P3-3: the pinned harness's K64_FREEZE.freezeCommit.
  filled.contracts.k64.freezeCommit = ctx.harnessK64Freeze.commit;
  filled.d10.g01.da1AcceptanceRecord = record;
  filled.d10.g01.rAndRirMode =
    record === "none" ? "unrestricted" : "restricted";
  filled.contracts.sp1.bytesCommit = hex40;
  filled.r5Gate.syntheticDetection.record = "docs/plans/sp-synthetic.md";
  filled.r5Gate.r5CheckRecord = "docs/plans/r5-check.md";
  filled.review = { ...review, recordSha256: "c".repeat(64) };
  // S2 追補: S3 decides each reviewer question before S4b.
  for (const question of filled.reviewerQuestions ?? [])
    question.decision = {
      choice: question.options[0].id,
      by: "S3",
      record: review.record,
    };
  filled.status = "frozen-before-observation";
  filled.placeholders = [];
  const frozenCtx = {
    ...ctx,
    fileSha256: {
      ...ctx.fileSha256,
      [filled.k64Procedure.formal.path]: "b".repeat(64),
    },
    procedureFormal: v1,
    sp1Sha256: SP1.sha256,
  };
  return { fixed: filled, frozenCtx };
}

test("S4 の最終関門の P3-3: contracts.k64.freezeCommit is the pinned constants.mjs K64_FREEZE.freezeCommit", async () => {
  const ctx = await context();
  // Read from the t14-k64-freeze pin's bytes, the K6/4 freeze (批准 7).
  assert.equal(
    ctx.harnessK64Freeze?.commit,
    "5dea38af158283c2a925d68ef0d8b0771c0ea209",
  );
  assert.equal(ctx.harnessK64Freeze.source.path, K64_FREEZE_SOURCE.path);
  const { fixed, frozenCtx } = await frozenRecord(ctx);
  assert.deepEqual(observationPrepErrors(fixed, frozenCtx), []);
  const check = (copy) => observationPrepErrors(copy, frozenCtx);
  // Another 40-hex commit is refused (the form alone does not pass).
  detects(
    fixed,
    check,
    (p) => (p.contracts.k64.freezeCommit = "a".repeat(40)),
    /contracts\.k64\.freezeCommit must be the pinned harness's K64_FREEZE/u,
  );
  // The confirmed commit of K6/4 is not its freeze commit.
  detects(
    fixed,
    check,
    (p) =>
      (p.contracts.k64.freezeCommit =
        "18ebc7b8de2d4f2701c573b5d91561a6cc852024"),
    /K64_FREEZE/u,
  );
  // Unreadable pinned bytes close the check.
  assert.ok(
    observationPrepErrors(fixed, {
      ...frozenCtx,
      harnessK64Freeze: null,
    }).some((e) => /K64_FREEZE.*unreadable/u.test(e)),
  );
  // The constants.mjs pin must hold the bytes the value was read from.
  assert.ok(
    observationPrepErrors(fixed, {
      ...frozenCtx,
      harnessK64Freeze: {
        ...frozenCtx.harnessK64Freeze,
        source: {
          ...frozenCtx.harnessK64Freeze.source,
          sha256: "d".repeat(64),
        },
      },
    }).some((e) => /constants\.mjs must be the bytes/u.test(e)),
  );
  // A draft keeps the placeholder: not compared.
  const draft = await draftPrep();
  assert.ok(PLACEHOLDER.test(draft.contracts.k64.freezeCommit));
  assert.deepEqual(
    observationPrepErrors(draft, { ...ctx, harnessK64Freeze: null }).filter(
      (e) => /K64_FREEZE/u.test(e),
    ),
    [],
  );
});

test("S4 の最終関門の P3-3: parseK64FreezeCommit reads the field once from the K64_FREEZE literal only", () => {
  const commit = "5dea38af158283c2a925d68ef0d8b0771c0ea209";
  const field = `  freezeCommit: "${commit}",`;
  const text = [
    "export const K64_FREEZE = Object.freeze({",
    '  path: "docs/plans/x.md",',
    '  confirmedCommit: "18ebc7b8de2d4f2701c573b5d91561a6cc852024",',
    field,
    "});",
  ].join("\n");
  assert.equal(parseK64FreezeCommit(text), commit);
  // Absent, twice, short, another constant, or only outside the literal.
  for (const changed of [
    text.replace("freezeCommit", "freeze"),
    text.replace(field, `${field}\n${field}`),
    text.replace(commit, commit.slice(1)),
    text.replace("K64_FREEZE", "K62_FREEZE"),
    `export const K62_FREEZE = Object.freeze({\n${field}\n});\n${text.replace(`${field}\n`, "")}`,
  ])
    assert.equal(parseK64FreezeCommit(changed), undefined, changed);
});

test("observation prep frozen: every placeholder filled, commits 40-hex, digests match the files", async () => {
  const ctx = await context();
  const { fixed, frozenCtx } = await frozenRecord(ctx);
  assert.deepEqual(observationPrepErrors(fixed, frozenCtx), []);
  // v1 の file が無い（S4 が置いていない）なら frozen にできない。
  assert.ok(
    observationPrepErrors(fixed, ctx).some((e) =>
      /k64Procedure\.formal/u.test(e),
    ),
  );

  const wrong = clone(fixed);
  wrong.traces[1].sha256 = flip(wrong.traces[1].sha256);
  assert.ok(
    observationPrepErrors(wrong, frozenCtx).some((e) => /trace/u.test(e)),
  );

  const shortCommit = clone(fixed);
  shortCommit.candidate.commit = "abc";
  assert.ok(
    observationPrepErrors(shortCommit, frozenCtx).some((e) =>
      /candidate/u.test(e),
    ),
  );

  const noReview = clone(fixed);
  noReview.review = null;
  assert.ok(
    observationPrepErrors(noReview, frozenCtx).some((e) => /review/u.test(e)),
  );
});

test("S3-P2-2: boundFiles is exactly the five files, and traces agree with it", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const noAuthor = clone(prep);
  noAuthor.boundFiles = noAuthor.boundFiles.filter(
    (row) => row.path !== OBSERVATION_PREP_FILES.authorDeclaration,
  );
  assert.ok(
    observationPrepErrors(noAuthor, ctx).some((e) => /boundFiles/u.test(e)),
  );
  const empty = clone(prep);
  empty.boundFiles = [];
  assert.ok(
    observationPrepErrors(empty, ctx).some((e) => /boundFiles/u.test(e)),
  );

  const { fixed, frozenCtx } = await frozenRecord(ctx);
  const split = clone(fixed);
  split.traces[0].commit = "d".repeat(40);
  assert.ok(
    observationPrepErrors(split, frozenCtx).some((e) => /boundFiles/u.test(e)),
  );
});

test("S3-P2-3: the frozen v1 procedure must be the reviewed draft-2 values", async () => {
  const ctx = await context();
  const { fixed, frozenCtx } = await frozenRecord(ctx);
  const shorter = {
    ...frozenCtx,
    procedureFormal: {
      ...frozenCtx.procedureFormal,
      values: { ...frozenCtx.procedureFormal.values, r1r4WaitMs: 3_000 },
    },
  };
  assert.ok(
    observationPrepErrors(fixed, shorter).some((e) =>
      /k64Procedure\.formal/u.test(e),
    ),
  );
  const stillDraft = {
    ...frozenCtx,
    procedureFormal: { ...frozenCtx.procedureFormal, draft: true },
  };
  assert.ok(observationPrepErrors(fixed, stillDraft).length > 0);
  const otherReview = clone(fixed);
  otherReview.k64Procedure.formal.review = {
    ...otherReview.k64Procedure.formal.review,
    record: "docs/another.md",
  };
  assert.ok(
    observationPrepErrors(otherReview, frozenCtx).some((e) =>
      /k64Procedure\.formal\.review/u.test(e),
    ),
  );
});

test("S3-P2-4: the G-01 R and R+IR mode follows the DA-1 record", async () => {
  const ctx = await context();
  const prep = await draftPrep();
  assert.ok(PLACEHOLDER.test(prep.d10.g01.rAndRirMode));
  const fixedDraft = clone(prep);
  fixedDraft.d10.g01.rAndRirMode = "restricted";
  assert.ok(
    observationPrepErrors(fixedDraft, ctx).some((e) => /rAndRirMode/u.test(e)),
  );

  const none = await frozenRecord(ctx, { record: "none" });
  assert.deepEqual(observationPrepErrors(none.fixed, none.frozenCtx), []);
  const contradiction = clone(none.fixed);
  contradiction.d10.g01.rAndRirMode = "restricted";
  assert.ok(
    observationPrepErrors(contradiction, none.frozenCtx).some((e) =>
      /rAndRirMode/u.test(e),
    ),
  );
  const path_ = await frozenRecord(ctx);
  const unrestricted = clone(path_.fixed);
  unrestricted.d10.g01.rAndRirMode = "unrestricted";
  assert.ok(
    observationPrepErrors(unrestricted, path_.frozenCtx).some((e) =>
      /rAndRirMode/u.test(e),
    ),
  );
});

test("S3-P1-1: R5 gates every Graph arm run and the K6/4 freeze", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  for (const run of [
    "g-case-gold",
    "g-case-diagnostic-negative",
    "v10-ready-probe",
    "k62-ii-diagnostic",
    "k62-iii-diagnostic",
    "trace",
    "k64-freeze-commit",
  ]) {
    const open = clone(prep);
    open.r5Gate.blockedUntilMatch = open.r5Gate.blockedUntilMatch.filter(
      (row) => row !== run,
    );
    assert.ok(
      observationPrepErrors(open, ctx).some((e) => /r5Gate/u.test(e)),
      run,
    );
  }
  const exempt = clone(prep);
  exempt.r5Gate.exempt.push({ run: "g-case-gold", reason: "x" });
  assert.ok(observationPrepErrors(exempt, ctx).some((e) => /r5Gate/u.test(e)));
  const order = clone(prep);
  order.r5Gate.k64FreezeAfterMatch = false;
  assert.ok(observationPrepErrors(order, ctx).some((e) => /r5Gate/u.test(e)));
  const revision = clone(prep);
  delete revision.r5Gate.onFixtureRevision;
  assert.ok(
    observationPrepErrors(revision, ctx).some((e) => /r5Gate/u.test(e)),
  );
  const missing = clone(prep);
  delete missing.r5Gate;
  assert.ok(observationPrepErrors(missing, ctx).some((e) => /r5Gate/u.test(e)));
});

test("S3-P3-1: diagnostic runs match their addendum rows including the mutation", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const mutated = clone(prep);
  mutated.diagnosticRuns.find(
    (row) => row.id === "K24-G01-N2",
  ).mutationAfterDeclaration = "restore-same-bytes-body-version";
  assert.ok(
    observationPrepErrors(mutated, ctx).some((e) => /K24-G01-N2/u.test(e)),
  );
});

test("S3-P3-2: G-01 negatives include a different-bytes restore and their procedure", async () => {
  const ctx = await context();
  const addendum = await json(OBSERVATION_PREP_FILES.setupAddendum);
  assert.deepEqual(
    addendum.diagnosticNegatives.map((row) => row.id),
    ["K24-G01-N1", "K24-G01-N2", "K24-G01-N3", "K24-G01-N4"],
  );
  const noPrep = clone(addendum);
  delete noPrep.diagnosticNegatives[3].beforeDeclaration;
  assert.ok(
    setupAddendumErrors(noPrep, ctx).some((e) => /beforeDeclaration/u.test(e)),
  );
  const noSeam = clone(addendum);
  delete noSeam.diagnosticNegatives[1].measurementProcess;
  assert.ok(
    setupAddendumErrors(noSeam, ctx).some((e) => /measurementProcess/u.test(e)),
  );
});

test("S3-P2-1 / P3-3: the browsing stay ends on a product event; stall attempts are bounded", async () => {
  const ctx = await context();
  for (const file of [
    OBSERVATION_PREP_FILES.traceEditing,
    OBSERVATION_PREP_FILES.traceBrowsing,
  ]) {
    const trace = await json(file);
    const stall = clone(trace);
    stall.stall.attemptLimit = 5;
    assert.ok(
      traceErrors(stall, ctx).some((e) => /stall/u.test(e)),
      file,
    );
  }
  const trace = await json(OBSERVATION_PREP_FILES.traceBrowsing);
  const harbor = trace.operations.find((op) => op.sceneId === "g02-harbor");
  assert.equal(harbor.until, "query-published");
  const free = clone(trace);
  delete free.operations.find((op) => op.sceneId === "g02-harbor").until;
  assert.ok(traceErrors(free, ctx).some((e) => /template/u.test(e)));
  const timed = clone(trace);
  timed.operations.find((op) => op.sceneId === "g02-harbor").until = "ms:500";
  assert.ok(traceErrors(timed, ctx).some((e) => /template/u.test(e)));
});

test("S3-P3-4 / P3-5: tolerance usages registered; R comes from the hybrid arm's Raw", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const fewer = clone(prep);
  fewer.registeredForReview[0].usages.pop();
  assert.ok(
    observationPrepErrors(fewer, ctx).some((e) =>
      /registeredForReview/u.test(e),
    ),
  );
  const raw = clone(prep);
  raw.d10.arms.raw = "unrestricted";
  assert.ok(
    observationPrepErrors(raw, ctx).some((e) => /d10\.arms\.raw/u.test(e)),
  );
  const source = clone(prep);
  delete source.samplePlan.rFrom;
  assert.ok(
    observationPrepErrors(source, ctx).some((e) => /samplePlan/u.test(e)),
  );
});

test("author declaration: no Graph output observed, read files with digests", async () => {
  const declaration = await json(OBSERVATION_PREP_FILES.authorDeclaration);
  assert.deepEqual(authorDeclarationErrors(declaration), []);
  const observed = clone(declaration);
  observed.graphRuntimeOutputObserved = true;
  assert.ok(authorDeclarationErrors(observed).length > 0);
  const badSha = clone(declaration);
  badSha.readFiles[0].sha256 = "xyz";
  assert.ok(authorDeclarationErrors(badSha).length > 0);
  const forbidden = clone(declaration);
  forbidden.readFiles.push({
    path: "docs/plans/nir1-lane-decisions/cp4-decisions.md",
    sha256: "0".repeat(64),
  });
  assert.ok(
    authorDeclarationErrors(forbidden).some((e) => /forbidden/u.test(e)),
  );
});

test("the placeholder form is S4:<name> and nothing else", () => {
  assert.ok(PLACEHOLDER.test("S4:trace-editing-commit"));
  assert.ok(!PLACEHOLDER.test("S4:"));
  assert.ok(!PLACEHOLDER.test("s4:trace"));
  assert.ok(!PLACEHOLDER.test("S4:Trace Commit"));
});

test("the frozen files the record must not change keep their freeze digests", async () => {
  // The current freeze (B2a review P3-2): freeze.v2.json since G-04 v2.
  assert.equal(NIR1_GRAPH_FREEZE_PATH, "evals/nir1-graph/freeze.v2.json");
  const freeze = await json(NIR1_GRAPH_FREEZE_PATH);
  for (const entry of freeze.cases) {
    const bytes = await readFile(path.join(repoRoot, entry.path));
    assert.equal(sha256(bytes), entry.sha256, entry.path);
  }
});

test("SP/1: the record binds the seed pin addendum, gates R5 on it and plans SP-P4", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.ok(
    prep.boundFiles.some(
      (row) => row.path === OBSERVATION_PREP_FILES.seedPinAddendum,
    ),
  );
  const noSp1 = clone(prep);
  delete noSp1.contracts.sp1;
  assert.ok(observationPrepErrors(noSp1, ctx).some((e) => /sp1/u.test(e)));

  const unbound = clone(prep);
  unbound.boundFiles = unbound.boundFiles.filter(
    (row) => row.path !== OBSERVATION_PREP_FILES.seedPinAddendum,
  );
  assert.ok(
    observationPrepErrors(unbound, ctx).some((e) => /boundFiles/u.test(e)),
  );

  const noStep = clone(prep);
  noStep.r5Gate.matchRequires = noStep.r5Gate.matchRequires.filter(
    (row) => row !== "seed-pin-step-executed-workspace",
  );
  assert.ok(observationPrepErrors(noStep, ctx).some((e) => /r5Gate/u.test(e)));

  const noP4 = clone(prep);
  noP4.diagnosticRuns = noP4.diagnosticRuns.filter((row) => row.id !== "SP-P4");
  assert.ok(
    observationPrepErrors(noP4, ctx).some((e) =>
      /diagnosticRuns|SP-P4/u.test(e),
    ),
  );

  const graphP4 = clone(prep);
  graphP4.diagnosticRuns.find((row) => row.id === "SP-P4").arms = [
    "hybrid",
    "graph",
  ];
  assert.ok(observationPrepErrors(graphP4, ctx).some((e) => /SP-P4/u.test(e)));

  const fewer = clone(prep);
  fewer.diagnosticRuns.find((row) => row.id === "SP-P4").variants.pop();
  assert.ok(observationPrepErrors(fewer, ctx).some((e) => /SP-P4/u.test(e)));

  const notExempt = clone(prep);
  notExempt.r5Gate.exempt = notExempt.r5Gate.exempt.filter(
    (row) => row.run !== "sp-p4-seed-pin-parity",
  );
  assert.ok(
    observationPrepErrors(notExempt, ctx).some((e) => /r5Gate/u.test(e)),
  );

  const order = clone(prep);
  order.stepOrder.graphCases = [...order.stepOrder.graphCases].reverse();
  assert.ok(
    observationPrepErrors(order, ctx).some((e) => /stepOrder/u.test(e)),
  );
});

test("SP/1: addenda and traces point at the seed pin step", async () => {
  const ctx = await context();
  for (const [file, check] of [
    [OBSERVATION_PREP_FILES.setupAddendum, setupAddendumErrors],
    [OBSERVATION_PREP_FILES.declarationAddendum, declarationAddendumErrors],
  ]) {
    const addendum = await json(file);
    const stale = clone(addendum);
    stale.seedPinStepNote = "pending";
    assert.ok(
      check(stale, ctx).some((e) => /seedPinStepNote/u.test(e)),
      file,
    );
  }
  for (const file of [
    OBSERVATION_PREP_FILES.traceEditing,
    OBSERVATION_PREP_FILES.traceBrowsing,
  ]) {
    const trace = await json(file);
    const stale = clone(trace);
    stale.project.seedPinAddendum = null;
    assert.ok(
      traceErrors(stale, ctx).some((e) => /seedPinAddendum/u.test(e)),
      file,
    );
  }
});

test("DR-CP4-G4-7 B2b-1: the G-01 setup addendum v2 is v1 with the references only changed, and supersedes v1's unchanged bytes", async () => {
  const ctx = await context();
  assert.equal(
    OBSERVATION_PREP_FILES.setupAddendum,
    "evals/nir1-g01/setup-addendum.v2.json",
  );
  const v1Bytes = await readFile(path.join(repoRoot, SETUP_ADDENDUM_V1.path));
  assert.equal(sha256(v1Bytes), SETUP_ADDENDUM_V1.sha256);
  const v1 = JSON.parse(v1Bytes);
  const v2 = await json(OBSERVATION_PREP_FILES.setupAddendum);
  assert.deepEqual(setupAddendumErrors(v2, ctx), []);
  assert.equal(v2.addendumId, "nir1-g01-setup-addendum/2");
  // DR-CP4-S4-7 (2b): frozen on the B2b-1 independent code review (contracts
  // 294f708f); the reviewer saw 9dbc5d6c, the fix (flag, note) came after.
  assert.equal(v2.status, "frozen-after-independent-review");
  assert.equal(
    v2.review.recordSha256,
    "ff4f43753bb29e013d93698b19e14abc533207d44caa30be5d864d8e12ddf403",
  );
  assert.ok(
    v2.review.record.includes("294f708fc2e02ebbe10257533193de711a1f5bed"),
  );
  for (const word of [
    "9dbc5d6c343c878db4eabb9c348dbafe34f01c7840ace14033c309682605c03b",
    "18964170a5ecadfa2c87cb61170fb42412a404208deb6c77675f72e36aae7224",
    "直した後の bytes を reviewer が見直した記録は無い",
    "独立期待値レビューでもない",
  ])
    assert.ok(v2.review.conditions.includes(word), word);
  // Written after a Graph runtime observation (B2b-1 review P2-1).
  assert.equal(v2.graphRuntimeObservedBeforeAuthoring, true);
  assert.deepEqual(
    {
      path: v2.supersedes.path,
      sha256: v2.supersedes.sha256,
      commit: v2.supersedes.commit,
    },
    {
      path: SETUP_ADDENDUM_V1.path,
      sha256: SETUP_ADDENDUM_V1.sha256,
      commit: "cf1c83e3c4d491032511cb6f11fecb5699bc3ed5",
    },
  );
  assert.deepEqual(
    {
      path: v2.references.graphCaseFreeze.path,
      sha256: v2.references.graphCaseFreeze.sha256,
    },
    { path: NIR1_GRAPH_FREEZE_PATH, sha256: ctx.freeze.sha256 },
  );
  assert.ok(
    v2.references.graphCaseFreeze.note.startsWith(
      v1.references.graphCaseFreeze.note,
    ),
  );
  // Every other field is v1's, the new versions' paths and the declared
  // Scene count (K2/4 の 5 件目) read back.
  const back = clone(v2);
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
  back.declarationPlace.rule = back.declarationPlace.rule
    .replace(
      "5 つの Scene（G-01 と G-02／G-04／G-07／G-08 の追加 Scene）",
      "4 つの Scene（G-01 と G-02／G-07／G-08 の追加 Scene）",
    )
    .replace(
      OBSERVATION_PREP_FILES.declarationAddendum,
      DECLARATION_ADDENDUM_V1.path,
    );
  back.seedPinStepNote = back.seedPinStepNote.replace(
    SEED_PIN_ADDENDUM_PATH,
    SEED_PIN_ADDENDUM_V1.path,
  );
  const v1Back = clone(v1);
  for (const key of [
    "addendumId",
    "status",
    "review",
    "graphRuntimeObservedBeforeAuthoring",
  ])
    delete v1Back[key];
  assert.deepEqual(back, v1Back);

  // v1 itself is not the current version (freeze.v1.json, no supersedes).
  assert.ok(
    setupAddendumErrors(v1, ctx).some((e) => /graphCaseFreeze/u.test(e)),
  );
  const oldFreeze = clone(v2);
  oldFreeze.references.graphCaseFreeze = v1.references.graphCaseFreeze;
  assert.ok(
    setupAddendumErrors(oldFreeze, ctx).some((e) => /graphCaseFreeze/u.test(e)),
  );
  const oldSeedPin = clone(v2);
  oldSeedPin.seedPinStepNote = v1.seedPinStepNote;
  assert.ok(
    setupAddendumErrors(oldSeedPin, ctx).some((e) =>
      /seedPinStepNote/u.test(e),
    ),
  );
  for (const mutate of [
    (a) => delete a.supersedes,
    (a) => (a.supersedes.sha256 = flip(a.supersedes.sha256)),
    (a) => (a.supersedes.path = SEED_PIN_ADDENDUM_V1.path),
    (a) => (a.supersedes.commit = "cf1c83e3"),
  ]) {
    const mutated = clone(v2);
    mutate(mutated);
    assert.ok(
      setupAddendumErrors(mutated, ctx).some((e) => /supersedes/u.test(e)),
    );
  }
  for (const changed of ["1".repeat(64), null])
    assert.ok(
      setupAddendumErrors(v2, {
        ...ctx,
        supersededSetupAddendum: changed && {
          ...ctx.supersededSetupAddendum,
          sha256: changed,
        },
      }).some((e) => /supersedes/u.test(e)),
    );

  // B2b-1 review P2-1, P3-1, P3-2: the flag true holds only for a copy of v1.
  const copyError = (e) => /references only changed/u.test(e);
  assert.ok(!setupAddendumErrors(v2, ctx).some(copyError));
  for (const mutate of [
    (a) => (a.declarationTiming = `${a.declarationTiming} 追記。`),
    (a) => (a.declarations[0].vetoNote = "観測の後に書き直した。"),
    (a) => (a.afterMutationReadings.retry.gapMs = 300),
    (a) => (a.references.graphCaseFreeze.note = "freeze.v2.json を参照する。"),
    (a) =>
      (a.declarationPlace.rule = a.declarationPlace.rule.replace(
        "5 つの Scene",
        "6 つの Scene",
      )),
    (a) => (a.extra = true),
  ]) {
    const mutated = clone(v2);
    mutate(mutated);
    assert.equal(mutated.graphRuntimeObservedBeforeAuthoring, true);
    assert.ok(setupAddendumErrors(mutated, ctx).some(copyError));
  }
  for (const id of ["nir1-g01-setup-addendum/1", "nir1-g01-setup-addendum/3"]) {
    const mutated = clone(v2);
    mutated.addendumId = id;
    assert.ok(
      setupAddendumErrors(mutated, ctx).some((e) => /addendumId/u.test(e)),
    );
  }
  assert.ok(
    setupAddendumErrors(v2, {
      ...ctx,
      sourcePinGit: { blobSha: () => null },
    }).some((e) => /supersedes\.commit/u.test(e)),
  );
});

test("B2b-1 review P3-2: the formal gate checks each addendum's superseded v1 bytes at its commit (git)", async () => {
  const ctx = await context();
  const rows = supersededReferences(ctx.parsed);
  assert.deepEqual(
    rows.map((row) => [row.path, row.sha256]),
    [
      [SETUP_ADDENDUM_V1.path, SETUP_ADDENDUM_V1.sha256],
      [DECLARATION_ADDENDUM_V1.path, DECLARATION_ADDENDUM_V1.sha256],
      [SEED_PIN_ADDENDUM_V1.path, SEED_PIN_ADDENDUM_V1.sha256],
    ],
  );
  const run = (args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
  const git = {
    blobSha: (commit, file) => {
      try {
        return sha256(run(["show", `${commit}:${file}`]));
      } catch {
        return null;
      }
    },
    isAncestor: (ancestor, descendant) => {
      try {
        run(["merge-base", "--is-ancestor", ancestor, descendant]);
        return true;
      } catch {
        return false;
      }
    },
  };
  const head = run(["rev-parse", "HEAD"]).toString("utf8").trim();
  assert.deepEqual(formalReferenceErrors(rows, head, git), []);
  // The gate's rows include them.
  const gateRows = formalReferenceRows(
    await json(OBSERVATION_PREP_FILES.prep),
    ctx.parsed,
  );
  for (const row of rows)
    assert.ok(
      gateRows.some(
        (entry) =>
          entry.path === row.path &&
          entry.commit === row.commit &&
          entry.sha256 === row.sha256,
      ),
      row.path,
    );
  const wrong = rows.map((row) => ({ ...row, commit: head }));
  assert.equal(formalReferenceErrors(wrong, head, git).length >= 3, true);
});

test("DR-CP4-G4-7 B2b-1 (P2-1 (ii)): a trace names seed-pin addendum v1 with its unchanged bytes or the current version, nothing else", async () => {
  const ctx = await context();
  assert.equal(
    SEED_PIN_ADDENDUM_PATH,
    "evals/nir1-graph/seed-pin-addendum.v2.json",
  );
  for (const file of [
    OBSERVATION_PREP_FILES.traceEditing,
    OBSERVATION_PREP_FILES.traceBrowsing,
  ]) {
    const trace = await json(file);
    // The frozen traces name v1 and validate as committed.
    assert.equal(trace.project.seedPinAddendum, SEED_PIN_ADDENDUM_V1.path);
    assert.deepEqual(traceErrors(trace, ctx), [], file);
    const current = clone(trace);
    current.project.seedPinAddendum = SEED_PIN_ADDENDUM_PATH;
    assert.deepEqual(traceErrors(current, ctx), [], file);
    for (const named of [
      "evals/nir1-graph/seed-pin-addendum.v3.json",
      OBSERVATION_PREP_FILES.setupAddendum,
      `./${SEED_PIN_ADDENDUM_V1.path}`,
      `${SEED_PIN_ADDENDUM_V1.path} `,
      "seed-pin-addendum.v1.json",
      "",
    ]) {
      const other = clone(trace);
      other.project.seedPinAddendum = named;
      assert.ok(
        traceErrors(other, ctx).some((e) => /seedPinAddendum/u.test(e)),
        `${file}: ${named}`,
      );
    }
    // v1 is accepted only while its bytes are unchanged.
    for (const changed of ["1".repeat(64), null])
      assert.ok(
        traceErrors(trace, {
          ...ctx,
          supersededSeedPinAddendum: changed && {
            ...ctx.supersededSeedPinAddendum,
            sha256: changed,
          },
        }).some((e) => /seedPinAddendum/u.test(e)),
        file,
      );
  }
});

test("S3v2-P2-1: synthetic detection runs before the first gated run", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const without = clone(prep);
  without.r5Gate.beforeFirstGatedRun = ["sp-p4-seed-pin-parity"];
  assert.ok(
    observationPrepErrors(without, ctx).some((e) =>
      /beforeFirstGatedRun/u.test(e),
    ),
  );
  const ids = clone(prep);
  ids.r5Gate.syntheticDetection.negatives.pop();
  assert.ok(
    observationPrepErrors(ids, ctx).some((e) => /syntheticDetection/u.test(e)),
  );
});

test("S3v2-P3-2: SP-P4 fixes its mode, branches from one copy, compares logical IDs and records zero Graph begins", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const p4 = (value) => value.diagnosticRuns.find((row) => row.id === "SP-P4");
  for (const mutate of [
    (row) => {
      row.d2aMode = "unrestricted";
    },
    (row) => {
      row.branch = "independent-setups";
    },
    (row) => {
      row.compareBy = "runtime-id";
    },
    (row) => {
      row.requiredRecords = row.requiredRecords.filter(
        (r) => r !== "owner-begins-delta-zero",
      );
    },
    (row) => {
      row.notCountedAs = [];
    },
  ]) {
    const changed = clone(prep);
    mutate(p4(changed));
    assert.ok(
      observationPrepErrors(changed, ctx).some((e) => /SP-P4/u.test(e)),
    );
  }
});

test("S3v2-P3-3: G-01 restore negatives use the Scene body version restore and re-check the seed pin", async () => {
  const ctx = await context();
  const addendum = await json(OBSERVATION_PREP_FILES.setupAddendum);
  const n = (value, id) =>
    value.diagnosticNegatives.find((row) => row.id === id);
  const snapshot = clone(addendum);
  n(snapshot, "K24-G01-N3").restorePath = "project-snapshot";
  assert.ok(
    setupAddendumErrors(snapshot, ctx).some((e) => /restorePath/u.test(e)),
  );
  for (const id of ["K24-G01-N2", "K24-G01-N3", "K24-G01-N4"]) {
    const unchecked = clone(addendum);
    n(unchecked, id).afterMutationChecks = ["sp-p1-recheck"];
    assert.ok(
      setupAddendumErrors(unchecked, ctx).some((e) =>
        /afterMutationChecks/u.test(e),
      ),
      id,
    );
    const noInconclusive = clone(addendum);
    delete n(noInconclusive, id).inconclusiveWhen;
    assert.ok(
      setupAddendumErrors(noInconclusive, ctx).some((e) =>
        /inconclusiveWhen/u.test(e),
      ),
      id,
    );
  }
});

test("integrator: the CP-4 candidate is decided in the S5 ledger, never an S4 placeholder", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.equal(prep.candidate.commit, null);
  assert.ok(
    !prep.placeholders.some((row) => row.token === "S4:cp4-candidate-commit"),
  );
  const asPlaceholder = clone(prep);
  asPlaceholder.candidate.commit = "S4:cp4-candidate-commit";
  asPlaceholder.placeholders.push({
    token: "S4:cp4-candidate-commit",
    field: "candidate.commit",
    fill: "x",
  });
  assert.ok(
    observationPrepErrors(asPlaceholder, ctx).some((e) => /candidate/u.test(e)),
  );
  const filledIn = clone(prep);
  filledIn.candidate.commit = "a".repeat(40);
  assert.ok(
    observationPrepErrors(filledIn, ctx).some((e) => /candidate/u.test(e)),
  );
  const noLedger = clone(prep);
  delete noLedger.candidate.decidedIn;
  assert.ok(
    observationPrepErrors(noLedger, ctx).some((e) => /candidate/u.test(e)),
  );
  const { fixed, frozenCtx } = await frozenRecord(ctx);
  assert.equal(fixed.candidate.commit, null);
  assert.deepEqual(observationPrepErrors(fixed, frozenCtx), []);
});

test("S3v3-P3-1: a frozen record needs the SP/1 bytes in the repository and their commit", async () => {
  const ctx = await context();
  const { fixed, frozenCtx } = await frozenRecord(ctx);
  assert.ok(
    observationPrepErrors(fixed, { ...frozenCtx, sp1Sha256: null }).some((e) =>
      /SP\/1|sp1/u.test(e),
    ),
  );
  const noCommit = clone(fixed);
  noCommit.contracts.sp1.bytesCommit = "S4:sp1-bytes-commit";
  assert.ok(
    observationPrepErrors(noCommit, frozenCtx).some((e) => /sp1/u.test(e)),
  );
  const draft = await draftPrep();
  assert.deepEqual(
    observationPrepErrors(draft, { ...ctx, sp1Sha256: null }),
    [],
  );
});

test("S3v3-P3-2: SP-P4 retakes after a Graph begin are disclosed and capped at 2", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const p4 = (value) => value.diagnosticRuns.find((row) => row.id === "SP-P4");
  assert.equal(p4(prep).attemptLimit, 2);
  const more = clone(prep);
  p4(more).attemptLimit = 3;
  assert.ok(observationPrepErrors(more, ctx).some((e) => /SP-P4/u.test(e)));
  const silent = clone(prep);
  p4(silent).attemptRule = "retake";
  assert.ok(observationPrepErrors(silent, ctx).some((e) => /SP-P4/u.test(e)));
});

test("integrator: the R5 check run is a narrow exception and the phases run R5 -> K6/4 freeze -> S4 -> Graph", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const r5 = (value) =>
    value.r5Gate.exempt.find((row) => row.run === "r5-seed-pin-check");
  assert.ok(r5(prep));
  const wide = clone(prep);
  r5(wide).scope.push("rir-query");
  assert.ok(
    observationPrepErrors(wide, ctx).some((e) => /r5-seed-pin-check/u.test(e)),
  );
  const lax = clone(prep);
  r5(lax).forbids = r5(lax).forbids.filter((row) => row !== "v10-ready-probe");
  assert.ok(
    observationPrepErrors(lax, ctx).some((e) => /r5-seed-pin-check/u.test(e)),
  );
  const gone = clone(prep);
  gone.r5Gate.exempt = gone.r5Gate.exempt.filter(
    (row) => row.run !== "r5-seed-pin-check",
  );
  assert.ok(observationPrepErrors(gone, ctx).some((e) => /r5Gate/u.test(e)));

  const order = clone(prep);
  const phases = order.stepOrder.phases;
  [phases[1], phases[2]] = [phases[2], phases[1]];
  assert.ok(
    observationPrepErrors(order, ctx).some((e) => /stepOrder\.phases/u.test(e)),
  );

  const decided = clone(prep);
  decided.contracts.k64.decidedIn = "after-s4";
  assert.ok(
    observationPrepErrors(decided, ctx).some((e) => /k64\.decidedIn/u.test(e)),
  );

  const record = clone(prep);
  record.r5Gate.r5CheckRecord = "";
  assert.ok(
    observationPrepErrors(record, ctx).some((e) => /r5CheckRecord/u.test(e)),
  );
  const { fixed, frozenCtx } = await frozenRecord(ctx);
  const unfilled = clone(fixed);
  unfilled.r5Gate.r5CheckRecord = "S4:r5-check-record";
  assert.ok(
    observationPrepErrors(unfilled, frozenCtx).some((e) =>
      /r5CheckRecord/u.test(e),
    ),
  );
});

test("S3v4: synthetic detection before S4, a bounded R5 check run, discarded R5 workspaces, two-stage S4", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.deepEqual(prep.stepOrder.phases, [
    "r5-seed-pin-check",
    "k64-freeze-commit",
    "sp-synthetic-detection",
    "s4-observation-prep-commit",
    "sp-p4-seed-pin-parity",
    "graph-arm-runs",
  ]);
  const late = clone(prep);
  late.stepOrder.phases = [
    "r5-seed-pin-check",
    "k64-freeze-commit",
    "s4-observation-prep-commit",
    "sp-synthetic-detection",
    "sp-p4-seed-pin-parity",
    "graph-arm-runs",
  ];
  assert.ok(
    observationPrepErrors(late, ctx).some((e) => /stepOrder\.phases/u.test(e)),
  );
  const decided = clone(prep);
  decided.r5Gate.syntheticDetection.decidedIn = "after-s4";
  assert.ok(
    observationPrepErrors(decided, ctx).some((e) =>
      /syntheticDetection/u.test(e),
    ),
  );

  const r5 = (value) =>
    value.r5Gate.exempt.find((row) => row.run === "r5-seed-pin-check");
  assert.deepEqual(r5(prep).scope, [
    "setup-through-seed-pin-step",
    "product-db-read",
  ]);
  const setup = clone(prep);
  r5(setup).scope = ["setup", "product-db-read"];
  assert.ok(
    observationPrepErrors(setup, ctx).some((e) => /r5-seed-pin-check/u.test(e)),
  );
  const maint = clone(prep);
  r5(maint).forbids = r5(maint).forbids.filter(
    (row) => row !== "maintenance-enable",
  );
  assert.ok(
    observationPrepErrors(maint, ctx).some((e) => /r5-seed-pin-check/u.test(e)),
  );

  const reuse = clone(prep);
  reuse.r5Gate.r5CheckWorkspace.reuseFor = ["graph-arm-runs"];
  assert.ok(
    observationPrepErrors(reuse, ctx).some((e) => /r5CheckWorkspace/u.test(e)),
  );
  const noRecheck = clone(prep);
  noRecheck.r5Gate.r5CheckWorkspace.recheckInLaterPhases = ["sp-p1"];
  assert.ok(
    observationPrepErrors(noRecheck, ctx).some((e) =>
      /r5CheckWorkspace/u.test(e),
    ),
  );

  const oneStage = clone(prep);
  oneStage.s4Stages = ["s4"];
  assert.ok(
    observationPrepErrors(oneStage, ctx).some((e) => /s4Stages/u.test(e)),
  );
});

test("S3v4-P3-3: referenced bytes sit in a strict ancestor of the frozen record's commit (S4a before S4b)", () => {
  const head = "b".repeat(40);
  const rows = [
    { path: "evals/x.json", commit: "a".repeat(40), sha256: "c".repeat(64) },
  ];
  const git = {
    blobSha: () => "c".repeat(64),
    isAncestor: () => true,
  };
  assert.deepEqual(formalReferenceErrors(rows, head, git), []);
  assert.ok(
    formalReferenceErrors([{ ...rows[0], commit: head }], head, git).some((e) =>
      /strict ancestor/u.test(e),
    ),
  );
  assert.ok(
    formalReferenceErrors(rows, head, { ...git, blobSha: () => "d".repeat(64) })
      .length > 0,
  );
  assert.ok(
    formalReferenceErrors(rows, head, { ...git, isAncestor: () => false })
      .length > 0,
  );
});

// ---- S2 追補（S1j-2 の setup の読み〔DR-CP4-L-11〕と trace の runner の提案〔DR-CP4-TR-8〜TR-10〕） ----

/** Asserts that `mutate` on a clone of `value` makes `check` report `pattern`. */
function detects(value, check, mutate, pattern) {
  const copy = clone(value);
  mutate(copy);
  const errors = check(copy);
  assert.ok(
    errors.some((e) => pattern.test(e)),
    `expected ${pattern} in ${JSON.stringify(errors)}`,
  );
}

const rowOf = (rows, variant) => rows.find((row) => row.variant === variant);

test("S2 追補 L-11: setupReadings fix the sessions, the variant sessions, the probe, the blocked names, the specs and the seal reopen", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.deepEqual(observationPrepErrors(prep, ctx), []);
  const readings = prep.setupReadings;
  assert.ok(readings, "setupReadings is required");
  assert.deepEqual(
    readings.items.map((row) => row.l11),
    [
      "(1)",
      "(2)",
      "(3)",
      "(4)",
      "(5)",
      "(6)",
      "(7)",
      "(8)",
      "(9)",
      "(10)",
      "L-24",
      "L-27",
      "L-19",
      // S2 追補 #9（DR-CP4-P-5）: the re-freeze's harness readings.
      "T-3、T-5",
      "T-1",
      "T-4",
    ],
  );
  assert.equal(readings.variantSessions.length, 13);
  assert.deepEqual(
    rowOf(readings.variantSessions, "G-08/chronicle-index-unusable").sessions,
    ["author", "ir", "seal", "hold", "reseal"],
  );
  const check = (copy) => observationPrepErrors(copy, ctx);

  detects(
    prep,
    check,
    (p) => p.setupReadings.items.splice(7, 1),
    /setupReadings\.items/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.items[10].reading = " "),
    /setupReadings\.items/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.sessions.ir.main = "product"),
    /setupReadings\.sessions/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.sessions.hold.seam = true),
    /setupReadings\.sessions/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (rowOf(
        p.setupReadings.variantSessions,
        "G-08/chronicle-index-unusable",
      ).sessions = ["author", "ir", "seal", "hold"]),
    /variantSessions G-08\/chronicle-index-unusable/u,
  );
  detects(
    prep,
    check,
    (p) =>
      rowOf(
        p.setupReadings.variantSessions,
        "G-08/both-indexes-unusable",
      ).chronicleQueryIn.push("hold"),
    /variantSessions G-08\/both-indexes-unusable/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (rowOf(
        p.setupReadings.variantSessions,
        "G-08/graph-recovered",
      ).measurementSession = "hold"),
    /variantSessions G-08\/graph-recovered/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (rowOf(
        p.setupReadings.variantSessions,
        "G-02/base",
      ).mutations[0].session = "hold"),
    /variantSessions G-02\/base/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (rowOf(
        p.setupReadings.variantSessions,
        "G-08/graph-index-unusable",
      ).specKind = "steady-state"),
    /variantSessions G-08\/graph-index-unusable/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.measurementSpecs[
        "while-chronicle-index-unusable"
      ].warmUp = true),
    /setupReadings\.measurementSpecs/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.measurementSpecs[
        "while-both-indexes-unusable"
      ].freshColdCopyPerProcess = false),
    /setupReadings\.measurementSpecs/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.reopen.limits.seal.reopens = 3),
    /setupReadings\.reopen/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.reopen.triggers[0].waitMs = 60_000),
    /setupReadings\.reopen/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.receiptFields.sealAttempts = { outcomes: [] }),
    /setupReadings\.receiptFields/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.blocked = p.setupReadings.blocked.filter(
        (row) => row.name !== "blocked:b-seal-not-published",
      )),
    /setupReadings\.blocked/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.probe.sources = ["readIndexMetadata"]),
    /setupReadings\.probe/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.probe.readOnly = false),
    /setupReadings\.probe/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.irPath.contextSetCount = 3),
    /setupReadings\.irPath/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.irPath.aiSettings.model = "other"),
    /setupReadings\.irPath/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.irPath.mainSessions = ["ir", "seal"]),
    /setupReadings\.irPath/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.setupMain.env.GRIMODEX_PRODUCT_JOURNEY_FAKE_AI = "live"),
    /setupReadings\.setupMain/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.setupMain.output = "dist-electron/main.cjs"),
    /setupReadings\.setupMain/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.typeEdit.mutation = "g02-m-other"),
    /setupReadings\.typeEdit/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.typeEdit.firstMode = "new-id"),
    /setupReadings\.typeEdit/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.irWithdrawal.decision = "rejected"),
    /setupReadings\.irWithdrawal/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.invariantCheck.checkedAt = "first-session-end"),
    /setupReadings\.invariantCheck/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.switchingRetry.boundMs = 120_000),
    /setupReadings\.switchingRetry/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.switchingRetry.r5CheckRetries = true),
    /setupReadings\.switchingRetry/u,
  );
});

test("S2 追補 L-11 (P-3): d2 is read as the index-state probe only for the three unusable G-08 variants", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const readings = prep.d2.variantReadings;
  assert.deepEqual(
    readings.readAs.map((row) => row.variant),
    [
      "G-08/graph-index-unusable",
      "G-08/chronicle-index-unusable",
      "G-08/both-indexes-unusable",
    ],
  );
  assert.equal(readings.unchanged.length, 10);
  // d2.rule 本体は変えない（読み替えは別の欄）。
  assert.ok(
    prep.d2.rule.startsWith(
      "B の sealed binding は、setup の session で B-ROUTE",
    ),
  );
  const check = (copy) => observationPrepErrors(copy, ctx);
  detects(
    prep,
    check,
    (p) =>
      p.d2.variantReadings.readAs.push({
        ...p.d2.variantReadings.readAs[0],
        variant: "G-08/graph-recovered",
      }),
    /d2\.variantReadings/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.d2.variantReadings.unchanged = p.d2.variantReadings.unchanged.filter(
        (v) => v !== "G-01/v1",
      )),
    /d2\.variantReadings/u,
  );
  detects(
    prep,
    check,
    (p) => (p.d2.variantReadings.readAs[1].oneShot = false),
    /d2\.variantReadings/u,
  );
  detects(
    prep,
    check,
    (p) => (p.d2.variantReadings.readAs[0].b = "current"),
    /d2\.variantReadings/u,
  );
  detects(
    prep,
    check,
    (p) => (p.d2.variantReadings.readAs[2].chronicle = "usable"),
    /d2\.variantReadings/u,
  );
  detects(
    prep,
    check,
    (p) => (p.d2.variantReadings.readAs[0].maintenanceSeam = true),
    /d2\.variantReadings/u,
  );
  detects(
    prep,
    check,
    (p) => (p.d2.variantReadings.onMismatch = "blocked:b-sealed-binding"),
    /d2\.variantReadings/u,
  );
  detects(
    prep,
    check,
    (p) => (p.d2.variantReadings.checkedAt = ["before-measurement"]),
    /d2\.variantReadings/u,
  );
});

test("S2 追補: reviewerQuestions carry P-4 and the open readings for S3, undecided in a draft and decided when frozen", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const ids = prep.reviewerQuestions.map((row) => row.id);
  assert.ok(ids.includes("P-4"));
  const check = (copy) => observationPrepErrors(copy, ctx);
  detects(
    prep,
    check,
    (p) =>
      (p.reviewerQuestions = p.reviewerQuestions.filter(
        (row) => row.id !== "P-4",
      )),
    /reviewerQuestions/u,
  );
  detects(
    prep,
    check,
    (p) => (p.reviewerQuestions[0].decision = { choice: "a" }),
    /reviewerQuestions/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.reviewerQuestions[0].options = p.reviewerQuestions[0].options.slice(
        0,
        1,
      )),
    /reviewerQuestions/u,
  );
  detects(
    prep,
    check,
    (p) => (p.reviewerQuestions[0].grounds = []),
    /reviewerQuestions/u,
  );
  const { fixed, frozenCtx } = await frozenRecord(ctx);
  assert.deepEqual(observationPrepErrors(fixed, frozenCtx), []);
  const undecided = clone(fixed);
  undecided.reviewerQuestions[0].decision = null;
  assert.ok(
    observationPrepErrors(undecided, frozenCtx).some((e) =>
      /reviewerQuestions/u.test(e),
    ),
  );
  // 決定は選択肢のどれか（S2 の並べた選択肢の外の choice は通さない）。
  const outside = clone(fixed);
  outside.reviewerQuestions[0].decision.choice = "z";
  assert.ok(
    observationPrepErrors(outside, frozenCtx).some((e) =>
      /reviewerQuestions P-4/u.test(e),
    ),
  );
});

for (const kind of ["editing", "browsing"]) {
  test(`S2 追補 TR-8〜TR-10: the ${kind} trace's runner readings (commit, A3, caret, start seal, maintenance launch) and proposals`, async () => {
    const ctx = await context();
    const file =
      kind === "editing"
        ? OBSERVATION_PREP_FILES.traceEditing
        : OBSERVATION_PREP_FILES.traceBrowsing;
    const trace = await json(file);
    assert.deepEqual(traceErrors(trace, ctx), []);
    const check = (copy) => traceErrors(copy, ctx);
    const ops = trace.runnerReadings.operations;
    assert.deepEqual(
      Object.keys(ops).sort(),
      kind === "editing"
        ? ["confirm-autosave-commit", "edit", "open-scene", "product-query"]
        : ["navigate", "open-scene"],
    );
    detects(
      trace,
      check,
      (t) => delete t.runnerReadings.operations["open-scene"],
      /runnerReadings\.operations/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.a3.readAt = "after-commit"),
      /runnerReadings\.a3/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.startSeal.usableStates = ["current", "dirty"]),
      /runnerReadings\.startSeal/u,
    );
    detects(
      trace,
      check,
      (t) =>
        (t.runnerReadings.startSeal.states = ["current", "dirty", "missing"]),
      /runnerReadings\.startSeal/u,
    );
    detects(
      trace,
      check,
      (t) => t.runnerReadings.startSeal.reads.pop(),
      /runnerReadings\.startSeal/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.startSeal.onDisagreement = "current"),
      /runnerReadings\.startSeal/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.startSeal.connection.busyTimeoutMs = 300),
      /runnerReadings\.startSeal/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.startSeal.insideTimingWindow = true),
      /runnerReadings\.startSeal/u,
    );
    detects(
      trace,
      check,
      (t) =>
        (t.runnerReadings.maintenanceLaunch.env =
          t.runnerReadings.maintenanceLaunch.env.filter(
            (name) => !/NONCE/u.test(name),
          )),
      /runnerReadings\.maintenanceLaunch/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.maintenanceLaunch.scope = "every-launch"),
      /runnerReadings\.maintenanceLaunch/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.maintenanceLaunch.onForbiddenOption = "drop"),
      /runnerReadings\.maintenanceLaunch/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.maintenanceLaunch.trigger = "other"),
      /runnerReadings\.maintenanceLaunch/u,
    );
    // 禁止の seam の option の一覧（[precheck] の対象）を減らさない。
    detects(
      trace,
      check,
      (t) => t.maintenance.forbiddenSeamOptions.pop(),
      /maintenance\.forbiddenSeamOptions/u,
    );
    detects(
      trace,
      check,
      (t) =>
        t.contentProposals.push({
          id: "x",
          status: "applied",
          proposal: "Q を 150 にする",
        }),
      /contentProposals/u,
    );
    if (kind === "editing") {
      detects(
        trace,
        check,
        (t) => (t.runnerReadings.operations.edit.caret = "click"),
        /runnerReadings\.operations\.edit/u,
      );
      detects(
        trace,
        check,
        (t) =>
          (t.runnerReadings.operations["confirm-autosave-commit"].version =
            "db-version"),
        /runnerReadings\.operations\.confirm-autosave-commit/u,
      );
      detects(
        trace,
        check,
        (t) =>
          (t.runnerReadings.operations[
            "confirm-autosave-commit"
          ].harnessReadsDb = true),
        /runnerReadings\.operations\.confirm-autosave-commit/u,
      );
    } else {
      detects(
        trace,
        check,
        (t) =>
          (t.runnerReadings.operations.navigate.outsideQ.onNonCompleted =
            "wait-for-publication"),
        /runnerReadings\.operations\.navigate/u,
      );
    }
  });
}

test("S2 追補: the author may list the permitted DR rows of cp4-decisions.md only, and a ref prefix does not hide a forbidden path", async () => {
  const declaration = await json(OBSERVATION_PREP_FILES.authorDeclaration);
  assert.deepEqual(authorDeclarationErrors(declaration), []);
  const decisions = declaration.readFiles.filter((row) =>
    /nir1-lane-decisions\/cp4-decisions\.md$/u.test(row.path),
  );
  assert.equal(decisions.length, 4);
  assert.equal(typeof declaration.decisionSummariesSeen, "string");

  const extraRow = clone(declaration);
  extraRow.readFiles
    .find((row) => /cp4-decisions/u.test(row.path))
    .permittedRows.push("DR-CP4-K-5");
  assert.ok(
    authorDeclarationErrors(extraRow).some((e) =>
      /forbidden|permittedRows/u.test(e),
    ),
  );

  const noPermit = clone(declaration);
  delete noPermit.readFiles.find((row) => /cp4-decisions/u.test(row.path))
    .permittedBy;
  assert.ok(
    authorDeclarationErrors(noPermit).some((e) =>
      /forbidden|permittedBy/u.test(e),
    ),
  );

  const noSummary = clone(declaration);
  delete noSummary.decisionSummariesSeen;
  assert.ok(
    authorDeclarationErrors(noSummary).some((e) =>
      /decisionSummariesSeen/u.test(e),
    ),
  );

  for (const hidden of [
    "claude/x@0123456789abcdef0123456789abcdef01234567:docs/plans/nir1-lane-decisions/cp4-decisions.md",
    "claude/x:.artifacts/cp4/run/receipt.json",
  ]) {
    const prefixed = clone(declaration);
    prefixed.readFiles.push({ path: hidden, sha256: "0".repeat(64) });
    assert.ok(
      authorDeclarationErrors(prefixed).some((e) => /forbidden/u.test(e)),
      hidden,
    );
  }
});

// ---- S2 追補 #2（S3 の 6 回目の条件 P2-1〜P2-3、P3-1〜P3-4、master の harness への pin） ----

test("S2 追補 #2 P2-1: setupReadings pin master commits and copy L-24's closed set of reopen triggers, limits, blocked names and receipt fields", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.deepEqual(observationPrepErrors(prep, ctx), []);
  const readings = prep.setupReadings;
  assert.deepEqual(
    readings.source.pins.map((row) => row.role),
    [
      "s1j2-blocked-map",
      "s1j2-complete-setup",
      "trace-runner",
      "b-route-seam-fix",
      "t14-k64-freeze",
      "freshness-requeue-fix",
      // S2 追補 #4（#753〜#756）。
      "startup-gate-io-settle",
      "s5a-graph-arm-runner",
      "maintenance-ownership-release",
      "s5b-diagnostics-wiring",
      // S2 追補 #6（#757。DR-CP4-Q-1）。
      "sp-p4-ir-timeout",
      // S2 追補 #7（#758。DR-CP4-S4-1）。
      "s4-rehearsal-admission",
      // S2 追補 #8（#759。DR-CP4-Q-2）。
      "sp-p4-ir-pair-limit",
      // S2 追補 #9（DR-CP4-T-1〜T-5。S4 の凍結のやり直し、DR-CP4-P-5）。
      "t3-t5-setup-freshness-settle",
      "t1-t4-measurement-settle-ready",
      // S2 追補 #10（DR-CP4-V-2〜V-4。3 回目の凍結のやり直し、DR-CP4-P-6）。
      "v2-trace-probe-paths",
      "v4-trace-record-requery",
      "v4-followup-cancelled-match",
      "v4-trace-runner-quote-guard",
      // S2 追補 #11（G-04 fixture v2。4 回目の凍結のやり直し、DR-CP4-P-7）。
      "g4-b1-post-observation-freeze",
      "g4-b1-freeze-v2-constants",
      "g4-b2a-declaration-v2-path",
      "g4-b2b1-addendum-v2-paths",
      // S2 追補 #5（P-S2-9 (b)。正式の入口の閉包の file を最後に変えた commit）。
      "pr1-native-eval-feature",
      "p1-harness-core",
      "p2p3-harness-admission",
      "p4-setup-driver-seed-pin",
      // S2 追補 #7（harness の外の eval 専用 script を最後に変えた commit）。
      "nir1-retrieval-ir-base",
      "cp0-graph-eval-freeze",
      "da1-route-isolation",
      "cq-lim-graph-limits",
      "dp-h-unknown-scope",
    ],
  );
  assert.deepEqual(
    readings.reopen.triggers.map((row) => row.id),
    ["not-published", "sealed-then-dirty", "maintenance-wait"],
  );
  const check = (copy) => observationPrepErrors(copy, ctx);
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.source.pins[0].commit =
        "14ccf6ac3470de28c37b9a9dd1e8d3db7d19adc9"),
    /setupReadings\.source\.pins/u,
  );
  detects(
    prep,
    check,
    (p) =>
      p.setupReadings.reopen.triggers.push({
        ...p.setupReadings.reopen.triggers[0],
        id: "index-build-timeout",
      }),
    /setupReadings\.reopen/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.reopen.limits.author.waitMs = 120_000),
    /setupReadings\.reopen/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.reopen.limits.hold.openings = 3),
    /setupReadings\.reopen/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.reopen.totalReopenableOpenings = 10),
    /setupReadings\.reopen/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.reopen.triggers[1].onExhausted =
        "blocked:b-seal-not-published"),
    /setupReadings\.reopen/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.reopen.closedSet = false),
    /setupReadings\.reopen/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.blocked = p.setupReadings.blocked.filter(
        (row) => row.name !== "blocked:index-build-timeout",
      )),
    /setupReadings\.blocked/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.indexBuild.intervalMs = 50),
    /setupReadings\.indexBuild/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.indexBuild.reopenTrigger = true),
    /setupReadings\.indexBuild/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.receiptFields.sealAttempts.outcomes = [
        "sealed",
        "not-published",
        "failed",
      ]),
    /setupReadings\.receiptFields/u,
  );
  detects(
    prep,
    check,
    (p) => delete p.setupReadings.receiptFields.preMutationIndexState,
    /setupReadings\.receiptFields/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.setupMain.shaPerRun = true),
    /setupReadings\.setupMain/u,
  );
});

test("S2 追補 #2 P2-3 / P3-4: blockedCaseJudgement is S3's table (harness names kept, never mapped to the maintenance-enabled precondition)", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const rows = prep.setupReadings.blockedCaseJudgement.rows;
  const row = (harnessId, condition) =>
    rows.find(
      (entry) => entry.harnessId === harnessId && entry.condition === condition,
    );
  assert.equal(
    row("b-seal-not-published", "any").graphCases,
    "blocked:b-sealed-binding",
  );
  assert.equal(row("b-seal-not-published", "any").g01, "hold");
  // DR-CP4-L-28: 前提条件 maintenance-enabled に写すのは P-5 の待ち切れの行だけ。
  assert.deepEqual(
    rows
      .filter((entry) => entry.graphCases === "blocked:maintenance-enabled")
      .map((entry) => `${entry.harnessId}/${entry.condition}`),
    ["maintenance-enabled/maintenance-wait-exhausted"],
  );
  const check = (copy) => observationPrepErrors(copy, ctx);
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.blockedCaseJudgement.rows[0].graphCases =
        "blocked:maintenance-enabled"),
    /setupReadings\.blockedCaseJudgement/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.blockedCaseJudgement.rows[2].graphCases =
        "blocked:b-sealed-binding"),
    /setupReadings\.blockedCaseJudgement/u,
  );
  detects(
    prep,
    check,
    (p) => p.setupReadings.blockedCaseJudgement.rows.pop(),
    /setupReadings\.blockedCaseJudgement/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.blockedCaseJudgement.receiptName = "contract-id"),
    /setupReadings\.blockedCaseJudgement/u,
  );
});

test("S2 追補 #2 P2-2: P-4 (b) is wired only for the two one-shot G-08 variants, the others keep warm-up 5 and 30 in the steady state", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const exceptions = prep.samplePlan.variantExceptions;
  assert.deepEqual(
    exceptions.map((row) => row.variants),
    [["G-08/chronicle-index-unusable", "G-08/both-indexes-unusable"]],
  );
  assert.equal(prep.samplePlan.warmupPerArm, 5);
  assert.equal(prep.samplePlan.measuredPerArm, 30);
  const check = (copy) => observationPrepErrors(copy, ctx);
  detects(
    prep,
    check,
    (p) =>
      p.samplePlan.variantExceptions[0].variants.push(
        "G-08/graph-index-unusable",
      ),
    /samplePlan\.variantExceptions/u,
  );
  detects(
    prep,
    check,
    (p) => (p.samplePlan.variantExceptions[0].warmupProcessesPerArm = 0),
    /samplePlan\.variantExceptions/u,
  );
  detects(
    prep,
    check,
    (p) => (p.samplePlan.variantExceptions[0].measuredProcessesPerArm = 20),
    /samplePlan\.variantExceptions/u,
  );
  detects(
    prep,
    check,
    (p) => (p.samplePlan.variantExceptions[0].receiptLabel = "定常状態"),
    /samplePlan\.variantExceptions/u,
  );
  detects(
    prep,
    check,
    (p) => (p.samplePlan.variantExceptions[0].excludeFromDefaultPools = true),
    /samplePlan\.variantExceptions/u,
  );
  detects(
    prep,
    check,
    (p) => (p.samplePlan.variantExceptions[0].preMeasurementQueries = true),
    /samplePlan\.variantExceptions/u,
  );
  detects(
    prep,
    check,
    (p) =>
      p.samplePlan.variantExceptions.push({
        ...p.samplePlan.variantExceptions[0],
        variants: ["G-02/base"],
      }),
    /samplePlan\.variantExceptions/u,
  );
  detects(
    prep,
    check,
    (p) => (p.d10.parity.oneShot.variants = ["G-08/chronicle-index-unusable"]),
    /d10\.parity\.oneShot/u,
  );
  detects(
    prep,
    check,
    (p) => (p.d10.parity.oneShot.warmupProcessesPerArm = 0),
    /d10\.parity\.oneShot/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.measurementSpecs[
        "while-both-indexes-unusable"
      ].warmupProcessesPerArm = 0),
    /setupReadings\.measurementSpecs/u,
  );
  // P-4 の決定は S3 の記録の写し（S2 は決めない）。
  const p4 = prep.reviewerQuestions.find((row) => row.id === "P-4");
  assert.equal(p4.decision.choice, "b");
});

test("S2 追補 #2: S3's decisions are recorded, and P-S2-5 (the harness's blocked mapping against S3's table) stays open", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const byId = Object.fromEntries(
    prep.reviewerQuestions.map((row) => [row.id, row]),
  );
  for (const id of ["P-4", "P-S2-2", "P-S2-3", "P-S2-4"])
    assert.ok(byId[id].decision);
  assert.equal(byId["P-S2-5"].decision.by, "integrator（DR-CP4-L-28）");
  const check = (copy) => observationPrepErrors(copy, ctx);
  detects(
    prep,
    check,
    (p) =>
      (p.reviewerQuestions.find((row) => row.id === "P-4").decision.record =
        ""),
    /reviewerQuestions P-4/u,
  );
});

test("S2 追補 #2 P3-3: a draft keeps exactly the S4 placeholder tokens", async () => {
  const ctx = await context();
  const prep = await draftPrep();
  assert.equal(prep.placeholders.length, 20);
  const check = (copy) => observationPrepErrors(copy, ctx);
  detects(
    prep,
    check,
    (p) => {
      p.contracts.k64.freezeCommit = "a".repeat(40);
      p.placeholders = p.placeholders.filter(
        (row) => row.token !== "S4:k64-freeze-commit",
      );
    },
    /placeholders/u,
  );
});

for (const kind of ["editing", "browsing"]) {
  test(`S2 追補 #2 P2-3 / P-S2-3 / P-S2-4: the ${kind} trace keeps its project, records seal reads and outside-Q returns`, async () => {
    const ctx = await context();
    const file =
      kind === "editing"
        ? OBSERVATION_PREP_FILES.traceEditing
        : OBSERVATION_PREP_FILES.traceBrowsing;
    const trace = await json(file);
    assert.deepEqual(traceErrors(trace, ctx), []);
    const check = (copy) => traceErrors(copy, ctx);
    detects(
      trace,
      check,
      (t) => (t.setupFailure.projectSwapAllowed = true),
      /setupFailure/u,
    );
    // trace の project だけを別の G-case に替える。
    detects(trace, check, (t) => (t.project.caseId = "G-03"), /setupFailure/u);
    // 別の G-case への差し替え（setupFailure の project も合わせて替える）。
    detects(
      trace,
      check,
      (t) => {
        t.project.caseId = "G-03";
        t.setupFailure.project = "G-03/base";
      },
      /setupFailure/u,
    );
    detects(
      trace,
      check,
      (t) => (t.setupFailure.onNotSetupComplete.cp4Availability = "PASS"),
      /setupFailure/u,
    );
    detects(
      trace,
      check,
      (t) =>
        (t.fixedBeforeObservation = `${t.fixedBeforeObservation} 作り直せるのは setup の検証を通らないとき。`),
      /fixedBeforeObservation/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.startSeal.receipt.sealReadTimes = false),
      /runnerReadings\.startSeal/u,
    );
    detects(
      trace,
      check,
      (t) => (t.runnerReadings.startSeal.receipt.cdpNow = "omit"),
      /runnerReadings\.startSeal/u,
    );
    if (kind === "browsing")
      detects(
        trace,
        check,
        (t) =>
          (t.runnerReadings.operations.navigate.outsideQ.receiptCountByReason = false),
        /runnerReadings\.operations\.navigate/u,
      );
  });
}

test("S2 追補 #2 P3-1 / P3-2: forbidden paths are found anywhere in the path; the blindness scope and the readings chosen after dev runs are disclosed", async () => {
  const declaration = await json(OBSERVATION_PREP_FILES.authorDeclaration);
  assert.deepEqual(authorDeclarationErrors(declaration), []);
  for (const hidden of [
    "/home/grimodex/worktrees/Grimodex/x/docs/plans/nir1-lane-decisions/cp4-decisions.md",
    "git show claude/x:docs/plans/nir1-lane-decisions/rs-join-decisions.md",
    "./docs/plans/nir1-lane-decisions/cq-deferred-decisions.md",
    "./.artifacts/cp4/run/receipt.json",
    "claude/nir1-contracts:docs/plans/nir1-cp4-records/r.json",
  ]) {
    const copy = clone(declaration);
    copy.readFiles.push({ path: hidden, sha256: "0".repeat(64) });
    assert.ok(
      authorDeclarationErrors(copy).some((e) => /forbidden/u.test(e)),
      hidden,
    );
  }
  const vagueScope = clone(declaration);
  vagueScope.graphRuntimeOutputObservedScope = "Graph の出力は見ていない。";
  assert.ok(
    authorDeclarationErrors(vagueScope).some((e) =>
      /graphRuntimeOutputObservedScope/u.test(e),
    ),
  );
  const noScope = clone(declaration);
  delete noScope.graphRuntimeOutputObservedScope;
  assert.ok(
    authorDeclarationErrors(noScope).some((e) =>
      /graphRuntimeOutputObservedScope/u.test(e),
    ),
  );
  const fewer = clone(declaration);
  fewer.readingsChosenAfterDevObservation =
    fewer.readingsChosenAfterDevObservation.slice(1);
  assert.ok(
    authorDeclarationErrors(fewer).some((e) =>
      /readingsChosenAfterDevObservation/u.test(e),
    ),
  );
  // S4a(3)（S4 の最終関門の P2-2）: the two readings chosen after the dev runs
  // (K24-G01 retry limit 30→60, SP-P4 ir-complete-pairs and K=6) are listed.
  for (const id of ["g01-retry-limit", "sp-p4-ir-timeout-limit"]) {
    const without = clone(declaration);
    without.readingsChosenAfterDevObservation =
      without.readingsChosenAfterDevObservation.filter((row) => row.id !== id);
    assert.ok(
      authorDeclarationErrors(without).some((e) =>
        /readingsChosenAfterDevObservation/u.test(e),
      ),
      id,
    );
    const unattributed = clone(declaration);
    unattributed.readingsChosenAfterDevObservation.find(
      (row) => row.id === id,
    ).chosenBy = " ";
    assert.ok(
      authorDeclarationErrors(unattributed).some((e) =>
        /readingsChosenAfterDevObservation/u.test(e),
      ),
      id,
    );
  }
});

// ---- S2 追補 #3（P-S2-5 の integrator の決定〔DR-CP4-L-28〕と harness の表の照合） ----

test("S2 追補 #3: blockedCaseJudgement equals the pinned harness's BLOCKED_CONTRACT_TABLE row by row", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.deepEqual(observationPrepErrors(prep, ctx), []);
  // harness の表は pin した commit の bytes から導き直す。
  assert.equal(ctx.harnessBlockedTable.length, 9);
  assert.equal(
    ctx.harnessBlockedTableSource.sha256,
    prep.setupReadings.source.pins
      .find((row) => row.role === BLOCKED_TABLE_SOURCE.role)
      .files.find((file) => file.path.endsWith("frozen-setup-driver.mjs"))
      .sha256,
  );
  const rows = prep.setupReadings.blockedCaseJudgement.rows;
  assert.deepEqual(
    rows.map((row) => [row.harnessId, row.condition, row.g01, row.graphCases]),
    ctx.harnessBlockedTable.map((row) => [
      row.harnessId,
      row.condition,
      row.g01,
      row.graphCases,
    ]),
  );
  assert.ok(rows.every((row) => row.harnessAgrees === true));
  assert.ok(rows.every((row) => !/undecided/u.test(JSON.stringify(row))));
  const check = (copy) => observationPrepErrors(copy, ctx);
  // 表の 1 行を harness と食い違わせる。
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.blockedCaseJudgement.rows[6].graphCases =
        "hold-and-precheck"),
    /blockedCaseJudgement/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.blockedCaseJudgement.rows[7].g01 = "hold"),
    /blockedCaseJudgement/u,
  );
  detects(
    prep,
    check,
    (p) => (p.setupReadings.blockedCaseJudgement.rows[4].harnessAgrees = false),
    /blockedCaseJudgement/u,
  );
  // harness の側が S2 と違う（pin の後に harness が変わった）なら通さない。
  const drifted = {
    ...ctx,
    harnessBlockedTable: ctx.harnessBlockedTable.map((row, at) =>
      at === 0 ? { ...row, graphCases: "blocked:maintenance-enabled" } : row,
    ),
  };
  assert.ok(
    observationPrepErrors(prep, drifted).some((e) =>
      /blockedCaseJudgement/u.test(e),
    ),
  );
  const unread = { ...ctx, harnessBlockedTable: null };
  assert.ok(
    observationPrepErrors(prep, unread).some((e) =>
      /BLOCKED_CONTRACT_TABLE could not be read/u.test(e),
    ),
  );
  // harness と S2 の両方が別の行を maintenance-enabled に写す（L-28 は P-5 の行だけ）。
  const both = {
    ...ctx,
    harnessBlockedTable: ctx.harnessBlockedTable.map((row, at) =>
      at === 0 ? { ...row, graphCases: "blocked:maintenance-enabled" } : row,
    ),
  };
  const bothPrep = clone(prep);
  bothPrep.setupReadings.blockedCaseJudgement.rows[0].graphCases =
    "blocked:maintenance-enabled";
  assert.ok(
    observationPrepErrors(bothPrep, both).some((e) =>
      /blockedCaseJudgement/u.test(e),
    ),
  );
  // pin の file の sha256 が harness の表の出所と違う。
  detects(
    prep,
    check,
    (p) => {
      const pin = p.setupReadings.source.pins.find(
        (row) => row.role === BLOCKED_TABLE_SOURCE.role,
      );
      pin.files[0].sha256 = flip(pin.files[0].sha256);
    },
    /BLOCKED_CONTRACT_TABLE|pins/u,
  );
});

// ---- S2 追補 #4（S5 の配線 #754〜#756 の後の pin と、S5-B の読みの写し。DR-CP4-P-1） ----

const H4 = "scripts/quality/nir1-graph-eval/";
const ORPHAN = "0123456789abcdef0123456789abcdef01234567";
/**
 * S2 追補 #9（DR-CP4-P-5）／#10（DR-CP4-P-6）／#11（DR-CP4-P-7）: the pins at
 * branch commits that S4's PR brings to master with its merge commit (gh pr
 * merge --merge).
 */
const BRANCH_PIN_ROLES = new Set([
  "t3-t5-setup-freshness-settle",
  "t1-t4-measurement-settle-ready",
  "v2-trace-probe-paths",
  "v4-trace-record-requery",
  "v4-followup-cancelled-match",
  "v4-trace-runner-quote-guard",
  "g4-b1-post-observation-freeze",
  "g4-b1-freeze-v2-constants",
  "g4-b2a-declaration-v2-path",
  "g4-b2b1-addendum-v2-paths",
]);
const gitText = (args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

test("S2 追補 #4 (A): each pin is a master commit and each bytes pin holds that commit's bytes (git)", async (t) => {
  const ctx = await context();
  if (!ctx.sourcePinGit) {
    t.skip("shallow clone: the pins are checked by the formal gate");
    return;
  }
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const pins = prep.setupReadings.source.pins;
  const { head } = ctx.sourcePinGit;
  assert.deepEqual(sourcePinGitErrors(pins, head, ctx.sourcePinGit), []);
  // 同じ path を 2 つの pin に置かない（SOURCE_PINS そのもの）。
  const held = SOURCE_PINS.flatMap((pin) => pin.paths);
  assert.equal(new Set(held).size, held.length);
  assert.deepEqual(
    pins.map((row) => [row.role, row.commit, row.check]),
    SOURCE_PINS.map((pin) => [pin.role, pin.commit, pin.check]),
  );
  // 変異: bytes の pin の sha256 を 1 字変える（全 file）。
  for (const [at, pin] of pins.entries())
    for (const [index, file] of (pin.files ?? []).entries()) {
      const copy = clone(pins);
      copy[at].files[index].sha256 = flip(file.sha256);
      assert.ok(
        sourcePinGitErrors(copy, head, ctx.sourcePinGit).some((e) =>
          e.includes(`${file.path} at ${pin.commit} is not the pinned bytes`),
        ),
        `${pin.role} ${file.path}`,
      );
      detects(
        prep,
        (p) => observationPrepErrors(p, ctx),
        (p) => {
          p.setupReadings.source.pins[at].files[index].sha256 = flip(
            file.sha256,
          );
        },
        /is not the pinned bytes|BLOCKED_CONTRACT_TABLE|harness constants/u,
      );
    }
  // 変異: commit を孤立の hash に変える（bytes の pin と ancestor の pin）。
  for (const role of [
    "s5b-diagnostics-wiring",
    "maintenance-ownership-release",
  ]) {
    const copy = clone(pins);
    copy.find((row) => row.role === role).commit = ORPHAN;
    const errors = sourcePinGitErrors(copy, head, ctx.sourcePinGit);
    assert.ok(
      errors.some((e) => e.includes(`${role}: ${ORPHAN} is not an ancestor`)),
      role,
    );
    detects(
      prep,
      (p) => observationPrepErrors(p, ctx),
      (p) => {
        p.setupReadings.source.pins.find((row) => row.role === role).commit =
          ORPHAN;
      },
      /is not an ancestor/u,
    );
  }
  // 存在するが祖先でない commit（rebase で孤立した commit）も拒む。
  const notAncestor = { ...ctx.sourcePinGit, isAncestor: () => false };
  assert.equal(
    sourcePinGitErrors(pins, head, notAncestor).length,
    SOURCE_PINS.length,
  );
});

test("S2 追補 #4／#6／#7／#9／#10／#11 (A): the bytes pins hold every non-test harness file #754, #756, #757, #758, #759, T-1〜T-5, V-2〜V-4 and the G-04 v2 closure files changed, each at the commit that last changed it", async (t) => {
  const ctx = await context();
  if (!ctx.sourcePinGit) {
    t.skip("shallow clone");
    return;
  }
  // S2 追補 #8: the newest pin (#759) is the tip the last changes are read at.
  // Every pin, #759's included, is a master commit and holds the files it
  // last changed on master (strict).
  const rehearsal = SOURCE_PINS.find(
    (pin) => pin.role === "s4-rehearsal-admission",
  );
  const sp = SOURCE_PINS.find((pin) => pin.role === "sp-p4-ir-timeout");
  const pairLimit = SOURCE_PINS.find(
    (pin) => pin.role === "sp-p4-ir-pair-limit",
  );
  // S2 追補 #10: the newest pin (V-4, 759a4679) is the tip now; the T-4 pin
  // (354b1ba6) is the tip of the T-1〜T-5 diff below.
  const tip = SOURCE_PINS.find(
    (pin) => pin.role === "v4-trace-runner-quote-guard",
  );
  const t4 = SOURCE_PINS.find(
    (pin) => pin.role === "t1-t4-measurement-settle-ready",
  );
  // S2 追補 #11（DR-CP4-P-7）: the four G-04 v2 pins (branch claude/g04-v2c-fixture,
  // base master 8187fbfc); the newest (B2b-1, c5b46714) is where every pin's
  // last change is read now. The earlier ranges keep their tips; a file of an
  // earlier range that the G-04 v2 branch changed again is held by a G-04 v2
  // pin.
  const g4Pins = SOURCE_PINS.filter((pin) => pin.role.startsWith("g4-"));
  assert.deepEqual(
    g4Pins.map((pin) => pin.role),
    [
      "g4-b1-post-observation-freeze",
      "g4-b1-freeze-v2-constants",
      "g4-b2a-declaration-v2-path",
      "g4-b2b1-addendum-v2-paths",
    ],
  );
  const newest = g4Pins.at(-1);
  const g4Paths = g4Pins.flatMap((pin) => pin.paths);
  const master = gitText(["rev-parse", "refs/remotes/origin/master"]);
  // S2 追補 #9（DR-CP4-P-5）／#10（DR-CP4-P-6）: the two T-1〜T-5 pins and
  // the four V-2〜V-4 pins are branch commits that S4's PR brings to master
  // with its merge commit; before that merge they are ancestors of the
  // record's HEAD (a descendant of master), after it of master. Every other
  // pin is a master commit.
  const branchPins = BRANCH_PIN_ROLES;
  assert.ok(ctx.sourcePinGit.isAncestor(master, ctx.sourcePinGit.head));
  for (const pin of SOURCE_PINS)
    assert.ok(
      ctx.sourcePinGit.isAncestor(pin.commit, master) ||
        (branchPins.has(pin.role) &&
          ctx.sourcePinGit.isAncestor(pin.commit, ctx.sourcePinGit.head)),
      pin.role,
    );
  const nonTest = (text) =>
    text
      .split("\n")
      .filter(
        (file) =>
          file !== "" &&
          !file.endsWith(".test.mjs") &&
          !file.endsWith("test-support.mjs"),
      )
      .sort();
  const changed = nonTest(
    gitText([
      "diff",
      "--name-only",
      "b1a87b0b81fbdce7f3d280e0671bced51306be1d",
      tip.commit,
      "--",
      H4,
    ]),
  ).filter(
    // S4a の手順の file（k64-procedure の draft-2 と v1）は S2 の boundFiles と
    // k64Procedure が束縛し、pin の対象でない。
    (file) => !file.startsWith(`${H4}procedure/`),
  );
  const held = SOURCE_PINS.filter((pin) =>
    [
      "s5a-graph-arm-runner",
      "s5b-diagnostics-wiring",
      "sp-p4-ir-timeout",
      "s4-rehearsal-admission",
      "sp-p4-ir-pair-limit",
      "t3-t5-setup-freshness-settle",
      "t1-t4-measurement-settle-ready",
      "v2-trace-probe-paths",
      "v4-trace-record-requery",
      "v4-followup-cancelled-match",
      "v4-trace-runner-quote-guard",
    ].includes(pin.role),
  )
    .flatMap((pin) => pin.paths)
    .concat(g4Paths.filter((file) => changed.includes(file)))
    .filter((file) => file.startsWith(H4))
    .sort();
  assert.deepEqual(held, changed);
  // #757 が変えた test 以外の file は 3 つ（diagnostic-runner.mjs と frozen-diagnostics.mjs は後の PR でも変わり、後の pin にある）。
  assert.deepEqual(
    nonTest(
      gitText([
        "diff",
        "--name-only",
        "950751d040b29b6d78a067a003dc19b196cfb692",
        sp.commit,
        "--",
        H4,
      ]),
    ),
    [
      ...sp.paths,
      `${H4}diagnostic-runner.mjs`,
      `${H4}frozen-diagnostics.mjs`,
    ].sort(),
  );
  // #758 が変えた試験と文書以外の file は 5 つ（試験専用の test-support.mjs は pin しない。
  // diagnostic-runner.mjs は #759 でも変わり、その pin にある）。
  assert.deepEqual(
    nonTest(
      gitText([
        "diff",
        "--name-only",
        sp.commit,
        rehearsal.commit,
        "--",
        "scripts",
      ]),
    ),
    [
      ...rehearsal.paths,
      `${H4}diagnostic-runner.mjs`,
      // S2 追補 #11: moved to the G-04 v2 pins.
      `${H4}frozen-k64-admission.mjs`,
      `${H4}trace-frozen.mjs`,
    ].sort(),
  );
  // #759 が変えた試験と文書以外の file は 2 つで、すべて sp-p4-ir-pair-limit の pin にある。
  assert.deepEqual(
    nonTest(
      gitText([
        "diff",
        "--name-only",
        rehearsal.commit,
        pairLimit.commit,
        "--",
        "scripts",
      ]),
    ),
    [...pairLimit.paths].sort(),
  );
  // S2 追補 #9: T-1〜T-5（master 5ce12211 から枝の 354b1ba6 まで）が変えた試験以外の
  // scripts の file は 4 つで、すべて 2 つの新しい pin にある。
  const settle = SOURCE_PINS.find(
    (pin) => pin.role === "t3-t5-setup-freshness-settle",
  );
  assert.deepEqual(
    nonTest(
      gitText([
        "diff",
        "--name-only",
        "5ce1221158f9855725a3c87704c17586324a08a9",
        t4.commit,
        "--",
        "scripts",
      ]),
    ),
    [...settle.paths, ...t4.paths].sort(),
  );
  assert.ok(ctx.sourcePinGit.isAncestor(settle.commit, t4.commit));
  // S2 追補 #10: V-2〜V-4（master a02c9c98 から枝の 759a4679 まで）が変えた試験以外の
  // scripts の file は 4 つで、それぞれを最後に変えた枝の commit の 4 つの新しい pin にある。
  const tracePath = SOURCE_PINS.filter((pin) =>
    [
      "v2-trace-probe-paths",
      "v4-trace-record-requery",
      "v4-followup-cancelled-match",
      "v4-trace-runner-quote-guard",
    ].includes(pin.role),
  );
  assert.equal(tracePath.length, 4);
  assert.deepEqual(
    nonTest(
      gitText([
        "diff",
        "--name-only",
        "a02c9c98e48037a429faf6751f2a60ff7b132974",
        tip.commit,
        "--",
        "scripts",
      ]),
    ),
    tracePath.flatMap((pin) => pin.paths).sort(),
  );
  assert.ok(
    ctx.sourcePinGit.isAncestor(
      "a02c9c98e48037a429faf6751f2a60ff7b132974",
      tracePath[0].commit,
    ),
  );
  for (const pin of tracePath) {
    assert.ok(ctx.sourcePinGit.isAncestor(t4.commit, pin.commit), pin.role);
    assert.equal(pin.paths.length, 1, pin.role);
  }
  // S2 追補 #11: G-04 v2（master 8187fbfc から枝の c5b46714 まで）が変えた試験以外の
  // scripts の file は 8 つ。4 つは正式の入口の閉包にあり、それぞれを最後に変えた枝の
  // commit の 4 つの新しい pin にある。残りは S2 validator の 2 file（pin でなく S2 の
  // 束縛が対象）と、閉包の外の dev の形の写し 2 file。
  const g4Base = "8187fbfc9685356225956dfce83431aec9845473";
  assert.ok(ctx.sourcePinGit.isAncestor(g4Base, g4Pins[0].commit));
  assert.deepEqual(
    nonTest(
      gitText(["diff", "--name-only", g4Base, newest.commit, "--", "scripts"]),
    ),
    [
      ...g4Paths,
      "scripts/quality/nir1-graph/observation-prep.mjs",
      "scripts/quality/nir1-graph/seed-pin-addendum.mjs",
      `${H4}dev-fixtures/dev-shape-g04.v1.json`,
      `${H4}dev-shape-fixture.mjs`,
    ].sort(),
  );
  for (const pin of g4Pins) {
    assert.ok(ctx.sourcePinGit.isAncestor(pin.commit, newest.commit), pin.role);
    assert.equal(pin.paths.length, 1, pin.role);
  }
  for (const pin of SOURCE_PINS)
    for (const file of pin.paths) {
      const last = gitText([
        "log",
        "-1",
        "--format=%H",
        newest.commit,
        "--",
        file,
      ]);
      assert.equal(
        last,
        pin.commit,
        `${file} is held by the commit that last changed it`,
      );
    }
  // ancestor の pin は PR の squash の commit（#753、#755 ほか）。
  for (const pin of SOURCE_PINS)
    assert.ok(
      ctx.sourcePinGit.isAncestor(pin.commit, newest.commit),
      `${pin.role} precedes ${newest.commit}`,
    );
  // 変異: path を 2 つの pin に置く、pin から file を外す、check を変える。
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const check = (copy) => observationPrepErrors(copy, ctx);
  detects(
    prep,
    check,
    (p) => {
      const pins = p.setupReadings.source.pins;
      const from = pins.find((row) => row.role === "s5b-diagnostics-wiring");
      pins
        .find((row) => row.role === "s5a-graph-arm-runner")
        .files.push({ ...from.files[0] });
    },
    /setupReadings\.source\.pins must be/u,
  );
  detects(
    prep,
    check,
    (p) => {
      p.setupReadings.source.pins
        .find((row) => row.role === "s5b-diagnostics-wiring")
        .files.pop();
    },
    /setupReadings\.source\.pins must be/u,
  );
  detects(
    prep,
    check,
    (p) => {
      p.setupReadings.source.pins.find(
        (row) => row.role === "s1j2-blocked-map",
      ).check = "bytes";
    },
    /setupReadings\.source\.pins must be/u,
  );
  detects(
    prep,
    check,
    (p) => {
      p.setupReadings.source.pins = p.setupReadings.source.pins.filter(
        (row) => row.role !== "startup-gate-io-settle",
      );
    },
    /setupReadings\.source\.pins must be/u,
  );
});

test("S2 追補 #4／#6 (A): the blocked table and the harness constants are read from the bytes of the pin that holds each file", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  // S2 追補 #9: frozen-setup-driver.mjs is held by the T-3／T-5 pin (b0df31f0).
  assert.equal(BLOCKED_TABLE_SOURCE.role, "t3-t5-setup-freshness-settle");
  assert.equal(
    BLOCKED_TABLE_SOURCE.commit,
    "b0df31f076ea1e11fd187c5c6fdf179d0df337b5",
  );
  const pinOf = (role) =>
    prep.setupReadings.source.pins.find((row) => row.role === role);
  const pin = pinOf(BLOCKED_TABLE_SOURCE.role);
  assert.equal(
    pin.files.find((file) => file.path === BLOCKED_TABLE_SOURCE.path).sha256,
    ctx.harnessBlockedTableSource.sha256,
  );
  // harness の定数（O-14 の文面でなく g01-negatives.mjs の値が正）。
  // S2 追補 #6: SP-P4 の規則と K は #757 の frozen-diagnostics.mjs の値。
  assert.deepEqual(ctx.harnessConstants, {
    B_SEAL_REOPENS: 2,
    B_SEAL_WAIT_MS: 120000,
    G01_CONTROL_ATTEMPTS: 60,
    G01_SAMPLE_ATTEMPTS: 60,
    G01_CONTROL_GAP_MS: 250,
    G01_GRAPH_READY_WAIT_MS: 10000,
    SP_P4_COMPARISON_RULE: "ir-complete-pairs",
    SP_P4_IR_TIMEOUT_LIMIT: 6,
    // S2 追補 #8: #759 の組の上限（S3 の C2 の組の最少 24）。
    SP_P4_IR_TIMEOUT_PAIR_LIMIT: 6,
    // S2 追補 #9（DR-CP4-T-3）: 完全な setup の Freshness の待ち。
    FRESHNESS_SETTLE_WAIT_MS: 60000,
    FRESHNESS_SETTLE_INTERVAL_MS: 250,
    // S2 追補 #9（DR-CP4-T-1）: 測定の process の待ち（export しない module の定数）。
    RUN_FRESHNESS_SETTLE_LIMIT_MS: 15000,
    RUN_FRESHNESS_SETTLE_INTERVAL_MS: 100,
  });
  assert.deepEqual(
    ctx.harnessConstantSources.map((row) => row.path),
    [
      ...Object.keys(HARNESS_CONSTANTS),
      ...Object.keys(HARNESS_MODULE_CONSTANTS),
    ],
  );
  // 各 file はそれを持つ pin の commit から読む（frozen-diagnostics.mjs は #757）。
  assert.deepEqual(
    ctx.harnessConstantSources.map((row) => [
      row.path.slice(H4.length),
      row.commit.slice(0, 8),
    ]),
    [
      // S2 追補 #9: T-5（b0df31f0）の pin。
      ["frozen-setup-driver.mjs", "b0df31f0"],
      ["g01-negatives.mjs", "950751d0"],
      // S2 追補 #8: #759 の pin（値は SOURCE_PINS から読む）。
      [
        "frozen-diagnostics.mjs",
        SOURCE_PINS.find(
          (pin) => pin.role === "sp-p4-ir-pair-limit",
        ).commit.slice(0, 8),
      ],
      // S2 追補 #9: T-4（354b1ba6）の pin。
      ["frozen-k64-run.mjs", "354b1ba6"],
    ],
  );
  for (const source of ctx.harnessConstantSources)
    assert.equal(
      pinOf(harnessPinOf(source.path).role).files.find(
        (file) => file.path === source.path,
      )?.sha256,
      source.sha256,
    );
  assert.equal(
    harnessPinOf(`${H4}frozen-diagnostics.mjs`).role,
    "sp-p4-ir-pair-limit",
  );
  // 変異: 組の上限は #757（43e3f40b）の bytes には無い。
  const before759 = execFileSync(
    "git",
    [
      "show",
      `43e3f40b5d653c62d5aca4ca795917b67310992c:${H4}frozen-diagnostics.mjs`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(
    parseHarnessConstant(before759, "SP_P4_IR_TIMEOUT_PAIR_LIMIT"),
    undefined,
  );
  assert.equal(parseHarnessConstant(before759, "SP_P4_IR_TIMEOUT_LIMIT"), 6);
  assert.equal(harnessPinOf(`${H4}not-a-harness-file.mjs`), undefined);
  // 変異: 定数を古い pin（950751d0）の bytes から読むと、規則は current で K は無い。
  const old = execFileSync(
    "git",
    [
      "show",
      `950751d040b29b6d78a067a003dc19b196cfb692:${H4}frozen-diagnostics.mjs`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(parseHarnessConstant(old, "SP_P4_COMPARISON_RULE"), "current");
  assert.equal(parseHarnessConstant(old, "SP_P4_IR_TIMEOUT_LIMIT"), undefined);
  // 変異: frozen-diagnostics.mjs の sha256 を s5b の pin の旧い bytes と比べる。
  const misread = {
    ...ctx,
    harnessConstantSources: ctx.harnessConstantSources.map((row) =>
      row.path.endsWith("frozen-diagnostics.mjs")
        ? { ...row, sha256: sha256(old) }
        : row,
    ),
  };
  assert.ok(
    observationPrepErrors(prep, misread).some((e) =>
      /sp-p4-ir-pair-limit: .*frozen-diagnostics\.mjs must be the bytes the harness constants were read from/u.test(
        e,
      ),
    ),
  );
  assert.equal(
    parseHarnessConstant(
      'export const A = 10_000;\nexport const B = "x";',
      "A",
    ),
    10000,
  );
  assert.equal(parseHarnessConstant('export const B = "x";', "B"), "x");
  assert.equal(parseHarnessConstant("const A = 1;", "A"), undefined);
  // 定数の出所の bytes が pin と違う、または読めない。
  const drifted = {
    ...ctx,
    harnessConstantSources: ctx.harnessConstantSources.map((row, at) =>
      at === 1 ? { ...row, sha256: flip(row.sha256) } : row,
    ),
  };
  assert.ok(
    observationPrepErrors(prep, drifted).some((e) =>
      /must be the bytes the harness constants were read from/u.test(e),
    ),
  );
  const addendum = await json(OBSERVATION_PREP_FILES.setupAddendum);
  assert.ok(
    setupAddendumErrors(addendum, { ...ctx, harnessConstants: null }).some(
      (e) => /harness constants could not be read/u.test(e),
    ),
  );
});

test("S2 追補 #4 (B): K24-G01-N2〜N4 read reached by the control and the sample, with the re-ask rule fixed to the harness constants", async () => {
  const ctx = await context();
  const addendum = await json(OBSERVATION_PREP_FILES.setupAddendum);
  assert.deepEqual(setupAddendumErrors(addendum, ctx), []);
  const readings = addendum.afterMutationReadings;
  assert.equal(readings.control.attemptLimit, 60);
  assert.equal(readings.sample.attemptLimit, 60);
  assert.equal(readings.retry.gapMs, 250);
  for (const row of addendum.diagnosticNegatives.slice(1))
    assert.deepEqual(row.afterMutationChecks, [
      "sp-p1-recheck",
      "graph-requested-with-seed",
      "g01-mira-entity-reached",
    ]);
  const check = (copy) => setupAddendumErrors(copy, ctx);
  const R = (mutate, pattern) => detects(addendum, check, mutate, pattern);
  R((a) => (a.afterMutationReadings.control.attemptLimit = 10), /control/u);
  R((a) => (a.afterMutationReadings.control.gapMs = 1200), /control/u);
  R((a) => (a.afterMutationReadings.control.workspace = "fresh"), /control/u);
  R((a) => (a.afterMutationReadings.control.bIndex = "compare"), /control/u);
  R((a) => (a.afterMutationReadings.sample.attemptLimit = 30), /sample/u);
  R(
    (a) => a.afterMutationReadings.sample.reachedWhen.pop(),
    /afterMutationReadings\.sample/u,
  );
  R(
    (a) => a.afterMutationReadings.sample.undeterminedWhen.shift(),
    /afterMutationReadings\.sample/u,
  );
  R((a) => (a.afterMutationReadings.retry.sampleLimit = 30), /retry/u);
  R((a) => (a.afterMutationReadings.retry.decision = "best-of"), /retry/u);
  R((a) => (a.afterMutationReadings.retry.retryOn = "every-answer"), /retry/u);
  R(
    (a) => (a.afterMutationReadings.retry.decidedAnswers = ["graph-ready"]),
    /retry/u,
  );
  R(
    (a) => (a.afterMutationReadings.retry.parentChild = "best-of-parent-child"),
    /retry/u,
  );
  R(
    (a) => (a.afterMutationReadings.retry.onExhausted = "not-reached"),
    /retry/u,
  );
  R(
    (a) => (a.afterMutationReadings.retry.onConstantMismatch = "disclose"),
    /retry/u,
  );
  R((a) => a.afterMutationReadings.retry.disclose.pop(), /retry/u);
  R(
    (a) =>
      (a.afterMutationReadings.seedRequested.source = "native-begin-record"),
    /seedRequested/u,
  );
  R(
    (a) => (a.afterMutationReadings.seedRequested.notFrom = null),
    /seedRequested/u,
  );
  R(
    (a) => (a.afterMutationReadings.seedRequested.expected = "g01-mira-entity"),
    /seedRequested/u,
  );
  R(
    (a) => a.afterMutationReadings.verdict.inconclusiveReasons.splice(3, 1),
    /verdict/u,
  );
  R(
    (a) => (a.afterMutationReadings.resealAfterMutation.reopensMax = 3),
    /reseal/u,
  );
  R(
    (a) => (a.afterMutationReadings.resealAfterMutation.waitMs = 60000),
    /reseal/u,
  );
  R(
    (a) =>
      (a.afterMutationReadings.resealAfterMutation.measurementPoint =
        "setup-measurement-point"),
    /reseal/u,
  );
  R(
    (a) =>
      (a.diagnosticNegatives[2].beforeDeclarationWriter = "saveSceneContent"),
    /createRevision/u,
  );
  R(
    (a) => delete a.diagnosticNegatives[3].afterMutationReading,
    /afterMutationReading must name/u,
  );
  R(
    (a) => delete a.afterMutationReadings,
    /afterMutationReadings is required/u,
  );
  // harness の定数が S2 の値と違えば（例: 上限を 30 に戻した harness）通さない。
  for (const [key, value] of [
    ["G01_CONTROL_ATTEMPTS", 30],
    ["G01_SAMPLE_ATTEMPTS", 30],
    ["G01_CONTROL_GAP_MS", 1200],
    ["G01_GRAPH_READY_WAIT_MS", 5000],
    ["B_SEAL_REOPENS", 1],
    ["B_SEAL_WAIT_MS", 60000],
  ])
    assert.ok(
      setupAddendumErrors(addendum, {
        ...ctx,
        harnessConstants: { ...ctx.harnessConstants, [key]: value },
      }).length > 0,
      key,
    );
});

test("S2 追補 #4／#6 (C): SP-P4 re-reads sparse, R+IR − R, graph-recovered's reason, measurement-only retake, and puts ir-complete-pairs (C1〜C3) in force", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const { readDiagnosticPlan, SP_P4_COMPARISON_RULE, SP_P4_IR_TIMEOUT_LIMIT } =
    await import("../nir1-graph-eval/frozen-diagnostics.mjs");
  // harness の plan の読みは S2 の記録をそのまま受ける。
  assert.equal(readDiagnosticPlan(prep).spP4.variants.length, 8);
  const p4 = prep.diagnosticRuns.find((row) => row.id === "SP-P4");
  // S2 追補 #6: 作業 tree の harness（#757 の後の master）と pin の bytes の両方で ir-complete-pairs と K=6。
  assert.equal(p4.comparisonRule.inForce, SP_P4_COMPARISON_RULE);
  assert.equal(p4.comparisonRule.inForce, "ir-complete-pairs");
  assert.equal(ctx.harnessConstants.SP_P4_COMPARISON_RULE, "ir-complete-pairs");
  const pairs = p4.comparisonRule.rules.find(
    (row) => row.id === "ir-complete-pairs",
  );
  assert.equal(pairs.timeoutLimit, SP_P4_IR_TIMEOUT_LIMIT);
  assert.equal(pairs.timeoutLimit, ctx.harnessConstants.SP_P4_IR_TIMEOUT_LIMIT);
  assert.equal(pairs.status, "in-force");
  assert.equal(
    p4.comparisonRule.rules.find((row) => row.id === "current").status,
    "not-in-force",
  );
  const at = prep.diagnosticRuns.indexOf(p4);
  const check = (copy) => observationPrepErrors(copy, ctx);
  const R = (mutate, pattern = /SP-P4/u) =>
    detects(prep, check, (p) => mutate(p.diagnosticRuns[at]), pattern);
  const P = (r) => r.comparisonRule.rules[1];
  // 変異: in force を current に戻す（status も）、current を in force のまま残す。
  R((r) => (r.comparisonRule.inForce = "current"));
  R((r) => {
    r.comparisonRule.inForce = "current";
    r.comparisonRule.rules[0].status = "in-force";
    P(r).status = "not-in-force";
  });
  R((r) => (r.comparisonRule.rules[0].status = "in-force"));
  R((r) => (r.comparisonRule.rules[0].status = "proposed"));
  R((r) => (P(r).status = "proposed"));
  R((r) => (P(r).awaits = "S3"));
  // 変異: K を 5／7 に変える、文字列にする、欠く。
  for (const value of [5, 7, "6", null])
    R((r) => (P(r).timeoutLimit = value), /SP_P4_IR_TIMEOUT_LIMIT/u);
  R((r) => delete P(r).timeoutLimit, /SP_P4_IR_TIMEOUT_LIMIT/u);
  // 変異: 「しきい値は足さない」を戻す、撤回の記録を落とす。
  R((r) => (P(r).threshold = null), /SP_P4_IR_TIMEOUT_LIMIT/u);
  R(
    (r) => (P(r).text += "しきい値（期限切れの数や割合の上限）は足さない。"),
    /SP_P4_IR_TIMEOUT_LIMIT/u,
  );
  R((r) => delete P(r).withdrawn, /SP_P4_IR_TIMEOUT_LIMIT/u);
  // 変異: C1 の 4 つの条件のそれぞれ、外す範囲、組の扱い。
  for (const [key, value] of [
    ["outcome", "not-ir-ready"],
    ["deadlineExceeded", false],
    ["rIrSceneIds", "any"],
    ["irSupplementSceneId", "any"],
  ])
    R((r) => (P(r).irExcludedWhen[key] = value), /SP_P4_IR_TIMEOUT_LIMIT/u);
  R((r) => delete P(r).irExcludedWhen.deadlineExceeded, /SP_P4/u);
  R((r) => (P(r).otherNotReady = "excluded"), /SP_P4_IR_TIMEOUT_LIMIT/u);
  R((r) => (P(r).pairExcludedWhen = "both-sides-excluded"), /SP_P4/u);
  R((r) => (P(r).onOverTimeoutLimit = "disclose"), /SP_P4/u);
  R((r) => (P(r).onNoIrCompared = "disclose"), /SP_P4/u);
  R((r) => P(r).timeoutLimitBy.pop(), /SP_P4/u);
  R((r) => P(r).undefinedReasons.pop(), /SP_P4/u);
  R((r) => P(r).rFields.pop(), /SP_P4/u);
  R((r) => (P(r).pairing = "any-ready-sample"), /SP_P4/u);
  R((r) => r.comparisonRule.rules.pop());
  // 変異: C1〜C3 の本文を落とす・欠く、C1 の 4 つの条件の語を落とす。
  for (const id of ["C1", "C2", "C3"]) {
    R((r) => (P(r).conditions[id] = ""));
    R((r) => delete P(r).conditions[id]);
  }
  for (const word of [
    "timeout",
    "deadlineExceeded",
    "R+IR",
    "共通追加枠",
    "spP4IrTimeoutExcluded",
    "current と同じ",
  ])
    R(
      (r) => (P(r).conditions.C1 = P(r).conditions.C1.replaceAll(word, "")),
      /comparisonRule must put ir-complete-pairs in force/u,
    );
  R(
    (r) =>
      (P(r).conditions.C2 = P(r).conditions.C2.replaceAll(
        "SP_P4_IR_TIMEOUT_LIMIT",
        "K",
      )),
  );
  R(
    (r) => (P(r).conditions.C3 = P(r).conditions.C3.replaceAll("43e3f40b", "")),
  );
  R((r) => (P(r).conditions.C4 = "extra"));
  R((r) => (r.comparisonRule.harnessConstant = "SP_P4_COMPARISON_RULE だけ"));
  // 変異: receipt の読み（harness の欄名）を変える、disclosure の注を落とす。
  R(
    (r) => (r.comparisonRule.receiptReading.design = ["rule"]),
    /receiptReading/u,
  );
  R(
    (r) => r.comparisonRule.receiptReading.attemptIrMeasured.pop(),
    /receiptReading/u,
  );
  R(
    (r) => (r.comparisonRule.receiptReading.sideStability[4] = "irComplete"),
    /receiptReading/u,
  );
  R(
    (r) => r.comparisonRule.receiptReading.comparison.shift(),
    /receiptReading/u,
  );
  R((r) => delete r.comparisonRule.receiptReading, /receiptReading/u);
  R(
    (r) =>
      (r.comparisonRule.disclosure = r.comparisonRule.disclosure.replaceAll(
        "explainedByIrDeadline",
        "explained",
      )),
    /receiptReading/u,
  );
  R((r) => (r.sparseReading.when = "before-product-fetch"));
  R((r) => (r.sparseReading.via = "harness-sql"));
  R((r) => (r.supplementSlot.maxScenes = 2));
  R(
    (r) =>
      (r.countReason = r.countReason.replaceAll(
        "G-08/graph-recovered",
        "G-08",
      )),
  );
  R((r) => (r.retakeScope = "setup-and-measurement"));
  // 変異: harness の定数を読み違える（規則が current、K が 5／7／欠け／文字列）。
  const withConstants = (patch) =>
    observationPrepErrors(prep, {
      ...ctx,
      harnessConstants: { ...ctx.harnessConstants, ...patch },
    }).filter((e) => /comparisonRule/u.test(e));
  assert.deepEqual(withConstants({}), []);
  for (const patch of [
    { SP_P4_COMPARISON_RULE: "current" },
    { SP_P4_IR_TIMEOUT_LIMIT: 5 },
    { SP_P4_IR_TIMEOUT_LIMIT: 7 },
    { SP_P4_IR_TIMEOUT_LIMIT: undefined },
    { SP_P4_IR_TIMEOUT_LIMIT: "6" },
  ])
    assert.ok(withConstants(patch).length > 0, JSON.stringify(patch));
  // harness が current のままなら、S2 の記録を current に戻しても ir-complete-pairs は通さない（S2 は #757 を pin する）。
  const reverted = clone(prep);
  const rule = reverted.diagnosticRuns[at].comparisonRule;
  rule.inForce = "current";
  rule.rules[0].status = "in-force";
  rule.rules[1].status = "not-in-force";
  assert.ok(
    observationPrepErrors(reverted, {
      ...ctx,
      harnessConstants: {
        ...ctx.harnessConstants,
        SP_P4_COMPARISON_RULE: "current",
      },
    }).some((e) => /comparisonRule must put ir-complete-pairs/u.test(e)),
  );
  // gate: P-S2-6 の決定が無い、e 以外（a を除く）、決定の conditions が無いと通さない。
  const gate = (mutate) =>
    detects(
      prep,
      check,
      (p) => mutate(p.reviewerQuestions.find((row) => row.id === "P-S2-6")),
      /comparisonRule must put ir-complete-pairs in force/u,
    );
  for (const choice of ["b", "c", "d"])
    gate((row) => (row.decision.choice = choice));
  gate((row) => delete row.decision.conditions);
  gate((row) => (row.decision = null));
});

test("S2 追補 #4 (D): the Gold run uses the one completed parity before its start; the parity fallback is not wired", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.ok(
    prep.runnerHandoff.some(
      (row) =>
        row.includes("claude/nir1-contracts") &&
        row.includes("fileSha256AtStart"),
    ),
  );
  const check = (copy) => observationPrepErrors(copy, ctx);
  const R = (mutate, pattern) =>
    detects(prep, check, (p) => mutate(p.d10.parity), pattern);
  R((d) => (d.fallbackWired = true), /fallback/u);
  R((d) => (d.fallback = d.fallback.replaceAll("[precheck]", "")), /fallback/u);
  R((d) => (d.selection.onTwoOrMore = "latest"), /selection/u);
  R((d) => (d.selection.onNone = "unrestricted-fallback"), /selection/u);
  R((d) => (d.selection.finishedBeforeGoldStart = false), /selection/u);
  R((d) => (d.selection.completedOnly = false), /selection/u);
  R((d) => (d.selection.blockedAttempt = "completed"), /selection/u);
  R((d) => d.receipt.priorAttempts.splice(2, 1), /priorAttempts/u);
  R((d) => d.receipt.thisAttempt.pop(), /priorAttempts/u);
});

test("S2 追補 #4 (E): the trace takes only the candidate's G-02 base complete setup, SP-P1's one-row R5 and a named blocked as setupFailure", async () => {
  const ctx = await context();
  for (const file of [
    OBSERVATION_PREP_FILES.traceEditing,
    OBSERVATION_PREP_FILES.traceBrowsing,
  ]) {
    const trace = await json(file);
    assert.deepEqual(traceErrors(trace, ctx), []);
    const check = (copy) => traceErrors(copy, ctx);
    const R = (mutate, pattern) => detects(trace, check, mutate, pattern);
    R(
      (tr) =>
        (tr.runnerReadings.setupReceipt.rejects =
          tr.runnerReadings.setupReceipt.rejects.filter(
            (row) => row !== "r5-check-run",
          )),
      /setupReceipt/u,
    );
    R(
      (tr) =>
        (tr.runnerReadings.setupReceipt.rejects =
          tr.runnerReadings.setupReceipt.rejects.filter(
            (row) => row !== "sp-p4-branch",
          )),
      /setupReceipt/u,
    );
    R(
      (tr) => (tr.runnerReadings.setupReceipt.candidate = "any"),
      /setupReceipt/u,
    );
    R(
      (tr) => (tr.runnerReadings.r5Check.check = "thirteen-variants"),
      /r5Check/u,
    );
    R((tr) => (tr.runnerReadings.r5Check.onMismatch = "disclose"), /r5Check/u);
    R((tr) => (tr.setupFailure.acceptsOnly = "any-failure"), /acceptsOnly/u);
  }
});

test("S2 追補 #5: the S3 7th review's decisions are recorded (P-S2-6 conditional e, P-S2-7 a, P-S2-8 a, P-S2-9 b)", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const byId = Object.fromEntries(
    prep.reviewerQuestions.map((row) => [row.id, row]),
  );
  assert.ok(byId["P-S2-6"].topic.includes("loosening"));
  for (const [id, choice] of [
    ["P-S2-6", "e"],
    ["P-S2-7", "a"],
    ["P-S2-8", "a"],
    ["P-S2-9", "b"],
  ]) {
    const { decision } = byId[id];
    assert.equal(decision.choice, choice, id);
    // S2 追補 #8（S4 の最終関門の P2-1）: P-S2-6 の by は K と組の上限の帰属を足す。
    if (id === "P-S2-6")
      assert.ok(
        decision.by.startsWith("S3 の 7 回目（独立 reviewer、Opus）。"),
        id,
      );
    else assert.equal(decision.by, "S3 の 7 回目（独立 reviewer、Opus）", id);
    assert.ok(decision.record.includes("DR-CP4-P-2"), id);
    assert.ok(decision.conditions.length > 0, id);
  }
  // P-S2-6 の e は S3 の条件 C1〜C3 の選択肢。S2 追補 #6 で #757 の後に in force にした。
  const e = byId["P-S2-6"].options.find((row) => row.id === "e");
  for (const word of ["C1", "C2", "C3", "timeout", "K（=6）"])
    assert.ok(e.text.includes(word), word);
  // S2 追補 #8: 側ごとの上限 6 は integrator（#757）、S3 は例として 3 と組の最少 24、
  // 組の上限 6 は #759（DR-CP4-Q-2）。
  for (const text of [
    e.text,
    byId["P-S2-6"].decision.by,
    byId["P-S2-6"].decision.conditions,
  ])
    for (const word of [
      "integrator が #757（DR-CP4-Q-1）",
      "例として 3",
      "組の最少 24",
      "#759（DR-CP4-Q-2）",
    ])
      assert.ok(text.includes(word), word);
  assert.ok(byId["P-S2-6"].decision.fulfilled.includes("DR-CP4-P-3"));
  const p4 = prep.diagnosticRuns.find((row) => row.id === "SP-P4");
  assert.equal(p4.comparisonRule.inForce, "ir-complete-pairs");
  assert.equal(
    p4.comparisonRule.rules.find((row) => row.id === "ir-complete-pairs")
      .status,
    "in-force",
  );
  const check = (copy) => observationPrepErrors(copy, ctx);
  detects(
    prep,
    check,
    (p) =>
      (p.reviewerQuestions.find((row) => row.id === "P-S2-6").decision = {
        choice: "a",
      }),
    /reviewerQuestions P-S2-6/u,
  );
  // 選択肢に無い choice は拒む（e を外すと P-S2-6 の決定が宙に浮く）。
  detects(
    prep,
    check,
    (p) => {
      const row = p.reviewerQuestions.find((r) => r.id === "P-S2-6");
      row.options = row.options.filter((option) => option.id !== "e");
    },
    /reviewerQuestions P-S2-6: a decision must be S3's/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.reviewerQuestions = p.reviewerQuestions.filter(
        (row) => row.id !== "P-S2-9",
      )),
    /reviewerQuestions must be/u,
  );
});

// ---- S2 追補 #5（S3 の 7 回目の P2-2〔P-S2-9 (b)〕、P3-1、P-S2-6〜9 の決定。DR-CP4-P-2） ----

/**
 * 正式の入口からの harness の閉包: 静的な import（相対）、HTML の script の src、
 * harness の path の文字列（scripts/quality/nir1-graph-eval/… と renderer/…）を
 * たどる。harness の directory の外の file は数えない（製品と別の評価の道具）。
 */
function harnessClosure(root, entries) {
  const dir = path.join(root, H4);
  const seen = new Set();
  const stack = entries.map((entry) => path.join(dir, entry));
  const exists = (file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !exists(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']|<script[^>]*\ssrc=["']([^"']+)["']/gu,
    )) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!spec.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), spec);
      const target =
        ["", ".mjs", ".ts", ".tsx", ".js"]
          .map((ext) => base + ext)
          .find(exists) ?? base;
      if (target.startsWith(dir)) stack.push(target);
    }
    for (const m of text.matchAll(
      /["'`](scripts\/quality\/nir1-graph-eval\/[\w./-]+\.(?:mjs|ts|tsx|html))["'`]/gu,
    ))
      stack.push(path.join(root, m[1]));
    for (const m of text.matchAll(
      /["'`/](renderer\/[\w.-]+\.(?:ts|tsx|html))["'`]/gu,
    ))
      stack.push(path.join(dir, m[1]));
  }
  return [...seen].map((file) => path.relative(root, file)).sort();
}

/** 閉包の file のうち、どの bytes の pin にも無いもの。 */
const unpinned = (closure, pins) => {
  const held = new Set(pins.flatMap((pin) => pin.paths));
  return closure.filter((file) => !held.has(file));
};

/** S2 追補 #5 で足した 36 file（28 は静的な import、8 は renderer と observer の entry）。 */
const ADDENDUM5_FILES = Object.freeze({
  "s1j2-complete-setup": [
    "electron-observer.entry.mjs",
    "launcher.mjs",
    "session.mjs",
  ],
  "trace-runner": ["build-receipt-check.mjs", "renderer/trace-cycle.ts"],
  // S2 追補 #10: cp4-trace-probe.tsx と followup.mjs は V-2〜V-4 の pin に移った。
  "v2-trace-probe-paths": ["renderer/cp4-trace-probe.tsx"],
  "v4-followup-cancelled-match": ["followup.mjs"],
  // S2 追補 #11: constants.mjs は G-04 v2 の pin に移った。
  "t14-k64-freeze": ["receipt.mjs"],
  "g4-b1-freeze-v2-constants": ["constants.mjs"],
  "pr1-native-eval-feature": ["native-architecture.mjs"],
  "p1-harness-core": [
    "admission-facts.mjs",
    "availability.mjs",
    "egress.mjs",
    "join.mjs",
    "native-sample.mjs",
    "procedure-file.mjs",
    "q4.mjs",
    "run-sample.mjs",
    "stats.mjs",
  ],
  "p2p3-harness-admission": [
    "dev-fixture.mjs",
    "dprime-check.mjs",
    "eval-native-build.mjs",
    "keep-test.mjs",
    "observer-core.mjs",
    "outcome.mjs",
    "renderer-build.mjs",
    "renderer/cp4-harness.html",
    "renderer/cp4-hook-probe.tsx",
    "renderer/fetchRelatedScenes.timing.ts",
    "renderer/nir1GraphAvailability.eval.ts",
    "renderer/shell.timing.ts",
    "signal-cleanup.mjs",
  ],
  "p4-setup-driver-seed-pin": [
    "r5-check-runner.mjs",
    "seed-pin-setup.mjs",
    "seed-pin.mjs",
    "setup-driver.mjs",
  ],
});

test("S2 追補 #5 (P2-2): the formal entries' harness closure is held by the bytes pins, and an unpinned closure file fails", async (t) => {
  const closure = harnessClosure(repoRoot, FORMAL_HARNESS_ENTRIES);
  // 静的な import の閉包は 49 file、path の参照をたどると renderer と observer の entry の 12 file が増える。
  assert.equal(closure.length, 61);
  assert.ok(
    closure.every((file) => !/\.test\.mjs$|test-support\.mjs$/u.test(file)),
  );
  assert.deepEqual(unpinned(closure, SOURCE_PINS), []);
  const added = Object.values(ADDENDUM5_FILES).flat();
  assert.equal(added.length, 36);
  for (const file of added) assert.ok(closure.includes(H4 + file), file);
  // 変異: 閉包の file を pin から外す（36 file のそれぞれ）。
  for (const [role, names] of Object.entries(ADDENDUM5_FILES))
    for (const name of names) {
      const pins = SOURCE_PINS.map((pin) =>
        pin.role === role
          ? { ...pin, paths: pin.paths.filter((file) => file !== H4 + name) }
          : pin,
      );
      assert.deepEqual(unpinned(closure, pins), [H4 + name], name);
    }
  // 変異: 閉包に新しい file が入る（harness が新しい file を import する）。
  assert.deepEqual(unpinned([...closure, `${H4}new-helper.mjs`], SOURCE_PINS), [
    `${H4}new-helper.mjs`,
  ]);
  // 記録の pin と SOURCE_PINS は同じ path の列で、記録から外しても validator が落ちる。
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  for (const [role, names] of Object.entries(ADDENDUM5_FILES))
    detects(
      prep,
      (copy) => observationPrepErrors(copy, ctx),
      (p) => {
        const pin = p.setupReadings.source.pins.find(
          (row) => row.role === role,
        );
        pin.files = pin.files.filter((file) => file.path !== H4 + names[0]);
      },
      /setupReadings\.source\.pins must be/u,
    );
  if (!ctx.sourcePinGit) {
    t.skip("shallow clone: the commits are checked by the formal gate");
    return;
  }
  // 各 file は master でそれを最後に変えた commit の pin にあり、その commit は master の祖先。
  // S2 追補 #10: 枝の pin（BRANCH_PIN_ROLES）は、S4 の PR の merge の前は記録の HEAD で
  // 最後に変えた commit で、HEAD の祖先。
  const master = gitText(["rev-parse", "refs/remotes/origin/master"]);
  for (const [role, names] of Object.entries(ADDENDUM5_FILES)) {
    const pin = SOURCE_PINS.find((row) => row.role === role);
    assert.equal(pin.check, "bytes", role);
    const tip =
      BRANCH_PIN_ROLES.has(role) &&
      !ctx.sourcePinGit.isAncestor(pin.commit, master)
        ? ctx.sourcePinGit.head
        : master;
    assert.ok(ctx.sourcePinGit.isAncestor(pin.commit, tip), role);
    for (const name of names) {
      assert.equal(
        gitText(["log", "-1", "--format=%H", tip, "--", H4 + name]),
        pin.commit,
        name,
      );
      const row = prep.setupReadings.source.pins
        .find((p) => p.role === role)
        .files.find((file) => file.path === H4 + name);
      assert.equal(
        row.sha256,
        sha256(
          execFileSync("git", ["show", `${pin.commit}:${H4}${name}`], {
            cwd: repoRoot,
          }),
        ),
        name,
      );
    }
  }
});

test("S2 追補 #5 (P2-2): a changed sha256 of each added file fails the git check", async (t) => {
  const ctx = await context();
  if (!ctx.sourcePinGit) {
    t.skip("shallow clone");
    return;
  }
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const pins = prep.setupReadings.source.pins;
  const { head } = ctx.sourcePinGit;
  let mutated = 0;
  for (const [role, names] of Object.entries(ADDENDUM5_FILES))
    for (const name of names) {
      const copy = clone(pins);
      const row = copy
        .find((p) => p.role === role)
        .files.find((file) => file.path === H4 + name);
      row.sha256 = flip(row.sha256);
      assert.ok(
        sourcePinGitErrors(copy, head, ctx.sourcePinGit).some((e) =>
          e.includes(`${H4}${name} at `),
        ),
        name,
      );
      mutated += 1;
    }
  assert.equal(mutated, 36);
});

test("S2 追補 #5 (P3-1): K24-G01-N4 makes its draft version as the harness does (saveSceneContent, then createRevision)", async () => {
  const ctx = await context();
  const addendum = await json(OBSERVATION_PREP_FILES.setupAddendum);
  assert.deepEqual(setupAddendumErrors(addendum, ctx), []);
  const n4 = addendum.diagnosticNegatives.find(
    (row) => row.id === "K24-G01-N4",
  );
  assert.equal(
    n4.beforeDeclarationWriter,
    "saveSceneContent-then-createRevision",
  );
  const check = (copy) => setupAddendumErrors(copy, ctx);
  const N4 = (mutate) =>
    detects(
      addendum,
      check,
      (a) =>
        mutate(a.diagnosticNegatives.find((row) => row.id === "K24-G01-N4")),
      /K24-G01-N4 must save the draft body/u,
    );
  N4((row) => (row.beforeDeclarationWriter = "saveSceneContent"));
  N4(
    (row) =>
      (row.beforeDeclaration = row.beforeDeclaration.replaceAll(
        "createRevision",
        "保存",
      )),
  );
  N4(
    (row) =>
      (row.beforeDeclaration = row.beforeDeclaration.replaceAll(
        "saveSceneContent",
        "保存",
      )),
  );
});

// ---- S2 追補 #6（#757 の後の pin し直し、SP-P4 の C1〜C3 の in force、P3-2。DR-CP4-P-3） ----

test("S2 追補 #8（DR-CP4-Q-2）: ir-complete-pairs carries the pinned pair limit SP_P4_IR_TIMEOUT_PAIR_LIMIT (S3's 24-pair minimum) and its receipt fields", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.deepEqual(observationPrepErrors(prep, ctx), []);
  assert.equal(ctx.harnessConstants.SP_P4_IR_TIMEOUT_PAIR_LIMIT, 6);
  const pairsOf = (p) =>
    p.diagnosticRuns
      .find((row) => row.id === "SP-P4")
      .comparisonRule.rules.find((row) => row.id === "ir-complete-pairs");
  const ruleOf = (p) =>
    p.diagnosticRuns.find((row) => row.id === "SP-P4").comparisonRule;
  const pairs = pairsOf(prep);
  assert.equal(pairs.timeoutPairLimit, 6);
  assert.equal(pairs.timeoutPairLimitConstant, "SP_P4_IR_TIMEOUT_PAIR_LIMIT");
  // C2 は現在形の事実（側ごとの上限と組の上限）。経緯（最少 18 の取り違え）は history。
  for (const word of [
    "組の上限",
    "組の最少 24",
    "各側に IR を比べる sample が 24 以上",
  ])
    assert.ok(pairs.conditions.C2.includes(word), word);
  for (const word of ["最少 18", "最小数"])
    assert.ok(!pairs.conditions.C2.includes(word), word);
  assert.ok(pairs.history.includes("最少 18"));
  assert.ok(pairs.history.includes("#759（DR-CP4-Q-2）"));
  const check = (copy) => observationPrepErrors(copy, ctx);
  const PAIR = /must carry the pair limit/u;
  detects(prep, check, (p) => (pairsOf(p).timeoutPairLimit = 7), PAIR);
  detects(prep, check, (p) => delete pairsOf(p).timeoutPairLimit, PAIR);
  detects(
    prep,
    check,
    (p) =>
      (pairsOf(p).conditions.C2 = pairsOf(p).conditions.C2.replace(
        "SP_P4_IR_TIMEOUT_PAIR_LIMIT（6）",
        "SP_P4_IR_TIMEOUT_PAIR_LIMIT（7）",
      )),
    PAIR,
  );
  detects(
    prep,
    check,
    (p) =>
      (pairsOf(p).text = pairsOf(p).text.replaceAll(
        "ir-timeout-pair-limit",
        "",
      )),
    PAIR,
  );
  detects(
    prep,
    check,
    (p) =>
      (ruleOf(p).harnessConstant = ruleOf(p).harnessConstant.replaceAll(
        "SP_P4_IR_TIMEOUT_PAIR_LIMIT",
        "",
      )),
    PAIR,
  );
  // 定数が pin の bytes から読めない（または違う）と閉じる。
  for (const value of [undefined, 7]) {
    const errors = observationPrepErrors(prep, {
      ...ctx,
      harnessConstants: {
        ...ctx.harnessConstants,
        SP_P4_IR_TIMEOUT_PAIR_LIMIT: value,
      },
    });
    assert.ok(
      errors.some((e) => PAIR.test(e)),
      String(value),
    );
  }
  // C2 の語（組の上限、S3 の組の最少 24）と、規則の形（理由、開示の欄）。
  const C123 = /comparisonRule must put ir-complete-pairs in force/u;
  for (const word of ["組の上限", "組の最少 24", "SP_P4_IR_TIMEOUT_PAIR_LIMIT"])
    detects(
      prep,
      check,
      (p) =>
        (pairsOf(p).conditions.C2 = pairsOf(p).conditions.C2.replaceAll(
          word,
          "",
        )),
      C123,
    );
  const SHAPE = /comparisonRule ir-complete-pairs must be C1/u;
  detects(
    prep,
    check,
    (p) =>
      (pairsOf(p).undefinedReasons = [
        "ir-timeout-limit",
        "no-ir-complete-pair",
      ]),
    SHAPE,
  );
  detects(
    prep,
    check,
    (p) =>
      (pairsOf(p).disclose = pairsOf(p).disclose.filter(
        (key) => key !== "timeoutPairLimit",
      )),
    SHAPE,
  );
  detects(prep, check, (p) => delete pairsOf(p).onOverTimeoutPairLimit, SHAPE);
  const READING = /comparisonRule\.receiptReading must read/u;
  for (const [key, field] of [
    ["design", "irTimeoutPairLimit"],
    ["attemptIrMeasured", "timeoutPairLimit"],
    ["comparison", "irExcludedPairs"],
    ["comparison", "irTimeoutPairLimit"],
  ])
    detects(
      prep,
      check,
      (p) =>
        (ruleOf(p).receiptReading[key] = ruleOf(p).receiptReading[key].filter(
          (name) => name !== field,
        )),
      READING,
    );
});

test("S2 追補 #6: the SP-P4 receipt reading and C1 are the pinned harness's (spP4ReceiptDesign, spP4IrDisclosure, assertSpP4WorkspaceStable, compareSpP4Variant, spP4IrTimeoutExcluded)", async () => {
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const p4 = prep.diagnosticRuns.find((row) => row.id === "SP-P4");
  const reading = p4.comparisonRule.receiptReading;
  const pairs = p4.comparisonRule.rules.find(
    (row) => row.id === "ir-complete-pairs",
  );
  const d = await import("../nir1-graph-eval/frozen-diagnostics.mjs");
  const { spP4ReceiptDesign } =
    await import("../nir1-graph-eval/diagnostic-runner.mjs");
  // 作業 tree の harness は pin の bytes と同じ（import した関数が pin の挙動）。
  // S2 追補 #8: frozen-diagnostics.mjs と diagnostic-runner.mjs は #759 の pin にある。
  for (const [name, role] of [
    ["frozen-diagnostics.mjs", "sp-p4-ir-pair-limit"],
    ["diagnostic-runner.mjs", "sp-p4-ir-pair-limit"],
  ]) {
    const pin = harnessPinOf(H4 + name);
    assert.equal(pin.role, role);
    const held = prep.setupReadings.source.pins
      .find((row) => row.role === pin.role)
      .files.find((file) => file.path === H4 + name);
    assert.equal(
      sha256(readFileSync(path.join(repoRoot, H4 + name))),
      held.sha256,
    );
  }
  const design = spP4ReceiptDesign({
    targets: [{ variantKey: "G-01/v1" }],
    warmup: 5,
    measured: 30,
  });
  for (const key of reading.design) assert.ok(Object.hasOwn(design, key), key);
  assert.equal(design.rule, p4.comparisonRule.inForce);
  assert.equal(design.irTimeoutLimit, pairs.timeoutLimit);
  assert.equal(design.irTimeoutPairLimit, pairs.timeoutPairLimit);
  const row = (repeat, outcome = "ir-ready", patch = {}) => ({
    phase: "measured",
    repeat,
    rSceneIds: ["s1", "s2"],
    denseHitSceneIds: ["s1"],
    sparseSceneIds: ["s2"],
    rIrSceneIds: ["s1", "s2"],
    irSupplementSceneId: null,
    ir: { outcome, deadlineExceeded: outcome === "timeout" },
    ...patch,
  });
  const samples = (timeouts, count = 30) => [
    { phase: "warmup", repeat: 0, ir: { outcome: "ir-ready" } },
    ...Array.from({ length: count }, (_, at) =>
      row(at + 1, at < timeouts ? "timeout" : "ir-ready"),
    ),
  ];
  assert.deepEqual(
    Object.keys(d.spP4IrDisclosure(samples(2)).measured),
    reading.attemptIrMeasured,
  );
  assert.deepEqual(
    Object.keys(d.assertSpP4WorkspaceStable(samples(2), "x")),
    reading.sideStability,
  );
  // K 件までは比べ、K+1 件で ir-timeout-limit、IR を比べる組が 0 件で no-ir-complete-pair。
  const K = pairs.timeoutLimit;
  const compare = (left, right) =>
    d.compareSpP4Variant({ variantKey: "G-01/v1", without: left, with: right });
  assert.equal(compare(samples(K), samples(0)).same, true);
  const over = compare(samples(K + 1), samples(0));
  assert.equal(over.undefinedReason, pairs.undefinedReasons[0]);
  for (const key of reading.comparison)
    assert.ok(Object.hasOwn(over, key), key);
  const none = compare(samples(K, K), samples(0, K));
  assert.equal(none.undefinedReason, "no-ir-complete-pair");
  // S2 追補 #8（DR-CP4-Q-2）: 組の上限。別の位置で外れた組が上限を超えると
  // ir-timeout-pair-limit、同じ位置なら組の除外は側の数のまま。
  assert.deepEqual(pairs.undefinedReasons, [
    "ir-timeout-limit",
    "ir-timeout-pair-limit",
    "no-ir-complete-pair",
  ]);
  const P = pairs.timeoutPairLimit;
  const at = (positions, count = 30) => [
    { phase: "warmup", repeat: 0, ir: { outcome: "ir-ready" } },
    ...Array.from({ length: count }, (_, i) =>
      row(i + 1, positions.includes(i) ? "timeout" : "ir-ready"),
    ),
  ];
  const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
  const sameSpots = compare(at(range(0, K)), at(range(0, K)));
  assert.equal(sameSpots.same, true);
  assert.equal(sameSpots.irExcludedPairs, K);
  assert.equal(sameSpots.irTimeoutPairLimit, P);
  const half = Math.floor(P / 2);
  assert.equal(compare(at(range(0, half)), at(range(10, P - half))).same, true);
  const split = compare(at(range(0, half)), at(range(10, P - half + 1)));
  assert.equal(split.undefinedReason, "ir-timeout-pair-limit");
  assert.equal(split.irExcludedPairs, P + 1);
  assert.equal(30 - P, 24);
  assert.equal(
    d.spP4IrDisclosure(samples(2)).measured.timeoutPairLimit,
    pairs.timeoutPairLimit,
  );
  assert.throws(
    () => d.assertSpP4WorkspaceStable(samples(K + 1), "x"),
    /more than 6/u,
  );
  // C1 の 4 つの条件（S2 の irExcludedWhen）と harness の spP4IrTimeoutExcluded。
  const when = pairs.irExcludedWhen;
  assert.equal(when.outcome, "timeout");
  const base = row(1, when.outcome);
  assert.equal(d.spP4IrTimeoutExcluded(base), true);
  for (const flipped of [
    row(1, "failed", { ir: { outcome: "failed", deadlineExceeded: true } }),
    row(1, "timeout", { ir: { outcome: "timeout", deadlineExceeded: false } }),
    row(1, "timeout", { rIrSceneIds: ["s2", "s1"] }),
    row(1, "timeout", { irSupplementSceneId: "s3" }),
  ])
    assert.equal(d.spP4IrTimeoutExcluded(flipped), false);
  // 外さない非 ready（failed）は current と同じに比べる（片側だけなら違いが残る）。
  const failed = samples(0).map((sample, at) =>
    at === 1
      ? { ...sample, rIrSceneIds: ["s1"], ir: { outcome: "failed" } }
      : sample,
  );
  assert.equal(compare(failed, samples(0)).same, false);
});

test("S2 追補 #6 (P3-2): retry.rule and graphTries are the harness's re-ask disclosure (every try's counters and cached, the discarded takes' Scenes), never judged", async () => {
  const ctx = await context();
  const addendum = await json(OBSERVATION_PREP_FILES.setupAddendum);
  assert.deepEqual(setupAddendumErrors(addendum, ctx), []);
  const retry = addendum.afterMutationReadings.retry;
  // harness の askUntilDecided の各回の欄（g01-negatives.mjs、s5b の pin）。
  const { askUntilDecided } =
    await import("../nir1-graph-eval/g01-negatives.mjs");
  let reads = 0;
  const asked = await askUntilDecided({
    ask: async () => ({
      parent: { graphOutcome: reads > 2 ? "graph-ready" : "late" },
    }),
    limit: 3,
    gapMs: 0,
    readCounters: async () => ({
      begins: ++reads,
      cacheHits: 0,
      lateCached: reads,
    }),
    sleep: async () => {},
  });
  assert.equal(asked.tries.length, 2);
  for (const key of retry.graphTries.perTry)
    assert.ok(Object.hasOwn(asked.tries[0], key), key);
  assert.deepEqual(
    Object.keys(asked.tries[0].counters),
    retry.graphTries.counters,
  );
  assert.equal(asked.tries[0].cached, true);
  // askGraph が graphTries に残す欄（g01-negative-run.mjs、sp-p4-ir-timeout の pin の bytes）。
  const pin = harnessPinOf(`${H4}g01-negative-run.mjs`);
  assert.equal(pin.role, "sp-p4-ir-timeout");
  const text = execFileSync(
    "git",
    ["show", `${pin.commit}:${H4}g01-negative-run.mjs`],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  const pushed = text.slice(text.indexOf("state.graphTries.push({"));
  for (const key of retry.graphTries.sample)
    assert.match(pushed.slice(0, 400), new RegExp(`\\b${key}\\b`, "u"), key);
  const discarded = text.slice(text.indexOf("const discarded = takes"));
  for (const key of retry.graphTries.discarded)
    assert.match(discarded.slice(0, 900), new RegExp(`\\b${key}\\b`, "u"), key);
  assert.ok(text.includes("readCounters: state.readCounters"));
  assert.ok(text.includes("...(row?.followUp?.child?.finalSceneIds ?? [])"));
  // 変異: 文の欄名を落とす、開示の欄を変える、判定に使う。
  const check = (copy) => setupAddendumErrors(copy, ctx);
  const R = (mutate) =>
    detects(
      addendum,
      check,
      (a) => mutate(a.afterMutationReadings.retry),
      /retry/u,
    );
  for (const word of [
    "graphTries",
    "counters",
    "cached",
    "returnedSceneIds",
    "declaredSceneReturned",
    "判定には使わない",
  ])
    R((r) => (r.rule = r.rule.replaceAll(word, "")));
  R((r) => (r.graphTries.judged = true));
  R((r) => r.graphTries.discarded.pop());
  R((r) => r.graphTries.counters.pop());
  R((r) => r.graphTries.perTry.splice(3, 1));
  R((r) => r.graphTries.sample.shift());
  R((r) => (r.graphTries.countersFrom = "declaration-main"));
  R((r) => (r.graphTries.returnedSceneIds = "runtime"));
  R((r) => delete r.graphTries);
});

// ---- S2 追補 #7（#758 への pin し直し、harness の外の eval 専用 script の pin、S4 の手順。DR-CP4-P-4） ----

/**
 * S2 追補 #7: 正式の入口の閉包を harness の directory の外までたどる。相対の静的な
 * import（と動的な import、cp4-harness.html の script）はどの directory でもたどり、
 * harness の path の文字列はどの file でも、renderer/… の文字列は harness の file
 * だけでたどる。共有の CI 基盤と製品（isSharedClosureBoundary）の file は境界として
 * 記録し、その先はたどらない。bare な specifier（node:…、package、alias）はたどらない。
 */
function evalClosure(root, entries) {
  const dir = path.join(root, H4);
  const seen = new Set();
  const boundaries = new Set();
  const stack = entries.map((entry) => path.join(dir, entry));
  const exists = (file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !exists(file)) continue;
    const relative = path.relative(root, file);
    if (isSharedClosureBoundary(relative)) {
      boundaries.add(relative);
      continue;
    }
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']|<script[^>]*\ssrc=["']([^"']+)["']/gu,
    )) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!spec.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), spec);
      stack.push(
        ["", ".mjs", ".ts", ".tsx", ".js"]
          .map((ext) => base + ext)
          .find(exists) ?? base,
      );
    }
    for (const m of text.matchAll(
      /["'`](scripts\/quality\/nir1-graph-eval\/[\w./-]+\.(?:mjs|ts|tsx|html))["'`]/gu,
    ))
      stack.push(path.join(root, m[1]));
    if (file.startsWith(dir))
      for (const m of text.matchAll(
        /["'`/](renderer\/[\w.-]+\.(?:ts|tsx|html))["'`]/gu,
      ))
        stack.push(path.join(dir, m[1]));
  }
  return {
    files: [...seen].map((file) => path.relative(root, file)).sort(),
    boundaries: [...boundaries].sort(),
  };
}

/** S2 追補 #7 で足した harness の外の eval 専用 script（role ごと）。 */
const ADDENDUM7_OUTSIDE = Object.freeze({
  "s4-rehearsal-admission": ["scripts/quality/nir1-retrieval/contract.mjs"],
  "p1-harness-core": [
    "scripts/quality/nir1-retrieval/standard-build-receipt.mjs",
  ],
  "p2p3-harness-admission": [
    "scripts/quality/nir1-retrieval/standard-build.mjs",
  ],
  "nir1-retrieval-ir-base": [
    "scripts/quality/nir1-retrieval/acceptance-policy.mjs",
    "scripts/quality/nir1-retrieval/candidate-policy.mjs",
  ],
  "cp0-graph-eval-freeze": [
    "scripts/quality/nir1-graph/porter.mjs",
    "scripts/quality/nir1-retrieval/paired.mjs",
  ],
  "da1-route-isolation": ["scripts/quality/run-nir1-retrieval.mjs"],
  // S2 追補 #11: nir1-graph/contract.mjs は G-04 v2 の pin に移った（cq-lim-graph-limits
  // は ancestor の pin になった）。
  "g4-b1-post-observation-freeze": ["scripts/quality/nir1-graph/contract.mjs"],
  "dp-h-unknown-scope": [
    "scripts/quality/nir1-packing/final-request/architecture.mjs",
  ],
});
/** S2 追補 #7 で除外した共有の CI 基盤と製品（閉包の境界）。増えたら落ちる。 */
const ADDENDUM7_EXCLUDED = Object.freeze([
  "electron/main/rendererContainment.ts",
  "electron/main/rendererContainmentListener.ts",
  "electron/main/rendererContainmentStartup.ts",
  "electron/scripts/build.mjs",
  "scripts/local-ci-process-supervisor.mjs",
]);

test("S2 追補 #7: the formal entries' eval closure outside the harness directory is pinned, and only the fixed shared CI and product files are excluded", () => {
  const { files, boundaries } = evalClosure(repoRoot, FORMAL_HARNESS_ENTRIES);
  const outside = files.filter((file) => !file.startsWith(H4));
  const added = Object.values(ADDENDUM7_OUTSIDE).flat().sort();
  assert.equal(added.length, 10);
  assert.deepEqual(outside, added);
  // 閉包の harness の file は追補 #5 の 61 file と同じ（外からの戻りは無い）。
  assert.deepEqual(
    files.filter((file) => file.startsWith(H4)),
    harnessClosure(repoRoot, FORMAL_HARNESS_ENTRIES),
  );
  assert.ok(
    files.every((file) => !/\.test\.mjs$|test-support\.mjs$/u.test(file)),
  );
  assert.deepEqual(unpinned(files, SOURCE_PINS), []);
  // 除外は固定の一覧（validator の EVAL_CLOSURE_EXCLUSIONS と試験の写し）で、どれも pin しない。
  assert.deepEqual(boundaries, [...ADDENDUM7_EXCLUDED]);
  assert.deepEqual([...EVAL_CLOSURE_EXCLUSIONS], [...ADDENDUM7_EXCLUDED]);
  const held = new Set(SOURCE_PINS.flatMap((pin) => pin.paths));
  for (const file of ADDENDUM7_EXCLUDED) {
    assert.ok(isSharedClosureBoundary(file), file);
    assert.ok(!held.has(file), file);
  }
  for (const file of added) {
    assert.ok(!isSharedClosureBoundary(file), file);
    assert.equal(
      harnessPinOf(file)?.role,
      Object.keys(ADDENDUM7_OUTSIDE).find((role) =>
        ADDENDUM7_OUTSIDE[role].includes(file),
      ),
      file,
    );
  }
  // 変異: 足した file を pin から外す（10 file のそれぞれ）。
  for (const [role, names] of Object.entries(ADDENDUM7_OUTSIDE))
    for (const name of names) {
      const pins = SOURCE_PINS.map((pin) =>
        pin.role === role
          ? { ...pin, paths: pin.paths.filter((file) => file !== name) }
          : pin,
      );
      assert.deepEqual(unpinned(files, pins), [name], name);
    }
  // 変異: harness の外の新しい eval 専用 script が閉包に入る（pin に無い）。
  assert.deepEqual(
    unpinned(
      [...files, "scripts/quality/nir1-retrieval/new-helper.mjs"],
      SOURCE_PINS,
    ),
    ["scripts/quality/nir1-retrieval/new-helper.mjs"],
  );
});

test("S2 追補 #7: the eval closure stops at a shared CI or product file and a new one changes the fixed exclusions (synthetic repository)", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "s2-closure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (relative, text) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  };
  put(
    `${H4}entry.mjs`,
    'import "./inner.mjs";\nimport { x } from "../nir1-retrieval/eval.mjs";\nimport "node:fs";\n',
  );
  put(`${H4}inner.mjs`, 'import "../../local-ci-new.mjs";\n');
  put(
    "scripts/quality/nir1-retrieval/eval.mjs",
    'import "./more.mjs";\nimport "../../../electron/main/x.ts";\nconst p = "scripts/quality/nir1-graph-eval/late.mjs";\n',
  );
  put("scripts/quality/nir1-retrieval/more.mjs", "export const y = 1;\n");
  put(`${H4}late.mjs`, "export const z = 1;\n");
  put("scripts/local-ci-new.mjs", 'import "./quality/never.mjs";\n');
  put("scripts/quality/never.mjs", "export const n = 1;\n");
  put("electron/main/x.ts", "export const e = 1;\n");
  const { files, boundaries } = evalClosure(root, ["entry.mjs"]);
  assert.deepEqual(files, [
    "scripts/quality/nir1-graph-eval/entry.mjs",
    "scripts/quality/nir1-graph-eval/inner.mjs",
    "scripts/quality/nir1-graph-eval/late.mjs",
    "scripts/quality/nir1-retrieval/eval.mjs",
    "scripts/quality/nir1-retrieval/more.mjs",
  ]);
  // 境界の先（local-ci-new.mjs が import する never.mjs）はたどらない。
  assert.deepEqual(boundaries, [
    "electron/main/x.ts",
    "scripts/local-ci-new.mjs",
  ]);
  // 変異: 除外した共有基盤が閉包に増える → 固定の一覧と違う（試験が落ちる）。
  assert.notDeepEqual(
    [...ADDENDUM7_EXCLUDED, "scripts/local-ci-new.mjs"].sort(),
    [...ADDENDUM7_EXCLUDED],
  );
  assert.ok(isSharedClosureBoundary("src/lib/x.ts"));
  assert.ok(
    !isSharedClosureBoundary("scripts/quality/nir1-graph/contract.mjs"),
  );
});

test("S2 追補 #7: the record's closureExclusions are the fixed shared CI and product files with reasons, none of them pinned", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.deepEqual(observationPrepErrors(prep, ctx), []);
  assert.deepEqual(
    prep.setupReadings.source.closureExclusions.map((row) => row.path),
    [...ADDENDUM7_EXCLUDED],
  );
  const check = (copy) => observationPrepErrors(copy, ctx);
  const X = (mutate) =>
    detects(
      prep,
      check,
      (p) => mutate(p.setupReadings.source),
      /setupReadings\.source\.closureExclusions must be/u,
    );
  X((s) => s.closureExclusions.pop());
  X((s) =>
    s.closureExclusions.push({ path: "scripts/local-ci.mjs", reason: "x" }),
  );
  X((s) => (s.closureExclusions[0].reason = " "));
  X(
    (s) =>
      (s.closureExclusions[4].path =
        "scripts/quality/nir1-retrieval/paired.mjs"),
  );
  X((s) => delete s.closureExclusions);
  // 除外した file を pin に置く（記録と SOURCE_PINS の両方で落ちる）。
  detects(
    prep,
    check,
    (p) =>
      p.setupReadings.source.pins
        .find((row) => row.role === "da1-route-isolation")
        .files.push({ path: ADDENDUM7_EXCLUDED[4], sha256: "0".repeat(64) }),
    /setupReadings\.source\.closureExclusions must be/u,
  );
  // 記録から足した file を外すと pins の照合が落ちる。
  for (const [role, names] of Object.entries(ADDENDUM7_OUTSIDE))
    detects(
      prep,
      check,
      (p) => {
        const pin = p.setupReadings.source.pins.find(
          (row) => row.role === role,
        );
        pin.files = pin.files.filter((file) => file.path !== names[0]);
      },
      /setupReadings\.source\.pins must be/u,
    );
});

test("S2 追補 #7: each added eval script and each #758 file is pinned at the master commit that last changed it with that commit's bytes; a changed sha256 fails", async (t) => {
  const ctx = await context();
  if (!ctx.sourcePinGit) {
    t.skip("shallow clone: the commits are checked by the formal gate");
    return;
  }
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const pins = prep.setupReadings.source.pins;
  const master = gitText(["rev-parse", "refs/remotes/origin/master"]);
  const rehearsal = SOURCE_PINS.find(
    (pin) => pin.role === "s4-rehearsal-admission",
  );
  assert.equal(rehearsal.commit, "82d427465b16a12809c6f93adad74ac97859c85a");
  // S2 追補 #11: #758 の frozen-k64-admission.mjs と trace-frozen.mjs は G-04 v2 の
  // pin に移った（枝の pin は、S4 の PR の merge の前は記録の HEAD で最後に変えた commit）。
  const targets = {
    ...ADDENDUM7_OUTSIDE,
    "s4-rehearsal-admission": rehearsal.paths,
    "g4-b2a-declaration-v2-path": [`${H4}trace-frozen.mjs`],
    "g4-b2b1-addendum-v2-paths": [`${H4}frozen-k64-admission.mjs`],
  };
  let mutated = 0;
  for (const [role, files] of Object.entries(targets)) {
    const pin = SOURCE_PINS.find((row) => row.role === role);
    assert.equal(pin.check, "bytes", role);
    const tip =
      BRANCH_PIN_ROLES.has(role) &&
      !ctx.sourcePinGit.isAncestor(pin.commit, master)
        ? ctx.sourcePinGit.head
        : master;
    assert.ok(ctx.sourcePinGit.isAncestor(pin.commit, tip), role);
    for (const file of files) {
      assert.equal(
        gitText(["log", "-1", "--format=%H", tip, "--", file]),
        pin.commit,
        file,
      );
      const at = pins.findIndex((row) => row.role === role);
      const index = pins[at].files.findIndex((row) => row.path === file);
      assert.equal(
        pins[at].files[index].sha256,
        sha256(
          execFileSync("git", ["show", `${pin.commit}:${file}`], {
            cwd: repoRoot,
          }),
        ),
        file,
      );
      const copy = clone(pins);
      copy[at].files[index].sha256 = flip(copy[at].files[index].sha256);
      assert.ok(
        sourcePinGitErrors(copy, ctx.sourcePinGit.head, ctx.sourcePinGit).some(
          (e) => e.includes(`${file} at ${pin.commit} is not the pinned bytes`),
        ),
        file,
      );
      mutated += 1;
    }
  }
  // S2 追補 #8: diagnostic-runner.mjs は #759 の pin へ移った（13 file）。
  assert.equal(mutated, 13);
  // 移した file を旧い pin（950751d0、43e3f40b、82d42746）の bytes と比べると落ちる。
  for (const [name, old, role] of [
    [
      "admission.mjs",
      "950751d040b29b6d78a067a003dc19b196cfb692",
      "s4-rehearsal-admission",
    ],
    // S2 追補 #11: G-04 v2 の pin に移った 3 file を元の pin の bytes と比べると落ちる。
    [
      "frozen-k64-admission.mjs",
      "82d427465b16a12809c6f93adad74ac97859c85a",
      "g4-b2b1-addendum-v2-paths",
    ],
    [
      "trace-frozen.mjs",
      "82d427465b16a12809c6f93adad74ac97859c85a",
      "g4-b2a-declaration-v2-path",
    ],
    [
      "constants.mjs",
      "9e1a564efe5d7ac9d72d3c4008a6d9677b2b6d6f",
      "g4-b1-freeze-v2-constants",
    ],
    [
      "diagnostic-runner.mjs",
      "82d427465b16a12809c6f93adad74ac97859c85a",
      "sp-p4-ir-pair-limit",
    ],
    [
      "frozen-diagnostics.mjs",
      "43e3f40b5d653c62d5aca4ca795917b67310992c",
      "sp-p4-ir-pair-limit",
    ],
  ]) {
    const copy = clone(pins);
    const row = copy.find((p) => p.role === role);
    row.commit = old;
    assert.ok(
      sourcePinGitErrors(copy, ctx.sourcePinGit.head, ctx.sourcePinGit).some(
        (e) => e.includes(`${H4}${name} at ${old} is not the pinned bytes`),
      ),
      name,
    );
  }
});

test("S2 追補 #7 (DR-CP4-S4-1): s4StagesRule states S4's procedure (merge commit of claude/nir1-contracts, merge-commit PR, the integrator's formal gate on S4b, the entries' read against the freeze record)", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  assert.deepEqual(observationPrepErrors(prep, ctx), []);
  // S2 追補 #9（DR-CP4-S4-5）: (e) the re-freeze. S2 追補 #10（DR-CP4-S4-6）:
  // (f) the third re-freeze. S2 追補 #11（DR-CP4-S4-7）: (g) the fourth.
  assert.deepEqual(Object.keys(S4_PROCEDURE_WORDS), [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
  ]);
  let mutated = 0;
  for (const [item, words] of Object.entries(S4_PROCEDURE_WORDS))
    for (const word of words) {
      assert.ok(prep.s4StagesRule.includes(word), word);
      detects(
        prep,
        (copy) => observationPrepErrors(copy, ctx),
        (p) => (p.s4StagesRule = p.s4StagesRule.replaceAll(word, "")),
        new RegExp(`s4StagesRule must state S4's procedure \\(${item}\\)`, "u"),
      );
      mutated += 1;
    }
  assert.equal(mutated, 32);
  detects(
    prep,
    (copy) => observationPrepErrors(copy, ctx),
    (p) => delete p.s4StagesRule,
    /s4StagesRule must state S4's procedure \(a\)/u,
  );
});

test("S2 追補 #10（DR-CP4-P-6）: traceRunnerReadings copy DR-CP4-V-2〜V-4 (TP-1〜TP-7), bind the trace runner to the four V-2〜V-4 pins and disclose editing's lapse (i), the rules chosen after the first trace and the observation before this freeze", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const check = (copy) => observationPrepErrors(copy, ctx);
  assert.deepEqual(check(prep), []);
  const readings = prep.traceRunnerReadings;
  assert.deepEqual(
    readings.items.map((row) => row.id),
    ["TP-1", "TP-2", "TP-3", "TP-4", "TP-5", "TP-6", "TP-7"],
  );
  // 変異: 欄を消す、item を消す・入れ替える、出所の DR を消す、読みを空にする。
  detects(
    prep,
    check,
    (p) => delete p.traceRunnerReadings,
    /traceRunnerReadings is required/u,
  );
  detects(
    prep,
    check,
    (p) => p.traceRunnerReadings.items.pop(),
    /traceRunnerReadings\.items must be/u,
  );
  detects(
    prep,
    check,
    (p) => p.traceRunnerReadings.items.reverse(),
    /traceRunnerReadings\.items must be/u,
  );
  for (const at of readings.items.keys()) {
    detects(
      prep,
      check,
      (p) => (p.traceRunnerReadings.items[at].decision = "DR-CP4-T-1"),
      /traceRunnerReadings\.items must be/u,
    );
    detects(
      prep,
      check,
      (p) => (p.traceRunnerReadings.items[at].reading = " "),
      /traceRunnerReadings\.items must be/u,
    );
  }
  // 変異: rule から pin の role を 1 つずつ消す。
  for (const role of [
    "v2-trace-probe-paths",
    "v4-trace-record-requery",
    "v4-followup-cancelled-match",
    "v4-trace-runner-quote-guard",
  ]) {
    assert.ok(readings.rule.includes(role), role);
    assert.ok(
      SOURCE_PINS.some((pin) => pin.role === role),
      `${role} is a pin`,
    );
    detects(
      prep,
      check,
      (p) =>
        (p.traceRunnerReadings.rule = p.traceRunnerReadings.rule.replaceAll(
          role,
          "",
        )),
      /traceRunnerReadings\.rule must bind/u,
    );
  }
  // 変異: limits の開示の語を 1 つずつ消す。
  for (const word of [
    "失効 (i)",
    "DR-BSEAM-5",
    "HOLD または [precheck]",
    "見た後",
    "成功の方向へ動く判定は無い",
    "graphRuntimeObservedBeforeFreeze",
    "8913f127",
    "advisor に諮ったのは 2 つだけ",
    "別 lane への報告（未確認）",
    "invalid → valid",
    "prep の Main の stderr",
    "acc5ec71c4af240b7455341e623f0ca9fb4df7b9",
  ]) {
    assert.ok(readings.limits.includes(word), word);
    detects(
      prep,
      check,
      (p) =>
        (p.traceRunnerReadings.limits = p.traceRunnerReadings.limits.replaceAll(
          word,
          "",
        )),
      /traceRunnerReadings\.limits must disclose/u,
    );
  }
});

test("S2 追補 #11（DR-CP4-P-7）: S2 binds G-04 v2 (freeze.v2, the three new addendum versions, the four G-04 v2 pins) and g04RevisionReadings disclose (a)〜(h)", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const check = (copy) => observationPrepErrors(copy, ctx);
  assert.deepEqual(check(prep), []);
  // 葉ごとの判断（DR-CP4-P-7 (2)）: v2 に直した葉。
  assert.deepEqual(prep.references.graphCaseFreeze, {
    path: "evals/nir1-graph/freeze.v2.json",
    sha256: "8958dc736d67418cab4c183ab68131f723536bcc72cdf96944cd39e3fd4b127d",
  });
  assert.deepEqual(prep.d1.addenda, [
    "evals/nir1-g01/setup-addendum.v2.json",
    "evals/nir1-graph/declaration-addendum.v2.json",
  ]);
  assert.ok(prep.d1.runs.includes("G-04/base"));
  const g04 = prep.diagnosticRuns.find((row) => row.id === "K24-G04-N1");
  assert.equal(g04.source, "evals/nir1-graph/declaration-addendum.v2.json");
  assert.ok(
    prep.diagnosticRuns
      .find((row) => row.id === "SP-P4")
      .source.startsWith("evals/nir1-graph/seed-pin-addendum.v2.json"),
  );
  assert.ok(
    prep.r5Gate.currentFinding.includes(
      "evals/nir1-graph/seed-pin-addendum.v2.json",
    ),
  );
  assert.ok(
    prep.runnerHandoff[20].includes("evals/nir1-g01/setup-addendum.v2.json"),
  );
  for (const row of prep.placeholders)
    assert.ok(!/addendum\.v1\.json/u.test(row.fill), row.token);
  // v1 のまま残した葉（S3 が見た時点の事実）と、同じ path の freeze 記録。
  assert.ok(
    prep.reviewerQuestions[5].grounds[0].includes("seed-pin-addendum.v1.json"),
  );
  assert.ok(
    prep.reviewerQuestions[6].grounds[0].includes("setup-addendum.v1.json"),
  );
  assert.ok(prep.preconditions[3].includes("observation-prep-freeze.v1.json"));
  // 変異: 欄を消す、rule から pin の role と file を消す、limits の語を消す。
  detects(
    prep,
    check,
    (p) => delete p.g04RevisionReadings,
    /g04RevisionReadings is required/u,
  );
  const readings = prep.g04RevisionReadings;
  for (const word of [
    "g4-b1-post-observation-freeze",
    "g4-b1-freeze-v2-constants",
    "g4-b2a-declaration-v2-path",
    "g4-b2b1-addendum-v2-paths",
    "evals/nir1-graph/freeze.v2.json",
    "evals/nir1-graph/g04-scope-exact-unknown.v2.json",
    "96d44ec362f30352d6cb971c208f2ab71aed944d008cab9eb65ca2ab57c218e1",
    "evals/nir1-graph/declaration-addendum.v2.json",
    "evals/nir1-graph/seed-pin-addendum.v2.json",
    "evals/nir1-g01/setup-addendum.v2.json",
  ]) {
    assert.ok(readings.rule.includes(word), word);
    detects(
      prep,
      check,
      (p) =>
        (p.g04RevisionReadings.rule = p.g04RevisionReadings.rule.replaceAll(
          word,
          "",
        )),
      /g04RevisionReadings\.rule must bind/u,
    );
  }
  for (const role of [
    "g4-b1-post-observation-freeze",
    "g4-b1-freeze-v2-constants",
    "g4-b2a-declaration-v2-path",
    "g4-b2b1-addendum-v2-paths",
  ])
    assert.ok(
      SOURCE_PINS.some((pin) => pin.role === role),
      role,
    );
  detects(
    prep,
    check,
    (p) => (p.g04RevisionReadings.status = " "),
    /g04RevisionReadings\.rule must bind/u,
  );
  let words = 0;
  for (const word of [
    "557e683ccd884955e220f21bd15119f115995d29",
    "a7027915",
    "IR の recall の根拠にならない",
    "G-04-P2",
    "irSupplementedCoverage",
    "30/270",
    "作り直す",
    "S7 は v1 と v2 の両方を並べる",
    "5 件目",
    "README:265-266",
    "規則の改訂",
    "参照だけ",
    "結果の選択に使わない",
    "graphRuntimeObservedBeforeFreeze",
    "onFixtureRevision",
    "〔事実〕",
    "〔推測〕",
    // S4b''' の前の独立レビューの P2-2、P2-3、P3-2、C3。
    "独立コードレビュー",
    "v1 のまま",
    "trace-frozen.mjs:544-545",
    "K6/2 の手順 4",
    "K6/4 :317",
    "ユーザーの異議があれば止める",
  ]) {
    assert.ok(readings.limits.includes(word), word);
    detects(
      prep,
      check,
      (p) =>
        (p.g04RevisionReadings.limits = p.g04RevisionReadings.limits.replaceAll(
          word,
          "",
        )),
      /g04RevisionReadings\.limits must disclose/u,
    );
    words += 1;
  }
  assert.equal(words, 23);
  // 変異: d1.addenda、診断の run の source、SP-P4 の source を v1 に戻す。
  detects(
    prep,
    check,
    (p) => (p.d1.addenda[0] = "evals/nir1-g01/setup-addendum.v1.json"),
    /d1\.addenda must be/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.diagnosticRuns.find((row) => row.id === "K24-G04-N1").source =
        "evals/nir1-graph/declaration-addendum.v1.json"),
    /diagnosticRuns K24-G04-N1\.source must be/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.diagnosticRuns.find((row) => row.id === "K24-G01-N2").source =
        "evals/nir1-g01/setup-addendum.v1.json"),
    /diagnosticRuns K24-G01-N2\.source must be/u,
  );
  detects(
    prep,
    check,
    (p) =>
      (p.diagnosticRuns.find((row) => row.id === "SP-P4").source =
        "evals/nir1-graph/seed-pin-addendum.v1.json（SP/1 の受入れ SP-P4、SP-N7）"),
    /diagnosticRuns SP-P4\.source must be/u,
  );
  // S4b''' の前の独立レビューの P3-1: the path must be followed by the note
  // or the end, never by more of a path.
  for (const source of [
    "evals/nir1-graph/seed-pin-addendum.v2.json.bak",
    "evals/nir1-graph/seed-pin-addendum.v2.json.bak（SP/1 の受入れ SP-P4、SP-N7）",
    "evals/nir1-graph/seed-pin-addendum.v2.jsonx",
  ])
    detects(
      prep,
      check,
      (p) =>
        (p.diagnosticRuns.find((row) => row.id === "SP-P4").source = source),
      /diagnosticRuns SP-P4\.source must be/u,
    );
  for (const source of [
    "evals/nir1-graph/seed-pin-addendum.v2.json",
    "evals/nir1-graph/seed-pin-addendum.v2.json（SP/1 の受入れ SP-P4、SP-N7）",
  ]) {
    const copy = clone(prep);
    copy.diagnosticRuns.find((row) => row.id === "SP-P4").source = source;
    assert.ok(!check(copy).some((e) => /SP-P4\.source/u.test(e)), source);
  }
  // 変異: K24-G04-N1 を消すと診断の run の一覧が落ちる。
  detects(
    prep,
    check,
    (p) =>
      (p.diagnosticRuns = p.diagnosticRuns.filter(
        (row) => row.id !== "K24-G04-N1",
      )),
    /diagnosticRuns must be/u,
  );
});

test("S2 追補 #9（DR-CP4-T-1、T-3、T-5）: freshnessSettle copies the pinned harness's waits (setup 60 s／250 ms with maintenance stillness, measurement 15 s／100 ms) and maps the measurement's exhaustion to the existing blocked rows", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const check = (copy) => observationPrepErrors(copy, ctx);
  assert.deepEqual(check(prep), []);
  const settle = prep.setupReadings.freshnessSettle;
  assert.equal(
    settle.setup.waitMs,
    ctx.harnessConstants.FRESHNESS_SETTLE_WAIT_MS,
  );
  assert.equal(settle.measurement.waitMs, 15000);
  assert.equal(settle.measurement.intervalMs, 100);
  const word = /setupReadings\.freshnessSettle must wait/u;
  for (const mutate of [
    (p) => delete p.setupReadings.freshnessSettle,
    (p) => (p.setupReadings.freshnessSettle.setup.waitMs = 120000),
    (p) => (p.setupReadings.freshnessSettle.setup.intervalMs = 100),
    (p) => (p.setupReadings.freshnessSettle.measurement.waitMs = 60000),
    (p) => (p.setupReadings.freshnessSettle.measurement.intervalMs = 250),
    (p) => (p.setupReadings.freshnessSettle.setup.r5CheckWaits = true),
    (p) => p.setupReadings.freshnessSettle.setup.beforeExecutors.pop(),
    (p) => (p.setupReadings.freshnessSettle.setup.sessionEnd = false),
    (p) => (p.setupReadings.freshnessSettle.setup.onExhausted = "blocked"),
    (p) =>
      (p.setupReadings.freshnessSettle.setup.maintenanceOnExhausted =
        "[precheck]"),
    (p) => (p.setupReadings.freshnessSettle.setup.reopenTrigger = true),
    (p) =>
      (p.setupReadings.freshnessSettle.measurement.maintenanceStill = true),
    (p) =>
      (p.setupReadings.freshnessSettle.measurement.onExhaustedConditions[
        "while-variant"
      ] = "hold-and-precheck"),
    (p) => p.setupReadings.freshnessSettle.settledWhen.pop(),
    (p) => (p.setupReadings.freshnessSettle.readOnly = false),
    (p) => (p.setupReadings.freshnessSettle.setup.harnessConstants = []),
  ])
    detects(prep, check, mutate, word);
  // 定数は pin の bytes から読む（読めなければ照合できず落ちる）。
  const unread = { ...ctx, harnessConstants: { ...ctx.harnessConstants } };
  delete unread.harnessConstants.RUN_FRESHNESS_SETTLE_LIMIT_MS;
  assert.ok(observationPrepErrors(prep, unread).some((e) => word.test(e)));
  // 待ち切れは blocked の表の既存の 2 行（表は pin の bytes）。
  const table = ctx.harnessBlockedTable.map((row) =>
    row.harnessId === "index-build-timeout" && row.condition === "while-variant"
      ? { ...row, graphCases: "hold-and-precheck" }
      : row,
  );
  assert.ok(
    observationPrepErrors(prep, { ...ctx, harnessBlockedTable: table }).some(
      (e) =>
        /freshnessSettle\.measurement: the blocked table's index-build-timeout\/while-variant/u.test(
          e,
        ),
    ),
  );
  // 新しい受領書の欄。
  for (const key of [
    "freshnessSettles",
    "measurementPoint.freshnessFeed",
    "readBack.freshnessFeed",
    "readBack.maintenance",
  ])
    detects(
      prep,
      check,
      (p) => delete p.setupReadings.receiptFields[key],
      /setupReadings\.receiptFields/u,
    );
  // graph-index-unusable の C の作り直しは Freshness の処理の後（T-3）。
  detects(
    prep,
    check,
    (p) =>
      (p.d2.variantReadings.readAs.find(
        (row) => row.variant === "G-08/graph-index-unusable",
      ).readmeNote = "README :175 の読み"),
    /d2\.variantReadings/u,
  );
});

test("S2 追補 #9（DR-CP4-T-1）: the measurement process's constants are unexported module constants read once from the pinned bytes; the old bytes have none", () => {
  const text = execFileSync(
    "git",
    [
      "show",
      `354b1ba6a997bc464fb2ee9d7a2276c9f7d0bc78:${H4}frozen-k64-run.mjs`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(
    parseHarnessModuleConstant(text, "FRESHNESS_SETTLE_LIMIT_MS"),
    15000,
  );
  assert.equal(
    parseHarnessModuleConstant(text, "FRESHNESS_SETTLE_INTERVAL_MS"),
    100,
  );
  const old = execFileSync(
    "git",
    [
      "show",
      `950751d040b29b6d78a067a003dc19b196cfb692:${H4}frozen-k64-run.mjs`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(
    parseHarnessModuleConstant(old, "FRESHNESS_SETTLE_LIMIT_MS"),
    undefined,
  );
  const driverOld = execFileSync(
    "git",
    [
      "show",
      `950751d040b29b6d78a067a003dc19b196cfb692:${H4}frozen-setup-driver.mjs`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(
    parseHarnessConstant(driverOld, "FRESHNESS_SETTLE_WAIT_MS"),
    undefined,
  );
  // export された定数、2 回の定義、別名の衝突は読まない。
  assert.equal(
    parseHarnessModuleConstant("export const A = 1;", "A"),
    undefined,
  );
  assert.equal(
    parseHarnessModuleConstant("const A = 1;\nconst A = 2;", "A"),
    undefined,
  );
  assert.equal(parseHarnessModuleConstant("const A = 1_000;", "A"), 1000);
  const aliases = Object.values(HARNESS_MODULE_CONSTANTS).flatMap((rows) =>
    rows.map((row) => row.as),
  );
  const names = Object.values(HARNESS_CONSTANTS).flat();
  assert.ok(aliases.every((as) => !names.includes(as)));
});

test("S2 追補 #9（DR-CP4-T-4 (a)）: V-10 READY applies to the steady state only, as the pinned plan's readyProbeOf; graph-held-unusable discloses ownerReady.skipped", async () => {
  const ctx = await context();
  const prep = await json(OBSERVATION_PREP_FILES.prep);
  const check = (copy) => observationPrepErrors(copy, ctx);
  assert.deepEqual(ctx.harnessReadyProbe.kinds, ["steady-state"]);
  assert.equal(ctx.harnessReadyProbe.source.path, READY_PROBE_SOURCE.path);
  assert.equal(
    harnessPinOf(READY_PROBE_SOURCE.path).role,
    "t1-t4-measurement-settle-ready",
  );
  const specs = prep.setupReadings.measurementSpecs;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(specs).map(([k, v]) => [k, v.readyProbe]),
    ),
    {
      "after-maintenance-current": true,
      "while-graph-index-unusable": false,
      "while-chronicle-index-unusable": false,
      "while-both-indexes-unusable": false,
    },
  );
  const ready = /setupReadings\.readyProbe must apply V-10 READY/u;
  for (const mutate of [
    (p) => delete p.setupReadings.readyProbe,
    (p) => p.setupReadings.readyProbe.appliesTo.push("graph-held-unusable"),
    (p) => p.setupReadings.readyProbe.notApplicable.shift(),
    (p) => (p.setupReadings.readyProbe.judged = true),
    (p) => (p.setupReadings.readyProbe.skipped = "skipped"),
    (p) =>
      (p.setupReadings.readyProbe.rule =
        p.setupReadings.readyProbe.rule.replaceAll("fallback", "")),
    (p) =>
      (p.setupReadings.readyProbe.rule =
        p.setupReadings.readyProbe.rule.replaceAll("at-query", "")),
  ])
    detects(prep, check, mutate, ready);
  detects(
    prep,
    check,
    (p) =>
      (p.setupReadings.measurementSpecs[
        "while-graph-index-unusable"
      ].readyProbe = true),
    /setupReadings\.measurementSpecs/u,
  );
  // harness の plan が別の読み（!isOneShot）なら照合できない。
  assert.ok(
    observationPrepErrors(prep, {
      ...ctx,
      harnessReadyProbe: {
        ...ctx.harnessReadyProbe,
        kinds: ["graph-held-unusable"],
      },
    }).some((e) => ready.test(e)),
  );
  assert.ok(
    observationPrepErrors(prep, { ...ctx, harnessReadyProbe: null }).some((e) =>
      ready.test(e),
    ),
  );
  for (const commit of [
    "2c9316848ce028565c4d8e8af2d2779c3fd7e187",
    "5b4b93400bc71c634c7d015658543a71f51cab30",
  ]) {
    // #754 と T-1 の bytes は readyProbe: !isOneShot（graph-held-unusable にも READY）。
    const text = execFileSync(
      "git",
      ["show", `${commit}:${READY_PROBE_SOURCE.path}`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.ok(text.includes("readyProbe: !isOneShot"), commit);
    assert.equal(parseReadyProbeKinds(text), undefined, commit);
  }
  assert.equal(
    parseReadyProbeKinds(
      'const readyProbeOf = (kind) => kind === "steady-state";\nreadyProbe: readyProbeOf(kind),\n',
    ),
    undefined,
  );
  // 読み元の bytes が pin と違えば落ちる。
  assert.ok(
    observationPrepErrors(prep, {
      ...ctx,
      harnessReadyProbe: {
        ...ctx.harnessReadyProbe,
        source: {
          ...ctx.harnessReadyProbe.source,
          sha256: flip(ctx.harnessReadyProbe.source.sha256),
        },
      },
    }).some((e) =>
      /t1-t4-measurement-settle-ready: .*frozen-k64-plan\.mjs must be the bytes/u.test(
        e,
      ),
    ),
  );
});
