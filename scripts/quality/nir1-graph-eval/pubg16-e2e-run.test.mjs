// PUB-G 前提 #16 の runner（DR-PUBG-16-1）：引数と、到達の判定（pure）。
// 実 Native は起動しない。
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { loadDevFixture } from "./dev-fixture.mjs";
import {
  G01_HEAD_OPTIONS,
  G01_RESULT_SCHEMA,
  G01_VARIANT_KEY,
  MODES,
  STAGES,
  g01DiagnosticHeadOf,
  g01DiagnosticRecord,
  judgeNotActivated,
  judgeReach,
  parseArgs,
} from "./pubg16-e2e-run.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DEV = "scripts/quality/nir1-graph-eval/dev-fixtures/dev-lantern.v1.json";
const base = [
  "--run",
  "x1",
  "--setup",
  "s.json",
  "--ja-model",
  "ja",
  "--en-model",
  "en",
];

const REACHED_PAGE = {
  begin: { graph: { status: "pending" }, ir: "pending", roundTripMs: 12 },
  graph: {
    status: "available",
    reason: null,
    graphOnly: true,
    pathAttachments: 1,
    waitMs: 5,
  },
  click: { status: "qualified", reason: null, ms: 3 },
  settle: { status: "settled" },
  graphReady: { count: 1, afterSettleMs: 1 },
  requery: {
    begin: { graph: { status: "pending" }, roundTripMs: 4 },
    graph: { status: "available", reason: null },
  },
  errors: [],
};
const REACHED_SETTLES = [
  { settle: "unused", status: "settled", reason: null, ok: true },
  { settle: "used", status: "settled", reason: null, ok: true },
];
const REACHED_NATIVE = [
  { begin: "started", disposition: "unused" },
  { begin: "cached", disposition: null },
];

test("the runner takes name-value arguments and a known mode", () => {
  const options = parseArgs(base);
  assert.equal(options.mode, "reach");
  assert.ok(MODES.includes(options.mode));
  assert.throws(() => parseArgs(["--run", "x1"]), /--setup is required/u);
  assert.throws(() => parseArgs([...base, "--mode", "bogus"]), /--mode/u);
  assert.throws(
    () => parseArgs([...base, "--mode", "not-activated"]),
    /--product-native/u,
  );
  assert.equal(
    parseArgs([
      ...base,
      "--mode",
      "not-activated",
      "--product-native",
      "/p/grimodex-node.node",
    ])["product-native"],
    "/p/grimodex-node.node",
  );
  assert.throws(() => parseArgs(["--run", "../x", ...base.slice(2)]), /--run/u);
});

test("the dev fixture declares the Scene whose body makes the Graph-only row", () => {
  const loaded = loadDevFixture({ root: ROOT, fixturePath: DEV });
  const [declaration] = loaded.fixture.declarations;
  assert.equal(declaration.values, "g01-subset");
  const jars = loaded.fixture.variants[0].expectations.arms.rPlusIrPlusGraph;
  assert.equal(jars.appendedSceneId, declaration.sceneId);
  assert.ok(loaded.fixture.entities.some((row) => row.role === "seed"));
});

test("every stage reached is allReached, in the stage order", () => {
  const judged = judgeReach({
    page: REACHED_PAGE,
    native: REACHED_NATIVE,
    settledSlot: "empty",
    settles: REACHED_SETTLES,
  });
  assert.equal(judged.allReached, true);
  assert.equal(judged.firstMissing, null);
  assert.deepEqual(Object.keys(judged.reached), [...STAGES]);
  assert.equal(judged.stages.click.status, "qualified");
});

test("no Graph-only row stops at the continue stage (fixture side)", () => {
  const page = {
    ...REACHED_PAGE,
    graph: { ...REACHED_PAGE.graph, graphOnly: false },
    click: undefined,
  };
  const judged = judgeReach({
    page,
    native: REACHED_NATIVE,
    settledSlot: "empty",
    settles: REACHED_SETTLES,
  });
  assert.equal(judged.allReached, false);
  assert.equal(judged.firstMissing, "continue-available-graph-only");
  assert.equal(judged.reached["click-keep-click"], false);
});

