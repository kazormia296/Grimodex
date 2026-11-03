> 注（integrator、2026-11-03）：読むだけの workflow（調査 4・反証の検証 4・まとめ 1。model は sonnet）が作った材料。integrator が実物で確かめたのは次の 4 点：(1) `resolveCp4VariantOutcome`・`compareExistingQueryGraphArm`・`decideCp4Availability` は試験とコメント以外から呼ばれない（origin/master `39ac13c8`）、(2) `summarizeVariantQuality` は `k64-runner.mjs:289` の dev の予告の分岐だけから呼ばれる、(3)「IR と Graph で共通の追加 1 件枠」の初出は #571（`6dcd8e5b`、2026-09-12）の `nir1-l6-l9-execution-plan.md:909`、(4) Graph の seed は query の Scene の最初の pin（`nir1GraphSeed.ts:15`）。ほかの主張は workflow の検証を経た下書きとして読む。ユーザーの依頼：`c915aa5e`。

# 融合の枠を議論するための材料（NIR-1）

調べた範囲は `origin/master`（39ac13c8）と記録用 branch（`c915aa5e`、正式な再測定 s5r6 の記録は `a22080bd`）の git object だけです。コードは動かしていません。各主張には「確認済み」「推測」「未確認」を付けました。反証の検証で誤りとされた点は、正しい内容に直してあります。

## 1. 結論

1. **CP-4 の受入れ条件には品質が入っています。しかし s5r6 の S6／S7 が判定したのは可用性（表示の欠落、trace の失効）だけです。** 品質を判定する段は、今は実質まだありません。
2. 受領書の `recorded` は「この run は有効で、判定に使える」という印です。品質に合格したという意味ではありません。
3. Raw と Graph について言えること。
   - 設計した Gold では、Raw が返さない Gold 3 の Scene を Graph が末尾に 1 件足せます。5 つの case で、受領書の Scene ID の列まで確認できました。
   - 言えないこと。実原稿で Graph が Raw や IR より良いか。1 件の枠を IR と Graph のどちらに使うべきか。
4. IR と Graph で枠を共通にした技術的な理由は、読んだ文書のどこにも書かれていません。ユーザーが個別に確認した記録も、見つかりませんでした。
5. 枠を見直すなら、CP-4 とは別 lane で新しい測定が要ります。

## 2. 今のルールとその根拠

### 2.1 今のルール

- **表示は最大 8 件です。**
- **Raw の行は順位・score・excerpt をすべて保ちます。**
- **足せるのは、Raw にない Scene を最大 1 件、末尾にだけです。**
- **IR と Graph は、この 1 枠を取り合います。**
  - IR が枠を使うと、Graph は新しい Scene を足せません。
  - Raw が 8 件のときも足せません。
  - 枠を使わずにできるのは、すでに表示中の行へ path を付けることだけです。
- 訂正が 1 点あります。IR が枠を使うのは、IR だけにある Scene を足したときだけです。Raw と共有する Scene に IR 情報を添えるだけなら、枠は閉じません。

根拠（確認済み）。

- `policies/narrative/nir1-related-scenes-ranking.json`：融合 ID `raw-stable-one-supplement/1`、`maxScenes` 8、`maxAdditionalScenes` 1。
- `nir1RelatedScenesFusion.ts:56-57`：IR は `find` で 1 件だけ足します。
- `nir1GraphFusion.ts:78-90`：Graph の枠が開く条件を判定する `slotOpen`。
- Native 側は `graph_response.rs:105-130`。

### 2.2 いつ、誰が、なぜ決めたか

