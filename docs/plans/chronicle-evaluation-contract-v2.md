# Chronicle 評価契約 v2

状態: `draft-for-human-review`（4つのatomic Observation、原文／Gold、および承認済み2時間関係の範囲は確認済み。Goldの正式認証と実装全体の承認は未了）。
オフラインの診断用途に限定する。

本仕様は、Chronicleの1ケースに限定した新しい評価契約を定義する。
v1のGold（正解データ）、採点器、診断、プロンプト、プロバイダー呼び出し経路、過去の実行結果は変更しない。
実行可能なライブ評価スイートには登録せず、意味品質の正式認証にも使用しない。

## 対象範囲と維持する境界

v2の対象は、既存の「北門」の本文について、観測結果（Observation）を網羅的に評価する1件のテストデータである。
原文による裏付け、Observationの意味、提案（Proposal）の選別方針を分離する。
実装の適用範囲はこのテストデータに限定し、結果を日本語の物語を一般的に理解できる証拠として提示してはならない。

v1の成果物は、`semanticPassed: false` の結果を含め、過去の記録として保持する。
削除済みのプロバイダー出力は復元も再採点もしない。
将来プロバイダーを呼び出す際は、別途レビュー済みの実行契約を必要とする。

## 独立したGoldの作成

v2のGoldは、固定した原文と正規の座標から作成する。
作成経緯を記録し、その状態を `draft-for-human-review` として、確認済みの承認範囲と未承認の範囲を分けて次を明示する。

- 原文に対する独立した注釈であること。
- 原文だけを根拠に作成したこと。
- 削除済みのプロバイダー出力、評価対象の観測文言、v1の採点結果を使用していないこと。
- Goldの正式認証と実装全体の承認には、追加の人手確認が必要であること。
- 正式認証を無効にしていること。

この確認範囲は、機械可読な `authorship.reviewScope` としても記録する。recordには原文とGoldの確認、
4つのatomic Observation claim、`night-half-chain-break`／`night-half-gate-fall` の2つの時間関係、
および `absolute-date-conversion`、`downstream-sentence-time-inheritance`、`structured-entity-properties`、
`proposal-importance` の4つの時間評価除外を固定する。対象外の承認、実装全体の承認、正式認証の承認を含むrecordは
受け入れず、`formalCertification: false` と `status: "draft-for-human-review"` を維持する。

主張の件数が過去の出力件数と共通していても、その件数は原文から決めた設計上の判断である。
削除済みのv1応答から回収した証拠ではない。

テストデータは [actual-gate-collapse.json](../../evals/narrative/contracts/chronicle-v2/actual-gate-collapse.json) に置く。
[contract.schema.json](../../evals/narrative/contracts/chronicle-v2/contract.schema.json) で検証し、型付きの契約モジュール
`src/features/narrative-extraction/eval/chronicleV2Contract.ts` で読み込む。

## ObservationのGold

Observationの網羅範囲は、宣言した原子的な主張の粒度で `exhaustive` とする。
対象の原文は次のとおり。

> 夜半、北門の鎖が切れ、重い門扉が街路へ倒れた。衛兵は鐘を鳴らし、通行人を広場へ退避させた。

評価対象となる4つの主張を、次のように定義する。

| ID                          | 述語          | 関与する実体と役割                                    | 必須直接範囲（UTF-16） |
| --------------------------- | ------------- | ----------------------------------------------------- | ---------------------- |
| `chain-break`               | `chain-break` | `north-gate-chain:theme`                              | `[3, 10)`              |
| `gate-fall`                 | `gate-fall`   | `gate-leaf:theme`, `street:destination`               | `[11, 22)`             |
| `guards-ring-bell`          | `ring-bell`   | `guard:agent`, `bell:theme`                           | `[23, 31)`             |
| `guards-evacuate-passersby` | `evacuate`    | `guard:agent`, `passerby:theme`, `square:destination` | `[32, 44)`             |

正規の引用カタログが最初の2つの主張を含む広い範囲を提示しても、両者は別の主張として扱う。
各Goldには、意味を直接示す `requiredDirectRegions` と、同じリクエストでモデルに見えていて補助に使える
`allowedContextRegions` を分けて固定する。actualの有効な引用範囲を合わせた領域は、すべての必須直接範囲を隙間なく覆わなければならない。
小さな重なりだけでは直接根拠にならない。

退避の主張では、`guard:agent` の役割を、同じカタログ文中の先行する `衛兵は` という節が裏付ける。
必須直接範囲は `[32, 44)`、補助文脈範囲は `[23, 26)` とする。補助範囲は同じリクエストに結び付く情報の同じ閲覧範囲で
モデルに可視であることを検証するが、Goldの参加者をactualへ補完する入力にはしない。
この評価用データの他の主張は、補助範囲を空配列として直接範囲だけで評価する。

各主張には、述語、型付きの関与実体と役割、現実性、帰属、物語上の枠組み、必須直接範囲、許可された補助範囲、
および `atomic` という粒度を記録する。Goldで許可する述語は、このテストデータの4種類だけとする。
評価対象の観測であるactual側の語彙には、`gate-repair` や `bell-break` など、比較用の対照概念も有限個含める。
これにより、意味を判定できる誤った述語と、未対応の自由記述を区別する。

