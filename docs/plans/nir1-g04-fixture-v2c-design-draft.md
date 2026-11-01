# NIR-1 CP-4：G-04 fixture v2（案 C：IR に依存しない構成）の設計案（草稿）

状態：**草稿の改訂 1**。初版（`f4dc2a39`）の独立レビュー（判定 (b)「修正してから受入れ可」、P1 なし、導出は全項目で一致）の指摘 P2-1〜P2-3、P3-1〜P3-5 を、起案者が実物に当てて確かめてから反映した（末尾の「改訂の記録」）。ユーザーにはまだ示していない。fixture・README・manifest・schema・validator・harness・S2・S4・閾値・Gold は変えていない（この文書を足しただけ）。
基点：`claude/g04-fixture-v2-design` の `68f7da60`。前の設計案（案 A。`nir1-g04-fixture-v2-design-draft.md`、以下「設計 A」）の波及の洗い出しと手順を下敷きにする。
方向の確認：ユーザーが 2026-11-01 に「(C) IR に依存しない構成への作り直しを起案 (推奨)」を選んだ（contracts `user-confirmation-2026-11-01-g04-c-redesign.md`）。確認の範囲は**起案と独立レビューまで**。fixture の変更・S2 追補・S4 の凍結し直し・再測定は、この設計を示して改めて確認する。
**前提（与えられた事実で、この設計の結論ではない）**：IR は `g04-lio-landing` を採らない（IR 要約の cosine 0.556、floor 0.66。作者の 3 案も 0.649〜0.677）。IR 要約の追加探索はしない。

## 要点

1. G-04 を **ir-supplemented から supplementable へ**移す。`g04-lio-landing` の role を `answer` にし、その `qualifiedIr` 行を外す（validator が control／ir-only 以外の IR 行を拒否する。contract.mjs:989-992）。IR は control にだけ残り、IR が共通追加枠を使う経路が構成上なくなる。
2. Lio の pin を `g04-lio-landing` の 1 件にする（`g04-lio-market` の pin を外す）。2 件のままだと最小 hop の新規候補が 2 Scene になり validator が拒否する（contract.mjs:704-707。scratch で再現）。Graph は Lio の渡しの Scene（Gold 3）を 1 件追加する。
3. **Graph DTO（`expectations.graph`）は v1 と同じ bytes**。Kit／Ora／Tam／Sel の 4 負例（N1〜N4）と、その除外理由の導出は変わらない。Scope の除外の比較という G-04 の固有の価値は保つ。
4. review Scene の本文 2 件を、確認済みの手順で測った候補 #4（rv-match、Raw 0.3908）と #7（rv-unknown、0.4293）に替える。どちらも固定の順で最初の合格。語彙の機械検査は scratch で通った（§8）。
5. 前提条件は `b-sealed-binding`、`maintenance-enabled`、`raw-membership`、`cb4-inputs`（sceneId `g04-lio-landing`）。`ir-supplement-admission` は宣言しない（ir-only が無いので validator が宣言を拒否する。:1639-1645）。
6. 期待値は規則だけから導いた。R＝R+IR＝[control]、R+IR+Graph＝[control, lio-landing]、addedScene は lio-landing の全文（UTF-16 `[0,211)`）、pathAttachments と blockedCandidates は空、指標は R+IR が 0／0、R+IR+Graph が 0.5／0.4966。draft を scratch で `validateGraphCaseFixture` に通し、**誤り 0 件**。
7. 失うもの：G-04-P2（IR が枠を使った後は Graph が足さない）と、G-04 での path 付加の検査。前者の規則は G-05 の `g05-pia-ridge`（`ir-supplement-used`）だけが検査する。IR補完済みの区分（l6-l9:870 の「後二群」の片方）も G-05 だけが支える。
8. 新たに C-body に依存する（追加 Scene の本文開示）。確認済みの K2/4 契約は宣言する Scene を 4 つに限って列挙しており（K2/4:391）、G-04 はその外。**これは addendum の版の問題ではなく、確認済みの開示の契約の適用範囲を広げる問題**（§5、§9 U2）。
9. K6/4 の pool：規則上、Graph が lio-landing を追加し、その path の辺がちょうど 1 つの qualified Revision（`g04-r-lio`）に解決するので、`expectedContribution` は true になる見込み（§6.3）。v1 で pool の欠落（X5 30 件）の原因だった case を観測の後に作り直すので、1% の判定は Graph に有利な向きに動きうる。ユーザーの確認が要る（§1.3 の 5、§9 U3）。
10. 観測の後に作る版で、製品の挙動（IR が採らない、rv-match が救済で入る）を知った上で構成を選んでいる。この弱点を fixture・README・freeze・S7 に書く（§1.3）。
11. 波及は fixture と規則文のほかに、validator の試験（`ir-supplement-admission` を試す唯一の実例が G-04 なので G-05 に移す）、harness の試験 2 件、`quality-manifest.yaml`、dev の形の写しに及ぶ（§7.1）。凍結前の再 probe は、確認済みの script が ir-only 1 件を構造の条件にしているので、そのままでは v2 を判定できない（§3.3）。

---

## 1. 目的と範囲

### 1.1 この版が測るもの

- **Scope の除外を Graph DTO で比べる**：exact 一致の Lio は資格を得る（P1）。wl-alt の Kit（N1）、worldline unresolved の Ora（N2）、Scope の無い review Scene の Tam（N3、unknown marker）、holder が Mott の Sel（N4）は寄与しない。比べる field（`graph.nodes`、`graph.edgeIds`、`scenesWithoutPath`）は v1 と同じ値。
- **補完可能な枠への 1 件の追加**：IR が枠を使わず R+IR が 8 件未満のとき、Graph が最小 hop の 1 Scene を末尾に足し、R+IR の先頭（[control]、順序宣言あり）を変えない（README:14、:46、:128）。

### 1.2 測らないもの

- **IR の recall の品質**。この版は IR に補完させない構成で、IR の値は何の根拠にもならない。v1 の観測（IR が lio-landing を採らなかった）の評価もこの版はしない。
- 「IR が共通追加枠を使った後は Graph が足さない」（v1 の G-04-P2）。G-05 に任せる（§6）。

### 1.3 v1 との関係と、観測の後に作る版の弱点

- v1 の file（`g04-scope-exact-unknown.v1.json`、sha256 `4d002261…`）と、その結果（`blocked:raw-membership`、`ir-supplement-admission` も不成立）は残す。v2 は別 file、fixtureId `nir1-g04-scope-exact-unknown/2`。README:211 と manifest の `holdVersusBlocked`（「blocked の variant は新しい版と新しい独立期待値レビューでだけ測れる」）の手続きの内側で作る。
- **弱点（開示する）**：
  1. 構成を選んだ動機は v1 の観測（IR が採らない、rv-match が相対救済で R に入る）。IR に枠を使わせない形にしたのは、製品の IR がこの Scene を採らないと知った後の選択。
  2. 補完可能の形は G-02／G-07／G-08 で使われ、測定の setup で動くと integrator から聞いている（設計 A の付録 B。この起案者は受領書を読んでいない）。「動くと知っている形」を選んだことになる。
  3. 起案者は contracts の `g04-base-diagnosis.md` を読んだ。そこには Graph の子の要約（「子の辺は 0 件」）がある。期待値はこれを使わずに規則から導いた（§4）。Graph の DTO、frame、受領書の graph arm は読んでいない。
  4. review Scene の本文の候補は、v1 の rv-match の救済を見た後で、手順を確認して測ったもの。しかも案 A の手順で測った候補を案 C に流用する（§3.3）。
  5. **pool の判定への影響**：v1 の G-04/base は K6/4 の pool の欠落の唯一の原因だった（設計 A:29、contracts `s6-aggregation-s5r4/README.md` §4 (a)：欠落 30 件はすべて G-04/base の X5）。v2 はその pool の成員を、観測の後に `expectedContribution` が true になる見込みの形へ作り直す。さらに case が `blocked:raw-membership` になっても pool の寄与は true になりうる（§6.3。`availability.mjs`:240 の `inPool` は blocked を見ない）。閾値（1%）も pool の作り方も変えないが、観測の後の構成の選択が 1% の判定を Graph に有利な向きに動かしうる。これは「失敗した case を pool から外す」（S6 README の (X)）ではなく「失敗した case を作り直す」こと（(X) は設計 A 付録 B.4 の案で、選ばれなかった）。v1 の結果（30/30 の欠落と blocked）は残し、S7 で開示する。v1 のまま（設計 A 付録 B の (H)）なら pool の判定は HOLD のまま変わらない。ユーザーの確認の対象にする（§9 U3）。
