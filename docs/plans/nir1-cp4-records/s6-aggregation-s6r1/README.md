# S6 集計（S4b 6 回目・候補 `a2309b95`・K6/5）

> **訂正（2026-11-07。Opus の独立検査の指摘を受けた。ユーザーの決定 `../user-confirmation-2026-11-07-s6r1-hold-k66.md`）**。この README の初版（contracts `7eca5693`）から、次の 4 点を直した。(1) 2 の K6/5 の読みの記述（「新しい READY」の扱い）、(2) 3(a) の欠落の読みの説明（何の 30 件かの明記、表示 0 の variant が 5 つあること）、(3) 4・5 の「欠落 163 件の読み（要判断）」を、原因（R1 の下で `readyFresh` が構造的に false）の確認と、(甲)(乙) の両論、ユーザーの決定（HOLD と記録）に書き直した、(4) 5 に試験の欠落と再現性の限界を足した。受領書・台帳・閾値・規則が指す先（HOLD）は変えていない。script の開示欄の誤り（`c.failure?.stage` は存在しない field）も直した。詳細は 5 の 1・9〜11。

2026-11-07 に integrator が行った、CP-4 の ⑤ の S6 集計。入力は 6 回目の S4（S4b `63bc9b903d5b7dbba3533ea32da9bdd7fe649861`）の下、候補 `a2309b953873063b97b58942d42fa34d1bfbfc95`（PR #827 の merge commit。tree `f744618200470e14406f6d4449ae235520a749c5`）の正式の run 8 件（`sp-p4-s6r1-1`、`trace-editing-s6r1-1`、`trace-browsing-s6r1-1`、`parity-s6r1-1`、`gold-s6r1-1`、`neg-n2／n3／n4-s6r1-1`）の受領書と台帳。契約は K6/5（凍結 commit `07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f`、SHA-256 `1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7`。D＝40 ms、Hybrid p95 上限 94.2 ms、B＝54.2 ms、T_late＝100 ms。緩和 R-1〜R-5）と K6/4（`5dea38af`）。**S6 は受領書の数値に事前登録の規則を当てるだけで、閾値・期待値・Gold・Q と U の定義・pool の選び方・失効の読み・K6/5 の値は変えていない**。再現：`scripts/s6-aggregate.mjs`（集計。出力 `s6-aggregation.json`）、`scripts/recompute-trace-k64.mjs`（trace の K6/4 の読みへの再計算。出力 `trace-k64-recompute.json`）、`scripts/recompute-trace-base.mjs`（基準の再現）。前回の S6 は `../s6-aggregation-s5r6/`（S4b''''・候補 `cbf33077`・K6/4）。本文の数値は、断りのない限り `s6-aggregation.json`（script の出力）から写した。

## 1. 許可リストと集計の対象

