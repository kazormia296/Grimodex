// Synthetic variants and samples. The catalog and loader tests read only the
// frozen fixtures' digests, variant IDs and expectation fields (no Graph
// input); dev variants live in a fresh temp directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveVariantOutcome } from "../nir1-graph/contract.mjs";
import {
  FROZEN_FIXTURE_SHA256,
  GRAPH_CASE_FREEZE,
  GRAPH_EVAL_VARIANTS,
  devVariant,
  variantByKey,
} from "./constants.mjs";
import {
  EXISTING_QUERY_COMPARED_FIELDS,
  compareExistingQueryGraphArm,
  loadDevVariant,
  loadFrozenVariant,
  resolveCp4VariantOutcome,
  summarizeVariantQuality,
  unmetPreconditions,
} from "./outcome.mjs";
import { k64Sample, steadySummary } from "./test-support.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the catalog is the 13 frozen variants with their frozen digests and Graph status", async () => {
  assert.equal(GRAPH_EVAL_VARIANTS.length, 13);
  assert.equal(
    GRAPH_EVAL_VARIANTS.filter((row) => row.caseId !== "G-01").length,
    12,
  );
  assert.deepEqual(
    GRAPH_EVAL_VARIANTS.filter((row) => row.declaration).map((row) => row.key),
    [
      "G-01/v1",
      "G-02/base",
      "G-07/base",
      "G-08/base-usable",
      "G-08/graph-recovered",
    ],
  );
  const freezeBytes = await readFile(path.join(ROOT, GRAPH_CASE_FREEZE.path));
  assert.equal(sha256(freezeBytes), GRAPH_CASE_FREEZE.sha256);
  const freeze = JSON.parse(freezeBytes);
  assert.deepEqual(
    Object.fromEntries(freeze.cases.map((row) => [row.path, row.sha256])),
    FROZEN_FIXTURE_SHA256,
  );
  for (const [file, digest] of Object.entries(FROZEN_FIXTURE_SHA256))
    assert.equal(sha256(await readFile(path.join(ROOT, file))), digest, file);
  for (const entry of freeze.cases) {
    const catalog = GRAPH_EVAL_VARIANTS.filter(
      (row) => row.caseId === entry.caseId,
    );
    assert.ok(
      catalog.every((row) => row.fixturePath === entry.path),
      entry.caseId,
    );
    if (entry.caseId === "G-01") {
      assert.deepEqual(
        catalog.map((row) => row.variantId),
        ["v1"],
      );
      continue;
    }
    const fixture = JSON.parse(
      await readFile(path.join(ROOT, entry.path), "utf8"),
    );
    assert.deepEqual(
      catalog.map((row) => [row.variantId, row.expectedGraph]),
      fixture.variants.map((variant) => [
        variant.id,
        variant.expectations.graph.status,
      ]),
      entry.caseId,
    );
  }
});

const PRECONDITION_ROWS = {
  seal: { id: "b-sealed-binding", scope: "variant" },
  maintenance: { id: "maintenance-enabled", scope: "variant" },
  raw: { id: "raw-membership", scope: "variant" },
  ir: { id: "ir-supplement-admission", scope: "variant", sceneId: "dev-ir" },
  holding: { id: "index-state-holding", scope: "variant" },
  cb4: { id: "cb4-inputs", scope: "added-scene", sceneId: "dev-added" },
};

function devFixtureVariant(id, rows, options = {}) {
  return {
    id,
    measurementPoint: options.measurementPoint ?? "after-maintenance-current",
    indexState: options.indexState ?? { chronicle: "usable", graph: "usable" },
    preconditions: rows.map((key) => PRECONDITION_ROWS[key]),
    expectations: {
      arms: {
        raw: {
          sceneIds: ["dev-a", "dev-b"],
          orderPredeclared: options.ordered ?? false,
        },
        rPlusIr: { irSupplementSceneId: rows.includes("ir") ? "dev-ir" : null },
      },
    },
  };
}

