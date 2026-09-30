# Chronicle: 北門基準状態の確定と未使用短文への展開計画

作成日: 2026-09-07（JST）。現在は、先行Gemini診断とLunaの部分実行を保存した上で、ユーザー承認によりHを含む4ケースの修正・再実行を進める。以下の当初計画と基準状態は履歴として保持し、最新の変更範囲は末尾に記す。北門の成功条件と7軸rubric本文は維持する。

北門one-caseは、ユーザーの確認により、**校正済みLLM judgeによる実APIの限定的な意味評価PASSとして工程完了**とする。同じ本文を通すためのrubric／Gold／評価契約の追加調整や、同条件の成功確認は行わない。

## 保持する成功基準

| 項目                    | 固定する値・結果                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 成功run                 | `336fcd7d-2013-49d7-929a-6ea691358860`                                                                                                                                                         |
| 評価ソースcommit        | `0c1bd2ea9913dfecd600985530f7a56c04f03943`                                                                                                                                                     |
| ハーネス保存commit      | `8eb02dbd1d67c41dd362c9f931fd6b09ae978566`                                                                                                                                                     |
| 隔離runtime             | HEAD `96473b56c3db879043ce879fc1e686d7f7061c9d` ＋ tracked diff SHA-256 `91cc5873c1244cb2434dc9b1e060aaff705817247cb5fd9e4746ba0554c2072c`。評価に関わる11ファイルは上記評価ソースcommitと同一 |
| 校正                    | 固定12対照、全期待projection一致、不一致0                                                                                                                                                      |
| 北門Observation         | 4 Gold／4 actual。7軸すべて4 match、不一致・不確定0                                                                                                                                            |
| 北門Temporal            | 対象2関係すべて一致                                                                                                                                                                            |
| モデル                  | observation・synthesis・judgeとも `openai/gpt-5.6-luna`                                                                                                                                        |
| 設定                    | 要求effort `max`、出力上限32768、1 POST上限300秒、応答2,000,000 byte。実効effortはprovider未報告                                                                                               |
| rubric                  | `chronicle-llm-judge-rubric/2`、digest `79691d1c4f35e5c511cd4bcba3f284cceecb6887cbffc0e482c86458b924f3e1`                                                                                      |
| 校正fixture SHA-256     | `a763b2c589a939b27f8679a379ba7f223c062b52d19c1a8eff3f469aec577510`                                                                                                                             |
| helper manifest SHA-256 | `248d3821299d054f8171d1a9d354bbf38a1375b7f9688e2e823fa6ffd01694e3`                                                                                                                             |
| 実行条件v6 SHA-256      | `3b99f76ccdb8e04fb39e1a432d459ad22384036dde99d5f023615648521b5c14`                                                                                                                             |
| envelope SHA-256        | `6f0098b2f7bfb1a0b9fe18576d50dd0169532cfe9ba0a9a4e38da97b7f796e3c`                                                                                                                             |
| 北門projection SHA-256  | `b0c168d29fa6aecec12df3a6efe558a8ee2def86a33dd750589f5c8d40d32d8b`                                                                                                                             |

[固定設定](../../.artifacts/narrative-eval/chronicle-full-calibration-20260907/helper/manifest.json)、[実行結果](../../.artifacts/narrative-eval/chronicle-full-calibration-20260907/runs/336fcd7d-2013-49d7-929a-6ea691358860/diagnostic-envelope.json)、[北門projection](../../.artifacts/narrative-eval/chronicle-full-calibration-20260907/runs/336fcd7d-2013-49d7-929a-6ea691358860/diagnostic.json)を保持する。結果ファイルは既存のローカル成果物であり、ハーネスcommitに含まれるとは扱わない。

以前の抽出effort `medium` との同条件比較ではない。今回の新しい抽出を含む構成全体で成立した結果とし、評価器だけの変更による改善と断定しない。`diagnosticOnly=true`、`formalCertification=false`、`accepted=false`、`authorshipReady=false` を維持する。これらの用途フラグは今回の意味的PASSを取り消さない。

