# G-01 setup addendum v3 の独立コードレビュー（read-only）

- reviewer: Claude の subagent（Opus、read-only）。人間のレビューでも、ユーザーの確認でも、S3 の独立レビューでもない。Graph の runtime は実行しておらず、測定の受領書（`gold-*`、`traces-*`、`negatives-*` など）は読んでいない。
- 対象: worktree `/home/grimodex/worktrees/Grimodex/claude-cp4-s4-5th`、branch `claude/cp4-s4-5th`、HEAD `0d456ee2`。worktree は clean（`git status --short` が空）。
- 読んだ commit: `e112d2dc`（v3 の草案）、`ee43c197`（path の向け直し）、`425402c8`（追記 3）、`0d456ee2`（失効。S2 と試験を `179139b4` の bytes に戻す）、`f31d99e0`・`8e8aea2e`（harness）、`c65e352d`（v2 の凍結）、`a1cd6675`（基点。harness の差分の比較元）。
- SHA-256（HEAD の作業木の bytes。`sha256sum` で取得）
  - v3 `evals/nir1-g01/setup-addendum.v3.json`: `54b69bc2247e90c7b022d429eb1b268060dd0a616f5e21fb3da6d92c7d1e7176`
  - v2 `evals/nir1-g01/setup-addendum.v2.json`: `fd6b0c3cabb2713f58c6883bc6d3062e4db967517351d3dd4d3eefd204cc84b8`
  - v1 `evals/nir1-g01/setup-addendum.v1.json`: `ade7c40256c159f2da1341cfa885401542f6d6621a99ca394bcdb255b7271f46`
- 読んだ file: v1／v2／v3、`g01-negatives.mjs`、`g01-negative-run.mjs`、`g01-negative-preview.mjs`（:185-260 と grep）、`frozen-setup-driver.mjs:122-168`、`workspace-db.mjs:17-72,118-300,327-352`、`frozen-diagnostics.mjs:95-115`、`frozen-k64-admission.mjs:38-146`、`observation-prep.mjs` の関係する部分（:1-49,136-185,311-314,767-787,1125-1145,1562-1585,1745-1780,1855-2060,4670-4700,4840-4870）、`seed-pin-addendum.mjs:42-98`、`cp4-decisions.md` の DR-CP4-S4-8 の行（:874）と追記・追記 2・dev の予告・追記 3（:876-942）、K2/4 draft の :410-420 と :526-538、`nir1_graph_index_maintenance.rs:1-26`、`nir1_entity_relation_index.rs:443-470`。
- 実行したこと（Node 24.18.0。file は変えていない）
  - JSON の葉の比較（scratchpad の script `rv/leafdiff.mjs`）、キーの相対順の比較、v3 を v2 に読み戻した deep equal の確認
  - `git diff c65e352d HEAD -- v1 v2`（差分 0 行）と、`c65e352d`・HEAD の v1／v2 の `git show | sha256sum`
  - `node --test --test-reporter=tap`: `g01-negatives.test.mjs` 25/25、`g01-negative-run.test.mjs` 5/5、`frozen-k64-plan.test.mjs` 18/18、`frozen-k64-admission.test.mjs` 6/6、`scripts/quality/impact-map.test.mjs` 42/42、`scripts/quality/quality-workflow.test.mjs` 23/23
  - `prettier --check evals/nir1-g01/setup-addendum.v3.json`（通る）
  - 実行していないこと: `observation-prep.test.mjs`（追記 3 の 123/125 は再現していない）、変異の試験、Electron、dev の予告の再実行

## 要旨

P1 は無い。restore の地点は v2 と同じ A-1 だけで、本文だけの保存の地点の規則は DR (1) と同じか、より厳しい（`prior.dirty === false` を足している）。v3 を v2 に読み戻すと、キーの順まで含めて一致する。直すべき点は P2 が 4 件で、どれも文面の追加か言い換えで直る。内訳は、DR (8) の開示 5 件のうち 1 件が抜けていること、measurementPoint の定義の鍵が実装と辺縁で食い違うこと、`afterMutationReadings.status` が S3 の後の変更を書いていないこと、`limits (i)` の「入力の同一性」が範囲を広く読ませること。

