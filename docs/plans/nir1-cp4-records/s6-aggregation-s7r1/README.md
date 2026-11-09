# S6 集計（S4b 7 回目・候補 `3f333a83`・K6/6）

2026-11-09 に integrator の依頼で作った、CP-4 の ⑤ の S6 集計。入力は 7 回目の S4（S4b `f2f99b13e18bcf4dd84ff6778de56189a3e1ef9b`）の下、候補 `3f333a83554d4dba6c54417d500d3af6f0e985c5`（PR #840 の merge commit。tree `24da8524888b764bdf6cb71bb9b5d1c5bc5c96fb`）の正式の run の受領書と台帳。契約は K6/6（凍結 commit `56fb4fad2eb1eb2e021dfd121ea073f9d263cb4d`、SHA-256 `58c634fa9b3d76803e486516c0e67444b74d4f5987cd851cd0857a25cc8945e7`）、K6/5（`07fc80ec`）、K6/4（`5dea38af`）、K6/2（`af643a93`）。**S6 は受領書の数値に事前登録の規則を当てるだけで、閾値・期待値・Gold・Q と U の定義・pool の選び方・失効の読み・K6/6 の値は変えていない。結果がどちらを指しても、規則の読みも閾値も変えず、規則が指す先を記録するだけである。**

再現：`scripts/s6-aggregate.mjs`（集計。出力 `s6-aggregation.json`）、`scripts/recompute-trace-k64.mjs`（trace の K6/4 の読みへの再計算。出力 `trace-k64-recompute.json`）、`scripts/recompute-trace-base.mjs`（基準の再現）。前回の S6 は `../s6-aggregation-s6r1/`（S4b `63bc9b90`・候補 `a2309b95`・K6/5。規則は HOLD を指した）。本文の数値は、断りのない限り `s6-aggregation.json`（script の出力）から写した。品質の判定（品質判定 v2）は別に作られるもので、この集計は触れていない。

## 1. 許可リストと集計の対象

- 台帳 `../attempts-final-s7r1/` は **9 件**で、9 件すべて `(s4Commit, candidate.commit)` が `(f2f99b13…, 3f333a83…)`、contracts の写しは `.artifacts/cp4/attempts/` と byte 一致（script が確認）。
  - **集計の対象は status `completed` の 8 件**：`sp-p4-s7r1-1`、`trace-editing-s7r1-1`、`trace-browsing-s7r1-1`、`parity-s7r1-1`、**`gold-s7r1-2`**、`neg-n2／n3／n4-s7r1-1`。
  - **`gold-s7r1-1`（status `stopped`）は集計の対象に数えない**。5 の 1 に別に開示する。runbook の「台帳 8 件」は 1 回目の Gold だけの前提で書かれていた。今回は Gold が 2 回あるので、台帳は 9 件、対象は 8 件と数え直した。
  - script は、台帳の file 名が上の 9 件でない、組が違う、対象が 8 件でない・completed でない、`gold-s7r1-1` が stopped でない・`gold-s7r1-2` の前に終わっていない、のどれかで `[precheck]` で止まる（前回の「組が違う台帳が 1 件でもあれば止まる」を保った）。
