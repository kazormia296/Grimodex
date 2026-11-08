#!/usr/bin/env node
// 使い方: node build-results.mjs <dataDir> <outDir>
// data（repo の外）から、本文を含まない results/ の JSON を作る。README は render-readme.mjs が JSON から作る。
// 本文・題・抜粋・質問・Gold・回答・IR・judge の説明・照合者や人の note は読み出さず、出力にも入れない
// （supplement.mjs は questions/*.json の id・type・evidence の Scene 番号だけを使う）。
import fs from "node:fs";
import path from "node:path";
import { readJson, readJsonl, writeJson, wilson, kappa, round, longJapaneseStrings, sha256File } from "./lib.mjs";
import { loadScores, latestJudgeByAnswer } from "./scores.mjs";
import { computeSizing } from "./sizing.mjs";
import { computeSupplement } from "./supplement.mjs";

const [dataDir, outDir] = process.argv.slice(2);
if (!dataDir || !outDir) { console.error("usage: node build-results.mjs <dataDir> <outDir>"); process.exit(2); }
const P = (...a) => path.join(dataDir, ...a);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.error("CHECK FAILED:", name, detail ?? ""); };

// ---------- 1. summary の写し（本文らしい文字列が無いことを確かめてから）----------
const ALLOWED_TEXT = /\.(note|missingRules|definition)$/; // 集計器が出す固定の説明文だけ許す
for (const pass of ["sonnet", "haiku"]) {
  const s = readJson(P(`main-${pass}`, "summary.json"));
  const hits = longJapaneseStrings(s, 15).filter((h) => !ALLOWED_TEXT.test(h.path));
  check(`summary-${pass}: 本文らしい文字列なし`, hits.length === 0, JSON.stringify(hits));
  if (hits.length) process.exit(1);
  writeJson(path.join(outDir, `summary-${pass}.json`), s);
}
const sonnet = readJson(P("main-sonnet", "summary.json"));
const haiku = readJson(P("main-haiku", "summary.json"));
// 照合の前後で、主指標・比較・副の比較が変わっていないこと（照合は confirmation を足すだけ）
const pre = readJson(P("main-sonnet", "summary.pre-verification.json"));
for (const k of ["primary", "comparisons", "subsetComparisons", "armScores", "byArm", "byType", "completeness"]) {
  check(`照合の前後で ${k} が同じ`, JSON.stringify(pre[k]) === JSON.stringify(sonnet[k]));
}

// ---------- 2. 照合 ----------
const sel = readJson(P("verify-main-sonnet", "selection-summary.json"));
const key = readJson(P("verify-main-sonnet", "key.json"));
const vres = readJsonl(P("verify-main-sonnet", "results.jsonl"));
const sonnetRows = loadScores(dataDir, "sonnet");
const rowById = new Map(sonnetRows.map((r) => [r.id, r]));
const judgeLatest = latestJudgeByAnswer(readJsonl(P("main-sonnet", "judge.v3.jsonl")));

// 照合の結果を arm・規則・型で数える（照合者の note・where は使わない）
const vrows = vres.map((r) => {
  const k = key[r.id], a = rowById.get(k.answerId);
  return { ...r, rule: k.selectedBy, arm: a.arm, qid: a.qid, type: a.type, cellId: a.cellId };
});
const byRuleArm = {};
for (const r of vrows) {
  const o = (byRuleArm[r.rule] ??= {});
  const c = (o[r.arm] ??= { rows: 0, contradiction: 0, fabricatedClaim: 0, uncertain: 0 });
  c.rows++; if (r.contradiction) c.contradiction++; if (r.fabricated_claim) c.fabricatedClaim++; if (r.uncertain) c.uncertain++;
}
check("照合: 260 件", vrows.length === 260 && sel.selected === 260);
check("照合: 規則別の件数が selection と一致", ["S1", "S2", "S3"].every((k) => vrows.filter((r) => r.rule === k).length === sel.byRule[k]));

