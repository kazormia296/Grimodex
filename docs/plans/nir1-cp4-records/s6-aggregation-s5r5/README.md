# S6 集計（S4b'''・候補 `22b74a25`）

2026-11-02（JST）に integrator が行った、CP-4 の ⑤ の S6 集計。入力は S4b'''（`60bf9dc44a5f751551a9ce0195abb87f5c97543d`）の下の正式の run 8 件（`sp-p4-s5r5-1`、`trace-editing-s5r5-1`、`trace-browsing-s5r5-1`、`parity-s5r5-1`、`gold-s5r5-1`、`neg-n2／n3／n4-s5r5-1`）の受領書と台帳。**S6 は受領書の数値に事前登録の規則を当てるだけで、閾値・期待値・Gold・Q と U の定義・pool の選び方は変えていない**。再現：`scripts/s6-aggregate.mjs`（集計）、`scripts/recompute-trace-base.mjs`（基準の再現）、`scripts/recompute-trace-k64.mjs`（K6/4 の読みへの再計算）。出力は `s6-aggregation.json` と `trace-k64-recompute.json`。いずれもリポジトリの外の script で、harness は変えていない。

## 1. 許可リストと集計の対象

- 台帳 `attempts-final-s5r5/` の 8 件はすべて `s4Commit` が `60bf9dc44a5f751551a9ce0195abb87f5c97543d`、attempt 1。許可リストはこの `s4Commit` だけ。**completed は 6 件**（SP-P4、trace 2、parity、Gold、N3）。**`neg-n2-s5r5-1` と `neg-n4-s5r5-1` は `stopped`（blocked）**で、集計に入らない（理由は 4）。旧 S4b''（`557e683c`）以前の run は集計に入れない。
- `selectReceiptsForAggregation` の結果：`g-case-gold` 13、`g-case-parity-unrestricted` 12、`g-case-diagnostic-negative` 1（N3 のみ）。trace の受領書 2 件は前回と同じ `runner-is-not-the-k64-hook-consumer` で除かれる（関数が受領書全体の `runnerKind` を要求するが trace は query ごとに持つため。`receipt.mjs` は S2 に pin 済みなので変えない）。

## 2. 事前登録の規則（前回の S6 と同じ）

「条件が成立しない場合の CP-4 の可用性」（K6/2 `graph-eval-procedure`、K6/4 で確認済み）：(a) 定常状態の窓外率、(b) の窓外率、(b) の失効率のどれかが物差し（1%）を超えたら、可用性を満たしたと主張せず HOLD。失効率が基準を満たさない trace が 1 つでもあれば `[precheck]` でユーザーの判断。K6/4 の読み替え（表示の可用性。欠落の許容は floor(0.01 × pool の件数)）は、候補が D′・RS-JOIN の hook・W_f を含むときだけ当たる。trace の受領書は trace-runner が keep test を走らせないため K6/2 の読みで記録される。**同じ keep test の証拠で K6/4 の読みへ再計算したものを別に載せる**（前回と同じ手順。測定のやり直しではない）。

## 3. 結果

### (a) 定常状態（Gold、13 variant、regime k64）

- pool（`inPool` の 9 variant × 30 = 270 件）：**表示 270 件（すべて follow-up の成功）、欠落 0 件**。許される欠落は floor(0.01 × 270) = 2 件。**物差しの内側**。前回（S4b''）は欠落 30 件（11.1%、すべて G-04/base）だった。
- **G-04/base（v2）は 30/30 が表示された**（X5 = 0）。Graph arm の follow-up の最終一覧は 30/30 とも `[g04-control, g04-lio-landing]`（fixture v2 の予測の R+IR+Graph と同じ）、hybrid は 30/30 とも `[g04-control]`。**これは G-04 v2 を観測の後に作り直した結果であり、v1 の欠落が解消したという意味ではない**（S7 の 5）。
- 13 variant すべて valid。

### (b) 実際の操作の trace

| trace | 読み | Q／U | 表示 | 失効 | 窓外 | 主な理由 |
|---|---|---|---|---|---|---|
| editing | 受領書（K6/2） | 201／193 | — | **8（3.98%、超える）** | 窓外 201（超える） | begin の前の取消し |
| editing | 再計算（K6/4） | 201／193 | 181 | **15（7.46%、超える）** | 窓外 20（U 内 12、超える） | lapse |
| browsing | 受領書（K6/2） | 201／201 | — | 0 | 窓外 201（超える） | freshness |
| browsing | 再計算（K6/4） | 201／201 | 201 | 0 | 欠落 0 | なし |

- **editing の開始時の封印は 201 件すべて `current`（dirty 0、missing 0）**。前回（S4b''）は 201 件中 200 件が dirty だった。X1-5（本文だけの保存と Chronicle の IR の Freshness では B を dirty にしない）の効果。
- editing の失効 (i) 8 件はすべて **`cancelledBeforeBegin` 8**（begin の前に製品が取り消した counted parent。DR-CP4-V-3 の厳しい側の読み：Q に数え、U に入れず、失効 (i)、K6/4 は X12。測定の前に決めた規則）。B の seal が dirty だった件数ではない。K6/4 の読みの失効 15 は、i-b-seal 11（上の 8 ＋ follow-up の親の登録不可 3）と、iii（child の合流の無効化）4。X の内訳は X1 7、X3 8、X4 8、X5 4、X6 8、X11 1、X12 9。
- **失効率（編集）はどちらの読みでも物差しを超える**ので、規則どおり `[precheck]` でユーザーの判断に回る。browsing は K6/4 の読みでは物差しの内側、K6/2 の読みでは窓外 100% で物差しを超える。

### (c) SP-P4・parity・negative

- SP-P4（`sp-p4-s5r5-1`）：passed。8 variant で差異 0、IR の期限切れ（除外）0 件（上限 6）。G-04/base も R と R+IR が pin の有無で変わらない。
- parity（`parity-s5r5-1`）：completed。12 variant valid。
- negative（診断。判定に数えない）：**N3 は measured・valid**。**N2 と N4 は blocked（`b-seal-not-published`）**：「同じ本文を保存し直す」変異（N2）と、下書きに保存してから元に戻す変異（N4）のあと、負例の harness は B の**新しい** sealed generation を待つ（`bSealPublished(metadata, before.generation)`）。X1-5 は本文だけの保存で B を dirty にしないので、B は generation 1・dirty false のまま（N2 は 3 回の再 open、各 120 秒待ちで同じ。`negatives-s5r5-1/n2-seal-attempts-extract.json`）、新しい seal が来ない。**X1-5 の意図した効果と、負例の harness の前提（本文の保存し直しで B が作り直される）の衝突**で、harness の欠陥。N2／N4 を測るには harness の修正（B が clean で generation が変わらないことを sealed と認める）と S4 の凍結し直しが要り、DR-CP4-S4-6 により、改めてユーザーの確認が要る。

## 4. 規則の当てはめ（判定ではなく、規則が指す先）

- **CP-4 の Graph arm は可用性を満たしたと主張しない（HOLD）**。理由は 1 つ：**編集の trace の失効率**（K6/2 の読み 3.98%、K6/4 の読み 7.46%）が物差し 1% を超える。`[precheck]` でユーザーの判断。(a) の pool の欠落率は物差しの内側、browsing の trace は K6/4 の読みで物差しの内側。この結論は、trace を K6/2 と K6/4 のどちらで読むかに依らない。
- 閾値、期待値、Gold、pool の選び方は変えていない。失効の読み（begin の前の取消しを数えない、など）を結果を見た後に変えることは閾値の緩和にあたり、integrator の判断では行わない。

## 5. 注意（開示）

1. trace を K6/4 で読み直したのは、前回と同じく S6 の分析での integrator の技術判断（候補は K6/4 の 3 つの要件を満たし、trace-runner が keep test を走らせないために記録が K6/2 になった）。受領書の K6/2 の要約は変えず、再計算を別に載せた。結論は変わらない。
2. 窓の sampler：Gold・parity・negative は記録があり全件 clean。SP-P4 と trace は sampler の記録を持たない。
3. `recompute-trace-k64.mjs` は keep test（`useNir1RelatedScenes.graphReadyKeep.test.tsx`）を候補の worktree で走らせて封印した証拠を作る。前回と同じ手順。