- 受領書：`gold-s7r1-2` 13（13 variant。valid 13）、parity 12、negative 3（N2、N3、N4）、trace 2、SP-P4 1。`selectReceiptsForAggregation` の結果は、`g-case-gold` 13、`g-case-parity-unrestricted` 12、`g-case-diagnostic-negative` 3 の計 28。trace の受領書 2 件は前回と同じ `runner-is-not-the-k64-hook-consumer` で除かれる（関数が受領書全体の `runnerKind` を要求するが trace は query ごとに持つため。`receipt.mjs` は S2 に pin 済みなので変えない。script は「除かれるのが trace の 2 件だけ」であることを確認する）。
- **束縛の照合（script が `[precheck]` で止まる条件）**：受領書 31 件（SP-P4 1、Gold 13、parity 12、negative 3、trace 2）すべてについて、`head.k62`・`head.k64`・`head.k65`・`head.k66` の凍結 commit と SHA-256、`head.observationPrep.commit`（S4b）、`candidate.commit`、`preview: false` が許可リストの組に一致した（不一致 0）。あわせて script の定数は候補の `constants.mjs`（`K62_FREEZE`・`K64_FREEZE`・`K65_FREEZE`・`K66_FREEZE`）と一致。Gold・parity・negative の `priorAttempts.thisAttempt.runName` はそれぞれの run 名に一致。
- **SOURCE_PINS**：Gold（`gold-s7r1-2`・`gold-s7r1-1`）・parity・negative 3 の run-report の `checks.sourcePins`（45 件）は、(i) S4b の S2（`evals/nir1-graph/observation-prep.v1.json` の `setupReadings.source.pins`）と完全に一致、(ii) その S2 の pins は候補 `3f333a83` の `SOURCE_PINS`（`scripts/quality/nir1-graph/observation-prep.mjs`）と role・check・commit・path が一致、(iii) 各 pin の commit は候補の祖先で、`bytes` pin の各 file は、pin の commit・候補 `3f333a83`・候補の worktree の 3 つで同じ sha256（不一致 0）。`seedPinGate` は `match`、`productBuild` の製品・評価の受領書の head は候補。trace の run-report と SP-P4 の run-report は `sourcePins` の欄を持たない（run-report の構造。確認した）。
- 台帳の開始時の写しの sha256 が receipt の `priorAttempts.thisAttempt.fileSha256AtStart` と一致するかも確かめた（parity、`gold-s7r1-2`、`gold-s7r1-1`、N2、N3、N4 のすべて一致。trace の receipt は `priorAttempts` を持たず `attempts/<run>.json` の存在だけを確認）。runbook の one-liner は `gold-s7r1-1` を固定していたので Gold は `gold-s7r1-2` に直した。`gold-s7r1-2` の receipt の `priorAttempts.gold` は `gold-s7r1-1`（stopped、`e97ec4f7…`）で、最終台帳の sha256 と一致。
- 記録 dir の `files.sha256`：`setups-s7r1`・`g01-e2e-s7r1-1-report` の 2 つは **`files.sha256` を持たない**（`copy-records.sh` の `stage` がこの 2 dir では `sums` を呼ばない）。中身の不一致ではない。この 2 dir は `.artifacts` の元の file と `cmp` で byte 一致、`setups-s7r1/setup-receipts.sha256` は候補の worktree で 13 件とも検証できた。この集計はこの 2 dir に `files.sha256` を作っていない。それ以外の記録 dir（SP-P4、trace、parity、`gold-s7r1-1`、`gold-s7r1-2`、negative、attempts-final、g01）の `files.sha256` は検証済み。`.artifacts` の受領書・validation・run-report・台帳と contracts の写しは、全 file で `cmp` が一致。
- G-01 の診断 `g01-e2e-s7r1-1` は判定に数えない（`countsInCaseJudgement: false`、別 session）。集計の入力には入れず、結果だけを 3 の (c) に載せる。結果の `head`・`candidate` の束縛は確かめた（一致）。

## 2. 事前登録の規則

前回（s6r1）と同じ規則に、K6/6 が足した読みを加える。K6/6 が変えたのは、定常状態の first-render の数え方（準備の句 R-6、鮮度の印の句 R-7。5 の 2）と、それを守る狭める防御・記録だけで、D＝40 ms、Hybrid p95 の上限 94.2 ms（B＝54.2 ms）、T_late 100 ms、W_f 100 ms、T_show 2 s、1％・2 件の物差し、失効率の定義、Gold、pool、trace の規則は変えない。

