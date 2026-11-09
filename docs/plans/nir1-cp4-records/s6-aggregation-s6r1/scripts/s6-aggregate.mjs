// S6 の集計（integrator、リポジトリの外の script。contracts の s6-aggregation-s6r1/ に写す）。6 回目の S4（S4b 63bc9b90）・候補 a2309b95（K6/5）。
// 入力：.artifacts/cp4 の S4b 63bc9b90 の下の受領書と台帳、../trace-k64-recompute.json（keep test つきの証拠で trace を K6/4 の読みに再計算したもの）。
// 許可リスト：台帳の (s4Commit, candidate.commit) が (S4b 63bc9b90…, 候補 a2309b95…) の組の run だけを集計する（旧 S4b'''' 3734e501・候補 cbf33077 以前の run は入れない。DR-CP4-S4-9）。
// 前回（s6-aggregation-s5r6）の script からの変更：許可リストの組、run 名の接尾辞（s6r1-1）、K6/5 の束縛（head.k65）の確認、
// 受領書の数値を script の出力に載せる範囲の拡張（SP-P4、parity、negative、G-01 診断、trace の失効の内訳、C7 の開示欄）。閾値・期待値・Gold・Q と U の定義・pool の選び方・失効の読みは変えていない。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const R = "/home/grimodex/worktrees/Grimodex/cp4-formal-k65";
const A = `${R}/.artifacts/cp4`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const S4 = "63bc9b903d5b7dbba3533ea32da9bdd7fe649861";
const CAND = "a2309b953873063b97b58942d42fa34d1bfbfc95";
const K65 = { freezeCommit: "07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f", sha256: "1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7" };
const { selectReceiptsForAggregation } = await import(`${R}/scripts/quality/nir1-graph-eval/receipt.mjs`);
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const out = { allowList: { s4Commit: S4, candidate: CAND }, runs: [], selectReceiptsForAggregation: {}, bindings: {}, ssc: {}, spP4: {}, parity: {}, negatives: {}, g01Diagnostic: {}, traces: {} };

// 1. 許可リスト（台帳の s4Commit と候補）。
const ledger = fs.readdirSync(`${A}/attempts`).filter((f) => /-s6r1-1\.json$/u.test(f)).sort();
for (const f of ledger) {
  const a = load(`${A}/attempts/${f}`);
  out.runs.push({ run: a.runName, runKind: a.runKind, status: a.status, s4Commit: a.s4Commit, candidate: a.candidate?.commit, startedAtUtc: a.startedAtUtc, finishedAtUtc: a.finishedAtUtc, allowed: a.s4Commit === S4 && a.candidate?.commit === CAND && a.status === "completed" });
}
if (out.runs.length !== 8) throw new Error(`[precheck] allow list: expected 8 ledger entries, found ${out.runs.length}`);
if (out.runs.some((r) => r.s4Commit !== S4 || r.candidate !== CAND)) throw new Error("[precheck] allow list: a ledger entry is not under (S4b 63bc9b90, candidate a2309b95)");
if (out.runs.some((r) => !r.allowed)) throw new Error("[precheck] allow list: a ledger entry is not completed");

// 2. 受領書。
const dirs = (r) => fs.readdirSync(`${A}/${r}`).filter((d) => fs.existsSync(`${A}/${r}/${d}/receipt.json`)).sort().map((d) => `${A}/${r}/${d}/receipt.json`);
const validations = (r) => fs.readdirSync(`${A}/${r}`).filter((d) => fs.existsSync(`${A}/${r}/${d}/validation.json`)).sort().map((d) => ({ variant: d, ...load(`${A}/${r}/${d}/validation.json`) }));
const gold = dirs("gold-s6r1-1").map(load);
const parity = dirs("parity-s6r1-1").map(load);
const negRuns = ["neg-n2-s6r1-1", "neg-n3-s6r1-1", "neg-n4-s6r1-1"];
const neg = negRuns.flatMap((r) => dirs(r)).map(load);
const traces = ["editing", "browsing"].map((k) => load(`${A}/trace-${k}-s6r1-1/receipt.json`));
const spReceipt = load(`${A}/sp-p4-s6r1-1/sp-p4-receipt.json`);
const sel = selectReceiptsForAggregation([...gold, ...parity, ...neg, ...traces]);
out.selectReceiptsForAggregation = {
  included: sel.included.length,
  includedKinds: Object.fromEntries([...new Set(sel.included.map((r) => r.runKind))].map((k) => [k, sel.included.filter((r) => r.runKind === k).length])),
  excluded: sel.excluded,
  note: "trace の受領書は receipt 全体の runnerKind を持たず runner-is-not-the-k64-hook-consumer で除かれる（関数の既知の限界。trace の query は全件 followUp.issuedVia=product-hook で、R5 は要約の検査で見ている）。receipt.mjs は S2 に pin 済みなので変えない。",
};