function expectationsOf(variant) {
  return {
    rawSceneIds: variant.expectations.arms.raw.sceneIds,
    rawOrderPredeclared: variant.expectations.arms.raw.orderPredeclared,
    irSupplementSceneId: variant.expectations.arms.rPlusIr.irSupplementSceneId,
  };
}

function evidence(overrides = {}) {
  return {
    bSealedBinding: {
      route: "b-route-maintenance",
      publisher: "product",
      sealedGeneration: 3,
    },
    maintenance: {
      enabledVia: "runtime-policy-setting",
      sqlOverride: false,
      probe: {
        sealedChronicleGeneration: 4,
        sealedGraphGeneration: 3,
        sealedAtMs: 10,
      },
      mutationCommittedAtMs: 20,
    },
    rawMembership: { observedSceneIds: ["dev-a", "dev-b"] },
    irSupplement: {
      sceneId: "dev-ir",
      admitted: true,
      observedHybridSceneIds: ["dev-a", "dev-b", "dev-ir"],
    },
    indexStateHolding: {
      held: true,
      observed: { chronicle: "usable", graph: "unusable" },
    },
    cb4Inputs: { sceneId: "dev-added", present: true },
    ...overrides,
  };
}

test("only declared preconditions are judged, and missing evidence is unmet", () => {
  const all = devFixtureVariant("base", [
    "seal",
    "maintenance",
    "raw",
    "ir",
    "cb4",
  ]);
  const ex = expectationsOf(all);
  assert.deepEqual(unmetPreconditions(all, evidence(), ex), []);
  assert.deepEqual(
    unmetPreconditions(
      all,
      evidence({
        bSealedBinding: {
          route: "diagnostic-publisher",
          publisher: "test",
          sealedGeneration: 3,
        },
      }),
      ex,
    ),
    ["b-sealed-binding"],
  );
  assert.deepEqual(
    unmetPreconditions(
      all,
      evidence({ maintenance: { enabledVia: "sql", sqlOverride: true } }),
      ex,
    ),
    ["maintenance-enabled"],
  );
  assert.deepEqual(unmetPreconditions(all, {}, ex), [
    "b-sealed-binding",
    "maintenance-enabled",
    "raw-membership",
    "ir-supplement-admission",
    "cb4-inputs",
  ]);
  const noCb4 = devFixtureVariant("base", ["seal", "maintenance", "raw"]);
  assert.deepEqual(
    unmetPreconditions(
      noCb4,
      evidence({ cb4Inputs: null }),
      expectationsOf(noCb4),
    ),
    [],
  );
});

test("P2-6 (i): R membership is a set unless its order is predeclared", () => {
  const unordered = devFixtureVariant("base", ["raw"]);
  const reordered = evidence({
    rawMembership: { observedSceneIds: ["dev-b", "dev-a"] },
  });
  assert.deepEqual(
    unmetPreconditions(unordered, reordered, expectationsOf(unordered)),
    [],
  );
  const ordered = devFixtureVariant("base", ["raw"], { ordered: true });
  assert.deepEqual(
    unmetPreconditions(ordered, reordered, expectationsOf(ordered)),
    ["raw-membership"],
  );
  assert.deepEqual(
    unmetPreconditions(
      unordered,
      evidence({ rawMembership: { observedSceneIds: ["dev-a"] } }),
      expectationsOf(unordered),
    ),
    ["raw-membership"],
  );
});

