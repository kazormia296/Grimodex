// CP-4 S1f: R5（K6/4:196）の seed の pin の照合。
//
// K6/4 は、seed が製品の規則（query の Scene の最初の pin）で決まり、G-case の各
// query の Scene の最初の pin が事前の期待値の seed と一致することを「この draft の
// 凍結の前の前提」とする。一致しない、または確かめられないときは K6/4 の判定を
// 始めず、CP-0 の側で扱う（一致しないまま測ると全件が X7 か X12 になる）。K6/4 は
// G-case の setup の変更を許さない（批准 9）。
//
// この module は照合の関数と、判定を始める前の入口だけを持つ。pin の行は呼出し側
// が読む（製品の DB か、setup の記録から）。凍結した G-case の材料には通さない
// （実 fixture の照合は S5 の前の別工程。DR-CP4-F-3）。
//
// 製品の規則（`src/features/related-scenes/nir1GraphSeed.ts`
// `selectNir1GraphSeed`、Native の `read_nir1_graph_seed_in_tx` と同じ）: query の
// Scene の pin を、生きている（archive されていない）同じ project の Scene と、同じ
// project の Codex entry に join し、`created_at`、`entry_id` の昇順で最初の 1 件
// だけが決める。空、空白だけ、200 UTF-16 を超える id は seed なし（次の pin は試さ
// ない）。

import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import {
  assertCompleteSetupReceipt,
  isLoadedSetupReceipt,
} from "./setup-receipt.mjs";
import { isProductDbPinRead } from "./workspace-db.mjs";

const SEED_UTF16_MAX = 200;
export const SEED_PIN_PLANS = Object.freeze(["frozen", "dev"]);
/**
 * S1j P2-4: the stage of a frozen-plan gate. `r5-check` is ① (setups that
 * stopped at the seed pin step, all of one R5 check run); `evaluation` is ④
 * and ⑤ (complete setups on the S5 candidate; ①'s receipts are refused,
 * S2 `r5CheckWorkspace.reuseFor: []`).
 */
export const SEED_PIN_GATE_STAGES = Object.freeze(["r5-check", "evaluation"]);
/** Every G-case of the frozen plan (each query Scene is checked). */
export const FROZEN_SEED_CASE_IDS = Object.freeze([
  ...new Set(GRAPH_EVAL_VARIANTS.map((row) => row.caseId)),
]);

function compareKeys(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The pins of a case, or null when the rows cannot be compared as the
 * product's SQL would (a missing list, a malformed row, or `created_at`
 * values of mixed types).
 */
function comparablePins(input) {
  if (!Array.isArray(input?.pins) || typeof input.sceneLive !== "boolean")
    return null;
  const rows = input.pins;
  if (
    !rows.every(
      (row) =>
        row !== null &&
        typeof row === "object" &&
        typeof row.entryId === "string" &&
        typeof row.entryInProject === "boolean" &&
        (typeof row.createdAt === "string" ||
          (typeof row.createdAt === "number" &&
            Number.isFinite(row.createdAt))),
    )
  )
    return null;
  if (new Set(rows.map((row) => typeof row.createdAt)).size > 1) return null;
  return rows;
}

/** The seed the product reads for a query Scene (null: no seed). */
export function productSeedOf(input) {
  const rows = comparablePins(input);
  if (rows === null)
    throw new Error("[precheck] the pins of the query Scene are not readable");
  if (!input.sceneLive) return null;
  const first = rows
    .filter((row) => row.entryInProject)
    .sort(
      (left, right) =>
        compareKeys(left.createdAt, right.createdAt) ||
        compareKeys(left.entryId, right.entryId),
    )[0];
  const entryId = first?.entryId;
  if (
    typeof entryId !== "string" ||
    entryId.trim().length === 0 ||
    entryId.length > SEED_UTF16_MAX
  )
    return null;
  return entryId;
}

/**
 * Each row (a case, or since SP/1 a variant workspace): `match` (the
 * product's seed is the expected seed and the query Scene holds exactly that
 * one pin), `mismatch`, `no-pin`, `multiple-pins` (SP/1 SP-N2: the first pin
 * is the seed but there are more), `seed-runtime-id-mismatch` (the expected
 * runtime ID is not the one the setup mapped the logical seed to) or
 * `unconfirmed` (the pins or the expected seed are not known). A row reads
 * its pins from `read` (readQuerySceneSeedPins) or, for the pure checks,
 * from itself. The whole result is `match` only when every row matched and
 * there is at least one; `unconfirmed` comes before the other statuses.
 */
