# NIR-1 L0–L5: 品質 Hold と次候補の確認事項

2026-09-08。現行の承認済み `nir1-plan/1` / `nir1-product-tm/1` に対する実装途中の記録。
**L5/P1 は未完了。ready PR の作成条件を満たしていない。**
本書は既存の検索policy・Gold・性能予算を変更しない。

## 現候補の実測

基点は `/home/grimodex/Documents/Grimodex-evidence/nir1/first-product-path/`。
`l4-standard-build-6/build.json` の標準 Native/Electron build と全source hashに束縛した
`l4-paired-formal-3/receipt.json` を正本とする。実行前後のsourceは同一。
通常UIで作成・非秘密化・明示承認したchildのcold DBを各queryへ独立に複製し、
実local modelで比較した。比較中の意味再抽出、保存後のfixture改変、Gold変更はない。

| 指標                              |            Raw |          Raw + IR | 判定                  |
| --------------------------------- | -------------: | ----------------: | --------------------- |
| 全24queryの Recall@8              |       0.909722 |          0.909722 | 非回帰                |
| 全24queryの nDCG@8                |       0.891998 |          0.888629 | Hold                  |
| semantic群 nDCG@8                 |       0.783996 |          0.777259 | Hold                  |
| 日本語群 nDCG@8                   |       0.835315 |          0.835315 | 非回帰、改善なし      |
| 英語群 nDCG@8                     |       0.948681 |          0.941943 | Hold                  |
| Raw/prose群 Recall・nDCG          |          1 / 1 |             1 / 1 | 必須passageも保持     |
| warm p95、各720call               |         29.7ms |            48.2ms | Hybrid上限65.04ms以内 |
| IR timeout                        |         対象外 | 7 / 720 = 0.9722% | 上限1%以内            |
| combined build、独立5trial median | 固定T=2144.7ms |          3483.7ms | 固定上限4289.4ms以内  |

性能判定はL0で封印した **B=54.2ms、D=10.84ms、T=2144.7ms** を用いる。
今回のRaw p95から予算を計算し直していない。720callすべてが当初usable/supportedで、
失敗0、IR ready713、IR寄与326、Raw fallback394。timeoutを分母から除外していない。
timeout率には余裕が少なく、この1測定から他の負荷・corpus・hostでの達成を主張しない。

事前指定IR-benefit caseの改善は **0件**。top-1変更0、Raw parity違反0、
返したIRのEvidence qualification違反0。これは別途必要な10個のforbidden product case全体の合格を意味しない。
`l4-paired-formal-2/receipt.json` の性能・品質失敗は旧候補の証跡として保持する。

## 原因について分かっていること

- 日本語 `ja-01` / `ja-02` / `ja-03` では、Indexが利用可能でIR処理が完了しても返却IRが空。
  現sourceでbuildしたcold readerでは各queryの14 current revisionすべてが適格で、
  保存された14 vectorのrevision集合と一致した（`l5-cold-oracle-quality-1/report.json`）。
  資格を持つ保存データの欠落では説明できず、現在の表現と固定cosine floorの組合せでは
  日本語の改善対象にIRが寄与していない。
- 英語 `en-01` では、IR cosineが修理の下見0.63825、橋の崩壊0.52280。
  固定Goldの関連度はそれぞれ1と3。Rawの「橋の崩壊→修理の下見」が、
  等重みRRF後に「修理の下見→橋の崩壊」へ入れ替わり、nDCGを下げる。
  誤った並べ替え実装だけで説明できる結果ではなく、現行IR順位と承認済み融合規則に対応している。
- 事前Raw-only fixtureは平坦なscene群、通常抽出後のpaired fixtureは抽出用folderを含む。
  FTSの文書集合にはfolderのtitleも入るため、一部英語queryのBM25順序は事前Raw-only測定と異なる。
  現paired比較は同じ通常fixtureのRaw R同士を全callで完全照合している。事前Raw-onlyとの
  全順位一致を主張せず、この構造差を隠すために元fixtureやRaw予算を変更しない。

## 実装済みの経路と残る受入れ

通常抽出・Human child・current承認・canonical読取・sealed Index・typed IPC・
Raw/IR並行取得・固定deadline・Evidence遷移を実装した。失効通知、query lease、
Indexの再利用/再構築、同一snapshotの資格検証を含むfocused testを保存している。
書き込み所有者登録の修正後、`pnpm verify:quality` はexit 0。

実Electronの `l5-ui-diagnostic-1/report.json` では、通常UIで作った保存済みchildをcold再開し、
S2のRelated ScenesからS1のEvidenceへ移動して、180文字excerptより長い287文字の全文を選択した。
click時とeditor消費時の二回のbackend qualificationも成功した。
このUI記録は `l4-standard-build-4` に束縛したfocused証跡で、L5全体の受入れではない。

以下は未完了のまま残す。

- 固定品質条件の非回帰と、事前指定caseでの実改善。
- 実製品のforbidden cases、全writerの変更/rollback/復旧、追加navigation/restore journeysの完結。
- 100 current revision × 各mutation class 100trialの正式復旧測定。
  現100件fixtureで期待するIRの返却を確認できていないため、worker完了だけで代替しない。
- 現候補のQuick/verify、完成commitとready PR。最終結果は `ledger.json` と
  `.artifacts/local-ci/quick.json` に束縛する。Full/mergeは今回の停止点より後。
- 作者実測は `not-measured`。技術受入れと分離する。