## 1. 差分（必須）

- **v1・v2 の bytes**: `git diff c65e352d HEAD -- evals/nir1-g01/setup-addendum.v1.json evals/nir1-g01/setup-addendum.v2.json` は 0 行。`c65e352d` と HEAD の v1 は `ade7c402…`、v2 は `fd6b0c3c…` で一致し、作業木の sha256 とも一致した。v3 の `supersedes`（path v2、sha256 `fd6b0c3c…`、commit `c65e352d0cdb…`）は、v2 を最後に変えた commit（`git log -- v2` の先頭が `c65e352d`）と一致する。
- **変わった葉（全件）**: `addendumId`（/2→/3）、`status`（frozen→draft）、`supersedes.path`／`sha256`／`commit`／`rule`、`reviewPlan`、`review`（v2 の object の 6 葉を消して null）、`afterMutationReadings.resealAfterMutation.rule`／`sealRule`／`measurementPoint`、`diagnosticNegatives[1..3].measurementProcess`（3 行とも同じ文）。
- **足したキー**: `resealAfterMutation` の下の `measurementPointDefinition`、`sealPoints`、`records`、`limits` の 4 つだけ。top level に足したキーは無い。
- **キーの順**: 共通のキーの相対順は全階層で v2 と同じ（比較の script で ORDER の出力が無かった）。新しい 4 キーは `resealAfterMutation` の末尾にある。
- **読み戻し**: v3 の版の欄 5 つ（addendumId、status、supersedes、reviewPlan、review）、`resealAfterMutation` 全体、3 つの `measurementProcess` を v2 の値に戻すと、`JSON.stringify` が v2 と一致する（true）。つまり `supersedes.rule` に挙げていない葉の変更は無い。`measurementProcess` で変わったのは、v2 の「B の seal が current に戻り」を地点ごとの規則への参照に替えた句だけ（共通の前後を切り出して確認した）。
- **仕様との照合**: `rule`／`sealPoints`／`records`／`limits` は DR (1)〜(3) と合う（§2）。`sealRule` の語は「本文だけの保存の地点で、静止の後に世代不変も通す」を表している。`measurementPoint` の改名は DR (3) のとおり。(8) との照合は §4 を見てほしい（1 件抜けている。P2-1）。
- `reviewPlan` は、この指示書の確かめること 1〜5 と一致する。v2 は v1 の文面を残していたので、v3 で書き直したのは妥当である。`graphRuntimeObservedBeforeAuthoring` は v2 の true のまま（前例 `77acdf2a` の誤りを繰り返していない）。
- 追記 3 の「v2 の 257 葉のうち 238 葉が同じ」は数え直していない（未確認）。葉の一覧は上のとおりで、追記 3 の列挙と一致する。

## 2. harness との一致（必須）

