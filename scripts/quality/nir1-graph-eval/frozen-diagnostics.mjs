// CP-4 S5-B: 診断（SP-P4、K24-G01-N2〜N4）と receipt の先頭の純粋な部分
// （DR-CP4-O-1〜）。
//
// 正本: S2 の observation-prep（`diagnosticRuns`、`samplePlan`、`traces`、
// `runnerHandoff`）、SP/1 の SP-P4／SP-N7、G-01 の addendum の K24-G01-N2〜N4。
// この module は読むことと判定することだけを持つ（Electron は起動しない）:
//   - S2 の `diagnosticRuns` の SP-P4 と K24-G01-N2〜N4 の行が、観測の前に固定
//     した設計（下の定数）と同じであることの検査。違えば `[precheck]`。
//   - SP-P4: 予定（warm-up 5、measured 30、hybrid だけ、seed なし）、sample の
//     記録（論理 ID、owner の counter の差分）、試行の有効性と取り直し
//     （attemptLimit 2）、同じ workspace の中の一致、両側の比較（SP-N7）、
//     8 variant の要約と Graph arm の前の gate。
//   - K24-G01-N2〜N4: 対象の論理 ID、mutation の種類、測った sample の照合と
//     結果（blocked、inconclusive、not-established、established）。
//   - trace: Q の外の query のうち completed 以外の、理由ごとの数（P-S2-4）。
//   - receipt の先頭（K6/2 の事前登録の凍結 2）: 測定の前に書き、欠けや
//     placeholder なら測定を始めない。
// 閾値、K6/4 の規則、分類器、fixture、S2 の file は変えない。

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { G01_FIXTURE } from "./constants.mjs";
import {
  PARITY_FIELDS,
  compareSeedPinParity,
  seedPinPlanFromFixture,
} from "./seed-pin-setup.mjs";
import { traceRequeries } from "./trace-record.mjs";

function fail(code, detail) {
  throw new Error(`[precheck] S5-B ${code}: ${detail}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const sameList = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  left.every((value, at) => value === right[at]);

const stable = (value) => JSON.stringify(value);
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

// ---- S2 の diagnosticRuns ----------------------------------------------------

/** SP-P4 の設計（S2 の `diagnosticRuns` の SP-P4 の行。観測の前に固定）。 */
export const SP_P4 = deepFreeze({
  id: "SP-P4",
  runKind: "seed-pin-parity",
  arms: ["hybrid"],
  graphArm: false,
  seedSent: false,
  variants: [
    "G-01/v1",
    "G-02/base",
    "G-03/base",
    "G-04/base",
    "G-05/base",
    "G-06/base",
    "G-07/base",
    "G-08/base-usable",
  ],
  sides: ["without-seed-pin-step", "with-seed-pin-step"],
  runsPerSide: 1,
  d2aMode: "restricted",
  branch: "single-pre-step-copy",
  compareBy: "logical-id",
  requiredRecords: [
    "owner-begins-delta-zero",
    "logical-to-runtime-both-sides",
    "d2a-mode-both-sides",
  ],
  attemptLimit: 2,
  /** 各 sample の前後で読む owner の counter（S2 `requiredRecordsRule`）。 */
  counterKeys: ["begins", "cacheHits", "lateCached"],
});

/**
 * K24-G01-N2〜N4（G-01 の addendum の `diagnosticNegatives`）: 宣言の後の
 * mutation と、宣言の前に用意する本文版。
 */
export const G01_NEGATIVES = deepFreeze({
  "K24-G01-N2": {
    mutation: "resave-same-body",
    beforeDeclaration: null,
  },
  "K24-G01-N3": {
    mutation: "restore-same-bytes-body-version",
    beforeDeclaration: "same-bytes-version",
  },
  "K24-G01-N4": {
    mutation: "restore-different-bytes-body-version",
    beforeDeclaration: "draft-then-original",
  },
});

/** N4 の宣言の前の版で本文の末尾に足す文字列（addendum の beforeDeclaration）。 */
export const G01_N4_DRAFT_SUFFIX = " Draft.";

/** S2 の observation-prep の記録から、S5-B が使う診断の plan を読む。 */
export function readDiagnosticPlan(record) {
  const runs = Array.isArray(record?.diagnosticRuns)
    ? record.diagnosticRuns
    : null;
  if (runs === null) fail("plan", "diagnosticRuns is missing");
  const row = runs.filter((entry) => entry?.id === SP_P4.id);
  if (row.length !== 1) fail("plan", "diagnosticRuns has no single SP-P4 row");
  const sp = row[0];
  const problems = [];
  for (const key of [
    "runKind",
    "graphArm",
    "seedSent",
    "runsPerSide",
    "d2aMode",
    "branch",
    "compareBy",
    "attemptLimit",
  ])
    if (sp[key] !== SP_P4[key]) problems.push(key);
  for (const key of ["arms", "variants", "sides", "requiredRecords"])
    if (!sameList(sp[key], SP_P4[key])) problems.push(key);
  const warmup = record?.samplePlan?.warmupPerArm;
  const measured = record?.samplePlan?.measuredPerArm;
  if (warmup !== 5) problems.push("samplePlan.warmupPerArm");
  if (measured !== 30) problems.push("samplePlan.measuredPerArm");
  const g01Negatives = Object.entries(G01_NEGATIVES).map(([id, spec]) => {
    const found = runs.filter((entry) => entry?.id === id);
    if (
      found.length !== 1 ||
      found[0].declare !== true ||
      found[0].variant !== "G-01/v1" ||
      found[0].runKind !== "g-case-diagnostic-negative" ||
      found[0].mutationAfterDeclaration !== spec.mutation
    )
      problems.push(id);
    return { id, ...spec };
  });
  if (problems.length > 0)
    fail(
      "plan",
      `S2 diagnosticRuns differ from the fixed design (${problems.join(", ")}); S2 and DR-CP4-O-1 are read again`,
    );
  return deepFreeze({
    spP4: {
      variants: [...SP_P4.variants],
      sides: [...SP_P4.sides],
      warmup,
      measured,
      attemptLimit: SP_P4.attemptLimit,
      d2aMode: SP_P4.d2aMode,
    },
    g01Negatives,
  });
}

/**
 * SP-P4 の 8 variant の問いの Scene と予定の seed（凍結した fixture から
 * `loadFrozenSeedPinPlan` が読んだ 13 行のうち S2 の範囲）。
 */
export function spP4Targets({ seedPlan }) {
  const rows = SP_P4.variants.map((key) => {
    const row = (seedPlan ?? []).find((entry) => entry?.variantKey === key);
    if (!row) fail("targets", `${key} is not in the frozen seed pin plan`);
    return {
      variantKey: key,
      caseId: row.caseId,
      variantId: row.variantId,
      querySceneId: row.querySceneId,
      seedEntityId: row.seedEntityId,
    };
  });
  return deepFreeze(rows);
}

// ---- SP-P4 ------------------------------------------------------------------

/** 側ごとの予定: warm-up の後に measured（hybrid だけ、seed を渡さない）。 */
export function spP4Schedule({ warmup, measured }) {
  if (!Number.isInteger(warmup) || !Number.isInteger(measured))
    fail("schedule", "warm-up and measured counts are integers");
  return deepFreeze([
    ...Array.from({ length: warmup }, (_, repeat) => ({
      phase: "warmup",
      repeat,
      arm: "hybrid",
      seed: null,
    })),
    ...Array.from({ length: measured }, (_, repeat) => ({
      phase: "measured",
      repeat,
      arm: "hybrid",
      seed: null,
    })),
  ]);
}

/** runtime の Scene ID の列を論理 ID に直す（対応に無ければ比較できない）。 */
export function logicalSceneIds(runtimeIds, scenes) {
  const inverse = new Map(
    Object.entries(scenes ?? {}).map(([logical, runtime]) => [
      runtime,
      logical,
    ]),
  );
  return (runtimeIds ?? []).map((id) => {
    const logical = inverse.get(id);
    if (logical === undefined)
      fail(
        "logical-id",
        `runtime Scene ${String(id)} is not in the setup's logical → runtime map`,
      );
    return logical;
  });
}

