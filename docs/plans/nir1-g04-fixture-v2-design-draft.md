# NIR-1 CP-4：G-04 fixture の新しい版（v2）の設計案（草稿）

状態：**草稿の 2 版**。Fable の独立レビュー（結論「(A) で進めてよい。条件 5 つ」）を反映し、§4.6 の校正の probe を実行した（付録 A）。ユーザーにはまだ示していない。fixture・README・manifest・S2・harness・製品の code・閾値・Gold は変えていない（この文書を足しただけ）。
基点：master `588bb4d1`（branch `claude/g04-fixture-v2-design`）。測定の受領書は `claude-cp4-s5cand`（`86427ee5`）の `.artifacts/cp4/`、記録は contracts の `docs/plans/nir1-cp4-records/` を読んだ（読むだけ）。
方向の確認：ユーザーが 2026-11-01 に「β: G-04 の fixture を新しい版にする」を確認済み（contracts `user-confirmation-2026-11-01-x1-g04-spike.md`:9、:15）。

## 要点

1. v1 の G-04/base は、宣言した前提条件 `raw-membership` と `ir-supplement-admission` が Gold の 30 回すべてで成り立たなかった（R＝R+IR＝[control, rv-match]）。原因は model-only probe で測定済み：lio-landing の IR 文の cosine 0.556 が floor 0.66 に届かず、rv-match の本文 0.4925 が相対救済で R に入った。
2. 失われているのは IR 補完の検証ではない（G-05 は成立）。**G-04 しか測らない Scope exact／unknown の比較（負例 N1〜N4、Graph DTO）が 1 回も評価されていない**。v2 の価値はここ。
3. **推奨は (A) の最小差分**：比較する期待値（manifest の `comparedFields`）は 1 byte も変えない。変えるのは測定条件の入力（lio-landing の IR 要約と、Gold 0 の review Scene の本文。推奨の δ では rv-match と rv-unknown）と、版の識別（fixtureId）・予測の説明文だけ。Gold・query・Scope・pin・Revision・閾値は不変。
4. 入力は凍結前の model-only probe で選ぶ。合格条件は製品の基準より余裕 δ だけ厳しくする。**δ は G-04 以外の観測済み 7 case で校正した（付録 A）**：Raw の予測は全 case で観測と一致した。IR は 8 行のうち G-03 の 1 行だけ外れた（floor の 0.0062 下と予測したが採用された）。probe と製品の保存ベクトルのずれは最大 0.0150（G-02）。これを踏まえ **δ＝0.03 を推奨**する（ずれの最大の約 2 倍）。
5. 候補は、probe・spike・診断を知らない別の agent が書く。sha256 を probe の前に記録し、全候補を測って全結果を受領書に残し、固定の順で採る。全部が不合格なら止めて、ユーザーに戻る。
6. 採らない案：B は observationPolicy の最初の語（query）を変える。C は lio の pin が 2 Scene にあり、追加候補が一意にならない。C-body が Hold の間は Hold にもなる。D は corpus の作り直しで、選ぶ自由度が最大。E2 は観測の後に前提条件を読み替えることになり、確認済みの β の範囲外。
7. **副次の所見は訂正が要る**：G-02／03／06／07 の raw の `orderPredeclared` は **false**（validator が「control が 1 件のときだけ true」を強制）。raw-membership は集合で比べるので、順序の違いは前提条件にも比較にも効かない。v2 の範囲に入れない。
8. 波及：freeze の sha256 が変わり、S2 とその追補、S4、harness の定数（`constants.mjs`）に及ぶ。観測の後に作った版だと正直に記録するには、validator と schema を変え、README:265-266 の規則文も改訂する必要がある。validator には、G-04 以外の fixture と schema の sha256 が v1 freeze と一致することを束縛する検査も足す。
9. 今の S6 の集計は `s4Commit` を 1 つだけ通すので、S4 を凍結し直したら ④⑤ は全部やり直しになる。X1-5 の再測定と 1 回にまとめるのを推奨する。
10. 限界：v2 の G-04 は、IR 要約が query の役割名詞・動詞と語彙を共有する前提の下で Graph を測る case で、IR の recall の品質の証拠にならない。このことを fixture、manifest、README に書く（§5.6）。
11. ユーザーの確認が要る点：δ の値、観測後の版の記録方法（規則文の改訂を含む）、全候補不合格のときの扱い、測定のやり直しの範囲、probe の道具（§7.2）。

---

## 1. 何が成り立たなかったか（fixture の宣言と観測の対応）

### 1.1 観測（確かめた事実）

- Gold `gold-s5r4-1/G-04_base.receipt.json` の hybrid arm、measured 30 sample では `rawSceneIds` と `finalSceneIds` がどちらも 2 件。setup の受領書（`claude-cp4-s5cand/.artifacts/cp4/s5r4-g-04-base/setup/G-04/base/setup-receipt.json`）で論理 ID に写すと、**30 件すべてで R＝R+IR＝[g04-control, g04-rv-match]** だった（写した script は作業用で、repo には入れていない）。
- 比較のために G-05/base を同じ方法で写すと、30 件すべてで R＝[g05-control]、R+IR＝[g05-control, g05-xan-watch]。期待どおりで、前提条件は成り立っている。
- Gold の README（contracts `gold-s5r4-1/README.md`）では 13 variant が `measured`・`valid: true` で、`x` の非 0 は G-04/base の `X5` 30 件だけ。可用性の pool（`availability.mjs:240` の `inPool = expectedGraph !== "unavailable"`）は blocked を扱わず、G-04/base を 30/30 欠落と数えた（contracts `g04-base-diagnosis.md`:7）。

### 1.2 宣言ごとの対応

| fixture の宣言（`g04-scope-exact-unknown.v1.json`） | 予測していたこと | 観測・測定 | 判定 |
|---|---|---|---|
| `variants[base].preconditions`（:401-419） | `raw-membership` と `ir-supplement-admission`（sceneId `g04-lio-landing`）が成り立つ | 両方とも成り立たない | README:94-96 の規則では `blocked:raw-membership`（定義順で最初の id）、もう一方も併記 |
| `expectations.arms.raw`（:422-425） | [g04-control]、順序まで宣言 | [control, rv-match] | 不一致（`outcome.mjs:177-181` は順序宣言ありなら `sameList`） |
| `arms.rPlusIr`（:426-431） | [control, lio-landing]、`irSupplementSceneId` = lio-landing | [control, rv-match]（IR の補完なし） | 不一致（`outcome.mjs:183-195`） |
| `arms.rPlusIrPlusGraph`／`graph`／`pathAttachments`／`blockedCandidates`／`metrics`（:432-558） | Graph DTO は bren・lio と ferried-lio。path は lio-landing に付く。lio-market は `ir-supplement-used` で追加しない | blocked なので**評価しない**（README:96） | 未評価 |
| `scenes[g04-rv-match].body`（:38） | S2 と語彙を共有しないので R に入らない（`measurementBoundary.rawPrediction`、:609） | 質問との cosine 0.4925。gate 0.51 には届かないが、相対救済で入る | 予測が外れた。語彙の検査（`contract.mjs:770,800`、`porter.mjs`）では dense を見ない（README:164） |
| `qualifiedIr[g04-lio-landing].summary`（:320-326） | floor 以上で採用され、枠を使う | cosine 0.5559（保存ベクトル 0.5527）＜ floor 0.66 | 予測が外れた。凍結前に probe していない（manifest:198-199 `admissionProbe: "not-run"`、README:185、:229） |
| `measurementBoundary.setupRefusal`（:608） | 前提条件が成り立たなければ blocked で、調整して再実行しない | — | v1 は blocked として記録に残す |

### 1.3 原因の測定（contracts `s6-aggregation-s5r4/g04-cosine-probe.md`、`g04-cosine-probe.json`）

