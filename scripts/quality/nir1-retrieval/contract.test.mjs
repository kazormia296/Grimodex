import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRAPH_ARM_SCOPES,
  GRAPH_ARM_UNAVAILABLE_REASON,
  GRAPH_ARM_WIRED,
  GRAPH_ARM_WIRING,
  RETRIEVAL_ARMS,
  assertGraphArmRequestable,
  classifyGraphFixturePath,
  describeGraphArm,
  graphSeedForExistingQuery,
  loadGraphSeedPolicy,
  nearestRank,
  scoreQuery,
  summarizeGraphArm,
  summarizeWarm,
  loadContract,
  validateWarmPopulation,
  validateRawIpcTrace,
} from "./contract.mjs";
import path from "node:path";

test("NIR-1 preimplementation corpus is balanced, isolated and grounded", async () => {
  await loadContract(path.resolve(import.meta.dirname, "../../.."));
});

test("same-query repetition and warmup contamination cannot certify pooled B", () => {
  const ids = Array.from({ length: 24 }, (_, index) => `query-${index}`);
  const calls = ids.flatMap((queryId) =>
    Array.from({ length: 30 }, (_, repeat) => ({
      queryId,
      repeat,
      arm: "raw",
      phase: "measured",
    })),
  );
  validateWarmPopulation(calls, ids);
  assert.throws(
    () =>
      validateWarmPopulation(
        calls.map((call) => ({ ...call, queryId: ids[0] })),
        ids,
      ),
    /balanced schedule/,
  );
  assert.throws(
    () =>
      validateWarmPopulation(
        [{ ...calls[0], phase: "warmup" }, ...calls.slice(1)],
        ids,
      ),
    /warmup/,
  );
});

test("a swallowed Native error envelope or absent source read fails the Raw sample", () => {
  const calls = ["db_execute", "semantic_search", "fts_search"].map(
    (command) => ({ command, completed: true, ok: true }),
  );
  validateRawIpcTrace(calls);
  assert.throws(
    () => validateRawIpcTrace([{ ...calls[0], ok: false }, ...calls.slice(1)]),
    /swallowed/,
  );
  assert.throws(() => validateRawIpcTrace(calls.slice(1)), /db_execute/);
});

test("graded nDCG and Recall count scenes once and reject ineligible results", () => {
  const query = {
    eligibleSceneIds: ["a", "b", "c"],
    relevanceGrades: { a: 3, b: 1, c: 0 },
    requiredRawPassages: [{ sceneId: "a", text: "whole quote" }],
  };
  const results = [
    { sceneId: "c", chunkText: "noise" },
    { sceneId: "a", chunkText: "whole quote" },
  ];
  const score = scoreQuery(query, results);
  assert.equal(score.recallAt8, 0.5);
  assert.ok(
    Math.abs(score.ndcgAt8 - 7 / Math.log2(3) / (7 + 1 / Math.log2(3))) < 1e-12,
  );
  assert.equal(score.requiredRawPassagesRetained, true);
  assert.throws(() => scoreQuery(query, [...results, results[1]]), /duplicate/);
  assert.throws(
    () => scoreQuery(query, [{ sceneId: "unread", chunkText: "whole quote" }]),
    /ineligible/,
  );
  assert.equal(
    scoreQuery(query, [{ sceneId: "a", chunkText: "whole" }])
      .requiredRawPassagesRetained,
    false,
  );
  const eight = Array.from({ length: 8 }, (_, i) => ({
    sceneId: `s${i}`,
    chunkText: "text",
  }));
  const capQuery = {
    eligibleSceneIds: eight.map((r) => r.sceneId),
    relevanceGrades: Object.fromEntries(eight.map((r) => [r.sceneId, 1])),
    requiredRawPassages: [],
  };
  assert.throws(
    () =>
      scoreQuery(capQuery, [
        ...eight,
        { sceneId: "forbidden-ninth", chunkText: "forbidden" },
      ]),
    /cap/,
  );
  assert.throws(() => scoreQuery(capQuery, [...eight, eight[0]]), /cap/);
});

