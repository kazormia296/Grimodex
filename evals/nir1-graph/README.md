# NIR-1 C-product Graph case（G-01〜G-08）

状態: **観測前に固定済み**（独立期待値レビュー済み、[`freeze.v1.json`](freeze.v1.json) で固定）。fixture の作成からレビュー、freeze まで、Graph runtime は実行しておらず、その出力も読んでいない。

このディレクトリは、C-product の評価母集団 G-02〜G-08 の fixture、Gold、事前期待値、観測時の前提条件を固定する。
G-01 は [`evals/nir1-g01/fixture.v1.json`](../nir1-g01/fixture.v1.json) のまま変更しない。
case の class は [l6-l9 実行計画](../../docs/plans/nir1-l6-l9-execution-plan.md) の G-01〜G-08 表に従う。
各 fixture の `caseClass` は表の行をそのまま写し、validator が表と照合する。

## 固定母集団

補完区分は、l6-l9 L7 が実行前に求める「補完可能」「Raw満杯」「IR補完済み」の分類である。

- 補完可能：R+IR が 8 件未満で、IR が共通追加枠を使っていない。Graph は 1 件だけ末尾に追加できる。
- Raw満杯：R が 8 件ある。Graph は既存 Scene への path 付加だけを行う。
- IR補完済み：IR が共通追加枠を使った。Graph は既存 Scene への path 付加だけを行う。
- 後の二つでは、R+IR の membership、順位、excerpt を変えない。

| case | class                                        | 補完区分   | 主な正例                                       | 主な負例                                                         | fixture                                  |
| ---- | -------------------------------------------- | ---------- | ---------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| G-01 | 実在Entity seedの1-hop direct                | 補完可能   | 事前指定改善（`g01-mira` の追加）              | 名前だけの seed、未知 ID                                         | `evals/nir1-g01/fixture.v1.json`         |
| G-02 | directed Relationの向き                      | 補完可能   | 保存方向の `trained`、symmetric の両方向       | 逆向き edge、承認後に型を変えた edge                             | `g02-directed-relation.v1.json`          |
| G-03 | bounded 2-hop path                           | Raw満杯    | 1hop と 2hop の path 付加                      | 3hop、frontier 超過（発見 54 件）                                | `g03-bounded-two-hop.v1.json`            |
| G-04 | Scope exact／unknown                         | IR補完済み | 全軸 exact 一致                                | worldline 不一致、unresolved、unknown marker、character holder   | `g04-scope-exact-unknown.v1.json`        |
| G-05 | current Revision／Freshness                  | IR補完済み | 現行・承認済み・Fresh、再承認後の現行 Evidence | stale、旧 Revision だけの承認、却下、置換前 Revision の Evidence | `g05-current-revision-freshness.v1.json` |
| G-06 | Evidence anchor／path                        | Raw満杯    | Evidence 付きの 1hop／2hop path                | Revision のない Relation、名前だけの言及、同名の別 Entity        | `g06-evidence-anchor-path.v1.json`       |
| G-07 | strict reading-before-S2／reveal・secret境界 | 補完可能   | S2 より前の非秘密、S2 より前に開示済みの秘密   | S2 より後、S2 自身、未開示の秘密、開示先のない秘密               | `g07-reading-before-reveal.v1.json`      |
| G-08 | Graph Index unusable fallback                | 補完可能   | usable での追加と付加、再 build 後の回復       | 部分 Graph、旧 generation、Chronicle 停止時の Graph              | `g08-graph-index-fallback.v1.json`       |

`manifest.v1.json` は上の 8 件、比較 arm、runtime と比較する field、観測時の前提条件、既存 24 件の seed 方針、独立期待値レビューの状態を持つ。
`schema.v1.json` は G-02〜G-08 の形式を定める。

## fixture の読み方