test("P2-6 (ii): an unusable variant reaches the sealed generation before its mutation commits", () => {
  const unusable = devFixtureVariant("unusable", ["maintenance", "holding"], {
    measurementPoint: "while-graph-index-unusable",
    indexState: { chronicle: "usable", graph: "unusable" },
  });
  const ex = expectationsOf(unusable);
  assert.deepEqual(unmetPreconditions(unusable, evidence(), ex), []);
  const after = evidence({
    maintenance: {
      ...evidence().maintenance,
      probe: { ...evidence().maintenance.probe, sealedAtMs: 30 },
    },
  });
  assert.deepEqual(unmetPreconditions(unusable, after, ex), [
    "maintenance-enabled",
  ]);
  const untimed = evidence({
    maintenance: {
      ...evidence().maintenance,
      mutationCommittedAtMs: undefined,
    },
  });
  assert.deepEqual(unmetPreconditions(unusable, untimed, ex), [
    "maintenance-enabled",
  ]);
  // A current-point variant needs no ordering evidence.
  const current = devFixtureVariant("base", ["maintenance"]);
  assert.deepEqual(
    unmetPreconditions(current, untimed, expectationsOf(current)),
    [],
  );
  const wrongState = evidence({
    indexStateHolding: {
      held: true,
      observed: { chronicle: "usable", graph: "usable" },
    },
  });
  assert.deepEqual(unmetPreconditions(unusable, wrongState, ex), [
    "index-state-holding",
  ]);
});

test("P2-6 (iii): IR admission requires R+IR to place the Scene after R", () => {
  const variant = devFixtureVariant("base", ["raw", "ir"]);
  const ex = expectationsOf(variant);
  for (const hybrid of [
    ["dev-ir", "dev-a", "dev-b"],
    ["dev-a", "dev-ir", "dev-b"],
    ["dev-a", "dev-b"],
  ])
    assert.deepEqual(
      unmetPreconditions(
        variant,
        evidence({
          irSupplement: {
            sceneId: "dev-ir",
            admitted: true,
            observedHybridSceneIds: hybrid,
          },
        }),
        ex,
      ),
      ["ir-supplement-admission"],
      hybrid.join(","),
    );
});

function qualitySamples(variantKey, graphRows) {
  const rows = [];
  for (let repeat = 0; repeat < 30; repeat++) {
    rows.push({
      variantKey,
      arm: "hybrid",
      phase: "measured",
      repeat,
      trigger: "user-operation",
      finalSceneIds: ["dev-a", "dev-b"],
    });
    rows.push({
      variantKey,
      arm: "graph",
      phase: "measured",
      repeat,
      trigger: "user-operation",
      tFetch: 0,
      tRawReady: 10,
      tReturn: 30,
      startSlot: { readyFresh: true },
      freshnessStamp: { matched: true },
      finalSceneIds: ["dev-a", "dev-b", "dev-added"],
      graph: {
        joined: true,
        source: "worker",
        revalidation: "passed",
        arrivedAt: 15,
      },
      ...graphRows(repeat),
    });
  }
  return rows;
}

const lateRow = {
  finalSceneIds: ["dev-a", "dev-b"],
  graph: { joined: false, source: null, revalidation: null, arrivedAt: null },
};
const quality = (key, rows) =>
  summarizeVariantQuality({
    variant: variantByKey(key),
    samples: qualitySamples(key, rows),
    steadyState: steadySummary("k62"),
  });

test("K6/2 step 8: in-window samples agree, unjoined samples equal R+IR, none in window is HOLD", () => {
  assert.equal(
    quality("G-02/base", (r) => (r % 2 ? lateRow : {})).status,
    "measurable",
  );
  assert.deepEqual(
    quality("G-02/base", () => lateRow),
    {
      variantKey: "G-02/base",
      status: "hold",
      reason: "no-in-window-sample",
    },
  );
  assert.equal(
    quality("G-02/base", (r) =>
      r === 3 ? { finalSceneIds: ["dev-added"] } : {},
    ).reason,
    "in-window-samples-differ",
  );
  assert.equal(
    quality("G-02/base", (r) =>
      r === 4 ? { ...lateRow, finalSceneIds: ["dev-b"] } : {},
    ).reason,
    "out-of-window-sample-differs-from-r-plus-ir",
  );
  // A joined cache result is not steady-state but is no late mix either.
  assert.equal(
    quality("G-02/base", (r) =>
      r === 5
        ? {
            graph: {
              joined: true,
              source: "cache",
              revalidation: "passed",
              arrivedAt: 15,
            },
          }
        : {},
    ).status,
    "measurable",
  );
  assert.equal(
    quality("G-08/graph-index-unusable", () => lateRow).status,
    "fallback-measured",
  );
  assert.equal(
    quality("G-08/graph-index-unusable", () => ({})).reason,
    "graph-joined-for-a-variant-expected-unavailable",
  );
});