- 道具：製品と同じ int8 の bge-small-en-v1.5、CLS プーリング、L2 正規化、英語は prefix なし。golden 7 件で再現性を確認（avg 0.99747、min 0.99688）。IR 文を `ordered-json/1` で直列化して埋め込むと、cold workspace に保存された IR ベクトルとの cosine は 0.99833（control）と 0.99785（lio-landing）。
- 質問を本文だけにしたときの値（製品の query は本文の末尾 500 字で、題を含まない。下の §4.2）：
  - IR：control 0.6614（保存ベクトルでは 0.6598）、lio-landing 0.5559（同 0.5527）。
  - Raw：control 0.8083、**rv-match 0.4925**、rv-unknown 0.4390、rv-unresolved 0.4271、lio-market 0.4248、rv-alt 0.3923、rv-holder 0.3697、lio-landing 0.3597。
- **probe の中央値は製品と定義が違う**（`g04-probe.mjs`:51 は上側の中央値、製品の `selectRelatedScenes.ts:77` 以下は偶数個なら中央 2 値の平均）。製品の定義で計算し直しても結論は同じ：中央値 0.42595、＋0.05＝0.47595。rv-match は 0.46 以上（`relNearFloor`、:169）で、中央値との差も 0.05 以上（:179-183）。勝者の control が 0.51 以上（`hasWinner`、:171）なので相対救済が働く。
- probe と保存値のずれは最大 0.0032（lio-landing の IR：0.5559 と 0.5527）。control の IR は probe で 0.6614、保存ベクトルで 0.6598 と floor をまたいでおり、製品では採用された（diagnosis:12「子の IR は 1 件（R の先頭と同じ Scene）」）。**floor の近くでは probe だけで採否を断定できない**。§3 の余裕 δ はこのため。G-04 以外の case での校正（付録 A）では、ずれは最大 0.0150、予測が外れた行は G-03 の 1 行だった。

### 1.4 v1 で失ったもの

- G-04 は「Scope exact／unknown」の唯一の case（README:24）。blocked なので、Scope の負例（N1 worldline 不一致、N2 unresolved、N3 unknown marker、N4 character holder。fixture:576-601）の Graph DTO の比較が CP-4 で 1 回も行われていない。
- IR補完済みの区分の検証（manifest:194-197）は G-05 が成り立っているので「未検証」にはならない（README:106-107）。ただし区分の case は 1 つだけになっている。

---

## 2. v2 の直し方の選択肢

### 2.1 比べる観点：評価の誠実さ

- fixture の `observationPolicy`（:16、manifest:7）は「観測を見て query・corpus・seed・Gold・順序・指標を変えない」。一方 README:211 は「改版が要るなら失敗を残したまま別の版を提案し、独立期待値レビューと freeze をやり直す」、manifest:191 は「blocked の variant は新しい版と新しい独立期待値レビューでだけ測れる」と定める。つまり **policy は同じ版の中での変更を禁じる規則で、新しい版は規則の内側の手続き**。v1 の結果（blocked）は消さない。
- それでも v2 は観測の後に作るので、「製品の挙動に合わせて期待を作る（tuning to the product）」の危険がある。誠実さは次の 3 点で判断する。
  1. **何に合わせるか**：G-04 が測るのは Graph（Scope の除外、path の付加、枠の規則）。Raw と IR は Graph を測る土台で、README:112 は「Raw と IR の membership は入力（設計上の予測）として扱う」と書く。土台の入力を Raw／IR の基準に合わせるのは、Graph の期待を観測に合わせることとは違う。逆に、Graph の比較 field を観測に合わせて変えれば、それは tuning にあたる。
  2. **何を見て決めるか**：runtime の出力ではなく、凍結前の model-only probe で決める。manifest:199 の `probeOption` は「凍結前に probe して IR 要約を改訂してよい。probe と結果を freeze に記録する」と、この手続きをもともと想定している。
  3. **選ぶ余地をどれだけ残すか**：候補と合格条件を probe の前に固定し、選び方を機械的にする。
- 独立期待値レビューが確かめるべきこと（§3.3 で詳しく）：差分が宣言した field に限られているか。Graph の期待値を規則だけから導き直して v1 と一致するか。入力の候補が書き方の規則を守っているか（場面の解釈として忠実で、query を写していない）。probe の生データに対して選択が機械的だったか。

### 2.2 選択肢の比較

| 案 | 変えるもの | 変わる期待値 | Gold | 他の variant／case への波及 | 誠実さ | 検証の手順 |
|---|---|---|---|---|---|---|
| **(A) 最小差分**（推奨） | `qualifiedIr[g04-lio-landing].summary`、`scenes[g04-rv-match].body`（δ＝0.03 なら `g04-rv-unknown` も）、fixtureId、`rawPrediction` の文 | **無し**。arms、graph、pathAttachments、blockedCandidates、evidence、metrics は v1 と同じ bytes | 不変（goldDefinition、gold の値、answerEntityIds、Gold の 2 Scene の本文も不変） | G-04 は base の 1 variant だけ（fixture:392-561）。他の case の bytes は不変 | 比較 field を動かさない。変えるのは Graph が読まない入力だけ（Graph の Evidence は Relation、Entity の名前と要約の範囲、Revision／Decision、pin。README:51。review Scene の本文と IR 文は入らない） | probe（§4）→ 独立レビュー → freeze → S4 → 測定。runtime では前提条件をそのまま確かめる |
| (B) query を散文にする（製品のパネルの query は執筆中の場面の末尾なので、現実に近い） | `query.body`、query を逐語で写した control の本文（:78）、場合によっては IR 要約も | arms は形が同じでも、全 Scene の cosine が変わり、Raw の予測を全部やり直す | 定義は不変でも「この query」が変わる | G-01〜G-08 の query はすべて「Which earlier scene shows …?」の形（各 fixture の :31 付近）。G-04 だけ変えると case の間の比較の前提が崩れる | observationPolicy の最初の語（query）を変える。選ぶ余地が最大（文を変えるたびに全部動く） | 全 Scene の probe と、validator の語彙の検査のやり直し。spike では、pin を解決した query にしても今の IR 文は 0.6317 で floor に届かなかった（`g04-index-enrichment-spike.md`:18）。散文にすれば足りるという根拠は無い |
| (C) base の構成を変える（IR が枠を使わず、Graph が Graph-only の場面を足す） | `slotClass` を supplementable に。`rPlusIr` を [control] にし、`appendedSceneId`、`addedScene`、指標を変え、`blockedCandidates` を外す | Graph の比較 field が大きく変わる | 値は不変でも、指標（R+IR+Graph の Recall／nDCG）が変わる | 到達 Entity の lio の pin が 2 Scene（lio-landing、lio-market）にあり、最小 hop の追加候補が 1 件にならない。README:58-60 の規則で validator が拒否するので、pin も変える必要がある。C-body（README:212-214）と `cb4-inputs` にも依存する | 規則から導き直す別の case の設計になる。誠実さの点で (A) より決定的に悪いわけではない（「IR が lio-landing を採らない」を前提にすることと、区分〔l6-l9:870〕を観測後に変えることは弱点）。**決定的な棄却理由は実務の制約**：lio の pin が 2 Scene にあり、最小 hop の追加候補が一意にならない（README:58-60）。C-body が Hold の間は追加が返らず Hold になる（README:212-213） | probe（IR が floor 未満であることの確認）、C-body の状態の確認 |
| (D) G-04 を IR に依存しない構成にし、IR の補完は G-05 に任せる | (C) と同じか、Raw満杯（control 8 件）に作り直す | (C) と同じか、それ以上 | (C) と同じ | `irSupplementedCoverage.cases`（manifest:195）が G-05 だけになり、区分の case が 1 つで「後二群の不変」（l6-l9:870）を支える。Raw満杯にするなら corpus をほぼ作り直す | corpus の作り直しで、選ぶ自由度が最大 | (C) と同じ |
| (E1) raw の期待を観測に合わせる（[control, rv-match]） | `arms.raw` | R と R+IR の列 | 不変 | — | 観測した runtime の出力をそのまま期待にする。validator も「R は control の Scene とちょうど一致」を要求する（`contract.mjs:1163-1164`）。manifest:156 も IR補完済みの R を「control 1 件」と定める | **採れない** |
| (E2) `ir-supplement-admission` の範囲を狭くし、IR が成り立たなくても Graph DTO は比べる（`cb4-inputs` と同じ部分 blocked にする） | manifest の前提条件の定義（G-05 と共通） | 前提条件の意味 | 不変 | G-05 にも効く | manifest:192 `closedSet`（観測の後に足さず、外さず、読み替えない）に当たり、確認済みの β（fixture の新しい版）の範囲外。また raw-membership が先に落ちるので、これだけでは足りない | 今回は採らない。Scope の測定を IR から切り離す価値はあるので、将来の版の論点として残す |
| (E3) 索引時の強化（想定質問・関係文を索引に足す） | 製品の索引の文書の種類と、floor の再校正 | — | — | 製品の変更 | spike（`g04-index-enrichment-spike.md`:26-33）のとおり、文書の種類が増えると floor の再校正（閾値の変更）が要り、cosine は世界線を区別しない | fixture の版では扱わない（範囲外。ユーザーの確認が要る製品の変更） |

