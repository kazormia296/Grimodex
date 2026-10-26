// CP-4 S2: validator of the documents fixed before the first Graph observation.
//
//   evals/nir1-g01/setup-addendum.v1.json          K2/4 setup addendum (G-01)
//   evals/nir1-graph/declaration-addendum.v1.json  K2/4 addendum (G-02/07/08)
//   evals/nir1-graph/observation-prep.v1.json      D1, D2, D10, sample plan,
//                                                  traces, K6/4 procedure,
//                                                  diagnostic runs
//   evals/nir1-graph/trace-editing.v1.json         K6/2 step 4 (b) traces
//   evals/nir1-graph/trace-browsing.v1.json
//   evals/nir1-graph/observation-prep-author-declaration.v1.json
//   scripts/quality/nir1-graph-eval/procedure/k64-procedure.draft-2.json
//
// Like contract.mjs, this module never runs Graph, IR, Raw, a model, Electron
// or Native, and reads no runtime output. It recomputes what the documents
// copy from the contracts (the K2/4 table, K6/2 Q >= 200 and the editing
// density, the K6/4 values) and from the frozen fixtures, and checks the
// digests the documents reference. Files bound by freeze.v1.json are only
// read. A draft (placeholders `S4:<name>`) validates, but is never usable for
// a formal run (assertObservationPrepFormal).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const OBSERVATION_PREP_FILES = Object.freeze({
  setupAddendum: "evals/nir1-g01/setup-addendum.v1.json",
  declarationAddendum: "evals/nir1-graph/declaration-addendum.v1.json",
  prep: "evals/nir1-graph/observation-prep.v1.json",
  traceEditing: "evals/nir1-graph/trace-editing.v1.json",
  traceBrowsing: "evals/nir1-graph/trace-browsing.v1.json",
  authorDeclaration:
    "evals/nir1-graph/observation-prep-author-declaration.v1.json",
  procedureDraft:
    "scripts/quality/nir1-graph-eval/procedure/k64-procedure.draft-2.json",
});

/** The placeholder S4 replaces in the observation-prep commit. */
export const PLACEHOLDER = /^S4:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/u;

/** Contract bytes (K2/4 confirmed in Session B2; K6/2 frozen; K6/4 confirmed in B5). */
export const CONTRACTS = Object.freeze({
  k24: Object.freeze({
    draftRef: "nir1-c-body-disclosure-proposal/4",
    path: "docs/plans/nir1-c-body-disclosure-proposal-4-draft.md",
    sha256: "efc30cca32f2c91386baf3061836427ae7df3499c18188d31b5e2ba422a2fcfd",
    contractIds: Object.freeze([
      "graph-target-scene-body-disclosure",
      "scope-storage-authority",
    ]),
  }),
  k62: Object.freeze({
    draftRef: "nir1-final-request-eval-proposal/2",
    path: "docs/plans/nir1-final-request-eval-proposal-2-draft.md",
    sha256: "4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8",
    freezeCommit: "af643a93eeae7f937c9cd5a9dd87a6308c96fab6",
  }),
  k64: Object.freeze({
    draftRef: "nir1-final-request-eval-proposal/4",
    contractId: "graph-eval-procedure",
    path: "docs/plans/nir1-final-request-eval-proposal-4-draft.md",
    sha256: "d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3",
    confirmedCommit: "18ebc7b8de2d4f2701c573b5d91561a6cc852024",
  }),
});

/** K2/4「setup の addendum」の表（宣言する Scene、reading、excerpt）。 */
export const K24_TABLE = Object.freeze(
  [
    ["G-01", "v1", "g01-mira", 20, 100, 78],
    ["G-02", "base", "g02-tamsin-first", 30, 100, 78],
    ["G-07", "base", "g07-pell-dock", 40, 100, 70],
    ["G-08", "base-usable", "g08-cass-attic", 20, 100, 64],
    ["G-08", "graph-recovered", "g08-cass-attic", 20, 100, 64],
  ].map(([caseId, variantId, sceneId, scene, query, end]) =>
    Object.freeze({ caseId, variantId, sceneId, scene, query, end }),
  ),
);

/** K2/4「宣言の値（v1 は G-01 subset）」。 */
const DECLARATION_VALUES = Object.freeze({
  target: "saved-body-full-and-title",
  reading: "not-declared",
  story: "independent",
  auto: "independent",
  phase: "independent",
  reveal: "non-secret",
  pov: "independent",
  a1: "not-declared",
});

const G01_NEGATIVES = Object.freeze([
  ["K24-G01-N1", false, null],
  ["K24-G01-N2", true, "resave-same-body"],
  ["K24-G01-N3", true, "restore-same-bytes-body-version"],
  ["K24-G01-N4", true, "restore-different-bytes-body-version"],
]);
/** K2/4 :416 restore negatives need a prepared body version (S3-P3-2). */
const RESTORE_MUTATIONS = new Set([
  "restore-same-bytes-body-version",
  "restore-different-bytes-body-version",
]);
/** S3-P1-1: what R5 gates (every Graph arm run and the K6/4 freeze). */
const R5_GATED = Object.freeze([
  "g-case-gold",
  "g-case-diagnostic-negative",
  "v10-ready-probe",
  "k62-ii-diagnostic",
  "k62-iii-diagnostic",
  "trace",
  "k64-freeze-commit",
]);
/** S3-P3-4: every use of BOUNDARY_TOLERANCE_MS in claude/nir1-cp4. */
const TOLERANCE_USAGES = Object.freeze([
  "join.mjs:93",
  "followup.mjs:437",
  "followup.mjs:588",
  "followup.mjs:614",
  "k64-record.mjs:198",
]);
const STALL_ATTEMPT_LIMIT = 2;
const PROCEDURE_V1 =
  "scripts/quality/nir1-graph-eval/procedure/k64-procedure.v1.json";
const GRAPH_NEGATIVES = Object.freeze([
  ["K24-G02-N1", "G-02", "base"],
  ["K24-G07-N1", "G-07", "base"],
  ["K24-G08-N1", "G-08", "base-usable"],
]);
const SETUP_ORDER_ANCHOR = "then foreshadows, foreshadow Codex links and pins";
const ADDENDUM_STATUSES = Object.freeze([
  "draft-awaiting-independent-review",
  "frozen-after-independent-review",
]);
const PREP_DRAFT = "draft-awaiting-s3-review-and-s4-freeze";
const PREP_FROZEN = "frozen-before-observation";

/** K6/4 values (判断 2〜4; D from the P contract) and 技術点 2's ceiling. */
export const K64_VALUES = Object.freeze({
  dMs: 10.84,
  wFMs: 100,
  tLateMs: 100,
  tShowMs: 2_000,
});
export const K64_WAIT_CEILING_MS = 10_000;
const K64_FOLLOW = Object.freeze(
  Array.from({ length: 7 }, (_, at) => `F${at + 1}`),
);
const K64_EXCLUSIONS = Object.freeze(
  Array.from({ length: 13 }, (_, at) => `X${at + 1}`),
);

/** K6/2 step 2 and (b) rule 1. */
const WARMUP_PER_ARM = 5;
const MEASURED_PER_ARM = 30;
const TRACE_MIN_QUERIES = 200;
const PARITY_VARIANTS = Object.freeze([
  "G-02/base",
  "G-03/base",
  "G-03/frontier-exceeded",
  "G-04/base",
  "G-05/base",
  "G-06/base",
  "G-07/base",
  "G-08/base-usable",
  "G-08/graph-index-unusable",
  "G-08/graph-recovered",
  "G-08/chronicle-index-unusable",
  "G-08/both-indexes-unusable",
]);
const PLAN_VARIANTS = Object.freeze(["G-01/v1", ...PARITY_VARIANTS]);
const DIAGNOSTIC_IDS = Object.freeze([
  ...G01_NEGATIVES.map(([id]) => id),
  ...GRAPH_NEGATIVES.map(([id]) => id),
  "K62-iii",
]);

