// 第 6 版の集計の補助（読むだけ）。事前登録 §5・§6 の仕様。
// harness と同じ summarizeQueries で、作品ごと・地点ごと・層別・tail10 と、pool（3 作品）の D0・D1、
// 作品ごとの D1、記憶の対照（m-ja-2 と g-ja-1 の並べ）、第 5 版との位置ごとの比較、抽出の時間を出す。
// 出力は records の値と、それから計算した値だけ（本文・題名は records に無い）。検定はしない。
//
// 使い方：
//   node agg-v6.mjs <ir-classify.mjs の絶対 path> \
//     --pool m-ja-1=<records> m-ja-2=<records> m-en-1=<records> \
//     --control g-ja-1=<records> [--baseline m-ja-2=<第 5 版の records>]
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const BUCKETS = ["lt8", "8to30", "gt30"];
const D0_THRESHOLD = 200;
const D1_LIMIT = 0.05;
const MEMORY_REFERENCE = "m-ja-2";
// records の role：--pool は本測定（main）、--control は AI 生成の対照（control-ai-gen）。
const POOL_ROLE = "main";
const CONTROL_ROLE = "control-ai-gen";
// --baseline（第 5 版の records）の role も本測定の main。
const BASELINE_ROLE = "main";
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

/** key は out の添字に使うので、英数字で始まる安全な語に限る。 */
function assertKey(key) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key))
    throw new Error(`key の形が不正: ${JSON.stringify(key)}`);
}

const ratio = (num, den) => (den === 0 ? null : num / den);
const sub = (a, b) =>
  a === null || a === undefined || b === null || b === undefined ? null : a - b;

/** 中央値（偶数個は中央 2 つの平均）。空は null。 */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}
const maxOf = (values) => (values.length === 0 ? null : Math.max(...values));
const finiteNumbers = (values) =>
  values.filter((v) => typeof v === "number" && Number.isFinite(v));

const brief = (s) => ({
  queries: s.queries,
  samples: s.samples,
  categories: s.categories,
  unused: s.slotUnusedReasons,
  slotUse: `${s.slotUseRate.numerator}/${s.slotUseRate.denominator}`,
  slotUseValue: s.slotUseRate.value,
  irUnavailable: `${s.irUnavailableRate.numerator}/${s.irUnavailableRate.denominator}`,
  rawFullWithIr: `${s.rawFullWithIrCandidate.numerator}/${s.rawFullWithIrCandidate.denominator}`,
  rawFullWithIrValue: s.rawFullWithIrCandidate.value,
  timeoutCounterfactual: `${s.timeoutCounterfactual.numerator}/${s.timeoutCounterfactual.denominator}`,
});

// 製品の固定の診断 code（harness の sanitizeMessage が <long> に伏せない語と同じ規則）。
// 前後に英数字・_・- が続く列は一体の列なので拾わない。
const FIXED_CODE =
  /(?<![A-Za-z0-9_-])(?:SNAPSHOT|NEX)_[A-Z0-9_]{3,64}(?![A-Za-z0-9_-])/gu;
const FIXED_CODE_START =
  /(?<![A-Za-z0-9_-])(?:SNAPSHOT|NEX)_[A-Z0-9_]{3,64}(?![A-Za-z0-9_-])/u;
// harness の ir-error-record.mjs の MESSAGE_MAX と同じ。
const MESSAGE_MAX = 240;
const LABEL_MAX = 60;
// prefix が無い label に残す、code の後ろの文言の長さ。
const TAIL_MAX = 40;

