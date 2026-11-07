# G-04 fixture v2（案 C）B1 の独立コードレビュー（read-only）

- 対象：`/home/grimodex/worktrees/Grimodex/claude-g04-v2c`（`claude/g04-v2c-fixture`、基点 `8187fbfc`、HEAD `ae5de27e`、8 commit）
- 日付：2026-11-01。Node v24.18.0（fnm）。CI の Node 22 では走らせていない。
- 読まなかったもの：contracts の `gold-s5r4-1/`、`traces-*`、`parity-*`、`negatives-*`、`s6-aggregation-s5r4/`、`s7-report-*`、`.artifacts/cp4/`。
- repo の変更：なし。worktree の `git status --short` は終わった時点で空（0 行）。変異の試験はすべて scratchpad の写し（`g04c/b1/mut-root`、`git archive HEAD` の展開）と、基点の共有 clone（`g04c/b1/base-clone`）で行った。

## 結論：(b) 修正してから受入れ可

P1 なし。P2 2 件、P3 6 件。規則文の意味は変わっていない（下の 1）。validator の観測後の検査は一般的な迂回路になっておらず、G-04 以外の fixture を v1 の freeze に束縛する検査は変異で確かに落ちる。直すのは記録の正確さと手順の順序で、期待値・fixture の bytes・閾値に触れる修正は要らない。

---

## 1. 規則文の意味の判定（ユーザーの確認の範囲 3）

判定：**id・scope・判定の意味・`closedSet` は変わっていない。列挙 3 か所は変わっていない定義節から導かれる。列挙でない改訂（README:274-276 と `holdVersusBlocked`）は、ユーザーが質問 2 で明示的に確認した範囲（README:265-266 と `graphRuntimeObservedBeforeFreeze`）と設計 A §5.3／C §7.3 に収まる。緩和は紛れていない。**

(a) id・scope・`closedSet`・`notEvaluated`・outcome の規則
- `git diff 8187fbfc..HEAD -- evals/nir1-graph/manifest.v1.json` で、`preconditions.definitions[*].id`／`scope`、`cb4-inputs.notEvaluated`、`variantScope`、`addedSceneScope`、`closedSet`（manifest:207。"None is added, removed or reinterpreted after a runtime observation" はそのまま）、`observationPolicy`（manifest:7）は変わっていない。
- 機械的にも確かめた：freeze.v2 の `changesAfterApproval` の範囲の外を、基点の manifest（6958613f…）・README（fed96a76…）・schema（2ffd7591…）から `contentOutsideScope` で計算し直すと、宣言の `approvedSha256OutsideScope`（7ece9f1b…、23dc14fd…、727d1ea6…）と一致した（`g04c/b1/scope.mjs`）。変異で、id／scope／`notEvaluated`／`closedSet`／`ir-supplement-admission.check`／`observationPolicy` を変えると「changed outside its declared scope」で落ちる（`g04c/b1/mutate.out`）。

(b) 変わったのが列挙だけか
- `raw-membership.check`（manifest:171）："the two controls of a supplementable case" → "the controls of a supplementable case (two, or the single control of G-04)"。判定の文 "The observed R membership equals expectations.arms.raw.sceneIds" は同じ。括弧は `arms.raw` から読める件数の説明で、validator も件数を検査しない（v2 が誤り 0 件で通る）。判定の意味は同じ。
- `ir-supplement-admission.appliesTo`（manifest:177）：定義節 "Variants with a usable Chronicle Index in a case that declares an ir-only Scene" は同じで、列挙が "G-04 (g04-lio-landing) and G-05" → "G-05" になった。v2 の G-04 は ir-only を持たないので、定義節から導かれる。
- `cb4-inputs.appliesTo`（manifest:191）：定義節 "Variants that declare an appended Graph-only Scene" は同じで、G-04 base が足された。v2 の G-04/base は `appendedSceneId` を持つので、定義節から導かれる。
- `irSupplementedCoverage.cases`（manifest:210）：`["G-05"]`。`dependsOn` と `consequence` は同じ。
- README の前提条件の表（:87-96、`raw-membership` は :91）、:109、:139、:173-174、:188-189、:216 は manifest の列挙を繰り返すだけ（:188 の probe の記述は `admissionProbe` の事実の更新）。

