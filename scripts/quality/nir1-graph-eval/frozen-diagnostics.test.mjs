import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import {
  G01_NEGATIVES,
  SP_P4,
  SP_P4_COMPARISON_RULE,
  assertSpP4Passed,
  assertSpP4WorkspaceStable,
  assessG01Negative,
  assessSpP4Attempt,
  buildRunHead,
  compareSpP4Variant,
  g01NegativeTargets,
  logicalSceneIds,
  outsideQReceiptCountByReason,
  readBoundFile,
  readCommittedFile,
  readDiagnosticPlan,
  readRunHead,
  readSpP4Gate,
  readTraceFileHeads,
  spP4AttemptKey,
  traceAttemptKey,
  claimFrozenAttempt,
  frozenAttemptLedger,
  explainSpP4Instability,
  spP4IrDisclosure,
  spP4AttemptOutcome,
  spP4Schedule,
  spP4SampleRecord,
  spP4Targets,
  summarizeSpP4,
  writeRunHead,
} from "./frozen-diagnostics.mjs";
import { loadFrozenSeedPinPlan } from "./seed-pin-setup.mjs";
import { REPO_ROOT, testGit } from "./test-support.mjs";
import { s2Record } from "./s5b-test-support.mjs";

const H = (c) => c.repeat(64);
const C = (c) => c.repeat(40);

test("S5-B: S2 の diagnosticRuns から SP-P4 と K24-G01-N2〜N4 の plan を読む", () => {
  const plan = readDiagnosticPlan(s2Record());
  assert.deepEqual(plan.spP4.variants, SP_P4.variants);
  assert.equal(plan.spP4.warmup, 5);
  assert.equal(plan.spP4.measured, 30);
  assert.equal(plan.spP4.attemptLimit, 2);
  assert.deepEqual(
    plan.g01Negatives.map((row) => [row.id, row.mutation]),
    [
      ["K24-G01-N2", "resave-same-body"],
      ["K24-G01-N3", "restore-same-bytes-body-version"],
      ["K24-G01-N4", "restore-different-bytes-body-version"],
    ],
  );
});

test("S5-B: S2 の SP-P4 の行が設計と違えば [precheck]（観測の前に固定）", () => {
  const cases = [
    (r) => r.diagnosticRuns[4].variants.push("G-03/frontier-exceeded"),
    (r) => r.diagnosticRuns[4].variants.reverse(),
    (r) => (r.diagnosticRuns[4].attemptLimit = 3),
    (r) => (r.diagnosticRuns[4].graphArm = true),
    (r) => (r.diagnosticRuns[4].seedSent = true),
    (r) => (r.diagnosticRuns[4].d2aMode = "unrestricted"),
    (r) => (r.diagnosticRuns[4].branch = "two-setups"),
    (r) => (r.diagnosticRuns[4].compareBy = "runtime-id"),
    (r) => (r.diagnosticRuns[4].runsPerSide = 2),
    (r) => (r.diagnosticRuns[4].sides = ["with-seed-pin-step"]),
    (r) => r.diagnosticRuns[4].requiredRecords.pop(),
    (r) => (r.diagnosticRuns[4].arms = ["hybrid", "graph"]),
    (r) => r.diagnosticRuns.splice(4, 1),
    (r) => (r.samplePlan.measuredPerArm = 20),
    (r) => (r.samplePlan.warmupPerArm = 0),
    (r) => (r.diagnosticRuns[2].mutationAfterDeclaration = "resave-same-body"),
    (r) => (r.diagnosticRuns[3].declare = false),
    (r) => r.diagnosticRuns.splice(3, 1),
  ];
  for (const mutate of cases)
    assert.throws(
      () =>
        readDiagnosticPlan(
          s2Record((r) => {
            mutate(r);
            return r;
          }),
        ),
      /\[precheck\] S5-B/u,
    );
});

test("S5-B: SP-P4 の 8 variant は凍結した fixture の 13 variant から S2 の範囲（base）を取ったもの", () => {
  const seedPlan = loadFrozenSeedPinPlan({ root: REPO_ROOT });
  assert.equal(seedPlan.length, 13);
  const targets = spP4Targets({ seedPlan });
  assert.deepEqual(
    targets.map((row) => row.variantKey),
    SP_P4.variants,
  );
  // 含めない 5 つ（frontier-exceeded、G-08 の unusable と recovered）。
  const all = GRAPH_EVAL_VARIANTS.map((row) => row.key);
  assert.deepEqual(
    all.filter((key) => !SP_P4.variants.includes(key)),
    [
      "G-03/frontier-exceeded",
      "G-08/graph-index-unusable",
      "G-08/graph-recovered",
      "G-08/chronicle-index-unusable",
      "G-08/both-indexes-unusable",
    ],
  );
  for (const row of targets) {
    assert.equal(typeof row.querySceneId, "string");
    assert.equal(typeof row.seedEntityId, "string");
  }
  assert.equal(
    targets.find((row) => row.variantKey === "G-01/v1").seedEntityId,
    "g01-orin",
  );
});

test("S5-B: SP-P4 の予定は側ごとに warm-up 5 の後に measured 30（hybrid だけ、seed なし）", () => {
  const schedule = spP4Schedule({ warmup: 5, measured: 30 });
  assert.equal(schedule.length, 35);
  assert.deepEqual(
    schedule.slice(0, 6).map((row) => [row.phase, row.repeat]),
    [
      ["warmup", 0],
      ["warmup", 1],
      ["warmup", 2],
      ["warmup", 3],
      ["warmup", 4],
      ["measured", 0],
    ],
  );
  assert.ok(schedule.every((row) => row.arm === "hybrid" && row.seed === null));
  assert.equal(schedule.at(-1).repeat, 29);
});