## 限定した時間関係のGold

時間関係はObservationの4主張とは別の、対象を絞ったsymbolic metadataの層として評価する。Goldの
`temporalGold.coverage` は `targeted` とし、必須関係は次の2件だけである。

| 関係ID                   | 対象claim     | 関係        | 表現   | 必須範囲（UTF-16）        |
| ------------------------ | ------------- | ----------- | ------ | ------------------------- |
| `night-half-chain-break` | `chain-break` | `occurs-at` | `夜半` | `scene-north-gate [0, 2)` |
| `night-half-gate-fall`   | `gate-fall`   | `occurs-at` | `夜半` | `scene-north-gate [0, 2)` |

`夜半` は象徴的な時間表現として保持し、00:00や絶対日時へ変換しない。`guards-ring-bell` と
`guards-evacuate-passersby` への時間付与、後続文への時間継承、絶対日付の変換、実体属性、Proposalの重要度は、
このGoldでは明示的に採点対象外とする。4つのevent claim、原文、既存のdirect/context範囲は変更しない。

時間の評価はevent評価の後に一方向で行う。production parserを通過した
`artifacts.observations[].payload.temporalExpressions` の materialized な `string[]` を、Goldを渡さない専用の
raw/normalized行へ写す。対象eventにexactなevent assignmentがある場合だけ関係を採点し、assignmentが
`unobservable` または不確かな場合は `event-identity-unavailable` の `unobservable` とする。時間値からevent identityを
作ったり、既存のevent assignmentを変更したりはしない。

対象actual自身の検証済みcanonical citationの範囲のunionが、`夜半` の `[0, 2)` を完全に覆う場合だけ時間の証拠を有効とする。
別actualの引用、同じwindowに見えるだけの範囲、foreign request／snapshot／window、stale binding、改変された座標やtext、
Goldから補った範囲は代用できない。対象eventの証拠が不足または不正なら `temporal-evidence-invalid` としてFAIL要因にする。

既知の `夜半` があればその関係を `matched` とする。`夜半` がなく空配列または既知の `朝` だけなら `missing`、
`夜半` がなく未知の表現があれば `unobservable` とする。`夜半` に `朝`、未知値、日付らしい文字列が追加されても、
このtargeted関係では加点も減点もせず、別のFPとして数えない。missingまたはinvalid evidenceが1件でもあれば時間statusは
`FAIL`、確定失敗がなくunobservableがあれば `UNDETERMINED`、2件ともmatchedなら `PASS` とする。後続2主張の時間値は、
時間の件数・status・event判定を変えない。

時間projectionはeventの6軸、FP/FN、分母と分離し、`requiredRelationCount`、`matchedCount`、`missingCount`、
`invalidEvidenceCount`、`unobservableCount`、`blockedByEventIdentityCount`、`unscoredGoldCount`、`judgedCount`、
`denominator`、`status`、`passed` だけを数値と有限列挙値で記録する。4区分の合計はrequired件数、denominatorはrequired件数、
`judgedCount = requiredRelationCount - unobservableCount`、`blockedByEventIdentityCount <= unobservableCount` とする。
event・時間・採点済みProposalの確定FAILはoverall semantic statusへ反映するが、`observationPassed` はevent判定として独立に保つ。

## オフラインLLM意味判定（診断専用）

自由記述の意味を有限の別名辞書へ押し込めず、正規化前のproduction Observationを、参照Gold付きの単一judgeへ渡す経路を追加する。
これは `src/features/narrative-extraction/eval/chronicleLlmJudgeOffline.ts` の
`prepareChronicleLlmJudgeOfflineRun`／`runChronicleLlmJudgeOffline` で実装し、外部通信を行わず固定応答を使う。
固定Observation応答は本番のcitation-ID parser、materializer、merger、canonical evidence resolverを通過してからjudge入力になる。
synthesisはこの評価経路の対象外であり、合成結果を入力へ混ぜない。

judge入力のactualは、述語、participant surface／role、actuality、attribution、narrative frame、semanticType、location、duration、
時間表現をそのまま保持する。judgeは意味の同一性、各意味軸、原文による意味的裏付け、欠落・捏造・重複、対象時間関係だけを判定し、
actualの修復やGoldからの補完を返さない。participantはGoldの必須集合と比較し、roleはactualが明示したparticipantだけを比較する。
明示的なunknownはその軸を `undetermined` とし、actual内の命令文らしい文字列はデータとして扱う。

`sourceSupport` は、許可された原文とevidence contextが完全に明示されたevent（participant-roleの結び付き、否定、現実性、帰属、narrative frameを含む）を
支持するかを、他の意味軸とは独立に判定する。`evidenceCandidates` の `evidenceValid`、`overlap`、`directSupport`、
`contextSupport` は引用の有効性、参照解決、範囲被覆だけを表し、意味的含意を表さない。有効な引用が必須範囲を覆っていても、
actualのparticipant-role assertionが原文に支持されることは保証しない。同じ根本原因が複数の独立した軸を不一致にすることがあり、
1つの軸で報告しても別の軸を無効化しない。入力フィールドとresponse schemaは変更せず、judgeの軸値を後処理で書き換えない。