- 弱点を小さくする手当て：比べる期待値は validator が規則から計算し直す。Graph DTO の bytes は v1 のまま。変える入力は Graph の Evidence に入らない（README:51。ただし §10 の 3）。独立期待値レビューは Graph runtime の出力を見ない（manifest:231 の要件）。

---

## 2. 構成

### 2.1 Scene の role と pin

| Scene | v1 | v2 | 理由 |
|---|---|---|---|
| `g04-control` | control、IR あり、pin Kit／Ora／Tam／Sel | 同じ | R の唯一の Scene。N4（no path reaches control）の材料 |
| `g04-lio-landing` | ir-only、Gold 3、IR あり、pin Lio | **answer**、Gold 3、**IR なし**、pin Lio | Graph-only の追加先。Gold 正例の role は answer か ir-only だけ（:862-865）。ir-only を残すと R+IR に入れることを validator が求める（:1193-1200） |
| `g04-lio-market` | answer、Gold 2、pin Lio | answer、Gold 2、**pin なし** | 最小 hop の候補を 1 件にする（README:58-60、:704-707） |
| `g04-rv-match` | review、本文 "Tally marks covered a wooden post near a jetty." | 本文を #4 に | v1 で相対救済により R に入った（Raw 0.4925） |
| `g04-rv-unknown` | review、本文 "Wind tugged at a shutter on an empty inn." | 本文を #7 に | 0.4390 が確認済みの条件 0.43 を超える |
| ほかの review 3 件 | — | 同じ | — |

- role の名付けの余地は無い：Gold が正の Scene は `answer` か `ir-only`（schema の role の列挙と :862-865）。ir-only は IR を前提にするので `answer` だけが残る。
- pin の総数は 6 → 5。到達 Entity の pin は 1 件（Lio → lio-landing）。K1 の上限 8 の内（README:136-139、validator の `framePinCount` は 1）。
- seed の pin（SP/1、`seed-pin-addendum.v1.json`:132-135。Bren を S2 に pin）は変わらない。seed の pin は候補に数えない（:647-649）。

### 2.2 Entity・Relation・Scope・Revision・setupTimeline

すべて**変えない**。IR 行が control の 1 件だけになっても、setupTimeline の `qualified-ir:g04-ir` の step は validator が必須とする（:1044-1052）ので残る。setupTimeline の bytes は v1 と同じ。

### 2.3 変える field と変えない field（scratch の draft と v1 を node で比べた結果）

| 区分 | field |
|---|---|
| **変える** | `fixtureId`（`/2`）、`slotClass`（`supplementable`）、`scenes`（lio-landing の role、rv-match と rv-unknown の body）、`pins`（lio-market／Lio を外す）、`qualifiedIr`（lio-landing の行を外す）、`variants[base]`（下の表）、`positive`（P1 の文と rule、P2 を外す）、`measurementBoundary.graphConnection`、`measurementBoundary.rawPrediction` |
| **変えない（v1 と同じ bytes）** | `schemaVersion`、`status`、`caseId`、`sourceDocument`、`sourceSection`、`designReferences`、`observationPolicy`、`language`、`caseClass`、`goldDefinition`、`answerEntityIds`、`query`、`eligibleSceneIds`、`scope`、`entities`、`relations`、`manualSeed`、`foreshadows`、`revisions`、`mutations`、`setupTimeline`、`negative`、`measurementBoundary` の `contractBaseline`／`runtimeSetup`／`setupOrder`／`goldOrigin`／`setupRefusal` |
| variant の中で変える | `description`、`preconditions`、`arms.rPlusIr`、`arms.rPlusIrPlusGraph`、`pathAttachments`、`addedScene`、`blockedCandidates`、`evidence.requirements`、`metrics.rPlusIr`、`metrics.rPlusIrPlusGraph`（値は v1 と同じ数。§4.2） |
| variant の中で変えない | `id`、`measurementPoint`、`indexState`、`arms.raw`、`graph`（全体）、`scenesWithoutPath`、`forbiddenSceneIds`、`evidence.pathEvidenceValidity`、`evidence.assertions`、`metrics.raw` |

- `goldOrigin`（"Predeclared … before any Graph runtime observation"）は Gold についての文で、Gold は v1 のまま。期待値の由来（観測後の版）は `rawPrediction` と freeze の記録に書く（§7.3）。
- `setupOrder` は S2 validator が探す anchor（"then foreshadows, foreshadow Codex links and pins"、observation-prep.mjs:211）を含んだまま。

---

## 3. 前提条件と Raw の予測

### 3.1 宣言する前提条件

`[b-sealed-binding, maintenance-enabled, raw-membership, cb4-inputs(added-scene, sceneId g04-lio-landing)]`。`requiredPreconditions`（:1633-1655）が fixture から導く集合と一致する（scratch で確認）。

- `raw-membership` は残る（全 variant に必須、:1634-1638）。
- `ir-supplement-admission` は宣言できない（ir-only が無い。:1639-1645）。宣言すると「preconditions must be exactly …」で拒否される。
- **IR が何も足さないことは、前提条件ではなく構成で宣言する**：IR 行は R の Scene（control）にしか無い。製品の融合は、admitted な IR のうち Raw に無い最初の Scene だけを `kind: "ir"` の行にする（`nir1RelatedScenesFusion.ts`:44-69）。Graph の枠は `kind === "ir"` の行が無く Raw が 8 件未満なら開く（`nir1GraphFusion.ts`:79-91）。control の IR が採られれば行は `raw-ir`、採られなければ結果は `raw` で、どちらでも枠は開く。新しい前提条件（「IR が補完しない」）は足さない：manifest:192 の `closedSet` に当たる。
- **構成の担保が外れた場合は Hold になる（blocked ではない）**：表に無い Scene に製品が IR を作り、それが枠を使った場合（§10 の 5 の未確認の経路）、R+IR は arms と違う。v2 が宣言する前提条件のうち、これに当たるものは無い（raw-membership は R だけを見る）。v1 と同じ bytes の `setupRefusal`（"any other R or R+IR difference from the arms is Hold"）により、variant は Hold になる。前提条件を足さない判断（closedSet）と矛盾しない：宣言していない前提条件で観測を blocked にはできず（README:104、`resolveVariantOutcome` の :1779-1785）、Hold として結果を残す。
- control の IR（probe 0.6614、保存ベクトル 0.6598、floor 0.66 の近く）が採られるかは予測しない。`rPlusIr.resultKind` は記録だけの field（README:47、manifest の `recordedOnlyFields`）で、v1 の値 `fused` を残す。G-02／G-07／G-08 も `fused` と書き、R+IR+Graph は観測した R+IR をその kind に関わらず基底にする（README:46、:166、manifest `dependencies`）。

