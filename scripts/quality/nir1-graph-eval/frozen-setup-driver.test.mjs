// CP-4 S1i: 凍結した G-case の setup の driver。fake の製品の page（一時の SQLite）と
// fixture から導いた plan だけで確かめる。凍結した材料で実 Electron を起動せず、
// setup も実行しない（fixture は fs で読むだけ）。
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  B_SEAL_REOPENS,
  R5_CHECK_ALLOWED_IPC,
  R5_CHECK_ALLOWED_PAGE,
  assertBuildMatchesProductReceipt,
  assertLogicalRuntimeMap,
  createSetupIds,
  frozenSetupFixturePins,
  guardIpc,
  guardPage,
  prepareFrozenSetupShared,
  runFrozenSetupSteps,
  setupFrozenVariant,
} from "./frozen-setup-driver.mjs";
import {
  SETUP_STOPS,
  assertR5CheckPhases,
  executedPhaseNames,
  loadFrozenSetupPlans,
} from "./frozen-setup-plan.mjs";
import { assessSeedPinStep, SEED_PIN_WRITER } from "./seed-pin-setup.mjs";
import { assertSeedPinsBeforeK64 } from "./seed-pin.mjs";
import {
  FROZEN_SETUP_RECEIPT_SCHEMA,
  SEAL_OPENINGS_MAX,
  assertCompleteSetupReceipt,
  loadSetupReceipt,
} from "./setup-receipt.mjs";
import {
  readFrozenSetupRows,
  readQuerySceneSeedPins,
} from "./workspace-db.mjs";
import {
  COMPLETE_SETUP_FIELDS,
  REPO_ROOT,
  frozenSetupFakeProduct,
  productReceipt,
} from "./test-support.mjs";

const PARTIAL = loadFrozenSetupPlans({
  root: REPO_ROOT,
  stopsAt: SETUP_STOPS.seedPin,
});
const COMPLETE = loadFrozenSetupPlans({
  root: REPO_ROOT,
  stopsAt: SETUP_STOPS.complete,
});
const planOf = (plans, key) => plans.find((plan) => plan.variantKey === key);

function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let counter = 0;
const uuid = () => `rt-${String(++counter).padStart(6, "0")}`;

