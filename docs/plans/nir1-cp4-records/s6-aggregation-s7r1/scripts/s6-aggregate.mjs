// S6 の集計（integrator、リポジトリの外の script。contracts の s6-aggregation-s7r1/ に写す）。7 回目の S4（S4b f2f99b13）・候補 3f333a83（K6/6）。
// 入力：.artifacts/cp4 の S4b f2f99b13 の下の受領書、contracts の attempts-final-s7r1/ の台帳、../trace-k64-recompute.json（keep test つきの証拠で trace を K6/4 の読みに再計算したもの）。
// 許可リスト：台帳の (s4Commit, candidate.commit) が (S4b f2f99b13…, 候補 3f333a83…) の組の run だけを集計する。台帳 9 件のうち集計の対象は completed の 8 件。
// gold-s7r1-1（stopped。[precheck] V-10 で停止した 1 回目）は集計に数えず、開示欄（gold1Disclosure）に別に載せる。集計の Gold は gold-s7r1-2（取り直し。13 variant）。
// 前回（s6-aggregation-s6r1）の script からの変更：許可リストの組、run 名の接尾辞（s7r1）、Gold の run（gold-s7r1-2）と台帳 9 件の扱い、
// K6/6 の束縛（head.k66）と head.k62・head.k64・SOURCE_PINS の照合、K6/6 の受領書の数値（firstRenderCandidates ほか）の載せ方、
// 3a（classifyFollowUp の再適用。K6/6 の harness は next を渡すので同じ数を再現できない）を受領書の firstRenderNotCountedReasons の並べ替えに置換、
// trace の C7（excludedChronicleStop）の開示。閾値・期待値・Gold・Q と U の定義・pool の選び方・失効の読みは変えていない。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const R = "/home/grimodex/worktrees/Grimodex/cp4-formal-k66";
const A = `${R}/.artifacts/cp4`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REC = path.resolve(HERE, "../.."); // contracts の docs/plans/nir1-cp4-records
const S4 = "f2f99b13e18bcf4dd84ff6778de56189a3e1ef9b";
const CAND = "3f333a83554d4dba6c54417d500d3af6f0e985c5";
const K62 = { freezeCommit: "af643a93eeae7f937c9cd5a9dd87a6308c96fab6", sha256: "4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8" };
const K64 = { freezeCommit: "5dea38af158283c2a925d68ef0d8b0771c0ea209", sha256: "d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3" };
const K65 = { freezeCommit: "07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f", sha256: "1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7" };
const K66 = { freezeCommit: "56fb4fad2eb1eb2e021dfd121ea073f9d263cb4d", sha256: "58c634fa9b3d76803e486516c0e67444b74d4f5987cd851cd0857a25cc8945e7" };
const GOLD = "gold-s7r1-2"; // 集計の Gold（取り直し。13 variant）
const GOLD_PRIOR = "gold-s7r1-1"; // 1 回目（stopped）。集計に数えず開示だけ
const PARITY = "parity-s7r1-1";
const NEG_RUNS = ["neg-n2-s7r1-1", "neg-n3-s7r1-1", "neg-n4-s7r1-1"];
const EXPECTED_LEDGER = ["gold-s7r1-1", "gold-s7r1-2", "neg-n2-s7r1-1", "neg-n3-s7r1-1", "neg-n4-s7r1-1", "parity-s7r1-1", "sp-p4-s7r1-1", "trace-browsing-s7r1-1", "trace-editing-s7r1-1"];
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const git = (...args) => execFileSync("git", ["-C", R, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const { selectReceiptsForAggregation } = await import(`${R}/scripts/quality/nir1-graph-eval/receipt.mjs`);
const constants = await import(`${R}/scripts/quality/nir1-graph-eval/constants.mjs`);
const out = { allowList: { s4Commit: S4, candidate: CAND, goldRun: GOLD, goldPriorRunNotCounted: GOLD_PRIOR }, runs: [], selectReceiptsForAggregation: {}, bindings: {}, ssc: {}, spP4: {}, parity: {}, negatives: {}, g01Diagnostic: {}, traces: {}, gold1Disclosure: {} };

// 0. 束縛の定数を、候補の constants.mjs（K62_FREEZE ほか）と突き合わせる。
{
  const same = (a, b) => a.freezeCommit === (b.freezeCommit ?? b.commit) && a.sha256 === b.sha256;
  const pairs = { k62: [K62, constants.K62_FREEZE], k64: [K64, constants.K64_FREEZE], k65: [K65, constants.K65_FREEZE], k66: [K66, constants.K66_FREEZE] };
  const bad = Object.entries(pairs).filter(([, [mine, theirs]]) => !same(mine, theirs)).map(([k]) => k);
  if (bad.length) throw new Error(`[precheck] binding: this script's freeze constants differ from the candidate's constants.mjs: ${bad.join(", ")}`);
  out.bindings.constantsMatchCandidateConstantsMjs = true;
}

// 1. 許可リスト（台帳 9 件。(s4Commit, 候補) の組は 9 件すべてに要求する。集計の対象は completed の 8 件で、gold-s7r1-1 は stopped として開示欄へ）。
const ledgerFiles = fs.readdirSync(`${REC}/attempts-final-s7r1`).filter((f) => f.endsWith(".json")).sort();
if (JSON.stringify(ledgerFiles) !== JSON.stringify(EXPECTED_LEDGER.map((r) => `${r}.json`))) throw new Error(`[precheck] allow list: attempts-final-s7r1 holds ${JSON.stringify(ledgerFiles)}, expected ${JSON.stringify(EXPECTED_LEDGER)}`);
for (const f of ledgerFiles) {
  const bytes = fs.readFileSync(`${REC}/attempts-final-s7r1/${f}`);
  const a = JSON.parse(bytes.toString("utf8"));
  const artifact = fs.readFileSync(`${A}/attempts/${f}`);
  out.runs.push({ run: a.runName, runKind: a.runKind, status: a.status, attempt: a.attempt ?? null, s4Commit: a.s4Commit, candidate: a.candidate?.commit, startedAtUtc: a.startedAtUtc, finishedAtUtc: a.finishedAtUtc, pairMatches: a.s4Commit === S4 && a.candidate?.commit === CAND, ledgerFileSha256: sha(bytes), sameBytesAsArtifacts: Buffer.compare(bytes, artifact) === 0, counted: a.status === "completed" && a.runName !== GOLD_PRIOR });
}
if (out.runs.some((r) => !r.pairMatches)) throw new Error("[precheck] allow list: a ledger entry is not under (S4b f2f99b13, candidate 3f333a83)");
if (out.runs.some((r) => !r.sameBytesAsArtifacts)) throw new Error("[precheck] allow list: a contracts ledger file differs from .artifacts/cp4/attempts");
const prior = out.runs.find((r) => r.run === GOLD_PRIOR), goldRun = out.runs.find((r) => r.run === GOLD);
if (prior.status !== "stopped") throw new Error(`[precheck] allow list: ${GOLD_PRIOR} is ${prior.status}, expected stopped`);
if (!(prior.finishedAtUtc < goldRun.startedAtUtc)) throw new Error(`[precheck] allow list: ${GOLD_PRIOR} did not finish before ${GOLD} started`);
const counted = out.runs.filter((r) => r.counted);
if (counted.length !== 8 || counted.some((r) => r.status !== "completed")) throw new Error(`[precheck] allow list: expected 8 completed counted entries, found ${counted.length}`);
out.ledger = { entries: out.runs.length, counted: counted.length, countedRuns: counted.map((r) => r.run), notCounted: out.runs.filter((r) => !r.counted).map((r) => ({ run: r.run, status: r.status })) };

// 2. 受領書。
const dirs = (r) => fs.readdirSync(`${A}/${r}`).filter((d) => fs.existsSync(`${A}/${r}/${d}/receipt.json`)).sort().map((d) => `${A}/${r}/${d}/receipt.json`);
const validations = (r) => fs.readdirSync(`${A}/${r}`).filter((d) => fs.existsSync(`${A}/${r}/${d}/validation.json`)).sort().map((d) => ({ variant: d, ...load(`${A}/${r}/${d}/validation.json`) }));
const gold = dirs(GOLD).map(load);
const goldPrior = dirs(GOLD_PRIOR).map(load);
const parity = dirs(PARITY).map(load);
const neg = NEG_RUNS.flatMap((r) => dirs(r)).map(load);
const traces = ["editing", "browsing"].map((k) => load(`${A}/trace-${k}-s7r1-1/receipt.json`));
const spReceipt = load(`${A}/sp-p4-s7r1-1/sp-p4-receipt.json`);
if (gold.length !== 13 || parity.length !== 12 || neg.length !== 3 || goldPrior.length !== 3) throw new Error(`[precheck] receipts: gold ${gold.length} (13), parity ${parity.length} (12), negative ${neg.length} (3), gold-1 ${goldPrior.length} (3)`);
const sel = selectReceiptsForAggregation([...gold, ...parity, ...neg, ...traces]);
out.selectReceiptsForAggregation = {
  included: sel.included.length,
  includedKinds: Object.fromEntries([...new Set(sel.included.map((r) => r.runKind))].map((k) => [k, sel.included.filter((r) => r.runKind === k).length])),
  excluded: sel.excluded,
  note: "trace の受領書は receipt 全体の runnerKind を持たず runner-is-not-the-k64-hook-consumer で除かれる（関数の既知の限界。trace の query は全件 followUp.issuedVia=product-hook で、R5 は要約の検査で見ている）。receipt.mjs は S2 に pin 済みなので変えない。",
};
if (!(sel.included.length === 28 && sel.excluded.length === 2 && sel.excluded.every((e) => e.reason === "runner-is-not-the-k64-hook-consumer" && /^trace-(editing|browsing)-s7r1-1$/u.test(e.runId)))) throw new Error(`[precheck] selectReceiptsForAggregation: expected 28 included (gold 13, parity 12, negative 3) and only the 2 trace receipts excluded, got ${JSON.stringify(out.selectReceiptsForAggregation)}`);

// 2b. 束縛：全受領書の head.k62・k64・k65・k66・observationPrep・candidate・preview が許可リストの組と一致するか。
const bindErrors = (r) => {
  const e = [];
  for (const [k, v] of [["k62", K62], ["k64", K64], ["k65", K65], ["k66", K66]]) if (r.head?.[k]?.freezeCommit !== v.freezeCommit || r.head?.[k]?.sha256 !== v.sha256) e.push(`head.${k}`);
  if (r.head?.observationPrep?.commit !== S4) e.push("head.observationPrep.commit");
  if (r.candidate?.commit !== CAND) e.push("candidate.commit");
  if (r.preview !== false) e.push("preview");
  return e;
};
const all = [["sp-p4", spReceipt], ...gold.map((r) => ["gold", r]), ...parity.map((r) => ["parity", r]), ...neg.map((r) => ["negative", r]), ...traces.map((r) => ["trace", r])];
const bad = all.map(([k, r]) => [k, r, bindErrors(r)]).filter(([, , e]) => e.length);
if (bad.length) throw new Error(`[precheck] binding: ${bad.length} receipt(s) differ from (K6/6, K6/5, K6/4, K6/2 freeze, S4b, candidate, preview=false): ${bad.map(([k, r, e]) => `${k}:${r.runId}[${e.join(",")}]`).join(", ")}`);
// run 名の束縛：priorAttempts.thisAttempt.runName が receipt の属する run と一致（Gold・parity・negative）。
const runNameBad = [...gold.map((r) => [GOLD, r]), ...parity.map((r) => [PARITY, r]), ...neg.map((r) => [r.runId.split("/")[0], r])].filter(([run, r]) => r.priorAttempts?.thisAttempt?.runName !== run || !String(r.runId).startsWith(`${run}/`));
if (runNameBad.length) throw new Error(`[precheck] binding: receipt run name differs from its run: ${runNameBad.map(([run, r]) => `${run}:${r.runId}`).join(", ")}`);

// 2c. SOURCE_PINS：run-report の checks.sourcePins（45 件）を、S4b の S2（observation-prep.v1.json）の pins と、観測前コードの SOURCE_PINS、候補の bytes・祖先に突き合わせる。
const prepMod = await import(`${R}/scripts/quality/nir1-graph/observation-prep.mjs`);
const s2 = JSON.parse(git("show", `${S4}:evals/nir1-graph/observation-prep.v1.json`).toString("utf8"));
const s2Pins = s2.setupReadings?.source?.pins;
const isAncestor = (a, b) => { try { git("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } };
const expectedReportPins = s2Pins.map((x) => (x.check === "ancestor" ? { role: x.role, check: "ancestor", commit: x.commit } : { role: x.role, check: "bytes", commit: x.commit, files: x.files.map((f) => ({ path: f.path, sha256: f.sha256 })) }));
const pinProblems = (reportPins) => {
  const p = [];
  if (!Array.isArray(reportPins) || reportPins.length !== 45) return [`length ${reportPins?.length}`];
  if (JSON.stringify(reportPins) !== JSON.stringify(expectedReportPins)) p.push("run-report sourcePins differ from S4b's S2 setupReadings.source.pins");
  for (const pin of reportPins) {
    if (!isAncestor(pin.commit, CAND)) p.push(`${pin.role}: ${pin.commit} is not an ancestor of the candidate`);
    for (const f of pin.files ?? []) {
      let atCand = null, atPin = null, inTree = null;
      try { atCand = sha(git("show", `${CAND}:${f.path}`)); } catch { /* missing */ }
      try { atPin = sha(git("show", `${pin.commit}:${f.path}`)); } catch { /* missing */ }
      try { inTree = sha(fs.readFileSync(path.join(R, f.path))); } catch { /* missing */ }
      if (atCand !== f.sha256 || atPin !== f.sha256 || inTree !== f.sha256) p.push(`${pin.role}: ${f.path} bytes (candidate ${atCand?.slice(0, 8)}, pin commit ${atPin?.slice(0, 8)}, tree ${inTree?.slice(0, 8)}, pinned ${f.sha256.slice(0, 8)})`);
    }
  }
  return p;
};
const codePins = prepMod.SOURCE_PINS.map((x) => [x.role, x.check, x.commit, x.check === "bytes" ? x.paths : []]);
const s2VsCode = JSON.stringify(s2Pins.map((x) => [x.role, x.check, x.commit, (x.files ?? []).map((f) => f.path)])) === JSON.stringify(codePins);
const reportFiles = { [GOLD]: `${REC}/${GOLD}/run-report.json`, [GOLD_PRIOR]: `${REC}/${GOLD_PRIOR}/run-report.json`, [PARITY]: `${REC}/parity-s7r1-1/run-report.json`, ...Object.fromEntries(NEG_RUNS.map((r) => [r, `${REC}/negatives-s7r1-1/${r}.run-report.json`])) };
const sourcePins = { s2PinsEqualObservationPrepCodeSOURCE_PINS: s2VsCode, s2PinCount: s2Pins.length, codePinCount: codePins.length, runs: {} };
for (const [run, file] of Object.entries(reportFiles)) {
  const rep = load(file);
  sourcePins.runs[run] = { pins: rep.checks?.sourcePins?.length ?? null, problems: pinProblems(rep.checks?.sourcePins), seedPinGate: rep.checks?.seedPinGate?.status ?? null, productBuildChecked: rep.checks?.productBuild?.checked ?? null, productReceiptHead: rep.checks?.productBuild?.productReceiptHead ?? null, evalReceiptHead: rep.checks?.productBuild?.evalReceiptHead ?? null };
}
const pinBad = Object.entries(sourcePins.runs).filter(([run, v]) => run !== GOLD_PRIOR && (v.problems.length || v.seedPinGate !== "match" || v.productBuildChecked !== true || v.productReceiptHead !== CAND || v.evalReceiptHead !== CAND));
if (!s2VsCode || pinBad.length) throw new Error(`[precheck] binding: SOURCE_PINS / seed pin gate / product build: ${JSON.stringify({ s2VsCode, pinBad })}`);
out.bindings = { ...out.bindings, receipts: all.length, k62: K62, k64: K64, k65: K65, k66: K66, observationPrepCommit: S4, candidate: CAND, previewFalse: true, runNameMatches: true, allMatch: true, sourcePins };

// 3. 定常状態（Gold。gold-s7r1-2 の 13 variant）の K6/4 の pool。
const rows = gold.map((j) => {
  const a = j.aggregates.steadyStateCase;
  const k = a.k64;
  return {
    variantKey: a.variantKey, inPool: a.inPool, regime: j.aggregates.candidateRegime.regime, n: a.n,
    k62Literal: { inWindow: a.inWindow, outOfWindow: a.outOfWindow, outOfWindowRate: a.outOfWindowRate, notReadyAtStart: a.notReadyAtStart, stampMismatch: a.stampMismatch, stampWithoutComparison: a.stampWithoutComparison, stampResults: a.stampResults, boundaryDisagreement: a.boundaryDisagreement, cacheOrigin: a.cacheOrigin },
    receiptQualityHoldFlag: a.qualityHold,
    k64: k ? {
      n: k.n, firstRender: k.firstRender, followUp: k.followUp, displayed: k.displayed, missed: k.missed,
      firstRenderCandidates: k.firstRenderCandidates, firstRenderNotCounted: k.firstRenderNotCounted, firstRenderNotCountedBy: k.firstRenderNotCountedBy, firstRenderNotCountedReasons: k.firstRenderNotCountedReasons,
      contributedNotCounted: k.contributedNotCounted, firstRenderOutOfWindow: k.firstRenderOutOfWindow, firstRenderOutOfWindowRate: k.firstRenderOutOfWindowRate,
      x: Object.fromEntries(Object.entries(k.x).filter(([, v]) => v)), violations: k.violations.length, notApplied: k.notApplied, q1Max: k.q1?.max ?? null, q1N: k.q1?.n ?? null,
    } : null,
    windowClean: j.environment?.windowAssessment?.clean ?? null,
  };
});
const pool = rows.filter((r) => r.inPool && r.k64);
const sum = (f) => pool.reduce((t, r) => t + f(r), 0);
const n = sum((r) => r.k64.n), displayed = sum((r) => r.k64.displayed), missed = sum((r) => r.k64.missed), firstRender = sum((r) => r.k64.firstRender);
const holdCases = pool.filter((r) => r.k64.displayed === 0).map((r) => r.variantKey);
const sumReasons = (key) => pool.reduce((acc, r) => { for (const [k, v] of Object.entries(r.k64[key] ?? {})) acc[k] = (acc[k] ?? 0) + v; return acc; }, {});
out.ssc = {
  goldRun: GOLD,
  rows,
  goldValidations: { count: validations(GOLD).length, allValid: validations(GOLD).every((v) => v.valid === true) },
  pool: {
    variants: pool.length, poolVariants: pool.map((r) => r.variantKey), n, displayed, missed, missRate: missed / n, allowedMisses: Math.floor(0.01 * n), exceeds: missed > Math.floor(0.01 * n),
    firstRenderInWindow: firstRender, followUp: sum((r) => r.k64.followUp),
    holdCases, anyVariantWithZeroDisplayed: holdCases.length > 0,
    contributedNotCounted: sum((r) => r.k64.contributedNotCounted), firstRenderCandidates: sum((r) => r.k64.firstRenderCandidates), firstRenderNotCounted: sum((r) => r.k64.firstRenderNotCounted),
    firstRenderOutOfWindow: n - firstRender, firstRenderOutOfWindowRate: (n - firstRender) / n,
    firstRenderOutOfWindowNote: "K6/6 の条件（FR-1〜FR-8）で数えた first-render の窓外率（= 窓外の sample は follow-up で表示された）。K6/4 の変える点 1・2、K6/6 の変える点 5：記録と開示だけで、物差しには使わない。",
    k62OutOfWindowRate: { poolN: sum((r) => r.k62Literal.inWindow + r.k62Literal.outOfWindow), outOfWindow: sum((r) => r.k62Literal.outOfWindow), note: "K6/2 の字義（readyFresh・stamp の条件つき）の窓外率。受領書の steadyStateCase.outOfWindow。K6/6 では記録と開示だけ" },
    reasonsNotCounted: { by: sumReasons("firstRenderNotCountedBy"), reasons: sumReasons("firstRenderNotCountedReasons") },
  },
  poolWithoutG04: (() => { const p = pool.filter((r) => r.variantKey !== "G-04/base"); return { note: "開示用（判定には使わない。pool の選び直しは禁止）", n: p.reduce((t, r) => t + r.k64.n, 0), missed: p.reduce((t, r) => t + r.k64.missed, 0) }; })(),
  nonPoolVariants: rows.filter((r) => !r.inPool).map((r) => ({ variantKey: r.variantKey, n: r.n, hasK64: r.k64 !== null, receiptQualityHoldFlag: r.receiptQualityHoldFlag, windowClean: r.windowClean })),
};

// 3a'. 開示用：欠落の内訳は受領書の firstRenderNotCountedReasons に載る（K6/6 の変える点 7）。FR7:*・FR3:stamp-*・R1・a|b|c の件数を variant ごと・合計で並べる。
//      （前回の 3a は classifyFollowUp の再適用。K6/6 の harness は next を渡すので同じ数を再現できないため置き換えた。）
out.ssc.notCountedReasonsDisclosure = {
  note: "開示用（判定には使わない）。受領書の firstRenderNotCountedBy／Reasons。first-render の候補が first-render に数えられなかった理由の件数",
  byVariant: pool.map((r) => ({ variantKey: r.variantKey, firstRenderCandidates: r.k64.firstRenderCandidates, firstRenderNotCounted: r.k64.firstRenderNotCounted, by: r.k64.firstRenderNotCountedBy, reasons: r.k64.firstRenderNotCountedReasons })),
  total: out.ssc.pool.reasonsNotCounted,
  fr7: Object.entries(out.ssc.pool.reasonsNotCounted.reasons).filter(([k]) => /^FR7:/u.test(k)),
  stampOrR1: Object.entries(out.ssc.pool.reasonsNotCounted.reasons).filter(([k]) => /^(FR3:stamp-|R1)/u.test(k)),
};

// 3b. SP-P4・parity・negative・G-01 診断。
const spSides = spReceipt.variants.flatMap((v) => Object.values(v.sides));
out.spP4 = { status: spReceipt.summary.status, problems: spReceipt.summary.problems.length, variants: spReceipt.summary.variants.length, allSame: spReceipt.summary.variants.every((v) => v.same), differences: spReceipt.summary.variants.reduce((t, v) => t + v.differences, 0), irTimeoutExcluded: spSides.reduce((t, s) => t + (s.irTimeoutExcluded ?? 0), 0), irTimeoutLimit: spReceipt.design.irTimeoutLimit };
const pv = validations(PARITY);
out.parity = { variants: parity.length, validations: pv.length, allValid: pv.every((v) => v.valid === true), windowClean: parity.map((j) => j.environment?.windowAssessment?.clean), allWindowClean: parity.every((j) => j.environment?.windowAssessment?.clean === true), regimes: [...new Set(parity.map((j) => j.aggregates?.candidateRegime?.regime))], note: "parity は Graph arm を測らない。parity が READY だったことは Gold の worker が READY になる証拠ではない（gold-s7r1-1 の V-10）。" };
for (const r of NEG_RUNS) {
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
const g01 = load(`${REC}/g01-e2e-s7r1-1-report/pubg16-report.json`);
const g01Result = load(`${REC}/g01-e2e-s7r1-1/g01-e2e-s7r1-1.result.json`);
const g01Head = load(`${REC}/g01-e2e-s7r1-1/head.json`);
const g01BindErrors = bindErrors({ head: g01Result.head, candidate: g01Result.candidate, preview: false });
if (g01BindErrors.length) throw new Error(`[precheck] binding: the G-01 diagnostic result differs from (K6/6 …, S4b, candidate): ${g01BindErrors.join(",")}`);
out.g01Diagnostic = { run: g01Result.run, mode: g01Result.mode, purpose: g01Result.diagnostic.purpose, countsInCaseJudgement: g01Result.diagnostic.countsInCaseJudgement, session: g01Result.diagnostic.session, reachedEndToEnd: g01Result.diagnostic.reachedEndToEnd, firstMissing: g01Result.diagnostic.firstMissing, leaseEvidence: g01Result.diagnostic.leaseEvidence, candidateClean: g01Result.candidate.clean, headMatchesHeadJson: JSON.stringify(g01Result.head) === JSON.stringify(g01Head), bindingMatches: true, runStartedAtUtc: g01Result.head.runStartedAtUtc, reportProblems: g01.problems.length, reportMatchesResult: g01.run === g01Result.run, sessionProblems: g01Result.sessionProblems ?? null };

// 3c. 開示：gold-s7r1-1（1 回目。stopped。集計に数えない）。
{
  const ledger1 = load(`${REC}/attempts-final-s7r1/${GOLD_PRIOR}.json`);
  const rep1 = load(`${REC}/${GOLD_PRIOR}/run-report.json`);
  const g2 = Object.fromEntries(rows.map((r) => [r.variantKey, r]));
  const g2Receipt = gold.find((r) => r.aggregates.steadyStateCase.variantKey === "G-02/base");
  const entry = g2Receipt.priorAttempts.gold.find((e) => e.runName === GOLD_PRIOR);
  const bind1 = goldPrior.map((r) => ({ run: r.runId, errors: bindErrors(r) }));
  out.gold1Disclosure = {
    note: "開示用。gold-s7r1-1 は集計の対象に数えない（status stopped の試行）。判定にも使わない。",
    ledger: { status: ledger1.status, startedAtUtc: ledger1.startedAtUtc, finishedAtUtc: ledger1.finishedAtUtc, variants: ledger1.variants },
    stoppedVariant: Object.entries(rep1.variants).filter(([, v]) => v.status === "stopped").map(([k, v]) => ({ variant: k, error: v.error })),
    runReportProblems: rep1.problems.map((p) => String(p).split("\n")[0]),
    measuredVariantsWithReceipt: goldPrior.map((r) => r.aggregates.steadyStateCase.variantKey),
    secondRunDisclosesFirst: { goldReceiptPriorAttemptsGold: entry, sameAsFinalLedgerSha256: entry?.fileSha256 === out.runs.find((r) => r.run === GOLD_PRIOR).ledgerFileSha256, appliesTo: "gold-s7r1-2 の 13 receipt すべての priorAttempts.gold（frozen-k64-run.mjs:1681-1703 が前の Gold 試行を開示する）", allThirteenDisclose: gold.every((r) => JSON.stringify(r.priorAttempts.gold) === JSON.stringify([entry])) },
    sameCandidateAndSetup: { candidate: CAND, setupsOfBothRunsEqual: JSON.stringify(ledger1.setups) === JSON.stringify(load(`${REC}/attempts-final-s7r1/${GOLD}.json`).setups) },
    bindingOfItsReceipts: { checked: bind1.length, allMatch: bind1.every((b) => b.errors.length === 0), detail: bind1 },
    // 3 variant の数値を gold-s7r1-2 の同じ variant と並べる（選択の疑いへの備え。どちらも判定に使わない側と使う側を分けて書く）。
    sideBySide: goldPrior.map((r) => {
      const a = r.aggregates.steadyStateCase, k = a.k64, k2 = g2[a.variantKey].k64;
      const f = (x) => (x ? { n: x.n, firstRender: x.firstRender, followUp: x.followUp, displayed: x.displayed, missed: x.missed, contributedNotCounted: x.contributedNotCounted, firstRenderOutOfWindow: x.firstRenderOutOfWindow } : null);
      return { variantKey: a.variantKey, valid: validations(GOLD_PRIOR).find((v) => v.variant === a.variantKey.replace("/", "_"))?.valid ?? null, windowClean: r.environment?.windowAssessment?.clean ?? null, goldS7r1_1_notCounted: f(k), goldS7r1_2_counted: f(k2) };
    }),
  };
}

// 4. trace。記録済み（K6/2 の読み）と再計算（K6/4 の読み）。
const rec = load(`${HERE}/../trace-k64-recompute.json`);
if (rec.evidence?.rsJoinHook?.evidence !== "candidate-test" || rec.evidence.rsJoinHook.head !== CAND || rec.evidence.rsJoinHook.passed !== true) throw new Error("[precheck] the recompute evidence is not the candidate's keep test at the allow-listed candidate");
for (const t of traces) {
  const k = t.settings.traceKind ?? t.trace.kind;
  const r = t.summary.k64, c = rec.summaries[k];
  const f = (s) => ({ regime: s.regime, status: s.status, Q: s.Q, U: s.U, displayed: s.displayed ?? null, firstRenderInWindow: s.firstRenderInWindow ?? s.inWindow ?? null, followUpDisplayed: s.followUpDisplayed ?? null, lapse: s.lapse.total, lapseBreakdown: s.lapse, lapseRate: s.lapseRate, lapseExceeds: s.lapseExceeds, outOfWindow: s.outOfWindow, outOfWindowU: s.outOfWindowU, outOfWindowRate: s.outOfWindowRate, outOfWindowExceeds: s.outOfWindowExceeds, mainReason: s.mainReason, categories: s.categories, reasons: s.reasons, outcomes: s.outcomes, boundaryDisagreement: s.boundaryDisagreement, violations: s.violations.length, notApplied: s.k64NotApplied ?? null, x: Object.fromEntries(Object.entries(s.x ?? {}).filter(([, v]) => v)), followUpLapse: s.followUpLapse ?? null, q1: s.q?.q1 ?? null, requeryCount: s.requeryCount });
  const counted = t.queries.filter((q) => !q.requery);
  const notShown = counted.filter((q) => q.graph?.outcome === "graph-unavailable").map((q) => ({ queryId: q.queryId, traceIndex: q.traceIndex, graphOutcome: q.graph.outcome, graphReason: q.graph.reason, irOutcome: q.irOutcome, snapshotUsable: q.snapshot.usable, startSealState: q.startSeal?.state }));
  const ex = t.native.alignment.excludedChronicleStop;
  out.traces[k] = {
    receiptStatus: t.status, defects: t.defects?.length ?? null, headBound: true, attempt: t.attempt, stalled: t.stalled ?? null,
    recordedInReceipt: f(r), recomputedWithKeepTestEvidence: f(c),
    startSeal: { current: t.startSeal.current, dirty: t.startSeal.dirty, missing: t.startSeal.missing, unknown: t.startSeal.unknown },
    nativeAlignment: { aligned: t.native.alignment.aligned, seededBegins: t.native.alignment.seededBegins, records: t.native.alignment.records, excludedAfterWindow: t.native.alignment.excludedAfterWindow },
    c7ExcludedChronicleStop: ex === null ? null : { rule: ex.rule, count: ex.count, conditionFetches: ex.conditionFetches, countedAs: ex.countedAs, byRole: Object.fromEntries(Object.entries(ex.byRole).map(([role, v]) => [role, { count: v.count, queryIndexes: v.queryIndexes }])), begins: ex.begins.map((b) => ({ beginId: b.beginId, fetchSeq: b.fetchSeq, graphOutcome: b.graphOutcome, irReason: b.irReason, role: b.role, queryIndex: b.queryIndex })), countEqualsConditionFetches: ex.count === ex.conditionFetches, readClockRange: t.native.alignment.clock?.rangeMs ?? null, readClockReason: t.native.alignment.clock?.readClockReason ?? null },
    lapseI: t.lapseI, requeries: t.requeries, cancelledParents: t.cancelledParents, outsideQ: { outsideQ: t.outsideQ.outsideQ, completed: t.outsideQ.completed, nonCompleted: t.outsideQ.nonCompleted },
    graphUnavailableQueries: notShown,
  };
}
console.log(JSON.stringify(out, null, 1));
