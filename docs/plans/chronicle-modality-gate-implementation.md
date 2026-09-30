# Chronicle様態照合の実装修正

状態: 様態修正候補r2のgate・独立受入れを完了し、Journey実装を追加。対象HEADは `7a75200effeab333e5de91d64ce6eca445b2635c`、修正は未コミット。新候補のgate・Journey実行結果は下記の候補台帳を正本とする。前段の通常回帰3 FAILを解消し、その後に実envelope・Native保存/Applyを含む小Journeyを検証する。過去のLuna診断を今回の候補の成功証跡に転用しない。

## 判定規則

Hypothesisが参照するObservationの集合を共通の決定的関数で検査する。全参照が一意に解決し、全ObservationのactualityがHypothesisのactualityに一致した場合だけ様態照合を通す。空・未解決・曖昧な参照、混在、不一致は固定reasonで拒否する。判定結果は参照順・Observation配列順に依存しない。

同じclusterにactualとplanned等があっても、仮説がactualのObservationだけを参照する場合は許可できる。両方を参照するactual仮説は拒否する。判定は仮説単位で、独立した正当なactual Proposalを残す。重要度・解決済み根拠・既存イベント照合の条件も維持する。

元Observation、モデルの合成結果、terminal receiptを変更しない。拒否仮説と理由を採用Proposalとは別の結果に保存する。fallbackは先頭Observationから様態を選ばず、参照集合の一意な様態を使う。混在等で仮説を作れないclusterは、仮説を捏造せずclusterの拒否理由として別記する。

AIのhypotheses artifactはNativeの厳密schemaに合わせて従来の `{ hypotheses }` を維持する。AI仮説の拒否理由は後段のproposal-plan artifactへ保存し、C1合成artifactへ追加fieldを混ぜない。fallbackでの未生成clusterの理由は、C1を持たないfallback artifactの任意fieldとproposal-planで保持する。Nativeの`deny_unknown_fields`は緩めない。

保存復元ではProposalだけでなく`alreadySatisfied`の仮説も照合する。旧不適合の一致済み行を承認済み表示へ戻さず、同じ再解析要求として扱う。保存された承認・適用履歴の削除や書換えは行わない。

## 影響マトリクス

| ID  | 経路                                               | 正本・境界                                                 | 保持条件と互換性                                                                                 | 検証                                                       | 状態                        |
| --- | -------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | --------------------------- |
| P1  | AI新規抽出→合成→planner                            | `extractionCoordinator`、共通様態関数、`proposalPlanner`   | 元合成を保持し、採用Proposalと拒否理由を分離                                                     | Bの3様態、A、独立actual正例                                | implemented                 |
| P2  | 完了済みObservation/合成artifactから未完planを再開 | Native確認済みinline artifact→同じplanner                  | 保存済み採用フラグを信用せず再判定                                                               | 保存再開＋不当actual＋正例                                 | implemented                 |
| P3  | deterministic fallback                             | cluster参照集合→共通検査→仮説→planner                      | 先頭依存を廃止。unsupported/混在clusterの理由を別記                                              | C、混在配列順入替                                          | implemented                 |
| P4  | planner直接呼出し                                  | 詳細結果API、既存配列API                                   | 同じ様態規則、既存consumer互換                                                                   | 全様態、混在、欠落/曖昧参照、順序対照                      | implemented                 |
| P5  | 完了済みplanのcoordinator再開                      | saved ProposalSet＋plan/Observation/Hypothesis artifact    | 旧不適合データは再解析が必要と明示。既存ProposalSet・承認・適用履歴を変更しない                  | 完了plan復元の適格/不適格                                  | implemented                 |
| P6  | 通常Dialogの保存review復元                         | `getChronicleExtractionReview`、Native review bundle       | coordinatorを通らない復元でも同じ検査。旧不適合を採用扱いにしない                                | cold review復元回帰                                        | implemented                 |
| P7  | 正当な部分集合仮説→実V2 envelope                   | `chronicleV2Production`、合成contextと仮説根拠             | モデルが見たcluster全体と仮説の参照根拠を区別。receipt/digestを書換えない                        | 混在clusterのactual部分集合を実envelopeで確認              | implemented                 |
| P8  | 実Dialog→承認→Native prepare/apply→再起動          | 既存typed IPC/main/N-API/共有Rust                          | 固定AI応答以外は本番経路。最終Proposal/eventの直接seedで代用しない                               | 計画済み小Journey、実保存/再読込                           | implemented; 実行結果は台帳 |
| P9  | 既存Native authority/認可/seal/Apply整合性         | 既存契約                                                   | actor・権限・受入れ契約を変更しない                                                              | 既存関連回帰。新しいsecurity threat modelは固定しない      | out of scope: 契約変更なし  |
| P10 | Observation/Repair監査metadata→実audit IPC         | 共通`citationBindingAuditMetadata`→既存Electron/Native検査 | 重複scalarだけ除外。binding本体・alias・artifact・receiptと秘密情報検査を保持                    | producer生成metadataを実IPCへ通す回帰＋既存拒否の維持      | Journey失敗からの限定修正   |
| P11 | TS Observation/Hypothesis→Native合成artifact保存   | 既存TS IR語彙→`stage_provenance.rs`の2つの様態一覧         | `rumored`を原形で保持。書込みProposal/Assertionの3値制限、C1照合/digest/receipt、authorityは維持 | Native保存の原形/digest、未知値rollback、rumored書込み拒否 | Journey失敗からの限定修正   |

