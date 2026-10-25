import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import { loadRecoveryAcceptance } from "./acceptance-policy.mjs";
import { validateStandardBuildSuccessReceipt } from "./standard-build-receipt.mjs";
import {
  FROZEN_FIXTURE_SHA256,
  FROZEN_MATERIAL_SHA256,
  G01_FIXTURE,
  GRAPH_CASE_FREEZE,
  K62_FREEZE,
  OBSERVATION_PREP_RECORD_PATH,
  OBSERVATION_PREP_RECORD_SCHEMA,
  OBSERVATION_PREP_REMOTE_REF,
} from "../nir1-graph-eval/constants.mjs";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateContract(manifest, corpus) {
  assert.equal(manifest.schemaVersion, "nir1-retrieval/1");
  assert.equal(corpus.schemaVersion, "nir1-retrieval-corpus/1");
  const queries = [];
  for (const language of ["ja", "en"]) {
    const section = corpus.languages[language];
    assert.ok(section.scenes.length > manifest.rawRoute.maxScenes);
    const ids = new Set(section.scenes.map((scene) => scene.id));
    assert.equal(ids.size, section.scenes.length, "duplicate scene identity");
    for (const query of section.queries) {
      assert.ok(query.currentBody.length > 0);
      assert.ok(!ids.has(query.currentSceneId));
      assert.deepEqual(new Set(query.eligibleSceneIds), ids);
      assert.deepEqual(new Set(Object.keys(query.relevanceGrades)), ids);
      assert.ok(
        Object.values(query.relevanceGrades).every(
          (g) => Number.isInteger(g) && g >= 0 && g <= 3,
        ),
      );
      assert.ok(Object.values(query.relevanceGrades).some((g) => g > 0));
      for (const scene of section.scenes)
        assert.ok(scene.order < query.currentOrder);
      for (const passage of query.requiredRawPassages) {
        const scene = section.scenes.find(
          (item) => item.id === passage.sceneId,
        );
        assert.ok(
          scene?.body.includes(passage.text),
          "required passage absent from canonical source",
        );
        assert.ok(query.relevanceGrades[passage.sceneId] > 0);
      }
      assert.equal(
        query.requiredRawPassages.length > 0,
        query.task === "raw-prose",
      );
      queries.push({ ...query, language });
    }
    assert.equal(
      section.queries.length,
      manifest.quality.languageCounts[language],
    );
    assert.equal(
      section.queries.filter((q) => q.task === "semantic").length,
      6,
    );
    assert.equal(
      section.queries.filter((q) => q.task === "raw-prose").length,
      6,
    );
    const model = manifest.models[language];
    assert.match(model.artifactSha256, /^[a-f0-9]{64}$/);
    assert.match(model.tokenizerSha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(queries.length, 24);
  assert.equal(new Set(queries.map((q) => q.id)).size, queries.length);
  assert.equal(
    corpus.forbiddenCases.length,
    manifest.quality.forbiddenCaseCount,
  );
  assert.equal(
    new Set(corpus.forbiddenCases.map((q) => q.id)).size,
    corpus.forbiddenCases.length,
  );
  for (const forbidden of corpus.forbiddenCases) {
    assert.ok(queries.some((q) => q.id === forbidden.baseQueryId));
    assert.equal(forbidden.expectedIrContributions, 0);
    if (forbidden.pool === "target-only-ir") {
      assert.equal(forbidden.expectedRaw, "exact-raw");
      assert.ok(forbidden.otherScenes.includes("Raw-only"));
    } else {
      assert.equal(forbidden.pool, "mixed-allowed-and-forbidden-ir");
      assert.ok(forbidden.allowedSceneIds.length > 0);
      assert.ok(forbidden.mustMatchAllowedOnlyControl.includes("slots"));
    }
  }
  assert.equal(
    corpus.forbiddenCases.filter((q) => q.pool === "target-only-ir").length,
    8,
  );
  assert.ok(
    corpus.forbiddenCases.filter(
      (q) => q.pool === "mixed-allowed-and-forbidden-ir",
    ).length >= 2,
  );
  assert.ok(
    queries.some(
      (q) =>
        Object.values(q.relevanceGrades).includes(1) &&
        Object.values(q.relevanceGrades).includes(2),
    ),
  );
  assert.equal(
    queries.filter((q) => q.challenge === "nonlexical-paraphrase").length,
    4,
  );
  assert.ok(queries.some((q) => q.irBenefitExpected));
  assert.equal(manifest.performance.warm.callsPerArm, queries.length * 30);
  assert.equal(manifest.performance.warm.measuredRunsPerQueryPerArm, 30);
  assert.equal(manifest.performance.warm.warmupsPerQueryPerArm, 5);
  assert.equal(
    manifest.evidenceBoundary.artificialVectorsAsQualityProof,
    false,
  );
  assert.equal(
    manifest.evidenceBoundary.existingLockedRerankerHoldoutUsed,
    false,
  );
  assert.equal(
    manifest.evidenceBoundary.sendFixtureManuscriptOrCredentialsExternally,
    false,
  );
  return queries;
}

export function nearestRank(values, percentile) {
  assert.ok(values.length > 0 && percentile > 0 && percentile <= 1);
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
  return [...values].sort((a, b) => a - b)[
    Math.ceil(percentile * values.length) - 1
  ];
}

export function scoreQuery(query, results, k = 8) {
  assert.ok(results.length <= k, "result exceeds the production scene cap");
  const ids = results.map((row) => row.sceneId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    "duplicate scene result cannot inflate quality",
  );
  const eligible = new Set(query.eligibleSceneIds);
  assert.ok(
    ids.every((id) => eligible.has(id)),
    "unknown or ineligible scene result",
  );
  const relevant = Object.entries(query.relevanceGrades).filter(
    ([id, grade]) => eligible.has(id) && grade > 0,
  );
  assert.ok(
    relevant.length > 0,
    "zero-positive safety cases must not enter macro quality",
  );
  const dcg = (grades) =>
    grades.reduce(
      (sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2),
      0,
    );
  const ideal = dcg(
    relevant
      .map(([, grade]) => grade)
      .sort((a, b) => b - a)
      .slice(0, k),
  );
  return {
    recallAt8:
      ids.filter((id) => query.relevanceGrades[id] > 0).length /
      relevant.length,
    ndcgAt8: dcg(ids.map((id) => query.relevanceGrades[id])) / ideal,
    top1SceneId: ids[0] ?? null,
    relevantRank:
      ids.findIndex((id) => query.relevanceGrades[id] > 0) + 1 || null,
    requiredRawPassagesRetained: query.requiredRawPassages.every((passage) =>
      results
        .slice(0, k)
        .some(
          (row) =>
            row.sceneId === passage.sceneId &&
            row.chunkText.includes(passage.text),
        ),
    ),
  };
}

export function summarizeQuality(cases) {
  assert.ok(cases.length > 0);
  const groups = {
    all: cases,
    semantic: cases.filter((row) => row.task === "semantic"),
    "raw-prose": cases.filter((row) => row.task === "raw-prose"),
    ja: cases.filter((row) => row.language === "ja"),
    en: cases.filter((row) => row.language === "en"),
  };
  return Object.fromEntries(
    Object.entries(groups).map(([name, rows]) => [
      name,
      {
        count: rows.length,
        recallAt8: rows.length
          ? rows.reduce((sum, row) => sum + row.metrics.recallAt8, 0) /
            rows.length
          : null,
        ndcgAt8: rows.length
          ? rows.reduce((sum, row) => sum + row.metrics.ndcgAt8, 0) /
            rows.length
          : null,
      },
    ]),
  );
}

export function summarizeWarm(calls, expectedCalls = 720) {
  const completedStates = new Set(["ok", "completed-safe-fallback"]);
  const failed = calls.filter((call) => !completedStates.has(call.status));
  const finite = calls.filter(
    (call) => Number.isFinite(call.durationMs) && call.durationMs >= 0,
  );
  const complete =
    calls.length === expectedCalls &&
    failed.length === 0 &&
    finite.length === expectedCalls;
  const finiteP95Ms = finite.length
    ? nearestRank(
        finite.map((call) => call.durationMs),
        0.95,
      )
    : null;
  return {
    status: complete ? "complete" : "blocked",
    scheduledCount: calls.length,
    expectedCount: expectedCalls,
    failedCount: failed.length,
    finiteP95Ms,
    B: complete ? finiteP95Ms : null,
    D: complete ? Math.min(100, 0.2 * finiteP95Ms) : null,
  };
}

export function validateWarmPopulation(
  calls,
  queryIds,
  repeats = 30,
  arm = "raw",
) {
  assert.equal(
    new Set(queryIds).size,
    24,
    "expected exactly 24 distinct frozen queries",
  );
  assert.equal(
    calls.length,
    queryIds.length * repeats,
    "wrong total warm population",
  );
  const expected = queryIds.flatMap((queryId) =>
    Array.from(
      { length: repeats },
      (_, repeat) => `${queryId}:${repeat}:${arm}`,
    ),
  );
  const actual = calls.map((call) => {
    assert.equal(call.phase, "measured", "warmup entered measured denominator");
    return `${call.queryId}:${call.repeat}:${call.arm}`;
  });
  assert.deepEqual(
    actual,
    expected,
    "query/arm/repetition order differs from frozen balanced schedule",
  );
}

export function validateRawIpcTrace(calls) {
  assert.ok(
    calls.every((call) => call.completed && call.ok),
    "failed or unfinished Raw IPC was swallowed by fallback",
  );
  for (const command of ["db_execute", "semantic_search", "fts_search"]) {
    assert.equal(
      calls.filter((call) => call.command === command).length,
      1,
      `expected one production ${command} dispatch`,
    );
  }
}

// R+IR+Graph arm (C-product CP-0 scaffold, CP-4 admission). Without an
// admission the arm stays the not-wired scaffold: recorded as unavailable,
// no call scheduled, never a pass. `wired` is admitted only with build
// receipts (TASK CP-4 §15.2, §15.8): the existing 24 queries and P with the
// product standard-build receipt (no seed, Graph not-requested), and G-cases
// with the evaluation build receipt bound to the product receipt of the same
// candidate, where a frozen fixture further needs the pre-observation freeze
// record commit to be an ancestor of the candidate on origin/master. The
// admission lists the fixture paths and digests it allows; the runner reads
// every fixture through assertFixtureReadAllowed. Existing raw/hybrid
// measurement, gates and budgets are untouched by these helpers.
export const RETRIEVAL_ARMS = Object.freeze({
  raw: "R",
  hybrid: "R+IR",
  graph: "R+IR+Graph",
});
export const GRAPH_ARM_WIRING = "not-wired";
export const GRAPH_ARM_WIRED = "wired";
export const GRAPH_ARM_UNAVAILABLE_REASON = "graph-runtime-not-wired";
export const GRAPH_CASE_MANIFEST_PATH = "evals/nir1-graph/manifest.v1.json";
export const GRAPH_ARM_SCOPES = Object.freeze({
  existing: "existing-queries",
  graphCase: "graph-case",
});
export const PRODUCT_BUILD_RECEIPT_SCHEMA = "nir1-standard-build/1";
export const EVAL_BUILD_RECEIPT_SCHEMA = "nir1-graph-eval-build/1";
export const GRAPH_EVAL_FEATURE = "nir1-graph-eval";
export const EVAL_BUILD_OUTPUT_DIR = ".artifacts/cp4/eval-build";
export const PRODUCT_NATIVE_ARTIFACT =
  "electron/native/grimodex-node/grimodex-node.node";
export const FROZEN_GRAPH_FIXTURE_ROOTS = Object.freeze([
  "evals/nir1-graph/",
  "evals/nir1-g01/",
]);
export const DEV_GRAPH_FIXTURE_ROOT =
  "scripts/quality/nir1-graph-eval/dev-fixtures/";

const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

function precheck(message) {
  return new Error(`[precheck] ${message}`);
}

/** Repo-relative path with no empty, `.` or `..` segment, `\` or root. */
function assertCleanRelative(file, label) {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    file.startsWith("/") ||
    file.includes("\\") ||
    /^[A-Za-z]:/u.test(file) ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw precheck(`${label} must be a clean repo-relative path: ${file}`);
  return file;
}

/** `frozen` for CP-0 / G-01 fixtures, `dev` for synthetic dev fixtures. */
export function classifyGraphFixturePath(file) {
  assertCleanRelative(file, "Graph fixture path");
  if (FROZEN_GRAPH_FIXTURE_ROOTS.some((root) => file.startsWith(root)))
    return "frozen";
  if (file.startsWith(DEV_GRAPH_FIXTURE_ROOT) && file.endsWith(".json"))
    return "dev";
  throw precheck(
    `${file} is neither a frozen G-case fixture nor a dev fixture`,
  );
}

/** Passed product standard-build receipt (the producer's own check). */
export function assertProductBuildReceipt(receipt) {
  if (receipt?.schemaVersion !== PRODUCT_BUILD_RECEIPT_SCHEMA)
    throw precheck(
      `the Graph arm needs a ${PRODUCT_BUILD_RECEIPT_SCHEMA} receipt`,
    );
  try {
    validateStandardBuildSuccessReceipt(receipt, false);
  } catch (error) {
    throw precheck(
      `product standard-build receipt is not a clean passed build: ${error.message}`,
    );
  }
  return receipt;
}

function cleanCandidate(candidate) {
  return (
    candidate?.worktreeClean === true &&
    ["resolvedBaseSha", "resolvedHeadSha", "resolvedHeadTreeSha"].every(
      (field) => HEX40.test(candidate?.[field] ?? ""),
    ) &&
    candidate.currentHeadSha === candidate.resolvedHeadSha
  );
}

function assertInsideEvalDir(file) {
  assertCleanRelative(file, "evaluation artifact");
  if (!file.startsWith(`${EVAL_BUILD_OUTPUT_DIR}/`))
    throw precheck(
      `evaluation artifact ${file} must be inside ${EVAL_BUILD_OUTPUT_DIR}/`,
    );
  return file;
}

/**
 * Passed evaluation build receipt. Every artifact (one `.node` and its
 * C-query worker under the fixed name beside it) is inside
 * `.artifacts/cp4/eval-build/`, never the default addon path; the feature
 * set is an array holding exactly `nir1-graph-eval`; the `nir1GraphEval`
 * capability is true.
 */
export function assertEvalBuildReceipt(receipt) {
  if (receipt?.schemaVersion !== EVAL_BUILD_RECEIPT_SCHEMA)
    throw precheck(
      `the G-case Graph arm needs a ${EVAL_BUILD_RECEIPT_SCHEMA} receipt`,
    );
  if (
    receipt.status !== "passed" ||
    receipt.standardBuild !== false ||
    receipt.evaluationBuild !== true ||
    receipt.sourceUnchanged !== true ||
    !cleanCandidate(receipt.candidate)
  )
    throw precheck(
      "evaluation build receipt is not a clean passed evaluation build",
    );
  if (
    !Array.isArray(receipt.features) ||
    receipt.features.length !== 1 ||
    receipt.features[0] !== GRAPH_EVAL_FEATURE
  )
    throw precheck(
      `evaluation build feature set must be exactly ["${GRAPH_EVAL_FEATURE}"]`,
    );
  if (receipt.capabilities?.nir1GraphEval !== true)
    throw precheck("evaluation build lacks the nir1GraphEval capability");
  const artifacts = Object.keys(receipt.artifacts ?? {});
  for (const file of artifacts) {
    assertInsideEvalDir(file);
    if (!HEX64.test(receipt.artifacts[file]))
      throw precheck(`evaluation artifact ${file} lacks a sha256`);
  }
  const nodes = artifacts.filter((file) => file.endsWith(".node"));
  if (nodes.length !== 1)
    throw precheck(
      `evaluation .node must be the single addon under ${EVAL_BUILD_OUTPUT_DIR}/`,
    );
  const directory = nodes[0].slice(0, nodes[0].lastIndexOf("/"));
  const worker = receipt.worker;
  if (typeof worker?.path !== "string")
    throw precheck("evaluation worker path is missing");
  assertInsideEvalDir(worker.path);
  if (
    worker.path.slice(0, worker.path.lastIndexOf("/")) !== directory ||
    !/\/nir1-c-query-worker(\.exe)?$/u.test(worker.path) ||
    !HEX64.test(worker.sha256 ?? "") ||
    receipt.artifacts[worker.path] !== worker.sha256
  )
    throw precheck(
      "evaluation worker must be the fixed name beside the evaluation .node",
    );
  if (artifacts.length !== 2)
    throw precheck(
      "evaluation build artifacts are exactly the addon and its worker",
    );
  return receipt;
}

/** Shape of the pre-observation freeze record (S4); see OBSERVATION_PREP_RECORD_SCHEMA. */
export function observationPrepRecordErrors(record, headFileSha256) {
  const errors = [];
  if (record?.schemaVersion !== OBSERVATION_PREP_RECORD_SCHEMA)
    errors.push(`schemaVersion must be ${OBSERVATION_PREP_RECORD_SCHEMA}`);
  if (record?.graphRuntimeObservedBeforeFreeze !== false)
    errors.push("graphRuntimeObservedBeforeFreeze must be false");
  if (
    record?.k62?.freezeCommit !== K62_FREEZE.commit ||
    record?.k62?.sha256 !== K62_FREEZE.sha256
  )
    errors.push("k62 must name the K6/2 freeze commit and bytes");
  for (const [field, expected] of [
    ["graphCaseFreeze", GRAPH_CASE_FREEZE],
    ["g01Fixture", G01_FIXTURE],
  ])
    if (
      record?.[field]?.path !== expected.path ||
      record?.[field]?.sha256 !== expected.sha256
    )
      errors.push(`${field} must be ${expected.path} with its frozen sha256`);
  const bound = record?.boundFiles;
  if (!bound || typeof bound !== "object" || Object.keys(bound).length === 0)
    errors.push("boundFiles must list the files the record binds");
  const declared = {
    ...(bound ?? {}),
    [GRAPH_CASE_FREEZE.path]: GRAPH_CASE_FREEZE.sha256,
    [G01_FIXTURE.path]: G01_FIXTURE.sha256,
  };
  for (const [file, digest] of Object.entries(declared)) {
    try {
      assertCleanRelative(file, "bound file");
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (!HEX64.test(digest ?? "")) errors.push(`${file} needs a sha256`);
    else if (headFileSha256?.[file] !== digest)
      errors.push(`${file} at the candidate head differs from the record`);
  }
  return errors;
}

/**
 * N-1: a frozen G-case fixture may reach the Graph arm and the evaluation
 * `.node` only after the pre-observation freeze record (fixed path) was
 * introduced by a commit that is an ancestor of the measured candidate and
 * of origin/master, whose record bytes equal the head's, and whose content
 * binds the frozen digests that the head still has.
 */
export function assertObservationPrepAdmits(observationPrep, candidateHead) {
  const prep = observationPrep;
  if (!prep)
    throw precheck(
      "the pre-observation commit is not given for a frozen fixture",
    );
  if (prep.recordPath !== OBSERVATION_PREP_RECORD_PATH)
    throw precheck(
      `the pre-observation record must be ${OBSERVATION_PREP_RECORD_PATH}`,
    );
  if (!HEX40.test(prep.commit ?? ""))
    throw precheck("the pre-observation commit must be a 40-hex commit");
  if (prep.candidateHead !== candidateHead)
    throw precheck(
      "pre-observation facts were collected for another candidate head",
    );
  if (prep.ancestorOfCandidateHead !== true)
    throw precheck(
      "the pre-observation commit is not an ancestor of the candidate head",
    );
  if (
    prep.remoteRef !== OBSERVATION_PREP_REMOTE_REF ||
    prep.onRemoteRef !== true
  )
    throw precheck(
      `the pre-observation commit is not on ${OBSERVATION_PREP_REMOTE_REF}`,
    );
  if (prep.recordIntroducedByCommit !== true)
    throw precheck(
      "the pre-observation commit did not introduce the freeze record",
    );
  if (
    !HEX64.test(prep.recordSha256AtCommit ?? "") ||
    prep.recordSha256AtCommit !== prep.recordSha256AtHead
  )
    throw precheck(
      "the observation-prep freeze record differs from the pre-observation commit",
    );
  const errors = observationPrepRecordErrors(prep.record, prep.headFileSha256);
  if (errors.length > 0)
    throw precheck(
      `observation-prep freeze record invalid: ${errors.join("; ")}`,
    );
  return prep;
}

/** Declared seed policy for the frozen 24 queries: no seed, Graph contribution 0. */
export async function loadGraphSeedPolicy(root, contract) {
  const bytes = await readFile(`${root}/${GRAPH_CASE_MANIFEST_PATH}`);
  const policy = JSON.parse(bytes).existingRetrievalSeedPolicy;
  assert.ok(
    policy,
    "[precheck] Graph seed policy for existing queries is missing",
  );
  assert.equal(
    policy.manualSeed,
    "none",
    "[precheck] existing retrieval queries must not carry a Graph seed",
  );
  assert.equal(policy.graphStatus, "not-requested");
  assert.equal(policy.expectedGraphContribution, 0);
  assert.equal(policy.rPlusIrPlusGraphEqualsRPlusIr, true);
  assert.equal(policy.queryCount, 24);
  if (contract) {
    assert.equal(
      policy.retrievalManifestScope,
      contract.manifest.scope,
      "[precheck] retrieval manifest scope differs from the declared seed policy",
    );
    assert.equal(contract.queries.length, policy.queryCount);
  }
  return {
    policyId: policy.policyId,
    manualSeed: policy.manualSeed,
    graphStatus: policy.graphStatus,
    expectedGraphContribution: policy.expectedGraphContribution,
    manifestPath: GRAPH_CASE_MANIFEST_PATH,
    manifestSha256: sha256(bytes),
  };
}

/** The frozen 24 queries never receive a manual Graph seed. */
export function graphSeedForExistingQuery(policy, query) {
  assert.ok(query?.id, "[precheck] query identity is required");
  assert.equal(
    policy?.manualSeed,
    "none",
    "[precheck] existing retrieval queries declare no Graph seed",
  );
  return null;
}

function fixtureAllowlist(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0)
    throw precheck("a G-case Graph arm request names no fixture");
  const rows = fixtures.map(({ path: file, sha256: digest }) => {
    const kind = classifyGraphFixturePath(file);
    if (!HEX64.test(digest ?? "")) throw precheck(`${file} needs its sha256`);
    if (kind === "frozen" && FROZEN_FIXTURE_SHA256[file] !== digest)
      throw precheck(
        `${file} is not a frozen G-case fixture with its frozen digest`,
      );
    if (kind === "dev" && FROZEN_MATERIAL_SHA256.has(digest))
      throw precheck(`${file} is a copy of frozen material, not a dev fixture`);
    return Object.freeze({ path: file, sha256: digest, kind });
  });
  if (new Set(rows.map((row) => row.path)).size !== rows.length)
    throw precheck("duplicate fixture in the admission");
  return Object.freeze(rows);
}

/**
 * Refuses a request to measure the Graph arm unless it carries an admission.
 * `not-wired` (the default) is always accepted and returns the scaffold.
 * `wired` needs `admission`:
 *   { scope: "existing-queries", buildReceipt, seedPolicy }
 *     the product standard-build receipt; the existing queries carry no
 *     seed, so Graph is `not-requested` and contributes nothing.
 *   { scope: "graph-case", buildReceipt, productReceipt, fixtures,
 *     observationPrep }
 *     the evaluation build receipt and the product receipt of the same head
 *     and tree; `fixtures` is [{ path, sha256 }]; any frozen fixture also
 *     needs the pre-observation facts (assertObservationPrepAdmits).
 * Everything else is refused with `[precheck]`.
 */
export function assertGraphArmRequestable(
  requested = GRAPH_ARM_WIRING,
  admission = null,
) {
  if (requested === GRAPH_ARM_WIRING) return { wiring: GRAPH_ARM_WIRING };
  if (requested !== GRAPH_ARM_WIRED)
    throw precheck(
      `the ${RETRIEVAL_ARMS.graph} arm accepts only ${GRAPH_ARM_WIRING} or ${GRAPH_ARM_WIRED}`,
    );
  if (!admission)
    throw precheck(
      `the ${RETRIEVAL_ARMS.graph} arm is ${GRAPH_ARM_WIRING} without a build receipt admission`,
    );
  if (admission.scope === GRAPH_ARM_SCOPES.existing) {
    if (admission.buildReceipt?.schemaVersion === EVAL_BUILD_RECEIPT_SCHEMA)
      throw precheck(
        "the existing queries and P are measured on the product build, not the evaluation build",
      );
    assertProductBuildReceipt(admission.buildReceipt);
    if (admission.seedPolicy?.manualSeed !== "none")
      throw precheck("existing retrieval queries declare no Graph seed");
    return Object.freeze({
      wiring: GRAPH_ARM_WIRED,
      scope: GRAPH_ARM_SCOPES.existing,
      receiptKind: "product",
      candidateHead: admission.buildReceipt.candidate.resolvedHeadSha,
      graphStatus: "not-requested",
      expectedGraphContribution: 0,
    });
  }
  if (admission.scope === GRAPH_ARM_SCOPES.graphCase) {
    if (admission.buildReceipt?.schemaVersion === PRODUCT_BUILD_RECEIPT_SCHEMA)
      throw precheck(
        "a G-case Graph arm cannot run on the product build (Graph is not activated there)",
      );
    assertEvalBuildReceipt(admission.buildReceipt);
    assertProductBuildReceipt(admission.productReceipt);
    const evaluation = admission.buildReceipt.candidate;
    const product = admission.productReceipt.candidate;
    if (
      evaluation.resolvedHeadSha !== product.resolvedHeadSha ||
      evaluation.resolvedHeadTreeSha !== product.resolvedHeadTreeSha
    )
      throw precheck(
        "the evaluation and product receipts are for different candidates",
      );
    const allowedFixtures = fixtureAllowlist(admission.fixtures);
    const candidateHead = evaluation.resolvedHeadSha;
    const frozen = allowedFixtures.some((row) => row.kind === "frozen");
    if (frozen)
      assertObservationPrepAdmits(admission.observationPrep, candidateHead);
    return Object.freeze({
      wiring: GRAPH_ARM_WIRED,
      scope: GRAPH_ARM_SCOPES.graphCase,
      receiptKind: "evaluation",
      candidateHead,
      candidateTree: evaluation.resolvedHeadTreeSha,
      fixtureClass: frozen ? "frozen" : "dev",
      allowedFixtures,
      observationPrepCommit: frozen ? admission.observationPrep.commit : null,
    });
  }
  throw precheck(`unknown ${RETRIEVAL_ARMS.graph} admission scope`);
}

/**
 * The only way a runner reads a G-case fixture once the Graph arm is wired:
 * the path must be one the admission allowed, a regular file reached without
 * any symlink under `root`, and its bytes must have the allowed digest (a dev
 * fixture is never a copy of frozen material). Returns the checked bytes.
 */
export function assertFixtureReadAllowed(admission, { root, path: file }) {
  if (
    admission?.wiring !== GRAPH_ARM_WIRED ||
    admission.scope !== GRAPH_ARM_SCOPES.graphCase
  )
    throw precheck("fixture reads need a wired G-case admission");
  const kind = classifyGraphFixturePath(file);
  const allowed = admission.allowedFixtures?.find((row) => row.path === file);
  if (!allowed || allowed.kind !== kind)
    throw precheck(`${file} is not a fixture this admission allowed`);
  const realRoot = realpathSync(root);
  const full = nodePath.join(realRoot, file);
  const metadata = lstatSync(full);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw precheck(`${file} must be a regular file, not a symlink`);
  if (realpathSync(full) !== full)
    throw precheck(`${file} is reached through a symlink`);
  const bytes = readFileSync(full);
  const digest = sha256(bytes);
  if (digest !== allowed.sha256)
    throw precheck(`${file} bytes differ from the admitted digest`);
  if (kind === "dev" && FROZEN_MATERIAL_SHA256.has(digest))
    throw precheck(`${file} is a copy of frozen material`);
  return bytes;
}

export function describeGraphArm({ seedPolicy = null, admission = null } = {}) {
  if (
    admission?.wiring === GRAPH_ARM_WIRED &&
    admission.scope === GRAPH_ARM_SCOPES.existing
  )
    return {
      arm: "graph",
      label: RETRIEVAL_ARMS.graph,
      comparedAgainst: "hybrid",
      wiring: GRAPH_ARM_WIRED,
      scope: admission.scope,
      receiptKind: admission.receiptKind,
      status: "not-requested",
      reason: "existing-query-carries-no-graph-seed",
      expectedGraphContribution: 0,
      seedPolicy,
      gate: "equal-to-hybrid",
      pass: false,
    };
  return {
    arm: "graph",
    label: RETRIEVAL_ARMS.graph,
    comparedAgainst: "hybrid",
    wiring: GRAPH_ARM_WIRING,
    status: "unavailable",
    reason: GRAPH_ARM_UNAVAILABLE_REASON,
    scheduledCalls: 0,
    seedPolicy,
    gate: "hold",
    pass: false,
  };
}

/**
 * Graph-integrated recheck verdict. A not-wired or unavailable arm stays
 * Hold. On the existing queries a wired arm can only show that R+IR+Graph
 * equals R+IR: `comparisons` ([{ queryId, equal, violations }] from
 * compareExistingQueryGraphArm) must cover every one of `queryIds` and no
 * other. That is not a Graph pass, so `pass` stays false here.
 */
export function summarizeGraphArm(
  graphArm,
  comparisons = null,
  { queryIds } = {},
) {
  if (
    graphArm?.wiring === GRAPH_ARM_WIRED &&
    graphArm.scope === GRAPH_ARM_SCOPES.existing &&
    Array.isArray(comparisons) &&
    comparisons.length > 0
  ) {
    const expected = new Set(queryIds ?? []);
    const covered = new Set(comparisons.map((row) => row.queryId));
    const complete =
      Array.isArray(queryIds) &&
      expected.size === queryIds.length &&
      expected.size > 0 &&
      [...expected].every((id) => covered.has(id)) &&
      [...covered].every((id) => expected.has(id));
    const violations = comparisons.flatMap((row) => row.violations ?? []);
    const equal = complete && comparisons.every((row) => row.equal === true);
    return {
      status: equal ? "equal-to-hybrid" : "hold",
      reason: !complete
        ? "comparisons-do-not-cover-every-query"
        : equal
          ? "existing-queries-graph-not-requested"
          : "graph-arm-differs-from-hybrid",
      arm: graphArm.label ?? RETRIEVAL_ARMS.graph,
      equalsHybrid: equal,
      violations: [...new Set(violations)],
      pass: false,
    };
  }
  return {
    status: "hold",
    reason:
      graphArm?.wiring === GRAPH_ARM_WIRING
        ? GRAPH_ARM_UNAVAILABLE_REASON
        : "graph-arm-evaluation-not-implemented",
    arm: graphArm?.label ?? RETRIEVAL_ARMS.graph,
    pass: false,
  };
}

export async function loadContract(root, { requireFreeze = false } = {}) {
  const manifestBytes = await readFile(
    `${root}/evals/nir1-retrieval/manifest.json`,
  );
  const corpusBytes = await readFile(
    `${root}/evals/nir1-retrieval/corpus.json`,
  );
  const manifest = JSON.parse(manifestBytes);
  const corpus = JSON.parse(corpusBytes);
  const queries = validateContract(manifest, corpus);
  const digests = {
    manifestSha256: sha256(manifestBytes),
    corpusSha256: sha256(corpusBytes),
  };
  if (requireFreeze) {
    const freeze = JSON.parse(
      await readFile(`${root}/evals/nir1-retrieval/freeze.json`),
    );
    assert.equal(freeze.status, "frozen-after-independent-expectation-review");
    assert.equal(freeze.manifestSha256, digests.manifestSha256);
    assert.equal(freeze.corpusSha256, digests.corpusSha256);
    assert.ok(freeze.reviewedBy && freeze.reviewReceipt && freeze.frozenAt);
  }
  const activeAcceptance = await loadRecoveryAcceptance(
    root,
    manifest,
    digests,
  );
  return { manifest, corpus, queries, digests, activeAcceptance };
}