test("nearest rank p95 has fixed denominator and failed calls cannot fix B", () => {
  assert.equal(
    nearestRank(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.95,
    ),
    95,
  );
  assert.throws(() => nearestRank([1, Infinity], 0.95));
  const calls = Array.from({ length: 720 }, () => ({
    status: "ok",
    durationMs: 100,
  }));
  assert.deepEqual(
    { B: summarizeWarm(calls).B, D: summarizeWarm(calls).D },
    { B: 100, D: 20 },
  );
  calls[0] = { status: "timeout", durationMs: 10000 };
  assert.equal(summarizeWarm(calls).B, null);
  assert.equal(summarizeWarm(calls).failedCount, 1);
  assert.equal(summarizeWarm(calls.slice(1)).status, "blocked");
  calls[0] = { status: "completed-safe-fallback", durationMs: 110 };
  assert.equal(summarizeWarm(calls).status, "complete");
  assert.equal(summarizeWarm(calls).scheduledCount, 720);
});

test("the R+IR+Graph arm is a not-wired scaffold that is unavailable and never passes", () => {
  assert.deepEqual(RETRIEVAL_ARMS, {
    raw: "R",
    hybrid: "R+IR",
    graph: "R+IR+Graph",
  });
  const arm = describeGraphArm();
  assert.equal(arm.wiring, GRAPH_ARM_WIRING);
  assert.equal(arm.status, "unavailable");
  assert.equal(arm.reason, GRAPH_ARM_UNAVAILABLE_REASON);
  assert.equal(arm.comparedAgainst, "hybrid");
  assert.equal(arm.scheduledCalls, 0);
  assert.equal(arm.pass, false);
  assert.deepEqual(summarizeGraphArm(arm), {
    status: "hold",
    reason: GRAPH_ARM_UNAVAILABLE_REASON,
    arm: "R+IR+Graph",
    pass: false,
  });
  // Even a fabricated "measured" arm cannot turn the recheck into a pass.
  const forged = { ...arm, wiring: "wired", status: "measured", pass: true };
  assert.equal(summarizeGraphArm(forged).pass, false);
  assert.equal(summarizeGraphArm(forged).status, "hold");
  assert.equal(summarizeGraphArm(undefined).pass, false);
});

test("a request to measure the R+IR+Graph arm is refused while it is not wired", () => {
  assert.doesNotThrow(() => assertGraphArmRequestable());
  assert.doesNotThrow(() => assertGraphArmRequestable(GRAPH_ARM_WIRING));
  for (const requested of ["wired", "measure", "R+IR+Graph"])
    assert.throws(() => assertGraphArmRequestable(requested), /\[precheck\]/);
});

test("the frozen 24 queries take no Graph seed and the retrieval scope stays not Graph", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const contract = await loadContract(root);
  const policy = await loadGraphSeedPolicy(root, contract);
  assert.equal(policy.manualSeed, "none");
  assert.equal(policy.expectedGraphContribution, 0);
  assert.equal(policy.graphStatus, "not-requested");
  assert.match(policy.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(contract.manifest.scope, /\bnot Graph\b/);
  for (const query of contract.queries)
    assert.equal(graphSeedForExistingQuery(policy, query), null);
  assert.throws(
    () =>
      graphSeedForExistingQuery(
        { ...policy, manualSeed: "case" },
        contract.queries[0],
      ),
    /no Graph seed/,
  );
  await assert.rejects(
    loadGraphSeedPolicy(root, {
      ...contract,
      manifest: { ...contract.manifest, scope: "Graph" },
    }),
    /scope differs/,
  );
});

const H40 = (c) => c.repeat(40);
const H64 = (c) => c.repeat(64);

function productReceipt(overrides = {}) {
  return {
    schemaVersion: "nir1-standard-build/1",
    status: "passed",
    standardBuild: true,
    sourceUnchanged: true,
    candidate: {
      worktreeClean: true,
      resolvedBaseSha: H40("a"),
      resolvedHeadSha: H40("b"),
      resolvedHeadTreeSha: H40("c"),
      currentHeadSha: H40("b"),
    },
    artifacts: { "electron/native/grimodex-node/grimodex-node.node": H64("d") },
    ...overrides,
  };
}

