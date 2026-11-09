# S7 報告（草稿）：CP-4 の Graph arm の評価（S4b 63bc9b90・候補 `a2309b95`・K6/5）

2026-11-07（JST）の integrator の報告の草稿。測定の記録は同じ `nir1-cp4-records/` の `sp-p4-s6r1-1/`、`traces-s6r1-1/`、`parity-s6r1-1/`、`gold-s6r1-1/`、`negatives-s6r1-1/`、`g01-e2e-s6r1-1/`、`attempts-final-s6r1/`、`setups-s6r1/`、実施記録は `s6r1-run-record.md`、集計は `s6-aggregation-s6r1/`、品質の判定（補助）は `quality-verdict-s6r1-1/`。前回の報告は `s7-report-s5r6/`（S4b''''・候補 `cbf33077`・K6/4。規則は HOLD を指さなかった）。ユーザーの決定は `user-confirmation-2026-11-07-s6r1-hold-k66.md`（`1e6ede44`）。数値は断りのない限り `s6-aggregation-s6r1/s6-aggregation.json` と受領書から写した。

## 1. 結論

**事前登録の規則を当てた結果は HOLD（Gold の定常状態の pool で、欠落 163／270。許容は 2 件）。CP-4 の Graph arm の可用性を満たしたとは主張しない。** 原因は、製品が Graph を出せなくなったこと（退行）ではなく、K6/4 の R1（各 sample の前に slot を `empty` にする）の下では定常状態の first-render が構造的に数えられない、という契約の規定の食い違いである。K6/5 が D を 10.84 → 40 ms に広げたことで、親が窓内に Graph を受ける sample が出るようになり、食い違いが初めて表に出た。欠落 163 件はすべて、Graph の結果が D＝40 ms の窓内に合流した親（`graph-ready`、`joined`、返却時の再検証 passed、出所 worker）で、`startSlot.readyFresh` が false のために harness が first-render に数えなかったもの。この読み（(甲)）と、K6/5 の変える点 5・K6/5-P1 の読み（(乙)）は、契約の文面だけでは決まらない。ユーザーは 2026-11-07 に、受領書を読み直して合格にせず、s6r1 は HOLD と記録して新しい版（K6/6）を起案すると決めた。

| 指標（K6/4 の読み。候補は 3 つの要件を満たす） | 前回（S4b''''・`cbf33077`・K6/4） | 今回（S4b・`a2309b95`・K6/5） | 物差し |
|---|---|---|---|
| D／Hybrid p95 の上限／B | 10.84 ms／65.04 ms／54.2 ms | **40 ms／94.2 ms／54.2 ms** | K6/5 で変更（R-1〜R-5） |
| (a) Gold の pool の欠落 | 0／270（表示 270、first-render 0、follow-up 270） | **163／270（表示 107、first-render 0、follow-up 107）** | 2 件（floor(0.01×270)）。**超える** |
| 表示 0／30 の variant（K6/4:167） | 0 | **5**（G-01/v1、G-03/base、G-06/base、G-08/base-usable、G-08/graph-recovered） | HOLD（独立に当たる） |
| (b) 編集 trace の失効 | 0／201 | 1／201（0.50%。`i-b-seal`） | 1%（内側） |
| (b) 編集 trace の窓外（表示の欠落） | 1／201（U 内 1） | 1／201（U 内 1。失効と同じ query） | 2 件（内側） |
| (b) 閲覧 trace の失効／欠落 | 0／0 | 0／0 | — |
| ④ SP-P4 | passed（IR の期限切れ 2／上限 6） | passed（差異 0。IR の期限切れ 0） | — |
| parity | 12 variant valid | 12 variant valid | — |
| 診断の負例 N2／N3／N4（判定に数えない） | すべて measured・established | すべて measured・established | — |
| **規則が指す先** | HOLD に当たらない | **HOLD に当たる（(a) の欠落）** | — |

## 2. 測ったもの（S4b `63bc9b903d5b7dbba3533ea32da9bdd7fe649861`、候補 `a2309b953873063b97b58942d42fa34d1bfbfc95`、attempt 1、台帳 completed）

| run | 種類 | 時間（UTC。台帳） |
|---|---|---|
| `sp-p4-s6r1-1` | ④ SP-P4 | 11:11〜11:13（約 2 分） |
| `trace-editing-s6r1-1` | ⑤ trace（編集） | 11:14〜11:25（約 11 分） |
| `trace-browsing-s6r1-1` | ⑤ trace（閲覧） | 11:25〜11:29（約 4 分） |
| `parity-s6r1-1` | ⑤ parity | 11:30〜11:38（約 7 分） |
| `gold-s6r1-1` | ⑤ Gold（13 variant） | 11:39〜12:19（約 41 分） |
| `neg-n2／n3／n4-s6r1-1` | ⑤ 診断の負例 | 12:20〜12:28（各約 2.3 分） |
| `g01-e2e-s6r1-1` | G-01 の e2e 診断（判定に数えない。別 session） | 12:28〜12:29（約 1 分） |

