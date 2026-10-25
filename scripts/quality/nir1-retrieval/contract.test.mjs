import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  FROZEN_FIXTURE_SHA256,
  G01_FIXTURE,
  GRAPH_CASE_FREEZE,
  K62_FREEZE,
  OBSERVATION_PREP_RECORD_PATH,
  OBSERVATION_PREP_RECORD_SCHEMA,
} from "../nir1-graph-eval/constants.mjs";
import {
  H40,
  H64,
  candidate,
  evalReceipt,
  productReceipt,
} from "../nir1-graph-eval/test-support.mjs";
import {
  GRAPH_ARM_SCOPES,
  GRAPH_ARM_UNAVAILABLE_REASON,
  GRAPH_ARM_WIRED,
  GRAPH_ARM_WIRING,
  RETRIEVAL_ARMS,
  assertFixtureReadAllowed,
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

const SEED_NONE = { manualSeed: "none" };
const FROZEN = "evals/nir1-graph/g02-directed-relation.v1.json";
const DEV = "scripts/quality/nir1-graph-eval/dev-fixtures/dev-g02.v1.json";
const frozenFixture = { path: FROZEN, sha256: FROZEN_FIXTURE_SHA256[FROZEN] };
const devFixture = { path: DEV, sha256: H64("d") };

function prepRecord(overrides = {}) {
  return {
    schemaVersion: OBSERVATION_PREP_RECORD_SCHEMA,
    graphRuntimeObservedBeforeFreeze: false,
    k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
    graphCaseFreeze: { ...GRAPH_CASE_FREEZE },
    g01Fixture: { path: G01_FIXTURE.path, sha256: G01_FIXTURE.sha256 },
    boundFiles: { "evals/nir1-graph/trace-editing.v1.json": H64("7") },
    ...overrides,
  };
}

function prepFacts(overrides = {}) {
  return {
    recordPath: OBSERVATION_PREP_RECORD_PATH,
    commit: H40("9"),
    candidateHead: H40("b"),
    ancestorOfCandidateHead: true,
    remoteRef: "refs/remotes/origin/master",
    onRemoteRef: true,
    recordIntroducedByCommit: true,
    recordSha256AtCommit: H64("1"),
    recordSha256AtHead: H64("1"),
    record: prepRecord(),
    headFileSha256: {
      [GRAPH_CASE_FREEZE.path]: GRAPH_CASE_FREEZE.sha256,
      [G01_FIXTURE.path]: G01_FIXTURE.sha256,
      "evals/nir1-graph/trace-editing.v1.json": H64("7"),
    },
    ...overrides,
  };
}

function graphCase(overrides = {}) {
  return assertGraphArmRequestable(GRAPH_ARM_WIRED, {
    scope: GRAPH_ARM_SCOPES.graphCase,
    buildReceipt: evalReceipt(),
    productReceipt: productReceipt(),
    fixtures: [devFixture],
    ...overrides,
  });
}

test("P-1: the existing queries' Graph arm is wired on the product receipt, not-requested and equal to R+IR", () => {
  const admission = assertGraphArmRequestable(GRAPH_ARM_WIRED, {
    scope: GRAPH_ARM_SCOPES.existing,
    buildReceipt: productReceipt(),
    seedPolicy: SEED_NONE,
  });
  assert.equal(admission.receiptKind, "product");
  assert.equal(admission.expectedGraphContribution, 0);
  const arm = describeGraphArm({ seedPolicy: SEED_NONE, admission });
  assert.equal(arm.status, "not-requested");
  assert.equal(arm.pass, false);
  const ids = ["q1", "q2"];
  const equal = summarizeGraphArm(
    arm,
    [
      { queryId: "q1", equal: true },
      { queryId: "q2", equal: true },
    ],
    { queryIds: ids },
  );
  assert.equal(equal.status, "equal-to-hybrid");
  assert.equal(equal.pass, false);
  const differs = summarizeGraphArm(
    arm,
    [
      { queryId: "q1", equal: true },
      {
        queryId: "q2",
        equal: false,
        violations: ["forbidden-contribution:seed"],
      },
    ],
    { queryIds: ids },
  );
  assert.equal(differs.status, "hold");
  assert.deepEqual(differs.violations, ["forbidden-contribution:seed"]);
  assert.equal(summarizeGraphArm(arm).status, "hold");
});

test("P2-11: the 24 queries' equality must cover every query and no other", () => {
  const arm = describeGraphArm({
    admission: assertGraphArmRequestable(GRAPH_ARM_WIRED, {
      scope: GRAPH_ARM_SCOPES.existing,
      buildReceipt: productReceipt(),
      seedPolicy: SEED_NONE,
    }),
  });
  const ids = ["q1", "q2"];
  for (const [comparisons, queryIds] of [
    [[{ queryId: "q1", equal: true }], ids],
    [
      [
        { queryId: "q1", equal: true },
        { queryId: "q2", equal: true },
        { queryId: "q3", equal: true },
      ],
      ids,
    ],
    [
      [
        { queryId: "q1", equal: true },
        { queryId: "q2", equal: true },
      ],
      undefined,
    ],
    [
      [
        { queryId: "q1", equal: true },
        { queryId: "q2", equal: true },
      ],
      ["q1", "q1", "q2"],
    ],
  ]) {
    const result = summarizeGraphArm(arm, comparisons, { queryIds });
    assert.equal(result.status, "hold");
    assert.equal(result.reason, "comparisons-do-not-cover-every-query");
  }
});

test("P-1 / N-3 / P3: the existing queries refuse a missing, unclean or evaluation receipt and a seed", () => {
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
  // The producer's full check: commands and the exact artifact set.
  assert.throws(
    () => request({ buildReceipt: productReceipt({ commands: [] }) }),
    /not a clean passed build/,
  );
  const artifacts = { ...productReceipt().artifacts };
  delete artifacts["dist/index.html"];
  assert.throws(
    () => request({ buildReceipt: productReceipt({ artifacts }) }),
    /not a clean passed build/,
  );
  assert.throws(
    () => request({ seedPolicy: { manualSeed: "case" } }),
    /no Graph seed/,
  );
  assert.throws(() => request({ scope: "something-else" }), /unknown/);
});

test("N-3 / P1-2: a G-case Graph arm needs a strict evaluation receipt", () => {
  const withEval = (buildReceipt) => () => graphCase({ buildReceipt });
  assert.equal(graphCase().fixtureClass, "dev");
  assert.throws(withEval(productReceipt()), /cannot run on the product build/);
  assert.throws(
    withEval(evalReceipt({ capabilities: { nir1GraphEval: false } })),
    /capability/,
  );
  assert.throws(withEval(evalReceipt({ features: [] })), /feature/);
  assert.throws(
    withEval(evalReceipt({ features: "xx-nir1-graph-eval-yy" })),
    /feature/,
  );
  assert.throws(
    withEval(evalReceipt({ features: ["xx-nir1-graph-eval-yy"] })),
    /feature/,
  );
  const escape =
    ".artifacts/cp4/eval-build/../../../electron/native/grimodex-node/grimodex-node.node";
  const escapeWorker =
    ".artifacts/cp4/eval-build/../../../electron/native/grimodex-node/nir1-c-query-worker";
  assert.throws(
    withEval(
      evalReceipt({
        artifacts: { [escape]: H64("e"), [escapeWorker]: H64("f") },
        worker: { path: escapeWorker, sha256: H64("f") },
      }),
    ),
    /clean repo-relative path/,
  );
  for (const bad of [
    ".artifacts/cp4/eval-build//grimodex-node.node",
    ".artifacts/cp4/eval-build/./grimodex-node.node",
    "/abs/.artifacts/cp4/eval-build/x.node",
    ".artifacts\\cp4\\eval-build\\x.node",
  ])
    assert.throws(
      withEval(
        evalReceipt({
          artifacts: {
            [bad]: H64("e"),
            ".artifacts/cp4/eval-build/nir1-c-query-worker": H64("f"),
          },
        }),
      ),
      /\[precheck\]/,
      bad,
    );
  assert.throws(
    withEval(
      evalReceipt({
        artifacts: {
          ...evalReceipt().artifacts,
          "electron/native/grimodex-node/grimodex-node.node": H64("e"),
        },
      }),
    ),
    /must be inside/,
  );
  assert.throws(
    withEval(
      evalReceipt({
        artifacts: {
          "dist/grimodex-node.node": H64("e"),
          ".artifacts/cp4/eval-build/nir1-c-query-worker": H64("f"),
        },
      }),
    ),
    /must be inside/,
  );
  for (const workerPath of [
    ".artifacts/cp4/eval-build/nir1-c-query-workerx",
    ".artifacts/cp4/eval-build/sub/nir1-c-query-worker",
    ".artifacts/cp4/eval-build/other-worker",
  ])
    assert.throws(
      withEval(
        evalReceipt({
          artifacts: {
            ".artifacts/cp4/eval-build/grimodex-node.node": H64("e"),
            [workerPath]: H64("f"),
          },
          worker: { path: workerPath, sha256: H64("f") },
        }),
      ),
      /fixed name beside/,
      workerPath,
    );
  assert.throws(
    withEval(
      evalReceipt({
        worker: {
          path: ".artifacts/cp4/eval-build/nir1-c-query-worker",
          sha256: H64("0"),
        },
      }),
    ),
    /fixed name beside/,
  );
  assert.throws(
    withEval(
      evalReceipt({
        candidate: { ...productReceipt().candidate, currentHeadSha: H40("0") },
      }),
    ),
    /not a clean passed evaluation build/,
  );
});

test("P2-10: the evaluation and product receipts must be the same candidate", () => {
  assert.throws(() => graphCase({ productReceipt: undefined }), /\[precheck\]/);
  assert.throws(
    () =>
      graphCase({
        productReceipt: productReceipt({ candidate: candidate(H40("e")) }),
      }),
    /different candidates/,
  );
  assert.throws(
    () =>
      graphCase({
        productReceipt: productReceipt({
          candidate: candidate(H40("b"), H40("f")),
        }),
      }),
    /different candidates/,
  );
});

test("N-1 / P1-1: a frozen fixture needs the introducing, remote, content-checked pre-observation commit", () => {
  const request = (observationPrep, fixtures = [frozenFixture]) =>
    graphCase({ fixtures, observationPrep });
  const admitted = request(prepFacts());
  assert.equal(admitted.fixtureClass, "frozen");
  assert.equal(admitted.observationPrepCommit, H40("9"));
  const cases = [
    [undefined, /not given/],
    [
      prepFacts({ recordPath: GRAPH_CASE_FREEZE.path }),
      /pre-observation record must be/,
    ],
    [prepFacts({ ancestorOfCandidateHead: false }), /not an ancestor/],
    [
      prepFacts({ remoteRef: "refs/remotes/fork/feature" }),
      /not on refs\/remotes\/origin\/master/,
    ],
    [prepFacts({ onRemoteRef: false }), /not on refs\/remotes\/origin\/master/],
    [prepFacts({ recordIntroducedByCommit: false }), /did not introduce/],
    [prepFacts({ recordSha256AtHead: H64("2") }), /freeze record differs/],
    [prepFacts({ recordSha256AtCommit: null }), /freeze record differs/],
    [prepFacts({ candidateHead: H40("8") }), /another candidate head/],
    [prepFacts({ commit: "abc" }), /40-hex/],
    [prepFacts({ record: null }), /schemaVersion/],
    [
      prepFacts({
        record: prepRecord({ graphRuntimeObservedBeforeFreeze: true }),
      }),
      /graphRuntimeObservedBeforeFreeze/,
    ],
    [
      prepFacts({
        record: prepRecord({
          graphCaseFreeze: { path: GRAPH_CASE_FREEZE.path, sha256: H64("0") },
        }),
      }),
      /graphCaseFreeze/,
    ],
    [
      prepFacts({
        record: prepRecord({
          g01Fixture: { path: G01_FIXTURE.path, sha256: H64("0") },
        }),
      }),
      /g01Fixture/,
    ],
    [
      prepFacts({
        record: prepRecord({
          k62: { freezeCommit: H40("0"), sha256: K62_FREEZE.sha256 },
        }),
      }),
      /k62/,
    ],
    [prepFacts({ record: prepRecord({ boundFiles: {} }) }), /boundFiles/],
    [
      prepFacts({
        headFileSha256: {
          ...prepFacts().headFileSha256,
          "evals/nir1-graph/trace-editing.v1.json": H64("8"),
        },
      }),
      /differs from the record/,
    ],
    [
      prepFacts({
        headFileSha256: {
          ...prepFacts().headFileSha256,
          [GRAPH_CASE_FREEZE.path]: H64("8"),
        },
      }),
      /differs from the record/,
    ],
    [
      prepFacts({ record: prepRecord({ boundFiles: { "../x": H64("7") } }) }),
      /clean repo-relative/,
    ],
  ];
  for (const [facts, message] of cases)
    assert.throws(() => request(facts), message, String(message));
  // Mixing a dev fixture does not lift the frozen rule; dev alone needs none.
  assert.throws(
    () => request(undefined, [devFixture, frozenFixture]),
    /not given/,
  );
  assert.equal(request(undefined, [devFixture]).fixtureClass, "dev");
});

test("N-16 / P1-3: the admission lists the fixtures it allows by path and digest", () => {
  assert.equal(classifyGraphFixturePath(FROZEN), "frozen");
  assert.equal(classifyGraphFixturePath(DEV), "dev");
  for (const bad of [
    "/abs/evals/nir1-graph/g02.json",
    "scripts/quality/nir1-graph-eval/dev-fixtures/../../../evals/nir1-graph/g02-directed-relation.v1.json",
    "scripts/quality/nir1-graph-eval/dev-fixtures//x.json",
    "evals/nir1-retrieval/corpus.json",
    "scripts/quality/nir1-graph-eval/dev-fixtures/readme.md",
    "",
  ])
    assert.throws(() => classifyGraphFixturePath(bad), /\[precheck\]/, bad);
  assert.throws(() => graphCase({ fixtures: [] }), /names no fixture/);
  assert.throws(
    () =>
      graphCase({
        fixtures: [{ path: FROZEN, sha256: H64("0") }],
        observationPrep: prepFacts(),
      }),
    /frozen digest/,
  );
  assert.throws(
    () =>
      graphCase({
        fixtures: [{ path: DEV, sha256: FROZEN_FIXTURE_SHA256[FROZEN] }],
      }),
    /copy of frozen material/,
  );
  assert.throws(
    () =>
      graphCase({
        fixtures: [{ path: DEV, sha256: GRAPH_CASE_FREEZE.sha256 }],
      }),
    /copy of frozen material/,
  );
  assert.throws(
    () => graphCase({ fixtures: [devFixture, devFixture] }),
    /duplicate/,
  );
  assert.deepEqual(graphCase().allowedFixtures, [
    { ...devFixture, kind: "dev" },
  ]);
});

test("P1-3: every fixture read is checked against the admission, symlinks and digest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cp4-read-"));
  try {
    const bytes = Buffer.from('{"caseId":"DEV"}\n');
    const digest = createHash("sha256").update(bytes).digest("hex");
    await mkdir(
      path.join(root, "scripts/quality/nir1-graph-eval/dev-fixtures"),
      { recursive: true },
    );
    await writeFile(path.join(root, DEV), bytes);
    const admission = graphCase({ fixtures: [{ path: DEV, sha256: digest }] });
    assert.deepEqual(
      assertFixtureReadAllowed(admission, { root, path: DEV }),
      bytes,
    );
    const other = "scripts/quality/nir1-graph-eval/dev-fixtures/other.json";
    await writeFile(path.join(root, other), bytes);
    assert.throws(
      () => assertFixtureReadAllowed(admission, { root, path: other }),
      /not a fixture this admission allowed/,
    );
    assert.throws(
      () => assertFixtureReadAllowed(admission, { root, path: FROZEN }),
      /not a fixture this admission allowed/,
    );
    assert.throws(
      () =>
        assertFixtureReadAllowed(
          { ...admission, wiring: GRAPH_ARM_WIRING },
          { root, path: DEV },
        ),
      /wired G-case admission/,
    );
    await writeFile(path.join(root, DEV), '{"changed":true}\n');
    assert.throws(
      () => assertFixtureReadAllowed(admission, { root, path: DEV }),
      /differ from the admitted digest/,
    );
    await rm(path.join(root, DEV));
    await symlink(path.join(root, other), path.join(root, DEV));
    assert.throws(
      () => assertFixtureReadAllowed(admission, { root, path: DEV }),
      /not a symlink/,
    );
    // A symlinked directory component is refused too.
    const linkedRoot = await mkdtemp(path.join(tmpdir(), "cp4-read-link-"));
    try {
      await mkdir(path.join(linkedRoot, "scripts/quality/nir1-graph-eval"), {
        recursive: true,
      });
      await symlink(
        path.join(root, "scripts/quality/nir1-graph-eval/dev-fixtures"),
        path.join(linkedRoot, "scripts/quality/nir1-graph-eval/dev-fixtures"),
      );
      await rm(path.join(root, DEV));
      await writeFile(path.join(root, DEV), bytes);
      assert.throws(
        () =>
          assertFixtureReadAllowed(admission, { root: linkedRoot, path: DEV }),
        /through a symlink/,
      );
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