/** A session factory over one fake product per session label. */
function fakeSessions(product) {
  const started = [];
  return {
    started,
    startSession: async ({ label, extraEnv }) => {
      started.push({ label, extraEnv: Object.keys(extraEnv ?? {}) });
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

const SHARED = Object.freeze({
  root: REPO_ROOT,
  server: null,
  observer: null,
  nativePath: "/nonexistent/grimodex-node.node",
  models: { ja: "ja", en: "en" },
  admission: null,
  tmpRoot: null,
  candidate: {
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    clean: true,
  },
  launch: { native: "product", nativeSha256: "c".repeat(64) },
  // S1j P2-4: a seed-pin setup names the R5 check run it belongs to.
  r5CheckRunId: "r5-test-run",
});

function deepKeys(value, out = new Set()) {
  if (value !== null && typeof value === "object")
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      deepKeys(inner, out);
    }
  return out;
}

test("① の部分実行（G-02/base、fake の製品）: 段は plan のとおり seed の pin の段で止まり、writer は許した入口だけ、upsertScenePin は問いの Scene に 1 回", async () => {
  const plan = planOf(PARTIAL, "G-02/base");
  const product = frozenSetupFakeProduct();
  const ids = createSetupIds({ plan, uuid });
  const phases = [];
  const ctx = await runFrozenSetupSteps({
    plan,
    page: product.page,
    workspacePath: path.join(scratch("cp4-s1i-ws-"), "workspace"),
    ids,
    session: "author",
    phase: (name, details) => phases.push({ name, ...details }),
    uuid,
  });
  const names = phases.map((row) => row.name);
  assert.deepEqual(names, executedPhaseNames(plan));
  assert.equal(assertR5CheckPhases({ plan, phases: names }).ok, true);
  assert.deepEqual(product.forbidden, []);
  for (const call of product.calls)
    assert.ok(
      R5_CHECK_ALLOWED_IPC.includes(call) ||
        R5_CHECK_ALLOWED_PAGE.includes(call),
      call,
    );
  // fixture の pin（6）と seed の pin（1）。問いの Scene への書込みは 1 回だけ。
  const pinCalls = product.calls.filter(
    (call) => call === "api.upsertScenePin",
  );
  assert.equal(pinCalls.length, 7);
  const querySceneRuntime = ids.scenes["g02-query"];
  const rows = readFrozenSetupRows(product.file(), ids.projectId);
  assert.deepEqual(
    rows.pins.filter((pin) => pin.sceneId === querySceneRuntime),
    [{ sceneId: querySceneRuntime, entryId: ids.entities["g02-orla"] }],
  );
  // fixture の pin は変わらない（問いの Scene の外の pin は fixture の pin と同じ）。
  const outside = rows.pins.filter((pin) => pin.sceneId !== querySceneRuntime);
  const fixturePins = frozenSetupFixturePins(plan, ids);
  assert.deepEqual(
    outside.map((pin) => `${pin.sceneId}/${pin.entryId}`).sort(),
    fixturePins.map((pin) => `${pin.sceneId}/${pin.entryId}`).sort(),
  );
  // SP/1 の記録（S1g-A の形）と SP-P1・SP-P2。
  assert.equal(ctx.seedPinRecord.writer, SEED_PIN_WRITER);
  assert.equal(assessSeedPinStep(ctx.seedPinRecord, { fixturePins }).ok, true);
  // 各 phase の前後の状態（workspace を開く前の project の前は null）。
  assert.equal(phases[0].stateBefore, null);
  for (const row of phases) assert.ok(row.stateAfter, row.name);
  const pinsPhase = phases.find((row) => row.name === "pins");
  assert.equal(pinsPhase.stateBefore.pins, 0);
  assert.equal(pinsPhase.stateAfter.pins, 6);
  const seedPhase = phases.find((row) => row.name === "seed-pin");
  assert.equal(seedPhase.stateAfter.pins, 7);
  assert.equal(rows.maintenanceEnabled, false);
  assert.equal(assertLogicalRuntimeMap({ plan, ids, rows }).ok, true);
  // IR を持つ Scene（g02-attach）は自分の folder の中の a0、folder はその読む順の位置。
  const nodes = new Map(rows.scenes.map((row) => [row.id, row]));
  const folder = nodes.get(ids.folders["nir1-folder-g02-attach"]);
  assert.deepEqual(
    {
      nodeType: folder.nodeType,
      parentId: folder.parentId,
      title: folder.title,
    },
    { nodeType: "folder", parentId: null, title: "Slate question" },
  );
  const attach = nodes.get(ids.scenes["g02-attach"]);
  assert.deepEqual(
    { parentId: attach.parentId, sortOrder: attach.sortOrder },
    { parentId: folder.id, sortOrder: "a0" },
  );
  const roots = rows.scenes
    .filter((row) => row.parentId === null)
    .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1))
    .map((row) => row.id);
  assert.deepEqual(roots, [
    ids.scenes["g02-review"],
    ids.scenes["g02-probe"],
    folder.id,
    ids.scenes["g02-tamsin-first"],
    ids.scenes["g02-rook-decoy"],
    ids.scenes["g02-dace-decoy"],
    ids.scenes["g02-harbor"],
    ids.scenes["g02-query"],
  ]);
  assert.equal(Object.keys(ids.folders).length, 1);
  for (const row of rows.scenes)
    assert.deepEqual(
      [row.storyTimeOrder, row.povCharacterId],
      [null, null],
      row.id,
    );
});