| provider報告費用         |            US$ |
| ------------------------ | -------------: |
| 校正12回                 |     0.05904020 |
| 北門の観測1回            |     0.00370860 |
| 北門のsynthesis4回       |     0.00160620 |
| 北門のjudge1回           |     0.00273255 |
| **北門の抽出・評価小計** | **0.00804735** |
| 全18回総額               |     0.06708755 |

Proposalの重要度、対象外の時間情報、他ケースでの品質、製品全体の動作は未評価。校正と北門実診断が同じ原文を土台にしている限界も残す。

## 新規4ケースの固定案 `/1`

以下はモデル出力を見る前に本文だけから作った独立した意味Gold案で、新ケースの抽出・judge呼び出しは0回。既存の `evals/narrative` と `docs/plans` に完全一致する本文がないことを確認した。学習データや外部世界での未出現までは主張しない。

状態は `candidate-frozen-before-model / human-reviewed`。ユーザーが本文SHA-256と全直接・補助範囲を再計算して確認し、A・P・DのGoldと採点方針を採用した。Hの意味Goldも妥当と確認されたが、現行契約での正例表現は別途判定する。出力取得後に同じ版のGoldを変更しない。注釈誤りが判明した場合は元結果を残し、理由と新しい版を別途記録する。

座標は各本文に対するUTF-16、0始まり・半開区間。本文SHA-256はUTF-8・末尾改行なし。述語とentityは意味的な参照解答であり、actualへコピーする辞書ではない。

7軸は predicate／participants／roles／actuality／attribution／narrativeFrame／sourceSupport。sourceSupportは直接根拠と許可contextによる意味的支持を要求し、引用範囲が成立しただけではmatchとしない。

actualに既にある参照の解決は、欠けたparticipantの補完と区別する。Pの「私」は許可contextからリナへの参照と判定できる。Aの「布」やDの「魚」も文脈上一意なら、色の形容がないだけで別実体や欠落にしない。色属性自体は未採点。ただしraw surfaceは書き換えず、存在しないparticipantをGoldやcontextから追加しない。参照が曖昧な場合はundeterminedを残す。

新規4件では**時間値とProposal重要度をすべて未採点**とする。Temporalはtargeted・relations空・全Gold主張をunscoredと明示し、0/0を「時間理解PASS」と呼ばない。計画／実行、夢／現実の区別はevent軸として採点する。新しい時間辞書は追加しない。

### A — 別の実際の出来事（transfer-actual-001）

> ナギは赤い布を箱に入れた。トウマは箱の蓋を閉めた。

本文SHA-256: `7e3c35f54a6a243ee03b8b0b234354b3f29f46e9f19f7622e7df493da02c61f9`

注釈範囲: **exhaustive**。本文の2つの原子的な出来事を網羅する。布の色や箱の材質を別の出来事に数えない。

| Gold | 述語の意味         | 必須participantとrole                       | actuality | attribution | frame       |
| ---- | ------------------ | ------------------------------------------- | --------- | ----------- | ----------- |
| A1   | 赤い布を箱に入れる | ナギ: agent／赤い布: theme／箱: destination | actual    | narrator    | story-world |
| A2   | 箱の蓋を閉める     | トウマ: agent／箱の蓋: theme                | actual    | narrator    | story-world |

直接根拠: A1 `[0,12)`「ナギは赤い布を箱に入れた」、A2 `[13,24)`「トウマは箱の蓋を閉めた」。許可context: なし。

検出対象: 主体・対象・行き先の入れ替え、存在しない受取人や行為の補完、主張の欠落・重複。

### P — 人物が話す計画（transfer-plan-001）

> リナはソウに「私は薬箱を運ぶ予定だ」と話した。薬箱は机の上に残っていた。

本文SHA-256: `9c515bb167409dcc57726d7eff547808c565a0dfba8b13e4fb8a11fee108fe15`

