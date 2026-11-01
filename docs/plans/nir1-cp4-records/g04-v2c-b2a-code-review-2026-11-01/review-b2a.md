# G-04 fixture v2（案 C）B2a の独立コードレビュー（read-only）

- 対象：worktree `/home/grimodex/worktrees/Grimodex/claude-g04-v2c`、branch `claude/g04-v2c-fixture`、範囲 `7635e880..a7679acd`（10 commit、16 file、+746/−51）。
- reviewer：別の agent（Opus、read-only）。Graph runtime を実行していない。測定の受領書（`gold-s5r4-1/`、`traces-*`、`parity-*`、`negatives-*`、`s6-aggregation-s5r4/`、`s7-report-*`）と `.artifacts/cp4/` は読んでいない。
- repo の file は編集していない。作業前と作業後の `git status --short` は空（0 行）。変異の試験はすべてメモリ上で行った（scratchpad の script が worktree の module を import し、addendum と ctx の写しを変える）。
- 作業 file：同じ directory の `mutate-b2a.mjs`／`.out`、`mutate-c5b.mjs`／`.out`、`reref-sim.mjs`／`.out`、`nir1-graph-test.txt`、`eval-test.txt`。

## 結論

**(b) 修正してから受入れ可**。P1 は無い。B2a の実装（宣言の addendum v2、K2/4 の 5 件目、観測後の行の検査、freeze.v2 への向け直し）は正しく、迂回路は見つからなかった。ただし、次の段（B2b と新しい版）の前提として、DR-CP4-G4-7 の (b)「G-01 の setup addendum と seed-pin addendum の新しい版で直る」が **trace 2 file への連鎖**を書いていない（P2-1）。この連鎖は次の段の作業量と、frozen の材料（S3 済みの trace）を改版するかどうかの判断を変える。直さないと次の段が途中で止まるので「直してから」とした。直す内容は DR の追記（選択肢の列挙）と小さな試験の修正で、B2a の validator の変更には手を入れなくてよい。

## 指摘

### P2-1 seed-pin addendum の新しい版は trace 2 file と setup addendum の本文に連鎖する（DR-CP4-G4-7 の (b) に無い）

- 根拠：`scripts/quality/nir1-graph/seed-pin-addendum.mjs:17-18` の `SEED_PIN_ADDENDUM_PATH`＝`evals/nir1-graph/seed-pin-addendum.v1.json`。この定数を、次の 3 か所が完全一致か部分一致で検査する。
  - `scripts/quality/nir1-graph/observation-prep.mjs:2465-2468`：`trace.project.seedPinAddendum !== SEED_PIN_ADDENDUM_PATH` なら誤りにする。`evals/nir1-graph/trace-editing.v1.json:41` と `trace-browsing.v1.json:41` は v1 の path を持つ。どちらも `frozen-after-independent-review`（S3 の 7 回目に確認済み）で、S2 の `boundFiles` が束縛している。
  - `observation-prep.mjs:1725-1733`（`commonAddendumErrors`）：`seedPinStepNote` が `SEED_PIN_ADDENDUM_PATH` を含むことを求める。`evals/nir1-g01/setup-addendum.v1.json:205` と `declaration-addendum.v2.json`（`seedPinStepNote`）は v1 の path を書いている。
  - `observation-prep.mjs:45`：`OBSERVATION_PREP_FILES.seedPinAddendum` も同じ定数（S2 の `boundFiles` の照合）。
