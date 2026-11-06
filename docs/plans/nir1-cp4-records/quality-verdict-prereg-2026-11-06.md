# CP-4 品質の判定の段：事前に固定する定義（事前登録。2026-11-06）

> 状態：実装・実行の前に固定した定義（判定の結果ではない）。設計は `quality-verdict-design-2026-11-06.md`、ユーザーの決定（2026-11-06）は (i) 入力が揃う条件だけ判定し残りは `not-evaluable` で開示、(a) 手順外の補助の記録（S2・S4 の freeze は触らない）、対象は s5r6（候補 `cbf33077`）の受領書。
> 製品・harness・S2・S4 の bytes、閾値、fixture、Gold は変えない。pin 済みの file（`outcome.mjs`、`receipt.mjs`、`constants.mjs`、`k64-runner.mjs`）は import するだけ。

## 0. 観測の規律と、定義の前に見たもの

- **定義の前に見たもの（開示）**：受領書の構造確認として、(1) `samples[]` のキーと G-01／G-04 の Graph arm の sample 1 件ずつの全文、(2) 13 variant の Graph arm の measured 30 件ごとの `graph.outcome`・`followUp.child` の `outcome／contributionBasis／expectedContribution／materialRevision の matched 件数と unresolvedEdges／publishCount／currentAtDisplay／lateGraphInDisplay` と parent の `lateGraphInDisplay／publishCount` の集計表を 1 回見た。この集計は §6 の edge の束縛と §7 の (b) の件数に関わる（定義を選ぶ前に、その件数の概形を見たことになる）。(3) fixture（事前指定の期待値。観測ではない）の `expectations.metrics`、`forbiddenSceneIds`、`blockedCandidates`、`pathAttachments`、`addedScene`。
- **見ていないもの**：Graph arm／R+IR arm の Recall・nDCG の計算値、p95（`tReturn − tFetch` の分布）、macro の値。参考値の p95 は見えているが、定義はその値に合わせて選んでいない（§4 は P の定義 `evals/nir1-retrieval/manifest.json:130-140` の字義どおり）。（→ 末尾の「訂正（2026-11-06、受入れレビューの後）」を見よ。ここの「見ていない」は誤りで、撤回している。）
- 以降の定義は、実行の後に変えない。変える場合は新しい版の事前登録を作り、変更前の結果を残す。

## 1. 位置づけと入力

- 判定の段は「S2 の手順が定めた測定に、事前登録の条件を後から当てる記録」で、測定の一部ではない（(a)）。受領書は書き換えない。出力は別 file の JSON と Markdown の要約。
- 入力は、許可リスト `(s4Commit, candidate.commit)` を通った受領書だけ。受領書ごとに `head.observationPrep.commit`、`candidate.commit` が許可リストと一致し、`preview === false`、`verdict.outcome === "recorded"`、`runKind` が gold（13 variant）／parity（12 variant）であることを要求し、満たさなければ `[precheck]` で止まる。`selectReceiptsForAggregation`（`receipt.mjs`）が 1 件でも除いたら `[precheck]`。`<名前>.validation.json` があれば `valid: true`、`files.sha256` があれば受領書の sha256 の一致を要求する。
- 判定に使う母集団は **Gold の受領書（13 variant）だけ**。parity の受領書（12 variant、hybrid だけの unrestricted）は、sha256 の束縛と p95 の開示（判定に数えない）にだけ使う。
- variant が blocked かは、受領書に判定の記録が無い（recompute README）。台帳（`attempts-final-*/<run>.json` の `variants`）を任意の入力に取り、`blocked:*` の variant を macro・p95 から外す。台帳が無いときは「blocked の判定を取り込まず、全 variant を数えた」と出力に書く。受領書も台帳も無い variant があれば `[precheck]`。

## 2. 共通の読み

