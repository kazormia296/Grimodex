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
 * Each case: `match` (the product's seed is the expected seed), `mismatch`
 * or `unconfirmed` (the pins or the expected seed are not known). The whole
 * result is `match` only when every case matched and there is at least one.
 */
export function verifySeedPins(cases) {
  const rows = (Array.isArray(cases) ? cases : []).map((input) => {
    const caseId = typeof input?.caseId === "string" ? input.caseId : null;
    const expectedSeed =
      typeof input?.expectedSeed === "string" && input.expectedSeed.length > 0
        ? input.expectedSeed
        : null;
    if (caseId === null || expectedSeed === null || !comparablePins(input))
      return {
        caseId,
        querySceneId: input?.querySceneId ?? null,
        status: "unconfirmed",
        productSeed: null,
        expectedSeed,
      };
    const productSeed = productSeedOf(input);
    return {
      caseId,
      querySceneId: input.querySceneId ?? null,
      status: productSeed === expectedSeed ? "match" : "mismatch",
      productSeed,
      expectedSeed,
    };
  });
  const status =
    rows.length === 0 || rows.some((row) => row.status === "unconfirmed")
      ? "unconfirmed"
      : rows.some((row) => row.status === "mismatch")
        ? "mismatch"
        : "match";
  return { status, rows };
}

/**
 * The entry before a K6/4 judgement starts (R5, a precondition of the
 * freeze): every case of the plan (all G-cases for "frozen", at least one
 * for "dev"), each once, and every one a match; otherwise `[precheck]`.
 */
export function assertSeedPinsBeforeK64({ cases, plan }) {
  if (!SEED_PIN_PLANS.includes(plan))
    throw new Error(
      `[precheck] the seed pin plan is ${SEED_PIN_PLANS.join(" or ")}`,
    );
  const result = verifySeedPins(cases);
  const ids = result.rows.map((row) => row.caseId);
  const problems = [];
  if (new Set(ids).size !== ids.length) problems.push("a case is listed twice");
  if (plan === "frozen") {
    const missing = FROZEN_SEED_CASE_IDS.filter((id) => !ids.includes(id));
    const extra = ids.filter((id) => !FROZEN_SEED_CASE_IDS.includes(id));
    if (missing.length > 0) problems.push(`missing ${missing.join(",")}`);
    if (extra.length > 0) problems.push(`not a G-case ${extra.join(",")}`);
  }
  for (const row of result.rows)
    if (row.status !== "match") problems.push(`${row.caseId}: ${row.status}`);
  if (result.status !== "match" && problems.length === 0)
    problems.push(result.status);
  if (problems.length > 0)
    throw new Error(
      `[precheck] R5: the query Scene's first pin is not confirmed to be the expected seed (${problems.join("; ")}); the K6/4 judgement does not start (CP-0 handles it)`,
    );
  return Object.freeze({
    status: "match",
    plan,
    rows: Object.freeze(result.rows.map((row) => Object.freeze(row))),
  });
}
