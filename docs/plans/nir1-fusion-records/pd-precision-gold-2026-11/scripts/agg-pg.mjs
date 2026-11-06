// 融合の枠の候補の precision を測る小さな Gold の集計（読むだけ）。事前登録 第 1 版 §2〜§7・§11 の仕様。
//   selection : records → 層・query の選択・候補（本文なし）
//   aggregate : 選択＋注釈 → rank ごとの precision・Wilson・κ・arm・判断規則 §7
// 出力は位置・層・ラベル・計算値だけの JSON（Scene の本文・題名・AI の応答の本文は扱わない）。
//
// 使い方：
//   node agg-pg.mjs selection --records m-ja-2=<records> g-ja-1=<records> \
//        [--seed <種>] [--fixed-from <selection-run1.json>] [--prior <selection-run1.json>] [--out <file>]
//   node agg-pg.mjs compare --selection1 <selection-run1.json> --selection2 <selection-run2.json> \
//        [--records1 m-ja-2=<f> g-ja-1=<f> --records2 m-ja-2=<f> g-ja-1=<f>] [--out <file>]   （run 2 の run 間の差。§5）
//   node agg-pg.mjs aggregate --selection <selection.json> --user <annotations.json> \
//        [--ai <annotations.json>] [--ai2 <annotations.json>] [--out <file>]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---- 事前登録の固定値（§2〜§7） -------------------------------------------------------------
export const SEED = "2026-11-06-precision-gold-1";
// contracts に置いた事前登録の写し（repo の外の原本 preregistration-precision-gold-v1.md と sha256 が同一）。
export const PREREG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../preregistration-v1.md");
export const WORKS = ["m-ja-2", "g-ja-1"]; // 割当ての優先順（先に列挙した作品の層の順序は出力順にも使う）
export const QUOTA = { "m-ja-2": 8, "g-ja-1": 7 };
export const PER_STRATUM = 15;
export const RAW_MAX = 8; // Raw が 8 件のとき「満杯」
export const PRIOR_LIMIT = 30; // 前の Scene が 30 以下／超
export const IR_RANKS = [1, 2, 3];
export const RAW_RANKS = [6, 7, 8];
export const FLOOR_L = 0.5; // §7 下限 L
export const DELTA = 0; // §7 相対の許容差 Δ
export const D0_MIN_VALID_QUERIES = 40;
export const D0_MIN_KAPPA = 0.4;
export const D0_MIN_PAIRS_PER_RANK = 30;
export const D0_MAX_UNAVAILABLE = 0.1;
export const BOOTSTRAP_B = 10000;
const Z95 = 1.959963984540054;

export const STRATA = [
  { id: "full-le30", rawFull: true, priorLe30: true },
  { id: "full-gt30", rawFull: true, priorLe30: false },
  { id: "short-le30", rawFull: false, priorLe30: true },
  { id: "short-gt30", rawFull: false, priorLe30: false },
];

// §6 の arm。cap=true は Raw と合わせて 8 件を超えない（足せるのは 8−r 件まで）。
export const ARMS = {
  S1: { k: 1, cap: true },
  S2: { k: 2, cap: true },
  S3: { k: 3, cap: true },
  O1: { k: 1, cap: false },
  O2: { k: 2, cap: false },
};

export const sha256Hex = (data) =>
  crypto.createHash("sha256").update(data).digest("hex");
export const fileSha256 = (file) => sha256Hex(fs.readFileSync(file));

