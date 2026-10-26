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
import { isProductDbPinRead } from "./workspace-db.mjs";

const SEED_UTF16_MAX = 200;
export const SEED_PIN_PLANS = Object.freeze(["frozen", "dev"]);
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
 * The entry before a K6/4 judgement starts (R5, a precondition of the
 * freeze; SP/1 SP-P1, SP-P3). Each row is one workspace read from the
 * product DB (`read`, readQuerySceneSeedPins; a receipt's copy is
 * self-reported, SP-N13). "frozen" needs one row for each of the 13
 * variants of G-01〜G-08 (so every case, SP-N11, SP-N14), each with the
 * planned seed's logical ID equal to `seedPlan` (the fixture's value), the
 * setup's logical→runtime map, and a match; "dev" needs at least one row.
 * Anything else is `[precheck]`.
 */
export function assertSeedPinsBeforeK64({ cases, plan, seedPlan }) {
  if (!SEED_PIN_PLANS.includes(plan))
    throw new Error(
      `[precheck] the seed pin plan is ${SEED_PIN_PLANS.join(" or ")}`,
    );
  const planned = plan === "frozen" ? frozenSeedPlan(seedPlan) : null;
  const input = Array.isArray(cases) ? cases : [];
  const result = verifySeedPins(input);
  const keys = result.rows.map(rowKey);
  const problems = [];
  if (new Set(keys).size !== keys.length)
    problems.push("a workspace is listed twice");
  input.forEach((row, at) => {
    if (!isProductDbPinRead(row?.read))
      problems.push(
        `${keys[at]}: self-reported (not read from the product DB)`,
      );
  });
  if (plan === "frozen") {
    const missing = FROZEN_SEED_VARIANT_KEYS.filter(
      (key) => !keys.includes(key),
    );
    const extra = keys.filter((key) => !FROZEN_SEED_VARIANT_KEYS.includes(key));
    if (missing.length > 0) problems.push(`missing ${missing.join(",")}`);
    if (extra.length > 0)
      problems.push(`not a G-case variant ${extra.join(",")}`);
    input.forEach((row, at) => {
      const want = planned.get(keys[at]);
      if (!want) return;
      if (row.entityRuntimeIds === undefined)
        problems.push(`${keys[at]}: no logical-to-runtime map`);
      if (row.expectedSeedLogical !== want.seedEntityId)
        problems.push(`${keys[at]}: plan-seed-mismatch`);
      if ((row.querySceneLogical ?? row.querySceneId) !== want.querySceneId)
        problems.push(`${keys[at]}: plan-query-scene-mismatch`);
    });
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
    rows: Object.freeze(result.rows.map((row) => Object.freeze(row))),
  });
}