const scenes = {
  "g02-query": "rq",
  "g02-a": "ra",
  "g02-b": "rb",
  "g02-c": "rc",
};

function measure(overrides = {}) {
  return {
    status: "completed",
    rawSceneIds: ["ra", "rb"],
    resultSceneIds: ["ra", "rb", "rc"],
    ...overrides,
  };
}

const counters = (begins, cacheHits = 0, lateCached = 0) => ({
  begins,
  cacheHits,
  lateCached,
  pending: 9,
});

function sampleOf(overrides = {}, at = { phase: "measured", repeat: 0 }) {
  return spP4SampleRecord({
    ...at,
    measure: measure(overrides.measure),
    denseHitSceneIds: overrides.dense ?? ["rb", "ra"],
    sparseSceneIds: overrides.sparse ?? ["ra"],
    before: overrides.before ?? counters(3),
    after: overrides.after ?? counters(3),
    scenes,
  });
}

test("S5-B: SP-P4 の sample は論理 ID で、共通追加枠は R+IR にあって R に無い Scene", () => {
  const row = sampleOf();
  assert.deepEqual(row.rSceneIds, ["g02-a", "g02-b"]);
  assert.deepEqual(row.denseHitSceneIds, ["g02-b", "g02-a"]);
  assert.deepEqual(row.sparseSceneIds, ["g02-a"]);
  assert.deepEqual(row.rIrSceneIds, ["g02-a", "g02-b", "g02-c"]);
  assert.equal(row.irSupplementSceneId, "g02-c");
  assert.deepEqual(
    spP4SampleRecord({
      phase: "measured",
      repeat: 0,
      measure: {
        ...measure(),
        resultKind: "raw",
        completion: { outcome: "ir-timeout", deadlineExceeded: true },
      },
      denseHitSceneIds: [],
      sparseSceneIds: [],
      before: counters(0),
      after: counters(0),
      scenes,
    }).ir,
    { resultKind: "raw", outcome: "ir-timeout", deadlineExceeded: true },
  );
  assert.deepEqual(row.counters.delta, {
    begins: 0,
    cacheHits: 0,
    lateCached: 0,
  });
  assert.equal(row.beginsDeltaZero, true);
  assert.equal(
    sampleOf({ measure: { resultSceneIds: ["ra", "rb"] } }).irSupplementSceneId,
    null,
  );
  // 追加枠が 2 つ以上なら記録の誤り。
  assert.throws(
    () => sampleOf({ measure: { resultSceneIds: ["rq", "ra", "rb", "rc"] } }),
    /\[artifact\]/u,
  );
  // 対応に無い runtime ID は比較できない。
  assert.throws(() => logicalSceneIds(["zz"], scenes), /\[precheck\]/u);
  assert.throws(
    () => sampleOf({ before: { begins: 1 }, after: { cacheHits: 0 } }),
    /\[artifact\]/u,
  );
});

function attemptSamples(mutate = () => ({})) {
  return spP4Schedule({ warmup: 5, measured: 30 }).map((at, index) =>
    sampleOf(mutate(at, index), at),
  );
}

test("S5-B: begins の差分が 0 でない sample があれば試行は無効（SP-N7 に数えない）、2 回目の無効で [precheck]", () => {
  const ok = assessSpP4Attempt({
    samples: attemptSamples(),
    warmup: 5,
    measured: 30,
  });
  assert.equal(ok.valid, true);
  const bad = assessSpP4Attempt({
    samples: attemptSamples((at) =>
      at.phase === "warmup" && at.repeat === 2 ? { after: counters(4) } : {},
    ),
    warmup: 5,
    measured: 30,
  });
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.invalidSamples, [
    { phase: "warmup", repeat: 2, beginsDelta: 1 },
  ]);
  // 予定より少ない sample は無効。
  assert.equal(
    assessSpP4Attempt({
      samples: attemptSamples().slice(0, 34),
      warmup: 5,
      measured: 30,
    }).valid,
    false,
  );
  assert.equal(spP4AttemptOutcome({ attempt: 1, valid: true }), "accepted");
  assert.equal(spP4AttemptOutcome({ attempt: 1, valid: false }), "retake");
  assert.equal(spP4AttemptOutcome({ attempt: 2, valid: false }), "precheck");
  assert.equal(spP4AttemptOutcome({ attempt: 2, valid: true }), "accepted");
  assert.throws(
    () => spP4AttemptOutcome({ attempt: 3, valid: true }),
    /\[precheck\]/u,
  );
});

test("S5-B: 同じ workspace の measured の sample どうしが一致しなければ [precheck]", () => {
  const samples = attemptSamples();
  assert.equal(
    assertSpP4WorkspaceStable(samples, "G-02/base:with").measured,
    30,
  );
  const unstable = attemptSamples((at) =>
    at.phase === "measured" && at.repeat === 7 ? { sparse: ["rb"] } : {},
  );
  assert.throws(
    () => assertSpP4WorkspaceStable(unstable, "G-02/base:with"),
    /\[precheck\].*measured 7/u,
  );
  // warm-up の違いは比較に入れない（測る前の段）。
  const warm = attemptSamples((at) =>
    at.phase === "warmup" ? { sparse: ["rb"] } : {},
  );
  assert.equal(assertSpP4WorkspaceStable(warm, "x").measured, 30);
});