- 「条件が成立しない場合の CP-4 の可用性」（K6/2 `graph-eval-procedure`、K6/4 の読み替え）：(a) 定常状態の表示の欠落、(b) の窓外率、(b) の失効率のどれかが物差し（1%。許す件数は floor(0.01 × 件数)）を超えたら、可用性を満たしたと主張せず HOLD。失効率が基準を満たさない trace が 1 つでもあれば `[precheck]` でユーザーの判断。表示された sample が 1 件もない case と pool が 0 件のときは HOLD（K6/4:167）。K6/4 の読み替えは、候補が D′・RS-JOIN の hook・W_f を含むときだけ当たる。trace の受領書は trace-runner が keep test を走らせないため K6/2 の読みで記録される。**同じ keep test の証拠で K6/4 の読みへ再計算したものを別に載せる**（前回と同じ手順。測定のやり直しではない）。今回の再計算の証拠は `candidate-test`（候補 `3f333a83` で `useNir1RelatedScenes.graphReadyKeep.test.tsx` を走らせ、8 件 pass、`runDigest 7adf240f…`）で、`regime: k64`、`notApplied: []`（候補は 3 つの要件を満たす）。
- **(a) の物差し**：K6/4 draft の「ユーザーが批准すること」の 2（「K6/2 で可用性の合否を述べる『(a)』は表示の可用性の欠落率と読み、first-render の窓外率は記録と開示だけにする」。「変える点」の 1〜3）と、K6/6 の変える点 5（first-render の窓外率は開示）により、定常状態の物差しは次の 2 つ：表示の欠落が floor(0.01 × 270) = 2 件以下であること、表示 0 の variant が無いこと。**first-render の窓外率は記録と開示だけで、物差しではない**（今回の値は 3 (a) に載せる）。
- **K6/6 で読みに加わったもの**（`../k66-freeze-record.md`、K6/6 draft〔`docs/plans/nir1-final-request-eval-proposal-6-draft.md` の SHA-256 `58c634fa…` の bytes。凍結 commit `56fb4fad`〕の読み。「threat model」「受入れ」の節も読み、S6 の規則に足す HOLD・`[precheck]`・開示の項目が漏れていないことを確かめた。K6/6-N8〔窓内の `stamp0-missing` の親だけを分母から外した受領書は拒否〕は、Gold の pool が全 variant で n＝30（270 件）、valid であることで満たされ、K6/6-N9〔`head.k66` が無い受領書は拒否〕は束縛の照合で満たされる）：
  1. R-6（準備の句）：first-render の候補は「開始時に新しい READY」ではなく、R1 を満たし、その sample のための準備が 1 回だけ行われ、その worker が答えたこと（FR-1〜FR-8 の条件）で数える。`readyFresh` は条件に使わず、開示（`notReadyAtStart`）に残す。
  2. R-7（鮮度の印の句）：stamp が `fresh` と `stamp0-missing` を数え、`unavailable` と記録なしは数えず、`stale` で合流した記録は `[artifact]`。
  3. 帰結（品質判定 v2 が出す）：窓内に合流して Graph が表示に寄与した親が first-render の条件を欠く（`contributedNotCounted > 0`）と、その variant の品質は FAIL（可用性の 1% の許容は効かない）。**S6 は件数を載せるだけで、FAIL の判定は品質判定 v2 の役目**。
  4. 受領書の記録の項目が増えた（R7）：`firstRenderCandidates`、`firstRenderNotCounted(By／Reasons)`、`contributedNotCounted`、`firstRenderOutOfWindow(Rate)`。**前回の 3a（欠落の sample に `classifyFollowUp` を当て直す開示）は削除し、受領書の `firstRenderNotCountedReasons` を variant ごと・合計で並べる開示に置き換えた**。K6/6 の harness は `next`（`nextGraphArmOf`）を渡すので、集計側の再適用では同じ数を再現できない。
- 失効の読み（K6/4 の変える点 15 の follow-up の失敗の区分、DR-CP4-V-3 の厳しい側）と、窓外の category の定義、C7（DR-CP4-C7）の扱いは変えない。C7 は harness の整列と分類器の中で働くので、集計は受領書の `lapse.i-chronicle-stop` をそのまま読み、`native.alignment.excludedChronicleStop` を開示する。集計側で C7 の外す条件を再判定したり、`i-chronicle-stop` の数を足し引きしたりはしない。
- G-01 の診断 run は判定に数えず、合格基準は到達の有無だけ。K6/6 の変える点 3〜5 は**定常状態**の規則で、(b) の trace には当てない。

## 3. 結果

### (a) 定常状態（`gold-s7r1-2`、13 variant、regime k64）

- pool（`inPool` の 9 variant × 30 = 270 件）：**表示 270 件（first-render 156、follow-up 114）、欠落 0 件**。許される欠落は floor(0.01 × 270) = 2 件。**物差しの内側**。**表示 0 の variant は無い**（K6/4:167）。`contributedNotCounted` は 9 variant すべてで 0（合計 0）。`firstRenderCandidates` 156、`firstRenderNotCounted` 0（FR-1〜FR-8・R-6・R-7 のどれでも数えられなかった候補は無く、`firstRenderNotCountedReasons` は全 variant で空）。X の内訳は全 variant で 0、violations 0。
- first-render の窓外率（**K6/6 の条件で数えたもの。開示だけで、物差しではない**）：**114／270（42.2%）**。窓外の sample は follow-up で表示された。K6/2 の字義の条件（`readyFresh`・stamp 一致つき）の窓外率は **270／270（100%）**で、これは K6/6 では開示だけ（`notReadyAtStart` 270、`stampMismatch` 269、`stampWithoutComparison` 269、stamp の result は `stamp0-missing` 269・`fresh` 1。`readyFresh` が構造的に false になる点は 5 の 2）。