| 項目 | いつ・誰が | 理由の記述 | 根拠 |
|---|---|---|---|
| 上限 8 | 2026-06-19、NIR-1 より前の関連シーンパネルの PR #120 が `RELATED_SCENES_MAX=8` として導入。誰の判断かは未確認 | **ない**（設計書は「最大 8 件」とだけ書く）。後の融合ルールはこれを継承した | `f4d42f22`、設計書 :37、確認済み |
| 「Raw 保持＋末尾に最大 1 件」 | 融合 ID と内容は、先に A5 比較 1（採用不可）に出た。2026-09-08 にユーザーが A5 候補 2 を承認（見直しの承認 10:05 UTC、実装と検証の承認 10:53 UTC） | 数値の根拠は 2 つだけ。ひとつは固定 24 件で nDCG が 0.892→0.942 になったこと。もうひとつは「Raw の末尾へ追加する方式は nDCG 非回帰を満たしやすい」という一文。**「1 件」「8 件未満」が最適だと示す比較はない** | `nir1-a5-candidate-2.md`、`nir1-l5-quality-hold.md`、`ranking-candidate-v2.json`（`approvedAt` 2026-09-08T10:53:16Z）。承認の逐語は repo 外の `ledger.json` にあり、未確認 |
| **IR と Graph で共通の 1 枠** | 初出は 2026-09-12 の PR #571（L6-L9 実行計画）の 1 文「IR補完がない共通追加1件枠だけを利用する」。エージェントが起案した計画文書 | **ない**。Graph の精度は測っていない | `6dcd8e5b`、post-B 計画 :215、確認済み |

共通枠の位置づけ（確認済み）。

- 契約別の確認台帳に、枠の共有や個数の行はありません。
- K2/4（2026-10-17 確認）が共通枠の条件を「変えないもの」と引いています。確認を求めた対象は、作者の本文宣言と Scene Scope v2 の 2 行だけです。
- したがって共通枠は、承認済みの候補 2 の 1 件を、計画文書の前提として後続の契約が引用している状態です。
- 「IR の慎重さを Graph にもそのまま当てたのだろう」というのは**推測**です。記録には、Graph の枠を IR と分ける検討をした形跡がありません。

### 2.3 候補 2 についての補足（検証で直した点）

- 「RRF をやめた直接の原因は固定 24 件の品質 Hold」とは言い切れません。
  - 数値は正しいです（nDCG は Raw 0.891998、Raw+IR 0.888629。IR 改善 case は 0 件）。
  - ただし日本語の ja-01〜03 は、IR floor との組合せで IR が空になっていました。融合だけが原因ではありません。
  - 比較 1 では IR floor も同時に動いています（ja 0.850→0.848）。
- 「候補 2 が融合を導入した」という説明も正確ではありません。
  - 候補 2 は比較 1 の融合をそのまま保ち、ja の floor を 0.813 にしました。その結果、固定 24 件で改善 2 件が出ました。
  - 比較 1 は同じ融合を使っても採用不可でした。Raw 末尾追加の効果と floor の効果を分けた比較はありません。

## 3. Raw と Graph を比べる材料

### 3.1 CP-4 の品質判定の所在

| 確認事項 | 結果 | 根拠 |
|---|---|---|
| 品質は CP-4 の受入れ条件か | **はい** | post-B §7.3（:221、:225）、K6/2（`nir1-final-request-eval-proposal-2-draft.md`:620）、K6/4（`proposal-4-draft.md`:167-171） |
| K6/4 は条件を変えたか | 品質の条件は変えず、測る対象だけを「表示された sample の表示の結果」に替えた。P の 65.04 ms と IR の timeoutRate も変えない | `proposal-4-draft.md`:210 |
| 品質を計算するコードはあるか | あるが、本番の経路から呼ばれていない | 下記 |
| s5r6 の S6／S7 は品質を判定したか | **していない**。可用性だけ（pool の欠落 0/270、編集 trace の失効 0/201、窓外 1/201 など） | `s6-aggregate.mjs`、S7 §1 |

品質を計算するコードの状況（確認済み）。

- `summarizeVariantQuality`（`outcome.mjs:441-470`）が見るのは「表示の一貫性」です。nDCG、Recall、Evidence の妥当性は計算しません。
  - 返り値は 5 種です（measurable、fallback-measured、hold、fail、invalid）。
  - `finalSceneIds` を返すのは measurable と fallback-measured だけです。
  - K6/2 の regime では「窓内」基準、K6/4 の regime では「表示」基準になります。