test("S5-B: 両側の measured の各 sample を論理 ID で比べ、1 件でも違えば SP-N7", () => {
  const same = compareSpP4Variant({
    variantKey: "G-02/base",
    without: attemptSamples(),
    with: attemptSamples(),
  });
  assert.equal(same.same, true);
  assert.equal(same.compared, 30);
  for (const [field, change] of [
    [
      "rSceneIds",
      {
        measure: {
          rawSceneIds: ["rb", "ra"],
          resultSceneIds: ["rb", "ra", "rc"],
        },
      },
    ],
    ["denseHitSceneIds", { dense: ["ra", "rb"] }],
    ["sparseSceneIds", { sparse: [] }],
    ["rIrSceneIds", { measure: { resultSceneIds: ["ra", "rc", "rb"] } }],
    [
      "irSupplementSceneId",
      { measure: { resultSceneIds: ["ra", "rb", "rq"] } },
    ],
  ]) {
    const result = compareSpP4Variant({
      variantKey: "G-02/base",
      without: attemptSamples(),
      with: attemptSamples((at) => (at.phase === "measured" ? change : {})),
    });
    assert.equal(result.same, false, field);
    assert.ok(result.differences[0].fields.includes(field), field);
  }
  // 側の runtime ID は違ってよい（論理 ID で比べる）。
  const other = {
    "g02-query": "sq",
    "g02-a": "sa",
    "g02-b": "sb",
    "g02-c": "sc",
  };
  const withOther = spP4Schedule({ warmup: 5, measured: 30 }).map((at) =>
    spP4SampleRecord({
      ...at,
      measure: {
        status: "completed",
        rawSceneIds: ["sa", "sb"],
        resultSceneIds: ["sa", "sb", "sc"],
      },
      denseHitSceneIds: ["sb", "sa"],
      sparseSceneIds: ["sa"],
      before: counters(0),
      after: counters(0),
      scenes: other,
    }),
  );
  assert.equal(
    compareSpP4Variant({
      variantKey: "G-02/base",
      without: attemptSamples(),
      with: withOther,
    }).same,
    true,
  );
});

function variantRecord(
  variantKey,
  comparison = { same: true, compared: 30, differences: [] },
) {
  const attempt = (side) => ({
    side,
    attempt: 1,
    valid: true,
    outcome: "accepted",
    d2aMode: "restricted",
    logicalToRuntime: { scenes: {} },
  });
  return {
    variantKey,
    sides: {
      "without-seed-pin-step": { attempts: [attempt("without-seed-pin-step")] },
      "with-seed-pin-step": { attempts: [attempt("with-seed-pin-step")] },
    },
    comparison,
  };
}

test("S5-B: 8 variant がすべて一致したときだけ SP-P4 は passed、違えば SP-N7、欠ければ incomplete", () => {
  const all = SP_P4.variants.map((key) => variantRecord(key));
  const passed = summarizeSpP4({ variants: all });
  assert.equal(passed.status, "passed");
  assert.equal(assertSpP4Passed(passed).status, "passed");
  const differing = summarizeSpP4({
    variants: all.map((row, at) =>
      at === 3
        ? variantRecord(row.variantKey, {
            same: false,
            compared: 30,
            differences: [{ index: 0, fields: ["rSceneIds"] }],
          })
        : row,
    ),
  });
  assert.equal(differing.status, "sp-n7");
  assert.throws(() => assertSpP4Passed(differing), /\[precheck\] .*SP-N7/u);
  const missing = summarizeSpP4({ variants: all.slice(1) });
  assert.equal(missing.status, "incomplete");
  assert.throws(() => assertSpP4Passed(missing), /\[precheck\]/u);
  // 側の d2a の mode が restricted でなければ SP-P4 の記録として足りない。
  const mode = all.map((row) => JSON.parse(JSON.stringify(row)));
  mode[0].sides["with-seed-pin-step"].attempts[0].d2aMode = "unrestricted";
  assert.equal(summarizeSpP4({ variants: mode }).status, "incomplete");
  // 無効の試行しかない側。
  const invalid = all.map((row) => JSON.parse(JSON.stringify(row)));
  invalid[1].sides["without-seed-pin-step"].attempts = [
    {
      ...invalid[1].sides["without-seed-pin-step"].attempts[0],
      valid: false,
      outcome: "retake",
    },
    {
      ...invalid[1].sides["without-seed-pin-step"].attempts[0],
      attempt: 2,
      valid: false,
      outcome: "precheck",
    },
  ];
  assert.equal(summarizeSpP4({ variants: invalid }).status, "precheck");
  // 自分で書いた passed は通さない（summarizeSpP4 の記録だけ）。
  assert.throws(
    () => assertSpP4Passed({ status: "passed", variants: [] }),
    /\[precheck\]/u,
  );
});

test("S5-B: K24-G01-N2〜N4 の対象は G-01 の fixture の論理 ID", () => {
  const targets = g01NegativeTargets({ root: REPO_ROOT });
  assert.deepEqual(targets, {
    caseId: "G-01",
    variantId: "v1",
    sceneId: "g01-mira",
    entityId: "g01-mira-entity",
    seedEntityId: "g01-orin",
    querySceneId: targets.querySceneId,
  });
  assert.equal(typeof targets.querySceneId, "string");
  assert.deepEqual(Object.keys(G01_NEGATIVES), [
    "K24-G01-N2",
    "K24-G01-N3",
    "K24-G01-N4",
  ]);
  assert.equal(G01_NEGATIVES["K24-G01-N2"].beforeDeclaration, null);
  assert.equal(
    G01_NEGATIVES["K24-G01-N3"].beforeDeclaration,
    "same-bytes-version",
  );
  assert.equal(
    G01_NEGATIVES["K24-G01-N4"].beforeDeclaration,
    "draft-then-original",
  );
});