/**
 * 失敗した抽出の形の分類（label）。
 *
 * 分類は errorShape の文字列だけで行う。本番の抽出の失敗は
 * `new Error("Snapshot build failed: " + diagnostics の code を ", " で連結)` で、
 * .code も .cause も持たない（errorChain の chain[0].code は null になる）ので、
 * errorChain は分類に使わない。
 *
 * errorShape の中の SNAPSHOT_／NEX_ の固定の code（SNAPSHOT_SOURCE_CHANGED、
 * SNAPSHOT_SOURCE_READ_FAILED、SNAPSHOT_SCOPE_VALIDATION_FAILED など）は、どれも同じ規則で
 * 文字列のどこにあっても拾う。複数あれば重複を除いて辞書順に並べ、", " で連結して
 * 「<code の前の文言>: <code, code>」の label にする
 * （例 "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED, SNAPSHOT_SOURCE_READ_FAILED"）。
 * 最初の code より後ろ（code の間でも最後の code の後ろでも）に <long> があれば、その印も末尾に足す。
 * code の前の文言が空なら "(code)" を置き、code の後ろの文言の先頭 40 字も残す
 * （例 "(code): SNAPSHOT_SCOPE_VALIDATION_FAILED: eventOutput event count mismatch"）。
 *
 * ただし "Failed query"（drizzle の失敗。SQL の大文字の識別子が code の形に見えうる）と
 * "Evidence span catalog coverage hole" は、code の探索より前に決める。
 *
 * errorShape が MESSAGE_MAX（240 字）に達し、最後の code が文字列の末尾で終わっているときは、
 * 切れた code の可能性があるのでその match を外す（同じ code が多数並ぶ失敗で
 * SNAPSHOT_SOURCE_C のような存在しない code 名が混ざるのを防ぐ）。外した後に code が
 * 残らなければ "<code の前の文言>: <切断>"。
 *
 * 第 5 版の record では、32 字以上の code が "<long>" に伏せられていた
 * （既知は SNAPSHOT_SCOPE_VALIDATION_FAILED）。その形 "Snapshot build failed: <long>" は
 * label をそのまま残す（他の 32 字以上の code と区別できない）。第 6 版の record では、
 * 固定の code は伏せられずに残るので、上の規則で code ごとに分かれる。
 *
 * errorShape が無い失敗は "(なし:<errorCode>)"（errorCode も無ければ "(なし)"）。
 * "Failed query" は drizzle の失敗の接頭辞で、どの SELECT かは決めつけない。
 * code が無く "Snapshot build failed" で始まる失敗は、shape が <long> を含むときだけ
 * "Snapshot build failed: <long>"、含まなければ shape の先頭 60 字。
 * @param {{ errorShape?: string | null, errorCode?: string | null }} e
 */
/** label の部分を上限で切り、切った後の末尾の空白・区切りも落とす。 */
function trimLabel(text, max = LABEL_MAX) {
  return text
    .replace(/[\s:,]+$/u, "")
    .slice(0, max)
    .replace(/[\s:,]+$/u, "");
}

/**
 * harness が MESSAGE_MAX 字で切った errorShape か。切れた後ろにあった code は label に入らない
 * （違う原因が同じ label に潰れうる）ので、件数を別に出す。
 * @param {{ errorShape?: string | null }} e
 */
export function isTruncatedShape(e) {
  return typeof e.errorShape === "string" && e.errorShape.length >= MESSAGE_MAX;
}