- **対象の sample**：`phase === "measured"` かつ `trigger === "user-operation"`。warm-up は入れない。Graph arm と R+IR arm（`arm === "hybrid"`）を `repeat` で対にし、各 arm はちょうど 30 件（`MEASURED_RUNS_PER_ARM`）。違えば、その variant の条件は `hold`。
- **ID**：`finalSceneIds` の runtime UUID は、受領書の `settings.setupReceipt.logicalToRuntime.scenes` の逆引きで論理 ID にする。未対応の UUID が 1 件でもあれば `[precheck]`。逆引きが 1 対 1 でなければ `[precheck]`。
- **期待値**：fixture（`FROZEN_FIXTURE_SHA256` の sha256 を照合してから読む）の Gold 等級（`scenes[].gold`）、`eligibleSceneIds`、`expectations.metrics`。G-01 の「事前指定改善」は manifest（`evals/nir1-graph/manifest.v1.json`）の `cases[].predeclaredImprovement` が `true` の case（G-01 だけ）。期待値が無い、または G-01 以外が `true` なら `[precheck]`。
- **Recall／nDCG**：`scripts/quality/nir1-retrieval/contract.mjs` の `scoreQuery`（k は同関数の既定。結果が eligible でない・重複するときは、その variant の条件を `hold`）。
- **許容誤差**：metric の比較は K6/2（`K62_FREEZE`、sha256 を照合）が定める既存の評価式と同じ許容誤差（`1e-12`）。script には書かず、K6/2 の本文から読む（読めなければ `[precheck]`）。
- **状態の語**：`pass`（計算でき、成立）、`fail`（計算でき、測定が条件を破った）、`hold`（入力はあるが測定が足りず決められない、または期待値と観測が違うまま Hold として残す〔manifest `comparison.failure`〕）、`not-evaluable`（受領書に入力が無い）、`n/a`（その variant に適用しない）。条件の状態は components のうち `fail` > `hold` > `not-evaluable` > `pass` の最悪で決める。
- **全体の verdict**：5 条件がすべて `pass` のときだけ `pass`。それ以外は `hold`（理由：`failed-required-items`、`held-required-items`、`unverified-required-items`）。`not-evaluable` を `pass` に読み替えない。

## 3. Graph arm の「最終一覧」と graph-late の child の読み

- 親は `graph-late`（D の窓の後に Graph が届く設計）。利用者に表示される一覧は、harness の displayed 判定と同じ読みにする：`classifyFollowUp(sample, { context: "steady" })`（`followup.mjs`）の `displayedSceneIds`（first-render なら親の `finalSceneIds`、follow-up なら **子**の `finalSceneIds`）。
- **子の読み**：follow-up が成立した sample では、Graph arm の評価対象は子の `finalSceneIds`（親の一覧ではない）。表示されなかった sample（first-render も follow-up も無い）は品質の計算に入れず、件数を開示する（表示は 1 件以上必要。0 件は `hold`）。表示された一覧がすべて同じでなければ `hold`。`classifyFollowUp` の `violations`（N1 など）が 1 件でもあれば `fail`。
- 期待 Graph が `unavailable` の variant（G-03/frontier-exceeded、G-08 の 4 件）は、harness の `unavailableQuality` と同じ読み：親・子の表示がすべて対の R+IR と同じ一覧で、Graph が合流（`graph.joined`）も表示（子が `graph-ready` かつ `edgeCount > 0`）もしていなければ、Graph arm の一覧は R+IR と同じとする。違えば、その差を禁止寄与の候補にして `fail`。
- R+IR arm の一覧は `hybrid` の `finalSceneIds`。30 件が同一でなければ `hold`。

## 4. 条件 3：Hybrid p95 ≤ 上限（P の定義）

- **統計量**：`p95(t_return − t_fetch)`（`tReturn − tFetch`。`tRawReady − tFetch` ではない）。nearest-rank `sorted[ceil(p·N) − 1]`（`nir1-retrieval/contract.mjs` の `nearestRank`）。百分位は manifest の `performance.warm.B` の `p95(...)` から読む。
- **上限**：manifest の `hybridP95Limit` が `"B+D"`、`D` が `min(100ms, c*B)`（c は manifest の文字列から読む）。D は `GRAPH_EVAL_D_MS`（import するだけ）。D が cap 未満のとき B = D / c、上限 = B + D（有効数字 12 桁に丸める）。cap 以上なら B が導けないので `[precheck]`。
- **母集団**：Gold の受領書の measured の全 variant（blocked を除く）を **arm ごとに**プールする（13 variant × 30 = 最大 390 件／arm）。24 query × 30 の P の母集団とは別で、出力に明記する。
- **判定**：Graph arm と R+IR arm の**両方**が上限以下のときだけ `pass`（Graph を入れた利用者の待ちも P の予算に入る。厳しい側）。どちらかが超えれば `fail`。measured の sample に status が `completed`／`ok`／`completed-safe-fallback` でないもの、または非有限・負の時間があれば `fail`（`summarizeWarm` と同じ。失敗した call は落とさない）。variant ごとの p95 と parity の p95 は開示（`countsInVerdict: false`）。
- 本測定の P（24 query × 30、Raw-only の B の測り直しを含む）の代わりではない。G-case の母集団で測った p95 が上限に収まるかを見る補助の判定。