function negSample(overrides = {}) {
  return {
    phase: "measured",
    repeat: 0,
    arm: "graph",
    seedRequested: "g01-orin",
    frameReached: true,
    returnedSceneIds: ["g01-review", "g01-weather"],
    ...overrides,
  };
}

test("S5-B: K24-G01-N2〜N4 の結果は blocked、inconclusive、not-established、established の順に決まる", () => {
  const base = {
    id: "K24-G01-N2",
    spP1Recheck: { status: "match" },
    samples: [negSample(), negSample({ repeat: 1 })],
  };
  assert.equal(assessG01Negative(base).outcome, "established");
  assert.equal(
    assessG01Negative({ ...base, blocked: { reason: "b-seal-not-current" } })
      .outcome,
    "blocked",
  );
  const inconclusive = (patch) => assessG01Negative({ ...base, ...patch });
  assert.deepEqual(
    inconclusive({ spP1Recheck: { status: "mismatch" } }).reasons,
    ["sp-p1-recheck"],
  );
  assert.deepEqual(
    inconclusive({ samples: [negSample({ seedRequested: null })] }).reasons,
    ["graph-requested-with-seed"],
  );
  // frame を読む入口が無い（null）なら unobservable で inconclusive。
  const unobservable = inconclusive({
    samples: [negSample({ frameReached: null })],
  });
  assert.equal(unobservable.outcome, "inconclusive");
  assert.deepEqual(unobservable.reasons, [
    "g01-mira-entity-reached:undetermined",
  ]);
  assert.deepEqual(
    inconclusive({ samples: [negSample({ frameReached: false })] }).reasons,
    ["g01-mira-entity-reached"],
  );
  assert.equal(
    inconclusive({ samples: [negSample({ returnedSceneIds: ["g01-mira"] })] })
      .outcome,
    "not-established",
  );
  // graph の arm の measured の sample が無ければ成り立ったと書かない。
  assert.equal(inconclusive({ samples: [] }).outcome, "inconclusive");
  assert.equal(
    inconclusive({ samples: [negSample({ arm: "hybrid" })] }).outcome,
    "inconclusive",
  );
  assert.throws(
    () => assessG01Negative({ ...base, id: "K24-G01-N1" }),
    /\[precheck\]/u,
  );
  assert.equal(assessG01Negative(base).countsInCaseJudgement, false);
});

test("S5-B: Q の外の query のうち completed 以外を status ごとに数える（P-S2-4）", () => {
  const observation = {
    fetches: [
      {
        seq: 1,
        sceneId: "q",
        seed: "s",
        calledAt: 1,
        result: { status: "completed" },
      },
      {
        seq: 2,
        sceneId: "h",
        seed: null,
        calledAt: 2,
        result: { status: "completed" },
      },
      {
        seq: 3,
        sceneId: "h",
        seed: null,
        calledAt: 3,
        result: { status: "raw-only" },
      },
      {
        seq: 4,
        sceneId: "h",
        seed: null,
        calledAt: 4,
        result: { status: "raw-only" },
      },
      {
        seq: 5,
        sceneId: "h",
        seed: null,
        calledAt: 5,
        failed: true,
        result: null,
      },
      { seq: 6, sceneId: "h", seed: null, calledAt: 6, result: null },
      {
        seq: 7,
        sceneId: "q",
        seed: "s",
        calledAt: 7,
        result: { status: "superseded" },
      },
    ],
    notices: [],
  };
  const counts = outsideQReceiptCountByReason({
    observation,
    parentSeqs: [1],
    querySceneId: "q",
  });
  assert.deepEqual(counts, {
    outsideQ: 5,
    completed: 1,
    nonCompleted: 4,
    byReason: { "raw-only": 2, "fetch-failed": 1, unresolved: 1 },
  });
});

function freezeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "s5b-head-"));
  return dir;
}

const goodHead = () => ({
  kind: "sp-p4",
  k62: { freezeCommit: C("6"), sha256: H("6") },
  k64: { freezeCommit: C("4"), sha256: H("4") },
  observationPrep: { commit: C("5"), freezeRecordSha256: H("5") },
  traces: s2Record().traces,
});