- 害：seed-pin addendum を新しい file（例：`seed-pin-addendum.v2.json`）にして定数を変えると、trace 2 file が新しい誤りで落ちる。直すには、(i) trace 2 file の新しい版を作る（S3 済みで frozen の材料の改版。trace は G-02 だけを使い、G-04 にも freeze にも依存しない）か、(ii) trace の検査を「seed-pin の v1 か現行の版」を受けるように緩める（v1 の G-02 の行は v2 と同じ値）か、(iii) seed-pin の新しい版を作らず、SP-N8 を「v1 は freeze.v1 と G-04 v1 に対して検査し、v2 の freeze との差は G-04 の行だけで、その行は v2 から導き直しても同じ値」とする、のどれかが要る。どれも B2b の範囲（S2、S4、作者の宣言）の外で、「4 件は新しい版で直る」という見積りより大きい。
- 再現：`reref-sim.mjs` は seed-pin addendum の参照だけを v2 にすると `seedPinAddendumErrors` が `[]` になることを示す。連鎖は path の定数を変えた場合に起きるもので、コードの読みから導いた。定数を変えて試験は流していない（repo を書かないため）。**確かめていない**：定数を変えた後の誤りの件数。
- 直し方（提案）：DR-CP4-G4-7 の (b) に、上の連鎖と (i)〜(iii) の選択肢を足して integrator に返す。どれを選ぶかは決めない。declaration-addendum.v2 は draft なので、`seedPinStepNote` は独立レビューと凍結の前に新しい path に直せる。

### P2-2 SP/1 は G-04 の fixture と freeze を v1 の sha256 で名指し、改版の条項を持たない（記録が要る）

- 根拠：`docs/plans/nir1-graph-case-seed-pin-proposal-1-draft.md`:43（baseline は `freeze.v1.json` `6080530a…`）、:46（「変えないもの」に G-04 `4d002261…`）、:123（addendum は「`freeze.v1.json` の SHA-256 と各 fixture の SHA-256 を参照する」）、:170（SP-N8 は「`freeze.v1.json` の SHA-256 の照合が通らない」で検出する）。K2/4 には fixture を改版したときに addendum の新しい版を作る条項（`nir1-c-body-disclosure-proposal-4-draft.md`:419）があるが、SP/1 には無い（grep の結果は「改版」が選択肢 D1 の行〔:54、:133〕に出るだけ）。
- B2a は `seed-pin-addendum.mjs:181-189` の SP-N8 を `NIR1_GRAPH_FREEZE_PATH`（v2）に向けた。これは SP/1 :123、:170 の文字どおりの読みから離れる。
- 判断：**内容は変わらないので、ユーザーへの追加の確認は要らない**と判断する。理由：(1) SP/1 :46 が守るのは v1 の bytes で、v1 は変わっていない。(2) G-04 の seed の行（`g04-query`→`g04-bren`、`manualSeed.entityId`、`graph-cases`、`expectedGraph: available`）は SP/1 :95 の表と同じで、fixture v2 から導き直しても同じ値（`reref-sim.out`）。(3) fixture v2 を作ることと、その addendum を直すことは、ユーザーの確認 `a7027915` の「確認の範囲」1（「規則文・addendum・試験の改訂」）に入る。
- ただし、この判断は「SP/1 が固定した参照先を、addendum の側で現行の freeze に読み替える」ものなので、DR に明記する（SP-N8 の検出の意味は「addendum が束縛する freeze と fixture の digest を実 file と照合する」で同じ、と書く）。今の DR-CP4-G4-7 の (0-f) は SP-N8 の変更を書いているが、SP/1 :123、:170 との関係を書いていない。

### P3-1 落ちる 30 件の分類で、#31〜#33 は (a) だけでなく (b) も要る

- DR-CP4-G4-7「落ちる試験の理由」は #30 だけを「(a) と (b) の両方」とし、#31〜#33 を (a) に入れる。
- 根拠：#31（`observation-prep.test.mjs:200`）は `validateNir1ObservationPrep` で全文書を検査し `errors` が `[]` であることを求める。#32（:214）は `assertObservationPrepFormal` の拒否の文が placeholder／draft であることを求めるが、全文書の誤りがあると「documents are invalid」で拒否されるので一致しない。#33（:228）の実際の `[precheck]` の文は setup addendum の誤りから始まる（`nir1-graph-test.txt`）。どれも setup addendum と seed-pin addendum が v1 の freeze を指す限り通らない。
- 件数：(a) だけで直る 22 件、(b) だけで直る 4 件（#34、#108、#118、#119）、両方が要る 4 件（#30〜#33）。合計 30 で、B2a の報告の 30 と一致する。

