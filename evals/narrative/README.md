# Narrative Extraction 評価データ

このディレクトリは、Narrative Extraction の意味品質を測るための、バージョン付き評価データの正本です。Chronicle Vertical Slice では、14件の認証用 micro corpus と、5件の motif-boundary 診断用 corpus を管理します。

## Gold の扱い

各 case file の `expected` は、人間がレビューした Human Gold です。イベントタイトルなどの表層文字列を一致させるのではなく、次の意味軸を比較します。

- Event Detection
- Actuality
- Attribution
- Narrative Frame
- Evidence
- Clustering
- Significance
- Proposal Gate

本文はすべてこの評価用に作成した合成テキストです。Gold はモデル出力から自動生成しません。Gold を変更する場合は、ケース本文、期待値、critical violation、要件への影響を人間が一緒にレビューします。

現行の legacy Chronicle 出力は、exact quote、actuality、attribution などを持たないため、旧経路の baseline を採取する用途には使えても、新しい Narrative Extraction 経路の認証には使えません。Production prompt、schema、parser を通した結果だけが認証対象です。

## Chronicle 評価契約 v2（オフライン診断）

v1 の Gold、scorer、diagnostics、実行記録は変更せず、その意味品質や認証結果を v2 へ読み替えません。v2 は既存の北門本文について、4つの原子的なObservationの主張（鎖の切断、門扉の倒壊、衛兵による鐘、通行人の広場への退避）を独立に注釈する契約です。4つのObservation、原文／Gold、および承認済みの2つの時間関係は確認済みですが、Goldの正式認証と実装全体の承認は未了です。Evidence は正規の引用IDと UTF-16 座標で本文へ厳格に結び付けます。Gold には `requiredDirectRegions` と `allowedContextRegions` を分けて固定し、actual の有効な引用範囲は必須直接範囲を隙間なく覆わなければなりません。小さな重なりだけでは対応を成立させず、`allowedContextRegions` が空なら追加文脈を要求せず、文脈が必要な場合は同じリクエスト範囲の検証済み可視部分だけを補助にします。述語・参加者・role・actuality・attribution・narrative frame は別の有限な照合器で比較します。`exhaustive` で actual がGoldの4件を超えた分は `cardinalityExcessLowerBound` に記録してFAILへ反映しますが、actual区分やFP/FN・分母へ重複計上しません。`targeted` ではこの値を0とし、注釈範囲外のactualを `unscored` として保持します。

v2 Gold は本文だけから独立に作成した `candidateOutputContamination: false` の記録で、限定承認済みだが正式認証前の診断専用データです。機械可読な review record には原文／Gold確認、4つのatomic Observation、承認済みの2つの時間関係、4つの時間評価除外を記録し、対象外の承認や正式認証へ拡張しません。Proposal は Observation と分離し、この短文では重要度を決めないため `targeted`／`unscored` として明示します。未知の項目はその項目だけを有限の reason 付き `unobservable` として保持し、同じ actual の既知項目の比較を消去しません。未知actualに互換なGoldがあれば、完全一致で先に予約された場合でもactual行は `unobservable` として保持し、未予約Goldへ割り当てられる容量だけを `unknownMatchCapacity` に数えます。診断の `evaluationScope` は Proposal が未採点なら `observation-and-temporal`、採点する場合は `observation-temporal-and-proposal` とします。`accepted` は正式ゲートとして維持し、draft Gold では false です。診断データの `validation.ok` は形状・digest・層間整合性の検証結果であり、`accepted` とは独立です。実 API、14件の v1 corpus、実行suite の登録はこの v2 評価用データの対象外です。

時間関係はObservationとは別のtargeted symbolic metadata層です。`夜半` を `chain-break` と `gate-fall` に付ける2 relationだけを採点し、`scene-north-gate` の UTF-16 `[0, 2)` を同じactual自身の検証済みcitation unionで覆うことを要求します。00:00や絶対日時への変換、後続文への時間継承、実体属性、Proposal importanceは採点しません。既知の `夜半` は `matched`、空または `朝` だけは `missing`、未知表現を含み `夜半` がない場合は `unobservable` とし、`夜半` に朝・未知・日付らしい追加値があっても減点しません。event identityが不確かな場合は `event-identity-unavailable` として時間側だけを `unobservable` にし、eventの6区分やFP/FN・分母へ戻しません。後続2主張の時間値は `unscoredGoldCount` 以外の結果を変えません。