準備（標準 build、評価 build、13 setup）は 10:16 から。各 run の前に静けさを確認した（`s6r1-run-record.md`）。契約は K6/5（凍結 `07fc80ec`、SHA-256 `1ad10884…24a7`）と K6/4（`5dea38af`）。台帳の 8 件はすべて `(63bc9b90…, a2309b95…)`、受領書 31 件はすべて K6/5 の束縛に一致（script が確認）。

## 3. 言えること、言えないこと

**言えること**

- D＝40 ms の下で、親が first-render の窓内に Graph を受ける sample が増えた。Gold の定常状態の pool では 0 → 163／270（60.4%）、trace では editing 0 → 32／201、browsing 0 → 2／201。163 件はすべて `graph-ready`・合流済み・返却時の再検証 passed で、Graph は窓内に届いている。
- 欠落 163 件の原因は、harness の `steadyStateInWindow`（`join.mjs:113-120`）が `readyFresh === true` と stamp の一致を要るのに、R1 の下では `readyFresh` が構造的に false になること（`nir1_graph_eval/mod.rs:446-453`）。Gold の Graph arm の measured は s6r1・s5r6 とも `startSlot.kind` が `empty`・`readyFresh` が false（G-08/graph-index-unusable の 23 件だけ `suspended`）、`notReadyAtStart` は 13 variant すべて 30／30。(甲) の下では D の値に関わらず Gold の first-render は数えられない。D＝10.84 ms では親が常に graph-late で follow-up が出たので表に出なかった。
- (乙) で数えた場合、欠落が 0 になるのは準備の句（`readyFresh`）と鮮度の印の句（stamp 一致）の両方を外した場合だけ。鮮度の印の句を残すと first-render は stamp が `fresh` の 2 件だけで、欠落は 161 件。stamp は 327／330 件が `stamp0-missing`（製品の状態。非 blocking の読取が None を返す）。
- Hybrid p95 は R+IR arm 22.00 ms、Graph arm 60.20 ms（各 n＝390）で、上限 94.2 ms の内側（品質の判定の条件 3。pass）。
- trace：editing の失効は 1／201（0.50%）、表示の欠落は 1／201 で、どちらも物差しの内側。browsing は失効 0・欠落 0。`T_late`（100 ms）は両 trace で超過 0。SP-P4 passed、parity 12 variant valid、負例 N2・N3・N4 は measured・established、G-01 の診断は `reachedEndToEnd: true`。
- 受領書の範囲では、製品が Graph を出せなくなった形跡は無い。欠落 163 件を (乙) で数えた場合の数字は、`s6-aggregation.json` の `ssc.missedBreakdownDisclosure` にある（開示用で、判定に使わない）。

**言えないこと**

- **表示の可用性が上がったか下がったかは、この run では言えない**。Gold の定常状態は、(甲) では欠落 163 で下がった形、(乙) の両句を外す読みでは 0 で前回と同じ、鮮度の印の句を残す (乙) では 161 で下がった形。契約の読みで答えが変わるので、s6r1 からは決められない。trace は表示 200／201（editing）・201／201（browsing）で、前回と同じ水準だが、trace の first-render は `join.inWindow`・出所 worker・snapshot usable で決まり、Gold の条件（`readyFresh`・stamp）を使わない。両者の読みの違いは trace では表に出ない。
- 製品の退行が無いこと。上は受領書の範囲の形跡で、証明ではない。
- 品質（Recall・nDCG）の改善・非回帰。表示のあった sample だけを品質に数える規則（事前登録 §3）のため、表示 0／30 の 5 variant は計算されず、条件 1・2 と条件 4 の edge の束縛は hold。G-02/base は 24／30、G-05/base は 23／30 表示。
- D＝40 ms の効果の機構。Graph が窓内に合流する割合が増えたことは言えるが、なぜ 40 ms で足りたか（IR の窓、製品の合流）は確かめていない。
- editing の失効 1 件の原因（trace の最初の query で Graph の registration が使えなかった）は未確認。C7 の効果（Chronicle の停止を失効に数える）は、外した begin が 0 件だったので今回の run では観測されていない。

## 4. 前回（s5r6）との比較

前回の値は `s6-aggregation-s5r6/`、`quality-verdict-s5r6-1/` から、今回の値は `s6-aggregation-s6r1/`、`quality-verdict-s6r1-1/` から写した。

