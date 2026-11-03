# S6 集計（S4b''''・候補 `cbf33077`）

2026-11-03（JST）に integrator が行った、CP-4 の ⑤ の S6 集計。入力は S4b''''（`3734e501c456f3fef22ded01a0084be457a60c1a`）の下、候補 `cbf3307739db9310e2e1d65d947a811591fd77f2`（PR #779 の merge commit。tree `0ad15da4cdf2d0eab13981e964729d6820feedf6`）の正式の run 8 件（`sp-p4-s5r6-1`、`trace-editing-s5r6-1`、`trace-browsing-s5r6-1`、`parity-s5r6-1`、`gold-s5r6-1`、`neg-n2／n3／n4-s5r6-1`）の受領書と台帳。**S6 は受領書の数値に事前登録の規則を当てるだけで、閾値・期待値・Gold・Q と U の定義・pool の選び方・失効の読みは変えていない**。再現：`scripts/s6-aggregate.mjs`（集計）、`scripts/recompute-trace-k64.mjs`（trace の K6/4 の読みへの再計算）、`scripts/recompute-trace-base.mjs`（基準の再現）。前回の S6 は `s6-aggregation-s5r5/`（S4b'''・候補 `22b74a25`）。

## 1. 許可リストと集計の対象

- 台帳 `attempts-final-s5r6/` の 8 件はすべて `(s4Commit, candidate.commit)` が `(3734e501…, cbf33077…)`、attempt 1、**status `completed`**。許可リストはこの組だけ（集計 script は、組が違う台帳が 1 件でもあれば `[precheck]` で止まる）。旧 S4b'''・候補 `22b74a25` の run（`*-s5r5-1`）と、旧 S4b から旧 S4b'' の run は集計に入れない。
- 台帳の開始時の状態は、各 run の開始の直後に contracts へ写した（`attempts/*-s5r6-1.json`、commit `c7a43662`〜`02648615`。DR-CP4-N-14 (5)）。
- `selectReceiptsForAggregation` の結果：`g-case-gold` 13、`g-case-parity-unrestricted` 12、**`g-case-diagnostic-negative` 3（N2、N3、N4）**。trace の受領書 2 件は前回と同じ `runner-is-not-the-k64-hook-consumer` で除かれる（関数が受領書全体の `runnerKind` を要求するが trace は query ごとに持つため。`receipt.mjs` は S2 に pin 済みなので変えない）。

## 2. 事前登録の規則（前回の S6 と同じ）

「条件が成立しない場合の CP-4 の可用性」（K6/2 `graph-eval-procedure`、K6/4 で確認済み）：(a) 定常状態の窓外率、(b) の窓外率、(b) の失効率のどれかが物差し（1%）を超えたら、可用性を満たしたと主張せず HOLD。失効率が基準を満たさない trace が 1 つでもあれば `[precheck]` でユーザーの判断。K6/4 の読み替え（表示の可用性。欠落の許容は floor(0.01 × 件数)）は、候補が D′・RS-JOIN の hook・W_f を含むときだけ当たる。trace の受領書は trace-runner が keep test を走らせないため K6/2 の読みで記録される。**同じ keep test の証拠で K6/4 の読みへ再計算したものを別に載せる**（前回と同じ手順。測定のやり直しではない）。今回の再計算の証拠は `regime: k64`、`notApplied: null`（候補は 3 つの要件を満たす）。

## 3. 結果

### (a) 定常状態（Gold、13 variant、regime k64）

- pool（`inPool` の 9 variant × 30 = 270 件）：**表示 270 件（すべて follow-up の成功）、欠落 0 件**。許される欠落は floor(0.01 × 270) = 2 件。**物差しの内側**（前回も欠落 0）。
- **G-04/base（v2）は 30/30 が表示された**（前回と同じ。**G-04 v2 は観測の後に作り直した版で、v1 の欠落が解消した意味ではない**。S7 の 5）。
- 13 variant すべて valid、窓の評価（`windowAssessment`）は 13 件とも `clean: true`（違反 0、隙間 0）。

### (b) 実際の操作の trace

| trace | 読み | Q／U | 表示 | 失効 | 窓外 | 主な理由 |
|---|---|---|---|---|---|---|
| editing | 受領書（K6/2） | 201／201 | — | **0（0%）** | 窓外 201（超える。前回と同じ型） | other 199、freshness 2 |
| editing | 再計算（K6/4） | 201／201 | 200 | **0（0%）** | **欠落 1（U 内 1。許容 2。内側）** | `freshness-stamp-stamp0-missing:clear` 1（X3 に分類） |
| browsing | 受領書（K6/2） | 201／201 | — | 0 | 窓外 201（超える。前回と同じ型） | freshness 171、other 30 |
| browsing | 再計算（K6/4） | 201／201 | 201 | 0 | 欠落 0 | なし |

- **editing の開始時の封印は 201 件すべてで B が generation 1・dirty でない**（browsing も 201 件とも同じ）。前回（S4b'''・候補 `22b74a25`）も 201 件とも current だった（X1-5 の効果。DR-CP4-S6-2）。その前（S4b''）は 201 件中 200 件が dirty だった。
- 前回（S4b'''・候補 `22b74a25`）との比較：editing の失効 8（K6/2）／15（K6/4）→ **0**、K6/4 の窓外（表示の欠落）20（U 内 12／193）→ **1（U 内 1／201）**。前回の失効 8 はすべて begin の前の取消し（`cancelledBeforeBegin`）で、DR-CP4-V-3 の厳しい側の読み（Q に数え、U に入れず、失効）は今回も同じ規則で適用された（今回は該当 0）。`requeryCount` は 0。
- 受領書の K6/2 の読みの窓外 201（両 trace）は、Graph の答えが first-render の窓の後に着く設計（`outcomes: graph-late` 201）による K6/2 の読みの性質で、前回も同じ。K6/4 の読み（表示の可用性）に読み替えるのは、候補が 3 つの要件を満たすときの事前登録の規則（2）。
- editing の K6/4 の欠落 1 件：集計の要約からは、どの query かは特定していない（未確認）。理由は `freshness-stamp-stamp0-missing:clear`（freshness stamp0 の欠落、重なりなし）で X3 に分類された。q1 の最大は 135.3 ms（p99 41.8 ms）で、K6/4 の `T_late`（100 ms）を超える query が 1 件あるが、これが同じ query かは未確認。

### (c) SP-P4・parity・negative

- SP-P4（`sp-p4-s5r6-1`）：**passed**。8 variant で差異 0、IR の期限切れ（除外）2 件（上限 6。前回は 0）。
- parity（`parity-s5r6-1`）：completed。12 variant valid、窓の評価は 12 件とも clean。
- negative（診断。`countsInCaseJudgement: false`。判定に数えない）：**N2、N3、N4 すべて measured・valid・`established`**（`g01-mira` が返らなかった）。
  - N2（`resave-same-body`）：封印は**世代不変（`unchanged`）**、待ち 1040 ms、`settleCoversMutation: true`（mutation 直後の feed head 19、acknowledged 18→静止で 19）。B は generation 1・dirty でない。
  - N3（`restore-same-bytes-body-version`）：新しい世代（`new-generation`）、511 ms、B generation 2。
  - N4（`restore-different-bytes-body-version`）：宣言前の保存は世代不変（feed head 19、acknowledged 17→静止）、restore は新しい世代（510 ms、B generation 2）。
  - 前回（S4b'''）は N2・N4 が `blocked:b-seal-not-published`、N3 だけが measured だった。今回は DR-CP4-S4-8 の封印の規則（案 A′）により 3 つとも測れた。**N3 の規則（新しい世代だけ）は変えていない**。詳細は `negatives-s5r6-1/seal-attempts-extract.json`。
  - 窓の評価は 3 件とも clean。