test("P1-3: 期待が unavailable の variant に Graph が join したら、cache 由来でも READY でなくても FAIL", () => {
  for (const graph of [
    { joined: true, source: "cache", revalidation: "passed", arrivedAt: 15 },
    { joined: true, source: "worker", revalidation: "passed", arrivedAt: 15 },
  ])
    for (const startSlot of [{ readyFresh: true }, { readyFresh: false }])
      assert.equal(
        quality("G-03/frontier-exceeded", (r) =>
          r === 7 ? { graph, startSlot } : lateRow,
        ).reason,
        "graph-joined-for-a-variant-expected-unavailable",
        JSON.stringify({ graph, startSlot }),
      );
  // join しなくても、final list が同じ repeat の R+IR と違えば FAIL。
  assert.equal(
    quality("G-08/both-indexes-unusable", (r) =>
      r === 2 ? { ...lateRow, finalSceneIds: ["dev-b", "dev-a"] } : lateRow,
    ).reason,
    "fallback-sample-differs-from-r-plus-ir",
  );
  const measured = quality("G-08/chronicle-index-unusable", () => lateRow);
  assert.equal(measured.status, "fallback-measured");
  assert.deepEqual(measured.finalSceneIds, ["dev-a", "dev-b"]);
});

test("P1-3: 測った件数が 30 でなければ invalid（0 件でも fallback-measured にしない）", () => {
  const variant = variantByKey("G-08/graph-index-unusable");
  const rows = qualitySamples(variant.key, () => lateRow);
  for (const samples of [
    [],
    rows.filter((row) => !(row.arm === "graph" && row.repeat === 4)),
    rows.filter((row) => !(row.arm === "hybrid" && row.repeat === 9)),
  ]) {
    const result = summarizeVariantQuality({
      variant,
      samples,
      steadyState: steadySummary("k62"),
    });
    assert.equal(result.status, "invalid");
  }
  assert.throws(
    () => summarizeVariantQuality({ variant, samples: rows }),
    /regime/,
  );
});

test("D-12: 測った対の repeat が重複していれば invalid", () => {
  const variant = variantByKey("G-02/base");
  const rows = qualitySamples(variant.key, () => ({}));
  const graphDup = rows.map((row) =>
    row.arm === "graph" && row.repeat === 29 ? { ...row, repeat: 0 } : row,
  );
  const hybridExtra = [
    ...rows,
    { ...rows.find((row) => row.arm === "hybrid" && row.repeat === 3) },
  ];
  for (const samples of [graphDup, hybridExtra])
    assert.equal(
      summarizeVariantQuality({
        variant,
        samples,
        steadyState: steadySummary("k62"),
      }).status,
      "invalid",
    );
});

test("D-1: 品質の regime は封印した定常状態の要約から読み、呼び出し側が選べない", () => {
  const variant = variantByKey("G-02/base");
  const samples = qualitySamples(variant.key, () => ({}));
  for (const steadyState of [
    undefined,
    { regime: "k64" },
    { ...steadySummary("k64") },
    JSON.parse(JSON.stringify(steadySummary("k64"))),
  ])
    assert.throws(
      () => summarizeVariantQuality({ variant, samples, steadyState }),
      /summarizeSteadyState/,
    );
  assert.throws(
    () => summarizeVariantQuality({ variant, samples, regime: "k64" }),
    /unsupported option regime/,
  );
  assert.ok(Object.isFrozen(steadySummary("k64")));
});

/** K6/4 rows of one variant: hybrid shows the parent's R+IR list. */
function k64QualitySamples(variantKey, graphRow) {
  const rows = [];
  for (let repeat = 0; repeat < 30; repeat++) {
    rows.push({
      variantKey,
      arm: "hybrid",
      phase: "measured",
      repeat,
      trigger: "user-operation",
      finalSceneIds: ["dev-a", "dev-b", "dev-c"],
    });
    const [overrides = {}, followUp = {}] = graphRow(repeat);
    rows.push(
      k64Sample(
        { variantKey, phase: "measured", repeat, ...overrides },
        followUp,
      ),
    );
  }
  return rows;
}