// ---- 統計の小道具 ------------------------------------------------------------------------
/** 中央値（偶数個は中央 2 つの平均）。空は null。agg-v6.mjs と同じ定義。 */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Wilson 95％ 区間。n=0 は null。 */
export function wilson(k, n, z = Z95) {
  if (n === 0) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** 0/n の片側 95％ 上限（3/n の近似）。 */
export const zeroUpper95 = (n) => (n === 0 ? null : 3 / n);

/** 2 値の Cohen の κ（a=両方 1、b=A のみ 1、c=B のみ 1、d=両方 0）。pe=1 のときは null。 */
export function cohenKappa({ a, b, c, d }) {
  const n = a + b + c + d;
  if (n === 0) return null;
  const po = (a + d) / n;
  const pe = ((a + b) * (a + c) + (c + d) * (b + d)) / (n * n);
  if (pe === 1) return null;
  return (po - pe) / (1 - pe);
}

/** seed 固定の PRNG（mulberry32）。bootstrap の再現用。 */
export function makeRng(seedText) {
  let t = sha256Hex(seedText).slice(0, 8);
  let s = parseInt(t, 16) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const ratio = (k, n) => (n === 0 ? null : k / n);

/** 1 つの分母・分子の集計セル。 */
export function cell(k, n) {
  return {
    k,
    n,
    p: ratio(k, n),
    wilson95: wilson(k, n),
    zeroUpper95: k === 0 ? zeroUpper95(n) : null,
  };
}

// ---- records → query の事実 ----------------------------------------------------------------
/** query の事実（本文なし）。Raw の位置は query 内の全 sample で一致することを確かめる。 */
export function queryFacts(records, work) {
  const queries = records.checkpoints.flatMap((c) => c.queries ?? []);
  const seen = new Set();
  return queries.map((q) => {
    if (seen.has(q.position))
      throw new Error(`${work}: query の位置が重複: ${q.position}`);
    seen.add(q.position);
    const rawPositions = q.samples[0].rawPositions ?? [];
    const rawConsistent = q.samples.every(
      (s) =>
        JSON.stringify(s.rawPositions ?? []) === JSON.stringify(rawPositions),
    );
    if (!rawConsistent)
      throw new Error(`${work}@${q.position}: Raw の位置が sample 間で不一致`);
    if (rawPositions.some((p) => p >= q.position))
      throw new Error(`${work}@${q.position}: query 以降の Raw の位置がある`);
    const admitted = q.probe?.admittedPositions ?? [];
    // 候補は query より前で Raw に無いもの（cosine の降順を保つ）。§3
    const irOutsideRaw = admitted.filter(
      (p) => p < q.position && !rawPositions.includes(p),
    );
    return {
      work,
      position: q.position,
      priorScenes: q.priorScenes,
      rawPositions,
      rawCount: rawPositions.length,
      probeStatus: q.probe?.status ?? "missing",
      irOutsideRaw,
    };
  });
}

export function stratumOf(facts) {
  const rawFull = facts.rawCount >= RAW_MAX;
  const priorLe30 = facts.priorScenes <= PRIOR_LIMIT;
  return STRATA.find((s) => s.rawFull === rawFull && s.priorLe30 === priorLe30)
    .id;
}

/** §3 の候補：IR の Raw 外の rank 1〜3 と Raw の rank 6〜8（存在するものだけ）。 */
export function candidatesOf(facts) {
  const ir = facts.irOutsideRaw.slice(0, IR_RANKS.length).map((position, i) => ({
    position,
    rank: i + 1,
    origin: "ir",
  }));
  const raw = RAW_RANKS.filter((rank) => facts.rawPositions[rank - 1] !== undefined).map(
    (rank) => ({ position: facts.rawPositions[rank - 1], rank, origin: "raw" }),
  );
  return [...ir, ...raw];
}

export const pairId = (work, queryPosition, candidatePosition) =>
  `${work}|${queryPosition}|${candidatePosition}`;

// ---- query の選択（§2） -----------------------------------------------------------------
export const queryHash = (seed, work, position) =>
  sha256Hex(`${seed}|${work}|${position}`);

/**
 * 層ごとに、各作品の query を hash の昇順に並べ、割当て数を先頭から取る。足りない作品の不足は
 * 他方の作品が続きの順で埋める（層の合計は PER_STRATUM、全体で足りなければあるだけ）。
 * @param {Record<string, ReturnType<typeof queryFacts>>} factsByWork
 */
export function selectQueries(
  factsByWork,
  { seed = SEED, quota = QUOTA } = {},
) {
  const works = Object.keys(factsByWork);
  const selected = [];
  const strataSizes = {};
  const shortfall = {};
  for (const stratum of STRATA) {
    const pools = {};
    for (const work of works) {
      pools[work] = factsByWork[work]
        .filter((f) => stratumOf(f) === stratum.id)
        .map((f) => ({ facts: f, hash: queryHash(seed, work, f.position) }))
        .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
      (strataSizes[work] ??= {})[stratum.id] = pools[work].length;
    }
    const take = {};
    let deficit = 0;
    for (const work of works) {
      take[work] = Math.min(quota[work], pools[work].length);
      deficit += quota[work] - take[work];
    }
    // 不足は、まだ余っている作品が続きから埋める（works の順）。
    for (const work of works) {
      if (deficit === 0) break;
      const extra = Math.min(deficit, pools[work].length - take[work]);
      take[work] += extra;
      deficit -= extra;
    }
    if (deficit > 0) shortfall[stratum.id] = deficit;
    for (const work of works)
      for (const item of pools[work].slice(0, take[work]))
        selected.push({ stratum: stratum.id, hash: item.hash, facts: item.facts });
  }
  return { selected, strataSizes, shortfall };
}

/** IR の Raw 外の件数の分布（§2：2 件以上・3 件以上の割合）。 */
export function irOutsideStats(factsList) {
  const queries = factsList.length;
  const ge2 = factsList.filter((f) => f.irOutsideRaw.length >= 2).length;
  const ge3 = factsList.filter((f) => f.irOutsideRaw.length >= 3).length;
  return {
    queries,
    ge2,
    ge2Rate: ratio(ge2, queries),
    ge3,
    ge3Rate: ratio(ge3, queries),
  };
}

/**
 * selection を作る。fixedFrom（run 1 の selection）があれば、その query をそのまま使い（run 2）、
 * prior の pair に無い候補に newPair を付ける。
 */
export function buildSelection({
  recordsByWork,
  recordsMeta = {},
  seed = SEED,
  fixedFrom = null,
  prior = null,
  preregSha256 = null,
  fixedFromSha256 = null,
  priorSha256 = null,
}) {
  const factsByWork = Object.fromEntries(
    Object.entries(recordsByWork).map(([w, r]) => [w, queryFacts(r, w)]),
  );
  let chosen;
  let strataSizes;
  let shortfall = {};
  if (fixedFrom) {
    const byKey = new Map(
      Object.values(factsByWork)
        .flat()
        .map((f) => [`${f.work}|${f.position}`, f]),
    );
    chosen = fixedFrom.queries.map((q) => {
      const facts = byKey.get(`${q.work}|${q.queryPosition}`);
      if (!facts)
        throw new Error(`fixedFrom の query が records に無い: ${q.work}@${q.queryPosition}`);
      return { stratum: stratumOf(facts), hash: q.queryHash, facts };
    });
    strataSizes = fixedFrom.strataSizes;
  } else {
    ({ selected: chosen, strataSizes, shortfall } = selectQueries(factsByWork, { seed }));
  }
  const priorPairs = new Set(
    (prior?.queries ?? []).flatMap((q) =>
      q.candidates.map((c) => pairId(q.work, q.queryPosition, c.position)),
    ),
  );
  const queries = chosen.map(({ stratum, hash, facts }) => ({
    work: facts.work,
    queryPosition: facts.position,
    priorScenes: facts.priorScenes,
    rawCount: facts.rawCount,
    stratum,
    probeStatus: facts.probeStatus,
    irOutsideRawCount: facts.irOutsideRaw.length,
    queryHash: hash,
    candidates: candidatesOf(facts).map((c) => ({
      ...c,
      pairId: pairId(facts.work, facts.position, c.position),
      ...(prior ? { newPair: !priorPairs.has(pairId(facts.work, facts.position, c.position)) } : {}),
    })),
  }));
  const selectedFacts = chosen.map((c) => c.facts);
  const countBy = (list, keyFn) =>
    list.reduce((acc, x) => ((acc[keyFn(x)] = (acc[keyFn(x)] ?? 0) + 1), acc), {});
  const candidates = queries.flatMap((q) => q.candidates);
  return {
    schemaVersion: "fusion-slot-pg-selection/1",
    evidenceScope: "not-cp4-evidence",
    preregistration: { name: "preregistration-precision-gold-v1.md", sha256: preregSha256 },
    run: fixedFrom ? 2 : 1,
    ...(fixedFrom ? { derivedFrom: { fixedFromSha256, priorSha256: prior ? priorSha256 : null } } : {}),
    seed: fixedFrom ? fixedFrom.seed : seed,
    quota: QUOTA,
    perStratum: PER_STRATUM,
    sources: recordsMeta,
    strataSizes,
    shortfall,
    selectedCounts: {
      total: queries.length,
      byStratum: countBy(queries, (q) => q.stratum),
      byWork: countBy(queries, (q) => q.work),
      byWorkStratum: countBy(queries, (q) => `${q.work}|${q.stratum}`),
    },
    candidateCounts: {
      total: candidates.length,
      ir: candidates.filter((c) => c.origin === "ir").length,
      raw: candidates.filter((c) => c.origin === "raw").length,
      byRank: countBy(candidates, (c) => `${c.origin}${c.rank}`),
      ...(prior ? { newPairs: candidates.filter((c) => c.newPair).length } : {}),
    },
    irOutsideRaw: {
      allQueriesByWork: Object.fromEntries(
        Object.entries(factsByWork).map(([w, f]) => [w, irOutsideStats(f)]),
      ),
      selected: irOutsideStats(selectedFacts),
    },
    probeUnavailableSelected: queries.filter((q) => q.probeStatus !== "available").length,
    queries,
  };
}

// ---- 枠 1 の再現（§6） ------------------------------------------------------------------
/** arm が足す IR の候補（rank 順）。r は同じ run の Raw の件数、cands は IR の Raw 外の候補列。 */
export function armAdds(r, irCandidates, armId) {
  const arm = ARMS[armId];
  const room = arm.cap ? Math.max(0, RAW_MAX - r) : Infinity;
  return irCandidates.slice(0, Math.min(arm.k, room));
}

/**
 * 現行の枠 1（S1）が records の `kind:"ir"` の行を再現するか。irStatus が available の sample は
 * S1 の予測と一致すること、available でない sample は ir の行が無いこと。
 */
export function reproduceIrRows(records, work) {
  let samples = 0;
  let withIr = 0;
  let mismatches = 0;
  let unavailableSamples = 0;
  const examples = [];
  for (const f of queryFacts(records, work)) {
    const q = records.checkpoints.flatMap((c) => c.queries).find((x) => x.position === f.position);
    const ir = f.irOutsideRaw.slice(0, 3);
    for (const s of q.samples) {
      samples += 1;
      const actual = s.rows.filter((r) => r.kind === "ir").map((r) => r.position);
      if (actual.length > 0) withIr += 1;
      let predicted = [];
      if (s.irStatus === "available") predicted = armAdds(f.rawCount, ir, "S1");
      else unavailableSamples += 1;
      const predictedPositions = predicted;
      if (JSON.stringify(actual) !== JSON.stringify(predictedPositions)) {
        mismatches += 1;
        if (examples.length < 3) examples.push({ work, position: f.position });
      }
    }
  }
  return { samples, withIr, mismatches, unavailableSamples, examples };
}

// ---- 注釈 -------------------------------------------------------------------------------
export const LABELS = ["none", "partial", "strict"];
export const isStrict = (label) => label === "strict";
export const isPartial = (label) => label === "partial" || label === "strict";

/** 注釈 file を検証して Map(pairId → label) にする。 */
export function loadAnnotations(raw, selection, selectionSha256, role) {
  if (raw.schemaVersion !== "fusion-slot-pg-annotations/1")
    throw new Error(`${role}: schemaVersion が想定外`);
  if (raw.selectionSha256 && raw.selectionSha256 !== selectionSha256)
    throw new Error(`${role}: selectionSha256 が selection と一致しない`);
  const valid = new Set(selection.queries.flatMap((q) => q.candidates.map((c) => c.pairId)));
  const map = new Map();
  for (const entry of raw.labels) {
    const id = pairId(entry.work, entry.queryPosition, entry.candidatePosition);
    if (!valid.has(id)) throw new Error(`${role}: selection に無い組: ${id}`);
    if (!LABELS.includes(entry.label))
      throw new Error(`${role}: label が不正: ${id}`);
    if (map.has(id)) throw new Error(`${role}: 組が重複: ${id}`);
    map.set(id, entry.label);
  }
  return map;
}

/** annotator の組合せ（variant）。both／either は両方が付けた組だけが分母。 */
export function variantFlag(variant, level, maps, id) {
  const test = level === "strict" ? isStrict : isPartial;
  const user = maps.user?.get(id);
  const ai = maps.ai?.get(id);
  if (variant === "user") return user === undefined ? null : test(user);
  if (variant === "ai") return ai === undefined ? null : test(ai);
  if (user === undefined || ai === undefined) return null;
  return variant === "both" ? test(user) && test(ai) : test(user) || test(ai);
}

function variantsAvailable(maps) {
  const v = [];
  if (maps.user) v.push("user");
  if (maps.ai) v.push("ai");
  if (maps.user && maps.ai) v.push("both", "either");
  return v;
}

const groupsOf = (candidate) => {
  const groups = [`${candidate.origin}${candidate.rank}`];
  groups.push(candidate.origin === "ir" ? "irAll" : "rawAll");
  return groups;
};
export const GROUPS = ["ir1", "ir2", "ir3", "irAll", "raw6", "raw7", "raw8", "rawAll"];

/** pairs（{ candidate, queryRef }）の rank ごとの precision の表。 */
function precisionTable(pairs, variant, level, maps) {
  const acc = Object.fromEntries(GROUPS.map((g) => [g, { k: 0, n: 0 }]));
  for (const { candidate } of pairs) {
    const flag = variantFlag(variant, level, maps, candidate.pairId);
    if (flag === null) continue;
    for (const g of groupsOf(candidate)) {
      acc[g].n += 1;
      if (flag) acc[g].k += 1;
    }
  }
  return Object.fromEntries(GROUPS.map((g) => [g, cell(acc[g].k, acc[g].n)]));
}

function allPairs(queries) {
  return queries.flatMap((q) => q.candidates.map((candidate) => ({ candidate, q })));
}

// ---- 対応のある比較（query 単位の bootstrap） -------------------------------------------
/**
 * 各 query の (irK, irN, rawK, rawN) の配列から、プールした差（IR − Raw）の点推定と、query 単位の
 * bootstrap（percentile 95％。B・乱数は固定）の区間を出す。
 */
export function pairedDifference(rows, seedText, B = BOOTSTRAP_B) {
  const n = rows.length;
  if (n === 0) return { nQueries: 0, irP: null, rawP: null, delta: null, ci95: null };
  const sum = (list) =>
    list.reduce(
      (a, r) => ({ irK: a.irK + r.irK, irN: a.irN + r.irN, rawK: a.rawK + r.rawK, rawN: a.rawN + r.rawN }),
      { irK: 0, irN: 0, rawK: 0, rawN: 0 },
    );
  const point = sum(rows);
  const irP = point.irK / point.irN;
  const rawP = point.rawK / point.rawN;
  const rng = makeRng(seedText);
  const deltas = [];
  for (let b = 0; b < B; b += 1) {
    const sample = [];
    for (let i = 0; i < n; i += 1) sample.push(rows[Math.floor(rng() * n)]);
    const s = sum(sample);
    deltas.push(s.irK / s.irN - s.rawK / s.rawN);
  }
  deltas.sort((a, b) => a - b);
  const at = (q) => deltas[Math.min(B - 1, Math.max(0, Math.floor(q * B)))];
  return {
    nQueries: n,
    irP,
    rawP,
    delta: irP - rawP,
    ci95: [at(0.025), at(0.975)],
  };
}

function pairedRows(queries, variant, level, maps, irRanks) {
  const rows = [];
  for (const q of queries) {
    const ir = q.candidates.filter((c) => c.origin === "ir" && irRanks.includes(c.rank));
    const raw = q.candidates.filter((c) => c.origin === "raw");
    const tally = (list) =>
      list.reduce(
        (a, c) => {
          const f = variantFlag(variant, level, maps, c.pairId);
          return f === null ? a : { k: a.k + (f ? 1 : 0), n: a.n + 1 };
        },
        { k: 0, n: 0 },
      );
    const i = tally(ir);
    const r = tally(raw);
    if (i.n === 0 || r.n === 0) continue;
    rows.push({ irK: i.k, irN: i.n, rawK: r.k, rawN: r.n });
  }
  return rows;
}

// ---- κ ---------------------------------------------------------------------------------
export function kappaTable(mapA, mapB) {
  const out = {};
  for (const level of ["strict", "partial"]) {
    const test = level === "strict" ? isStrict : isPartial;
    const t = { a: 0, b: 0, c: 0, d: 0 };
    for (const [id, la] of mapA) {
      if (!mapB.has(id)) continue;
      const x = test(la);
      const y = test(mapB.get(id));
      if (x && y) t.a += 1;
      else if (x) t.b += 1;
      else if (y) t.c += 1;
      else t.d += 1;
    }
    const n = t.a + t.b + t.c + t.d;
    out[level] = {
      n,
      agree: t.a + t.d,
      agreeRate: ratio(t.a + t.d, n),
      disagree: t.b + t.c,
      table: t,
      kappa: cohenKappa(t),
    };
  }
  return out;
}

// ---- arm ------------------------------------------------------------------------------
function armTables(queries, maps) {
  const out = {};
  const variants = variantsAvailable(maps);
  for (const armId of Object.keys(ARMS)) {
    const perQuery = queries.map((q) => {
      const ir = q.candidates.filter((c) => c.origin === "ir");
      return { q, adds: armAdds(q.rawCount, ir, armId) };
    });
    const added = perQuery.flatMap((x) => x.adds);
    const arm = {
      queries: queries.length,
      queriesWithAdd: perQuery.filter((x) => x.adds.length > 0).length,
      addedRows: added.length,
      rowsAfterMax: Math.max(0, ...perQuery.map((x) => x.q.rawCount + x.adds.length)),
      queriesOverEight: perQuery.filter((x) => x.q.rawCount + x.adds.length > RAW_MAX).length,
      rawRowsUnchanged: true, // 足すのは末尾への追加だけで、Raw の行は並べ替えも削除もしない
      byVariant: {},
    };
    arm.addedQueryRate = ratio(arm.queriesWithAdd, arm.queries);
    for (const variant of variants) {
      const byLevel = {};
      for (const level of ["strict", "partial"]) {
        let k = 0;
        let n = 0;
        let wrong = 0;
        let unannotated = 0;
        for (const x of perQuery)
          for (const c of x.adds) {
            const f = variantFlag(variant, level, maps, c.pairId);
            if (f === null) {
              unannotated += 1;
              continue;
            }
            n += 1;
            if (f) k += 1;
            else wrong += 1;
          }
        byLevel[level] = {
          precision: cell(k, n),
          wrongAdds: wrong,
          wrongAddsPerQuery: ratio(wrong, queries.length),
          unannotatedAdds: unannotated,
        };
      }
      arm.byVariant[variant] = byLevel;
    }
    out[armId] = arm;
  }
  // S1 との差（同じ query 集合の対応のある差。誤った追加行数の 1 query あたりの平均の差）
  for (const armId of Object.keys(ARMS))
    for (const [variant, byLevel] of Object.entries(out[armId].byVariant))
      for (const level of Object.keys(byLevel))
        byLevel[level].wrongAddsPerQueryVsS1 =
          byLevel[level].wrongAddsPerQuery - out.S1.byVariant[variant][level].wrongAddsPerQuery;
  return out;
}

// ---- 判断規則 §7 -------------------------------------------------------------------------
function judgement(queries, maps, seed, kappaUserAi) {
  const primaries = ["user", "ai"].filter((r) => maps[r]);
  const reasons = [];
  // (1) 有効な query：候補を取れ（probe が available で、候補が 1 件以上）、注釈者の全員が全ての組を付けた query。
  //     候補が 0 件の query は §7 の「候補を取れ」に当たらないので有効に数えない（every が空で真になるのを避ける）。
  const withoutCandidates = queries.filter((q) => q.candidates.length === 0).length;
  const validQueries = queries.filter(
    (q) =>
      q.probeStatus === "available" &&
      q.candidates.length > 0 &&
      q.candidates.every((c) => primaries.every((r) => maps[r].has(c.pairId))),
  ).length;
  if (validQueries < D0_MIN_VALID_QUERIES)
    reasons.push(`有効 query が ${D0_MIN_VALID_QUERIES} 未満（${validQueries}）`);
  // (2) strict の κ（ユーザー対 AI）。
  const kappaStrict = kappaUserAi?.strict?.kappa;
  if (kappaStrict === undefined) reasons.push("κ（ユーザー対 AI）が算出できない（注釈者が揃わない）");
  else if (kappaStrict === null) reasons.push("κ が未定義（片方の値が一定）");
  else if (kappaStrict < D0_MIN_KAPPA)
    reasons.push(`strict の κ が ${D0_MIN_KAPPA} 未満（${kappaStrict.toFixed(3)}）`);
  // (4) 候補を取れなかった query が 10％ 超。
  const unavailable = queries.filter((q) => q.probeStatus !== "available").length;
  const unavailableRate = ratio(unavailable, queries.length);
  if (unavailableRate !== null && unavailableRate > D0_MAX_UNAVAILABLE)
    reasons.push(`候補を取れなかった query が 10％ 超（${unavailable}/${queries.length}）`);
  const globalIndeterminate = reasons.length > 0;

  const byVariant = {};
  for (const variant of variantsAvailable(maps)) {
    const ranks = [];
    let k = 0;
    let broken = false;
    let blocked = false;
    for (const r of IR_RANKS) {
      const cellR = precisionTable(allPairs(queries), variant, "strict", maps)[`ir${r}`];
      const rows = pairedRows(queries, variant, "strict", maps, [r]);
      const diff = pairedDifference(rows, `${seed}|bootstrap|${variant}|strict|ir${r}`);
      const rel = diff.delta !== null && diff.delta >= DELTA;
      const floor = cellR.wilson95 !== null && cellR.wilson95[0] >= FLOOR_L;
      const pass = rel && floor;
      // (3) その rank の注釈済みの組が 30 未満（主の注釈＝ユーザーの組で数える）。
      const annotated = allPairs(queries).filter(
        (x) => x.candidate.origin === "ir" && x.candidate.rank === r && variantFlag(variant, "strict", maps, x.candidate.pairId) !== null,
      ).length;
      const indeterminate = annotated < D0_MIN_PAIRS_PER_RANK;
      if (!broken && !blocked) {
        if (indeterminate) blocked = true;
        else if (pass) k += 1;
        else broken = true;
      }
      ranks.push({
        rank: r,
        annotatedPairs: annotated,
        indeterminate,
        relative: { ...diff, pass: rel },
        floor: { wilson95: cellR.wilson95, threshold: FLOOR_L, pass: floor },
        pass,
      });
    }
    byVariant[variant] = {
      ranks,
      k: globalIndeterminate ? null : k,
      kNote: globalIndeterminate
        ? "判断不能（上の indeterminateReasons）"
        : blocked
          ? `rank ${k + 1} の注釈済みの組が 30 未満のため、k は ${k} 以上としか言えない`
          : "rank 1 から連続して両条件を満たす最大の k",
    };
  }
  return {
    primaryAnnotator: "user",
    thresholds: { floorL: FLOOR_L, delta: DELTA },
    indeterminate: globalIndeterminate,
    indeterminateReasons: reasons,
    validQueries,
    queriesWithoutCandidates: withoutCandidates,
    unavailableQueries: unavailable,
    byVariant,
  };
}

// ---- 集計の本体 ------------------------------------------------------------------------
export function aggregate({ selection, selectionSha256, annotations, seed = null }) {
  const maps = {};
  for (const role of ["user", "ai", "ai2"])
    if (annotations[role])
      maps[role] = loadAnnotations(annotations[role], selection, selectionSha256, role);
  if (!maps.user) throw new Error("ユーザーの注釈（--user）が要る（主の注釈）");
  const usedSeed = seed ?? selection.seed;
  const queries = selection.queries;
  const variants = variantsAvailable(maps);

  const precision = {};
  const paired = {};
  for (const variant of variants) {
    precision[variant] = {};
    paired[variant] = {};
    for (const level of ["strict", "partial"]) {
      precision[variant][level] = precisionTable(allPairs(queries), variant, level, maps);
      paired[variant][level] = {};
      for (const [name, ranks] of [["ir1", [1]], ["ir2", [2]], ["ir3", [3]], ["irAll", IR_RANKS]])
        paired[variant][level][name] = pairedDifference(
          pairedRows(queries, variant, level, maps, ranks),
          `${usedSeed}|bootstrap|${variant}|${level}|${name}`,
        );
    }
  }
  const kappa = {};
  if (maps.ai) kappa.userVsAi = kappaTable(maps.user, maps.ai);
  if (maps.ai && maps.ai2) kappa.aiVsAi2 = kappaTable(maps.ai, maps.ai2);

  // 作品ごと・層ごと（ユーザー・AI の strict／partial。n 併記）
  const breakdown = { byWork: {}, byStratum: {} };
  for (const work of new Set(queries.map((q) => q.work)))
    breakdown.byWork[work] = breakdownOf(queries.filter((q) => q.work === work), maps);
  for (const s of STRATA)
    breakdown.byStratum[s.id] = breakdownOf(queries.filter((q) => q.stratum === s.id), maps);

  const coverage = Object.fromEntries(
    Object.entries(maps).map(([role, map]) => [role, { labeled: map.size }]),
  );
  coverage.totalPairs = queries.reduce((a, q) => a + q.candidates.length, 0);

  return {
    schemaVersion: "fusion-slot-pg-aggregate/1",
    evidenceScope: "not-cp4-evidence",
    selectionSha256,
    seed: usedSeed,
    queries: queries.length,
    coverage,
    annotators: Object.fromEntries(
      Object.entries(annotations).map(([role, a]) => [role, a.meta ?? null]),
    ),
    precision,
    paired,
    kappa,
    arms: armTables(queries, maps),
    judgement: judgement(queries, maps, usedSeed, kappa.userVsAi),
    breakdown,
  };
}

function breakdownOf(queries, maps) {
  const out = { queries: queries.length };
  for (const variant of variantsAvailable(maps).filter((v) => v === "user" || v === "ai")) {
    out[variant] = {};
    for (const level of ["strict", "partial"]) {
      const t = precisionTable(allPairs(queries), variant, level, maps);
      out[variant][level] = { irAll: t.irAll, rawAll: t.rawAll };
    }
  }
  return out;
}

// ---- run 2（事前登録 §5）：run 間の差 ----------------------------------------------------------
// run 2 は同じ query（run 1 の位置で固定）で候補を取り直す。注釈は組に付くので、run 1 に無い組（newPair）だけ追加で注釈する。
// 報告するのは、query ごとの候補集合の Jaccard、新しい組の割合、rank ごとの precision の差（注釈の後に計算）。

/** 2 つの集合の Jaccard。両方が空なら定義できないので null（中央値から外す）。 */
export function jaccard(a, b) {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size === 0 && y.size === 0) return null;
  let inter = 0;
  for (const v of x) if (y.has(v)) inter += 1;
  return inter / (x.size + y.size - inter);
}

const queryKey = (q) => `${q.work}|${q.queryPosition}`;
const nonNull = (list) => list.filter((v) => v !== null);
const medianCell = (values) => ({ n: values.length, median: median(values) });

/**
 * run 1・run 2 の selection（本文なし）の比較。query の集合（作品・位置・層・hash）が同一であることを検査し、
 * query ごとの Jaccard（全候補・IR だけ）、層ごと・作品ごとの中央値、新しい組・失った組の一覧と割合を出す。
 * run 2 の selection は run 1 を `--fixed-from` で固定して作るので、query の集合は一致するはずで、違えば止める。
 */
export function compareRuns(sel1, sel2) {
  const keys1 = sel1.queries.map(queryKey);
  const keys2 = sel2.queries.map(queryKey);
  if (JSON.stringify(keys1) !== JSON.stringify(keys2))
    throw new Error("run 1 と run 2 の query の集合（作品・位置・順序）が一致しない");
  const hashMismatch = sel1.queries.filter((q, i) => q.queryHash !== sel2.queries[i].queryHash).length;
  if (hashMismatch > 0) throw new Error(`query の hash が run 間で違う（${hashMismatch} 件）`);
  const stratumMismatches = sel1.queries.filter((q, i) => q.stratum !== sel2.queries[i].stratum).length;

  const perQuery = [];
  const newPairs = [];
  const lostPairs = [];
  let commonPairs = 0;
  let rankChanged = 0;
  for (let i = 0; i < sel1.queries.length; i += 1) {
    const q1 = sel1.queries[i];
    const q2 = sel2.queries[i];
    const byPair1 = new Map(q1.candidates.map((c) => [c.pairId, c]));
    const byPair2 = new Map(q2.candidates.map((c) => [c.pairId, c]));
    const positions = (q, origin) => q.candidates.filter((c) => !origin || c.origin === origin).map((c) => c.position);
    for (const c of q2.candidates) {
      const before = byPair1.get(c.pairId);
      if (!before)
        newPairs.push({
          work: q2.work, queryPosition: q2.queryPosition, stratum: q2.stratum,
          candidatePosition: c.position, origin: c.origin, rank: c.rank, pairId: c.pairId,
        });
      else {
        commonPairs += 1;
        if (before.origin !== c.origin || before.rank !== c.rank) rankChanged += 1;
      }
    }
    for (const c of q1.candidates)
      if (!byPair2.has(c.pairId))
        lostPairs.push({
          work: q1.work, queryPosition: q1.queryPosition, stratum: q1.stratum,
          candidatePosition: c.position, origin: c.origin, rank: c.rank, pairId: c.pairId,
        });
    perQuery.push({
      work: q2.work,
      queryPosition: q2.queryPosition,
      stratum: q2.stratum,
      run1: { candidates: q1.candidates.length, ir: positions(q1, "ir").length },
      run2: { candidates: q2.candidates.length, ir: positions(q2, "ir").length },
      jaccardAll: jaccard(positions(q1), positions(q2)),
      jaccardIr: jaccard(positions(q1, "ir"), positions(q2, "ir")),
      rawIdentical: JSON.stringify(positions(q1, "raw")) === JSON.stringify(positions(q2, "raw")),
      newPairs: q2.candidates.filter((c) => !byPair1.has(c.pairId)).length,
    });
  }

  const medians = (rows) => ({
    queries: rows.length,
    jaccardAll: medianCell(nonNull(rows.map((r) => r.jaccardAll))),
    jaccardIr: medianCell(nonNull(rows.map((r) => r.jaccardIr))),
  });
  const countBy = (list, keyFn) => list.reduce((acc, x) => ((acc[keyFn(x)] = (acc[keyFn(x)] ?? 0) + 1), acc), {});
  const total1 = sel1.queries.reduce((a, q) => a + q.candidates.length, 0);
  const total2 = sel2.queries.reduce((a, q) => a + q.candidates.length, 0);
  const queriesWithNew = perQuery.filter((r) => r.newPairs > 0);
  return {
    schemaVersion: "fusion-slot-pg-run-comparison/1",
    evidenceScope: "not-cp4-evidence",
    queries: perQuery.length,
    stratumMismatches,
    pairs: {
      run1: total1,
      run2: total2,
      common: commonPairs,
      rankOrOriginChangedInCommon: rankChanged,
      newPairs: newPairs.length,
      newPairRate: ratio(newPairs.length, total2),
      lostPairs: lostPairs.length,
      lostPairRate: ratio(lostPairs.length, total1),
      newByOrigin: countBy(newPairs, (p) => p.origin),
      newByRank: countBy(newPairs, (p) => `${p.origin}${p.rank}`),
      newByWork: countBy(newPairs, (p) => p.work),
      newByStratum: countBy(newPairs, (p) => p.stratum),
      queriesWithNewPair: queriesWithNew.length,
      queriesWithoutNewPair: perQuery.length - queriesWithNew.length,
      rawPairsIdentical: perQuery.every((r) => r.rawIdentical),
    },
    jaccard: {
      definition:
        "query ごとの候補集合（Scene の位置の集合。all＝IR の rank 1〜3＋Raw の rank 6〜8、ir＝IR だけ）の |∩|/|∪|。両方空の query は null で中央値から外す。Raw の候補は run 間で同一なので、all は ir より高く出る",
      overall: medians(perQuery),
      byStratum: Object.fromEntries(
        [...new Set(perQuery.map((r) => r.stratum))]
          .sort((x, y) => STRATA.findIndex((s) => s.id === x) - STRATA.findIndex((s) => s.id === y))
          .map((id) => [id, medians(perQuery.filter((r) => r.stratum === id))]),
      ),
      byWork: Object.fromEntries(
        [...new Set(perQuery.map((r) => r.work))].map((w) => [w, medians(perQuery.filter((r) => r.work === w))]),
      ),
    },
    perQuery,
    newPairList: newPairs,
    lostPairList: lostPairs,
  };
}

/** 複数の注釈の Map(pairId → label) を 1 つにまとめる（同じ組に違う label があれば止める）。 */
export function unionLabelMaps(...maps) {
  const out = new Map();
  for (const map of maps)
    for (const [id, label] of map) {
      if (out.has(id) && out.get(id) !== label) throw new Error(`同じ組に違う label がある: ${id}`);
      out.set(id, label);
    }
  return out;
}

/**
 * rank ごとの precision の run 間の差（run 2 − run 1）。注釈（同じ注釈者の labelMap。run 1 の注釈＋run 2 の追加分）の後に使う。
 * 各 run の組は、その run の selection の候補（組は run をまたいで同じ 1 組なので label は共通）。差は点推定どうしで、
 * 区間は付けない（2 run は同じ query の取り直しで、確率性の全体は測れない）。`newOnly` は run 2 の新しい組だけの precision。
 */
export function runPrecisionDelta({ sel1, sel2, labelMap, level = "strict" }) {
  const test = level === "strict" ? isStrict : isPartial;
  const tally = (selection, filter = () => true) => {
    const acc = Object.fromEntries(GROUPS.map((g) => [g, { k: 0, n: 0, unlabeled: 0 }]));
    for (const q of selection.queries)
      for (const c of q.candidates) {
        if (!filter(c)) continue;
        for (const g of groupsOf(c)) {
          const label = labelMap.get(c.pairId);
          if (label === undefined) acc[g].unlabeled += 1;
          else {
            acc[g].n += 1;
            if (test(label)) acc[g].k += 1;
          }
        }
      }
    return acc;
  };
  const a1 = tally(sel1);
  const a2 = tally(sel2);
  const aNew = tally(sel2, (c) => c.newPair === true);
  const out = {};
  for (const g of GROUPS) {
    const c1 = cell(a1[g].k, a1[g].n);
    const c2 = cell(a2[g].k, a2[g].n);
    out[g] = {
      run1: { ...c1, unlabeled: a1[g].unlabeled },
      run2: { ...c2, unlabeled: a2[g].unlabeled },
      newOnly: { ...cell(aNew[g].k, aNew[g].n), unlabeled: aNew[g].unlabeled },
      diff: c1.p === null || c2.p === null ? null : c2.p - c1.p,
    };
  }
  return { level, groups: out };
}

/**
 * 抽出の失敗・IR の時間切れ・probe が候補に与える影響の観測（本文なし）。records（run 1・run 2）と selection から数える。
 * 候補（IR の Raw 外 rank 1〜3）は probe の `admittedPositions`（deadline なし）から取るので、
 * ・probe が available でない query は候補（IR）を取れない（available でなければ admittedPositions が空）。
 * ・抽出に失敗した Scene は IR の索引に載らず、admittedPositions に出ない（観測：全 query で 0 件）。
 * ・IR の時間切れ（サンプルの irStatus が unavailable）は表示の行にだけ効き、probe の候補には効かない。
 */
export function failureImpact({ records1, records2, sel1, sel2 }) {
  const failedOf = (records) =>
    records.extraction.filter((e) => e.status !== "completed").map((e) => e.position).sort((a, b) => a - b);
  const works = [...new Set(sel2.queries.map((q) => q.work))];
  const out = {};
  for (const work of works) {
    const runs = { run1: records1[work], run2: records2[work] };
    const failed = { run1: failedOf(runs.run1), run2: failedOf(runs.run2) };
    const selected = { run1: sel1.queries.filter((q) => q.work === work), run2: sel2.queries.filter((q) => q.work === work) };
    const perRun = {};
    for (const run of ["run1", "run2"]) {
      const queries = runs[run].checkpoints.flatMap((c) => c.queries ?? []);
      const byPosition = new Map(queries.map((q) => [q.position, q]));
      const failedSet = new Set(failed[run]);
      const sel = selected[run];
      const hasStatus = (q, status) => q.samples.some((s) => s.irStatus === status);
      const countStatus = (list, status) => list.reduce((a, q) => a + q.samples.filter((s) => s.irStatus === status).length, 0);
      const timeoutPositions = queries.filter((q) => hasStatus(q, "unavailable")).map((q) => q.position);
      const selectedRaw = sel.map((q) => byPosition.get(q.queryPosition));
      const failedAdmitted = queries.reduce(
        (a, q) => a + (q.probe?.admittedPositions ?? []).filter((p) => failedSet.has(p)).length,
        0,
      );
      perRun[run] = {
        extraction: { failed: failed[run].length, positions: failed[run] },
        probeUnavailable: { allQueries: queries.filter((q) => q.probe?.status !== "available").length, selected: sel.filter((q) => q.probeStatus !== "available").length },
        // irStatus が unavailable のサンプルが時間切れ（records の summary の ir-timeout と一致）、empty は IR が空（時間切れではない）
        irTimeout: {
          allQueries: queries.filter((q) => hasStatus(q, "unavailable")).length,
          allSamples: countStatus(queries, "unavailable"),
          selectedQueries: selectedRaw.filter((q) => hasStatus(q, "unavailable")).length,
        },
        irEmpty: {
          allQueries: queries.filter((q) => hasStatus(q, "empty")).length,
          allSamples: countStatus(queries, "empty"),
          selectedQueries: selectedRaw.filter((q) => hasStatus(q, "empty")).length,
        },
        // 位置の範囲（選んだ query が時間切れ・失敗の位置より前に偏っているかを読むため）
        positions: {
          selectedQueryMax: sel.length ? Math.max(...sel.map((q) => q.queryPosition)) : null,
          irTimeoutMin: timeoutPositions.length ? Math.min(...timeoutPositions) : null,
          extractionFailedMin: failed[run].length ? failed[run][0] : null,
        },
        failedSceneInAdmittedPositions: failedAdmitted,
        selectedQueriesAfterAFailedScene: sel.filter((q) => failed[run].some((p) => p < q.queryPosition)).length,
        selectedQueriesOwnSceneFailed: sel.filter((q) => failedSet.has(q.queryPosition)).length,
        selectedQueriesWithoutIrCandidate: sel.filter((q) => !q.candidates.some((c) => c.origin === "ir")).length,
        selectedFailedScenesAsRawCandidate: sel.reduce(
          (a, q) => a + q.candidates.filter((c) => c.origin === "raw" && failedSet.has(c.position)).length,
          0,
        ),
      };
    }
    const irPairs = (queries) => queries.flatMap((q) => q.candidates.filter((c) => c.origin === "ir").map((c) => ({ q, c })));
    const f1 = new Set(failed.run1);
    const f2 = new Set(failed.run2);
    // run 2 の新しい IR の組のうち、run 1 では抽出に失敗していた Scene（run 1 では候補になれなかった）／
    // run 1 の IR の組のうち、run 2 で抽出に失敗した Scene（run 2 では候補になれない）
    const newIr = irPairs(selected.run2).filter(({ c }) => c.newPair === true);
    const run1Ir = irPairs(selected.run1);
    out[work] = {
      ...perRun,
      newIrPairs: newIr.length,
      newIrPairsOnSceneFailedInRun1: newIr.filter(({ c }) => f1.has(c.position)).length,
      run1IrPairs: run1Ir.length,
      run1IrPairsOnSceneFailedInRun2: run1Ir.filter(({ c }) => f2.has(c.position)).length,
    };
  }
  return out;
}

// ---- 入出力 ----------------------------------------------------------------------------
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, records: {} };
  for (let i = 0; i < rest.length; ) {
    const name = rest[i];
    if (!name.startsWith("--")) throw new Error(`引数の形が不正: ${name}`);
    if (name === "--records" || name === "--records1" || name === "--records2") {
      const bucket = name === "--records" ? opts.records : (opts[name.slice(2)] = {});
      i += 1;
      while (i < rest.length && !rest[i].startsWith("--")) {
        const [k, ...p] = rest[i].split("=");
        bucket[k] = p.join("=");
        i += 1;
      }
    } else {
      opts[name.slice(2)] = rest[i + 1];
      i += 2;
    }
  }
  return opts;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeOrPrint = (value, out) => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (out) fs.writeFileSync(out, text, { flag: "wx" });
  else process.stdout.write(text);
};

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command === "selection") {
    const recordsByWork = {};
    const recordsMeta = {};
    for (const work of WORKS) {
      const file = opts.records[work];
      if (!file) throw new Error(`--records ${work}=<file> が要る`);
      recordsByWork[work] = readJson(file);
      recordsMeta[work] = {
        file: path.basename(file),
        sha256: fileSha256(file),
        runId: recordsByWork[work].runId,
        scenesFileSha256: recordsByWork[work].scenesFileSha256,
      };
    }
    const selection = buildSelection({
      recordsByWork,
      recordsMeta,
      seed: opts.seed ?? SEED,
      fixedFrom: opts["fixed-from"] ? readJson(opts["fixed-from"]) : null,
      prior: opts.prior ? readJson(opts.prior) : null,
      fixedFromSha256: opts["fixed-from"] ? fileSha256(opts["fixed-from"]) : null,
      priorSha256: opts.prior ? fileSha256(opts.prior) : null,
      preregSha256: fs.existsSync(PREREG_PATH) ? fileSha256(PREREG_PATH) : null,
    });
    writeOrPrint(selection, opts.out);
    return;
  }
  if (opts.command === "aggregate") {
    if (!opts.selection || !opts.user) throw new Error("--selection と --user が要る");
    const selection = readJson(opts.selection);
    const annotations = { user: readJson(opts.user) };
    if (opts.ai) annotations.ai = readJson(opts.ai);
    if (opts.ai2) annotations.ai2 = readJson(opts.ai2);
    writeOrPrint(
      aggregate({ selection, selectionSha256: fileSha256(opts.selection), annotations }),
      opts.out,
    );
    return;
  }
  if (opts.command === "compare") {
    if (!opts.selection1 || !opts.selection2) throw new Error("--selection1 と --selection2 が要る");
    const sel1 = readJson(opts.selection1);
    const sel2 = readJson(opts.selection2);
    const comparison = compareRuns(sel1, sel2);
    comparison.inputs = {
      selection1: { file: path.basename(opts.selection1), sha256: fileSha256(opts.selection1) },
      selection2: { file: path.basename(opts.selection2), sha256: fileSha256(opts.selection2) },
    };
    if (opts.records1 && opts.records2) {
      const load = (m) => Object.fromEntries(WORKS.map((w) => [w, readJson(m[w])]));
      comparison.failureImpact = failureImpact({ records1: load(opts.records1), records2: load(opts.records2), sel1, sel2 });
    }
    writeOrPrint(comparison, opts.out);
    return;
  }
  throw new Error("使い方: agg-pg.mjs selection|aggregate|compare ...（冒頭のコメントを参照）");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
