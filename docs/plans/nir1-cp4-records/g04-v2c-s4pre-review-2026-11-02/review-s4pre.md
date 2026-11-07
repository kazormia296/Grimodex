# G-04 v2c B2b-2（S4b''' の前）の独立レビュー（read-only、2026-11-01〜02）

対象：`/home/grimodex/worktrees/Grimodex/claude-g04-v2c`（branch `claude/g04-v2c-fixture`）、`cedbd867..eae0c79d`（8 commit。HEAD `eae0c79d0e8c0a1384f81cbc02d54d309848dba4` を確認）。
読んでいないもの：測定の受領書（contracts の `gold-s5r4-1/`、`traces-*`、`parity-*`、`negatives-*`、`s6-aggregation-s5r4/`、`s7-report-*`）と `.artifacts/cp4/`。①の記録 `r5-check-r5-1027/README.md` は読んだ（観測前の記録。Graph arm を含まない）。`r5-check-record.json` と受領書の本体は開いていない。
repo は編集していない（終了時の `git status --short` は空）。変異はメモリ上（scratchpad の `g04c/s4pre/mut.mjs`、`mut2.mjs` が worktree の validator を import して、読んだ JSON を変える）だけで行い、worktree に一時 file を作っていない。`claude-g04-cand` には触れていない。

## 結論：(b) 修正してから受入れ可

P1 なし。P2 が 3 件、P3 が 6 件。失効、addendum の凍結の欄、pin し直し、S2 の葉の扱い、validator の追加の検査は事実と合い、弱めもない（pin の全件照合で食い違い 0、node の試験 125/125 を再現）。直すべきは、(1) 宣言の addendum v2 に K2/4 :418 の独立 reviewer の記録が束縛されていない（今の review は「:418 の記録はまだ無い」と書く記録を引く）、(2) C2 の判断が K6/4 :317 の順を解いていない（13 variant の取り直しは必要だが、それだけでは字義を満たせない）、(3) `g04RevisionReadings.limits (h)` が trace の名指す宣言の addendum v1 を開示していない、の 3 点。C1 には同意、C3 は (i) 許容・(ii) 作らない・(iii) 文を書き換えない、に同意（理由は integrator の案より K6/2 手順 4 の方が強い）。

---

## 指摘

### P2-1 宣言の addendum v2 の review が、K2/4 :418 の独立 reviewer の記録を束縛していない