judge responseは余分なキーや自由文を許さないJSON schemaとし、primary／unmatched actual／unmatched Gold／temporal relationの全入力を
ちょうど一つの区分へ割り当てる。一対一のprimary、未知参照、duplicateの自己参照・連鎖、時間関係のretargetingをコードで拒否する。
duplicateは別のprimary完全一致actualだけを参照できる。primaryの対応にも `evidenceValid`、`overlap`、`directSupport`、
`contextSupport` の全条件を再適用し、judgeのsourceSupport判定で引用条件を免除しない。これらのフラグはsourceSupportの
意味判定を代替しない。

各runのsource／actual／Gold／relation／evidence refは意味を持たないopaque IDへ置き換え、元IDとの変換表はメモリだけに保持する。
検証済み診断へ残すのは、opaque decision、固定enum、件数、軸別status件数、temporal件数、版とdigestだけである。
`exhaustive` では actual／Gold件数差の欠落・過剰下限を別々に計算し、judgeが全て `undetermined` でも下限が正なら `FAIL` とする。
通信・JSON schema・参照・本番parserの失敗は意味判定へ変換せず、実行失敗として入力構築前に停止する。
出力projectionは常に `diagnosticOnly: true`、`formalCertification: false`、`accepted: false`、`authorshipReady: false` とする。
`prepareChronicleLlmJudgeOfflineRun` の `serialize(result)` は、同じprepare closureが生成したfreeze済みresultだけを受け付け、元contextと返答を再検証してから、allowlist・件数parity・digestを満たすprojection JSONだけを返す。別run・copy・改変されたresultは保存境界で拒否する。同じimmutable resultの再serializeは同じbytesを返し、filesystem sinkの失敗で正当なresultを消費しない。
`invalidEvidenceCount`、`unsupportedPrimaryEvidenceCount`、`temporalEvidenceFailureCount` を保存し、証拠不成立のprimaryは7軸が一致してもexact／temporal identityへ昇格させない。該当時間関係は `null`、`undetermined`、`event-identity-unavailable` に固定する。judgeの軸値自体は書き換えない。

校正対照は [chronicle-llm-judge-v1.json](../../evals/narrative/calibration/chronicle-llm-judge-v1.json) とその review record に置く。
12対照と完全コピーのmerger controlは、提案された人手ラベルの確認用であり、外部API、モデル利用可能性確認、retry、正式認証を許可しない。

## Source document bindingとparserの観測境界

Contractのdocument IDとproduction prepared document IDは暗黙に同一視しない。evaluatorは、title／textの一意一致と
Source Viewを検証した結果を、`{ contractDocumentId, preparedDocumentId, sourceRef, evidenceSourceRefs }` の明示的な
一対一bindingとして返す。`sourceRef` はSource Viewの `S` 参照、`evidenceSourceRefs` はprepared mappingに登録された同一文書の
Source View `S` 参照とcitation catalog `E` aliasを含む集合であり、SとEが同じ文字列であることを要求しない。一つのprepared documentが
複数のS／E aliasを持つ場合はすべてcanonical sortしてbindingへ含める。
欠落、重複、foreign contract ID、別prepared document／S参照へのrebind、未知または別文書へ解決するE alias、
evidenceのdocument IDとの不一致はfail closedにする。document IDだけのidentity fallbackは使わない。

temporal Goldの範囲はこの検証済みbindingからprepared IDへ共通helperでremapする。raw temporal行のactualRef集合は
materialized Observationを一度ずつ完全に覆い、各行の `evidenceRefs` はその `actualRef` に対応する検証済みactual evidenceのE alias集合と
canonicalに一致し、かつ対象bindingのalias集合に含まれなければならない。catalog全体のalias集合を各行へコピーすることは許さない。
S参照とE aliasを文字列一致させたり、別actualのaliasを流用したりはしない。bindingはevaluatorのephemeralな検証結果であり、
永続numeric diagnosticsへ文字列値やalias集合を保存しない。contextなしのdiagnostics validatorが再検証するのは、数値projection、
版、digest、層間整合性である。prepared title／textの元照合やbindingの真正性を、contextなしvalidatorだけで再証明するとは主張しない。

contextなしvalidatorは、保存されたprojectionの形状・数値・status／passed・digestの自己整合だけを検証するため、raw入力、binding、
relation、projectionを相互に整合する一式へ置き換えるcoherent rebindingまでは検出しない。builderは与えられた入力から同じremap helperと
temporal scorerを再実行してprojectionを再導出するが、入力一式そのものが置き換えられた場合の真正性を認証しない。元のevaluation／contractと
prepared documents／bindingsを保持するcontext付きvalidatorだけが、document／alias parity、raw rowのexact cover、relation rows、projectionを
元の入力から再導出してcoherent rebindingを拒否できる。したがって両者の検証能力を同一視しない。

