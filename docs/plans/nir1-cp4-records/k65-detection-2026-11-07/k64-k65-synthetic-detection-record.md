# K6/4 の分類器の Negative（K6/4-N1〜N40）、K6/5 の Negative・Positive（K6/5-N1〜N4、K6/5-P1）、C7 の合成の記録による検出力の記録（6 回目の S4 の取り直し。2026-11-07）

K6/4「受入れ」（K6/4:209）と K6/5「確認までの手順」（K6/5:115–127）の「CP-4 の分類器と品質の判定は、合成の記録（実 run の記録を複製し、通知、counter、begin の記録、子の outcome、時刻を書き換えたもの）で Negative と Positive を期待どおりに分けることを、観測の前に示して記録する」に対する記録。K6/5 の受入れは、K6/4 の Negative に K6/5-N1〜N4、K6/5-P1 を足し、C7（DR-CP4-C7）の例も含める（S3 の 8 回目の M2）。**Graph の実行出力を一つも見ずに**（runtime を起動しない node の試験と、読込み時の置換だけで）取った。

- 実行日：2026-11-07T08:55:20.222Z（UTC。JST 17:55 ごろ）。K6/5 の凍結 `07fc80ec` の後、S4b の前、正式の run の前。取り直しの理由：K6/5 の確認までの手順（K6/5 の変える点と受入れ）と、DR-CP4-S4-9 (7)・S3 の M2。
- 候補：`1d58a1eb733e2b1ebb7b0d255dc8aaf7f7fcbd87`（tree `74967f87c45ec5f2db929d00d969ade3640c8006`。枝 `claude/k65-harness`〔PR #827〕の、S3 の反映、手順のファイル v2 の review、contracts の merge commit での取り込み、bytes の pin の取り直し、C7 の試験（irStatus の variant）の追加の後の commit）。detach の worktree `claude-k65-detect`（全体の TAP）と `claude-k65-detect2`（K6/5・C7 の変異）。どちらも実行の前と後に `git status --porcelain` が空で HEAD が上の値（`results-k65-1d58a1eb.json` と `results-spn-1d58a1eb.json` の `verdict.clean`）。node：v22.23.3。
- 全体の command：`node --test --test-reporter=tap scripts/quality/nir1-graph-eval/*.test.mjs`（SP-N の記録の `baselineAll` と同じ run）。結果：**656 件、pass 656、fail 0、cancelled 0、skipped 0、todo 0**。TAP の sha256 `137c27b57b0fa097e38c9d33ac5a8d6a54b49a33e70f34822e6e886e37f86df9`。（前の版〔contracts の `k64-synthetic-detection-record.md`。候補 `cbf33077`〕は 611 件、TAP の sha256 `fecb5fd2ca39f934932707c8304ef27d34f327d6bc42457d98f2345b2a758d63`。）
- N の数え方：`tools/count-n.mjs` が TAP の題の「K6/4-」「K6/5-」「DR-CP4-C7」の記号の部分（「:」「）」の手前まで）に N<番号> を持つ試験を数える（出力は `counts-1d58a1eb.json`。sha256 `4b3e2022a47c6572467fce662c78cd71364c1908658ff2005782db83d5684907`）。前の版は「題に現れる」としか書かず、題の先頭だけを見ていた可能性がある：前の版との差は N29 と N32 が 1 → 2 で、題「K6/4-N1／N29／N32: 遅れた結果の混入は pool の判定と別に FAIL」（N1、N29、N32 を併記した 1 件）をこの数え方が 3 つに数えるため（N1 は前の版も 2 件）。**ほかの N の件数と file は前の版の表と同じ**（N1〜N40 のすべてが 1 件以上で pass）。
- 規則の file（`followup.mjs`、`outcome.mjs`、`availability.mjs`、`window.mjs`、`receipt.mjs`、`join.mjs`、`trace-record.mjs`、`admission.mjs`、`procedure-file.mjs`、`constants.mjs`、`quality-verdict.mjs`、`k64-record.mjs`）は、前の候補 `cbf33077` から `followup.mjs`、`receipt.mjs`、`admission.mjs`、`constants.mjs`、`procedure-file.mjs`、`quality-verdict.mjs`、`trace-record.mjs` が変わった（`git diff --name-only cbf33077 1d58a1eb -- <12 file>`）。前の記録は K6/5 の受入れ（N1〜N4、P1、C7）を持たず、この候補では無効で、取り直した。