| variant | n | first-render | follow-up | 表示 | 欠落 | first-render の窓外 | q1 max（follow-up。ms） |
|---|---|---|---|---|---|---|---|
| G-01/v1 | 30 | 30 | 0 | 30 | 0 | 0 | — |
| G-02/base | 30 | 3 | 27 | 30 | 0 | 27 | 43.8 |
| G-03/base | 30 | 30 | 0 | 30 | 0 | 0 | — |
| G-04/base（v2） | 30 | 0 | 30 | 30 | 0 | 30 | 43.7 |
| G-05/base | 30 | 4 | 26 | 30 | 0 | 26 | 44.5 |
| G-06/base | 30 | 30 | 0 | 30 | 0 | 0 | — |
| G-07/base | 30 | 0 | 30 | 30 | 0 | 30 | 53.2 |
| G-08/base-usable | 30 | 29 | 1 | 30 | 0 | 1 | 42.5 |
| G-08/graph-recovered | 30 | 30 | 0 | 30 | 0 | 0 | — |
| 計（pool 9 variant） | 270 | 156 | 114 | 270 | 0 | 114 | 最大 53.2（T_late 100 の内側。X3 `late` 0） |

- 13 variant すべて valid（`validation.json`）、窓の評価（`windowAssessment`）は 13 件とも `clean: true`。pool に入らない 4 variant（G-03/frontier-exceeded、G-08 の graph-index-unusable・chronicle-index-unusable・both-indexes-unusable）は期待が unavailable で、K6/4 の集計は無い。
- 受領書の variant ごとの `qualityHold` の欄は、pool の 9 variant すべてで `true` だが、これは **K6/2 の字義の `inWindow === 0`（`availability.mjs:334`）の旗**で、K6/4 の表示 0（`displayed === 0`、`availability.mjs:484`）の `holdCases` は**空**である。前者は 5 の 2 の理由（`readyFresh` が構造的に false）で全 variant が true になる。
- 開示用の参考（`poolWithoutG04`。判定に使わない。pool の選び直しは禁止）：G-04/base を除くと 240 件中欠落 0。

### (b) 実際の操作の trace

| trace | 読み | Q／U | 表示（first／follow） | 失効 | 窓外 | 主な理由 |
|---|---|---|---|---|---|---|
| editing | 受領書（K6/2） | 201／201 | — | 1（0.4975%。許容 2 件の内側。`i-chronicle-stop` 1） | 窓外 178（88.6%。超える。K6/2 の読みの性質） | other 173（`freshness-stamp-stamp0-missing:overlap-record-missing`）、freshness 4（`graph-late:stale-start`）、lapse 1 |
| editing | 再計算（K6/4） | 201／201 | 200（23／177） | **1（0.4975%、`i-chronicle-stop` 1、`i-b-seal` 0）** | **欠落 1（U 内 1。許容 2。内側）** | `i-chronicle-stop` 1（欠落と同じ query） |
| browsing | 受領書（K6/2） | 201／201 | — | 0 | 窓外 198（98.5%。超える。同上） | freshness 175、other 23 |
| browsing | 再計算（K6/4） | 201／201 | 201（3／198） | 0 | 欠落 0 | なし |

- **C7（DR-CP4-C7）が正式の run で初めて働いた**：editing の `native.alignment.excludedChronicleStop` は `count: 1`、`conditionFetches: 1`（一致）、`countedAs: i-chronicle-stop`、外した begin は 1 件（`beginId 8`、`fetchSeq 21`、`graphOutcome: graph-unavailable:cancelled`、`irReason: index-unavailable`、role `counted-parent`、query index 1）、読取の時計の範囲あり（lower 642.79、upper 646.55 ms）。alignment は aligned（seeded begin 378＝record 378）。外した親は defect にならず、Q・U に入り、失効 (i) の `i-chronicle-stop` 1 として数えられた（開始時の封印は current）。browsing は外した begin 0（`excludedChronicleStop: null`、seeded begin 399＝record 399）。両 trace とも `excludedAfterWindow` は null、DR-CP4-V-3 の `cancelledParents` は 0、開始時の封印は 201 件すべて current（dirty・missing・unknown は 0）、defects 0、stalled なし、attempt 1。
- **editing の失効 1 件**：`nir1-cp4-trace-editing/1#1`（traceIndex 1）。`graph.outcome: graph-unavailable`、`reason: cancelled`、IR は `index-unavailable`、snapshot は usable、開始時の封印は current。失効率 1/201 ＝ 0.4975%（物差し 1%＝許容 2 件の内側。2 件までは内側で、3 件で超える）。K6/4 の読みでは follow-up が無いので同じ query が表示の欠落 1 でもある（X11・X12 が各 1。許容 2 の内側）。
- `boundaryDisagreement`：editing は `not-joined-in-time` 2（K6/4 の読みでも同じ。窓外に数えられた境界の食い違いの開示）、`joined-late-within-tolerance` 0。browsing は両方 0。
- T_late（100 ms）：q1（`t_notice − t_raw_ready`、follow-up の n）は editing p50 45.4、p99 50.5、max 50.7 ms（n=177）、browsing p50 61.8、p99 81.2、**max 83.1 ms（n=198）**。どちらも 100 ms の内側で、X3 の `late` は 0。
- `requeryCount` は両 trace とも 0。editing の `graph-ready` 再 query 177（ほかに `index-ready` 1）、browsing 198（`outside-q` 200 は Q の外の再 query で、いずれも completed）。
- 受領書の K6/2 の読みの窓外（editing 178、browsing 198）は、Graph の答えが first-render の窓の後に着く設計（graph-late）による K6/2 の読みの性質で、前回（169／199）も同じ型。K6/4 の読み（表示の可用性）に読み替えるのは事前登録の規則 (2)。