function counterBlock(value) {
  const block = {};
  for (const key of SP_P4.counterKeys) {
    if (!Number.isInteger(value?.[key]))
      throw new Error(`[artifact] S5-B: the owner counter ${key} is not read`);
    block[key] = value[key];
  }
  return block;
}

/**
 * One SP-P4 sample: the product fetch without a seed (`measure`), the begin's
 * dense hits and the sparse Scenes of the same query, and the owner counters
 * before and after, with every Scene in logical IDs.
 */
export function spP4SampleRecord({
  phase,
  repeat,
  measure,
  denseHitSceneIds,
  sparseSceneIds,
  before,
  after,
  scenes,
}) {
  const rSceneIds = logicalSceneIds(measure?.rawSceneIds, scenes);
  const rIrSceneIds = logicalSceneIds(measure?.resultSceneIds, scenes);
  const extra = rIrSceneIds.filter((id) => !rSceneIds.includes(id));
  if (extra.length > 1)
    throw new Error(
      `[artifact] S5-B: R+IR adds ${extra.length} Scenes to R (one supplement slot)`,
    );
  const countersBefore = counterBlock(before);
  const countersAfter = counterBlock(after);
  const delta = Object.fromEntries(
    SP_P4.counterKeys.map((key) => [
      key,
      countersAfter[key] - countersBefore[key],
    ]),
  );
  return deepFreeze({
    phase,
    repeat,
    status: measure?.status ?? null,
    // Disclosed, not compared: the IR wait's outcome of this fetch.
    ir: {
      resultKind: measure?.resultKind ?? null,
      outcome: measure?.completion?.outcome ?? null,
      deadlineExceeded: measure?.completion?.deadlineExceeded ?? null,
    },
    rSceneIds,
    denseHitSceneIds: logicalSceneIds(denseHitSceneIds, scenes),
    sparseSceneIds: logicalSceneIds(sparseSceneIds, scenes),
    rIrSceneIds,
    irSupplementSceneId: extra[0] ?? null,
    counters: { before: countersBefore, after: countersAfter, delta },
    beginsDeltaZero: delta.begins === 0,
  });
}

