// CP-4 S1g-A: SP/1 の seed の pin の段（DR-CP4-G-*）。
//
// 契約: draftRef `nir1-graph-case-seed-pin-proposal/1`、contractId
// `graph-case-seed-pin-setup`、SHA-256 8ccdf534…e547（2026-10-27 06:47 JST に
// ユーザーが推奨のまま確認。G-01 を含む）。凍結した G-01〜G-08 の fixture は問いの
// Scene に pin を持たないので、製品の seed（問いの Scene の最初の pin）が null に
// なる。setup に、問いの Scene から予定の seed の Entity への pin を 1 つ、製品の
// renderer の API `upsertScenePin` だけで足す段を置く（`setupOrder` の外の 1 段。
// `setupTimeline` の step にも `measurementPoint` にも数えない）。
//
// この module が持つもの:
//   - plan: fixture の宣言から、case と variant ごとの問いの Scene と予定の seed
//     の論理 ID（`manualSeed.entityId`、G-01 は `entitySeed.id`）を写す。harness
//     は選ばない。S1g-B の addendum の file に依らない形（疎結合。S4 が結線する）。
//   - 段: `upsertScenePin` を 1 回だけ呼び、前後の状態を記録する（書込みと読取は
//     呼出し側の deps。setup-driver.mjs が renderer の API で渡す）。
//   - 受入れの判定: SP-P1、SP-P2（SP-N1〜N5、N8、N9）、置き場（SP-N6、N14）、
//     pin あり／なしの R と R+IR の比較（SP-P4、SP-N7。診断の道具）、arm の
//     pin の集合（SP-N10）、Graph の arm に seed が載ったこと（SP-P5）、凍結の
//     bytes（SP-N8）。どれも違反は `[precheck]`（この段を使った評価をしない）。
// SP-N11、N13、N14 の R5 の側は seed-pin.mjs、SP-N12 は receipt.mjs の
// runnerKind の検査が受け持つ。
//
// SQL の書込み、注入した状態、試験専用の入口は使わない。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FROZEN_FIXTURE_SHA256,
  GRAPH_CASE_FREEZE,
  GRAPH_EVAL_VARIANTS,
} from "./constants.mjs";
import { productSeedOf } from "./seed-pin.mjs";

export const SP1_CONTRACT = Object.freeze({
  draftRef: "nir1-graph-case-seed-pin-proposal/1",
  contractId: "graph-case-seed-pin-setup",
  sha256: "8ccdf5345a50ab710a61039e8abd09803086bef3f8337bb83667ea9274b4e547",
});
export const SEED_PIN_WRITER = "upsertScenePin";
export const SEED_PIN_PHASE = "seed-pin";
export const SEED_PIN_RECORD_SCHEMA = "nir1-cp4-seed-pin-step/1";
/** SP/1「設計」の置き場。 */
export const SEED_PIN_ANCHORS = Object.freeze({
  graphCase:
    "after-foreshadows-links-and-pins-before-maintenance-and-setup-timeline",
  g01: "after-the-only-pin-before-typed-revision-and-b-seal",
});
/** The freeze record's other bound files (SP/1「変えないもの」). */
export const FREEZE_EXTRA_FILES = Object.freeze({
  manifestSha256: "evals/nir1-graph/manifest.v1.json",
  schemaSha256: "evals/nir1-graph/schema.v1.json",
  readmeSha256: "evals/nir1-graph/README.md",
});
/**
 * The Scene Scope binding's v1 columns (`narrative_scene_scope_bindings`
 * before the K2/4 body declaration columns), compared before and after the
 * step (SP-P2).
 */
export const SCENE_SCOPE_BINDING_V1_COLUMNS = Object.freeze([
  "scene_incarnation_id",
  "compatibility_marker",
  "query_identity_json",
  "material_constraint_json",
  "knowledge_holder_json",
  "audience_json",
  "version",
  "source_token",
  "updated_at",
]);
const SEED_UTF16_MAX = 200;