// (b) の下限を独立に再計算して summary と照合する
const ARMS = ["0", "A", "B", "O", "C", "D"];
const lowerBoundRecomputed = {};
for (const arm of ARMS) {
  const ans = sonnetRows.filter((r) => r.arm === arm && r.type !== "N" && !r.missing);
  const s2 = new Map(vrows.filter((r) => r.rule === "S2" && r.arm === arm).map((r) => [r.qid, r]));
  let k = 0;
  for (const a of ans) { const v = s2.get(a.qid); if (a.hedged || (v && (v.contradiction || v.fabricated_claim))) k++; }
  lowerBoundRecomputed[arm] = { n: ans.length, successes: k };
  const sm = sonnet.confirmation.byArm[arm].lowerBound;
  check(`(b) 下限の再計算 arm ${arm}`, sm.successes === k && sm.n === ans.length, `${k}/${ans.length} vs ${sm.successes}/${sm.n}`);
}
const s3 = vrows.filter((r) => r.rule === "S3");
const s3Miss = s3.filter((r) => r.contradiction || r.fabricated_claim).length;
check("S3 の見逃し 4/69", s3Miss === 4 && s3.length === 69 && sonnet.confirmation.s3MissRate.successes === 4);

// N 型：照合者の判定（arm 別）と、照合者が『原稿から答えられる』と記録した質問
const nRows = vrows.filter((r) => r.type === "N");
const nByArm = {};
for (const arm of ARMS) {
  const rs = nRows.filter((r) => r.arm === arm);
  nByArm[arm] = {
    verified: rs.length,
    abstained: rs.filter((r) => r.abstained).length,
    fabricated: rs.filter((r) => r.fabricated).length,
    goldAnswerableInManuscript: rs.filter((r) => r.gold_answerable_in_manuscript).length,
    judgeAgreesAbstained: rs.filter((r) => judgeLatest.get(key[r.id].answerId)?.abstained === r.abstained).length,
  };
  const sm = sonnet.confirmation.nTypeByArm[arm];
  check(`N 型 arm ${arm} が summary と一致`, sm.verified === nByArm[arm].verified && sm.abstained === nByArm[arm].abstained && sm.fabricated === nByArm[arm].fabricated);
}
const nonAbstainedN = Object.fromEntries(ARMS.map((arm) => [arm, nRows.filter((r) => r.arm === arm && !r.abstained).map((r) => ({ qid: r.qid, verifierFabricated: r.fabricated, goldAnswerableInManuscript: r.gold_answerable_in_manuscript, judgeFabricated: judgeLatest.get(key[r.id].answerId).fabricated }))]));
const answerableN = [...new Set(nRows.filter((r) => r.gold_answerable_in_manuscript).map((r) => r.qid))].sort();
// N 型の回答の総数（空の回答は judge を呼ばず棄権で採点され、照合の対象外）
const nAnswersByArm = Object.fromEntries(ARMS.map((arm) => [arm, sonnetRows.filter((r) => r.arm === arm && r.type === "N").length]));
const emptyAnswers = Object.fromEntries(ARMS.map((arm) => [arm, [...judgeLatest.values()].filter((j) => j.auto === "empty" && j.answerId.split("|")[1] === arm).map((j) => j.qid).sort()]));