注釈範囲: **targeted**。発話内容の計画P1だけが必須。話したという発話行為、机上にある状態は対象外。聞き手ソウを運搬の受取人や共同実行者にしない。

| Gold | 述語の意味     | 必須participantとrole    | actuality | attribution    | frame    |
| ---- | -------------- | ------------------------ | --------- | -------------- | -------- |
| P1   | 薬箱を運ぶ計画 | リナ: agent／薬箱: theme | planned   | character:リナ | reported |

直接根拠: `[7,17)`「私は薬箱を運ぶ予定だ」。許可context: `[0,6)`「リナはソウに」、`[18,22)`「と話した」。計画の存在を明示した主張を評価し、rawに存在しない実行者情報をこのcontextから補完しない。

検出対象: 計画を実行済みへ変えること、行き先・受取人・成功／失敗を根拠なく補うこと。時間メタデータの正確性は未採点。計画を表すactualityと、発話を表すframeを分ける。

### H — 人物が話す伝聞（transfer-hearsay-001）

> ハルはミナに「山小屋が燃えたと旅人から聞いた」と話した。ハルは山小屋を見ていない。

本文SHA-256: `38b2ccf2ae6087d6a2b618070afb97e0b7a5ddd83041874bd5ac3292809e4433`

注釈範囲: **targeted**。伝聞中の「燃えた」という主張H1だけが必須。話した／聞いた行為、本人が見ていないという知覚の否定は対象外。旅人は伝達元であり、放火者ではない。

| Gold | 述語の意味                   | 必須participantとrole | actualityの意味Gold                                     | attribution    | frame    |
| ---- | ---------------------------- | --------------------- | ------------------------------------------------------- | -------------- | -------- |
| H1   | 山小屋が燃えたという伝聞内容 | 山小屋: theme         | rumored: 燃えたと伝えられるが、語り手は真偽を保証しない | character:ハル | reported |

直接根拠: `[7,22)`「山小屋が燃えたと旅人から聞いた」。許可context: `[0,6)`「ハルはミナに」、`[23,27)`「と話した」。伝達元の旅人までの多段attribution chainは今回未採点。

検出対象: 「燃えた」を語り手が保証する現実へ昇格すること。「見ていない」を「燃えていない」へ変えること。聞き手や旅人を火災の行為者にすること。

**表現能力の注意点:** production schemaはreported frameとcharacter帰属を表せるが、actuality enumに `rumored` はない。v2 Gold側にはある。この相違は北門成功で解消したとは扱わない。意味Goldをparserに都合よくactualへ変更したり、unknownを自動補完したりしない。

無課金の正本確認により、Hは **representation gap** とする。型・parserは `actual + character:* + reported` を受理するが、production promptはactualの認識論的意味を定義していない。既存micro fixtureで同組合せを使う橋の崩落には目撃・本文の裏付けがあり、未検証・反証された伝聞はrumoredとされ、actualへの昇格が禁止されている。したがって、parser通過だけから「発話内で成立する主張、語り手保証なし」へ意味を読み替えない。

参照: [production IR](../../src/features/narrative-extraction/ir/observations/eventOccurrence.ts)、[observation task](../../src/application/narrative-extraction/aiTasks/runObservationExtractionTask.ts)、[citation-ID prompt](../../src/application/narrative-extraction/aiTasks/citationIdObservation.ts)、[micro fixture](../../evals/narrative/cases/chronicle-micro-v1.yaml)のrumor-only／duplicate-mention／disputed-attribution。現行checkoutで確認しており、取得できた旧参照版だけの推定ではない。

Hは全7軸PASSを期待する通常品質試験から外す。Goldを弱めず、enumを追加せず、A・P・Dは独立に進める。Hを将来実APIで観察する場合は、出力形式の表現能力を見る専用診断として別枠にする。actualのunknown、judgeのundetermined、representation gapを混同しない。

## 人手確認済みのtargeted判定規則