## K6/4-N1〜N40 と K6/5 と C7 の試験（題に N を持つ試験の件数）

K6/4-N1〜N40 のすべてと、K6/5-N1〜N4、K6/5-P1、C7 が、少なくとも 1 件の合成の記録の試験の題に現れ、すべて pass。`件` はその番号を題に持つ試験の数。

| 番号 | 試験 file | 件 | 結果 |
|---|---|---|---|
| K6/4-N1 | followup.test.mjs | 2 | pass |
| K6/4-N2 | followup.test.mjs | 1 | pass |
| K6/4-N3 | followup.test.mjs | 1 | pass |
| K6/4-N4 | followup.test.mjs | 1 | pass |
| K6/4-N5 | followup.test.mjs | 1 | pass |
| K6/4-N6 | followup.test.mjs | 1 | pass |
| K6/4-N7 | followup.test.mjs | 1 | pass |
| K6/4-N8 | followup.test.mjs | 1 | pass |
| K6/4-N9 | followup.test.mjs | 1 | pass |
| K6/4-N10 | followup.test.mjs | 1 | pass |
| K6/4-N11 | followup.test.mjs | 1 | pass |
| K6/4-N12 | followup.test.mjs, outcome.test.mjs | 2 | pass |
| K6/4-N13 | outcome.test.mjs | 1 | pass |
| K6/4-N14 | followup.test.mjs, outcome.test.mjs | 2 | pass |
| K6/4-N15 | followup.test.mjs | 1 | pass |
| K6/4-N16 | followup.test.mjs, receipt.test.mjs | 2 | pass |
| K6/4-N17 | receipt.test.mjs | 1 | pass |
| K6/4-N18 | receipt.test.mjs | 1 | pass |
| K6/4-N19 | followup.test.mjs | 1 | pass |
| K6/4-N20 | followup.test.mjs | 1 | pass |
| K6/4-N21 | receipt.test.mjs | 1 | pass |
| K6/4-N22 | followup.test.mjs | 1 | pass |
| K6/4-N23 | followup.test.mjs | 1 | pass |
| K6/4-N24 | followup.test.mjs | 1 | pass |
| K6/4-N25 | followup.test.mjs | 1 | pass |
| K6/4-N26 | followup.test.mjs | 1 | pass |
| K6/4-N27 | followup.test.mjs | 1 | pass |
| K6/4-N28 | followup.test.mjs | 1 | pass |
| K6/4-N29 | followup.test.mjs | 2 | pass |
| K6/4-N30 | followup.test.mjs | 1 | pass |
| K6/4-N31 | followup.test.mjs, receipt.test.mjs | 2 | pass |
| K6/4-N32 | followup.test.mjs | 2 | pass |
| K6/4-N33 | followup.test.mjs | 1 | pass |
| K6/4-N34 | followup.test.mjs | 1 | pass |
| K6/4-N35 | followup.test.mjs | 1 | pass |
| K6/4-N36 | followup.test.mjs | 1 | pass |
| K6/4-N37 | followup.test.mjs | 1 | pass |
| K6/4-N38 | followup.test.mjs | 1 | pass |
| K6/4-N39 | followup.test.mjs | 1 | pass |
| K6/4-N40 | followup.test.mjs | 1 | pass |
| K6/5-N1 | receipt.test.mjs | 1 | pass |
| K6/5-N2 | admission.test.mjs | 3 | pass |
| K6/5-N3 | admission.test.mjs, receipt.test.mjs | 3 | pass |
| K6/5-N4 | quality-verdict.test.mjs, receipt.test.mjs | 2 | pass |
| K6/5-P1 | followup.test.mjs | 1 | pass |
| DR-CP4-C7 | trace-record.test.mjs | 7 | pass |

