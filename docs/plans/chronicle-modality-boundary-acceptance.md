# Chronicle様態の境界検証と次の受入れ対象

対象commitは `7a75200effeab333e5de91d64ce6eca445b2635c`、PRは #566。本資料は修正前のObservation診断・境界試験とJourney計画を記録する。以下の48 PASS/3 FAILは前段の結果として保持する。後続の本番修正・検証は[様態照合の実装修正](./chronicle-modality-gate-implementation.md)を参照する。Journeyの実施・成功を示す資料ではない。

## 実行bindingとコミットの一致

最終Luna runは `00af7df2-e76d-401d-afc0-c5bdf894594b`。binding SHA-256は `ac0ebec09bd0421a41e2bda87f26402b2fb2269f1991c755d9c209cb3dce08c9`。

実行時はHEAD `8eb02dbd` の未コミット候補だった。現在のcommit `7a75200e` とGit metadataは異なるが、binding対象3,915ファイルの作業ツリー内容に不一致0、うちGit管理対象3,814ファイルは現在commitのblob内容と直接SHA-256比較して不一致0。残る101ファイルはローカルの診断用artifact等であり、コミット済みとは呼ばない。確認時点のPR HEADも `7a75200e` と一致。

比較証跡は `.artifacts/narrative-eval/chronicle-modality-boundaries-20260907/execution-binding-match.json`。旧Quickのhead/tree/dirty metadataを書き換えず、旧receiptを現在commitのexact-HEAD検証へ転用しない。以下で追加するテスト・計画文書は実行後の差分として分離する。

## 本番契約と既存テストの対応

| 境界                               | 現在の本番契約                                                                      | 既存の証明                                                                                                                                                                 | 不足・限界                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Observation task / Citation parser | `rumored`・`planned`・`dreamed`と帰属・frameを独立に保持                            | [citationIdObservation.test.ts](../../src/application/narrative-extraction/aiTasks/citationIdObservation.test.ts) の実task＋固定send＋strict materializerでpayload完全一致 | 後段のHypothesisやProposalまでは証明しない                                                                                          |
| Window正規化 / rekey / merger      | 正規化・ID再割当はpayloadを引き継ぎ、merger identityにactualityを含める             | [observationMerger.test.ts](../../src/features/chronicle/extraction/observationMerger.test.ts) は同一根拠のplannedとactualを別観測として保持                               | 3様態をcoordinatorの保存artifactまで通す一貫した確認が不足                                                                          |
| AI synthesis正規化                 | Hypothesisの許可値はactual/attempted/prevented/rumored。モデルのactualityを保持     | [eventSynthesis.test.ts](../../src/features/chronicle/extraction/eventSynthesis.test.ts) はrumored/actual保持とplanned等の拒否                                             | planned/dreamedをHypothesisに保持する契約ではない。元Observationとのactuality照合は別問題                                           |
| AI coordinator                     | 参照・stage receipt・artifactを結び付けて合成結果をplannerへ渡す                    | 既存AI coordinatorテストは主にactualのID・件数・参照                                                                                                                       | 非現実Observationだけを根拠にactual仮説が返る場合の防止を確認できていない                                                           |
| Deterministic fallback             | 先頭Observationの様態を読み、rumoredを保持、planned/dreamedを仮説化せず落とす       | 既存coordinatorテストはactualのProposal生成を確認                                                                                                                          | 保存済みの3様態をfallbackへ渡す検証が不足。raw本文からの夢・伝聞検出の証明とは別                                                    |
| Planner                            | 仮説がactual/attempted/prevented、major/scene-level、解決済み根拠を持つ場合に提案   | [proposalPlanner.test.ts](../../src/features/chronicle/extraction/proposalPlanner.test.ts) はactual正例とrumored抑制                                                       | `skips planned / minor ...`という既存test名の該当入力はactual+minorであり、planned検証に数えない。元Observationとの様態照合は未証明 |
| V2 envelope / adapter              | 仮説とProposalのactuality一致、元・統合Observationのpayload一致、帰属/frame等を検証 | `chronicleV2Production` / `chronicleSceneEventAdapter` の既存契約検証                                                                                                      | 仮説のactualityと根拠Observationのactualityの一致を同義には扱わない                                                                 |
| LLM judge                          | 独立Goldと7軸で比較し、scope外を限定的に未採点とする                                | A/P/H/Dの対象6主張×7軸が最終runで全match                                                                                                                                   | synthesisは呼んでおらず、planner・承認・保存・再読込の評価ではない                                                                  |