test("① の setup を 13 の variant で（fake の製品）: variant ごとの cold DB と受領書、R5 の照合が match、DB の使い回しは拒む", async () => {
  const root = scratch("cp4-s1i-13-");
  const cases = [];
  const receipts = [];
  for (const plan of PARTIAL) {
    const product = frozenSetupFakeProduct();
    const sessions = fakeSessions(product);
    const setupDir = path.join(root, plan.caseId, plan.variantId);
    const { receipt, receiptPath } = await setupFrozenVariant({
      plan,
      setupDir,
      shared: SHARED,
      deps: { startSession: sessions.startSession, uuid },
    });
    // ① は author の session だけ（B-ROUTE の seam の seal の session を開かない）。
    assert.deepEqual(sessions.started, [{ label: "author", extraEnv: [] }]);
    assert.equal(receipt.status, "setup-through-seed-pin", plan.variantKey);
    assert.equal(receipt.schemaVersion, FROZEN_SETUP_RECEIPT_SCHEMA);
    assert.deepEqual(receipt.fixture, {
      kind: "frozen",
      caseId: plan.caseId,
      variantId: plan.variantId,
      path: plan.fixturePath,
      sha256: plan.fixtureSha256,
      fixtureId: plan.fixtureId,
    });
    assert.equal(receipt.stopsAt, SETUP_STOPS.seedPin);
    assert.deepEqual(receipt.candidate, SHARED.candidate);
    assert.deepEqual(
      receipt.phases.map((row) => row.name),
      executedPhaseNames(plan),
    );
    assert.equal(receipt.seedPin.ok, true);
    assert.equal(receipt.readBack.logicalRuntimeCheck.ok, true);
    assert.equal(receipt.readBack.maintenanceEnabled, false);
    // folder（harness の値）は Scene と別の対応に残す。
    assert.deepEqual(
      Object.keys(receipt.logicalToRuntime.folders).sort(),
      plan.steps
        .find((step) => step.phase === "scenes")
        .input.rows.filter((row) => row.folder)
        .map((row) => row.folder.logicalId)
        .sort(),
    );
    assert.equal(receipt.readBack.logicalRuntimeCheck.folders > 0, true);
    // ① の受領書は Index の状態（B の seal、Graph index、IR、metadata）を書かない。
    const keys = deepKeys(receipt);
    for (const key of [
      "metadata",
      "metadataAfterAuthor",
      "seal",
      "preconditionEvidence",
      "chronicle",
      "generation",
      "dirty",
    ])
      assert.ok(!keys.has(key), `${plan.variantKey} records ${key}`);
    const setup = loadSetupReceipt({ root: REPO_ROOT, file: receiptPath });
    assert.equal(setup.stopsAt, SETUP_STOPS.seedPin);
    // ④ と ⑤ は ① の受領書を使わない。
    assert.throws(() => assertCompleteSetupReceipt(setup), /\[precheck\]/u);
    const read = readQuerySceneSeedPins(
      setup.coldDatabase.path,
      setup.projectId,
      setup.scenes[plan.querySceneId],
    );
    cases.push({ caseId: plan.caseId, variantId: plan.variantId, setup, read });
    receipts.push({ plan, setup });
  }
  assert.equal(
    new Set(cases.map((row) => row.setup.coldDatabase.path)).size,
    13,
  );
  const seedPlan = PARTIAL.map((plan) => plan.seedPin);
  assert.equal(
    assertSeedPinsBeforeK64({
      cases,
      plan: "frozen",
      seedPlan,
      stage: "r5-check",
    }).status,
    "match",
  );
  // 別の variant の cold DB を読んだ行は止める（workspace の使い回し）。
  const reused = cases.map((row, at) =>
    at === 3
      ? {
          ...row,
          read: readQuerySceneSeedPins(
            cases[2].setup.coldDatabase.path,
            cases[2].setup.projectId,
            cases[2].read.source.sceneId,
          ),
        }
      : row,
  );
  assert.throws(
    () =>
      assertSeedPinsBeforeK64({
        cases: reused,
        plan: "frozen",
        seedPlan,
        stage: "r5-check",
      }),
    /\[precheck\] R5/u,
  );
});

