# S3 の 7 回目の独立レビュー（S2 追補 #4）の報告（原文）

この file は、S2（観測前の準備 file `evals/nir1-graph/observation-prep.v1.json`）の追補 #4 に対する S3 型の独立 reviewer の最終報告を、**原文のまま**残す記録。reviewer は Claude（Opus、effort high）の subagent で、人間ではない。ユーザーの確認ではない。

- 実施日：2026-10-30（JST）。
- 対象：branch `claude/cp4-s2-observation-prep` の HEAD `bc2500da`（見た差分は `968f6782` と `bc2500da`。master の merge `00fe0e4a` の取り込み分は除く）。
- 依頼の要点：問い 1〜4（P-S2-6〜P-S2-9）を先入観なく判断する。integrator は結論を渡していない。read-only（file の編集、commit、push をしない）。
- 判定：**accept-with-conditions**。条件 C1〜C3（P-S2-6）と、bytes の pin の不足（P-S2-9）、P3 の文の修正。
- 条件の充足：C1〜C3 は harness の PR #757（master `43e3f40b`）、pin の不足は S2 の追補 #5（`c5d481c4`）と追補 #7（`9fc5221d`）、P3-1／P3-2／P3-3 は追補 #5／#6、記録は `docs/plans/nir1-lane-decisions/cp4-decisions.md` の DR-CP4-P-2〜P-4 と DR-CP4-Q-1。
- この記録は、7 回目の報告の原本が repo に無かったことを受けて、2026-10-30 に integrator が会話の記録から書き起こした。reviewer が使った scratchpad の script（`asym.mjs`、`closure.mjs`、`closure.txt`）は repo に無い。**1〜6 回目の報告の原文はこの記録に含まれない**（要旨は DR-CP4-L-28、P-1 などにある）。

---

## 報告の原文

## S3 型の独立レビュー（S2 追補 #4、HEAD bc2500da、対象 968f6782 と bc2500da）

### 1. 総合の判定
**accept-with-conditions**。pin の bytes、harness の定数、parity の選択の写しは正確でした。条件は 2 つで、問い 1 の規則を条件つきでしか採れないこと、問い 4 の pin が足りないことです。

### 2. 問いごとの決定

**問い 1（P-S2-6）: 条件つきで逸脱でない。**
- 条件 C1〜C3 を採れば、SP/1 の改版もユーザーの確認も要りません。S2／harness の読みの改訂で足ります。ただし予定しているユーザー通知に、この読みを明記してください。
- 提案のまま（選択肢 a）採るなら**逸脱**で、ユーザーの確認が要ります。

根拠:
- (a) 目的との整合: IR の期限は seed の pin の段に依りません。期限切れの sample は IR の値を測れていないので、比較から外すこと自体は診断の目的（段の影響の検出）に合います。dev の観測は 35 件中 2 件で、R は全件一致です。
- (b) 検出力の低下が実在します。
  - harness は `ir-ready` 以外の outcome をすべて外します（`frozen-diagnostics.mjs:369, 524-531`）。外れるのは `timeout` だけでなく、`failed`／`ir-unavailable`／`cancelled`／`invalidated`（`src/features/related-scenes/nir1RelatedScenesDeadline.ts:6-13`）も含みます。
  - 側の間の偏りを検出せず、組の最小数もありません。
  - 合成で再現しました（scratchpad の asym.mjs）。without の側が 30/30 `ir-ready`、with の側が 1/30 `ir-ready` で残り 29 が `timeout`／`failed`／`ir-unavailable` のとき、提案の規則では stable かつ `same:true`（SP-P4 passed）になります。`current` では `[precheck]` です。
  - with の側が 30 件とも `ir-unavailable` のとき、`current` と SP/1 では SP-N7 ですが、提案の規則では `[precheck]` に下がります。
  - pin が IR を失敗させる・遅らせるという R+IR の変化を、SP/1 の文面は R+IR の不一致（SP-N7）として捕らえます。提案の規則では、それが開示だけになります。