writeJson(path.join(outDir, "verification.json"), {
  schema: "ir-chat-pilot-verification/1",
  evidenceScope: "not-cp4-evidence",
  instructionsGivenToVerifiers: {
    note: "指示書の全文から照合者の節（「照合者への指示」と「守ること」）だけを切り出した instructions.md。8 部で同一。",
    excerptSha256: [...new Set(fs.readdirSync(P("verify-main-sonnet", "parts")).map((d) => sha256File(P("verify-main-sonnet", "parts", d, "instructions.md"))))],
    fullInstructionsSha256FromFreezeManifest: readJson(P("freeze-manifest.json")).data.verifyInstructions,
    parts: fs.readdirSync(P("verify-main-sonnet", "parts")).sort().map((d) => ({ part: d, rows: readJsonl(P("verify-main-sonnet", "parts", d, "results.jsonl")).length })),
  },
  verifier: "Sonnet 5.5 の subagent（effort high、API ではない）。8 部に分けて 8 体。盲検の限界は README と事前登録の限界 18・19",
  selection: { seed: sel.seed, rate: sel.rate, judgedAnswers: sel.judgedAnswers, skippedAuto: sel.skippedAuto, selected: sel.selected, byRule: sel.byRule, byType: sel.byType, materialsSha256: sel.materialsSha256 },
  definition: sonnet.confirmation.definition,
  confirmation: {
    lowerBoundByArm: Object.fromEntries(ARMS.map((a) => [a, sonnet.confirmation.byArm[a]])),
    s3MissRate: sonnet.confirmation.s3MissRate,
    recomputedLowerBound: lowerBoundRecomputed,
  },
  judgeVsVerifier: sonnet.confirmation.judgeVsVerifier,
  itemAudit: sonnet.confirmation.itemAudit,
  verifierFlagsByRuleAndArm: byRuleArm,
  verifierUncertain: { rows: vrows.length, uncertainTrue: vrows.filter((r) => r.uncertain).length },
  nType: {
    note: "N 型の正本は S1（照合者）。judge 側の数（棄権・作話）は summary-sonnet.json の byArm。",
    verifierByArm: nByArm,
    nAnswersByArm,
    emptyAnswersAbstainedWithoutJudge: emptyAnswers,
    questionsVerifierRecordedAnswerableInManuscript: answerableN,
    nonAbstainedByVerifier: nonAbstainedN,
    summaryNTypeByArm: sonnet.confirmation.nTypeByArm,
    judgeBasedByArm: Object.fromEntries(ARMS.map((a) => [a, { nAbstain: sonnet.byArm[a].nAbstain, nFabricated: sonnet.byArm[a].nFabricated }])),
  },
});