// 2b. 束縛：全受領書の head.k65・observationPrep・candidate が許可リストの組と一致するか。
const all = [["sp-p4", spReceipt], ...gold.map((r) => ["gold", r]), ...parity.map((r) => ["parity", r]), ...neg.map((r) => ["negative", r]), ...traces.map((r) => ["trace", r])];
const bad = all.filter(([, r]) => r.head?.k65?.freezeCommit !== K65.freezeCommit || r.head?.k65?.sha256 !== K65.sha256 || r.head?.observationPrep?.commit !== S4 || r.candidate?.commit !== CAND || r.preview !== false);
if (bad.length) throw new Error(`[precheck] binding: ${bad.length} receipt(s) differ from (K6/5 freeze, S4b, candidate, preview=false): ${bad.map(([k, r]) => `${k}:${r.runId}`).join(", ")}`);
out.bindings = { receipts: all.length, k65: K65, k64: all[0][1].head.k64, observationPrepCommit: S4, candidate: CAND, previewFalse: true, allMatch: true };

// 3. 定常状態（Gold）の K6/4 の pool。
const rows = gold.map((j) => {
  const a = j.aggregates.steadyStateCase;
  return { variantKey: a.variantKey, inPool: a.inPool, regime: j.aggregates.candidateRegime.regime, n: a.n, inWindow: a.inWindow, outOfWindow: a.outOfWindow, k64: a.k64 ? { n: a.k64.n, firstRender: a.k64.firstRender, followUp: a.k64.followUp, displayed: a.k64.displayed, missed: a.k64.missed, x: Object.fromEntries(Object.entries(a.k64.x).filter(([, v]) => v)), violations: a.k64.violations.length } : null, qualityHold: a.qualityHold, windowClean: j.environment?.windowAssessment?.clean ?? null };
});
const pool = rows.filter((r) => r.inPool && r.k64);
const sum = (f) => pool.reduce((t, r) => t + f(r), 0);
const n = sum((r) => r.k64.n), displayed = sum((r) => r.k64.displayed), missed = sum((r) => r.k64.missed);
out.ssc = {
  rows,
  goldValidations: { count: validations("gold-s6r1-1").length, allValid: validations("gold-s6r1-1").every((v) => v.valid === true) },
  pool: { variants: pool.length, n, displayed, missed, missRate: missed / n, allowedMisses: Math.floor(0.01 * n), exceeds: missed > Math.floor(0.01 * n), firstRenderInWindow: sum((r) => r.k64.firstRender), followUp: sum((r) => r.k64.followUp) },
  poolWithoutG04: (() => { const p = pool.filter((r) => r.variantKey !== "G-04/base"); const nn = p.reduce((t, r) => t + r.k64.n, 0), mm = p.reduce((t, r) => t + r.k64.missed, 0); return { note: "開示用（判定には使わない。pool の選び直しは禁止）", n: nn, missed: mm }; })(),
  firstRenderWindowMiss: { poolN: sum((r) => r.n), outOfWindow: sum((r) => r.outOfWindow), note: "K6/2 の最初の表示の窓外率（D=40 ms）。K6/4 では記録と開示だけ" },
};

