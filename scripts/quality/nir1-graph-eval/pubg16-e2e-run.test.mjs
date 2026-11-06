// PUB-G 前提 #16 の runner（DR-PUBG-16-1）：引数と、到達の判定（pure）。
// 実 Native は起動しない。
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { loadDevFixture } from "./dev-fixture.mjs";
import {
  MODES,
  STAGES,
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
  });
  assert.equal(unavailable.firstMissing, "click-keep-click");
  assert.equal(unavailable.stages.click.reason, "failed");
  const notCached = judgeReach({
    page: REACHED_PAGE,
    native: [REACHED_NATIVE[0], { begin: "pending", disposition: null }],
    settledSlot: "empty",
  });
  assert.equal(notCached.firstMissing, "requery-cached");
  const thrown = judgeReach({
    page: { ...REACHED_PAGE, errors: ["settle failed"] },
    native: REACHED_NATIVE,
    settledSlot: "empty",
  });
  assert.equal(thrown.firstMissing, "used-settle");
  const slot = judgeReach({
    page: REACHED_PAGE,
    native: REACHED_NATIVE,
    settledSlot: "suspended",
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