- 箇所：`evals/nir1-graph/declaration-addendum.v2.json` の `review`（c65e352d）。`review.conditions` は B2a の記録の「K2/4 :418 の独立 reviewer の記録はまだ無い（次の段）」を写している。根拠：K2/4（`docs/plans/nir1-c-body-disclosure-proposal-4-draft.md`、sha256 `efc30cca…`）:418「期待値を独立した reviewer が確かめた記録をその commit に束縛する」。同じ file の `reviewPlan` も「確かめた記録をこの file に束縛し（review の欄に記録の path と sha256 を書き）」と書く。contracts `33042487` の `review-b2a.md`:72。
- 事実：B2a のレビューは G-04 の行を規則から導き直した（`review-b2a.md`:67）ので中身は :418 の確認に近いが、その記録自身が :418 の記録ではないと書いている。v1 は S3 の 7 回目の記録を束縛していた（`declaration-addendum.v1.json` の review）。今の v2 は「frozen-after-independent-review」なのに、:418 の記録が無いと自分で書く記録を束縛している。
- このレビューの項目 3（下）は :418 の確認として使える。束縛の仕方は integrator が選ぶ：(a) S4b''' の前に、宣言の addendum v2 の `review` だけを（c65e352d と同じ型で）書き換えてこの記録の contracts の commit と sha256 を足す（凍結済みの file を後から変えるのではなく、:418 の記録が無い時点で c65e352d が凍結したのが早すぎたことの訂正として扱う。bytes が変わる。`conditions` の「8d6e967e の後、この file を変えた commit はこの凍結のほかに無い」と、S4a''' の revisions、S2 `g04RevisionReadings.limits (f)` の文を合わせて直す）、(b) addendum は触らず、S2 の `limits (f)`（S4b''' が束縛する）と S4b''' の record・DR に「K2/4 :418 の記録はこの記録」と書く（`reviewPlan` の「この file に束縛」の字義は満たさない）。どちらも選ばずに S4b''' を作ると、:418 の字義を満たさないまま凍結する。
- 再現：`python3 -c "import json;print(json.load(open('evals/nir1-graph/declaration-addendum.v2.json'))['review']['conditions'])" | grep -o 'K2/4 :418[^。]*'`。

### P2-2 C2（①の取り直し）の案は、K6/4 :317 の順を解いていない

- 根拠：K6/4（`docs/plans/nir1-final-request-eval-proposal-4-draft.md`、sha256 `d205b35f…`）:317「G-case の seed の pin の照合（R5）は、この凍結の前に済ませる」。K6/4 の凍結は `5dea38af`（2026-10-27 18:11 JST）。S2 の `r5Gate.r5CheckWorkspace.rule`「⑤ で fixture か setup の改版…が起きると、R5 を K6/4 の凍結の後に照合することになり K6/4 :317 の順を満たせないので、その場合も [precheck] で integrator に回す」。
- 事実：13 variant すべての取り直しは**必要**で、integrator の裁量ではなく形式の帰結である。(i) `verifyR5CheckRecord`（`r5-check-runner.mjs`:344-480）は現行の `GRAPH_EVAL_VARIANTS`（G-04 は v2 の path）から `loadFrozenSetupPlans` で plan を作り、`frozenSetupFixturePins(plan, …)` で SP-P2 を計算し直す。v2 は Lio の pin を lio-landing の 1 件にした（lio-market の pin を外した）ので、v1 の setup の受領書は SP-P2 で通らない（code の読み。cold DB は読んでいない）。(ii) 同じ関数は 13 行すべてに `setup.r5CheckRunId === record.runId` を求め、13 の順も固定する（:370-375、:397-400）。G-04 だけを取り直して差し替える形は記録の形式が許さない。(iii) ① の閉包（`r5-check-runner.mjs`:26 の `constants.mjs`、`frozen-setup-plan.mjs`:29 の `nir1-graph/contract.mjs`）はこの枝で変わった。
- しかし、いつ取り直しても R5 は `5dea38af` の後になる。時期（S4b''' の前）と候補（枝の最終 commit）を選ぶだけでは :317 の字義は満たせない。integrator が S2 の [precheck] として明示に選び、DR に記録する必要がある：(α) 順の逸脱を開示して進む（K6/4 の bytes は不変で、`5dea38af` は v1・v2 のどの観測より前の事前登録のまま。新しい ① は S4b''' と gated run のどれよりも前。S2 の `g04RevisionReadings`／S4b''' の record・DR・ユーザー通知に書く）、(β) 新しい ① の後に同じ bytes（`d205b35f`）で K6/4 を新しい contracts の commit に凍結し直す（K6/2「事前登録の凍結」6 の型で旧記録は残す。`constants.mjs` の `K64_FREEZE.freezeCommit`、S2 の `contracts.k64.freezeCommit`、`k64-freeze-record.md` が変わり、`constants.mjs` が変わるので SP-N の記録をその後でもう一度取り直す。事前登録の時点が観測の後に動くという別の弱さが出る）。:317 の文は確認済みの bytes の中にあるが、見出し「確認後の記録（この draft の外で行う。台帳への取り込みの提案）」（:312）の下の、確認の後に integrator が行う記録の手順の提案で、判定の条項ではない。この位置づけと、変えるのは順だけで K6/4 の値・判定は変えないことから、私は (α) の方が害が小さいと考えるが、確認済みの契約の手順の字義から外れるので、integrator が委任の範囲と判断するならその理由を DR に書き、そうでなければユーザーに確認する。
- `k64-freeze-record.md`（② の記録）は ① の記録 `21ed9a9c` を前提として書いている（:16、:26-28）。(α) を選んでも、② の記録が v1 の ① を引いたままであることを開示に書く。

### P2-3 `g04RevisionReadings.limits (h)` が、trace の名指す宣言の addendum v1 を開示していない