| 指標 | 前回（s5r6） | 今回（s6r1） |
|---|---|---|
| editing の first-render／follow-up | 0／200 | 32／168 |
| browsing の first-render／follow-up | 0／201 | 2／199 |
| `i-chronicle-stop`（editing／browsing） | 記録の欄なし（C7 前） | 0／0（C7 の外した begin 0） |
| K6/2 の読みの窓外（editing／browsing） | 201／201 | 169／199（K6/4 の読みへの再計算の理由は S6 README 5 の 3） |
| q1 の max（editing／browsing） | 135.3／89.5 ms | 56.9／98.6 ms（`T_late` 100 ms。browsing は余裕 1.4 ms） |
| 品質の判定（補助）の p95（R+IR arm／Graph arm） | 55.30／31.50 ms（上限 65.04） | 22.00／60.20 ms（上限 94.2。pass） |
| 品質の判定（補助）の全体 | hold（unverified-required-items） | hold（failed-required-items、held-required-items） |

- 前回と今回で、Gold の Graph arm の `readyFresh`（false）・`notReadyAtStart`（30／30）・stamp（大半が `stamp0-missing`）は同じ状態だった。違いは、親の Graph が graph-late（窓の後に届く）だったか graph-ready（窓内に合流）だったかだけ（D の 10.84 → 40 ms の効果と読めるが、機構は確かめていない）。
- 品質の判定の条件 5 の (a) の fail（G-08/chronicle-index-unusable）：前回も `index-ready` の再 query の子は 30／30 で出ていたが、子の Graph は graph-late（edge 無し）だった。今回は子の Graph が子の Raw-ready の 27.9〜33.8 ms 後に合流した（edge は `g08-r-juno|g08-rents-to-juno`）。旧 D（10.84 ms）は超え新 D（40 ms）の内側なので、D＝40 ms の効果と読むのが数値上は強い推測。表示された一覧は R+IR と同じで、禁止 Scene・blocked 候補への寄与は 0。違反は事前登録 §3 の「Graph が表示された」規則による（`quality-verdict-s6r1-1/README.md`）。

## 5. ユーザーに決めてほしいこと（残り）

決定済み：s6r1 は HOLD と記録し、K6/6 を起案する。品質判定は次の版で契約の「子」の定義にそろえる（今回の fail は開示して残す）。s6r1 の受領書は K6/6 の判定に使わない（`user-confirmation-2026-11-07-s6r1-hold-k66.md`）。残りは起案と独立レビューの後に確認を求める。

1. **K6/6 の鮮度の印の句の扱い**（K6/6 の起案で選択肢として示す。起案者は選ばない）：準備の句と鮮度の印の句の両方を外す、準備の句だけを外す（欠落は 161 で HOLD のまま）、どちらも残す、など。鮮度の印の句を外すことは緩和に当たりうる。D・Hybrid p95 の上限・`T_late`・W_f・T_show・1%・失効の読みは変えない。
2. **R1 の下で起きる sample への試験と検出力の記録の取り直し**：K6/5-P1 の合成の試験と検出力の記録が R1 の下で起きない fixture を使っていた（6 の 2）。S2 追補・S3 の再レビュー・S4 の 7 回目で、R1 の下の sample（`readyFresh: false`、stamp `stamp0-missing`）を含めて取り直すか。
3. **品質判定の事前登録の新版**：`index-ready` の再 query を chronicle-index-unusable の判定から外し、その再 query に禁止寄与が混ざらないことを別に検査する（決定済みの方針の具体化の確認）。

## 6. 開示（必須）