test("S5-B: receipt の先頭は測定の前に書き、欠け・placeholder・読めない値なら測定を始めない", async () => {
  const dir = freezeRepo();
  const now = () => new Date("2026-10-28T01:02:03.000Z");
  const head = buildRunHead(goodHead(), { now });
  assert.equal(head.runStartedAtUtc, "2026-10-28T01:02:03.000Z");
  const written = await writeRunHead({ runDir: dir, head });
  assert.equal(written.sha256.length, 64);
  const read = readRunHead({ runDir: dir, sha256: written.sha256 });
  assert.deepEqual(read, head);
  // bytes が書き換わっていれば終わりの照合で止まる。
  const file = path.join(dir, "head.json");
  writeFileSync(file, readFileSync(file, "utf8").replace("sp-p4", "sp-p5"));
  assert.throws(
    () => readRunHead({ runDir: dir, sha256: written.sha256 }),
    /\[precheck\]/u,
  );
  for (const mutate of [
    (h) => delete h.k64,
    (h) => (h.k62.sha256 = "x"),
    (h) => (h.observationPrep.commit = null),
    (h) => (h.traces[0].commit = "S4:trace-editing-commit"),
    (h) => (h.traces[1].sha256 = "S4:trace-browsing-sha256"),
    (h) => (h.traces = []),
    (h) => (h.kind = "other"),
  ]) {
    const value = goodHead();
    mutate(value);
    assert.throws(() => buildRunHead(value, { now }), /\[precheck\]/u);
  }
  // 診断と trace は trace の file の commit と SHA-256 を持つ。
  const noTrace = goodHead();
  delete noTrace.traces;
  assert.throws(() => buildRunHead(noTrace, { now }), /traces/u);
  // 開始時刻が読めなければ始めない。
  assert.throws(
    () => buildRunHead(goodHead(), { now: () => new Date(Number.NaN) }),
    /\[precheck\]/u,
  );
  // 既にある head は上書きしない（1 run 1 head）。
  await assert.rejects(writeRunHead({ runDir: dir, head }), /\[precheck\]/u);
});

test("S5-B: S2 が commit と SHA-256 で指す file は、その commit から読んで照合する（boundFiles は配列）", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "s5b-bound-"));
  testGit(repo, "init", "-q");
  mkdirSync(path.join(repo, "evals/nir1-graph"), { recursive: true });
  const file = "evals/nir1-graph/declaration-addendum.v1.json";
  writeFileSync(path.join(repo, file), '{"declarations":[]}\n');
  testGit(repo, "add", file);
  testGit(repo, "commit", "-q", "-m", "a");
  const commit = testGit(repo, "rev-parse", "HEAD");
  const digest = createHash("sha256")
    .update(readFileSync(path.join(repo, file)))
    .digest("hex");
  const record = { boundFiles: [{ path: file, commit, sha256: digest }] };
  const bound = readBoundFile({ root: repo, record, file });
  assert.equal(bound.sha256, digest);
  assert.equal(bound.bytes.toString("utf8"), '{"declarations":[]}\n');
  // 作業 tree の bytes ではなく commit の bytes を読む。
  writeFileSync(path.join(repo, file), "changed\n");
  assert.equal(readBoundFile({ root: repo, record, file }).sha256, digest);
  for (const entry of [
    { path: file, commit, sha256: H("0") },
    { path: file, commit: "S4:declaration-addendum-commit", sha256: digest },
    { path: file, commit: C("0"), sha256: digest },
    { path: "evals/nir1-graph/missing.json", commit, sha256: digest },
  ])
    assert.throws(
      () => readCommittedFile({ root: repo, entry }),
      /\[precheck\] S5-B/u,
    );
  assert.throws(
    () => readBoundFile({ root: repo, record: { boundFiles: {} }, file }),
    /boundFiles/u,
  );
  assert.equal(
    readTraceFileHeads({
      root: repo,
      traces: [{ kind: "editing", path: file, commit, sha256: digest }],
    })[0].commit,
    commit,
  );
});

test("S5-B（変異 D7）: measured の sample の無い両側は一致としない", () => {
  const warmOnly = attemptSamples().filter((row) => row.phase === "warmup");
  const result = compareSpP4Variant({
    variantKey: "G-02/base",
    without: warmOnly,
    with: warmOnly,
  });
  assert.equal(result.compared, 0);
  assert.equal(result.same, false);
});