function evalReceipt(overrides = {}) {
  return {
    schemaVersion: "nir1-graph-eval-build/1",
    status: "passed",
    standardBuild: false,
    evaluationBuild: true,
    sourceUnchanged: true,
    candidate: productReceipt().candidate,
    features: ["nir1-graph-eval"],
    capabilities: { nir1GraphEval: true },
    artifacts: {
      ".artifacts/cp4/eval-build/grimodex-node.node": H64("e"),
      ".artifacts/cp4/eval-build/nir1-c-query-worker": H64("f"),
    },
    worker: {
      path: ".artifacts/cp4/eval-build/nir1-c-query-worker",
      sha256: H64("f"),
    },
    ...overrides,
  };
}

function prepFacts(overrides = {}) {
  return {
    commit: H40("9"),
    candidateHead: H40("b"),
    ancestorOfCandidateHead: true,
    remoteRefs: ["refs/remotes/origin/master"],
    freezeRecordSha256AtCommit: H64("1"),
    freezeRecordSha256AtHead: H64("1"),
    ...overrides,
  };
}

const SEED_NONE = { manualSeed: "none" };
const FROZEN = "evals/nir1-graph/g02-directed-relation.v1.json";
const DEV = "scripts/quality/nir1-graph-eval/dev-fixtures/dev-g02.v1.json";

test("P-1: the existing queries' Graph arm is wired on the product receipt, not-requested and equal to R+IR", () => {
  const admission = assertGraphArmRequestable(GRAPH_ARM_WIRED, {
    scope: GRAPH_ARM_SCOPES.existing,
    buildReceipt: productReceipt(),
    seedPolicy: SEED_NONE,
  });
  assert.equal(admission.wiring, GRAPH_ARM_WIRED);
  assert.equal(admission.receiptKind, "product");
  assert.equal(admission.expectedGraphContribution, 0);
  const arm = describeGraphArm({ seedPolicy: SEED_NONE, admission });
  assert.equal(arm.status, "not-requested");
  assert.equal(arm.expectedGraphContribution, 0);
  assert.equal(arm.pass, false);
  const equal = summarizeGraphArm(arm, [{ equal: true, violations: [] }]);
  assert.equal(equal.status, "equal-to-hybrid");
  assert.equal(equal.equalsHybrid, true);
  assert.equal(equal.pass, false);
  const differs = summarizeGraphArm(arm, [
    { equal: true, violations: [] },
    { equal: false, violations: ["forbidden-contribution:seed"] },
  ]);
  assert.equal(differs.status, "hold");
  assert.deepEqual(differs.violations, ["forbidden-contribution:seed"]);
  // Without comparisons a wired arm is still not a result.
  assert.equal(summarizeGraphArm(arm).status, "hold");
});

test("P-1 / N-3: the existing queries refuse a missing, unclean or evaluation receipt and a seed", () => {
  const request = (overrides) =>
    assertGraphArmRequestable(GRAPH_ARM_WIRED, {
      scope: GRAPH_ARM_SCOPES.existing,
      buildReceipt: productReceipt(),
      seedPolicy: SEED_NONE,
      ...overrides,
    });
  assert.throws(
    () => assertGraphArmRequestable(GRAPH_ARM_WIRED),
    /\[precheck\].*without a build receipt/,
  );
  assert.throws(() => request({ buildReceipt: undefined }), /\[precheck\]/);
  assert.throws(
    () => request({ buildReceipt: evalReceipt() }),
    /product build, not the evaluation build/,
  );
  assert.throws(
    () =>
      request({
        buildReceipt: productReceipt({
          candidate: { ...productReceipt().candidate, worktreeClean: false },
        }),
      }),
    /not a clean passed build/,
  );
  assert.throws(
    () => request({ buildReceipt: productReceipt({ status: "failed" }) }),
    /\[precheck\]/,
  );
  assert.throws(
    () => request({ seedPolicy: { manualSeed: "case" } }),
    /no Graph seed/,
  );
  assert.throws(() => request({ scope: "something-else" }), /unknown/);
});

