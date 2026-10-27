// CP-4 S5-A: 正式の run の仕様、d2 の probe と blocked の判定、one-shot の
// process の並び、parity、宣言の段の照合、F6 の材料の Revision の単位
// （DR-CP4-N-1〜N-4）。凍結の fixture から plan を導き、13 variant すべてを覆う。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import { F6_FORMAL_BASIS, F6_PREVIEW_BASIS } from "./followup.mjs";
import {
  ONE_SHOT_RECEIPT_LABEL,
  blockedJudgement,
  d2ProbeCheck,
  declarationInvariantCheck,
  devRunSpec,
  formalRunPlan,
  g01ModeOf,
  measurementCopySeedCheck,
  oneShotProcessSchedule,
  parityComparison,
} from "./frozen-k64-plan.mjs";
import {
  loadDevGraphCasePlans,
  loadFrozenSetupPlans,
} from "./frozen-setup-plan.mjs";
import { k64GraphSampleRow } from "./k64-record.mjs";
import { runSchedule } from "./run-sample.mjs";
import {
  expectedMaterialPaths,
  hashGraphPaths,
  hashObservationPaths,
  materialRevisionResolver,
  productQuoteOf,
  typedRevisionMaterials,
} from "./material-revision.mjs";
import {
  K64_CHILD_RESULT,
  REPO_ROOT,
  k64HookInput,
  k64Observation,
  seedPinWorkspace,
} from "./test-support.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const PLANS = loadFrozenSetupPlans({ root: REPO_ROOT, stopsAt: "complete" });
const KEYS = GRAPH_EVAL_VARIANTS.map((row) => row.key);
const ONE_SHOT = [
  "G-08/chronicle-index-unusable",
  "G-08/both-indexes-unusable",
];
const DECLARED = {
  "G-01/v1": "g01-mira",
  "G-02/base": "g02-tamsin-first",
  "G-07/base": "g07-pell-dock",
  "G-08/base-usable": "g08-cass-attic",
  "G-08/graph-recovered": "g08-cass-attic",
};

/** The S2 values (observation-prep.v1.json at S4) the runner reads. */
function s2Prep(mutate = (value) => value) {
  const exception = {
    variants: [...ONE_SHOT],
    kind: "one-shot",
    warmupProcessesPerArm: 5,
    warmupUsed: false,
    measuredProcessesPerArm: 30,
    queriesPerProcess: 1,
    freshColdCopyPerProcess: true,
    maintenanceSeam: false,
    receiptLabel: ONE_SHOT_RECEIPT_LABEL,
    excludeFromDefaultPools: false,
    preMeasurementQueries: false,
  };
  const steady = { kind: "steady-state" };
  const value = {
    samplePlan: {
      warmupPerArm: 5,
      measuredPerArm: 30,
      order: "AB/BA",
      variants: [...KEYS],
      rFrom: "hybrid-arm-raw",
      variantExceptions: [exception],
    },
    d1: { choice: "ii", runs: Object.keys(DECLARED) },
    d2: {
      variantReadings: {
        unchanged: KEYS.filter((key) => !key.includes("unusable")),
        readAs: [
          {
            variant: "G-08/graph-index-unusable",
            b: "not-current",
            chronicle: "usable",
            maintenanceSeam: false,
            oneShot: false,
          },
          {
            variant: "G-08/chronicle-index-unusable",
            b: "current",
            chronicle: "unusable",
            maintenanceSeam: false,
            oneShot: true,
          },
          {
            variant: "G-08/both-indexes-unusable",
            b: "not-current",
            chronicle: "unusable",
            maintenanceSeam: false,
            oneShot: true,
          },
        ],
        checkedAt: ["before-measurement", "at-query"],
        onMismatch: "blocked:index-state-holding",
      },
    },
    d10: {
      g01: {
        rAndRirMode: "S4:g01-r-rir-mode",
        da1AcceptanceRecord: "S4:da1-acceptance-record",
      },
      parity: { oneShot: { variants: [...ONE_SHOT] } },
    },
    setupReadings: {
      measurementSpecs: {
        "after-maintenance-current": steady,
        "while-graph-index-unusable": { kind: "graph-held-unusable" },
        "while-chronicle-index-unusable": {
          kind: "one-shot",
          measuredProcessesPerArm: 30,
        },
        "while-both-indexes-unusable": {
          kind: "one-shot",
          measuredProcessesPerArm: 30,
        },
      },
    },
  };
  const copy = clone(value);
  return mutate(copy) ?? copy;
}

