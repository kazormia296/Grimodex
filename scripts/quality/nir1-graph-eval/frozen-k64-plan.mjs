// CP-4 S5-A: 凍結した G-case の正式の run の仕様（pure。DR-CP4-N-1〜N-3）。
//
// 凍結の setup の plan（`loadFrozenSetupPlans({stopsAt:"complete"})`、13
// variant）と、S4 の commit から読んだ S2 の値（`observation-prep.v1.json` の
// `samplePlan`、`d1`、`d2`、`d10`、`setupReadings`、宣言の addendum）から、variant
// ごとの run の仕様を導く。食い違えば `[precheck]`。測定の前と query の時点の d2
// の probe、測定の時点の blocked の判定（`BLOCKED_CONTRACT_TABLE`、L-28）、one-shot
// の process の並び、d10 の parity の比較、宣言の段の前後の照合もここに置く。

import { blockedRecord } from "./frozen-setup-driver.mjs";
import {
  GRAPH_EVAL_VARIANTS,
  MEASURED_RUNS_PER_ARM,
  WARMUP_RUNS_PER_ARM,
} from "./constants.mjs";
import { verifySeedPins } from "./seed-pin.mjs";
import { isProductDbPinRead } from "./workspace-db.mjs";

export const ONE_SHOT_RECEIPT_LABEL = "one-shot（index-state-holding）";
export const RUN_KINDS = Object.freeze([
  "steady-state",
  "graph-held-unusable",
  "one-shot",
]);
const CATALOG = Object.freeze(GRAPH_EVAL_VARIANTS.map((row) => row.key));

function fail(detail) {
  throw new Error(`[precheck] S5 ${detail}`);
}

const sameSet = (left, right) =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((value) => right.includes(value));

const keyOf = (row) => `${row.caseId}/${row.variantId}`;

/**
 * The S2 values the runner uses, checked against the contract numbers
 * (warm-up 5, measured 30, AB/BA, R from the hybrid arm, D1 (ii)).
 */
function s2Values(prep) {
  const sample = prep?.samplePlan;
  if (
    sample?.warmupPerArm !== WARMUP_RUNS_PER_ARM ||
    sample?.measuredPerArm !== MEASURED_RUNS_PER_ARM ||
    sample?.order !== "AB/BA" ||
    sample?.rFrom !== "hybrid-arm-raw" ||
    !Array.isArray(sample?.variants) ||
    JSON.stringify(sample.variants) !== JSON.stringify(CATALOG)
  )
    fail(
      "samplePlan: warm-up 5, measured 30, AB/BA, R from the hybrid arm and the 13 variants in catalog order",
    );
  if (prep?.d1?.choice !== "ii") fail("d1: the declaration place is (ii)");
  if (!Array.isArray(prep?.d1?.runs)) fail("d1.runs");
  const readings = prep?.d2?.variantReadings;
  if (
    !Array.isArray(readings?.unchanged) ||
    !Array.isArray(readings?.readAs) ||
    readings.onMismatch !== "blocked:index-state-holding" ||
    !sameSet(readings.checkedAt ?? [], ["before-measurement", "at-query"])
  )
    fail("d2.variantReadings");
  const exceptions = sample.variantExceptions;
  if (!Array.isArray(exceptions)) fail("samplePlan.variantExceptions");
  const specs = prep?.setupReadings?.measurementSpecs;
  if (!specs || typeof specs !== "object")
    fail("setupReadings.measurementSpecs");
  const oneShot = prep?.d10?.parity?.oneShot;
  if (!Array.isArray(oneShot?.variants)) fail("d10.parity.oneShot");
  return { sample, readings, exceptions, specs, oneShot, d10: prep.d10 };
}