## 候補と検証

統合担当はroot、様態実装担当はhearsay_contract、Journey担当はrepair_helper、候補非編集の独立受入れ担当はacceptance_review。実装と受入れレビューの役割を分ける。

1. 様態修正と境界試験を完了し、B/A/C・既存回帰・混在対照・型チェックを確認する。
2. base/head/tree、clean状態と作業ツリー指紋、receipt directoryを単一台帳へ記録する。focused gate後に候補を固定し、canonical品質検証・Quick＋同じrefのverifyを実行する。
3. 次のJourney laneでは候補を明示的に再開し、古いgateを新差分の証明に使わない。実envelope、Native保存/Apply、再起動後の残存・件数不変を確認する。
4. 独立担当が固定候補と証跡を確認する。失敗があれば候補を再開し、古いreceiptを無効化する。

証跡の保存先: `.artifacts/narrative-eval/chronicle-modality-fix-20260907/`。commit/push/merge、課金APIの追加実行はこの作業に含めない。Fullはmerge前のclean commitで必要となる別gateであり、部分実行やdirty候補のQuick/Journeyで置き換えない。

Journeyの詳細な操作と未実装部分は[前段の受入れ計画](./chronicle-modality-boundary-acceptance.md)を参照する。今回の結果は同文書の前段48 PASS/3 FAILと区別して追記する。

## 様態修正のfocused検証

実装と周辺回帰は23ファイル175件がPASS。独立レビューの追補修正後、変更した3ファイル50件がPASS。V2の型修正後も19件がPASSし、fresh型チェック・対象lint・diff checkは成功した。重複するテストを合算しない。

元のB3件、A/C、混在・参照/格納順入替、独立actual、空/欠落/曖昧な参照、保存済みHypothesisからの再開、完了plan・cold reviewの再解析要求、Dialogの遅延通知抑止、actual/attempted/preventedの能力probeを確認した。実V2の混在cluster対照は、合成入力全体とclaim subsetを分離したまま受理し、不完全なcontext receiptを拒否する。

freeze前の独立レビューで見つかった旧`alreadySatisfied`の検査漏れと、Nativeの厳密なAI仮説artifact形状との不一致を修正した。独立担当は両修正の静的閉鎖を確認し、重大な追加findingなしと報告した。これは実Native保存/ApplyのJourney成功を示すものではない。

ログは `logs/modality-gate-focused-final`、`logs/modality-gate-focused-r2`、`logs/modality-gate-eslint-r2`、`logs/modality-gate-tsc-r2` の各 `.log` / `.exit.json`。固定候補のidentityと、その後のcanonical gate・Journeyの成否は同じ証跡ディレクトリの `candidate-ledger.json` を正本とする。

最初の固定候補では品質検証とQuick/verifyが成功したが、frontend gateが既存評価コード3ファイルの17件のPrettierエラーで停止した。失敗ログを保存し、候補を再開して該当3ファイルだけ整形した。各ファイルがHEADへ同じPrettier設定を適用した結果とbyte一致することを確認した。旧receiptを新しい候補へ転用せず、再固定後にgateを実行する。既存の警告はこの修正へ含めない。

## 様態修正候補r2のgate