---

## 3. 推奨案と理由、設計の原則

### 3.1 推奨：(A) 最小差分

理由：
- G-04 の目的（Scope の除外を Graph DTO で比べ、IR補完済みの枠の規則を確かめる）を保ったまま、成り立たなかった 2 つの測定条件だけを直せる。
- 比較する期待値が v1 と同じ bytes なので、独立期待値レビューで「Graph の期待値は規則から導いたもので、観測に合わせていない」と確かめやすい。
- IR の文は setup が fixture の `qualifiedIr` から決定論の provider に渡す（`frozen-setup-plan.mjs:498-517`、`setup-main-build.mjs:7-18`）。fixture だけで完全に決まり、製品は変えない。
- 同じ形の G-05 が成り立っている。G-05 の IR 要約は「Hale, the fort's quartermaster, supplied Xan …」（`g05-current-revision-freshness.v1.json`:240）で、query の役割の名詞（quartermaster）と動詞（supplied）を場面の解釈として述べている。G-04 v1 の要約「Bren ferried Lio across the river …」は役割の名詞（ferryman）も動詞（carried）も使っていない。v2 の IR 要約の書き方を G-05 にそろえる、という根拠のある規則が立てられる（観測に合わせた規則ではなく、成立している兄弟の case にそろえる規則）。

他を採らない理由：
- B は observationPolicy の最初の語（query）を変え、変える範囲と選ぶ余地が最大になり、case の間の共通の形も崩す。
- C は規則から導き直す別の case の設計で、決定的な理由は実務の制約。lio の pin が 2 Scene にあって追加候補が一意にならず（README:58-60）、C-body が Hold の間は Hold になる（README:212-213）。
- D は corpus の作り直しで自由度が最大。IR補完済みの区分の case も 1 つになる。
- E1 は tuning そのもので、validator も拒否する。
- E2 は manifest:192 `closedSet` に当たり、確認済みの β の範囲外（将来の版の論点として残す）。E3 は製品の変更。

**正直に書いておく限界**：
- この文書の例（§3.2 の 5）は、spike の数値を知ったうえで書いている。だから**候補の作者には渡さない**（§3.2 の 6）。
- (A) でも、入力を選ぶ動機は v1 の観測（rv-match が入った、IR が届かなかった）である。手続きで選ぶ余地を絞ることはできるが、「観測を知らずに作った版」にはならない。§5.3 のとおり、freeze にそう記録する。
- **v2 の G-04 は、IR 要約が query の役割名詞・動詞と語彙を共有する前提の下で Graph を測る case で、IR の recall の品質の証拠にならない**。R+IR の指標（Recall@8 0.5 など）は設計で作った値。後で IR の recall の根拠として読まれないよう、§5.6 のとおり fixture、manifest、README に書く。
- 合格する候補が無い可能性がある。spike では、陳述文の形の「関係文 1」（plain text）が 0.6596 で floor 未満、「関係文 2」が 0.6839 だった（`g04-index-enrichment-spike.md`:14-15）。spike は直列化していない文なので、v2 の値にはそのまま当てはまらない。

### 3.2 設計の原則（v2 の手続きの規則として固定する案）

1. **比較する期待値は変えない。** `variants[base]` 全体、`goldDefinition`、`answerEntityIds`、`query`、`scope`、`entities`、`relations`、`pins`、`revisions`、`setupTimeline`、`positive`／`negative`、`measurementBoundary` のうち `rawPrediction` 以外は v1 と同じ bytes にする。
2. **変えてよい入力の集合を先に宣言する**：`qualifiedIr[sceneId=g04-lio-landing].summary` と、`role=review` で Gold 0 の Scene の `body`。このうち実際に変えるのは、**v1 の bytes に最終の手順の probe（§4。製品の定義の中央値、本文だけの文書）を当て直し**、合格条件で不合格になった項目だけ。変える項目の集合はこの結果から機械的に決め、その後に候補を書く。既存の値（`g04-cosine-probe.json` と付録 A の G-04 の行）からの暫定の見積りは、推奨の δ＝0.03 なら **lio-landing の IR 要約、rv-match、rv-unknown の 3 つ**（§4.3）、δ＝0.02 なら lio-landing の IR 要約と rv-match の 2 つ。ほかに変えるのは fixtureId と `rawPrediction` の文だけ。
3. **合格条件は probe の前に固定する**（§4.3）。条件は製品の基準（floor 0.66、gate 0.51、救済の下限 0.46）を緩めず、余裕 δ だけ厳しくする。δ は fixture の設計の値で、製品の閾値ではない。v1 の G-04 の値を見て δ を選ぶ弱点を消すため、**δ は G-04 以外の観測済みの case での校正（付録 A）から決め**、ユーザーの確認で固定する。
4. **候補は probe の前に書き、順番を固定する。** 項目ごとに 3 件以内とし、各候補の文字列と sha256 を、probe の前に受領書に記録する。probe は**全候補を測り、全結果（値と合否）を受領書に載せる**。最初の合格で止めない（結果を隠さない）。採るのは、合格した候補のうち固定の順で最も前のもの。probe の後に候補を足したり、言い回しを直したりしない。全部が不合格なら v2 は作らず、ユーザーに戻る（§7.2 Q3）。
5. **候補の書き方の規則**（独立レビューが確かめる）：
   - IR 要約：陳述文 1 文にする（疑問文は floor の校正分布の外。spike の限界 2）。場面の本文と Codex の要約から言える内容だけを書く（例：Bren が渡しを営むことは Entity の要約〔fixture:194〕にあり、Lio を対岸に降ろしたことは本文〔:86〕にある）。役割の名詞と行為の動詞を述べる形は G-05 にそろえる。query の文、疑問詞、query だけにある語（scene、earlier、chosen、shows）を写さない。`actuality`、`attribution`、`narrativeFrame` は変えない。長さは v1 と G-05 の要約の ±50% 以内。
   - review Scene の本文：陳述文 1 文。S2 と Porter stem を共有しない（validator が検査する）。Revision の Scope と holder の設計に関わる語を入れない。長さは v1 の ±50% 以内。
   - 例（未測定。**候補の作者には渡さない**。この文書の書き手は spike を知っているので、例は候補にしない）：IR「Bren, the river's ferryman, carried Lio across at dusk and left her on the far stones.」。rv-match「Chalk tallies covered a plank wall in a cold store room.」（G-05 の review の本文〔`g05-current-revision-freshness.v1.json`:38〕と同じ文。G-05 ではこの Scene は R に入らなかった。G-04 の S2 との語彙の検査はしていない）。
6. **役割を「知っていること」で分ける**：
   - 候補の作者：probe、spike、診断の記録を**渡されない別の agent**。
   - 作者に渡すもの（案。integrator が決める）：§3.2 の 5 の規則の文（例の行を除く）、変える項目の名前の一覧（理由と値は渡さない）、G-04 の全 Scene の題と本文、Entity の名前と要約、Relation、Scope の設計（どの Scene が何の負例か）、G-04 の query の本文、G-05 の query・IR 要約・review の本文（形の手本）、`qualifiedIr` の他の field。
   - 作者に渡さないもの：cosine の値すべて（v1 の診断、spike、付録 A の校正）、contracts の `s6-aggregation-s5r4/` 全部と `g04-*` の名前の file 全部、Gold などの受領書と v1 の観測、δ と合格条件の数値、この設計案（§1〜§7 と付録）。
   - probe の実行者：作者とは別。sha256 を固定した script で実行する。
   - 独立期待値レビュー：作者とも probe の実行者とも別。read-only。