const ADDENDA = [
  { declarations: [{ caseId: "G-01", variantId: "v1", sceneId: "g01-mira" }] },
  {
    declarations: Object.entries(DECLARED)
      .filter(([key]) => !key.startsWith("G-01"))
      .map(([key, sceneId]) => {
        const [caseId, variantId] = key.split("/");
        return { caseId, variantId, sceneId };
      }),
  },
];

const specs = () =>
  formalRunPlan({ plans: PLANS, prep: s2Prep(), addenda: ADDENDA });

test("DR-CP4-N-1: 13 variant の run の仕様を plan と S2 の値から導く（kind、宣言、one-shot、holding）", () => {
  const rows = specs();
  assert.deepEqual(
    rows.map((row) => row.variantKey),
    KEYS,
  );
  for (const row of rows) {
    const oneShot = ONE_SHOT.includes(row.variantKey);
    assert.equal(row.kind === "one-shot", oneShot, row.variantKey);
    assert.equal(Boolean(row.oneShot), oneShot);
    // C5: a one-shot process issues no query before its measured one.
    assert.equal(row.buildChronicleIndex, !oneShot);
    assert.equal(row.readyProbe, !oneShot);
    assert.equal(
      row.declaration?.sceneId ?? null,
      DECLARED[row.variantKey] ?? null,
    );
    assert.equal(row.holding, row.variantKey.includes("unusable"));
  }
  assert.equal(
    rows.find((row) => row.variantKey === "G-08/graph-index-unusable").kind,
    "graph-held-unusable",
  );
  assert.deepEqual(rows[0].g01Mode, {
    mode: null,
    reason: "rAndRirMode-unresolved",
  });
});

test("DR-CP4-N-1: S2 の値の食い違いは [precheck]（one-shot、宣言、d2 の読み、数、順）", () => {
  const refuse = (mutate, pattern) =>
    assert.throws(
      () =>
        formalRunPlan({
          plans: PLANS,
          prep: s2Prep(mutate),
          addenda: ADDENDA,
        }),
      pattern,
    );
  refuse((v) => {
    v.samplePlan.variantExceptions[0].variants.pop();
  }, /disagree on one-shot/u);
  refuse((v) => {
    v.d10.parity.oneShot.variants = [ONE_SHOT[0]];
  }, /disagree on one-shot/u);
  refuse((v) => {
    v.d2.variantReadings.readAs[1].oneShot = false;
  }, /disagree on one-shot/u);
  refuse((v) => {
    v.samplePlan.variantExceptions[0].preMeasurementQueries = true;
  }, /no pre-measurement query/u);
  refuse((v) => {
    v.samplePlan.variantExceptions[0].excludeFromDefaultPools = true;
  }, /kept in the pools/u);
  refuse((v) => {
    v.samplePlan.variantExceptions[0].measuredProcessesPerArm = 20;
  }, /measured 30 processes/u);
  refuse((v) => {
    v.samplePlan.warmupPerArm = 3;
  }, /warm-up 5/u);
  refuse((v) => {
    v.samplePlan.variants.reverse();
  }, /catalog order/u);
  refuse((v) => {
    v.d1.choice = "i";
  }, /\(ii\)/u);
  refuse((v) => {
    v.d1.runs.pop();
  }, /d1.runs/u);
  refuse((v) => {
    v.d2.variantReadings.readAs[0].b = "current";
  }, /indexState/u);
  refuse((v) => {
    v.d2.variantReadings.unchanged.pop();
  }, /each of the 13/u);
  refuse((v) => {
    v.setupReadings.measurementSpecs["while-graph-index-unusable"].kind =
      "steady-state";
  }, /measurementSpecs/u);
  assert.throws(
    () =>
      formalRunPlan({
        plans: PLANS,
        prep: s2Prep(),
        addenda: [ADDENDA[1]],
      }),
    /d1.runs and the addenda/u,
  );
  assert.throws(
    () =>
      formalRunPlan({
        plans: PLANS.slice(1),
        prep: s2Prep(),
        addenda: ADDENDA,
      }),
    /13 complete setup plans/u,
  );
});