test("N-3: a G-case Graph arm refuses the product receipt and a malformed evaluation receipt", () => {
  const request = (buildReceipt) =>
    assertGraphArmRequestable(GRAPH_ARM_WIRED, {
      scope: GRAPH_ARM_SCOPES.graphCase,
      buildReceipt,
      fixturePaths: [DEV],
    });
  assert.equal(request(evalReceipt()).fixtureClass, "dev");
  assert.throws(
    () => request(productReceipt()),
    /cannot run on the product build/,
  );
  assert.throws(
    () => request(evalReceipt({ capabilities: { nir1GraphEval: false } })),
    /capability/,
  );
  assert.throws(() => request(evalReceipt({ features: [] })), /feature/);
  assert.throws(
    () =>
      request(
        evalReceipt({
          artifacts: {
            ...evalReceipt().artifacts,
            "electron/native/grimodex-node/grimodex-node.node": H64("e"),
          },
        }),
      ),
    /default addon path/,
  );
  assert.throws(
    () =>
      request(
        evalReceipt({
          artifacts: {
            "dist/grimodex-node.node": H64("e"),
            ".artifacts/cp4/eval-build/nir1-c-query-worker": H64("f"),
          },
        }),
      ),
    /single artifact under/,
  );
  assert.throws(
    () =>
      request(
        evalReceipt({
          worker: {
            path: ".artifacts/cp4/other/nir1-c-query-worker",
            sha256: H64("f"),
          },
        }),
      ),
    /fixed name beside/,
  );
  assert.throws(
    () =>
      request(
        evalReceipt({
          candidate: {
            ...productReceipt().candidate,
            currentHeadSha: H40("0"),
          },
        }),
      ),
    /not a clean passed evaluation build/,
  );
});

test("N-1: a frozen fixture needs the pre-observation commit as a remote ancestor with the same freeze record", () => {
  const request = (observationPrep, fixturePaths = [FROZEN]) =>
    assertGraphArmRequestable(GRAPH_ARM_WIRED, {
      scope: GRAPH_ARM_SCOPES.graphCase,
      buildReceipt: evalReceipt(),
      fixturePaths,
      observationPrep,
    });
  const admitted = request(prepFacts());
  assert.equal(admitted.fixtureClass, "frozen");
  assert.equal(admitted.observationPrepCommit, H40("9"));
  assert.throws(() => request(undefined), /\[precheck\].*not given/);
  assert.throws(
    () => request(prepFacts({ ancestorOfCandidateHead: false })),
    /not an ancestor/,
  );
  assert.throws(
    () => request(prepFacts({ remoteRefs: [] })),
    /remote-tracking ref/,
  );
  assert.throws(
    () => request(prepFacts({ freezeRecordSha256AtHead: H64("2") })),
    /freeze record differs/,
  );
  assert.throws(
    () => request(prepFacts({ freezeRecordSha256AtCommit: null })),
    /freeze record differs/,
  );
  assert.throws(
    () => request(prepFacts({ candidateHead: H40("8") })),
    /another candidate head/,
  );
  assert.throws(() => request(prepFacts({ commit: "abc" })), /40-hex/);
  // Mixing a dev fixture does not lift the frozen-path rule.
  assert.throws(
    () => request(undefined, [DEV, "evals/nir1-g01/fixture.v1.json"]),
    /not given/,
  );
  // Dev fixtures alone need no pre-observation commit.
  assert.equal(request(undefined, [DEV]).fixtureClass, "dev");
});

test("N-16: Graph input paths are allowlisted by fixture class", () => {
  assert.equal(classifyGraphFixturePath(FROZEN), "frozen");
  assert.equal(
    classifyGraphFixturePath("evals/nir1-g01/fixture.v1.json"),
    "frozen",
  );
  assert.equal(classifyGraphFixturePath(DEV), "dev");
  for (const bad of [
    "/abs/evals/nir1-graph/g02.json",
    "scripts/quality/nir1-graph-eval/dev-fixtures/../../../evals/nir1-graph/g02-directed-relation.v1.json",
    "evals/nir1-retrieval/corpus.json",
    "scripts/quality/nir1-graph-eval/dev-fixtures/readme.md",
    "",
  ])
    assert.throws(() => classifyGraphFixturePath(bad), /\[precheck\]/, bad);
  assert.throws(
    () =>
      assertGraphArmRequestable(GRAPH_ARM_WIRED, {
        scope: GRAPH_ARM_SCOPES.graphCase,
        buildReceipt: evalReceipt(),
        fixturePaths: [],
      }),
    /names no fixture path/,
  );
});