function oneShotOf(exception) {
  if (
    exception?.kind !== "one-shot" ||
    exception.warmupProcessesPerArm !== WARMUP_RUNS_PER_ARM ||
    exception.measuredProcessesPerArm !== MEASURED_RUNS_PER_ARM ||
    exception.queriesPerProcess !== 1 ||
    exception.freshColdCopyPerProcess !== true ||
    exception.warmupUsed !== false ||
    exception.maintenanceSeam !== false ||
    exception.preMeasurementQueries !== false ||
    exception.excludeFromDefaultPools !== false ||
    exception.receiptLabel !== ONE_SHOT_RECEIPT_LABEL
  )
    fail(
      "samplePlan.variantExceptions: a one-shot exception is warm-up 5 (unused) and measured 30 processes per arm, 1 query each from a fresh cold copy, no pre-measurement query, kept in the pools",
    );
  return Object.freeze({
    warmupProcessesPerArm: exception.warmupProcessesPerArm,
    measuredProcessesPerArm: exception.measuredProcessesPerArm,
    queriesPerProcess: 1,
    freshColdCopyPerProcess: true,
    warmupUsed: false,
    preMeasurementQueries: false,
    receiptLabel: exception.receiptLabel,
  });
}

/** The declarations of the two addenda by variant key. */
function declarationsOf(addenda) {
  const map = new Map();
  for (const addendum of addenda ?? [])
    for (const row of addendum?.declarations ?? []) {
      const key = keyOf(row);
      if (map.has(key)) fail(`the addenda declare ${key} twice`);
      map.set(key, row.sceneId);
    }
  return map;
}

/** G-01's R and R+IR mode (d10.g01): restricted, unrestricted or unresolved. */
export function g01ModeOf(d10) {
  const mode = d10?.g01?.rAndRirMode;
  const record = d10?.g01?.da1AcceptanceRecord;
  if (mode === "restricted" || mode === "unrestricted") {
    const expected = record === "none" ? "unrestricted" : "restricted";
    if (typeof record !== "string" || record.startsWith("S4:"))
      return { mode: null, reason: "da1AcceptanceRecord-unresolved" };
    if (mode !== expected)
      fail(
        `d10.g01: rAndRirMode ${mode} does not follow da1AcceptanceRecord (${expected})`,
      );
    return { mode, reason: null };
  }
  return { mode: null, reason: "rAndRirMode-unresolved" };
}

/**
 * Each variant's run specification, in catalog order. `plans` are the 13
 * complete setup plans; `prep` the S2 record read at the S4 commit;
 * `addenda` the G-01 and G-02〜G-08 declaration addenda read at the same
 * commit. Every S2 source that names the same fact must agree.
 */