test("d10.g01: G-01 の R と R+IR の mode は S4 が埋めるまで未決（[precheck] の理由）、埋めた値は記録と一致", () => {
  assert.equal(g01ModeOf(s2Prep().d10).mode, null);
  assert.deepEqual(
    g01ModeOf({
      g01: { rAndRirMode: "unrestricted", da1AcceptanceRecord: "none" },
    }),
    { mode: "unrestricted", reason: null },
  );
  assert.deepEqual(
    g01ModeOf({
      g01: {
        rAndRirMode: "restricted",
        da1AcceptanceRecord: "docs/plans/da1.md",
      },
    }),
    { mode: "restricted", reason: null },
  );
  assert.throws(
    () =>
      g01ModeOf({
        g01: { rAndRirMode: "restricted", da1AcceptanceRecord: "none" },
      }),
    /does not follow/u,
  );
});

test("S2 P-4 (b): one-shot の process は arm ごとに warm-up 5＋測定 30、AB/BA は process の並びに repeat で当てる", () => {
  const spec = specs().find((row) => row.variantKey === ONE_SHOT[0]);
  const rows = oneShotProcessSchedule(spec.oneShot);
  assert.equal(rows.length, 70);
  for (const phase of ["warmup", "measured"])
    for (const arm of ["hybrid", "graph"])
      assert.equal(
        rows.filter((row) => row.phase === phase && row.arm === arm).length,
        phase === "warmup" ? 5 : 30,
      );
  const first = (phase, repeat) =>
    rows.find((row) => row.phase === phase && row.repeat === repeat).arm;
  assert.equal(first("warmup", 0), "hybrid");
  assert.equal(first("warmup", 1), "graph");
  assert.equal(first("measured", 0), "hybrid");
  assert.equal(first("measured", 29), "graph");
  assert.deepEqual(
    rows.map((row) => row.process),
    rows.map((_, at) => at),
  );
  assert.equal(spec.oneShot.receiptLabel, "one-shot（index-state-holding）");
  // The receipt's aggregates read the AB/BA schedule: the processes in
  // order are exactly runSchedule's slots.
  assert.deepEqual(
    rows.map(({ phase, repeat, arm }) => ({ phase, repeat, arm })),
    runSchedule(),
  );
});

const clean = (generation) => ({ generation, dirty: false });
const dirty = (generation) => ({ generation, dirty: true });

/** The before-measurement and at-query state each variant declares. */
function heldState(spec) {
  const graph = spec.indexState.graph === "usable" ? clean(7) : dirty(7);
  const chronicle =
    spec.indexState.chronicle === "usable" ? clean(3) : dirty(3);
  return {
    metadata: { b: graph, chronicle },
    beforeUsable: spec.buildChronicleIndex
      ? spec.indexState.chronicle === "usable"
      : null,
    atQuery: spec.indexState.chronicle === "usable",
  };
}