- 箇所：`evals/nir1-graph/observation-prep.v1.json` の `g04RevisionReadings.limits` の (h)。根拠：`trace-editing.v1.json` と `trace-browsing.v1.json` の `.project.setup` は「K2/4 の宣言の段は declarationPlace (ii)〔evals/nir1-graph/declaration-addendum.v1.json〕」と書き、`.project.seedPinAddendum` は seed-pin addendum v1 を名指す。一方で trace の runner（`trace-frozen.mjs`:544-545、2bf48fad で変更）は宣言の addendum **v2** を読む。
- (h) は「trace が名指す seed-pin addendum の path は v1 か現行の版だけを受け」とだけ書き、宣言の addendum の食い違いに触れない。値は同じ（v2 の G-02 base の行は v1 と同じ。JSON で比較して一致）なので測定は変わらないが、S2 の開示としては不足。integrator の C3 の前提「trace は seed-pin addendum v1 の path を名指すだけ」も同じ点で不正確。
- 直し方：(h) に「trace の `project.setup` の文は宣言の addendum v1 を名指すが、runner は宣言の addendum v2 を読む。G-02 base の行は v1 と同じ値」を足す。validator の語の検査は今の語のままでよい。
- 再現：`grep -o 'declaration-addendum.v1.json' evals/nir1-graph/trace-*.v1.json`、`grep -n DECLARATION_ADDENDUM_PATH -A1 scripts/quality/nir1-graph-eval/trace-frozen.mjs`。

### P3-1 SP-P4 の source の検査は接頭辞だけを見る

- `observation-prep.mjs` の S2 追補 #11 の SP-P4 の検査は `startsWith(OBSERVATION_PREP_FILES.seedPinAddendum)` なので、`evals/nir1-graph/seed-pin-addendum.v2.json.bak` も通る（変異 M6）。今の文は path の後に「（SP/1 の受入れ…）」が続くので完全一致にはできないが、path の直後が「（」か文字列の終わりであることを求めれば閉じる。

### P3-2 limits の語の検査は (f) と (h) の中身を守らない

- 「（独立期待値レビューではない…）」を消す（M16）、(h) の「trace 2 file … は v1 のまま」を「扱った」にする（M17）は通る。文の検査の限界で迂回路ではないが、(f) の「独立コードレビュー」と (h) の「v1 のまま」を語に足すと、開示の要の 2 点が守られる。

### P3-3 s4StagesRule (g) の「確認の範囲 1」は integrator の読み

- (g) は「ユーザーの確認は … user-confirmation-2026-11-01-g04-v2c-build.md。確認の範囲 1 に S2 追補と S4 の凍結し直しを含む」「この確認は Gold・negative・trace の観測の後の再凍結を含む（(e) の最後の文の確認に当たる）」と書く。記録（`a7027915`）では「確認の範囲」は「integrator の読み」で、ユーザーの回答は 4 問の選択肢。DR-CP4-S4-7 は「integrator の読みの確認の範囲 1」と書いている。S2 の (g) にも「integrator の読み」を足す。

### P3-4 `limits (f)` の新しい版の差の列挙に flag が無い

- (f) は seed-pin と G-01 の setup の新しい版で直したものを「freeze、G-04 の fixture、それを述べる文、宣言する Scene の数 4→5、互いの path」と書くが、`graphRuntimeObservedBeforeAuthoring` を true にした（77acdf2a、B2b-1 のレビューの P2-1）ことが入っていない。各 file の review.conditions には書いてある。

### P3-5 凍結の review.conditions の「下に書いた凍結の前の sha256」

- 3 つの file の `review.conditions` の最後の文「ほかの bytes は下に書いた凍結の前の sha256 の bytes と同じ」は、sha256 が同じ文の前の方にある（下ではない）。「上に書いた」に。

### P3-6 DR-CP4-S4-7／P-7 の除外6項目の欄

- S4-7 の欄は「該当なし（ユーザーの確認は contracts の記録にある。新しい確認を作らない。閾値・Gold・pool・δ・F6／X5 は変えない）」で、製品公開、製品認可の削除、新しい契約・authority を名指していない（送信先と保存範囲は信頼境界の欄にある）。B2a のレビュー P3（G4-7）と同じ型。6 項目を 1 行ずつ書く。

