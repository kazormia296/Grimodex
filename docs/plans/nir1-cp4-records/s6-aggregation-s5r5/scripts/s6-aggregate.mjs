// S6 の集計（integrator、リポジトリの外の script。contracts の s6-aggregation-s5r5/ に写す）。
// 入力：.artifacts/cp4 の S4b'' の下の受領書と台帳、trace-k64-recompute.json（keep test つきの証拠で trace を K6/4 の読みに再計算したもの）。
// 許可リスト：台帳の s4Commit が 60bf9dc4… の run だけを集計する（旧 S4b b7d74950・旧 S4b' 9f52e7da は入れない）。
import fs from "node:fs";
const R = "/home/grimodex/worktrees/Grimodex/claude-g04-cand";
const A = `${R}/.artifacts/cp4`;
const S4 = "60bf9dc44a5f751551a9ce0195abb87f5c97543d";
const { selectReceiptsForAggregation } = await import(`${R}/scripts/quality/nir1-graph-eval/receipt.mjs`);
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const out = { allowList: { s4Commit: S4 }, runs: [], selectReceiptsForAggregation: {}, ssc: {}, traces: {} };

// 1. 許可リスト（台帳の s4Commit）。
const ledger = fs.readdirSync(`${A}/attempts`).filter((f) => /-s5r5-1\.json$/u.test(f)).sort();
for (const f of ledger) {
  const a = load(`${A}/attempts/${f}`);
  out.runs.push({ run: a.runName, runKind: a.runKind, status: a.status, s4Commit: a.s4Commit, allowed: a.s4Commit === S4 && a.status === "completed" });
}

// 2. 受領書。
const dirs = (r) => fs.readdirSync(`${A}/${r}`).filter((d) => fs.existsSync(`${A}/${r}/${d}/receipt.json`)).sort().map((d) => `${A}/${r}/${d}/receipt.json`);
const gold = dirs("gold-s5r5-1").map(load);
const parity = dirs("parity-s5r5-1").map(load);
const neg = ["neg-n2-s5r5-1", "neg-n3-s5r5-1", "neg-n4-s5r5-1"].flatMap((r) => dirs(r)).map(load);
const traces = ["editing", "browsing"].map((k) => load(`${A}/trace-${k}-s5r5-1/receipt.json`));
const sel = selectReceiptsForAggregation([...gold, ...parity, ...neg, ...traces]);
out.selectReceiptsForAggregation = {
  included: sel.included.length,
  includedKinds: Object.fromEntries([...new Set(sel.included.map((r) => r.runKind))].map((k) => [k, sel.included.filter((r) => r.runKind === k).length])),
  excluded: sel.excluded,
  note: "trace の受領書は receipt 全体の runnerKind を持たず runner-is-not-the-k64-hook-consumer で除かれる（関数の既知の限界。trace の query は全件 followUp.issuedVia=product-hook で、R5 は要約の検査で見ている）。receipt.mjs は S2 に pin 済みなので変えない。",
};

// 3. 定常状態（Gold）の K6/4 の pool。
const rows = gold.map((j) => {
  const a = j.aggregates.steadyStateCase;
  return { variantKey: a.variantKey, inPool: a.inPool, regime: j.aggregates.candidateRegime.regime, n: a.n, inWindow: a.inWindow, outOfWindow: a.outOfWindow, k64: a.k64 ? { n: a.k64.n, firstRender: a.k64.firstRender, followUp: a.k64.followUp, displayed: a.k64.displayed, missed: a.k64.missed, x: Object.fromEntries(Object.entries(a.k64.x).filter(([, v]) => v)), violations: a.k64.violations.length } : null, qualityHold: a.qualityHold };
});
const pool = rows.filter((r) => r.inPool && r.k64);
const sum = (f) => pool.reduce((t, r) => t + f(r), 0);
const n = sum((r) => r.k64.n), displayed = sum((r) => r.k64.displayed), missed = sum((r) => r.k64.missed);
out.ssc = { rows, pool: { variants: pool.length, n, displayed, missed, missRate: missed / n, allowedMisses: Math.floor(0.01 * n), exceeds: missed > Math.floor(0.01 * n), firstRenderInWindow: sum((r) => r.k64.firstRender), followUp: sum((r) => r.k64.followUp) }, poolWithoutG04: (() => { const p = pool.filter((r) => r.variantKey !== "G-04/base"); const nn = p.reduce((t, r) => t + r.k64.n, 0), mm = p.reduce((t, r) => t + r.k64.missed, 0); return { note: "開示用（判定には使わない。pool の選び直しは禁止）", n: nn, missed: mm }; })(), firstRenderWindowMiss: { poolN: sum((r) => r.n), outOfWindow: sum((r) => r.outOfWindow), note: "K6/2 の最初の表示の窓外率。K6/4 では記録と開示だけ" } };

// 4. trace。記録済み（K6/2 の読み）と再計算（K6/4 の読み）。
const rec = load("/tmp/claude-1000/-home-grimodex-Grimodex/dd1afc24-5546-4b01-b89b-6ba9b38e5b63/scratchpad/s5r5/trace-k64-recompute.json");
for (const t of traces) {
  const k = t.settings.traceKind ?? t.trace.kind;
  const r = t.summary.k64, c = rec.summaries[k];
  const f = (s) => ({ regime: s.regime, status: s.status, Q: s.Q, U: s.U, displayed: s.displayed, lapse: s.lapse.total, lapseRate: s.lapseRate, lapseExceeds: s.lapseExceeds, outOfWindow: s.outOfWindow, outOfWindowU: s.outOfWindowU, outOfWindowExceeds: s.outOfWindowExceeds, mainReason: s.mainReason, categories: s.categories, outcomes: s.outcomes, violations: s.violations.length, notApplied: s.k64NotApplied ?? null, x: Object.fromEntries(Object.entries(s.x ?? {}).filter(([, v]) => v)), followUpLapse: s.followUpLapse ?? null });
  out.traces[k] = { recordedInReceipt: f(r), recomputedWithKeepTestEvidence: f(c) };
}
console.log(JSON.stringify(out, null, 1));