test("DR-CP4-N-3: d2 の probe は 13 variant すべてで宣言の状態なら通り、測定の前と query の時点の不一致は blocked（表で判定）", () => {
  const setupProbe = { bGeneration: 7 };
  for (const spec of specs()) {
    const plan = PLANS.find((row) => row.variantKey === spec.variantKey);
    const state = heldState(spec);
    const before = d2ProbeCheck({
      spec,
      setupProbe,
      metadata: state.metadata,
      indexUsable: state.beforeUsable,
      at: "before-measurement",
    });
    assert.equal(before.ok, true, spec.variantKey);
    assert.equal(
      d2ProbeCheck({
        spec,
        setupProbe,
        metadata: null,
        indexUsable: state.atQuery,
        at: "at-query",
      }).ok,
      true,
    );
    // at-query: the opposite snapshot is a mismatch.
    const atQuery = d2ProbeCheck({
      spec,
      setupProbe,
      metadata: null,
      indexUsable: !state.atQuery,
      at: "at-query",
    });
    assert.equal(atQuery.ok, false);
    const judged = blockedJudgement({ plan, blocked: atQuery.blocked });
    if (spec.holding) {
      assert.equal(judged.harnessId, "index-state-holding");
      assert.equal(judged.contractBlockedId, "index-state-holding");
    } else {
      assert.equal(judged.harnessId, "measurement-point-mismatch");
      assert.equal(judged.condition, "chronicle-only");
      assert.equal(judged.contractBlockedId, null);
      assert.equal(judged.hold, true);
      assert.equal(judged.precheck, true);
    }
    // before: B at another generation (a new seal) is a Graph mismatch.
    if (spec.indexState.graph === "usable") {
      const moved = d2ProbeCheck({
        spec,
        setupProbe,
        metadata: { ...state.metadata, b: clean(8) },
        indexUsable: state.beforeUsable,
        at: "before-measurement",
      });
      assert.equal(moved.ok, false, spec.variantKey);
      const row = blockedJudgement({ plan, blocked: moved.blocked });
      if (spec.holding)
        assert.equal(row.contractBlockedId, "index-state-holding");
      else if (spec.caseId === "G-01") {
        assert.equal(row.contractBlockedId, null);
        assert.equal(row.hold, true);
        assert.equal(row.precheck, false);
      } else assert.equal(row.contractBlockedId, "b-sealed-binding");
    }
  }
});

test("DR-CP4-N-3: readAs の読み（graph-index-unusable は B の generation を保ち、one-shot は C が dirty で query の時点で使えない）", () => {
  const rows = specs();
  const spec = (key) => rows.find((row) => row.variantKey === key);
  const setupProbe = { bGeneration: 7 };
  // graph-index-unusable: a dirty B with another generation is not held.
  assert.equal(
    d2ProbeCheck({
      spec: spec("G-08/graph-index-unusable"),
      setupProbe,
      metadata: { b: dirty(8), chronicle: clean(3) },
      indexUsable: true,
      at: "before-measurement",
    }).ok,
    false,
  );
  // chronicle-index-unusable: a clean C before the query is not held (C5).
  const held = d2ProbeCheck({
    spec: spec("G-08/chronicle-index-unusable"),
    setupProbe,
    metadata: { b: clean(7), chronicle: clean(3) },
    indexUsable: null,
    at: "before-measurement",
  });
  assert.equal(held.ok, false);
  assert.equal(held.blocked.harnessId, "index-state-holding");
  // A one-shot query that found C usable (a pre-measurement query rebuilt it).
  assert.equal(
    d2ProbeCheck({
      spec: spec("G-08/both-indexes-unusable"),
      setupProbe,
      metadata: null,
      indexUsable: true,
      at: "at-query",
    }).blocked.condition,
    "while-variant",
  );
  // steady state: an Index build whose last snapshot was unusable.
  assert.equal(
    d2ProbeCheck({
      spec: spec("G-02/base"),
      setupProbe,
      metadata: { b: clean(7), chronicle: clean(3) },
      indexUsable: false,
      at: "before-measurement",
    }).blocked.condition,
    "chronicle-only",
  );
  assert.throws(
    () =>
      d2ProbeCheck({
        spec: spec("G-02/base"),
        setupProbe,
        metadata: null,
        indexUsable: true,
        at: "later",
      }),
    /unknown probe time/u,
  );
});