| actualの状態                                             | 扱い                                                     |
| -------------------------------------------------------- | -------------------------------------------------------- |
| 必須対象へ正しく対応                                     | 7軸で採点してmatch                                       |
| 事前に対象外と宣言され、本文支持と有効な証拠を確認できる | unscored。actual件数に残し、対象範囲のPASSを妨げない     |
| 対象内外を判断できない                                   | undetermined                                             |
| 対象主張の誤昇格・意味的な誤り                           | 対象内mismatch。「運んだ」を「運ぶ予定」の対象外にしない |
| 捏造・不正な証拠                                         | 対象外という理由で免除しない                             |

Goldと完全一致しないことは対象外の根拠にならない。今回のunscoredは、正誤不明な未注釈actualではなく、事前scopeに照らして妥当な対象外だと確認したactualだけを中立にする規則である。scope policy・response・projection・最終judge入力の版とdigestへ変更を反映する。旧12対照の校正を、新しいscope判断の実API校正済み証拠へ読み替えない。

### D — 夢と覚醒後の現実（transfer-dream-001）

> ユイは、銀の魚が泳ぐ夢を見た。目を覚ましたユイは、床の毛布を畳んだ。

本文SHA-256: `770d604c8b2014d06026908a81b9b9f6941bc7662bfe7c0e52bd32fa79a0a657`

注釈範囲: **targeted**。夢中の遊泳D1と覚醒後の畳む行為D2だけが必須。夢を見たという外側の経験、目覚めそのもの、床の位置情報は対象外。

| Gold | 述語の意味   | 必須participantとrole    | actuality | attribution | frame       |
| ---- | ------------ | ------------------------ | --------- | ----------- | ----------- |
| D1   | 銀の魚が泳ぐ | 銀の魚: agent            | dreamed   | narrator    | dream       |
| D2   | 毛布を畳む   | ユイ: agent／毛布: theme | actual    | narrator    | story-world |

| Gold | 直接根拠                      | 許可context                     |
| ---- | ----------------------------- | ------------------------------- |
| D1   | `[4,10)`「銀の魚が泳ぐ」      | `[10,14)`「夢を見た」           |
| D2   | `[25,33)`「床の毛布を畳んだ」 | `[15,24)`「目を覚ましたユイは」 |

検出対象: 夢の魚を現実に存在・遊泳したことにする、覚醒後の行為を夢にする、夢を見たユイを泳ぐ主体にする誤り。

## 北門専用制約から切り離す最小実装

以下の境界でオフライン実装を進める。検証結果と実API診断は個別のreceiptで記録し、この計画の存在だけを完了証拠にしない。

| 現行の制約                                                                                                          | 必要な変更                                                                                                                                        | 維持する境界                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `chronicleV2Contract.ts`／`contracts/chronicle-v2/contract.schema.json`: 4述語・7entity・4主張・北門固有reviewScope | 新ケース用のversioned contractを分離し、Goldの意味表現・件数・reviewScopeをデータで指定する。旧北門ローダーを緩めず、共通の証拠region型へ接続する | actual用の有限辞書を増やさず、raw actualを既存judgeへ渡す。型・schema・loaderの同一契約と一対一対応                     |
| `chronicleLlmJudgeOffline.ts`: targeted入力はあるが、unmatched actualはfabricated／duplicate／undeterminedのみ      | 妥当な対象外actualのunscored区分をcase scopeと結び付けて追加する。response／projectionの版を分ける                                                | actualの事前削除は禁止。対象内の誤昇格や無効な証拠をunscoredで免除しない                                                |
| Gold／Temporal: 夜半・2 relation・scene-north-gate `[0,2)`固定                                                      | 新規4件は空のtargeted temporal scopeと明示的未採点を表現する。北門scorerは保持                                                                    | 0件を能力PASSへ変換しない。timeからeventを補完しない                                                                    |
| helperのLIVE_CONFIG／loadSourceOnlyContext／runNorthGate、絶対パス・旧HEAD・北門IDへのbinding                       | 新しい実行laneでcase descriptorを受け、source／Gold／設定／出力先／stage予算を固定し直す                                                          | 保存済み北門snapshotは変更しない。manifestとbinding検証を除去しない                                                     |
| 北門固有のGold ID漏出チェック                                                                                       | 新ケースのGold専用IDを対象とし、source-only DTOと実際の送信messagesを確認する                                                                     | 抽出へGold・対象注釈・期待ラベルを渡さない。judgeへだけGoldを渡す                                                       |
| actual replay／opaque refs／context付きstrict serializer                                                            | 新ケースにも再利用する                                                                                                                            | 正規parser・merger・evidence resolver、actual非補完、foreign／stale参照拒否、unknown保持、raw reasoning／元ID表の非保存 |