export function formalRunPlan({ plans, prep, addenda }) {
  const { readings, exceptions, specs, oneShot, d10 } = s2Values(prep);
  const list = Array.isArray(plans) ? plans : [];
  if (
    JSON.stringify(list.map((plan) => plan.variantKey)) !==
    JSON.stringify(CATALOG)
  )
    fail("the plans are the 13 complete setup plans in catalog order");
  if (!list.every((plan) => plan.stopsAt === "complete"))
    fail("the plans are complete setup plans");
  const oneShotExceptions = exceptions.filter((row) => row.kind === "one-shot");
  if (oneShotExceptions.length !== exceptions.length)
    fail("samplePlan.variantExceptions names one-shot exceptions only");
  const exceptionOf = new Map();
  for (const row of oneShotExceptions)
    for (const key of row.variants ?? []) {
      if (exceptionOf.has(key))
        fail(`samplePlan.variantExceptions names ${key} twice`);
      exceptionOf.set(key, oneShotOf(row));
    }
  const declared = declarationsOf(addenda);
  const readAs = new Map(
    (readings.readAs ?? []).map((row) => [row.variant, row]),
  );
  if (
    !sameSet([...readings.unchanged, ...readAs.keys()], CATALOG) ||
    readAs.size !== readings.readAs.length
  )
    fail("d2.variantReadings names each of the 13 variants once");
  if (!sameSet(prep.d1.runs, [...declared.keys()]))
    fail("d1.runs and the addenda's declarations name the same runs");
  const g01 = g01ModeOf(d10);
  return Object.freeze(
    list.map((plan) => {
      const key = plan.variantKey;
      const spec = plan.measurementSpec;
      const kind = spec?.kind;
      if (!RUN_KINDS.includes(kind))
        fail(`${key}: the plan's measurement spec kind ${String(kind)}`);
      const point = plan.measurementPoint;
      if (point !== null && specs[point]?.kind !== kind)
        fail(`${key}: setupReadings.measurementSpecs.${point} is not ${kind}`);
      const oneShotSpec = exceptionOf.get(key) ?? null;
      const reading = readAs.get(key) ?? null;
      const inParity = oneShot.variants.includes(key);
      const isOneShot = kind === "one-shot";
      if (
        Boolean(oneShotSpec) !== isOneShot ||
        inParity !== isOneShot ||
        (reading?.oneShot ?? false) !== isOneShot
      )
        fail(
          `${key}: the plan, samplePlan.variantExceptions, d10.parity.oneShot and d2.variantReadings disagree on one-shot`,
        );
      if (
        isOneShot &&
        specs[point]?.measuredProcessesPerArm !== MEASURED_RUNS_PER_ARM
      )
        fail(`${key}: setupReadings.measurementSpecs has no process counts`);
      const declarationScene = declared.get(key) ?? null;
      const planScene = plan.declaration?.sceneId ?? null;
      if (declarationScene !== planScene)
        fail(
          `${key}: the plan declares ${String(planScene)}, the addenda ${String(declarationScene)}`,
        );
      if (
        declarationScene !== null &&
        !plan.runnerSteps?.some((row) => row.phase === "declaration")
      )
        fail(`${key}: the plan has no declaration runner step`);
      const holding = String(point ?? "").startsWith("while-");
      if (holding !== (reading !== null))
        fail(`${key}: a while- variant is read as (d2.variantReadings.readAs)`);
      if (reading) {
        const graphUsable = reading.b === "current";
        if (
          (graphUsable ? "usable" : "unusable") !== plan.indexState?.graph ||
          reading.chronicle !== plan.indexState?.chronicle ||
          reading.maintenanceSeam !== false
        )
          fail(
            `${key}: d2.variantReadings.readAs differs from the plan's indexState`,
          );
      }
      return Object.freeze({
        variantKey: key,
        caseId: plan.caseId,
        variantId: plan.variantId,
        fixturePath: plan.fixturePath,
        fixtureSha256: plan.fixtureSha256,
        measurementPoint: point,
        kind,
        holding,
        indexState: plan.indexState ?? { graph: "usable", chronicle: "usable" },
        declaration: declarationScene ? { sceneId: declarationScene } : null,
        oneShot: oneShotSpec,
        // C5: a one-shot process issues no query before its measured one.
        buildChronicleIndex: !isOneShot,
        readyProbe: !isOneShot,
        g01Mode: plan.caseId === "G-01" ? g01 : null,
      });
    }),
  );
}

/**
 * The one-shot processes of one variant (S2 P-4 (b)): for warm-up then
 * measured, repeat 0.. per arm; an even repeat runs the hybrid process
 * first, an odd one the graph process first (the AB/BA count of orderRule).
 */
export function oneShotProcessSchedule(oneShot) {
  const rows = [];
  for (const [phase, count] of [
    ["warmup", oneShot.warmupProcessesPerArm],
    ["measured", oneShot.measuredProcessesPerArm],
  ])
    for (let repeat = 0; repeat < count; repeat += 1) {
      const arms = repeat % 2 === 0 ? ["hybrid", "graph"] : ["graph", "hybrid"];
      for (const arm of arms)
        rows.push(Object.freeze({ phase, repeat, arm, process: rows.length }));
    }
  return Object.freeze(rows);
}

const clean = (row) =>
  Boolean(row && Number(row.generation) > 0 && row.dirty === false);