### P3-2 置換漏れ：`observation-prep.test.mjs:1212-1218` が今も `freeze.v1.json` の cases を読む

- 試験「the frozen files the record must not change keep their freeze digests」は `freeze.v1.json` の cases の sha256 を照合する。今通るのは G-04 v1 の file が tree に残っているからで、意図（現行の freeze の bytes を守る）は `NIR1_GRAPH_FREEZE_PATH` に向くべき。現行の freeze の cases は contract.mjs（`eval:fixtures` の nir1Graph）が照合するので、穴の害は小さい。`seed-pin-addendum.test.mjs:128` の試験名「digests of freeze.v1.json」も古い。
- それ以外の置換は漏れていない。`git grep freeze\.v1\.json` の残りは次のどれか：superseded の定数（`contract.mjs:64`）、`manifest.v1.json:251` の `supersededFreezeRecord`、`freeze.v2.json` の `supersedes`（:76）と経緯の文、v1 を v1 として記録する file（declaration-addendum.v1、observation-prep-author-declaration.v1:45、observation-prep-freeze.v1:9）、B2b と新しい版で直す file（S2 :45、setup addendum :30、seed-pin :18）、変異の試験（`observation-prep.test.mjs:491` は v1 を入れて落ちることを試す）、コメント（`test-support.mjs:1963`、:1970）。

### P3-3 `contractScopeExtension.userConfirmation` の `question` と `answer` は検査されない

- `observation-prep.mjs:1833-1852` は `decision`、`variants`、`record`、`commit`、`sha256`、`rule` を照合するが、`question`（3）と `answer` は照合しない（変異 M17、M18 が通る）。commit と sha256 で記録を束縛しているので害は小さい。`K24_SCOPE_EXTENSION` に `question: 3` を足して照合すると、別の質問を出典にする誤記を落とせる。
- 確認の記録は自分でも照合した：`git show a7027915:docs/plans/nir1-cp4-records/user-confirmation-2026-11-01-g04-v2c-build.md | sha256sum`＝`1de09724c6db…f5a`。質問 3 の回答は「K2/4 の適用範囲を広げることを、ここで確認する (推奨)」、確認の範囲 4 は「宣言の値・veto・利用時の判定・製品の authority の中身は変えない。記録は addendum の新しい版と `K24_TABLE` の出典に書く」。addendum と定数は一致する。

### P3-4 宣言する Scene の A1 が explicit であることを validator は確かめない（既存の穴。G-04 で初めて関係する）

- `declarationRowErrors`（`observation-prep.mjs:1459-1505`）と `vetoesFor`（:1435-1457）は reading、excerpt、veto を確かめるが、A1 を確かめない。fixture v2 の `scope.overrides` に `g04-lio-landing: {marker: "unknown"}` を入れても通る（変異 C9）。v1 の 4 行の検査にも無い穴で、B2a が弱めたものではない。ただ、override を持つ fixture は G-04 だけで、addendum の `declarationsNote` と DR は「A1 は Scope の既定（explicit）」と書く。`scope.overrides[sceneId]` が無いか marker が explicit であることと、既定の marker が explicit であることを足すとよい。今の fixture v2 では `g04-lio-landing` に override は無い（実物で確認）。

### P3-5 観測後の行の判定は freeze の `postObservationRevisions` を信じる（依存先の明記）