(c) 観測の後の版の規則が既存の規則を弱めていないか
- 前提条件の規則「観測の後に足さず、外さず、読み替えない」（README:105）と `closedSet` は bytes が同じ。新しい文はこれを弱めない。
- README:274 は「観測の前に限り、…やり直す」→「観測の前は、…やり直す」。README:275 は観測の後の版を固定済みとして扱う条件（ユーザーの確認、`postObservationRevisions`、新しい独立期待値レビュー、前の版と結果を残す）を足した。README:276 は「この版」→「その版の bytes」。**これは列挙の更新ではなく、v1 の freeze の規則の緩和（観測の後の改版の道を開く）**である。ただしユーザーは質問 2 で「README:265-266、`graphRuntimeObservedBeforeFreeze`」を名指しして確認しており、設計 A §5.3 が「v2 はこの規則自体を観測の後に改訂する」と書いた案（文案もほぼ同じ）の内側にある。条件を足す形で、前提条件・期待値・Hold と blocked の定義は変えない。
- `holdVersusBlocked`（manifest:206）は既存の 2 文を残し、README:275 と同じ文を 1 文足しただけ。Hold と blocked の定義は同じ。
- 文は一般形（G-04 に限らない）だが、validator は `POST_OBSERVATION_CHANGE_SCOPES` の `/cases/3`（G-04 の行）だけを manifest の case で許し、superseded の freeze を定数で固定するので、validator を変えずに他の case を作り直すことはできない（下の 2）。

(d) 緩和が紛れていないか
- floor／gate／救済の下限／δ／1% の数値、Gold（`goldDefinition`、各 Scene の Gold、`answerEntityIds`）、pool の作り方、F6・X5、blocked と Hold の定義のどれも、manifest・README・fixture・harness の差分にない。fixture v1→v2 の差は構造比較で `fixtureId`、`slotClass`、`scenes`（lio-landing の role、rv-match／rv-unknown の body）、`pins`、`qualifiedIr`、`positive`、`measurementBoundary.graphConnection`／`rawPrediction`、variant の `description`／`preconditions`／`arms.rPlusIr`／`arms.rPlusIrPlusGraph`（`appendedSceneId`）／`pathAttachments`／`addedScene`／`blockedCandidates`／`evidence.requirements`／`metrics.rPlusIr` だけで、freeze.v2 の `changedFields` と一致した。
- 注記：`observationPolicy`（"Do not change … corpus … after observing"）は文のまま残り、v2 は G-04 の corpus を観測の後に変えている。設計は「新しい版の手続きの内側」と読み、README:275 と `postObservationRevisions` がその読みを書いている。ユーザーは質問 4 でこの弱点の開示つきで進めることを確認した。欠陥とは扱わない。
- `admissionProbe` "not-run"→"run" は record-only（consumer は contract.mjs の一致の検査だけ。git grep）。根拠の G-05 の IR の値は設計 A 付録 A の「測定に数えない」校正 probe で、freeze の reason がそれを開示している。読み方は I5 で integrator に返されている。

---

## 2. validator（`scripts/quality/nir1-graph/contract.mjs`）