- 台帳 `../attempts-final-s6r1/` の 8 件はすべて `(s4Commit, candidate.commit)` が `(63bc9b90…, a2309b95…)`、attempt 1、**status `completed`**（script の出力 `runs`）。許可リストはこの組だけ。集計 script は、台帳が 8 件でない、組が違う、completed でない、のどれかで `[precheck]` で止まる（前回の「組が違う台帳が 1 件でもあれば止まる」を保った）。旧 S4b''''・候補 `cbf33077` 以前の run（`*-s5r6-1` ほか）は集計に入れない。
- さらに script は 31 件の受領書（SP-P4 1、Gold 13、parity 12、negative 3、trace 2）すべてが、`head.k65`＝K6/5 の凍結 commit と SHA-256、`head.observationPrep.commit`＝`63bc9b90`、`candidate.commit`＝`a2309b95`、`preview: false` であることを確かめる（違えば `[precheck]`。出力 `bindings.allMatch: true`）。K6/4 の束縛 `5dea38af`、`d205b35f…` も同じ受領書に記録されている。
- `.artifacts/cp4`（候補の worktree。ignore 対象で、tracked file は触っていない）の受領書 31 件と台帳 8 件は、contracts の `gold-s6r1-1/` ほかの写し（commit `c62b33d1`）と byte 単位で一致した（`cmp`）。contracts の各 dir の `files.sha256` も `sha256sum -c` で全件一致。
- `selectReceiptsForAggregation` の結果：`g-case-gold` 13、`g-case-parity-unrestricted` 12、**`g-case-diagnostic-negative` 3（N2、N3、N4）**。trace の受領書 2 件は前回と同じ `runner-is-not-the-k64-hook-consumer` で除かれる（関数が受領書全体の `runnerKind` を要求するが trace は query ごとに持つため。`receipt.mjs` は S2 に pin 済みなので変えない）。
- G-01 の診断 `g01-e2e-s6r1-1` は判定に数えない（`countsInCaseJudgement: false`、別 session）。集計の入力には入れず、結果だけを 3 の (c) に載せる。

## 2. 事前登録の規則

前回（s5r6）と同じ規則に、K6/5 が足した読みを加える。K6/5 が変えたのは D（10.84→40 ms）と Hybrid p95 の上限（65.04→94.2 ms）だけで、1％・2 件の物差し、T_late、W_f、T_show、失効率の定義、Gold、pool は変えない。

- 「条件が成立しない場合の CP-4 の可用性」（K6/2 `graph-eval-procedure`、K6/4 で確認済み）：(a) 定常状態の窓外率、(b) の窓外率、(b) の失効率のどれかが物差し（1%）を超えたら、可用性を満たしたと主張せず HOLD。失効率が基準を満たさない trace が 1 つでもあれば `[precheck]` でユーザーの判断。K6/4 の読み替え（表示の可用性。欠落の許容は floor(0.01 × 件数)）は、候補が D′・RS-JOIN の hook・W_f を含むときだけ当たる。trace の受領書は trace-runner が keep test を走らせないため K6/2 の読みで記録される。**同じ keep test の証拠で K6/4 の読みへ再計算したものを別に載せる**（前回と同じ手順。測定のやり直しではない）。今回の再計算の証拠は `candidate-test`（候補 `a2309b95` で `useNir1RelatedScenes.graphReadyKeep.test.tsx` を走らせ、8 件 pass）で、`regime: k64`、`notApplied: []`（候補は 3 つの要件を満たす）。
- **K6/5 で読みに加わったもの**（K6/5 の draft〔`96c657cf`、凍結 `07fc80ec`〕、確認の記録 `user-confirmation-2026-11-07-k65-graph-eval-procedure.md`・`-k65-c7-g01-r5.md`・`-k65-r5-reuse.md`、S3 の再レビュー `s3-rereview-2026-11-07-k65.md`、候補側の S2〔`evals/nir1-graph/observation-prep.v1.json` の `k65Readings`、`traceRunnerReadings` の TP-1〕から読んだ）：
  1. D＝40 ms（変える点 1〜3、R-1〜R-3、R-5）。first-render の窓内、(b) の窓内、親の IR の締切、子の IR の deadline、「D の後の Graph を表示に混ぜた」の違反の境界が 40 ms で読まれる。K6/5-P1：D の窓内に親が Graph を受けた sample は first-render の窓内に数え、子は出ない（変える点 5）。**ただし、定常状態で first-render に数える条件は、文面だけでは決まらない**。K6/2 の手順 3（K6/2 draft `docs/plans/nir1-final-request-eval-proposal-2-draft.md:695`）は「製品 owner の slot が新しい READY になったことを確かめてから query を始める」と、最終文「開始時に READY でなかった sample や、鮮度の stamp が一致しなかった sample も、分母から除かず窓外に数える」を置く。このうち「新しい READY」は K6/4 の変える点 4（K6/4 draft `docs/plans/nir1-final-request-eval-proposal-4-draft.md:98`）で R1（同 :192。各 sample の前に slot が `empty`）に置き換えられ、K6/5 はその置換を変えていない。残っているのは :695 の最終文だけで、K6/5 の変える点 5 と K6/5-P1 はそれに触れていない（「規則は変えない」）。
  2. Hybrid p95 の上限（変える点 4、R-4）：G-case の Gold の measured・user-operation の call を arm ごとに pool した nearest-rank の p95 を、R+IR arm と Graph arm の**両方**が 94.2 ms（B＝54.2 ms ＋ D＝40 ms。B は D から逆算しない）以下であること。これは品質の判定（`../quality-verdict-s6r1-1/`）の条件 3 で当たる。S6 の集計（可用性）には使わない。
  3. T_late は 100 ms のまま（U-2）。q1 ＝ `t_notice − t_raw_ready`。
  4. C7（S2 追補 #14 の TP-1、ユーザーの確認 `0600ec04` の質問 1）：seeded な fetch のうち、`indexUsable === false`、`querySupported === true`、IR の理由が `index-unavailable`、renderer の値が `graph-unavailable:cancelled` のすべてを満たすものの begin を、整列の前に外す。外した親は defect にせず、record の無い行として Q と U（開始時の封印が current のとき）に入れ、**失効 (i) の `i-chronicle-stop` として数える**（封印が current でなければ `i-b-seal` が先）。外した begin の数 E と条件を満たす fetch の数の一致、E＞0 のときは読取の時計の範囲が必須、外した親への混入の検査（N1・N29・N32）。物差し（失効率 1％、窓外 2 件）は変えない（DR-CP4-LAPSE-3）。**集計での扱い**：C7 は harness の整列と分類器の中で働くので、集計は受領書の `lapse.i-chronicle-stop` をそのまま読み、`native.alignment.excludedChronicleStop` を開示する。集計側で C7 の外す条件を再判定したり、`i-chronicle-stop` の数を足し引きしたりはしない。
  5. G-01 の診断 run（`g01-e2e-diagnostic`）は判定に数えず、合格基準は到達の有無だけ。
- 失効の読み（K6/4 の変える点 15 の follow-up の失敗の区分、DR-CP4-V-3 の厳しい側）と、窓外の category の定義は変えない。

## 3. 結果

### (a) 定常状態（Gold、13 variant、regime k64）

- pool（`inPool` の 9 variant × 30 = 270 件）：**表示 107 件（すべて follow-up の成功。first-render は 0）、欠落 163 件（60.4%）**。許される欠落は floor(0.01 × 270) = 2 件。**物差しを超える**（前回は欠落 0）。
- 欠落は 6 つの variant に集中する：G-01/v1 30/30、G-03/base 30/30、G-06/base 30/30、G-08/base-usable 30/30、G-08/graph-recovered 30/30、G-05/base 7/30、G-02/base 6/30。G-04/base（v2。30/30 表示）と G-07/base（30/30 表示）に欠落は無い（前回の G-04/base v2 の開示は同じ。G-04 v2 は観測の後に作り直した版）。X の内訳は欠落のあった variant で F1・X3・X4・X6 が欠落と同数（1 つの sample が複数の code に載る）。
- **欠落の中身（開示用。判定には使わない。script が受領書の sample に harness の分類器を当て直し、受領書の k64 の集計〔表示 107、欠落 163〕と一致することを確認した）**：欠落 163 件はすべて、Graph の結果が D＝40 ms の窓内に合流した親（`graph.outcome: graph-ready`、`joined: true`、返却時の再検証 passed、出所 `worker`）で、`startSlot.readyFresh` が false、鮮度の stamp は 161 件が `stamp0-missing`（`matched: null`）、2 件が `fresh`（`matched: true`）。分類器は定常状態の first-render を `steadyStateInWindow`（窓内、出所 worker、`readyFresh === true`、stamp が一致）で決めるので、これらは first-render に数えられず、follow-up は出ない（親が合流済み）ので F1（`parent-joined`）で「表示されなかった」になる。前回（D＝10.84 ms）は pool 270 件（9 variant × 30 件）にこの形の sample が 0 件で、270 件すべてが graph-late の親に対する follow-up で表示された（各 variant の 30 件がすべて）。
- **表示 0 の variant（K6/4 draft :167）**：K6/4 の表示の可用性の定義（:167）は「表示された sample が 1 件もない case と、pool が 0 件のときは HOLD」とする。harness の記録どおりの読み（5 の 1 の (甲)）の下では、表示 0／30 の variant が G-01/v1、G-03/base、G-06/base、G-08/base-usable、G-08/graph-recovered の 5 つあり、それぞれが独立にこの規則に当たる（欠落の物差し〔許容 2〕とは別の理由でも HOLD を指す）。
- 13 variant すべて valid（`validation.json`）、窓の評価（`windowAssessment`）は 13 件とも `clean: true`（違反 0、隙間 0）。pool に入らない 4 variant（G-03/frontier-exceeded、G-08 の graph-index-unusable・chronicle-index-unusable・both-indexes-unusable）の K6/4 の集計は無い（期待が unavailable）。
- 開示用の参考（`poolWithoutG04`。判定に使わない。pool の選び直しは禁止）：G-04/base を除くと 240 件中欠落 163。

### (b) 実際の操作の trace

| trace | 読み | Q／U | 表示（first／follow） | 失効 | 窓外 | 主な理由 |
|---|---|---|---|---|---|---|
| editing | 受領書（K6/2） | 201／201 | — | **1（0.50%。物差し 1% の内側）** | 窓外 169（超える。K6/2 の読みの性質） | other 163（`freshness-stamp-stamp0-missing:clear`）、freshness 5、lapse 1 |
| editing | 再計算（K6/4） | 201／201 | 200（32／168） | **1（0.50%、`i-b-seal` 1、`i-chronicle-stop` 0）** | **欠落 1（U 内 1。許容 2。内側）** | `i-b-seal` 1（欠落と同じ query） |
| browsing | 受領書（K6/2） | 201／201 | — | 0 | 窓外 199（超える。同上） | freshness 174、other 25 |
| browsing | 再計算（K6/4） | 201／201 | 201（2／199） | 0 | 欠落 0 | なし |

- **`i-chronicle-stop` は両 trace とも 0**。C7 は働かなかった：`native.alignment.excludedChronicleStop` は両 trace とも `null`（外した begin 0）、`alignment` は aligned（editing seeded begin 369＝record 369、browsing 400＝400）、`excludedAfterWindow` は null、DR-CP4-V-2 の窓の後の除外は 0、DR-CP4-V-3 の `cancelledParents` は 0。開始時の封印は両 trace とも 201 件すべて B が generation 1・dirty でない（current 201、dirty 0、missing 0、unknown 0）。
- **editing の失効 1 件**：`nir1-cp4-trace-editing/1#0`（traceIndex 0、trace の最初の query）。`graph.outcome: graph-unavailable`、`reason: registration-unavailable`、IR は ir-ready、snapshot は usable、開始時の封印は current。`lapseKind` の規則（`graph.reason === registration-unavailable` は `i-b-seal`）で失効 (i) に数えられ、K6/4 の読みでは follow-up が無いので同じ query が表示の欠落 1 でもある（X3・X4・X6・X12 が各 1）。失効率 1/201 ＝ 0.4975%（物差し 1% の内側）。表示の欠落 1/201（許容 2 の内側）。前回（s5r6）の editing は失効 0。**最初の query で Graph の registration が使えなかった原因は未確認**。
- K6/5 の読みの効果：D＝40 ms の窓内に親が Graph を受けた query が trace にも出た（first-render の窓内 editing 32、browsing 2。trace の first-render は `join.inWindow`・出所 worker・snapshot usable で決まり、`readyFresh`・stamp の条件は無い）。前回は両 trace とも 0 で全件 follow-up だった。
- T_late（100 ms）：q1（`t_notice − t_raw_ready`、follow-up の n）は editing p50 45.6、p99 49.0、max 56.9 ms（n=168）、browsing p50 64.9、p99 91.6、**max 98.6 ms（n=199）**。どちらも 100 ms の内側で、X3 の `late` は 0。browsing の最大は 100 ms まで 1.4 ms の余裕しかない（K6/5 の draft の見積りは観測の最悪 83.7 ms）。前回の max は editing 135.3、browsing 89.5 ms。
- `requeryCount` は両 trace とも 0。editing の `graph-ready` 再 query 168、browsing 199（`outside-q` 200 は Q の外の再 query で、いずれも completed）。
- 受領書の K6/2 の読みの窓外（editing 169、browsing 199）は、Graph の答えが first-render の窓の後に着く設計（graph-late）による K6/2 の読みの性質で、前回（201）も同じ型。K6/4 の読み（表示の可用性）に読み替えるのは事前登録の規則 (2)。

### (c) SP-P4・parity・negative・G-01 診断

- SP-P4（`sp-p4-s6r1-1`）：**passed**。8 variant で差異 0、problems 0、IR の期限切れ（除外）0（上限 6。前回は 2）。
- parity（`parity-s6r1-1`）：completed。12 variant すべて valid、窓の評価は 12 件とも clean。
- negative（診断。`countsInCaseJudgement: false`。判定に数えない）：**N2、N3、N4 すべて measured・valid・`established`**（`g01-mira` が返らなかった。30 sample すべて `g01-question` のみ、frame 到達）。窓の評価は 3 件とも clean。
  - N2（`resave-same-body`）：封印は世代不変（`unchanged`）、待ち 1040 ms、`settleCoversMutation: true`（mutation 直後の feed head 19、acknowledged 17→静止で 19）。B は generation 1・dirty でない。
  - N3（`restore-same-bytes-body-version`）：新しい世代（`new-generation`）、515 ms、B generation 2。
  - N4（`restore-different-bytes-body-version`）：宣言前の保存は世代不変（1038 ms、`settleCoversMutation: true`）、restore は新しい世代（510 ms、B generation 2）。
  - 前回（s5r6）と同じ結果型。N3 の規則（新しい世代だけ）は変えていない。
- G-01 の診断（`g01-e2e-s6r1-1`、purpose `g01-e2e-diagnostic`、別 session）：**`reachedEndToEnd: true`、`firstMissing: null`**。lease の証拠（continue の Graph-only、click の keep_click、requery cached、requery continue available、used settle）はすべて true。report の problems 0。**判定に数えない**。

## 4. 規則の当てはめ（判定ではなく、規則が指す先）

- **規則は HOLD を指す**。K6/4 の読み（候補が 3 つの要件を満たすので当たる読み）で、(a) の定常状態の pool の欠落が 163/270（60.4%）で、許容 2 件の物差しを超える。「どれかが物差しを超えたら HOLD」の条件に当たるので、**可用性を満たしたと主張しない**。
- 超えていない指標：(b) editing の失効 1/201（0.50%。物差し 1% の内側）、表示の欠落 1/201（許容 2 の内側）、browsing の失効 0・欠落 0。失効率が基準を満たさない trace は無いので、その `[precheck]`（失効率による）には当たらない。
- K6/2 の読み（受領書の記録）では、窓外が editing 169/201、browsing 199/201 で物差しを超える（前回も同じ型で、K6/4 の読みを当てる規則 (2) に従った）。結論は読みを替えても同じ（HOLD）。
- 閾値・期待値・Gold・pool の選び方・失効の読み・K6/5 の値は変えていない。欠落 163 件の扱い（定常状態の first-render の条件）は、harness が受領書に記録した読み（5 の 1 の (甲)）をそのまま適用した。この点は契約の文面だけでは決まらない（規定の欠落・矛盾。5 の 1）。**ユーザーの決定（2026-11-07、`../user-confirmation-2026-11-07-s6r1-hold-k66.md`）で、s6r1 は HOLD と記録し、受領書の読み直しで合格にはしない。新しい版（K6/6）を起案する**。

## 5. 注意（開示）

1. **欠落 163 件の読みと、その原因（ユーザーの決定で HOLD と記録）**。
   - **原因（read-only の独立検査〔Opus〕と受領書・コードで確認した）**：K6/4 の R1（各 sample の前に slot を `empty` にする。K6/4 draft :192）の下では、`startSlot.readyFresh` は構造的に false になる。候補 `a2309b95` の `electron/native/grimodex-node/src/nir1_graph_eval/mod.rs:446-453` は `ready_fresh = kind == Ready && prepares_ready > LAST_CONSUMED_PREPARES_READY` で、slot が `empty` なら `kind == Ready` が成り立たず必ず false。harness の `steadyStateInWindow`（`scripts/quality/nir1-graph-eval/join.mjs:113-120`）は窓内・出所 worker・`readyFresh === true`・stamp の `matched === true` をすべて要る（`followup.mjs:485-490` の steady の context）ので、**この読みの下では、D の値に関わらず Gold の定常状態の first-render は数えられない**。窓内に合流した親は follow-up が出ない（子を出さない設計）ので、F1 `parent-joined`（`followup.mjs:600-608`）で「表示されなかった」になる。D＝10.84 ms では親が常に graph-late で follow-up が出たので、表に出なかった。K6/4 の側もこの食い違いを記録している（`docs/plans/nir1-lane-decisions/cp4-decisions.md:468`〔候補 `a2309b95` の worktree。contracts の枝にはこの file は無い〕と K6/4 draft :127「`steadyStateInWindow` は全 sample が窓外」）。
   - **受領書で確かめた値**：s6r1・s5r6 とも、Gold の Graph arm の measured は `startSlot.kind` が `empty`・`readyFresh` が false（G-08/graph-index-unusable の 23 件だけ `suspended`）。`notReadyAtStart` は 13 variant すべてで両 run とも 30／30。鮮度の stamp は、s6r1 の Gold の Graph arm で `stamp0-missing` 327 件・`fresh` 3 件（stamp の記録のある 330 件。s5r6 は 328 件・2 件）。**`stamp0-missing` は製品の状態**で、読取が None を返すとき数えられる（`nir1_graph_product.rs:2632-2636`、非 blocking の読取 `c_query_freshness.rs:14-29`。接続が再利用できない、待ちの利用者がいる、mutex を握られている、transaction の内側、のどれか）。
   - **(甲)(乙) の 2 つの読み。契約の文面だけでは決まらない（規定の欠落・矛盾）**。(甲) harness の記録どおり：定常状態の first-render は `steadyStateInWindow`（窓内、worker、`readyFresh`、stamp 一致）で数える。根拠：K6/2 draft :695 の最終文、K6/4 draft :52（first-render の可用性 ＝ K6/2 の (a) の窓内）、K6/4 draft :299（`steadyStateInWindow` は first-render の記録として残す）、DR-CP4-S1C1-8（`cp4-decisions.md:231`。`stamp0-missing` は `matched: null` で窓内にしない）。(乙) D の窓内に合流した親は数える：K6/5 の変える点 5（K6/5 draft `docs/plans/nir1-final-request-eval-proposal-5-draft.md:92`。「D=40 ms では親が D の内に Graph を受ける sample が出うる。その sample は K6/4-P2 で first-render の窓内に数え、子は出ない」）と K6/5-P1（同 :121）。(甲) と (乙) は同じ sample に別の答えを出す。S6 は受領書に記録された (甲) を使い、読みを変えなかった。
   - **(乙) で数えた場合の数字（開示用。判定に使わない）**：欠落が 0 になるのは、(乙) の「窓内に合流した親は数える」を、準備の句（`readyFresh`）と鮮度の印の句（stamp 一致）の**両方を外す**読みとして当てた場合だけである。鮮度の印の句を残すと、first-render に数えられるのは stamp が `fresh` の 2 件だけで、欠落は 161 件（許容 2 件を超える）。準備の句だけを外しても同じ。この数字は `s6-aggregation.json` の `ssc.missedBreakdownDisclosure` から読める。
   - **決定**：受領書を読み直して合格にすることは、観測の後の定義の変更（K6/2 draft :617、:620）に当たりうるので、どの道でも取り直しの run が要る。ユーザーは 2026-11-07 に、s6r1 を HOLD と記録して新しい版（K6/6）を起案する選択をした（`../user-confirmation-2026-11-07-s6r1-hold-k66.md`）。K6/6 は、準備の句・鮮度の印の句・G-08 の取り直しの扱いを明文にする。
   - 前回（s5r6）の Gold の Graph arm も `readyFresh` は false で、受領書の記録は今回と同じ状態だった。前回との差は、Graph の outcome が graph-late（窓の後に届く）だったか graph-ready（窓内に合流）だったかだけ。D の 10.84→40 ms の効果と読めるが、窓内に合流する割合の増加だけが言え、表示の可用性が上がったかどうかはこの run だけでは言えない。
2. **D＝40 の下での再計算 script の前提**。前回の再計算 script は D を持たず、候補の `availability.mjs`・`followup.mjs`・`constants.mjs` をそのまま呼ぶので、D＝40 の下でも手順は変えていない（候補の worktree・run 名・head の commit だけ置き換えた。`diff` で確認）。前回の結果の読み方は trace の親がすべて graph-late（201 件）という前提に立っていたが、今回はその前提が当たらない。今回は trace の親の一部（editing 32、browsing 2）が D の窓内に合流して first-render に数えられ、残りが follow-up で表示された。基準の再現（keep test なしの封印した ancestor だけの証拠）は、記録済みの要約と完全に一致した（`recompute-trace-base.mjs`。regime k62、Q・U・lapse・outcomes・mainReason が一致）。
3. trace を K6/4 で読み直したのは、前回と同じく S6 の分析での integrator の技術判断（候補は K6/4 の 3 つの要件を満たし、trace-runner が keep test を走らせないために記録が K6/2 になった）。受領書の K6/2 の要約は変えず、再計算を別に載せた。keep test は候補 `a2309b95` の clean な worktree で候補自身の試験を走らせた（tracked file は変えない。ログは scratchpad）。
4. **setup の再実行（run-record の開示を写す）**：G-05/base の setup が別の Xvfb の起動・終了で 2 回 `setup-with-problems` になり、3 回目で complete した（測定の窓の前）。失敗 2 回の receipt は contracts に入っていない（`../s6r1-run-record.md`）。測定の窓（11:05〜12:30Z）の間、build・試験・他の Electron は走らせていない。
5. 窓の sampler：Gold・parity・negative は記録があり全件 clean。SP-P4 と trace は sampler の記録を持たない（設計）。
6. 各 run は attempt 1 で、取り直していない。**この run は、D・p95 の上限の緩和（R-1〜R-5）を含む K6/5 の下の 1 回目の正式の測定**で、K6/5 の値の選択の前に s5r6 の p95 を見ていたこと（S2 `k65Readings.limits (a)(e)`）、凍結の前の dev の観測 5 つ（同 (e)）、C7 と LAPSE-2 の例外（同 (b)(c)）、R5 の記録の再利用（同 (g)）は S2 に開示済み。S7 に引き継ぐ。
7. C7 の外す条件を満たす begin は今回 0 件で、C7 の効果（Chronicle の停止を失効に数える）は今回の run では観測されていない。dev の予行（S2 `k65Readings.limits (e)`）では 1 件外した run があった。
8. dev の診断 run・dev の予告・dev の確認は、この集計に入れていない。
9. **試験と検出力の記録が、R1 の下で起きない sample を使っていた（開示）**。K6/5-P1 の合成の試験（`followup.test.mjs:132-147`）と、その検出力の記録（contracts `3675c50e` の `k65-detection-2026-11-07/k64-k65-synthetic-detection-record.md:111`、K65-P1-window の行。枝 `claude/k65-harness` の commit で、contracts の枝には入っていない）は、`test-support.mjs:73-74` の fixture（`startSlot: { readyFresh: true }`、stamp は `fresh`・`matched: true`）で first-render を数えていた。R1 の下では `readyFresh` が true になる sample は起きないので、P1 の試験は実際の Gold の定常状態を反映していなかった。K65-P1-window の変異が見るのは窓の値（`join.mjs` の D）だけである。S2 の `k65Readings`、追補 #14・#15、S3 の再レビュー（`../s3-rereview-2026-11-07-k65.md`）には、first-render・`readyFresh`・K6/4-P2 への言及が無い（S2 の file 全体を `readyFresh`・`first-render` で検索して 0 件、再レビューも 0 件。確認した）。凍結の前の dev の予行（S2 `k65Readings.limits (e)` の (3)）は trace の run 3 回で、Gold の定常状態を D＝40 ms で見ていない。この食い違いは正式の run の後に初めて表に出た。
10. **trace の K6/4 の再計算の再現性の限界**。`trace-k64-recompute.json` の K6/4 の読みは、候補 `a2309b95` で keep test を走らせて得た証拠（`evidence.rsJoinHook`。`candidate-test`、8 件 pass、`runDigest 7adf240f…`）に依る。JSON に写した証拠だけから `summarizeTrace` を呼ぶと、regime は k62（`k64NotApplied: ["ratification5-not-collected"]`）になり、K6/4 の読みは再現できない（integrator が確かめた。editing の再計算で regime が k62、失効 1）。再現するには keep test の再実行が要る。独立検査（Opus）は keep test を再実行していない。
11. **script の直し（2026-11-07）**。`scripts/s6-aggregate.mjs:84` の `c.failure?.stage` は実在しない field で、開示欄の `failedStage` が全件 null になっていた。正しい field は `c.failedStage` で、直して再実行した。**変わったのは `ssc.missedBreakdownDisclosure.byCondition` の 2 行の `failedStage` だけ**（null → `{stage: "parent", codes: [{stage: "parent", code: "F1", detail: "parent-joined"}]}`。161 件と 2 件の両方）。pool の集計（表示 107、欠落 163、許容 2）、再適用の件数（displayed 107、missed 163）、trace・SP-P4・negative・G-01 診断、規則が指す先（HOLD）は変わらない（出力の `diff` で確認）。`files.sha256` を作り直した。

## 6. 前回（s5r6：S4b''''・候補 `cbf33077`・K6/4）との比較