### 3.2 Raw の予測（本文だけの query と文書。設計 A §1.3・§4.2 の方法）

| Scene | Raw cos（probe） | 条件（δ＝0.03） | 由来 |
|---|---|---|---|
| control | 0.8083 | ≥ 0.54 | v1（設計 A §1.3） |
| rv-unknown（#7） | 0.4293 | ≤ 0.43（余裕 0.0007） | 候補の測定（contracts `g04-v2-candidates-2026-11-01/`） |
| rv-unresolved | 0.4271 | ≤ 0.43 | v1 |
| lio-market | 0.4248 | ≤ 0.43 | v1 |
| rv-alt | 0.3923 | ≤ 0.43 | v1 |
| rv-match（#4） | 0.3908 | ≤ 0.43 | 候補の測定 |
| rv-holder | 0.3697 | ≤ 0.43 | v1 |
| lio-landing | 0.3597 | ≤ 0.43 | v1 |

- 予測：**R＝[g04-control]**。control 以外がすべて 0.46（救済の下限）未満なので、sparse 救済も相対救済も起きない（`selectRelatedScenes.ts`:169-183。設計 A §4.1）。中央値に依存しない。
- Scene ごとの cosine は query とその Scene の本文だけで決まる。v2 で変える role、pin、IR 行は Raw の文書を変えないので、v1 と候補の値をそのまま組み合わせられる。候補は「1 項目だけを置き換えた仮の fixture」で測ったが（候補 README §2）、同じ理由で組み合わせても値は変わらない。
- 語彙（sparse）の検査：#4 と #7 は scratch で validator の `checkLexicalIsolation`（title を含む。:797）を通った。候補 README §1.4 の「機械の検査はまだ」の穴はここで埋まる。

### 3.3 候補 #4／#7 を使うことの扱い

- #4 は項目 B、#7 は項目 C の、固定の順で**最初の合格**（候補 README §2）。確認済みの手順（全候補を測り、固定の順の最初の合格を採る）に従った選択で、値を見て選び直していない。手順で確定していなかったのは「A が全件不合格なので B・C の採用も確定しない」ことだけで、(C) では A が要らない。ただし候補は**案 A の確認**（`user-confirmation-2026-11-01-g04-v2.md`）の手順で測ったもので、それを案 C に流用すること自体はユーザーの確認に含める（§9 U4）。
- #7 の余裕 0.0007 は δ を足した条件に対する余裕で、製品の救済の下限 0.46 に対しては 0.0307、gate 0.51 に対しては 0.0807。δ＝0.03 は独立の case の probe と保存値のずれ（最大 0.0150）の約 2 倍として確認された値（設計 A 付録 A）。
- 採らない選び方：#8（0.3746）を余裕で選ぶのは固定の順の規則に反する。v1 の rv-unknown を残す（0.4390）のは確認済みの条件 0.43 の緩和。どちらも起案者は決めない（§9 U4）。

### 3.4 凍結前の再 probe（判定基準は probe の前に固定する）

- 新しい候補は書かない。凍結する v2 の bytes に、凍結の直前に 1 回 probe を当てる（設計 A §4.5）。道具は以前に承認された `/tmp/onnxprobe`（設計 A §7.2 Q5 の (a)）。
- **確認済みの script はそのままでは v2 を判定できない**：`probe.mjs`（contracts `g04-v2-candidates-2026-11-01/`、`8fcc9010…`）は構造の条件を `irOnlyIrRows === 1 && controlScenes === 1`（:165）とし、これが false なら `allPass` は false、`stopRequired` は true になる（:174-178）。v2 は ir-only が 0 件なので、値に関わらず止まる。値を見てから「構造の条件は無視する」と読むことは、判定を後で読み替えることになるので採らない。
- 推奨：probe を当てる**前に**、構造の条件だけを v2 の形（ir-only 0 件、control 1 件）に変えた script の版を作り、差分がその 1 行に限られることを独立レビューで確かめ、sha256 を固定してから当てる。合否の条件（δ＝0.03 の値 `T_CONTROL`＝0.54、`T_OTHER`＝0.43、:32-37）と golden の条件（min ≥ 0.995）は変えない。ir-only が無いので IR の条件（`T_IR`）は使われない。control の IR は条件にしない（設計 A §4.3 と同じ）。
- 判定（固定する）：golden が条件を満たし、control の Raw が 0.54 以上、control 以外の 7 Scene の Raw がすべて 0.43 以下なら合格。**値の一致は求めない**（§3.2 の値と違っても、条件を満たせば合格）。1 つでも外れたら（例：#7 が 0.4301）止めてユーザーに戻る。値を見て候補を選び直さず、δ を変えず、probe を当て直さない。
- この版の script を作ることも、確認済みの道具の変更にあたるので、U4 の確認に含める。

---

## 4. 期待値の導出（規則だけから。Graph の出力は見ない）

### 4.1 手順と根拠

| 段 | 結果 | 根拠の規則 |
|---|---|---|
| 1. Revision の資格 | `g04-r-lio` だけが資格を得る。kit は `scope-mismatch`（wl-alt）、ora は `scope-unresolved`、tam は `scope-marker-unknown`、sel は `holder-not-reader` | README:116-120（承認、Scope、holder／audience）、contract.mjs `revisionExclusionReasons`。Revision と Scope は v1 と同じなので v1 と同じ |
| 2. 辿り | nodes＝bren@0、lio@1。edgeIds＝[ferried-lio]。除外の edge と Entity は v1 と同じ（4 edge と kit／ora／tam／sel は `revision-excluded`、mott は `no-revision`） | README:122-125（不適格 Revision、向き、範囲） |
| 3. Scene の対応付け | 到達した非 seed Entity の pin：Lio → lio-landing の 1 件。framePinCount 1 | README:126-127（明示 pin だけ、K1）、:647-686 |
| 4. 基底 | R＝R+IR＝[control]（control 1 件、順序宣言あり）。irSupplementSceneId＝null | README:44、:128。validator :1163-1166、:1193-1200 |
| 5. path の付加 | lio-landing は基底に無いので付加なし。pathAttachments＝[] | :687-690 |
| 6. 共通追加 1 枠 | R+IR が 1 件（8 未満）で IR 行が無いので枠は開く。最小 hop の新規候補は lio-landing だけ → addedScene＝lio-landing、path＝{bren, [ferried-lio], lio, hop 1}。blockedCandidates＝[] | README:128（融合）、:694-717 |
| 7. 最終の列 | R+IR+Graph＝[control, lio-landing]、appendedSceneId＝lio-landing、baseline＝rPlusIr、orderPredeclared＝true | :1222-1229、:1386-1394 |
| 8. path の無い Scene | scenesWithoutPath＝[control]（v1 と同じ）。forbiddenSceneIds＝[]（decoy が無い。v1 と同じ） | :1396-1418 |
| 9. excerpt | 本文 1 行の全体、`[0,211)`（UTF-16 長は node で 211） | :1362-1371、README:128（最初の非空行） |
| 10. Evidence | 4 必須＋`added-scene-body-anchor`。`raw-excerpt-unchanged` は付加が 0 件なので要求されない（:1431-1437）。G-08 graph-recovered（付加 0、追加 1）の前例に合わせて外す（§9.2 I4） | :1420-1444、README:50-53 |
| 11. 指標 | `scoreQuery`（Recall@8、nDCG@8）で計算：R 0／0、R+IR 0／0、R+IR+Graph 0.5／0.4966392596877323＝((2³−1)/log₂3)/(7＋(2²−1)/log₂3) | README:54、`nir1-retrieval/contract.mjs`:147-183 |
| 12. 区分 | base の arms から `supplementable` が導かれる | :1549-1573 |
| 13. 正例・負例 | P1 の材料（g04-r-lio、ferried-lio、lio-landing）は寄与する。N1〜N4 の材料は除外か path なしに入る | :1575-1624 |