const TRACE_KINDS = Object.freeze({
  editing: Object.freeze({ file: OBSERVATION_PREP_FILES.traceEditing }),
  browsing: Object.freeze({ file: OBSERVATION_PREP_FILES.traceBrowsing }),
});
/** Product sources whose values a trace writes (K6/2 step 4, K6/4 変える点 12). */
const PRODUCT_SOURCES = Object.freeze({
  settings: "src/features/settings/types.ts",
  hook: "src/features/related-scenes/useNir1RelatedScenes.ts",
});
const FORBIDDEN_READ = Object.freeze([
  /^docs\/plans\/nir1-lane-decisions\/cp4-decisions\.md$/u,
  /^docs\/plans\/nir1-lane-decisions\/cq-deferred-decisions\.md$/u,
  /^docs\/plans\/nir1-lane-decisions\/rsj-/u,
  /^docs\/plans\/nir1-lane-decisions\/rs-join-decisions\.md$/u,
  /(?:^|\/)\.artifacts\//u,
  /\/tasks\/[^/]+\.output$/u,
  /(?:^|\/)cp4-(?:task|hardening-task|s1f-task|k64-task)\.md$/u,
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** UTF-16 length of the first non-empty line (the K2/4 excerpt rule). */
function firstLineUtf16(body) {
  const line = String(body)
    .split(/\r\n|\n|\r/u)
    .find((row) => row.trim().length > 0);
  return line === undefined ? 0 : line.length;
}

function fixtureIdErrors(errors, label, reference, fixture) {
  if (!isObject(reference)) {
    errors.push(`${label} reference is missing`);
    return;
  }
  if (reference.path !== fixture.path)
    errors.push(`${label}.path must be ${fixture.path}`);
  if (reference.sha256 !== fixture.sha256)
    errors.push(
      `${label}.sha256 must be the fixture's sha256 ${fixture.sha256}`,
    );
  if (reference.sha256 !== fixture.frozenSha256)
    errors.push(`${label}.sha256 must equal the freeze record's digest`);
  if (reference.fixtureId !== fixture.json.fixtureId)
    errors.push(`${label}.fixtureId must be ${fixture.json.fixtureId}`);
}

function freezeReferenceErrors(errors, reference, ctx) {
  if (
    !isObject(reference) ||
    reference.path !== "evals/nir1-graph/freeze.v1.json" ||
    reference.sha256 !== ctx.freeze.sha256
  )
    errors.push(
      `references.graphCaseFreeze must be evals/nir1-graph/freeze.v1.json with its sha256 ${ctx.freeze.sha256}`,
    );
}

function contractErrors(errors, contract) {
  const k24 = CONTRACTS.k24;
  if (
    !isObject(contract) ||
    contract.draftRef !== k24.draftRef ||
    contract.path !== k24.path ||
    contract.sha256 !== k24.sha256 ||
    !same(contract.contractIds, k24.contractIds)
  )
    errors.push(
      `contract must be K2/4 (${k24.draftRef}, sha256 ${k24.sha256})`,
    );
}

function reviewErrors(errors, document, statuses, label) {
  if (!statuses.includes(document.status))
    errors.push(`${label}.status must be one of ${statuses.join(", ")}`);
  const frozen = document.status === statuses[1];
  if (!frozen) {
    if (document.review !== null)
      errors.push(`${label}.review must be null until the independent review`);
    return;
  }
  const review = document.review;
  if (
    !isObject(review) ||
    typeof review.reviewer !== "string" ||
    review.reviewer.trim() === "" ||
    typeof review.reviewedAt !== "string" ||
    !ISO_DATE.test(review.reviewedAt) ||
    typeof review.record !== "string" ||
    review.record.trim() === "" ||
    !HEX64.test(review.recordSha256 ?? "")
  )
    errors.push(
      `${label}.review must name the reviewer, date, record and record sha256 when frozen`,
    );
}

/**
 * The veto records K2/4 refuses for a declared Scene, recomputed from the
 * fixture: a secret foreshadow whose Scene fields refer to it, a POV on it, a
 * secret Chronicle (qualified IR) row on it.
 */
function vetoesFor(fixture, sceneId) {
  const vetoes = [];
  for (const foreshadow of fixture.foreshadows ?? []) {
    if (foreshadow.secret !== true) continue;
    for (const [key, value] of Object.entries(foreshadow)) {
      if (!/scene/iu.test(key)) continue;
      const values = Array.isArray(value) ? value : [value];
      if (values.includes(sceneId))
        vetoes.push(`secret foreshadow ${foreshadow.id} (${key})`);
    }
  }
  const scene = (fixture.scenes ?? []).find((row) => row.id === sceneId);
  for (const key of ["pov", "povEntityId", "storyTime", "storyTimeOrder"])
    if (scene && scene[key] !== undefined && scene[key] !== null)
      vetoes.push(`Scene ${key}`);
  for (const row of fixture.qualifiedIr ?? [])
    if (row.sceneId === sceneId && row.secret === true)
      vetoes.push("secret Chronicle event");
  for (const row of fixture.chronicleEvents ?? [])
    if (row.secret === true && JSON.stringify(row).includes(`"${sceneId}"`))
      vetoes.push(`secret Chronicle event ${row.id ?? ""}`);
  return vetoes;
}

function declarationRowErrors(errors, row, expected, fixture, excerpt) {
  const label = `${expected.caseId}/${expected.variantId}`;
  if (!isObject(row)) {
    errors.push(`declarations is missing ${label}`);
    return;
  }
  if (row.sceneId !== expected.sceneId)
    errors.push(`${label} must declare ${expected.sceneId} (K2/4 table)`);
  const scene = (fixture.scenes ?? []).find((s) => s.id === expected.sceneId);
  if (!scene) {
    errors.push(`${label}: ${expected.sceneId} is not a fixture Scene`);
    return;
  }
  if (
    row.readingOrder?.scene !== expected.scene ||
    row.readingOrder?.query !== expected.query ||
    scene.readingOrder !== expected.scene ||
    fixture.query?.readingOrder !== expected.query
  )
    errors.push(
      `${label} readingOrder must be ${expected.scene}/${expected.query}`,
    );
  if (!(scene.readingOrder < fixture.query.readingOrder))
    errors.push(`${label}: the declared Scene is not read before the query`);
  const vetoes = vetoesFor(fixture, expected.sceneId);
  if (vetoes.length > 0)
    errors.push(
      `${label}: veto records on ${expected.sceneId}: ${vetoes.join(", ")}`,
    );
  if (!Array.isArray(row.vetoRecords) || row.vetoRecords.length !== 0)
    errors.push(`${label}.vetoRecords must be empty (K2/4 table: none)`);
  const range = row.expectedExcerpt;
  if (
    range?.sceneId !== expected.sceneId ||
    range?.start !== 0 ||
    range?.end !== expected.end ||
    excerpt?.start !== 0 ||
    excerpt?.end !== expected.end ||
    firstLineUtf16(scene.body) !== expected.end
  )
    errors.push(
      `${label} expected excerpt must be [0,${expected.end}) (K2/4 table, the frozen expectation and the first non-empty line)`,
    );
}

function placeErrors(errors, place) {
  if (!isObject(place) || (place.choice !== "i" && place.choice !== "ii"))
    errors.push(
      "declarationPlace.choice must be i or ii (K2/4 測定の workspace)",
    );
  else if (typeof place.reason !== "string" || place.reason.trim() === "")
    errors.push("declarationPlace.reason is required");
}

function negativeErrors(errors, rows, expected) {
  if (!Array.isArray(rows) || rows.length !== expected.length) {
    errors.push(
      `diagnosticNegatives must be exactly ${expected.map((row) => row.id).join(", ")}`,
    );
    return;
  }
  expected.forEach((want, at) => {
    const row = rows[at];
    for (const [key, value] of Object.entries(want))
      if (row?.[key] !== value)
        errors.push(`diagnosticNegatives[${at}].${key} must be ${value}`);
    if (row?.countsInCaseJudgement !== false)
      errors.push(
        `diagnosticNegatives[${at}] is diagnostic only (countsInCaseJudgement false)`,
      );
    if (typeof row?.expectation !== "string" || row.expectation.trim() === "")
      errors.push(`diagnosticNegatives[${at}].expectation is required`);
    if (
      want.mutationAfterDeclaration !== null &&
      (typeof row?.measurementProcess !== "string" ||
        !row.measurementProcess.includes("nir1-graph-index-build"))
    )
      errors.push(
        `diagnosticNegatives[${at}].measurementProcess must reseal B through the journey seam (nir1-graph-index-build)`,
      );
    if (
      RESTORE_MUTATIONS.has(want.mutationAfterDeclaration) &&
      (typeof row?.beforeDeclaration !== "string" ||
        row.beforeDeclaration.trim() === "")
    )
      errors.push(
        `diagnosticNegatives[${at}].beforeDeclaration must prepare the body version to restore`,
      );
  });
}

function commonAddendumErrors(errors, addendum, ctx, schemaVersion) {
  if (!isObject(addendum)) {
    errors.push("addendum must be an object");
    return false;
  }
  if (addendum.schemaVersion !== schemaVersion)
    errors.push(`schemaVersion must be ${schemaVersion}`);
  if (addendum.graphRuntimeObservedBeforeAuthoring !== false)
    errors.push("graphRuntimeObservedBeforeAuthoring must be false");
  reviewErrors(errors, addendum, ADDENDUM_STATUSES, "addendum");
  contractErrors(errors, addendum.contract);
  freezeReferenceErrors(errors, addendum.references?.graphCaseFreeze, ctx);
  const values = addendum.declarationValues;
  for (const [key, value] of Object.entries(DECLARATION_VALUES))
    if (values?.[key] !== value)
      errors.push(`declarationValues.${key} must be ${value} (K2/4 v1 subset)`);
  placeErrors(errors, addendum.declarationPlace);
  for (const key of [
    "declarationTiming",
    "bSealProcedure",
    "afterDeclaration",
    "recordPreconditions",
    "cb4Inputs",
  ])
    if (typeof addendum[key] !== "string" || addendum[key].trim() === "")
      errors.push(`${key} is required`);
  if (
    !Array.isArray(addendum.measurementWorkspaceCheck) ||
    addendum.measurementWorkspaceCheck.length < 3
  )
    errors.push("measurementWorkspaceCheck must list the K2/4 checks");
  return true;
}

/** G-01 addendum (K2/4 table row 1; fixture v1 unchanged). */
export function setupAddendumErrors(addendum, ctx) {
  const errors = [];
  if (
    !commonAddendumErrors(errors, addendum, ctx, "nir1-c-body-setup-addendum/1")
  )
    return errors;
  fixtureIdErrors(
    errors,
    "references.g01Fixture",
    addendum.references?.g01Fixture,
    ctx.g01,
  );
  const fixture = ctx.g01.json;
  const rows = addendum.declarations;
  if (!Array.isArray(rows) || rows.length !== 1)
    errors.push("declarations must be exactly the G-01 row of the K2/4 table");
  else {
    const expected = K24_TABLE[0];
    if (
      rows[0].caseId !== expected.caseId ||
      rows[0].variantId !== expected.variantId
    )
      errors.push("declarations[0] must be G-01/v1");
    declarationRowErrors(
      errors,
      rows[0],
      expected,
      fixture,
      fixture.expectations?.sceneExcerpt?.canonicalUtf16Range,
    );
  }
  const unchanged = addendum.unchanged;
  const expectations = fixture.expectations ?? {};
  if (
    unchanged?.querySceneId !== fixture.query?.sceneId ||
    unchanged?.seedEntityId !== fixture.entitySeed?.id ||
    !same(unchanged?.gold, { "g01-mira": 3 }) ||
    !same(unchanged?.expectations?.raw, expectations.raw) ||
    !same(unchanged?.expectations?.rPlusIr, expectations.rPlusIr) ||
    !same(
      unchanged?.expectations?.rPlusIrPlusGraph,
      expectations.rPlusIrPlusGraph,
    ) ||
    !same(
      unchanged?.expectations?.excerptRange,
      expectations.sceneExcerpt?.canonicalUtf16Range,
    ) ||
    !same(unchanged?.expectations?.metrics, expectations.metrics)
  )
    errors.push(
      "unchanged must copy the G-01 fixture v1 query, seed, Gold and expectations",
    );
  if (fixture.scenes?.find((s) => s.id === "g01-mira")?.gold !== 3)
    errors.push("the G-01 fixture no longer has g01-mira as Gold 3");
  negativeErrors(
    errors,
    addendum.diagnosticNegatives,
    G01_NEGATIVES.map(([id, declare, mutation]) => ({
      id,
      caseId: "G-01",
      variantId: "v1",
      declare,
      mutationAfterDeclaration: mutation,
    })),
  );
  return errors;
}

/** Variants whose frozen expectations append a Graph-only Scene. */
function appendedVariants(ctx) {
  const rows = [];
  for (const caseId of Object.keys(ctx.fixtures).sort()) {
    for (const variant of ctx.fixtures[caseId].json.variants ?? []) {
      const appended =
        variant.expectations?.arms?.rPlusIrPlusGraph?.appendedSceneId ?? null;
      rows.push({
        key: `${caseId}/${variant.id}`,
        caseId,
        variant,
        appended,
      });
    }
  }
  return rows;
}

/** G-02 base, G-07 base, G-08 base-usable and graph-recovered (K2/4 table). */
export function declarationAddendumErrors(addendum, ctx) {
  const errors = [];
  if (
    !commonAddendumErrors(
      errors,
      addendum,
      ctx,
      "nir1-c-body-declaration-addendum/1",
    )
  )
    return errors;
  for (const caseId of ["G-02", "G-07", "G-08"])
    fixtureIdErrors(
      errors,
      `references.fixtures.${caseId}`,
      addendum.references?.fixtures?.[caseId],
      ctx.fixtures[caseId],
    );
  const table = K24_TABLE.slice(1);
  const rows = Array.isArray(addendum.declarations)
    ? addendum.declarations
    : [];
  const keys = rows.map((row) => `${row.caseId}/${row.variantId}`);
  const tableKeys = table.map((row) => `${row.caseId}/${row.variantId}`);
  for (const key of tableKeys)
    if (!keys.includes(key)) errors.push(`declarations is missing ${key}`);
  for (const key of keys)
    if (!tableKeys.includes(key))
      errors.push(
        `declarations has ${key}, which the K2/4 table does not declare`,
      );
  if (!same(keys, tableKeys))
    errors.push(
      `declarations must be ${tableKeys.join(", ")} in the K2/4 order`,
    );
  const appended = appendedVariants(ctx).filter(
    (row) => row.caseId !== "G-01" && row.appended !== null,
  );
  const appendedKeys = appended.map((row) => row.key);
  if (!same([...appendedKeys].sort(), [...tableKeys].sort()))
    errors.push(
      `the frozen variants that append a Scene (${appendedKeys.join(", ")}) differ from the K2/4 table`,
    );
  for (const expected of table) {
    const row = rows.find(
      (candidate) =>
        candidate.caseId === expected.caseId &&
        candidate.variantId === expected.variantId,
    );
    if (!row) continue;
    const fixture = ctx.fixtures[expected.caseId].json;
    const variant = (fixture.variants ?? []).find(
      (candidate) => candidate.id === expected.variantId,
    );
    if (
      variant?.expectations?.arms?.rPlusIrPlusGraph?.appendedSceneId !==
      expected.sceneId
    )
      errors.push(
        `${expected.caseId}/${expected.variantId}: the frozen appendedSceneId is not ${expected.sceneId}`,
      );
    declarationRowErrors(
      errors,
      row,
      expected,
      fixture,
      variant?.expectations?.addedScene?.sceneExcerpt?.canonicalUtf16Range,
    );
  }
  const without = appendedVariants(ctx)
    .filter((row) => row.caseId !== "G-01" && row.appended === null)
    .map((row) => row.key);
  if (!same(addendum.variantsWithoutDeclaration?.variants, without))
    errors.push(
      `variantsWithoutDeclaration.variants must be ${without.join(", ")}`,
    );
  const step = addendum.declarationStep;
  if (!isObject(step)) errors.push("declarationStep is required (K2/4 :407)");
  else {
    if (step.outsideSetupOrder !== true)
      errors.push("declarationStep.outsideSetupOrder must be true");
    if (step.after !== SETUP_ORDER_ANCHOR)
      errors.push(`declarationStep.after must be "${SETUP_ORDER_ANCHOR}"`);
    if (step.before !== "the first Graph arm query")
      errors.push("declarationStep.before must be the first Graph arm query");
    for (const key of [
      "setupTimelineStep",
      "measurementPoint",
      "fixtureChanged",
      "setupOrderChanged",
    ])
      if (step[key] !== false)
        errors.push(`declarationStep.${key} must be false`);
  }
  for (const caseId of ["G-02", "G-07", "G-08"]) {
    const order = ctx.fixtures[caseId].json.measurementBoundary?.setupOrder;
    if (typeof order !== "string" || !order.includes(SETUP_ORDER_ANCHOR))
      errors.push(`${caseId} setupOrder no longer has the declaration anchor`);
  }
  if (
    addendum.graphRecovered
      ?.noDeclarationWriteBetweenMutationAndMeasurementPoint !== true
  )
    errors.push(
      "graphRecovered.noDeclarationWriteBetweenMutationAndMeasurementPoint must be true",
    );
  negativeErrors(
    errors,
    addendum.diagnosticNegatives,
    GRAPH_NEGATIVES.map(([id, caseId, variantId]) => ({
      id,
      caseId,
      variantId,
      declare: false,
      mutationAfterDeclaration: null,
    })),
  );
  return errors;
}

/** The operation list a trace's declared pattern expands to. */
export function expandTraceOperations(trace) {
  const counted = (index) => ({
    index,
    counted: true,
    querySceneId: trace.querySceneId,
    seed: trace.seed?.entityId,
    expectedMaterials: (trace.expectedMaterials ?? []).map(
      (row) => row.revisionId,
    ),
  });
  const ops = [
    {
      op: "open-scene",
      sceneId: trace.querySceneId,
      until: "cycle-end",
      query: counted(0),
    },
  ];
  for (let cycle = 1; cycle <= trace.cycles; cycle++) {
    if (trace.kind === "editing") {
      ops.push({
        op: "edit",
        via: "product-editor",
        sceneId: trace.querySceneId,
        action: cycle % 2 === 1 ? "append-suffix" : "remove-suffix",
      });
      ops.push({ op: "confirm-autosave-commit", sceneId: trace.querySceneId });
      ops.push({
        op: "product-query",
        trigger: "autosave-commit",
        until: "cycle-end",
        query: counted(cycle),
      });
    } else {
      ops.push({
        op: "navigate",
        sceneId: trace.browse?.otherSceneId,
        until: "query-published",
        query: {
          counted: false,
          querySceneId: trace.browse?.otherSceneId,
          seed: null,
          expectedMaterials: [],
        },
      });
      ops.push({
        op: "navigate",
        sceneId: trace.querySceneId,
        until: "cycle-end",
        query: counted(cycle),
      });
    }
  }
  return ops.map((op, seq) => ({ seq, ...op }));
}

const ALLOWED_OPS = Object.freeze({
  editing: new Set([
    "open-scene",
    "edit",
    "confirm-autosave-commit",
    "product-query",
  ]),
  browsing: new Set(["open-scene", "navigate"]),
});

/** K6/2 step 4 density and the forbidden operations, from the list itself. */
function operationErrors(errors, trace) {
  const ops = Array.isArray(trace.operations) ? trace.operations : [];
  const allowed = ALLOWED_OPS[trace.kind] ?? new Set();
  let since = [];
  let queries = 0;
  ops.forEach((op, at) => {
    if (op?.seq !== at) errors.push(`operations[${at}].seq must be ${at}`);
    if (/approv|prepare|decision|reject/iu.test(String(op?.op)))
      errors.push(
        `operations[${at}] is an approval operation (${op.op}); a trace never approves`,
      );
    else if (!allowed.has(op?.op))
      errors.push(
        `operations[${at}].op ${op?.op} is not a ${trace.kind} trace operation`,
      );
    if (op?.op === "edit" && op.via !== "product-editor")
      errors.push(`operations[${at}] edit must go through the product-editor`);
    if (trace.kind === "browsing" && /edit|commit|save/iu.test(String(op?.op)))
      errors.push(`operations[${at}]: a browsing trace must not edit or save`);
    if (op?.query?.counted === true) {
      if (trace.kind === "editing" && queries > 0) {
        const lastCommit = since.findLastIndex(
          (row) => row.op === "confirm-autosave-commit",
        );
        const edit = since.findIndex((row) => row.op === "edit");
        if (lastCommit < 0 || edit < 0 || edit > lastCommit)
          errors.push(
            `density: query ${queries} lacks an edit and its autosave commit before it`,
          );
        else if (lastCommit !== since.length - 1)
          errors.push(
            `density: query ${queries} has ${since
              .slice(lastCommit + 1)
              .map((row) => row.op)
              .join(",")} between its commit and the query`,
          );
        if (op.op !== "product-query" || op.trigger !== "autosave-commit")
          errors.push(
            `density: query ${queries} must be the product's own query on the autosave commit`,
          );
      }
      queries += 1;
      since = [];
      return;
    }
    since.push(op ?? {});
  });
  return queries;
}

function triggerValueErrors(errors, trace, ctx) {
  const triggers = trace.productTriggers ?? {};
  const settings = ctx.productSources?.[PRODUCT_SOURCES.settings] ?? "";
  const hook = ctx.productSources?.[PRODUCT_SOURCES.hook] ?? "";
  const autosave = /"editor\.autoSaveDelay":\s*"(\d+)"/u.exec(settings);
  if (
    triggers.autoSaveDelayMs?.source?.path !== PRODUCT_SOURCES.settings ||
    !autosave ||
    Number(autosave[1]) !== triggers.autoSaveDelayMs?.value
  )
    errors.push(
      `productTriggers.autoSaveDelayMs must be the product default editor.autoSaveDelay (${autosave?.[1] ?? "unreadable"})`,
    );
  const debounce = /const FETCH_DEBOUNCE_MS = (\d+);/u.exec(hook);
  if (
    triggers.fetchDebounceMs?.source?.path !== PRODUCT_SOURCES.hook ||
    !debounce ||
    Number(debounce[1]) !== triggers.fetchDebounceMs?.value
  )
    errors.push(
      `productTriggers.fetchDebounceMs must be the product FETCH_DEBOUNCE_MS (${debounce?.[1] ?? "unreadable"})`,
    );
  const expression = triggers.graphReadyFirstRefreshMs?.source?.expression;
  if (
    triggers.graphReadyFirstRefreshMs?.value !== 0 ||
    typeof expression !== "string" ||
    !hook.includes(expression)
  )
    errors.push(
      "productTriggers.graphReadyFirstRefreshMs must be the product's 0 ms first graph-ready refresh (DR-RSJ-6)",
    );
  if (!HEX40.test(triggers.build?.authoredAtBaseCommit ?? ""))
    errors.push("productTriggers.build.authoredAtBaseCommit must be a commit");
}

/** One (b) trace file (K6/2 step 4 and (b) rule 1; K6/4 変える点 15). */
export function traceErrors(trace, ctx) {
  const errors = [];
  if (!isObject(trace)) return ["trace must be an object"];
  if (trace.schemaVersion !== "nir1-cp4-trace/1")
    errors.push("schemaVersion must be nir1-cp4-trace/1");
  if (!Object.hasOwn(TRACE_KINDS, trace.kind))
    return [...errors, "kind must be editing or browsing"];
  if (trace.traceId !== `nir1-cp4-trace-${trace.kind}/1`)
    errors.push(`traceId must be nir1-cp4-trace-${trace.kind}/1`);
  if (trace.graphRuntimeObservedBeforeAuthoring !== false)
    errors.push("graphRuntimeObservedBeforeAuthoring must be false");
  reviewErrors(errors, trace, ADDENDUM_STATUSES, "trace");
  if (
    trace.contract?.k62?.sha256 !== CONTRACTS.k62.sha256 ||
    trace.contract?.k64?.sha256 !== CONTRACTS.k64.sha256
  )
    errors.push("contract must name the K6/2 and K6/4 bytes");
  const project = trace.project ?? {};
  const fixture = ctx.fixtures[project.caseId];
  if (!fixture) errors.push(`project.caseId ${project.caseId} is not a G-case`);
  else {
    if (project.fixturePath !== fixture.path)
      errors.push(`project.fixturePath must be ${fixture.path}`);
    if (
      project.fixtureSha256 !== fixture.sha256 ||
      project.fixtureSha256 !== fixture.frozenSha256
    )
      errors.push("project.fixtureSha256 must be the frozen fixture sha256");
    const variant = (fixture.json.variants ?? []).find(
      (row) => row.id === project.variantId,
    );
    if (!variant || variant.expectations?.graph?.status !== "available")
      errors.push(
        "project must be a variant whose Graph is expected available",
      );
    if (trace.querySceneId !== fixture.json.query?.sceneId)
      errors.push(
        `querySceneId must be the fixture query ${fixture.json.query?.sceneId}`,
      );
    if (trace.seed?.entityId !== fixture.json.manualSeed?.entityId)
      errors.push(
        `seed.entityId must be the fixture manual seed ${fixture.json.manualSeed?.entityId}`,
      );
    const materials = trace.expectedMaterials;
    if (!Array.isArray(materials) || materials.length === 0)
      errors.push("expectedMaterials must list at least one Revision");
    const graph = variant?.expectations?.graph ?? {};
    for (const material of materials ?? []) {
      const revision = (fixture.json.revisions ?? []).find(
        (row) => row.id === material.revisionId,
      );
      const qualified = (graph.qualifiedRevisionIds ?? []).includes(
        material.revisionId,
      );
      const edges = (material.edgeIds ?? []).filter(
        (edge) =>
          (graph.edgeIds ?? []).includes(edge) &&
          (revision?.relationIds ?? []).includes(edge),
      );
      if (
        !revision ||
        !qualified ||
        edges.length === 0 ||
        edges.length !== (material.edgeIds ?? []).length
      )
        errors.push(
          `expectedMaterials ${material.revisionId} must be a qualified Revision whose relations are expected Graph edges`,
        );
    }
    if (trace.kind === "browsing") {
      const other = trace.browse?.otherSceneId;
      if (!(fixture.json.scenes ?? []).some((row) => row.id === other))
        errors.push("browse.otherSceneId must be a fixture Scene");
      if ((fixture.json.pins ?? []).some((pin) => pin.sceneId === other))
        errors.push(
          "browse.otherSceneId must have no pin (its query carries no seed and is outside Q)",
        );
    }
  }
  triggerValueErrors(errors, trace, ctx);
  if (
    trace.maintenance?.gate === undefined ||
    !String(trace.maintenance.gate).includes("nir1-graph-index-build")
  )
    errors.push(
      "maintenance.gate must open the B route through the B-ROUTE journey seam (trigger nir1-graph-index-build)",
    );
  if (!Number.isInteger(trace.cycles) || trace.cycles < 1)
    errors.push("cycles must be a positive integer");
  if (
    trace.stall?.attemptLimit !== STALL_ATTEMPT_LIMIT ||
    typeof trace.stall?.attemptRule !== "string" ||
    !trace.stall.attemptRule.includes("[precheck]")
  )
    errors.push(
      `stall.attemptLimit must be ${STALL_ATTEMPT_LIMIT} with a disclosed attempt rule ending in [precheck] (S3-P3-3)`,
    );
  if (
    trace.kind === "browsing" &&
    (typeof trace.browse?.stayEnd !== "string" ||
      trace.browse.stayEnd.trim() === "")
  )
    errors.push("browse.stayEnd must fix the end of the other Scene's stay");
  const queries = operationErrors(errors, trace);
  if (queries < TRACE_MIN_QUERIES)
    errors.push(`the trace has Q=${queries}, fewer than ${TRACE_MIN_QUERIES}`);
  if (trace.plannedQ !== queries)
    errors.push(`plannedQ must be the counted queries ${queries}`);
  if (!same(trace.operations, expandTraceOperations(trace)))
    errors.push(
      "operations differ from the declared template (open, then cycles of the fixed pattern)",
    );
  return errors;
}

/** The K6/4 procedure file draft (mirrors procedure-file.mjs of claude/nir1-cp4). */
export function procedureDraftErrors(procedure) {
  const errors = [];
  const top = [
    "schema",
    "version",
    "draft",
    "contract",
    "values",
    "conditions",
    "review",
  ];
  if (!isObject(procedure)) return ["procedure must be an object"];
  if (!same(Object.keys(procedure).sort(), [...top].sort()))
    errors.push(`procedure keys must be exactly ${top.join(", ")}`);
  if (procedure.schema !== "nir1-cp4-k64-procedure/1")
    errors.push("schema must be nir1-cp4-k64-procedure/1");
  if (procedure.version !== "draft-2" || procedure.draft !== true)
    errors.push("this file is the draft-2 version (draft true)");
  if (
    !same(procedure.contract, {
      draftRef: CONTRACTS.k64.draftRef,
      contractId: CONTRACTS.k64.contractId,
      sha256: CONTRACTS.k64.sha256,
    })
  )
    errors.push(`contract must be K6/4 (sha256 ${CONTRACTS.k64.sha256})`);
  const values = procedure.values ?? {};
  const keys = [...Object.keys(K64_VALUES), "r1r4WaitMs"];
  if (!same(Object.keys(values).sort(), [...keys].sort()))
    errors.push(`values keys must be exactly ${keys.join(", ")}`);
  for (const [key, value] of Object.entries(K64_VALUES))
    if (values[key] !== value)
      errors.push(`values.${key} must be the contract's ${value}`);
  if (
    !Number.isInteger(values.r1r4WaitMs) ||
    values.r1r4WaitMs <= 0 ||
    values.r1r4WaitMs > K64_WAIT_CEILING_MS
  )
    errors.push(
      `values.r1r4WaitMs must be a positive integer of at most ${K64_WAIT_CEILING_MS} ms (技術点 2)`,
    );
  if (
    !same(procedure.conditions, {
      follow: K64_FOLLOW,
      exclusions: K64_EXCLUSIONS,
    })
  )
    errors.push(
      "conditions must be F1..F7 and X1..X13 in the contract's order",
    );
  if (procedure.review !== null)
    errors.push("review must be null for a draft (it is never reviewed)");
  return errors;
}

function placeholderTokens(value, out = new Set()) {
  if (typeof value === "string") {
    if (value.startsWith("S4:")) out.add(value);
  } else if (Array.isArray(value))
    value.forEach((row) => placeholderTokens(row, out));
  else if (isObject(value))
    for (const inner of Object.values(value)) placeholderTokens(inner, out);
  return out;
}

function referenceErrors(errors, label, value, kind, frozen, expectedSha) {
  const placeholder = typeof value === "string" && PLACEHOLDER.test(value);
  const pattern = kind === "commit" ? HEX40 : HEX64;
  if (placeholder) {
    if (frozen) errors.push(`${label} is still the placeholder ${value}`);
    return;
  }
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(
      `${label} must be a ${kind === "commit" ? "40-hex commit" : "sha256"} or an S4 placeholder`,
    );
    return;
  }
  if (kind === "sha256" && expectedSha !== undefined && value !== expectedSha)
    errors.push(`${label} differs from the file's sha256 ${expectedSha}`);
}

/** The observation-prep record (D1, D2, D10, plan, traces, procedure, diagnostics). */
export function observationPrepErrors(prep, ctx) {
  const errors = [];
  if (!isObject(prep)) return ["observation prep must be an object"];
  if (prep.schemaVersion !== "nir1-cp4-observation-prep/1")
    errors.push("schemaVersion must be nir1-cp4-observation-prep/1");
  if (prep.status !== PREP_DRAFT && prep.status !== PREP_FROZEN)
    errors.push(`status must be ${PREP_DRAFT} or ${PREP_FROZEN}`);
  const frozen = prep.status === PREP_FROZEN;
  if (prep.graphRuntimeObservedBeforeAuthoring !== false)
    errors.push("graphRuntimeObservedBeforeAuthoring must be false");
  const { k24, k62, k64 } = prep.contracts ?? {};
  if (k24?.sha256 !== CONTRACTS.k24.sha256 || k24?.path !== CONTRACTS.k24.path)
    errors.push("contracts.k24 must be the K2/4 bytes");
  if (
    k62?.sha256 !== CONTRACTS.k62.sha256 ||
    k62?.freezeCommit !== CONTRACTS.k62.freezeCommit
  )
    errors.push("contracts.k62 must be the K6/2 bytes and freeze commit");
  if (
    k64?.sha256 !== CONTRACTS.k64.sha256 ||
    k64?.draftRef !== CONTRACTS.k64.draftRef ||
    k64?.confirmedCommit !== CONTRACTS.k64.confirmedCommit
  )
    errors.push("contracts.k64 must be the K6/4 bytes");
  referenceErrors(
    errors,
    "contracts.k64.freezeCommit",
    k64?.freezeCommit,
    "commit",
    frozen,
  );
  if (
    prep.references?.g01Fixture?.sha256 !== ctx.g01.sha256 ||
    prep.references?.g01Fixture?.sha256 !== ctx.g01.frozenSha256
  )
    errors.push("references.g01Fixture must be the frozen G-01 fixture sha256");
  freezeReferenceErrors(errors, prep.references?.graphCaseFreeze, ctx);
  referenceErrors(
    errors,
    "candidate.commit",
    prep.candidate?.commit,
    "commit",
    frozen,
  );

  // D1: the same declaration place as both addenda.
  const choices = [
    ctx.setupAddendum?.declarationPlace?.choice,
    ctx.declarationAddendum?.declarationPlace?.choice,
  ];
  if (
    prep.d1?.choice !== "ii" ||
    choices.some((choice) => choice !== prep.d1?.choice)
  )
    errors.push(
      "d1.choice must be ii and equal both addenda's declarationPlace",
    );
  if (
    !same(
      prep.d1?.runs,
      K24_TABLE.map((row) => `${row.caseId}/${row.variantId}`),
    )
  )
    errors.push("d1.runs must be the five K2/4 declaration runs");
  if (
    typeof prep.d2?.rule !== "string" ||
    !prep.d2.rule.includes("nir1-graph-index-build")
  )
    errors.push(
      "d2.rule must establish the B seal through the B-ROUTE journey seam",
    );

  // D10: modes and parity.
  const arms = prep.d10?.arms ?? {};
  if (arms.graph !== "restricted")
    errors.push(
      "d10.arms.graph must be restricted (Graph appears only restricted)",
    );
  for (const arm of ["raw", "hybrid"])
    if (arms[arm] !== "restricted" && arms[arm] !== "unrestricted")
      errors.push(`d10.arms.${arm} must be a D2a mode`);
  if (arms.raw !== arms.hybrid)
    errors.push(
      "d10.arms.raw must equal d10.arms.hybrid (R is the hybrid arm's Raw)",
    );
  const record = prep.d10?.g01?.da1AcceptanceRecord;
  const mode = prep.d10?.g01?.rAndRirMode;
  const recordPlaceholder =
    typeof record === "string" && PLACEHOLDER.test(record);
  if (recordPlaceholder) {
    if (typeof mode !== "string" || !PLACEHOLDER.test(mode))
      errors.push(
        "d10.g01.rAndRirMode must stay a placeholder until da1AcceptanceRecord is filled (S3-P2-4)",
      );
  } else {
    const expectedMode = record === "none" ? "unrestricted" : "restricted";
    if (mode !== expectedMode)
      errors.push(
        `d10.g01.rAndRirMode must be ${expectedMode} when da1AcceptanceRecord is ${record === "none" ? "none" : "a record"} (K6/2 CP-0 (a)/(d))`,
      );
  }
  if (
    prep.d10?.g01?.rAndRirModeRule?.recordPath !== "restricted" ||
    prep.d10?.g01?.rAndRirModeRule?.none !== "unrestricted"
  )
    errors.push(
      "d10.g01.rAndRirModeRule must map a record to restricted and none to unrestricted",
    );
  if (
    typeof record !== "string" ||
    record.trim() === "" ||
    (record.startsWith("S4:") && (!PLACEHOLDER.test(record) || frozen))
  )
    errors.push(
      "d10.g01.da1AcceptanceRecord must be filled (a record path or none) when frozen",
    );
  if (typeof prep.d10?.g01?.fallback !== "string")
    errors.push("d10.g01.fallback is required (K6/2 CP-0 (d))");
  const parity = prep.d10?.parity ?? {};
  if (
    !Number.isInteger(parity.unrestrictedRunsPerVariant) ||
    parity.unrestrictedRunsPerVariant < 1
  )
    errors.push("d10.parity.unrestrictedRunsPerVariant must be at least 1");
  if (!same(parity.variants, PARITY_VARIANTS))
    errors.push(`d10.parity.variants must be ${PARITY_VARIANTS.join(", ")}`);
  for (const key of [
    "run",
    "comparison",
    "countReason",
    "mismatch",
    "fallback",
  ])
    if (typeof parity[key] !== "string" || parity[key].trim() === "")
      errors.push(`d10.parity.${key} is required`);

  // Sample plan (K6/2 step 2).
  const plan = prep.samplePlan ?? {};
  if (
    plan.warmupPerArm !== WARMUP_PER_ARM ||
    plan.measuredPerArm !== MEASURED_PER_ARM ||
    !same(plan.arms, ["hybrid", "graph"]) ||
    plan.order !== "AB/BA" ||
    !same(plan.variants, PLAN_VARIANTS)
  )
    errors.push(
      "samplePlan must be warm-up 5, measured 30, hybrid/graph AB/BA over the 13 variants",
    );
  if (plan.rFrom !== "hybrid-arm-raw" || typeof plan.rRule !== "string")
    errors.push(
      "samplePlan.rFrom must be hybrid-arm-raw with its rRule (S3-P3-5)",
    );

  // R5 gate (S3-P1-1; K6/4 R5 and :317, K2/4 :418-420).
  const gate = prep.r5Gate;
  if (!isObject(gate)) errors.push("r5Gate is required (S3-P1-1)");
  else {
    if (!same([...(gate.blockedUntilMatch ?? [])].sort(), [...R5_GATED].sort()))
      errors.push(`r5Gate.blockedUntilMatch must be ${R5_GATED.join(", ")}`);
    const exempt = Array.isArray(gate.exempt) ? gate.exempt : [];
    if (
      exempt.some((row) => row?.run !== "g-case-parity-unrestricted") ||
      exempt.some((row) => R5_GATED.includes(row?.run))
    )
      errors.push(
        "r5Gate.exempt may name only g-case-parity-unrestricted (no Graph arm)",
      );
    if (gate.k64FreezeAfterMatch !== true)
      errors.push("r5Gate.k64FreezeAfterMatch must be true (K6/4 :317)");
    if (
      typeof gate.onFixtureRevision !== "string" ||
      !gate.onFixtureRevision.includes("レビュー")
    )
      errors.push(
        "r5Gate.onFixtureRevision must require new addendum and trace versions and a new review",
      );
    if (typeof gate.rule !== "string" || typeof gate.check !== "string")
      errors.push("r5Gate.rule and r5Gate.check are required");
  }
  if (
    !Array.isArray(prep.preconditions) ||
    !String(prep.preconditions[0] ?? "").startsWith("r5Gate")
  )
    errors.push("preconditions must start with the r5Gate (S3-P1-1)");

  // Registered tolerance usages (S3-P3-4).
  const tolerance = (prep.registeredForReview ?? []).find(
    (row) => row?.name === "BOUNDARY_TOLERANCE_MS",
  );
  if (
    !same(
      (tolerance?.usages ?? []).map((row) => row.site),
      TOLERANCE_USAGES,
    ) ||
    (tolerance?.usages ?? []).some(
      (row) => typeof row.use !== "string" || row.use.trim() === "",
    )
  )
    errors.push(
      `registeredForReview BOUNDARY_TOLERANCE_MS must list ${TOLERANCE_USAGES.join(", ")}`,
    );

  // Traces: both kinds, the reviewed bytes by commit and sha256.
  const traces = Array.isArray(prep.traces) ? prep.traces : [];
  if (
    !same(
      traces.map((row) => row.kind),
      ["editing", "browsing"],
    )
  )
    errors.push("traces must be the editing and the browsing trace");
  for (const [at, row] of traces.entries()) {
    const file = TRACE_KINDS[row.kind]?.file;
    if (row.path !== file) errors.push(`traces[${at}].path must be ${file}`);
    referenceErrors(
      errors,
      `traces[${at}].commit`,
      row.commit,
      "commit",
      frozen,
    );
    referenceErrors(
      errors,
      `traces[${at}].sha256`,
      row.sha256,
      "sha256",
      frozen,
      ctx.fileSha256[file],
    );
  }

  // K6/4 procedure file.
  const procedure = prep.k64Procedure ?? {};
  if (procedure.draft?.path !== OBSERVATION_PREP_FILES.procedureDraft)
    errors.push(
      `k64Procedure.draft.path must be ${OBSERVATION_PREP_FILES.procedureDraft}`,
    );
  if (!same(procedure.values, ctx.procedureDraft?.values))
    errors.push("k64Procedure.values must equal the procedure file's values");
  for (const key of [...Object.keys(K64_VALUES), "r1r4WaitMs"])
    if (
      typeof procedure.valueReasons?.[key] !== "string" ||
      procedure.valueReasons[key].trim() === ""
    )
      errors.push(`k64Procedure.valueReasons.${key} is required`);
  const formal = procedure.formal ?? {};
  if (formal.version !== "v1" || formal.path !== PROCEDURE_V1)
    errors.push("k64Procedure.formal must be the v1 file");
  referenceErrors(
    errors,
    "k64Procedure.formal.commit",
    formal.commit,
    "commit",
    frozen,
  );
  referenceErrors(
    errors,
    "k64Procedure.formal.sha256",
    formal.sha256,
    "sha256",
    frozen,
  );
  if (frozen) {
    if (ctx.fileSha256[formal.path] === undefined)
      errors.push("k64Procedure.formal: the v1 file is not in the repository");
    else if (formal.sha256 !== ctx.fileSha256[formal.path])
      errors.push("k64Procedure.formal.sha256 differs from the v1 file");
    const review = formal.review;
    if (
      !isObject(review) ||
      typeof review.reviewer !== "string" ||
      typeof review.record !== "string" ||
      !ISO_DATE.test(review.reviewedAt ?? "")
    )
      errors.push("k64Procedure.formal.review must be the v1 file's review");
    const v1 = ctx.procedureFormal;
    const draft = ctx.procedureDraft ?? {};
    if (
      !isObject(v1) ||
      v1.version !== "v1" ||
      v1.draft !== false ||
      v1.schema !== draft.schema ||
      !same(v1.contract, draft.contract) ||
      !same(v1.values, draft.values) ||
      !same(v1.conditions, draft.conditions)
    )
      errors.push(
        "k64Procedure.formal: the v1 file must be the reviewed draft-2 (schema, contract, values, conditions) as version v1, draft false (S3-P2-3)",
      );
    else if (!same(v1.review, review))
      errors.push("k64Procedure.formal.review must equal the v1 file's review");
    if (review?.record !== prep.review?.record)
      errors.push(
        "k64Procedure.formal.review must cite the same independent review record as this record",
      );
  } else if (formal.review !== null)
    errors.push("k64Procedure.formal.review must be null until S3 reviews");

  // Diagnostic runs (K2/4 negatives and K6/2 (iii)).
  const ids = (prep.diagnosticRuns ?? []).map((row) => row.id);
  if (!same(ids, DIAGNOSTIC_IDS))
    errors.push(`diagnosticRuns must be ${DIAGNOSTIC_IDS.join(", ")}`);
  const negatives = [
    ...(ctx.setupAddendum?.diagnosticNegatives ?? []),
    ...(ctx.declarationAddendum?.diagnosticNegatives ?? []),
  ];
  for (const negative of negatives) {
    const row = (prep.diagnosticRuns ?? []).find(
      (run) => run.id === negative.id,
    );
    if (
      !row ||
      row.variant !== `${negative.caseId}/${negative.variantId}` ||
      row.declare !== negative.declare ||
      row.mutationAfterDeclaration !== negative.mutationAfterDeclaration
    )
      errors.push(`diagnosticRuns ${negative.id} must match its addendum row`);
  }

  // Bound files: exactly the five documents (S3-P2-2).
  const boundPaths = (prep.boundFiles ?? []).map((row) => row.path);
  const requiredBound = [
    OBSERVATION_PREP_FILES.setupAddendum,
    OBSERVATION_PREP_FILES.declarationAddendum,
    OBSERVATION_PREP_FILES.traceEditing,
    OBSERVATION_PREP_FILES.traceBrowsing,
    OBSERVATION_PREP_FILES.authorDeclaration,
  ];
  if (!same([...boundPaths].sort(), [...requiredBound].sort()))
    errors.push(`boundFiles must be exactly ${requiredBound.join(", ")}`);
  for (const trace of traces) {
    const bound = (prep.boundFiles ?? []).find(
      (row) => row.path === trace.path,
    );
    if (
      !bound ||
      bound.commit !== trace.commit ||
      bound.sha256 !== trace.sha256
    )
      errors.push(
        `boundFiles ${trace.path} must carry the same commit and sha256 as traces`,
      );
  }
  for (const [at, row] of (prep.boundFiles ?? []).entries()) {
    if (ctx.fileSha256[row.path] === undefined)
      errors.push(
        `boundFiles[${at}].path ${row.path} is not an observation-prep file`,
      );
    referenceErrors(
      errors,
      `boundFiles[${at}].commit`,
      row.commit,
      "commit",
      frozen,
    );
    referenceErrors(
      errors,
      `boundFiles[${at}].sha256`,
      row.sha256,
      "sha256",
      frozen,
      ctx.fileSha256[row.path],
    );
  }

  // Placeholders: documented exactly; none when frozen.
  const { placeholders: listed, ...rest } = prep;
  const used = [...placeholderTokens(rest)].sort();
  const documented = (Array.isArray(listed) ? listed : [])
    .map((row) => row.token)
    .sort();
  for (const token of used)
    if (!PLACEHOLDER.test(token))
      errors.push(`placeholder ${token} is not of the form S4:<name>`);
  if (!same(used, documented))
    errors.push(
      `placeholders must document exactly the placeholders used (${used.join(", ") || "none"})`,
    );
  if (frozen && used.length > 0)
    errors.push(`a frozen record still has placeholder(s) ${used.join(", ")}`);

  if (frozen) {
    const review = prep.review;
    if (
      !isObject(review) ||
      typeof review.reviewer !== "string" ||
      typeof review.record !== "string" ||
      !ISO_DATE.test(review.reviewedAt ?? "") ||
      !HEX64.test(review.recordSha256 ?? "")
    )
      errors.push("review must name the independent review record when frozen");
  } else if (prep.review !== null)
    errors.push("review must be null until S3 reviews");
  return errors;
}

/** The author's declaration (S2 did not read Graph runtime output). */
export function authorDeclarationErrors(declaration) {
  const errors = [];
  if (!isObject(declaration)) return ["author declaration must be an object"];
  if (declaration.schemaVersion !== "nir1-cp4-observation-prep-author/1")
    errors.push("schemaVersion must be nir1-cp4-observation-prep-author/1");
  if (declaration.graphRuntimeOutputObserved !== false)
    errors.push("graphRuntimeOutputObserved must be false");
  if (
    !isObject(declaration.author) ||
    typeof declaration.author.model !== "string"
  )
    errors.push("author.model is required");
  if (typeof declaration.author?.effort !== "string")
    errors.push("author.effort is required");
  if (!ISO_DATE.test(declaration.declaredAt ?? ""))
    errors.push("declaredAt must be an ISO date");
  const rows = Array.isArray(declaration.readFiles)
    ? declaration.readFiles
    : [];
  if (rows.length === 0)
    errors.push("readFiles must list what the author read");
  for (const [at, row] of rows.entries()) {
    if (typeof row?.path !== "string" || row.path.trim() === "")
      errors.push(`readFiles[${at}].path is required`);
    if (!HEX64.test(row?.sha256 ?? ""))
      errors.push(`readFiles[${at}].sha256 must be a sha256`);
    if (FORBIDDEN_READ.some((pattern) => pattern.test(row?.path ?? "")))
      errors.push(
        `readFiles[${at}] ${row.path} is a forbidden (observation) file`,
      );
  }
  if (!Array.isArray(declaration.accidentalReads))
    errors.push("accidentalReads must be a list (empty when none)");
  if (declaration.forbiddenFilesNotRead !== true)
    errors.push("forbiddenFilesNotRead must be true");
  return errors;
}

/** Reads every file the validators compare against. */
export async function loadObservationPrepContext({ repoRoot }) {
  const read = (relative) => readFile(path.join(repoRoot, relative));
  const freezeBytes = await read("evals/nir1-graph/freeze.v1.json");
  const freezeJson = JSON.parse(freezeBytes);
  const frozen = new Map(
    (freezeJson.cases ?? []).map((row) => [row.caseId, row]),
  );
  const fixture = async (caseId) => {
    const entry = frozen.get(caseId);
    const bytes = await read(entry.path);
    return {
      path: entry.path,
      sha256: sha256(bytes),
      frozenSha256: entry.sha256,
      json: JSON.parse(bytes),
    };
  };
  const fixtures = {};
  for (const caseId of frozen.keys()) fixtures[caseId] = await fixture(caseId);
  const fileSha256 = {};
  const parsed = {};
  for (const [name, relative] of Object.entries(OBSERVATION_PREP_FILES)) {
    try {
      const bytes = await read(relative);
      fileSha256[relative] = sha256(bytes);
      parsed[name] = JSON.parse(bytes);
    } catch {
      parsed[name] = null;
    }
  }
  const formal = PROCEDURE_V1;
  let procedureFormal = null;
  try {
    const bytes = await read(formal);
    fileSha256[formal] = sha256(bytes);
    procedureFormal = JSON.parse(bytes);
  } catch {
    // The v1 procedure file is S4's; absent in a draft.
  }
  const productSources = {};
  for (const relative of Object.values(PRODUCT_SOURCES))
    productSources[relative] = (await read(relative)).toString("utf8");
  return {
    freeze: { sha256: sha256(freezeBytes), json: freezeJson },
    g01: fixtures["G-01"],
    fixtures,
    fileSha256,
    productSources,
    setupAddendum: parsed.setupAddendum,
    declarationAddendum: parsed.declarationAddendum,
    procedureDraft: parsed.procedureDraft,
    procedureFormal,
    parsed,
  };
}

/** eval:fixtures: every observation-prep document, draft or frozen. */
export async function validateNir1ObservationPrep({ repoRoot }) {
  const ctx = await loadObservationPrepContext({ repoRoot });
  const errors = [];
  const add = (label, list) =>
    errors.push(...list.map((e) => `${label}: ${e}`));
  for (const [name, relative] of Object.entries(OBSERVATION_PREP_FILES))
    if (ctx.parsed[name] === null)
      errors.push(`${relative} is missing or not JSON`);
  if (errors.length > 0)
    return { status: "failed", errors, formalReady: false, placeholders: [] };
  add(
    OBSERVATION_PREP_FILES.setupAddendum,
    setupAddendumErrors(ctx.parsed.setupAddendum, ctx),
  );
  add(
    OBSERVATION_PREP_FILES.declarationAddendum,
    declarationAddendumErrors(ctx.parsed.declarationAddendum, ctx),
  );
  add(
    OBSERVATION_PREP_FILES.traceEditing,
    traceErrors(ctx.parsed.traceEditing, ctx),
  );
  if (ctx.parsed.traceEditing?.kind !== "editing")
    errors.push(`${OBSERVATION_PREP_FILES.traceEditing}: kind must be editing`);
  add(
    OBSERVATION_PREP_FILES.traceBrowsing,
    traceErrors(ctx.parsed.traceBrowsing, ctx),
  );
  if (ctx.parsed.traceBrowsing?.kind !== "browsing")
    errors.push(
      `${OBSERVATION_PREP_FILES.traceBrowsing}: kind must be browsing`,
    );
  add(
    OBSERVATION_PREP_FILES.procedureDraft,
    procedureDraftErrors(ctx.parsed.procedureDraft),
  );
  add(OBSERVATION_PREP_FILES.prep, observationPrepErrors(ctx.parsed.prep, ctx));
  add(
    OBSERVATION_PREP_FILES.authorDeclaration,
    authorDeclarationErrors(ctx.parsed.authorDeclaration),
  );
  const placeholders = (ctx.parsed.prep?.placeholders ?? []).map(
    (row) => row.token,
  );
  const formalReady =
    errors.length === 0 &&
    placeholders.length === 0 &&
    ctx.parsed.prep?.status === PREP_FROZEN &&
    [
      ctx.parsed.setupAddendum,
      ctx.parsed.declarationAddendum,
      ctx.parsed.traceEditing,
      ctx.parsed.traceBrowsing,
    ].every((document) => document?.status === ADDENDUM_STATUSES[1]);
  return {
    status: errors.length === 0 ? "passed" : "failed",
    errors,
    formalReady,
    placeholders,
  };
}

function gitBlobSha(repoRoot, commit, file) {
  try {
    const bytes = execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return sha256(bytes);
  } catch {
    return null;
  }
}

function isAncestor(repoRoot, ancestor, head) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, head], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The gate a formal CP-4 Graph run passes before its first query: every
 * document frozen and reviewed, no placeholder, and (git) each referenced
 * commit holds the referenced bytes and is an ancestor of `head`.
 */