現行parserは配列内の非文字列をsilent filterするため、`[123]` は `[]`、`["夜半", 123]` は `["夜半"]` としてmaterializeされ得る。
この挙動はcharacterizationとして固定するが、raw provider応答の文法妥当性、非文字列を含む応答の品質、parser前の省略や変形は判定しない。
したがって、`missing` はmaterialized metadataに関係がないという意味に限られ、元応答の意図や一般的な時間理解の証明にはならない。

## 版と評価scope

この時間拡張で固定する版は、schema `/2`、contract `/3`、Gold `/3`、evaluator `/4`、diagnostics `/4`、diagnostics schema `4`、
LLM judge rubric `/2`、temporal scorer `/1` である。event normalizer `/1` とevent Alignment `/3` は変更しない。Proposalが未採点のこのcaseの
`evaluationScope` は `observation-and-temporal` とし、Proposalまで採点する別契約では `observation-temporal-and-proposal` とする。
`accepted` は正式ゲートとしてdraft Goldではfalseのまま保持し、`validation.ok` はdiagnosticsの構造・数値・digest bindingが検証できたことだけを示す。

## 証拠と本番処理への結び付け

証拠は、原文に対して厳密に検証する。

1. 引用IDが、対象のリクエストとスナップショットに属していること。
2. カタログの項目から、固定した文書と座標を解決できること。
3. 復元した文字列が、UTF-16座標で切り出した原文の文字列と一致すること。
4. 別の対象に属する参照、古い参照、改変された参照、曖昧な参照、解決できない参照を不合格にすること。

Goldの直接範囲とactualの証拠範囲には、全体の範囲一致を要求しない。
範囲の重なりは対応候補を作るためだけに使う。actualの引用範囲を合わせた領域が必須直接範囲を隙間なく覆うことと、
補助範囲が同じリクエストでモデルに見えていることを別々に検証する。
一時的に保持する候補の型は次のとおり。

```ts
{
  actualRef: string;
  goldRef: string | null;
  evidenceValid: boolean;
  overlap: boolean;
  directSupport: boolean;
  contextSupport: boolean;
}
```

`directSupport` は同じactualの有効な正規引用範囲を合わせた領域が、必須直接範囲をすべて覆った場合だけtrueとなる。
`contextSupport` は、同じactualの同じリクエストにある検証済みの結び付け情報のSource View範囲が、許可された補助範囲を
同じ文書で覆った場合だけtrueとなる。`allowedContextRegions` が空配列の場合は、追加の文脈を要求しないためtrueとする。
登録済みSource Viewの一覧全体、スナップショット全体、非表示の文書本文は、可視性の根拠にしない。対応付けで有効な対応候補となる
条件は、`evidenceValid`、`overlap`、`directSupport`、`contextSupport` のすべてがtrueであることとする。

対応付けへの受け渡しには `ChronicleV2AlignmentInput` を使う。
渡す内容は、Goldの主張、独立に正規化したactualの主張、証拠に基づく対応候補、
2つの網羅範囲モード、および独立したProposalの選別方針である。
actualの正規化器にはGoldを引数として渡さず、GoldのID・述語・関与実体・役割・判断をactualの主張へコピーしてはならない。

## 適用範囲を限定したactualの正規化

正規化器は、このテストデータに限定した有限の語彙だけを対応付ける。
次の3層を分けて保持する。

1. 本番形式の応答に含まれる、正規化前のactualの主張。
2. 決定的な手順で正規化したactualの主張。
3. 対応付けの比較対象としてだけ使うGoldの主張。

既知の別名には、原文の4主張に対応する日本語・英語の表現、`guards` から `guard`、
`passersby` から `passerby` への対応、および入力の役割 `patient`・`object` から
正規の役割 `theme` への対応を含める。
正規の役割は `agent`、`causer`、`destination`、`theme` とする。
`patient` は入力時の別名であり、独立した別の意味役割ではない。
行先の実体である `street` と `square` は区別する。

対照用の述語 `gate-repair` と `bell-break` は既知の語彙だが、Goldには現れない。
語彙の範囲外の値は、項目ごとに `{status: "unknown", reason: ...}` として扱う。
特に、帰属を表す値が `unknown` の場合は、既知の事実へ変換せず、不明のまま保持する。
未知の値を黙って合格にしてはならず、契約上の根拠なしに誤りと断定してもならない。

## 意味に基づく一対一の対応付け

対応付けでは、まず証拠条件を満たす対応候補から完全な意味的一致の組を作り、次に残った候補を不一致の診断用に比較する。
有効な対応候補は、`evidenceValid`、`overlap`、`directSupport`、`contextSupport` のすべてがtrueであるものに限る。
述語、必須の関与実体すべて、その役割、現実性、帰属、物語上の枠組みが一致する場合だけ、意味の一致を認める。
1つのactualの主張が対応できるGoldの主張は最大1つであり、1つのGoldの主張に対応できるactualの主張も最大1つとする。

