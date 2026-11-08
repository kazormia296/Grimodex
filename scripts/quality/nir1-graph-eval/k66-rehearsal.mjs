// K6/6 の dev の予行の評価（非判定）。
//
// draftRef nir1-final-request-eval-proposal/6（改訂 3。確認・凍結済み）の threat model の
// 「dev の予行」の 2 と 3 を、予行の samples に当てる純粋な関数。
//   2. 有効とする下限: 窓内に合流した親が 30 件以上あり、FR-7 の記録が窓内に合流
//      した親の全件にあること。30 件に満たなければ予行は「未実施」（fixture を直して
//      取り直す）。FR-7 の記録が無い、または k64-record.mjs の読取の追加でも取れない
//      と分かった場合は、/6 では判定せず、FR-7 を直した新しい draftRef（/7）で再確認
//      する（/6 の中で FR-7 を外す・緩めることはしない）。
//   3. 止める条件: 窓内に合流した親のうち、R-6 の (a)〜(c) か FR-1〜FR-8 のどれか
//      1 つの下位条件で落ちた割合が 1/30 を超えたら、凍結に進まず integrator に返す。
//      落ちた親には理由を付ける（構造的か偶発かは予行の記録に人が書く）。
//
// 結果は常に「非判定の dev の予行」で、判定・凍結・receipt の正本ではない。dev の
// fixture（`dev-shape-g0x.v1.json` など。凍結の fixture やその写しではない）の
// preview の samples にだけ当てる。この module は Electron も Native も見ない。

import { classifyFollowUp, nextGraphArmOf } from "./followup.mjs";
import { USER_OPERATION, classifyJoin } from "./join.mjs";
import { rehearsalK64Quality } from "./outcome.mjs";
import { d3Eligible, d3Problems } from "./quality-verdict.mjs";

export const K66_REHEARSAL_MIN_JOINED = 30;
/** 止める条件: 落ちた割合が 1/30 を超えたら（落ちた件数 × 30 > 窓内に合流した件数）。 */
export const K66_REHEARSAL_MAX_DROP = Object.freeze({
  numerator: 1,
  denominator: 30,
});
export const K66_REHEARSAL_NOT_JUDGED =
  "dev preview of the K6/6 first-render reading (revision 3, confirmed and frozen; the dev preview is not a receipt); never a CP-4 result, a freeze or a receipt";

/**
 * @param {object[]} samples the steady-state rows of one dev preview run (all
 *   variants of the run; the measured Graph-arm rows are read)
 * @param {{ fixture?: string, fixtureVersion?: string }} [about] what the
 *   record names (「試した全回の記録（fixture の版、件数、結果）」)
 */
export function assessK66Rehearsal(samples, about = {}) {
  const nexts = nextGraphArmOf(samples);
  const measured = samples.filter(
    (row) =>
      row.arm === "graph" &&
      row.phase === "measured" &&
      row.trigger === USER_OPERATION,
  );
  let joinedInWindow = 0;
  let fr7Recorded = 0;
  const dropped = [];
  const artifacts = [];
  const byCondition = {};
  for (const row of measured) {
    let join;
    try {
      join = classifyJoin(row);
    } catch (error) {
      artifacts.push({
        variantKey: row.variantKey,
        repeat: row.repeat,
        message: String(error.message),
      });
      continue;
    }
    if (!join.inWindow) continue;
    joinedInWindow += 1;
    const contribution = row.followUp?.parent?.contribution;
    if (contribution !== null && typeof contribution === "object")
      fr7Recorded += 1;
    let result;
    try {
      result = classifyFollowUp(row, {
        context: "steady",
        next: nexts.get(row),
      });
    } catch (error) {
      artifacts.push({
        variantKey: row.variantKey,
        repeat: row.repeat,
        message: String(error.message),
      });
      continue;
    }
    if (result.firstRender) continue;
    dropped.push({
      variantKey: row.variantKey,
      repeat: row.repeat,
      reasons: result.firstRenderFails,
    });
    for (const condition of new Set(
      result.firstRenderFails.map((code) => code.split(":")[0]),
    ))
      byCondition[condition] = (byCondition[condition] ?? 0) + 1;
  }
  const enough = joinedInWindow >= K66_REHEARSAL_MIN_JOINED;
  const status = !enough
    ? "not-run"
    : artifacts.length > 0
      ? "artifact"
      : fr7Recorded < joinedInWindow
        ? "fr7-record-missing"
        : dropped.length * K66_REHEARSAL_MAX_DROP.denominator >
            joinedInWindow * K66_REHEARSAL_MAX_DROP.numerator
          ? "stop"
          : "ok";
  const next = {
    "not-run":
      "the rehearsal is not run (fewer than 30 parents joined in the window): fix the dev fixture and retake it; do not proceed to the freeze",
    artifact:
      "a record the /6 rules rule out (FR-8, a stale joined parent, …): an artifact; fix and retake",
    "fr7-record-missing":
      "FR-7's record is not on every parent that joined in the window: /6 is not judged; reconfirm with a new draftRef (/7) that fixes FR-7 (FR-7 is neither dropped nor loosened inside /6)",
    stop: "more than 1/30 of the parents that joined in the window missed a first-render sub-condition: do not proceed to the freeze; return to the integrator with the reasons (structural or accidental, written by a person)",
    ok: "the rehearsal's lower bound and its stop condition are met (still a non-judging record)",
  }[status];
  return Object.freeze({
    notJudged: K66_REHEARSAL_NOT_JUDGED,
    fixture: about.fixture ?? null,
    fixtureVersion: about.fixtureVersion ?? null,
    measuredGraphSamples: measured.length,
    joinedInWindow,
    fr7Recorded,
    dropped: dropped.length,
    droppedRate: joinedInWindow === 0 ? null : dropped.length / joinedInWindow,
    droppedByCondition: byCondition,
    droppedParents: dropped,
    artifacts,
    status,
    next,
  });
}