正本: [Observation task](../../src/application/narrative-extraction/aiTasks/runObservationExtractionTask.ts)、[正規化](../../src/features/chronicle/extraction/eventSynthesis.ts)、[coordinator](../../src/application/narrative-extraction/extractionCoordinator.ts)、[planner](../../src/features/chronicle/extraction/proposalPlanner.ts)、[Hypothesis型](../../src/features/narrative-extraction/ir/inferences/eventHypothesis.ts)、[V2 adapter](../../src/features/narrative-extraction/proposals/chronicleSceneEventAdapter.ts)。

## 追加する統合試験の範囲

実coordinator・実Observation task・実synthesis taskを使用し、モデル通信にはコードで固定した合成応答を使う。既存harnessはNative永続化のほか、`buildChronicleProductionV2Envelopes`、`buildChronicleProposalSetPayload`、`buildSnapshotSourceBasis`もmockする。したがって証明範囲は実task・正規化・coordinator・planner出力までで、実V2 envelope構築・Native保存/Applyの受入れではない。独立したactual主張を正例として併走させる。GoldやLLM judgeの応答を本番出力へ流用しない。

1. Citation Observation→window正規化→merger→AI synthesis→planner: original/merged artifactの3様態を保持し、rumored仮説は残して提案を抑制、planned/dreamedは現行契約の空合成とし、actualのProposalが残ることを確認する。
2. 各非現実Observationだけを根拠に合成がactualを返す場合: 誤ったProposalを作らず、独立actualのProposalが残るという通常の回帰assertionを置く。失敗した場合は本番の未解決箇所として記録し、期待値反転・skip・全Proposal破棄で通さない。
3. 保存済みtyped Observation/clusterからdeterministic fallbackを再開: rumored保持、planned/dreamedの非昇格、actual Proposalの残存を確認する。本文を読むdeterministic extractorの様態認識はこの試験の範囲外。

本番契約を拡張・変更する修正はこのテスト追加へ混ぜない。失敗を再現した場合は、次の受入れ候補を固定する前に解消する必要がある。

## 追加試験の結果

[extractionCoordinator.test.ts](../../src/application/narrative-extraction/extractionCoordinator.test.ts)にA/B/Cの5ケースを追加した。4ファイルのfocused検証は **48 PASS / 3 FAIL / 0 skipped**（exit 1）。既存coordinator 16件とA/Cは成功し、通常の拒否assertionを置いたBの3様態だけが失敗した。

追加後の `pnpm exec tsc --noEmit` はPASS（exit 0）。型チェックの成功は上記3件の動作上の失敗を解消しない。

- A `preserves citation modalities through real synthesis and keeps only the actual control Proposal`: PASS。original/mergedの様態、実合成への入力、rumored仮説、actualだけのProposalを確認。
- B `rejects unjustified actual synthesis of a %s event while retaining the independent actual Proposal`: rumored/planned/dreamedの3ケースがFAIL。非現実と同じ出来事・参加者を合成がactualと返すと、不当なactual Proposalがplanner出力へ到達する。発話・聴取・夢を経験する外側の行為ではない。独立したactual正例が残ることは先に確認済み。
- C `resumes typed modality artifacts into real fallback without promoting them or discarding the actual control`: PASS。rumored保持、planned/dreamed省略、actual Proposalの残存を確認。

既存の様態保持契約を確認するテストと、誤昇格防止に必要な未実装の照合を分けた。**3 FAILは本番側の残存blocker**として維持し、`it.fails`・skip・期待値反転を使わない。本番コード、Gold、schema、promptは変更していない。課金APIも実行していない。

証跡: `.artifacts/narrative-eval/chronicle-modality-boundaries-20260907/logs/coordinator-modalities-focused-final.log`と同`.exit.json`。新しいテスト/計画差分は未コミットで、PR HEAD `7a75200e` の内容と区別する。既知のfocused失敗があるため、この後続候補のQuick/Full成功は主張しない。次のJourney受入れ前にこの照合不足を修正する必要がある。

## 次の小さなJourney

候補名: `chronicle-extract-review-apply-reopen`。現時点では未登録・未実行。1つの隔離workspace、1project、1章、短いscene、1つの妥当なactualイベントと非現実の対照を使う。

追補: 後続実装で、現行の根拠欄はscene名ではなくscene IDを表示すると確認した。以下のscene名表示の期待は未充足であり、後続の限定Journeyでは引用本文と実scene IDの対応を検証する。scene名表示や本文ジャンプが完成したとは扱わない。具体的な5観測・2採用・3拒否の対照と候補gateは[後続の実装記録](./chronicle-modality-gate-implementation.md)に分けて記録する。