| v3 の文面 | 実装 | 判定 |
|---|---|---|
| 本文だけの保存の地点は N2 の mutation と N4 の宣言の前の保存 | `runG01NegativeStep` の `bodyOnly = spec.mutation === "resave-same-body"`（g01-negatives.mjs:650、:660）。N4 は wrapper が明示の `allowUnchanged: true` を渡す（g01-negative-run.mjs:174、preview.mjs:202）。N3 の宣言の前（`same-bytes-version`）は開き直さない（run.mjs:161） | 一致 |
| `freshnessSettle.when: once-per-opening-before-the-b-poll` | `waitG01NegativeSealed` が poll の loop の前に 1 回だけ `waitFreshnessSettled` を呼ぶ（:200-207） | 一致 |
| `settledWhen: cursor-acknowledged-at-least-head-no-active-run-no-reservation` | `freshnessSettled`（workspace-db.mjs:155-163）: head と acknowledged が整数、`acknowledged >= head`、`activeRun === false`、`reserved === false` | 一致 |
| `limit`／`interval` は FRESHNESS_SETTLE_WAIT_MS／INTERVAL_MS | :203-204。値は 60_000／250（frozen-setup-driver.mjs:167-168） | 一致 |
| `maintenanceQuiet: not-waited` | `readActivity` を渡していない（:201-207） | 一致 |
| `onNotSettled: new-generation-only` | `unchangedAllowed = freshnessSettle?.settled === true`（:208）。偽なら `g01SealBranch` は A-1 だけ | 一致 |
| 上限は静止の待ちを含めて waitMs | `started` は静止の待ちの前（:198）、判定は `now() - started >= limitMs`（:224）。60 s < 120 s なので、1 回の開きは最長でおよそ 120 s＋poll 1 回 | 一致 |
| `unchangedRequires` の 8 条件 | `bSealUnchanged`（:138-154）: prior と row があること、`Number.isInteger(previous) && previous >= 1`、`prior.dirty === false`、`row.generation === previous`、`row.dirty === false`、producerId／producerVersion／sourceDigest／dependencySetDigest の一致。`freshness-settled` は呼び出し側（:208、:538）。readIndexMetadata は 4 つの欄を実際に SELECT する（workspace-db.mjs:62-66、:40-43）。B の publish は 4 欄を書く（`nir1_entity_relation_index.rs:2710-2727` の INSERT／UPSERT。`snapshot.source.digest`、`d1.dependency_set_digest`、`PRODUCER_ID`、`PRODUCER_VERSION`）。このため、封印済みの B の行では、null 同士の空の一致にならないと読める（実 DB の値は見ていない） | 一致（8 条件と 1 対 1。過不足なし） |
| restore の地点は静止を待たず A-1 だけ | `allowUnchanged` は既定の false（:489、:660）。readFreshness は渡るが、`allowUnchanged` が偽なので呼ばれない（:200）。mutation の直後の feed も読まない（:652-653） | 一致 |
| Chronicle の再判定は同じ規則で、静止を待ち直さない | `recheckBranch = g01SealBranch(..., { allowUnchanged: allowUnchanged && sealed.unchangedAllowed === true })`（:537-539）。静止の再呼び出しは無い | 一致 |
| 外れたら sealed-then-dirty で次の開き直し／使い切れば blocked | :541-545、:556-561。Chronicle が使えなければ開き直さずに `chronicle-index-not-usable`（:546-552） | 一致 |
| records の欄の名前 | `sealBranch`／`freshnessSettle`／`settleCoversMutation`（:512-517）、`chronicle.recheckBranch`（:540）、`step.feedAfterMutation`（:669、:682）、`beforeDeclarationFeedAfterSaves`（run.mjs:95、:166、:332） | 一致（細部の不一致は P3-2、P3-3） |
| `settleCoversMutation` の意味 | :450-457: head が整数でない、または静止していなければ null。そうでなければ `acknowledged >= head` | 一致 |
| `measurementPoint`／`measurementPointDefinition` | `measurementProbe` は最後の sealAttempt の `chronicle.metadata ?? metadata` を読む（run.mjs:246-255） | **辺縁で食い違う（P2-2）** |

restore の地点の A-1 は、v2 の実装（`a1cd6675` の `bSealPublished(metadata, Number(before?.b?.generation ?? 0))`）と同じ式を `g01SealBranch` の最初の分岐で使っている（`git diff a1cd6675 HEAD` で確認）。

## 3. 緩和がないこと（必須）

- **restore の地点**: 上のとおり、規則・定数・reason は v2 と同じ。feed の読取りも増えていない。緩和は無い。
- **本文だけの保存の地点**: DR (1) は「前の世代が 1 以上で dirty でない」としている。実装と v3 は、これに `prior.dirty === false` と producer／digest の一致を足している。DR より厳しいので可。さらに、静止を待つあいだは A-1 も判定しないので、v2 より遅くなることはあっても、通りやすくはならない。
- **不変の葉**: §1 の読み戻しが一致したので、`inconclusiveWhen`、`verdict`、`control`、`sample`、`retry`（上限 60、間隔 250）、`seedRequested`、`mutationAfterDeclaration`、`mutationNote`、`beforeDeclaration`、`expectation`、`declarations`、`declarationValues`、`reopensMax` 2、`waitMs` 120000、`blocked` はすべて v2 と同じ bytes の値である。
- **緩和の方向の推論**（未検証。推論として書く）: A-2 で B を作り直さずに通すと、B は宣言の時点の世代のままになる。誤りがあるとすれば、g01-mira が返る側（not-established）か、判定不能の側に寄る。established を通りやすくする向きではないと読める。