- `postObservationAddendumErrors`（`observation-prep.mjs:1862-1924`）は、作り直した case を freeze の `postObservationRevisions` から読み、その case の行を v1 の写しの照合（`kept`）から外す。freeze が G-02 も作り直したと書き、addendum の `postObservationDeclarations.variants` もそれに合わせると、G-02 の行の `vetoNote` の改変は通る（変異 C5b。reading と excerpt の改変は K2/4 の表の検査で落ちる）。
- 迂回路ではない。freeze.v2.json は harness の `GRAPH_CASE_FREEZE.sha256` で固定され、`postObservationRevisions` と manifest の一致、作り直した case 以外の sha256 が v1 の freeze と一致することを contract.mjs（`eval:fixtures` の nir1Graph）が確かめる。この依存を validator のコメントか DR に一文書くとよい。

### P3-6 DR-CP4-G4-7 の形

- G4-1〜G4-6 は表の行で「代替案」「advisor」「除外6項目への該当」「owner/lifecycle matrix」「状態」の欄を持つ。G4-7 は散文の節で、除外6項目は「新しい送信先・保存範囲なし。閾値・Gold・pool・δ・F6／X5 の定義は変えない」の一文だけ。製品公開、製品認可の削除、新しい契約・authority についての記述が無い。K2/4 の適用範囲の拡大は確認済み（`a7027915` の質問 3）なので「新しい契約・authority：該当なし（K2/4 の拡大はユーザーの確認済みで、値・veto・authority は不変）」と書ける。advisor に諮ったかの記録も無い。
- 「DR-CP4-G4-6 の追記」の読み替え：`freeze.v2.json` の `irSupplementAdmissionProbe.reason`、`ruleTextReview.fixedAfterReview`（:723）、`ruleTextReview.notes`（:756）の「DR-CP4-G4-6 の追記」が G4-7 の節を指す、と G4-7 の冒頭に書く扱いは妥当（freeze を作り直すと `GRAPH_CASE_FREEZE` と addendum v2 の sha256 が連鎖して変わる）。ただし `cp4-decisions.md`:908 に「G-04 fixture v2 の実装後の追記（B1）」という別の追記の節があり、freeze の読者が取り違えうる。:908 の節か G4-6 の行に「B2a の追記は DR-CP4-G4-7 の節」と 1 行足すとよい（cp4-decisions.md は freeze が束縛しない）。

## 確かめたこと（項目ごと）

### 1. 宣言の addendum v2 の値