const measuredOf = (samples) =>
  (samples ?? [])
    .filter((row) => row?.phase === "measured")
    .sort((left, right) => left.repeat - right.repeat);

/**
 * An attempt is valid when it holds the whole schedule and every sample's
 * owner `begins` did not move (the Graph was not requested). A sample with a
 * non-zero delta makes the attempt a setup defect (never SP-N7).
 */
export function assessSpP4Attempt({ samples, warmup, measured }) {
  const rows = samples ?? [];
  const invalidSamples = rows
    .filter((row) => row?.beginsDeltaZero !== true)
    .map((row) => ({
      phase: row?.phase ?? null,
      repeat: row?.repeat ?? null,
      beginsDelta: row?.counters?.delta?.begins ?? null,
    }));
  const counts = {
    warmup: rows.filter((row) => row?.phase === "warmup").length,
    measured: rows.filter((row) => row?.phase === "measured").length,
  };
  const complete = counts.warmup === warmup && counts.measured === measured;
  return {
    valid: invalidSamples.length === 0 && complete,
    complete,
    counts,
    invalidSamples,
  };
}

/** S2 `attemptRule`: 1 回目の無効は 1 回だけ取り直し、2 回目の無効は [precheck]。 */
export function spP4AttemptOutcome({
  attempt,
  valid,
  attemptLimit = SP_P4.attemptLimit,
}) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > attemptLimit)
    fail(
      "attempt",
      `an SP-P4 attempt is numbered 1 to ${attemptLimit} (S2 attemptLimit)`,
    );
  if (valid) return "accepted";
  return attempt >= attemptLimit ? "precheck" : "retake";
}

const parityOf = (row) =>
  Object.fromEntries(PARITY_FIELDS.map((field) => [field, row?.[field]]));

/**
 * S2 `comparison`: the measured samples of one workspace agree with each
 * other; otherwise the comparison is undefined (`[precheck]`).
 */
/**
 * DR-CP4-O-7: the SP-P4 comparison rules. `current` is S2's rule as frozen
 * (every measured sample, every field). `ir-complete-pairs` is the
 * integrator's proposed reading (S2／S3 confirm it first): R, the dense hits
 * and the sparse Scenes over every measured sample; R+IR and the supplement
 * slot only over the samples whose IR reached `ir-ready` (both sides, by
 * repeat, for the comparison); a side with no IR-complete measured sample is
 * `[precheck]`. No threshold is introduced.
 */
export const SP_P4_COMPARISON_RULES = Object.freeze([
  "current",
  "ir-complete-pairs",
]);
/** The rule in force (switched only after S2／S3; S2 pins this commit). */
export const SP_P4_COMPARISON_RULE = "current";
const R_SIDE_FIELDS = Object.freeze([
  "rSceneIds",
  "denseHitSceneIds",
  "sparseSceneIds",
]);
const IR_SIDE_FIELDS = Object.freeze(["rIrSceneIds", "irSupplementSceneId"]);
const irReady = (row) => row?.ir?.outcome === "ir-ready";

function checkRule(rule) {
  if (!SP_P4_COMPARISON_RULES.includes(rule))
    fail("rule", `unknown SP-P4 comparison rule ${String(rule)}`);
  return rule;
}

function firstDifference(rows, fields) {
  if (rows.length === 0) return null;
  const pick = (row) =>
    stable(Object.fromEntries(fields.map((field) => [field, row?.[field]])));
  const first = pick(rows[0]);
  const differs = rows.find((row) => pick(row) !== first);
  if (!differs) return null;
  return {
    repeat: differs.repeat,
    reference: rows[0].repeat,
    fields: fields.filter(
      (field) => stable(differs[field]) !== stable(rows[0][field]),
    ),
  };
}

export function assertSpP4WorkspaceStable(
  samples,
  label,
  { rule = SP_P4_COMPARISON_RULE } = {},
) {
  checkRule(rule);
  const rows = measuredOf(samples);
  if (rows.length === 0) fail("stable", `${label}: no measured sample`);
  const ready = rows.filter(irReady);
  if (rule === "ir-complete-pairs" && ready.length === 0)
    fail(
      "stable",
      `${label}: no measured sample reached ir-ready; the IR contribution cannot be compared`,
    );
  const differs =
    rule === "current"
      ? firstDifference(rows, PARITY_FIELDS)
      : (firstDifference(rows, R_SIDE_FIELDS) ??
        firstDifference(ready, IR_SIDE_FIELDS));
  if (differs)
    fail(
      "stable",
      `${label}: measured ${differs.repeat} differs from measured ${differs.reference} in the same workspace (${differs.fields.join(", ")}); the comparison is not defined`,
    );
  return {
    rule,
    measured: rows.length,
    irReady: ready.length,
    irNotReady: rows.length - ready.length,
  };
}