export async function assertObservationPrepFormal({ repoRoot, head = "HEAD" }) {
  const result = await validateNir1ObservationPrep({ repoRoot });
  if (result.errors.length > 0)
    throw new Error(
      `[precheck] the observation-prep documents are invalid: ${result.errors.join("; ")}`,
    );
  if (!result.formalReady)
    throw new Error(
      `[precheck] the observation-prep record is a draft or keeps placeholder(s) (${result.placeholders.join(", ") || "status"}); a formal run cannot use it`,
    );
  const prep = JSON.parse(
    await readFile(path.join(repoRoot, OBSERVATION_PREP_FILES.prep), "utf8"),
  );
  const references = [
    ...prep.traces,
    ...prep.boundFiles,
    {
      path: prep.k64Procedure.formal.path,
      commit: prep.k64Procedure.formal.commit,
      sha256: prep.k64Procedure.formal.sha256,
    },
  ];
  for (const row of references) {
    if (gitBlobSha(repoRoot, row.commit, row.path) !== row.sha256)
      throw new Error(
        `[precheck] ${row.path} at ${row.commit} is not the referenced bytes`,
      );
    if (!isAncestor(repoRoot, row.commit, head))
      throw new Error(`[precheck] ${row.commit} is not an ancestor of ${head}`);
  }
  return { proceed: true };
}