7. **probe は予測で、測定ではない。** runtime の前提条件の確認（`outcome.mjs:177-195`）はそのまま行う。v2 でも成り立たなければ blocked と記録し、v3 は作らずにユーザーに戻る。

### 3.3 独立期待値レビューの入力と確かめること

- 渡すもの：v1 と v2 の fixture、その差分、README・manifest・l6-l9 の規則の節、この設計の §3.2 と §4.3（固定した版）、候補の一覧（順番つき）、候補の作者に渡した資料の一覧（§3.2 の 6）、probe の生データ（JSON）と script の sha256、v2 が要る理由の 1 段落（「R に review Scene が 1 件余分に入り、ir-only の IR が floor に届かなかった」まで）。
- 渡さないもの：Graph runtime の出力（DTO、frame、受領書の graph arm、X5 など）。manifest:231 の要件（Graph runtime の出力を見ない）を v2 でも守る。
- 確かめること：(1) 差分が §3.2 の 2 の集合に限られる。(2) Graph の期待値を規則だけから導き直し、v2 の `variants` と一致する（v1 と同じ bytes であることの確認を含む）。(3) 候補が §3.2 の 5 を守る。(4) probe の生データに対して、選択が §3.2 の 4 のとおり機械的。(5) validator（`pnpm eval:fixtures`）が通る。(6) **必須の確認**：review Scene の本文が、製品の typed Revision の準備（本文を anchor に取るか）と Evidence に入らないことを、凍結の前に製品の code で確かめる。validator の水準では README:51 の Evidence の要素に入らないので支持されるが、製品側は確かめていない。入るなら rv-match などの本文の変更は Graph の入力の変更になり、(A) の前提が崩れるので止める。(7) 候補の作者が渡されないはずの資料を見ていないこと（渡した一覧と作業の記録で確かめる）。

---

## 4. 凍結前の admission probe の手順（必須化）

### 4.1 何を測るか

- **Raw**：query と、各 Scene の文書の cosine。8 Scene すべてを測る。
- **IR**：query と、`qualifiedIr` の各行を `ordered-json/1` で直列化した文の cosine。直列化は `JSON.stringify({summary, actuality, attribution, narrativeFrame})` で、v1 の probe はこれで保存ベクトルを 0.998 で再現した。
- **判定に使う製品の規則**（v1 の probe から直す点を含む）：
  - floor：英語 0.66、日本語 0.813（`policies/narrative/nir1-related-scenes-ranking.json`:3-4）。
  - Raw の gate：英語 0.51（`semanticRecall.ts:62`）。sparse 救済は `minScore − rescueMargin`＝0.46（`selectRelatedScenes.ts:128,178`、`semanticRecall.ts:97`）。相対救済は 0.46 以上、かつ中央値＋0.05 以上、かつ勝者がいること（`selectRelatedScenes.ts:169-183`、`relatedScenesConfig.ts:4`）。
  - **中央値は製品の定義で計算する**（偶数個なら中央 2 値の平均。`selectRelatedScenes.ts:77` 以下）。v1 の probe（`g04-probe.mjs`:51）は上側の値を使っていたので直す。ただし §4.3 の合格条件は中央値に依存させない。
- **golden の確認**：`src-tauri/tests/fixtures/bge_small_en_v15_golden.json` の 7 件で、cosine の最小値が 0.995 以上でなければ probe は無効（v1 の probe は 0.99688）。
- **後で照合する確認（任意。測定には数えない）**：v2 の setup の後、測定を始める前に、cold workspace の `narrative_nir1_chronicle_vectors` と probe の IR ベクトルの cosine が 0.995 以上かを確かめる（v1 の診断と同じ読み方。Graph の出力は読まない）。

### 4.2 query と文書の形

- query は Scene の本文の末尾 500 字（UTF-16）で、題を含まない。Raw は `fetchNir1RelatedScenes.ts:172-178` → `semanticRecall.ts:151-165`。native 側は `related_scenes_query.rs:3,48`（`RAW_QUERY_TAIL_UTF16_UNITS = 500`、保存された content から作る）。IR は同じ変換を使うと書かれている（`retrieval_admission/types.rs:229-231` のコメント）。**合否は本文だけの query で判定する**。v1 の probe の「題＋本文」の列は判定に使わない。
- Raw の文書の形：索引は `SELECT content FROM tree_nodes`（`grimodex-semantic/src/index.rs:318`）で本文だけを読み、題は入らない。英語の chunk の目標の上限は 1000 字（`grimodex-semantic/src/spec.rs:110-111`）で、G-04 の本文はどれも 1 段落でこれより短い。1 Scene が 1 chunk になるとは読めるが、chunker の分け方の全部は読んでいない。**合否は本文だけの文書で判定する**。付録 A では、題＋本文の形で予測しても 8 case の Raw の membership はすべて同じ結果になった（形の違いはこの校正では区別できない）。

### 4.3 合格条件（案。推奨の δ＝0.03 のとき）

| 対象 | 条件 | 製品の基準との関係 |
|---|---|---|
| ir-only の IR（lio-landing） | cosine ≥ 0.66 ＋ δ ＝ **0.69** | floor より厳しい |
| control の Raw | cosine ≥ 0.51 ＋ δ ＝ **0.54** | gate より厳しい |
| control 以外の全 Scene の Raw（7 件。Gold の 2 Scene を含む） | cosine ≤ 0.46 − δ ＝ **0.43** | 0.46 未満なら sparse 救済も相対救済も起きない（`selectRelatedScenes.ts:169,178-183`）。中央値がどう動いても成り立つ |
| 語彙 | `pnpm eval:fixtures` の語彙の検査が通る | sparse 側（FTS5）は probe では再現しないので、validator の検査に任せる |
| control の IR | 条件にしない | README:165「IR は control に付くとは仮定しない」。採られても R の Scene と重なるだけ（G-05 で観測した形と同じ） |

- δ の根拠（付録 A。G-04 を除いた独立の case で決める）：
  - IR：probe の query と、probe の IR ベクトル／製品の保存ベクトルとの cosine の差は最大 **0.0150**（G-02 の attach：0.6912 と 0.6762）。G-04 だけを見た v1 の診断の 0.0032 より大きい。予測が外れたのは G-03 の c5 の 1 行（probe 0.6538、保存ベクトル 0.6556 で floor 未満と予測したが、30/30 で採用）で、境界からの距離は 0.0062。
  - Raw：7 case すべてで予測した membership が観測と一致した。境界に最も近い行は G-07 の rhea-reveal（0.5033、gate の 0.0067 下で、正しく不採用）。Raw の Scene ベクトルは保存されていないので、製品の値とは照合できない。IR のずれを代わりの目安にする。
  - δ＝0.03 は IR のずれの最大の約 2 倍で、外れた行の距離の約 5 倍。δ＝0.02 だと、ずれの最大との差は 0.005 しか残らない。
- 変える項目の暫定の見積り（v1 の本文だけの値。§3.2 の 2 の確定は手順 2 で行う）：δ＝0.03 なら lio-landing の IR 要約、rv-match（0.4925）、rv-unknown（0.4390 ＞ 0.43）の 3 項目。lio-market（Gold 2、0.4248）と rv-unresolved（0.4271）は 0.43 以下で、変えない。δ＝0.02 なら lio-landing の IR 要約と rv-match の 2 項目。
- 合格条件は「成り立つと予測できる」の基準で、成り立つことの保証ではない。

### 4.4 何を記録するか