- **corpus と setup**：`query`、`scenes`、`scope`、`entities`、`relations`、`pins`、`foreshadows`、`qualifiedIr`、`revisions`、`mutations`、`setupTimeline`。
  - ID はすべて logical ID である。通常 writer が発行した runtime ID は setup receipt で対応付け、Gold には書かない。
  - setup の順序は各 fixture の `measurementBoundary.setupOrder` に従う。最初の typed Revision を準備した後は、tree の順序、registry、Scene Scope を変えない。project の Scope authority が変わると、全材料の束縛が古くなるためである。
  - `setupTimeline` の最初の step より前に、maintenance を実設定で有効にする。製品の既定は `maintenance_enabled=0` で、このままでは測定点に届かない（SPIKE S1 §5）。SQL や状態の注入では有効にしない。
  - `setupTimeline` は Revision と Decision、mutation、`qualified-ir`（IR の作成）を 1 本の順序に並べる。IR は、G-08 以外では Graph 側の mutation がすべて終わった後に作る。G-08 では、unusable 状態を測るため、IR の後に mutation を置く。
- **`variants`**：測る状態ごとの期待値。
  - `measurementPoint` は測定の時点で、通常は maintenance が最新の sealed generation を公開した後とする。G-08 の unusable 状態は、宣言した mutation の commit 後、再 build の前に測る。
  - `preconditions` は、その variant を測るための観測時の前提条件である（「観測時の前提条件と blocked」を参照）。
- **`expectations.arms`**：R、R+IR、R+IR+Graph の Scene 列。
  - control が 1 件なら順序まで事前に宣言する。2 件や 8 件なら membership だけを宣言する。
  - 順序を宣言しない arm の要素はすべて Gold 0 なので、指標は順序に依存しない。
  - R+IR+Graph は、同じ run で観測した R+IR を、その kind（raw／fused）にかかわらずそのまま先頭に置く。
  - `rPlusIr.resultKind` は作成時の設計予測で、記録だけする。
- **`expectations.graph`**：Graph DTO の nodes（hop 付き）と edges。資格を得た Revision と除外の理由は、規則から導いた説明として添える。
- **Scene 側の期待値**：`pathAttachments`（既存 Scene への path）、`addedScene`（追加する 1 件と excerpt）、`blockedCandidates`（枠の規則で追加しない Scene）、`scenesWithoutPath`、`forbiddenSceneIds`。
- **`evidence`**：path Evidence の必須要素。
  - 必須要素：Relation 正本、Entity の名前／要約の exact UTF-16 範囲、Revision／Decision の束縛、明示 pin。
  - 加えて、既存 Raw excerpt を変えないことと、追加 Scene の本文 anchor を求める。
  - case ごとの assertion も持つ。
- **`metrics`**：既存の `scoreQuery` と同じ Recall@8／nDCG@8。validator が再計算する。

runtime ID の順序（edge ID、Entity ID、Scene ID）は fixture を固定する時点では分からない。このため、期待値が ID の順序に依存しないように設計した。

- 補完可能な case では、追加候補を最小 hop で 1 件にする。
- 既存 Scene に付ける path は、Scene ごとに 1 本にする。
- validator はこの二つが崩れた fixture を拒否する。

### runtime と比較する field

機械可読の正本は `manifest.v1.json` の `runtimeComparison` である。validator は、この分類が schema の expectation field を過不足なく覆うことを検査する。

- **比較する**：
  - 各 arm の Scene 列。`orderPredeclared` が true のときだけ順序も比べ、それ以外は membership を比べる。
  - `rPlusIr.irSupplementSceneId`、R+IR+Graph の `baseline` と `appendedSceneId`。
  - `graph.status`、`graph.nodes`（hop 付き）、`graph.edgeIds`。
  - `pathAttachments`、`addedScene`、`blockedCandidates` の Scene と Entity、`scenesWithoutPath`、`forbiddenSceneIds`、`evidence`、`metrics`。
- **記録だけで比較しない**：
  - 対象は `rPlusIr.resultKind`、`graph.reasonClass`、`graph.qualifiedRevisionIds`、`excludedRevisions`／`excludedEdges`／`excludedEntities`、`graph.frontier`、`blockedCandidates[].reason` である。
  - これらは規則から導いた説明か、作成時の設計予測である。runtime は別の区分を返しうる（例：`stale-after-approval` ではなく superseded）。上限で止まる runtime は、規則から導いた発見数を返さない。
  - 違っても Hold の理由にしない。
- **`graph.reasonClass`**：
  - runtime の reason allowlist は CP-1 が決める（DSN §1.5 の表は案）。観測前に対応表を固定できないので、`graph.status` だけを比較する。
  - unavailable の原因は二つの方法で確かめる。G-08 では前提条件 `index-state-holding` で確かめる。G-03 では、`g03-r-frontier` の有無だけが違う 2 variant を比べる。
  - runtime の reason は記録する。

