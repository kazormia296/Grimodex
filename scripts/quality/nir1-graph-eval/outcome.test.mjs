// Synthetic variants and samples. The catalog test reads only the variant IDs
// and `expectations.graph.status` of the frozen fixtures (no Graph input).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { resolveVariantOutcome } from "../nir1-graph/contract.mjs";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import {
  EXISTING_QUERY_COMPARED_FIELDS,
  compareExistingQueryGraphArm,
  resolveCp4VariantOutcome,
  summarizeVariantQuality,
  unmetPreconditions,
} from "./outcome.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

const PRECONDITION_ROWS = {
  seal: { id: "b-sealed-binding", scope: "variant" },
  maintenance: { id: "maintenance-enabled", scope: "variant" },
  raw: { id: "raw-membership", scope: "variant" },
  ir: { id: "ir-supplement-admission", scope: "variant", sceneId: "dev-ir" },
  holding: { id: "index-state-holding", scope: "variant" },
  cb4: { id: "cb4-inputs", scope: "added-scene", sceneId: "dev-added" },
};

function devVariant(
  id,
  rows,
  indexState = { chronicle: "usable", graph: "usable" },
) {
  return {
    id,
    preconditions: rows.map((key) => PRECONDITION_ROWS[key]),
    indexState,
  };
}

const EXPECTATIONS = { rawSceneIds: ["dev-a", "dev-b"] };

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
      probe: { sealedChronicleGeneration: 4, sealedGraphGeneration: 3 },
    },
    rawMembership: { observedSceneIds: ["dev-a", "dev-b"] },
    irSupplement: { sceneId: "dev-ir", admitted: true },
    indexStateHolding: {
      held: true,
      observed: { chronicle: "usable", graph: "unusable" },
    },
    cb4Inputs: { sceneId: "dev-added", present: true },
    ...overrides,
  };
}