- (a) 一般的な迂回路か：**なっていない。** `graphRuntimeObservedBeforeFreeze: true` は、`postObservationRevisions`（freeze と manifest の両方、同じ case）、`supersedes`（`NIR1_GRAPH_SUPERSEDED_FREEZE` の path・sha256・commit に固定、contract.mjs:63-67）、v1 の freeze が repo に pin した bytes で残ること、作り直していない全 case が v1 の freeze の `cases` と path・sha256 で一致すること（:2429-2438）、`/1` 以外の fixtureId は作り直した case だけ（:2442-2447）、`graphOutputUsed: false`、`userConfirmation`／`expectationReview` の記録と commit を求める。変更範囲は `POST_OBSERVATION_CHANGE_SCOPES`（:137-163）の固定した pointer に限られる。
- (b) G-04 以外を v1 に束縛する検査が効くか：**効く。** 写しで G-05 の bytes を変え、freeze の `cases` と `filesAtReview` を新しい hash に結び直しても「G-05 is not a declared post-observation revision」で落ちた。freeze だけに G-05 の行を足す、`supersedes` を消す、freeze.v1.json や G-04 v1 を 1 byte 変える、`from.sha256` を変える、manifest の `postObservationRevisions` を消す、freeze だけ false にする、のどれも落ちた（`g04c/b1/mutate.out` の 27 項目、すべて期待どおり）。
- (c) v1 の厳しさ：**弱めていない。** 写しで validator の freeze path だけを freeze.v1.json に戻し、基点の manifest・README・schema を置くと、新しい validator は誤り 0 件で v1 を受け入れた。そこに `postObservationRevisions` や true を入れる、README の範囲外の節を変える、はすべて落ちた。v1 の scope（`CHANGE_AFTER_APPROVAL_SCOPES`）は変わっていない。round ごとの reviewer の検査（:2250-2268）は強める向きの追加。
- (d) freeze.v2.json と v1 の整合：round 1〜3、global reviewer、`reviewReceipt`／sha256、`reviewedBy`、`schemaVersion`、`status` は v1 と同じで、`cases` は G-04 だけが違う（node で確かめた）。`pendingReview` は P2-1 を参照。
- 範囲の粗さ（P3-3）と、範囲外の hash を freeze 自身が申告する形（P3-4）は下に書いた。

## 3. 試験

- G-04 から G-05 に移した 4 つの試験（resultKind、前提条件の列挙、`ir-supplement-admission` を外すと拒否、`blocked:ir-supplement-admission`）は、assertion の形とメッセージが同じで、G-05/base は `ir-supplement-admission`（`g05-xan-watch`）と `irSupplementSceneId` を持つので同じ性質を同じ強さで検査する。「Raw-full and IR-supplemented cases never append」から G-04 の行が外れたのは v2 の区分の帰結（G-05 は残る）。差分で消えた `assert` は 4 行で、どれも v1 の値（false、a153743b、json-keys の scope）を v2 の値に置き換えたもの。
- v2 の新しい試験は、validator の変異で落ちる：非宣言 case の v1 束縛（VM1）、`/2` の検査（VM2）、`graphOutputUsed`（VM3）、round の reviewer（VM4）、allowed に `closedSet` を足す（VM7）、配列 pointer の扱い（VM8）。**落ちない変異が 3 つある**（P3-5）：VM5 manifest の行との一致（:2484-2492）、VM6 新しい file と fixtureId の要求（:2466-2472）、VM9 `changedFields`／`observedRuns` の要求（:2493-2501）。
- harness の試験の期待の変更（`frozen-setup-complete`：G-05/base に移す、IR の表 10→9 行、`frozen-setup-plan`：宣言 6 run と G-04 の folder が control だけ、`outcome`：catalog に G-04/base、`irSupplementSceneId` null、`frozen-setup-driver`：G-05/base）は、v2 の qualifiedIr が control 1 行、`declaration` true から導ける。

## 4. harness の定数（`scripts/quality/nir1-graph-eval/constants.mjs`）

- 変更は `GRAPH_CASE_FREEZE`（freeze.v2.json、`847e98bd…`＝実 file の sha256）、`FROZEN_FIXTURE_SHA256` の G-04（v2、96d44ec3…）、G-04/base の `declaration` true と fixturePath、コメントだけ。`seed-pin-setup.mjs`:141-165（SP-N8）が freeze の束縛する manifest・schema・README を照合するので、freeze の向け先の変更は必要。`declaration` true は plan が `cb4-inputs` から宣言の Scene を導くため必要（DR の追記どおり）。最小と判断する。
- freeze.v1.json の consumer（git grep）：S2 `observation-prep.v1.json`:45、S4 `observation-prep-freeze.v1.json`:9、作者の宣言 :45、seed-pin addendum :18、宣言の addendum :25、G-01 setup addendum :30、`quality-manifest.yaml`:690、S2 validator `observation-prep.mjs`:1342 と :4251（path を直書き）。どれも v1 の bytes が残るので今は壊れない（`pnpm eval:fixtures` は exit 0、nir1Graph／nir1FinalRequest／nir1ObservationPrep は passed、誤り 0）。ただし nir1ObservationPrep の `formalReady: true` は v1 の freeze に対する判定で、harness（v2）と食い違っている（P3-6）。
- S2 の pin：`observation-prep.v1.json`:923-928 が `constants.mjs` を commit `9e1a564e` の bytes `579959656ee9…`（基点の bytes と一致）で pin している。現在の bytes は `c34b8986…`。実装担当の報告どおり。