test("論理→runtime の対応の取り違えを拒む（Entity、Scene、Relation、伏線、Scope の holder、pin）", async () => {
  const run = async (key, mutate) => {
    const plan = planOf(PARTIAL, key);
    const product = frozenSetupFakeProduct(mutate ? { mutate } : {});
    const ids = createSetupIds({ plan, uuid });
    await runFrozenSetupSteps({
      plan,
      page: product.page,
      workspacePath: path.join(scratch("cp4-s1i-mix-"), "workspace"),
      ids,
      session: "author",
      phase: () => {},
      uuid,
    });
    return {
      plan,
      ids,
      rows: readFrozenSetupRows(product.file(), ids.projectId),
    };
  };
  const g02 = await run("G-02/base");
  assert.equal(assertLogicalRuntimeMap(g02).ok, true);
  const swap = (map, a, b) => ({ ...map, [a]: map[b], [b]: map[a] });
  for (const ids of [
    { ...g02.ids, entities: swap(g02.ids.entities, "g02-orla", "g02-tamsin") },
    { ...g02.ids, scenes: swap(g02.ids.scenes, "g02-probe", "g02-attach") },
    {
      ...g02.ids,
      relations: swap(
        g02.ids.relations,
        "g02-trained-tamsin",
        "g02-trained-orla",
      ),
    },
    { ...g02.ids, entities: { ...g02.ids.entities, "g02-dace": "rt-missing" } },
  ])
    assert.throws(
      () => assertLogicalRuntimeMap({ ...g02, ids }),
      /\[precheck\] S1i logical-runtime/u,
    );
  // writer が別の値を書いた（label、summary、payoff の Scene、holder）。
  for (const [key, mutate] of [
    [
      "G-02/base",
      (name, input) =>
        name === "api.createCodexRelation" ? { ...input, label: "x" } : input,
    ],
    [
      "G-02/base",
      (name, input) =>
        name === "api.createCodexEntry" && input.name === "Rook"
          ? { ...input, summary: "Rook is someone else." }
          : input,
    ],
    [
      "G-07/base",
      (name, input) =>
        name === "api.createForeshadow"
          ? { ...input, payoffSceneId: null }
          : input,
    ],
    [
      "G-02/base",
      (() => {
        let first = true;
        return (name, input) => {
          if (name !== "api.upsertScenePin" || !first) return input;
          first = false;
          return { ...input, sceneId: `${input.sceneId}x` };
        };
      })(),
    ],
    [
      "G-02/base",
      // IR の Scene を folder に入れず root に置いた。
      (name, input) =>
        name === "tree_node_create" &&
        input.payload.title === "Slate question" &&
        input.payload.nodeType === "scene"
          ? { payload: { ...input.payload, parentId: null } }
          : input,
    ],
    [
      "G-06/base",
      // IR の Scene を folder の外（root）の folder と同じ位置に置いた（読む順は同じ）。
      (() => {
        let folderSort = null;
        return (name, input) => {
          if (name !== "tree_node_create") return input;
          if (input.payload.nodeType === "folder") {
            folderSort = input.payload.sortOrder;
            return input;
          }
          if (input.payload.parentId === null || folderSort === null)
            return input;
          const moved = {
            payload: {
              ...input.payload,
              parentId: null,
              sortOrder: folderSort,
            },
          };
          folderSort = null;
          return moved;
        };
      })(),
    ],
    [
      "G-04/base",
      // 2 つ目の IR の Scene を 1 つ目の folder の a0 に入れた（読む順は同じ。親だけが違う）。
      (() => {
        const folders = [];
        return (name, input) => {
          if (name !== "tree_node_create") return input;
          if (input.payload.nodeType === "folder") {
            folders.push(input.payload.id);
            return input;
          }
          return folders.length === 2 && input.payload.parentId === folders[1]
            ? { payload: { ...input.payload, parentId: folders[0] } }
            : input;
        };
      })(),
    ],
    [
      "G-02/base",
      // root の最初の 2 つの Scene の位置を入れ替えた（親と a0 は正しい。読む順だけが違う）。
      (() => {
        const roots = [];
        return (name, input) => {
          if (
            name !== "tree_node_create" ||
            input.payload.nodeType !== "scene" ||
            input.payload.parentId !== null
          )
            return input;
          roots.push(input.payload.sortOrder);
          if (roots.length === 1)
            return { payload: { ...input.payload, sortOrder: "zz" } };
          return input;
        };
      })(),
    ],
    [
      "G-04/base",
      // folder の title を変えた。
      (name, input) =>
        name === "tree_node_create" && input.payload.nodeType === "folder"
          ? { payload: { ...input.payload, title: "Folder" } }
          : input,
    ],
    [
      "G-05/base",
      // story time を設定した（K2/4 :411 は NULL のまま）。
      (name, input) =>
        name === "tree_node_create" && input.payload.nodeType === "scene"
          ? { payload: { ...input.payload, storyTimeOrder: "a5" } }
          : input,
    ],
  ]) {
    const mixed = await run(key, mutate);
    assert.throws(
      () => assertLogicalRuntimeMap(mixed),
      /\[precheck\] S1i logical-runtime/u,
      key,
    );
  }
  // G-04: unknown の marker の Scene は書かず、character holder は runtime の ID。
  const g04 = await run("G-04/base");
  assert.equal(assertLogicalRuntimeMap(g04).ok, true);
  const holder = g04.rows.bindings.find(
    (row) => row.sceneId === g04.ids.scenes["g04-rv-holder"],
  );
  assert.deepEqual(holder.knowledgeHolder, {
    kind: "character",
    ref: g04.ids.entities["g04-mott"],
  });
  const unknown = g04.rows.bindings.find(
    (row) => row.sceneId === g04.ids.scenes["g04-rv-unknown"],
  );
  assert.equal(unknown.marker, "unknown");
  // G-07: 伏線と Codex の link。
  const g07 = await run("G-07/base");
  assert.equal(assertLogicalRuntimeMap(g07).ok, true);
  assert.equal(g07.rows.foreshadows.length, 3);
  assert.equal(g07.rows.foreshadowLinks.length, 3);
});