test("S5-B: Graph arm を含む実行は ④ の SP-P4 の receipt を読み直し、sample から比較し直して passed のときだけ始める", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "s5b-gate-"));
  const head = {
    kind: "sp-p4",
    k62: { freezeCommit: C("6"), sha256: H("6") },
    k64: { freezeCommit: C("4"), sha256: H("4") },
    observationPrep: { commit: C("5"), freezeRecordSha256: H("5") },
  };
  const headSha256 = createHash("sha256")
    .update(`${JSON.stringify(head, null, 2)}\n`)
    .digest("hex");
  const sides = (change = () => ({})) =>
    Object.fromEntries(
      SP_P4.sides.map((side) => [
        side,
        {
          attempts: [
            {
              side,
              attempt: 1,
              valid: true,
              outcome: "accepted",
              d2aMode: "restricted",
              logicalToRuntime: { scenes },
              samples: attemptSamples(
                side === "with-seed-pin-step" ? change : () => ({}),
              ),
            },
          ],
        },
      ]),
    );
  const receipt = (overrides = {}, change) => ({
    runKind: "seed-pin-parity",
    preview: false,
    head,
    headSha256,
    stop: null,
    design: { rule: "current" },
    candidate: { commit: C("b"), clean: true },
    variants: SP_P4.variants.map((variantKey) => ({
      variantKey,
      sides: sides(change),
      // 記録された比較は信じない（読み直しで作り直す）。
      comparison: { same: true },
    })),
    summary: { status: "passed" },
    ...overrides,
  });
  const write = (value, name) => {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const gate = readSpP4Gate({
    file: write(receipt(), "ok.json"),
    head,
    candidateCommit: C("b"),
  });
  assert.equal(gate.summary.status, "passed");
  for (const [name, value, commit] of [
    ["preview", receipt({ preview: true }), C("b")],
    [
      "other-prep",
      receipt({ head: { observationPrep: { commit: C("6") } } }),
      C("b"),
    ],
    ["other-candidate", receipt(), C("c")],
    ["missing", receipt({ variants: receipt().variants.slice(1) }), C("b")],
    ["stopped", receipt({ stop: "[precheck] x" }), C("b")],
    ["head-sha", receipt({ headSha256: H("0") }), C("b")],
    [
      "not-clean",
      receipt({ candidate: { commit: C("b"), clean: false } }),
      C("b"),
    ],
    ["other-rule", receipt({ design: { rule: "ir-complete-pairs" } }), C("b")],
    // レビュー P2-1: 記録が valid でも sample の数と counter から計算し直す。
    [
      "forged-valid",
      (() => {
        const forged = receipt();
        for (const row of forged.variants)
          for (const side of SP_P4.sides) {
            const attempt = row.sides[side].attempts[0];
            attempt.samples = attempt.samples
              .filter((at) => at.phase === "measured")
              .slice(0, 1)
              .map((at) => ({
                ...at,
                counters: {
                  before: { begins: 0, cacheHits: 0, lateCached: 0 },
                  after: { begins: 7, cacheHits: 0, lateCached: 0 },
                  delta: { begins: 7, cacheHits: 0, lateCached: 0 },
                },
                beginsDeltaZero: true,
              }));
          }
        return forged;
      })(),
      C("b"),
    ],
    [
      "unstable-accepted",
      (() => {
        const unstable = receipt();
        const attempt =
          unstable.variants[0].sides["without-seed-pin-step"].attempts[0];
        attempt.samples = attemptSamples((at) =>
          at.phase === "measured" && at.repeat === 7 ? { sparse: ["rb"] } : {},
        );
        return unstable;
      })(),
      C("b"),
    ],
  ])
    assert.throws(
      () =>
        readSpP4Gate({
          file: write(value, `${name}.json`),
          head,
          candidateCommit: commit,
        }),
      /\[precheck\]/u,
      name,
    );
  // 記録が same でも sample が違えば SP-N7（読み直しで見つける）。
  assert.throws(
    () =>
      readSpP4Gate({
        file: write(
          receipt({}, (at) =>
            at.phase === "measured" ? { sparse: ["rb"] } : {},
          ),
          "differs.json",
        ),
        head,
        candidateCommit: C("b"),
      }),
    /SP-N7/u,
  );
  // K6/4 の head が今の admission と違えば通さない。
  assert.throws(
    () =>
      readSpP4Gate({
        file: write(receipt(), "k64.json"),
        head: { ...head, k64: { freezeCommit: C("7"), sha256: H("7") } },
        candidateCommit: C("b"),
      }),
    /k64 head/u,
  );
});

test("O-7: 同じ workspace の不一致が IR の期限切れだけで説明できるかを判定とは別に開示する", () => {
  const withIr = (change) =>
    spP4Schedule({ warmup: 5, measured: 30 }).map((at) => {
      const patch = change(at) ?? {};
      return spP4SampleRecord({
        ...at,
        measure: {
          ...measure(patch.measure),
          resultKind: patch.ir === "timeout" ? "raw" : "fused",
          completion: {
            outcome: patch.ir ?? "ir-ready",
            deadlineExceeded: patch.ir === "timeout",
          },
        },
        denseHitSceneIds: patch.dense ?? ["rb", "ra"],
        sparseSceneIds: ["ra"],
        before: counters(0),
        after: counters(0),
        scenes,
      });
    });
  const timeout = { ir: "timeout", measure: { resultSceneIds: ["ra", "rb"] } };
  const explained = explainSpP4Instability(
    withIr((at) =>
      at.phase === "measured" && at.repeat === 3 ? timeout : null,
    ),
  );
  assert.equal(explained.explainedByIrDeadline, true);
  assert.equal(explained.differing, 1);
  for (const patch of [
    { measure: { resultSceneIds: ["ra", "rb"] } },
    { ...timeout, dense: ["ra", "rb"] },
    { ir: "timeout", measure: { resultSceneIds: ["rb", "ra"] } },
  ])
    assert.equal(
      explainSpP4Instability(
        withIr((at) =>
          at.phase === "measured" && at.repeat === 3 ? patch : null,
        ),
      ).explainedByIrDeadline,
      false,
    );
  assert.equal(
    explainSpP4Instability(withIr(() => timeout)).reason,
    "no-ir-ready-sample",
  );
  const disclosed = spP4IrDisclosure(
    withIr((at) => (at.repeat === 1 ? timeout : null)),
  );
  assert.deepEqual(
    [
      disclosed.warmup.notReady,
      disclosed.measured.notReady,
      disclosed.notReadySamples.length,
    ],
    [1, 1, 2],
  );
});

test("O-7（変異 I4）: IR が完了した sample の違いは、行ごとにも期限切れで説明できるとしない", () => {
  const rows = spP4Schedule({ warmup: 0, measured: 3 }).map((at) =>
    spP4SampleRecord({
      ...at,
      measure: {
        ...measure(at.repeat === 2 ? { resultSceneIds: ["ra", "rb"] } : {}),
        resultKind: "fused",
        completion: { outcome: "ir-ready", deadlineExceeded: false },
      },
      denseHitSceneIds: ["rb", "ra"],
      sparseSceneIds: ["ra"],
      before: counters(0),
      after: counters(0),
      scenes,
    }),
  );
  const result = explainSpP4Instability(rows);
  assert.equal(result.readyAgree, false);
  assert.deepEqual(
    result.rows.map((row) => [row.repeat, row.explained]),
    [[2, false]],
  );
});

