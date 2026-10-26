// SP/1（draftRef nir1-graph-case-seed-pin-proposal/1、contractId
// graph-case-seed-pin-setup、2026-10-27 確認）の seed の pin の段。合成の記録と fake
// の書込み口だけ。凍結した G-case の材料では走らせない（plan の導出は fixture の宣言
// を読むだけで、digest を照合する）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  FROZEN_FIXTURE_SHA256,
  GRAPH_CASE_FREEZE,
  GRAPH_EVAL_VARIANTS,
} from "./constants.mjs";
import {
  SEED_PIN_ANCHORS,
  SEED_PIN_PHASE,
  SEED_PIN_WRITER,
  SP1_CONTRACT,
  assertArmsShareSeedPin,
  assertFrozenSetupBytes,
  assertSeedPinParity,
  assertSeedPinPlacement,
  assertSeedPinSetup,
  assertSeedPinStep,
  assessSeedPinStep,
  compareSeedPinParity,
  fixturePinsRuntime,
  loadFrozenSeedPinPlan,
  runSeedPinStep,
  seedCarriedFindings,
  seedPinPlanFromFixture,
} from "./seed-pin-setup.mjs";
import { seedPinPageDeps } from "./setup-driver.mjs";
import { assertSeedPinsBeforeK64 } from "./seed-pin.mjs";
import { REPO_ROOT, seedPinWorkspace } from "./test-support.mjs";

const G02 = {
  caseId: "G-02",
  query: { sceneId: "g02-query" },
  manualSeed: { entityId: "g02-orla", manualSeed: true },
  pins: [
    { sceneId: "g02-attach", entryId: "g02-sela", source: "scene_codex_pins" },
    { sceneId: "g02-probe", entryId: "g02-rook", source: "scene_codex_pins" },
  ],
  variants: [{ id: "base" }],
};

test("SP/1 plan: 予定の seed と問いの Scene は fixture の値をそのまま写す（G-01 は entitySeed、v1）", () => {
  assert.deepEqual(seedPinPlanFromFixture({ caseId: "G-02", fixture: G02 }), [
    {
      caseId: "G-02",
      variantId: "base",
      variantKey: "G-02/base",
      querySceneId: "g02-query",
      seedEntityId: "g02-orla",
      anchor: SEED_PIN_ANCHORS.graphCase,
    },
  ]);
  const g01 = {
    query: { sceneId: "g01-query" },
    entitySeed: { id: "g01-orin", manualSeed: true },
    pins: [{ sceneId: "g01-mira", entryId: "g01-mira-entity" }],
  };
  assert.deepEqual(seedPinPlanFromFixture({ caseId: "G-01", fixture: g01 }), [
    {
      caseId: "G-01",
      variantId: "v1",
      variantKey: "G-01/v1",
      querySceneId: "g01-query",
      seedEntityId: "g01-orin",
      anchor: SEED_PIN_ANCHORS.g01,
    },
  ]);
  // seed が宣言されていなければ harness は選ばない。
  for (const fixture of [
    { ...G02, manualSeed: undefined },
    { ...G02, manualSeed: { entityId: "g02-orla", manualSeed: false } },
    { ...G02, manualSeed: { entityId: " ", manualSeed: true } },
    { ...G02, query: undefined },
    { ...G02, variants: [] },
  ])
    assert.throws(
      () => seedPinPlanFromFixture({ caseId: "G-02", fixture }),
      /\[precheck\] SP\/1/u,
    );
  assert.throws(
    () =>
      seedPinPlanFromFixture({
        caseId: "G-01",
        fixture: { ...g01, entitySeed: undefined },
      }),
    /\[precheck\] SP\/1/u,
  );
});