- (c) 必要な措置: 条件つきで harness と S2 の読みの改訂。

条件:
- **C1**: IR の欄を外すのは、outcome が `timeout`（deadlineExceeded true）で、R+IR＝R、共通追加枠が null の sample に限る（`explainSpP4Instability` の explained と同じ条件）。それ以外の非 ready は `current` と同じに比べる（片側が常に unavailable なら SP-N7 のまま）。
- **C2**: 期限切れの上限を観測の前に固定する。止める側だけの上限で、variant と側ごとに measured 30 件のうち `timeout` が K 件を超えたら `[precheck]`。K は例えば 3（dev は 2/35）。これで偏りと最小の組数（24 以上）を同時に押さえます。harness の定数にし、S2 が写して validator が照合します。「しきい値は足さない」は撤回が要ります。
- **C3**: 切替は harness の別 commit で行い、S2 がそこに pin し直す（S4 の前）。validator は切替を choice "a" のときだけ許すので（`observation-prep.mjs` の comparisonRule の検査、`decided?.choice !== "a"`）、この条件つきの決定を受けられるよう直す。

**問い 2（P-S2-7）: a（意図を保つ。限界は開示）。**
- 対照は、同じ workspace・同じ seed で、DTO の Graph-only の行と orin→mira-entity の edge から reached を判定します（`g01-negatives.mjs:296-312`）。
- sample の「届いた」は、対照が reached、Graph の入力の digest が同じ、親の fetch の seed、最初に決まった graph-ready、A3 eligible をすべて満たすときだけです（`g01-negatives.mjs:556-575`）。
- 不確かさはすべて inconclusive に倒れ、偽の established にはなりません。
- 残余は 2 つで、どちらも S2 の `limits` に開示済みです。B の Index の中身は比べていません（A3 が edge の材料の eligibility を補います）。不適格の理由も観測していません。
- N4 の文は harness と食い違っています（P3-1）。

**問い 3（P-S2-8）: a（結果を選ばない）。**
- 定数は一致しています。`G01_CONTROL_ATTEMPTS`＝60、`G01_SAMPLE_ATTEMPTS`＝60、`G01_GRAPH_READY_WAIT_MS`＝10000、`G01_CONTROL_GAP_MS`＝250（`g01-negatives.mjs:191-197`）。`B_SEAL_REOPENS`＝2、`B_SEAL_WAIT_MS`＝120000（`frozen-setup-driver.mjs:118,131`）。いずれも setup-addendum の値と同じです。
- 聞き直すのは中立の答えだけで、unavailable も決まった答えとして止まります（`askUntilDecided`）。親が決まっていれば親を使い、子は使いません（best-of でない）。
- late の答えは Graph の寄与を欠くので、採るとかえって偽の established に寄ります。聞き直しは保守側です。
- 30→60 の引き上げ（dc1c9b29）は dev の fixture を見た後の決定ですが、凍結した G-case の観測の前です。効果は undetermined を decided に変えることだけです。S4 で凍結すれば問題ありません。
- 開示の欠け（P3-2）があります。

**問い 4（P-S2-9）: 不足。b を推奨。**
- 正式の入口（diagnostic-runner、trace-runner、frozen-k64-run、frozen-setup-driver、r5-check-runner）の静的な import の閉包のうち、28 file が pin にありません。
- 一覧: admission-facts、availability、build-receipt-check、constants、dev-fixture、dprime-check、egress、eval-native-build、followup、join、keep-test、launcher、native-architecture、native-sample、observer-core、outcome、procedure-file、q4、r5-check-runner、receipt、renderer-build、run-sample、seed-pin-setup、seed-pin、session、setup-driver、signal-cleanup、stats（.mjs）。
- S5 の admission は pin の file と祖先関係しか見ません（`frozen-k64-admission.mjs:137-188`）。候補の commit は S4 の後に決まります（`observation-prep.v1.json:52`）。したがって、これらの file が候補で変わっても止まりません。選択肢 a の根拠「祖先なら同じ bytes」は成り立ちません。
- 測定の結果を変えうる例:
  - `seed-pin.mjs`（`compareSeedPinParity` は SP-P4 の比較、`assertSeedPinsBeforeK64` は R5）
  - `run-sample.mjs`（`a3AtStartOf` は N2〜N4 の reached、`snapshotOf` は U）
  - `availability`、`outcome`、`stats`、`followup`、`join`
  - `constants`（`FROZEN_FIXTURE_SHA256`、`K64_FREEZE`）
  - `procedure-file`、`receipt`

