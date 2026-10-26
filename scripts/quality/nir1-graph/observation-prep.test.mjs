// CP-4 S2: 観測前に固定する文書（K2/4 の addendum、観測前の記録、trace、K6/4 の
// 手順のファイル、作者の宣言）の validator の試験。どれも Graph の runtime を動かさ
// ず、repo の file と、その変異（in-memory の複製）だけを読む。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SP1 } from "./seed-pin-addendum.mjs";
import {
  K24_TABLE,
  OBSERVATION_PREP_FILES,
  PLACEHOLDER,
  assertObservationPrepFormal,
  authorDeclarationErrors,
  declarationAddendumErrors,
  loadObservationPrepContext,
  observationPrepErrors,
  procedureDraftErrors,
  setupAddendumErrors,
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

test("the committed observation-prep files validate (draft status)", async () => {
  const result = await validateNir1ObservationPrep({ repoRoot });
  assert.deepEqual(result.errors, []);
  assert.equal(result.status, "passed");
  assert.equal(result.formalReady, false);
  assert.ok(result.placeholders.length > 0);
});

test("a draft with placeholders is never usable for a formal run", async () => {
  await assert.rejects(
    assertObservationPrepFormal({ repoRoot }),
    /\[precheck\].*(placeholder|draft)/u,
  );
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
  observed.graphRuntimeObservedBeforeAuthoring = true;
  assert.ok(setupAddendumErrors(observed, ctx).length > 0);

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
  const prep = await json(OBSERVATION_PREP_FILES.prep);
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
  const prep = await json(OBSERVATION_PREP_FILES.prep);
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
  filled.contracts.k64.freezeCommit = hex40;
  filled.d10.g01.da1AcceptanceRecord = record;
  filled.d10.g01.rAndRirMode =
    record === "none" ? "unrestricted" : "restricted";
  filled.contracts.sp1.bytesCommit = hex40;
  filled.r5Gate.syntheticDetection.record = "docs/plans/sp-synthetic.md";
  filled.r5Gate.r5CheckRecord = "docs/plans/r5-check.md";
  filled.review = { ...review, recordSha256: "c".repeat(64) };
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
  const prep = await json(OBSERVATION_PREP_FILES.prep);
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
  const freeze = await json("evals/nir1-graph/freeze.v1.json");
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
  const draft = await json(OBSERVATION_PREP_FILES.prep);
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