| 手順           | 使用する実装済みアプリ経路                                                                                             | 確認する事実                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 抽出           | ChroniclePanel→ChronicleExtractDialogの「解析」→`startChronicleExtraction`→実coordinator                               | sceneを保存してsnapshotを作る。製品既定の`useAi:true`を通し、Observation/synthesisの型・根拠解決を実施                                                                                                                     |
| 根拠表示・提案 | `ChronicleProposalReview`→`ChronicleEvidencePane`                                                                      | actual候補が1件以上表示され、引用とscene名が本文に一致する。非現実内容をactual候補として表示しない                                                                                                                         |
| 承認           | ProposalCard→`decideChronicleProposal`→`appendHumanDecision`                                                           | 対象revisionへの人の承認がNativeで永続化されてからUIがapprovedになる。承認だけでは最終イベントを作らない                                                                                                                   |
| 保存           | 「取り込む」→`applyChronicleExtractionReview` / `applyChronicleExtractionCommit`→compile→prepare/apply                 | 承認したactualだけがイベントとして作成され、根拠・sceneリンク・applicationと結び付く。Proposal全破棄による0件成功を認めない                                                                                                |
| 再読込         | アプリを終了し同じworkspace/projectを再起動。イベント一覧を表示し、review bundleはrunId指定の読み取り専用APIで確認する | UIでは同じeventの残存とイベント数不変を確認する。全件適用済みreviewは再発見・再適用されないことを確認。適用前に記録したrunIdを用いた読み取り専用typed IPCで、同じrevision/decision/application・根拠の永続化を別途確認する |

承認・保存・読込は[typed preload](../../electron/preload/index.ts)→[main dispatch](../../electron/main/ipc.ts)→[N-API](../../electron/native/grimodex-node/src/lib.rs)→[共有Rust DB](../../src-tauri/crates/grimodex-db/src/narrative_extraction/mod.rs)まで通す。`narrative_extraction_append_human_decision`、`narrative_extraction_prepare_commit`、`narrative_extraction_apply_commit`、`narrative_extraction_get_run_review_bundle`が実装済み。検証のために最終イベントやProposalをDBへ直接seedして通過扱いにしない。

全件適用成功時はDialogがprojectionを破棄し、通常の`restoreChronicleExtractionReview`は未適用の適格Proposalがあるrunだけを復元する。適用済みreviewの根拠・承認・applicationを通常UIで再表示する機能が実装済みとは扱わない。ここではイベント再表示と、テスト観測用の`get_run_review_bundle`による永続化確認を分ける。

根拠の本文ジャンプは現行Dialogから`onEvidenceClick`を渡していないため、このJourneyでは引用・scene名の表示だけを受入れ対象とする。ジャンプ完成を暗黙の条件にしない。

固定合成応答を通常のAI transportへ返すChronicle用Journey接続は、今後実装・確認する必要がある。リクエストごとのcitation/observation/cluster IDだけをそのリクエストへ結び付け、意味内容はコードで固定する。coordinator・planner・review storeを固定結果へ置換しない。実LLM品質とアプリ往復動作を同時に測る構成にせず、課金APIの追加実行をこの計画で開始しない。

既存の`chronicle-native-roundtrip`は`event_create` / `chronicle_bulk_mutate`と再起動後の永続化を通すが、抽出・根拠表示・承認を迂回する。`chronicle-ui-roundtrip`は[Journey catalog](../../electron/scripts/product-journey-catalog.mjs)のbacklogであり、実行済みJourneyではない。この2つを今回要求された連続経路の成功証跡に数えない。

Journey実装時には宣言catalog・runner・対応するcoverageを一緒に登録し、新しいcandidateのbase/head/tree、clean状態、app/native build、固定応答のdigest、各step、保存後のID/件数、再起動前後の証跡を固定する。必要なElectron/native実行環境のみを前提とし、未解決の様態境界があれば受入れを保留する。Journey単独の成功は正式認証やFull-from-stage-1＋verifyを置き換えない。

## 診断結果と未評価範囲

A/P/H/Dは最終Luna runで全PASS。入力24,688、出力25,730、8POST、provider報告US$0.0370468。先行Luna適用試行を含む17POSTの累計US$0.1213859。原文・独立Gold・rubric不変、解析失敗・未解決根拠0、replay一致を確認している。

これは固定4ケースのObservation診断であり、新scopeの独立LLM judge校正、一般的な意味精度、時間、synthesis、Hypothesis、Proposal、アプリJourney、再起動復旧、正式認証の証明ではない。`diagnosticOnly=true`、`accepted=false`、`formalCertification=false`を維持する。