/**
 * DR-CP4-O-7 (a): the IR wait's outcome per sample of one attempt, disclosed
 * apart from the judgement — how many warm-up and measured samples did not
 * reach `ir-ready`, and which.
 */
export function spP4IrDisclosure(samples) {
  const rows = samples ?? [];
  const count = (phase) => {
    const of = rows.filter((row) => row?.phase === phase);
    return {
      samples: of.length,
      notReady: of.filter((row) => row?.ir?.outcome !== "ir-ready").length,
    };
  };
  return {
    warmup: count("warmup"),
    measured: count("measured"),
    notReadySamples: rows
      .filter((row) => row?.ir?.outcome !== "ir-ready")
      .map((row) => ({
        phase: row?.phase ?? null,
        repeat: row?.repeat ?? null,
        outcome: row?.ir?.outcome ?? null,
        deadlineExceeded: row?.ir?.deadlineExceeded ?? null,
        resultKind: row?.ir?.resultKind ?? null,
      })),
  };
}

const R_FIELDS = ["rSceneIds", "denseHitSceneIds", "sparseSceneIds"];

/**
 * DR-CP4-O-7 (b), disclosed apart from the judgement (the `[precheck]` of an
 * unstable workspace stands): whether the measured samples that differ from
 * the first `ir-ready` one are explained by the IR deadline alone — the IR
 * did not reach `ir-ready`, R, the dense hits and the sparse Scenes are the
 * reference's, and R+IR is R with no supplement (only the IR contribution is
 * missing) — and every `ir-ready` sample agrees with the reference.
 */
export function explainSpP4Instability(samples) {
  const measured = measuredOf(samples);
  const ready = measured.filter((row) => row?.ir?.outcome === "ir-ready");
  if (ready.length === 0)
    return {
      explainedByIrDeadline: false,
      reason: "no-ir-ready-sample",
      rows: [],
    };
  const reference = ready[0];
  const same = (row, fields) =>
    fields.every((field) => stable(row[field]) === stable(reference[field]));
  const readyAgree = ready.every((row) => same(row, PARITY_FIELDS));
  const rows = measured
    .filter((row) => !same(row, PARITY_FIELDS))
    .map((row) => {
      const notReady = row?.ir?.outcome !== "ir-ready";
      const rSame = same(row, R_FIELDS);
      const irOnlyMissing =
        row.irSupplementSceneId === null &&
        stable(row.rIrSceneIds) === stable(row.rSceneIds);
      return {
        repeat: row.repeat,
        irOutcome: row?.ir?.outcome ?? null,
        rSame,
        irOnlyMissing,
        explained: notReady && rSame && irOnlyMissing,
      };
    });
  return {
    reference: { repeat: reference.repeat },
    readyAgree,
    differing: rows.length,
    explained: rows.filter((row) => row.explained).length,
    explainedByIrDeadline:
      readyAgree && rows.length > 0 && rows.every((row) => row.explained),
    rows,
  };
}

/** The two sides' measured samples, in order, by logical ID (SP-N7). */
export function compareSpP4Variant({
  variantKey,
  without,
  with: withSide,
  rule = SP_P4_COMPARISON_RULE,
}) {
  checkRule(rule);
  const left = measuredOf(without);
  const right = measuredOf(withSide);
  const differences = [];
  const count = Math.max(left.length, right.length);
  let irPairs = 0;
  for (let at = 0; at < count; at++) {
    const result = compareSeedPinParity({
      caseId: variantKey.split("/")[0],
      variantId: variantKey.split("/")[1],
      before: left[at] ? parityOf(left[at]) : null,
      after: right[at] ? parityOf(right[at]) : null,
    });
    // ir-complete-pairs: the IR fields count only where both sides' IR
    // reached ir-ready; R's fields always count.
    const pairReady = irReady(left[at]) && irReady(right[at]);
    if (pairReady) irPairs += 1;
    const ignored =
      rule === "ir-complete-pairs" && !pairReady
        ? new Set(IR_SIDE_FIELDS)
        : new Set();
    const fields = [
      ...result.differences.map((row) => row.field),
      ...result.missing.map((row) => row.split(".").at(-1)),
    ].filter((field) => !ignored.has(field));
    if (fields.length > 0 || !left[at] || !right[at])
      differences.push({ index: at, fields: [...new Set(fields)] });
  }
  const noPair = rule === "ir-complete-pairs" && irPairs === 0;
  return {
    variantKey,
    rule,
    compared: count,
    irCompletePairs: irPairs,
    same:
      differences.length === 0 &&
      left.length === right.length &&
      count > 0 &&
      !noPair,
    ...(noPair ? { undefinedReason: "no-ir-complete-pair" } : {}),
    differences,
  };
}

const SUMMARIES = new WeakSet();

/**
 * The SP-P4 record over the 8 variants: `passed` only when every variant has
 * one accepted attempt on both sides (restricted, logical → runtime map
 * recorded) and the sides agree; `sp-n7` when any variant differs;
 * `precheck` when a side used its last attempt invalid; else `incomplete`.
 */