// ---------- 3. 人の較正 ----------
const csel = readJson(P("calibration-selection.json"));
const ckey = readJson(P("calibration-key.json"));
const cj = readJson(P("calibration-judgments.json"));
const verdict = new Map(cj.judgments.map((j) => [j.cid, j.verdict])); // note は読まない
const cids = Object.keys(ckey).sort();
check("較正: 42 件", cids.length === 42 && cj.judgments.length === 42 && csel.total === 42);
const citems = cids.map((cid) => {
  const k = ckey[cid];
  const j = judgeLatest.get(k.answerId);
  check(`較正 ${cid}: judge の reproduced が judge.v3 と一致`, j && j.reproduced[k.itemIndex] === k.reproduced);
  return { cid, arm: k.arm, stratum: k.stratum, qid: k.qid, itemIndex: k.itemIndex, humanVerdict: verdict.get(cid), judgeReproduced: k.reproduced, answerId: k.answerId };
});
const dist = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
const decided = citems.filter((c) => c.humanVerdict === "yes" || c.humanVerdict === "no");
const agg = (rows) => {
  const agree = rows.filter((c) => (c.humanVerdict === "yes") === c.judgeReproduced).length;
  return {
    n: rows.length, agree, agreement: wilson(agree, rows.length),
    kappa: kappa(rows.map((c) => [c.judgeReproduced, c.humanVerdict === "yes"])),
    judgeLenient: rows.filter((c) => c.judgeReproduced && c.humanVerdict === "no").length, // judge true・人 no
    judgeStrict: rows.filter((c) => !c.judgeReproduced && c.humanVerdict === "yes").length, // judge false・人 yes
    humanYes: rows.filter((c) => c.humanVerdict === "yes").length,
    judgeTrue: rows.filter((c) => c.judgeReproduced).length,
  };
};
const overall = agg(decided);
const calByArm = Object.fromEntries(ARMS.map((a) => [a, agg(decided.filter((c) => c.arm === a))]));
const calByStratum = Object.fromEntries(["short", "long"].map((s) => [s, agg(decided.filter((c) => c.stratum === s))]));
const unsure = citems.filter((c) => c.humanVerdict === "unsure").map((c) => ({ cid: c.cid, arm: c.arm, stratum: c.stratum, qid: c.qid }));
const arm0Answers = dist(citems.filter((c) => c.arm === "0").map((c) => c.answerId));
// 元の判定を 3 つに分けた集計（yes / no / unsure）
const verdictCounts = dist(citems.map((c) => c.humanVerdict));
check("較正: 23/18/1", verdictCounts.yes === 23 && verdictCounts.no === 18 && verdictCounts.unsure === 1, JSON.stringify(verdictCounts));
check("較正: 一致 38/41", overall.agree === 38 && overall.n === 41);
check("較正: 層別の件数が selection と一致", ARMS.every((a) => ["short", "long"].every((s) => citems.filter((c) => c.arm === a && c.stratum === s).length === csel.countsByArmAndStratum[a][s])));
const calItems = citems.map(({ answerId, ...rest }) => rest);
writeJson(path.join(outDir, "calibration.json"), {
  schema: "ir-chat-pilot-calibration/1",
  evidenceScope: "not-cp4-evidence",
  protocol: "事前登録 11.3（任意）。ユーザーが 2026-11-08 に判定。回答が項目を再現しているかを yes／no／unsure で判定。判定者 1 人・各項目 1 回。",
  seed: csel.seed, seedNote: "事前登録には種が無く、判定の前に統合者が固定した。",
  total: csel.total, distinctQuestions: csel.distinctQuestions, maxPerQuestion: csel.maxPerQuestion,
  layerThresholdsTextLength: csel.layerThresholds, countsByArmAndStratum: csel.countsByArmAndStratum,
  selectionRules: csel.rules, keySha256: csel.keySha256,
  deviations: [
    "arm 0 は棄権でない回答が 4 件しかない（短・長の各層の候補は 2 回答）ため、arm 0 だけ同じ回答から別の項目を最大 2 件取った（calibration-selection.json の rules）。",
    "棄権した回答（judge の abstained）は抽出の対象から外した。",
    "抽出の種は事前登録に無く、判定の前に統合者が固定した。",
  ],
  arm0ItemsPerAnswer: Object.values(arm0Answers).sort((a, b) => b - a),
  verdictCounts, unsure,
  overall, byArm: calByArm, byStratum: calByStratum,
  items: calItems,
});