test("DR-CP4-N-2: setup の blocked は受領書の名前のまま表で判定し直し、食い違い・表に無い組は [precheck]", () => {
  const plan = PLANS.find((row) => row.variantKey === "G-02/base");
  const g01 = PLANS[0];
  const blocked = {
    harnessId: "b-seal-not-published",
    condition: "any",
    unmet: ["b-sealed-binding"],
  };
  const row = blockedJudgement({ plan, blocked });
  assert.equal(row.contractBlockedId, "b-sealed-binding");
  assert.equal(blockedJudgement({ plan: g01, blocked }).hold, true);
  assert.deepEqual(
    blockedJudgement({ plan, blocked, recorded: { ...row } }),
    row,
  );
  assert.throws(
    () =>
      blockedJudgement({
        plan,
        blocked,
        recorded: { ...row, contractBlockedId: "maintenance-enabled" },
      }),
    /differs from BLOCKED_CONTRACT_TABLE/u,
  );
  assert.throws(
    () =>
      blockedJudgement({
        plan,
        blocked: {
          harnessId: "index-state-holding",
          condition: "graph",
        },
      }),
    /no case judgement/u,
  );
});

test("SP-P1 on ⑤: 測定の写しの pin を gate の行と照合する（別の Scene、2 つ目の pin、自己申告は拒む）", () => {
  const ws = seedPinWorkspace({
    caseId: "G-02",
    variantId: "base",
    querySceneLogical: "g02-query",
    querySceneRuntime: "rt-query",
    seedLogical: "g02-orla",
    seedRuntime: "rt-orla",
    pins: [{ entryId: "rt-orla", createdAt: "2026-10-28T00:00:00Z" }],
    stopsAt: "complete",
  });
  const gateRow = {
    caseId: "G-02",
    variantId: "base",
    querySceneId: "rt-query",
    expectedSeed: "rt-orla",
  };
  assert.equal(
    measurementCopySeedCheck({ gateRow, read: ws.read }).status,
    "match",
  );
  assert.throws(
    () =>
      measurementCopySeedCheck({
        gateRow: { ...gateRow, expectedSeed: "rt-other" },
        read: ws.read,
      }),
    /mismatch/u,
  );
  assert.throws(
    () =>
      measurementCopySeedCheck({
        gateRow: { ...gateRow, querySceneId: "rt-other" },
        read: ws.read,
      }),
    /another Scene/u,
  );
  assert.throws(
    () =>
      measurementCopySeedCheck({
        gateRow,
        read: JSON.parse(JSON.stringify(ws.read)),
      }),
    /read from its DB/u,
  );
  const two = seedPinWorkspace({
    caseId: "G-02",
    variantId: "base",
    querySceneLogical: "g02-query",
    querySceneRuntime: "rt-query",
    seedLogical: "g02-orla",
    seedRuntime: "rt-orla",
    pins: [
      { entryId: "rt-orla", createdAt: "2026-10-28T00:00:00Z" },
      { entryId: "rt-sela", createdAt: "2026-10-28T00:00:01Z" },
    ],
    stopsAt: "complete",
  });
  assert.throws(
    () => measurementCopySeedCheck({ gateRow, read: two.read }),
    /multiple-pins/u,
  );
});

test("K2/4 (S3-P3-6): 宣言の段の前後の tree order・registry・v1 の列・A1 の digest が違えば [precheck]", () => {
  const state = {
    treeOrder: { rows: 3, sha256: "a" },
    registry: { rows: 1, sha256: "b" },
    sceneV1: { rows: 3, sha256: "c" },
    a1: { rows: 3, sha256: "d" },
  };
  assert.equal(
    declarationInvariantCheck({ before: state, after: { ...state } }).same,
    true,
  );
  assert.throws(
    () =>
      declarationInvariantCheck({
        before: state,
        after: { ...state, sceneV1: { rows: 3, sha256: "x" } },
      }),
    /changed sceneV1/u,
  );
});