targetedの追加は必要な応答契約変更であり、「本文JSONの差し替えだけで旧ハーネスのまま実行可能」とは扱わない。対象外の妥当な発話行為と、対象内の誤昇格を区別する限定的な固定応答検証を行う。scope判定が不確かならundeterminedを保持する。exhaustiveのAでは既存の欠落・過剰下限を維持する。

7軸の意味とrubric `/2` の本文は維持する。新response／projection schemaには版と変更範囲を記録し、「新schema自体が既に実API校正済み」とは呼ばない。既存12対照は拡張・再ラベル付けをせず、互換性確認用の固定応答回帰に再利用する。新しい意味規則が必要になった場合は別変更として扱う。

## 実施順と結果の読み方

1. この4件の本文・Gold・scopeを出力を見ずに確認し、版とdigestを固定する。plan／reported／dreamの帰属と未採点範囲を先に確定する。
2. 上記のcase入力・scope処理だけを実装する。4件は独立した診断suiteに登録し、既存14件の正式認証suiteを置換しない。既存ケースの流用はGoldの網羅範囲を確認してからにする。
3. 無課金でspan・schema・actual非補完・raw replay・targeted対象内外・unknown・証拠参照・旧12対照の互換性を確認する。固定応答はモデル品質の証拠に数えない。実装変更には通常の差分gateを適用するが、この計画文書作成のための再実行は行わない。
4. ユーザー追加指示により、最初の適用診断はGeminiのA・P・D各1回とする。同じrunのactualをjudgeへ渡し、caseごとの状態・UUID・citation・Gold・usageを独立させる。既存12件の実API再実行を単なる開始条件にしない。
5. 実API前に新case範囲・送信内容・stage上限・実行bindingを具体化する。今回の最大6 POSTはA・P・Dのobservation＋judge各1回だけであり、北門の旧18 POST枠を流用しない。Gold件数に合わせて余分なactualを切り捨てない。
6. case別に以下を報告する。意味的不一致は記録して次の独立caseへ進められる構成とし、通信・構造・証拠参照の失敗は当該runを停止する。結果を成功へ変える自動retry／repairは行わない。

| 種類                        | 意味と扱い                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- |
| semantic PASS               | 指定event対象の7軸と証拠条件が成立。時間・Proposal・範囲外主張まで保証しない  |
| semantic FAIL               | 既知の不一致・欠落・捏造・証拠不正などを、根拠のある軸ごとに記録              |
| actualのunknown             | 抽出が明示した未確定情報。非補完のまま軸別undeterminedを保持                  |
| judgeのundetermined         | 固定Goldとの比較でjudgeが判定できない。自動的に抽出誤りへ読み替えない         |
| representation／harness gap | parser・Gold・scopeの表現能力不足やbinding不一致。意味品質のFAIL/PASSから分離 |
| unscored                    | 事前に定めた対象外。known mismatchや未知を隠す区分にしない                    |

本文が示す「伝聞の真偽不明」は、その内容の既知の性質であり、judgeの不確実性とは別である。誤りの原因が抽出側かjudge側か一意に分からない場合、その帰属を未確定のまま残す。

別judgeとの合議、表現辞書の拡充、大量の対照追加、同条件の成功待ち反復、effort／費用の最適化は含めない。この4件で一般精度や製品受入れを証明するのではなく、別の述語・人物・発話・frameで使えた範囲と、使えなかった原因の種類を確認する。