## 4. 限界の開示（必須）

DR (2)(8) と (i)〜(vi) の対応は次のとおり。

| DR | v3 | 判定 |
|---|---|---|
| (8) 世代不変の分岐の有効性は X1-5 の分類に依る | (i) の前半 | 合う |
| (2) digest の照合は入力の保証ではない。その主張を書かない | (i) の中段 | 合う |
| (2) 入力の同一性は graphInputsDigest が見る | (i) の末尾 | 文は DR と同じだが、範囲を広く読ませる（P2-4） |
| (8) 「B が current」の意味の変更 | (ii) | 合う |
| (8) N2・N4 の blocked を見た後の規則の変更 | (iv) | 合う |
| (8) 開き直しで宣言が失われる欠陥 | (v) | 合う |
| (8) X1-5 は S4b''' の基点に入っていたが、封印待ちの前提をその下で確かめた記録は無い | **無い** | **P2-1** |
| （P3-6 の扱い）静止は 1 回だけ | (iii) | 真（:200-208、:537-539） |
| （dev の予告 (b)）静止が上限に届いたとき | (vi) | 真 |

- 「B の入力が変わっていない」と肯定で読める文は無い。v3 の「保証」の語は、(i) の否定文の 1 か所だけである（grep で確認）。
- 「B が current であることを保証する」のような言い回しも無い。

## 5. K2/4 との一致（必須）

- K2/4 draft :416「宣言の後に `g01-mira` の本文を同じ文字列で保存し直すと出ない。…本文版を restore すると（同じ bytes に戻す場合も）出ない」と、:534 の表の行「同じ文字列での再保存も失効させる」。v3 の N2 の `mutationAfterDeclaration`／`mutationNote`／`expectation`（「本文 Source の token の前進で失効する」）、N3／N4 の restore と期待は v2 の bytes のままで、これらの文と合う。
- 契約の文は変えていない。K2/4 draft の最終更新は `a0ce11aa` で、この branch では触っていない。v3 の封印の規則は K2/4 の「B の seal の手順（観測前の commit が書き足す）」の範囲の読みで、期待値は変えていない。

## 6. path の向け直し（`ee43c197`）

- 3 file の差分は path の文字列と、その説明のコメント 2 行だけである（`frozen-k64-admission.mjs:42-44`、`test-support.mjs:1924`、`frozen-k64-plan.test.mjs:184`）。挙動の変更は無い。`frozen-k64-*.test.mjs` は通る。
- `grep -rn "setup-addendum.v2" scripts evals docs/plans/nir1-lane-decisions` の全件（HEAD の行番号）を次のように分けた。

| 箇所 | 分類 |
|---|---|
| `observation-prep.mjs:3`（header のコメント）、`:43`（`OBSERVATION_PREP_FILES.setupAddendum`） | v3 に向ける（#12） |
| `observation-prep.v1.json:58`（`d1.addenda`）、`:396`・`:405`・`:414`・`:423`（`diagnosticRuns[*].source`）、`:628`（`boundFiles`）、`runnerHandoff[20]`（:864 付近） | v3 に向ける（#12） |
| **`observation-prep.v1.json:707`（`placeholders` の `S4:setup-addendum-commit` の `fill`「frozen にした setup-addendum.v2.json を含む commit」）** | **見落とし**。追記 3 の列挙に無い。v3 に向ける（#12） |
| `observation-prep.test.mjs:1322`（「v2 は v1 の写し」の試験）、`:5042`、`:5059` | v3 に向ける、または v2 の履歴の試験として残す（#12 で決める） |
| `observation-prep.mjs:1443` と `observation-prep.test.mjs:5089`（`G04_REVISION_RULE_FILES`。S2 追補 #11 の rule の語） | v2 の履歴（#11 の記録）として残すのが妥当。ただし #12 で決める |
| `evals/quality-manifest.yaml:696` | v2 の行は残し、v3 の行を足す（既知）。分類漏れで落ちる試験は無い（`impact-map.test.mjs`・`quality-workflow.test.mjs` は通る。`evals/impact-map.yaml:365` は `evals/nir1-g01/**` の glob なので v3 も入る） |
| `declaration-addendum.v2.json:198`（凍結済み）、`v3.json:36`（supersedes）、`cp4-decisions.md:890`・`:1033`・`:1045` | v2 の履歴として残す |

- grep の外の見落とし: `observation-prep.mjs:146` の `SETUP_ADDENDUM_ID = "…/2"`（追記 3 (c) は既に挙げている）と、**`observation-prep.test.mjs:1468`（addendumId の `/3` を誤りとして拒む試験。#12 で逆にしないと落ちる）**。
- 追記 3 が挙げた行番号（v1.json の :400 など、test の :1385 など）は、`0d456ee2` の revert の後の HEAD とずれている（上の表が HEAD の番号）。これは記録の側の注意点で、v3 の不備ではない。

## 7. 迂回路・誤読

- 「A-2 はどの mutation でも通る」とは読みにくい。`sealRule` の語が `…-at-body-only-save` で終わり、`rule` は「restore の地点は (A-1) だけで、世代不変は認めない（v2 と同じ）」と書き、`sealPoints.restore.passes` は `["new-generation"]` だけである。
- ただし、N3 の `measurementProcess` は、N3 に無い「本文だけの保存の地点」の規則の要約を含む（3 行が同じ文）。地点の名指しは sealPoints の参照に任せている（P3-5）。
- 地点名 `K24-G01-N2:mutation`、`K24-G01-N4:beforeDeclaration`、`K24-G01-N3:mutation`、`K24-G01-N4:mutation` は v3 だけの識別子で、実装の文字列には現れない。実装の鍵との対応は次のとおり（P3-4）。
  - N2:mutation: `spec.mutation` の `resave-same-body`。operations[0] と一致する。
  - N3／N4:mutation: `restore-same-bytes-body-version`／`restore-different-bytes-body-version`。一致する。
  - N4:beforeDeclaration: 実装の kind は `draft-then-original`（frozen-diagnostics.mjs:108）、label は `before-declaration`（run.mjs:172）。v3 は v2 の `beforeDeclarationWriter` の値 `saveSceneContent-then-createRevision` を使っている。実際の操作は、保存→createRevision→元の本文の再保存の 3 段である。
  - step の label は既定の `measure`（:488）。

## 8. S2 追補 #12 の作業一覧に足すもの（既知の一覧の外）

1. **validator の supersedes の連鎖**: `SETUP_ADDENDUM_V1`（observation-prep.mjs:141-144）、`SETUP_V1_COPY.readBack`（:156-185）、`supersededSetupAddendum` の読込み（:4680）、`supersededCopyErrors`（seed-pin-addendum.mjs:49-91）は、どれも v1 の写しを前提にしている。v3 には次の 3 つが要る。
   - v2 を束縛する定数（path、`fd6b0c3c…`）
   - v3→v2 の readBack: `resealAfterMutation` を v2 の値に戻し、足した 4 キーを消す。3 つの `measurementProcess` の句を戻す。**`reviewPlan` も戻す**（`VERSION_FIELDS`〔seed-pin-addendum.mjs:42-48〕に `reviewPlan` は無いので、戻さないと `reviewPlan differ` で落ちる）
   - v1 も連鎖で照合するかの判断
2. **`supersededReferences`**（:4847-4856）: v1 の path・sha256 と v3 の `supersedes.commit`（`c65e352d`）を組む。`c65e352d` は v1 を同じ bytes で持つので通ってしまうが、意味は v2 の照合に変えるべきである（formal の gate の `formalReferenceRows`）。
3. **`SETUP_ADDENDUM_ID`**（:146）を /3 にし、**`observation-prep.test.mjs:1468` の `/3` を拒む試験を逆にする**。:1318-1332 の「v2 は v1 の写し」の試験を履歴として残すか、v3 版にするかを決める。
4. **`G01_RESEAL`**（:1132-1138）は値だけでなく、error 文（:1770-1772「until a new B generation is sealed」「measuring at the reopened Main's sealed generation」）も v3 の意味に直す。`sealPoints` の検査を足すなら、`freshnessSettle.limit`／`interval` を `HARNESS_CONSTANTS` の driver の 4 定数（:770-775）の値と照合できる。
5. **S2 の `placeholders` の `fill`**（observation-prep.v1.json:707）を v3 にする。`observation-prep.test.mjs:5062` の `addendum\.v1\.json` の否定と同じ形の、v2 の否定を足すかも決める。
6. **S4 の freeze record**（S4b''''）の `boundFiles` が v3 の path を束縛すること。`readFreezeBoundFile`（frozen-k64-admission.mjs:139-146）が S2_FILES の各 file を freeze record の束縛と照合するので、束縛が無いと admission で止まる。#12 の外（S4b''''）だが、順の確認として挙げる。
7. 隣接（#12 の外）: 作者の宣言（S4a''''。`observation-prep-author-declaration.v1.json`）に DR (8) の 5 つの開示と、この読みの変更の revisions の行を書く。
8. v3 の凍結の前に決めること: P2-3 の `afterMutationReadings.status`（追記 3 (d) の「master 950751d0」を含む）。