test("d10: parity は restricted の R と R+IR の各 sample を unrestricted の measured と比べ、unrestricted どうしの食い違いは [precheck]", () => {
  const row = (repeat, raw, fused, extra = {}) => ({
    arm: "hybrid",
    phase: "measured",
    repeat,
    rawSceneIds: raw,
    finalSceneIds: fused,
    ...extra,
  });
  const reference = Array.from({ length: 30 }, (_, at) =>
    row(at, ["a", "b"], ["a", "b", "c"]),
  );
  assert.deepEqual(
    parityComparison({ restricted: reference, unrestricted: reference }),
    { status: "match", compared: 30, mismatches: [] },
  );
  const moved = reference.map((value, at) =>
    at === 4 ? row(4, ["b", "a"], ["b", "a", "c"]) : value,
  );
  assert.deepEqual(
    parityComparison({ restricted: moved, unrestricted: reference }).mismatches,
    [4],
  );
  assert.throws(
    () => parityComparison({ restricted: reference, unrestricted: moved }),
    /differ among themselves/u,
  );
  assert.throws(
    () =>
      parityComparison({
        restricted: reference,
        unrestricted: reference.slice(1),
      }),
    /30 measured/u,
  );
});

/** The logical → runtime map of a setup receipt (synthetic runtime IDs). */
function runtimeIds(plan) {
  const ids = {
    projectId: "rt-p",
    scenes: {},
    entities: {},
    typedRevisions: {},
  };
  for (const step of plan.steps) {
    if (step.executor === "scenes")
      for (const row of step.input.rows ?? [])
        ids.scenes[row.logicalId ?? row.id] = `rt-${row.logicalId ?? row.id}`;
    if (step.executor === "entities")
      for (const row of step.input.rows)
        ids.entities[row.logicalId] = `rt-${row.logicalId}`;
  }
  for (const id of typedRevisionMaterials(plan).keys())
    ids.typedRevisions[id] = { revisionId: `rt-rev-${id}` };
  ids.querySceneId = ids.scenes[plan.querySceneId];
  return ids;
}

function fixtureExpectations(plan) {
  const fixture = JSON.parse(
    readFileSync(path.join(REPO_ROOT, plan.fixturePath), "utf8"),
  );
  return (
    fixture.variants?.find((row) => row.id === plan.variantId)?.expectations ??
    fixture.expectations
  );
}

/** The Entities' summaries as of a Revision's prepare (the plan's order). */
function entitiesAt(plan, revisionId) {
  const entities = new Map();
  for (const step of plan.steps) {
    if (step.executor === "entities")
      for (const row of step.input.rows)
        entities.set(row.logicalId, { name: row.name, summary: row.summary });
    if (step.executor === "codex-entry-summary-edit")
      entities.get(step.input.entityId).summary = step.input.to;
    if (
      step.executor === "typed-revision" &&
      (step.input.id === revisionId ||
        step.input.rows?.some((row) => row.id === revisionId))
    )
      break;
  }
  return entities;
}

const quoteEdge = (materials, revisionId, relationId, ids, plan, summary) => {
  const relation = materials
    .get(revisionId)
    .relations.find((row) => row.relationId === relationId);
  const entities = entitiesAt(plan, revisionId);
  const quote = (logical) =>
    summary?.[logical] ?? productQuoteOf(entities.get(logical));
  return {
    relationType: relation.relationType,
    directionality: relation.directionality,
    from: { entityId: ids.entities[relation.from] },
    to: { entityId: ids.entities[relation.to] },
    evidence: [
      { evidenceId: `e-${relation.from}`, quote: quote(relation.from) },
      { evidenceId: `e-${relation.to}`, quote: quote(relation.to) },
    ],
  };
};