完全な意味的一致の組は、成立する組数が最大になるように先に確定し、そのGoldを不一致や不確実性の診断用比較へ再利用しない。
この優先処理により、先に不一致を選んだために後続の完全一致を失うことを防ぐ。完全一致を確保した後の診断用比較は、
残ったactualとGoldから、まず組数を最大化し、次に比較した意味次元の一致数の合計を最大化し、最後に正規化したactual ID順とGold ID順で同順位を決める。
未知を含む容量計算は同じ一対一の組数を最大化し、候補に意味得点を加えない。診断用の比較組は一致の組数を増やさず、
比較相手を選ぶためだけのものである。すべての判定結果は正規の並べ替え後に計算し、Gold・actual・対応候補の入力順序を変えても、
組、正規化した割当て、件数、次元別の値、状態が変わらないようにする。入力の結び付けを記録する `rawActualDigest`、
`goldDigest`、`evidenceGraphDigest` などは配列順を含むため、入力順の変更で変わり得る。この入力の指紋まで不変だとは主張しない。

未知の項目は行全体を捨てず、その項目だけを観測不能として保持する。未知actualは、診断用の不一致割当てより先に、
証拠条件を満たす有効な全Gold候補について既知項目の矛盾がないかを比較し、互換候補の集合を作る。
この未知互換グラフと `unknownMatchCapacity` は診断用の比較割当てから独立して計算するため、比較相手として選ばれた別Goldとの不一致だけを理由に、
互換候補を持つactualを `mismatch` へ移してはならない。例えば既知の `gate-repair` とGoldの `gate-fall` が比較でき、帰属だけが未知なら、
そのGoldとの比較では述語の不一致を確定し、帰属の次元だけを観測不能とする。ただし、有効な全Gold候補との比較で既知矛盾が残り、
互換候補が1つもない場合に限って、actualを不一致または余分として扱う。参加者の一部が未知でも、既知の参加者数や多重集合がGoldと矛盾する場合は、
その参加者次元の不一致と観測不能を同時に保持する。参加者と役割では、確定した不一致と未知を同じactualに併記できる。
全次元の `truePositive + unobservable <= actualCount` と、単一値4次元の
`pairedComparisonDenominator + unobservable <= actualCount` は、診断節に定めた範囲で検証する。

未知を含むactualは、証拠条件を満たし、actualの既知の項目がそのGoldと矛盾しないGoldが1つでもあれば、
そのGoldが先に完全一致へ予約されていても行全体を `unobservable` として保持する。未知actualが未予約のGoldを表現できる数だけを
別途 `unknownMatchCapacity` に数え、原子的な一対一の制約を容量計算にだけ適用する。既知の述語・関与実体・役割・現実性・帰属・
物語上の枠組みのいずれかが矛盾するGoldは不確実性集合へ加えない。したがって、未知候補だけを理由に無関係なGoldまで
`undetermined` にしてはならない。

結果の状態は `match`、`mismatch`、`unobservable`、`unscored` の有限集合とする。
理由には、述語の不一致、関与実体の不足・過剰、役割の不一致、現実性・帰属・物語上の枠組みの不一致、
証拠の不正・欠如、主張の重複、語彙の範囲外の意味を含める。

未知の主張が複数のGoldと対応し得る場合でも、一対一の原子性を保つ。Goldが4件で原子的なactualが1件なら、
そのactualが4件すべてと対応し得るように見えても、表現できるGoldは最大1件であり、少なくとも3件が欠落するという下限は確定する。
どの3件かを決められないときは、任意のIDを確定欠落として割り当てず、欠落の下限と不確実な候補ID集合を別々に記録する。
`unknownMatchCapacity` は、完全一致を確保した後に未知を含むactualが原子的な一対一制約の下で表現できるGoldの最大数とする。
`missingCountLowerBound` は `max(0, goldCount - matchedCount - unknownMatchCapacity)` で導出し、
確実な欠落をGold IDの不確実性と混同せずに保持する。IDを特定できない欠落もこの下限から消してはならない。
`cardinalityExcessLowerBound` は `exhaustive` の場合だけ `max(0, actualCount - goldCount)` として記録し、
`targeted` では常に0とする。これは実際のactual区分、偽陽性・偽陰性、判定対象数へ加算しない独立した下限であり、
1以上なら原子Goldの件数を超えた確定的な不合格要因として扱う。

注釈範囲を限定した場合、そのGold集合の外にあるactualは `unscored` とする。
そのactualも判定対象数には残し、黙って偽陽性や合格にするのではなく、意味評価を `UNDETERMINED` とする要因として保持する。

## ObservationとProposalの分離

Observationの採点では、原文の4主張を忠実に捉えているかを評価する。
原文による裏付けがある軽微な主張は、後段のProposalの選別方針によって抑制されても、Observationの評価対象に残す。