Hypothesis・Proposalが少ない、あるいは0件でも、その件数をObservation品質のFAILへ流し込まない。今回の評価対象は指定したObservationであり、重要度や後段の選別ではない。

## ユーザー追加指示: Geminiでの先行診断

ユーザーがGoogle AI Studio APIの利用を許可し、Lunaの前にGeminiの軽量モデルで試す方針を追加した。オフラインのscope確認後にA・P・Dを対象とする。Hは通常品質試験へ混ぜない。

公式モデルmetadataをGETで1回確認し、`gemini-3.5-flash-lite`／version `3.5-flash-lite-07-2026` のgenerateContentとthinking対応を確認した。モデル出力上限は65536で、診断では既存の32768上限を維持できる。[公式モデル仕様](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)

Geminiは別provider・別モデル・新scopeによる探索的診断であり、Lunaの12対照校正や北門基準の証拠へ合算しない。モデル・thinking設定・scope版・入力digest・case別結果を独立して記録する。APIキーはファイル・引数・URL・ログに保存しない。抽出へは本文とproduction prompt／citationだけを渡し、judgeへだけGoldとscopeを渡す。実費はAPIのusageと料金根拠を分離し、無料枠という利用条件をAPIが返していない請求額へ読み替えない。

実行枠は`gemini-3.5-flash-lite`、thinking要求`high`、出力上限32768、1 POSTあたり300秒、応答本文上限2 MiB、最大6 POST。statelessなgenerateContentを使い、検索・外部tool・自動retry・repairは行わない。A・P・DのObservationをproduction parser／citation materializer／merger／evidence resolverで処理し、同じraw responseをメモリ内で再生する。synthesis APIは呼ばず、その空出力をObservationの失敗条件にしない。この枠は後段のHypothesis／Proposal品質を測らない。

独立受入れレビュー担当が実行helperを読み取り専用で事前確認した。最終candidate freezeでは、helper・case契約・productionコード・judge入力生成にhash bindingを付け、実行前後で一致を確認する。保存対象はcontext認証済みprojection、case別状態、token usage、モデルmetadata、入力／出力digestだけであり、raw model responseとthinking textを保存しない。

実装時の正本: [Gold型・loader](../../src/features/narrative-extraction/eval/chronicleV2Contract.ts)、[LLM judge](../../src/features/narrative-extraction/eval/chronicleLlmJudgeOffline.ts)、[production schema](../../src/features/chronicle/extraction/schemas.ts)、[時間scorer](../../src/features/narrative-extraction/eval/chronicleV2Temporal.ts)、[既存設計](chronicle-evaluation-contract-v2.md)、[品質manifest](../../evals/quality-manifest.yaml)。関連要件はGDX-GROUND-001／GDX-ARTIFACT-001／GDX-ISOLATION-001／GDX-TRACE-001。計画の存在だけで実行可能・評価済みsuiteとは扱わない。

## 追加承認: Hを含む4ケースの修正・再実行

ユーザーは全ケースPASSまでの修正・再実行を許可し、対象を「Hも含めた4ケース」と明示した。Gemini先行runはA/P/Dの意味判定FAIL、Luna先行runはAが2主張・7軸一致PASS、Pはobservation応答受信後に局所処理が停止、D未実行だった。Pの例外codeを保存していなかったため、過去の失敗原因は未確定のまま保持する。

次の変更は、(1) helperの局所stage・有限例外code・数値の記録、(2) 現行production契約へのrumoredの表現能力追加、(3) Hの正例と誤actual昇格負例の確認後の通常試験有効化に限定する。原文・Goldの意味・事前scope・7軸rubricは変更しない。Hの以前のrepresentation gap判定は当時の契約に対する正しい記録として残す。

修正前3891ファイル・35,072,050 bytesを、旧bindingとhash一致確認の上で専用snapshotに保全した。新候補の同一設定でA/P/H/D各observation+judge、最大8POSTを実行する。PASSまでという許可は、Gold調整・不確実性の補完・対象内の誤りのunscored化を許可するものとは扱わない。