// 3a. 開示用（判定には使わない。読みは変えない）：pool の欠落 sample が、harness の読みでなぜ「表示」に数えられなかったか。
// 同じ harness（候補 a2309b95 の followup.mjs・join.mjs）の classifyFollowUp と classifyJoin を受領書の sample に当て直し、受領書の集計（k64）と一致することを確かめる。
const { classifyFollowUp } = await import(`${R}/scripts/quality/nir1-graph-eval/followup.mjs`);
const { classifyJoin } = await import(`${R}/scripts/quality/nir1-graph-eval/join.mjs`);
const breakdown = {};
let recomputedMissed = 0, recomputedDisplayed = 0;
for (const j of gold) {
  const a = j.aggregates.steadyStateCase;
  if (!a.inPool) continue;
  const graphSamples = j.samples.filter((s) => s.arm === "graph" && s.phase === "measured" && s.trigger === "user-operation");
  let missedHere = 0;
  for (const s of graphSamples) {
    const c = classifyFollowUp(s, { context: "steady" });
    if (c.displayed) { recomputedDisplayed += 1; continue; }
    recomputedMissed += 1; missedHere += 1;
    const join = classifyJoin(s);
    const key = JSON.stringify({ outcome: s.graph.outcome, joined: s.graph.joined, joinedWithinD: join.inWindow, source: s.graph.source, readyFresh: s.startSlot?.readyFresh ?? null, stampResult: s.freshnessStamp?.result ?? null, stampMatched: s.freshnessStamp?.matched ?? null, failedStage: c.failedStage ?? null, firstCode: Object.keys(c.x ?? {})[0] ?? null });
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }
  if (missedHere !== a.k64.missed) throw new Error(`[precheck] ${a.variantKey}: re-applied classifyFollowUp missed ${missedHere}, the receipt says ${a.k64.missed}`);
}
if (recomputedMissed !== missed || recomputedDisplayed !== displayed) throw new Error("[precheck] re-applied classification differs from the receipt's pool aggregate");
out.ssc.missedBreakdownDisclosure = { note: "開示用（判定には使わない）。受領書の欠落の各 sample に harness の分類器を当て直した内訳（件数は受領書の k64 と一致を script が確認）", reapplied: { displayed: recomputedDisplayed, missed: recomputedMissed }, byCondition: Object.entries(breakdown).map(([k, v]) => ({ ...JSON.parse(k), n: v })) };

// 3b. SP-P4・parity・negative・G-01 診断。
const spSides = spReceipt.variants.flatMap((v) => Object.values(v.sides));
out.spP4 = { status: spReceipt.summary.status, problems: spReceipt.summary.problems.length, variants: spReceipt.summary.variants.length, allSame: spReceipt.summary.variants.every((v) => v.same), differences: spReceipt.summary.variants.reduce((t, v) => t + v.differences, 0), irTimeoutExcluded: spSides.reduce((t, s) => t + (s.irTimeoutExcluded ?? 0), 0), irTimeoutLimit: spReceipt.design.irTimeoutLimit };
const pv = validations("parity-s6r1-1");
out.parity = { variants: parity.length, validations: pv.length, allValid: pv.every((v) => v.valid === true), windowClean: parity.map((j) => j.environment?.windowAssessment?.clean), allWindowClean: parity.every((j) => j.environment?.windowAssessment?.clean === true), regimes: [...new Set(parity.map((j) => j.aggregates?.candidateRegime?.regime))] };
for (const r of negRuns) {
  const rep = load(`${A}/${r}/run-report.json`);
  const v = rep.variants["G-01/v1"], ng = v.negative, st = ng.step;
  const rec = neg.find((x) => x.runId.startsWith(`${r}/`));
  out.negatives[r] = {
    status: v.status, valid: v.valid, verdict: v.verdict.outcome, samples: v.samples, runProblems: rep.problems.length,
    assessment: ng.assessment, control: ng.control.status,
    returnedSceneIdsOverMeasured: [...new Set(ng.samples.flatMap((s) => s.returnedSceneIds))], graphMiraReturned: ng.samples.some((s) => s.returnedSceneIds.includes("g01-mira")), frameReachedAll: ng.samples.every((s) => s.frameReached),
    step: { mutation: st.mutation, feedAfterMutation: st.feedAfterMutation, sealAttempts: st.sealAttempts.map((s) => ({ outcome: s.outcome, waitedMs: s.waitedMs, sealBranch: s.sealBranch ?? null, bGeneration: s.metadata?.b?.generation, bDirty: s.metadata?.b?.dirty, settleCoversMutation: s.settleCoversMutation ?? null })) },
    beforeDeclarationSealAttempts: ng.beforeDeclarationSealAttempts ? ng.beforeDeclarationSealAttempts.map((s) => ({ outcome: s.outcome, waitedMs: s.waitedMs, sealBranch: s.sealBranch ?? null, bGeneration: s.metadata?.b?.generation, bDirty: s.metadata?.b?.dirty, settleCoversMutation: s.settleCoversMutation ?? null })) : null,
    validation: load(`${A}/${r}/G-01_v1/validation.json`), windowClean: rec?.environment?.windowAssessment?.clean ?? null,
  };
}
const g01 = load(`${A}/g01-e2e-s6r1-1/pubg16-report.json`);
const g01Result = load(`${HERE}/../../g01-e2e-s6r1-1/g01-e2e-s6r1-1.result.json`);
out.g01Diagnostic = { run: g01Result.run, mode: g01Result.mode, purpose: g01Result.diagnostic.purpose, countsInCaseJudgement: g01Result.diagnostic.countsInCaseJudgement, session: g01Result.diagnostic.session, reachedEndToEnd: g01Result.diagnostic.reachedEndToEnd, firstMissing: g01Result.diagnostic.firstMissing, leaseEvidence: g01Result.diagnostic.leaseEvidence, reportProblems: g01.problems.length, reportMatchesResult: g01.run === g01Result.run };