- K2/4（`docs/plans/nir1-c-body-disclosure-proposal-4-draft.md`、sha256 `efc30cca…`。基点から変わっていない）の :391（宣言する Scene は `appendedSceneId` を持つ variant の 4 つ）、:393-398（表）、:399（POV、story time、Chronicle event を持たず A1 は explicit で reading が query より前）、:294-295 と :299（veto：secret の foreshadow、secret な Chronicle event、POV）、:418（別 file、独立 reviewer の記録の束縛、quality-manifest への分類）、:419（改版のときは新しい版）を実物で読んだ。
- 既存の行の導出：G-02 `g02-tamsin-first` は readingOrder 30／query 100、本文 78 字の 1 行、frozen の `addedScene.sceneExcerpt.canonicalUtf16Range`＝[0,78)。G-07 は 40／100、[0,70)、G-08 は 20／100、[0,64)。3 件とも「fixture の readingOrder」と「frozen の canonicalUtf16Range＝最初の非空行の UTF-16 長」で表の値になる。
- 同じ方法で G-04 v2 を導いた：`variants[base].expectations.arms.rPlusIrPlusGraph.appendedSceneId`＝`g04-lio-landing`、scene の readingOrder 20、`query.readingOrder` 100、本文は ASCII の 1 行で 211 字、`addedScene.sceneExcerpt.canonicalUtf16Range`＝{0,211}。veto：`foreshadows` は空、Scene に pov／story time の field は無い、`qualifiedIr` は `g04-control` の 1 行だけ（v1 には `g04-lio-landing` の行もあった。v2 で外れた）、`chronicleEvents` は無い。A1：既定は explicit、`scope.overrides` に `g04-lio-landing` は無い。**B2a の行（20／100、[0,211)、veto なし）と一致する。**
- v1 の bytes：`declaration-addendum.v1.json` の sha256 は `82b05bae…`、`git diff 8187fbfc..HEAD` は空。`supersedes.commit` の `cf1c83e3` は HEAD の祖先で、`git show cf1c83e3:…` の sha256 も `82b05bae…`（v1 の最後の改訂の commit）。
- v2 と v1 の違い：G-04 以外の `declarations`、`diagnosticNegatives`、`declarationValues`（note を除く）は v1 と同じ値（JSON で比較）。`variantsWithoutDeclaration` から `G-04/base` が外れ、`references` が freeze.v2 と G-04 v2 を名指し、`contractScopeExtension`、`supersedes`、`postObservationDeclarations` が加わった。
- `graphRuntimeObservedBeforeAuthoring: true`：Graph runtime が v1 の全 case を観測した後にこの file を書いた、という事実の記録。G-04 の行は fixture v2 と K2/4 の規則だけから導けるので、観測の結果を使っていない（上で再導出して一致）。fixture v2 の Graph arm は、この addendum より前に観測されていない（README と freeze の記述。受領書は読んでいないので、この点は記述によって確かめた）。K2/4 :418 の「Graph arm を観測するどの実行よりも前の commit」は v2 の観測より前で満たせる。
- 診断用の負例 `K24-G04-N1`：形は他の 3 件と同じ（declare false、mutationAfterDeclaration null、countsInCaseJudgement false、expectation の文）。G-02 の次に置かれ、`GRAPH_NEGATIVES`（`observation-prep.mjs:245-250`）の順と一致する。判定に数えない（変異 M30 で countsInCaseJudgement を true にすると落ちる）。
- status は `draft-awaiting-independent-review`、review は null。正式の門は addendum が frozen でないと `formalReady` を false にする（`observation-prep.mjs:4536-4546`）。K2/4 :418 の独立 reviewer の記録はまだ無い（次の段）。

### 2. 観測後の行の規則と `K24_SCOPE_EXTENSION`（変異の結果。`mutate-b2a.out`、`mutate-c5b.out`）

- 無変異は通る。49 個の変異のうち 46 個は落ちた。主なもの：G-04 の行の reading、excerpt の start／end、sceneId、vetoRecords（M1〜M6）、G-04 の行を消す（M7）、ユーザーの確認の commit、sha256、record を消すか変える（M8〜M12）、拡張の variants に `G-02/base` を足す、空にする（M13、M14）、decision、rule（M15、M16）、flag を false にする（M19）、`postObservationDeclarations` を消すか広げる（M20〜M22）、`supersedes` を変えるか消す（M23〜M25）、v1 の行と負例の文を変える（M26〜M28）、`K24-G04-N1` の改変（M29〜M32）、G-04 の参照を v1 に戻す（M33）、参照に余分な case を足す（M34）、freeze の参照を v1 に戻す（M35）、`variantsWithoutDeclaration` に G-04 を戻す（M36）。ctx の側では、v1 の addendum の bytes の不一致と欠落（C1、C2）、freeze が G-04 を作り直したと書かない場合（C3、C4）、fixture v2 の本文を縮める、POV や secret の foreshadow を足す、`appendedSceneId` を消す（C6〜C8、C10）。
- 通ったのは 3 個：M17、M18（P3-3）、C9（P3-4）。C5b（P3-5）は freeze の側の改変で、contract.mjs が守る。
- v1 の 4 件の検査は弱まっていない。K2/4 の表の照合（`declarationRowErrors`）は 4 行にそのまま掛かり、加えて v1 の写しとの完全一致（`kept`）が掛かる。`graphRuntimeObservedBeforeAuthoring` の検査は `commonAddendumErrors` から外れたが、setup addendum は `setupAddendumErrors`（:1749-1750）で常に false、宣言の addendum は G-04 の行が無ければ false（M7、C3）、seed-pin addendum は `seed-pin-addendum.mjs:141-142` で常に false のまま。
- `K24_TABLE` と `K24_SCOPE_EXTENSION` は code の定数で、`observation-prep.test.mjs` の B2a の試験が 6 行と `variants`＝`["G-04/base"]` と確認の commit を固定する（diff の :22-52）。code を変えて拡張を広げるには試験の改変が要る。