- 新しい probe の受領書（名前は案：`evals/nir1-graph/admission-probe.v2.json`）。中身は、model の sha256 と tokenizer の sha256（候補の受領書の `candidate.models.en` と一致すること）、golden の avg と min、query の文字列、文書ごとの文字列と cosine（本文だけの形）、直列化した IR 文の bytes、製品の定義の中央値、合格条件と δ、候補の一覧（順番つき）と合否、採った候補、script の sha256、道具の版（パッケージの名前と版）、実行者、日時。
- freeze が受領書の sha256 を束縛する。manifest の `irSupplementedCoverage.admissionProbe` を `run` にし、freeze の `irSupplementAdmissionProbe.status` と一致させる（`contract.mjs:2300-2307`）。
- fixture には probe の欄を足さない。schema が `additionalProperties: false` なので（`schema.v1.json:38`）、足すと schema の変更が増える。

### 4.5 いつ、誰が

- いつ：候補を固定した後、独立期待値レビューの前、freeze の前。凍結する bytes に対して、凍結の直前にもう 1 回実行し、同じ値になることを確かめる。
- 誰が：作者とは別の人（integrator か、別の read-only の agent）が、sha256 を固定した script で実行する。
- 道具：v1 の probe は `/tmp/onnxprobe` に、ユーザーの承認を得て npm で入れた `@huggingface/transformers`（onnxruntime-node を含む）を使った（`g04-cosine-probe.md`:3）。付録 A の校正もこの道具を使った（`@huggingface/transformers` 4.3.2、`onnxruntime-node` 1.30.0、Node v24.18.0。model の sha256 `4f183171…e44b` と tokenizer の sha256 `d241a60d…5c66` は、Gold の受領書の `candidate.models.en` と一致した）。必須の手順では、これらの版と sha256 を受領書に残す。新たに install するなら、install の承認が要る（§7.2 Q5）。

### 4.6 他の fixture にも同じ probe を当てる（2026-11-01 に実行。結果は付録 A）

- 目的：**probe の予測が当たるかを確かめる**こと。fixture を直すためではない。runtime の結果がすでにある case で、probe の予測と比べる：
  - G-05：IR（xan-watch）は採用され、R は [control]（§1.1）。probe は合格と予測するはず。
  - G-04 v1：不合格と予測するはず（すでに測定済み）。
  - G-01：S1 で control の IR が 0.61294 で floor 未満だった（README:165）。今回の Gold でも 30/30 不採用。
  - G-02／03／06／07／08：Gold で R の membership が期待と一致した（§6）。probe は control が gate 以上（Raw満杯の 8 control を含む）、control 以外がすべて救済の下限未満、と予測するはず。
- 手順：§4.1 と同じ方法で、凍結済みの bytes に対して実行し、case ごとに「probe の予測」と「runtime の観測」を並べた。観測は Gold `gold-s5r4-1` の measured 30 件で、Raw は hybrid arm の `rawSceneIds`、IR の採否は graph arm の `followUp.parent.irSceneIds`（採用された IR の Scene）を、setup の受領書で論理 ID に写した。IR は cold workspace の保存ベクトル（`narrative_nir1_chronicle_vectors`）とも照合した。
- 結果の扱い：当てた結果を見て fixture を変えない（どれも観測済み）。runtime は成り立ったのに probe が不合格と予測した場合は、probe の合格条件が保守的すぎるか再現がずれていることを示すので、δ と道具を見直す材料として記録する。runtime と probe の予測が食い違った場合（付録 A では G-03 の IR 1 行。G-04 v1 は予測どおり不合格）は、probe では再現しない要因（sparse、chunk、query の形）があることを示すので、§4.2 の仮定を見直す。
- 限界：sparse（FTS5）と RRF の順位は再現しない。cosine が下限未満なら membership には効かないが、順序まで宣言する case（G-04、G-05）の R+IR の順序は probe では確かめない。

---

## 5. 波及と手順

### 5.1 G-04 の fixture の sha256 と freeze の sha256 が入っている場所（grep で確かめた）

S2（`evals/nir1-graph/observation-prep.v1.json`）は、**G-04 の fixture の sha256 を直接は持たない**。持っているのは freeze の sha256（:44-47 `references.graphCaseFreeze`、`6080530a…`）で、freeze が G-04 の sha256（`4d002261…`、`freeze.v1.json`:37）を束縛する。G-04/base の名前は S2 の variant の一覧（:81、:152、:215、:473、:1644）に出るが、v2 で variant の名前が変わらなければ、この一覧は変わらない。

| 場所 | 持っているもの | v2 で要ること |
|---|---|---|
| `evals/nir1-graph/g04-scope-exact-unknown.v1.json` | v1 の bytes | 新しい file（案：`…v2.json`）、fixtureId `nir1-g04-scope-exact-unknown/2`。v1 の file は tree に残してよい：validator は case を `manifest.cases[].path` で列挙し（`contract.mjs:1929-1932`、:2360-2363）、`eval-fixtures.mjs` の directory の走査は `evals/fixtures` の yaml だけ（:56-65、:73）。manifest が指さなければ検査の対象外になる |
| `evals/nir1-graph/schema.v1.json`:43 | fixtureId の形 `^nir1-g0[2-8]-[a-z0-9-]+/1$` | `/2` を通すには schema の変更が要る（freeze が schema の sha256 を束縛する） |
| `manifest.v1.json`:8、:33-39、:198-199、:225-235 | `graphRuntimeObservedBeforeFreeze`、G-04 の path と fixtureId、probe の状態、レビューの経緯 | 更新（§5.3） |
| `README.md`:24、:185、:229-231、レビューと freeze の節 | G-04 の行、probe をしていないという記述 | 更新（freeze が README の sha256 を束縛する） |
| `independent-expectation-review.v1.json` | 1 回目のレビュー記録（schema `nir1-graph-expectation-review/1`） | v2 のレビューの記録（新しい記録か追記か。形式は確かめていない） |
| `freeze.v1.json`:11-13、:37、:113、:259、:311、`irSupplementAdmissionProbe` | manifest、schema、README と各 case の sha256、probe の状態 | 凍結のやり直し。path は `contract.mjs:52` に固定されている |
| `observation-prep.v1.json`:44-47（S2） | freeze の sha256 | S2 の追補（DR-CP4-S4-6 と同じ形の手続き） |
| `observation-prep-author-declaration.v1.json`:46、:62-66、:94、:100 | freeze、G-04、README、manifest の sha256（S2 の作者が読んだ版） | 更新 |
| `seed-pin-addendum.v1.json`:17-20、:37-41（状態 `frozen-after-independent-review`） | freeze と G-04 の fixtureId、sha256 | 更新し、addendum のレビューもやり直す。G-04 の行（:132-135、query は g04-query、seed は g04-bren）は (A) では変わらない |
| `declaration-addendum.v1.json`:26、`evals/nir1-g01/setup-addendum.v1.json`:31 | freeze の sha256 | 更新 |
| `observation-prep-freeze.v1.json`（S4）:8-11、:16-25 | freeze の sha256 と、束縛する file の sha256 | S4 の凍結のやり直し |
| harness `scripts/quality/nir1-graph-eval/constants.mjs`:108-111、:125-126、:184-190 | `GRAPH_CASE_FREEZE`、`FROZEN_FIXTURE_SHA256`、variant の一覧の path | code の変更（今回はしない。実装の段で要る） |
| harness `setup-main-build.mjs`:7-18 | 「表は fixture から導く」 | G-04 の IR 行が変わると、setup 専用の Main を build し直す |
| validator `scripts/quality/nir1-graph/contract.mjs`:1921-1924、:2253-2254 | manifest と freeze の `graphRuntimeObservedBeforeFreeze === false` | §5.3 |
| `docs/plans/nir1-graph-case-seed-pin-proposal-1-draft.md`:43（SP/1。確認済みの bytes。S2:30-36 が sha256 を束縛する） | 「材料の正本」として freeze v1 の sha256 を引用 | bytes は変えられない。SP/1 の確認が v2 にも及ぶかは integrator の判断（§7.1） |

### 5.2 手順（順番）