// 4. trace。記録済み（K6/2 の読み）と再計算（K6/4 の読み）。
const rec = load(`${HERE}/../trace-k64-recompute.json`);
if (rec.evidence?.rsJoinHook?.evidence !== "candidate-test" || rec.evidence.rsJoinHook.head !== CAND || rec.evidence.rsJoinHook.passed !== true) throw new Error("[precheck] the recompute evidence is not the candidate's keep test at the allow-listed candidate");
for (const t of traces) {
  const k = t.settings.traceKind ?? t.trace.kind;
  const r = t.summary.k64, c = rec.summaries[k];
  const f = (s) => ({ regime: s.regime, status: s.status, Q: s.Q, U: s.U, displayed: s.displayed ?? null, lapse: s.lapse.total, lapseBreakdown: s.lapse, lapseRate: s.lapseRate, lapseExceeds: s.lapseExceeds, outOfWindow: s.outOfWindow, outOfWindowU: s.outOfWindowU, outOfWindowRate: s.outOfWindowRate, outOfWindowExceeds: s.outOfWindowExceeds, mainReason: s.mainReason, categories: s.categories, reasons: s.reasons, outcomes: s.outcomes, violations: s.violations.length, notApplied: s.k64NotApplied ?? null, x: Object.fromEntries(Object.entries(s.x ?? {}).filter(([, v]) => v)), followUpLapse: s.followUpLapse ?? null, q1: s.q?.q1 ?? null, requeryCount: s.requeryCount });
  const counted = t.queries.filter((q) => !q.requery);
  const notShown = counted.filter((q) => q.graph?.outcome === "graph-unavailable").map((q) => ({ queryId: q.queryId, traceIndex: q.traceIndex, graphOutcome: q.graph.outcome, graphReason: q.graph.reason, irOutcome: q.irOutcome, snapshotUsable: q.snapshot.usable, startSealState: q.startSeal?.state }));
  out.traces[k] = {
    receiptStatus: t.status, defects: t.defects?.length ?? null, headBound: true,
    recordedInReceipt: f(r), recomputedWithKeepTestEvidence: f(c),
    startSeal: { current: t.startSeal.current, dirty: t.startSeal.dirty, missing: t.startSeal.missing, unknown: t.startSeal.unknown },
    nativeAlignment: { aligned: t.native.alignment.aligned, seededBegins: t.native.alignment.seededBegins, records: t.native.alignment.records, excludedAfterWindow: t.native.alignment.excludedAfterWindow, excludedChronicleStopC7: t.native.alignment.excludedChronicleStop },
    lapseI: t.lapseI, requeries: t.requeries, cancelledParents: t.cancelledParents, outsideQ: { outsideQ: t.outsideQ.outsideQ, completed: t.outsideQ.completed, nonCompleted: t.outsideQ.nonCompleted },
    graphUnavailableQueries: notShown,
  };
}
console.log(JSON.stringify(out, null, 1));