### K6/5 と C7 の試験の題（上の表の根拠）

- K6/5-N1・N4: settings.k64 の D・B・Hybrid p95 の上限が契約（40・54.2・94.2 ms）と違う receipt は、receipt の層で拒む（手順のファイルの loader は契約と違う値の file を読まないので、記録の値そのものを契約と照合する）
- K6/5-N2（変える点 6）: 候補の製品の D が 40 ms でない（#802 が祖先に無い、定数が 40 でない・読めない）候補は run の前に [precheck]
- K6/5-N2・N3: admitGraphCaseRun は /5 の凍結の head（commit と bytes）と製品の D=40 ms を、封印の前に実際の関数で強制する
- K6/5-N2・N3: assertReceiptHeadBound は head.k65（commit と bytes）を凍結と照合し、ratification5 を必須にして D=40 ms を強制する
- K6/5-N3: 正式の Graph の receipt の先頭は /5 の凍結（commit と SHA-256）を持ち、無い・違う receipt は拒む
- K6/5-N4（条件 3）: Hybrid p95 の判定の境界は 94.2 ms で、65.04 ms と 240 ms ではない。arm ごとに pool し、どちらかに failed があれば fail
- K6/5-P1: D=40 ms の窓内（Raw-ready の後 10.84 ms を超え 40 ms 以内）に親が Graph を受けた sample は first-render の窓内で、子は出ない
- DR-CP4-C7: 外す条件を満たす begin は対応から外し、親は defect にせず Q と U に数えて失効 (i) の i-chronicle-stop、K6/4 では X11／X12 の欠落（窓外）。残りは今の対応のまま、開示する
- DR-CP4-C7: 外す条件を 1 つでも満たさない begin（理由が違う、querySupported が false、renderer の値が違う、indexUsable が違う）は外さず、record が無ければ従来どおり整列の失敗で trace は invalid
- DR-CP4-C7: 外した begin の数と外す条件を満たす fetch の数が違えば整列の失敗（begin の無い fetch、begin が 2 つの fetch）。数えない fetch の begin も同じ条件で外し、子は行の子の begin として外す
- DR-CP4-C7: 外した begin があるのに Native の読取の時計の範囲が求められなければ整列の失敗。外した begin が無ければ今までどおり
- DR-CP4-C7: 外した begin の record が実は在る（条件の読みが製品と違う）と、残りの組が 1 つずれて整列の失敗になる
- DR-CP4-C7: 外した親の行にも混入の検査（N1／N29／N32）を当てる。公開が 2 回以上、遅れた Graph の表示、窓の中の再 query の 2 回の公開は違反で、外すこと自体は止めない
- DR-CP4-C7: 総数が合っても内訳が違えば整列の失敗（begin が 0 の fetch と 2 の fetch）。A3 や timing が欠けた外した親は defect に戻る

## 検出力の確認（変異）

K6/5-N1〜N4、K6/5-P1、C7 のそれぞれについて、規則の実装（`admission.mjs`、`followup.mjs`、`join.mjs`、`k64-record.mjs`、`procedure-file.mjs`、`quality-verdict.mjs`、`receipt.mjs`、`trace-record.mjs`）の 1 か所を、読込み時の置換（node の module の load hook。`--import` で登録）で別の値にし、示した試験 file だけを走らせた。どの変異も置換が 1 か所だけ当たったことを確かめた（hook は当たった数が 1 でなければ読込みを失敗させ、数を記録した。23 件すべて 1）。baseline（変異なし）の対象 7 file は 203 件 pass、fail 0（TAP の sha256 `fc86011350c2b25a7fbacdc3941f72017d43ab1785b799a42eb2a2fc503096a1`）。陽性の対照（K6/5-N1〜N4、P1、C7 の題を持つ 14 件。baseline で ok であること）はすべて ok、probe（hook が試験の子 process で効くこと）も ok。

結果（`results-k65-1d58a1eb.json` の `verdict`：`allHitOnce: true`、`allAsExpected: true`、`exactCount: 23`）：23 件のうち **21 件は表に書いた試験が落ち、余分に落ちた試験も落ちなかった試験もない**。**2 件（C7-total-count、K65-N2-sample-window-null）は置換しても判定が変わらない等価の変異で、試験が落ちないことが期待**（理由は表）。