## 5. 条件 1：G-01 の事前指定改善、条件 2：macro 非回帰

- **G-01**：G-01/v1 の R+IR arm の一覧の指標を H、Graph arm（§3）を G とする。次をすべて満たせば `pass`：(1) H が fixture の事前指定 `rPlusIr` と許容誤差内で一致、(2) G が事前指定 `rPlusIrPlusGraph` と許容誤差内で一致、(3) G の nDCG が H の nDCG を許容誤差を超えて上回り、Recall は H を下回らない。改善はあるが (1)(2) が違う場合は `hold`（観測と期待が違う）。改善が無ければ `fail`。表示・一覧の条件（§2 §3）が満たされなければ `hold`。
- **macro の範囲**：G-case の variant だけ（blocked を除く。台帳が無ければ 13 件）。Recall@8 と nDCG@8 のそれぞれの単純平均（variant 平均）を、R+IR arm と Graph arm で比べ、Graph が R+IR を許容誤差を超えて下回らなければ `pass`。期待 `unavailable` の variant も、Graph arm の一覧（= R+IR の一覧）で数える。
- **既存 24 件の Graph arm は `not-evaluable`**：manifest は macro を「既存 24 件＋G-01〜G-08」と読む。24 件の Graph arm の受領書は無いので、macro 条件は components（`g-case`、`existing-24-graph-arm`）に分け、後者を `not-evaluable` で開示する。したがって macro 条件の状態は G-case が `pass` でも `not-evaluable` になる（G-case の部分の結果は components に残す）。
- variant ごとの行の macro は、その variant の Graph が R+IR を下回らないか（内訳。合否は集計の値で決める）。

## 6. 条件 4：Evidence の部分判定（edge の束縛だけ）

- 全体（UTF-16 範囲、pin、Raw excerpt の不変、追加 Scene の本文 anchor）は受領書に入力が無い。`requalification: passed` は推論値（`k64-record.mjs:300`）で根拠にしない。これらは components で `not-evaluable`。
- **部分判定「edge の束縛」**（`materialRevision`）：期待の寄与は fixture から作る（G-01 は `expectations.graphPath`、G-02 以降は `expectations.addedScene`〔kind `graph-only`〕と `expectations.pathAttachments`〔kind `path-attachment`〕。各 Scene の期待 edge は `path.edgeIds`）。期待のある variant の Graph arm の各 sample について、子が `graph-ready`、`contributionBasis === "material-revision"`、`materialRevision.unresolvedEdges === 0`、`observed` の (kind, sceneId, `pairs` の `revision|edge` の edge の集合) が期待と**ちょうど**一致（余分な entry も不可）、を要求する。1 つでも破れば `fail`。子が無い・`graph-ready` でない sample は検査できないので数えず（`skipped`）、検査した sample が 0 の variant は `hold`。期待の寄与が無い variant（unavailable など）は `n/a`（Graph の edge が出ていないことは §7 で見る）。
- 集計：適用する variant の検査件数と合否を出す。edge の束縛が `pass` でも、条件 4 は `not-evaluable`（他の部分が無い）。

## 7. 条件 5：禁止寄与（(a)(b) だけ。(c) は `not-evaluable`）

- **(a) 禁止 Scene・blocked 候補**：Graph arm の sample ごとに、利用者に出た一覧（親の `finalSceneIds`、および `publishCount > 0` の子の `finalSceneIds`。表示の成否にかかわらず厳しい側）から、同じ `repeat` の R+IR の一覧を引いた集合を **Graph の寄与**とする。寄与が fixture の `forbiddenSceneIds` または `blockedCandidates[].sceneId` に 1 件でも入れば違反。R+IR の一覧にも入っている禁止 Scene は寄与ではなく、「基準側にある」として開示する（件数は条件に数えない）。期待の追加・差し込み以外の寄与（期待の外の追加）も件数を開示する（条件には数えない）。
- **(b) 遅れた Graph の混入**：Graph arm の sample ごとに、親と子の `lateGraphInDisplay === true` または `publishCount > 1` があれば違反（`classifyFollowUp` の N1 系の `violations` も違反に数える）。
- **(c) 既存 24 件の Graph の出現、Graph DTO の node／path**：受領書に記録が無い。`not-evaluable`。
- 違反が 1 件でもあれば `fail`。(a)(b) が 0 件で `pass` でも、条件 5 は `not-evaluable`（(c) が無い）。