0. ユーザーが §7.2 の確認事項に答える。
1. integrator：変えない部分を v1 と同じ bytes にした v2 の下書きを作り、候補の作者に渡す資料の一覧（§3.2 の 6）を決めて記録する。
2. probe の実行者：v1 の bytes に最終の手順の probe を当て、v1 の診断の値を再現することと、変える項目の集合（§3.2 の 2）を確定する。その後、候補の作者（§3.2 の 6 の別の agent）が集合の項目について候補を書いて固定し、文字列と sha256 を受領書に先に記録する。probe の実行者が全候補を測り、全結果を受領書に載せ、固定の順で採る。
3. integrator：採った候補で v2 の bytes を確定する。
4. 独立期待値レビュー（§3.3）。changes-required なら、§3.2 の範囲の中でだけ直し、probe からやり直す。
5. validator・schema・harness の定数の変更（§5.3、§5.1）を、試験と一緒に別の PR で用意し、レビューを受ける。
6. graph case の freeze を凍結し直す（manifest、README、schema、レビュー記録、probe の受領書）。
7. S2 の追補、addendum の更新、S4 の凍結のやり直し（DR-CP4-S4-6 の手続き：失効の commit → S2 の追補 → S4a → S4b → manifest）。
8. setup を作り直す。G-04 の fixture の variant は base の 1 つだけ。setup 専用の Main は全 fixture の IR から表を作るので、その sha256 が変わる。受領書は setup ごとに `setupMainSha256` を持つ（`setup-receipt.mjs:73,121`）。13 setup の間で一致を求める検査は grep では見つからなかったが、確かめてはいない。X1-5 で候補が変わるなら、どのみち 13 setup を全部作り直す。
9. ④ SP-P4、⑤（trace 2 件、parity、Gold、negative N2〜N4）を新しい S4 と候補で測る。
10. S6 の集計と S7 の報告。

### 5.3 観測の後に作った版の記録（validator の扱い）

- 今の validator は、manifest と freeze の両方で `graphRuntimeObservedBeforeFreeze === false` を求める（`contract.mjs:1921-1924`、:2253-2254）。v2 の G-04 は v1 の runtime を観測した後に作るので、そのまま `false` と書くと事実と違う。README:265-266 も「freeze の前に Graph runtime を観測した版は固定済みとして扱わない」と書いている。
- 推奨：v2 の manifest と freeze では `graphRuntimeObservedBeforeFreeze` を **`true`** にし、case ごとの欄を足す。例：`postObservationRevisions: [{ caseId: "G-04", fromFixtureSha256: "4d002261…", observedRuns: ["gold-s5r3-1", "gold-s5r4-1", …], changedFields: [...], graphOutputUsed: false, userConfirmation: "…x1-g04-spike.md" }]`。v2 の bytes 自体は凍結の前に Graph runtime を通していない、と分けて書く。validator は、`true` のときはこの宣言があり、レビューが approve の場合だけ受け入れるように変える。
- **`graphRuntimeObservedBeforeFreeze` は case ごとではなく global の boolean**（manifest:8、freeze の同名の欄）。凍結し直す時点では、G-02〜G-08 も全部が観測済みである。「`postObservationRevisions` があり approve なら `true` を受け入れる」だけでは緩い。他の case の bytes が観測の後に黙って変わっても通ってしまう。そこで validator に次の検査を足す：v2 の freeze が v1 の freeze の記録（path と sha256）を引用し、**G-04 以外の全 fixture の sha256 が v1 の freeze の `cases` と一致する**ことを束縛する。schema は `/2` に対応するために変わるので、v2 の freeze に「schema の変更は fixtureId の pattern だけ」と変更の範囲を宣言し、validator が v1 の schema との差分をその範囲に限る。
- **規則文の改訂**：README:265-266（「変える必要があれば、観測の前に限り、独立期待値レビューと freeze をやり直す」「freeze の前に Graph runtime を観測した場合は、この版を固定済みとして扱わない」）は規則の文で、v2 はこの規則自体を観測の後に改訂する（例：「観測の後の版は、ユーザーの確認と `postObservationRevisions` の宣言、独立期待値レビューを経たときに限り固定済みとして扱う」）。manifest:191 の補足（blocked は新しい版と新しいレビューでだけ測れる）とも合わせる。Q2 の確認はこの改訂を含む。
- 採らない案：`false` を「この版の bytes は観測していない」と読み替える。field の意味を観測の後に変えることになる。
- 前例との違い：CQ-LIM-4 は G-03 を fixtureId `/1` のまま作り直して凍結し直した（README:244、manifest:29）。ただしそれは Graph の観測より前だった（`cq-lim-decisions.md` DR-CQL-15）。v2 は観測の後なので、v1 の結果と区別できるように fixtureId を `/2` にするのを推奨する（schema の変更が要る）。

### 5.4 測定のやり直しの範囲

- 今の S6 の集計は、台帳の `s4Commit` が 1 つの値の run だけを通す（contracts `s6-aggregation-s5r4/scripts/s6-aggregate.mjs`:3、:16）。S4 を凍結し直せば、G-04 以外の variant も古い S4 の run は集計に入らない。**今の規則の下では ④⑤ の全部をやり直すことになる**。
- G-04 だけを測り直すには、集計の規則を変える必要がある（古い S4 と新しい S4 の run を混ぜる）。結果を見た後で pool の作り方を変えることに近いので、推奨しない（§7.2 Q4）。

### 5.5 X1-5 と並べて進める方法

- 測定の候補は X1-5 を含む master になる（依頼の前提）。X1-5 は製品の変更なので、候補が変わり、④⑤ の全部のやり直しがどのみち要る。v2 の freeze を X1-5 の S4 の凍結のやり直しより前に終えれば、S4 の凍結と測定は 1 回で済む。
- v2 の作業（§5.2 の 1〜6）は製品の code に触れないので、X1-5 の実装と並べて進められる。S4（手順 7）は候補が決まった後、つまり X1-5 の merge の後。
- X1-5 が G-04 の Raw／IR の値を変えるかは確かめていない。X1-5 は失効の範囲の変更で、cosine や floor には関わらないと読んでいるが、推測。

### 5.6 限界の記録先（独立レビューの条件 5）

v2 の G-04 が IR の recall の根拠として読まれないよう、§3.1 の限界を次に書く（文は案。bytes は v2 の作成と凍結の段で決める）：
- v2 の fixture の `measurementBoundary.rawPrediction`：「The ir-only IR summary was chosen by a pre-freeze model-only probe to share the query's role noun and verb; this case measures Graph on that premise and is not evidence of IR recall quality.」
- manifest の `irSupplementedCoverage`：G-04 の IR 補完は、probe で選んだ要約の上に成り立つ測定条件で、IR の recall の品質を測らないこと。
- README の「解釈を要した点」と「対象外（coverage gap）」の節：同じ内容。

### 5.7 見積り（推測）

| 段 | 見積り（推測） | 根拠 |
|---|---|---|
| 1〜4（候補、probe、レビュー） | 0.5〜1 日 | probe 自体は数分（付録 A の 8 case で数分だった）。レビューが 1 回で通る場合 |
| 5（validator・schema・定数） | 0.5〜1 日 | 試験とレビューを含む |
| 6〜7（freeze、S2、S4） | 約 1 日 | DR-CP4-S4-6 の手続きの規模から |
| 8〜10（setup、④⑤、S6/S7） | 数時間〜1 日 | Gold は 35 分（contracts `gold-s5r4-1/README.md`:7）。ほかの run の時間は確かめていない |

---

## 6. 副次の観測：G-02／G-03／G-06／G-07 の Raw の順序

**確かめた事実**：
- 4 つの fixture の `arms.raw.orderPredeclared` は **false**。true なのは G-04 と G-05 だけ（node で全 fixture の値を読んだ）。validator が `raw.orderPredeclared !== (raw.sceneIds.length === 1)` を拒否する（`contract.mjs:1165-1166`）ので、control が 2 件や 8 件の case で true にはできない。README:44-45 も「control が 1 件なら順序まで、2 件や 8 件なら membership だけを宣言する。順序を宣言しない arm の要素はすべて Gold 0 なので、指標は順序に依存しない」と書く。
- `preconditionHolds` の raw-membership（`outcome.mjs:177-181`）は、`rawOrderPredeclared` が true なら `sameList`、false なら `sameSet`。`rawOrderPredeclared` は `arms.raw.orderPredeclared === true` から作る（`outcome.mjs:57-66`）。runtime との比較も、`orderPredeclared` が true のときだけ順序を見る（manifest:129）。
- Gold `gold-s5r4-1` の hybrid の measured 30 件を論理 ID に写すと、G-02、G-03、G-06、G-07 の R は fixture の並びと順序が違い、membership は一致した（例：G-02 は [g02-attach, g02-probe]、G-03 は [c4, c3, c2, c1, c7, c6, c5, c8]）。G-08 の 3 variant は並びも一致した。