（参考、指摘ではない）S4b''' の予行で `21ed9a9c` と `2d33e6a8` を埋めても `formalReady: true` になる（DR の追記 :1019）。機械の門は ① と SP-N の記録の有効性を見ないので、取り直しは integrator の手順でだけ守られる。

---

## 確かめたこと（項目ごと）

### 1. 失効（d50b0a48）

- `observation-prep-freeze.v1.json` を削除（`d50b0a48` で空。`557e683c` では `b915ba91…`）。manifest の GDX-GROUND-001 の evidence から同じ行だけを外した（diff 1 行）。
- 復元した S2 の sha256 は `90493023…`、`6cb7e05c` の S2 と bytes が同じ。`6cb7e05c..cedbd867` で S2 を変えたのは `557e683c` だけ（`git log`）。
- `6cb7e05c`→`557e683c` の葉の差（`s4pre-leafdiff.py`。1713→1699 葉）は、placeholder の 20 の token の場所（`boundFiles[*].commit/sha256`、`traces[*]`、`contracts.k64.freezeCommit`、`contracts.sp1.bytesCommit`、`d10.g01.*`、`k64Procedure.formal.commit/sha256`、`r5Gate.*Record`）、`status`、`review`、`k64Procedure.formal.review`、`placeholders` だけ。本文の葉の差は無い。

### 2. 3 つの addendum の凍結（c65e352d）

- 変えた葉は 3 file とも `status` と `review` だけ（凍結の前 172／255／253 葉、`review` の下の 6 葉と `status` 以外は同じ）。凍結の前の sha256 は 8d6e967e／cf79d0ab／18964170 で、review の文の値と一致。
- 記録の sha256：contracts `33042487` の `review-b2a.md` は `b6b164ff…`、README `59aacc92…`。`294f708f` の `review-b2b1.md` は `ff4f4375…`、README `ad83db1c…`。どれも review の文の値と一致。
- reviewer が読んだ bytes：`5591f37a` の setup v2 は `9dbc5d6c…`、seed-pin v2 は `b998056a…`、`a7679acd` の宣言 v2 は `c3207d69…`。review の文と一致。その後の差は setup v2 が `graphRuntimeObservedBeforeAuthoring` と `references.graphCaseFreeze.note`、seed-pin v2 が flag、宣言 v2 が `declarationPlace.rule` と `seedPinStepNote` だけ（葉の比較）。review の文の主張と一致。
- verdict（(b)、P1 なし、P2×1・P3×5）、日付、「B2b-1 のレビューは 8d6e967e の変更を見た（review-b2b1.md:40）」は記録の本文と一致。
- **「期待値レビュー済み」とは書いていない**。3 つとも「独立コードレビューで、S3 の独立レビューでも fixture の独立期待値レビューでもない」「直した後の bytes を reviewer が見直した記録は無い」と書く。事実の範囲に収まっている。問題は束縛の中身（P2-1）だけ。

### 3. K2/4 :414-421 の確認を宣言の addendum v2（`ec0f1b85…`）に当てる

自分で fixture v2（`96d44ec3…`。sha256 を確認）と K2/4 の規則から導いた。
- 宣言する Scene：`variants` は `base` だけで、`rPlusIrPlusGraph.appendedSceneId`＝`g04-lio-landing`。K2/4 :391 の規則（appendedSceneId を持つ variant に宣言）に当たり、5 件目はユーザーの確認（`a7027915` の質問 3。記録の sha256 `1de09724…` を照合）。
- reading：Scene の readingOrder 20、`query.readingOrder` 100 → 20／100。
- excerpt：本文は改行の無い ASCII の 1 行で UTF-16 長 211、`expectations.addedScene.sceneExcerpt.canonicalUtf16Range`＝{0,211} → [0,211)。
- veto：`foreshadows` は空。`qualifiedIr` は `g04-control` の 1 行だけで、`g04-lio-landing` に Chronicle の行は無い（secret な Chronicle event も `scene_events` も生じない）。Scene に POV／story time の field は無く、本文に sceneBeat は無い。→ veto なし。
- A1：`scope.default` は explicit、3 軸 exact（tl-main／wl-main／layer-story）、holder と audience は reader。`overrides` に `g04-lio-landing` は無い。query と一致。
- addendum の G-04 の行（20／100、[0,211)、vetoRecords []）は導いた値と一致。validator も同じ値を固定する（変異：reading 30、excerpt end 210、sceneId を lio-market にすると `declarationAddendumErrors` が落ちる）。
- v1 の subset：`declarationValues` は note を除いて v1 と同じ（JSON で比較）。
- 宣言の段が期待値・前提条件・setupTimeline を変えない：`declarationStep` は setupOrder の外（`outsideSetupOrder: true`、`setupTimelineStep: false`、`measurementPoint: false`、`fixtureChanged: false`）、`declarationPlace` は (ii)（測定点の後、測定の workspace）。G-04 v2 の setupOrder の文は G-02／G-07 と同じ（文字列の比較）。G-04 は `mutations` が空。freeze.v2 は宣言の addendum を束縛しない（file に名前が無い）。freeze.v2 の 8 case の sha256 は実 file と一致し、G-04 以外は freeze.v1 と同じ。前提条件の `cb4-inputs`（added-scene、`g04-lio-landing`）は fixture の宣言どおり。
- 診断用の負例 `K24-G04-N1`：declare false、mutationAfterDeclaration null、countsInCaseJudgement false、expectation の文は他の 3 件と同じ型。validator は消す・countsInCaseJudgement を true にする変異で落ちる。S2 の `diagnosticRuns` の写しも一致（M7〜M9 で落ちる）。
- v1 の bytes と supersedes：`declaration-addendum.v1.json` は `82b05bae…` で、`supersedes.commit` `cf1c83e3` は HEAD の祖先、その commit の v1 の bytes も `82b05bae…`、v1 を最後に変えた commit も `cf1c83e3`。v1 の 4 行と負例 3 件は v1 と JSON で一致。
- K2/4 :419-420（改版のときは改版後の版を参照する新しい版を作り、宣言する値は変えない）：references は freeze.v2 と G-04 v2、値は不変。
- quality-manifest：`declaration-addendum.v2.json` は GDX-GROUND-001 の implementedBy にある（:698）。impact-map は v1 と同じく manifest から導く（`impact-map.mjs` に addendum の名前は無い）。
- **判断**：:418 の reviewer の確認の 3 点（v1 の subset で宣言できる、宣言の段が期待値・前提条件・setupTimeline を変えない、診断用の負例）を、最終の bytes（`ec0f1b85…`。凍結の前の `8d6e967e…` と review／status だけが違う）について、fixture と規則から独立に確かめた。**K2/4 :418 の独立 reviewer の確認として使える**。ただし記録を束縛する手続きが要る（P2-1）。私が確かめていないもの：製品の writer の veto の実装（K2/4 の契約の範囲）、Graph runtime の挙動。

### 4. S2 追補 #11（daadd9f3）と validator

**(a) pin**：自分で全件を照合した（`git show <pin>:<path>` の sha256、HEAD の bytes、`git log -1 HEAD -- <path>`、`git merge-base --is-ancestor <pin> HEAD`）。pin 32、bytes の file 72、同じ path の重複 0、食い違い 0。枝だけの commit は 4 つの `g4-*`（7bd785fe、d06f080e、2bf48fad、c5b46714）で、どれも HEAD の祖先。HEAD の bytes の file のうち枝で変わった非試験 file は `constants.mjs`、`frozen-k64-admission.mjs`、`trace-frozen.mjs`、`nir1-graph/contract.mjs`（pin した 4 つ）、`observation-prep.mjs`、`seed-pin-addendum.mjs`（S2 validator。pin の外）、`dev-shape-fixture.mjs`（dev。閉包の外で、閉包の試験が通る）。
- **t14 の pin を `constants.mjs` の今の bytes にしない判断は妥当**：`t14-k64-freeze`（9e1a564e）は `receipt.mjs` も持ち、`receipt.mjs` を最後に変えたのは 9e1a564e のまま。pin の commit を d06f080e に動かすと、`receipt.mjs` を最後に変えていない commit が持つことになり pinRule に反する（変異 M22：`constants.mjs` を t14 に戻すと落ちる）。
- **(b) `boundFiles` に freeze.v2 を足さない判断は妥当**：`boundFiles` の検査は 6 file ちょうど（M12、M13 のメッセージ）。freeze.v2 は `references.graphCaseFreeze` が path と sha256 で束縛し、検査もある（M11 で落ちる）。
- **(c) 本文**：`graphCaseFreeze`（freeze.v2、`8958dc73…`）、`d1.addenda`（v2 の 2 つ）、`d1.runs`（G-04/base を足して 6）、`diagnosticRuns`（K24-G04-N1 を K24-G02-N1 の後に。G-01 の 4 件と K24-G02/07/08 の source を v2 に）、`runnerHandoff[20]`、`switchRule`、`currentFinding`、placeholder の fill 3 つは、変えた差分を読んで妥当。
- **v1 の path を持っていた 23 の葉**（d50b0a48 の S2 で、addendum と freeze と G-04 v1 の path を持つ葉。`observation-prep-freeze.v1.json` の 3 葉は同じ path の record なので数えない）：v2 に直した 20 葉（`references.graphCaseFreeze.path`、`d1.addenda[0..1]`、`diagnosticRuns[0..6].source`、SP-P4 の `source` と `switchRule`、`boundFiles[0]/[1]/[5].path`、`placeholders[9]/[11]/[15].fill`、`r5Gate.currentFinding`、`runnerHandoff[20]`）は、どれも現行の束縛か次の run の手順を述べる文で、v2 に直すのが正しい。v1 のまま残した 3 葉（`reviewerQuestions[5].grounds[0]`、`[5].subQuestions[0]`、`[6].grounds[0]`）は S3 が見た時点の問いの根拠で、書き換えると S3 の記録が事実と合わなくなる。v2 の写しの内容は同じ（SP-P4 の check の文と K24-G01-N2〜N4 は v1 と同じ）なので、残しても誤りにならない。葉ごとに妥当。
- **(d) `g04RevisionReadings.limits`**：必要な開示（観測の後の版、IR の recall の根拠にならない、失う検査 G-04-P2 と path の付加、`irSupplementedCoverage.cases`＝`["G-05"]`、pool の 30/270 と作り直し・S7 の並記、K2/4 の 5 件目、README:265-266 の規則の改訂と 12a738ac が読んだ bytes、新しい版の addendum、旧 S4b'' の観測を結果の選択に使わない、`graphRuntimeObservedBeforeFreeze` の字義、trace の v1 と onFixtureRevision）は入っている。事実と推測は (a)(c) で分かれ、(c) の 1% の動きは〔推測〕。数値は 30/270（`a7027915` の質問 4）と再 probe の 0.4293／0.43／0.0007（DR-CP4-G4-3、model-only の probe。Graph の観測ではない）だけで、測定の受領書の数値は無い。manifest の `irSupplementedCoverage.consequence` とも合う。不足は P2-3（trace の宣言の addendum）、P3-4（flag）、P2-1 と P2-2 の帰結（K2/4 :418 の記録、① と K6/4 :317）。
- **(e) validator の追加の検査**：メモリ上の変異 29 件（`g04c/s4pre/mut.mjs`）。`d1.addenda` を v1 に・順を逆に（M1、M2）、各負例の source を v1 に・別の addendum に（M3、M4）、SP-P4 の source を v1 に（M5）、K24-G04-N1 の削除・declare・variant（M7〜M9）、`d1.runs`（M10）、freeze（M11）、`boundFiles`（M12、M13）、limits の〔推測〕・(h)・〔事実〕への入替え（M14、M15、M18）、rule の role（M19）、欄の削除（M20）、(g)（M21）、pin（M22、M23）はすべて落ちた。通ったのは M6（P3-1）、M16・M17（P3-2）、M24〜M28（散文の葉。検査の対象外で想定どおり）。ctx の宣言の addendum から K24-G04-N1 を消す変異（C1）は S2 の検査を通るが、`declarationAddendumErrors` が「diagnosticNegatives must be exactly …」で落とす（`mut2.mjs`）ので系として覆われている。前からあった検査は弱めていない（負例の行の照合の分岐はそのままで、source の照合を `else if` で足しただけ）。
- `node --test scripts/quality/nir1-graph/*.test.mjs`（Node 24.18.0）：125 件 pass。nir1-graph-eval の 602 件は走らせていない（確かめていない）。

### 5. S4a'''（13f04b26）と訂正（8020b22b）