export function shapeKey(e) {
  const shape = e.errorShape;
  if (!shape) return e.errorCode ? `(なし:${e.errorCode})` : "(なし)";
  // drizzle の失敗の SQL や根拠の目録の穴の message は、識別子（大文字を含みうる）が code の形に
  // 見えることがあるので、固定 code の探索より前に決める。
  if (shape.startsWith("Failed query")) return "Failed query";
  if (shape.includes("Evidence span catalog coverage hole"))
    return "Evidence span catalog coverage hole";
  const matches = [...shape.matchAll(FIXED_CODE)];
  // harness は message を MESSAGE_MAX 字で切る。切れた末尾の code（SNAPSHOT_SOURCE_C など）は
  // 存在しない code 名なので、最後の match が文字列の末尾で終わり、長さが上限に達しているなら外す。
  let truncatedCode = false;
  let limit = shape.length;
  if (shape.length >= MESSAGE_MAX && matches.length > 0) {
    const edge = matches[matches.length - 1];
    if (edge.index + edge[0].length === shape.length) {
      matches.pop();
      truncatedCode = true;
      limit = edge.index;
    }
  }
  if (matches.length === 0 && truncatedCode) {
    const cutAt = shape.search(FIXED_CODE_START);
    const prefix = trimLabel(shape.slice(0, cutAt));
    return `${prefix === "" ? "(code)" : prefix}: <切断>`;
  }
  if (matches.length > 0) {
    const codes = [...new Set(matches.map((m) => m[0]))].sort();
    const first = matches[0];
    const prefix = trimLabel(shape.slice(0, first.index));
    const last = matches[matches.length - 1];
    // 最初の code の後ろ（code の間と最後の code の後ろ）。切れた code は含めない。
    const after = shape.slice(first.index + first[0].length, limit);
    if (after.includes("<long>")) codes.push("<long>");
    const label = `${prefix === "" ? "(code)" : prefix}: ${codes.join(", ")}`;
    if (prefix !== "") return label;
    // prefix が無いときは、code の後ろの文言の先頭も残す（第 5 版の "<long>: eventOutput ..." など）。
    let tail = shape.slice(last.index + last[0].length, limit);
    // 切れた message では、末尾の語が途中で切れている（code の断片など）ので落とす。
    if (shape.length >= MESSAGE_MAX) tail = tail.replace(/[A-Za-z0-9_]*$/u, "");
    const rest = trimLabel(tail.replace(/^[\s:,]+/u, ""), TAIL_MAX);
    return rest === "" ? label : `${label}: ${rest}`;
  }
  if (shape.startsWith("Snapshot build failed") && shape.includes("<long>"))
    return "Snapshot build failed: <long>";
  return shape.slice(0, LABEL_MAX);
}

const extractionOf = (d) => d.extraction ?? [];
const isCompleted = (e) => e.status === "completed";

function failuresByShape(d) {
  const failures = {};
  for (const e of extractionOf(d)) {
    if (isCompleted(e)) continue;
    (failures[shapeKey(e)] ??= []).push(e.position);
  }
  return failures;
}

function queriesOf(d) {
  return d.checkpoints.filter((c) => (c.queries ?? []).length > 0);
}

/** D1：IR 未構築＋故障 ÷ 全 sample。 */
function d1Of(summary) {
  const bad = summary.categories["ir-not-built"] + summary.categories.fault;
  const rate = ratio(bad, summary.samples);
  return {
    notBuiltPlusFault: bad,
    samples: summary.samples,
    rate,
    withinLimit: rate !== null && rate <= D1_LIMIT,
  };
}