- R+IR+Graph の指標の値は v1 の `metrics.rPlusIrPlusGraph` と同じ数になるが、導出は別（v1 は IR が lio-landing を足し、v2 は Graph が足す）。「v1 と同じ bytes」とは扱わない。
- 「指定改善」（`predeclaredImprovement`）は G-01 だけで、v2 でも false（manifest の検査 :1935-1938）。R+IR からの改善（0→0.5）は記録するが、G-01 の改善の代わりにはならない。

### 4.2 variant の期待値（draft。scratch の `g04-v2c-landing.json` の抜粋）

```json
"arms": {
  "raw": { "sceneIds": ["g04-control"], "orderPredeclared": true },
  "rPlusIr": { "sceneIds": ["g04-control"], "orderPredeclared": true, "irSupplementSceneId": null, "resultKind": "fused" },
  "rPlusIrPlusGraph": { "baseline": "rPlusIr", "sceneIds": ["g04-control", "g04-lio-landing"], "appendedSceneId": "g04-lio-landing", "orderPredeclared": true }
},
"pathAttachments": [],
"addedScene": { "sceneId": "g04-lio-landing", "path": { "seedEntityId": "g04-bren", "edgeIds": ["g04-ferried-lio"], "targetEntityId": "g04-lio", "hop": 1 },
  "sceneExcerpt": { "sceneId": "g04-lio-landing", "body": "<v1 と同じ本文>", "canonicalUtf16Range": { "start": 0, "end": 211 } } },
"blockedCandidates": [],
"evidence": { "pathEvidenceValidity": 1, "requirements": ["edge-relation-evidence", "node-entity-evidence", "revision-decision-binding", "explicit-pin-association", "added-scene-body-anchor"], "assertions": [] },
"metrics": { "raw": {"recallAt8": 0, "ndcgAt8": 0}, "rPlusIr": {"recallAt8": 0, "ndcgAt8": 0}, "rPlusIrPlusGraph": {"recallAt8": 0.5, "ndcgAt8": 0.4966392596877323} }
```

- P1 の文（案）："… qualifies; the one Scene pinned to Lio is appended in the shared slot that IR left unused."。rule に candidate §6 の「IRが共通追加枠を使っていなければGraph-only Sceneを1件追加」を足す。
- P2 は外す。同じ ID を別の意味で使い回すと v1 と v2 の比較を誤らせるので、ID は再利用しない（§9.2 I3）。
- `graphConnection` は G-02 の文から「path attachments to existing R+IR Scenes」を除いた文にする（付加が無いので）。`rawPrediction` には「v1 の観測の後に作った版で、ir-only を置かず IR は control だけに与え、review の本文 2 件は凍結前の model-only probe で選んだ。IR の recall の根拠にならない」を書く（設計 A §5.6 の限界の記録先）。

---

## 5. C-body への依存

- **要る**。Graph-only の追加は target Scene の本文開示（C-body）を要し、C-body が Hold なら追加は返らず Hold になる（README:212-215、manifest `dependencies`）。path 付加と Graph DTO は依存しない。v2 の G-04 は Graph DTO（Scope の比較の中心）を C-body に依存せず比べられ、追加 1 件の部分だけが依存する。
- 補完可能な case の宣言（`declaration-addendum.v1.json`）：fixture の setupOrder に段を足さず、setupOrder の外に 1 段を挟む（`declarationStep`：setupOrder の pin の段の後、Graph arm の最初の query の前。place は (ii)〔測定の workspace を開いた後〕）。値は v1 の subset（story／auto／phase／POV は independent、reveal は non-secret、対象は本文全体と title）。承認は製品 Main の CI seam（`electron/main/bodyDeclarationCiSeam.ts`）。run ごとに宣言する。
- lio-landing が v1 の subset で宣言できるか（K2/4 の「宣言の値」:284-301、「利用時の判定」:309-319 を fixture に当てた）：
  - reading：20 < 100。
  - reveal：G-04 の `foreshadows` は空。secret な Chronicle event も無い（IR 行を外すので、lio-landing に Chronicle の child も作られない）。
  - POV：fixture は設定しない。
  - A1：lio-landing は Scope の既定（explicit、3 軸 exact で query と一致、reader）。K2/4:296 の条件を満たす。
  - excerpt：`[0,211)`。本文の読取の上限 64 KiB（`scene_body_declaration/limits.rs`:10）の内。
- setupTimeline：変えない。宣言の段は setupTimeline の step にも measurementPoint にも数えない（addendum の `declarationStep`）。
- **閉じたままの UI**（`BODY_DECLARATION_UI_ENABLED = false`、`bodyDeclarationAvailability.ts`:13）：測定の setup は UI でなく CI seam を通るので、UI が閉じていることは測定を妨げない。G-02／G-07／G-08 の setup で動くことは integrator の記録（設計 A 付録 B）による。G-04 の形（宣言する Scene が IR 行を持たない answer の Scene）で動くかは確かめていない。
- **確認済みの契約の範囲の外**（版の問題ではない）：K2/4（`nir1-c-body-disclosure-proposal/4`、2026-10-17 に確認）の setup addendum は「宣言する Scene は、期待値が Graph-only の追加（appendedSceneId）を持つ variant の、次の4つである」（:391）と書き、表（:393-398）に G-01、G-02、G-07、G-08 を並べる。:419 の改版の条項も G-01 と G-02／G-07／G-08 の改版だけを挙げる。`K24_TABLE`（observation-prep.mjs:76-87）はこの表の写しで、S2 validator は出典として K2/4 を引く。G-04 に行を足すと、Graph に本文を開示する評価の Scene を、確認済みの契約が限った 4 つから 5 つに広げることになる。宣言の値・veto・利用時の判定（製品の authority）は変えないが、適用範囲の拡張なので、AGENTS の委任の外（新しい契約・authority）に近い。選択肢は §9 U2。
- 宣言しない場合：C-body の利用時の判定は宣言の 2 列がそろうことを求める（K2/4:312）ので、Graph-only の追加は返らない。addendum の `cb4Inputs` のとおり、これは `cb4-inputs` に当たらず、期待値と違うので **Hold**。Graph DTO と R+IR の先頭は比べられるが、v2 の追加の検査は成り立たない。
- 要る変更（どれもこの設計では行わない）：
  - 宣言の addendum の新しい版（v1 は `frozen-after-independent-review`〔:4〕で、`variantsWithoutDeclaration` に G-04/base を持つ〔:125-138〕）。
  - S2 validator：`K24_TABLE`（observation-prep.mjs:77-87）に G-04/base の行（`g04-lio-landing`、20、100、211）を足す。`declarationAddendumErrors`（:1789-1870）は、追加を持つ凍結済み variant の集合が K24_TABLE と一致することを求める（:1825-1831）。診断用の負例を足すなら `GRAPH_NEGATIVES`（:205-209）も。
  - harness：`GRAPH_EVAL_VARIANTS` の G-04 の行（`constants.mjs`:183-190）で `declaration` を true に、fixturePath を v2 にする。:156-157 の「five K2/4 declaration runs」も 6 になる。