- `resolveCp4VariantOutcome`、`compareExistingQueryGraphArm`、`decideCp4Availability` には、テスト以外の呼び出し元がありません。`comparisonPassed` を作るコードもありません（master と `cbf33077` で同じ）。
- 正式な Gold の経路は `summarizeVariantQuality` を呼びません。呼ぶのは `k64-runner.mjs:288-304` の dev 限定の分岐だけです。
- 受領書の `recorded` を返す `receipt.mjs:578-596` のコメントは「A run receipt never decides CP-4」です。

注意点がもうひとつあります。S6 の `ssc.rows` では、9 variant で `qualityHold: true` が出ています。これは K6/2 の「窓内 0 件」の読みで、`availability.mjs:296` が定義しています（確認済み）。K6/4 の読みでは、表示された sample が 30 件ずつあるので HOLD に当たりません。この違いを S6 の README は説明していません。読み手が HOLD と読み違える恐れがあります。

### 3.2 Gold（G-01〜G-08）で分かること

fixture の期待値と、s5r6 の受領書から復元した最終列（child の `finalSceneIds`）を、Scene ID の集合（membership）で照合しました。12 variant と G-01 で一致しています（確認済み）。順序は見ていません。

| case | 枠の区分 | Graph が末尾に足した Scene（Gold の等級） | 期待値（Recall@8） |
|---|---|---|---|
| G-01 | 補完可能 | g01-mira（3） | R 0／R+IR 0／R+IR+Graph 1、nDCG 0.6309。fixture は `evals/nir1-g01/fixture.v1.json` にあり、`evals/nir1-graph/` ではない |
| G-02 | 補完可能 | g02-tamsin-first（3） | 0／0／1、nDCG 0.5 |
| G-03 | Raw 満杯 | なし。path 付加が 2 件（c1・c2） | 全 arm 0。足せなかった候補 g03-hollis-ward（3） |
| G-04（現行は v2） | 補完可能 | g04-lio-landing（3） | 0／0／**0.5**（nDCG 0.4966）。lio-market（2）はどの arm も拾わない |
| G-05 | IR 補完済み | **なし**。IR が xan-watch（3）を足し、Graph は足せない | R+IR も R+IR+Graph も 0.5。足せなかった候補 g05-pia-ridge（2、`ir-supplement-used`） |
| G-06 | Raw 満杯 | なし。path 付加 2 件 | 全 arm 0。足せなかった候補 g06-bram-galley（3） |
| G-07 | 補完可能 | g07-pell-dock（3） | 0／0／1、nDCG 0.5 |
| G-08 | 補完可能 | g08-cass-attic（3）。base-usable と graph-recovered | 0／0／1、nDCG 0.5 |

読み取れること。

- **Gold は Graph に有利に作ってあります。** Raw は質問文を写しただけの control で、答えの Scene は Raw の語彙から離して作ってあります（G-03／G-06 は 8 件の decoy）。「Graph が Raw を上回る」のは設計した差で、実測した優位ではありません。作者の評価も未測定です（`authorValue: not-measured`）。
- **枠の衝突を測った case は G-05 だけです。** 結果は IR を優先して Graph を落とすものでした。これは規則（IR 優先）の帰結で、優先順位を比べた測定ではありません。
- G-04 は v1 の観測後に v2 へ作り直しました。IR が補う群は G-05 の 1 件だけに依拠しています。
- G-04 v1 では g04-lio-landing を IR が足し、Graph は足しません。「Graph にしか拾えない」のは v2 だけの性質です。
- 順序を事前宣言しているのは、control が 1 件の G-04 v2 と G-05 だけです。ほかは membership だけです。受領書から nDCG を再計算するときは、この点に注意が要ります（推測）。

### 3.3 あるもの・足りないもの