export function verifySeedPins(cases) {
  const rows = (Array.isArray(cases) ? cases : []).map((input) => {
    const caseId = typeof input?.caseId === "string" ? input.caseId : null;
    const variantId =
      typeof input?.variantId === "string" ? input.variantId : null;
    const expectedSeed =
      typeof input?.expectedSeed === "string" && input.expectedSeed.length > 0
        ? input.expectedSeed
        : null;
    const source = input?.read ?? input;
    const base = {
      caseId,
      variantId,
      querySceneId: input?.querySceneId ?? null,
      productSeed: null,
      expectedSeed,
      expectedSeedLogical: input?.expectedSeedLogical ?? null,
      pinCount: Array.isArray(source?.pins) ? source.pins.length : null,
    };
    if (caseId === null || expectedSeed === null || !comparablePins(source))
      return { ...base, status: "unconfirmed" };
    const map = input.entityRuntimeIds;
    if (
      map !== undefined &&
      (typeof input.expectedSeedLogical !== "string" ||
        map?.[input.expectedSeedLogical] !== expectedSeed)
    )
      return { ...base, status: "seed-runtime-id-mismatch" };
    const productSeed = productSeedOf(source);
    const status =
      source.pins.length === 0
        ? "no-pin"
        : productSeed !== expectedSeed
          ? "mismatch"
          : source.pins.length > 1
            ? "multiple-pins"
            : "match";
    return { ...base, productSeed, status };
  });
  const status =
    rows.length === 0 || rows.some((row) => row.status === "unconfirmed")
      ? "unconfirmed"
      : rows.some((row) => row.status !== "match")
        ? "mismatch"
        : "match";
  return { status, rows };
}

const rowKey = (row) =>
  row.variantId === null || row.variantId === undefined
    ? String(row.caseId)
    : `${row.caseId}/${row.variantId}`;

/** The frozen plan's 13 variant keys, in the catalog's order. */
export const FROZEN_SEED_VARIANT_KEYS = Object.freeze(
  GRAPH_EVAL_VARIANTS.map((row) => row.key),
);

/**
 * The seed plan of the frozen run (SP/1: from each fixture, or the addendum
 * once S4 reads it): one row per variant with the query Scene and the
 * planned seed's logical IDs. Returns a map by variant key, or throws.
 */
function frozenSeedPlan(seedPlan) {
  const rows = Array.isArray(seedPlan) ? seedPlan : [];
  const map = new Map();
  for (const row of rows) {
    if (
      typeof row?.caseId !== "string" ||
      typeof row.variantId !== "string" ||
      typeof row.querySceneId !== "string" ||
      typeof row.seedEntityId !== "string"
    )
      continue;
    map.set(`${row.caseId}/${row.variantId}`, row);
  }
  if (
    rows.length !== FROZEN_SEED_VARIANT_KEYS.length ||
    map.size !== FROZEN_SEED_VARIANT_KEYS.length ||
    !FROZEN_SEED_VARIANT_KEYS.every((key) => map.has(key))
  )
    throw new Error(
      "[precheck] R5: the frozen plan needs the seedPlan (case, variant, query Scene and planned seed) of all 13 variants (SP/1)",
    );
  return map;
}

/**
 * One gate row bound to its sources (P2-1): the logical IDs (the frozen
 * plan's, or the dev row's), the runtime IDs from the sealed setup receipt
 * (never from the caller), and the sealed read checked against them (the
 * same Scene and project; for a frozen variant, the setup's own cold DB).
 */
function completeSetup(setup) {
  try {
    assertCompleteSetupReceipt(setup);
    return true;
  } catch {
    return false;
  }
}

function bindRow(row, plan, planned, stage) {
  const key = rowKey({
    caseId: row?.caseId ?? null,
    variantId: row?.variantId ?? null,
  });
  const problems = [];
  const setup = row?.setup;
  const read = row?.read;
  const sealedSetup = isLoadedSetupReceipt(setup);
  const sealedRead = isProductDbPinRead(read);
  if (!sealedSetup) problems.push("setup-self-reported");
  if (!sealedRead)
    problems.push("self-reported (not read from the product DB)");
  let logicalQuery = row?.querySceneLogical;
  let logicalSeed = row?.expectedSeedLogical;
  if (plan === "frozen") {
    const want = planned.get(key);
    if (want) {
      if (logicalQuery !== undefined && logicalQuery !== want.querySceneId)
        problems.push("plan-query-scene-mismatch");
      if (logicalSeed !== undefined && logicalSeed !== want.seedEntityId)
        problems.push("plan-seed-mismatch");
      logicalQuery = want.querySceneId;
      logicalSeed = want.seedEntityId;
    }
  }
  let runtimeQuery = null;
  let runtimeSeed = null;
  if (sealedSetup) {
    const kind = plan === "frozen" ? "frozen" : "dev";
    if (setup.fixtureKind !== kind) problems.push("setup-of-another-kind");
    else if (plan === "frozen") {
      if (setup.caseId !== row.caseId || setup.variantId !== row.variantId)
        problems.push("setup-of-another-variant");
      // S1j P2-4: ① reads ①'s setups only; ④⑤ read complete setups only.
      if (
        stage === "r5-check" &&
        (setup.stopsAt !== "seed-pin" || setup.r5CheckRunId === null)
      )
        problems.push("setup-not-of-an-r5-check-run");
      if (stage === "evaluation" && !completeSetup(setup))
        problems.push("setup-not-complete");
    }
    runtimeQuery = setup.scenes[logicalQuery] ?? null;
    runtimeSeed = setup.entities[logicalSeed] ?? null;
    if (runtimeQuery === null) problems.push("query-scene-not-mapped");
    if (runtimeSeed === null) problems.push("seed-not-mapped");
    if (sealedRead) {
      if (read.source.sceneId !== runtimeQuery)
        problems.push("read-of-another-scene");
      if (read.source.projectId !== setup.projectId)
        problems.push("read-of-another-project");
      if (
        plan === "frozen" &&
        (read.source.db.path !== setup.coldDatabase.path ||
          read.source.db.sha256 !== setup.coldDatabase.sha256)
      )
        problems.push("read-of-another-workspace");
    }
  }
  return {
    key,
    problems,
    setup: sealedSetup ? setup : null,
    read: sealedRead ? read : null,
    verify: {
      caseId: row?.caseId ?? null,
      variantId: row?.variantId ?? null,
      querySceneId: runtimeQuery,
      expectedSeed: runtimeSeed,
      expectedSeedLogical: logicalSeed ?? null,
      read,
    },
  };
}