const countBy = (items, pick) => {
  const out = {};
  for (const item of items) {
    const k = String(pick(item) ?? "(null)");
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

function proposalsOf(d) {
  return extractionOf(d).flatMap((e) => e.proposals ?? []);
}

function buildWork(summarizeQueries, d) {
  const cps = queriesOf(d);
  const all = cps.flatMap((c) => c.queries);
  const summary = summarizeQueries(all);
  const ex = extractionOf(d);
  return {
    all,
    summary,
    work: {
      status: d.status,
      sceneCount: d.sceneCount,
      extraction: {
        attempted: ex.length,
        completed: ex.filter(isCompleted).length,
        failuresByShape: failuresByShape(d),
      },
      checkpoints: cps.map((c) => ({
        fraction: c.fraction,
        sceneCount: c.sceneCount,
        ...brief(summarizeQueries(c.queries)),
        irWaitMs: Math.round(c.irWait?.durationMs ?? NaN),
      })),
      total: brief(summary),
      byPriorScenes: Object.fromEntries(
        BUCKETS.map((b) => [
          b,
          brief(summarizeQueries(all.filter((q) => q.priorScenesBucket === b))),
        ]),
      ),
      tail10: brief(summarizeQueries(all.filter((q) => q.tail10))),
      checkpointConstruction: d.checkpointConstruction ?? null,
    },
  };
}

/** 抽出の時間：connectionWait と failedAtMs（第 6 版の record だけにある）。項目が無ければ null。 */
function extractionTimingOf(d) {
  const failed = extractionOf(d).filter((e) => !isCompleted(e));
  const waits = failed
    .map((e) => e.connectionWait)
    .filter((w) => w && typeof w === "object");
  return {
    failedExtractions: failed.length,
    withConnectionWait: waits.length,
    ready: waits.filter((w) => w.ready === true).length,
    timedOut: waits.filter((w) => w.timedOut === true).length,
    waitFailed: waits.filter((w) => w.ready !== true && w.timedOut !== true)
      .length,
    waitedMsMax: maxOf(finiteNumbers(waits.map((w) => w.waitedMs))),
    waitedMsMedian: median(finiteNumbers(waits.map((w) => w.waitedMs))),
    failedAtMsMedian: median(finiteNumbers(failed.map((e) => e.failedAtMs))),
  };
}

/** 記憶の対照で作品ごとに並べる値。 */
function memoryProfile(d, summary, work) {
  const proposals = proposalsOf(d);
  const completed = work.extraction.completed;
  const rawFull = summary.rawFullWithIrCandidate.rawFull;
  return {
    extraction: {
      attempted: work.extraction.attempted,
      completed,
      failed: work.extraction.attempted - completed,
      failuresByShape: work.extraction.failuresByShape,
    },
    proposals: {
      total: proposals.length,
      perCompletedScene: ratio(proposals.length, completed),
      bySignificance: countBy(proposals, (p) => p.significance),
      byActuality: countBy(proposals, (p) => p.actuality),
    },
    primary: {
      slotUse: work.total.slotUse,
      slotUseValue: work.total.slotUseValue,
    },
    rawFullRate: {
      numerator: rawFull,
      denominator: summary.samples,
      value: ratio(rawFull, summary.samples),
    },
    rawFullWithIr: {
      value: work.total.rawFullWithIr,
      ratio: work.total.rawFullWithIrValue,
    },
    irEmptyRate: {
      numerator: summary.slotUnusedReasons["ir-empty"],
      denominator: summary.samples,
      value: ratio(summary.slotUnusedReasons["ir-empty"], summary.samples),
    },
    byPriorScenes: Object.fromEntries(
      BUCKETS.map((b) => [
        b,
        {
          slotUse: work.byPriorScenes[b].slotUse,
          slotUseValue: work.byPriorScenes[b].slotUseValue,
        },
      ]),
    ),
    tail10: {
      slotUse: work.tail10.slotUse,
      slotUseValue: work.tail10.slotUseValue,
    },
  };
}

/** 値の差（compared − reference）だけ。検定はしない。 */
function memoryDelta(ref, cmp) {
  return {
    extractionCompleted: sub(
      cmp.extraction.completed,
      ref.extraction.completed,
    ),
    extractionFailed: sub(cmp.extraction.failed, ref.extraction.failed),
    proposalsTotal: sub(cmp.proposals.total, ref.proposals.total),
    proposalsPerCompletedScene: sub(
      cmp.proposals.perCompletedScene,
      ref.proposals.perCompletedScene,
    ),
    primarySlotUseValue: sub(
      cmp.primary.slotUseValue,
      ref.primary.slotUseValue,
    ),
    rawFullRate: sub(cmp.rawFullRate.value, ref.rawFullRate.value),
    rawFullWithIr: sub(cmp.rawFullWithIr.ratio, ref.rawFullWithIr.ratio),
    irEmptyRate: sub(cmp.irEmptyRate.value, ref.irEmptyRate.value),
    byPriorScenes: Object.fromEntries(
      BUCKETS.map((b) => [
        b,
        sub(
          cmp.byPriorScenes[b].slotUseValue,
          ref.byPriorScenes[b].slotUseValue,
        ),
      ]),
    ),
    tail10SlotUseValue: sub(cmp.tail10.slotUseValue, ref.tail10.slotUseValue),
  };
}

/** 第 5 版と第 6 版の、位置ごとの抽出の成否。失敗の label どうしは比べない。 */
function compareBaseline(summarizeQueries, baseline, current) {
  const outcome = (d) =>
    new Map(extractionOf(d).map((e) => [e.position, isCompleted(e)]));
  const v5 = outcome(baseline);
  const v6 = outcome(current);
  const positions = [...new Set([...v5.keys(), ...v6.keys()])].sort(
    (a, b) => a - b,
  );
  const groups = {
    bothCompleted: [],
    failedOnlyInV5: [],
    failedOnlyInV6: [],
    bothFailed: [],
    notComparable: [],
  };
  for (const p of positions) {
    if (!v5.has(p) || !v6.has(p)) groups.notComparable.push(p);
    else if (v5.get(p) && v6.get(p)) groups.bothCompleted.push(p);
    else if (!v5.get(p) && v6.get(p)) groups.failedOnlyInV5.push(p);
    else if (v5.get(p) && !v6.get(p)) groups.failedOnlyInV6.push(p);
    else groups.bothFailed.push(p);
  }
  const side = (d) => {
    const ex = extractionOf(d);
    const { summary } = buildWork(summarizeQueries, d);
    return {
      status: d.status,
      attempted: ex.length,
      completed: ex.filter(isCompleted).length,
      total: brief(summary),
    };
  };
  return {
    positions: groups,
    counts: Object.fromEntries(
      Object.entries(groups).map(([k, v]) => [k, v.length]),
    ),
    v5: side(baseline),
    v6: side(current),
  };
}

/** 出力に添える、各値の分子・分母の定義（読み手が値の意味を取り違えないため）。 */
const DEFINITIONS = {
  primary:
    '主指標（slotUse）＝kind:"ir" の行がある sample ÷（IR ready［slot-used＋slot-unused］かつ Raw が 8 件未満の sample）。raw-ir は含めない。その分母が pooled.D0.irReadyRawLt8',
  rawFullRate:
    "Raw の満杯率＝Raw が 8 件の sample ÷ 全 sample（IR の状態を問わない）",
  rawFullWithIr:
    "Raw が 8 件の sample のうち、probe が Raw の外に IR の候補を返した数 ÷（Raw が 8 件の sample − probe が取れなかった sample）",
  irEmptyRate:
    "IR が空の割合＝slot-unused のうち ir-empty（admitted が 0 件）の sample ÷ 全 sample。ir-empty の sample も Raw が 8 件のことがあり、Raw の満杯率と重なりうる（足し合わせない）",
  proposalsPerCompletedScene:
    "提案の数の Scene あたり＝抽出した提案の総数 ÷ 完了した Scene の数（status=completed。試みた数ではない）",
  D0: "D0＝pool（control を除く）の IR ready かつ Raw が 8 件未満の sample 数。200 以上で decidable",
  D1: "D1＝（ir-not-built＋fault）÷ 全 sample。ir-timeout は含まない（irUnavailable は ir-timeout＋fault ÷ 全 sample で別の値）。5％以下で withinLimit。control は readAsControl として読む",
  irUnavailable: "irUnavailable＝（ir-timeout＋fault）÷ 全 sample",
  failureLabel:
    "extraction.failuresByShape の label は shapeKey の規則（SNAPSHOT_／NEX_ の code を辞書順に連結、Failed query と coverage hole は code の探索より前に決めて接頭辞だけ、errorShape が無ければ (なし:errorCode)）。第 5 版の record で伏せられていた 32 字以上の code は <long>",
};

/**
 * @param {{
 *   summarizeQueries: (queries: unknown[]) => any,
 *   pool: [string, any][],
 *   control?: [string, any][],
 *   baseline?: [string, any][],
 *   digests?: {
 *     classifySha256: string,
 *     records: { pool: Record<string, string>, control: Record<string, string>, baseline: Record<string, string> },
 *   },
 * }} input
 */
export function buildReport({
  summarizeQueries,
  pool,
  control = [],
  baseline = [],
  digests = undefined,
}) {
  const out = {
    inputs: {
      pool: pool.map(([k]) => k),
      control: control.map(([k]) => k),
      baseline: baseline.map(([k]) => k),
      irClassifySha256: digests?.classifySha256 ?? null,
      recordsSha256: digests?.records ?? null,
    },
    definitions: DEFINITIONS,
    sources: {},
    works: {},
    checks: {},
    pooled: null,
    perWorkD1: {},
    memoryControl: null,
  };
  const seen = new Set();
  // runId は pool・control・baseline をまたいで一意（同じ records の二重投入や取り違えを止める）。
  const runIds = new Map();
  const claimRunId = (key, d) => {
    if (typeof d.runId !== "string" || d.runId === "")
      throw new Error(`${key}: records に runId が無い`);
    const prev = runIds.get(d.runId);
    if (prev !== undefined)
      throw new Error(`runId が重複: ${d.runId}（${prev} と ${key}）`);
    runIds.set(d.runId, key);
  };
  const built = {};
  const pooledQueries = [];
  for (const [role, entries, expectedRole] of [
    ["pool", pool, POOL_ROLE],
    ["control", control, CONTROL_ROLE],
  ]) {
    for (const [key, d] of entries) {
      assertKey(key);
      if (seen.has(key)) throw new Error(`key が重複: ${key}`);
      seen.add(key);
      claimRunId(key, d);
      if (d.role !== expectedRole)
        throw new Error(
          `${key}: records の role が ${JSON.stringify(d.role ?? null)}（--${role} は ${JSON.stringify(expectedRole)} が必要）`,
        );
      const b = buildWork(summarizeQueries, d);
      built[key] = { ...b, role, d };
      out.works[key] = b.work;
      out.sources[key] = {
        role,
        recordsRole: d.role ?? null,
        runId: d.runId ?? null,
        status: d.status,
        preregistrationSha256: d.preregistration?.sha256 ?? null,
      };
      if (d.summary) {
        out.checks[key] =
          JSON.stringify(d.summary) === JSON.stringify(b.summary)
            ? "harness の summary と一致"
            : "harness の summary と不一致";
      }
      if (role === "pool") pooledQueries.push(...b.all);
      const d1 = d1Of(b.summary);
      out.perWorkD1[key] = {
        role,
        ...d1,
        ...(role === "control" ? { readAsControl: d1.withinLimit } : {}),
      };
    }
  }

  // pooled：pool の作品だけ（control は入れない）。
  const pooled = summarizeQueries(pooledQueries);
  out.pooled = {
    ...brief(pooled),
    byPriorScenes: Object.fromEntries(
      BUCKETS.map((b) => [
        b,
        brief(
          summarizeQueries(
            pooledQueries.filter((q) => q.priorScenesBucket === b),
          ),
        ),
      ]),
    ),
    tail10: brief(summarizeQueries(pooledQueries.filter((q) => q.tail10))),
    D0: {
      irReadyRawLt8: pooled.slotUseRate.denominator,
      threshold: D0_THRESHOLD,
      decidable: pooled.slotUseRate.denominator >= D0_THRESHOLD,
    },
    D1: d1Of(pooled),
  };

  // memoryControl：m-ja-2（基準）と control の各作品を並べる。差は値の差だけ。
  const ref = built[MEMORY_REFERENCE];
  if (control.length > 0 && ref?.role !== "pool")
    throw new Error(
      `--control があるのに --pool に ${MEMORY_REFERENCE} が無い（記憶の対照の基準）`,
    );
  if (ref && control.length > 0) {
    const profiles = {
      [MEMORY_REFERENCE]: memoryProfile(ref.d, ref.summary, ref.work),
    };
    const differences = {};
    for (const [key] of control) {
      const c = built[key];
      profiles[key] = memoryProfile(c.d, c.summary, c.work);
      differences[key] = memoryDelta(profiles[MEMORY_REFERENCE], profiles[key]);
    }
    out.memoryControl = {
      reference: MEMORY_REFERENCE,
      deltaDefinition: "control の値 − 基準（m-ja-2）の値。検定はしない",
      profiles,
      differences,
    };
  }

  // baselineComparison：第 5 版の records との位置ごとの比較。
  if (baseline.length > 0) {
    out.baselineComparison = {};
    const baselineKeys = new Set();
    for (const [key, d] of baseline) {
      assertKey(key);
      if (baselineKeys.has(key))
        throw new Error(`--baseline の key が重複: ${key}`);
      baselineKeys.add(key);
      const current = built[key];
      if (!current || current.role !== "pool")
        throw new Error(`--baseline の key ${key} が --pool に無い`);
      if (d.role !== BASELINE_ROLE)
        throw new Error(
          `${key}: --baseline の records の role が ${JSON.stringify(d.role ?? null)}（${JSON.stringify(BASELINE_ROLE)} が必要）`,
        );
      claimRunId(`baseline:${key}`, d);
      if (typeof d.language !== "string" || d.language !== current.d.language)
        throw new Error(
          `${key}: --baseline の language が ${JSON.stringify(d.language ?? null)}（現行は ${JSON.stringify(current.d.language ?? null)}）`,
        );
      if (
        !Number.isInteger(d.sceneCount) ||
        d.sceneCount !== current.d.sceneCount
      )
        throw new Error(
          `${key}: --baseline の sceneCount が ${JSON.stringify(d.sceneCount ?? null)}（現行は ${JSON.stringify(current.d.sceneCount ?? null)}）`,
        );
      out.baselineComparison[key] = compareBaseline(
        summarizeQueries,
        d,
        current.d,
      );
    }
  }

  // 240 字で切れた失敗の位置（label から後ろの code が落ちている可能性がある）。works は第 5 版と
  // 同じ形に保つので、別の項目にする。
  out.extractionTruncatedShapes = Object.fromEntries(
    Object.entries(built).map(([k, b]) => [
      k,
      extractionOf(b.d)
        .filter((e) => !isCompleted(e) && isTruncatedShape(e))
        .map((e) => e.position),
    ]),
  );
  out.extractionTiming = Object.fromEntries(
    Object.entries(built).map(([k, b]) => [k, extractionTimingOf(b.d)]),
  );
  return out;
}

/**
 * argv（classify の path の後ろ）から --pool／--control／--baseline の key=file を集める。
 * --pool に m-ja-2、--control が 1 つ以上は必須（記憶の対照を黙って省かない）。
 * 同じ flag の中の同じ key の重複は失敗。
 */
export function parseArgs(argv) {
  const [classifyPath, ...rest] = argv;
  const flags = { "--pool": [], "--control": [], "--baseline": [] };
  let current = null;
  for (const arg of rest) {
    if (Object.hasOwn(flags, arg)) {
      current = arg;
      continue;
    }
    if (!current) throw new Error(`flag の前の引数: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq <= 0 || eq === arg.length - 1)
      throw new Error(`key=records の形ではない: ${arg}`);
    const key = arg.slice(0, eq);
    assertKey(key);
    if (flags[current].some(([k]) => k === key))
      throw new Error(`${current} の key が重複: ${key}`);
    flags[current].push([key, arg.slice(eq + 1)]);
  }
  if (!classifyPath || classifyPath.startsWith("--"))
    throw new Error("ir-classify.mjs の path が必要");
  if (flags["--pool"].length === 0) throw new Error("--pool が必要");
  if (!flags["--pool"].some(([k]) => k === MEMORY_REFERENCE))
    throw new Error(`--pool に ${MEMORY_REFERENCE} が必要（記憶の対照の基準）`);
  if (flags["--control"].length === 0)
    throw new Error("--control が必要（記憶の対照）");
  return {
    classifyPath,
    pool: flags["--pool"],
    control: flags["--control"],
    baseline: flags["--baseline"],
  };
}

const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/** records を読み、本文の sha256 も返す（読んだ bytes から計算する）。 */
function load(entries) {
  const data = [];
  const digests = {};
  for (const [key, file] of entries) {
    const bytes = fs.readFileSync(file);
    data.push([key, JSON.parse(bytes.toString("utf8"))]);
    digests[key] = sha256(bytes);
  }
  return { data, digests };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const classifyBytes = fs.readFileSync(args.classifyPath);
  const { summarizeQueries } = await import(
    pathToFileURL(args.classifyPath).href
  );
  const pool = load(args.pool);
  const control = load(args.control);
  const baseline = load(args.baseline);
  const report = buildReport({
    summarizeQueries,
    pool: pool.data,
    control: control.data,
    baseline: baseline.data,
    digests: {
      classifySha256: sha256(classifyBytes),
      records: {
        pool: pool.digests,
        control: control.digests,
        baseline: baseline.digests,
      },
    },
  });
  console.log(JSON.stringify(report, null, 1));
}

/** symlink 経由の起動でも直接実行と判定する。 */
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  await main();
}