export function summarizeSpP4({ variants }) {
  const rows = variants ?? [];
  const problems = [];
  let precheck = false;
  let differing = false;
  for (const key of SP_P4.variants) {
    const row = rows.find((entry) => entry?.variantKey === key);
    if (!row) {
      problems.push(`${key}: missing`);
      continue;
    }
    for (const side of SP_P4.sides) {
      const attempts = row.sides?.[side]?.attempts ?? [];
      const accepted = attempts.filter((entry) => entry?.valid === true);
      if (attempts.some((entry) => entry?.outcome === "precheck"))
        precheck = true;
      if (accepted.length !== 1) problems.push(`${key}:${side}: no accepted`);
      else if (accepted[0].d2aMode !== SP_P4.d2aMode)
        problems.push(`${key}:${side}: d2a mode`);
      else if (!accepted[0].logicalToRuntime?.scenes)
        problems.push(`${key}:${side}: logical → runtime`);
    }
    // Review P2-b: an undefined comparison (no IR-complete pair) is a
    // [precheck], never SP-N7.
    if (row.comparison?.undefinedReason) precheck = true;
    else if (row.comparison?.same === false) differing = true;
    else if (row.comparison?.same !== true)
      problems.push(`${key}: not compared`);
  }
  const extra = rows
    .map((row) => row?.variantKey)
    .filter((key) => !SP_P4.variants.includes(key));
  if (extra.length > 0) problems.push(`not SP-P4 variants: ${extra.join(",")}`);
  const status = differing
    ? "sp-n7"
    : precheck
      ? "precheck"
      : problems.length > 0
        ? "incomplete"
        : "passed";
  const summary = Object.freeze({
    id: SP_P4.id,
    status,
    problems: Object.freeze([...problems]),
    variants: Object.freeze(
      rows.map((row) => ({
        variantKey: row?.variantKey ?? null,
        same: row?.comparison?.same ?? null,
        differences: row?.comparison?.differences?.length ?? null,
      })),
    ),
    notCountedAs: Object.freeze([
      "g01-eval-revision-receipt",
      "k3-parity-run",
      "g-case-parity-unrestricted",
      "case-judgement",
    ]),
  });
  SUMMARIES.add(summary);
  return summary;
}

/**
 * S2 `r5Gate.beforeFirstGatedRun`: no Graph-arm run starts before SP-P4
 * passed. Only a record summarizeSpP4 made in this process is accepted (a
 * runner reads the SP-P4 receipt back and summarizes it again).
 */
export function assertSpP4Passed(summary) {
  if (!SUMMARIES.has(summary))
    fail("gate", "the SP-P4 record is not one summarizeSpP4 made");
  if (summary.status === "sp-n7")
    fail(
      "SP-N7",
      "SP-P4 found a difference between the sides; the seed pin addendum is not used and no Graph-arm run starts (the integrator returns it to the user)",
    );
  if (summary.status !== "passed")
    fail(
      "gate",
      `SP-P4 is ${summary.status} (${summary.problems.join("; ")}); no Graph-arm run starts`,
    );
  return summary;
}

// ---- K24-G01-N2〜N4 ----------------------------------------------------------

/** G-01 の fixture から負例の対象（pin の Scene と Entity、seed、問いの Scene）。 */
export function g01NegativeTargets({ root }) {
  let fixture;
  try {
    const bytes = readFileSync(path.join(root, G01_FIXTURE.path));
    // Review P3 (d): the frozen bytes only.
    if (sha256(bytes) !== G01_FIXTURE.sha256)
      fail("g01", "the G-01 fixture is not the frozen bytes");
    fixture = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (String(error?.message ?? "").startsWith("[precheck]")) throw error;
    fail("g01", "the G-01 fixture cannot be read");
  }
  const [plan] = seedPinPlanFromFixture({ caseId: "G-01", fixture });
  const pins = Array.isArray(fixture?.pins) ? fixture.pins : [];
  if (pins.length !== 1)
    fail("g01", `the G-01 fixture has ${pins.length} pins (one expected)`);
  return deepFreeze({
    caseId: "G-01",
    variantId: "v1",
    sceneId: pins[0].sceneId,
    entityId: pins[0].entryId,
    seedEntityId: plan.seedEntityId,
    querySceneId: plan.querySceneId,
  });
}

/**
 * The result of one negative from its measured Graph-arm samples (logical
 * IDs): `blocked` (the step could not be prepared or B never returned),
 * `inconclusive` (SP-P1 did not match again, a sample did not request the
 * Graph with the seed, or did not reach `g01-mira-entity` — `null` when
 * undetermined, DR-CP4-O-6), `not-established` (g01-mira was returned) or
 * `established`. Never counted in a case judgement.
 */
