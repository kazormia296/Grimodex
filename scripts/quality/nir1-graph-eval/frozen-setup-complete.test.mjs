// CP-4 S1j-2: 凍結した G-case の完全な setup（⑤ 用）。fake の製品の page（一時の
// SQLite）と fixture から導いた plan だけで確かめる。凍結した材料で実 Electron を
// 起動せず、setup も実行しない（fixture は fs で読むだけ）。
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  BLOCKED_CONTRACT_TABLE,
  INDEX_BUILD_INTERVAL_MS,
  INDEX_BUILD_WAIT_MS,
  indexBuildUnmet,
  MAINTENANCE_REOPENS,
  MAINTENANCE_WAIT_MS,
  RELATION_ID_REUSE_REFUSAL,
  blockedRecord,
  assertRelationStaleOnCold,
  B_SEAL_REOPENS,
  B_SEAL_WAIT_MS,
  FRESHNESS_SETTLE_INTERVAL_MS,
  FRESHNESS_SETTLE_WAIT_MS,
  assertChronicleSetup,
  createSetupIds,
  guardPage,
  indexStateProbe,
  prepareFrozenSetupShared,
  runFrozenSetupSteps,
  setupFrozenVariant,
  setupIrRowsOfPlans,
} from "./frozen-setup-driver.mjs";
import {
  SETUP_STOPS,
  executedPhaseNames,
  loadFrozenSetupPlans,
} from "./frozen-setup-plan.mjs";
import { irTableRows } from "./setup-main-build.mjs";
import {
  assertCompleteSetupReceipt,
  loadSetupReceipt,
} from "./setup-receipt.mjs";
import { readChronicleSetupRows } from "./workspace-db.mjs";
import {
  REPO_ROOT,
  completeSetupExtension,
  frozenSetupFakeProduct,
  productReceipt,
} from "./test-support.mjs";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import { readFileSync } from "node:fs";

const COMPLETE = loadFrozenSetupPlans({
  root: REPO_ROOT,
  stopsAt: SETUP_STOPS.complete,
});
const PARTIAL = loadFrozenSetupPlans({
  root: REPO_ROOT,
  stopsAt: SETUP_STOPS.seedPin,
});
const planOf = (plans, key) => plans.find((plan) => plan.variantKey === key);