## 観測時の前提条件と blocked

各 variant の `preconditions` は、その variant に当てはまる前提条件を過不足なく並べる。validator が fixture から必要な集合を導いて照合する。
前提条件は次の 6 種だけで、定義は `manifest.v1.json` の `preconditions` にある。

| id                        | 範囲        | 当てはまる variant                                                            | 確かめること                                                                                                                                                                                                                                                         |
| ------------------------- | ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b-sealed-binding`        | variant     | 全 variant                                                                    | B の sealed generation を、製品が所有する B build 経路で確立した。経路は B-ROUTE の maintenance entry（試験と journey 用の起動経路から起動してよい）か CP-2a の owner である。test 専用や診断用の publisher、SQL、注入は使わない。a153743b にこの経路は無い（S1 §5） |
| `maintenance-enabled`     | variant     | 全 variant                                                                    | maintenance を実設定で有効にし、宣言した setup の後の sealed generation に到達した。unusable の variant では、mutation の commit より前に到達した                                                                                                                    |
| `raw-membership`          | variant     | 全 variant                                                                    | 観測した R が `arms.raw` と一致する。補完可能は control 2 件、Raw満杯は control ちょうど 8 件、IR補完済みは control 1 件                                                                                                                                             |
| `ir-supplement-admission` | variant     | G-04、G-05                                                                    | ir-only Scene の IR が IR floor 以上で admission され、R+IR が R の後にその Scene を置く                                                                                                                                                                             |
| `index-state-holding`     | variant     | G-08 の unusable 3 variant                                                    | mutation の commit 後、query の時点で、canonical usability probe が宣言どおりの Index 状態を示す。通常の writer と lifecycle 制御だけで保つ                                                                                                                          |
| `cb4-inputs`              | added-scene | 追加 1 件を持つ variant（G-02、G-07、G-08 の base-usable と graph-recovered） | fixture は POV と story time を設定しない。CB-4 がそれらを要求せずに追加 Scene を判定できる                                                                                                                                                                          |

- 範囲が variant の前提条件が成り立たなければ、その variant を `blocked:<id>` と記録する。
  - 複数が成り立たなければ、定義順で最初の id を名前にし、全部を記録する。
  - 期待値は評価しない。macro 集計（非回帰、path Evidence の妥当性、禁止寄与の分母）から除き、PASS に数えない。
- `cb4-inputs` が成り立たなければ、追加 1 件の部分期待値だけを `blocked:cb4-inputs` とする。
  - 評価しないのは `addedScene`、`appendedSceneId`、R+IR+Graph の末尾の 1 件、`added-scene-body-anchor`、R+IR+Graph の指標である。
  - Graph DTO、path 付加、R と R+IR は比較する。R+IR+Graph は、観測した R+IR と同じで、ほかの Scene を含まないことを確かめる。
- Hold と blocked は区別する。
  - Hold：製品を測ったうえで、比較する期待値と違った。正例の材料を setup で作れなかった場合も Hold とする。
  - blocked：宣言した測定条件が成り立たず、その先を測っていない。
- 前提条件は、観測の後に足さず、外さず、読み替えない。前提条件が成り立たなくても期待値は変えない。
  - variant が宣言していない前提条件で、観測結果を blocked にすることはできない。validator の `resolveVariantOutcome` がこれを拒否する。
  - blocked の variant を測るには、fixture の新しい版と独立期待値レビューが要る。
- 必須の項目（manifest の `comparison.required`）に当てはまる variant がすべて blocked なら、その項目は未検証であり、CP-4 は PASS にならない。
  - 特に、IR補完済み（G-04、G-05）の全 variant が `blocked:ir-supplement-admission` なら、l6-l9 L7 の「後二群は membership、順位、excerpt 不変」は未検証のままである（manifest の `irSupplementedCoverage`）。

## 期待値を導いた規則

validator（`scripts/quality/nir1-graph/contract.mjs`）は、fixture の宣言と次の規則だけから Graph 側の期待値を再計算し、宣言と一致することを確かめる。
Raw と IR の membership は入力（設計上の予測）として扱い、計算しない。観測時には前提条件として確かめる。

| 規則                            | 内容                                                                                                                                                                                                                                                                                                                                                           | 出典                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 承認                            | 資格を得るのは approved の Human Decision を持つ現行 Revision だけ。却下と Decision なしは除外する                                                                                                                                                                                                                                                             | l6-l9 typed-revision-material                                                                                                                                                           |
| Freshness                       | 承認後に Entity 要約や Relation 型が変わった Revision は stale として除外する。資格を戻すには、新しい Revision と新しい Decision が要る                                                                                                                                                                                                                        | 同上 Recovery、graph-limited-binding                                                                                                                                                    |
| reading                         | review Scene が S2 より厳密に前であること。S2 自身と S2 より後は除外する                                                                                                                                                                                                                                                                                       | 実装計画 A6、l6-l9 G-07                                                                                                                                                                 |
| Scope                           | marker は explicit であること。material 制約は any か、query identity と同じ exact だけを許す。unresolved と unknown は fail closed にする                                                                                                                                                                                                                     | l6-l9 L6 Profile 評価、scope-storage-authority、ADR009 §3・§6                                                                                                                           |
| holder／audience                | reader の参照用途では、holder と audience が reader であること                                                                                                                                                                                                                                                                                                 | 実装計画 A6、§4 threat model                                                                                                                                                            |
| secret／reveal                  | 伏線が secret でないか abandoned なら妨げない。secret で payoff Scene があれば、その Scene が S2 以前（S2 自身を含む）のとき開示済みとし、payoffConfirmed は問わない。payoff Scene がなければ payoffConfirmed のときだけ開示済みとする。fixture は story time を設定しないので、前後は reading 順で決まる                                                      | 製品の既存 reveal 規則 `read_a3_reveal_state`（`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_entity_relation.rs`）、実装計画 A6「秘密は既存reveal規則の範囲」、l6-l9 G-07 |
| 不適格 Revision                 | 上の規則で資格を得ない Revision は、その Revision だけを除外し、frontier に寄与させない。Graph 全体を unavailable にはしない。製品の Disclosure read が Revision ごとに Unavailable を返しても、その Revision の除外と読む                                                                                                                                     | l6-l9 L7（seed-local query は適格 frontier に接続する行だけを取得し、不適格行は read／admission を消費するだけ）                                                                        |
| 向き                            | directed は保存方向だけ、symmetric は両方向に辿る                                                                                                                                                                                                                                                                                                              | l6-l9 L7                                                                                                                                                                                |
| 範囲                            | 最大 2hop。不適格な edge や Entity を橋にしない                                                                                                                                                                                                                                                                                                                | l6-l9 L7、post-B §6.2                                                                                                                                                                   |
| 上限                            | 発見 Entity が 50、適格 edge 展開が 512 を超えたら、Graph 全体を unavailable にする。上位 50 件への切り詰めも部分 Graph とみなす                                                                                                                                                                                                                               | graph-limited-binding、post-B §6.2                                                                                                                                                      |
| 対応付け                        | 到達した非 seed Entity の明示 pin だけを Scene に対応付ける。名前の一致や本文中の言及は使わない                                                                                                                                                                                                                                                                | 接続候補 §1・§6                                                                                                                                                                         |
| frame と資格判定の順（K1 既定） | 到達 Entity（hop 1 以上）の pin を予算内で全件列挙し、Scene ごとに tuple 最小の path を代表にする。tuple＝（hop、traversal 順の edge ID 列、到達 Entity ID、Scene ID）を UTF-8 byte 順に並べ、先頭 8 件（N_F＝8）を parent に渡す。parent は先頭から資格を判定し、R+IR の Scene に path を付け、追加できるときは最初に Eligible になった Scene を 1 件追加する | DSN（`docs/plans/nir1-dsn-2026-10.md`）§2.2〜§2.3、接続候補 §6。K1 は逸脱案（N_F＞8）なしで確認済み                                                                                     |
| 融合                            | R+IR を保持する。追加は R+IR が 8 件未満で、IR が共通追加枠を使っていないときの 1 件だけ。excerpt は最初の非空行。「IR が共通追加枠を使っていない」とは IR 種別の行が無いことで、R+IR の kind（raw／fused）は問わない                                                                                                                                          | 接続候補 §2・§6、post-B §7.2、SPIKE S1 §5                                                                                                                                               |
| 可用性                          | Graph unusable なら R+IR、Chronicle unusable なら Graph も止めて exact R。混合集合は作らない                                                                                                                                                                                                                                                                   | 実装計画 A6 の表                                                                                                                                                                        |

実装計画 A2 表の「temporal constraints／secret」行（allowSecrets=false、secret は reveal 後も初回不可）は、Chronicle IR の query context の規則である。
A3 の Graph 材料には適用せず、上の secret／reveal 行（既存 reveal 規則）を使う。

K1 既定規則の適用範囲：

- 全 fixture で、到達 Entity の pin の総数は 8 以下である。この数には、不適格な Scene への pin も含める。
  - 内訳は G-02 が 2、G-03 が 3、G-04 が 2、G-05 が 2、G-06 が 3、G-07 が 2、G-08 が 1〜2 である。
- この数は frame に載る相異なる Scene の数の上限である。このため、N_F＝8 の切り詰めはどの期待値にも効かない。追加候補は最小 hop の 1 件で、tuple 順で最初の Eligible な Scene と一致する。
- validator はこの上限を検査する。
- DSN §2.5 が推奨する「両方の規則で結果が分かれる fixture」は含めない。K1 が逸脱案なしで確認されたためである。

## 解釈を要した点と独立期待値レビューの判断

1. **G-05 の「旧Epoch」**（採用）：「同じ material の置換前 Revision（旧 Source／承認 epoch）」として具体化した。
   - 要約を編集し、再承認した後も、置換前 Revision の Evidence（`copper`）が返らないことを求める。stale 規則から導け、R+IR を保ったまま測れる形である。
   - literal な semantic epoch の境界（restore、Scope authority の変更）は、全材料を同時に失効させる。このため G-01〜G-08 のどれも測らない（「対象外」を参照）。旧 generation の混入は G-08 で扱う。
2. **G-02 の「型不一致 edge」**（採用）：seed だけの query には型の条件がない。そこで承認後の Relation 型編集で、「承認済み material の型が現行 Relation の型と一致しない edge」を作った。
   - typed-revision-material の Source token 失効で、`g02-r-dace` は stale になる。
   - 通常 writer が承認済み Relation の型編集を拒否したら refused-at-setup とし、寄与 0 のままとする。
3. **G-03 の frontier 超過**（採用）：文書の「limit 超過は Graph 寄与 0」と「部分 Graph を返さない」から、Graph 全体の unavailable とした。
   - 製品の traversal も、上限に達すると切り詰めずに Err を返す（`nir1_graph.rs` の `NIR1_GRAPH_NODE_LIMIT`）。
   - 50 件の数え方（seed を含めるかどうか）に依存しないよう、発見数は 2（base）と 54（超過）にした。54 は上限 50 に 4 を足した値で、seed を含めても除いても 50 を超える。edge 展開は 54 で、上限 512 の内にある。
   - 54 は規則から導いた説明値で、runtime とは比較しない。製品は上限で止まるので、54 は観測されない。
   - 上限の値は proposal/7（`graph-limited-binding` の改訂。2026-10-17 の Session B2 で確認済み）による。以前の 12 件と 144 展開（発見 16 件）の期待値は置き換えた。
   - 上位 50 件に切り詰めて部分 Graph を返す実装が現れたら Hold とし、規則を観測後に読み替えない。
4. **G-07 の開示済み secret**（採用）：A6「秘密は既存reveal規則の範囲」の正本は `read_a3_reveal_state` である。validator の判定はこの規則（上の表の secret／reveal 行）に揃えた。
   - G-07 の 3 配置では、作成時の保守的な判定と結論が変わらない。Rhea は payoff が 30 で S2 より前かつ確定、Hask は payoff が 120 で S2 より後、Nim は payoff Scene がなく未確定である。
   - payoff が S2 自身、未確定の payoff Scene が S2 より前、payoff Scene なしで確定、abandoned の各分岐は、`contract.test.mjs` で検査する。
5. **G-04 の「未対応制約」**（条件付き採用）：l6-l9 G-04 の負例「未対応制約」は、`g04-rv-unresolved`（worldline の unresolved 制約）が担う。
   - character holder（`g04-rv-holder`、Mott だけが知る material）は、holder／audience の AND 条件の不一致で、追加の負例である。
   - fixture は変えない。
6. **Raw と IR の予測**（SPIKE S1 を受けて修正）：
   - R は、S2 を逐語で引用する control だけを返すと予測する。観測時には前提条件 `raw-membership` として確かめる。
   - control 以外の Scene は、S2 と Porter stem が重なる語を持たない。validator は FTS5 の porter tokenizer に合わせた保守的な検査を行う。dense の類似度は静的に検査できない。
   - IR は control に付くとは仮定しない。S1 では、G-01 の control IR が cosine 0.61294 で英語の IR floor 0.66 を下回り、R+IR は raw のままだった。
   - R+IR+Graph の基底には、観測した R+IR をその kind（raw／fused）にかかわらず用いる。このため `rPlusIr.resultKind` は記録だけで比較しない。CP-3a は、raw の基底でも Graph-only の追加を行う必要がある（manifest の `dependencies`）。
   - IR補完済みの case では、ir-only Scene の本文に無関係な描写を混ぜた。本文ではなく、資格付きの解釈だけが query に届く設計である。その IR の admission は前提条件 `ir-supplement-admission` で確かめ、成り立たなければ blocked とする（Hold ではない）。
7. **Gold**（採用）：「S2 時点で読者に開示されている情報で、答えの人物が登場する Scene」と定義する。G-01 の「到達人物が登場する以前の Scene」に揃えた。
   - 各 fixture の `goldDefinition` が case ごとの定義である。
   - pin だけの Scene、名前を口にするだけの Scene、問いを写しただけの control は、Gold 0 とする。
   - G-04 と G-05 の第二 Gold（2）は、答えの人物が登場する別の Scene である。IR が追加枠を使った後に Graph がその Scene を追加しないことを測る負例として働く。
8. **IR と Graph 側 mutation の独立**（採用）：IR 失効 writer 表（実装計画 §6）に Codex の編集は入っていない。ただし IR の recipe が Codex を入力に含むかは、fixture の段階では確定できない。そこで次のように設計した。
   - IR は、Graph 側の mutation の後に作る（G-08 を除く）。
   - G-08 では、IR の後に編集する Juno を、IR を持つ control に pin せず、IR の本文や要約でも名指ししない。validator がこの条件を検査する。
   - それでも Juno の編集で Chronicle Index が unusable になった場合は、宣言した Index 状態にならない。その variant は `blocked:index-state-holding` とする。
9. **K1 既定規則**（追加・採用）：「tuple の順で先頭 8 件 → 先頭から資格判定 → path の付加と追加 1 枠」で導いた。到達 Entity の pin 総数が 8 以下なので、DSN §2.5 の規則判別 fixture は含めない（上の「K1 既定規則の適用範囲」）。
10. **不適格 Revision**（追加・採用）：個別に除外し、Graph 全体を unavailable にしない（上の表の「不適格 Revision」行）。
11. **runtime と比較する field**（追加・採用）：「runtime と比較する field」の節と、manifest の `runtimeComparison` に固定した。

## 対象外（coverage gap）

- literal な semantic epoch の境界（restore、Scope authority の変更）は、G-01〜G-08 のどれも測らない。G-05 は 1 つの material の置換前 Revision を、G-08 は旧 generation の混入を測る。
- `graph.reasonClass` は status だけを比較する。runtime の reason との対応表は、CP-1 の後に fixture の新しい版で固定するまで比較しない。
- K1 既定規則と DSN §2.5 の逸脱案（N_F＞8）を判別する fixture はない。
- IR補完済みの区分は、前提条件 `ir-supplement-admission` に依存する。ir-only IR の admission を事前に確かめる model-only の cosine probe は行っていない（manifest の `irSupplementedCoverage.admissionProbe` は `not-run`）。

## 既存 24 件の seed 方針（宣言）

[`evals/nir1-retrieval/manifest.json`](../nir1-retrieval/manifest.json) の 24 件は、R+IR+Graph arm で manual seed を使わない。

- 24 件の corpus には Codex Entity、Relation、pin、typed Revision がない。このため Graph は not-requested であり、寄与は 0 である。
- R+IR+Graph は、R+IR と membership、順位、excerpt、Evidence が一致しなければならない。24 件で Graph の node、path、Scene が現れたら、禁止寄与とする。
- この 24 件では、Graph の品質、可用性、遅延を測らない。それらは G-01〜G-08 が担う。not-requested は unavailable に数えない。
- nir1-retrieval の manifest、corpus、freeze は変更しない。manifest の scope は「not Graph」のままとする。
- 機械可読の宣言は `manifest.v1.json` の `existingRetrievalSeedPolicy` にある。P harness の `graphSeedForExistingQuery` もこれを読む。

## R+IR+Graph arm（P harness）の扱い

`scripts/quality/nir1-retrieval/contract.mjs` に、R+IR+Graph arm の語彙と not-wired の足場を置いた。

- `paired.mjs` と `run-nir1-retrieval.mjs` は、arm を `unavailable`（`graph-runtime-not-wired`）として receipt に記録する。
- arm を測る指定（`--graph-arm` で `not-wired` 以外）は `[precheck]` で拒否する。
- この arm は PASS にならない。Graph 統合の再確認（`graphIntegratedRecheck`）は `hold` のままとする。
- 既存の raw／hybrid の測定、gate、閾値（B／D／T、65.04 ms）、receipt の status は変えない。

## 観測規則と失敗時の扱い

- 観測した後に、query、corpus、seed、Gold、順序、指標、fixture、前提条件を変えない。
- 比較する期待値と実 runtime の結果が違えば、その結果を保持して Hold にする。正例の材料を setup で作れない場合も Hold とする。
- 宣言した前提条件が成り立たなければ、その variant（`cb4-inputs` では追加 1 件だけ）を `blocked:<id>` と記録する。Hold でも PASS でもない。
- fixture の改版が必要になったら、失敗を残したまま別の版を提案し、独立期待値レビューと freeze をやり直す。
- 補完可能な case（G-02、G-07、G-08 の usable 状態）で Graph-only Scene を追加するには、target Scene 本文の開示（C-body）が要る。
  - C-body が Hold の間、これらの追加は返らず Hold になる。
  - C-body があっても、CB-4 が POV や story position を要求するなら、追加 1 件だけを `blocked:cb4-inputs` とする。
- 既存 Scene への path 付加と Graph DTO の nodes／edges は、C-body に依存しない。

## CP-0 で行わなかった作業

次の作業は CP-0 では行わず、後続へ移す。

- **R／R+IR baseline の測り直し**（計画 CP-0 節の 4 点目）：CP-4 の計測窓へ移す。
  - 静かな窓で、同じホストの R／R+IR baseline を測り直す。PR-P の receipt（`~/.codex/worktrees/nir1-p/.artifacts/`）を参照する。
  - 計測の窓は、S2 と P の計測とは分ける（SPIKE S1 §8）。
- **SPIKE S1 の harness の取り込み**：CP-4 へ移す。
  - S1 の報告は `/tmp/claude-1000/-home-grimodex-Grimodex/3754f9a7-620d-4e21-ad37-3096691a96be/scratchpad/spike/S1.md` にある。作業環境の一時領域で、repository には入っていない。
  - harness は spike worktree（branch `claude/nir1-spike`）の未追跡の `scripts/quality/nir1-g01/*` である。run に使った版は、同じ worktree の `.artifacts/s1/harness-frozen/` に凍結されている。
  - 取り込むときは S1 §8「CP-0 へ移すとき」に従う。clean な worktree で standard-build の受領書を取り直す。決定論 provider の対応表の置き場所を決める。pin 済み model の取得元（`MODEL_SOURCE_ROOT`）を引数にする。setup では model の download と spellchecker の辞書取得を止める。off-screen の guard を必須にし、X11 socket を隔離する。IPC trace を receipt に残し、run ごとに harness を凍結する。Graph arm と B の sealed binding の手順を加える。
- S1 §5 の「B の sealed binding を確立する製品経路が無い」は、CP-4 の前提である（B-ROUTE、前提条件 `b-sealed-binding`）。
- ir-only IR の model-only cosine probe は行っていない。
  - 行うかどうかは、integrator が observationPolicy の範囲で判断する。
  - 行って IR 要約を改版する場合は、fixture の改版として独立期待値レビューと freeze をやり直し、probe とその結果を freeze に記録する。

## 独立期待値レビューと freeze

- **レビューの担当**：fixture の作成者でも、要求された変更を反映した担当でもない、read-only の担当である。
  - 2 回とも、文書の規則と fixture から期待値を導き直した。一部の規則は製品コードで裏付けた。
  - 候補の worktree は編集していない。Graph runtime を実行しておらず、その出力（worker の frame、Graph 付きの Related Scenes の結果、`.artifacts` の Graph 出力）と CP-1 の worktree も読んでいない。
  - model と effort は freeze の記録にある。
- **1 回目**：changes-required。G-02、G-03、G-06、G-07、G-08 は approve で、G-04 と G-05 には IR admission を前提条件にすることを求めた。要求は 10 件である。
  - 記録は [`independent-expectation-review.v1.json`](independent-expectation-review.v1.json)（`nir1-graph-expectation-review/1`）にある。レビューした時点の各ファイルの sha256 も、同じ記録に残した。
  - 要求はすべて反映した。fixture の本体は変えず、変えたのは前提条件の field と `measurementBoundary` の文言だけである。
- **2 回目**：approve。G-02〜G-08 のすべてを approve とし、残る要求はない。
  - case ごとの判定と導出、解釈についての判断は、[`freeze.v1.json`](freeze.v1.json) の `independentExpectationReview` にレビューの結果のまま記録した。承認した時点の各ファイルの sha256 も同じところにある。
- **承認の後の変更**：期待値を持たない部分だけを変えた。
  - manifest は `independentExpectationReview` の欄だけで、判定を approve にし、2 回の経緯を書いた。
  - README は「CP-0 で行わなかった作業」とこの節だけである。
  - validator には、承認と freeze の整合の検査を足した。
  - fixture、`schema.v1.json`、1 回目のレビュー記録は、承認した時点の bytes のままである。
- **freeze**：[`freeze.v1.json`](freeze.v1.json)（`nir1-graph-freeze/1`）が次を束縛する。
  - manifest、G-01〜G-08 の fixture、`schema.v1.json`、この README の sha256。
  - 1 回目のレビュー記録とその sha256。2 回目（承認）の記録、承認した時点の sha256、承認の後に変えた範囲。
  - reviewer、`reviewVerdict`、`frozenAt`、`baselineHead`（a153743b）、IR admission probe の状態、`graphRuntimeObservedBeforeFreeze: false`。
- **validator の検査**：
  - freeze がある場合は、次を求める。
    - manifest の `status` が `frozen-after-independent-expectation-review` で、`independentExpectationReview` の `status` が `reviewed`、`verdict` が `approve` である。freeze の `reviewVerdict` もこれと一致する。
    - 最後の回が approve で、G-02〜G-08 をすべて approve とし、要求が残っていない。reviewer は作成者と別の read-only の担当で、Graph runtime の出力を観測していない。1 回目は、束縛したレビュー記録と判定が一致する。
    - fixture、schema、1 回目のレビュー記録が、承認した時点の sha256 と一致する。manifest と README は、宣言した範囲（manifest の key、README の節）を除くと、承認した時点と一致する。
    - 束縛した hash がすべて一致し、レビュー記録が存在する。
  - freeze がない場合は、manifest の `status` が `predeclared-awaiting-independent-expectation-review` のままであることを求める。
- 固定した後に、束縛したファイルのどれかを変えると hash が一致せず、`pnpm eval:fixtures` が失敗する。変える必要があれば、観測の前に限り、独立期待値レビューと freeze をやり直す。
- freeze の前に Graph runtime を観測した場合は、この版を固定済みとして扱わない。

## 検証

CI と同じ Node 22 で実行する。

```sh
pnpm eval:fixtures
node --test scripts/quality/nir1-graph/contract.test.mjs
node --test scripts/quality/nir1-retrieval/contract.test.mjs
```

`pnpm eval:fixtures` の出力の `nir1Graph` に、8 件の sha256、variant 数、freeze の状態が出る。
これらの検査は fixture の整合性を確かめるだけであり、runtime の成立、G-01 の PASS、Graph の公開を意味しない。
