# NIR-1 L0–L5 受入れ記録

2026-09-09。対象は Related Scenes で承認済み解釈を発見し、現在の Evidence へ戻る初回製品経路（L0–L5）。Graph・Packing・全体受入れ（L6–L9）は本候補に含めない。

## 確認した結果

標準 Native／Electron build、品質定義検証、差分 Quick と直後の verify が成功した。固定24ケースの実Electron比較は各arm 720回、combined buildは独立5回を測定した。

| 指標                       | Raw     | Raw + IR |
| -------------------------- | ------- | -------- |
| semantic Recall@8          | 0.81944 | 0.93056  |
| semantic nDCG@8            | 0.78400 | 0.88412  |
| Raw/prose Recall@8・nDCG@8 | 1.0     | 1.0      |
| warm p95                   | 59.8ms  | 68.1ms   |

呼び出し失敗0、IR timeout 0/720、比較中のEvidence・Raw parity違反0。combined build中央値3430.3msは固定上限4289.4ms以内。これは固定した合成corpusの測定であり、実作者の効用や未使用holdoutへの一般化は証明しない。

10種の禁止情報ケース、通常操作での承認済みchildとcold読取、Evidence全文選択とquery変更・未保存編集・保存競合によるキャンセル、writer失効とrollbackを確認した。Apply／undo／redo／importは共通Feed hookと既存C2証拠の組合せであり、各経路のNIR1 pool実動作を個別反復したとは扱わない。復元は既存NAPI 7件とUI／authority 15件が成功し、epochによる旧資格失効は別のwriter証拠で確認した。

候補を編集していない独立担当がNative／renderer／IPCの主要経路と復旧受入れ差分を確認し、範囲内に未解決の指摘はない。全repositoryの独立監査やFull CI完了は主張しない。

## 性能の限定例外

固定検索予算は B=54.2ms、D=10.84ms、B+D=65.04ms のまま保持する。現候補のHybrid p95=68.1msは上限を3.06ms超え、測定receiptの `hybridLatency=false`／`hold` を変更しない。

2026-09-09、超過を既知の性能課題として残してコミット・ready PRまで進める提案に対し、ユーザーが「続けてください」と明示した。この候補のPR作成に限って当該性能gateの例外を承認済みとする。予算の一般的な緩和、失敗記録の合格への変更、マージやreleaseの承認を意味しない。

1ケースの診断では311msの呼び出し中273.48ms、229.5ms中198.15msがWAL／DBのfsyncに重なり、Raw単独でも同期書込みの遅延を観測した。これは当該診断の遅延を説明する証拠であり、正式測定の全tailを同一原因と断定しない。監査書込み・同期保証・checkpoint設定は変更しない。共有DB経路の性能改善は別課題とする。

復旧条件は[受入れ第2版](nir1-recovery-acceptance-v2.md)に従う。旧根拠は直ちに失効させ、Rawを利用可能なまま新IRをbackground再生成する。再生成p95 2秒と400回反復は必須gateではない。元のmanifest、Gold、モデル、順位規則、開示境界、過去の失敗・未完了記録を保持する。

## 証跡と公開範囲

ローカル台帳は `Documents/Grimodex-evidence/nir1/first-product-path/ledger.json`。現候補の標準buildは `l4-standard-build-22/build.json`、固定比較は `l4-paired-formal-5/receipt.json`、同期書込み診断は `l4-latency-sync-diagnostic-1/correlation.json`。初回診断driverの起動失敗を含む原記録を保持している。

PR公開前にcleanなcommit済みHEADでQuick＋verifyを実行し、そのSHAをPRへ束縛する。今回はready PR作成後、マージ前で停止する。マージには最新baseを含むclean HEADでFull-from-stage-1＋verifyが別途必要である。