Gold側の区分は `matched`、`missing`、`undetermined` の3つだけとする。
区分は互いに重ならず、すべてのGoldの主張を網羅するため、
`goldCount = matchedCount + missingCount + undeterminedGoldCount` が成り立つ。
`mismatchedGoldCount` は診断用の部分集合であり、`missing` と重なり得る。
未知の候補も同じGoldの主張を覆う場合は、`undetermined` と重なり得るため、独立した4つ目のGold区分にはしない。
一方、IDを特定できない欠落を表す `missingCountLowerBound` はGold区分の件数ではなく、
`max(0, goldCount - matchedCount - unknownMatchCapacity)` で求める追加の下限である。
そのため、`missingCountLowerBound` を `missingCount` や `undeterminedGoldCount` に足してGold件数を再計上してはならない。
例えばGold 4件、完全一致0件、未知actualの `unknownMatchCapacity = 1` の場合は、
`missingCountLowerBound = 3` となる。`undeterminedGoldCount` は実際に互換な候補として残ったGold IDの数であり、4件とは限らない。
Gold IDの不確実性を保ったまま、確実な不足をFAIL判定へ反映する。

actual側は、`matched`、意味の `mismatch`、`extra`、`duplicate`、`unscored`、`unobservable` の6つに分け、
区分同士は重ならないものとする。
Goldとactualの件数は別々に保持する。全体の判定対象数は `goldCount + actualCount` とし、
判定済み件数からは、未判定のGoldと、観測不能または未採点のactualを除く。

Observationは、確定した不一致、余分、重複、証拠不正、未採点、観測不能、未確定Gold、
`missingCountLowerBound > 0`、または `cardinalityExcessLowerBound > 0` が残る場合はPASSにしない。
`observationPassed` はこの条件を満たすときだけtrueとなる。`semanticStatus` は、確定した不合格要因が1つでもあれば
`FAIL`、確定した不合格はないが未確定要因が残れば `UNDETERMINED`、必要な判定がすべて成立したときだけ `PASS` とする。
この優先順序は、未確定な候補があることによって既知の不一致や確実な欠落を隠さないためのものである。

Proposalの評価は、Observationの同一性を確定した後にだけ行う。
このテストデータのProposalの網羅範囲は `targeted` だが、選別方針は理由 `importance-not-annotated` を伴う
`unscored` として明示する。この原文だけでは、出来事の歴史的重要性に関する方針を確定できないためである。
将来Proposalを採点するテストデータを作る場合は、対象となる主張IDと期待する判断を明示しなければならない。
Proposalの件数や重要度によって、Observationの件数を書き換えてはならない。

Proposalの `unscored` は、Proposal層を今回の総合判定から除外する宣言であり、Observationの不確実性とは区別する。
その場合は `proposal.status = "unscored"`、Proposalの採点件数を0、`proposalPassed = false` とするが、
Observationと対象時間関係がPASSなら `semanticStatus = "PASS"`、`semanticPassed = true` を許す。
この正例の組み合わせは `observationPassed = true`、`proposalPassed = false`、`semanticPassed = true` であり、
Proposalを含めず、4つのObservationと承認済みの時間関係だけを評価することを
`evaluationScope = "observation-and-temporal"` で固定する。
Proposalを採点する場合は `evaluationScope = "observation-temporal-and-proposal"` とし、Proposalの確定不合格は
Observationの不確実性とは別に `semanticStatus = "FAIL"` へ反映する。

仮説（Hypothesis）とクラスタリングも別の層として報告する。
因果関係があっても、同じ出来事とは限らない。鎖の切断と門扉の転倒は、因果関係があっても2つの原子的な主張として区別できる。

この契約では、クラスタリングは件数だけを報告し、`not-scored` とする。
クラスタ数と仮説数を、ObservationやProposalの正解として加算してはならない。

## v2の診断

v2の数値診断データには新しいスキーマ版を使い、v1の `U/M/R/X` の式は流用しない。
記録できる内容は、固定キー、有限の列挙値、整数、真偽値、SHA-256ダイジェストだけとする。

- 証拠の有効性、未解決件数、対応候補の組数。
- ObservationのGold件数・actual件数、一致・欠落・余分・重複・観測不能・未判定・未採点の件数。
  Gold側の3区分とactual側の6区分の規則に従う。Gold側は
  `goldCount = matchedCount + missingCount + undeterminedGoldCount`、actual側は
  `actualCount = matchedCount + mismatchCount + extraCount + duplicateCount + unscoredActualCount + unobservableCount`
  とする。`mismatchedGoldCount` はGold区分に足さない診断用の重複可能な件数である。
  `unknownMatchCapacity` と `missingCountLowerBound` はGold区分とは別の容量診断であり、
  `missingCountLowerBound = max(0, goldCount - matchedCount - unknownMatchCapacity)` とする。
  `cardinalityExcessLowerBound` は `exhaustive` のときだけ `max(0, actualCount - goldCount)`、`targeted` のときは0とし、
  actual側の6区分、偽陽性・偽陰性、判定対象数へ加算しない。1以上はObservationの確定的なFAIL要因である。
  `goldJudgedCount = goldCount - undeterminedGoldCount`、`actualJudgedCount = actualCount - unobservableCount - unscoredActualCount`、
  `judgedCount = goldJudgedCount + actualJudgedCount`、`denominator = goldCount + actualCount` とする。