## 5. 落ちる試験

- 基点（scratchpad の共有 clone を `8187fbfc` に置き、`refs/remotes/origin/master` を本物の値〔8187fbfc〕に合わせた）：nir1-graph **115/115**、nir1-graph-eval **601/601**。最初は clone の origin/master の違いで observation-prep.test の 3 件（#82、#89、#98）が落ちたが、ref を合わせると通った（環境の差）。
- HEAD（worktree）：nir1-graph 117 件中 115（B1 が 2 件足した）、落ちるのは observation-prep.test の #31「the draft copy of the committed S2 validates as a draft」と #32「a draft with placeholders is never usable for a formal run」。理由は `assertObservationPrepFormal` が「setupReadings.source.pins t14-k64-freeze: constants.mjs must be the bytes…」で、期待の placeholder／draft の前に pin で止まること。nir1-graph-eval 601 件中 595、落ちるのは frozen-k64-plan.test の 6 件（#206、#207、#208、#210、#211、#212）で、全部「S5 G-04/base: the plan declares g04-lio-landing, the addenda null」（#208 は期待のメッセージの前にこれで止まる）。
- 性質：前者は S2 追補で constants.mjs の pin を更新すれば直り、後者は宣言の addendum の新しい版で G-04/base の宣言が入れば直る形。両方とも fail-closed（正式の門が止まる向き）。
- ほかに落ちる試験はない：`impact-map.test.mjs` と `eval-fixtures.test.mjs` は 52/52、`quality-workflow.test.mjs`（設計 C §7.1 の「影響は無い見込み」の 1 つ。quality-manifest.yaml を B2 に回したことの確認）は 23/23、`pnpm eval:fixtures`（`node scripts/quality/eval-fixtures.mjs`）は exit 0。

## 6. DR の正確さ

- 引用の hash は全部一致した：ユーザーの確認 `a7027915` の file の sha256 `1de09724…`（作業 tree と commit の両方）、再 probe の README `6e7c5aad…`（`a27660e0`）、レビューの README `1e80a44f…`・本文 `fdd8a01e…`・`derivation-before-design.md` `2eb8ec09…`・`v2-final.json` `96d44ec3…`（`8857f618`）、設計 C `ae03f258…`（`700ff053` と同じ bytes）、設計 A `6c3c9020…`（`68f7da60` と同じ bytes）。
- 除外6項目の欄：G4-2 だけが「新しい契約・authority にあたる（確認済み）」とし、ほかは「ない」。確認の範囲（質問 3）と合う。G4-3 の「閾値を変えていない」は probe-v2c の記録に依るもので、script そのものは読んでいない（**確かめられなかった**）。
- 食い違い：P3-1、P3-2、P3-6 の DR 追記の漏れ（下）。DR-CP4-G4-5 の「validator の判定の code（`requiredPreconditions`、`checkPreconditions`、`resolveVariantOutcome`）を変えない」は差分と一致する。

## 7. bytes

- `git show HEAD:evals/nir1-graph/g04-scope-exact-unknown.v2.json | sha256sum` ＝ `96d44ec362f30352d6cb971c208f2ab71aed944d008cab9eb65ca2ab57c218e1`。
- `git diff 8187fbfc..HEAD -- evals/nir1-graph/freeze.v1.json evals/nir1-graph/g04-scope-exact-unknown.v1.json evals/nir1-graph/independent-expectation-review.v1.json` は空。freeze.v1.json は `6080530a…`、最後に書いた commit は `a789039a`（定数と一致）。