export function assessG01Negative({
  id,
  blocked = null,
  spP1Recheck,
  samples,
  target = {
    sceneId: "g01-mira",
    seedEntityId: "g01-orin",
  },
}) {
  if (!Object.hasOwn(G01_NEGATIVES, id))
    fail("g01", `${String(id)} is not K24-G01-N2〜N4`);
  const base = {
    id,
    mutation: G01_NEGATIVES[id].mutation,
    countsInCaseJudgement: false,
  };
  if (blocked) return { ...base, outcome: "blocked", blocked, reasons: [] };
  const graph = (samples ?? []).filter(
    (row) => row?.arm === "graph" && row?.phase === "measured",
  );
  const returnedRows = graph.filter((row) =>
    (row.returnedSceneIds ?? []).includes(target.sceneId),
  );
  // Review P2-4: a reached sample that returned the target defeats the
  // negative whatever the other samples are (a product defect is never
  // buried under undetermined samples).
  const defeating = returnedRows.filter(
    (row) =>
      row.frameReached === true && row.seedRequested === target.seedEntityId,
  );
  if (spP1Recheck?.status === "match" && defeating.length > 0)
    return {
      ...base,
      outcome: "not-established",
      reasons: [],
      returnedIn: defeating.map((row) => row.repeat),
    };
  const reasons = [];
  if (spP1Recheck?.status !== "match") reasons.push("sp-p1-recheck");
  if (graph.length === 0) reasons.push("no-measured-graph-sample");
  if (graph.some((row) => row.seedRequested !== target.seedEntityId))
    reasons.push("graph-requested-with-seed");
  if (graph.some((row) => row.frameReached === null))
    reasons.push("g01-mira-entity-reached:undetermined");
  else if (graph.some((row) => row.frameReached !== true))
    reasons.push("g01-mira-entity-reached");
  if (reasons.length > 0) return { ...base, outcome: "inconclusive", reasons };
  return {
    ...base,
    outcome: returnedRows.length > 0 ? "not-established" : "established",
    reasons: [],
    returnedIn: returnedRows.map((row) => row.repeat),
  };
}

// ---- trace: Q の外 ------------------------------------------------------------

/**
 * S2 `navigate.outsideQ.receiptCountByReason` (P-S2-4): the outside-Q
 * fetches (no seed, or another Scene than the query's) counted, and those
 * that did not return `completed` counted by their status (`fetch-failed`
 * for a rejected fetch, `unresolved` for one without a result).
 */