1. **K6/5 の下の 1 回目の正式の測定**。D・Hybrid p95 の上限の緩和（R-1〜R-5）を含む契約の下で測った。K6/5 の値の選択の前に s5r6 の p95 を見ていたこと、凍結の前の dev の観測 5 つ、C7 と LAPSE-2 の例外、R5 の記録の再利用は S2 `k65Readings` に開示済み（S6 README 5 の 6）。各 run は attempt 1 で、取り直していない。1 回の測定なので、同じ候補での再現性は測っていない。
2. **欠落 163 件の読み**。契約の文面だけでは決まらない（規定の欠落・矛盾）。(甲) harness の記録どおり：K6/2 :695 の最終文（「開始時に READY でなかった sample や、鮮度の stamp が一致しなかった sample も、分母から除かず窓外に数える」）、K6/4 :52・:299、DR-CP4-S1C1-8（`cp4-decisions.md:231`）。(乙) 窓内に合流した親は数える：K6/5 の変える点 5（K6/5 draft :92）と K6/5-P1（:121）。「新しい READY」は K6/4 の変える点 4（:98）で R1（:192）に置き換わっており、K6/5 は変えていない（S6 README 2 の 1、5 の 1）。K6/4 は R1 の下で `steadyStateInWindow` が全 sample 窓外になることを記録していた（K6/4 draft :127、`cp4-decisions.md:468`）。
3. **試験と検出力の記録が R1 の下で起きない sample を使っていた**。K6/5-P1 の合成の試験（`followup.test.mjs:132-147`）と、検出力の記録（contracts `3675c50e`〔枝 `claude/k65-harness`〕の `k64-k65-synthetic-detection-record.md:111`）は、`test-support.mjs:73-74` の fixture（`readyFresh: true`、stamp 一致）を使った。S2 の `k65Readings`、追補 #14・#15、S3 の再レビューには、first-render・`readyFresh`・K6/4-P2 への言及が無い。凍結前の dev の予行は trace の run 3 回で、Gold の定常状態を D＝40 ms で見ていない。食い違いは正式の run の後に初めて表に出た。
4. **trace の読み**。受領書（K6/2 の読み）は窓外 editing 169／201、browsing 199／201（物差しを超える）と記録する。これは Graph の答えが first-render の窓の後に着く設計（graph-late）による K6/2 の読みの性質で、前回も同じ型。K6/4 の読みへの再計算は前回と同じ integrator の技術判断。**再計算は keep test の証拠に依り、JSON に写した証拠だけからは regime が k62（`ratification5-not-collected`）になって再現できない**。独立検査（Opus）は keep test を再実行していない（S6 README 5 の 10）。
5. **editing の失効 1 件**：`nir1-cp4-trace-editing/1#0`（trace の最初の query）。`graph-unavailable`・`registration-unavailable`（`i-b-seal`）。原因は未確認。失効率 0.4975%（物差し 1% の内側）。
6. **setup の 2 回の再実行**：G-05/base の setup が、同じ session の別 lane（chat の IR の pilot の抽出）の Xvfb の起動・終了で 2 回 `setup-with-problems` になり、3 回目で complete した（測定の窓の前。失敗 2 回の receipt は contracts に入っていない）。測定の窓の間、他の build・試験・Electron は走らせていない。
7. **G-01 の診断は判定外**（`countsInCaseJudgement: false`、別 session。合格基準は到達の有無だけ）。`reachedEndToEnd: true`、`firstMissing: null`。
8. **品質の判定は補助**で、S6 の規則（HOLD に当たるか）を置き換えない。条件 5 の (a) の fail は事前登録 §3 の「Graph が表示された」規則による違反の数（30 sample）で、禁止 Scene・blocked 候補への寄与は 0。判定の「子」は `index-ready` の再 query を含み、K6/4 :52 の定義（`graph-ready` で出す 1 回の再 query）と違う。次の版でそろえる（ユーザーの決定）。Graph arm の p95 が旧上限 65.04 ms の内側でもあることは開示に留め、/4 の行では判定しない（K6/5 draft :78）。p95 を判定する関数の bytes は S2 が束縛しない（S2 `k65Readings.limits (a)`）。
9. **S6 の script の直し**：開示欄の `failedStage` が全件 null になる誤り（存在しない field `c.failure?.stage`）を直して再実行した。変わったのは開示欄の 2 行だけで、判定は変わらない（S6 README 5 の 11）。
10. 窓の sampler：Gold・parity・negative は全件 clean（違反 0、隙間 0）。SP-P4 と trace は sampler の記録を持たない（設計）。
11. dev の診断 run・dev の予告・dev の確認は CP-4 の結果に数えていない。
12. この報告は製品の公開（Graph の published 化）を何も決めない。`PRODUCT_GRAPH_PUBLISHED` は false のまま。

## 7. 次

1. **K6/6 の起案**（`nir1-final-request-eval-proposal/6` の `graph-eval-procedure`）。範囲は、定常状態の first-render の数え方（準備の句・鮮度の印の句・G-08 の取り直しの扱いと、K6/5-P1 との関係）と、それに伴って直す箇所だけ。鮮度の印の句の扱いは選択肢として示す。
2. 独立レビュー → ユーザーの確認 → 凍結。
3. harness の直し：S2 追補、S3 の独立レビュー、S4 の 7 回目の凍結（R1 の下の sample を含む試験と検出力の記録の取り直しを含む）。
4. 取り直しの正式 run（K6/6 の凍結の後に始めたものだけを判定に使う。s6r1 の受領書は使わない）。
5. 品質判定の事前登録の新版（`index-ready` の再 query を chronicle-index-unusable の判定から外し、禁止寄与 0 を別に検査する）。