**読み**：Fable の所見の「`orderPredeclared: true` と違う」は、fixture の bytes と一致しない（並べた順を宣言と取り違えた可能性があるが、推測）。順序の違いは前提条件も比較も破らない。**v2 の範囲に含めず、他の fixture も改訂しない**ことを推奨する。integrator は、この訂正を記録に残すかだけを判断すればよい。

---

## 7. 確かめていないこと、ユーザーの確認が要る点

### 7.1 確かめていないこと

- 1 Scene が 1 chunk になるか（§4.2。題が入らないことは確かめた。chunker の全部は読んでいない）。
- probe と製品の query ベクトルの直接の一致（製品の query ベクトルは保存されない。確かめたのは golden と、保存された IR ベクトルだけ）。G-03 の IR 1 行で予測が外れた原因（query 側のずれか、それ以外か）も分からない。Raw の Scene ベクトルは保存されないので、Raw は製品の値と照合できない。
- 候補が合格するか（§3.1 の限界）。この文書の例は測っていない。
- レビュー記録の形式（新しい記録か追記か）。v1 の file を残すことは §5.1 で確かめた（`nir1-graph-eval/` の他の readdir〔`admission.mjs` など〕は読んでいない）。
- 13 setup の間で `setupMainSha256` の一致を求める検査があるか（grep では見つからなかった）。
- SP/1（`graph-case-seed-pin-setup`）の確認が v2 の G-04 にも及ぶか（G-04 の行の中身は変わらないが、確認済みの bytes は freeze v1 の sha256 を引用している）。
- v2 で K6/4 の `X5` が 0 になるか（測定で確かめる）。v1 で Graph-only の追加が無かった理由（v2 は `appendedSceneId: null` なので関係しない）。
- X1-5 が G-04 の Raw／IR の値に影響しないか（§5.5、推測）。
- review Scene の本文が、製品の typed Revision の準備や Evidence に入らないこと。README:51 の Evidence の要素には入っていない。setup の順序（fixture:605）では本文を Revision の準備より前に書くので、失効は起きないと読んでいる。製品の code では確かめていない。**§3.3 の (6) で、独立レビューの必須の確認にした**。
- 付録 A の校正は 1 回の実行で、測定には数えない。script と出力は作業用の場所にあり、repo には入れていない。

### 7.2 ユーザーの確認が要る点（選択肢と推奨）

- **Q1 余裕 δ の値**：(a) §4.6 の校正の結果で決める。校正からの推奨は **0.03**：独立の case での IR のずれの最大 0.0150 の約 2 倍で、変えるのは 3 項目（lio-landing の IR、rv-match、rv-unknown）。IR は 0.69 以上が要るので、合格する候補が無い危険は 0.02 より大きい（推奨）／(b) 0.02：変えるのは 2 項目だが、ずれの最大との差は 0.005／(c) その他。
- **Q2 観測の後の版の記録**：(a) global の boolean `graphRuntimeObservedBeforeFreeze` を `true` にし、`postObservationRevisions` の欄を足す。G-04 以外の fixture と schema の sha256 を v1 の freeze に束縛する検査を validator に足し、schema を `/2` に対応させる。**規則文（README:265-266 と manifest:191 の補足）の改訂を含む**（推奨）／(b) `false` を読み替える（推奨しない）。
- **Q3 全候補が不合格のとき**：(a) v2 を作らずに戻り、C／D／E2 などを改めて相談する（推奨）／(b) 候補の追加を 1 回だけ認める（作者の自由度が戻る）。
- **Q4 測定のやり直しの範囲**：(a) X1-5 の候補で ④⑤ を全部やり直し、1 回にまとめる（推奨）／(b) G-04 だけを測り直し、集計の許可リストを変える（推奨しない。§5.4）。
- **Q5 probe の道具**：(a) 前に承認された `/tmp/onnxprobe` を使い、`@huggingface/transformers` と onnxruntime-node の版、model と tokenizer の sha256 を受領書に残す（推奨。新しい install は無い）／(b) repo の中に道具を固定する（install または build が要る。承認が要る）。
- 確認は要らないが、integrator が決めること：fixtureId `/2` と file の名前、§6 の訂正の記録の仕方、レビュー記録の形式、候補の作者に渡す資料の一覧（§3.2 の 6）、付録 A の script と出力を contracts に写すか。

---

## 付録 A：δ の校正の probe（2026-11-01 実行。生の値。測定に数えない）

- 何をしたか：G-01/v1、G-02〜G-07 の base、G-08/base-usable の 8 variant で、凍結済みの fixture の bytes から model-only の cosine probe を計算した。製品の Raw の規則（gate 0.51、救済の下限 0.46、中央値は製品の定義、＋0.05、勝者の条件）と IR の floor 0.66 で予測し、Gold `gold-s5r4-1` の measured 30 件の観測と並べた。G-04 は確認のために並べたが、**δ の決定には G-04 以外の 7 variant を使う**。製品・fixture・harness は変えていない。新しい install は無い。
- 道具：`/tmp/onnxprobe/node_modules`（`@huggingface/transformers` 4.3.2、`onnxruntime-node` 1.30.0）、Node v24.18.0。model は `bge-small-en-v15/model_int8.onnx`（sha256 `4f1831710bec8904589cf50c58ad4d9ed3e66386f4973173c13f1e9d3ae8e44b`）、tokenizer の sha256 は `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66`。どちらも Gold の受領書の `candidate.models.en` と一致する。golden 7 件：avg 0.99747、min 0.99688。
- script と出力（作業用の場所。repo には入れていない）：`/tmp/claude-1000/-home-grimodex-Grimodex/dd1afc24-5546-4b01-b89b-6ba9b38e5b63/scratchpad/calib/calib-probe.mjs`（sha256 `2c96f0e4305691299cd6755c0a75de408dcb9a21f59ad0e988e3f2a1254031c4`）、`…/calib/calib-out.json`（sha256 `bb61596ff2eeab81cbbe10980e243b3edb31f1af1f959ded217b5c80ad671031`）。方法は `g04-probe.mjs` と同じで、query は本文だけ。
- 限界：Raw の Scene ベクトルは保存されていないので、Raw は fixture の本文を同じ方法で埋め込んだ値で、製品の値とは照合できない。sparse（FTS5）と RRF は再現しない。IR の採否の観測は `followUp.parent.irSceneIds`（採用された IR の Scene）による。

### A.1 Raw（本文だけ。予測と観測の membership）

| variant | 観測した R（30/30 同じ） | probe の予測 | 一致 | 中央値（製品の定義） | 境界に最も近い Scene（cosine、境界との距離） |
|---|---|---|---|---|---|
| G-01/v1 | [g01-question] | 同じ | ○ | 0.4320 | g01-review 0.4375（不採用、0.0445） |
| G-02/base | [attach, probe] | 同じ | ○ | 0.4167 | g02-tamsin-first 0.4217（不採用、0.0450） |
| G-03/base | [c1〜c8] | 同じ | ○ | 0.7193 | g03-hollis-ward 0.4406（不採用、0.0694） |
| G-05/base | [g05-control] | 同じ | ○ | 0.4373 | g05-review 0.4570（不採用、0.0304） |
| G-06/base | [c1〜c8] | 同じ | ○ | 0.7447 | g06-bram-galley 0.4413（不採用、0.0687） |
| G-07/base | [attach, probe] | 同じ | ○ | 0.5033 | g07-rhea-reveal 0.5033（不採用、gate の 0.0067 下） |
| G-08/base-usable | [attach, control] | 同じ | ○ | 0.4300 | g08-review 0.4300（不採用、0.0500） |
| （確認）G-04/base | [control, rv-match] | 同じ | ○ | 0.4259 | g04-rv-match 0.4925（相対救済で採用、0.0166） |