Contract document IDとprepared document IDは暗黙に同一視しません。evaluatorは title／text と Source View の検証結果から、`{ contractDocumentId, preparedDocumentId, sourceRef, evidenceSourceRefs }` の明示bindingを作ります。`sourceRef` はSource ViewのS参照、`evidenceSourceRefs` は同一prepared documentに属するSとE aliasの全集合で、文字列同一性には依存しません。各 `temporal.rawRows[].evidenceRefs` は、その `actualRef` の検証済みevidence alias集合とcanonicalに一致し、catalog全体のalias集合をコピーしません。欠落・重複・foreign binding、未知／別文書のalias、別actualのalias流用、document ID fallbackは拒否します。contextなしvalidatorはnumeric projection、digest、版、層間整合性を検証しますが、prepared title／textとの元照合や、raw／binding／relation／projectionを相互に整合する一式へ置き換えるcoherent rebindingは再証明しません。builderは与えられた入力からprojectionを再導出するだけで、完全に置き換えられた入力一式の真正性を認証しません。元のevaluation／contractを保持するcontext付きvalidatorだけが、同じremap helperとscorerを再実行し、document／alias parityとprojectionを元入力から再導出してcoherent rebindingを拒否できます。

production parserは配列内の非文字列をsilent filterするため、`[123]` は `[]`、`["夜半", 123]` は `["夜半"]` になり得ます。このcharacterizationはmaterialized metadataの境界を記録するだけで、raw provider応答の文法妥当性、非文字列を含む応答の品質、parser前の省略や変形、一般的な時間理解を証明しません。永続diagnosticsはraw textや引用文ではなく、固定キー、有限列挙値、整数、真偽値、SHA-256 digestだけを保持します。

この時間拡張の版bindingは schema `/2`、contract `/3`、Gold `/3`、evaluator `/4`、diagnostics `/4`、diagnostics schema `4`、temporal scorer `/1` です。event normalizer `/1` と event Alignment `/3` は変更しません。

- `contracts/chronicle-v2/actual-gate-collapse.json`: 独立4件のGold評価用データ（限定承認済み、正式認証前）
- `contracts/chronicle-v2/contract.schema.json`: v2評価用データのJSON Schema
- `../../docs/plans/chronicle-evaluation-contract-v2.md`: v2 の証拠境界、alignment、Observation／Proposal 分離、offline acceptance 条件
- `src/features/narrative-extraction/eval/chronicleV2Contract.ts`: 型付きローダーと評価用データに限定したactual正規化器
- `src/features/narrative-extraction/eval/chronicleV2Alignment.ts`: Evidence candidate に基づく決定的な一対一対応付け
- `src/features/narrative-extraction/eval/chronicleV2Evaluator.ts`: 本番に近い形で具体化したObservationの v2 evaluator
- `src/features/narrative-extraction/eval/chronicleV2Temporal.ts`: Gold独立の temporal raw／normalized rows、evidence、2 relationのtargeted scorer
- `src/features/narrative-extraction/eval/chronicleV2Diagnostics.ts`: raw text を保存しない digest-bound numeric projection と strict validator
- `src/features/narrative-extraction/eval/chronicleV2Contract.test.ts`、`chronicleV2Alignment.test.ts`、`chronicleV2Evaluator.test.ts`、`chronicleV2Temporal.test.ts`、`chronicleV2Diagnostics.test.ts`: v2 contract、alignment、temporal relation、本番に近い評価、unknown／coverage／proposal／Gold leakage のオフライン試験

## ファイル

- `manifest.yaml`: suite、要件、件数、release gate の正本
- `schemas/case-v1.schema.json`: 個々の case の JSON Schema
- `cases/chronicle-micro-v1.yaml`: 14件の Chronicle 認証用 micro case
- `cases/chronicle-motif-boundary-v1.yaml`: 015/016 の matched minimal pair と 017-019 の adversarial variants からなる、motif 過剰解釈を測る5件の診断用ケース

ケースは `schemaVersion: 1` を持ち、`scope`、固定 locale/timezone/time、corpus coverage、documents、Human Gold、critical violation class を自己完結して保持します。同じ case の実行は、他 case の状態や artifact を共有してはいけません。