- revisions の 2 行の事実（旧 S4b'' と 86427ee5 の下の ④⑤、S6/S7 の HOLD と理由〔編集中の失効、30/270 がすべて G-04/base〕、57176fb1・bcfb4b0d・b70f5f6c・#773、4206df12・9bf7654b・02e2e680・a7027915、再 probe a27660e0 と 0.4293、8857f618、12a738ac、f2ebdd98・33042487・294f708f）は、DR-CP4-S6-1・G4-1〜G4-3 の行と contracts の commit の題（自分で `git log` で引いた）と合う。
- 訂正で「本文を読んだ記録」と「hash と要旨を引いた記録」を書き分けた。B2a・B2b-1 のレビューの本文を読んだ、という申告は c65e352d の review の文（record の行番号を引く）と整合する。
- `graphRuntimeOutputObservedScope` の追記（旧 S4b'' の下の観測と S6-1、設計の作者が `g04-base-diagnosis.md` の Graph の子の要約を読んだこと〔設計 C の §1.3 の 3、:42 と一致〕）は過不足ない。`readingsChosenAfterDevObservation` の `g04-v2-after-observation` の chosenBy は、ユーザー・integrator・builder を書き分けている。
- 作者の宣言の sha256 は HEAD で `ee322d3a…`（DR の追記の :1022 と一致。:1016 の `17382797…` は訂正の前の値と明記されている）。