export function outsideQReceiptCountByReason({
  observation,
  parentSeqs,
  querySceneId,
}) {
  const outside = new Set(
    traceRequeries({ observation, parentSeqs, querySceneId })
      .rows.filter((row) => row.kind === "outside-q")
      .map((row) => row.seq),
  );
  const byReason = {};
  let completed = 0;
  for (const fetch of observation?.fetches ?? []) {
    if (!outside.has(fetch.seq)) continue;
    const reason = fetch.failed
      ? "fetch-failed"
      : (fetch.result?.status ?? "unresolved");
    if (reason === "completed") completed += 1;
    else byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return {
    outsideQ: outside.size,
    completed,
    nonCompleted: outside.size - completed,
    byReason,
  };
}

// ---- receipt の先頭 ----------------------------------------------------------

/** 先頭を持つ run の種類と、trace の file の commit と SHA-256 が要るか。 */
export const RUN_HEAD_KINDS = deepFreeze({
  "sp-p4": { traces: true },
  "g01-negative": { traces: true },
  trace: { traces: true },
});
export const RUN_HEAD_FILE = "head.json";
const TRACE_KINDS = ["editing", "browsing"];

function freezeHead(value, label, problems) {
  if (!COMMIT.test(value?.freezeCommit ?? "")) problems.push(`${label}.commit`);
  if (!SHA256.test(value?.sha256 ?? "")) problems.push(`${label}.sha256`);
}

/**
 * K6/2 事前登録の凍結 2: the receipt head written before any measurement —
 * the K6/2 and K6/4 freeze commits and SHA-256, the pre-observation commit
 * and its record's SHA-256, the start time (UTC) and, for a diagnostic or a
 * trace, the trace files' commit and SHA-256 (S2 `tracesRule`). A missing,
 * unreadable or placeholder value is `[precheck]`: the measurement does not
 * start.
 */
export function buildRunHead(input, { now = () => new Date() } = {}) {
  const problems = [];
  const kind = RUN_HEAD_KINDS[input?.kind];
  if (!kind) problems.push("kind");
  freezeHead(input?.k62, "k62", problems);
  freezeHead(input?.k64, "k64", problems);
  if (!COMMIT.test(input?.observationPrep?.commit ?? ""))
    problems.push("observationPrep.commit");
  if (!SHA256.test(input?.observationPrep?.freezeRecordSha256 ?? ""))
    problems.push("observationPrep.freezeRecordSha256");
  let traces = null;
  if (kind?.traces) {
    const rows = Array.isArray(input?.traces) ? input.traces : [];
    const kinds = rows.map((row) => row?.kind);
    if (!sameList([...kinds].sort(), [...TRACE_KINDS].sort()))
      problems.push("traces");
    rows.forEach((row, at) => {
      if (typeof row?.path !== "string" || row.path.length === 0)
        problems.push(`traces[${at}].path`);
      if (!COMMIT.test(row?.commit ?? ""))
        problems.push(`traces[${at}].commit`);
      if (!SHA256.test(row?.sha256 ?? ""))
        problems.push(`traces[${at}].sha256`);
    });
    traces = rows.map(({ kind: traceKind, path: file, commit, sha256 }) => ({
      kind: traceKind,
      path: file,
      commit,
      sha256,
    }));
  }
  let runStartedAtUtc = null;
  try {
    runStartedAtUtc = now().toISOString();
  } catch {
    problems.push("runStartedAtUtc");
  }
  if (problems.length > 0)
    fail(
      "head",
      `the receipt head is not complete (${problems.join(", ")}); the measurement does not start`,
    );
  return deepFreeze({
    kind: input.kind,
    k62: { freezeCommit: input.k62.freezeCommit, sha256: input.k62.sha256 },
    k64: { freezeCommit: input.k64.freezeCommit, sha256: input.k64.sha256 },
    observationPrep: {
      commit: input.observationPrep.commit,
      freezeRecordSha256: input.observationPrep.freezeRecordSha256,
    },
    ...(traces ? { traces } : {}),
    runStartedAtUtc,
  });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Writes `head.json` once (never over an earlier head) before measuring. */
export async function writeRunHead({ runDir, head }) {
  const file = path.join(runDir, RUN_HEAD_FILE);
  const bytes = `${JSON.stringify(head, null, 2)}\n`;
  try {
    await writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    fail("head", `${file} cannot be written (${error?.code ?? error})`);
  }
  return { path: file, sha256: sha256(Buffer.from(bytes)) };
}

/** Reads the head back at the end; its bytes are the ones written first. */
export function readRunHead({ runDir, sha256: expected }) {
  const file = path.join(runDir, RUN_HEAD_FILE);
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    fail("head", `${file} cannot be read`);
  }
  if (sha256(bytes) !== expected)
    fail("head", `${file} changed after it was written`);
  return JSON.parse(bytes.toString("utf8"));
}

/**
 * One file S2 names with its commit and SHA-256 (S4 fills them), read from
 * that commit and checked. `[precheck]` when not filled, unreadable or
 * different.
 */
export function readCommittedFile({ root, entry, label = "file" }) {
  if (!COMMIT.test(entry?.commit ?? "") || !SHA256.test(entry?.sha256 ?? ""))
    fail(
      label,
      `${String(entry?.path)}: the commit and SHA-256 are not filled (S4)`,
    );
  let bytes;
  try {
    bytes = execFileSync("git", ["show", `${entry.commit}:${entry.path}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    fail(label, `${entry.path} cannot be read from ${entry.commit}`);
  }
  if (sha256(bytes) !== entry.sha256)
    fail(label, `${entry.path} at ${entry.commit} is not ${entry.sha256}`);
  return bytes;
}

/** The trace files at the commits S2 `traces` names (S4 fills them). */
export function readTraceFileHeads({ root, traces }) {
  return (traces ?? []).map((row) => {
    readCommittedFile({ root, entry: row, label: "traces" });
    return {
      kind: row.kind,
      path: row.path,
      commit: row.commit,
      sha256: row.sha256,
    };
  });
}

/** A file of the observation-prep `boundFiles` (an array of path, commit, SHA-256). */
export function readBoundFile({ root, record, file }) {
  const rows = Array.isArray(record?.boundFiles) ? record.boundFiles : [];
  const entry = rows.find((row) => row?.path === file);
  if (!entry)
    fail("bound", `${file} is not in the observation-prep boundFiles`);
  const bytes = readCommittedFile({ root, entry, label: "bound" });
  return {
    path: entry.path,
    commit: entry.commit,
    sha256: entry.sha256,
    bytes,
  };
}

/** One recorded sample with its owner counter delta re-derived. */
function rederivedSample(row) {
  const before = row?.counters?.before;
  const after = row?.counters?.after;
  const delta =
    Number.isInteger(before?.begins) && Number.isInteger(after?.begins)
      ? after.begins - before.begins
      : null;
  return { ...row, beginsDeltaZero: delta === 0 };
}

const headBytes = (head) => `${JSON.stringify(head, null, 2)}\n`;

/**
 * S2 `r5Gate.beforeFirstGatedRun`: a Graph-arm run (Gold, a K24 negative, a
 * trace, the V-10 probe) reads the SP-P4 receipt of ④ back and re-derives
 * its result instead of trusting the record (review P2-1): every attempt's
 * validity from the samples' counters before and after and the plan's counts
 * (warm-up 5, measured 30), the attempt numbering and outcomes, each
 * accepted side's stability and the sides' comparison under the rule in
 * force; the run did not stop, its head is the head.json it wrote, its K6/2
 * and K6/4 heads and pre-observation commit are this admission's, and the
 * candidate is this one and clean. Otherwise `[precheck]`.
 */
export function readSpP4Gate({
  file,
  head,
  candidateCommit,
  warmup = 5,
  measured = 30,
  rule = SP_P4_COMPARISON_RULE,
}) {
  let bytes;
  let receipt;
  try {
    bytes = readFileSync(file);
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("gate", `the SP-P4 receipt ${String(file)} cannot be read`);
  }
  if (receipt?.runKind !== SP_P4.runKind || receipt?.preview !== false)
    fail(
      "gate",
      "the SP-P4 receipt is not ④'s record (a preview or another run)",
    );
  if (receipt.stop !== null)
    fail("gate", "the SP-P4 run stopped before its end");
  if (
    typeof receipt.headSha256 !== "string" ||
    sha256(Buffer.from(headBytes(receipt.head))) !== receipt.headSha256
  )
    fail("gate", "the SP-P4 receipt's head is not the head.json it wrote");
  for (const key of ["k62", "k64"])
    if (stable(receipt.head?.[key]) !== stable(head?.[key]))
      fail("gate", `the SP-P4 receipt's ${key} head differs from this run's`);
  if (receipt.head?.observationPrep?.commit !== head?.observationPrep?.commit)
    fail("gate", "the SP-P4 receipt is of another pre-observation commit");
  if (receipt.candidate?.commit !== candidateCommit)
    fail("gate", "the SP-P4 receipt is of another candidate commit");
  if (receipt.candidate?.clean !== true)
    fail("gate", "the SP-P4 run's candidate was not clean");
  if ((receipt.design?.rule ?? "current") !== checkRule(rule))
    fail("gate", "the SP-P4 receipt used another comparison rule");
  const variants = (receipt.variants ?? []).map((row) => {
    const sides = {};
    for (const side of SP_P4.sides) {
      const recorded = row?.sides?.[side]?.attempts ?? [];
      const attempts = recorded.map((entry, at) => {
        const samples = (entry?.samples ?? []).map(rederivedSample);
        const assessment = assessSpP4Attempt({ samples, warmup, measured });
        const outcome = spP4AttemptOutcome({
          attempt: at + 1,
          valid: assessment.valid,
        });
        if (
          entry?.attempt !== at + 1 ||
          entry?.valid !== assessment.valid ||
          entry?.outcome !== outcome
        )
          fail(
            "gate",
            `${String(row?.variantKey)} ${side} attempt ${at + 1}: the recorded validity or outcome is not the samples'`,
          );
        return { ...entry, samples, valid: assessment.valid, outcome };
      });
      if (attempts.findIndex((entry) => entry.valid) !== attempts.length - 1)
        fail(
          "gate",
          `${String(row?.variantKey)} ${side}: the attempts do not end at the one accepted attempt`,
        );
      assertSpP4WorkspaceStable(
        attempts.at(-1).samples,
        `${String(row?.variantKey)}:${side}`,
        { rule },
      );
      sides[side] = { ...row.sides[side], attempts };
    }
    const accepted = (side) => sides[side].attempts.at(-1).samples;
    const comparison = compareSpP4Variant({
      variantKey: String(row?.variantKey),
      without: accepted("without-seed-pin-step"),
      with: accepted("with-seed-pin-step"),
      rule,
    });
    return { ...row, sides, comparison };
  });
  const summary = assertSpP4Passed(summarizeSpP4({ variants }));
  return { summary, receiptSha256: sha256(bytes) };
}