### (c) SP-P4・parity・negative・G-01 診断

- SP-P4（`sp-p4-s7r1-1`）：**passed**。8 variant で差異 0、problems 0、IR の期限切れ（除外）0（上限 6）。
- parity（`parity-s7r1-1`）：completed。12 variant すべて valid、窓の評価は 12 件とも clean。**parity は Graph arm を測らないので、parity が通ったことは Gold の worker が READY になる証拠ではない**（5 の 1）。
- negative（診断。`countsInCaseJudgement: false`。判定に数えない）：**N2、N3、N4 すべて measured・valid・`established`**（`g01-mira` が返らなかった。70 sample のうち返った scene は `g01-question` のみ、frame 到達、control `reached`）。窓の評価は 3 件とも clean、run の problems 0。受領書の `assessment.outcome` は 3 件とも `established`、`g01-mira` は返っていない（前回の README と同じ言い方）。
  - N2（`resave-same-body`）：封印は世代不変（`unchanged`）、待ち 1041 ms、`settleCoversMutation: true`（feed head 19、acknowledged 17）。B は generation 1・dirty でない。
  - N3（`restore-same-bytes-body-version`）：新しい世代（`new-generation`）、515 ms、B generation 2。
  - N4（`restore-different-bytes-body-version`）：宣言前の保存は世代不変（1038 ms、`settleCoversMutation: true`）、restore は新しい世代（513 ms、B generation 2）。
  - 前回（s6r1）と同じ結果型。N3 の規則（新しい世代だけ）は変えていない。
- G-01 の診断（`g01-e2e-s7r1-1`、purpose `g01-e2e-diagnostic`、別 session）：**`reachedEndToEnd: true`、`firstMissing: null`**。lease の証拠（continue の Graph-only、click の keep_click、requery cached、requery continue available、used settle）はすべて true。report の problems 0、`sessionProblems` 空、候補は clean。**判定に数えない**。

## 4. 規則の当てはめ（判定ではなく、規則が指す先）

- **規則は HOLD を指さず、`[precheck]` にも当たらない**。K6/4 の読み（候補が 3 つの要件を満たすので当たる読み。trace は再計算で）で、次の物差しはどれも超えていない。
  - (a) 定常状態の表示の欠落 0／270（許容 2）、表示 0 の variant 0。
  - (b) editing の窓外 1／201（許容 2）、失効 1／201（0.4975%。許容 2）、browsing の窓外 0・失効 0。
  - 失効率が基準を満たさない trace は無い（`[precheck]` に当たらない）。
  - K6/6 の追加条件：`contributedNotCounted` は 0（合計 0。FAIL の条件に当たらない）。
- K6/2 の読み（受領書の記録）では、trace の窓外が editing 178/201、browsing 198/201 で物差しを超える（前回も同じ型で、K6/4 の読みを当てる規則 (2) に従った）。定常状態の K6/2 の字義の窓外率は 270/270。**K6/2 の字義のまま読むと HOLD に当たる**。K6/4 の読みを当てるのは、候補が 3 つの要件を満たし、事前登録の規則 (2) が読み替えを定めているため（前回と同じ扱い）。結論が読みに依ることは隠さない。
- 超えた物差しが無いことは、**可用性の物差しの結果**であって、次の代わりではない：(i) 品質の判定（品質判定 v2。FAIL の条件〔`contributedNotCounted`、Gold の品質、p95〕は v2 が出す）、(ii) S7 の報告とユーザーの受入れ。
- 閾値・期待値・Gold・pool の選び方・失効の読み・K6/6 の値は変えていない。

## 5. 注意（開示）

