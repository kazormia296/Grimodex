# NIR-1 A5 候補2: 承認済みの実装・製品検証差分

2026-09-08。**設計・local比較は完了。同日10:53 UTC、ユーザーが以下の検索policyと復旧probeの別版実装・実ElectronでのL5検証を承認した。製品受入れは未了。**
元の `nir1-plan/1` / `nir1-product-tm/1` と、
[承認済みのA5比較範囲](nir1-l5-quality-hold.md) を維持する。
今回の比較は本体担当のみで実施した。独立受入れ・作者実測とは扱わない。

## 提案する検索policyの差分

| 項目                  | 初回の製品候補                                                    | 次候補2                                                                                                 |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| embedding対象         | immutable四項目JSON                                               | 同じ。summary / actuality / attribution / narrativeFrameを省略しない                                    |
| IR cosine floor       | ja=0.850 / en=0.510                                               | **ja=0.813 / en=0.660**。Rawの閾値は維持                                                                |
| RawとIRの融合         | 等重みRRF、Raw高信頼anchorを保持                                  | **Rawの全順位・score・excerptを保持**。共有sceneへIR情報を添え、8件未満なら最上位のIR-onlyを最大1件追加 |
| IRが空・失敗・timeout | exact Raw                                                         | 同じ                                                                                                    |
| IRの資格・cap         | whole-material admissionの後にscoring、scene maxと決定的tie、top8 | 同じ                                                                                                    |

融合候補IDは `raw-stable-one-supplement/1`、local比較protocolは `nir1-a5-local-comparison/2`。
具体的な校正結果は、次の独立した記録に束縛する。

- `l5-a5-revision-2/protocol.json`: `601a368d1ebfc7a0072735899bac42c9785cccb8c97b302defe42bc0ab33a0d1`
- `l5-a5-revision-2/selection.json`: holdout推論より前に保存した表現・閾値・融合の選択。
- `l5-a5-revision-2/report.json`: 全caseの結果と入力hash、監査検証。

基点は `/home/grimodex/Documents/Grimodex-evidence/nir1/first-product-path/`。
初回manifest・Gold・Raw B/D/Tをそのまま保持し、実装する場合は追加のpolicy versionと
新しいreceiptに差分を明示する。旧比較1や旧製品候補の失敗記録は残す。

## local比較で得られた結果

校正は日英それぞれ、短い照会12件・長い照会12件・該当なし4件、各14候補。
短い照会と長い照会は12題材を共有する。別の12題材から同じ構成のholdoutを作った。
全入力と規則を推論前に固定し、holdoutを見てから閾値を変更していない。

校正の選択条件は、24の正例pair中20以上を取得するfloorの中でF0.5を最大化し、
precision、より高いfloorの順で同点を解決するもの。これは校正の選択上の条件であり、
固定Goldの受入れ条件を置き換えない。Rawと同じfloorを使う初回案からのpolicy変更候補である。

### 既存の固定24case

同じimmutable四項目・model・queryの計算結果と、実Electronで各30回確認済みの同一Raw Rを再利用した
component比較。初回比較で全336 statement digestとcold資格、観測された47 Native cosineの完全一致を検証済み。

| 指標                     |      Raw |  次候補2 |
| ------------------------ | -------: | -------: |
| 全体 Recall@8            | 0.909722 | 0.965278 |
| 全体 nDCG@8              | 0.891998 | 0.942061 |
| 日本語 nDCG@8            | 0.835315 | 0.935442 |
| 英語 nDCG@8              | 0.948681 | 0.948681 |
| semantic群 nDCG@8        | 0.783996 | 0.884122 |
| Raw/prose群 Recall・nDCG |    1 / 1 |    1 / 1 |

事前指定caseの改善は `ja-01` と `ja-03` の2件。追加sceneは2件とも固定Gold上の関連sceneで、
この24caseでの無関係scene追加は0。Raw順位・score・excerpt・必須passageは保持される。
canonical `scoreQuery` と48組の計算が一致した。