| あるもの | 足りないもの |
|---|---|
| 設計した Gold 8 case の期待値（arm ごと）。確認済み | Raw が実際に答えを返す case での比較 |
| s5r6 の受領書から復元できる R／R+IR／R+IR+Graph の Scene ID 列（親 sample と child）。確認済み | 受領書に順位・score・抜粋・path の hop や node、Recall／nDCG はない。復元は Scene ID の列まで |
| 固定 24 件での Raw と IR の比較。Recall 0.9097 / nDCG 0.8920（Raw）、候補 2 は 0.9653 / 0.9421。確認済み | 24 件には Graph が入らない（R+IR+Graph＝R+IR と宣言済み） |
| 診断の負例 N2／N3／N4 は 3 つとも measured・valid・established（g01-mira が返らなかった）。確認済み | 負例は G-01/v1 だけが対象で、case の判定には数えない |
| 枠の衝突を測った case（G-05） | 1 件しかない。IR と Graph が同じ Scene を狙う case はほかにない |
| IR の precision の材料（A5 holdout：ja 0.264／en 0.476） | **Graph の precision の測定は見つからなかった**。実 Raw・実 IR・実 Graph を同じ query で測った組もない |
| | Raw が 8 件満杯になる実際の割合、IR が枠を使う割合、Graph の適格な候補が枠の閉鎖で捨てられる割合（Native は候補の有無を区別させない設計） |
| | Evidence の妥当性 100%、禁止寄与 0、P（Hybrid p95 ≤ 65.04 ms）を判定する値。s5r6 の run には 24 件の比較も P の計測もない |

補足。

- ご質問の 0.769 と 0.667 は、Raw と IR の比較でも Graph の値でもありません。A5 比較 1 の「IR の floor を超えた pair」の precision です（校正・英語 0.769、holdout・英語 0.667）。比較 1 は採用不可で、比較 2（候補 2）に置き換わっています（`nir1-l5-quality-hold.md`:117-125）。
- 試験の言う「Graph の seed は Raw や IR の結果から来る」という前提は誤りです。seed は query Scene 自身の最初の pin（`created_at`、`entry_id` の順）で、Raw／IR とは無関係です。Raw／IR に縛られるのは次の 2 点です。
  - path を付けられる行が、表示中の R／R+IR だけであること。
  - Graph だけの Scene が、共通枠が空くときしか足せないこと。
- Graph 側にも、枠とは別の上限があります（確認済み）。
  - pin がなければ Graph はありません。
  - seed 自身の pin は寄与しません。
  - 候補は最大 8 件です。
  - 順序は、hop 数、edge ID、Entity ID の機械的な順です。意味的な関連度でも、読書順でも、新しさでもありません。
  - 本文を開示できるのは、作者の本文宣言がある Scene だけです。
  - 枠を増やしても、足せる Scene はこの上限で頭打ちになります。
- Graph の答えが first-render より後に着くのは、現行の測定条件・実装での結果です。
  - Gold の 13 variant は全 sample が窓外でした。
  - 構造的な保証ではありません。D（10.84 ms）以内に着けば first-render に合流します。
  - 表示の欠落を測る 9 variant では、first-render 0、follow-up 30／30 でした。残る 4 variant（G-03 frontier-exceeded、G-08 の unusable 3 種）にはその記録がありません。

## 4. 見直しの案の比較

案 A〜D は、枠の規則そのものを変える案です。案 E〜G は、調査中に実物から見つかった周辺の案です。どの案も、閾値・Gold・新しい契約や authority に触れるので、AGENTS.md の委任の外です。ユーザーの確認が要ります。

先に共通の注意を挙げます（確認済み）。

- 枠の規則は 4 か所に固定されています。
  - renderer の融合（`nir1RelatedScenesFusion.ts` の `find`、`nir1GraphFusion.ts` の `slotOpen`）。
  - Native の compose と `AppendSlot`（真偽値）。
  - IPC の wire（`graphOnly` が単数）。
  - policy JSON。
- policy の数値だけを 2 にしても動きません。`maxAdditionalScenes` は件数として使われず、真偽判定です。
- 次の検査が `==1` を見ているので、policy を変えると落ちます。
  - Native の `ranking_policy.rs:47`
  - `contract.mjs` の `GRAPH_RULES`
  - `candidate-policy.mjs` の完全一致
  - `observation-prep.mjs:3687`
  - `ranking-candidate-v2.json` の hash
- 凍結済みの G-03／G-05／G-06 は、枠の規則で「足せない」候補を期待値に持ちます。枠を広げる案はこの期待値を変えます。G-case の新しい版と独立な期待値レビューが要ります。