- 述語、関与実体、役割、現実性、帰属、物語上の枠組みの各得点と、明示した比較組数。
  各次元は比較可能なactualとGoldの組だけを採点し、
  `pairedComparisonDenominator = truePositive + falsePositive = truePositive + falseNegative` を満たす。
  未知の値はその次元の `unobservable` を増やす。既知の件数・多重集合などから不一致が確定する行では、
  同じ次元の `falsePositive`・`falseNegative`・比較組数と `unobservable` が同じ行に共存してよい。
  ただし、全次元で `truePositive + unobservable <= actualCount` を満たし、述語・現実性・帰属・物語上の枠組みの4つの単一値次元では
  `pairedComparisonDenominator + unobservable <= actualCount` も満たすものとする。参加者と役割の次元では、参加者数や多重集合から
  確定した不一致と未知が同じactualに現れ得るため、比較組数と観測不能数を足して行数に合わせる式は置かない。
  それ以外の値は非負整数として比較組数の上限内で検証する。
  欠落・余分・証拠不正・重複の行を、すべての次元の偽陽性や偽陰性として連鎖的に計上しない。
- 独立したクラスタ数とHypothesis件数。
- Proposalの選別方針に対する評価結果、または明示した未採点状態。
  未採点のProposalは中立に扱い、Proposalの採点件数をゼロ、状態を `status: "unscored"` とする。
  採点による合格と混同しないよう、保存する `passed` フラグはfalseとする。
- `observationPassed`、`proposalPassed`、`semanticPassed`、`accepted` は、以下の整合性の規則から導出する。
  `observationPassed` は確定した不一致、余分、重複、証拠不正、未採点、観測不能、未確定Gold、
  `missingCountLowerBound > 0`、または `cardinalityExcessLowerBound > 0` がない場合だけtrueとなる。
  `semanticStatus` は、確定した不合格要因（Observationの確定した不一致、余分、重複、証拠不正、
  `missingCountLowerBound > 0`、`cardinalityExcessLowerBound > 0`、または採点済みProposalの `status = "fail"`）を先に `FAIL` とし、
  それがなく未確定要因が残る場合に `UNDETERMINED`、いずれもない場合に `PASS` とする。
  `semanticPassed` は `semanticStatus = "PASS"` のときだけtrueとなる。
- Proposalの採点有無を表す固定列挙値 `evaluationScope`。Proposalが `unscored` の場合は
  `observation-and-temporal`、Proposalが `scored` の場合は `observation-temporal-and-proposal` とし、Proposalの件数を
  Observationへ重複計上しない。

`proposalPassed = false` かつ `evaluationScope = "observation-and-temporal"` でも、Observationと対象時間関係が成立していれば
`semanticPassed = true` とできる。これはProposalの採点を省略したまま意味判定の対象をObservationへ限定するためであり、
Proposalの採点済み合格を意味しない。`accepted` は `semanticPassed`、採点済みProposalの合格、
Gold authorshipの正式な準備がすべて成立した場合だけtrueとなる。`draft-for-human-review` のGoldではfalseのままとする。
診断Projectionの `validation.ok` は、固定形状、件数式、層間整合性、ダイジェストを再検証できたことを示す値であり、
`accepted` や一般的な意味品質の認証とは独立である。

生の応答文、プロンプト、原文、引用文、スタックトレース、認証情報、自由記述のエラーは永続化しない。
ダイジェストは、正規化前のactualのデータ、正規化後のactualのデータ、Gold、証拠グラフ、割当て、
各層の診断、選別方針の評価結果、スキーマと採点器の版、および固定形式の診断データ全体を結び付ける。

## オフライン対照試験と受入れ

対象を絞ったテストで、次を実証しなければならない。

- production parserを通過した4つのevent actualについて、最初の2つへ同じ `[0, 2)` の `夜半` evidenceが結び付く正例を通し、
  event PASS、temporal PASS、後続2主張の temporal unscored、`accepted: false` を確認すること。
- temporal metadataの対象ごとに、空配列／既知の `朝`／未知表現／`朝`+未知／`夜半`+既知値／`夜半`+未知値／日付らしい追加値を対照し、
  missing・unobservable・matchedの規則と、既知の失敗を未知が弱めない優先順を確認すること。
- 対象eventのassignmentが不確かな場合、`event-identity-unavailable` の temporal unobservable とし、eventのassignment、unknown capacity、
  missing lower bound、cardinality excess、6区分、FP/FN、event denominatorを変更しないこと。別関係にmissingまたはinvalid evidenceがあればFAILを維持すること。
- temporal evidenceは対象actual自身の検証済みcanonical citation unionが `[0, 2)` を完全に覆う場合だけ有効とし、別actual、同一windowの可視性だけ、foreign／stale／改変された参照、
  部分覆域、句読点だけの範囲を拒否すること。2つのtarget actualが同じ範囲を共有できることも確認すること。