## 8. 製品が qualifiedIr の無い Scene に IR を作らないか

- `setup-main-build.mjs`:83-110 の `irTableRows` は fixture の `qualifiedIr` の行だけから表を作る。`electron/main/productJourneyNir1Ai.ts`:40-45 は本文が表と一致しない Scene に `null` を返し、一致しても `interpretationSeed` が無ければ throw する。v2 の lio-landing は表に行が無いので、決定論の provider は IR の材料を返さない。plan の qualified-ir の段も qualifiedIr の Scene だけを folder に包む（frozen-setup-plan.test の 9 行）。
- `null` を受けた Chronicle の抽出の後段の挙動と、測定の Main（製品の corpus.json）で同じことが成り立つ経路は読んでいない（**確かめられなかった**。provider の水準では成り立つ）。

---

## 指摘

### P2-1 `pendingReview` の範囲と、閉じる順序
- 根拠：`evals/nir1-graph/freeze.v2.json`:705。文は「規則文の列挙の更新で意味が変わっていないか」だけを未了とし、「integrator が行う」と書く。
- (i) 範囲が足りない：round 4 が見ていない改訂は列挙だけでなく、README:274-276 と `holdVersusBlocked` の規則の文、`admissionProbe` と `probeOption`、`coverageGaps` の追加、`afterApproval` の文も含む。(ii) ユーザーの確認は「独立期待値レビューで確かめ、記録に残す」で、integrator 自身の確認では足りない。(iii) validator は `pendingReview` を見ないので、機械の門になっていない。
- 順序の害：`pendingReview` を閉じるには freeze.v2.json を書き換える必要があり、`GRAPH_CASE_FREEZE.sha256`（constants.mjs:110）が変わり、constants.mjs の bytes が変わる。S2 は constants.mjs の bytes を pin する（observation-prep.v1.json:927-928）。S2 追補の後に閉じると、S2 の pin が再びずれる。
- 修正：このレビューを記録先にして、S2 追補より**前**に `pendingReview` を閉じる（記録の path と commit、判定、範囲を書く）。そのあとで `GRAPH_CASE_FREEZE` を直し、それから S2 の pin を取る。閉じない場合は、範囲を (i) まで広げ、担当を「独立レビュー」に直す。

### P2-2 DR の追記が落ちる試験 8 件のうち 2 件を書いていない
- 根拠：`docs/plans/nir1-lane-decisions/cp4-decisions.md` の「G-04 fixture v2 の実装後の追記」は frozen-k64-plan.test の 6 件だけを書き、observation-prep.test の #31／#32（`assertObservationPrepFormal` が constants.mjs の pin で止まる）を書いていない。同じ追記の「`pnpm eval:fixtures` はこの状態で通る」は正しいが、正式の門（S2 の formal）はこの branch では止まる。
- 害：Quick は impact の段だけ（`scripts/local-ci-registry.json` の `profiles.quick`＝`["impact"]`、`eval:impact`）で、`evals/nir1-graph/**` の変更は narrative-semantic-contract の面を選び（`evals/impact-map.yaml`:366-368）、その command に observation-prep.test（`scripts/quality/impact-map.mjs`:519）と frozen-k64-plan.test（:586）がある。このため branch 単体の Quick は赤くなる見込み（Quick 自体は走らせていない）。merge の前に、B2（S2 追補、宣言の addendum の新しい版）と同じ PR にするか、順に入れることを PR 本文と DR に書かないと、merge の門の判断を誤らせる。
- 修正：追記に 2 件と理由（S2 の pin 579959…→c34b8986…）を足し、「B1 単体では merge しない（B2 と一緒）」を書く。

### P3-1 manifest の `afterApproval` が「check を変えていない」と書く
- manifest:245 "without changing any id, scope or check"。実際は `raw-membership.check`（manifest:171）の文が変わり、freeze の scope も `/preconditions/definitions/2/check` を宣言する。判定の意味は同じなので、「判定（check の比較の条件）は変えず、raw-membership.check の件数の列挙を直した」と正確に書く。freeze.v2.json:675 の `change` の文は正確（"updates only the enumerations … raw-membership.check …"）。