1. **`gold-s7r1-1` の停止と、`gold-s7r1-2` への取り直し（集計の Gold は `gold-s7r1-2`）**。
   - **1 回目 `gold-s7r1-1`**：2026-11-08T18:11:58Z〜18:19:27Z、台帳 `stopped`。4 番目の variant `G-03/frontier-exceeded` で **`[precheck] V-10: the worker never reached READY`**（`frozen-k64-run.mjs:895` の readyProbe。`OWNER_READY_WAIT_MS` 90 s）で停止。receipt のあるのは measured の 3 variant（G-01/v1、G-02/base、G-03/base。いずれも valid、窓 clean）だけで、残りの variant は測っていない。run-report の problems はこの 1 件だけ。
   - **2 回目 `gold-s7r1-2`**：同じ候補 `3f333a83`・同じ S4b・**同じ setup（13 件の setup の sha256 は 1 回目の台帳と同じ。script が確認）**。2026-11-08T23:02:45Z〜23:49:40Z、13 variant すべて measured・valid・窓 clean、台帳 `completed`。**1 回目は precheck による停止**（測定の判定ではない）で、停止した variant は測られておらず、判定の対象になっていない。
   - **記録による裏づけ**：2 回目の Gold の 13 receipt すべての `priorAttempts.gold` は `gold-s7r1-1`（stopped、台帳の sha256 `e97ec4f7…`）を開示している（`frozen-k64-run.mjs:1681-1703` が前の Gold 試行を開示する）。取り直しはユーザーの決定による：integrator の記録 `handoff/nir1-night-20261109.md`（2026-11-09 の節。「同じ候補で Gold を 1 回だけ取り直し、並行して修正案を設計」。ユーザーの AskUserQuestion の回答）にあり、記録は contracts の外（integrator のセッションの引き継ぎ file）にある。取り直しの理由として記録されているのは V-10 の停止（precheck）で、「結果を見て選んだのではなく、1 回目は precheck 停止」という記述は同じ file の integrator の開示欄にある。**この S6 が言えるのは、台帳・receipt の記録が上の事実を示すことまで**。引用した記録（integrator の引き継ぎ file）の見出しの時刻（「08:20」「08:40」など）は、integrator が時計を読まずに付けた推定で不正確だった。その file に訂正（2026-11-09 09:20 JST）を追記済み。session の記録の timestamp では、ユーザーの回答「同じ候補で Gold を 1 回だけ取り直し、並行して修正案を設計」は 2026-11-08T23:00:12Z（08:00:12 JST）、台帳の `gold-s7r1-2` の開始は 23:02:45Z（08:02:45 JST）で、**決定は 2 回目の開始の約 2.5 分前、1 回目の停止（18:19:27Z）の後**。ただしこの S6 の集計そのものは、台帳・receipt の記録と integrator の記録を引用するだけで、決定の前後を独立に確かめてはいない。ユーザーが取り直しの決定の時点で見ていたのは 1 回目の停止の報告（4 番目の variant で `[precheck] V-10`）で、1 回目の 3 variant の数値を見たかどうかは、この集計では確かめられない（記録は未確認）。
   - **1 回目の 3 variant の数値（開示用。集計に数えない。判定に使わない）**。`gold-s7r1-2` の同じ variant の値と並べる（`s6-aggregation.json` の `gold1Disclosure.sideBySide`）：

| variant | 1 回目（数えない）first／follow／表示／欠落 | 2 回目（数える）first／follow／表示／欠落 |
|---|---|---|
| G-01/v1 | 30／0／30／0 | 30／0／30／0 |
| G-02/base | 9／21／30／0 | 3／27／30／0 |
| G-03/base | 30／0／30／0 | 30／0／30／0 |

   1 回目の 3 variant の `contributedNotCounted` は 0、束縛の照合は 2 回目と同じ（一致）。表示の欠落は 1 回目も 0 で、2 回目と同じ向き。G-02/base の first-render と follow-up の内訳は run ごとに違う（9／21 と 3／27。表示の合計は同じ 30）。
   - 製品側の事象（cold DB に `running` の dependency-verify が残ると、取消しの連打から registration refused を経て Suspended になりうる）は dev の fixture で再現済みで、V-10 は決定的でなく確率的と読まれている。修正案・lane の扱いは integrator の別の記録（`handoff/s7r1-fix-design/design.md`、`handoff/s7r1-dev-ready/results.md`）で、この集計の範囲外。
   - `.artifacts/cp4/abandoned/` は空（setup や run の失敗の退避はない）。setup の再実行の有無・開示は run record（統合者）に任せる。