/** The observed paths of the expected contribution, built from the materials. */
function expectedPaths(plan, expectations, ids, summary = null) {
  const { materials, paths } = expectedMaterialPaths({ plan, expectations });
  const edges = (pairs) =>
    pairs.map((pair) => {
      const [revisionId, relationId] = pair.split("|");
      return quoteEdge(materials, revisionId, relationId, ids, plan, summary);
    });
  const graphOnly = paths.find((row) => row.kind === "graph-only");
  return {
    graphOnly: graphOnly
      ? {
          sceneId: ids.scenes[graphOnly.sceneId],
          edges: edges(graphOnly.pairs),
        }
      : null,
    pathAttachments: paths
      .filter((row) => row.kind === "path-attachment")
      .map((row) => ({
        sceneId: ids.scenes[row.sceneId],
        edges: edges(row.pairs),
      })),
  };
}

test("DR-CP4-N-4: 13 variant の期待の path は fixture から 1 つの qualified な typed Revision に解決し、観測が同じ材料なら寄与あり", () => {
  let withPaths = 0;
  for (const plan of PLANS) {
    const expectations = fixtureExpectations(plan);
    const { paths } = expectedMaterialPaths({ plan, expectations });
    const ids = runtimeIds(plan);
    const resolver = materialRevisionResolver({ plan, expectations, ids });
    const result = resolver.contribution(
      hashGraphPaths(expectedPaths(plan, expectations, ids)),
    );
    assert.equal(result.basis, F6_FORMAL_BASIS);
    assert.equal(result.contribution, paths.length > 0, plan.variantKey);
    assert.equal(result.unresolvedEdges, 0);
    if (paths.length > 0) withPaths += 1;
    // No Graph, no contribution.
    assert.equal(resolver.contribution(null).contribution, false);
  }
  // G-01, G-02, G-03 base, G-04〜G-07, G-08 base-usable and graph-recovered.
  assert.equal(withPaths, 9);
});

test("DR-CP4-N-4: G-05 の xan-1（古い summary の quote）は xan-2 と区別され寄与にならない。向き違い・型違い・別の Scene も寄与にならない", () => {
  const plan = PLANS.find((row) => row.variantKey === "G-05/base");
  const expectations = fixtureExpectations(plan);
  const ids = runtimeIds(plan);
  const resolver = materialRevisionResolver({ plan, expectations, ids });
  const current = expectedPaths(plan, expectations, ids);
  assert.equal(
    resolver.contribution(hashGraphPaths(current)).contribution,
    true,
  );
  // xan-1 was prepared before the summary edit: its quote is the old one.
  const stale = expectedPaths(plan, expectations, ids, {
    "g05-xan": "Xan carries a copper lamp on night watch.",
  });
  const staleResult = resolver.contribution(hashGraphPaths(stale));
  assert.equal(staleResult.contribution, false);
  assert.deepEqual(
    staleResult.observed.map((row) => row.pairs),
    [["g05-r-xan-1|g05-supplied-xan"]],
  );
  const g02 = PLANS.find((row) => row.variantKey === "G-02/base");
  const g02Expect = fixtureExpectations(g02);
  const g02Ids = runtimeIds(g02);
  const g02Resolver = materialRevisionResolver({
    plan: g02,
    expectations: g02Expect,
    ids: g02Ids,
  });
  const base = expectedPaths(g02, g02Expect, g02Ids);
  const reversed = clone(base);
  const edge = reversed.graphOnly.edges[0];
  [edge.from, edge.to] = [edge.to, edge.from];
  [edge.evidence[0], edge.evidence[1]] = [edge.evidence[1], edge.evidence[0]];
  reversed.pathAttachments = [];
  const result = g02Resolver.contribution(hashGraphPaths(reversed));
  assert.equal(result.contribution, false);
  assert.equal(result.unresolvedEdges, 1);
  const retyped = clone(base);
  retyped.graphOnly.edges[0].relationType = "buys-from";
  retyped.pathAttachments = [];
  assert.equal(
    g02Resolver.contribution(hashGraphPaths(retyped)).contribution,
    false,
  );
  const moved = clone(base);
  moved.graphOnly.sceneId = g02Ids.scenes["g02-probe"];
  moved.pathAttachments = [];
  assert.equal(
    g02Resolver.contribution(hashGraphPaths(moved)).contribution,
    false,
  );
});