test("レビュー P2-4: 届いた sample に g01-mira が返れば、ほかの sample が判定不能でも not-established", () => {
  const base = { id: "K24-G01-N3", spP1Recheck: { status: "match" } };
  const reachedReturned = negSample({
    repeat: 4,
    returnedSceneIds: ["g01-mira"],
  });
  const outcome = (samples) => assessG01Negative({ ...base, samples });
  assert.equal(
    outcome([negSample({ frameReached: null }), reachedReturned]).outcome,
    "not-established",
  );
  assert.deepEqual(
    outcome([negSample({ seedRequested: null }), reachedReturned]).returnedIn,
    [4],
  );
  // 届いたと言えない sample の返りは負例を崩さない（判定不能のまま）。
  assert.equal(
    outcome([negSample({ frameReached: null, returnedSceneIds: ["g01-mira"] })])
      .outcome,
    "inconclusive",
  );
  // SP-P1 が合わなければ（条件が違う）not-established にしない。
  assert.equal(
    assessG01Negative({
      ...base,
      spP1Recheck: { status: "mismatch" },
      samples: [reachedReturned],
    }).outcome,
    "inconclusive",
  );
});

test("レビュー P2-5: 比較の規則は既定が今の規則（current）で、ir-complete-pairs は R を全 sample、IR の寄与を IR 完了の組だけで比べる", () => {
  assert.equal(SP_P4_COMPARISON_RULE, "current");
  const withIr = (change) =>
    spP4Schedule({ warmup: 5, measured: 30 }).map((at) => {
      const patch = change(at) ?? {};
      return spP4SampleRecord({
        ...at,
        measure: {
          ...measure(patch.measure),
          resultKind: patch.ir === "timeout" ? "raw" : "fused",
          completion: {
            outcome: patch.ir ?? "ir-ready",
            deadlineExceeded: patch.ir === "timeout",
          },
        },
        denseHitSceneIds: patch.dense ?? ["rb", "ra"],
        sparseSceneIds: ["ra"],
        before: counters(0),
        after: counters(0),
        scenes,
      });
    });
  const timeoutAt = (repeat) => (at) =>
    at.phase === "measured" && at.repeat === repeat
      ? { ir: "timeout", measure: { resultSceneIds: ["ra", "rb"] } }
      : null;
  const without = withIr(timeoutAt(3));
  const withSide = withIr(timeoutAt(9));
  // 今の規則: 期限切れで同じ workspace の中の一致が崩れ [precheck]。
  assert.throws(() => assertSpP4WorkspaceStable(without, "x"), /\[precheck\]/u);
  // 改訂の規則: 期限切れの sample は IR の比較から外し、R は全件で比べる。
  const stableResult = assertSpP4WorkspaceStable(without, "x", {
    rule: "ir-complete-pairs",
  });
  assert.deepEqual([stableResult.irReady, stableResult.irNotReady], [29, 1]);
  const compared = compareSpP4Variant({
    variantKey: "G-02/base",
    without,
    with: withSide,
    rule: "ir-complete-pairs",
  });
  assert.equal(compared.same, true);
  assert.equal(compared.irCompletePairs, 28);
  assert.equal(
    compareSpP4Variant({ variantKey: "G-02/base", without, with: withSide })
      .same,
    false,
  );
  // R の違いは期限切れの sample でも数える。
  const rDiffers = withIr((at) =>
    at.phase === "measured" && at.repeat === 3
      ? {
          ir: "timeout",
          measure: { rawSceneIds: ["rb", "ra"], resultSceneIds: ["rb", "ra"] },
        }
      : null,
  );
  assert.equal(
    compareSpP4Variant({
      variantKey: "G-02/base",
      without: withIr(() => null),
      with: rDiffers,
      rule: "ir-complete-pairs",
    }).same,
    false,
  );
  // IR が完了した組の IR の違いは SP-N7。
  const irDiffers = withIr((at) =>
    at.phase === "measured" && at.repeat === 5
      ? { measure: { resultSceneIds: ["ra", "rb", "rq"] } }
      : null,
  );
  assert.deepEqual(
    compareSpP4Variant({
      variantKey: "G-02/base",
      without: withIr(() => null),
      with: irDiffers,
      rule: "ir-complete-pairs",
    }).differences.map((row) => [row.index, row.fields]),
    [[5, ["rIrSceneIds", "irSupplementSceneId"]]],
  );
  // 片側に IR 完了の sample が無ければ比べられない。
  const allTimeout = withIr((at) =>
    at.phase === "measured"
      ? { ir: "timeout", measure: { resultSceneIds: ["ra", "rb"] } }
      : null,
  );
  assert.throws(
    () =>
      assertSpP4WorkspaceStable(allTimeout, "x", { rule: "ir-complete-pairs" }),
    /no measured sample reached ir-ready/u,
  );
  const noPair = compareSpP4Variant({
    variantKey: "G-02/base",
    without: allTimeout,
    with: withIr(() => null),
    rule: "ir-complete-pairs",
  });
  assert.deepEqual(
    [noPair.same, noPair.undefinedReason],
    [false, "no-ir-complete-pair"],
  );
  assert.throws(
    () =>
      compareSpP4Variant({
        variantKey: "x/y",
        without,
        with: withSide,
        rule: "other",
      }),
    /\[precheck\]/u,
  );
});

