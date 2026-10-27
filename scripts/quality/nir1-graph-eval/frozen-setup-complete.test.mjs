// CP-4 S1j-2: 凍結した G-case の完全な setup（⑤ 用）。fake の製品の page（一時の
// SQLite）と fixture から導いた plan だけで確かめる。凍結した材料で実 Electron を
// 起動せず、setup も実行しない（fixture は fs で読むだけ）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  B_SEAL_REOPENS,
  B_SEAL_WAIT_MS,
  assertChronicleSetup,
  createSetupIds,
  guardPage,
  indexStateProbe,
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
function fakeSessions(product) {
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
          product.close();
          return { label, problems: [] };
        },
      };
    },
  };
}

const noSleep = async () => {};

async function completeSetup(key, options = {}, shared = SHARED) {
  const plan = planOf(COMPLETE, key);
  const product = completeProduct(plan, options);
  const sessions = fakeSessions(product);
  const setupDir = path.join(scratch("cp4-s1j2-"), plan.caseId, plan.variantId);
  const result = await setupFrozenVariant({
    plan,
    setupDir,
    shared,
    deps: {
      startSession: sessions.startSession,
      uuid,
      sleep: noSleep,
      limits: { bSealMs: 50 },
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
  assert.match(recreated.sameIdError, /ID reuse refused/u);
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
  // The seal attempt is recorded although a later step stopped the run.
  assert.deepEqual(
    dirtied.receipt.sealAttempts.map((row) => [row.attempt, row.published]),
    [[0, true]],
  );
  assert.match(
    dirtied.receipt.precheck.message,
    /blocked:maintenance-enabled — G-02\/base: the probe shows graph unusable/u,
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
      limits: { bSealMs: 50 },
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