---

## 6. 失うものと coverage への影響

### 6.1 G-04-P2、path 付加、「後二群の不変」

- 失う：v1 の G-04-P2（IR が枠を使った後、資格のある Lio の第二の Scene を Graph が足さず、R+IR を変えない）。
- 失う：**G-04 での path 付加の検査**。v1 の G-04-P1 は IR が補った Scene に path を付けることも検査していた（v1 の `pathAttachments`、`raw-excerpt-unchanged`）。v2 は付加が 0 件。path 付加は G-02、G-03、G-05〜G-08 が持つので（各 fixture の `pathAttachments`）、検査そのものは残る。Lio の pin を control に移して付加を残す案は、N4 の「no path reaches g04-control」（fixture の negative の文）と矛盾するので採れない。
- 残る検査：G-05 の base が同じ規則を検査する（`blockedCandidates` に `g05-pia-ridge`／`ir-supplement-used`、正例の第二 Gold。README:171）。IR補完済みの区分は G-05 だけになる。
- manifest `irSupplementedCoverage.cases` は `["G-05"]` になる（validator が ir-supplemented の case の列挙と一致を求める。:1900-1907）。`consequence` のとおり、G-05/base が `blocked:ir-supplement-admission` なら l6-l9:870 の「後二群は membership、順位、excerpt 不変」の IR補完済みの側は未検証で、CP-4 は PASS にならない。v1 の G-04 が blocked だった今と、この帰結は同じ（G-04 はすでにこの区分を支えていない）。G-05 の xan-watch の IR は probe 0.7531（floor から +0.093。設計 A 付録 A）で、v1 の G-04 より余裕は大きい。ただし manifest の必須の項目「R+IR membership, order and excerpts unchanged for raw-full and ir-supplemented cases」（manifest:85）の IR補完済みの側の根拠が 1 case だけになることは変わらないので、ユーザーの確認の対象にする（§9 U5）。
- G-04-P2 の代わりの検査は**置かない**と明記する。代わりにできる案（§9 U0 の P-c）は corpus を足し、選ぶ余地が大きい。
- macro の非回帰（manifest:82 の必須の項目）：G-04 の R+IR → R+IR+Graph の差が、v1 の設計の 0 から +0.5（Recall）／+0.4966（nDCG）になる。補完可能な case では普通の形で、閾値・Gold・pool の緩和には当たらないと読む。macro の計算箇所は `nir1-graph-eval/` の非試験の code に見つからず（"macro" の grep で該当なし）、**確かめられなかった**。これも G-01 の指定改善の代わりにはならない（§4.1）。
- 補完可能な case の側の検査：R+IR+Graph の先頭は観測した R+IR と同じでなければならず（README:46）、G-04 v2 は control 1 件なので順序まで比べる。これは「後二群」の不変の代わりではなく、補完可能な区分の検査。

### 6.2 区分の分布

- 補完可能：G-01、G-02、G-04、G-07、G-08（G-08 は usable の variant）。Raw満杯：G-03、G-06。IR補完済み：G-05。3 区分とも残る（manifest の検査 :1946-1952）。
- control 1 件の補完可能は G-02〜G-08 に前例が無い（G-01 は control 1 件の補完可能）。manifest:156 の `raw-membership` の `check` は「the two controls of a supplementable case」と書くので、文の更新が要る（§9 U1、件数の選択は §9.2 I1）。

### 6.3 K6/4 の pool と `expectedContribution`（規則から）

- 正式の run は `materialContribution`（`frozen-k64-run.mjs`:1948-1954）で判定する。期待の path は fixture の `addedScene` と `pathAttachments` から作る（`material-revision.mjs`:150-171）。v2 では graph-only の lio-landing、組は `g04-r-lio|g04-ferried-lio`。`pairOf`（:138-149）は edge を運ぶ qualified Revision がちょうど 1 件であることを求め、`g04-ferried-lio` は `g04-r-lio` だけが運ぶので成り立つ。
- 寄与は、観測した graph-only の Scene とその辺の Revision がこの組と一致し、辺が 1 件以上のとき true（`material-revision.mjs`:283-306、`followup.mjs`:680-681 の X5）。規則の上では Graph が lio-landing を追加するので、**true になる見込み**。v1 は期待の付加先（lio-landing）が一覧に無く、照合する観測が無かった（diagnosis の subagent の報告）。
- 見込みが崩れる条件：宣言の段が G-04 に無い（Hold）、C-body の判定で不採用、B の seal が成り立たない（blocked:b-sealed-binding）。
- **pool と case の判定が分かれうる**：v2 では IR 行が R の Scene にしか無く、Raw が 8 件未満なら枠は開く。review Scene が R に余分に入っても Graph は lio-landing を足せるので、pool の寄与は true になりうる。一方、case の比較は `blocked:raw-membership` になる。pool（`availability.mjs`:240 の `inPool = expectedGraph !== "unavailable"`）は blocked を見ないので、v1 と逆向きの分離が起きうる。S7 で開示する。
- pool の作り方、閾値 1%、F6・X5 の定義は変えない。G-04/base は `expectedGraph: "available"` のまま pool に入る。それでも、v1 の欠落の唯一の原因だった case を観測の後に作り直すので、1% の判定は Graph に有利な向きに動きうる（§1.3 の 5、§9 U3）。

---

## 7. 波及と手順

### 7.1 sha256 と規則文が入っている場所（設計 A §5.1 を確かめ直した差分）

設計 A §5.1 の表の行はすべて (C) でも要る（新 file、schema の fixtureId の pattern〔schema.v1.json:43〕、manifest の G-04 の行、README、レビュー記録、freeze、S2 の `references.graphCaseFreeze`、作者の宣言、seed-pin addendum、declaration addendum と G-01 の setup addendum の freeze の sha256、S4、harness の `GRAPH_CASE_FREEZE` と `FROZEN_FIXTURE_SHA256`〔constants.mjs:108-130〕、setup 専用の Main、validator の `graphRuntimeObservedBeforeFreeze`、SP/1）。このセッションで実物に当てたのは、constants.mjs（:108-130、:183-190）、S2（observation-prep.v1.json と observation-prep.mjs）、seed-pin addendum（:37-41、:132-135）、declaration addendum、作者の宣言（:63）、validator（contract.mjs:1921-1924 の周辺と :2300-2307）。schema:43、freeze の行番号、独立レビュー記録、SP/1、setup-main-build の sha の扱いは設計 A の記述を引き継いだ。(C) で**足すもの**：