### P3-2 DR-CP4-G4-5 (4) が README:274／:276 の書き換えを列挙していない
- DR は「観測の後の版の扱いを足す」とだけ書く。実際は「観測の前に限り」→「観測の前は」（:274）と「この版」→「その版の bytes」（:276）の 2 つの書き換えもある。とくに :276 の書き換えが、G-02 などの v1 の bytes（v2 の freeze の前に観測済み）を v2 の freeze で固定済みと読ませる。ユーザーの確認（README:265-266）の範囲内だが、意味の確認の対象として DR と `pendingReview` に明記する。

### P3-3 観測後の変更範囲が粗い（validator が気づけない変更がある）
- 根拠：contract.mjs:137-163。`/coverageGaps` は配列全体、`/preconditions/holdVersusBlocked` は文全体、README は節単位（「観測時の前提条件と blocked」の節に README:105 の「観測の後に足さず、外さず、読み替えない」がある）。
- 再現：`g04c/b1/mutate.mjs` の「coverageGaps: an EXISTING gap deleted」「holdVersusBlocked rewritten」「README: … '観測の後に足さず' removed」は、freeze を結び直すと誤り 0 件で通る。
- 今回の差分は 1 行ずつ読んで問題が無いことを確かめた。今後のために、`coverageGaps` は「承認した配列が先頭に残る（追加だけ）」の検査、README:105 の行は範囲外に固定、などを検討する。

### P3-4 範囲外の hash と `filesAtReview` は freeze 自身の申告
- `approvedSha256OutsideScope` は freeze の値と比べるだけで、承認した bytes から計算し直さない（v1 と同じ形）。post-observation の場合、round 4 の `filesAtReview` の manifest／schema／README の sha256 は superseded の freeze の `manifestSha256`／`schemaSha256`／`readmeSha256` と同じであるべきなのに、照合しない。
- 再現：`mutate.mjs` の「filesAtReview manifest sha set to junk」「approvedSha256OutsideScope recomputed after an outside-scope schema change」が通る。
- 今回の値は基点の bytes から計算し直して一致を確かめた（§1 (a)）。改善：`filesAtReview` の 3 file を superseded の freeze の 3 つの sha256 と照合する検査を足す（安い）。

### P3-5 試験で落ちない validator の変異
- VM5（:2484-2492 manifest の行との一致）、VM6（:2466-2472 新しい file と新しい fixtureId）、VM9（:2493-2501 `changedFields`／`observedRuns`）を無効にしても contract.test は 29/29。`graphRuntimeObservedBeforeFreeze` が boolean でないときの検査も試験が無い。それぞれ 1 件ずつ負の試験を足す。

### P3-6 S2 validator が freeze.v1.json を直書きしている
- `observation-prep.mjs`:1342、:4251。`eval:fixtures` の nir1ObservationPrep の `formalReady: true` は v1 の freeze に対する判定で、harness の `GRAPH_CASE_FREEZE`（v2）と食い違う。S2 追補で直す箇所として設計 C §7.1 の表に path の直書きが挙がっていない（`references.graphCaseFreeze` は挙がる）。B2 の作業一覧に足す。

---

## 再現の手順（scratchpad）

- 範囲外の hash の再計算：`node g04c/b1/scope.mjs <worktree> g04c/b1`。
- validator の変異（27 項目）：`node g04c/b1/mutate.mjs <worktree> g04c/b1/mut-root g04c/b1`、結果は `g04c/b1/mutate.out`。
- 試験の変異（VM1〜VM9）：写しの contract.mjs を `g04c/b1/vm.mjs` で 1 か所だけ書き換えて `node --test scripts/quality/nir1-graph/contract.test.mjs`。
- 試験の結果：`g04c/b1/head-graph.tap`、`head-eval.tap`、`head-misc.tap`、`head-evalfix.txt`、基点 `base-graph.tap`、`base-eval.tap`。