- control の cosine の最小は 0.6980（G-03 の c8）で、どれも gate から 0.18 以上離れている。
- 題＋本文の形で計算しても、8 variant すべてで予測は観測と一致した（形の違いはこの校正では区別できない。§4.2 のとおり製品の索引は本文だけ）。

### A.2 IR（probe の cosine、保存ベクトルとの cosine、採否）

| variant | IR の Scene | probe | 保存ベクトル | probe と保存の差 | IR ベクトルの一致（cos） | 予測（≥0.66） | 観測（採用の回数） | floor との距離（probe） |
|---|---|---|---|---|---|---|---|---|
| G-01/v1 | g01-question | 0.6220 | 0.6222 | 0.0002 | 0.99867 | 不採用 | 0/30 | −0.0380 |
| G-02/base | g02-attach | 0.6912 | 0.6762 | **0.0150** | 0.99757 | 採用 | 30/30 | +0.0312 |
| G-03/base | g03-c5 | 0.6538 | 0.6556 | 0.0018 | 0.99644 | **不採用** | **30/30** | −0.0062（**外れ**） |
| G-05/base | g05-control | 0.6904 | 0.6938 | 0.0034 | 0.99725 | 採用 | 30/30 | +0.0304 |
| G-05/base | g05-xan-watch | 0.7531 | 0.7637 | 0.0106 | 0.99560 | 採用 | 30/30 | +0.0931 |
| G-06/base | g06-c6 | 0.6824 | 0.6821 | 0.0003 | 0.99936 | 採用 | 30/30 | +0.0224 |
| G-07/base | g07-probe | 0.7117 | 0.7097 | 0.0020 | 0.99747 | 採用 | 30/30 | +0.0517 |
| G-08/base-usable | g08-control | 0.6519 | 0.6469 | 0.0050 | 0.99673 | 不採用 | 0/30 | −0.0081 |
| （確認）G-04/base | g04-control | 0.6614 | 0.6598 | 0.0016 | 0.99833 | 採用 | 30/30 | +0.0014 |
| （確認）G-04/base | g04-lio-landing | 0.5559 | 0.5527 | 0.0032 | 0.99785 | 不採用 | 0/30 | −0.1041 |

### A.3 解釈（生の値と分ける）

- 独立の 7 variant で、Raw の membership の予測はすべて当たった。IR は 8 行のうち 7 行が当たり、G-03 の c5 が外れた。外れた行は floor の 0.0062 下（保存ベクトルでも 0.0044 下）だったが、製品は 30/30 で採用した。製品の値が probe より少なくとも約 0.005 高かったことになる。原因（query 側の埋め込みのずれか、それ以外か）は分からない。
- probe の query に対して、probe の IR ベクトルと製品の保存ベクトルの cosine の差は、最大 0.0150（G-02）、次いで 0.0106（G-05 の xan-watch）。v1 の診断が G-04 だけで見た 0.0032 は、ずれを小さく見積もっていた。
- 以上から、余裕 δ は「独立の case で観測したずれの最大（0.0150）の約 2 倍」の **0.03** を推奨する。0.02 は外れた行の距離（0.0062）の約 3 倍だが、ずれの最大との差は 0.005 しかない。
- これは 1 回の model-only の計算で、校正の点は IR 8 行・Raw 7 case と少ない。δ は予測を当てるための安全幅で、成り立つことの保証ではない（runtime の前提条件の確認はそのまま行う）。


## 付録 B：候補の測定の結果と、v2 を作らずに戻った後の選択肢（2026-11-01 追補）

この節は追補で、§1〜§7 と付録 A の本文は変えない。

### B.1 結果（contracts `6224915f`、`g04-v2-candidates-2026-11-01/`）

- 診断の記録を渡していない作者が 9 件を書き、固定した script（`8fcc9010…`）で全件を 1 回測った。追加や直しはしていない。
- **項目 A（lio-landing の IR 要約）は 3 件とも不合格**：0.6621／0.6768／0.6490（合格条件 0.69、製品の floor 0.66）。項目 B（rv-match）は #4 が合格（0.3908）、項目 C（rv-unknown）は #7 が合格（余裕 0.0007）。
- §7.2 Q3 の (a) に従って v2 は作らずユーザーに戻り、ユーザーは「v2 は作らず戻り、設計を相談し直す」を選んだ（`9bf7654b`）。候補の追加、δ の変更、言い回しの修正は行わない。

### B.2 開示（integrator の読みの影響）

- A の長さの範囲 47〜106 文字は、「v1 と G-05 の要約の ±50% 以内」を**両方の重なり**と読んだ integrator の解釈（v1 だけなら 36〜106、G-05 だけなら 47〜141）。短い要約は試していないので、「どんな言い回しでも届かない」とは言えない。言えるのは、**query の語を共有し G-05 の形にそろえた陳述文 3 件が 0.649〜0.677 で止まった**ことまで。

### B.3 新しく分かったこと（判断に要るもの）

1. **疑問形の query × 陳述形の IR**：floor 0.66 は陳述文の分布で校正された値で、query は疑問文（§3.1 の限界 2）。spike の 0.6596／0.6839 と今回の 0.649〜0.677 は、言い回しの問題というより構造の問題を示す。
2. **Gold の pool の欠落（30/30）と同じ根**：S6（`s6-aggregation-s5r4/README.md`:27, 51）のとおり、G-04/base は IR が lio-landing を採らず、辺が 0 件で `expectedContribution` が false になり、K6/4 の F6 で必ず「表示されない」。Gold の pool の可用性が、手書きの IR が floor を越えるかに従属している。S6 README:51 の「事前登録の設計の問題の可能性」は、この根と同じ。**2 つを別々の問題として扱わない**。
3. 閾値、Gold、pool の選び方を結果を見た後に変えることは、integrator の判断では行わない（S6 README:46）。

### B.4 選択肢（ユーザーに相談する案。どれも未実行）

| 案 | 内容 | 失うもの／必要なもの |
|---|---|---|
| (C) | G-04 を「IR が lio-landing を採らない」前提の構成に作り直す。Scope の除外の検査（Kit／Ora／Tam／Sel）は保ち、Graph が Graph-only の Scene を足す形にする。lio の pin は 1 Scene にして追加候補を一意にする | 「IR が枠を使った後は Graph が足さない」の検査（G-04-P2）。IR 補完済みの区分は G-05 だけが支える（l6-l9:870）。C-body v1 は master に merge 済みで宣言の UI は閉じたまま（`nir1-continuation-2026-10.md`:153）。測定の setup で動くことは G-02／G-07／G-08 で観測済みだが、G-04 の形で成り立つかは未確認。新しい版、独立期待値レビュー、S4 の凍結し直し |
| (D) | corpus を作り直し、IR に依存しない構成にする（Raw 満杯など） | (C) より自由度が大きい。選び方の余地が最大 |
| (B) | 全 case の query を散文にする（G-04 だけ変えると case 間の比較が崩れるので全 case） | 全 fixture の作り直し。今回の結果で根拠は増えたが、散文にすれば足りるという測定は無い |
| (E2) | `ir-supplement-admission` の定義を狭め、IR 不成立でも Graph DTO は比べる | manifest:192 の `closedSet` に当たり、確認済みの β の外。G-05 にも効く。新しい確認が要る |
| (E3) | 索引時の強化（想定質問・関係文を索引に足す） | 製品の変更と floor の再校正（閾値の変更）。cosine は世界線を区別しない。CP-4 の範囲外 |
| (X) | G-04/base を pool から外す | 結果を見た後の pool／Gold の緩和。ユーザーの判断でだけ可能（S6 README:46）。失敗した case を外す弱点がある |
| (H) | 直さず、G-04/base の X5 を設計の問題として S7 に書き、Graph arm は HOLD のまま | fixture を変えないので S4 の凍結し直しは要らない。X1-5 の効果は v1 のまま測り直せば分かる |