2. **この run は K6/6 の下の 1 回目の正式の測定。K6/6 の first-render の数え方（R-6・R-7）は、前回（s6r1）の観測の後に起案した改訂で、今回の「欠落 0」はその数え方の下の値である**。
   - 前回の欠落 163／270 は、同じ型の sample（親が D＝40 ms の窓内に worker の Graph を受けた sample）を、harness が `readyFresh` と stamp の一致を理由に first-render に数えなかったことで出た。今回、**窓内に合流した親の数**は 156／270（G-01 30、G-03 30、G-06 30、G-08/base-usable 29、G-08/graph-recovered 30、G-05 4、G-02 3）で、前回の 163／270（G-01 30、G-03 30、G-06 30、G-08 の 2 variant 各 30、G-05 7、G-02 6）とほぼ同じである。**欠落 163 → 0 の差は、製品の挙動が大きく変わったためではなく、K6/6 が数え方を明文にした（R-6・R-7）ためと読める**。K6/6 自身が「観測の後の改訂」と開示している（K6/6 draft の冒頭の開示）。
   - **`readyFresh` は R1 の下で構造的に false**：Gold の定常状態は 270／270 が `notReadyAtStart`（K6/2 の字義）。K6/6 は `readyFresh` を条件に使わない。**鮮度の stamp は pool の 270 件のうち 269 件が `stamp0-missing`（製品が S0 を読めなかった）、1 件が `fresh`**（G-08/graph-recovered）。R-7 は `stamp0-missing` を数えるので欠落 0 になっている。K6/6 は ② の項目で `stamp0-missing` の親を落とせる形にしているが、今の harness では合流した親に対して実質無条件に当たる（K6/6 draft の「R-7 の実効」）。したがって、**stamp が読めなかった sample（269 件）を first-render として数えることが、欠落 0 の前提**である。pool の stamp の result に `unavailable`・記録なしは無く（`fresh` と `stamp0-missing` だけ）、`stale` で合流した記録（`[artifact]`）も無い（受領書は valid、`firstRenderNotCounted` 0）。
   - K6/6 の狭める防御（FR-2・FR-4〜FR-8 など）は受領書の `firstRenderNotCountedBy`／`Reasons` に反映されるが、全 variant で空（数えられなかった候補は 0）。この集計は FR の個別の判定を再計算していない（受領書の値を読むだけ）。
3. **K6/6 の残余（開示）の確認**：(2) 境界（`boundaryDisagreement`。許容 0.01 ms）は、Gold の pool の 9 variant すべてで `not-joined-in-time` 0・`joined-late-within-tolerance` 0。(3) 「次の sample の `preparesReady` との差」（(c)）が理由で数えられなかった親は 0（`firstRenderNotCountedReasons` は全 variant で空）。trace の editing の `not-joined-in-time` 2 は定常状態の規則ではなく (b) の窓外の開示（3 の (b)）。
4. **first-render の窓外率（K6/6 の条件で 114／270、42.2%）と K6/2 の字義の窓外率（270／270）は、どちらも記録と開示だけで、物差しではない**（K6/4 の批准 2・「変える点」の 1〜3、K6/6 の変える点 5）。これを HOLD の根拠にはしていない。かつ、隠してもいない。
5. **trace の K6/4 の再計算の再現性の限界**。`trace-k64-recompute.json` の K6/4 の読みは、候補 `3f333a83` で keep test を走らせて得た証拠（`evidence.rsJoinHook`。`candidate-test`、8 件 pass、`runDigest 7adf240f…`、lockfile の sha256 は worktree の `node_modules/.pnpm/lock.yaml` と一致、vitest 4.1.12）に依る。JSON に写した証拠だけから `summarizeTrace` を呼んでも K6/4 の読みになるかは確かめていない（前回の確認では、証拠だけだと regime が k62 になり再現できなかった。今回は再確認していない）。再現するには keep test の再実行が要る。
   - 基準の再現（keep test なしの封印した ancestor だけの証拠。`recompute-trace-base.mjs`）は、記録済みの要約と完全に一致した（editing・browsing とも regime k62、Q・U・lapse・outcomes・mainReason・notApplied が一致）。
   - trace を K6/4 で読み直したのは、前回と同じく S6 の分析での integrator の技術判断（候補は K6/4 の 3 つの要件を満たし、trace-runner が keep test を走らせないために記録が K6/2 になった）。受領書の K6/2 の要約は変えず、再計算を別に載せた。keep test は正式の測定がすべて終わった後に、候補 `3f333a83` の clean な worktree で走らせた。tracked file・untracked file は変えていない（実行の前後で `git status --porcelain --untracked-files=all` が空、`HEAD` は `3f333a83`）。ログは scratchpad（`/tmp/claude-1000/.../scratchpad/keep-log/`）にあり、記録には含めていない。