/**
 * The entry before a K6/4 judgement starts (R5, a precondition of the
 * freeze; SP/1 SP-P1, SP-P3). Each row is one workspace: `{ caseId,
 * variantId, setup, read }` with `setup` from loadSetupReceipt and `read`
 * from readQuerySceneSeedPins (a receipt's copy of either is self-reported,
 * SP-N13). The runtime IDs come from the sealed setup receipt only, and the
 * read must be of that runtime query Scene and project (P2-1). "frozen"
 * needs one row for each of the 13 variants of G-01〜G-08 (so every case,
 * SP-N11, SP-N14) with the logical IDs of `seedPlan` (the fixture's
 * values), each read of that variant's own sealed cold DB and no workspace
 * read twice; "dev" needs at least one row naming its logical IDs
 * (`querySceneLogical`, `expectedSeedLogical`). Each row must match:
 * exactly one pin on the query Scene, the product's first pin the planned
 * seed. Anything else is `[precheck]`.
 */
export function assertSeedPinsBeforeK64({ cases, plan, seedPlan, stage }) {
  if (!SEED_PIN_PLANS.includes(plan))
    throw new Error(
      `[precheck] the seed pin plan is ${SEED_PIN_PLANS.join(" or ")}`,
    );
  if (plan === "frozen" && !SEED_PIN_GATE_STAGES.includes(stage))
    throw new Error(
      `[precheck] R5: a frozen-plan gate names its stage (${SEED_PIN_GATE_STAGES.join(" or ")}), not ${String(stage)}`,
    );
  const planned = plan === "frozen" ? frozenSeedPlan(seedPlan) : null;
  const input = Array.isArray(cases) ? cases : [];
  const bound = input.map((row) => bindRow(row, plan, planned, stage));
  const keys = bound.map((row) => row.key);
  const result = verifySeedPins(bound.map((row) => row.verify));
  const problems = [];
  if (new Set(keys).size !== keys.length)
    problems.push("a workspace is listed twice");
  // ①: every setup of the gate is of one R5 check run.
  if (plan === "frozen" && stage === "r5-check") {
    const runs = new Set(
      bound.map((row) => row.setup?.r5CheckRunId).filter(Boolean),
    );
    if (runs.size > 1) problems.push("setups-of-two-r5-check-runs");
  }
  const seen = new Map();
  for (const row of bound) {
    const marks = [
      row.read
        ? `db:${row.read.source.db.path}:${row.read.source.db.ino}`
        : null,
      row.setup ? `setup:${row.setup.sha256}` : null,
    ].filter(Boolean);
    for (const mark of marks) {
      if (seen.has(mark) && seen.get(mark) !== row.key)
        problems.push(`${row.key}: workspace-reused (with ${seen.get(mark)})`);
      else seen.set(mark, row.key);
    }
  }
  bound.forEach((row) => {
    for (const problem of row.problems) problems.push(`${row.key}: ${problem}`);
  });
  if (plan === "frozen") {
    const missing = FROZEN_SEED_VARIANT_KEYS.filter(
      (key) => !keys.includes(key),
    );
    const extra = keys.filter((key) => !FROZEN_SEED_VARIANT_KEYS.includes(key));
    if (missing.length > 0) problems.push(`missing ${missing.join(",")}`);
    if (extra.length > 0)
      problems.push(`not a G-case variant ${extra.join(",")}`);
  }
  result.rows.forEach((row, at) => {
    if (row.status !== "match") problems.push(`${keys[at]}: ${row.status}`);
  });
  if (result.status !== "match" && problems.length === 0)
    problems.push(result.status);
  if (problems.length > 0)
    throw new Error(
      `[precheck] R5: the query Scene's first pin is not confirmed to be the expected seed (${problems.join("; ")}); the K6/4 judgement does not start (CP-0 / SP/1 handles it)`,
    );
  return Object.freeze({
    status: "match",
    plan,
    rows: Object.freeze(
      result.rows.map((row, at) =>
        Object.freeze({
          ...row,
          setupReceiptSha256: bound[at].setup.sha256,
          db: bound[at].read.source.db.path,
        }),
      ),
    ),
  });
}