| 場所 | v2（C）で要ること |
|---|---|
| manifest `cases[G-04].slotClass` | `supplementable`（validator が fixture と照合。contract.mjs:2396-2400） |
| manifest `irSupplementedCoverage.cases` | `["G-05"]`（:1900-1907） |
| manifest `preconditions.definitions` の文 | `raw-membership.check`（:156、control の件数）、`ir-supplement-admission.appliesTo`（:162、G-05 だけ）、`cb4-inputs.appliesTo`（:176、G-04 base を足す）。id と scope は変えない（:1866-1876） |
| README | :24（区分を補完可能に）、:89-92（前提条件の表の列挙）、:107（IR補完済み＝G-05）、:137（G-04 の pin 2 → 1）、:171（第二 Gold の負例は G-05 だけ）、:185（probe の記述）、:212（補完可能な case の列挙）、:265-266（観測後の版の規則文。設計 A §5.3） |
| `declaration-addendum`（新しい版） | G-04/base の宣言の行、`references.fixtures` に G-04、`variantsWithoutDeclaration` から G-04/base を外す、必要なら診断用の負例 `K24-G04-N1`。S2 は addendum の commit と sha256 を束縛する（observation-prep.mjs:1172-1173 の key）ので S2 追補の対象 |
| S2 validator `observation-prep.mjs` | `K24_TABLE`、`references.fixtures` の loop（:1801-1807 は G-02／G-07／G-08 だけ）、必要なら `GRAPH_NEGATIVES` |
| addendum の path の定数（新しい file 名にする場合） | `observation-prep.mjs`:32、`trace-frozen.mjs`:541-542、`frozen-k64-admission.mjs`:40 |
| harness `constants.mjs` | G-04 の `declaration` を true |
| setup 専用の Main の IR の表 | lio-landing の行が無くなる（`setup-main-build.mjs`:7-18 は fixture から表を作る） |
| validator の試験 `scripts/quality/nir1-graph/contract.test.mjs` | `fixture()`（:55-58）は manifest の path で読むので、manifest を v2 に向けると次が落ちる：:251-270（G-04 の lio-market が blocked。G-04 の行を外し G-03・G-06・G-05 で残す）、:544-551（admitted な IR 補完の resultKind。G-05 に移す）、:563-574（G-04 の前提条件に `ir-supplement-admission`。G-05 の `g05-xan-watch` に移し、G-04 は cb4-inputs を持つ形の検査に変える）、:596-606（`ir-supplement-admission` を外すと拒否。G-05 に移す）、:640-650（`blocked:ir-supplement-admission`。G-05 に移す）、:830（freeze の drift の対象の path を v2 に）。`ir-supplement-admission` を試す実例は今は G-04 だけ。:402-408（G-04 の Revision の除外理由）は Revision と Scope が同じなので変わらない |
| harness の試験 | `frozen-setup-complete.test.mjs`:471-478（G-04/base の Chronicle の IR が 2 件で、2 つの child を使う試験。v2 は 1 件なので G-05/base に移す）、`frozen-setup-plan.test.mjs`:906-918（IR を持つ Scene の folder：G-04 は [control] だけ、合計 10 → 9）、`outcome.test.mjs`:769-774（`irSupplementSceneId` が lio-landing。v2 は null）。`frozen-setup-plan.test.mjs`:753-768 と `frozen-setup-driver.test.mjs`:495-505（G-04 の Scope の書込み）は Scope が同じなので変わらない見込み |
| `evals/quality-manifest.yaml` | GDX-GROUND-001 の `implementedBy`（:684 に v1 の path、:694 に addendum v1）に v2 の file と addendum の新しい版を足す（K2/4:418 は addendum を quality-manifest と impact-map に分類することを求める）。`evals/impact-map.yaml`:366-368 は glob なので変えない |
| dev の形の写し | `dev-shape-fixture.mjs`:33-36 と `dev-fixtures/dev-shape-g04.v1.json`（v1 の形、:395 に `ir-supplement-admission`）。⑤ より前に形を dev で試すための写し（同 file :1-12）なので、v2 の形（追加 1 件と宣言）で作り直すのを推奨（§9.2 I6） |
| 対象外（過去の記録） | `docs/plans/nir1-cp4-records/r5-check-r5-1027/receipts/G-04__base.setup-receipt.json`、`sp-p4-1/sp-p4-receipt.json`、`cp4-decisions.md` の DR-CP4-J-1、`nir1-graph-case-seed-pin-proposal-1-draft.md`:46、`independent-expectation-review.v1.json`。v1 の記録として変えない |

- repo 全体の grep（`git grep`：v1 の file 名、sha256 `4d002261`、`g04-lio-landing`／`g04-lio-market`、`"G-04"`、`G-04/`、`ir-supplemented`、`ir-supplement-admission`）で上の表と設計 A §5.1 の外に出た場所は、ほかに `availability.test.mjs`、`followup.test.mjs`、`diagnostic-runner.test.mjs`、`r5-check-runner.test.mjs`、`seed-pin*.test.mjs`、`s5b-test-support.mjs`、`frozen-diagnostics.mjs`、`eval-fixtures.test.mjs`、`quality-workflow.test.mjs`。どれも variant 名か case ID を key に使うだけで、名前は変わらないので影響は無い見込み（走らせて確かめる。§10）。`frozen-setup-driver.mjs`:236-243 の前提条件の順の一覧は case に依らない。
- S2 の variant の一覧（observation-prep.v1.json:81、:152、:215、:473、:1644）は variant 名 `G-04/base` が変わらないので変えない。
- SP/1 の G-04 の行（query `g04-query`、seed `g04-bren`、`expectedGraph: available`）の中身は変わらない。

### 7.2 手順

0. ユーザーが §9.1 の確認事項に答える。integrator は mutation の前に、判断と信頼境界を `cp4-decisions.md` に DR として書き、その ID を作業記録に載せる（§9.3）。
1. integrator：scratch の draft（§8）を元に v2 の bytes を組む。変える field は §2.3 の集合に限る。
2. probe の実行者：§3.4 のとおり、構造の条件だけを直した script の版を独立レビューで確かめて sha256 を固定し、凍結する bytes に 1 回当てて、固定した条件で判定する（新しい候補は書かない）。
3. 宣言の addendum の新しい版を起案する（U2 で選ばれた形。値は変えない）。
4. 独立期待値レビュー：fixture の作成者と別の read-only の担当。渡すもの：v1 と v2、その差分、README・manifest・l6-l9 の規則の節、この設計の §2〜§4、候補の測定記録、probe の生データ。渡さないもの：Graph runtime の出力（DTO、frame、graph arm の受領書、X5 の内訳、diagnosis の Graph の要約）。確かめること：差分が §2.3 に限られること、期待値を規則だけから導き直して一致すること、`graph` が v1 と同じ bytes であること、#4／#7 の選択が固定の順のとおりであること、addendum の宣言が v1 の subset で veto に当たらないこと、`pnpm eval:fixtures` が通ること、設計 A §3.3 (6)（review Scene の本文が typed Revision の準備と Evidence に入らない）を製品の code で確かめること。
5. validator・schema・S2 validator・harness の定数の変更を、試験と一緒に別の PR で用意し、レビューを受ける（設計 A §5.3 の `postObservationRevisions` と、G-04 以外の fixture の sha256 を v1 の freeze に束縛する検査を含む）。試験の範囲（§7.1 の表）：
   - `contract.test.mjs`：`ir-supplement-admission` の 4 つの試験（:544-551、:563-574、:596-606、:640-650）を G-05 に移し、:251-270 から G-04 の行を外す。新しく書く試験：G-04 v2 が `supplementable` で cb4-inputs（`g04-lio-landing`）を持ち、追加が lio-landing であること、Lio の pin を 2 件に戻すと最小 hop の重なりで拒否されること、answer の Scene に IR 行を足すと拒否されること（§8 の負の検査を試験にする）。
   - S2 validator の試験：K24_TABLE の 6 行と G-04 の `references.fixtures`、addendum の新しい版の形。
   - harness の試験：`frozen-setup-complete.test.mjs` の 2 child の試験を G-05/base に移し、`frozen-setup-plan.test.mjs` と `outcome.test.mjs` の期待を v2 に合わせる。
   - 変えない見込みの試験（§7.1 の grep の残り）も走らせて確かめる。
   - `quality-manifest.yaml` の分類と、dev の形の写し（I6）。