/** Prereg v2 D2・D3 apply to G-08/chronicle-index-unusable only (D3 (1)). */
const D3_VARIANT = /(^|\/)chronicle-index-unusable$/u;

/**
 * Prereg v2 D2・D3 on one dev variant (a forecast; the formal reading is
 * `quality-verdict.mjs`). A Graph-arm child that meets D3's conditions (2)〜(6)
 * (`d3Eligible`: `index-ready`, not a `graph-ready` refresh, the parent's
 * Chronicle Index unusable and its Graph Index usable, the child's Chronicle
 * Index usable) is not a "child" of K6/4:52 any more (D2) and is checked by
 * D3 (a)〜(d) instead; every other child stays (fail closed). The dev fixture
 * carries no forbidden Scene set or setup record unless the caller passes
 * `forbiddenSceneIds`, `blockedSceneIds` and `typedRevisions`; D3 (a)(b)(d) then
 * read an empty set and (d) holds (`d-revision-resolution-unavailable`).
 */
function applyD2D3(run) {
  if (!D3_VARIANT.test(run.variant.key))
    return { samples: run.samples, d3: null };
  const forbidden = new Set(run.forbiddenSceneIds ?? []);
  const blocked = new Set(run.blockedSceneIds ?? []);
  const pairOf = new Map(
    run.samples
      .filter(
        (row) =>
          row.arm === "hybrid" &&
          row.phase === "measured" &&
          row.trigger === USER_OPERATION,
      )
      .map((row) => [row.repeat, row.finalSceneIds]),
  );
  const d3 = { eligible: 0, graphShown: 0, outOfD3: 0, problems: [] };
  const samples = run.samples.map((row) => {
    const child = row.followUp?.child;
    if (row.arm !== "graph" || row.phase !== "measured" || !child) return row;
    if (!d3Eligible(row, child)) {
      if (child.origin === "index-ready") d3.outOfD3 += 1;
      return row;
    }
    d3.eligible += 1;
    if (child.outcome === "graph-ready" && (child.edgeCount ?? 0) > 0)
      d3.graphShown += 1;
    for (const problem of d3Problems({
      child,
      pair: pairOf.get(row.repeat) ?? [],
      lists: (ids) => ids,
      forbidden,
      blocked,
      typedRevisions: run.typedRevisions,
    }))
      d3.problems.push({ repeat: row.repeat, ...problem });
    return { ...row, followUp: { ...row.followUp, child: null } };
  });
  return { samples, d3 };
}

/**
 * K6/6 の dev の予行の品質の予告（非判定）: 予行の receipt の `quality` は regime が
 * k62 のため /6 の品質 FAIL の規則が走らない。各 variant の samples に /6 の regime
 * （K6/4 の品質の読み。変える点 6 の `graph-contributed-parent-not-counted-as-first-render`
 * を含む）を当て、variant ごとの判定と件数を返す。G-08/chronicle-index-unusable は
 * 品質判定 v2 の D2・D3 に揃える（`applyD2D3`）。判定には使わない予告の値。
 *
 * @param {{variant: {key: string, expectedGraph: string}, samples: object[],
 *   forbiddenSceneIds?: string[], blockedSceneIds?: string[],
 *   typedRevisions?: object}[]} runs
 *   one entry per variant of the rehearsal (the receipt's `settings.devVariant`
 *   and `samples`; the optional fields are D3's forbidden Scenes and the setup
 *   record's `logicalToRuntime.typedRevisions`)
 */
export function assessK66RehearsalQuality(runs) {
  const variants = runs.map((run) => {
    try {
      const { samples, d3 } = applyD2D3(run);
      const base = rehearsalK64Quality({ variant: run.variant, samples });
      if (d3 === null || d3.eligible === 0) return base;
      const d3Status = d3.problems.some((entry) => entry.kind === "fail")
        ? "fail"
        : d3.problems.some((entry) => entry.kind === "hold")
          ? "hold"
          : "pass";
      const disclosure = {
        eligible: d3.eligible,
        graphShown: d3.graphShown,
        outOfD3: d3.outOfD3,
        status: d3Status,
        problems: d3.problems,
      };
      // A D2 result that already failed or held stays; otherwise D3 decides.
      if (base.status === "fail" || base.status === "hold")
        return { ...base, d3: disclosure };
      if (d3Status === "fail")
        return {
          variantKey: run.variant.key,
          status: "fail",
          reason: "a2-index-ready-requery-forbidden",
          d3: disclosure,
        };
      if (d3Status === "hold")
        return {
          variantKey: run.variant.key,
          status: "hold",
          reason: "a2-index-ready-requery-hold",
          d3: disclosure,
        };
      return { ...base, d3: disclosure };
    } catch (error) {
      return {
        variantKey: run.variant.key,
        status: "error",
        reason: String(error.message).split("\n")[0],
      };
    }
  });
  const count = (status) =>
    variants.filter((row) => row.status === status).length;
  return Object.freeze({
    notJudged: K66_REHEARSAL_NOT_JUDGED,
    regime:
      "k64 (forecast under the /6 reading; the dev receipt's own regime is k62)",
    variants,
    fail: count("fail"),
    hold: count("hold"),
    measurable: count("measurable"),
    fallbackMeasured: count("fallback-measured"),
    other: variants.filter(
      (row) =>
        !["fail", "hold", "measurable", "fallback-measured"].includes(
          row.status,
        ),
    ).length,
  });
}
