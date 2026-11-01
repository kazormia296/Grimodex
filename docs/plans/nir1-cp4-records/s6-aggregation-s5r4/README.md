# S6 集計（S4b''・候補 `86427ee5`）

2026-11-01（UTC）に integrator が行った、CP-4 の ⑤ の S6 集計。入力は S4b''（`557e683c`）の下の正式の run 8 件（`sp-p4-s5r4-1`、`trace-editing-s5r4-1`、`trace-browsing-s5r4-1`、`parity-s5r4-1`、`gold-s5r4-1`、`neg-n2／n3／n4-s5r4-1`）の受領書と台帳。**S6 は受領書の数値に事前登録の規則を当てるだけで、閾値・期待値・Gold・Q と U の定義・pool の選び方は変えていない**。この記録は結果と規則の当て方の記録で、その後の扱い（HOLD の後に何をするか）は S7 の報告に回す。

再現：`scripts/s6-aggregate.mjs`（集計）、`scripts/recompute-trace-base.mjs`（基準の再現）、`scripts/recompute-trace-k64.mjs`（K6/4 の読みへの再計算）。出力は `s6-aggregation.json` と `trace-k64-recompute.json`。いずれもリポジトリの外の script で、harness（`scripts/quality/nir1-graph-eval/**`）は変えていない。

## 1. 許可リストと集計の対象

- 台帳 `attempts/*-s5r4-1.json` の 8 件はすべて `s4Commit` が `557e683ccd884955e220f21bd15119f115995d29`、status `completed`、attempt 1。許可リストはこの `s4Commit` だけ。旧 S4b `b7d74950` と旧 S4b' `9f52e7da` の run（`sp-p4-1`、`parity-1`、`*-s5r-*`、`*-s5r2-*`、`*-s5r3-*`）は集計に入れない（`s4-revocation-9f52e7da-2026-11-01.md`）。
- `selectReceiptsForAggregation`（`receipt.mjs`）に S4b'' の 28 件の受領書を通すと、`g-case-gold` 13、`g-case-parity-unrestricted` 12、`g-case-diagnostic-negative` 3 の計 28 件が入る（窓の評価はすべて clean）。**trace の受領書 2 件は `runner-is-not-the-k64-hook-consumer` で除かれる**。関数が受領書全体の `runnerKind` を要求するのに、trace の受領書は query ごとに `runnerKind` を持ち（browsing は 201 件とも `k64-hook-consumer`。editing は 198 件が `k64-hook-consumer`、残り 3 件は `runnerKind` が無い）、全体では持たないため。trace の query は両方とも 201 件すべてで `followUp.issuedVia` が `product-hook` で、R5 は要約の検査で確かめられている。`receipt.mjs` は S2 に pin 済みなので変えず、trace は下の 3 のとおり別に扱う。

## 2. 事前登録の規則

「条件が成立しない場合の CP-4 の可用性」（K6/2 `graph-eval-procedure`、K6/4 で確認済み）：CP-4 の担当は (a) 定常状態の窓外率、(b) の窓外率、(b) の失効率を CP-4 の receipt に記録し、**どれかが物差し（1%）を超えたら、可用性を満たしたと主張せず HOLD にする**。(a) が超えたときは HOLD が既定。**失効率が基準を満たさない trace が 1 つでもあれば、窓外率と主な理由にかかわらず `[precheck]` でユーザーの判断に回す**。K6/4 の読み替え（可用性を「最初の表示の窓内か follow-up の成功」の表示の可用性で測り、欠落の許容は floor(0.01 × pool の件数)）は、候補が D′ の状態機械、RS-JOIN の hook、W_f の変更の 3 つを含むときだけ当たる（`assessCandidateRegime`。それ以外は K6/2 の文のまま）。

## 3. 候補の regime

- **Gold（定常状態）**：`candidateRegime` は `k64`（欠け無し）。D′ `4d38d0d1` と W_f `c4333bbd` は候補の祖先。RS-JOIN の hook の commit `c7b091da` は候補の祖先ではない（squash で入ったため）ので、Gold は `--keep-test-worktree` で RS-JOIN の keep test（`useNir1RelatedScenes.graphReadyKeep.test.tsx`、8 件、passed）を候補の clean な worktree で走らせた証拠で K6/4 になった。
- **trace**：`trace-runner.mjs` は `--keep-test-worktree` を受けない。trace の受領書の `candidate.ratification5` は hook を「祖先」の証拠（`c7b091da` は祖先でない）だけで記録しているので、**受領書に記録された trace の要約は K6/2 の読み**（`regime: "k62"`、`k64NotApplied: ["b:rs-join-hook"]`）。
- **再計算**（今回の S6 で行った分析。測定のやり直しではない）：同じ候補で、Gold と同じ keep test を候補の worktree で走らせて封印した証拠を作り（`recompute-trace-k64.mjs`、8 件 passed、`head` は `86427ee5`）、観測済みの trace の query（各 201 件）を `summarizeTrace` に通し直した。基準として、keep test の無い封印済みの証拠（hook は祖先 false）で再計算すると、受領書の要約と Q・U・失効・outcomes・mainReason・notApplied が完全に一致する（`recompute-trace-base.mjs`）。**K6/4 の読みと K6/2 の読みの両方を下に載せる**。