test("① の guard: S2 の範囲の外の IPC と page の入口（maintenance、typed Revision、Index の build、query、宣言、probe）を呼べない", async () => {
  const partial = planOf(PARTIAL, "G-05/base");
  const complete = planOf(COMPLETE, "G-05/base");
  for (const cmd of R5_CHECK_ALLOWED_IPC)
    assert.doesNotThrow(() =>
      guardIpc(partial, cmd, { sql: "SELECT 1", method: "all" }),
    );
  for (const cmd of [
    "narrative_runtime_policy_set",
    "nir1_entity_relation_revision_prepare",
    "narrative_extraction_append_human_decision",
    "narrative_extraction_capture_workspace_binding",
    "nir1_related_scenes_begin",
    "semantic_reindex_all",
  ])
    assert.throws(
      () => guardIpc(partial, cmd, {}),
      /\[precheck\] S1i r5-check/u,
    );
  assert.throws(
    () =>
      guardIpc(partial, "db_execute", {
        sql: "UPDATE narrative_runtime_policy SET maintenance_enabled = 1",
        method: "run",
      }),
    /\[precheck\] S1i r5-check/u,
  );
  for (const entry of [
    "measure",
    "buildIndex",
    "buildRaw",
    "declaration.declare",
    "k64.sample",
    "hook.sample",
    "api.updateCodexEntrySummary",
  ])
    assert.throws(
      () => guardPage(partial, entry),
      /\[precheck\] S1i r5-check/u,
    );
  // 停止位置を書き換えた ① の plan でも、禁止の集合の段（maintenance）は始めない。
  // seal の session も開かない。
  const executors = new Proxy({}, { get: () => async () => ({}) });
  const run = (plan, session) =>
    runFrozenSetupSteps({
      plan,
      page: frozenSetupFakeProduct().page,
      workspacePath: "/nonexistent",
      ids: createSetupIds({ plan: partial, uuid }),
      session,
      phase: () => {},
      uuid,
      executors,
      readState: async () => null,
    });
  await assert.rejects(
    run({ ...partial, stopIndex: partial.stopIndex + 1 }, "author"),
    /\[precheck\] S1i r5-check: G-05\/base: maintenance-enabled \(maintenance-enable\)/u,
  );
  await assert.rejects(
    run(partial, "seal"),
    /\[precheck\] S1i r5-check: G-05\/base: the seal session/u,
  );
  // 完全な setup の plan は ① の guard を受けない（SQL の書込みはどちらでも拒む）。
  assert.doesNotThrow(() =>
    guardIpc(complete, "narrative_runtime_policy_set", {}),
  );
  assert.throws(
    () =>
      guardIpc(complete, "db_execute", {
        sql: "DELETE FROM scene_codex_pins",
        method: "run",
      }),
    /\[precheck\]/u,
  );
});

