// 融合の枠の評価（段階 2）：IR の測定の 1 回分を分類し、地点ごとに集計する純粋関数。
//
// 分類は計画（contracts `docs/plans/nir1-fusion-records/ir-cloud-extraction-plan-2026-11-03.md`
// の §3）の順。判定は reason の文字列ではなく `completion.outcome` で行う（renderer が
// expired→invalidated、capacity→failed に潰すため）。
// 入力の sample は ir-renderer.ts の `measure` が返す 1 回分で、件数・位置・enum だけを持つ。

export const RAW_MAX = 8;

/** 6 分類（＋枠を使わなかった理由の細目）。 */
export const CATEGORIES = Object.freeze([
  "unsupported", // 対象外（querySupported=false）
  "ir-not-built", // IR 未構築（indexUsable=false）
  "ir-timeout", // IR が間に合わない（outcome=timeout）
  "fault", // 故障（ir-unavailable／failed／cancelled／invalidated、または fetch の失敗）
  "slot-used", // IR ready で枠を使った（kind:"ir" の行がある）
  "slot-unused", // IR ready で枠を使わなかった
]);

/**
 * @returns {{ category: string, unusedReason: string | null }}
 *   unusedReason は slot-unused のときだけ：
 *   "ir-empty"（admitted が 0 件）／"raw-full"（Raw が 8 件で枠が閉じていた）／
 *   "overlap"（Raw が 8 件未満で、admitted が全て Raw と重なった）。
 */
export function classifySample(sample) {
  const snapshot = sample.initialSnapshot;
  if (sample.status !== "completed" && !snapshot)
    return { category: "fault", unusedReason: null };
  if (!snapshot || snapshot.querySupported === false)
    return { category: "unsupported", unusedReason: null };
  if (snapshot.indexUsable === false)
    return { category: "ir-not-built", unusedReason: null };
  const outcome = sample.completion?.outcome ?? null;
  if (outcome === "timeout") return { category: "ir-timeout", unusedReason: null };
  if (outcome !== "ir-ready" || sample.status !== "completed")
    return { category: "fault", unusedReason: null };
  if (sample.resultKind === "raw") {
    if (sample.irStatus === "empty")
      return { category: "slot-unused", unusedReason: "ir-empty" };
    return { category: "fault", unusedReason: null };
  }
  if (sample.rows.some((row) => row.kind === "ir"))
    return { category: "slot-used", unusedReason: null };
  return {
    category: "slot-unused",
    unusedReason: sample.rawCount >= RAW_MAX ? "raw-full" : "overlap",
  };
}

/**
 * probe（別 operation の begin→continue）の admitted の位置から、Raw の外にある
 * query より前の Scene の位置を返す。probe が取れなかったときは null。
 */
export function irCandidatesOutsideRaw(probe, rawPositions, queryPosition) {
  if (!probe || probe.status !== "available") return null;
  const raw = new Set(rawPositions);
  return probe.admittedPositions.filter(
    (p) => p > 0 && p < queryPosition && !raw.has(p),
  );
}

const ratio = (num, den) => (den === 0 ? null : num / den);

/**
 * 1 地点（または全体）の query の列を集計する。各 query は
 * { position, samples: [...], probe } の形。
 */
export function summarizeQueries(queries) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const unused = { "ir-empty": 0, "raw-full": 0, overlap: 0 };
  let samples = 0;
  let readyRawNotFull = 0;
  let slotUsedRawNotFull = 0;
  let rawFull = 0;
  let rawFullWithCandidate = 0;
  let rawFullProbeMissing = 0;
  let timeouts = 0;
  let timeoutCounterfactual = 0;
  let timeoutProbeMissing = 0;
  for (const query of queries) {
    for (const sample of query.samples) {
      samples++;
      const { category, unusedReason } = classifySample(sample);
      counts[category]++;
      if (unusedReason) unused[unusedReason]++;
      const full = sample.rawCount !== null && sample.rawCount >= RAW_MAX;
      if (
        (category === "slot-used" || category === "slot-unused") &&
        !full
      ) {
        readyRawNotFull++;
        if (category === "slot-used") slotUsedRawNotFull++;
      }
      const candidates = irCandidatesOutsideRaw(
        query.probe,
        sample.rawPositions,
        query.position,
      );
      if (full) {
        rawFull++;
        if (candidates === null) rawFullProbeMissing++;
        else if (candidates.length > 0) rawFullWithCandidate++;
      }
      if (category === "ir-timeout") {
        timeouts++;
        if (candidates === null) timeoutProbeMissing++;
        else if (candidates.length > 0 && !full) timeoutCounterfactual++;
      }
    }
  }
  return {
    queries: queries.length,
    samples,
    categories: counts,
    slotUnusedReasons: unused,
    // 主指標：kind:"ir" の行がある ÷（IR ready かつ Raw が 8 件未満）。raw-ir は含めない。
    slotUseRate: {
      numerator: slotUsedRawNotFull,
      denominator: readyRawNotFull,
      value: ratio(slotUsedRawNotFull, readyRawNotFull),
    },
    irUnavailableRate: {
      numerator: counts["ir-timeout"] + counts.fault,
      denominator: samples,
      value: ratio(counts["ir-timeout"] + counts.fault, samples),
      timeout: counts["ir-timeout"],
    },
    rawFullWithIrCandidate: {
      numerator: rawFullWithCandidate,
      denominator: rawFull - rawFullProbeMissing,
      value: ratio(rawFullWithCandidate, rawFull - rawFullProbeMissing),
      rawFull,
      probeMissing: rawFullProbeMissing,
    },
    timeoutCounterfactual: {
      numerator: timeoutCounterfactual,
      denominator: timeouts - timeoutProbeMissing,
      value: ratio(timeoutCounterfactual, timeouts - timeoutProbeMissing),
      probeMissing: timeoutProbeMissing,
    },
  };
}

/**
 * 地点の作り方の判定（計画 §2.5）：前の地点で probe が admitted にした Scene が、
 * Scene を足して承認した後の probe でも全て残っているか。
 */
export function compareAdmitted(before, after) {
  const lost = [];
  for (const [position, previous] of before) {
    const current = after.get(position);
    if (!current) {
      lost.push({ position, lost: previous.length, missingProbe: true });
      continue;
    }
    const now = new Set(current);
    const missing = previous.filter((p) => !now.has(p));
    if (missing.length) lost.push({ position, lost: missing.length, missing });
  }
  return { compared: before.size, nonDecreasing: lost.length === 0, lost };
}
