#!/usr/bin/env node
// 使い方: node render-readme.mjs <resultsDir>
// results/ の JSON だけから README.md を作る（data は読まない）。README の数値はすべて JSON の値。
import fs from "node:fs";
import path from "node:path";
import { readJson, wilson } from "./lib.mjs";

const dir = process.argv[2];
if (!dir) { console.error("usage: node render-readme.mjs <resultsDir>"); process.exit(2); }
const R = (f) => readJson(path.join(dir, f));
const S = R("summary-sonnet.json"), H = R("summary-haiku.json"), V = R("verification.json"), C = R("calibration.json");
const SP = R("spend.json"), Z = R("sizing.json"), W = R("work-breakdown.json"), X = R("supplement.json");

const pt = (x, d = 1) => (x == null ? "—" : (x * 100).toFixed(d));
const sg = (x, d = 1) => (x == null ? "—" : (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(d));
const ci = (c) => `[${sg(c.ci95[0])}, ${sg(c.ci95[1])}]`;
const loco = (c) => `${sg(c.leaveOneClusterOut.min)}〜${sg(c.leaveOneClusterOut.max)}`;
const wl = (w) => `${w.successes}/${w.n}＝${pt(w.rate)}％ [${pt(w.low)}, ${pt(w.high)}]`;
const usd = (x) => "$" + x.toFixed(2);
const ARMS = ["0", "A", "B", "O", "C", "D"];
const cmp = (s, k) => s.comparisons[k];
const sub = (s, k) => s.subsetComparisons[k]["B-A"];
// summary の mean は 4 桁に丸められている。README の 1 桁表示で二重丸めにならないよう、差の平均は supplement.json の
// 丸める前の値（6 桁）を使う。summary の値と食い違えば止める（build-results.mjs でも突合している）。
const withExact = (c, m) => { if (Math.abs(m - c.mean) > 5.1e-5) throw new Error(`exact mean mismatch: ${m} vs ${c.mean}`); return { ...c, mean: m }; };
const exC = (pass, k) => withExact((pass === "sonnet" ? S : H).comparisons[k], X.exactDifferences[pass].comparisons[k].mean);
const exS = (pass, k) => withExact((pass === "sonnet" ? S : H).subsetComparisons[k]["B-A"], X.exactDifferences[pass].subsetsBA[k].mean);
const row = (label, s, c, n) => `| ${label} | ${n ?? c.n} | ${sg(c.mean)} | ${ci(c)} | ${loco(c)} |`;

const sB = V.confirmation.lowerBoundByArm;
const jv = V.judgeVsVerifier;
const sizeNo = Object.fromEntries(Z.results.noCluster.map((r) => [r.delta, r.questions]));
const sizeMc = Object.fromEntries(Z.results.mcnemar.map((r) => [r.delta, r.questionsEquivalent]));
const rc = (arr, d, m) => arr.find((r) => r.delta === d && r.questionsPerCell === m);
const rcell = Z.results.cellCluster.requiredCellsAtPointEstimate, rcell2 = Z.results.cellCluster.requiredCellsIfCellVarianceDoubled, rcell0 = Z.results.cellCluster.requiredCellsIfCellVarianceZero;
const rw = Z.results.workNested.requiredWorks;
const floor = Z.results.cellCluster.mdeFloorWithUnlimitedQuestions;
const mde20 = Z.results.cellCluster.mdeAtPointEstimate.find((r) => r.questionsPerCell === 20 && r.cells === 4);
const ov = Z.inputs;
const sonnetTotals = SP.stages.find((s) => s.stage === "answer-sonnet");

const typeRows = ["E", "M", "T", "U", "R", "K"].map((t) => {
  const b = S.byType[t], c = exS("sonnet", `type:${t}`);
  return `| ${t} | ${c.n} | ${pt(b.A.questionScoreMean)} | ${pt(b.B.questionScoreMean)} | ${sg(c.mean)} ${ci(c)} | ${pt(b.O.questionScoreMean)} | ${pt(b.C.questionScoreMean)} |`;
});
const armRows = ARMS.map((a) => {
  const b = S.byArm[a], l = sB[a];
  return `| ${a} | ${pt(b.itemRecall.rate)}（${b.itemRecall.successes}/${b.itemRecall.n}） | ${pt(b.questionScoreMean)} | ${pt(b.overAbstain.rate)} | ${b.nAbstain.successes}/12・${b.nFabricated.successes} | ${pt(b.contradictionAny.rate)} | ${pt(b.bCandidate.rate)} | ${l.lowerBound.successes}/${l.lowerBound.n}＝${pt(l.lowerBound.rate)}％ [${pt(l.lowerBound.low)}, ${pt(l.lowerBound.high)}] | ${pt(l.pointEstimate.rateIfMissRateLow)}〜${pt(l.pointEstimate.rateIfMissRateHigh)}（${pt(l.pointEstimate.rate)}） |`;
});
const calArm = ARMS.map((a) => {
  const x = C.byArm[a];
  return `| ${a} | ${x.n} | ${x.agree}/${x.n} | ${x.kappa ?? "—"} | ${x.judgeLenient} | ${x.judgeStrict} | ${x.humanYes} | ${x.judgeTrue} |`;
});
const nVer = V.nType.verifierByArm;
const stageRows = SP.stages.map((s) => `| ${s.stage} | ${usd(s.usd)} | ${usd(s.cumulativeUsd)} | ${s.capUsd == null ? "—" : usd(s.capUsd)} |`);
const hcmp = (k) => exC("haiku", k);
const hf = X.haikuJudgeFailures;
const hDropArms = hf.droppedAnswerIds.map((id) => id.split("|")[1]);
const hLine = (k, label) => { const c = exS("haiku", k); return `| ${label} | ${c.n} | ${sg(c.mean)} ${ci(c)} | ${sg(exS("sonnet", k).mean)} |`; };
const sens = X.sensitivity;
const jb = X.judgeVsVerifierBreakdown.tally;
const s3a = X.confirmedByRuleArm.S3, s2a = X.confirmedByRuleArm.S2;
const s3Text = (arms) => arms.map((a) => `${a} ${s3a[a].confirmed}/${s3a[a].rows}`).join("、");
const hit = X.hitStrata;
const hitTxt = (p) => `根拠 Scene が B の IR に入った ${hit[p].hit.questions} 問は A ${pt(hit[p].hit.byArm.A)}・B ${pt(hit[p].hit.byArm.B)}・O ${pt(hit[p].hit.byArm.O)}、入らなかった ${hit[p].miss.questions} 問は A ${pt(hit[p].miss.byArm.A)}・B ${pt(hit[p].miss.byArm.B)}・O ${pt(hit[p].miss.byArm.O)}`;
const nUnc = X.nonAbstainedN.filter((x) => x.uncertain && !x.verifierFabricated && !x.goldAnswerableInManuscript);
const nUncQ = [...new Set(nUnc.map((x) => x.qid))].join("・");
const nUncArms = [...new Set(nUnc.map((x) => x.arm))].join("・");
const nW12 = wilson(0, 12);
const oaA = S.byArm.A.overAbstain, oaB = S.byArm.B.overAbstain;
const itemAudit = V.itemAudit.mechanicalVsJudge;

const md = `# chat の IR pilot 本測定の結果（2026-11-07〜08）

事前登録 v3.2（\`../preregistration-v3.2.md\`、凍結 \`../freeze-record-v3.2.md\`）の本測定の結果。本文を含まない（件数・ID・enum・率・区間・hash だけ）。数値は同じ階層の JSON が正本で、この README は \`scripts/render-readme.mjs\` が JSON から作る。

## 位置づけ

- **not-cp4-evidence の探索 pilot**。次の正式な試験の規模と質問の型の配分の材料を得るのが目的（1.2）。製品判断（閉じた経路の開閉、鮮度、枠の大きさ、PUB-G）には使わない。採否の閾値は置かない。
- 言えるのは『**出来事の IR の block を足した効果（文脈の量・検索単位の違い・quote の追加を含む）**』の推定まで。「IR の効果」とは書かない。
- **B−A は『chat に質問で IR を引く経路をつないだ場合の見積り』**。B・D の IR は評価側が質問つきの seed で選んだもので、製品の今の IR の経路（質問を載せられない）ではない（限界 16）。

## 何をしたか・逸脱・未実施

2 作品（g-ja-1、m-ja-2）×2 地点（p=59・117）の 79 問（答えのある 67 問＋N 12 問）を 6 arm（0・A・B・O・C・D）で回答させた。Sonnet 5.5 effort high を ${S.counts.answers} request（各 arm 1 回）、Haiku 5.5 effort low を ${H.counts.answers} request（0・A・B・O は各 237、C・D は各 79）。**停止規則の発動は 0**、API 失敗による欠測 0、max_tokens の切れ 0、棄権の refusal 0。judge は Haiku 5.5 の API（prompt v3、sha256 \`${S.judge.sha256.slice(0, 8)}…\`）。judge の失敗は Sonnet が 1 回（再送で成功）、Haiku は失敗した呼び出しが ${hf.failedCalls} 回（再送で成功した answer ${hf.retriedOkAnswers} 件〔その失敗は ${hf.failedCallsInRetriedOkAnswers} 回〕、3 回目の試行でも失敗して欠測の answer ${hf.droppedAnswers} 件〔その失敗は ${hf.failedCallsInDroppedAnswers} 回〕＝Haiku の ${hDropArms.join(" と ")} 各 1）。Sonnet の空の回答 2 件（C の ${V.nType.emptyAnswersAbstainedWithoutJudge.C.join("・")}）は規則（6.5）どおり棄権として採点。

| 区分 | 内容 |
|---|---|
| 逸脱（手順の細部） | **照合者への指示書は全文でなく、照合者の節（「照合者への指示」と「守ること」）だけを切り出した instructions.md を渡した**（盲検のため S1〜S3 の規則を見せない）。切り出しの sha256 \`${V.instructionsGivenToVerifiers.excerptSha256[0].slice(0, 8)}…\`、全文の sha256 は manifest の verifyInstructions（\`${V.instructionsGivenToVerifiers.fullInstructionsSha256FromFreezeManifest.slice(0, 8)}…\`）と一致。照合は Sonnet 5.5 subagent（effort high）8 体、260 件を原稿ごとに 2 つ、計 8 部に分けた。 |
| 逸脱（較正） | 抽出の種 \`${C.seed}\` は事前登録に無く、判定の前に統合者が固定した。arm 0 は棄権でない回答が 4 件しかなく、arm 0 だけ同じ回答から別の項目を最大 2 件取った。棄権した回答は抽出から外した。 |
| 未実施（逸脱ではない） | **本測定への judge の反復（--repeat）**。事前登録 4 節の judge の自己一致は Haiku の通し 168 回答の測定として書かれ、本測定への適用は必須と書かれていない（6.2 の費用見積りが再判定の 2 倍を見込んだだけ）。よって未実施として扱う。本測定の judge の揺れは未測定で、通しの値（contradiction κ 0.77、unverified κ 0.53）しか根拠が無い。 |
| 未実施 | Haiku の judge の照合者による確認（設計に無い）。Haiku の数値は Sonnet に持ち越さない。 |
| 未実施 | A−B 以外の arm 間の不一致セルの件数（事前登録 5 節の副）。A−B の項目の対応は「正式な試験の規模の見積り」の節にある。他の組は集計していない。 |

## 主指標と副の差（Sonnet 5.5 effort high、項目の再現は judge v3）

主指標は答えのある 67 問の B−A（質問単位の対応のある差の平均。区間は cell〔作品×地点〕で層別した質問の復元抽出 bootstrap、種 \`${S.primary.seed.split(":")[0]}\`、10,000 回。「LOCO」は 1 cluster を除いた推定値 4 個の範囲）。単位は pt。**区間が 0 を含まない**が、区間は cell を固定した層別なので cell の標本変動を含まない（下の規模の見積り）。採否は判定しない。

| 比較 | 質問数 | 差 (pt) | 95% 区間 | LOCO |
|---|---|---|---|---|
${row("**B−A（主指標）**", S, exC("sonnet", "B-A"))}
${row("B−A 確認済み 30 問", S, exS("sonnet", "confirmed30"))}
${row("B−A 根拠 Scene に IR あり", S, exS("sonnet", "irInEvidence"))}
${row("B−A 根拠 Scene に IR なし", S, exS("sonnet", "irNotInEvidence"))}
${row("B−A 推測可を除く", S, exS("sonnet", "excludingGuessable"))}
${row("B−A g-ja-1", S, exS("sonnet", "work:g-ja-1"))}
${row("B−A m-ja-2", S, exS("sonnet", "work:m-ja-2"))}
${row("B−A p=59", S, exS("sonnet", "p:59"))}
${row("B−A p=117", S, exS("sonnet", "p:117"))}
${row("D−C（注意誘導・妨害）", S, exC("sonnet", "D-C"))}
${row("C−A", S, exC("sonnet", "C-A"))}
${row("O−A", S, exC("sonnet", "O-A"))}
${row("O−0", S, exC("sonnet", "O-0"))}
${row("B−0", S, exC("sonnet", "B-0"))}

LOCO は作品別・地点別では 2 cluster。arm 別の点数（質問の点数の平均、％）は 0＝${pt(S.armScores["0"].questionScoreMean)}、A＝${pt(S.armScores.A.questionScoreMean)}、B＝${pt(S.armScores.B.questionScoreMean)}、O＝${pt(S.armScores.O.questionScoreMean)}、C＝${pt(S.armScores.C.questionScoreMean)}、D＝${pt(S.armScores.D.questionScoreMean)}。B は O にも C にも遠い。**D−C の ${sg(sens.DminusC.all.mean)} は C の空の回答 1 件（${sens.emptyAnswerQuestionsInC.join("・")}）の棄権採点で決まる**：C は空で点数 0、D は 1。この質問を除くと D−C は ${sg(sens.DminusC.withoutEmpty.mean)}（${sens.DminusC.withoutEmpty.n} 問）で符号が変わる（C−A は ${sg(sens.CminusA.all.mean)} から ${sg(sens.CminusA.withoutEmpty.mean)}）。D−C が 0 でない質問は ${sens.DminusCnonzeroQuestions.total} 問（D 優位 ${sens.DminusCnonzeroQuestions.DBetter}、C 優位 ${sens.DminusCnonzeroQuestions.CBetter}）で、C と D の差は読めない。空の回答は 6.5 どおり棄権として採点しており規則違反ではない。arm 0 の項目の再現は g-ja-1 で ${W.byWork["g-ja-1"]["0"].itemRecall.successes}/${W.byWork["g-ja-1"]["0"].itemRecall.n}、m-ja-2 で ${W.byWork["m-ja-2"]["0"].itemRecall.successes}/${W.byWork["m-ja-2"]["0"].itemRecall.n}で、記憶による交絡は見えない。**ただし arm 0 は答えのある質問の ${pt(S.byArm["0"].overAbstain.rate)}％で棄権しており（定型句『分からなければそう答える』あり。限界 9）、記憶を検出する力は弱い**。m-ja-2 の記憶（限界 5）は主指標に混ざりうるので作品別を併記する。B−A は作品差が大きい（g-ja-1 ${sg(exS("sonnet", "work:g-ja-1").mean)}、m-ja-2 ${sg(exS("sonnet", "work:m-ja-2").mean)}。作品別の差は上表）。質問つき seed で根拠 Scene が IR に入った質問（47 問）で差が大きく、入らなかった質問（20 問）は 0 を含む。

**検索の hit 別の点数（％、記述。事前登録 5 節の副）**：Sonnet は${hitTxt("sonnet")}。Haiku は${hitTxt("haiku")}。

**Haiku 5.5 effort low（別の表。Sonnet に持ち越さない。0・A・B・O は 3 回の平均、C・D は 1 回）**

| 比較 | 質問数 | 差 (pt) | 95% 区間 | LOCO |
|---|---|---|---|---|
${row("B−A", H, hcmp("B-A"))}
${row("D−C", H, hcmp("D-C"))}
${row("C−A", H, hcmp("C-A"))}
${row("O−A", H, hcmp("O-A"))}
${row("B−A 根拠 Scene に IR あり", H, exS("haiku", "irInEvidence"))}
${row("B−A 根拠 Scene に IR なし", H, exS("haiku", "irNotInEvidence"))}

D−C・C−A の 66 問は C の judge 欠測 1 問を除いたもの（6.5）。Haiku の揺れ（同じ arm・同じ項目の判定が rep で割れる割合）は 0＝${pt(H.reproducibility["0"].item.splitRate)}％、A＝${pt(H.reproducibility.A.item.splitRate)}％、B＝${pt(H.reproducibility.B.item.splitRate)}％、O＝${pt(H.reproducibility.O.item.splitRate)}％。

**Haiku の B−A の作品別・地点別・型別（Sonnet の同じ層と並べる。事前登録 4 節は両方の差を出すと定める）**

| 層 | 質問数 | Haiku B−A (pt) [95% 区間] | Sonnet B−A (pt) |
|---|---|---|---|
${hLine("work:g-ja-1", "作品 g-ja-1")}
${hLine("work:m-ja-2", "作品 m-ja-2")}
${hLine("p:59", "地点 p=59")}
${hLine("p:117", "地点 p=117")}
${["E", "M", "T", "U", "R", "K"].map((t) => hLine(`type:${t}`, `型 ${t}`)).join("\n")}

**作品差・地点差・型別の傾向は Sonnet の観察で、Haiku は同じ大きさでは再現しない**。作品・地点の向きは同じ（m-ja-2 が g-ja-1 より、p=59 が p=117 より大きい）が、Haiku は作品差が小さく（${sg(exS("haiku", "work:g-ja-1").mean)} 対 ${sg(exS("haiku", "work:m-ja-2").mean)}）、p=117 は ${sg(exS("haiku", "p:117").mean)} と 0 に近い。型別では K が Haiku で ${sg(exS("haiku", "type:K").mean)}（Sonnet は ${sg(exS("sonnet", "type:K").mean)} で符号が逆）、U が ${sg(exS("haiku", "type:U").mean)}（Sonnet は ${sg(exS("sonnet", "type:U").mean)}）。R・E で大きい点は共通。

### arm 別の記述（Sonnet。judge の陽性・候補率は arm 間で比べない。4 節・限界 25）

| arm | 項目の再現率 | 質問の点数 | 過剰棄権％ | N の棄権・作話（judge） | judge 陽性（contradiction か hedged）％ | judge 候補（unverified を含む）％ | (b) 下限（照合者が確定） | (b) 点推定（r の範囲） |
|---|---|---|---|---|---|---|---|---|
${armRows.join("\n")}

過剰棄権は答えのある質問での棄権。(b) の下限は『judge の hedged ∪ S2 のうち照合者が contradiction か fabricated_claim を確定』（判定済みの答えのある 67 問が母数）で、arm 間の誤りの比較に使えるのは下限だけ（S2 の標本の範囲）。点推定は『(下限 + r × S2 に入らなかった回答) ÷ 67』で、r は S3 の見逃し率 ${V.confirmation.s3MissRate.successes}/${V.confirmation.s3MissRate.n}＝${pt(V.confirmation.s3MissRate.rate)}％（Wilson [${pt(V.confirmation.s3MissRate.low)}, ${pt(V.confirmation.s3MissRate.high)}]）の両端。**r は pooled で、arm 別には使えない**（S3 の標本は arm あたり 9〜17 件）。点推定の arm 間の差は、pooled の r を各 arm の S2 に入らなかった回答数に掛けた結果にすぎず、誤りの大小の証拠にしない。

## 照合の結果（Sonnet subagent。原稿全体を読んだ確認）

- 抽出 ${V.selection.selected} 件＝S1（N 全件）${V.selection.byRule.S1}、S2（(b) の候補全件）${V.selection.byRule.S2}、S3（残りの 25％）${V.selection.byRule.S3}。照合の前後で主指標・比較・arm 別の集計は変わらない（照合は confirmation を足すだけ）。
- **(b) の下限**（arm 0／A／B／O／C／D）：${ARMS.map((a) => `${sB[a].lowerBound.successes}/${sB[a].lowerBound.n}`).join("／")}。B は ${sB.B.lowerBound.successes}/67（Wilson [${pt(sB.B.lowerBound.low)}, ${pt(sB.B.lowerBound.high)}]）、A は 0/67（上限 ${pt(sB.A.lowerBound.high)}）。標本が小さく、S2 では B の確定 ${sB.B.s2Confirmed.successes}/${sB.B.s2Confirmed.n} が A の 0/${sB.A.s2Confirmed.n} より多いという記述にとどめる。**S3（無作為の 25％）で照合者が contradiction か fabricated_claim を確定した ${V.confirmation.s3MissRate.successes} 件の arm 内訳は ${s3Text(["A", "C", "D", "B"])}（O ${s3a.O.confirmed}/${s3a.O.rows}、0 ${s3a["0"].confirmed}/${s3a["0"].rows}）で、A が B より多い**。S2 と S3 で向きが逆なので、**arm 間の誤りの大小は判定しない**。誤りの原因が IR の block かは見ていない。
- **S3 の見逃し率**は ${V.confirmation.s3MissRate.successes}/${V.confirmation.s3MissRate.n}。点推定は A＝${pt(sB.A.pointEstimate.rate)}％、B＝${pt(sB.B.pointEstimate.rate)}％など（上表。r の範囲での幅が大きい）。r は pooled の値を全 arm に掛けたもので、arm 別の S3 の確定（上）とは向きが合わない。
- **judge と照合者の一致**：項目の再現 ${wl(jv.items.agreement)}、κ ${jv.items.kappa}（陽性は judge ${jv.items.positives.judge}・照合者 ${jv.items.positives.verifier}・両方 ${jv.items.positives.both}）。**judge の contradiction か hedged と照合者の contradiction（答えのある ${jv.contradictionOrHedgedVsContradiction.agreement.n} 件＝S2＋S3 で比べる）**：judge の陽性は ${jb.judgePositive} 件（contradiction のみ ${jb.judgePositiveByFlag.contradictionOnly}、hedged のみ ${jb.judgePositiveByFlag.hedgedOnly}、両方 ${jb.judgePositiveByFlag.both}）、照合者の contradiction は ${jb.verifierContradiction} 件（${jv.contradictionOrHedgedVsContradiction.agreement.n} 件中）、両方 ${jb.both} 件（κ ${jv.contradictionOrHedgedVsContradiction.kappa}）。**judge の陽性 ${jb.judgePositive} 件のうち照合者が contradiction としたのは ${jb.both} 件**。照合者の ${jb.verifierContradiction} 件のうち ${jb.verifierOnly} 件は judge が flag していない回答（S3 で ${jb.verifierOnlyByRule.S3} 件、S2 の unverified で ${jb.verifierOnlyByRule.S2} 件）。judge の hedged ${jb.judgePositiveByFlag.hedgedOnly + jb.judgePositiveByFlag.both} 件は設計上、照合者が覆さない列（4 節）で比較に入っており、そのうち照合者が contradiction としたのは ${jb.hedgedAndVerifierContradiction} 件。標本は judge の陽性に偏る（S2 は候補の全件、S3 は残りの 25％で、S3 で judge が flag した回答は ${jb.judgePositiveInS3} 件）ので、κ は両者の一致の目安で、誤りの率の代表値ではない。judge の unverified ${jv.unverifiedVsFabricatedClaim.positives.judge} 件と照合者の fabricated_claim ${jv.unverifiedVsFabricatedClaim.positives.verifier} 件は両方 ${jv.unverifiedVsFabricatedClaim.positives.both} 件（κ ${jv.unverifiedVsFabricatedClaim.kappa}）。judge は誤りの flag では照合者と合わず、judge の flag 率は誤りの率として読めない。項目の再現の不一致率（照合者 対 judge）は ${pt(V.itemAudit.verifierVsJudgeItemDisagreementRate)}％。**機械照合が真なのに judge が偽の項目は ${itemAudit.mechanicalTrueJudgeFalse}/${itemAudit.itemsChecked}**（事前登録 4 節の報告項目。機械が偽で judge が真は ${itemAudit.mechanicalFalseJudgeTrue}/${itemAudit.itemsChecked}＝${pt(itemAudit.mechanicalFalseJudgeTrueRate)}％。機械は逐語照合で、言い換えを拾えない）。
- 照合者は uncertain を ${V.verifierUncertain.uncertainTrue}/${V.verifierUncertain.rows} 件に付けた。

## 人の較正（ユーザーが 2026-11-08 に判定。事前登録 11.3、任意）

${C.total} 件（arm 6×7、字数の中央値で短・長に層別、1 質問から最大 2 件、${C.distinctQuestions} 問）。判定は yes ${C.verdictCounts.yes}・no ${C.verdictCounts.no}・unsure ${C.verdictCounts.unsure}（${C.unsure.map((u) => `${u.cid}＝arm ${u.arm}、${u.qid}`).join("、")}）。unsure を除く ${C.overall.n} 件で judge の reproduced との**一致 ${wl(C.overall.agreement)}、κ ${C.overall.kappa}**。**差の向き**：judge が寛容（judge true・人 no）${C.overall.judgeLenient} 件、judge が厳密（judge false・人 yes）${C.overall.judgeStrict} 件。層別では短 ${C.byStratum.short.agree}/${C.byStratum.short.n}、長 ${C.byStratum.long.agree}/${C.byStratum.long.n}。

| arm | 件 | 一致 | κ | 寛容 | 厳密 | 人 yes | judge true |
|---|---|---|---|---|---|---|---|
${calArm.join("\n")}

**範囲の限界**：判定者 1 人・各項目 1 回、arm あたり 6〜7 件で arm 別の区間は極めて広い。arm 0 は 7 件とも judge・人とも no で情報が少ない（κ は定義できない）。arm O で一致が 5/7（κ ${C.byArm.O.kappa}）と低いが、件数が少なく傾向とは言えない。一致率の Wilson 下限 ${pt(C.overall.agreement.low)}％ は、judge の判定がおおむね人と合うという目安にとどまり、arm 間の差への影響は見ていない。差の向きは寛容 1・厳密 2 で、再現率の絶対値が低めに出る方向だが、件数が少なく確定しない。

## 棄権・N 型・型別（記述だけ）

- 過剰棄権（答えのある質問での棄権）は 0＝${pt(S.byArm["0"].overAbstain.rate)}％ → A＝${pt(S.byArm.A.overAbstain.rate)}％ → B＝${pt(S.byArm.B.overAbstain.rate)}％ → O＝${pt(S.byArm.O.overAbstain.rate)}％ → C＝${pt(S.byArm.C.overAbstain.rate)}％ → D＝${pt(S.byArm.D.overAbstain.rate)}％。A→B は ${pt(oaA.rate)}→${pt(oaB.rate)}％だが、Wilson 区間は重なる（A [${pt(oaA.low)}, ${pt(oaA.high)}]、B [${pt(oaB.low)}, ${pt(oaB.high)}]。対応のある差の区間は出していない）。出来事の IR の block を足した条件の記述で、要因（文脈の量・検索単位・quote）は分けていない。全文の arm ほどには減らない。
- **N 型 12 問（照合者が正本）**：棄権は arm 0・A・B・O が ${nVer["0"].abstained}/12、C が ${nVer.C.abstained}/${nVer.C.verified}（空の回答 1 件は judge なしで棄権）、D が ${nVer.D.abstained}/12。**照合者が作話と確定した件数は全 arm で 0**（各 arm 12 問中。Wilson 上限は n=12 で ${nW12.high.toFixed(2)}）。ただし非棄権の C・D 各 2 件のうち、**各 1 件（${nUncQ}、arm ${nUncArms}）は照合者が棄権とも作話とも判定せず uncertain を付けた未決の回答**で、judge は両方を作話とした。4 節の定義（棄権でなければ作話）では C・D の作話に入る余地があり、『作話 0』は照合者が確定した範囲の値。もう各 1 件は **${V.nType.questionsVerifierRecordedAnswerableInManuscript.join("・")}**（照合者が 6 arm すべてで『原稿から答えられる』と記録。**N の Gold のラベル誤りの疑い**で、人は N を確かめていない）。
- 型別（点数％、B−A は pt。Sonnet）。M は根拠 Scene 3 以上、T は順序、U は更新。区間は広い。

| 型 | 質問数 | A | B | B−A [区間] | O | C |
|---|---|---|---|---|---|---|
${typeRows.join("\n")}

R・U で差が大きく、K は差が負で区間が 0 をまたぐ（Sonnet。Haiku は上の表のとおり U が小さく K の符号が逆で、型別の傾向は Sonnet だけの観察）。T と U は O の並びが手がかりになる分が O−A に混ざる（5 節の注記）。

## 正式な試験の規模の見積り（1.3）【推測】

方法と前提は \`sizing.json\`（\`scripts/sizing.mjs\`）。観測した不一致率と cluster の相関を入れた計算で、**正式な試験が pilot と同じ設計・同じ judge であること**を仮定する。両側 α 0.05、検出力 0.8。

- 入力：B−A の質問ごとの差の平均 ${sg(ov.meanDiff)} pt、質問ごとの差の SD ${pt(ov.sdDiff)} pt。項目の A・B の対応は、両方再現 ${ov.itemTable.bothReproduced}・A だけ ${ov.itemTable.aOnly}・B だけ ${ov.itemTable.bOnly}・どちらも不再現 ${ov.itemTable.neither}（${ov.items} 項目）で**不一致率 ${pt(ov.discordanceRate)}％**、ほぼ B だけの片方向。cell（作品×地点）の相関は ICC ${ov.varianceComponents.icc}（cell 間の分散 ${ov.varianceComponents.sigmaC2}、質問の分散 ${ov.varianceComponents.sigmaE2}。cell 4 件からの積率法）。
- **cluster を無視した下限**：差 10 pt を検出するのに ${sizeNo[0.1]} 問（項目の不一致率からは ${sizeMc[0.1]} 問相当）、5 pt に ${sizeNo[0.05]} 問（${sizeMc[0.05]}）、3 pt に ${sizeNo[0.03]} 問（${sizeMc[0.03]}）。
- **cell を cluster にした場合**（作品数 = cell 数 ÷ 2、各作品 2 地点が独立という楽観的な前提）：10 pt に cell ${rc(rcell, 0.1, 80).cells}〜${rc(rcell, 0.1, 20).cells}（作品 ${rc(rcell, 0.1, 80).works}〜${rc(rcell, 0.1, 20).works}、cell あたり 80〜20 問、計 ${rc(rcell, 0.1, 20).totalQuestions}〜${rc(rcell, 0.1, 80).totalQuestions} 問）。5 pt に cell ${rc(rcell, 0.05, 80).cells}〜${rc(rcell, 0.05, 20).cells}（作品 ${rc(rcell, 0.05, 80).works}〜${rc(rcell, 0.05, 20).works}、計 ${rc(rcell, 0.05, 20).totalQuestions}〜${rc(rcell, 0.05, 80).totalQuestions} 問）。3 pt には cell ${rc(rcell, 0.03, 80).cells}〜${rc(rcell, 0.03, 20).cells}。cell 間の分散が 2 倍なら 10 pt に cell ${rc(rcell2, 0.1, 40).cells}、5 pt に ${rc(rcell2, 0.05, 40).cells}（cell あたり 40 問）。cluster の分散が 0 なら 10 pt に cell ${rc(rcell0, 0.1, 40).cells}、5 pt に ${rc(rcell0, 0.05, 40).cells}。
- **質問を増やしても残る下限**：cluster の分散だけで、cell 4 なら ±${floor[0].mde}、8 なら ±${floor[1].mde}、16 なら ±${floor[2].mde}、32 なら ±${floor[3].mde}。pilot の 4 cell×約 17 問の検出できる最小の差は約 ${pt(mde20.mde, 0)} pt。**要点は質問数より作品・地点数**。
- **作品を cluster にした入れ子**（作品 2 件の差からの 1 自由度の見積りで、信頼できない）：10 pt に作品 ${rw.find((r) => r.delta === 0.1 && r.questionsPerCell === 80).works}〜${rw.find((r) => r.delta === 0.1 && r.questionsPerCell === 20).works}（各 2 地点）、5 pt には作品 ${rw.find((r) => r.delta === 0.05 && r.questionsPerCell === 80).works}〜${rw.find((r) => r.delta === 0.05 && r.questionsPerCell === 20).works}。作品間の差（g-ja-1 と m-ja-2）が大きいため、作品数が支配的。
- **pilot の区間の読み方**：上の区間は cell を固定した層別 bootstrap。4 cell の平均として t 区間を取ると ${sg(ov.cellTInterval.meanOfCellMeans)} pt [${sg(ov.cellTInterval.low)}, ${sg(ov.cellTInterval.high)}]（df 3）と 0 を含む。「差あり」とも「差なし」とも言えず、規模の材料として使う。B−A は質問つき seed の上限寄りの見積りなので、製品の経路の差はこれより小さい可能性が高く、その場合の必要数は増える。

## 限界（10 節のうち結果に効くもの）

- **照合**：盲検を仕組みで守れない（文体・長さ・相対的な位置表現から arm を推測しうる）。Claude Code の system と tool が固定されない。原稿を読み切れない見落としが残る。judge と同系列（限界 18・19）。
- **較正**：判定者 1 人・${C.total} 件・arm あたり 6〜7 件、unsure ${C.verdictCounts.unsure}。arm 0 は情報が少ない。arm 間の差への影響は見ていない。
- **自己選好**：抽出・IR・回答・Gold・judge・照合がすべて Anthropic 系列。IR の効果を過大に見せうる（限界 6）。
- **B−A の読み方に直結する限界**：（限界 2）B−A は文脈の量・検索単位と index・quote・要約文を同時に足し、分離していない。（限界 3）IR は全件承認済みで、却下・編集の無い最大条件。（限界 4）**文脈が製品の標準より薄い**（synopsis・codex・plot thread が空。A は story_so_far なしの下限）ので、**IR の増分が過大に見えうる**。（限界 5）m-ja-2 は model が記憶で答えうる。arm 0 の検出力は低く（上）、作品別を併記する。（限界 11）g-ja-1 は 11 Scene の IR が欠け、IR が答えられない質問が構造的にある（根拠 Scene の IR の有無で層別）。（限界 13）C・D は長文脈そのものと位置（p より前に限った効果）の交絡があり、C−A ${sg(exC("sonnet", "C-A").mean)} などは arm だけでは分けられない。
- **IR は評価側が質問で選んだもの**（限界 16）：製品の経路との 8 件の重なりは平均 4.2／8、根拠 Scene の IR への収まりは 46％対 20％。B−A は上限寄り。IR は Chronicle の出来事だけ（限界 1）、描画は評価専用（限界 3）。
- **Scene の題が製品と違う**（本測定の後にユーザーの指摘で足した。事前登録の 10 節に無い）：評価の DB の写しでは、後の内容と位置の手がかりを除くため、Scene の題を中立のラベル（2 文字の片仮名。順位との相関は g-ja-1 0.04、m-ja-2 0.00。\`relabel-record.json\`）に置き換えた。回答はこのラベルで Scene を指すことがある。製品では本来の題が出るので、題が順序や内容を示す作品では、T（順序）などの質問が製品より答えにくい側に出うる。
- **回答の条件が製品の既定と違う**（限界 24）：effort は製品の chat が medium、pilot の Sonnet は high。定型句あり、history なし。棄権の絶対値は製品と違う（限界 9）。
- **judge**：根拠の段落だけを見る。誤りの flag は照合者と合わない（上記）。誤受理の測定は楽観的（限界 17・22・23）。本測定の judge の反復は未実施。
- **Gold**：人が確かめたのは答えのある 67 問のうち 30 問（誤り 1/30）。残りの 37 問と N の 12 問は未確認で、N の 1 問に誤りの疑い。M・U・K の網羅は見ていない（限界 7・20）。
- **規模**：cluster は 4、作品は 2。区間は広い（限界 8）。事実 QA は執筆支援の proxy（限界 14）。

## 費用（上限 ${usd(SP.capUsd)}）

台帳（\`spend.json\`）の合計 **${usd(SP.totalUsd)}**、残り ${usd(SP.remainingUsd)}。事前登録の見込みは中央 ${usd(SP.estimateFromPreregistrationUsd.central)}、最悪 ${usd(SP.estimateFromPreregistrationUsd.worst)}。全 stage が段の上限の内側。本測定の Sonnet は ${usd(sonnetTotals.usd)}（${sonnetTotals.lines} request、台帳の行）。gold 段は旧台帳の cache 読みの計上のため実費より約 $1.33 多い（6.2.1）。

| stage | 計 | 累計 | 段の上限 |
|---|---|---|---|
${stageRows.join("\n")}

## ファイル

\`summary-sonnet.json\`・\`summary-haiku.json\`（集計の写し）、\`verification.json\`、\`calibration.json\`、\`spend.json\`、\`sizing.json\`、\`work-breakdown.json\`、\`supplement.json\`（丸める前の差・照合の内訳・hit 別・Haiku の judge の失敗の内訳。\`scripts/supplement.mjs\`）、\`build-checks.json\`（${R("build-checks.json").checks.length} 件の突合）、\`scripts/\`（\`build-results.mjs <data> <out>\`、\`render-readme.mjs <out>\`、\`scripts/*.mjs\`）、\`SHA256SUMS\`（results/ のファイルと、data の answers.jsonl・judge.v3.jsonl・results.jsonl・calibration-judgments.json ほか）。data は repo の外（\`fusion-eval-data/ir-chat-pilot-2026-11/\`）。
`;
fs.writeFileSync(path.join(dir, "README.md"), md);
console.log("README.md:", md.split("\n").length, "lines");