test("SP/1 plan: 凍結した 13 の variant の plan は SP/1 の事実 (e) の表と一致する（digest を照合して宣言だけを読む）", () => {
  const plan = loadFrozenSeedPinPlan({ root: REPO_ROOT });
  assert.deepEqual(
    plan.map((row) => row.variantKey),
    GRAPH_EVAL_VARIANTS.map((row) => row.key),
  );
  const seeds = Object.fromEntries(
    plan.map((row) => [row.caseId, [row.querySceneId, row.seedEntityId]]),
  );
  assert.deepEqual(seeds, {
    "G-01": ["g01-query", "g01-orin"],
    "G-02": ["g02-query", "g02-orla"],
    "G-03": ["g03-query", "g03-wren"],
    "G-04": ["g04-query", "g04-bren"],
    "G-05": ["g05-query", "g05-hale"],
    "G-06": ["g06-query", "g06-maro"],
    "G-07": ["g07-query", "g07-vesna"],
    "G-08": ["g08-query", "g08-odile"],
  });
  assert.ok(Object.isFrozen(plan) && plan.every(Object.isFrozen));
});

test("SP-N8: 凍結の bytes（freeze と 8 つの fixture）が freeze の値と同じことを確かめ、違えば [precheck]", async () => {
  assert.equal(assertFrozenSetupBytes({ root: REPO_ROOT }).ok, true);
  const root = await mkdtemp(path.join(tmpdir(), "cp4-sp1-bytes-"));
  try {
    for (const file of [
      GRAPH_CASE_FREEZE.path,
      ...Object.keys(FROZEN_FIXTURE_SHA256),
      "evals/nir1-graph/manifest.v1.json",
      "evals/nir1-graph/schema.v1.json",
      "evals/nir1-graph/README.md",
      "evals/nir1-graph/independent-expectation-review.v1.json",
    ]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(
        path.join(root, file),
        await readFile(path.join(REPO_ROOT, file)),
      );
    }
    assert.equal(assertFrozenSetupBytes({ root }).ok, true);
    const g03 = "evals/nir1-graph/g03-bounded-two-hop.v1.json";
    await writeFile(
      path.join(root, g03),
      `${await readFile(path.join(root, g03), "utf8")} `,
    );
    assert.throws(() => assertFrozenSetupBytes({ root }), /SP-N8.*g03/u);
    assert.throws(() => loadFrozenSeedPinPlan({ root }), /SP-N8.*g03/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The workspace state the step reads before and after its one write. */
function state(overrides = {}) {
  return {
    queryScene: {
      live: true,
      version: 3,
      updatedAt: "2026-10-27T00:00:00Z",
      ...overrides.queryScene,
    },
    queryScenePins: overrides.queryScenePins ?? [],
    workspacePins: overrides.workspacePins ?? [
      { sceneId: "g02-attach", entryId: "rt-sela" },
      { sceneId: "g02-probe", entryId: "rt-rook" },
    ],
    sceneScopeBinding: overrides.sceneScopeBinding ?? {
      version: 2,
      compatibility_marker: "explicit",
      source_token: `sha256:${"a".repeat(64)}`,
    },
  };
}

const IDS = {
  scenes: { "g02-query": "g02-query" },
  entities: {
    "g02-orla": "rt-orla",
    "g02-sela": "rt-sela",
    "g02-rook": "rt-rook",
  },
};
const PLAN = seedPinPlanFromFixture({ caseId: "G-02", fixture: G02 })[0];
const SEED_PIN = {
  entryId: "rt-orla",
  createdAt: "2026-10-27T00:00:05Z",
  entryInProject: true,
};

function goodAfter() {
  return state({
    queryScenePins: [SEED_PIN],
    workspacePins: [
      ...state().workspacePins,
      { sceneId: "g02-query", entryId: "rt-orla" },
    ],
  });
}

async function runWith(after = goodAfter(), before = state()) {
  const calls = [];
  const states = [before, after];
  const phases = [];
  const record = await runSeedPinStep({
    plan: PLAN,
    ids: IDS,
    deps: {
      readState: async () => states.shift(),
      upsertScenePin: async (input) => {
        calls.push(input);
      },
    },
    phase: (name, details) => phases.push([name, details]),
  });
  return { record, calls, phases };
}

test("SP/1 の段: upsertScenePin を 1 回だけ、問いの Scene から予定の seed の runtime ID へ呼び、前後の状態を記録する", async () => {
  const { record, calls, phases } = await runWith();
  assert.deepEqual(calls, [{ sceneId: "g02-query", entryId: "rt-orla" }]);
  assert.equal(record.writer, SEED_PIN_WRITER);
  assert.deepEqual(record.contract, SP1_CONTRACT);
  assert.deepEqual(record.querySceneId, {
    logical: "g02-query",
    runtime: "g02-query",
  });
  assert.deepEqual(record.seed, { logical: "g02-orla", runtime: "rt-orla" });
  assert.equal(record.createdAt, "2026-10-27T00:00:05Z");
  assert.equal(record.countedAsSetupTimelineStep, false);
  assert.equal(record.countedAsMeasurementPoint, false);
  assert.deepEqual(
    phases.map(([name]) => name),
    [SEED_PIN_PHASE],
  );
  const fixturePins = fixturePinsRuntime(G02, IDS);
  assert.deepEqual(assessSeedPinStep(record, { fixturePins }).findings, []);
  assert.equal(assertSeedPinStep(record, { fixturePins }).ok, true);
  // runtime の対応が無い seed は書かない（harness が選ばない）。
  await assert.rejects(
    runSeedPinStep({
      plan: PLAN,
      ids: { ...IDS, entities: {} },
      deps: { readState: async () => state(), upsertScenePin: async () => {} },
    }),
    /\[precheck\] SP\/1/u,
  );
});

test("SP-N1〜N5、N8、N9 と SP-P2: 合成の記録で段の違反を分ける", async () => {
  const fixturePins = fixturePinsRuntime(G02, IDS);
  const findingsOf = async (after, before) =>
    assessSeedPinStep((await runWith(after, before)).record, { fixturePins })
      .findings.map((row) => row.split(":")[0])
      .sort();
  const other = {
    entryId: "rt-other",
    createdAt: "2026-10-27T00:00:01Z",
    entryInProject: true,
  };
  const withPins = (queryScenePins, extra = []) =>
    state({
      queryScenePins,
      workspacePins: [
        ...state().workspacePins,
        ...queryScenePins.map((pin) => ({
          sceneId: "g02-query",
          entryId: pin.entryId,
        })),
        ...extra,
      ],
    });
  assert.deepEqual(await findingsOf(withPins([other])), ["SP-N1"]);
  assert.deepEqual(
    await findingsOf(
      withPins([SEED_PIN, { ...other, createdAt: "2026-10-27T00:00:09Z" }]),
    ),
    ["SP-N2"],
  );
  assert.deepEqual(await findingsOf(withPins([other, SEED_PIN])), [
    "SP-N2",
    "SP-N3",
  ]);
  // SP-N5: 問いの Scene 以外に pin を足した、fixture の pin を消した。
  assert.deepEqual(
    await findingsOf(
      withPins([SEED_PIN], [{ sceneId: "g02-attach", entryId: "rt-orla" }]),
    ),
    ["SP-N5"],
  );
  const removed = goodAfter();
  removed.workspacePins = removed.workspacePins.slice(1);
  assert.deepEqual(await findingsOf(removed), ["SP-N5"]);
  // 段の前にすでに問いの Scene に pin があった（足した pin が唯一でない）。
  assert.deepEqual(
    await findingsOf(withPins([other, SEED_PIN]), withPins([other])),
    ["SP-N2", "SP-N3", "SP-N5"],
  );
  // SP-N9: archive された問いの Scene、別の project の entry。
  assert.deepEqual(
    await findingsOf(state({ ...goodAfter(), queryScene: { live: false } })),
    ["SP-N9"],
  );
  const foreign = goodAfter();
  foreign.queryScenePins = [{ ...SEED_PIN, entryInProject: false }];
  assert.deepEqual(await findingsOf(foreign), ["SP-N9"]);
  // SP-P2: 問いの Scene の version／updated_at、Scene Scope の binding が変わった。
  assert.deepEqual(
    await findingsOf(state({ ...goodAfter(), queryScene: { version: 4 } })),
    ["SP-P2"],
  );
  assert.deepEqual(
    await findingsOf(
      state({ ...goodAfter(), sceneScopeBinding: { version: 3 } }),
    ),
    ["SP-P2"],
  );
  // SP-N4: 書込みの経路が upsertScenePin でない、記録が無い。SP-N8: 段を timeline に数えた。
  const { record } = await runWith();
  for (const [change, code] of [
    [{ writer: "sql" }, "SP-N4"],
    [{ writer: undefined }, "SP-N4"],
    [{ createdAt: null }, "SP-N4"],
    [{ countedAsSetupTimelineStep: true }, "SP-N8"],
    [{ countedAsMeasurementPoint: true }, "SP-N8"],
  ])
    assert.deepEqual(
      assessSeedPinStep({ ...record, ...change }, { fixturePins }).findings.map(
        (row) => row.split(":")[0],
      ),
      [code],
      JSON.stringify(change),
    );
  assert.throws(
    () => assertSeedPinStep({ ...record, writer: "sql" }, { fixturePins }),
    /\[precheck\] SP\/1.*SP-N4/u,
  );
});

test("SP-N6／SP-N14: 段の置き場（G-02〜G-08 は pin の段の直後で maintenance と setupTimeline の前、G-01 は唯一の pin の後で typed Revision と B の seal の前）", () => {
  const graphCase = [
    "project",
    "scenes",
    "entities",
    "relations",
    "scope-registry",
    "scene-scope",
    "foreshadows",
    "foreshadow-links",
    "pins",
    SEED_PIN_PHASE,
    "maintenance-enabled",
    "setup-timeline:g02-r-tamsin",
    "b-seal",
  ];
  const ok = (phases, anchor) => assertSeedPinPlacement({ phases, anchor }).ok;
  assert.equal(ok(graphCase, SEED_PIN_ANCHORS.graphCase), true);
  const move = (list, from, to) => {
    const copy = list.filter((name) => name !== from);
    copy.splice(to, 0, from);
    return copy;
  };
  for (const phases of [
    move(graphCase, SEED_PIN_PHASE, 11), // maintenance の後
    move(graphCase, SEED_PIN_PHASE, 8), // pin の段の前
    [...graphCase, SEED_PIN_PHASE], // 2 回
    graphCase.filter((name) => name !== SEED_PIN_PHASE), // 無い
    [...graphCase.slice(0, 9), "graph-arm:first-query", ...graphCase.slice(9)], // 観測の後
  ])
    assert.throws(
      () =>
        assertSeedPinPlacement({ phases, anchor: SEED_PIN_ANCHORS.graphCase }),
      /\[precheck\] SP\/1 SP-N6/u,
      phases.join(">"),
    );
  const g01 = [
    "project",
    "scenes",
    "pins",
    SEED_PIN_PHASE,
    "typed-revisions",
    "b-seal",
  ];
  assert.equal(ok(g01, SEED_PIN_ANCHORS.g01), true);
  assert.throws(
    () =>
      assertSeedPinPlacement({
        phases: move(g01, SEED_PIN_PHASE, 5),
        anchor: SEED_PIN_ANCHORS.g01,
      }),
    /SP-N6/u,
  );
  assert.throws(
    () =>
      assertSeedPinPlacement({
        phases: g01.filter((name) => name !== SEED_PIN_PHASE),
        anchor: SEED_PIN_ANCHORS.g01,
      }),
    /SP-N14/u,
  );
});

const PARITY = {
  rSceneIds: ["a", "b"],
  denseHitSceneIds: ["a", "b", "c"],
  sparseSceneIds: ["b"],
  rIrSceneIds: ["a", "b", "d"],
  irSupplementSceneId: "d",
};

test("SP-N7／SP-P4: pin のある写しと無い写しの R と R+IR の membership・順位の比較（判定に使わない診断の道具）", () => {
  const same = compareSeedPinParity({
    caseId: "G-02",
    variantId: "base",
    before: PARITY,
    after: { ...PARITY },
  });
  assert.equal(same.same, true);
  assert.deepEqual(same.differences, []);
  assert.equal(assertSeedPinParity(same).same, true);
  for (const [field, value] of [
    ["rSceneIds", ["b", "a"]],
    ["denseHitSceneIds", ["a", "b"]],
    ["sparseSceneIds", ["b", "c"]],
    ["rIrSceneIds", ["a", "b"]],
    ["irSupplementSceneId", null],
  ]) {
    const result = compareSeedPinParity({
      caseId: "G-02",
      variantId: "base",
      before: PARITY,
      after: { ...PARITY, [field]: value },
    });
    assert.deepEqual(
      result.differences.map((row) => row.field),
      [field],
    );
    assert.throws(
      () => assertSeedPinParity(result),
      /\[precheck\] SP\/1 SP-N7.*D1/u,
    );
  }
  const missing = compareSeedPinParity({
    caseId: "G-02",
    variantId: "base",
    before: PARITY,
    after: { rSceneIds: ["a", "b"] },
  });
  assert.deepEqual(missing.missing, [
    "after.denseHitSceneIds",
    "after.sparseSceneIds",
    "after.rIrSceneIds",
    "after.irSupplementSceneId",
  ]);
  assert.throws(() => assertSeedPinParity(missing), /SP-P4.*unconfirmed/u);
});

test("SP-N10: case の arm の間で pin の集合が同じ（Graph の arm の workspace にだけ pin があれば [precheck]）", () => {
  const pins = [
    { sceneId: "g02-attach", entryId: "rt-sela" },
    { sceneId: "g02-query", entryId: "rt-orla" },
  ];
  assert.equal(
    assertArmsShareSeedPin({
      hybrid: pins,
      graph: [...pins].reverse(),
    }).ok,
    true,
  );
  assert.throws(
    () =>
      assertArmsShareSeedPin({
        hybrid: pins.slice(0, 1),
        graph: pins,
      }),
    /\[precheck\] SP\/1 SP-N10/u,
  );
});

test("SP-P5: Graph の arm の親の begin に予定の seed が載り、requalification の落ち（SeedChanged は invalidated に出る）が無い", () => {
  const row = (parentSeed, parentGraph, child) => ({
    arm: "graph",
    graph: parentGraph,
    followUp: { parent: { seed: parentSeed }, child },
  });
  const graphLate = { outcome: "graph-late", reason: null };
  const ok = row("rt-orla", graphLate, {
    outcome: "graph-ready",
    reason: null,
  });
  assert.deepEqual(seedCarriedFindings([ok, { arm: "hybrid" }], "rt-orla"), []);
  assert.deepEqual(
    seedCarriedFindings([row("rt-other", graphLate, null)], "rt-orla"),
    ["SP-P5:parent-seed-differs"],
  );
  assert.deepEqual(
    seedCarriedFindings(
      [
        row(
          "rt-orla",
          { outcome: "graph-unavailable", reason: "invalidated" },
          null,
        ),
        row("rt-orla", graphLate, {
          outcome: "graph-unavailable",
          reason: "invalidated",
        }),
      ],
      "rt-orla",
    ),
    ["SP-P5:possible-seed-changed", "SP-P5:possible-seed-changed"],
  );
});

/** A fake harness page over a throwaway SQLite: SELECT read-backs only, and the product writer. */
function fakePage() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, project_id TEXT, node_type TEXT, archived_at TEXT, version INTEGER, updated_at TEXT);
    CREATE TABLE codex_entries (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE scene_codex_pins (scene_id TEXT, entry_id TEXT, created_at TEXT);
    CREATE TABLE narrative_scene_scope_bindings (project_id TEXT, scene_id TEXT, scene_incarnation_id TEXT,
      compatibility_marker TEXT, query_identity_json TEXT, material_constraint_json TEXT,
      knowledge_holder_json TEXT, audience_json TEXT, version INTEGER, source_token TEXT, updated_at TEXT,
      body_declaration_json TEXT, body_declaration_token TEXT);
    INSERT INTO tree_nodes VALUES ('g02-query', 'p', 'scene', NULL, 3, '2026-10-27T00:00:00Z'),
      ('g02-attach', 'p', 'scene', NULL, 1, '2026-10-27T00:00:00Z'),
      ('g02-probe', 'p', 'scene', NULL, 1, '2026-10-27T00:00:00Z');
    INSERT INTO codex_entries VALUES ('rt-orla', 'p'), ('rt-sela', 'p'), ('rt-rook', 'p');
    INSERT INTO scene_codex_pins VALUES ('g02-attach', 'rt-sela', '2026-10-27T00:00:01Z'),
      ('g02-probe', 'rt-rook', '2026-10-27T00:00:02Z');
    INSERT INTO narrative_scene_scope_bindings VALUES ('p', 'g02-query', 'inc-1', 'explicit', '{}', '{}', '{}', '{}', 2,
      'sha256:${"a".repeat(64)}', '2026-10-27T00:00:00Z', NULL, NULL);
  `);
  const calls = [];
  const window = {
    cp4Harness: {
      call: async (name, input) => {
        calls.push(name);
        if (
          name !== "db_execute" ||
          input.method !== "all" ||
          !/^\s*SELECT\b/iu.test(input.sql)
        )
          return { ok: false, error: "only SELECT read-backs" };
        return {
          ok: true,
          value: { rows: db.prepare(input.sql).all(...input.params) },
        };
      },
      api: {
        upsertScenePin: async ({ sceneId, entryId }) => {
          calls.push("upsertScenePin");
          db.prepare("INSERT INTO scene_codex_pins VALUES (?, ?, ?)").run(
            sceneId,
            entryId,
            "2026-10-27T00:00:05Z",
          );
          return { ok: true, value: true };
        },
      },
    },
  };
  return {
    calls,
    page: {
      evaluate: async (fn, arg) => {
        globalThis.window = window;
        try {
          return await fn(arg);
        } finally {
          delete globalThis.window;
        }
      },
    },
  };
}

test("setup-driver の段: renderer の API の upsertScenePin を 1 回だけ呼び、前後は SELECT の読み戻しで記録する（SQL の書込みなし）", async () => {
  const { page, calls } = fakePage();
  const phases = [
    "project",
    "scenes",
    "foreshadows",
    "foreshadow-links",
    "pins",
  ];
  const record = await runSeedPinStep({
    plan: PLAN,
    ids: IDS,
    deps: seedPinPageDeps({ page, projectId: "p", querySceneId: "g02-query" }),
    phase: (name) => phases.push(name),
  });
  assert.deepEqual(
    calls.filter((name) => name !== "db_execute"),
    ["upsertScenePin"],
  );
  assert.deepEqual(record.before.queryScenePins, []);
  assert.deepEqual(record.after.queryScenePins, [SEED_PIN]);
  assert.deepEqual(record.before.queryScene, {
    live: true,
    version: 3,
    updatedAt: "2026-10-27T00:00:00Z",
  });
  assert.equal(record.after.sceneScopeBinding.version, 2);
  assert.ok(!("body_declaration_json" in record.after.sceneScopeBinding));
  phases.push("maintenance-enabled", "setup-timeline:g02-r-tamsin");
  const summary = assertSeedPinSetup({
    phases,
    record,
    fixturePins: fixturePinsRuntime(G02, IDS),
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.placementIndex, 5);
  // 置き場が違えば（dev の author のように maintenance が先）止める。
  assert.throws(
    () =>
      assertSeedPinSetup({
        phases: [
          "maintenance-enabled",
          ...phases.filter((name) => name !== "maintenance-enabled"),
        ],
        record,
        fixturePins: fixturePinsRuntime(G02, IDS),
      }),
    /SP-N6/u,
  );
});

test("SP-P3: 凍結した fixture から写した plan が、そのまま R5 の照合の seedPlan になる（variant ごとの workspace、封印した受領書と DB の読取）", () => {
  const plan = loadFrozenSeedPinPlan({ root: REPO_ROOT });
  const cases = plan.map((row) => {
    const workspace = seedPinWorkspace({
      caseId: row.caseId,
      variantId: row.variantId,
      fixtureKind: "frozen",
      querySceneLogical: row.querySceneId,
      querySceneRuntime: `${row.variantKey}/query`,
      seedLogical: row.seedEntityId,
      seedRuntime: `rt-${row.variantKey}`,
      live: true,
      pins: [
        { entryId: `rt-${row.variantKey}`, createdAt: "2026-10-27T00:00:05Z" },
      ],
    });
    return {
      caseId: row.caseId,
      variantId: row.variantId,
      setup: workspace.setup,
      read: workspace.read,
    };
  });
  assert.equal(
    assertSeedPinsBeforeK64({ cases, plan: "frozen", seedPlan: plan }).status,
    "match",
  );
  // 予定の seed を fixture と違う Entity にした行は止める。
  const swapped = cases.map((row) =>
    row.caseId === "G-07" ? { ...row, expectedSeedLogical: "g07-other" } : row,
  );
  assert.throws(
    () =>
      assertSeedPinsBeforeK64({
        cases: swapped,
        plan: "frozen",
        seedPlan: plan,
      }),
    /G-07\/base: plan-seed-mismatch/u,
  );
});