6. graph case の freeze を凍結し直す。宣言の addendum の新しい版を凍結する。
7. S2 の追補、addendum の更新、S4 の凍結のやり直し（DR-CP4-S4-6 の手続き：失効の commit → S2 の追補 → S4a → S4b → manifest）。
8. setup を作り直す（13 setup。IR の表が変わる）。
9. ④ SP-P4、⑤（trace 2 件、parity、Gold、negative）を新しい S4 と X1-5 の候補で測る。
10. S6 の集計と S7 の報告。

### 7.3 観測の後に作った版の記録、測定のやり直しの範囲

- 記録の方法は設計 A §5.3 をそのまま使う（`graphRuntimeObservedBeforeFreeze` を true にして `postObservationRevisions` を足し、G-04 以外の fixture と schema の変更の範囲を束縛する。README:265-266 と manifest の `holdVersusBlocked` の文を改訂する）。`changedFields` には §2.3 の「変える」の行を書き、`graphOutputUsed: false` の注記に §1.3 の 3（diagnosis の要約を読んだこと）を書く。
- manifest の `irSupplementedCoverage.admissionProbe` と freeze の `irSupplementAdmissionProbe.status` は一致が求められる（contract.mjs:2300-2307）。G-04 の Raw の probe は凍結前に行うが、G-05 の IR は凍結前に probe していない。field の読み方（区分全体か case ごとか）は integrator が決める（§9.2 I5）。
- 測定のやり直しは全部（設計 A §5.4。S6 は `s4Commit` を 1 つだけ通す）。X1-5 の再測定と 1 回にまとめる（先の確認の Q4 (a)）。

---

## 8. 妥当性の確認（scratch。測定に数えない）

- 置き場：`/tmp/claude-1000/-home-grimodex-Grimodex/dd1afc24-5546-4b01-b89b-6ba9b38e5b63/scratchpad/g04c/`。`build.mjs`（v1 の bytes から draft を作る。sha256 `49a878b5…`）、`check.mjs`（`957ad386…`）、`neg.mjs`（`9fb6ec80…`）、draft `g04-v2c-landing.json`（`ec5455a9…`）。
- 方法：worktree の `scripts/quality/nir1-graph/contract.mjs` を絶対 path で import し、`parseGraphCaseTable`（l6-l9 の表）と、**scratch のメモリ上で fixtureId の pattern だけを `/[12]$` に緩めた schema** の Ajv で `validateGraphCaseFixture` を呼んだ。Node v24.18.0（CI は Node 22。README:270）。repo に一時 file は作っていない。
- 結果：
  - draft（P-a）：**誤り 0 件**。前提条件は導出と一致、framePinCount 1、最終の列 [control, lio-landing]、語彙の隔離（#4／#7 を含む）も通過。
  - P-b（lio-market を追加）：誤り 0 件（R+IR+Graph の nDCG 0.2128453970090281）。
  - Lio の pin を 2 件のまま：「several new Scenes share the minimum hop」と blockedCandidates の不一致で拒否。
  - role を answer にして IR 行を残す：「qualified IR may only target control or ir-only Scenes」で拒否。
  - role を ir-only のまま：R+IR、irSupplementSceneId、前提条件（`ir-supplement-admission` が要る）の 3 件で拒否。
  - `raw-excerpt-unchanged` を残す：誤り 0 件（validator はどちらも許す）。
- 確かめていない経路：`pnpm eval:fixtures` の全体（manifest、freeze、S2 の検査）。manifest・freeze・S2 は v1 の bytes を前提にしており、tracked file を変えずには回せない。S2 validator（`declarationAddendumErrors`）は §5 のとおり、今の bytes のままでは G-04 の追加を拒否すると code から読める（実行はしていない）。

---

## 9. 選択肢と、確認・判断の分担

### 9.1 ユーザーの確認が要る点

- **U0 この構成で v2 を作ること**（P-a と R-1 を含む）。pin の置き方の選択肢：(P-a) lio-market の pin を外し、lio-landing（Gold 3、Bren が Lio を降ろす場面そのもの）を追加する。R+IR+Graph の nDCG 0.4966（推奨。追加する Scene が Relation の内容と一致し、v1 の pin の 1 件をそのまま使う）／(P-b) lio-landing の pin を外し、lio-market（Gold 2）を追加する。nDCG 0.2128。Gold 3 の Scene が pin なしになる／(P-c) 新しい Entity と Relation で lio-market に 2 hop の path を作り、`one-slot-used` の blocked を残す（G-04-P2 の代わりになりうるが、corpus を足し選ぶ余地が最大。推奨しない）。
- **U1 規則文の改訂**：manifest `preconditions.definitions` の `appliesTo`／`check` の文（raw-membership の「補完可能は control 2 件」、ir-supplement-admission と cb4-inputs の列挙。§7.1）は、`closedSet`（manifest:192「観測の後に足さず、外さず、読み替えない」）が守る定義の文。validator は空でない文字列かだけを見る（contract.mjs:1877-1884）ので機械的には通る。この設計は id・scope・判定の意味を変えず、当てはまる case の列挙だけを直す、と読む。**読み替えに当たるかはユーザーが決める**。README の同じ列挙、README:265-266 の改訂、`graphRuntimeObservedBeforeFreeze` の扱い（設計 A §5.3、§7.2 Q2）も同じ確認に含める。
- **U2 C-body の開示の範囲（確認済みの K2/4 契約の適用範囲）**：
  - (a1) K2/4 の適用範囲を G-04 v2 の `g04-lio-landing` に広げることをユーザーが確認し、その確認の記録を addendum の新しい版と `K24_TABLE` の出典に書く。宣言の値・veto・利用時の判定は変えない。結果：Graph-only の追加が成り立ちうる（推奨。K2/4:391 の規則〔appendedSceneId を持つ variant に宣言する〕に当たり、製品の authority の中身は変えない。速い）。
  - (a2) K2/4 の新しい draftRef（例 `nir1-c-body-disclosure-proposal/5`）として、宣言する Scene の範囲だけを改訂して起案し、確認を受ける。結果は (a1) と同じだが、起案・レビュー・確認の分だけ遅れる。開示の範囲を契約として正式に改める点で、(a1) より手続きが重い。
  - (b) 宣言しない。結果：Graph-only の追加は返らず、v2 の G-04/base は Hold（§5）。Graph DTO の比較は残るが、K6/4 の pool では寄与が無く X5 が続く見込みで、(C) の目的の半分を失う。
- **U3 pool の判定への影響**（§1.3 の 5、§6.3）：v1 で pool の欠落の唯一の原因だった G-04/base を、観測の後に作り直す。case が blocked でも pool では寄与ありになりえ、1% の判定が Graph に有利な向きに動きうる。「失敗した case を外す」ではなく「作り直す」こと、v1 の結果を残すこと、S7 で開示すること、pool の選び方・閾値・F6・X5 は変えないことを前提に、これで進めてよいか。
- **U4 review Scene の本文と probe**：(a) 案 A の確認の手順で測った候補 #4／#7 を、案 C に流用する。固定の順の最初の合格を採る規則どおり。凍結前の再 probe は §3.4 のとおり、構造の条件だけを直した script の版で、δ＝0.03 の条件で判定し、外れたら止める（推奨）／(b) rv-unknown だけ候補の手順をやり直す（合格しているのでやり直す理由が無く、選ぶ余地が戻る）／(c) rv-unknown を v1 のまま残す（0.4390。**確認済みの条件 0.43 の緩和**で、起案者は決めない）。
- **U5 IR補完済みの区分が G-05 だけになること**：`irSupplementedCoverage.cases` が `["G-05"]` になり、必須の項目（manifest:85 の「後二群」の IR補完済みの側）の根拠が 1 case だけになる。G-05/base が blocked なら CP-4 は PASS にならない（manifest の `consequence`。今も G-04 は blocked なので帰結は同じ）。
- **閾値・Gold・pool にあたるもの**：推奨の案はどれも、閾値（floor、gate、救済の下限、δ、1%）、Gold（`goldDefinition`、各 Scene の Gold、`answerEntityIds`）、pool の作り方を変えない。U4 の (c) は確認済みの δ の条件の緩和。U3 は緩和ではないが pool の判定に効くので確認に回す。pin と IR 行を外すのは corpus の変更（`observationPolicy` の対象）で、新しい版の手続き（README:211）の内側で行う。