**Rawの末尾へ追加する方式はnDCG非回帰を構造的に満たしやすい。**
この数値だけで一般的な検索品質の改善とは判断しない。

### 新しいholdoutの限界

| 対象   | 正例取得 / 24 | 誤取得pair | pair precision | pair recall | 該当なしで誤返却したquery / 4 |
| ------ | ------------: | ---------: | -------------: | ----------: | ----------------------------: |
| 日本語 |            23 |         64 |          0.264 |       0.958 |                             1 |
| 英語   |            20 |         22 |          0.476 |       0.833 |                             0 |

上表はfloorを超えたpairの数で、すべてがUIへ追加されるという意味ではない。
Rawが空で先頭IRを最大1件返すと仮定した追加診断では、返却した1件のprecisionはja=0.750、en=0.800。
日本語は正例18、誤った候補5、空1、該当なしへの誤返却1。英語は正例16、誤った候補4、空4、
該当なしへの誤返却0だった。これらのholdoutでは実Rawを計測していないため、実製品の融合後品質へ読み替えない。

ラベルは本体担当の設計期待値であり、作者の判断ではない。全caseが `actual / narrator / story-world` で、
他のmodality・frame全体を覆わない。次候補は**固定caseで改善した限定候補**として扱い、
誤取得の残るholdoutや作者価値未測定を隠して一般化しない。

## 復旧試験の正例probeを別版にする差分

既存100 current revisionのworkloadは、100件すべてが同じ四項目statementを持つ。
既存の照会とのcosineは **0.8129581213** で、新候補のja floor **0.813** を下回る。
このままでは、Indexが正しく復旧しても `usable-included` の発見確認を成立させられない。
固定したfloorを、このworkloadに合わせて0.812へ下げる調整はしない。

そこで、**旧workloadと失敗記録を保持したうえで、復旧用の正例probeだけを別versionで固定する**ことを提案する。
新しい照会案は次の文字列に固定済み。

> 洪水で石橋が崩壊し、薪小屋への通行が不可能になった。この出来事の根拠を確認したい。

`l5-recovery-probe-design-1/` の事前固定local診断では、同じstatementとのcosineは0.8812292218。
これは正例probeの成立を確かめたcomponent診断で、復旧時間の成功証拠ではない。
原本の固定24caseのquery・Gold、B=54.2ms、D=10.84ms、T=2144.7msには手を加えない。

2026-09-09のユーザー承認により、復旧条件は[受入れ第2版](nir1-recovery-acceptance-v2.md)へ更新した。以下は現行条件であり、旧100回/class・p95 2秒必須の測定記録はそのまま保持する。

- 100 current revision。ancestorを件数へ加えない。
- mutation classごとに対象を絞った契約テストと実製品journeyで検証する。100回/class・400回は必須ではない。任意の反復測定では全失敗・timeoutを保持する。
- COMMIT後のmutation acknowledgementから計時し、最新generation/roster・Feed・二consumerの資格と実IR query、旧UI結果の失効まで測る。
- 旧資格は即時失効し、Rawと通常操作を利用できる状態でIRをbackground再生成する。再生成p95 2秒は改善目標。事前指定の `usable-included` / `usable-excluded` / `legitimately-pending` を変更しない。
- 元の遅延・空IR記録を成功へ書き換えない。復旧の速さと検索品質を別に報告する。

## 実装後も必要な条件

承認された案を別policy versionとして実装し、実Electronの固定720call/arm・独立5 build trial、
forbidden product cases、Evidence遷移・cold再開・restore・writer coverage、受入れ第2版の復旧検証を続ける。
新候補の性能値はまだ測っていない。旧候補の性能passを流用しない。

承認/開示/Scope、whole-material admission、二consumer Freshness、Evidence binding、immutable履歴、
保存・外部送信の境界は維持する。新しい外部modelや課金を伴う推論は含まない。
旧policyのままで世代切替修正を含むQuick/verifyは成功したが、policy変更後には再実行する。
受入れ未了をL5完了へ読み替えず、ready PRの後はmerge前で停止する。
