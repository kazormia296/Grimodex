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
  readTraceFileHeads,
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
    "g01-mira-entity-reached:unobservable",
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