## 4. 規則の当てはめ（判定ではなく、規則が指す先）

- **K6/4 の読み（候補が 3 つの要件を満たすので当たる読み）では、物差しを超える指標は無い**：(a) pool の欠落 0/270（許容 2）、(b) editing の失効 0/201（0%）、表示の欠落 1/201（許容 2）、browsing の失効 0、欠落 0。したがって「どれかが物差しを超えたら HOLD」の条件に**当たらない**。規則が指す先は、前回の HOLD（編集 trace の失効率と窓外率）が今回は成立しない、ということ。
- K6/2 の読み（受領書の記録）では、窓外 201/201（両 trace）が物差しを超える。これは前回も同じで、前回は K6/4 の読みを当てる規則（2）に従った。失効率は K6/2 の読みでも 0 で、基準を満たす。
- 閾値・期待値・Gold・pool の選び方・失効の読みは変えていない。

## 5. 注意（開示）

1. trace を K6/4 で読み直したのは、前回と同じく S6 の分析での integrator の技術判断（候補は K6/4 の 3 つの要件を満たし、trace-runner が keep test を走らせないために記録が K6/2 になった）。受領書の K6/2 の要約は変えず、再計算を別に載せた。基準の再現（keep test なしの封印した ancestor だけの証拠）は、記録済みの要約と完全に一致した（`recompute-trace-base.mjs`）。
2. 窓の sampler：Gold・parity・negative は記録があり全件 clean。SP-P4 と trace は sampler の記録を持たない（設計）。
3. `recompute-trace-k64.mjs` は keep test（`useNir1RelatedScenes.graphReadyKeep.test.tsx`）を候補の worktree で走らせて封印した証拠を作る。前回と同じ手順。
4. 今回の run は、前回の HOLD を見た後に、製品（LP-A1 `8dd7a9c0`、LP-GATE `2014ac50`）と N2／N4 の封印の規則を直した候補で行った（閾値・期待値・Gold・読みは変えていない）。各 run は attempt 1 で、取り直しはしていない。dev の診断 run・dev の予告・dev の確認（contracts `diag-lpd-2026-11-02/`、DR-CP4-S4-8、`dev-reopen-only-check-2026-11-03/`）はこの集計に入れていない。
5. **gate（LP-GATE）が動いた状態の効果**：受領書に LP-GATE の counter（`windowsOpened`、`graphWaited` など）は無く、この集計では gate の寄与を分けて観測していない。失効が 8→0 になったのは LP-A1 と LP-GATE の両方を含む候補の結果であり、どちらがどれだけ効いたかは分けられない。