| 変異 | 対象 | 置換 | 落ちた試験 | 結果 |
|---|---|---|---|---|
| C7-indexUsable | C7 | `trace-record.mjs` の `snapshot.indexUsable === false &&` → `true &&` | `trace-record.test.mjs:2770` 「DR-CP4-C7: 外す条件を 1 つでも満たさない begin（理由が違う、…」 | 検出 |
| C7-querySupported | C7 | `trace-record.mjs` の `snapshot.querySupported === true &&` → `true &&` | `trace-record.test.mjs:2770` 「DR-CP4-C7: 外す条件を 1 つでも満たさない begin（理由が違う、…」 | 検出 |
| C7-irStatus | C7 | `trace-record.mjs` の `result.irStatus === "unavailable" &&` → `true &&` | `trace-record.test.mjs:2770` 「DR-CP4-C7: 外す条件を 1 つでも満たさない begin（理由が違う、…」 | 検出 |
| C7-irReason | C7 | `trace-record.mjs` の `result.irReason === CHRONICLE_STOP_IR_REASON &&` → `true &&` | `trace-record.test.mjs:2770` 「DR-CP4-C7: 外す条件を 1 つでも満たさない begin（理由が違う、…」 | 検出 |
| C7-graphOutcome | C7 | `trace-record.mjs` の `result.graphOutcome === CHRONICLE_STOP_GRAPH_OUTCOME` → `true` | `trace-record.test.mjs:2770` 「DR-CP4-C7: 外す条件を 1 つでも満たさない begin（理由が違う、…」 | 検出 |
| C7-total-count | C7 | `trace-record.mjs` の `stopped.length !== stoppedFetches.length \|\|` → `false \|\|` | 落ちた試験なし | 等価（生き残るのが期待）。総数の照合 stopped.length !== stoppedFetches.length は、直後の「条件を満たす fetch ごとにちょうど 1 つの begin」の照合 stoppedFetches.some(beginsOf !== 1) に含まれる。外した begin は必ず条件を満たす fetch の begin で（stopped は chronicleStopFetch を満たす owner の begin だけ）、全 fetch で beginsOf が 1 なら総数は fetch の数と等しい。したがってこの照合を外しても判定は変わらない（等価の変異。生き残るのが期待） |
| C7-per-fetch-begin | C7 | `trace-record.mjs` の `stoppedFetches.some((fetch) => beginsOf(fetch) !== 1)` → `false` | `trace-record.test.mjs:3127` 「DR-CP4-C7: 総数が合っても内訳が違えば整列の失敗（begin が 0 …」 | 検出 |
| C7-clock-range | C7 | `trace-record.mjs` の `else if (stopped.length > 0 && !reads)` → `else if (false)` | `trace-record.test.mjs:2967` 「DR-CP4-C7: 外した begin があるのに Native の読取の時計…」 | 検出 |
| C7-lapse-count | C7 | `trace-record.mjs` の `countedAs: "i-chronicle-stop",` → `countedAs: "i-other",` | `trace-record.test.mjs:2621` 「DR-CP4-C7: 外す条件を満たす begin は対応から外し、親は def…」 | 検出 |
| K65-N1-receipt-values | K6/5-N1・N4 | `receipt.mjs` の `if (value?.[key] !== expected)` → `if (false)` | `receipt.test.mjs:524` 「K6/5-N1・N4: settings.k64 の D・B・Hybrid p9…」 | 検出 |
| K65-N1-loader-values | K6/5-N1・N4 | `procedure-file.mjs` の `} else if (actual !== expected)` → `} else if (false)` | `procedure-file.test.mjs:130` 「手順のファイル: 契約の値と違う値は、広げる・狭めるを問わず拒む（変える点 16…」 | 検出 |
| K65-N1-late-graph-boundary | K6/5-N1 | `k64-record.mjs` の `lateGraphShown(view, parent, GRAPH_EVAL_D_MS)` → `lateGraphShown(view, parent, 10.84)` | `k64-record.test.mjs:292` 「R7: 親の表示に D の後の Graph が混ざれば記録に残す（N1）。see…」 | 検出 |
| K65-N2-admission-wait | K6/5-N2 | `admission.mjs` の `evidence.dForty.config.waitMs !== need.waitMs` → `false` | `admission.test.mjs:734` 「K6/5-N2（変える点 6）: 候補の製品の D が 40 ms でない（#8…」、`admission.test.mjs:800` 「K6/5 変える点 6（readDFortyEvidence）: 定数は com…」、`admission.test.mjs:940` 「K6/5-N2・N3: admitGraphCaseRun は /5 の凍結の …」、`admission.test.mjs:1016` 「K6/5-N2・N3: assertReceiptHeadBound は hea…」 | 検出 |
| K65-N2-admission-ancestor | K6/5-N2 | `admission.mjs` の `evidence.dForty.ancestor !== true` → `false` | `admission.test.mjs:734` 「K6/5-N2（変える点 6）: 候補の製品の D が 40 ms でない（#8…」、`admission.test.mjs:940` 「K6/5-N2・N3: admitGraphCaseRun は /5 の凍結の …」 | 検出 |
| K65-N2-sample-window | K6/5-N2 | `followup.mjs` の `parent.graphWindowMs !== GRAPH_EVAL_D_MS` → `false` | `followup.test.mjs:533` 「K6/4-N30: 合流の窓の値が W_f と違う、子の IR の deadli…」 | 検出 |
| K65-N2-sample-window-null | K6/5-N2 | `followup.mjs` の `parent.graphWindowMs === null \|\|` → `false \|\|` | 落ちた試験なし | 等価（生き残るのが期待）。null の窓の検査 parent.graphWindowMs === null は、次の !Number.isFinite(parent.graphWindowMs) が null で true になるので、外しても判定は変わらない（等価の変異。生き残るのが期待） |
| K65-N3-head-sha | K6/5-N3 | `receipt.mjs` の `head?.k65?.sha256 !== freeze65.sha256` → `false` | `receipt.test.mjs:329` 「K6/5-N3: 正式の Graph の receipt の先頭は /5 の凍結…」 | 検出 |
| K65-N3-head-commit | K6/5-N3 | `receipt.mjs` の `head?.k65?.freezeCommit !== freeze65.freezeCommit` → `false` | `receipt.test.mjs:329` 「K6/5-N3: 正式の Graph の receipt の先頭は /5 の凍結…」 | 検出 |
| K65-N3-head-required | K6/5-N3 | `receipt.mjs` の `if (formalGraph \|\| head?.k65 !== undefined) {` → `if (false) {` | `receipt.test.mjs:329` 「K6/5-N3: 正式の Graph の receipt の先頭は /5 の凍結…」 | 検出 |
| K65-N4-verdict-values | K6/5-N4 | `quality-verdict.mjs` の `if (values?.[key] !== expected)` → `if (false)` | `quality-verdict.test.mjs:1018` 「no threshold is written in the verdict c…」 | 検出 |
| K65-N4-p95-limit | K6/5-N4 | `quality-verdict.mjs` の `limit: values.hybridP95LimitMs,` → `limit: 65.04,` | `quality-verdict.test.mjs:420` 「K6/5-N4（条件 3）: Hybrid p95 の判定の境界は 94.2 m…」、`quality-verdict.test.mjs:474` 「condition 3 (p95): tReturn - tFetch, nea…」 | 検出 |
| K65-N4-b | K6/5-N4 | `quality-verdict.mjs` の `b: values.bMs,` → `b: 65,` | `quality-verdict.test.mjs:474` 「condition 3 (p95): tReturn - tFetch, nea…」 | 検出 |
| K65-P1-window | K6/5-P1 | `join.mjs` の `const deadline = sample.tRawReady + GRAPH_EVAL_D_MS;` → `const deadline = sample.tRawReady + 10.84;` | `followup.test.mjs:132` 「K6/5-P1: D=40 ms の窓内（Raw-ready の後 10.84 …」 | 検出 |