## 4. 結果

### (a) 定常状態（Gold、13 variant、regime k64）

- pool（`inPool` の 9 variant × 30 = 270 件）：表示された 240 件（すべて follow-up の成功。最初の表示の窓内は 0 件）、**欠落 30 件（11.1%）**、許される欠落は floor(0.01 × 270) = 2 件。**物差しを超える**（HOLD が既定）。
- 欠落 30 件はすべて **G-04/base の 30/30**（X5）。子（follow-up）の Graph は `graph-ready`、IR は `ir-ready`、requalification は `passed` だが、**辺が 0 件で `expectedContribution` が false** のため、寄与の空の Graph（F6）として表示に数えられない。残りの 8 variant は 240/240 が表示された。旧 S4b' の下の Gold（`gold-s5r3-1`）でも同じ（G-04/base が 30/30 欠落、pool 240/270）。
- 参考（K6/2 の最初の表示の窓外率。K6/4 では記録と開示だけ）：pool 270 件のうち窓外 270 件（100%）、窓内 0 件。
- 開示用（判定には使わない。pool は事前登録のとおり 270 件）：G-04/base を除く 8 variant は 240 件中欠落 0 件。

### (b) 実際の操作の trace（regime の読み 2 通り）

| trace | 読み | Q／U | 表示（follow-up の成功） | 失効 | 窓外／欠落 | 主な理由 |
|---|---|---|---|---|---|---|
| editing | 受領書（K6/2） | 201／1 | — | 200（99.5%、**超える**） | 窓外 201（U 内 1/1、超える） | lapse |
| editing | 再計算（K6/4） | 201／1 | 1 | 200（99.5%、**超える**） | 窓外 200（U 内 0/1、超えない） | lapse |
| browsing | 受領書（K6/2） | 201／201 | — | 0 | 窓外 201（201/201、**超える**） | freshness（171） |
| browsing | 再計算（K6/4） | 201／201 | 201 | 0 | 欠落 0 | なし |

- editing の失効 200 件はすべて (i) B の封印（`i-b-seal`）。再計算の follow-up の失効は `parent-ticket-registration-unavailable` 5 件。X の内訳は X1 5、X3 196、X4 196、X6 196、X11 1、X12 194。K6/4 の `violations` は両 trace とも空。
- **失効率（編集）はどちらの読みでも物差しを超える**ので、規則どおり `[precheck]` でユーザーの判断に回る。browsing は K6/4 の読みでは物差しの内側、K6/2 の読みでは窓外 100% で物差しを超える。

## 5. 規則の当てはめ（判定ではなく、規則が指す先）

- **CP-4 の Graph arm は可用性を満たしたと主張しない（HOLD）**。理由は独立に 2 つ：(1) (a) の pool の欠落率が K6/4 の読みでも物差しを超える（G-04/base 30/30）。(2) 編集の trace の失効率 99.5% が物差しを超える（`[precheck]` でユーザーの判断）。この結論は、trace を K6/2 と K6/4 のどちらで読むかに依らない。
- 閾値、期待値、Gold、pool の選び方は変えていない。G-04/base を pool から外す、F6 の読みを変える、窓や lease を広げる、といった変更は閾値・Gold の緩和にあたり、integrator の判断では行わない。

## 6. 注意（開示）

1. trace を K6/4 で読み直したのは、S6 の分析での integrator の技術判断。理由：候補は K6/4 の 3 つの要件を満たし（Gold は同じ証拠で k64）、trace-runner が keep test を走らせないために記録が K6/2 になった。受領書の K6/2 の要約は変えず、再計算を別に載せた。結論（HOLD）は変わらない。
2. G-04/base の X5：`expectedContribution` が false の case が、事前登録の pool に入り、F6 の規則で必ず「表示されない」ことになる。fixture の期待（`g04-scope-exact-unknown.v1.json` は Scope が一致しない材料を 0 件にする case）と K6/4 の F6 の関係は、製品の性質ではなく事前登録の設計の問題の可能性がある。S7 で扱う（ユーザーの判断が要る）。
3. trace の受領書は窓の sampler（`windowSamples`）を持たない。`windowAssessment` は `clean: true` だが、sample を入力にしていないので、測定中に他の process が無かったことの証拠ではない（`traces-s5r4-1/README.md`）。Gold・parity・negative は sampler の記録があり、全件 clean（違反・欠け 0）。
4. 旧 S4b' の下で Graph arm（Gold・負例・trace）が走っていた事実と、freeze record の `graphRuntimeObservedBeforeFreeze: false`（契約が固定した形の値）が字義と合わないことは、S7 の報告に書く。