### 3. S2 validator と SP-N8 の freeze.v2 への向け直し

- `NIR1_GRAPH_FREEZE_PATH` の使用：`contract.mjs:56`（定義）、`observation-prep.mjs:1383-1387`（参照の検査）、:4403（凍結の fixture の読込み）、`seed-pin-addendum.mjs:184-188`（SP-N8）。
- fail-closed：v1 の freeze を指す文書（S2、G-01 の setup addendum、seed-pin addendum）はすべて誤りで落ち、`eval:fixtures` の nir1ObservationPrep は failed（B2a の報告で誤り 9 件。`nir1-graph-test.txt` の #30 の誤りも 9 件で同じ）、`assertObservationPrepFormal` は `[precheck]` で止まる（#33）。正式の run は通らない向きに倒れる。
- v1 を v1 として指し続けるもの、v2 に向けるべきものの区別は正しい（P3-2 の試験 1 件を除く）。

### 4. 落ちる 30 件の分類

- `node --test scripts/quality/nir1-graph/*.test.mjs`（Node 24.18.0）：119 件中 pass 89、fail 30（`nir1-graph-test.txt`）。`node --test scripts/quality/nir1-graph-eval/*.test.mjs`：602/602（`eval-test.txt`）。B2a の報告と一致する。
- 失敗の文は 8 種類だけ：S2、setup addendum、seed-pin の `graphCaseFreeze`（v1 を指す）、seed-pin の `references.fixtures.G-04`（v1 を指す）、S2 の `d1.runs`（5 run）、`diagnosticRuns` に `K24-G04-N1` が無い、`diagnosticRuns K24-G04-N1 must match its addendum row`、`boundFiles` の宣言の addendum が v1。ほかに `draftOf` の TypeError 13 件（`observation-prep.test.mjs:103`。試験の補助が `boundFiles` に v2 の path の行を見つけられない。門の挙動ではない）と `[precheck]` 1 件。**どれも「文書が v1 の freeze／v1 の addendum を指す」ことによるもので、ほかの種類の失敗は混ざっていない。**
- 基点との比較：基点 `8187fbfc` は 115/115、B1 の終わり `7635e880` は 117 件中 2 件（draft の試験 2 件。t14-k64-freeze の pin。B1 のレビュー記録 `review-b1.md`:65）。B2a は試験を 2 件足して 119 件。B1 で落ちていた 2 件は今も落ちる（TypeError に変わった。B2b で t14-k64-freeze の pin を直す必要は残る）。nir1-graph-eval の 6 件は B2a で直った。
- 分類は P3-1 のとおり（22／4／4）。TypeError の 11 件は `observationPrepErrors`（S2 だけ）を検査するので B2b で直る見込み、#31、#32 は全文書を検査するので (b) も要る。**確かめていない**：B2b の後に TypeError の試験が先へ進んだとき、新しい誤りが出ないこと（実行していない）。

### 5. seed-pin addendum と G-01 の setup addendum の新しい版