## 限界の開示

1. **期待の決め方**：変異ごとの「落ちるべき試験」（`tools/mutations-k65.json` の `expected`）は、変異を当てる前に決めたものではない。最初の run（`expected` が空）で落ちた試験を見て、変異と落ちた試験の題の対応を確かめた上で `expected` に写した。その run で C7-irStatus が生き残った（既存の試験は irStatus と irReason を同時に変える variant しか持たなかった）ので、`trace-record.test.mjs` の C7 の試験に variant を 2 つ足し（commit `1d58a1eb`）、候補をその commit にして取り直した。この記録の結果はその取り直しの run のもの（最初の run の結果は記録に含めない）。
2. **等価の変異 2 件**は、コードを読んで判定が変わらないと判断した（C7-total-count は直後の fetch ごとの照合に含まれる。K65-N2-sample-window-null は直後の `!Number.isFinite` が null を拒む）。判断は表の理由のとおりで、試験が落ちないことは実行で確かめたが、等価であることの証明は読みによる。
3. **K6/4-N1〜N40 の検出力**（分類の入替、判定の削除、閾値の変更などの変異）は、今回新たに当てていない。前の記録と同じく、N1〜N40 のための変異は統合 branch の各段の記録（`docs/plans/nir1-lane-decisions/cp4-decisions.md` の DR-CP4-K64-*、H-*、F-*、G-*、R-*、I-*、J-*、K-7、T14-* の変異の節）によるもので、この候補では試験が pass することだけを確かめた。今回の変異は K6/5-N1〜N4、K6/5-P1、C7 の 23 件。
4. **変異の網羅**：各 K6/5-N（と P1、C7）に 1〜9 件の置換を当てたもので、規則の全分岐を網羅しない。K6/5-N3 の 3 件は同じ試験（`receipt.test.mjs` の K6/5-N3）が落とし、N2 の admission の 2 件は `admission.test.mjs` の 4 件の一部が落とす（どの試験がどの置換を落とすかの分離は表のとおりで、N ごとの試験が 1 対 1 ではない）。
5. **品質の判定**（`quality-verdict.mjs`）は S2 の bytes の pin の外にある（`k65Readings.limits (a)`）。この記録の K6/5-N4 の変異は `quality-verdict.test.mjs` が落とすことを示すが、判定の bytes を束縛しない。
6. 製品の runtime、実 Electron、G-case の Graph の実行出力は使っていない。