| 案 | 変える場所 | 動く評価と再測定 | ユーザーの確認が要るもの | 危険 | 判断に要る測定 |
|---|---|---|---|---|---|
| **D：今のまま。path の付加の表示だけ強める** | renderer の表示だけ（`Nir1GraphPathEvidence.tsx` など）。wire・policy は不変 | 24 件・G-case の指標は動かない。表示コストの確認だけ | UI の変更だけなら不要。並べ替えや件数の示唆を足すと C や MD9 に触れる | 小さい。path のある行を上に出す並べ替えは C と同じ | 実利用で path が付く行の割合。重ならなければ効果は小さい |
| **A1：Graph 専用の枠を 1 件足す（合計 8 以内）** | policy に Graph 用の項、Native の `AppendSlot` と compose、renderer の `slotOpen`、`GRAPH_RULES`、完全一致の検査、hash。wire は単数のまま使える（推測） | G-05 が動く（pia-ridge 追加で Recall 0.5→1.0 の見込み。算術による**推測**）。補完可能 case（G-01、02、04、07、08）と Raw 満杯 case（G-03、06）は変わらない。24 件は IR 側が変わらず軽い | ranking policy の変更（候補 2 の承認の差分）。G-case の期待値の変更。共通枠の前提の読み替え | IR 1 件と Graph 1 件が末尾に並び、Raw の外か分かりにくい。Graph の 1 件は ID 順で選ばれる | IR が枠を使った query のうち Graph の適格な候補があった割合と、その precision |
| **A2：同上で 8 を超える** | A1 に加え、`RELATED_SCENES_MAX`、begin の `denseHits`／`rawSceneIds`（DR-CP3A-16）の ≤8 検査、UI の件数 | G-03／G-06 の期待値も動く。L0 の再測定も要る | A1 に加え、表示件数の変更 | UI と検査の波及が大きい | A1 と同じ |
| **B：共通枠を 2〜3 件に増やす** | IR 側 `find`→複数。Native の supplement を複数に。`AppendSlot` を件数に。枠だけ 2 にするなら wire は単数のままでよい。Graph-only を複数返すなら wire を配列に、click registry も複数に | 24 件の再比較（nDCG 非回帰は末尾追加なら保たれやすいが、無関係 Scene の追加 0 は保証されない）。G-03／G-06 以外の期待値が動き得る | policy、期待値、（複数返すなら）wire の契約。資源の閾値を緩めるなら委任の外 | IR の誤りが 2〜3 倍に出る。holdout では ja の誤取得が多く、返却 1 件の precision でも 0.75。Graph は ID 順で同じ Entity の複数 Scene の順が任意 | IR と Graph それぞれの 2 件目・3 件目の precision |
| **C：Raw の下位を押し出す** | 融合の根本（Raw 全件保持の前提）。融合 ID の新設、compose の検査、Graph の確信度の定義 | L0 の非回帰が構造的でなくなり、24 件の Raw 基準と B／D／T の再測定が要る。G-03／G-05／G-06 の期待値が全部変わる | Graph の確信度の新しい契約（現行は二値で、順位は hop 数→edge ID だけ）。post-B §7.2「押し出さない」の撤回。閾値や Gold の変更 | Graph に比較できる確信度がない。follow-up の再描画で、利用者が見た Raw の行が後から消える | Raw の rank 6〜8 の実際の Gold 率（失う側）と、押し出す側の precision |
| **E：Raw の dense pool（30 件）から Graph で昇格** | begin が返す `denseHits` と `rawSceneIds` の検査（DR-CP3A-16）。昇格を決める新しい wire | 昇格は枠の増加か押し出しになるので B か C と同じ | B か C と同じ。renderer が候補の有無を知ると MD9 に反するので、Native が pool との交差だけを返す設計が要る | Raw の抜粋が出せ、Graph-only の本文宣言は要らない。ただし設計次第で契約に触れる | Graph の到達 Scene が pool の何位にいるか（データなし、未確認） |
| **F：Graph を別セクションに出す** | 融合 8 件には触れず、同じパネル内に自前の上限を持つ欄を置く | Raw の非回帰は保たれる。枠の奪い合いがなくなる | post-B §7.2「新しい探索パネルは作らない」に当たるかは解釈が要る（未確認）。複数件の本文開示は B と同じ契約と資源の変更 | 同じパネル内でも別の欄を足すと、利用者の見え方が変わる | 別欄の効果は実利用での Graph 候補の質次第 |
| **G：Graph の到達範囲を広げる（枠の外）** | seed の選び方、候補の選択順（Scene ID 順）、複数 seed など | G-case と K1 の値が動く | K1 の値と規則は「変えないもの」。変更は新しい契約。pin の自動化は別 lane の論点 | 枠を広げる前に、候補の質を見直す余地がある | Graph 候補の precision |