test("完全な setup の段は、executor の無い段や [precheck] の executor の段に着いたところで止まり、それより前の段だけを記録する", async () => {
  const base = planOf(COMPLETE, "G-04/base");
  const at = base.steps.findIndex(
    (step) => step.phase === "setup-timeline:g04-ir",
  );
  // S1j-2: the four S1i prechecks have executors; a step still marked
  // `[precheck]` (or with an unknown executor) stops the run there.
  const withStep = (step) => ({
    ...base,
    steps: base.steps.map((row, index) => (index === at ? step : row)),
  });
  const precheckPlan = withStep({
    ...base.steps[at],
    session: "author",
    executor: "precheck",
    precheck: {
      code: "test-precheck",
      reason: "the step is not mapped",
      options: ["(A) one", "(B) two"],
    },
  });
  const unknownPlan = withStep({
    ...base.steps[at],
    session: "author",
    executor: "no-such-executor",
  });
  const names = [
    "project",
    "scenes",
    "entities",
    "relations",
    "scope-registry",
    "scene-scope",
    "foreshadows",
    "foreshadow-links",
    "pins",
    "seed-pin",
    "maintenance-enabled",
    "typed-revision",
  ];
  for (const [plan, pattern] of [
    [precheckPlan, /\[precheck\] S1i test-precheck: .*\(A\) one.*\(B\) two/u],
    [unknownPlan, /\[precheck\] S1i phase: .*no executor/u],
  ]) {
    const phases = [];
    const done = [];
    const executors = Object.fromEntries(
      names.map((name) => [
        name,
        async ({ step }) => {
          done.push(step.phase);
          return {};
        },
      ]),
    );
    await assert.rejects(
      runFrozenSetupSteps({
        plan,
        page: frozenSetupFakeProduct().page,
        workspacePath: "/nonexistent",
        ids: createSetupIds({ plan, uuid }),
        session: "author",
        phase: (name) => phases.push(name),
        uuid,
        executors,
        readState: async () => null,
      }),
      pattern,
    );
    assert.deepEqual(phases, done);
    assert.equal(phases.at(-1), "setup-timeline:g04-r-sel");
  }
});