test("an unavailable click is not a reach, and neither is a missing cached begin", () => {
  const unavailable = judgeReach({
    page: {
      ...REACHED_PAGE,
      click: { status: "unavailable", reason: "failed", ms: 1 },
    },
    native: REACHED_NATIVE,
    settledSlot: "empty",
    settles: REACHED_SETTLES,
  });
  assert.equal(unavailable.firstMissing, "click-keep-click");
  assert.equal(unavailable.stages.click.reason, "failed");
  const notCached = judgeReach({
    page: REACHED_PAGE,
    native: [REACHED_NATIVE[0], { begin: "pending", disposition: null }],
    settledSlot: "empty",
    settles: REACHED_SETTLES,
  });
  assert.equal(notCached.firstMissing, "requery-cached");

  const slot = judgeReach({
    page: REACHED_PAGE,
    native: REACHED_NATIVE,
    settledSlot: "suspended",
    settles: REACHED_SETTLES,
  });
  assert.equal(slot.firstMissing, "slot-empty");
});

test("an empty page result reaches nothing and carries no row text", () => {
  const judged = judgeReach({
    page: { error: "x" },
    native: [],
    settledSlot: null,
  });
  assert.equal(judged.allReached, false);
  assert.equal(judged.firstMissing, "begin-pending");
  assert.doesNotMatch(JSON.stringify(judged), /cp4-dev|sceneId|entityId/u);
});

test("not-activated is the unavailable answer with that reason only", () => {
  assert.equal(
    judgeNotActivated({
      page: {
        begin: { graph: { status: "unavailable", reason: "not-activated" } },
      },
    }).notActivated,
    true,
  );
  assert.equal(
    judgeNotActivated({
      page: {
        begin: { graph: { status: "pending" } },
        graph: { status: "available" },
      },
    }).notActivated,
    false,
  );
  assert.equal(
    judgeNotActivated({
      page: {
        begin: { graph: { status: "unavailable", reason: "not-requested" } },
      },
    }).notActivated,
    false,
  );
});

test("used settle is reached only when its answer is settled", () => {
  const judge = (settles) =>
    judgeReach({
      page: REACHED_PAGE,
      native: REACHED_NATIVE,
      settledSlot: "empty",
      settles,
    });
  // 失効や未知の settle は例外でなく `unavailable: cancelled` で戻る。
  const cancelled = judge([
    REACHED_SETTLES[0],
    { settle: "used", status: "unavailable", reason: "cancelled", ok: true },
  ]);
  assert.equal(cancelled.reached["used-settle"], false);
  assert.equal(cancelled.firstMissing, "used-settle");
  assert.equal(cancelled.stages.settles[1].reason, "cancelled");
  // 呼出しが投げた場合、応答が無い場合、used の行が無い場合。
  assert.equal(
    judge([REACHED_SETTLES[0], { settle: "used", status: null, ok: false }])
      .reached["used-settle"],
    false,
  );
  assert.equal(judge([REACHED_SETTLES[0]]).reached["used-settle"], false);
  assert.equal(judge(undefined).reached["used-settle"], false);
  // slot empty は used settle の根拠にならない。
  assert.equal(judge([]).reached["slot-empty"], true);
  assert.equal(judge(REACHED_SETTLES).allReached, true);
});

const g01Base = [
  "--run",
  "x1",
  "--mode",
  "g01-frozen",
  "--setups",
  "s.json",
  "--ja-model",
  "ja",
  "--en-model",
  "en",
  ...["s4", "k62", "k64", "k65", "k66"].flatMap((name) => [
    name === "s4" ? "--s4-commit" : `--${name}-commit`,
    "a".repeat(40),
  ]),
];

test("g01-frozen takes the frozen setups, never a dev setup, and never the product .node", () => {
  assert.ok(MODES.includes("g01-frozen"));
  assert.equal(G01_VARIANT_KEY, "G-01/v1");
  assert.equal(parseArgs(g01Base).setups, "s.json");
  assert.throws(
    () => parseArgs(g01Base.filter((_, at) => at !== 4 && at !== 5)),
    /--setups is required/u,
  );
  assert.throws(
    () => parseArgs([...g01Base, "--setup", "s.json"]),
    /g01-frozen takes --setups/u,
  );
  assert.throws(
    () => parseArgs([...g01Base, "--product-native", "/p/x.node"]),
    /--product-native is for --mode not-activated/u,
  );
  // The head's commits are required for g01-frozen (one at a time) and refused
  // by the dev modes.
  for (const name of G01_HEAD_OPTIONS) {
    const at = g01Base.indexOf(`--${name}`);
    assert.throws(
      () => parseArgs(g01Base.filter((_, i) => i !== at && i !== at + 1)),
      new RegExp(`--${name} is required`, "u"),
    );
    assert.throws(
      () => parseArgs([...base, `--${name}`, "a".repeat(40)]),
      new RegExp(`--${name} is for --mode g01-frozen only`, "u"),
    );
  }
  // The dev modes keep their own setup receipt and refuse the frozen one.
  assert.throws(
    () => parseArgs([...base, "--setups", "s.json"]),
    /--setups is for --mode g01-frozen only/u,
  );
});