function fail(code, detail) {
  throw new Error(`[precheck] SP/1 ${code}: ${detail}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const nonBlank = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= SEED_UTF16_MAX;

/**
 * The seed pin plan of one fixture: one row per variant (G-01 has `v1`),
 * with the query Scene and the planned seed copied from the fixture
 * (`manualSeed.entityId`; G-01 `entitySeed.id`). The harness never picks a
 * seed: a fixture that does not declare one is `[precheck]`.
 */
export function seedPinPlanFromFixture({ caseId, fixture }) {
  const querySceneId = fixture?.query?.sceneId;
  if (!nonBlank(querySceneId))
    fail("plan", `${caseId} declares no query Scene`);
  const g01 = caseId === "G-01";
  const declared = g01 ? fixture?.entitySeed : fixture?.manualSeed;
  const seedEntityId = g01 ? declared?.id : declared?.entityId;
  if (declared?.manualSeed !== true || !nonBlank(seedEntityId))
    fail(
      "plan",
      `${caseId} declares no manual seed (${g01 ? "entitySeed.id" : "manualSeed.entityId"}); the harness does not choose one`,
    );
  const variants = g01
    ? ["v1"]
    : (Array.isArray(fixture.variants) ? fixture.variants : []).map(
        (row) => row?.id,
      );
  if (variants.length === 0 || !variants.every(nonBlank))
    fail("plan", `${caseId} declares no variant`);
  return variants.map((variantId) => ({
    caseId,
    variantId,
    variantKey: `${caseId}/${variantId}`,
    querySceneId,
    seedEntityId,
    anchor: g01 ? SEED_PIN_ANCHORS.g01 : SEED_PIN_ANCHORS.graphCase,
  }));
}

function sha256File(root, file) {
  try {
    return createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex");
  } catch {
    return null;
  }
}

/**
 * SP-N8: the frozen bytes (the freeze record, the eight fixtures, the
 * manifest, schema, README and the independent review it binds) are the
 * freeze's. Reads digests only; `[precheck]` on any difference.
 */
export function assertFrozenSetupBytes({ root }) {
  const files = {
    [GRAPH_CASE_FREEZE.path]: GRAPH_CASE_FREEZE.sha256,
    ...FROZEN_FIXTURE_SHA256,
  };
  const differs = [];
  if (sha256File(root, GRAPH_CASE_FREEZE.path) !== GRAPH_CASE_FREEZE.sha256)
    differs.push(GRAPH_CASE_FREEZE.path);
  else {
    const freeze = JSON.parse(
      readFileSync(path.join(root, GRAPH_CASE_FREEZE.path), "utf8"),
    );
    for (const row of freeze.cases ?? [])
      if (FROZEN_FIXTURE_SHA256[row.path] !== row.sha256)
        differs.push(`${row.path} (freeze record)`);
    for (const [key, file] of Object.entries(FREEZE_EXTRA_FILES))
      files[file] = freeze[key];
    files[freeze.reviewReceipt] = freeze.reviewReceiptSha256;
  }
  for (const [file, digest] of Object.entries(files))
    if (file !== GRAPH_CASE_FREEZE.path && sha256File(root, file) !== digest)
      differs.push(file);
  if (differs.length > 0)
    fail("SP-N8", `frozen bytes differ from the freeze: ${differs.join(", ")}`);
  return { ok: true, files };
}

/**
 * The 13 variants' seed pin plan from the frozen fixtures, after the bytes
 * are checked (SP-N8). Reads the declared query Scene, seed and variants
 * only; nothing runs on the frozen material.
 */
export function loadFrozenSeedPinPlan({ root }) {
  assertFrozenSetupBytes({ root });
  const byCase = new Map();
  for (const variant of GRAPH_EVAL_VARIANTS) {
    if (byCase.has(variant.caseId)) continue;
    const fixture = JSON.parse(
      readFileSync(path.join(root, variant.fixturePath), "utf8"),
    );
    byCase.set(
      variant.caseId,
      seedPinPlanFromFixture({ caseId: variant.caseId, fixture }),
    );
  }
  const rows = GRAPH_EVAL_VARIANTS.map((variant) => {
    const row = byCase
      .get(variant.caseId)
      .find((candidate) => candidate.variantId === variant.variantId);
    if (!row) fail("plan", `${variant.key} is not a variant of its fixture`);
    return row;
  });
  return deepFreeze(rows);
}

/** A fixture's `pins` with the setup's runtime IDs (SP-P2's baseline). */
export function fixturePinsRuntime(fixture, ids) {
  return (fixture?.pins ?? []).map((pin) => ({
    sceneId: ids?.scenes?.[pin.sceneId] ?? pin.sceneId,
    entryId: ids?.entities?.[pin.entryId ?? pin.entityId] ?? null,
  }));
}

/**
 * The seed pin step of one variant workspace: reads the state, calls the
 * product writer `upsertScenePin` once (query Scene → the planned seed's
 * runtime ID), reads the state again and returns the record (SP/1「設計」の
 * 「記録」). `deps.readState()` and `deps.upsertScenePin()` are the
 * caller's (setup-driver.mjs: the renderer API and SELECT read-backs).
 */
export async function runSeedPinStep({ plan, ids, deps, phase = () => {} }) {
  const querySceneRuntime = ids?.scenes?.[plan.querySceneId];
  const seedRuntime = ids?.entities?.[plan.seedEntityId];
  if (!nonBlank(querySceneRuntime) || !nonBlank(seedRuntime))
    fail(
      "plan",
      `${plan.variantKey}: the setup maps no runtime ID to the query Scene or the planned seed`,
    );
  const before = await deps.readState();
  await deps.upsertScenePin({
    sceneId: querySceneRuntime,
    entryId: seedRuntime,
  });
  const after = await deps.readState();
  const written = (after?.queryScenePins ?? []).find(
    (pin) => pin.entryId === seedRuntime,
  );
  const record = {
    schema: SEED_PIN_RECORD_SCHEMA,
    contract: { ...SP1_CONTRACT },
    caseId: plan.caseId,
    variantId: plan.variantId,
    anchor: plan.anchor,
    querySceneId: { logical: plan.querySceneId, runtime: querySceneRuntime },
    seed: { logical: plan.seedEntityId, runtime: seedRuntime },
    writer: SEED_PIN_WRITER,
    createdAt: written?.createdAt ?? null,
    before,
    after,
    countedAsSetupTimelineStep: false,
    countedAsMeasurementPoint: false,
  };
  phase(SEED_PIN_PHASE, { caseId: plan.caseId, variantId: plan.variantId });
  return record;
}

const pinKey = (pin) => `${pin.sceneId}\u0000${pin.entryId}`;
const pinSet = (pins) => new Set((pins ?? []).map(pinKey));
const sameSet = (left, right) =>
  left.size === right.size && [...left].every((key) => right.has(key));
const stable = (value) => JSON.stringify(value ?? null);

/**
 * SP-P1 and SP-P2 on one step record: the findings (`SP-Nn:detail` or
 * `SP-P2:detail`), empty when the step holds. `fixturePins` is the fixture's
 * pins with runtime IDs.
 */
export function assessSeedPinStep(record, { fixturePins }) {
  const findings = [];
  const add = (code, detail) => findings.push(`${code}:${detail}`);
  const seed = record?.seed?.runtime;
  const query = record?.querySceneId?.runtime;
  if (record?.writer !== SEED_PIN_WRITER)
    add("SP-N4", `writer ${String(record?.writer)}`);
  else if (
    typeof record?.createdAt !== "string" &&
    (record?.after?.queryScenePins ?? []).some((pin) => pin.entryId === seed)
  )
    add("SP-N4", "the written pin's created_at is not recorded");
  if (record?.countedAsSetupTimelineStep !== false)
    add("SP-N8", "counted as a setupTimeline step");
  if (record?.countedAsMeasurementPoint !== false)
    add("SP-N8", "counted as the measurementPoint");
  const pins = record?.after?.queryScenePins ?? [];
  const productSeed = Array.isArray(pins)
    ? productSeedOf({
        sceneLive: record?.after?.queryScene?.live === true,
        pins,
      })
    : null;
  if (pins.length === 0) add("SP-N1", "no pin on the query Scene");
  else if (pins.length === 1 && pins[0].entryId !== seed)
    add("SP-N1", `the pin is ${pins[0].entryId}, not the planned seed`);
  if (pins.length > 1) add("SP-N2", `${pins.length} pins on the query Scene`);
  if (
    pins.length > 1 &&
    productSeed !== seed &&
    pins.some((pin) => pin.entryId === seed)
  )
    add("SP-N3", "the first pin is another Entity");
  if (pins.length === 1 && pins[0].entryId === seed && productSeed !== seed)
    add(
      "SP-N9",
      "the product reads no seed (archived Scene, other project or blank ID)",
    );
  // SP-N5: nothing changes outside the query Scene, before or after.
  const fixture = pinSet(fixturePins);
  const outside = (list) =>
    new Set(
      [...pinSet(list)].filter((key) => !key.startsWith(`${query}\u0000`)),
    );
  if (!sameSet(pinSet(record?.before?.workspacePins), fixture))
    add("SP-N5", "the workspace pins before the step are not the fixture's");
  else if (!sameSet(outside(record?.after?.workspacePins), fixture))
    add("SP-N5", "a pin outside the query Scene changed");
  // SP-P2: the query Scene's tree_nodes version / updated_at and its Scene
  // Scope binding v1 columns do not change.
  const node = (side) => ({
    version: record?.[side]?.queryScene?.version,
    updatedAt: record?.[side]?.queryScene?.updatedAt,
  });
  if (stable(node("before")) !== stable(node("after")))
    add("SP-P2", "query-scene-changed");
  if (
    stable(record?.before?.sceneScopeBinding) !==
    stable(record?.after?.sceneScopeBinding)
  )
    add("SP-P2", "scene-scope-binding-changed");
  return { ok: findings.length === 0, findings };
}

export function assertSeedPinStep(record, options) {
  const result = assessSeedPinStep(record, options);
  if (!result.ok)
    fail(
      result.findings.map((row) => row.split(":")[0]).join(","),
      `${record?.caseId}/${record?.variantId}: ${result.findings.join("; ")} (the evaluation does not use this workspace)`,
    );
  return result;
}

/**
 * The setup receipt's check of the step: its place among the recorded
 * phases (SP-N6, SP-N14) and its record (SP-P1, SP-P2). `[precheck]` on any
 * finding; returns the summary the setup receipt keeps.
 */
export function assertSeedPinSetup({ phases, record, fixturePins }) {
  const placement = assertSeedPinPlacement({ phases, anchor: record?.anchor });
  assertSeedPinStep(record, { fixturePins });
  return {
    ok: true,
    contract: { ...SP1_CONTRACT },
    caseId: record.caseId,
    variantId: record.variantId,
    placementIndex: placement.index,
  };
}

const AFTER_THE_STEP = [
  /^maintenance-enabled$/u,
  /^setup-timeline(:|$)/u,
  /^typed-revisions$/u,
  /^b-seal$/u,
  /^graph-arm(:|$)/u,
  /^measure(:|$)/u,
];

/**
 * SP-N6 / SP-N14: the step's place in the recorded setup phases. G-02〜G-08:
 * right after the pins phase (the last of foreshadows, foreshadow links and
 * pins), before maintenance and the first setupTimeline step. G-01: after
 * the only pin, before the typed Revision prepare and the B seal. Exactly
 * once, and never after any Graph-arm observation.
 */
export function assertSeedPinPlacement({ phases, anchor }) {
  const names = Array.isArray(phases) ? phases : [];
  const at = names.flatMap((name, index) =>
    name === SEED_PIN_PHASE ? [index] : [],
  );
  if (at.length === 0)
    fail(
      anchor === SEED_PIN_ANCHORS.g01 ? "SP-N14" : "SP-N6",
      "the seed pin step is missing",
    );
  if (at.length > 1) fail("SP-N6", "the seed pin step ran more than once");
  const index = at[0];
  const before = names.slice(0, index);
  if (before.some((name) => AFTER_THE_STEP.some((rule) => rule.test(name))))
    fail(
      "SP-N6",
      `the seed pin step comes after ${before.filter((name) => AFTER_THE_STEP.some((rule) => rule.test(name))).join(", ")}`,
    );
  if (anchor === SEED_PIN_ANCHORS.graphCase) {
    if (names[index - 1] !== "pins")
      fail("SP-N6", "the seed pin step is not right after the pins phase");
    if (!names.slice(index + 1).includes("maintenance-enabled"))
      fail("SP-N6", "maintenance is not enabled after the seed pin step");
  } else if (anchor === SEED_PIN_ANCHORS.g01) {
    if (!before.includes("pins"))
      fail("SP-N6", "the seed pin step comes before G-01's only pin");
  } else fail("SP-N6", `unknown anchor ${String(anchor)}`);
  return { ok: true, index };
}

/** SP-P4's compared fields (R, the dense and sparse Scene order, R+IR). */
export const PARITY_FIELDS = Object.freeze([
  "rSceneIds",
  "denseHitSceneIds",
  "sparseSceneIds",
  "rIrSceneIds",
  "irSupplementSceneId",
]);

const parityValueOk = (field, value) =>
  field === "irSupplementSceneId"
    ? value === null || typeof value === "string"
    : Array.isArray(value) && value.every((row) => typeof row === "string");

/**
 * SP-P4 / SP-N7: the R and R+IR of the same seedless query on the workspace
 * copy before the seed pin step and the copy after it (a diagnostic; the
 * Graph arm does not run). Returns the receipt's `seedPinParity` record.
 */
export function compareSeedPinParity({ caseId, variantId, before, after }) {
  const missing = [];
  const differences = [];
  for (const [side, value] of [
    ["before", before],
    ["after", after],
  ])
    for (const field of PARITY_FIELDS)
      if (!parityValueOk(field, value?.[field]))
        missing.push(`${side}.${field}`);
  for (const field of PARITY_FIELDS)
    if (
      parityValueOk(field, before?.[field]) &&
      parityValueOk(field, after?.[field]) &&
      stable(before[field]) !== stable(after[field])
    )
      differences.push({ field, before: before[field], after: after[field] });
  return {
    contract: { ...SP1_CONTRACT },
    caseId,
    variantId,
    arms: ["r", "r+ir"],
    fields: [...PARITY_FIELDS],
    before: before ?? null,
    after: after ?? null,
    missing,
    differences,
    same: missing.length === 0 && differences.length === 0,
  };
}

export function assertSeedPinParity(result) {
  if (result.missing.length > 0)
    fail(
      "SP-P4",
      `${result.caseId}/${result.variantId}: the parity is unconfirmed (${result.missing.join(", ")})`,
    );
  if (result.differences.length > 0)
    fail(
      "SP-N7",
      `${result.caseId}/${result.variantId}: the seed pin changes ${result.differences.map((row) => row.field).join(", ")}; the addendum is not used and the integrator proposes a refreeze (D1) in another draft`,
    );
  return result;
}

/** SP-N10: every arm of a case reads the same pins (one sealed setup). */
export function assertArmsShareSeedPin(arms) {
  const entries = Object.entries(arms ?? {});
  if (entries.length < 2) fail("SP-N10", "fewer than two arms to compare");
  const [first, ...rest] = entries;
  const base = pinSet(first[1]);
  const differs = rest
    .filter(([, pins]) => !sameSet(pinSet(pins), base))
    .map(([arm]) => arm);
  if (differs.length > 0)
    fail("SP-N10", `the pins of ${differs.join(", ")} differ from ${first[0]}`);
  return { ok: true };
}

/**
 * SP-P5: every Graph-arm sample's parent begin carried the planned seed (the
 * hook consumer's fetch record), and no join was dropped as invalidated (the
 * requalification's `SeedChanged` surfaces as invalidated; any invalidated
 * join is reported, the strict side).
 */
export function seedCarriedFindings(samples, expectedSeed) {
  const findings = [];
  for (const row of samples ?? []) {
    if (row?.arm !== "graph") continue;
    if (row.followUp?.parent?.seed !== expectedSeed)
      findings.push("SP-P5:parent-seed-differs");
    const invalidated = (join) =>
      join?.outcome === "graph-unavailable" && join.reason === "invalidated";
    if (invalidated(row.graph) || invalidated(row.followUp?.child))
      findings.push("SP-P5:possible-seed-changed");
  }
  return findings;
}