test("setup の受領書の loader: frozen は frozen の schema と停止位置・状態の組だけ、dev の schema の frozen は拒む", () => {
  const dir = scratch("cp4-s1i-receipt-");
  const file = path.join(dir, "setup-receipt.json");
  const base = {
    schemaVersion: FROZEN_SETUP_RECEIPT_SCHEMA,
    status: "setup-through-seed-pin",
    stopsAt: "seed-pin",
    r5CheckRun: { id: "r5-test-run" },
    fixture: { kind: "frozen", caseId: "G-02", variantId: "base" },
    logicalToRuntime: {
      projectId: "p",
      querySceneId: "g02-query",
      scenes: { "g02-query": "q" },
      entities: { "g02-orla": "o" },
    },
    coldDatabase: { path: file, sha256: "0".repeat(64) },
  };
  const load = (value) => {
    writeFileSync(file, `${JSON.stringify(value)}\n`);
    return loadSetupReceipt({ file });
  };
  assert.equal(load(base).stopsAt, "seed-pin");
  assert.equal(load(base).r5CheckRunId, "r5-test-run");
  const complete = load({
    ...base,
    stopsAt: "complete",
    status: "setup-complete",
    r5CheckRun: undefined,
    ...COMPLETE_SETUP_FIELDS,
  });
  assert.equal(complete.r5CheckRunId, null);
  assert.equal(assertCompleteSetupReceipt(complete), complete);
  // S1j-2 review P3 (e): a complete setup without its measurement point,
  // with a seal that ended other than sealed, more than three openings, or
  // no setup-only Main is not taken by ④⑤.
  for (const change of [
    { measurementPoint: undefined },
    {
      measurementPoint: {
        ...COMPLETE_SETUP_FIELDS.measurementPoint,
        probe: {
          ...COMPLETE_SETUP_FIELDS.measurementPoint.probe,
          graph: "unusable",
        },
      },
    },
    {
      sealAttempts: [{ session: "seal", attempt: 0, outcome: "not-published" }],
    },
    {
      sealAttempts: [0, 1, 2, 3].map((attempt) => ({
        session: "seal",
        attempt,
        outcome: attempt === 3 ? "sealed" : "sealed-then-dirty",
      })),
    },
    { sealAttempts: [] },
    { setupMain: undefined },
    // P-5: the author session's maintenance openings.
    { maintenanceAttempts: undefined },
    { maintenanceAttempts: [{ attempt: 0, outcome: "not-reached" }] },
    {
      maintenanceAttempts: [0, 1, 2, 3].map((attempt) => ({
        attempt,
        outcome: attempt === 3 ? "reached" : "not-reached",
      })),
    },
  ])
    assert.throws(
      () =>
        assertCompleteSetupReceipt(
          load({
            ...base,
            stopsAt: "complete",
            status: "setup-complete",
            r5CheckRun: undefined,
            ...COMPLETE_SETUP_FIELDS,
            ...change,
          }),
        ),
      /\[precheck\] the setup receipt .* is not a complete setup with its measurement point/u,
    );
  assert.equal(SEAL_OPENINGS_MAX, B_SEAL_REOPENS + 1);
  for (const value of [
    { ...base, status: "setup-complete" },
    { ...base, stopsAt: "complete" },
    { ...base, stopsAt: undefined },
    { ...base, status: "setup-with-problems" },
    {
      ...base,
      schemaVersion: "nir1-cp4-dev-setup/1",
      status: "setup-complete",
    },
    { ...base, fixture: { ...base.fixture, kind: "dev" } },
    { ...base, fixture: { ...base.fixture, variantId: null } },
    { ...base, fixture: { kind: "frozen", variantId: "base" } },
    // S1j P2-4: ① の受領書は run の ID を要り、完全な setup は持たない。
    { ...base, r5CheckRun: undefined },
    { ...base, r5CheckRun: { id: "" } },
    { ...base, stopsAt: "complete", status: "setup-complete" },
  ])
    assert.throws(() => load(value), /\[precheck\] the setup receipt/u);
  assert.throws(
    () => assertCompleteSetupReceipt(JSON.parse(readFileSync(file, "utf8"))),
    /\[precheck\]/u,
  );
});

test("manifest の isolation: 既にある setup の directory（前の run の workspace）では setup を始めない", async () => {
  const plan = planOf(PARTIAL, "G-06/base");
  const setupDir = scratch("cp4-s1i-reuse-");
  const product = frozenSetupFakeProduct();
  await assert.rejects(
    setupFrozenVariant({
      plan,
      setupDir,
      shared: SHARED,
      deps: { startSession: fakeSessions(product).startSession, uuid },
    }),
    /\[precheck\] S1i isolation: G-06\/base/u,
  );
  assert.deepEqual(product.calls, []);
});

test("① は maintenance が有効な workspace を受けない（記録した段は plan の段と照合した結果を受領書に残す）", async () => {
  const plan = planOf(PARTIAL, "G-03/base");
  const root = scratch("cp4-s1i-maint-");
  const product = frozenSetupFakeProduct({ maintenanceEnabled: true });
  const { receipt } = await setupFrozenVariant({
    plan,
    setupDir: path.join(root, "on"),
    shared: SHARED,
    deps: { startSession: fakeSessions(product).startSession, uuid },
  });
  assert.equal(receipt.status, "blocked");
  assert.match(receipt.precheck.message, /maintenance is on/u);
  assert.equal(receipt.readBack.maintenanceEnabled, true);
  // 既定（行なし）は maintenance が無効で、記録した段の照合の結果が残る。
  const off = frozenSetupFakeProduct();
  const ok = await setupFrozenVariant({
    plan,
    setupDir: path.join(root, "off"),
    shared: SHARED,
    deps: { startSession: fakeSessions(off).startSession, uuid },
  });
  assert.equal(ok.receipt.status, "setup-through-seed-pin");
  assert.deepEqual(ok.receipt.r5CheckPhases, {
    ok: true,
    phases: executedPhaseNames(plan),
  });
});