`corpusContract.test.ts` は manifest に登録された全 suite を列挙し、case count、JSON Schema、semantic validator、Evidence resolver、case ID の一意性を検証します。また、suite 全体に少なくとも1件の required observation が存在することを要求し、何も抽出しない null extractor が負例だけで有利になることを防ぎます。個々の静的描写 case は、required observation が空でも構いません。

## Production capability sidecar（診断専用）

`productionChronicleCapabilities.ts` は、manifest から読み込んだ任意の case 配列を本番 Chronicle の observation schema、synthesis schema、proposal planner、evaluation adapter の制約に照合する、純粋な additive report です。モデル呼び出しや課金は発生せず、Gold、scorer-v1 の計算、certification 判定、threshold は変更しません。

構造上の投影可能性は `contractCompatibility`、意味品質まで評価できるかは `semanticAssessment` として分離します。現行の全19件では、required に明示された `eventDetection: false`、`actuality: rumored`、`significance: none`、および canonical evaluation adapter の `major`／`scene-level` + `proposalGate: suppress` + resolved Evidence + empty catalog の組合せを gaps として報告します。`suppress` 単独や ineligible／already-satisfied の候補を一律に blocker とは扱いません。Gold に無い negative／rumored／none を推測して追加することもありません。別の実行 context を診断する場合は catalog の件数ではなく、planner が返した `already-satisfied`／`not-already-satisfied`／`unknown` の match 状態を明示します。

無課金の all-19 manifest regression は次で実行できます。

```bash
pnpm exec vitest --run src/features/narrative-extraction/eval/productionChronicleCapabilities.test.ts
```

このテストは `chronicle-micro-v1`（14件）と `chronicle-motif-boundary-v1`（5件）を実際に読み、case ID を hardcode せずに件数と gap 集計を検証します。`semanticAssessment.status` は、構造互換な軸が残っていても、明示された gaps または `forbidden` の direct scoring 未実装、predicate/content-aware alignment 未実装の limitation がある限り `BLOCKED` です。したがって `contractCompatibility` の一部が compatible であることを全体の意味評価 PASS と読んではいけません。

課金を伴う selected-case live 実行では、response diagnostics とこの capability report を、既存の `report.json` とは分離した `artifactRoot/diagnostics.json` に sidecar として保存できます。既存 report の shape、score、`certificationEligible` は変更しません。sidecar には `nonAuthoritative: true`、`diagnosticOnly: true`、`certificationEligible: false` を付け、JSON／schema／reference／normalizer の失敗や salvage と、本番能力の制約を説明するだけにします。対象は production task まで到達した非空応答の parse 診断です。empty response や transport exception は `runLiveSingleShot` が先に throw する既存挙動のままとし、partial sidecar や raw replay の永続化は今回の対象外です。純粋な helper は empty input を判別できますが、live で sidecar 保存されることは保証しません。live case の PASS、sidecar の `contractCompatibility`、または一部軸の supported は、forbidden 違反の直接検出、命題内容を考慮した alignment、認証 PASS、scorer／certification の代替にはなりません。

## Evidence と Coverage

Evidence は `{ documentId, quote }` だけを Gold とし、モデル由来の位置情報は使用しません。`quote` は参照先 document の `text` に完全一致する必要があります。位置解決は製品側の canonical resolver が行います。

`coverage.mode: partial` では、`omittedDocumentIds` に未取得 document を明示します。部分 corpus の結果から「ほかにイベントは存在しない」と断定してはいけません。

## 認証用 micro corpus

`chronicle-micro-v1` は、実際の出来事、計画、噂、阻止された試み、夢、仮定、回想、複数 Scene の重複言及、非イベント、紛らわしい引用、否定、帰属の反証、partial coverage、重要度の選別を含みます。

この14件は評価カーネルと最初の baseline を成立させるための最小セットです。既存の Chronicle 認証件数と release gate は、この suite のまま維持します。

## Motif Boundary 診断 suite

`chronicle-motif-boundary-v1` は、同じ「壁に掛かった儀礼剣」という目立つモチーフを使った5件の診断ケースです。`015` と `016` は matched minimal pair、`017`〜`019` は adversarial variants です。

1. `015`（matched minimal pair）: 後の Scene で実際に使用される
2. `016`（matched minimal pair）: 最後まで使用されず、未使用が明示される
3. `017`（adversarial variant）: 凶器らしく見えるが、別の手段が確定する
4. `018`（adversarial variant）: 登場人物だけが凶器だと推測し、本文が反証する
5. `019`（adversarial variant）: 反復する幻想的描写があるが、剣の状態変化は明示的に否定される