test("レビュー P3 (d): K24-G01-N2〜N4 の対象は凍結した G-01 の bytes からだけ読む", () => {
  const root = mkdtempSync(path.join(tmpdir(), "s5b-g01-"));
  mkdirSync(path.join(root, "evals/nir1-g01"), { recursive: true });
  const original = readFileSync(
    path.join(REPO_ROOT, "evals/nir1-g01/fixture.v1.json"),
    "utf8",
  );
  writeFileSync(
    path.join(root, "evals/nir1-g01/fixture.v1.json"),
    original.replace("Mira", "Myra"),
  );
  assert.throws(() => g01NegativeTargets({ root }), /not the frozen bytes/u);
  writeFileSync(path.join(root, "evals/nir1-g01/fixture.v1.json"), original);
  assert.equal(g01NegativeTargets({ root }).entityId, "g01-mira-entity");
});

test("レビュー P2-b: ir-complete-pairs で IR 完了の組が無ければ要約は SP-N7 でなく [precheck]", () => {
  const all = SP_P4.variants.map((key) => variantRecord(key));
  all[2] = variantRecord(all[2].variantKey, {
    same: false,
    compared: 30,
    irCompletePairs: 0,
    undefinedReason: "no-ir-complete-pair",
    differences: [],
  });
  const summary = summarizeSpP4({ variants: all });
  assert.equal(summary.status, "precheck");
  assert.throws(() => assertSpP4Passed(summary), /\[precheck\] S5-B gate/u);
});

test("レビュー P2-c: 台帳の key は試行の identity（観測前の commit、trace の file、候補）から導く", () => {
  assert.equal(
    spP4AttemptKey({ prepCommit: C("5"), candidateCommit: C("b") }),
    `sp-p4:${C("5")}:${C("b")}`,
  );
  const trace = {
    path: "evals/nir1-graph/trace-browsing.v1.json",
    commit: C("a"),
    sha256: H("2"),
  };
  assert.equal(
    traceAttemptKey({ trace, candidateCommit: C("b") }),
    `trace:${trace.path}:${C("a")}:${H("2")}:${C("b")}`,
  );
  assert.notEqual(
    traceAttemptKey({ trace, candidateCommit: C("c") }),
    traceAttemptKey({ trace, candidateCommit: C("b") }),
  );
  assert.throws(
    () => spP4AttemptKey({ prepCommit: "run-1", candidateCommit: C("b") }),
    /\[precheck\]/u,
  );
  assert.throws(
    () =>
      traceAttemptKey({
        trace: { ...trace, sha256: "x" },
        candidateCommit: C("b"),
      }),
    /\[precheck\]/u,
  );
  assert.throws(
    () => claimFrozenAttempt({ kind: "sp-p4", key: "k" }),
    /\[precheck\].*ledger/u,
  );
  assert.deepEqual(
    claimFrozenAttempt({ kind: "sp-p4", key: "k", ledger: (input) => input }),
    { kind: "sp-p4", key: "k" },
  );
});

test("DR-CP4-O-16: 台帳（A の #754）は同じ identity の SP-P4 の 2 回目を拒み、trace の試行 n は n − 1 回の記録の後だけ", () => {
  const root = mkdtempSync(path.join(tmpdir(), "s5b-ledger-"));
  const candidate = { commit: C("b"), tree: C("t") };
  const ledger = (runName, attempt = 1) =>
    frozenAttemptLedger({
      root,
      candidate,
      s4Commit: C("5"),
      runName,
      startedAtUtc: "2026-10-28T00:00:00.000Z",
      attempt,
    });
  const spKey = spP4AttemptKey({ prepCommit: C("5"), candidateCommit: C("b") });
  const first = claimFrozenAttempt({
    kind: "sp-p4",
    key: spKey,
    ledger: ledger("sp-1"),
  });
  assert.match(first.file, /attempts\/sp-1\.json$/u);
  assert.deepEqual(first.priorAttempts, []);
  assert.throws(
    () =>
      claimFrozenAttempt({ kind: "sp-p4", key: spKey, ledger: ledger("sp-2") }),
    /\[precheck\].*1 earlier attempts are recorded \(expected 0\)/u,
  );
  // 別の候補の SP-P4 は別の identity。
  const other = spP4AttemptKey({ prepCommit: C("5"), candidateCommit: C("c") });
  assert.throws(
    () =>
      claimFrozenAttempt({
        kind: "sp-p4",
        key: other,
        ledger: frozenAttemptLedger({
          root,
          candidate: { commit: C("c"), tree: C("t") },
          s4Commit: C("5"),
          runName: "sp-1",
          startedAtUtc: "t",
        }),
      }),
    /already attempted/u,
  );
  const trace = {
    path: "evals/nir1-graph/trace-editing.v1.json",
    commit: C("a"),
    sha256: H("1"),
  };
  const key = traceAttemptKey({ trace, candidateCommit: C("b") });
  assert.throws(
    () => claimFrozenAttempt({ kind: "trace", key, ledger: ledger("tr-2", 2) }),
    /0 earlier attempts are recorded \(expected 1\)/u,
  );
  claimFrozenAttempt({ kind: "trace", key, ledger: ledger("tr-1", 1) });
  const second = claimFrozenAttempt({
    kind: "trace",
    key,
    ledger: ledger("tr-2", 2),
  });
  assert.equal(second.priorAttempts.length, 1);
  assert.equal(second.priorAttempts[0].runName, "tr-1");
});
