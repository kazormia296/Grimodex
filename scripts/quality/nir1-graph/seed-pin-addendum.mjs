// CP-4 S1g-B: validator of the SP/1 seed pin addendum
// (draftRef nir1-graph-case-seed-pin-proposal/1, contractId
// graph-case-seed-pin-setup, confirmed 2026-10-27).
//
//   evals/nir1-graph/seed-pin-addendum.v1.json
//
// The addendum adds, outside setupOrder, one step that pins every G-case
// variant's query Scene to the fixture's planned seed through the product's
// upsertScenePin. This module recomputes the rows from the frozen fixtures
// (the planned seed is copied, never chosen), checks the digests of
// freeze.v1.json and every fixture, the placement, the one-pin rule and the
// SP-P1..P5 / SP-N1..N14 table. It never runs Graph, IR, Raw, Electron or
// Native and reads no runtime output; the runtime checks (DB re-read, receipt)
// belong to the setup driver and the run admission.

export const SEED_PIN_ADDENDUM_PATH =
  "evals/nir1-graph/seed-pin-addendum.v1.json";

/**
 * SP/1 bytes (confirmed 2026-10-27 06:47 JST). The bytes live on
 * claude/seed-pin-draft until the integrator places them unedited at `path`
 * on master (S3v2-P3-4). While the file is absent, the addendum must name this
 * constant; once present, eval:fixtures recomputes its SHA-256 (ctx.sp1Sha256)
 * and the file must match it.
 */
export const SP1 = Object.freeze({
  draftRef: "nir1-graph-case-seed-pin-proposal/1",
  contractId: "graph-case-seed-pin-setup",
  path: "docs/plans/nir1-graph-case-seed-pin-proposal-1-draft.md",
  sha256: "8ccdf5345a50ab710a61039e8abd09803086bef3f8337bb83667ea9274b4e547",
});

export const SP_ACCEPTANCE_IDS = Object.freeze([
  ...Array.from({ length: 5 }, (_, at) => `SP-P${at + 1}`),
  ...Array.from({ length: 14 }, (_, at) => `SP-N${at + 1}`),
]);
const STAGES = Object.freeze([
  "addendum-validator",
  "addendum-declaration",
  "setup-runtime",
  "run-admission",
  "diagnostic",
  "synthetic-detection",
]);
/**
 * Negatives this validator detects by recomputing a value or a row set from
 * the fixtures (S3v2-P3-1). The other static fields are declarations: the
 * violation itself is detected at setup or admission.
 */
const STATIC_NEGATIVES = Object.freeze([
  "SP-N1",
  "SP-N2",
  "SP-N3",
  "SP-N8",
  "SP-N9",
  "SP-N11",
  "SP-N14",
]);
const DECLARED_NEGATIVES = Object.freeze([
  "SP-N4",
  "SP-N5",
  "SP-N6",
  "SP-N10",
  "SP-N12",
  "SP-N13",
]);
/** SP/1 :178: shown on synthetic records before observation (S3v2-P2-1). */
export const SYNTHETIC_NEGATIVES = Object.freeze([
  "SP-N1",
  "SP-N2",
  "SP-N3",
  "SP-N4",
  "SP-N5",
  "SP-N9",
  "SP-N10",
  "SP-N11",
  "SP-N12",
  "SP-N13",
]);
const SETUP_ORDER_ANCHOR = "then foreshadows, foreshadow Codex links and pins";
const MAINTENANCE_ANCHOR =
  "Before the first setupTimeline step, enable maintenance";
const STATUSES = Object.freeze([
  "draft-awaiting-independent-review",
  "frozen-after-independent-review",
]);
const HEX64 = /^[0-9a-f]{64}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/u;
const SEED_UTF16_MAX = 200;

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** The rows SP/1 requires, recomputed from the frozen fixtures. */
export function expectedSeedPinRows(ctx) {
  const rows = [];
  for (const caseId of Object.keys(ctx.fixtures).sort()) {
    const fixture = ctx.fixtures[caseId].json;
    const g01 = caseId === "G-01";
    const variants = g01
      ? [{ id: "v1", status: "available" }]
      : (fixture.variants ?? []).map((variant) => ({
          id: variant.id,
          status: variant.expectations?.graph?.status,
        }));
    for (const variant of variants)
      rows.push({
        caseId,
        variantId: variant.id,
        querySceneId: fixture.query?.sceneId,
        seedEntityId: g01
          ? fixture.entitySeed?.id
          : fixture.manualSeed?.entityId,
        seedSource: g01 ? "entitySeed.id" : "manualSeed.entityId",
        placement: g01 ? "g01" : "graph-cases",
        expectedGraph: variant.status,
      });
  }
  return rows;
}