### 6. DR（S4-7／P-7／G4-7 の追記）

- 記述は diff と一致する：pin 4 つと元の pin、t14 と boundFiles の不採用、葉の扱い、「ほかの葉 170／253／251」、S2 の `04fd9f35…`、pin 32・72 file、SP-N の候補の bytes（`constants.mjs` `00150071…`、`test-support.mjs` `71a5a59f…`。HEAD の値と一致）、`git log fc7770fd..cedbd867` の 5 commit、作業記録（`nir1-continuation-2026-10.md`）への登録。
- 除外6項目の欄は P3-6。

### 7. integrator の判断 C1〜C3

- **C1（SP-N）：同意**。規則（`sp-synthetic-detection-record.md`:67-69）の 16 file のうち、`fc7770fd..8187fbfc` で変わったものは無く、この枝で `constants.mjs`（f3b34eb0、b3c1df48、d06f080e）と `test-support.mjs`（2bf48fad、c5b46714）が変わった。試験 3 file と検出の関数は変わっていない。中身でも当たる（`test-support.mjs` の `seedPinWorkspace` は凍結の fixture から 13 variant を作り、SP-N2 の試験は G-04/base を使う）。条件：取り直しは規則の file がもう変わらない時点（C2 で (β) を選べば `constants.mjs` がまた変わるので、その後）で、S4b''' の直前の枝の commit で行い、記録に「規則の 16 file の bytes は測定の候補（S4b''' の子、merge commit）まで同じ」であることを書く。node の試験と 23 件の変異だけで、製品を起動しない。
- **C2（①）：13 すべての取り直しには同意（形式の帰結。P2-2 の (i)(ii)）。時期（S4b''' の前）と候補（枝の最終の code の commit）も妥当**。ただし K6/4 :317 の順はこれで満たせないので、(α)／(β) を選んで記録する必要がある（P2-2）。補足：① は製品の標準 build を使うので、測定の候補で master が製品を変えていれば、① の製品と違う（前回も 7a2669ea と 86427ee5 で違った前例がある）。① の記録に候補と製品の build を書き、差を開示する。
- **C3（trace）：(i) 許容してよい、(ii) 作らない、(iii) S2 の文は書き換えない、に同意**。理由は integrator の案より強いものがある：K6/2 の測定の手順 4（`nir1-final-request-eval-proposal-2-draft.md`:696 の手順 4、:702 の「固定と再利用」）は「(ii)、CP-4、(iii) は同じ file（commit と SHA-256 が同じもの）を使い、(iii) では CP-4 の receipt を見た後に trace を作り直さない。作り直せるのは、不備（Q が 200 件に満たない、密度、setup の検証、期待寄与の材料の記録、製品の契機か debounce の値の不一致）があるときだけ」と書く。trace は旧 S4b'' の下で既に取られたので、参照を直すだけの v2 はこの文の「作り直し」に当たり、許される不備のどれでもない。S2 の `onFixtureRevision` の trace の条項は、観測の前の fixture の改版（CP-0）を想定した文で、K6/2 手順 4 を観測の後にまで広く読んでいる。trace の中身は G-02 の project・seed-pin の一般の段・G-02 base の宣言の行だけに依り、どれも v1 と同じ値（宣言の行は JSON で一致を確かめた）。S3 済みの文は書き換えず、`limits (h)` に K6/2 手順 4 の根拠と、trace が宣言の addendum v1 も名指すこと（P2-3）を書き、S4b''' の record と DR に「この読みは S3 の確認の範囲の外」と書く。