- `temporal.rawRows` がmaterialized ObservationをactualRefごとに一度ずつ完全に覆い、E aliasの集合が対応するbindingと一致することを確認すること。欠落、重複、未知、別文書、
  別actualからの流用、S参照とE aliasの文字列同一視を拒否すること。
- contract document IDとprepared document IDが異なるproduction対照で、明示的な
  `{ contractDocumentId, preparedDocumentId, sourceRef, evidenceSourceRefs }` bindingからGold regionをremapできることを確認すること。
  binding省略時のdocument ID fallback、重複／foreign binding、aliasの別文書解決を拒否すること。
- parserの `[123] -> []`、`["夜半", 123] -> ["夜半"]` をcharacterizationとして固定し、それをraw provider応答の文法妥当性や一般的な時間理解の証明に読み替えないこと。
- temporal projectionの4区分、required／denominator／judged、blocked capacity、status／passed、unscored件数、digestと版の不変条件を検証すること。
  numeric-only diagnosticsはprepared title／text照合を独立再証明しないという信頼限界を保持すること。
- 正しい4主張すべてを、正規の引用IDで表現できること。
- 有効な引用範囲がGoldの直接範囲より広い場合や包含関係にある場合、UTF-16範囲全体が一致しないという理由だけで不合格にならず、
  引用範囲を合わせた領域が必須直接範囲を覆い、補助範囲が同じリクエストでモデルに見えている条件を満たすこと。
- 必須直接範囲の小さな重なりだけでは対応候補を有効にせず、引用範囲を合わせた領域に隙間があれば不合格にすること。
- 同じリクエストの検証済みの結び付け情報で補助範囲がモデルに見えている場合だけ `contextSupport` を認め、別の閲覧範囲や登録済みSource View全体で補わないこと。
- 原文のGold範囲と実際の正規Source Viewを使った対照結果と、可視範囲を人工的に狭めた境界対照の結果を分けて記録し、人工的な境界対照を原文Goldの正例証拠に読み替えないこと。
- 同じ証拠でも、述語を誤った場合や役割を入れ替えた場合は不合格になること。
- 鎖の切断と門扉の転倒を、別の主張として保持すること。
- 重複する主張を1つのGoldに重ねて対応させず、重複として別計上すること。
- 捏造した5件目の出来事や行先の欠落を、網羅的なObservation契約では不合格にすること。
- 正しい4件に未知の5件目を加えた場合も、未知の内容を保持しつつ `cardinalityExcessLowerBound = 1` を記録してFAILにすること。
- `targeted` の場合は同じactual件数でも `cardinalityExcessLowerBound = 0` とし、注釈範囲外のactualを `unscored` として扱うこと。
- 空出力では4件の欠落を報告すること。
- 未対応の表現を、有限の理由コードを伴う観測不能として扱うこと。
- 既知の不一致と未知の項目が同じactualにある場合、既知の次元の不一致を保持し、未知の次元だけを観測不能にすること。
- 未知actualが複数のGoldに対応し得る場合も、一対一の容量を守り、`unknownMatchCapacity` と
  `missingCountLowerBound` によって確実な欠落数の下限を示すこと。4件のGoldを1件の原子的actualで覆う場合は下限3以上とすること。
- 完全一致の組数を先に最大化し、残る不一致の比較相手を有限の規則で決め、入力配列の順序を変えても同じ結果になること。
- Goldを変更しても、正規化済みactualとそのダイジェストは変わらないこと。
  一方、Goldの意味を変更した場合には、比較結果が変わること。
- Proposalの抑制によってObservationの正しさが変わらないこと。
- 不正な項目、古いダイジェスト、誤った区分、層をまたいだ件数の混入を拒否すること。

評価器の入力単位は、既存の本番統合処理を通過した、具体化済みのObservationとする。
バイト単位で同一の生データの重複は、その統合処理で既にまとめられているため、この契約で観測できるとはしない。
一方、意味が重複する主張は、引き続き必須の負例とする。

受入れには、v1との整合性の維持、Gold作成の独立性、正規の証拠による正例の成立、意味の変更を検出する感度、
証拠範囲が変わっても意味判定が変わらないこと、ObservationとProposalの分離、網羅性の確認、
不確実性の保持、Goldの意味がactualへ混入しないこと、数値診断の厳密な検証、
およびリポジトリで定めた対象別の検証とQuick／verifyの証跡を必要とする。
`accepted` は意味評価、Proposal、Gold authorshipの正式ゲートであり、draft Goldではfalseのままとする。
診断Projectionの `validation.ok` は、固定形状・ダイジェスト・層間整合性を再検証できたかという診断データの妥当性であり、
`accepted` とは独立である。この範囲の合格が裏付けるのは、ここで定義した1件の限定的な診断契約だけである。

Goldへの評価対象の内容の混入、証拠範囲だけによる意味判定、Goldに依存したactualの正規化、
貪欲な割当てによる入力順序への依存、網羅範囲の曖昧さ、不確実性を隠した合格扱い、層をまたいだ評価の混入、
成立しない正例、または版の不整合が見つかった場合は、契約を受入れ保留（HOLD）とする。