作業ツリー指紋 `dda5f9432bed6df6c2dafbf80bed86ff22d32361571c5bddbcde1321c0d5544f` を固定し、frontend、canonical quality、Quick、直後の同一ref verifyが成功した。frontendは1,468ファイル14,152件PASS、11ファイル38件skip。qualityのnarrative試験は81ファイル753件PASS。Quickが選択したLight 8 suiteはすべてPASS。13件のHeavy deferredとfresh-holdoutの1件blockedは未通過のまま保持する。

独立担当は5,563ファイルのhash、候補指紋、4ログのhashと終了値、Quick/verifyの同一候補を照合した。これは様態修正候補への限定受入れであり、Full、merge、実Native Journey、一般的なモデル意味品質を証明しない。台帳の`completedLanes`へr2を保存した後、Journey laneを明示的に再開した。Journey差分には新しい候補のgateを実行する。

## Journeyの具体的な範囲

固定した短いsceneに5観測を用意する。4観測は同じ述語のactual/rumored/planned/dreamed、残り1観測は独立したactualとする。固定AI応答は5件すべてをactual仮説として返す。元観測・merged観測・合成結果・terminal digestを保持したまま3仮説を拒否し、2件だけを実V2 envelopeとNative Proposalとして保存する。混在clusterの有効なactual仮説では、根拠の参照1件とモデルが見たcontext 4件を分離して検査する。

UIで引用本文と参照scene IDを確認し、2件を個別に人が承認する。承認後もevent/applicationは0件。UI Apply後に2 event、2 scene参照、2 application、1 Native commit/journalを検査する。アプリ再起動後もID・件数・envelope・artifact/stage receipt digestが不変で、全件適用済みreviewは再発見されないことを確認する。観測のための読み取り専用DB照会をUI操作と区別し、最終Proposal・承認・event・commitを直接seedしない。

事前計画の「scene名表示」は、現在の`chronicleExtractionApi`がIDを表示名として渡すため未実装だった。今回の限定Journeyでは引用と実scene IDの対応を検証し、scene名表示の完成は主張しない。本文ジャンプも現行Dialogからcallbackが渡されず未対応である。汎用`chronicle-ui-roundtrip`のbacklogは残し、今回の狭い抽出Journeyの成功で完了扱いにしない。

既存runnerの`acceptanceComplete`はC2-ZC等の正式条件を維持する。dirty候補にclean buildReceiptを発行せず、ビルド前後のsource指紋と実行するapp/native/renderer成果物のhashを別記する。限定Journeyの`allPassed`/`allClean`とNative保存証跡を確認するが、Full受入れへ読み替えない。

登録先は`electron/scripts/product-journey-catalog.mjs`の`chronicle-extract-review-apply-reopen`、契約は`chronicle:extract-review-apply-reopen`。固定意味データは`electron/shared/productJourneyChronicleFixture.json`、応答接続は`electron/main/productJourneyChronicleAi.ts`、UI操作とNative観測は`electron/scripts/chronicle-extraction-product-journey.mjs`。既存の非packaged・明示opt-inのfake AI wrapperだけを使い、Native保存/Applyのauthorityを変更しない。

候補台帳は `.artifacts/narrative-eval/chronicle-modality-fix-20260907/candidate-ledger.json`。各gateの終了値・log hash、source binding、ビルド成果物bindingとJourney resultsを候補ごとに記録する。実行失敗はその候補の失敗証跡として残し、修正後の成功と混同しない。

Journeyのfocused preflightは、固定応答/wrapper 11件、catalog/runner 144件、最終catalog再確認33件がPASS。重複分を合算しない。Electron型チェックと新規/wrapper対象lintも成功した。空行をJSONとして読む固定応答の不具合は失敗ログを保存して修正した。補足lintで検出した既存3ファイル14件のdiagnosticはHEADとの同一性と変更行外を確認し、未解消の既存項目として別記した。広いlint全件成功とは扱わない。

## 実Journeyで見つかったaudit境界の不一致

Journey r1はビルド成功後、760成果物のhashを固定して実行したが、提案表示前に失敗した。保存DBではsnapshot/window-planが成功し、Observation taskがrun開始44ms後に`ai_audit_append_batch`の事前検証で失敗していた。エラーは`events[0].payload.metadata.citationEvidence.bindingToken`がcredential/transport-header除外へ該当するというもの。audit行とC1 receiptは0件で、provider応答には到達していない。60秒の提案待機timeoutはこの失敗の結果であり、実LLM品質や様態gateの不適格判定とは区別する。

