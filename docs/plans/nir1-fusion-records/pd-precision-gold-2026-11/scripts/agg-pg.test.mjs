// agg-pg.mjs の試験：第 6 版の records で現行の枠 1 が `kind:"ir"` の行を再現すること、層の大きさ（事前登録 §2 の表）、
// 選択の決定性、統計の既知の値、arm・集計の小さな fixture。
// 実行：node --test agg-pg.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  armAdds,
  buildSelection,
  candidatesOf,
  cohenKappa,
  fileSha256,
  irOutsideStats,
  kappaTable,
  makeRng,
  median,
  pairedDifference,
  queryFacts,
  queryHash,
  reproduceIrRows,
  selectQueries,
  stratumOf,
  wilson,
  zeroUpper95,
  SEED,
} from "./agg-pg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V6 = path.resolve(HERE, "../../pd-ir-slot-2026-11-06");
const readRecords = (work) =>
  JSON.parse(fs.readFileSync(path.join(V6, `records-${work}-v6.json`), "utf8"));
const recordsByWork = { "m-ja-2": readRecords("m-ja-2"), "g-ja-1": readRecords("g-ja-1") };
const near = (actual, expected, eps = 5e-4) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} ≠ ${expected}`);

test("入力の records が第 6 版の SHA256SUMS と一致する", () => {
  const sums = fs.readFileSync(path.join(V6, "SHA256SUMS"), "utf8");
  for (const work of ["m-ja-2", "g-ja-1"]) {
    const name = `records-${work}-v6.json`;
    const line = sums.split("\n").find((l) => l.endsWith(`  ${name}`));
    assert.equal(line.split("  ")[0], fileSha256(path.join(V6, name)));
  }
});

test("median：偶数個は中央 2 つの平均、空は null", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("Wilson 95％・0/n の上限", () => {
  const [lo, hi] = wilson(7, 10);
  near(lo, 0.3968);
  near(hi, 0.8922);
  const [zlo, zhi] = wilson(0, 30);
  assert.equal(zlo, 0);
  near(zhi, 0.1135);
  assert.equal(wilson(0, 0), null);
  assert.equal(zeroUpper95(30), 0.1);
  assert.equal(zeroUpper95(60), 0.05);
  // 事前登録 §7：n=60 で下端が 0.5 に届く最小は 38/60。
  assert.ok(wilson(38, 60)[0] >= 0.5);
  assert.ok(wilson(37, 60)[0] < 0.5);
  // n=30 で点推定 0.70（21/30）が要る。
  assert.ok(wilson(21, 30)[0] >= 0.5);
  assert.ok(wilson(20, 30)[0] < 0.5);
});

test("Cohen の κ：既知の値", () => {
  near(cohenKappa({ a: 20, b: 5, c: 10, d: 15 }), 0.4, 1e-12); // po=0.7、pe=0.5
  assert.equal(cohenKappa({ a: 10, b: 0, c: 0, d: 10 }), 1);
  assert.equal(cohenKappa({ a: 0, b: 0, c: 0, d: 10 }), null); // pe=1 は未定義
  assert.equal(cohenKappa({ a: 0, b: 0, c: 0, d: 0 }), null);
  // strict／partial の段ごと：none=0、partial=partial のみ、strict=strict
  const A = new Map([["x", "strict"], ["y", "partial"], ["z", "none"], ["w", "none"]]);
  const B = new Map([["x", "strict"], ["y", "none"], ["z", "none"], ["w", "partial"]]);
  const k = kappaTable(A, B);
  assert.deepEqual(k.strict.table, { a: 1, b: 0, c: 0, d: 3 });
  assert.equal(k.strict.kappa, 1);
  assert.deepEqual(k.partial.table, { a: 1, b: 1, c: 1, d: 1 });
  assert.equal(k.partial.kappa, 0);
  assert.equal(k.partial.disagree, 2);
});

test("bootstrap は seed 固定で再現し、区間が点推定を含む", () => {
  const rows = [
    { irK: 1, irN: 1, rawK: 0, rawN: 1 },
    { irK: 1, irN: 1, rawK: 1, rawN: 1 },
    { irK: 0, irN: 1, rawK: 1, rawN: 2 },
    { irK: 1, irN: 2, rawK: 0, rawN: 1 },
  ];
  const a = pairedDifference(rows, "s", 500);
  const b = pairedDifference(rows, "s", 500);
  assert.deepEqual(a, b);
  assert.ok(a.ci95[0] <= a.delta && a.delta <= a.ci95[1]);
  const rng = makeRng("x");
  assert.equal(rng(), makeRng("x")());
});

test("現行の枠 1（S1）が records の kind:ir の行を再現する（事前登録 §6：138 sample、不一致 0）", () => {
  let samples = 0;
  let withIr = 0;
  let mismatches = 0;
  for (const [work, records] of Object.entries(recordsByWork)) {
    const r = reproduceIrRows(records, work);
    samples += r.samples;
    withIr += r.withIr;
    mismatches += r.mismatches;
  }
  assert.equal(samples, 696);
  assert.equal(withIr, 138);
  assert.equal(mismatches, 0);
  // g-ja-1 の 33 sample は IR が unavailable（Raw のみ）で、ir の行が無い。
  assert.equal(reproduceIrRows(recordsByWork["g-ja-1"], "g-ja-1").unavailableSamples, 33);
});

test("層の大きさが事前登録 §2 の表と一致する", () => {
  const expected = {
    "m-ja-2": { "full-le30": 13, "full-gt30": 73, "short-le30": 17, "short-gt30": 13 },
    "g-ja-1": { "full-le30": 12, "full-gt30": 81, "short-le30": 18, "short-gt30": 5 },
  };
  for (const [work, records] of Object.entries(recordsByWork)) {
    const sizes = {};
    for (const f of queryFacts(records, work))
      sizes[stratumOf(f)] = (sizes[stratumOf(f)] ?? 0) + 1;
    assert.deepEqual(sizes, expected[work]);
  }
});

test("IR が Raw 外に 2 件以上持つ query の数（§2：109/116、112/116、3 件以上は 99、107）", () => {
  const stats = Object.fromEntries(
    Object.entries(recordsByWork).map(([w, r]) => [w, irOutsideStats(queryFacts(r, w))]),
  );
  assert.deepEqual(
    [stats["m-ja-2"].ge2, stats["g-ja-1"].ge2, stats["m-ja-2"].ge3, stats["g-ja-1"].ge3],
    [109, 112, 99, 107],
  );
});

test("選択：決定的で、層ごとに 15（m-ja-2 8・g-ja-1 7、足りない層は他方で埋める）", () => {
  const factsByWork = Object.fromEntries(
    Object.entries(recordsByWork).map(([w, r]) => [w, queryFacts(r, w)]),
  );
  const a = selectQueries(factsByWork, { seed: SEED });
  const b = selectQueries(factsByWork, { seed: SEED });
  assert.deepEqual(a, b);
  assert.deepEqual(a.shortfall, {});
  const count = (work, stratum) =>
    a.selected.filter((s) => s.facts.work === work && s.stratum === stratum).length;
  for (const stratum of ["full-le30", "full-gt30", "short-le30"]) {
    assert.equal(count("m-ja-2", stratum), 8);
    assert.equal(count("g-ja-1", stratum), 7);
  }
  assert.equal(count("g-ja-1", "short-gt30"), 5); // 全件
  assert.equal(count("m-ja-2", "short-gt30"), 10); // 8＋不足の 2
  assert.equal(a.selected.length, 60);
  // 各作品・各層で、選ばれたものは sha256(種|作品|位置) の昇順の先頭から。
  for (const work of Object.keys(factsByWork))
    for (const stratum of ["full-le30", "full-gt30", "short-le30", "short-gt30"]) {
      const chosen = new Set(
        a.selected.filter((s) => s.facts.work === work && s.stratum === stratum).map((s) => s.facts.position),
      );
      const ordered = factsByWork[work]
        .filter((f) => stratumOf(f) === stratum)
        .map((f) => ({ p: f.position, h: queryHash(SEED, work, f.position) }))
        .sort((x, y) => (x.h < y.h ? -1 : 1));
      assert.deepEqual([...chosen].sort((x, y) => x - y), ordered.slice(0, chosen.size).map((o) => o.p).sort((x, y) => x - y));
    }
  // 種が違えば別の選択になる。
  const c = selectQueries(factsByWork, { seed: `${SEED}-other` });
  assert.notDeepEqual(
    c.selected.map((s) => s.facts.position),
    a.selected.map((s) => s.facts.position),
  );
});

test("選択の fallback：不足は他方が続きの順で埋める（合成）", () => {
  const mk = (work, n, rawCount, priorScenes) =>
    Array.from({ length: n }, (_, i) => ({
      work, position: 100 + i, priorScenes, rawPositions: Array.from({ length: rawCount }, (_, j) => j + 1),
      rawCount, probeStatus: "available", irOutsideRaw: [],
    }));
  const factsByWork = {
    "m-ja-2": [...mk("m-ja-2", 20, 8, 50)],
    "g-ja-1": [...mk("g-ja-1", 3, 8, 50)],
  };
  const r = selectQueries(factsByWork, { seed: "t" });
  const full = r.selected.filter((s) => s.stratum === "full-gt30");
  assert.equal(full.filter((s) => s.facts.work === "g-ja-1").length, 3);
  assert.equal(full.filter((s) => s.facts.work === "m-ja-2").length, 12);
  assert.equal(r.shortfall["full-le30"], 15); // 層が空
});

test("候補：IR の Raw 外の rank 1〜3 と Raw の rank 6〜8（本文を含まない）", () => {
  const facts = {
    work: "w", position: 20, priorScenes: 19, rawPositions: [5, 6, 7, 8, 9, 10, 11, 12], rawCount: 8,
    probeStatus: "available", irOutsideRaw: [3, 4, 15, 16],
  };
  assert.deepEqual(
    candidatesOf(facts).map((c) => `${c.origin}${c.rank}:${c.position}`),
    ["ir1:3", "ir2:4", "ir3:15", "raw6:10", "raw7:11", "raw8:12"],
  );
  const short = { ...facts, rawPositions: [5, 6, 7], rawCount: 3, irOutsideRaw: [3] };
  assert.deepEqual(candidatesOf(short).map((c) => `${c.origin}${c.rank}`), ["ir1"]);
});

test("selection-run1.json が現在の records・種から再生成した値と一致する", () => {
  const file = path.resolve(HERE, "../selection-run1.json");
  if (!fs.existsSync(file)) return;
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const fresh = buildSelection({
    recordsByWork,
    recordsMeta: saved.sources,
    seed: SEED,
    preregSha256: saved.preregistration.sha256,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)), saved);
  assert.equal(JSON.stringify(saved).includes('"text"'), false);
});

test("arm：S は 8−r 件まで、O は上限を外す", () => {
  const ir = [{ p: 1 }, { p: 2 }, { p: 3 }];
  const n = (r, arm) => armAdds(r, ir, arm).length;
  assert.deepEqual([n(0, "S1"), n(0, "S2"), n(0, "S3")], [1, 2, 3]);
  assert.deepEqual([n(7, "S1"), n(7, "S2"), n(7, "S3")], [1, 1, 1]);
  assert.deepEqual([n(8, "S1"), n(8, "S2"), n(8, "S3")], [0, 0, 0]);
  assert.deepEqual([n(8, "O1"), n(8, "O2"), n(7, "O2")], [1, 2, 2]);
  assert.equal(armAdds(5, [{ p: 1 }], "S3").length, 1); // 候補が足りなければ足せるだけ
  assert.equal(armAdds(0, [], "O1").length, 0);
});

// ---- 集計の fixture -------------------------------------------------------------------
const cand = (w, q, p, origin, rank) => ({ position: p, rank, origin, pairId: `${w}|${q}|${p}` });
const fixtureSelection = () => ({
  seed: "fx",
  queries: [
    {
      work: "m-ja-2", queryPosition: 10, priorScenes: 9, rawCount: 8, stratum: "full-le30", probeStatus: "available",
      candidates: [cand("m-ja-2", 10, 1, "ir", 1), cand("m-ja-2", 10, 2, "ir", 2), cand("m-ja-2", 10, 6, "raw", 6), cand("m-ja-2", 10, 7, "raw", 7)],
    },
    {
      work: "m-ja-2", queryPosition: 20, priorScenes: 19, rawCount: 3, stratum: "short-le30", probeStatus: "available",
      candidates: [cand("m-ja-2", 20, 1, "ir", 1), cand("m-ja-2", 20, 2, "ir", 2), cand("m-ja-2", 20, 3, "ir", 3)],
    },
  ],
});
const annot = (annotator, entries) => ({
  schemaVersion: "fusion-slot-pg-annotations/1",
  annotator,
  labels: entries.map(([work, q, c, label]) => ({ work, queryPosition: q, candidatePosition: c, label })),
});

test("aggregate：precision・arm・判断不能の小さな fixture", () => {
  const selection = fixtureSelection();
  const user = annot("user", [
    ["m-ja-2", 10, 1, "strict"], ["m-ja-2", 10, 2, "partial"], ["m-ja-2", 10, 6, "none"], ["m-ja-2", 10, 7, "strict"],
    ["m-ja-2", 20, 1, "strict"], ["m-ja-2", 20, 2, "none"], ["m-ja-2", 20, 3, "none"],
  ]);
  const ai = annot("ai", [
    ["m-ja-2", 10, 1, "strict"], ["m-ja-2", 10, 2, "strict"], ["m-ja-2", 10, 6, "none"], ["m-ja-2", 10, 7, "none"],
    ["m-ja-2", 20, 1, "partial"], ["m-ja-2", 20, 2, "none"], ["m-ja-2", 20, 3, "none"],
  ]);
  const out = aggregate({ selection, selectionSha256: "x", annotations: { user, ai } });
  const p = out.precision;
  assert.deepEqual([p.user.strict.ir1.k, p.user.strict.ir1.n], [2, 2]);
  assert.deepEqual([p.user.strict.ir2.k, p.user.strict.ir2.n], [0, 2]);
  assert.equal(p.user.strict.ir2.zeroUpper95, 1.5);
  assert.deepEqual([p.user.partial.ir2.k, p.user.partial.ir2.n], [1, 2]);
  assert.deepEqual([p.user.strict.raw7.k, p.user.strict.raw7.n], [1, 1]);
  assert.deepEqual([p.user.strict.rawAll.k, p.user.strict.rawAll.n], [1, 2]);
  // both／either は両者が付けた組が分母
  assert.deepEqual([p.both.strict.ir1.k, p.both.strict.ir1.n], [1, 2]); // q20: user strict／ai partial
  assert.deepEqual([p.either.strict.ir1.k, p.either.strict.ir1.n], [2, 2]);
  // arm：q10 は r=8、q20 は r=3
  assert.equal(out.arms.S1.addedRows, 1); // q20 の rank 1 だけ
  assert.equal(out.arms.O1.addedRows, 2);
  assert.equal(out.arms.S2.addedRows, 2); // q20 の rank 1〜2
  assert.equal(out.arms.O2.addedRows, 4);
  assert.equal(out.arms.O1.queriesOverEight, 1);
  assert.equal(out.arms.S3.addedRows, 3);
  assert.equal(out.arms.S1.rawRowsUnchanged, true);
  const o2 = out.arms.O2.byVariant.user.strict; // 追加: q10 の 1(strict),2(partial)、q20 の 1(strict),2(none)
  assert.deepEqual([o2.precision.k, o2.precision.n], [2, 4]);
  assert.equal(o2.wrongAdds, 2);
  assert.equal(o2.wrongAddsPerQuery, 1);
  assert.equal(out.arms.S1.byVariant.user.strict.wrongAdds, 0);
  assert.equal(o2.wrongAddsPerQuery - out.arms.S1.byVariant.user.strict.wrongAddsPerQuery, o2.wrongAddsPerQuery);
  // 有効 query が 40 未満なので判断不能
  assert.equal(out.judgement.indeterminate, true);
  assert.ok(out.judgement.indeterminateReasons.some((r) => r.includes("有効 query")));
  assert.equal(out.judgement.byVariant.user.k, null);
  assert.equal(out.kappa.userVsAi.strict.n, 7);
});

test("aggregate：注釈の検証（selection に無い組・重複・label の不正は拒否）", () => {
  const selection = fixtureSelection();
  const run = (labels) =>
    aggregate({ selection, selectionSha256: "x", annotations: { user: annot("user", labels) } });
  assert.throws(() => run([["m-ja-2", 10, 99, "strict"]]), /selection に無い組/);
  assert.throws(() => run([["m-ja-2", 10, 1, "strict"], ["m-ja-2", 10, 1, "none"]]), /重複/);
  assert.throws(() => run([["m-ja-2", 10, 1, "yes"]]), /label が不正/);
  assert.throws(
    () => aggregate({ selection, selectionSha256: "x", annotations: { user: { ...annot("user", []), selectionSha256: "y" } } }),
    /selectionSha256/,
  );
});

test("判断規則 §7：十分な数なら rank 1 から連続して通る最大の k（合成）", () => {
  // 60 query、各 query に IR rank 1〜3 と Raw rank 6〜8。IR1 は全 strict、IR2 は 0.7、IR3 は 0.4、Raw は 0.3 と置く。
  const queries = [];
  const user = [];
  const ai = [];
  for (let i = 0; i < 60; i += 1) {
    const q = 100 + i;
    const cs = [
      cand("w", q, 1, "ir", 1), cand("w", q, 2, "ir", 2), cand("w", q, 3, "ir", 3),
      cand("w", q, 4, "raw", 6), cand("w", q, 5, "raw", 7), cand("w", q, 6, "raw", 8),
    ];
    queries.push({ work: "w", queryPosition: q, priorScenes: q - 1, rawCount: 8, stratum: "full-gt30", probeStatus: "available", candidates: cs });
    const strict = [true, i % 10 < 7, i % 10 < 4, i % 10 < 3, i % 10 < 3, i % 10 < 3];
    cs.forEach((c, j) => {
      const label = strict[j] ? "strict" : "none";
      user.push(["w", q, c.position, label]);
      ai.push(["w", q, c.position, label]);
    });
  }
  const out = aggregate({
    selection: { seed: "fx", queries },
    selectionSha256: "x",
    annotations: { user: annot("user", user), ai: annot("ai", ai) },
  });
  assert.equal(out.judgement.indeterminate, false);
  const ranks = out.judgement.byVariant.user.ranks;
  assert.deepEqual(ranks.map((r) => r.pass), [true, true, false]);
  assert.equal(out.judgement.byVariant.user.k, 2);
  assert.equal(ranks[0].floor.wilson95[0] > 0.9, true);
  assert.equal(ranks[2].relative.pass, true); // 0.4 ≥ 0.3 だが下限（Wilson 下端 0.5）を満たさない
  assert.equal(ranks[2].floor.pass, false);
  assert.equal(out.kappa.userVsAi.strict.kappa, 1);
});