const k64Quality = (key, graphRow) =>
  summarizeVariantQuality({
    variant: variantByKey(key),
    samples: k64QualitySamples(key, graphRow),
    steadyState: steadySummary("k64"),
  });

test("K6/4 品質（批准 3、K6/4-P1）: 表示された sample の表示の結果で測り、表示の種類を書く", () => {
  const result = k64Quality("G-02/base", () => [{}, {}]);
  assert.equal(result.status, "measurable");
  assert.equal(result.steadyState, true);
  assert.deepEqual(result.displays, { firstRender: 0, followUp: 30 });
  assert.deepEqual(result.finalSceneIds, [
    "dev-a",
    "dev-b",
    "dev-c",
    "dev-added",
  ]);
  // 表示されなかった sample は R+IR に混ざりなく戻っていればよい。
  assert.equal(
    k64Quality("G-02/base", (r) =>
      r % 3 === 0 ? [{}, { notices: [], child: null }] : [{}, {}],
    ).status,
    "measurable",
  );
});

test("K6/4-N12: 子の R か IR が親と違えば品質は FAIL", () => {
  assert.equal(
    k64Quality("G-02/base", (r) =>
      r === 4 ? [{}, { child: { irSceneIds: ["dev-z"] } }] : [{}, {}],
    ).reason,
    "follow-up-r-or-ir-differs",
  );
});

test("K6/4-N13: 同じ case の表示の結果が sample の間で違えば FAIL", () => {
  assert.equal(
    k64Quality("G-02/base", (r) =>
      r === 8
        ? [
            {},
            {
              child: {
                finalSceneIds: ["dev-a", "dev-added", "dev-b", "dev-c"],
              },
            },
          ]
        : [{}, {}],
    ).reason,
    "displayed-samples-differ",
  );
});

test("K6/4-N14: 表示された sample が無い case は HOLD", () => {
  assert.deepEqual(
    k64Quality("G-02/base", () => [{}, { notices: [], child: null }]),
    { variantKey: "G-02/base", status: "hold", reason: "no-displayed-sample" },
  );
});

test("K6/4: 表示されなかった sample の親の表示が R+IR と違う、遅れた結果が混ざった、期待が unavailable なのに子が Graph を出した、はどれも FAIL", () => {
  assert.equal(
    k64Quality("G-02/base", (r) =>
      r === 1
        ? [{ finalSceneIds: ["dev-a"] }, { notices: [], child: null }]
        : [{}, {}],
    ).reason,
    "not-displayed-sample-differs-from-r-plus-ir",
  );
  assert.equal(
    k64Quality("G-02/base", (r) =>
      r === 1 ? [{}, { child: { lateGraphInDisplay: true } }] : [{}, {}],
    ).reason,
    "late-result-mixed-into-a-display",
  );
  // unavailable の variant: 子が Graph を出したら FAIL、出さなければ fallback。
  const unavailable = (graphRow) =>
    summarizeVariantQuality({
      variant: variantByKey("G-03/frontier-exceeded"),
      samples: k64QualitySamples("G-03/frontier-exceeded", graphRow),
      steadyState: steadySummary("k64"),
    });
  assert.equal(
    unavailable((r) =>
      r === 3 ? [{}, {}] : [{}, { notices: [], child: null }],
    ).reason,
    "graph-shown-for-a-variant-expected-unavailable",
  );
  assert.equal(
    unavailable(() => [{}, { notices: [], child: null }]).status,
    "fallback-measured",
  );
});

test("a joined-but-late sample within tolerance makes the variant HOLD boundary-disagreement", () => {
  const result = quality("G-02/base", (r) =>
    r === 6
      ? {
          graph: {
            joined: true,
            source: "worker",
            revalidation: "passed",
            arrivedAt: 20.845,
          },
        }
      : {},
  );
  assert.deepEqual(result, {
    variantKey: "G-02/base",
    status: "hold",
    reason: "boundary-disagreement",
    repeats: [6],
  });
});