ユーザーの本体のみで作業する指示以降、新しい独立受入れは実施していない。
以前のL0/L1/L2限定独立レビューは、その元の候補範囲でのみ保持する。

## 承認済み: A5の次候補を設計・比較する範囲

**2026-09-08 10:05:18 UTC、ユーザーの「A5の見直しを承認」により、以下の別候補の設計・local比較を承認。**
承認時の本書hashと確認文を `ledger.json:a5RevisionApproval` に記録した。
現行A5の採用algorithm・固定評価manifestはまだ変更していない。

現在固定している「四fieldのcompact JSONをembedding」「Rawと同じIR cosine floor」
「等重みRRFで再順位付け」の組合せを、独立versionの次候補として見直すことを提案する。
実装不具合の修正を超えて承認済み検索policyを変える範囲として、
[統合計画§3・§7](narrative-ir-nir1-implementation-plan.md) に従い差分確認を行った。

見直しの対象を次の三点へ限定する。

1. 四fieldの意味をすべて保持する言語別のembedding表現。summaryだけへの縮退、
   actuality/attribution/narrativeFrameの欠落、mutable title/noteによる代用は認めない。
   採用前にserializerの正確な文字列規則とversionを固定する。
2. Rawの閾値をIRへ共用する条件の見直し。IR用の校正用データと選択規則を実験前に固定し、
   現在の24caseの結果を見ながら閾値を下げ続ける選び方はしない。
3. Rawの有力結果をIRの誤順位で落としにくい融合規則。Raw本文用途の必須passageを保持し、
   IRの候補追加と既存結果の順位変更の効果を別に測る。候補数や重複で改善を水増ししない。

この承認は次候補の設計・限定local比較の範囲とし、現行候補をpassへ読み替えるものではない。
具体的なserializer・校正規則・融合式は変更候補として先に記録し、固定24caseのGold・
非回帰/改善条件・B/D/T・復旧条件を保持して評価する。
新候補が固定試験へ過適合していないかを扱う追加holdoutは、校正用データと分離して先に固定する。
これらが未成立の状態で、一般的な小説検索品質や作者価値の改善は主張しない。

承認主体・開示・Scope・whole-material admission・二consumerのcanonical Freshness・
Evidence binding・immutable履歴・保存範囲・外部送信境界は変更対象に含めない。
Graph/Packingへの拡張や課金/外部model実行も含めない。

## A5 local比較1: 採用不可

`l5-a5-revision-1/report.json`。校正24caseと別題材のholdout12case、候補二表現、
選択規則を初回推論前にhash固定した。既存の四項目JSONと、四項目すべてを残す
言語別label表現を比較した。各言語のpair F0.5を最大化し、precision、より高いfloorの順で
同点を解決した。両言語の最小F0.5を最大化する表現を一つ選び、holdout推論前に保存した。

選ばれた表現は既存JSON、floorは **ja=0.848 / en=0.660**。
融合候補はRawの全順位・score・excerptを保ち、余地があるときに最上位のIR-only sceneを
最大一つ追加する `raw-stable-one-supplement/1`。製品への採用は行っていない。

| 対象                  | 関連を取得 | 誤取得 | 関連を見逃し | precision | recall |
| --------------------- | ---------: | -----: | -----------: | --------: | -----: |
| 校正・日本語48pair    |          5 |      0 |            7 |     1.000 |  0.417 |
| 校正・英語48pair      |         10 |      3 |            2 |     0.769 |  0.833 |
| holdout・日本語24pair |          0 |      0 |            6 |    未定義 |  0.000 |
| holdout・英語24pair   |          2 |      1 |            4 |     0.667 |  0.333 |

固定24caseへのcomponent比較では、全群のRecall/nDCGはRawと同率。新しいsceneの追加0、
事前指定caseの改善0であり、品質条件を満たさない。IRが残った4queryもRawに含まれるsceneだけだった。
既存JSONのままfloorと融合をこの組合せに変えても、初回製品経路の採用条件を満たせない。

通常UIで保存された336件のimmutable四項目を読み、全件のcold資格と保存statement digestを確認した。
既存Native出力で観測できた47 cosineは今回の計算と完全一致。
48組のquality計算はcanonical `scoreQuery` と一致し、必須Raw passageを保持した。
校正216、holdout60、既存case360のlocal推論について、dispatch前の入力・model/tokenizer hashと
成功終端を検証した。元DBの内容・固定Gold・B/D/T・製品policyは変更していない。

この校正/holdoutのラベルは、推論前に固定した本体担当の設計期待値で、作者評価・独立受入れではない。
短い因果照会と四候補、`actual / narrator / story-world` に偏っており、執筆中の長い照会や
段階的な関連度全体を覆わない。日本語の返却0をprecision=1と数えない。
今回の不成立は、この選択候補を棄却する根拠であり、すべての表現や固定modelが不適切だという証明ではない。
追加で設計する比較も別versionとして先に固定し、見たholdoutを未観測の受入れ証拠へ再利用しない。

## A5 local比較2: 固定caseで改善、製品検証は未実施

比較2は校正/holdout各56caseを事前固定し、既存JSON、ja=0.813 / en=0.660、
Raw順序を保つ最大1件追加を選んだ。固定24caseではnDCG 0.891998→0.942061、改善2件。
一方、新holdoutでは誤取得が残る。製品policyの変更と、復旧用正例probeの別version案を
[次候補2の確認案](nir1-a5-candidate-2.md) に記録する。まだ採用・L5完了とは扱わない。