## 8. 束縛と出力

- 出力 JSON に、受領書（Gold・parity、各 sha256）、許可リスト file、台帳（任意）、procedure `k64-procedure.v1.json`（受領書の `settings.k64.procedureFile.sha256` との一致を要求）、graph manifest・retrieval manifest、fixture、K6/2 の本文、script 自身と import する pin 済み module（`followup.mjs`、`receipt.mjs`、`constants.mjs`、`join.mjs`、`nir1-retrieval/contract.mjs`）の sha256 を書く。後から `--verify` で再計算して照合できる。
- 閾値は script に数値で書かない（D は `GRAPH_EVAL_D_MS`、百分位・係数・上限の式は manifest、許容誤差は K6/2 の本文）。

## 9. 確かめられないこと（定義の限界）

- 24 件の Graph arm、Evidence の UTF-16 範囲・pin・Raw excerpt・追加 Scene の本文 anchor、node／path の DTO は受領書に無い。これらを揃えるには harness と受領書の schema を足す必要があり、S2 追補・S4 の再凍結・再測定を招く（設計 §3 (ii)）。この段では扱わない。
- blocked の判定（`cb4-inputs` など）は台帳の `variants` の値に頼る。
- G-case の母集団の p95 は、P の 24 query × 30 の p95 とは別の量。

## 訂正（2026-11-06、受入れレビューの後）

本文（確定版）は書き換えない。受入れレビュー（Opus）の指摘 P2-1・P3 を受けた訂正である。

- **(a) 値は既知だった**：§0 の「見ていないもの」（Recall・nDCG の計算値、macro の値）は誤り。contracts `44e3aa44`（2026-11-03）が s5r6 の受領書から 13 variant×3 arm の Recall@8・nDCG@8 と macro（recall 0.0385→0.4615 ほか）を 2 つの独立な計算で出して記録済みだった。設計 `cec52711` の 25 行も G-01 の値と child の読みの分かれを引いている。
- **(b) 「先に固定」は git で示せない**：この prereg の commit は結果と同じ `0f1962de`（2026-11-06 22:27:58）で、出力の生成（22:25）の後に入っている。「実行の前に固定した」「値を見る前に固定した」とは git の履歴から言えない。
- **(c) 読みの選択は結果を変えない**：レビューは、child の読み（(a) 子の `finalSceneIds`／(b) 親の一覧）と macro の範囲（13 件／8 件）のどちらを選んでも結果が pass で変わらないことを確認済み。
- **(d) 撤回**：定義が結果に合わせて選ばれた形跡は無い。ただし「定義は値を見る前に固定した」という主張は撤回する。この定義は、値が既知のうえで、設計と P の定義の字義から書いたものと読むこと。
- **§4 の「厳しい側」は言い過ぎ**：Graph arm の p95 は親の `tReturn − tFetch` で、follow-up（子）の表示までの待ちを含まない。Graph を入れた利用者の待ちを全部見ているわけではないので、Graph arm の pass は「親の返却が上限に収まる」の意味に限る。
- **再実行（P2-2・P2-3）**：受入れレビューの後、(1) 期待 `unavailable` の variant で「親・子の表示が対の R+IR と同じ一覧（順序を含む）」を `fail` の条件に足し（§3 の記述どおりの実装）、(2) 許可リストを `quality-verdict-s5r6-1/` に写して file 名で束縛し直した。同じ入力で 1 回だけ再実行し、`quality-verdict-s5r6-1/` の JSON・md・SHA256SUMS を置き直した。コードは実装 worktree の `b44c4717`（枝 `claude/cp4-quality-verdict`）。許可リストの写しは `allow-list-s5r6-s4-3734e501-candidate-cbf33077.json`（sha256 `6c95f736…4989`、元と同じ）。判定（`hold: unverified-required-items`、他の条件は pass）は変わらない。結果 JSON の bindings 以外は再実行の前後で同一。