/**
 * d2 (DR-CP4-N-3): whether the index state holds before the measurement or
 * at a query. `setupProbe` is the complete setup's measurement point probe
 * (`completeSetup.measurementPoint.probe`); `metadata` the read-only Index
 * metadata of the measurement copy; `indexUsable` the Chronicle query's
 * `initialSnapshot.indexUsable` (before: the Index build's last query, or
 * null when none ran; at-query: the sample's). Returns `{ ok }` or the
 * blocked record of the setup's naming rule.
 */
export function d2ProbeCheck({ spec, setupProbe, metadata, indexUsable, at }) {
  if (!["before-measurement", "at-query"].includes(at))
    fail(`d2: unknown probe time ${String(at)}`);
  const bGeneration = setupProbe?.bGeneration ?? null;
  const b = metadata?.b ?? null;
  const c = metadata?.chronicle ?? null;
  const sameB = b !== null && Number(b.generation) === bGeneration;
  let graphOk = true;
  let chronicleOk;
  const want = spec.indexState;
  if (at === "before-measurement") {
    graphOk =
      want.graph === "usable"
        ? sameB && b.dirty === false
        : // B not current: dirty; the held one keeps the setup's generation.
          b !== null &&
          b.dirty === true &&
          (spec.measurementPoint !== "while-graph-index-unusable" || sameB);
    // A usable C is clean and, where the process built it through the
    // query route, its last query's snapshot was usable.
    chronicleOk =
      want.chronicle === "usable"
        ? clean(c) &&
          (spec.buildChronicleIndex
            ? indexUsable === true
            : indexUsable !== false)
        : c !== null && c.dirty === true;
  } else
    chronicleOk =
      want.chronicle === "usable"
        ? indexUsable === true
        : indexUsable === false;
  const probe = {
    at,
    graph: graphOk
      ? want.graph
      : want.graph === "usable"
        ? "unusable"
        : "usable",
    chronicle: chronicleOk
      ? want.chronicle
      : want.chronicle === "usable"
        ? "unusable"
        : "usable",
    metadata: metadata ?? null,
    indexUsable: indexUsable ?? null,
    setupBGeneration: bGeneration,
  };
  if (graphOk && chronicleOk) return { ok: true, probe };
  const blocked = spec.holding
    ? {
        harnessId: "index-state-holding",
        condition: "while-variant",
        unmet: ["index-state-holding"],
      }
    : {
        harnessId: "measurement-point-mismatch",
        condition: graphOk ? "chronicle-only" : "graph",
        unmet: graphOk ? [] : ["b-sealed-binding"],
      };
  return { ok: false, probe, blocked };
}

/**
 * The receipt's blocked record of a measurement-time mismatch or of a setup
 * that stopped blocked: the harness's name and condition as they are, and
 * the case judgement of BLOCKED_CONTRACT_TABLE for the plan (G-01 has its
 * own column). A pair the table does not name is `[precheck]`.
 */
export function blockedJudgement({ plan, blocked, recorded = null }) {
  const record = blockedRecord({ plan, blocked });
  if (
    recorded !== null &&
    (recorded.harnessId !== record.harnessId ||
      recorded.condition !== record.condition ||
      (recorded.contractBlockedId ?? null) !== record.contractBlockedId ||
      Boolean(recorded.hold) !== record.hold)
  )
    fail(
      `${plan.variantKey}: the setup receipt's blocked judgement differs from BLOCKED_CONTRACT_TABLE`,
    );
  return record;
}

/**
 * SP-P1 again on the measurement copy (⑤): the copy's own read of the query
 * Scene's pins must match the gate's row (the same runtime Scene and seed,
 * exactly one pin).
 */