6. trace の取り直しは無い（両 trace とも attempt 1、`stalled` なし）。
7. 窓の sampler：Gold（13）・parity（12）・negative（3）は記録があり全件 clean。SP-P4 と trace は sampler の記録を持たない（設計）。
8. **parity の READY の非証拠**：parity は Graph arm を測らない（`gold-s7r1-1` の V-10 は parity が通った後に起きた）。parity の valid・clean は、Gold の worker が READY になることの証拠にはならない。
9. C7 の効果が正式の run で観測された（editing に 1 件。3 の (b)）。前回（s6r1）は外した begin が 0 件で、C7 は観測されていなかった（dev の予行では 1 件外した run があった）。
10. dev の診断 run・dev の予告・dev の確認（`handoff/s7r1-dev-ready/` の凍結外 fixture の測定を含む）は、この集計に入れていない。
11. 受領書は `.artifacts/cp4/`（候補の worktree。読むだけ）から読み、台帳は contracts の `attempts-final-s7r1/`（`.artifacts/cp4/attempts/` と byte 一致を確認）から読み、G-01 の診断の記録は contracts の `g01-e2e-s7r1-1/`・`g01-e2e-s7r1-1-report/` から読んだ。`.artifacts` の受領書と contracts の写しは全 file で byte 一致。
12. この集計の script は、前回の script を写して書き換えたもので、変更点は `scripts/s6-aggregate.mjs` の冒頭のコメントに書いた（許可リストの組と Gold の run、台帳 9 件の扱い、K6/6 の束縛、SOURCE_PINS、K6/6 の受領書の数値、3a の置き換え、C7 の開示欄）。実行は Node v24.18.0（fnm の既定）。同じ入力から 2 回実行して `s6-aggregation.json` が byte で一致した。

## 6. 前回（s6r1：S4b `63bc9b90`・候補 `a2309b95`・K6/5）との比較

前回の値は `../s6-aggregation-s6r1/s6-aggregation.json` と README から、今回の値は `s6-aggregation.json` から写した。**契約が K6/5 から K6/6 に変わっている（first-render の数え方）ので、定常状態の欠落の数は同じ物差しの比較ではない**（5 の 2）。

| 指標 | 前回（s6r1） | 今回（s7r1） | 物差し |
|---|---|---|---|
| 契約 | K6/5 | **K6/6**（R-6・R-7。K6/5 の D 40 ms・p95 94.2 ms などは同じ） | — |
| (a) Gold の pool の欠落（K6/4 の読み） | 163／270（表示 107、first-render 0、follow-up 107） | **0／270（表示 270、first-render 156、follow-up 114）** | 2 件 |
| 窓内に合流した親（定常状態） | 163／270 | 156／270 | — |
| 表示 0／30 の variant（K6/4:167） | 5 | **0** | HOLD（独立に当たる） |
| `contributedNotCounted` | （欄なし） | 0 | 0 を超えると品質 FAIL（v2） |
| (b) editing の失効（K6/4） | 1／201（0.50%。`i-b-seal`） | **1／201（0.4975%。`i-chronicle-stop`。C7）** | 許容 2 件（1%） |
| (b) editing の表示の欠落（K6/4） | 1／201（U 内 1） | 1／201（U 内 1。失効と同じ query） | 2 件 |
| editing の first-render／follow-up | 32／168 | 23／177 | — |
| (b) browsing の失効／欠落（K6/4） | 0／0 | 0／0 | — |
| browsing の first-render／follow-up | 2／199 | 3／198 | — |
| `i-chronicle-stop`（editing／browsing） | 0／0（C7 の外した begin 0） | **1／0（C7 の外した begin 1／0）** | — |
| K6/2 の読みの窓外（editing／browsing） | 169／199 | 178／198 | 超える（同じ型） |
| q1 の max（editing／browsing。K6/4 の follow-up） | 56.9／98.6 ms | **50.7／83.1 ms** | T_late 100 ms |
| ④ SP-P4 | passed、IR の期限切れ 0 | passed、IR の期限切れ 0 | 上限 6 |
| parity | 12 variant valid | 12 variant valid | — |
| 診断の負例 N2／N3／N4 | すべて measured・established | すべて measured・established | 判定に数えない |
| G-01 の e2e 診断 | reachedEndToEnd＝true | reachedEndToEnd＝true | 判定に数えない |
| Gold の run | 1 回（`gold-s6r1-1`、13 variant） | **2 回（`gold-s7r1-1` は V-10 で stopped、集計は `gold-s7r1-2`）** | — |
| 規則が指す先 | **HOLD に当たる（(a) の欠落）** | **HOLD にも `[precheck]` にも当たらない（可用性の物差しを超えるものが無い）** | — |

- 前回との差のうち、(a) の欠落の差（163 → 0）は、5 の 2 のとおり**数え方の改訂**によるところが大きい。q1 の max（browsing）は、前回は 100 ms まで 1.4 ms の余裕しか無かったが、今回は 83.1 ms で余裕が増えた。この変化が製品の変更によるのか run のばらつきなのかは、この 1 回の run からは言えない。
- 品質判定 v2 の p95（R+IR arm・Graph arm）は、この集計の対象外（`../quality-verdict-s7r1-1/` を参照）。