## 取り直しの規則

この候補（`1d58a1eb733e2b1ebb7b0d255dc8aaf7f7fcbd87`。前の版は contracts の `cbf33077` の記録）以後に、規則の file（`followup.mjs`、`outcome.mjs`、`availability.mjs`、`window.mjs`、`receipt.mjs`、`join.mjs`、`trace-record.mjs`、`admission.mjs`、`procedure-file.mjs`、`constants.mjs`、`quality-verdict.mjs`、`k64-record.mjs`）または上の試験 file を変えた commit を S4 以後の判定に使うなら、この記録はその候補では無効で、その候補で取り直す。

## 道具と結果の sha256

`tools/run.mjs` `0f29e79b0eaadf6d6c2f826232ce0d505a2842b62cd7e9dd96d6c49a575aa897`、`tools/hook.mjs` `e5732d013845a5a5b19e5cfeaf4042ef624ae7e02ae24c34b4fbef9389682994`、`tools/register.mjs` `5f651fffc2f71745446c0e05cf12136e73f5062b1f00766b9716cd6a0383fcaf`、`tools/mutations-k65.json` `4fce6611609e41182aa485c76ee029439a86fbd1e7b1caa9e9d6e8ea85bf3d30`、`tools/positive-k65.json` `c8cf780559df2ced6e0a81a9528e551bc015816f1599821a4eaa2303fce20c79`、`tools/count-n.mjs` `79adcb04a2fc471daf215ee07874b7de19f42c8e22dcfff828ca59535e5825cc`。結果 `results-k65-1d58a1eb.json` `936731f5ad12be62f5d75f262dba3fa494987295cbbd8dfc240b74f47e8a38ea`。