該当値はrequest identity・catalog/snapshot digest・window座標から導出する公開の12桁識別子で、既に`E<識別子>-NNN`というcitation aliasに含まれる。認証情報ではないが、既存のElectronとNativeの秘密情報検査はその項目名を拒否する。producerの監査projectionから重複するscalarを除き、request identity・digest・alias一覧による追跡を保つ。binding本体の`bindingToken`、プロンプト内のalias、Snapshot/artifact/receiptは変更せず、秘密情報検査の例外を追加しない。

失敗候補・画面・DB・ログと実行前後の同一hashを保存し、修正前に候補を再開した。追加回帰は共通producerの出力を実IPC検証へ通し、旧`bindingToken`や本当のcredential metadataが引き続き拒否されることを確認する。Journeyの待機もNativeの失敗status/errorを読み取り専用で記録して停止する形にし、期待Proposal数やtimeoutを緩めない。

修正後のfocused結果はcitation/repair 50件PASS、既存audit IPC 3件PASS（名前filterで431件除外）、Journey待機8件PASS。型チェック、対象lint、architecture preflightも成功。独立担当はproducerの1行削除と実IPC回帰を照合し、Electron/Rustの検証実装、spanCatalog、既存修復処理のhash不変を確認した。最終runtime/gateの成否は新候補台帳へ記録する。

## 実Journeyで見つかったNative様態語彙の不一致

Journey r2では監査の事前拒否が解消し、Observation・根拠解決・merge・clusterまで成功した。Nativeの合成完了時に`NEX_CHRONICLE_RAW_OBSERVATIONS_INVALID: payload fields are malformed`で失敗した。保存済みのraw/merged観測は同じdigestを持つ5件で、`actual/rumored/planned/dreamed/actual`を保持していた。Nativeのraw観測検査だけに`rumored`がなく、既存TS IR/parserが認める値を拒否していた。

同じNative実装のHypothesis/合成terminal用の一覧にも`rumored`がなく、正当なrumored仮説の保存も拒否する不一致があった。`stage_provenance.rs`の観測・仮説の2一覧だけを既存TS契約へ揃える。書込み可能なProposal/Assertionは引き続き`actual | attempted | prevented`であり、`rumored`をactualへ変換したり、そのままeventへ書き込めるようにしたりしない。

独立担当はこの2一覧の用途とwriterの独立した制限を確認した。C1の参照集合、仮説とterminalの意味的一致、digest再計算、receipt binding、seal、authority検査は変更しない。Native回帰ではraw/仮説/terminalのrumored保持とdigest一致、未知値の拒否・rollback、rumored Proposal/Assertionの書込み拒否を確認する。修正後はNativeを再ビルドし、新しいsource/成果物を固定してJourneyを再実行する。

Nativeのfocused回帰はDB合成12件とcore IR 14件がPASSし、対象rustfmt/diff checkも成功した。正当なrumored仮説だけでなく、rumored観測から誤ってactualとされた元合成も改変せず保存できることを確認し、その保存だけではProposalが作られないことを確認した。未知の観測値、不適合な仮説値、rumored仮説とactual terminalの不一致は拒否する。初回の語彙不一致3 FAILと、新テストの単stage fixtureに対してfull-run復元APIを使ったreadback失敗は別ログで保持し、後者はNative保存後のartifact/receiptをrun/task限定で読み戻す検証へ修正した。

Journey r3では再ビルドしたNativeで抽出が完了し、2 ProposalのUI表示まで進んだ。その後、試験がUI復元用bundleへ合成詳細artifactも含まれると誤認して停止した。実DBには`chronicle.stage-synthesis-outputs@1`が保存されており、Nativeのbundleは復元対象として検証したDAG artifactだけを返していた。製品のfilterを変更せず、試験から合成詳細をrun/project/taskと現在の完了attemptへ結び付けて別途読み取る。

この追加読取りはUI bundleの一部として扱わず、独立した保存証跡として記録する。Native確認済みHypothesis artifactと同じ所有task/attemptであること、artifactのcanonical JSON digest、raw/event/parsed output digest、同じC1 receiptのroot/terminal座標を照合する。初回・承認後・Apply後・再起動後で同じ保存内容を確認し、古いattemptや別のartifactで不足を埋めない。