// ---------- 4. 費用 ----------
const ledger = readJsonl(P("spend-ledger.jsonl"));
const CAPS = { gold: 16, context: 1, "answer-sonnet-pass": 3, "judge-sonnet-pass": 0.5, "answer-haiku": 4, "judge-haiku": 4, "judge-misaccept-gen": 0.1, "answer-sonnet": 30 };
const stages = new Map();
for (const r of ledger) {
  if (!stages.has(r.stage)) stages.set(r.stage, { stage: r.stage, lines: 0, usd: 0, inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, firstTs: r.ts, lastTs: r.ts });
  const s = stages.get(r.stage);
  s.lines++; s.usd += r.usd; s.inputTokens += r.input_tokens; s.cacheCreationTokens += r.cache_creation_input_tokens;
  s.cacheReadTokens += r.cache_read_input_tokens; s.outputTokens += r.output_tokens;
  if (r.ts < s.firstTs) s.firstTs = r.ts; if (r.ts > s.lastTs) s.lastTs = r.ts;
}
let cum = 0;
const stageList = [...stages.values()].sort((a, b) => (a.firstTs < b.firstTs ? -1 : 1)).map((s) => {
  cum += s.usd;
  return { ...s, usd: round(s.usd, 4), cumulativeUsd: round(cum, 4), capUsd: CAPS[s.stage] ?? null, withinCap: CAPS[s.stage] == null ? null : s.usd <= CAPS[s.stage] };
});
const total = ledger.reduce((a, r) => a + r.usd, 0);
const sonnetUsd = Object.values(sonnet.byArm).reduce((a, b) => a + b.usd, 0);
const stageUsd = (n) => stages.get(n)?.usd ?? 0;
check("費用: answer-sonnet の台帳と summary の arm 合計が一致", Math.abs(stageUsd("answer-sonnet") - sonnetUsd) < 0.01, `${stageUsd("answer-sonnet")} vs ${sonnetUsd}`);
check("費用: 上限 $60 以内", total <= 60);
check("費用: 台帳の行数 answer-sonnet が request 数以上", stages.get("answer-sonnet").lines >= 474);
writeJson(path.join(outDir, "spend.json"), {
  schema: "ir-chat-pilot-spend/1",
  source: "spend-ledger.jsonl（全 request の usage から計算した台帳）",
  capUsd: 60, capSource: "事前登録 0.1 の決定 6。段の上限は 6.2.1。",
  totalUsd: round(total, 4), remainingUsd: round(60 - total, 4), ledgerLines: ledger.length,
  stages: stageList,
  notes: [
    "gold 段は旧台帳が Sonnet の cache 読みを 0.1 倍で計上していたため、価格表どおり 0.05 倍で計算した実費より約 $1.33 多く載っている（事前登録 6.2.1。履歴なので書き換えていない）。",
    "judge-haiku 段は通し・誤受理・本測定（Sonnet・Haiku の回答）の judge の合計。answer-haiku 段は通しと本測定の反復と Scene p だけの label。",
  ],
  preMainRunUsdAtFreezeFromPreregistration: 18.0,
  estimateFromPreregistrationUsd: { central: 35.4, worst: 50.1 },
});

// ---------- 5. 規模の見積り ----------
const sizing = computeSizing(dataDir);
check("sizing: B−A の平均が summary と一致", Math.abs(sizing.inputs.meanDiff - sonnet.primary.mean) < 1e-3);
writeJson(path.join(outDir, "sizing.json"), sizing);

// ---------- 補助: arm 0 の作品別（記憶の確認）と欠測 ----------
const armWork = {};
for (const w of ["g-ja-1", "m-ja-2"]) for (const arm of ["0", "A", "B"]) {
  const rs = sonnetRows.filter((r) => r.work === w && r.arm === arm && r.type !== "N" && !r.missing);
  const items = rs.reduce((a, r) => a + r.items.length, 0), ok = rs.reduce((a, r) => a + r.items.filter(Boolean).length, 0);
  (armWork[w] ??= {})[arm] = { questions: rs.length, itemRecall: wilson(ok, items), questionScoreMean: round(rs.reduce((a, r) => a + r.score, 0) / rs.length) };
}
writeJson(path.join(outDir, "work-breakdown.json"), { schema: "ir-chat-pilot-work-breakdown/1", note: "Sonnet、judge v3 の reproduced。arm 0 は記憶の確認。", byWork: armWork });

// ---------- 6. 補足（丸める前の差、2×2 の内訳、S2／S3 の arm 別、Haiku の judge の失敗の内訳ほか）----------
const supplement = computeSupplement(dataDir, { checks, summaries: { sonnet, haiku } });
writeJson(path.join(outDir, "supplement.json"), { schema: "ir-chat-pilot-supplement/1", evidenceScope: "not-cp4-evidence", note: "summary の mean は 4 桁の丸めで、README の 1 桁表示と二重丸めになる。exactDifferences は丸める前の差（6 桁）。", ...supplement });

writeJson(path.join(outDir, "build-checks.json"), { schema: "ir-chat-pilot-build-checks/1", allOk: checks.every((c) => c.ok), checks });
console.log(`checks: ${checks.filter((c) => c.ok).length}/${checks.length} ok`);
if (!checks.every((c) => c.ok)) process.exit(1);