### 8. 取り直しが要る記録の一覧（各記録の取り直しの規則にこの枝の変更が当たるか）

| 記録（S4b''' の placeholder／S2 の参照） | 判定 | 理由 |
|---|---|---|
| ②' SP-N の合成の記録（`2d33e6a8`、候補 `fc7770fd`。#17） | **当たる** | 規則の file のうち `constants.mjs` と `test-support.mjs` がこの枝で変わった（上の C1） |
| ① R5 の照合（`21ed9a9c`、候補 `7a2669ea`。#19） | **当たる** | 記録に明文の取り直しの規則は無いが、G-04 の fixture が v2 になり、`verifyR5CheckRecord` は v2 の plan で SP-P2 を計算し直すので通らない。13 行は 1 run の形で、部分の差し替えはできない。K6/4 :317 の順の扱いが別に要る（P2-2） |
| K6/4 の凍結 commit（`5dea38af`。#0）と ② の記録 `k64-freeze-record.md` | **判断できない（integrator の選択次第）** | bytes（`d205b35f`）は不変。C2 で (α) なら値は同じで開示が要り、(β) なら新しい凍結の commit に変わる |
| K6/4 の検出力の記録（`k64-synthetic-detection-record.md`、`aba74aab`、候補 `86427ee5`。S2 に pin されない） | 当たらない | 規則の 5 file（`followup.mjs`、`outcome.mjs`、`availability.mjs`、`window.mjs`、`receipt.mjs`）は `86427ee5..HEAD` で変わっていない。ただし DR-CP4-S4-7 の運用条件 (11) で、候補が決まった後に integrator が取り直す予定 |
| trace 2 file の commit と sha256（#3〜#6） | 当たらない | bytes は旧 S4b'' と同じ（`7e72a040…`、`54e5e391…`）。C3 のとおり v1 のまま |
| K6/4 の手順 v1（#7、#8） | 当たらない | `k64-procedure.v1.json` は `8187fbfc..HEAD` で不変、sha256 `1c2428df…`（旧 S4b'' と同じ） |
| 3 つの addendum と作者の宣言（#9〜#16） | 当たらない（新しい値で埋める） | S4a''' の後の bytes（setup v2 `fd6b0c3c…`、宣言 v2 `ec0f1b85…`〔P2-1 で (a) を選べば変わる〕、seed-pin v2 `3e4334cc…`、作者の宣言 `ee322d3a…`） |
| SP/1 の bytes の commit（`cd04629e`。#18） | 当たらない | SP/1 の draft の sha256 は `cd04629e` と HEAD で同じ `8ccdf534…` |
| DA-1 の受入れ（none）と G-01 の R・R+IR の mode（unrestricted）（#1、#2） | 当たらない | この枝は d10 を変えていない |
| 独立期待値レビュー（`8857f618`）と再 probe（`a27660e0`） | 当たらない | fixture v2 の bytes は `96d44ec3…` のまま（`5fe90962` の後に変更なし） |
| 規則文の意味のレビュー（`12a738ac`） | 当たらない（既に開示済みの限界） | 読んだのは `7635e880` の bytes で、反映の後の bytes は読んでいない（limits (e) に開示） |
| S3 の 7 回目（`a1fd9f64`。S2 の review と formal.review に S4b''' が書く見込み） | 当たらない（限界は開示が要る） | S3 は追補 #11 と S4a''' を見ていない（作者の宣言と g04RevisionReadings.status に開示済み）。S4b'' と同じ書き方で S3 の確認の範囲の外を書く |
| ④ SP-P4 | （観測前の記録ではない） | 運用条件 (7) のとおり S4b''' の下で取り直す。旧 S4b'' の passed は流用しない |

S2 が名指す `traces-s5r3-1/start-seal-extract.json` は追補 #10 の `traceRunnerReadings` の出所で、この枝の変更ではない（読んでいない）。

---

## 再現の手順（scratchpad）

- 葉の比較：`python3 g04c/s4pre-leafdiff.py <rev-a> <rev-b> [path]`、文の差：`python3 g04c/s4pre-show.py <rev-a> <rev-b> '<json path>'`。
- 変異：`eval "$(fnm env --shell bash)"; node g04c/s4pre/mut.mjs`（S2）、`node g04c/s4pre/mut2.mjs`（宣言の addendum）。どちらも worktree の validator を import してメモリ上の JSON を変えるだけで、file を書かない。
- pin の全件照合：このレビューの session の inline の python（`git show <pin>:<path> | sha256sum`、`git log -1 --format=%H HEAD -- <path>`、`git merge-base --is-ancestor`）。