Journey r4では2件の個別承認をNativeへ保存した後、Applyが完了しなかった。保持DBのruntime policyは初期値の`review-only`で、別実行の例外観測でも`NARRATIVE_REVIEW_ONLY`を確認した。Nativeの拒否は正常であり、commit/application/journalは0件だった。失敗と診断を別証跡へ保存し、sourceと760成果物の実行前後の一致を確認した。

受入れfixtureの準備として、一時workspaceで既存のtyped `narrative_runtime_policy_get/set`を使い、取得versionによるCASで`manual-apply`を設定する。他の実行フラグを保持し、Nativeでの読戻しと設定証跡を解析前に確認する。設定UIの検証ではなく、実Applyに必要な既存の動作モードの準備である。review-only拒否、hard-disable、Nativeのauthorityとwriter検証は変更しない。独立担当は今回の明示されたApply検証の範囲内で、新しい信頼主体や権限契約の変更ではないことを確認した。

Journey r5では設定と読戻しは成功したが、次のアプリ起動直後のpolicy読取りが通常のworkspace初期化と競合し、`WORKSPACE_SWITCHING`で停止した。起動後と再起動後は、対象project/sceneが読み取れることを有限時間の読み取り専用検査で確認してから先へ進む。初期化中またはscene未取得だけを待機し、他のエラーは停止する。CAS設定・解析・承認・Applyの再試行や、workspace境界検査の緩和は行わない。

起動待機では、r6で確認した切替開始前の厳密な`No workspace is open`応答も初期化中として扱う。これは既存IPC契約にある未初期化状態で、待機は同じ30秒以内に限定する。対象sceneの読取りが成功するまで後続操作を始めず、類似文言や別エラーを広く無視しない。

## Native V2 Apply 正規化 lane（ユーザー確認済み）

2026-09-07、`chronicle-v2-apply-source-contract-draft-v1` の境界と受入れ条件をユーザーが明示確認した。確認原文とdraftのhashは候補台帳と同じ証跡ディレクトリの `native-apply-threat-model-confirmation.json` に保持する。以降はAstra本体のみで実施する。旧r7のreceiptは新laneの成功証跡にはしない。

実装前の対応規則:

- V1は既存readSetとchangeKindのconsumerを維持する。
- V2は現在のproduction pilotに合わせてinterpretation/addだけを扱い、他intent・未対応basisは拒否する。
- material sourceBasisの各sourceを既存Native resolverで再取得する。evidenceのsource/token一致、全dependency/contextの参照coverageを検証する。
- sourceBasisを指すdynamic inputはそのsource/tokenへ正規化する。`cluster:`・`observation:`は、当該revisionのProposalSet roster、同一run/taskの検証済みsynthesis root/terminal receipt、対応するtyped companionの内容・digest・membershipに結び付ける。companionのartifact source/tokenも封印・依存保存に含める。未知のaliasをsourceBasisで代用しない。
- 静的component-contractはrole/selector/inputRefとrevisionBasisのcontract digestを照合し、上記receiptとの一致を再確認する。live sourceへ偽装しない。
- PrepareとApplyで同じV2正規化を呼び、既存の封印digest比較を維持する。Applyの依存保存も同じ正規化結果を用い、canonical/legacyの既存transaction内で保存する。
- renderer/IPC型、role/selector/Scope意味、policy/authority/writerの防御は変更しない。

境界別影響: Native envelope→Prepareの封印、Prepare→ApplyのOCC、Apply→DBの依存保存を共有正規化で揃える。rendererは正式V2をそのまま渡す。focused検証はV1互換、V2成功、不正参照・digest・source変更/削除の拒否、rollback、依存保存とFreshnessを対象とし、新Native/appの実Journeyと更新gateへ進む。

Native Apply r1の新ビルドで、隔離fixtureのPrepare/Applyがevent 2・application 2・commit 1で成功した。実画面JourneyもApplyおよび再起動後のNative比較を通過したが、その後の表示待機で失敗した。Journeyは保存済みパネルの状態によらずChronicle stripeを押しており、`ToolWindowIcon` の `aria-pressed` が示す復元済みの表示を閉じ得る。r2は表示状態を読んでhidden時だけ開き、toolbar表示・eventタイトル表示の確認を維持する。失敗receiptと760成果物の前後一致はna1として保持する。