- 内容は変わらない：`reref-sim.out`。参照だけを v2 にした写しは、`seedPinAddendumErrors` と `setupAddendumErrors` の誤りが 0 になる。G-04 の seed の行は v2 から導き直しても v1 と同じ（`g04-query`→`g04-bren`、available）。fixture v2 の `manualSeed`、`query.sceneId`、`setupOrder`、query の Scene の pin（無し）は v1 と同じ。
- 変わる行（提案。書いていない）：
  - seed-pin addendum：:6（purpose の「freeze.v1.json が束縛しない」）、:18-19（`graphCaseFreeze` を freeze.v2 `8958dc73…` に）、:37-40（G-04 を `g04-scope-exact-unknown.v2.json`、`nir1-g04-scope-exact-unknown/2`、`96d44ec3…` に）、:290（SP-N8 の check の文）、`addendumId`、`status`（draft に戻る）、`review`（null。新しい独立レビューの記録を後で束縛）、`supersedes` 相当の欄。`graphRuntimeObservedBeforeAuthoring` は validator が常に false を求めるが、宣言の addendum v2 の規則（作り直した case の行を持つなら true）に合わせると G-04 の行を持つので true になる。どちらにするかは integrator の判断（P2-1 の選択肢と一緒に返す）。
  - G-01 の setup addendum：:30-32（`graphCaseFreeze` を freeze.v2 に。note の文）、:68（「4 つの Scene（G-01 と G-02／G-07／G-08）」「declaration-addendum.v1.json」は参照の陳腐化で、選択 (ii) は同じ）、:205（`seedPinStepNote` の seed-pin の path。seed-pin の path を変える場合だけ）、`addendumId`、`status`、`review`。G-04 を含まないので `graphRuntimeObservedBeforeAuthoring` は false のまま（B2a の規則と一致）。
  - 連鎖：trace 2 file（P2-1）、S2 の `boundFiles` と `diagnosticRuns` の `source`（:59、:430、:439、:448、:622。B2b）、S4 の freeze 記録。
- ユーザーの確認：**要らない**と判断する（P2-2 の理由）。ただし trace 2 file の改版（P2-1 の (i)）は S3 済みの frozen の材料に及ぶので、選ぶ場合は DR に記録してから進める。内容（seed の規則、行、SP-P／SP-N の表）が変わると分かった場合は止めて戻る。

### 6. DR-CP4-G4-7 の正確さ

- diff と矛盾する記述は見つからなかった。「S2、observation-prep-freeze、作者の宣言、S4 の file、fixture v1／v2、freeze.v1、宣言の addendum v1、seed-pin addendum、G-01 の setup addendum は 1 byte も変えていない」は項目 9 で確かめた。「sha256 を直書きした試験は無い」は `git grep '8f52f2f2\|8958dc73' -- '*.test.mjs'` が空で確かめた。(0-b) の README の文は規則文のレビュー（`rule-text-meaning-review.md`:72、:75）の提案の文と同じ。freeze.v2 の B2a での変更は `frozenAt`、manifest と README の sha256、`irSupplementAdmissionProbe`、`changesAfterApproval[0].change`、`ruleTextReview` の欄だけ（JSON の比較）。
- 不正確な点は P3-1（分類）、欠けている点は P2-1（連鎖）、P2-2（SP/1 との関係）、P3-6（除外6項目、advisor、追記の読み替え）。

### 9. 不変の file

- `git show HEAD:evals/nir1-graph/g04-scope-exact-unknown.v2.json | sha256sum`＝`96d44ec362f30352d6cb971c208f2ab71aed944d008cab9eb65ca2ab57c218e1`。v2 を書いた commit は `5fe90962` だけで、`git diff 7635e880..HEAD` も空。
- `git diff 8187fbfc..HEAD` が空：`g04-scope-exact-unknown.v1.json`、`freeze.v1.json`（`6080530a…`）、`declaration-addendum.v1.json`、`observation-prep.v1.json`（S2）、`observation-prep-author-declaration.v1.json`、`observation-prep-freeze.v1.json`（S4）、`seed-pin-addendum.v1.json`、`trace-editing.v1.json`、`trace-browsing.v1.json`、`evals/nir1-g01/setup-addendum.v1.json`、`evals/nir1-g01/fixture.v1.json`、`k64-procedure.v1.json`、`independent-expectation-review.v1.json`、K2/4 の文書、SP/1 の文書。