前回の値は `../s6-aggregation-s5r6/s6-aggregation.json` と README から、今回の値は `s6-aggregation.json`・`quality-verdict-s6r1-1/` から写した。前回の p95 は `../quality-verdict-s5r6-1/` から。

| 指標 | 前回（s5r6） | 今回（s6r1） | 物差し |
|---|---|---|---|
| D／Hybrid p95 の上限／B | 10.84 ms／65.04 ms／54.2 ms | **40 ms／94.2 ms／54.2 ms** | K6/5 で変更（R-1〜R-5） |
| (a) Gold の pool の欠落（K6/4） | 0／270（表示 270、first-render 0、follow-up 270） | **163／270（表示 107、first-render 0、follow-up 107）** | 2 件 |
| (b) editing の失効（K6/4） | 0／201 | **1／201（0.50%。`i-b-seal`）** | 1% |
| (b) editing の表示の欠落（K6/4） | 1／201（U 内 1。X3） | 1／201（U 内 1。失効と同じ query。X3・X4・X6・X12） | 2 件 |
| editing の first-render／follow-up | 0／200 | 32／168 | — |
| (b) browsing の失効／欠落（K6/4） | 0／0 | 0／0 | — |
| browsing の first-render／follow-up | 0／201 | 2／199 | — |
| `i-chronicle-stop`（editing／browsing） | 記録の欄なし（C7 前） | 0／0（C7 の外した begin 0） | — |
| K6/2 の読みの窓外（editing／browsing） | 201／201 | 169／199 | 超える（同じ型） |
| q1 の max（editing／browsing。K6/4 の follow-up） | 135.3／89.5 ms | 56.9／98.6 ms | T_late 100 ms |
| ④ SP-P4 | passed、IR の期限切れ 2 | passed、IR の期限切れ 0 | 上限 6 |
| parity | 12 variant valid | 12 variant valid | — |
| 診断の負例 N2／N3／N4 | すべて measured・established | すべて measured・established | 判定に数えない |
| G-01 の e2e 診断 | （なし） | reachedEndToEnd＝true | 判定に数えない |
| 規則が指す先 | HOLD に当たらない | **HOLD に当たる（(a) の欠落）** | — |
| 品質の判定（補助。`../quality-verdict-s6r1-1/`）の p95（R+IR arm／Graph arm） | 55.30／31.50 ms（上限 65.04） | 22.00／60.20 ms（上限 94.2、pass） | — |