### Graph-only を 2 件以上出す案（B の複数返却、A2 など）の資源と契約

検証で数値を直しました。

| 項目 | 検証で確認した実際の値 | 旧記述（誤って引かれていた値） |
|---|---|---|
| `GraphOnlyBudget` の SQLite VM steps | 600,000（`nir1_graph.rs:97`） | 100,000 |
| deadline | 500 ms（`graph_response.rs:53`） | |
| 結果 lease、512／513 | lease 100 ms は変えない値として残る。read／admission は 2,048 に改訂済み | 旧記述は C-query の旧数値 |

- Graph-only の走査は「本文を読まない判定を最初に通った 1 件」で止まります。
- その後の本文照合に失敗しても、次の候補は試さず、追加なしになります（`body.rs:246-260`）。
- wire の応答形は `ipcContract.ts` ではなく `relatedScenesSearchWire.ts:238` にあります。

### 本文開示まわりの前提（案 B・E・F に関わる）

- Graph だけの Scene の本文を出せるのは、作者の本文宣言（K2/4 Option B、新規契約）がある場合だけです。
- Native は、適格な候補があったかどうかを区別できないようにしています（DR-CB4-3、DR-CP3B-13、Mandatory defense 9）。
- したがって、現行の契約では「ほかにも Graph の候補があります」と示す UI は作れません。契約を改訂すれば作れます。
- Graph-only の表示自体は、defense 10 により、PUB-G までは製品で閉じています。

### 並べ方（推測）

D はいますぐ可能です。次に A1 が最小の差分です。C は新しい契約が要るので最後にします。E と F は設計次第で契約に触れます。

## 5. 次の一手の提案

最小の形は 2 段です。

1. **既存の受領書から offline で再計算する（新しい run は不要、コスト小）。**
   - s5r6 の Gold 受領書の Scene ID 列を、setup 受領書の ID 対応と凍結 fixture の等級に突き合わせます。
   - 出力は case ごとの Recall@8 と、membership ベースの nDCG@8 です。
   - 目的は、品質の判定を CP-4 のどの段が持つかを具体的に決める材料を作ることです。
   - ただし Gold は Graph に有利に設計してあるので、この結果は「Graph が実原稿で良い」ことの証拠にはなりません。
   - Evidence の妥当性 100%、禁止寄与 0、P は、受領書からは出せません。別の測定か集計が要ります。
2. **枠の見直しの判断には、実データでの別 lane の測定が要ります。**
   - 次の 3 つを、小さな評価専用の入口で測ります。
     - Raw が 8 件満杯になる割合。
     - IR が枠を使う割合。
     - Graph の適格な候補の有無と、その候補の人手ラベルによる precision。
   - Native は候補の有無を区別させない設計です。評価専用の入口を作ることは、新しい契約や authority に当たりえます。ユーザーの確認が要ります（推測）。
   - 枠を 1／2／3 件と変えた arm を並べる比較は、融合方針・評価基準・Gold が動きます。CP-4 の測定の後に別 lane で議論する、という記録（`idea-fusion-slot-raw-bias.md`）と整合します。
   - 枠を変える前に、まず新しい Gold の版を事前に固定する必要があります（観測後に Gold を変えない規則）。

ユーザーに決めてほしいのは次の点です。

- 品質の判定の段を、CP-4 の中に置くか、PUB-G の前に別に置くか。
- 共通枠の前提を、このまま引き継ぐか。

## 6. 確かめられなかったこと・食い違い

### 6.1 食い違い（どちらを採ったか）