test("S1j P2-4: ① の setup は run の ID を要り、受領書に書く。完全な setup は run の ID を持たない", async () => {
  const root = scratch("cp4-s1j-runid-");
  const partial = planOf(PARTIAL, "G-06/base");
  const product = frozenSetupFakeProduct();
  const { receipt } = await setupFrozenVariant({
    plan: partial,
    setupDir: path.join(root, "a"),
    shared: SHARED,
    deps: { startSession: fakeSessions(product).startSession, uuid },
  });
  assert.deepEqual(receipt.r5CheckRun, { id: "r5-test-run" });
  await assert.rejects(
    setupFrozenVariant({
      plan: partial,
      setupDir: path.join(root, "b"),
      shared: { ...SHARED, r5CheckRunId: undefined },
      deps: {
        startSession: fakeSessions(frozenSetupFakeProduct()).startSession,
        uuid,
      },
    }),
    /\[precheck\] S1i r5-check: G-06\/base: .*run ID/u,
  );
  await assert.rejects(
    setupFrozenVariant({
      plan: planOf(COMPLETE, "G-06/base"),
      setupDir: path.join(root, "c"),
      shared: SHARED,
      deps: {
        startSession: fakeSessions(frozenSetupFakeProduct()).startSession,
        uuid,
      },
    }),
    /\[precheck\] S1i .*run ID/u,
  );
});

test("S1j P3: 起動の側の準備は build と受領書（候補の commit と tree、4 つの artifact）を照合し、途中で失敗しても static server を閉じる", async () => {
  const root = scratch("cp4-s1j-build-");
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
  assert.deepEqual(
    assertBuildMatchesProductReceipt({
      root,
      candidate,
      productReceipt: receipt,
    }).artifacts,
    receipt.artifacts,
  );
  for (const [label, change] of [
    ["commit", { candidate: { ...candidate, commit: "c".repeat(40) } }],
    ["tree", { candidate: { ...candidate, tree: "c".repeat(40) } }],
    ["dist-electron/main.cjs", { file: "dist-electron/main.cjs" }],
    ["dist-electron/preload.cjs", { file: "dist-electron/preload.cjs" }],
    ["dist/index.html", { file: "dist/index.html" }],
  ]) {
    if (change.file) writeFileSync(path.join(root, change.file), "changed");
    assert.throws(
      () =>
        assertBuildMatchesProductReceipt({
          root,
          candidate: change.candidate ?? candidate,
          productReceipt: receipt,
        }),
      new RegExp(`\\[precheck\\] S1i build: .*${label}`, "u"),
    );
    if (change.file)
      writeFileSync(path.join(root, change.file), files[change.file]);
  }
  // observer の bundle で失敗しても、起動した static server は閉じる。
  let closed = 0;
  await assert.rejects(
    prepareFrozenSetupShared({
      runDir: path.join(root, "run"),
      options: {
        "product-receipt": "/nonexistent",
        "ja-model": "j",
        "en-model": "e",
        run: "r",
      },
      plans: PARTIAL,
      deps: {
        candidateOf: () => candidate,
        readProductReceipt: () => ({
          bytes: Buffer.from("{}"),
          value: receipt,
        }),
        root,
        admit: () => ({ dryRun: true }),
        buildRenderer: async () => ({ rendererBundleSha256: null }),
        startServer: async () => ({ close: async () => (closed += 1) }),
        bundle: async () => {
          throw new Error("observer bundle failed");
        },
      },
    }),
    /observer bundle failed/u,
  );
  assert.equal(closed, 1);
});