## 指摘

### P1

なし。

### P2

- **P2-1 DR (8) の開示の 5 つ目が v3 に無い。** DR-CP4-S4-8 (8)（cp4-decisions.md:874）は、開示先を「S7・作者の宣言・v3」として 5 項目を挙げている。最後の「X1-5 は S4b''' の基点に入っていたが、封印待ちの前提をその下で確かめた記録は読んだ範囲に無い（事実だけ。評価は書かない）」が `limits` に無い。(iv) は「blocked を見た後に決めた」とだけ書いている。凍結の後は足せないので、(vii) として足す（評価の語は入れない）。
- **P2-2 `measurementPointDefinition` の鍵が実装と辺縁で食い違う。** 定義は「世代不変の分岐（sealBranch が unchanged）では B は mutation の前と同じ世代、C は新しい世代」としている。一方、`measurementProbe`（run.mjs:246-255）が読むのは Chronicle の build の**後**の metadata である。A-2 で通った後、build のあいだに B が作り直されて再判定が `new-generation` になると（:537-545。A-1 は全地点で通る）、sealBranch は `unchanged` のままで、測定点の B は新しい世代になる。また「C は新しい世代」は、harness が確かめていない（見ているのは `usable` だけ。:525-527）。直し方は 2 つ。
  - 定義の鍵を「最後の判定の分岐（`chronicle.recheckBranch`）」にし、C は「Chronicle の build の後の current な世代」と書く。
  - `records.rule` の「S7 は mutation ごとに sealBranch を開示する」に `chronicle.recheckBranch` を足す。

  判定には影響しない（probe は実際の metadata と照合する）。ただ、事前登録の文面と実装が食い違うので、P1 の境界に近い。P1 と見るかどうかは integrator に委ねる。
- **P2-3 `afterMutationReadings.status` が DR-CP4-S4-8 の変更を書いていない。** この欄は「S3 の 7 回目が追補 #4 の版を確かめた…7 回目の後に #5（c5d481c4）と #6（94fc8ed4）が変わり、その変更を S3 が見た記録は無い」と書いている。しかし v3 は、同じ節の `resealAfterMutation` を S3 の後に変えた。その変更と「S3 ではなく独立コードレビューが見た」ことが、この欄に無い。このまま凍結すると、この節は S3 が確認した版から #5・#6 だけが変わったと読める。直すなら、`supersedes.rule` に `afterMutationReadings.status` を足して整合させる。同じ欄の「master 950751d0」（追記 3 (d)）も、凍結の前に決める。値は同じでも、読み元の pin は #12 で変わる。
- **P2-4 `limits (i)` の「入力の同一性は harness 既存の graphInputsDigest（…）が見る」が範囲を広く読ませる。** 直前の文が「B の入力」の話なので、B の入力の同一性を graphInputsDigest が見ると読める。実際の graphInputsDigest は、codex_entries の（id、type）、codex_relations の（id、端点、型）、pins の（scene、entry）の列だけを見る（g01-negatives.mjs:265-272、workspace-db.mjs:327-342）。B は metadata、D1、V1、Freshness の authority の上の cache である（nir1_graph_index_maintenance.rs:3-4）。そこで、既存の `afterMutationReadings.limits`（v2 の文）と同じく「Graph の関係の入力（…）の同一性は graphInputsDigest が見る。B の入力の全体の同一性はどこでも照合しない」と書き分ける。この文は DR (2) と同じなので、DR の表の側は変えずに、v3 だけを正確にすればよい。

### P3

- **P3-1** `rule` の「静止しない、どちらの分岐も満たさないときも…b-seal-not-published」は、「静止しなければ not-published」とも読める。実装は、静止しなくても A-1 で通る（:208-215）。同じ文の前の「静止しなければ (A-1) だけで待つ」、`onNotSettled`、(vi) が正しいので、読点の位置を直す程度の話である。
- **P3-2** `records.rule` の「通らなかった回は null」は、sealed-then-dirty の entry に当てはまらない。この entry は最初の判定の `sealBranch` を保持したまま `recheckBranch` が null になる（:512、:540-542）。「sealBranch は最初の判定の分岐、outcome が not-published の回は null」と書く。
- **P3-3** `records.rule` の対象の列挙（「N2 は step.sealAttempts、N4 は…」）に、N3 の `step.sealAttempts` が無い（N3 にも sealBranch は残る）。
- **P3-4** 地点名と operations は v3 だけの識別子である。§7 の対応（`resave-same-body`、`draft-then-original`、label `measure`／`before-declaration`、N4 の 3 段の操作）を 1 行書いておくと、照合しやすい。
- **P3-5** `measurementProcess` の要約は、A-2 の付帯条件（前の世代が 1 以上、前の B も dirty でない、producer／digest の一致、静止しなければ A-1 だけ）を省いている。N3 の行には、N3 に無い地点の規則の要約も入る。sealPoints を参照しているので P3 とした。
- **P3-6** 新しい停止の経路が開示されていない。formal は本文だけの保存の地点で常に readFreshness を注入する（run.mjs:143、:209）。feed の表が読めないと、例外で run が止まる（blocked ではない。追記の「気づいた点 (ii)」）。v2 には無かった停止で、fail-closed なので P3 とした。A-2 が `readFreshness` の注入を前提にしていること（:200）も、文面には無い。
- **P3-7** `freshnessSettle.limit`／`interval` は定数の名前だけで、値（60000、250）が無い。`reopensMax`／`waitMs` と同じく値も書けば、validator が `HARNESS_CONSTANTS` と照合できる。driver の bytes は S2 の pin が固定するので、P3 とした。
- **P3-8**（harness。v3 の外。dev 専用）preview は reopen が失敗した reason を常に `b-seal-not-published` にしている（preview.mjs:250）。`chronicle-index-not-usable` が区別できない。

## 判定

**(b) 修正してから受入れ可。**

修正点（凍結の前）:
1. P2-1: `limits` に DR (8) の 5 つ目を足す。
2. P2-2: `measurementPointDefinition` の鍵を最後の判定の分岐にし、C の記述を「build の後の current な世代」にする。S7 の開示に `chronicle.recheckBranch` を足す。
3. P2-3: `afterMutationReadings.status` に DR-CP4-S4-8 の変更と見た者を書き、`supersedes.rule` に足す（950751d0 の扱いも決める）。
4. P2-4: `limits (i)` の末尾を、Graph の関係の入力に限った文にする。
5. P3 は任意（P3-1〜P3-7 は文面だけの修正で済む）。

再レビュー: 全面の再レビューは不要と考える。修正の後に、v2 との葉の比較（`supersedes.rule` に挙げた葉だけが違うこと、v2 に読み戻して一致すること）をやり直し、変えた葉を目視で確かめれば足りる。修正が `rule`／`sealPoints`／`unchangedRequires`／restore の地点の葉に及ぶ場合は、§2・§3 の照合をその葉についてやり直す必要がある。