async function devRoot(variants, name = "dev-g02.v1.json") {
  const root = await mkdtemp(path.join(tmpdir(), "cp4-dev-"));
  const file = `scripts/quality/nir1-graph-eval/dev-fixtures/${name}`;
  await mkdir(path.join(root, path.dirname(file)), { recursive: true });
  await writeFile(
    path.join(root, file),
    JSON.stringify({ caseId: "DEV-02", variants }),
  );
  return { root, file };
}

const MEASURABLE = { status: "measurable" };

test("P-6 / P2-5: outcomes come from resolveVariantOutcome on a loaded fixture variant", async () => {
  const variant = devFixtureVariant("base", [
    "seal",
    "maintenance",
    "raw",
    "cb4",
  ]);
  const { root, file } = await devRoot([variant]);
  try {
    const loaded = await loadDevVariant({
      root,
      fixturePath: file,
      variantId: "base",
      expectedGraph: "available",
    });
    assert.equal(loaded.variantKey, "dev:dev-g02.v1/base");
    const blocked = resolveCp4VariantOutcome({
      loaded,
      evidence: evidence({ bSealedBinding: { route: "diagnostic-publisher" } }),
      quality: MEASURABLE,
      comparisonPassed: true,
    });
    const { variantKey, holdReason, ...policy } = blocked;
    assert.equal(variantKey, "dev:dev-g02.v1/base");
    assert.equal(holdReason, null);
    assert.deepEqual(
      policy,
      resolveVariantOutcome(loaded.fixtureVariant, {
        unmet: ["b-sealed-binding"],
      }),
    );
    assert.equal(policy.outcome, "blocked:b-sealed-binding");
    const sub = resolveCp4VariantOutcome({
      loaded,
      evidence: evidence({
        cb4Inputs: { sceneId: "dev-added", present: false },
      }),
      quality: MEASURABLE,
      comparisonPassed: true,
    });
    assert.equal(sub.outcome, "pass");
    assert.equal(sub.blockedSubExpectations[0].outcome, "blocked:cb4-inputs");
    const hold = resolveCp4VariantOutcome({
      loaded,
      evidence: evidence(),
      quality: { status: "hold", reason: "boundary-disagreement" },
      comparisonPassed: true,
    });
    assert.equal(hold.outcome, "hold");
    assert.equal(hold.holdReason, "boundary-disagreement");
    // A hand-built variant (e.g. another case's `base`) is refused.
    assert.throws(
      () =>
        resolveCp4VariantOutcome({
          loaded: { ...loaded },
          evidence: evidence(),
          quality: MEASURABLE,
          comparisonPassed: true,
        }),
      /must come from loadFrozenVariant/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-5: a frozen variant is loaded by digest and case ID", async () => {
  const loaded = await loadFrozenVariant({
    root: ROOT,
    variantKey: "G-04/base",
  });
  assert.equal(loaded.caseId, "G-04");
  assert.equal(loaded.expectations.irSupplementSceneId, "g04-lio-landing");
  assert.equal(loaded.expectations.rawOrderPredeclared, true);
  const fake = await mkdtemp(path.join(tmpdir(), "cp4-frozen-"));
  try {
    const file = variantByKey("G-04/base").fixturePath;
    await mkdir(path.join(fake, path.dirname(file)), { recursive: true });
    await writeFile(
      path.join(fake, file),
      JSON.stringify({ caseId: "G-04", variants: [] }),
    );
    await assert.rejects(
      loadFrozenVariant({ root: fake, variantKey: "G-04/base" }),
      /frozen digest/,
    );
  } finally {
    await rm(fake, { recursive: true, force: true });
  }
  await assert.rejects(
    loadFrozenVariant({ root: ROOT, variantKey: "G-09/base" }),
    /unknown CP-4 variant/,
  );
});

test("P1-3: a dev fixture that copies frozen material is refused", async () => {
  const bytes = await readFile(
    path.join(ROOT, variantByKey("G-02/base").fixturePath),
  );
  const root = await mkdtemp(path.join(tmpdir(), "cp4-copy-"));
  try {
    const file = "scripts/quality/nir1-graph-eval/dev-fixtures/copy.json";
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
    await assert.rejects(
      loadDevVariant({
        root,
        fixturePath: file,
        variantId: "base",
        expectedGraph: "available",
      }),
      /copy of frozen material/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.throws(
    () => devVariant({ key: "G-02/base", expectedGraph: "available" }),
    /dev variant key/,
  );
});

test("G-01 declares no precondition: an unreached B seal is a v1 expectation Hold", async () => {
  const loaded = await loadFrozenVariant({ root: ROOT, variantKey: "G-01/v1" });
  const hold = resolveCp4VariantOutcome({
    loaded,
    evidence: evidence({ bSealedBinding: null }),
    quality: MEASURABLE,
    comparisonPassed: true,
  });
  assert.equal(hold.outcome, "hold");
  assert.equal(hold.holdReason, "g01-v1-expectation-not-reached:b-seal");
  assert.equal(
    resolveCp4VariantOutcome({
      loaded,
      evidence: evidence(),
      quality: MEASURABLE,
      comparisonPassed: true,
    }).outcome,
    "pass",
  );
});

function existingSample(overrides = {}) {
  return {
    result: {
      kind: "hybrid",
      scenes: [
        { sceneId: "s1", chunkText: "alpha" },
        { sceneId: "s2", chunkText: "beta" },
      ],
    },
    evidence: [{ sceneId: "s1", status: "qualified", bindingMatches: true }],
    graph: { status: "not-requested", seed: null, contributionCount: 0 },
    ...overrides,
  };
}

test("P-2 / N-15 / P2-11: the existing queries' Graph arm equals R+IR in every compared field", () => {
  assert.deepEqual(EXISTING_QUERY_COMPARED_FIELDS, [
    "membership",
    "order",
    "excerpt",
    "evidence",
  ]);
  const hybrid = existingSample();
  assert.deepEqual(compareExistingQueryGraphArm(hybrid, existingSample()), {
    equal: true,
    violations: [],
  });
  const reordered = existingSample({
    result: { kind: "hybrid", scenes: [...hybrid.result.scenes].reverse() },
  });
  assert.deepEqual(compareExistingQueryGraphArm(hybrid, reordered).violations, [
    "order",
    "excerpt",
  ]);
  const added = existingSample({
    result: {
      kind: "hybrid",
      scenes: [...hybrid.result.scenes, { sceneId: "s3", chunkText: "g" }],
    },
  });
  assert.ok(
    compareExistingQueryGraphArm(hybrid, added).violations.includes(
      "membership",
    ),
  );
  const excerpt = existingSample({
    result: {
      kind: "hybrid",
      scenes: [hybrid.result.scenes[0], { sceneId: "s2", chunkText: "BETA" }],
    },
  });
  assert.deepEqual(compareExistingQueryGraphArm(hybrid, excerpt).violations, [
    "excerpt",
  ]);
  assert.deepEqual(
    compareExistingQueryGraphArm(hybrid, existingSample({ evidence: [] }))
      .violations,
    ["evidence"],
  );
  assert.deepEqual(
    compareExistingQueryGraphArm(
      hybrid,
      existingSample({
        graph: {
          status: "not-requested",
          seed: "entity-1",
          contributionCount: 0,
        },
      }),
    ).violations,
    ["forbidden-contribution:seed"],
  );
  assert.deepEqual(
    compareExistingQueryGraphArm(
      hybrid,
      existingSample({
        graph: { status: "graph-ready", seed: null, contributionCount: 1 },
      }),
    ).violations,
    ["graph-status:graph-ready", "forbidden-contribution:graph-rows"],
  );
  // Both result arrays missing never compare equal.
  assert.deepEqual(
    compareExistingQueryGraphArm({}, { graph: { status: "not-requested" } }),
    {
      equal: false,
      violations: ["missing-result", "missing-evidence"],
    },
  );
});