進行中の証跡: `.artifacts/narrative-eval/chronicle-transfer-luna-repair-20260907/`。未コミット。

### H拡張の変更境界

| 境界                     | 変更                                               | 維持する契約・確認                                                       |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Chronicle IR／出力parser | actualityのrumoredを受理・保持                     | actual/planned/dreamed/unknownの既存意味と古い有効入力の受理             |
| Observation prompt       | 語り手未保証の伝聞を表す一般規則                   | 固有人物・ケースGold・期待ラベルを抽出promptへ渡さない                   |
| Hypothesis／consumer     | 追加値がunknown/actualへ無言変換されないことを確認 | assertion帰属・frameとactualityを独立に保持                              |
| Capability report        | parserが実際に受理する範囲を反映                   | negative-event等の他の表現gapは引き続き別判定                            |
| H case descriptor        | 正例が通る証拠を得て通常試験を有効化               | source/Gold不変。元承認planの聞いた行為scopeが未実装なら出力取得前に補完 |
| 実API helper             | 固定stage/有限例外code/数値の保存、4件8POST        | raw/key非保存、bind検証、retry/fallback禁止、対象内の不一致を保持        |

Hの表現能力の確認はcanonical parserからscoped judge input、固定応答projectionまで通し、正例と誤actual昇格負例を区別する。モデル品質の確認は、その後の実API結果に分ける。

Hのscope補完について、当初planが「話した／聞いた行為」を対象外にしている一方、JSONに明示されていたのはspeech-actだけだったことを確認した。Hの実API出力取得前に、聞いた行為だけを指すhearing-actを別に宣言する。伝聞された火災H1をこの対象外へ逃がさず、source/Gold/coverageを固定したまま元の承認scopeを実装へ反映する。

hearing-actの直接範囲はUTF-16 `[15,22)`「旅人から聞いた」と再計算した。伝聞の内容H1と引用が重なること自体は許可し、対象内外は意味とsourceSupportで区別する。synthesis側はrumoredを保持し、proposal plannerのactual/attempted/prevented制限を維持する。

### 4ケースrun後の契約説明・診断修正

最初の4ケースrun `95264495-ad6f-4f63-b826-48ad04d6d4fa` は、Aが2主張・7軸一致PASS、P/Hがobservation処理の局所失敗、Dが2主張中1件のactualityでUNDETERMINEDだった。Dの妥当な対象外2件は事前scopeによりunscoredであり、actualityの不確実性はそのまま残した。6POSTはすべてHTTP200/stop、合計70,547 tokens、provider報告額US$0.0732012。成功runではない。

読み取り調査により、helperが`CitationIdObservationError`を識別せず`unknown-error`へまとめる診断不足と、production promptがactuality/frameの全許可値・人物帰属書式・時間表現の文字列配列を説明していない契約説明不足を確認した。これらは確定した不足であり、P/Hの具体的な失敗原因とはまだ断定しない。過去のraw responseを保存していないため、後からparser原因を補完しない。

修正候補では、parserの既存許可値を正本として一般的な出力説明を追加する。症例・人物・Goldをpromptへ渡さず、parserの許容範囲・正解・scope・rubricは維持する。診断は型を確認した有限例外codeと、メモリ上でcanonical parserを通した固定フィールド/理由ごとの数値に限定する。任意キー・値・error message・stack・raw response・reasoning・API keyは保存しない。解析callbackとtask完了の数値を区別し、成功したactualのunknown件数も固定軸別に記録して、抽出側のunknownとjudgeの判定不能を混同しない。

前候補の3902 bound filesは`chronicle-transfer-luna-repair-v1-snapshot-20260907`へhash一致確認後に保全した。新証跡は`.artifacts/narrative-eval/chronicle-transfer-luna-repair2-20260907/`とし、focused gates、独立レビュー、再freeze、Quickとverifyの後に同じ4ケース・Luna max・最大8POSTを再実行する。