const ADMISSION = Object.freeze({
  purpose: "g01-e2e-diagnostic",
  fixturePath: "evals/nir1-g01/fixture.v1.json",
  fixtureSha256: "a".repeat(64),
  countsInCaseJudgement: false,
  session: "separate-diagnostic",
});

test("the G-01 record counts for no judgement, whatever the reach, and shows the lease path", () => {
  const reached = judgeReach({
    page: REACHED_PAGE,
    native: REACHED_NATIVE,
    settledSlot: "empty",
    settles: REACHED_SETTLES,
  });
  const yes = g01DiagnosticRecord({ judgement: reached, admission: ADMISSION });
  assert.equal(yes.countsInCaseJudgement, false);
  assert.equal(yes.reachedEndToEnd, true);
  assert.equal(yes.firstMissing, null);
  assert.deepEqual(yes.leaseEvidence, {
    continueAvailableGraphOnly: true,
    clickKeepClick: true,
    requeryCached: true,
    requeryContinueAvailable: true,
    usedSettle: true,
  });
  assert.equal(yes.purpose, "g01-e2e-diagnostic");
  assert.equal(yes.session, "separate-diagnostic");
  // The G-01 receipt's shape: Graph-only row exists but continue is cancelled.
  const cancelled = g01DiagnosticRecord({
    judgement: judgeReach({
      page: {
        ...REACHED_PAGE,
        graph: { status: "unavailable", reason: "cancelled" },
        click: undefined,
        settle: undefined,
        graphReady: undefined,
        requery: undefined,
      },
      native: [REACHED_NATIVE[0]],
      settledSlot: "empty",
      settles: [],
    }),
    admission: ADMISSION,
  });
  assert.equal(cancelled.countsInCaseJudgement, false);
  assert.equal(cancelled.reachedEndToEnd, false);
  assert.equal(cancelled.firstMissing, "continue-available-graph-only");
  assert.equal(cancelled.leaseEvidence.clickKeepClick, false);
  assert.equal(cancelled.leaseEvidence.usedSettle, false);
  // No judgement at all (the run stopped early) is not a reach either.
  const none = g01DiagnosticRecord({ admission: ADMISSION });
  assert.equal(none.reachedEndToEnd, false);
  assert.equal(none.firstMissing, "no-judgement");
  assert.equal(none.countsInCaseJudgement, false);
  assert.equal(g01DiagnosticRecord({}).countsInCaseJudgement, false);
  // Numbers, flags and digests only: no row text or identifier.
  assert.doesNotMatch(
    JSON.stringify(yes),
    /g01-(review|weather|mira|question|orin)|sceneId|entityId|"body"/u,
  );
  assert.match(G01_RESULT_SCHEMA, /^nir1-pubg-16-g01-e2e\/1$/u);
});

test("the G-01 diagnostic's head is the other receipts' head: freeze heads, the S4 commit with its record's SHA-256 and the start time; a missing part stops the run", () => {
  const parts = {
    k62: { freezeCommit: "1".repeat(40), sha256: "2".repeat(64) },
    k64: { freezeCommit: "3".repeat(40), sha256: "4".repeat(64) },
    k65: { freezeCommit: "5".repeat(40), sha256: "6".repeat(64) },
    k66: { freezeCommit: "7".repeat(40), sha256: "8".repeat(64) },
    observationPrep: {
      commit: "9".repeat(40),
      freezeRecordSha256: "a".repeat(64),
    },
  };
  const now = () => new Date("2026-11-09T01:02:03.000Z");
  const head = g01DiagnosticHeadOf(parts, { now });
  assert.equal(head.kind, "g01-diagnostic");
  assert.equal(head.observationPrep.commit, "9".repeat(40));
  assert.equal(head.observationPrep.freezeRecordSha256, "a".repeat(64));
  assert.equal(head.runStartedAtUtc, "2026-11-09T01:02:03.000Z");
  for (const name of ["k62", "k64", "k65", "k66"])
    assert.deepEqual(head[name], parts[name]);
  assert.equal(head.traces, undefined);
  for (const name of Object.keys(parts))
    assert.throws(
      () => g01DiagnosticHeadOf({ ...parts, [name]: undefined }),
      /\[precheck\]|receipt head is not complete/u,
      name,
    );
  assert.throws(
    () =>
      g01DiagnosticHeadOf({
        ...parts,
        observationPrep: { ...parts.observationPrep, commit: "main" },
      }),
    /observationPrep\.commit/u,
  );
});