この suite が測るのは「伏線を発見できるか」ではありません。目立つ物体、反復描写、人物の推測、誤誘導から、Evidence に無い出来事や因果関係を Chronicle event として確定しないことを測ります。Foreshadow は NIR-0 `scene-event@1` の採点軸へ追加しません。

manifest では `diagnosticOnly: true` とし、既存14件の認証結果を変更しません。Gold は現在の blocking-key や scorer の能力に合わせて弱めず、未達の意味品質を診断として保持します。

### Motif Boundary の maintainer-local live 実行

5件の production prompt/parser 経路を billed OpenRouter で診断実行する場合は、次の専用コマンドを使います。

```bash
export OPENROUTER_API_KEY
pnpm eval:narrative:chronicle:motif:diagnostic:live
```

このコマンドは `NARRATIVE_EVAL_SUITE_ID=chronicle-motif-boundary-v1` を設定し、manifest の `caseFile` と `caseCount` を検証してから実行します。結果には suite ID、version、件数、manifest／corpus digest を記録します。全件実行でも一部実行でも `certificationEligible` は `false` です。`QUALITY_EVALUATION_SUITE_ID` は Live Model Qualification の Heavy suite binding であり、Narrative corpus suite の選択には使いません。

この diagnostic Heavy は `qualify:ai-live` の既定 profile、Formal Gate B2、既存14件の qualification semantics には追加されません。scorer-v1 の forbidden observation blind spot を解消した証拠や、認証 PASS として扱ってはいけません。

### 現行 scorer v1 での強制範囲

現行 scorer v1 は `expected.observations.forbidden` を直接採点しません。そのため、この suite は forbidden entry だけを合否根拠にせず、次の既存経路でも失敗が観測されるよう設計しています。

- 抽出すべき出来事は `required` とし、欠落を false negative にする
- Gold に対応しない捏造 observation は unmatched false positive にする
- 否定、帰属、actuality、proposal gate の既知の誤昇格は `criticalViolationClasses` に置く

`forbidden` は Human Gold として残しますが、Evaluation Contract v2 が content matcher と独立した forbidden scoring を導入するまでは、それだけで違反を検出できたとは扱いません。特に「正しい Evidence 引用を使って別の命題を捏造する」blind spot は、この fixture 追加だけでは閉じません。

### Chronicle 015 fixed-response reference seam

`reference-predictions/chronicle-015-v1/` の固定 JSON は、`src/features/narrative-extraction/eval/chronicle015Reference.ts` と専用 Vitest からのみ fixture-only の raw `send` 応答として canonical observation／synthesis task に注入できます。テストは case 015 の Human Gold を変更せず、準備済みの2 Source View（`S0001`／`S0002`）と、canonical rekey 後の runtime observation／cluster refs を厳格に bind し、欠落・余分・未知・重複参照と placeholder leakage を fail-closed で拒否します。Apply／DB 書き込みはこの proposal-only seam の対象外で、persistenceEvidence は `not-instrumented; proposal-planning-only runner` です。

この credential-free characterization では correct が `observations=1, hypotheses=1, proposals=1, parseFailures=0`、invalid-duration が `observations=0, parseFailures=1, synthesis=0` になります。correct の意図 semantic verdict／要件状態は人手承認済みの期待値であり、legacy scorer の PASS 単独では predicate／participant roles の意味を証明しません。wrong-meaning は実際の predicate／participant roles を保持したまま legacy scorer が evidence alignment だけで `PASS` になる既知の blind spot を再現するため、意図 semantic verdict は `FAIL`、要件状態は `HOLD` と別記します。wrong-meaning が将来 scorer FAIL になって characterization test が失敗するのは、この段階では意図的な既知挙動ロックです。scorer 修正時に明示更新し、この fixture lane では採点やテストの throw を変更しません。いずれもモデル品質・certification の証拠ではありません。

## 今後の corpus

作品単位の一般化や release 判定には、chapter/full-work/mutation case と独立 holdout を追加します。章規模の推理 fixture、motif-rich fantasy、予言・伝承、意味感度 A/B は、評価契約と実行能力を明示した上で段階的に追加します。