function seedIdErrors(errors, label, id) {
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    id.length > SEED_UTF16_MAX
  )
    errors.push(
      `${label}: the seed id is blank or longer than ${SEED_UTF16_MAX} UTF-16; the product reads no seed (SP-N9)`,
    );
}

export function seedPinAddendumErrors(addendum, ctx) {
  const errors = [];
  if (!isObject(addendum)) return ["seed pin addendum must be an object"];
  if (addendum.schemaVersion !== "nir1-graph-case-seed-pin-addendum/1")
    errors.push("schemaVersion must be nir1-graph-case-seed-pin-addendum/1");
  if (addendum.graphRuntimeObservedBeforeAuthoring !== false)
    errors.push("graphRuntimeObservedBeforeAuthoring must be false");
  if (!STATUSES.includes(addendum.status))
    errors.push(`status must be one of ${STATUSES.join(", ")}`);
  if (addendum.status === STATUSES[1]) {
    const review = addendum.review;
    if (
      !isObject(review) ||
      typeof review.reviewer !== "string" ||
      typeof review.record !== "string" ||
      !ISO_DATE.test(review.reviewedAt ?? "") ||
      !HEX64.test(review.recordSha256 ?? "")
    )
      errors.push("review must name the independent review record when frozen");
  } else if (addendum.review !== null)
    errors.push("review must be null until the independent review");

  const contract = addendum.contract ?? {};
  for (const key of ["draftRef", "contractId", "path", "sha256"])
    if (contract[key] !== SP1[key])
      errors.push(`contract.${key} must be SP/1's ${SP1[key]}`);
  if (
    ctx.sp1Sha256 !== null &&
    ctx.sp1Sha256 !== undefined &&
    ctx.sp1Sha256 !== SP1.sha256
  )
    errors.push(
      `the SP/1 bytes at ${SP1.path} hash to ${ctx.sp1Sha256}, not the confirmed ${SP1.sha256}`,
    );
  if (contract.decision1 !== "A")
    errors.push("contract.decision1 must be A (the confirmed recommendation)");
  if (contract.decision2 !== "include-g01")
    errors.push(
      "contract.decision2 must be include-g01 (SP/1 判断 2 was confirmed as recommended; SP-N14)",
    );

  // SP-N8: digests of freeze.v1.json and every fixture it binds.
  const freeze = addendum.references?.graphCaseFreeze;
  if (
    freeze?.path !== "evals/nir1-graph/freeze.v1.json" ||
    freeze?.sha256 !== ctx.freeze.sha256
  )
    errors.push(
      `references.graphCaseFreeze must be freeze.v1.json with its sha256 ${ctx.freeze.sha256} (SP-N8)`,
    );
  for (const caseId of Object.keys(ctx.fixtures).sort()) {
    const fixture = ctx.fixtures[caseId];
    const reference = addendum.references?.fixtures?.[caseId];
    if (
      !isObject(reference) ||
      reference.path !== fixture.path ||
      reference.sha256 !== fixture.sha256 ||
      reference.sha256 !== fixture.frozenSha256 ||
      reference.fixtureId !== fixture.json.fixtureId
    )
      errors.push(
        `references.fixtures.${caseId} must be ${fixture.path} with its frozen sha256 (SP-N8)`,
      );
  }

  // Rows: every variant once, copied from the fixture (SP-N1, N2, N11, N14).
  const expected = expectedSeedPinRows(ctx);
  const rows = Array.isArray(addendum.seedPins) ? addendum.seedPins : [];
  const keys = rows.map((row) => `${row.caseId}/${row.variantId}`);
  const expectedKeys = expected.map((row) => `${row.caseId}/${row.variantId}`);
  if (!same(keys, expectedKeys))
    errors.push(
      `seedPins must be one row per variant of G-01..G-08 in order (${expectedKeys.join(", ")}; SP-N2, SP-N11, SP-N14)`,
    );
  for (const want of expected) {
    const key = `${want.caseId}/${want.variantId}`;
    const row = rows.find(
      (candidate) => `${candidate.caseId}/${candidate.variantId}` === key,
    );
    if (!row) continue;
    if (row.querySceneId !== want.querySceneId)
      errors.push(
        `${key}: query Scene must be the fixture's ${want.querySceneId}`,
      );
    if (row.seedEntityId !== want.seedEntityId)
      errors.push(
        `${key}: seed must be the fixture's ${want.seedSource} ${want.seedEntityId} (SP-N1)`,
      );
    if (row.seedSource !== want.seedSource)
      errors.push(`${key}: seedSource must be ${want.seedSource}`);
    if (row.placement !== want.placement)
      errors.push(`${key}: placement must be ${want.placement} (SP-N6)`);
    if (row.expectedGraph !== want.expectedGraph)
      errors.push(`${key}: expectedGraph must be ${want.expectedGraph}`);
    seedIdErrors(errors, key, want.seedEntityId);
  }

  // Fixture facts the one-pin rule relies on (SP-N2, SP-N3).
  for (const caseId of Object.keys(ctx.fixtures).sort()) {
    const fixture = ctx.fixtures[caseId].json;
    const query = fixture.query?.sceneId;
    if ((fixture.pins ?? []).some((pin) => pin.sceneId === query))
      errors.push(
        `${caseId}: the fixture already pins its query Scene ${query}; the step would not leave exactly one seed pin (SP-N2, SP-N3)`,
      );
    const seed =
      caseId === "G-01" ? fixture.entitySeed?.id : fixture.manualSeed?.entityId;
    const entities =
      caseId === "G-01"
        ? [fixture.entitySeed?.id, fixture.targetEntity?.id]
        : (fixture.entities ?? []).map((entity) => entity.id);
    if (!entities.includes(seed))
      errors.push(
        `${caseId}: the planned seed ${seed} is not a fixture Entity`,
      );
  }

  // The step (SP-N4, N5, N6, N10).
  const step = addendum.step ?? {};
  if (step.writer !== "upsertScenePin")
    errors.push("step.writer must be upsertScenePin (SP-N4)");
  if (
    !same([...(step.forbiddenWriters ?? [])].sort(), [
      "injected-state",
      "sql",
      "test-only-entry",
    ])
  )
    errors.push(
      "step.forbiddenWriters must be sql, injected-state, test-only-entry (SP-N4)",
    );
  if (step.pinsOnQuerySceneAfterStep !== 1)
    errors.push("step.pinsOnQuerySceneAfterStep must be 1 (SP-N2)");
  if (step.otherPinsUnchanged !== true)
    errors.push("step.otherPinsUnchanged must be true (SP-N5)");
  if (step.fixturePinsUnchanged !== true)
    errors.push("step.fixturePinsUnchanged must be true (SP-N5)");
  if (step.allArmsSameWorkspace !== true)
    errors.push("step.allArmsSameWorkspace must be true (SP-N10)");
  const graphCases = step.placement?.graphCases ?? {};
  if (
    graphCases.after !== SETUP_ORDER_ANCHOR ||
    graphCases.before !==
      "maintenance enabling and the first setupTimeline step" ||
    graphCases.outsideSetupOrder !== true ||
    graphCases.setupTimelineStep !== false ||
    graphCases.measurementPoint !== false
  )
    errors.push(
      "step.placement.graphCases must be right after the foreshadow/pin step, before maintenance and setupTimeline, outside setupOrder (SP-N6)",
    );
  const g01 = step.placement?.g01 ?? {};
  if (
    typeof g01.after !== "string" ||
    !g01.after.includes("g01-mira") ||
    g01.before !== "typed Revision prepare and the B seal" ||
    g01.outsideSetupOrder !== true
  )
    errors.push(
      "step.placement.g01 must be after the g01-mira pin and before typed Revision prepare and the B seal (SP-N6)",
    );
  for (const caseId of Object.keys(ctx.fixtures).sort()) {
    if (caseId === "G-01") continue;
    const order = ctx.fixtures[caseId].json.measurementBoundary?.setupOrder;
    if (
      typeof order !== "string" ||
      !order.includes(SETUP_ORDER_ANCHOR) ||
      !order.includes(MAINTENANCE_ANCHOR) ||
      order.indexOf(SETUP_ORDER_ANCHOR) > order.indexOf(MAINTENANCE_ANCHOR)
    )
      errors.push(
        `${caseId} setupOrder no longer has the seed pin step's anchors`,
      );
  }

  // R5 (SP-N12, N13).
  const r5 = addendum.r5 ?? {};
  if (r5.pinsReadFrom !== "product-db")
    errors.push("r5.pinsReadFrom must be product-db (SP-N13)");
  if (r5.directFetchPreviewNeverJudged !== true)
    errors.push("r5.directFetchPreviewNeverJudged must be true (SP-N12)");
  if (
    typeof r5.check !== "string" ||
    !r5.check.includes("assertSeedPinsBeforeK64")
  )
    errors.push(
      "r5.check must be assertSeedPinsBeforeK64 with the frozen plan",
    );

  // Acceptance table (SP-P1..P5, SP-N1..N14).
  const acceptance = Array.isArray(addendum.acceptance)
    ? addendum.acceptance
    : [];
  for (const id of SP_ACCEPTANCE_IDS) {
    const entry = acceptance.find((row) => row.id === id);
    if (!entry) {
      errors.push(`acceptance is missing ${id}`);
      continue;
    }
    if (typeof entry.check !== "string" || entry.check.trim() === "")
      errors.push(`acceptance ${id} needs its check`);
    if (
      !Array.isArray(entry.stages) ||
      entry.stages.length === 0 ||
      entry.stages.some((stage) => !STAGES.includes(stage))
    )
      errors.push(`acceptance ${id} stages must be from ${STAGES.join(", ")}`);
    if (
      STATIC_NEGATIVES.includes(id) &&
      !entry.stages?.includes("addendum-validator")
    )
      errors.push(`acceptance ${id} is checked by the addendum validator`);
    if (DECLARED_NEGATIVES.includes(id)) {
      if (entry.stages?.includes("addendum-validator"))
        errors.push(
          `acceptance ${id} is a declaration, not detected by the addendum validator (S3v2-P3-1)`,
        );
      if (
        !entry.stages?.includes("addendum-declaration") ||
        !entry.stages?.some(
          (stage) => stage === "setup-runtime" || stage === "run-admission",
        )
      )
        errors.push(
          `acceptance ${id} must be a declaration detected at setup or admission`,
        );
    }
    if (
      SYNTHETIC_NEGATIVES.includes(id) &&
      !entry.stages?.includes("synthetic-detection")
    )
      errors.push(
        `acceptance ${id} must be shown on a synthetic record before observation (SP/1 :178)`,
      );
  }
  if (
    !acceptance
      .find((row) => row.id === "SP-N11")
      ?.stages?.includes("setup-runtime")
  )
    errors.push(
      "acceptance SP-N11 is a runtime fact: SP-P1 in each of the 13 workspaces",
    );
  for (const stage of STAGES)
    if (
      typeof addendum.acceptanceStages?.[stage] !== "string" ||
      addendum.acceptanceStages[stage].trim() === ""
    )
      errors.push(`acceptanceStages.${stage} must say who checks it`);
  if (
    !acceptance
      .find((row) => row.id === "SP-N7")
      ?.stages?.includes("diagnostic")
  )
    errors.push("acceptance SP-N7 must be the SP-P4 diagnostic");
  if (acceptance.length !== SP_ACCEPTANCE_IDS.length)
    errors.push("acceptance must list SP-P1..P5 and SP-N1..N14 once each");
  if (
    typeof addendum.declarationOrder !== "string" ||
    !addendum.declarationOrder.includes("seed の pin の段を先")
  )
    errors.push(
      "declarationOrder must put the seed pin step before the K2/4 declaration step",
    );
  return errors;
}