### 3. finding
- **P2-1**: 上の問い 1 のとおり、`ir-complete-pairs` は失敗系の outcome も外し、偏りの検出と組の最小数がありません（`frozen-diagnostics.mjs:369,401-411,524-547`、`observation-prep.v1.json:475`）。再現は合成の記録で、上に書いたとおりです。
- **P2-2**: 上の問い 4 のとおり、閉包の 28 file が pin にありません。
- **P3-1**: N4 の `beforeDeclaration` の文（`evals/nir1-g01/setup-addendum.v1.json` の N4）は「本文の保存の writer で版を作る」と読めます。harness は `saveSceneContent` と `createRevision`（manual）で版を作り（`renderer/cp4-diagnostic-probe.ts:116-134,154-178`）、N3 の文も「本文の保存の writer では版を作らない」としていて、食い違います。版が無ければ blocked になるので結果は変わりませんが、文を直してください。
- **P3-2**: S2 の `retry.rule` は「各 sample の全回の counter の差分と cached を記録」としています。しかし sample の `askGraph` は `readCounters` を渡していません（`g01-negative-run.mjs:202-211`）。そのため counter と cached は null です。捨てた take の返却 Scene も記録されません。開示だけの欠けですが、捨てた回に g01-mira が出たかどうかも残すべきです。
- **P3-3**: DR の O-6（10 回、1.2 s）と O-15（30 回）の文面は古いままです。P-1 が上書きを記録しているので、扱いは妥当です。O-6 と O-15 の行に「P-1 で更新」の注を足すとよいです。

validator（`sourcePinGitErrors`、定数を pin の bytes から読む照合、`SOURCE_PINS` の check と path の照合）に、検査を素通りさせる抜けはありませんでした。読めない場合、shallow な clone、file の移動のどれでも閉じる側に倒れます。

### 4. S4 の前に直すこと
1. P-S2-6 は C1〜C3 を harness の定数と比較で実装し、S2 が pin し直す。validator の choice の gate も直す。採らないなら `current` のまま、またはユーザーの確認を取る。
2. 問い 4 の 28 file を bytes の pin に足す（最後に変えた commit ごとに role を足す）。renderer の入口も含める（既に pin 済み）。
3. P3-1 と P3-2 の文と記録を直す。

### 5. 実行した検証
- `node --test scripts/quality/nir1-graph/*.test.mjs`、`impact-map.test.mjs`、`eval-fixtures.test.mjs`: 148 件 pass。
- harness の `frozen-diagnostics`、`g01-negatives`、`g01-negative-run`、`frozen-k64-admission` の試験: 50 件 pass。
- bytes の pin の全 26 file を確かめた。`git show <commit>:<path>` の sha256 と HEAD の file が一致し、それぞれ 950751d0 の時点でその file を最後に変えた commit。pin の 10 commit はすべて 950751d0 の祖先。
- `ir-complete-pairs` の反例を合成で確かめた（scratchpad の asym.mjs）。
- import の閉包を計算した（scratchpad の closure.mjs、結果は closure.txt）。
- `git diff 090ad95f..bc2500da` で、SP/1 の draft（SHA-256 8ccdf534… は一致）、K6 の draft、`AGENTS.md`、`.agents/`、`policies/` が変わっていないことを確かめた。

file の編集、commit、push はしていません。