test("the catalog is the 13 frozen variants with their expected Graph status", async () => {
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
  const manifest = JSON.parse(
    await readFile(
      path.join(ROOT, "evals/nir1-graph/manifest.v1.json"),
      "utf8",
    ),
  );
  for (const entry of manifest.cases) {
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

test("only declared preconditions are judged, and missing evidence is unmet", () => {
  const all = devVariant("base", ["seal", "maintenance", "raw", "ir", "cb4"]);
  assert.deepEqual(unmetPreconditions(all, evidence(), EXPECTATIONS), []);
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
      EXPECTATIONS,
    ),
    ["b-sealed-binding"],
  );
  assert.deepEqual(
    unmetPreconditions(
      all,
      evidence({ maintenance: { enabledVia: "sql", sqlOverride: true } }),
      EXPECTATIONS,
    ),
    ["maintenance-enabled"],
  );
  assert.deepEqual(
    unmetPreconditions(
      all,
      evidence({ rawMembership: { observedSceneIds: ["dev-b", "dev-a"] } }),
      EXPECTATIONS,
    ),
    ["raw-membership"],
  );
  assert.deepEqual(unmetPreconditions(all, {}, EXPECTATIONS), [
    "b-sealed-binding",
    "maintenance-enabled",
    "raw-membership",
    "ir-supplement-admission",
    "cb4-inputs",
  ]);
  // A variant that does not declare cb4 is not judged on it.
  const noCb4 = devVariant("base", ["seal", "maintenance", "raw"]);
  assert.deepEqual(
    unmetPreconditions(noCb4, evidence({ cb4Inputs: null }), EXPECTATIONS),
    [],
  );
  const holding = devVariant(
    "unusable",
    ["seal", "maintenance", "raw", "holding"],
    {
      chronicle: "usable",
      graph: "unusable",
    },
  );
  assert.deepEqual(unmetPreconditions(holding, evidence(), EXPECTATIONS), []);
  assert.deepEqual(
    unmetPreconditions(
      holding,
      evidence({
        indexStateHolding: {
          held: true,
          observed: { chronicle: "usable", graph: "usable" },
        },
      }),
      EXPECTATIONS,
    ),
    ["index-state-holding"],
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

test("K6/2 step 8: in-window samples agree, window-out samples equal R+IR, none in window is HOLD", () => {
  assert.equal(
    summarizeVariantQuality({
      variantKey: "G-02/base",
      samples: qualitySamples("G-02/base", (r) => (r % 2 ? lateRow : {})),
    }).status,
    "measurable",
  );
  assert.deepEqual(
    summarizeVariantQuality({
      variantKey: "G-02/base",
      samples: qualitySamples("G-02/base", () => lateRow),
    }),
    { variantKey: "G-02/base", status: "hold", reason: "no-in-window-sample" },
  );
  assert.equal(
    summarizeVariantQuality({
      variantKey: "G-02/base",
      samples: qualitySamples("G-02/base", (r) =>
        r === 3 ? { finalSceneIds: ["dev-added"] } : {},
      ),
    }).reason,
    "in-window-samples-differ",
  );
  assert.equal(
    summarizeVariantQuality({
      variantKey: "G-02/base",
      samples: qualitySamples("G-02/base", (r) =>
        r === 4 ? { ...lateRow, finalSceneIds: ["dev-b"] } : {},
      ),
    }).reason,
    "out-of-window-sample-differs-from-r-plus-ir",
  );
  assert.equal(
    summarizeVariantQuality({
      variantKey: "G-08/graph-index-unusable",
      samples: qualitySamples("G-08/graph-index-unusable", () => lateRow),
    }).status,
    "fallback-measured",
  );
  assert.equal(
    summarizeVariantQuality({
      variantKey: "G-08/graph-index-unusable",
      samples: qualitySamples("G-08/graph-index-unusable", () => ({})),
    }).reason,
    "graph-joined-for-a-variant-expected-unavailable",
  );
});

const MEASURABLE = { status: "measurable" };

test("P-6: G-case outcomes come from resolveVariantOutcome", () => {
  const variant = devVariant("base", ["seal", "maintenance", "raw", "cb4"]);
  const blocked = resolveCp4VariantOutcome({
    variantKey: "G-02/base",
    fixtureVariant: variant,
    evidence: evidence({ bSealedBinding: { route: "diagnostic-publisher" } }),
    expectations: EXPECTATIONS,
    quality: MEASURABLE,
    comparisonPassed: true,
  });
  const { variantKey, holdReason, ...policy } = blocked;
  assert.equal(variantKey, "G-02/base");
  assert.equal(holdReason, null);
  assert.deepEqual(
    policy,
    resolveVariantOutcome(variant, { unmet: ["b-sealed-binding"] }),
  );
  assert.equal(policy.outcome, "blocked:b-sealed-binding");
  assert.equal(policy.pass, false);
  // An unmet added-scene precondition blocks only the sub-expectation.
  const sub = resolveCp4VariantOutcome({
    variantKey: "G-02/base",
    fixtureVariant: variant,
    evidence: evidence({ cb4Inputs: { sceneId: "dev-added", present: false } }),
    expectations: EXPECTATIONS,
    quality: MEASURABLE,
    comparisonPassed: true,
  });
  assert.equal(sub.outcome, "pass");
  assert.equal(sub.blockedSubExpectations[0].outcome, "blocked:cb4-inputs");
  const hold = resolveCp4VariantOutcome({
    variantKey: "G-02/base",
    fixtureVariant: variant,
    evidence: evidence(),
    expectations: EXPECTATIONS,
    quality: { status: "hold", reason: "no-in-window-sample" },
    comparisonPassed: true,
  });
  assert.equal(hold.outcome, "hold");
  assert.equal(hold.holdReason, "no-in-window-sample");
  // An undeclared precondition never turns a difference into blocked.
  const undeclared = devVariant("base", ["seal", "maintenance", "raw"]);
  const kept = resolveCp4VariantOutcome({
    variantKey: "G-02/base",
    fixtureVariant: undeclared,
    evidence: evidence({ cb4Inputs: null }),
    expectations: EXPECTATIONS,
    quality: MEASURABLE,
    comparisonPassed: false,
  });
  assert.equal(kept.outcome, "hold");
  assert.throws(
    () =>
      resolveCp4VariantOutcome({
        variantKey: "G-03/frontier-exceeded",
        fixtureVariant: undeclared,
        evidence: evidence(),
        expectations: EXPECTATIONS,
        quality: MEASURABLE,
        comparisonPassed: true,
      }),
    /fixture variant does not match/,
  );
});

test("G-01 declares no precondition: an unreached B seal is a v1 expectation Hold", () => {
  const hold = resolveCp4VariantOutcome({
    variantKey: "G-01/v1",
    evidence: evidence({ bSealedBinding: null }),
    quality: MEASURABLE,
    comparisonPassed: true,
  });
  assert.equal(hold.outcome, "hold");
  assert.equal(hold.holdReason, "g01-v1-expectation-not-reached:b-seal");
  assert.ok(!hold.outcome.startsWith("blocked"));
  assert.equal(
    resolveCp4VariantOutcome({
      variantKey: "G-01/v1",
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

test("P-2 / N-15: the existing queries' Graph arm equals R+IR in every compared field", () => {
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
  const evidenceDiff = existingSample({ evidence: [] });
  assert.deepEqual(
    compareExistingQueryGraphArm(hybrid, evidenceDiff).violations,
    ["evidence"],
  );
  const seeded = existingSample({
    graph: { status: "not-requested", seed: "entity-1", contributionCount: 0 },
  });
  assert.deepEqual(compareExistingQueryGraphArm(hybrid, seeded).violations, [
    "forbidden-contribution:seed",
  ]);
  const ready = existingSample({
    graph: { status: "graph-ready", seed: null, contributionCount: 1 },
  });
  assert.deepEqual(compareExistingQueryGraphArm(hybrid, ready).violations, [
    "graph-status:graph-ready",
    "forbidden-contribution:graph-rows",
  ]);
});