| 食い違い | 採った内容 |
|---|---|
| 受領書には Raw の ID しかなく Graph が足した Scene の記録は見つからない、という調査と、R／R+IR／R+IR+Graph の列を復元できる、という調査 | 後者が正しい（独立に再計算して確認済み）。ただし順位・score・nDCG はない |
| MEMORY の「N2／N4 は blocked」 | s5r6 では N2／N3／N4 すべて measured。MEMORY の記録は s5r5 以前のもの |
| G-01 は `evals/nir1-graph/` にある、と扱った調査 | 正しくは `evals/nir1-g01/fixture.v1.json`。`variants` を持たず、`arms.sceneIds` や `orderPredeclared` もない |
| G-04 の Graph 期待値 Recall 1 | 現行 v2 は 0.5 |
| 融合の資源の数値 100,000 steps など | 600,000 steps、deadline 500 ms |
| 「defense 8、9」を非区別の根拠とした調査 | 非区別は defense 9 と DR-CB4-3。defense 8 は資源上限 |
| 「満たされる」とした非回帰 | 文書の表現は「満たしやすい」で、対象は IR の候補。Graph の保証は post-B §7.2 と G-case の不変条件 |

### 6.2 未確認

- 2026-09-08 の承認の逐語（`ledger.json`、repo 外）。承認文が「最大 1 件」「8 件未満」を個別に挙げていたかは分かりません。
- 共通枠をユーザーが口頭で承認したか。2026-09-25／26 の Codex 承認（不採用）に枠が含まれていたか。
- S6 の `s6-aggregate.mjs` が handoff の写しと一致するか。この checkout では handoff を見つけられず、diff を確かめられませんでした。
- 凍結 fixture の等級と、macro 非回帰の具体的な集計方法。Evidence 100% の判定手順（どの記録の何を見るか）。
- P の統合後の測定が、別の run として計画・実施されているか。
- 品質判定を後段に回したのが意図的な設計かどうか。S7 は「規則が指す先」を可用性だけで述べています。
- CP-4 の S2 や contracts 側の pin が、枠の値や slotClass を hash で束縛するか。
- trace-browsing／trace-editing が品質の指標を持つか（構造は見たが精読していない）。「Raw と Graph の品質比較には使わない」は構造からの推定です。
- `nir1-l5-acceptance.md` と、候補 2 の製品採用の最終判断。`nir1RelatedScenesFusion.ts` 以外の融合実装。
- post-B §7.2 の「新しい探索パネルは作らない」が、同じパネル内の Graph 専用欄（案 F）を禁じるか。
- JA sparse lane が進むと Raw の基準が動くので、L0 をいつ固定するか。

### 6.3 推測として扱ったもの

- 共通枠の設計判断が「IR の慎重さをそのまま当てた」ものだという読み。
- A1 での G-05 の改善見込み（fixture の Gold 値からの算術で、実行して確かめていない）。
- 案 B〜G の危険と必要な変更の範囲（実装は走らせていない）。
- 受領書から Recall／nDCG を計算できるという見込み（Scene ID の集合の照合までは確認済みで、数値の再計算はしていない）。

### 6.4 主な参照先

- 現行規則：`policies/narrative/nir1-related-scenes-ranking.json`、`src/features/related-scenes/nir1RelatedScenesFusion.ts`、`nir1GraphFusion.ts`、`electron/native/grimodex-node/src/related_scenes/graph_response.rs`、`ranking_policy.rs`
- 根拠：`docs/plans/nir1-l5-quality-hold.md`、`nir1-a5-candidate-2.md`、`nir1-post-b-execution-plan.md`、`nir1-l6-l9-execution-plan.md`（`6dcd8e5b`）、`nir1-final-request-eval-proposal-2-draft.md`／`-4-draft.md`
- 品質判定のコード：`scripts/quality/nir1-graph-eval/outcome.mjs`、`availability.mjs`、`receipt.mjs`、`k64-runner.mjs`
- Gold：`evals/nir1-graph/`、`evals/nir1-g01/fixture.v1.json`
- s5r6 の記録：`a22080bd` の `docs/plans/nir1-cp4-records/`（`gold-s5r6-1/`、`s6-aggregation-s5r6/`、`s7-report-s5r6/`）