export function measurementCopySeedCheck({ gateRow, read }) {
  if (!isProductDbPinRead(read))
    fail("R5: the measurement copy's pins are read from its DB");
  if (read.source.sceneId !== gateRow?.querySceneId)
    fail("R5: the measurement copy's read is of another Scene");
  const result = verifySeedPins([
    {
      caseId: gateRow.caseId,
      variantId: gateRow.variantId,
      querySceneId: gateRow.querySceneId,
      expectedSeed: gateRow.expectedSeed,
      read,
    },
  ]);
  if (result.status !== "match")
    fail(
      `R5: the measurement copy's query Scene pin is ${result.rows[0]?.status} (SP-P1 on ⑤)`,
    );
  return result.rows[0];
}

/**
 * K2/4 (S3-P3-6): the tree order, the registry, every Scene's v1 columns and
 * the A1 columns are the same before and after the declaration step.
 */
export function declarationInvariantCheck({ before, after }) {
  const differ = Object.keys({ ...before, ...after }).filter(
    (key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]),
  );
  if (differ.length > 0)
    fail(
      `K2/4: the declaration step changed ${differ.join(", ")} (the declaration writer writes none of them)`,
    );
  return { same: true, keys: Object.keys(before ?? {}) };
}

/**
 * d10: the restricted R and R+IR samples (the hybrid arm's measured rows)
 * against the unrestricted run's measured rows: every pair has the same R
 * (`rawSceneIds`) and R+IR (`finalSceneIds`) membership and order. The
 * unrestricted rows must agree among themselves, else `[precheck]`.
 */
export function parityComparison({ restricted, unrestricted }) {
  const measured = (rows) =>
    (rows ?? []).filter(
      (row) => row.arm === "hybrid" && row.phase === "measured",
    );
  const lists = (row) =>
    JSON.stringify([row.rawSceneIds ?? null, row.finalSceneIds ?? null]);
  const reference = measured(unrestricted);
  if (reference.length !== MEASURED_RUNS_PER_ARM)
    fail("d10: the unrestricted run has 30 measured R+IR samples");
  const references = new Set(reference.map(lists));
  if (references.size !== 1)
    fail(
      "d10: the unrestricted samples differ among themselves; the comparison is undefined",
    );
  const [want] = references;
  const rows = measured(restricted);
  const mismatches = rows
    .filter((row) => lists(row) !== want)
    .map((row) => row.repeat);
  return {
    status: mismatches.length === 0 && rows.length > 0 ? "match" : "mismatch",
    compared: rows.length,
    mismatches,
  };
}

/**
 * A dev graph-case plan's run specification (the shape check; preview
 * only). The same fields as `formalRunPlan` from the plan alone: no S2
 * cross-check, the contract counts for a one-shot variant.
 */
export function devRunSpec(plan) {
  if (plan?.fixtureKind !== "dev")
    fail("devRunSpec takes a dev graph-case plan only");
  const kind = plan.measurementSpec?.kind;
  if (!RUN_KINDS.includes(kind))
    fail(
      `${plan.variantKey}: the plan's measurement spec kind ${String(kind)}`,
    );
  const isOneShot = kind === "one-shot";
  const point = plan.measurementPoint;
  return Object.freeze({
    variantKey: plan.variantKey,
    caseId: plan.caseId,
    variantId: plan.variantId,
    fixturePath: plan.fixturePath,
    fixtureSha256: plan.fixtureSha256,
    measurementPoint: point,
    kind,
    holding: String(point ?? "").startsWith("while-"),
    indexState: plan.indexState ?? { graph: "usable", chronicle: "usable" },
    declaration: plan.declaration?.sceneId
      ? { sceneId: plan.declaration.sceneId }
      : null,
    oneShot: isOneShot
      ? Object.freeze({
          warmupProcessesPerArm: WARMUP_RUNS_PER_ARM,
          measuredProcessesPerArm: MEASURED_RUNS_PER_ARM,
          queriesPerProcess: 1,
          freshColdCopyPerProcess: true,
          warmupUsed: false,
          preMeasurementQueries: false,
          receiptLabel: ONE_SHOT_RECEIPT_LABEL,
        })
      : null,
    buildChronicleIndex: !isOneShot,
    readyProbe: !isOneShot,
    g01Mode: null,
  });
}