test("DR-CP4-N-4: quote は node で sha256 にしてから記録する（平文を残さない）", () => {
  const plain = {
    graphOnly: {
      sceneId: "s",
      edges: [
        {
          relationType: "t",
          directionality: "directed",
          from: { entityId: "a" },
          to: { entityId: "b" },
          evidence: [{ evidenceId: "e", quote: "secret text" }],
        },
      ],
    },
    pathAttachments: [],
  };
  const hashed = hashObservationPaths({
    fetches: [{ seq: 1, paths: plain }, { seq: 2 }],
  });
  assert.equal(JSON.stringify(hashed).includes("secret text"), false);
  assert.equal(
    hashed.fetches[0].paths.graphOnly.edges[0].evidence[0].quoteSha256,
    createHash("sha256").update("secret text").digest("hex"),
  );
  assert.equal(hashed.fetches[1].paths, undefined);
});

test("DR-CP4-N-4: 正式の run の子の記録は material-revision の基準で寄与を判定し、dev の予告は Scene の単位のまま", () => {
  const formal = k64GraphSampleRow(
    k64HookInput({
      materialContribution: () => ({
        basis: F6_FORMAL_BASIS,
        contribution: true,
        matched: ["graph-only:x"],
        unresolvedEdges: 0,
        observed: [],
      }),
    }),
  );
  assert.equal(formal.followUp.child.contributionBasis, F6_FORMAL_BASIS);
  assert.equal(formal.followUp.child.expectedContribution, true);
  assert.deepEqual(formal.followUp.child.materialRevision.matched, [
    "graph-only:x",
  ]);
  const none = k64GraphSampleRow(
    k64HookInput({
      materialContribution: () => ({
        basis: F6_FORMAL_BASIS,
        contribution: false,
        matched: [],
        unresolvedEdges: 1,
        observed: [],
      }),
    }),
  );
  assert.equal(none.followUp.child.expectedContribution, false);
  // Edges 0: no contribution even if the materials matched (F6).
  const empty = k64GraphSampleRow(
    k64HookInput({
      observation: k64Observation({
        child: {
          result: {
            ...k64Observation().fetches[0].result,
            ...K64_CHILD_RESULT,
            graph: { ...K64_CHILD_RESULT.graph, edgeCount: 0 },
          },
        },
      }),
      materialContribution: () => ({
        basis: F6_FORMAL_BASIS,
        contribution: true,
        matched: [],
        unresolvedEdges: 0,
        observed: [],
      }),
    }),
  );
  assert.equal(empty.followUp.child.expectedContribution, false);
  const preview = k64GraphSampleRow(k64HookInput());
  assert.equal(preview.followUp.child.contributionBasis, F6_PREVIEW_BASIS);
});

test("dev の形の確認: dev の graph case の plan から同じ形の仕様を導く（one-shot は契約の数）", () => {
  const plans = loadDevGraphCasePlans({
    root: REPO_ROOT,
    fixturePath:
      "scripts/quality/nir1-graph-eval/dev-fixtures/dev-harbor-graph-case.v1.json",
    stopsAt: "complete",
  });
  const rows = plans.map((plan) => devRunSpec(plan));
  const oneShot = rows.filter((row) => row.kind === "one-shot");
  assert.equal(oneShot.length, 2);
  for (const row of oneShot) {
    assert.equal(oneShotProcessSchedule(row.oneShot).length, 70);
    assert.equal(row.buildChronicleIndex, false);
  }
  assert.throws(() => devRunSpec(PLANS[1]), /dev graph-case plan only/u);
  for (const plan of plans) {
    const expectations = fixtureExpectations(plan);
    assert.doesNotThrow(() => expectedMaterialPaths({ plan, expectations }));
  }
});