function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let counter = 0;
const uuid = () => `rt-${String(++counter).padStart(6, "0")}`;
const SEAM_ENV = "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER";
/** The setup-only Main's admission as the session sees it (sealed in production). */
const SETUP_MAIN = Object.freeze({
  setupMain: {
    path: "dist-electron/main-setup-ir.cjs",
    sha256: "e".repeat(64),
  },
  table: { path: "t", sha256: "f".repeat(64), rows: [] },
  productMain: { path: "dist-electron/main.cjs", sha256: "a".repeat(64) },
  reproducedProductMainSha256: "a".repeat(64),
  inputDiff: {
    removed: ["evals/nir1-retrieval/corpus.json"],
    added: ["t"],
    inputs: 1,
  },
  env: { GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1" },
});
const SHARED = Object.freeze({
  root: REPO_ROOT,
  server: null,
  observer: null,
  nativePath: "/nonexistent/grimodex-node.node",
  models: { ja: "ja", en: "en" },
  admission: null,
  tmpRoot: null,
  candidate: { commit: "a".repeat(40), tree: "b".repeat(40), clean: true },
  launch: { native: "product", nativeSha256: "c".repeat(64) },
  setupMain: SETUP_MAIN,
});

/** The provider's answers: the plan's IR rows by Scene body. */
function irSeedsOf(plan) {
  return new Map(
    setupIrRowsOfPlans([plan]).map((row) => [row.body, row.interpretationSeed]),
  );
}

function completeProduct(plan, options = {}) {
  return frozenSetupFakeProduct({
    extend: completeSetupExtension({ irSeeds: irSeedsOf(plan), ...options }),
  });
}

/** Sessions over one fake product; records each label, seam and Main. */
function fakeSessions(product, onStop = null) {
  const started = [];
  return {
    started,
    startSession: async ({ label, extraEnv, setupMain }) => {
      const seam = Object.hasOwn(extraEnv ?? {}, SEAM_ENV);
      started.push({ label, seam, setupMain: setupMain ?? null });
      product.extension.beginSession({ label, seam, setupMain });
      return {
        page: product.page,
        userData: "/nonexistent",
        evidence: { label, problems: [] },
        stop: async () => {
          onStop?.(label, product);
          product.close();
          return { label, problems: [] };
        },
      };
    },
  };
}

const noSleep = async () => {};

async function completeSetup(key, options = {}, shared = SHARED, extra = {}) {
  const plan = planOf(COMPLETE, key);
  const product = completeProduct(plan, options);
  const sessions = fakeSessions(product, extra.onStop);
  const setupDir = path.join(scratch("cp4-s1j2-"), plan.caseId, plan.variantId);
  const result = await setupFrozenVariant({
    plan,
    setupDir,
    shared,
    deps: {
      startSession: sessions.startSession,
      uuid,
      // DR-CP4-T-3: the product's Freshness runs while the driver waits.
      sleep: async () => product.extension.freshnessTick(),
      limits: {
        bSealMs: 50,
        maintenanceMs: 50,
        ...(extra.freshnessSettleMs
          ? { freshnessSettleMs: extra.freshnessSettleMs }
          : {}),
      },
    },
  });
  return { plan, product, sessions, ...result };
}

test("S1j-2 完全な setup（G-02/base、fake の製品）: 段の順は plan のとおり、session は author → ir（setup 専用の Main）→ seal（seam）、受領書は assertCompleteSetupReceipt を通る", async () => {
  const { plan, product, sessions, receipt, receiptPath } =
    await completeSetup("G-02/base");
  assert.equal(receipt.status, "setup-complete", receipt.errors.join("\n"));
  assert.deepEqual(
    receipt.phases.map((row) => row.name),
    executedPhaseNames(plan),
  );
  // seed の pin の段より前は ① と同じ並び（変えていない）。
  const partial = planOf(PARTIAL, "G-02/base");
  assert.deepEqual(
    receipt.phases.map((row) => row.name).slice(0, partial.stopIndex + 1),
    executedPhaseNames(partial),
  );
  assert.deepEqual(
    sessions.started.map((row) => [
      row.label,
      row.seam,
      row.setupMain !== null,
    ]),
    [
      ["author", false, false],
      ["ir", false, true],
      ["seal", true, false],
    ],
  );
  assert.equal(
    receipt.phases.find((row) => row.name === "setup-timeline:g02-ir").session,
    "ir",
  );
  // B2 (B'): the same runtime ID; the Revision bound to it goes stale.
  const map = receipt.logicalToRuntime;
  const recreated = map.relationRecreations["g02-dace-link"];
  assert.equal(recreated.mode, "same-id");
  assert.equal(recreated.runtimeId, recreated.previousRuntimeId);
  assert.equal(map.relations["g02-dace-link"], recreated.runtimeId);
  assert.deepEqual(recreated.revisionsBefore, { "g02-r-dace": "available" });
  assert.deepEqual(recreated.revisionsAfter, { "g02-r-dace": "unavailable" });
  assert.equal(recreated.after.relationType, "buys-from");
  // B1: one approved nonsecret child per qualifiedIr row.
  assert.deepEqual(Object.keys(map.chronicle), ["g02-attach"]);
  assert.equal(map.chronicle["g02-attach"].decision, "approved");
  assert.equal(receipt.readBack.chronicle.irs, 1);
  const ir = receipt.phases.find((row) => row.name === "setup-timeline:g02-ir");
  assert.deepEqual(ir.details.aiSettings.after, {
    provider: "ollama",
    model: "product-journey-model",
    ollamaEndpoint: "http://127.0.0.1:11434",
  });
  // The measurement point and its spec; the setup-only Main's identity.
  assert.deepEqual(receipt.measurementPoint.probe.graph, "usable");
  assert.deepEqual(receipt.measurementPoint.probe.chronicle, "usable");
  // DR-CP4-T-1: the Freshness feed at the measurement point and on the cold
  // DB (the fake product's feed is empty: nothing pending).
  for (const feed of [
    receipt.measurementPoint.freshnessFeed,
    receipt.readBack.freshnessFeed,
  ])
    assert.deepEqual(
      [feed.consumerId, feed.head, feed.pendingEvents, feed.cursor],
      ["narrative-incremental-freshness/v1", 0, 0, false],
    );
  assert.equal(receipt.measurementSpec.kind, "steady-state");
  assert.equal(receipt.setupMain.sha256, SETUP_MAIN.setupMain.sha256);
  assert.equal(receipt.setupMain.table.sha256, SETUP_MAIN.table.sha256);
  assert.deepEqual(
    receipt.seams.map((row) => row.session),
    ["seal"],
  );
  assert.equal(receipt.authorityUnchangedAfterFirstRevision, true);
  assert.equal(receipt.readBack.logicalRuntimeCheck.ok, true);
  const sealed = loadSetupReceipt({ root: REPO_ROOT, file: receiptPath });
  assert.equal(assertCompleteSetupReceipt(sealed), sealed);
  // No page entry was refused by the fake product.
  assert.deepEqual(product.forbidden, []);
});

test("S1j-2 G-02 (B''): 製品が同じ ID の再利用を拒めば新しい ID で作り、論理 ID の対応を新しい runtime ID に向けて受領書に残す", async () => {
  const { receipt } = await completeSetup("G-02/base", {
    refuseRelationIdReuse: true,
  });
  assert.equal(receipt.status, "setup-complete", receipt.errors.join("\n"));
  const recreated =
    receipt.logicalToRuntime.relationRecreations["g02-dace-link"];
  assert.equal(recreated.mode, "new-id");
  assert.notEqual(recreated.runtimeId, recreated.previousRuntimeId);
  assert.match(recreated.sameIdError, /UNIQUE constraint failed/u);
  assert.equal(
    receipt.logicalToRuntime.relations["g02-dace-link"],
    recreated.runtimeId,
  );
  assert.equal(receipt.readBack.logicalRuntimeCheck.ok, true);
});

test("S1j-2 G-08 の 5 variant: session と seam の分け方、query の有無、probe、deferred の Decision（B3、B4）", async () => {
  const expect = {
    "G-08/base-usable": {
      sessions: [
        ["author", false],
        ["ir", false],
        ["seal", true],
      ],
      queries: ["seal"],
      probe: ["usable", "usable"],
    },
    "G-08/graph-index-unusable": {
      sessions: [
        ["author", false],
        ["ir", false],
        ["seal", true],
        ["hold", false],
      ],
      queries: ["seal", "hold"],
      probe: ["unusable", "usable"],
    },
    "G-08/graph-recovered": {
      sessions: [
        ["author", false],
        ["ir", false],
        ["seal", true],
        ["hold", false],
        ["reseal", true],
      ],
      queries: ["seal", "reseal"],
      probe: ["usable", "usable"],
    },
    "G-08/chronicle-index-unusable": {
      sessions: [
        ["author", false],
        ["ir", false],
        ["seal", true],
        ["hold", false],
        ["reseal", true],
      ],
      queries: ["seal"],
      probe: ["usable", "unusable"],
    },
    "G-08/both-indexes-unusable": {
      sessions: [
        ["author", false],
        ["ir", false],
        ["seal", true],
        ["hold", false],
      ],
      queries: ["seal"],
      probe: ["unusable", "unusable"],
    },
  };
  for (const [key, want] of Object.entries(expect)) {
    const { product, sessions, receipt } = await completeSetup(key);
    assert.equal(receipt.status, "setup-complete", `${key}: ${receipt.errors}`);
    assert.deepEqual(
      sessions.started.map((row) => [row.label, row.seam]),
      want.sessions,
      key,
    );
    // B4: chronicle-index-unusable and both never query after the mutation.
    assert.deepEqual(product.extension.indexCalls, want.queries, key);
    const probe = receipt.measurementPoint.probe;
    assert.deepEqual([probe.graph, probe.chronicle], want.probe, key);
    assert.deepEqual(receipt.measurementPoint.declared, {
      chronicle: want.probe[1],
      graph: want.probe[0],
    });
    const withdrawn =
      key.endsWith("chronicle-index-unusable") ||
      key.endsWith("both-indexes-unusable");
    assert.equal(
      receipt.logicalToRuntime.decisions?.["g08-m-ir-withdraw"]?.decision ??
        null,
      withdrawn ? "deferred" : null,
      key,
    );
    if (withdrawn) {
      const decision = receipt.logicalToRuntime.decisions["g08-m-ir-withdraw"];
      const ir = receipt.logicalToRuntime.chronicle["g08-control"];
      assert.deepEqual(
        [decision.runId, decision.proposalId, decision.revisionId],
        [ir.runId, ir.proposalId, ir.childRevisionId],
      );
      assert.deepEqual(receipt.readBack.chronicle.withdrawn, ["g08-control"]);
    }
    assert.equal(
      receipt.measurementSpec.kind,
      withdrawn
        ? "one-shot"
        : key.endsWith("graph-index-unusable")
          ? "graph-held-unusable"
          : "steady-state",
      key,
    );
  }
});

test("S1j-2 probe が宣言の状態を示さなければ blocked:index-state-holding で止まり、query の snapshot が使えない C は usable と数えない", async () => {
  const { receipt } = await completeSetup("G-08/graph-index-unusable", {
    bStaysDirty: false,
  });
  assert.equal(receipt.status, "setup-complete");
  // B stays dirty after every seal: the base variant cannot reach its point.
  const blocked = await completeSetup("G-08/base-usable", {
    bStaysDirty: true,
  });
  assert.equal(blocked.receipt.status, "blocked");
  assert.match(
    blocked.receipt.precheck.message,
    /blocked:b-seal-not-published — G-08\/base-usable: the seal session saw no new sealed B generation in 3 openings/u,
  );
  // B sealed, then dirtied again before the measurement point.
  const dirtied = await completeSetup("G-02/base", { bDirtiedByQuery: true });
  assert.equal(dirtied.receipt.status, "blocked");
  // P-1 (DR-BSEAM-3): every opening sealed B and saw it go dirty; the
  // bound is spent and the attempts are recorded.
  assert.deepEqual(
    dirtied.receipt.sealAttempts.map((row) => [
      row.attempt,
      row.published,
      row.outcome,
    ]),
    [
      [0, true, "sealed-then-dirty"],
      [1, true, "sealed-then-dirty"],
      [2, true, "sealed-then-dirty"],
    ],
  );
  // Once dirtied after the seal: the reopening seals gen 2 and completes;
  // the receipt's phases hold the counted opening only.
  const once = await completeSetup("G-02/base", {
    bDirtiedByQuery: true,
    bDirtiedByQueryTimes: 1,
  });
  assert.equal(
    once.receipt.status,
    "setup-complete",
    once.receipt.errors.join("\n"),
  );
  assert.deepEqual(
    once.receipt.sealAttempts.map((row) => [row.attempt, row.outcome]),
    [
      [0, "sealed-then-dirty"],
      [1, "sealed"],
    ],
  );
  // Review P3 (d): the discarded rows keep their details and states.
  assert.ok(
    once.receipt.sealAttempts[0].discardedPhases.every(
      (row) => row.details && row.stateAfter && row.session === "seal",
    ),
  );
  assert.deepEqual(
    once.receipt.sealAttempts[0].discardedPhases.map((row) => row.name),
    ["b-seal", "chronicle-index"],
  );
  assert.deepEqual(
    once.receipt.phases.map((row) => row.name),
    executedPhaseNames(planOf(COMPLETE, "G-02/base")),
  );
  assert.equal(once.receipt.measurementPoint.probe.metadata.b.generation, 2);
  // B and the session's C both dirtied after the seal: the reopening
  // rebuilds both.
  const both = await completeSetup("G-02/base", {
    bDirtiedByQuery: true,
    bDirtiedByQueryTimes: 1,
    queryDirtiesC: true,
  });
  assert.equal(
    both.receipt.status,
    "setup-complete",
    both.receipt.errors.join("\n"),
  );
  assert.deepEqual(
    both.receipt.sealAttempts.map((row) => row.outcome),
    ["sealed-then-dirty", "sealed"],
  );
  assert.match(
    dirtied.receipt.precheck.message,
    /blocked:measurement-point-mismatch — G-02\/base: the probe shows graph unusable/u,
  );
  const usable = { generation: 2, dirty: false };
  assert.equal(
    indexStateProbe({
      metadata: { b: usable, chronicle: usable },
      lastQuery: { initialSnapshot: { indexUsable: false } },
    }).chronicle,
    "unusable",
  );
  assert.equal(
    indexStateProbe({
      metadata: { b: { generation: 1, dirty: true }, chronicle: usable },
    }).graph,
    "unusable",
  );
  assert.equal(
    indexStateProbe({ metadata: { b: null, chronicle: null } }).chronicle,
    "unusable",
  );
});

test("S1j-2 qualified-ir の取り違えと optional story inputs を拒む（Chronicle の読み戻し）", async () => {
  // A third context (an optional story input in the planner) is refused.
  const extra = await completeSetup("G-02/base", { extraContext: true });
  assert.equal(extra.receipt.status, "blocked");
  assert.match(extra.receipt.precheck.message, /optional story input/u);
  // The recorded child of another Scene, or another decision, is refused.
  const { plan, receipt } = await completeSetup("G-04/base");
  assert.equal(receipt.status, "setup-complete", receipt.errors.join("\n"));
  const cold = path.resolve(REPO_ROOT, receipt.coldDatabase.path);
  const rows = readChronicleSetupRows(cold, receipt.logicalToRuntime.projectId);
  const ids = {
    ...receipt.logicalToRuntime,
    chronicle: { ...receipt.logicalToRuntime.chronicle },
  };
  assert.equal(assertChronicleSetup({ plan, ids, rows }).irs, 2);
  const [a, b] = Object.keys(ids.chronicle);
  const swapped = {
    ...ids,
    chronicle: { [a]: ids.chronicle[b], [b]: ids.chronicle[a] },
  };
  assert.throws(
    () => assertChronicleSetup({ plan, ids: swapped, rows }),
    /\[precheck\] S1i logical-runtime/u,
  );
  // An envelope bound to another Scene, and a Chronicle run the plan did
  // not make, are refused (S1j-2 mutation M25, M27).
  const otherScene = JSON.parse(JSON.stringify(rows));
  otherScene[0].proposals[0].revisions[0].envelope.assertion.scope.scene.ref =
    "scene:another";
  assert.throws(
    () => assertChronicleSetup({ plan, ids, rows: otherScene }),
    /envelope is not the fixture's seed/u,
  );
  assert.throws(
    () =>
      assertChronicleSetup({
        plan,
        ids,
        rows: [...rows, { runId: "extra-run", proposals: [] }],
      }),
    /Chronicle runs/u,
  );
  const missing = { ...ids, chronicle: { [a]: ids.chronicle[a] } };
  assert.throws(
    () => assertChronicleSetup({ plan, ids: missing, rows }),
    /\[precheck\] S1i logical-runtime/u,
  );
  // A withdrawal the plan did not make (the last Decision is not approved).
  const g08 = planOf(COMPLETE, "G-08/base-usable");
  const withdrawnRun = await completeSetup("G-08/both-indexes-unusable");
  const withdrawnRows = readChronicleSetupRows(
    path.resolve(REPO_ROOT, withdrawnRun.receipt.coldDatabase.path),
    withdrawnRun.receipt.logicalToRuntime.projectId,
  );
  assert.throws(
    () =>
      assertChronicleSetup({
        plan: g08,
        ids: withdrawnRun.receipt.logicalToRuntime,
        rows: withdrawnRows,
      }),
    /last Decision is not approved/u,
  );
});

test("S1j-2 測定点の段を持たない完全な setup は受領書を setup-complete にしない", async () => {
  const base = planOf(COMPLETE, "G-03/base");
  const plan = {
    ...base,
    steps: base.steps.slice(0, -1),
    stopIndex: base.stopIndex - 1,
  };
  const product = completeProduct(plan);
  const sessions = fakeSessions(product);
  const { receipt } = await setupFrozenVariant({
    plan,
    setupDir: path.join(scratch("cp4-s1j2-nomp-"), "G-03", "base"),
    shared: SHARED,
    deps: {
      startSession: sessions.startSession,
      uuid,
      sleep: noSleep,
      limits: { bSealMs: 50, maintenanceMs: 50 },
    },
  });
  assert.equal(receipt.status, "blocked");
  assert.match(receipt.precheck.message, /no measurement point/u);
});

test("S1j-2 Chronicle の入口は session で限る: 抽出・child・承認は ir の session だけ、撤回は製品の Main の session だけ、qualified-ir の段も ir の外では止まる", async () => {
  const plan = planOf(COMPLETE, "G-02/base");
  for (const entry of [
    "chronicle.extract",
    "chronicle.revise",
    "chronicle.decide",
  ]) {
    assert.doesNotThrow(() => guardPage(plan, entry, "ir"));
    for (const session of ["author", "seal", "hold", "reseal", null])
      assert.throws(
        () => guardPage(plan, entry, session),
        /\[precheck\] S1i session/u,
      );
  }
  assert.throws(
    () => guardPage(plan, "chronicle.recordDecision", "ir"),
    /\[precheck\] S1i session/u,
  );
  // ① は Chronicle の入口を呼べない（S2 の範囲の外）。
  const partial = planOf(PARTIAL, "G-02/base");
  assert.throws(
    () => guardPage(partial, "chronicle.extract", "ir"),
    /\[precheck\] S1i r5-check/u,
  );
  // The qualified-ir executor refuses another session.
  const product = completeProduct(plan);
  await assert.rejects(
    runFrozenSetupSteps({
      plan: {
        ...plan,
        steps: plan.steps.map((step) => ({ ...step, session: "author" })),
      },
      page: product.page,
      workspacePath: path.join(scratch("cp4-s1j2-ir-"), "workspace"),
      ids: createSetupIds({ plan, uuid }),
      session: "author",
      phase: () => {},
      uuid,
      sleep: noSleep,
    }),
    /\[precheck\] S1i (qualified-ir|session)/u,
  );
  // A complete setup without the setup-only Main's admission stops before
  // its IR session.
  const { receipt, sessions } = await completeSetup(
    "G-02/base",
    {},
    {
      ...SHARED,
      setupMain: null,
    },
  );
  assert.equal(receipt.status, "blocked");
  assert.match(receipt.precheck.message, /setup-main/u);
  assert.deepEqual(
    sessions.started.map((row) => row.label),
    ["author"],
  );
});

test("S1j-2 setup 専用の Main の表は fixture から導く: plan の行と fixture の qualifiedIr が同じ 10 行（G-01〜G-08）", () => {
  const sources = [];
  const seen = new Set();
  for (const variant of GRAPH_EVAL_VARIANTS) {
    if (seen.has(variant.fixturePath)) continue;
    seen.add(variant.fixturePath);
    sources.push({
      caseId: variant.caseId,
      fixture: JSON.parse(
        readFileSync(path.join(REPO_ROOT, variant.fixturePath), "utf8"),
      ),
    });
  }
  const fromFixtures = irTableRows(sources);
  const fromPlans = setupIrRowsOfPlans(COMPLETE);
  assert.equal(fromFixtures.length, 10);
  const key = (row) => `${row.caseId}/${row.id}`;
  assert.deepEqual(
    [...fromPlans].sort((x, y) => (key(x) < key(y) ? -1 : 1)),
    [...fromFixtures].sort((x, y) => (key(x) < key(y) ? -1 : 1)),
  );
});

test("S1j-2 P-0: B の generation が来なければ seal の session を開き直し（上限は 120 s × 開き直し 2 回の定数）、使った回数・各回の待ち・maintenance の run を受領書に残す", async () => {
  assert.equal(B_SEAL_WAIT_MS, 120_000);
  assert.equal(B_SEAL_REOPENS, 2);
  // Two missed openings: the third publishes; the attempts are recorded.
  const two = await completeSetup("G-08/graph-recovered", {
    sealMissesOpens: 2,
  });
  assert.equal(
    two.receipt.status,
    "setup-complete",
    two.receipt.errors.join("\n"),
  );
  assert.deepEqual(
    two.sessions.started.map((row) => [row.label, row.seam]),
    [
      ["author", false],
      ["ir", false],
      ["seal", true],
      ["seal-reopen-1", true],
      ["seal-reopen-2", true],
      ["hold", false],
      ["reseal", true],
    ],
  );
  assert.deepEqual(
    two.receipt.sealAttempts.map((row) => [
      row.session,
      row.attempt,
      row.dirLabel,
      row.published,
    ]),
    [
      ["seal", 0, "seal", false],
      ["seal", 1, "seal-reopen-1", false],
      ["seal", 2, "seal-reopen-2", true],
      ["reseal", 0, "reseal", true],
    ],
  );
  for (const row of two.receipt.sealAttempts.slice(0, 2)) {
    assert.ok(row.waitedMs >= 0);
    assert.deepEqual(
      row.maintenanceRuns.map((run) => run.surface),
      ["dependency-verify"],
    );
  }
  // The B seal is recorded once, from the opening that published it.
  assert.equal(
    two.receipt.phases.filter((row) => row.name === "b-seal").length,
    1,
  );
  // A later step of the seal session fails (no reopening): the attempt is
  // still recorded.
  const later = await completeSetup("G-03/base", { buildIndexFails: true });
  assert.equal(later.receipt.status, "blocked");
  assert.match(later.receipt.precheck.message, /chronicle-index/u);
  assert.deepEqual(
    later.receipt.sealAttempts.map((row) => [
      row.session,
      row.attempt,
      row.outcome,
      row.published,
    ]),
    [["seal", 0, "failed", true]],
  );
  // Three missed openings exhaust the bound: fail closed.
  const three = await completeSetup("G-02/base", { sealMissesOpens: 3 });
  assert.equal(three.receipt.status, "blocked");
  assert.match(
    three.receipt.precheck.message,
    /blocked:b-seal-not-published — G-02\/base: the seal session saw no new sealed B generation in 3 openings/u,
  );
  assert.equal(three.receipt.sealAttempts.length, 3);
  assert.ok(three.receipt.sealAttempts.every((row) => !row.published));
  // In every plan the B seal is the first step of each seam session (the
  // only step a reopening repeats).
  for (const plan of COMPLETE)
    for (const row of plan.sessions.filter((entry) => entry.seam))
      assert.equal(
        plan.steps.find((step) => step.session === row.label).executor,
        "b-seal",
        `${plan.variantKey} ${row.label}`,
      );
});

test("レビュー P3 (a): 凍結した材料の 1 variant の run でも、setup 専用の Main の表は 13 variant の plan の全行（10 行）から作る", async () => {
  const root = scratch("cp4-s1j2-shared-");
  const files = {
    "dist/index.html": "index",
    "dist-electron/main.cjs": "main",
    "dist-electron/preload.cjs": "preload",
    "electron/native/grimodex-node/grimodex-node.node": "node",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  const candidate = {
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    clean: true,
  };
  const receipt = productReceipt({
    candidate: {
      ...productReceipt().candidate,
      resolvedHeadSha: candidate.commit,
      currentHeadSha: candidate.commit,
      resolvedHeadTreeSha: candidate.tree,
    },
    artifacts: Object.fromEntries(
      Object.entries(files).map(([file, text]) => [file, digest(text)]),
    ),
  });
  const built = [];
  const shared = await prepareFrozenSetupShared({
    runDir: path.join(root, "run"),
    options: {
      "product-receipt": "/nonexistent",
      "ja-model": "j",
      "en-model": "e",
      run: "r",
    },
    plans: [planOf(COMPLETE, "G-02/base")],
    irPlans: COMPLETE,
    deps: {
      candidateOf: () => candidate,
      readProductReceipt: () => ({ bytes: Buffer.from("{}"), value: receipt }),
      root,
      admit: () => ({ dryRun: true }),
      buildRenderer: async () => ({ rendererBundleSha256: null }),
      startServer: async () => ({ close: async () => {} }),
      bundle: async () => ({ sha256: "o".repeat(64) }),
      buildSetupMain: async (input) => {
        built.push(input);
        return SETUP_MAIN;
      },
    },
  });
  assert.equal(built.length, 1);
  assert.equal(built[0].source, "frozen");
  assert.equal(built[0].rows.length, 10);
  assert.deepEqual(
    [...new Set(built[0].rows.map((row) => row.caseId))].sort(),
    ["G-01", "G-02", "G-03", "G-04", "G-05", "G-06", "G-07", "G-08"],
  );
  assert.equal(shared.setupMain, SETUP_MAIN);
});

test("レビュー P2-3／P2-4: G-02 の旧 Revision は live でも cold DB でも stale、新しい ID は ID の再利用の拒否のときだけ", async () => {
  const ok = await completeSetup("G-02/base");
  assert.equal(
    ok.receipt.status,
    "setup-complete",
    ok.receipt.errors.join("\n"),
  );
  const stale = ok.receipt.readBack.relationStaleness["g02-r-dace"];
  assert.equal(stale.relation, "g02-dace-link");
  assert.notEqual(stale.stored, stale.current);
  assert.equal(stale.stored, stale.beforeToken);
  // Another failure of the same-ID create (not a reuse refusal) stops.
  const other = await completeSetup("G-02/base", {
    relationCreateError: "WORKSPACE_SWITCHING: workspace is switching",
  });
  assert.equal(other.receipt.status, "blocked");
  assert.match(
    other.receipt.precheck.message,
    /\[precheck\] S1i mutation: g02-m-dace-type: relation\.create with the same ID failed for another reason/u,
  );
  // The same-ID create answering another ID stops (M40).
  const otherId = await completeSetup("G-02/base", {
    recreatedReportsOtherId: true,
  });
  assert.equal(otherId.receipt.status, "blocked");
  assert.match(
    otherId.receipt.precheck.message,
    /g02-m-dace-type: the same-id mode created/u,
  );
  // The bound Revision staying available after the edit stops (live).
  const live = await completeSetup("G-02/base", {
    revisionStaysAvailable: true,
  });
  assert.equal(live.receipt.status, "blocked");
  assert.match(live.receipt.precheck.message, /available → unavailable/u);
  // The cold DB showing the stored token equal to the current one stops.
  assert.throws(
    () =>
      assertRelationStaleOnCold({
        cold: "/nonexistent",
        ids: ok.receipt.logicalToRuntime,
        read: () => ({ stored: "t", current: "t" }),
      }),
    /\[precheck\] S1i mutation: g02-m-dace-type: the cold DB does not show g02-r-dace stale/u,
  );
  assert.throws(
    () =>
      assertRelationStaleOnCold({
        cold: "/nonexistent",
        ids: ok.receipt.logicalToRuntime,
        read: () => ({ stored: null, current: "t" }),
      }),
    /\[precheck\] S1i mutation/u,
  );
  // Re-review P3 (a): a stored token that is not the Relation's token before
  // the edit is no evidence, even when it differs from the current one.
  const before = stale.beforeToken;
  assert.throws(
    () =>
      assertRelationStaleOnCold({
        cold: "/nonexistent",
        ids: ok.receipt.logicalToRuntime,
        read: () => ({ stored: "v9@x:relation:y", current: "t" }),
      }),
    /the cold DB does not show g02-r-dace stale/u,
  );
  // The pre-edit token still current (the edit did not change the row).
  assert.throws(
    () =>
      assertRelationStaleOnCold({
        cold: "/nonexistent",
        ids: ok.receipt.logicalToRuntime,
        read: () => ({ stored: before, current: before }),
      }),
    /the cold DB does not show g02-r-dace stale/u,
  );
  assert.equal(
    assertRelationStaleOnCold({
      cold: "/nonexistent",
      ids: ok.receipt.logicalToRuntime,
      read: () => ({ stored: before, current: "t" }),
    })["g02-r-dace"].stored,
    before,
  );
  assert.match(RELATION_ID_REUSE_REFUSAL.source, /codex_relations/u);
});

test("レビュー P2-1／P2-2: hold の最初の mutation の前に B と C が seal の generation で clean であることを照合し、blocked は harness の名前と README の id の写しを別の欄に残す", async () => {
  // Success: the pre-mutation state is recorded.
  const ok = await completeSetup("G-08/both-indexes-unusable");
  assert.equal(
    ok.receipt.status,
    "setup-complete",
    ok.receipt.errors.join("\n"),
  );
  assert.deepEqual(ok.receipt.preMutationIndexState.expected, {
    b: ok.receipt.preMutationIndexState.metadata.b.generation,
    chronicle: ok.receipt.preMutationIndexState.metadata.chronicle.generation,
  });
  assert.equal(ok.receipt.preMutationIndexState.metadata.b.dirty, false);
  // A B dirtied after the seal session (the P-1 race) stops before the
  // mutation: a Graph mismatch, README b-sealed-binding (DR-CP4-L-28).
  const raced = await completeSetup("G-08/graph-index-unusable", {
    bDirtiedByQuery: true,
  });
  assert.equal(raced.receipt.status, "blocked");
  assert.match(
    raced.receipt.precheck.message,
    /blocked:pre-mutation-index-state/u,
  );
  assert.deepEqual(raced.receipt.blocked, {
    harnessId: "pre-mutation-index-state",
    condition: "graph",
    unmetPreconditions: ["b-sealed-binding"],
    declaredPreconditions: [
      "b-sealed-binding",
      "maintenance-enabled",
      "raw-membership",
      "index-state-holding",
    ],
    contractBlockedId: "b-sealed-binding",
    hold: false,
    precheck: false,
  });
  // The mutation never ran.
  assert.ok(
    !raced.receipt.phases.some(
      (row) => row.name === "setup-timeline:g08-m-juno",
    ),
  );
  // b-seal-not-published maps to b-sealed-binding (G-01 is Hold).
  const g02 = await completeSetup("G-02/base", { sealMissesOpens: 3 });
  assert.equal(g02.receipt.blocked.harnessId, "b-seal-not-published");
  assert.equal(g02.receipt.blocked.contractBlockedId, "b-sealed-binding");
  const g01 = await completeSetup("G-01/v1", { sealMissesOpens: 3 });
  assert.deepEqual(
    [
      g01.receipt.blocked.harnessId,
      g01.receipt.blocked.contractBlockedId,
      g01.receipt.blocked.hold,
    ],
    ["b-seal-not-published", null, true],
  );
});

/**
 * DR-CP4-L-28 (integrator's table; S2's blockedCaseJudgement rows with the
 * two undecided rows decided): harnessId × condition → G-01 and G-02〜G-08.
 */
const BLOCKED_TABLE_EXPECTED = [
  ["b-seal-not-published", "any", "hold", "blocked:b-sealed-binding"],
  ["measurement-point-mismatch", "graph", "hold", "blocked:b-sealed-binding"],
  [
    "measurement-point-mismatch",
    "chronicle-only",
    "hold-and-precheck",
    "hold-and-precheck",
  ],
  [
    "index-state-holding",
    "while-variant",
    "not-applicable",
    "blocked:index-state-holding",
  ],
  [
    "pre-mutation-index-state",
    "graph",
    "not-applicable",
    "blocked:b-sealed-binding",
  ],
  [
    "pre-mutation-index-state",
    "chronicle-only",
    "not-applicable",
    "hold-and-precheck",
  ],
  [
    "maintenance-enabled",
    "maintenance-wait-exhausted",
    "blocked:maintenance-enabled",
    "blocked:maintenance-enabled",
  ],
  [
    "index-build-timeout",
    "while-variant",
    "not-applicable",
    "blocked:index-state-holding",
  ],
  [
    "index-build-timeout",
    "other-variant",
    "hold-and-precheck",
    "hold-and-precheck",
  ],
];

test("DR-CP4-L-28: blocked の写しは integrator の表のとおり（G-01 と G-02〜G-08、S2 の blockedCaseJudgement の行ごと）", () => {
  const judgement = (record) =>
    record.contractBlockedId !== null
      ? `blocked:${record.contractBlockedId}`
      : record.precheck
        ? "hold-and-precheck"
        : "hold";
  const g01 = planOf(COMPLETE, "G-01/v1");
  const plans = {
    "while-variant": planOf(COMPLETE, "G-08/graph-index-unusable"),
    other: planOf(COMPLETE, "G-02/base"),
  };
  assert.deepEqual(
    BLOCKED_CONTRACT_TABLE.map((row) => [
      row.harnessId,
      row.condition,
      row.g01,
      row.graphCases,
    ]),
    BLOCKED_TABLE_EXPECTED,
  );
  for (const [
    harnessId,
    condition,
    wantG01,
    wantGraph,
  ] of BLOCKED_TABLE_EXPECTED) {
    const graphPlan =
      condition === "while-variant" ? plans["while-variant"] : plans.other;
    assert.equal(
      judgement(
        blockedRecord({ plan: graphPlan, blocked: { harnessId, condition } }),
      ),
      wantGraph,
      `${harnessId}/${condition} G-02〜G-08`,
    );
    if (wantG01 !== "not-applicable")
      assert.equal(
        judgement(
          blockedRecord({ plan: g01, blocked: { harnessId, condition } }),
        ),
        wantG01,
        `${harnessId}/${condition} G-01`,
      );
  }
  // A pair the table does not name is a [precheck] (no silent mapping).
  assert.throws(
    () =>
      blockedRecord({
        plan: plans.other,
        blocked: { harnessId: "b-seal-not-published", condition: "graph" },
      }),
    /\[precheck\] S1i blocked-map/u,
  );
  // maintenance-enabled is mapped only from the maintenance wait; the
  // other harness names never write the precondition maintenance-enabled.
  for (const row of BLOCKED_CONTRACT_TABLE)
    if (row.harnessId !== "maintenance-enabled")
      assert.ok(
        ![row.g01, row.graphCases].includes("blocked:maintenance-enabled"),
        row.harnessId,
      );
  // The unmet preconditions are recorded in README order.
  assert.deepEqual(
    blockedRecord({
      plan: plans.other,
      blocked: {
        harnessId: "measurement-point-mismatch",
        condition: "graph",
        unmet: ["index-state-holding", "b-sealed-binding"],
      },
    }).unmetPreconditions,
    ["b-sealed-binding", "index-state-holding"],
  );
});

test("P-5: author の session の maintenance の段（cutover marker）は 180 s × 開き直し 2 回の定数で開き直し、前の段を書き直さず、回の記録を受領書に残す", async () => {
  assert.equal(MAINTENANCE_WAIT_MS, 180_000);
  assert.equal(MAINTENANCE_REOPENS, 2);
  const once = await completeSetup("G-02/base", { cutoverMissesOpens: 1 });
  assert.equal(
    once.receipt.status,
    "setup-complete",
    once.receipt.errors.join("\n"),
  );
  assert.deepEqual(
    once.sessions.started.map((row) => row.label),
    ["author", "author-reopen-1", "ir", "seal"],
  );
  assert.deepEqual(
    once.receipt.maintenanceAttempts.map((row) => [
      row.attempt,
      row.dirLabel,
      row.outcome,
      row.settingWrites,
    ]),
    [
      [0, "author", "not-reached", 1],
      [1, "author-reopen-1", "reached", 0],
    ],
  );
  assert.deepEqual(
    once.receipt.maintenanceAttempts.map((row) => row.settingWritesTotal),
    [1, 1],
  );
  assert.equal(
    once.receipt.maintenanceAttempts[0].missing,
    "the canonical cutover marker",
  );
  // Idempotent resumption: the setting is written once, every phase once,
  // and the read-back finds no duplicate row.
  assert.equal(once.product.extension.policySets.length, 1);
  assert.deepEqual(
    once.receipt.phases.map((row) => row.name),
    executedPhaseNames(planOf(COMPLETE, "G-02/base")),
  );
  assert.equal(once.receipt.readBack.logicalRuntimeCheck.ok, true);
  const sealed = loadSetupReceipt({ root: REPO_ROOT, file: once.receiptPath });
  assert.equal(assertCompleteSetupReceipt(sealed), sealed);
  // Three openings without the marker: fail closed.
  const three = await completeSetup("G-05/base", { cutoverMissesOpens: 3 });
  assert.equal(three.receipt.status, "blocked");
  assert.match(
    three.receipt.precheck.message,
    /blocked:maintenance-enabled — the canonical cutover marker did not appear/u,
  );
  assert.equal(three.receipt.blocked.contractBlockedId, "maintenance-enabled");
  assert.deepEqual(
    three.receipt.maintenanceAttempts.map((row) => row.outcome),
    ["not-reached", "not-reached", "not-reached"],
  );
  assert.deepEqual(
    three.sessions.started.map((row) => row.label),
    ["author", "author-reopen-1", "author-reopen-2"],
  );
});

test("P-6: Chronicle の Index の build は照会の間隔 500 ms・待ち 120 s の定数で、受領書に indexBuild を残し、使い切れば blocked:index-build-timeout（開き直さない）", async () => {
  assert.equal(INDEX_BUILD_INTERVAL_MS, 500);
  assert.equal(INDEX_BUILD_WAIT_MS, 120_000);
  const ok = await completeSetup("G-08/graph-index-unusable");
  assert.equal(
    ok.receipt.status,
    "setup-complete",
    ok.receipt.errors.join("\n"),
  );
  assert.deepEqual(
    ok.product.extension.indexInputs.map((row) => [
      row.intervalMs,
      row.limitMs,
    ]),
    [
      [500, 120_000],
      [500, 120_000],
    ],
  );
  assert.deepEqual(
    ok.receipt.indexBuilds.map((row) => [
      row.phase,
      row.session,
      row.intervalMs,
      row.limitMs,
      row.queries,
      typeof row.usableAfterMs,
      typeof row.maintenanceCancelled,
    ]),
    [
      ["chronicle-index", "seal", 500, 120_000, 1, "number", "number"],
      [
        "chronicle-index:after-mutation",
        "hold",
        500,
        120_000,
        1,
        "number",
        "number",
      ],
    ],
  );
  // Timeouts: no reopening, the harness's name, the README mapping.
  const base = await completeSetup("G-02/base", { buildIndexFailsIn: "seal" });
  assert.equal(base.receipt.status, "blocked");
  assert.match(
    base.receipt.precheck.message,
    /blocked:index-build-timeout — G-02\/base/u,
  );
  assert.equal(
    base.sessions.started.filter((row) => row.label.startsWith("seal")).length,
    1,
  );
  assert.deepEqual(
    [base.receipt.blocked.contractBlockedId, base.receipt.blocked.hold],
    [null, true],
  );
  assert.equal(base.receipt.indexBuilds[0].usableAfterMs, null);
  const held = await completeSetup("G-08/graph-index-unusable", {
    buildIndexFailsIn: "hold",
  });
  assert.equal(held.receipt.blocked.contractBlockedId, "index-state-holding");
  const sealed = await completeSetup("G-08/graph-index-unusable", {
    buildIndexFailsIn: "seal",
  });
  // DR-CP4-L-28: a while- variant's timeout is index-state-holding,
  // whatever the step.
  assert.equal(sealed.receipt.blocked.contractBlockedId, "index-state-holding");
  assert.deepEqual(
    indexBuildUnmet({ measurementPoint: null }, "chronicle-index"),
    [],
  );
});

// DR-CP4-T-3: the complete setup waits for the product's Freshness before it
// closes a session and before the Chronicle Index and the measurement point,
// so the cold DB has nothing left that a measurement process would process.

const settlePoints = (receipt) =>
  receipt.freshnessSettles.map((row) => `${row.session}:${row.point}`);

test("DR-CP4-T-3: 待ちの定数は 60 s・250 ms で、G-02 型の未処理（型の編集の feed）は author の session を閉じる前に処理され、B と C はその後に封印される", async () => {
  assert.equal(FRESHNESS_SETTLE_WAIT_MS, 60_000);
  assert.equal(FRESHNESS_SETTLE_INTERVAL_MS, 250);
  const { receipt } = await completeSetup("G-02/base", {
    freshness: { settles: true },
  });
  assert.equal(receipt.status, "setup-complete", receipt.errors.join("\n"));
  assert.deepEqual(settlePoints(receipt), [
    "author:session-end",
    "ir:session-end",
    "seal:before:chronicle-index",
    "seal:before:measurement-point",
    "seal:session-end",
  ]);
  const authorEnd = receipt.freshnessSettles[0].settle;
  assert.ok(authorEnd.initial.pendingEvents > 0);
  assert.equal(authorEnd.final.pendingEvents, 0);
  assert.ok(receipt.freshnessSettles.every((row) => row.settle.settled));
  // The seal session opened on a settled feed: one seal, B and C usable.
  assert.deepEqual(
    receipt.sealAttempts.map((row) => row.outcome),
    ["sealed"],
  );
  assert.equal(receipt.measurementPoint.probe.graph, "usable");
  assert.equal(receipt.measurementPoint.probe.chronicle, "usable");
  assert.equal(receipt.measurementPoint.freshnessFeed.pendingEvents, 0);
  assert.equal(receipt.readBack.freshnessFeed.pendingEvents, 0);
  assert.equal(
    receipt.readBack.freshnessFeed.acknowledged,
    receipt.readBack.freshnessFeed.head,
  );
});

test("DR-CP4-T-3: G-08/graph-index-unusable は hold の session の編集の feed を C の作り直しの前に処理し、作り直した C は使え B は dirty のまま", async () => {
  const { receipt } = await completeSetup("G-08/graph-index-unusable", {
    freshness: { settles: true },
  });
  assert.equal(receipt.status, "setup-complete", receipt.errors.join("\n"));
  const before = receipt.freshnessSettles.find(
    (row) =>
      row.session === "hold" && row.point.startsWith("before:chronicle-index"),
  );
  assert.ok(before.settle.initial.pendingEvents > 0);
  assert.equal(before.settle.final.pendingEvents, 0);
  assert.equal(receipt.measurementPoint.probe.chronicle, "usable");
  assert.equal(receipt.measurementPoint.probe.graph, "unusable");
  assert.equal(receipt.readBack.freshnessFeed.pendingEvents, 0);
});

test("DR-CP4-T-3: Freshness が上限までに処理し終えなければ [precheck] freshness-settle で止める（blocked にしない）", async () => {
  const { receipt, sessions } = await completeSetup(
    "G-02/base",
    { freshness: { settles: false } },
    SHARED,
    { freshnessSettleMs: 30 },
  );
  assert.notEqual(receipt.status, "setup-complete");
  // It stops at the author session's end: no later session opens.
  assert.deepEqual(
    sessions.started.map((row) => row.label),
    ["author"],
  );
  assert.equal(receipt.blocked ?? null, null);
  assert.match(
    [receipt.precheck?.message, ...receipt.errors].join("\n"),
    /\[precheck\] S1i freshness-settle/u,
  );
  assert.equal(receipt.freshnessSettles.at(-1).settle.settled, false);
  assert.equal(receipt.freshnessSettles.at(-1).point, "session-end");
});

test("DR-CP4-T-3: 最後の session を閉じた後の cold DB に未処理が残れば [precheck]（測定の process に無効化を残さない）", async () => {
  const { receipt } = await completeSetup(
    "G-02/base",
    { freshness: { settles: true } },
    SHARED,
    {
      // A write after the last wait (as if the product appended an event
      // while the session closed).
      onStop: (label, product) => {
        if (label !== "seal") return;
        product.extension.appendFeedEvent();
      },
    },
  );
  assert.notEqual(receipt.status, "setup-complete");
  assert.match(
    [receipt.precheck?.message, ...receipt.errors].join("\n"),
    /\[precheck\] S1i freshness-settle: .*cold DB/u,
  );
});