/**
 * Review P3 (e), DR-CP4-O-12: the call site of the frozen attempt ledger. A's
 * ledger (PR #754, `.artifacts/cp4/attempts/<run>.json` written `wx` with
 * `priorAttempts`) is reused after #754 merges; until then no frozen SP-P4
 * or trace attempt starts (`[precheck]`). `ledger({ kind, key })` claims one
 * attempt and returns its record.
 */
export const ATTEMPT_LEDGER = Object.freeze({
  dir: ".artifacts/cp4/attempts",
  source: "PR #754 frozen-k64-admission.mjs / frozen-k64-run.mjs",
});
/**
 * Review P2-c: the ledger key is the attempt's identity, not a run name —
 * SP-P4: the pre-observation commit and the candidate commit; a trace: the
 * trace file's path, commit and SHA-256 and the candidate commit. A new run
 * name never restarts attempt 1 of the same identity.
 */
export function spP4AttemptKey({ prepCommit, candidateCommit }) {
  if (!COMMIT.test(prepCommit ?? "") || !COMMIT.test(candidateCommit ?? ""))
    fail("ledger", "the SP-P4 attempt key needs both commits");
  return `sp-p4:${prepCommit}:${candidateCommit}`;
}
export function traceAttemptKey({ trace, candidateCommit }) {
  if (
    typeof trace?.path !== "string" ||
    !COMMIT.test(trace?.commit ?? "") ||
    !SHA256.test(trace?.sha256 ?? "") ||
    !COMMIT.test(candidateCommit ?? "")
  )
    fail(
      "ledger",
      "the trace attempt key needs the trace file and the candidate",
    );
  return `trace:${trace.path}:${trace.commit}:${trace.sha256}:${candidateCommit}`;
}

export function claimFrozenAttempt({ kind, key, ledger = null }) {
  if (typeof ledger !== "function")
    fail(
      "ledger",
      `${kind} ${key}: the frozen attempt ledger (A's, #754) is wired after it merges; no frozen attempt starts`,
    );
  return ledger({ kind, key });
}
