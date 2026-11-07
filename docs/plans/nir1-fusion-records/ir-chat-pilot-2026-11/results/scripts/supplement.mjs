// build-results.mjs が呼ぶ補足の集計。summary.json の mean は 4 桁に丸められているため、
// README の 1 桁表示で二重丸め（79.35 → 0.7935 → 79.3）が起きる。ここで answers.jsonl と judge.v3.jsonl から
// 丸める前の差を作り直し、summary の値（4 桁）と一致することを確かめて supplement.json に 6 桁で残す。
// 他に、README の読み方に要る件数（照合の 2×2 の内訳、S2／S3 の arm 別の確定、N の uncertain、
// Haiku の judge の失敗の内訳、hit 別の点数、C の空の回答を除いた D−C）を出す。
// 質問・回答・judge の本文・説明は読まない。questions/*.json は id・type・evidence の Scene 番号だけ、
// context-build-real.json は irPositions（Scene 番号）だけを使う。
import path from "node:path";
import { readJson, readJsonl, round } from "./lib.mjs";
import { loadScores, questionArmScores, latestJudgeByAnswer } from "./scores.mjs";

const ARMS = ["0", "A", "B", "O", "C", "D"];
const COMPARISONS = { "B-A": ["B", "A"], "D-C": ["D", "C"], "C-A": ["C", "A"], "O-0": ["O", "0"], "O-A": ["O", "A"], "B-0": ["B", "0"] };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function computeSupplement(dataDir, { checks, summaries }) {
  const P = (...a) => path.join(dataDir, ...a);
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  // ---- 質問の属性（本文なし）----
  const build = readJson(P("context-build-real.json"));
  const confirmedIds = new Set(readJson(P("review-selection.json")).ids);
  const meta = new Map(); // qid -> {type, work, p, irInEvidence}
  for (const cell of Object.keys(build.cells).filter((c) => /-p(59|117)$/.test(c))) {
    const [, work, p] = cell.match(/^(.*)-p(\d+)$/);
    for (const q of readJson(P("questions", `${cell}.json`)).questions) {
      if (q.type === "N") continue;
      const per = build.cells[cell].perQuestion.find((x) => x.id === q.id);
      const ev = new Set((q.evidence ?? []).map((e) => e.scene));
      meta.set(q.id, { type: q.type, work, p: Number(p), irInEvidence: per.irPositions.some((pos) => ev.has(pos)) });
    }
  }
  check("補足: 答えのある質問 67・IR あり 47・なし 20", meta.size === 67 && [...meta.values()].filter((m) => m.irInEvidence).length === 47);

  // 推測可＝0 arm で Haiku か Sonnet のどちらかが項目を 1 つでも再現した質問（analysis-lib.guessableQuestions と同じ規則）
  const scoresByPass = {};
  const rowsByPass = {};
  const guessable = new Set();
  for (const pass of ["sonnet", "haiku"]) {
    rowsByPass[pass] = loadScores(dataDir, pass);
    scoresByPass[pass] = questionArmScores(rowsByPass[pass]);
    for (const r of rowsByPass[pass]) if (r.arm === "0" && !r.missing && r.items.some(Boolean)) guessable.add(r.qid);
  }
  const qidsAll = [...meta.keys()].sort();
  const subsets = {
    confirmed30: qidsAll.filter((q) => confirmedIds.has(q)),
    irInEvidence: qidsAll.filter((q) => meta.get(q).irInEvidence),
    irNotInEvidence: qidsAll.filter((q) => !meta.get(q).irInEvidence),
    excludingGuessable: qidsAll.filter((q) => !guessable.has(q)),
  };
  for (const t of [...new Set([...meta.values()].map((m) => m.type))].sort()) subsets[`type:${t}`] = qidsAll.filter((q) => meta.get(q).type === t);
  for (const w of [...new Set([...meta.values()].map((m) => m.work))].sort()) subsets[`work:${w}`] = qidsAll.filter((q) => meta.get(q).work === w);
  for (const p of [...new Set([...meta.values()].map((m) => m.p))].sort((a, b) => a - b)) subsets[`p:${p}`] = qidsAll.filter((q) => meta.get(q).p === p);

  const diffOf = (sc, x, y, qids) => {
    const d = [];
    for (const q of qids) { const a = sc.get(`${q}|${x}`), b = sc.get(`${q}|${y}`); if (a && b) d.push(a.score - b.score); }
    return { n: d.length, mean: mean(d) };
  };

  // ---- 丸める前の差 ----
  const exactDifferences = {};
  for (const pass of ["sonnet", "haiku"]) {
    const sc = scoresByPass[pass], S = summaries[pass];
    const out = { comparisons: {}, subsetsBA: {} };
    for (const [k, [x, y]] of Object.entries(COMPARISONS)) {
      const e = diffOf(sc, x, y, qidsAll);
      out.comparisons[k] = { n: e.n, mean: round(e.mean, 6) };
      check(`補足 ${pass} ${k}: 丸める前の差を 4 桁にすると summary と一致`, e.n === S.comparisons[k].n && Math.abs(round(e.mean, 4) - S.comparisons[k].mean) < 1e-9, `${e.mean} vs ${S.comparisons[k].mean}`);
    }
    for (const [k, qids] of Object.entries(subsets)) {
      const e = diffOf(sc, "B", "A", qids);
      out.subsetsBA[k] = { questions: qids.length, mean: round(e.mean, 6) };
      const s = S.subsetComparisons[k]["B-A"];
      check(`補足 ${pass} ${k} B−A: 4 桁で summary と一致`, e.n === s.n && Math.abs(round(e.mean, 4) - s.mean) < 1e-9, `${e.mean} vs ${s.mean}`);
    }
    exactDifferences[pass] = out;
  }

  // ---- 検索の hit 別（根拠 Scene が B の IR に入ったか）の点数（記述）----
  const hitStrata = {};
  for (const pass of ["sonnet", "haiku"]) {
    const sc = scoresByPass[pass];
    hitStrata[pass] = {};
    for (const [name, qids] of [["hit", subsets.irInEvidence], ["miss", subsets.irNotInEvidence]]) {
      hitStrata[pass][name] = { questions: qids.length, byArm: Object.fromEntries(["A", "B", "O"].map((a) => [a, round(mean(qids.map((q) => sc.get(`${q}|${a}`).score)), 6)])) };
    }
  }

  // ---- C の空の回答 1 件を除いた D−C・C−A（Sonnet。6.5 の棄権採点が符号に効くかの感度）----
  const empty = Object.entries(Object.fromEntries(
    [...latestJudgeByAnswer(readJsonl(P("main-sonnet", "judge.v3.jsonl"))).values()].filter((j) => j.auto === "empty" && j.qid && meta.has(j.qid) && j.answerId.split("|")[1] === "C").map((j) => [j.qid, 1]),
  )).map(([q]) => q);
  const scS = scoresByPass.sonnet;
  const qidsNoEmpty = qidsAll.filter((q) => !empty.includes(q));
  const dcAll = qidsAll.map((q) => scS.get(`${q}|D`).score - scS.get(`${q}|C`).score);
  const sensitivity = {
    emptyAnswerQuestionsInC: empty,
    DminusC: { all: { n: qidsAll.length, mean: round(mean(dcAll), 6) }, withoutEmpty: { ...diffOf(scS, "D", "C", qidsNoEmpty), mean: round(diffOf(scS, "D", "C", qidsNoEmpty).mean, 6) } },
    CminusA: { all: { n: qidsAll.length, mean: round(diffOf(scS, "C", "A", qidsAll).mean, 6) }, withoutEmpty: { n: qidsNoEmpty.length, mean: round(diffOf(scS, "C", "A", qidsNoEmpty).mean, 6) } },
    DminusCnonzeroQuestions: { total: dcAll.filter((d) => Math.abs(d) > 1e-12).length, DBetter: dcAll.filter((d) => d > 1e-12).length, CBetter: dcAll.filter((d) => d < -1e-12).length },
  };

  // ---- 照合の 2×2 の内訳（答えのある 189 件＝S2＋S3）----
  const key = readJson(P("verify-main-sonnet", "key.json"));
  const vres = readJsonl(P("verify-main-sonnet", "results.jsonl"));
  const judge = latestJudgeByAnswer(readJsonl(P("main-sonnet", "judge.v3.jsonl")));
  const rowById = new Map(rowsByPass.sonnet.map((r) => [r.id, r]));
  const cells = {}; // 「規則|judge の flag|照合者の確定」
  const confirmedByRuleArm = { S2: {}, S3: {} };
  let n189 = 0;
  const tally = { judgePositive: 0, verifierContradiction: 0, both: 0, judgePositiveOnly: 0, verifierOnly: 0, verifierOnlyByRule: { S2: 0, S3: 0 }, judgePositiveByFlag: { contradictionOnly: 0, hedgedOnly: 0, both: 0 }, hedgedAndVerifierContradiction: 0, verifierFabricatedClaim: 0, judgePositiveInS3: 0 };
  for (const r of vres) {
    const k = key[r.id];
    if (k.selectedBy === "S1") continue;
    n189++;
    const j = judge.get(k.answerId), a = rowById.get(k.answerId);
    const jpos = !!(j.contradiction || j.hedged), vpos = !!r.contradiction, conf = !!(r.contradiction || r.fabricated_claim);
    if (jpos) { tally.judgePositive++; if (j.contradiction && j.hedged) tally.judgePositiveByFlag.both++; else if (j.hedged) tally.judgePositiveByFlag.hedgedOnly++; else tally.judgePositiveByFlag.contradictionOnly++; if (k.selectedBy === "S3") tally.judgePositiveInS3++; }
    if (vpos) tally.verifierContradiction++;
    if (r.fabricated_claim) tally.verifierFabricatedClaim++;
    if (jpos && vpos) tally.both++;
    if (jpos && !vpos) tally.judgePositiveOnly++;
    if (!jpos && vpos) { tally.verifierOnly++; tally.verifierOnlyByRule[k.selectedBy]++; }
    if (j.hedged && vpos) tally.hedgedAndVerifierContradiction++;
    const o = ((confirmedByRuleArm[k.selectedBy][a.arm]) ??= { rows: 0, confirmed: 0 });
    o.rows++; if (conf) o.confirmed++;
    const c = `${k.selectedBy}|judge:${j.contradiction ? "contradiction" : ""}${j.hedged ? "+hedged" : ""}${!j.contradiction && !j.hedged ? (j.unverified ? "unverified" : "none") : ""}|verifier:${r.contradiction ? "contradiction" : ""}${r.fabricated_claim ? "+fabricated_claim" : ""}`;
    cells[c] = (cells[c] || 0) + 1;
  }
  const sj = summaries.sonnet.confirmation.judgeVsVerifier.contradictionOrHedgedVsContradiction;
  check("補足: 2×2 の件数が summary と一致（189・judge 71・照合者 8・両方 4）", n189 === sj.agreement.n && tally.judgePositive === sj.positives.judge && tally.verifierContradiction === sj.positives.verifier && tally.both === sj.positives.both, JSON.stringify(tally));
  const s3 = confirmedByRuleArm.S3;
  check("補足: S3 の確定の arm 別合計が 4/69", Object.values(s3).reduce((a, b) => a + b.confirmed, 0) === summaries.sonnet.confirmation.s3MissRate.successes && Object.values(s3).reduce((a, b) => a + b.rows, 0) === summaries.sonnet.confirmation.s3MissRate.n);

  // ---- N 型で棄権でなかった回答の照合者の判定（uncertain を含む）----
  const nonAbstainedN = [];
  for (const r of vres) {
    const k = key[r.id];
    if (k.selectedBy !== "S1" || r.abstained) continue;
    const a = rowById.get(k.answerId);
    nonAbstainedN.push({ qid: a.qid, arm: a.arm, verifierAbstained: !!r.abstained, verifierFabricated: !!r.fabricated, uncertain: !!r.uncertain, goldAnswerableInManuscript: !!r.gold_answerable_in_manuscript, judgeFabricated: !!judge.get(k.answerId).fabricated });
  }
  nonAbstainedN.sort((x, y) => (x.qid + x.arm < y.qid + y.arm ? -1 : 1));
  const nFabricatedByArm = Object.fromEntries(ARMS.map((arm) => [arm, vres.filter((r) => key[r.id].selectedBy === "S1" && rowById.get(key[r.id].answerId).arm === arm && r.fabricated).length]));

  // ---- Haiku の judge の失敗の内訳（呼び出し単位と answer 単位を分ける）----
  const hj = readJsonl(P("main-haiku", "judge.v3.jsonl"));
  const byAns = new Map();
  for (const r of hj) { if (!byAns.has(r.answerId)) byAns.set(r.answerId, []); byAns.get(r.answerId).push(r); }
  const hf = { failedCalls: hj.filter((r) => !r.ok).length, retriedOkAnswers: 0, failedCallsInRetriedOkAnswers: 0, retriedOkAtAttempt: {}, droppedAnswers: 0, failedCallsInDroppedAnswers: 0, droppedAnswerAttempts: [], droppedAnswerIds: [] };
  for (const [id, rows] of byAns) {
    const f = rows.filter((r) => !r.ok);
    if (!f.length) continue;
    const ok = rows.find((r) => r.ok);
    if (ok) { hf.retriedOkAnswers++; hf.failedCallsInRetriedOkAnswers += f.length; hf.retriedOkAtAttempt[ok.attempts] = (hf.retriedOkAtAttempt[ok.attempts] || 0) + 1; }
    else { hf.droppedAnswers++; hf.failedCallsInDroppedAnswers += f.length; hf.droppedAnswerAttempts.push(Math.max(...rows.map((r) => r.attempts))); hf.droppedAnswerIds.push(id); }
  }
  hf.droppedAnswerIds.sort();
  const hs = summaries.haiku.judge.failures;
  check("補足: Haiku judge の失敗の内訳が summary と一致（呼び出し 21・再送成功 13 answer・欠測 2 answer）",
    hf.failedCalls === hs.failedCalls && hf.retriedOkAnswers === hs.retriedOk && hf.droppedAnswers === hs.droppedAtMaxAttempts
    && hf.failedCalls === hf.failedCallsInRetriedOkAnswers + hf.failedCallsInDroppedAnswers && hf.droppedAnswerAttempts.every((x) => x === 3), JSON.stringify(hf));

  return { exactDifferences, hitStrata, sensitivity, judgeVsVerifierBreakdown: { rows: n189, tally, cells }, confirmedByRuleArm, nonAbstainedN, nFabricatedByArm, haikuJudgeFailures: hf };
}