### 9.2 integrator の判断でよい点（NIR-1 の委任の範囲の技術判断。DR に記録する）

- **I1 control の件数**：(R-1) control 1 件のまま（推奨。corpus を変えず、R の順序まで宣言でき〔:1165〕、比較が厳しくなる。G-01 に前例がある）／(R-2) control を 1 件足す。規則文の改訂は U1 で確認する。R-2 を選ぶなら Scene を足す corpus の変更になるので、ユーザーに戻す。
- **I2 診断用の負例**：`K24-G04-N1`（宣言しない run では R+IR+Graph が R+IR と同じ）を足す（推奨。G-02／G-07／G-08 と同じ形で、case の判定に数えない診断）。
- **I3 P2**：外し、v2 の記録に「G-04-P2 は v2 で廃止。同じ規則は G-05 が検査」と書く。ID は再利用しない（v1 と v2 の比較を誤らせないため）。
- **I4 `raw-excerpt-unchanged`**：外す。付加が 0 件で、G-08 graph-recovered の前例と同じ。この名前は `scripts/`、`src/`、`electron/` のうち validator（`nir1-graph/contract.mjs`）にしか出ず（git grep で確認）、runtime の比較に効かない。
- **I5** file の名前（案 `g04-scope-exact-unknown.v2.json`）、addendum の新しい版の名前、`admissionProbe` の field の読み方、レビュー記録の形式、scratch の draft と script を contracts に写すか。
- **I6 dev の形の写し**：`dev-shape-g04` を v2 の形で作り直す（推奨。⑤ の前に、追加 1 件と宣言の形を dev で試せる）。

### 9.3 判断の ID と記録先（案）

- ID：`DR-CP4-G4-1` から（`cp4-decisions.md` に `G4` の接頭辞は無い。git grep で確認）。G4-1 は案 C の構成（U0、I1〜I4）、G4-2 は U2 の扱い、G4-3 は再 probe の script の版と判定（U4、§3.4）、G4-4 は試験と分類の範囲（§7.2 の 5）、以後は手順ごと。
- 記録先：判断と信頼境界は `docs/plans/nir1-lane-decisions/cp4-decisions.md`（DR の表）と各 PR の本文。ID と記録先は作業記録 `docs/plans/nir1-continuation-2026-10.md` に載せる（AGENTS の手順）。ユーザーの確認は contracts の `docs/plans/nir1-cp4-records/user-confirmation-…-g04-c-….md` に残す（先の確認と同じ形）。

---

## 10. 確かめていないこと

1. `pnpm eval:fixtures` の全体と、S2 validator の実行（§8。fixture 単体の検査だけをした）。
2. 凍結する bytes に対する probe（embedding を実行していない）。§3.4 の script の版はまだ無い。§3.2 の v1 の Scene の値は設計 A §1.3 の数で、`g04-cosine-probe.json` は開いていない。
3. review Scene の本文が、製品の typed Revision の準備（本文を anchor に取るか）や Evidence に入らないこと（設計 A §3.3 (6) を持ち越す）。入るなら rv-match と rv-unknown の本文の変更は Graph の入力の変更になる。
4. C-body の宣言と追加が G-04 の形で測定の setup で動くこと。G-02／G-07／G-08 で動いたことも integrator の記録による（受領書は読んでいない）。
5. 製品が `qualifiedIr` の無い Scene に IR を作らないこと。setup の決定論の provider は fixture から作る表の本文と一致する Scene にだけ答える、と `setup-main-build.mjs`:7-18 のコメントにある。provider の実装と、表に無い Scene に対する Chronicle の挙動は読んでいない。
6. evidence の要件の名前（`raw-excerpt-unchanged`、`added-scene-body-anchor`）は `scripts/`、`src/`、`electron/` で validator にしか出ないことは確かめた（I4）。harness が `evidence` の field を runtime とどう比べるかは読んでいない。
7. dev の経路の `devExpectedContribution`（`k64-runner.mjs`:422-433）は `rPlusIrPlusGraph.pathAttachmentSceneIds` を読むが、schema にこの field は無い。正式の run は resolver を使うので v2 の判断には効かないと読んだが、確かめていない（副次の所見）。
8. 13 setup の間で `setupMainSha256` の一致を求める検査の有無（設計 A §7.1 と同じ）。
9. K2/4 の確認が 5 件目の宣言 Scene に及ぶか（§9 U2。ユーザーの判断）。
10. X1-5 が G-04 の Raw の値や C-body の判定に影響しないか（推測では影響しない）。
11. CI と同じ Node 22 での検査（起案者は Node v24.18.0 で実行。独立レビューは Node 22.23.3 でも誤り 0 件を再現したと報告しているが、起案者は確かめていない）。
12. §7.1 の「影響は無い見込み」の試験（availability、followup ほか）が v2 でも通ること（走らせていない）。§7.1 の表の試験の行番号は実物で読んだが、直した後の試験は書いていない。
13. macro の非回帰の計算箇所（§6.1）。
14. SP-P4 の IR を比べる組（`observation-prep.v1.json`:530-550）が、G-04 の IR が control だけになっても比べられること（独立レビューの所見。起案者は読んでいない）。

---

## 改訂の記録

- 改訂 1（2026-11-01）：初版 `f4dc2a39` の独立レビュー（scratch `g04c/review-g04-v2c-design.md`、`reviewer-own-derivation.md`。判定 (b)、P1 なし、導出は全項目で一致）を受けた。各指摘は起案者が実物に当てて確かめてから反映した。
  - P2-1（§7.1 の漏れ）：`contract.test.mjs` の 6 か所、`frozen-setup-plan.test.mjs`:906-918、`outcome.test.mjs`:769-774、`quality-manifest.yaml`:684／:694、`dev-shape-fixture.mjs`:33-36 を読んで確かめ、§7.1 と §7.2 の 5 に足した。repo 全体の git grep で、レビューに無い `frozen-setup-complete.test.mjs`:471-478（G-04 の IR 2 件を前提にする）も見つけて足した。
  - P2-2（pool）：`s6-aggregation-s5r4/README.md` §4 (a) と `availability.mjs`:240 で確かめ、§1.3 の 5、§6.3、§9 U3 に足した。
  - P2-3（K2/4 の範囲）：K2/4:391、:393-398、:419、:312、`observation-prep.mjs`:76-87 で確かめ、§5 と §9 U2 を書き直した。
  - P3-1：`setupRefusal`（v1 と同じ bytes）と README:104 で確かめ、§3.1 に足した。
  - P3-2：レビューの指摘に加え、確認済みの `probe.mjs`:165、:174-178 が ir-only 1 件を構造の条件にしており、そのままでは v2 を判定できないことを見つけた。§3.4 を新設した。
  - P3-3：§6.1 に足した。P3-4：§9 を U（確認）と I（integrator の判断）に分け、U5 を足し、§9.3 に DR の ID と記録先の案を書いた。P3-5：constants の fixturePath の列を §5 に足した。

